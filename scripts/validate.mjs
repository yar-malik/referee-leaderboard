// Validates every file under data/ against the shared schema and checks that
// all club/official/league references resolve. Run by CI on every pull request.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { clubSchema, incidentSchema, leagueSchema, officialSchema, seasonFileSchema, seasonTallySchema, sentimentFileSchema, unpackedSchema } from '../src/lib/schema.mjs';

const root = new URL('../data/', import.meta.url).pathname;
const errors = [];

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    errors.push(`${relative(root, path)}: invalid JSON (${e.message})`);
    return null;
  }
};

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') ? [p] : [];
  });

const check = (schema, value, label) => {
  const result = schema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) errors.push(`${label}: ${issue.path.join('.') || '(root)'} ${issue.message}`);
  }
  return result.success ? result.data : null;
};

const listOf = (file, schema) => {
  const raw = readJson(join(root, file)) ?? [];
  const items = raw.map((item, i) => check(schema, item, `${file}[${i}]`)).filter(Boolean);
  const dupes = items.map((x) => x.id).filter((id, i, a) => a.indexOf(id) !== i);
  for (const d of dupes) errors.push(`${file}: duplicate id "${d}"`);
  return new Set(items.map((x) => x.id));
};

const leagues = listOf('leagues.json', leagueSchema);
const clubs = listOf('clubs.json', clubSchema);
const officials = listOf('officials.json', officialSchema);

const incidentIds = new Set();
const incidentFiles = walk(join(root, 'incidents'));
for (const file of incidentFiles) {
  const label = relative(root, file);
  const inc = check(incidentSchema, readJson(file), label);
  if (!inc) continue;
  if (incidentIds.has(inc.id)) errors.push(`${label}: duplicate incident id "${inc.id}"`);
  incidentIds.add(inc.id);
  if (!file.endsWith(`${inc.date}-${inc.id}.json`)) errors.push(`${label}: filename must be "${inc.date}-${inc.id}.json"`);
  if (!file.includes(`/${inc.league}/${inc.season}/`)) errors.push(`${label}: must live in incidents/${inc.league}/${inc.season}/`);
  if (!leagues.has(inc.league)) errors.push(`${label}: unknown league "${inc.league}"`);
  for (const c of [inc.home, inc.away]) if (!clubs.has(c)) errors.push(`${label}: unknown club "${c}" (add it to clubs.json)`);
  for (const [role, id] of Object.entries(inc.officials)) {
    if (id && !officials.has(id)) errors.push(`${label}: unknown ${role} "${id}" (add them to officials.json)`);
  }
}

let matchCount = 0;
for (const file of walk(join(root, 'matches'))) {
  const label = relative(root, file);
  const f = check(seasonFileSchema, readJson(file), label);
  if (!f) continue;
  for (const m of f.matches) {
    matchCount++;
    for (const c of [m.home, m.away]) if (!clubs.has(c)) errors.push(`${label} ${m.id}: unknown club "${c}"`);
    for (const [role, id] of Object.entries(m.officials)) {
      if (id && !officials.has(id)) errors.push(`${label} ${m.id}: unknown ${role} "${id}"`);
    }
  }
}

const matchIds = new Set();
for (const file of walk(join(root, 'matches'))) {
  const f = readJson(file);
  for (const m of f?.matches ?? []) matchIds.add(m.id);
}
for (const file of walk(join(root, 'sentiment'))) {
  const label = relative(root, file);
  const f = check(sentimentFileSchema, readJson(file), label);
  if (!f) continue;
  for (const t of f.threads) {
    if (!matchIds.has(t.match)) errors.push(`${label}: unknown match "${t.match}"`);
    if (t.lean && !clubs.has(t.lean)) errors.push(`${label} ${t.match}: unknown club "${t.lean}"`);
  }
}

for (const file of walk(join(root, 'unpacked'))) {
  const label = relative(root, file);
  const u = check(unpackedSchema, readJson(file), label);
  if (!u) continue;
  if (!matchIds.has(u.match)) errors.push(`${label}: unknown match "${u.match}"`);
  const sourceIds = new Set(u.sources.map((s) => s.id));
  const cited = [u.standfirst, u.bottomLine, u.timeline, u.decided.flatMap((d) => d.body), u.questions.flatMap((q) => q.a),
    u.arguments.flatMap((a) => [a.resolution, ...a.sides.flatMap((s) => s.points)])].flat();
  for (const c of cited) for (const id of c.cite) if (!sourceIds.has(id)) errors.push(`${label}: unknown source "${id}"`);
  for (const g of u.arguments.map((a) => a.grievance).filter(Boolean)) if (!clubs.has(g.club)) errors.push(`${label}: unknown club "${g.club}"`);
  for (const id of [...u.decided, ...u.timeline, ...u.arguments].map((x) => x.incident).filter(Boolean)) {
    if (!incidentIds.has(id)) errors.push(`${label}: unknown incident "${id}"`);
  }
}

for (const file of walk(join(root, 'season-tallies'))) {
  const label = relative(root, file);
  const t = check(seasonTallySchema, readJson(file), label);
  if (!t) continue;
  for (const row of [...t.var, ...t.referee]) if (!clubs.has(row.club)) errors.push(`${label}: unknown club "${row.club}"`);
}

if (errors.length) {
  console.error(`✗ ${errors.length} data problem(s):\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(`✓ data OK — ${incidentFiles.length} incidents, ${matchCount} matches, ${clubs.size} clubs, ${officials.size} officials`);
