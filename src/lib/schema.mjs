// Shared by the site build and `npm run validate`, so a bad data file fails CI
// with a readable message instead of breaking a page at render time.
import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const season = z.string().regex(/^\d{4}-\d{2}$/, 'must look like 2026-27');

export const callVerdict = z.enum(['correct', 'error', 'debatable']);

export const leagueSchema = z.object({
  id: slug,
  name: z.string(),
  country: z.string(),
  active: z.boolean(),
});

export const clubSchema = z.object({
  id: slug,
  name: z.string(),
  short: z.string().max(4),
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  league: slug,
});

export const officialSchema = z.object({
  id: slug,
  name: z.string(),
  // Free-form note, e.g. "Stood down Sept 2026". Keep it factual and sourced.
  note: z.string().optional(),
});

const source = z.object({
  title: z.string(),
  publisher: z.string(),
  url: z.string().url(),
  kind: z.enum(['report', 'official', 'analysis', 'discussion']).default('report'),
});

const reaction = z.object({
  who: z.string(),
  role: z.string().optional(),
  quote: z.string(),
  // true when `quote` summarises what was said rather than reproducing it word for word.
  paraphrased: z.boolean().default(false),
  source: z.string().url().optional(),
});

export const incidentSchema = z
  .object({
    id: slug,
    league: slug,
    season,
    date: isoDate,
    home: slug,
    away: slug,
    score: z.string().regex(/^\d+-\d+$/, 'final score as home-away, e.g. 0-1'),
    minute: z.string(),
    type: z.enum(['goal', 'offside', 'penalty', 'red-card', 'handball', 'mistaken-identity', 'other']),
    title: z.string().max(90),
    summary: z.string(),
    onField: z.string(),
    varOutcome: z.enum(['overturned', 'confirmed', 'no-intervention', 'on-field-review-rejected']),
    // Who judged the call and how firmly. `kmi-panel` and `official-statement`
    // are authoritative; `media-consensus` stays provisional until the panel rules.
    verdictSource: z.enum(['kmi-panel', 'official-statement', 'media-consensus', 'community', 'pending']),
    // Votes are recorded majority-first, e.g. "4-1"; the matching call says which way the majority went.
    kmiVote: z.string().regex(/^\d-\d$/).optional(),
    kmiVoteOnField: z.string().regex(/^\d-\d$/).optional(),
    // Offside flags are the assistant's call, so they don't count against the referee.
    onFieldBy: z.enum(['referee', 'assistant-referee']).default('referee'),
    matchweek: z.number().int().min(1).max(38).optional(),
    calls: z.object({
      referee: callVerdict.nullable(),
      var: callVerdict.nullable(),
    }),
    officials: z.object({
      referee: slug,
      var: slug.optional(),
      avar: slug.optional(),
    }),
    benefited: slug,
    harmed: slug,
    impact: z.enum(['match-deciding', 'result-changing', 'significant', 'minor']),
    controversy: z.number().int().min(1).max(5),
    consequences: z.array(z.string()).default([]),
    reactions: z.array(reaction).default([]),
    sources: z.array(source).min(1, 'every incident needs at least one source'),
    featured: z.boolean().default(false),
  })
  .refine((i) => i.home !== i.away, { message: 'home and away must differ' })
  .refine((i) => i.benefited !== i.harmed, { message: 'benefited and harmed must differ' })
  .refine((i) => [i.home, i.away].includes(i.benefited) && [i.home, i.away].includes(i.harmed), {
    message: 'benefited/harmed must be the home or away club',
  })
  .refine((i) => (i.verdictSource === 'pending') === (i.calls.referee === null && i.calls.var === null), {
    message: 'pending incidents must have both calls null; judged incidents need at least one call',
  });

const officialSlot = slug.optional();

export const matchSchema = z.object({
  id: slug,
  league: slug,
  season,
  matchweek: z.number().int().min(1).max(38),
  date: isoDate,
  kickoff: z.string(),
  home: slug,
  away: slug,
  score: z.string().regex(/^\d+-\d+$/),
  providerId: z.string().optional(),
  officials: z.object({
    referee: slug,
    assistant1: officialSlot,
    assistant2: officialSlot,
    fourth: officialSlot,
    var: officialSlot,
    avar: officialSlot,
  }),
});

