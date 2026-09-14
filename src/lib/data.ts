import { z } from 'zod';
import {
  clubSchema,
  incidentSchema,
  leagueSchema,
  officialSchema,
  seasonFileSchema,
  seasonTallySchema,
} from './schema.mjs';

export type Club = z.infer<typeof clubSchema>;
export type Official = z.infer<typeof officialSchema>;
export type Incident = z.infer<typeof incidentSchema>;
export type League = z.infer<typeof leagueSchema>;
export type SeasonTally = z.infer<typeof seasonTallySchema>;
export type Match = z.infer<typeof seasonFileSchema>['matches'][number];
export type CallVerdict = 'correct' | 'error' | 'debatable';
export type Outcome = CallVerdict | 'pending';
export type Role = 'referee' | 'var' | 'avar';

const first = <T>(mod: Record<string, { default: T }>) => Object.values(mod)[0].default;

export const leagues: League[] = z.array(leagueSchema).parse(first(import.meta.glob('/data/leagues.json', { eager: true })));
export const clubs: Club[] = z.array(clubSchema).parse(first(import.meta.glob('/data/clubs.json', { eager: true })));
export const officials: Official[] = z
  .array(officialSchema)
  .parse(first(import.meta.glob('/data/officials.json', { eager: true })));

export const incidents: Incident[] = Object.values(
  import.meta.glob<{ default: unknown }>('/data/incidents/**/*.json', { eager: true }),
)
  .map((m) => incidentSchema.parse(m.default))
  .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

export const seasonTallies: SeasonTally[] = Object.values(
  import.meta.glob<{ default: unknown }>('/data/season-tallies/*.json', { eager: true }),
).map((m) => seasonTallySchema.parse(m.default));

export const seasonFiles = Object.values(
  import.meta.glob<{ default: unknown }>('/data/matches/**/*.json', { eager: true }),
).map((m) => seasonFileSchema.parse(m.default));

export const matches: Match[] = seasonFiles
  .flatMap((f) => f.matches)
  .sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff));

/** The fixture an incident belongs to, when the season's match file is on record. */
export const matchFor = (i: Incident) =>
  matches.find((m) => m.season === i.season && m.home === i.home && m.away === i.away && m.date === i.date);

export const incidentsFor = (m: Match) =>
  incidents.filter((i) => i.season === m.season && i.home === m.home && i.away === m.away && i.date === m.date);

const clubById = new Map(clubs.map((c) => [c.id, c]));
const officialById = new Map(officials.map((o) => [o.id, o]));

export const club = (id: string) => clubById.get(id)!;
export const official = (id: string) => officialById.get(id)!;

export const seasons = [...new Set(incidents.map((i) => i.season))].sort().reverse();
export const currentSeason = seasons[0];

/**
 * Whether the decision that finally stood was right. A wrong on-field call that VAR correctly
 * overturned ends up correct; a wrong on-field call VAR left alone (below the clear-and-obvious
 * threshold, or rejected at the monitor) still stands as an error.
 */
export const verdictOf = (i: Incident): Outcome => {
  const { referee, var: v } = i.calls;
  if (referee === null && v === null) return 'pending';
  if (v === 'error') return 'error';
  if (referee === 'error' && i.varOutcome !== 'overturned') return 'error';
  if (referee === 'debatable' || v === 'debatable') return 'debatable';
  return 'correct';
};

/** Authoritative verdicts come from the KMI panel or the referees' body itself. */
export const isConfirmed = (i: Incident) => i.verdictSource === 'kmi-panel' || i.verdictSource === 'official-statement';

// How much a wrong call hurts. A match-deciding error costs the most.
export const IMPACT_WEIGHT: Record<Incident['impact'], number> = {
  'match-deciding': 3,
  'result-changing': 2,
  significant: 1.5,
  minor: 1,
};

export const IMPACT_LABEL: Record<Incident['impact'], string> = {
  'match-deciding': 'Match-deciding',
  'result-changing': 'Result-changing',
  significant: 'Significant',
  minor: 'Minor',
};

