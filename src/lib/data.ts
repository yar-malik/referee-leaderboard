import { z } from 'zod';
import {
  clubSchema,
  incidentSchema,
  leagueSchema,
  officialSchema,
  seasonFileSchema,
  seasonTallySchema,
  sentimentFileSchema,
  unpackedSchema,
} from './schema.mjs';

export type Club = z.infer<typeof clubSchema>;
export type Official = z.infer<typeof officialSchema>;
export type Incident = z.infer<typeof incidentSchema>;
export type League = z.infer<typeof leagueSchema>;
export type SeasonTally = z.infer<typeof seasonTallySchema>;
export type Match = z.infer<typeof seasonFileSchema>['matches'][number];
export type Unpacked = z.infer<typeof unpackedSchema>;
export type Sentiment = z.infer<typeof sentimentFileSchema>['threads'][number];
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

export const sentimentFiles = Object.values(
  import.meta.glob<{ default: unknown }>('/data/sentiment/**/*.json', { eager: true }),
).map((m) => sentimentFileSchema.parse(m.default));

const sentimentByMatch = new Map(sentimentFiles.flatMap((f) => f.threads.map((t) => [t.match, t] as const)));

/** r/soccer post-match thread sentiment for a match, when we have it. */
export const sentimentFor = (m: Match) => sentimentByMatch.get(m.id);

export const OUTRAGE_LABEL = (n: number) =>
  n >= 75 ? 'Meltdown' : n >= 50 ? 'Furious' : n >= 30 ? 'Heated' : n >= 12 ? 'Grumbles' : 'Quiet';

/** Average fan outrage across the matches an official refereed or VAR'd, for a season's sentiment file. */
export const fanHeatByOfficial = (season: string) => {
  const out = new Map<string, { total: number; n: number; worst: { m: Match; s: Sentiment } | null }>();
  for (const m of matches.filter((x) => x.season === season)) {
    const s = sentimentFor(m);
    if (!s) continue;
    for (const role of ['referee', 'var'] as const) {
      const id = m.officials[role];
      if (!id) continue;
      const cur = out.get(id) ?? { total: 0, n: 0, worst: null };
      cur.total += s.outrage;
      cur.n++;
      if (!cur.worst || s.outrage > cur.worst.s.outrage) cur.worst = { m, s };
      out.set(id, cur);
    }
  }
  return [...out.entries()]
    .map(([id, v]) => ({ official: official(id), avg: v.total / v.n, n: v.n, worst: v.worst! }))
    .filter((x) => x.n >= 5)
    .sort((a, b) => b.avg - a.avg);
};

/** How often each club's fans were the angrier side. */
export const aggrievedClubs = (season: string) => {
  const c = new Map<string, { wronged: number; threads: number; outrage: number }>();
  for (const m of matches.filter((x) => x.season === season)) {
    const s = sentimentFor(m);
    if (!s) continue;
    for (const id of [m.home, m.away]) {
      const cur = c.get(id) ?? { wronged: 0, threads: 0, outrage: 0 };
      cur.threads++;
      cur.outrage += s.outrage;
      if (s.lean === id) cur.wronged++;
      c.set(id, cur);
    }
  }
  return [...c.entries()].map(([id, v]) => ({ club: club(id), ...v, avg: v.outrage / v.threads })).sort((a, b) => b.wronged - a.wronged || b.avg - a.avg);
};

export const unpacked: Unpacked[] = Object.values(
  import.meta.glob<{ default: unknown }>('/data/unpacked/**/*.json', { eager: true }),
).map((m) => unpackedSchema.parse(m.default));

/** The Match Unpacked page for a fixture, when one has been written. */
export const unpackedFor = (m: Match) => unpacked.find((u) => u.match === m.id);

// ── Fan verdicts & hubs ─────────────────────────────────────────────────────
// Every question fans can answer. Each belongs to one or more hubs: the Premier League hub and the
// hub of every club it's about. All generated from the data, so hubs fill themselves as the season runs.

export const LEAGUE_HUB = 'premier-league';