const tallyRow = z.object({ club: slug, for: z.number().int().min(0), against: z.number().int().min(0) });

export const seasonFileSchema = z.object({
  league: slug,
  season,
  // kmi-weekly: every key incident has a published panel ruling (2026-27 on).
  // kmi-season-errors: only the panel's end-of-season error list was published; other VAR decisions are inferred correct.
  coverage: z.enum(['kmi-weekly', 'kmi-season-errors']).default('kmi-weekly'),
  source: z.object({ title: z.string(), publisher: z.string(), url: z.string().url() }),
  matches: z.array(matchSchema),
});

export const sentimentFileSchema = z.object({
  league: slug,
  season,
  source: z.object({ title: z.string(), publisher: z.string(), url: z.string().url() }),
  method: z.string(),
  threads: z.array(
    z.object({
      match: z.string(),
      thread: z.object({ id: z.string(), title: z.string(), kind: z.string(), num_comments: z.number(), score: z.number().nullable(), url: z.string().url() }),
      comments: z.number().int(),
      officiating: z.number().int(),
      angry: z.number().int(),
      defending: z.number().int(),
      officiatingShare: z.number(),
      outrage: z.number().int().min(0).max(100),
      /** The club whose fans were angrier about the officiating, i.e. who felt wronged. */
      lean: slug.nullable(),
      split: z.object({ home: z.number(), away: z.number(), neutral: z.number() }),
      topics: z.array(z.string()),
      quotes: z.array(z.object({ text: z.string(), score: z.number(), fan: slug.nullable() })),
    }),
  ),
});

// A "Match Unpacked" page: the post-match report, arguments and Q&A for one fixture.
// Every sentence carries the ids of the sources that back it.
const cited = z.object({ text: z.string(), cite: z.array(slug).default([]) });

export const unpackedSchema = z.object({
  match: z.string(),
  status: z.enum(['prototype', 'draft', 'published']),
  updated: isoDate,
  headline: z.string(),
  standfirst: z.array(cited),
  decided: z.array(
    z.object({
      title: z.string(),
      weight: z.enum(['decisive', 'significant', 'contributing']),
      incident: slug.optional(),
      body: z.array(cited),
    }),
  ),
  bottomLine: z.array(cited),
  timeline: z.array(
    cited.extend({
      /** Wall-clock time, only when a source gives one. In-match events use the match clock alone. */
      at: z.string().datetime({ offset: true }).optional(),
      clock: z.string(),
      incident: slug.optional(),
    }),
  ),
  arguments: z.array(
    z.object({
      question: z.string(),
      /** The incident this question is about; its case file then asks fans the same question. */
      incident: slug.optional(),
      /** The club whose fans would be expected to pick `side`, for the one-eyed index. */
      grievance: z.object({ club: slug, side: z.number().int().min(0).max(1) }).optional(),
      sides: z.array(z.object({ label: z.string(), points: z.array(cited) })).length(2),
      /** `favours` is the side the official verdict came down on, when there is one. */
      resolution: cited.extend({ verdict: callVerdict, favours: z.number().int().min(0).max(1).optional(), by: z.string().optional() }),
    }),
  ),
  questions: z.array(z.object({ q: z.string(), a: z.array(cited) })),
  sources: z.array(
    z.object({
      id: slug,
      title: z.string(),
      publisher: z.string(),
      url: z.string().url(),
      kind: z.enum(['report', 'official', 'analysis', 'discussion']),
      published: z.union([isoDate, z.string().datetime({ offset: true })]).optional(),
    }),
  ),
});

export const seasonTallySchema = z.object({
  league: slug,
  season,
  title: z.string(),
  note: z.string(),
  sources: z.array(source).min(1),
  var: z.array(tallyRow),
  referee: z.array(tallyRow),
});
