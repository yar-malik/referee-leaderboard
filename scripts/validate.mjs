// Validates every file under data/ against the shared schema and checks that
// all club/official/league references resolve. Run by CI on every pull request.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { clubSchema, incidentSchema, leagueSchema, officialSchema, seasonFileSchema, seasonTallySchema } from '../src/lib/schema.mjs';

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