export type PollKind = 'binary' | 'scale' | 'choice';
export type PollCategory = 'call' | 'match' | 'club' | 'league';

export interface FanPoll {
  id: string;
  question: string;
  options: string[];
  /** binary: two sides · scale: ordered, averaged 1..n · choice: pick one, no average. */
  kind: PollKind;
  category: PollCategory;
  /** Clubs this is about, listed first in the breakdown. */
  clubs: string[];
  hubs: string[];
  date: string;
  /** The option the official verdict matches, and who gave it. */
  official: { option: number | null; label: string; by: string } | null;
  /** For the one-eyed index: fans of `harmed` would be expected to pick `option`, fans of `benefited` not. */
  grievance: { harmed: string; benefited: string; option: number } | null;
}

const hubsFor = (...clubIds: string[]) => [LEAGUE_HUB, ...clubIds];

export const argumentPoll = (u: Unpacked, n: number): FanPoll => {
  const a = u.arguments[n];
  const m = matches.find((x) => x.id === u.match)!;
  const r = a.resolution;
  return {
    id: `arg-${u.match}-${n}`,
    question: a.question,
    options: a.sides.map((s) => s.label),
    kind: 'binary',
    category: 'call',
    clubs: [m.home, m.away],
    hubs: hubsFor(m.home, m.away),
    date: m.date,
    official:
      r.favours !== undefined
        ? { option: r.favours, label: a.sides[r.favours].label, by: r.by ?? 'Official verdict' }
        : { option: null, label: 'No ruling yet', by: r.by ?? 'Official verdict' },
    grievance: a.grievance
      ? { harmed: a.grievance.club, benefited: a.grievance.club === m.home ? m.away : m.home, option: a.grievance.side }
      : null,
  };
};

/** The question fans answer on an incident: its Match Unpacked argument when there is one, else "was it right?". */
export const fanPollFor = (i: Incident): FanPoll => {
  for (const u of unpacked) {
    const n = u.arguments.findIndex((a) => a.incident === i.id);
    if (n >= 0) return argumentPoll(u, n);
  }
  const v = verdictOf(i);
  return {
    id: `inc-${i.id}`,
    question: 'Was the final decision right?',
    options: ['Right call', 'Wrong call'],
    kind: 'binary',
    category: 'call',
    clubs: [i.home, i.away],
    hubs: hubsFor(i.home, i.away),
    date: i.date,
    official: {
      option: v === 'correct' ? 0 : v === 'error' ? 1 : null,
      label: v === 'correct' ? 'Right call' : v === 'error' ? 'Wrong call' : v === 'debatable' ? 'Debatable' : 'Awaiting panel',
      by: SOURCE_LABEL[i.verdictSource],
    },
    grievance: { harmed: i.harmed, benefited: i.benefited, option: 1 },
  };
};

/** After every match: how was the refereeing, and did the better team win? */
export const matchPolls = (m: Match): FanPoll[] => {
  const [h, a] = m.score.split('-').map(Number);
  const loser = h < a ? m.home : a < h ? m.away : null;
  const winner = loser && (loser === m.home ? m.away : m.home);
  const label = `${club(m.home).short} ${h}–${a} ${club(m.away).short}`;
  const base = { category: 'match' as const, clubs: [m.home, m.away], hubs: hubsFor(m.home, m.away), date: m.date, official: null };
  return [
    {
      ...base,
      id: `ref-${m.id}`,
      question: `Rate the refereeing in ${label}`,
      options: ['Awful', 'Poor', 'OK', 'Good', 'Excellent'],
      kind: 'scale',
      grievance: null,
    },
    {
      ...base,
      id: `fair-${m.id}`,
      question: loser ? `Did the better team win ${label}?` : `Was ${label} a fair result?`,
      options: ['Yes', 'No'],
      kind: 'binary',
      grievance: loser && winner ? { harmed: loser, benefited: winner, option: 1 } : null,
    },
  ];
};