export const TYPE_LABEL: Record<Incident['type'], string> = {
  goal: 'Goal',
  offside: 'Offside',
  penalty: 'Penalty',
  'red-card': 'Red card',
  handball: 'Handball',
  'mistaken-identity': 'Mistaken identity',
  other: 'Other',
};

export const OUTCOME_LABEL: Record<Incident['varOutcome'], string> = {
  overturned: 'VAR overturned',
  confirmed: 'VAR confirmed',
  'no-intervention': 'VAR did not intervene',
  'on-field-review-rejected': 'Referee rejected VAR advice',
};

export const SOURCE_LABEL: Record<Incident['verdictSource'], string> = {
  'kmi-panel': 'KMI panel ruling',
  'official-statement': 'Admitted by referees’ body',
  'media-consensus': 'Media consensus · awaiting panel',
  community: 'Community assessment',
  pending: 'Awaiting KMI panel',
};

// ── Officials ────────────────────────────────────────────────────────────────

export interface OfficialDecision {
  incident: Incident;
  role: Role;
  verdict: CallVerdict;
}

export interface OfficialStats {
  official: Official;
  decisions: OfficialDecision[];
  correct: number;
  errors: number;
  debatable: number;
  /** correct / (correct + errors); null with no judged calls. */
  accuracy: number | null;
  /** Sum of impact weights across errors. */
  damage: number;
  matchDeciding: number;
  roles: Record<Role, number>;
  /** club id → number of this official's errors that went in that club's favour. */
  benefitedBy: Map<string, number>;
  harmedBy: Map<string, number>;
  /** Matches on file where they were the referee / VAR. */
  appearances: { referee: number; var: number; avar: number; other: number };
}

const decisionsFor = (i: Incident): { id: string; role: Role; verdict: CallVerdict }[] => {
  const out: { id: string; role: Role; verdict: CallVerdict }[] = [];
  // An assistant's offside flag is not the referee's call.
  if (i.calls.referee && i.onFieldBy === 'referee') out.push({ id: i.officials.referee, role: 'referee', verdict: i.calls.referee });
  // The AVAR shares responsibility for the VAR room's call.
  if (i.calls.var && i.officials.var) out.push({ id: i.officials.var, role: 'var', verdict: i.calls.var });
  if (i.calls.var && i.officials.avar) out.push({ id: i.officials.avar, role: 'avar', verdict: i.calls.var });
  return out;
};

export const officialStats = (pool: Incident[] = incidents): OfficialStats[] => {
  const byId = new Map<string, OfficialStats>();
  const get = (id: string) => {
    let s = byId.get(id);
    if (!s) {
      s = {
        official: official(id),
        decisions: [],
        correct: 0,
        errors: 0,
        debatable: 0,
        accuracy: null,
        damage: 0,
        matchDeciding: 0,
        roles: { referee: 0, var: 0, avar: 0 },
        benefitedBy: new Map(),
        harmedBy: new Map(),
        appearances: { referee: 0, var: 0, avar: 0, other: 0 },
      };
      byId.set(id, s);
    }
    return s;
  };

  for (const i of pool) {
    for (const d of decisionsFor(i)) {
      const s = get(d.id);
      s.decisions.push({ incident: i, role: d.role, verdict: d.verdict });
      s.roles[d.role]++;
      if (d.verdict === 'correct') s.correct++;
      if (d.verdict === 'debatable') s.debatable++;
      if (d.verdict === 'error') {
        s.errors++;
        s.damage += IMPACT_WEIGHT[i.impact];
        if (i.impact === 'match-deciding') s.matchDeciding++;
        s.benefitedBy.set(i.benefited, (s.benefitedBy.get(i.benefited) ?? 0) + 1);
        s.harmedBy.set(i.harmed, (s.harmedBy.get(i.harmed) ?? 0) + 1);
      }
    }
  }

  const seasons = new Set(pool.map((i) => i.season));
  for (const m of matches) {
    if (!seasons.has(m.season)) continue;
    for (const [role, id] of Object.entries(m.officials)) {
      if (!id) continue;
      const a = get(id).appearances;
      if (role === 'referee' || role === 'var' || role === 'avar') a[role]++;
      else a.other++;
    }
  }

  for (const s of byId.values()) {
    const judged = s.correct + s.errors;
    s.accuracy = judged ? s.correct / judged : null;
  }
  return [...byId.values()];
};

