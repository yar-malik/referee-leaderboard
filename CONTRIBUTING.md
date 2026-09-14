# Contributing

Thanks for helping keep the record straight. The site is only as trustworthy as its data, so the rules favour accuracy over volume.

## House rules

1. **Source everything.** Every incident needs at least one link to reputable reporting or an official statement.
2. **Judge the call, not the person.** Describe what happened and cite who ruled it wrong. Don't speculate about motives or allegiances.
3. **Prefer authority.** A KMI panel ruling or referees'-body statement outranks punditry. If the panel hasn't ruled yet, use `media-consensus` and update it later.
4. **Quotes are word for word.** If you're summarising, set `"paraphrased": true`.
5. **Log correct calls too.** Accuracy can't be measured from mistakes alone.

## Adding an incident

Create `data/incidents/<league>/<season>/<YYYY-MM-DD>-<id>.json`. The filename must match the `date` and `id` inside.

| Field | Values / notes |
| --- | --- |
| `id` | kebab-case, e.g. `mun-mci-haaland-enzo-offside` |
| `league` | id from `data/leagues.json` |
| `season` | `2026-27` |
| `date` | `YYYY-MM-DD` |
| `home`, `away` | club ids from `data/clubs.json` |
| `score` | final score, home first: `0-1` |
| `minute` | free text: `60'`, `90+8'`, `1st half` |
| `type` | `goal` · `offside` · `penalty` · `red-card` · `handball` · `mistaken-identity` · `other` |
| `title` | ≤ 90 chars, neutral |
| `summary` | what happened, factually |
| `onField` | the on-field decision |
| `varOutcome` | `overturned` · `confirmed` · `no-intervention` · `on-field-review-rejected` |
| `verdictSource` | `kmi-panel` · `official-statement` · `media-consensus` · `community` · `pending` (both calls `null`) |
| `onFieldBy` | `referee` (default) or `assistant-referee` for offside flags |
| `kmiVoteOnField` | optional panel vote on the on-field call, majority first |
| `kmiVote` | optional, e.g. `3-2` |
| `calls.referee` / `calls.var` | `correct` · `error` · `debatable` · `null` (not applicable) |
| `officials` | `referee` (required), `var`, `avar`: ids from `data/officials.json` |
| `benefited`, `harmed` | club ids. Must be the home or away club |
| `impact` | `match-deciding` · `result-changing` · `significant` · `minor` |
| `controversy` | 1–5 |
| `consequences` | optional list of strings |
| `reactions` | optional list of `{ who, role?, quote, paraphrased?, source? }` |
| `sources` | list of `{ title, publisher, url, kind }` where kind is `report` · `official` · `analysis` · `discussion` |
| `featured` | optional. Pins the incident to the homepage case file |

New club or official? Add them to `clubs.json` / `officials.json` in the same PR.

Run `npm run validate` before pushing. CI runs the same check.

## Season match files

`data/matches/<league>/<season>.json` lists every played match with its referee, assistants, fourth official, VAR and AVAR. These power the season page and each official's appointment history. Add new matchweeks as they're played.

## Updating a verdict

Each week the Premier League publishes the KMI panel's outcomes for the previous round. When they're out, switch pending (or `media-consensus`) incidents to `verdictSource: "kmi-panel"`, fill in `calls`, `kmiVote` and `kmiVoteOnField`, and add the panel's PDF as a source. If the panel disagrees with the media verdict, the panel wins.

## Adding a league

Flip `active` to `true` in `data/leagues.json`, add its clubs and officials, and start a folder under `data/incidents/<league-id>/`. Open an issue first so we can agree on which verdict sources count as authoritative for that league.