/** Standing questions in each club's hub, one set per season. Fans can change their answer any time. */
export const clubPolls = (clubId: string, season = currentSeason): FanPoll[] => {
  const c = club(clubId);
  const base = { category: 'club' as const, clubs: [clubId], hubs: [clubId], date: `${season.slice(0, 4)}-08-01`, official: null, grievance: null };
  return [
    { ...base, id: `club-${clubId}-${season}-season`, question: `How's ${c.name}'s season going?`, options: ['Disaster', 'Poor', 'OK', 'Good', 'Dream'], kind: 'scale' },
    { ...base, id: `club-${clubId}-${season}-manager`, question: `How much do you trust the ${c.short} manager right now?`, options: ['None', 'Little', 'Some', 'A lot', 'Total'], kind: 'scale' },
    { ...base, id: `club-${clubId}-${season}-finish`, question: `Where will ${c.name} finish?`, options: ['Champions', 'Top four', 'Europe', 'Mid-table', 'Relegation fight'], kind: 'choice' },
    { ...base, id: `club-${clubId}-${season}-refs`, question: `Do referees treat ${c.name} fairly?`, options: ['Against them', 'Fairly', 'In their favour'], kind: 'choice' },
  ];
};

export const leaguePolls = (season = currentSeason): FanPoll[] => {
  const base = { category: 'league' as const, clubs: [], hubs: [LEAGUE_HUB], date: `${season.slice(0, 4)}-08-01`, official: null, grievance: null };
  return [
    { ...base, id: `pl-${season}-var`, question: 'Should the Premier League keep VAR?', options: ['Keep it', 'Scrap it'], kind: 'binary' },
    { ...base, id: `pl-${season}-refs`, question: `Rate Premier League refereeing in ${season.replace('-', '–')}`, options: ['Awful', 'Poor', 'OK', 'Good', 'Excellent'], kind: 'scale' },
    { ...base, id: `pl-${season}-audio`, question: 'Should VAR audio be released after every big call?', options: ['Yes', 'No'], kind: 'binary' },
  ];
};

/** Clubs in the league this season: the ones with hubs. */
export const leagueClubs = (season = currentSeason) =>
  [...new Set(matches.filter((m) => m.season === season).flatMap((m) => [m.home, m.away]))]
    .map((id) => club(id))
    .sort((a, b) => a.name.localeCompare(b.name));

/** Every poll on the site, deduplicated, for the API manifest. */
export const allFanPolls = (): FanPoll[] => {
  const out = new Map<string, FanPoll>();
  const add = (p: FanPoll) => out.has(p.id) || out.set(p.id, p);
  unpacked.forEach((u) => u.arguments.forEach((_, n) => add(argumentPoll(u, n))));
  incidents.forEach((i) => add(fanPollFor(i)));
  matches.filter((m) => m.season === currentSeason).forEach((m) => matchPolls(m).forEach(add));
  leagueClubs().forEach((c) => clubPolls(c.id).forEach(add));
  leaguePolls().forEach(add);
  return [...out.values()];
};

// ── /h/ communities and posts ──────────────────────────────────────────────
// Reddit-style: h/premierleague plus one community per club. Every poll lives in a post; a post's
// comments hang off its first poll's thread, so comments made before posts existed stay attached.

export interface Community {
  /** URL slug: h/<slug> */
  slug: string;
  /** Hub id used by the API: 'premier-league' or a club id. */
  hub: string;
  title: string;
  club: Club | null;
  about: string;
}

export const LEAGUE_SLUG = 'premierleague';
const slugFor = (clubId: string) => clubId.replace(/-/g, '');

export const communities = (): Community[] => [
  {
    slug: LEAGUE_SLUG,
    hub: LEAGUE_HUB,
    title: 'Premier League',
    club: null,
    about: 'The front page of the Premier League. Every match thread, every big refereeing call and every fanbase, voting side by side.',
  },
  ...leagueClubs().map((c) => ({
    slug: slugFor(c.id),
    hub: c.id,
    title: c.name,
    club: c,
    about: `For ${c.name} fans. Rate every ${c.short} match, vote on every call involving ${c.short}, and see where the fanbase stands.`,
  })),
];

