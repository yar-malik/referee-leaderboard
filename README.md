# Clear & Obvious

**An open-source ledger of VAR and referee decisions, starting with the Premier League.**

Every incident is a small, sourced JSON file. The site turns those files into:

- **Officials leaderboard.** Errors, accuracy and a damage score that weights each error by its impact. There's a "Hall of shame" and a "Clean sheet".
- **Club ledger.** Errors that went for and against each club, plus the Premier League Key Match Incidents (KMI) panel's own season tallies.
- **Official × club heatmap.** Shows whose mistakes helped whom. It's a prompt to ask questions, not proof of bias.
- **Case files.** Each incident gets a full page with the call, the fallout, reactions and every source.

The dataset starts with the September 2026 Manchester derby. VAR overturned an offside flag to award Haaland's winner, and Pro Ref later admitted an "error of judgement". It also covers landmark incidents back to 2022-23.

## Run it

```bash
npm install
npm run dev        # http://localhost:4321
npm run validate   # schema + reference checks for everything in data/
npm run build      # validate, then build the static site into dist/
```

Built with [Astro](https://astro.build). The output is fully static, so you can host it anywhere.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md). In short:

1. **No code:** open an [incident issue](../../issues/new?template=incident.yml).
2. **Pull request:** add `data/incidents/<league>/<season>/<date>-<id>.json`, run `npm run validate`, then open a PR. CI checks every file.

## Layout

```
data/
  leagues.json, clubs.json, officials.json
  incidents/premier-league/<season>/*.json   ← one file per decision
  season-tallies/*.json                      ← KMI panel season tables
src/lib/schema.mjs   ← the data contract (zod), shared by site + CI
src/lib/data.ts      ← leaderboard maths
src/pages/           ← routes
scripts/deploy.sh    ← build + rsync to a server
```

## Licence

Code: MIT. Data in `data/`: CC BY-SA 4.0. Not affiliated with the Premier League, PGMOL/Pro Ref or any club.