/** Most damaging first: weighted damage, then raw errors, then name. */
export const worstOfficials = (stats = officialStats()) =>
  stats
    .filter((s) => s.errors > 0)
    .sort((a, b) => b.damage - a.damage || b.errors - a.errors || a.official.name.localeCompare(b.official.name));

/** Best record first: accuracy, then volume of correct calls. */
export const bestOfficials = (stats = officialStats()) =>
  stats
    .filter((s) => s.correct > 0)
    .sort((a, b) => (b.accuracy ?? 0) - (a.accuracy ?? 0) || b.correct - a.correct || a.errors - b.errors);

// ── Clubs ────────────────────────────────────────────────────────────────────

export interface ClubStats {
  club: Club;
  incidents: Incident[];
  errorsFor: number;
  errorsAgainst: number;
  net: number;
  decidingFor: number;
  decidingAgainst: number;
}

export const clubStats = (pool: Incident[] = incidents): ClubStats[] => {
  const byId = new Map<string, ClubStats>();
  const get = (id: string) => {
    let s = byId.get(id);
    if (!s) {
      s = { club: club(id), incidents: [], errorsFor: 0, errorsAgainst: 0, net: 0, decidingFor: 0, decidingAgainst: 0 };
      byId.set(id, s);
    }
    return s;
  };
  for (const i of pool) {
    const b = get(i.benefited);
    const h = get(i.harmed);
    b.incidents.push(i);
    h.incidents.push(i);
    if (verdictOf(i) !== 'error') continue;
    b.errorsFor++;
    h.errorsAgainst++;
    if (i.impact === 'match-deciding') {
      b.decidingFor++;
      h.decidingAgainst++;
    }
  }
  for (const s of byId.values()) s.net = s.errorsFor - s.errorsAgainst;
  return [...byId.values()].sort(
    (a, b) => b.net - a.net || b.errorsFor - a.errorsFor || a.club.name.localeCompare(b.club.name),
  );
};

/** Official × club net benefit from errors, for the heatmap. */
/** KMI accuracy for a season: on-field calls and final outcomes, from panel rulings only. */
export const panelAccuracy = (season: string) => {
  const ruled = incidents.filter((i) => i.season === season && i.verdictSource === 'kmi-panel');
  const onField = ruled.filter((i) => i.calls.referee !== null);
  const onFieldCorrect = onField.filter((i) => i.calls.referee === 'correct').length;
  const finalCorrect = ruled.filter((i) => verdictOf(i) === 'correct').length;
  return {
    ruled: ruled.length,
    onField: onField.length ? onFieldCorrect / onField.length : null,
    final: ruled.length ? finalCorrect / ruled.length : null,
    overturns: ruled.filter((i) => i.varOutcome === 'overturned').length,
    varErrors: ruled.filter((i) => i.calls.var === 'error').length,
  };
};

export const benefitMatrix = (pool: Incident[] = incidents) => {
  const stats = worstOfficials(officialStats(pool)).slice(0, 15);
  const clubIds = [
    ...new Set(pool.filter((i) => verdictOf(i) === 'error').flatMap((i) => [i.benefited, i.harmed])),
  ].sort((a, b) => club(a).short.localeCompare(club(b).short));
  const rows = stats.map((s) => ({
    stats: s,
    cells: clubIds.map((c) => (s.benefitedBy.get(c) ?? 0) - (s.harmedBy.get(c) ?? 0)),
  }));
  return { clubIds, rows };
};

// ── Formatting ───────────────────────────────────────────────────────────────

export const formatDate = (iso: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });

export const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);

export const matchLabel = (i: Incident) => `${club(i.home).name} ${i.score.replace('-', '–')} ${club(i.away).name}`;

export const base = import.meta.env.BASE_URL.replace(/\/$/, '');
export const href = (path: string) => `${base}${path}`;

export const REPO_URL = 'https://github.com/yar-malik/referee-leaderboard';