export const communityForClub = (clubId: string) => communities().find((c) => c.hub === clubId);
export const communityUrl = (slugOrClub: string) => {
  const c = communities().find((x) => x.slug === slugOrClub || x.hub === slugOrClub);
  return href(`/h/${c?.slug ?? LEAGUE_SLUG}/`);
};

export type PostFlair = 'Post Match Thread' | 'Refereeing Call' | 'Debate' | 'Poll';

export interface Post {
  id: string;
  /** Canonical community slug, used in the URL. */
  community: string;
  /** Every community slug whose feed shows it. */
  communities: string[];
  flair: PostFlair;
  title: string;
  date: string;
  /** Comment thread id: the first poll's id. */
  thread: string;
  polls: FanPoll[];
  pinned: boolean;
  match?: Match;
  incident?: Incident;
  /** Optional debate context from Match Unpacked. */
  argument?: { unpacked: Unpacked; n: number };
}

const clubSlugs = (...ids: string[]) => ids.map((id) => communityForClub(id)?.slug).filter((x): x is string => Boolean(x));

const buildPosts = (): Post[] => {
  const out: Post[] = [];
  for (const m of matches.filter((x) => x.season === currentSeason)) {
    const [h, a] = m.score.split('-');
    const polls = matchPolls(m);
    out.push({
      id: `m-${m.id}`,
      community: LEAGUE_SLUG,
      communities: [LEAGUE_SLUG, ...clubSlugs(m.home, m.away)],
      flair: 'Post Match Thread',
      title: `Post Match Thread: ${club(m.home).name} ${h}-${a} ${club(m.away).name} | Premier League`,
      date: m.date,
      thread: polls[0].id,
      polls,
      pinned: false,
      match: m,
    });
  }
  for (const i of incidents) {
    const poll = fanPollFor(i);
    const [h, a] = i.score.split('-');
    out.push({
      id: `c-${i.id}`,
      community: LEAGUE_SLUG,
      communities: [LEAGUE_SLUG, ...clubSlugs(i.home, i.away)],
      flair: 'Refereeing Call',
      title: `${i.title} (${club(i.home).short} ${h}–${a} ${club(i.away).short}, ${i.minute})`,
      date: i.date,
      thread: poll.id,
      polls: [poll],
      pinned: false,
      match: matchFor(i),
      incident: i,
    });
  }
  for (const u of unpacked) {
    const m = matches.find((x) => x.id === u.match)!;
    u.arguments.forEach((arg, n) => {
      if (arg.incident) return; // asked on the incident's own post
      const poll = argumentPoll(u, n);
      out.push({
        id: `d-${u.match}-${n}`,
        community: LEAGUE_SLUG,
        communities: [LEAGUE_SLUG, ...clubSlugs(m.home, m.away)],
        flair: 'Debate',
        title: `${arg.question} (${club(m.home).short} ${m.score.replace('-', '–')} ${club(m.away).short})`,
        date: m.date,
        thread: poll.id,
        polls: [poll],
        pinned: false,
        match: m,
        argument: { unpacked: u, n },
      });
    });
  }
  for (const p of leaguePolls()) out.push({ id: `q-${p.id}`, community: LEAGUE_SLUG, communities: [LEAGUE_SLUG], flair: 'Poll', title: p.question, date: p.date, thread: p.id, polls: [p], pinned: true });
  for (const c of leagueClubs()) {
    const slug = slugFor(c.id);
    for (const p of clubPolls(c.id)) out.push({ id: `q-${p.id}`, community: slug, communities: [slug], flair: 'Poll', title: p.question, date: p.date, thread: p.id, polls: [p], pinned: true });
  }
  return out.sort((x, y) => y.date.localeCompare(x.date));
};

let postCache: Post[] | null = null;
export const allPosts = () => (postCache ??= buildPosts());
export const postsIn = (slug: string) => allPosts().filter((p) => p.communities.includes(slug));
export const postUrl = (p: Post) => href(`/h/${p.community}/comments/${p.id}/`);
/** The post a poll belongs to, for "discuss this" links elsewhere on the site. */
export const postForPoll = (pollId: string) => allPosts().find((p) => p.polls.some((x) => x.id === pollId));

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
