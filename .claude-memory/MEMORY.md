# sheet-to-car — Project Memory

## Architecture Decisions

| Decision | Rationale |
|---|---|
| Google Sheets as source of truth | Inventory managed in `整合庫存` tab; DB is a read cache + write-back for PO flags |
| Key pool over single key | Multiple Gemini keys in DB settings; 60 s cache + cooldown prevents repeated 429s |
| Row order tracking | `row_order` column syncs sheet sequence; UI sort is independent |
| 7-day copy expiry | Published copies auto-expire; hourly cron cleanup (not lazy delete) |
| User prompts in data/ | `data/prompts/` overrides `dist/prompts/`; mounted as Docker volume for persistence |
| SSE for streaming | Both chat and batch copy generation use SSE (not WebSocket) |
| Single-car generation lock | UI and API both block duplicate copy generation for the same car while one request is in flight |
| 8891 skill guardrails | 8891 generation auto-loads local skill rules and returns review hints for inferred fields |
| Vehicle analysis MVP | New cars auto-run baseline analysis after bootstrap, dashboard shows pending-attention cars, expanded rows support photo-based Gemini analysis, review hints can be accepted/ignored with accepted values merged back into car data, and copy generation explicitly consumes confirmed findings while treating unresolved fields as non-facts |
| Review accept modes | Analysis/photo review acceptance now supports `supplement` and `replace`; supplement appends confirmed values, while replace is intentionally limited to numeric `specs.*` fields already consumed downstream (`engineDisplacement`, `doors`, `seats`, `horsepower`, `torque`) to avoid clobbering freeform text or ambiguous enum values |
| Copy reliability metadata | Each saved draft copy persists confirmed-feature count and pending-field count so reliability hints survive reloads |
| Structured confirmed features | Accepted analysis results are also stored in `vehicle_confirmed_features` so copy generation does not depend only on freeform note/modification text |
| VIN decode fallback | VIN decode is optional evidence only; failures fall back to cached/basic data plus review hints instead of blocking analysis or copy generation |
| 8891 structured draft | 8891 generation now prebuilds a post-helper-compatible JSON draft from sheet data, confirmed features, team contact, and VIN decode before asking Gemini to fill the remaining gaps |
| 8891 compatibility validation | Generated 8891 JSON is normalized and validated against post-helper's required basic/spec rules before being saved, with problems surfaced as review hints |
| 8891 validation summary | Each saved 8891 copy persists validation status plus error/warning counts so the UI can show readiness for post-helper without opening the JSON |
| Frontend update modal | The SPA tracks the last seen app version in localStorage and shows changelog-driven release notes once per version |
| Generate-all partial success | Full copy generation now saves successful platforms even if another platform fails, and the UI reports which platforms need retry |
| No ORM | Raw better-sqlite3 SQL; migrations are append-only |
| CommonJS only | `tsconfig.json` module: commonjs; no ESM imports |

## Key Files

| Concern | Path |
|---|---|
| Server entry | `src/index.ts` |
| DB init & migrations | `src/db/connection.ts`, `src/db/migrate.ts`, `src/db/migrations/` |
| Google Sheets sync | `src/lib/sheets/` (reader, writer, auth, parser) |
| AI chat agent | `src/services/agent.ts`, `src/services/agentTools.ts` |
| Copy generation | `src/services/copyGenerator.ts` |
| Key rotation | `src/services/geminiKeys.ts`, `src/services/geminiRetry.ts` |
| Platform prompts | `src/prompts/platforms/*.md` + `data/prompts/` (runtime overrides) |
| Route handlers | `src/routes/` (api, chat, copies, settings, prompts) |
| Frontend SPA | `src/public/index.html`, `src/public/js/app.js` |
| Skill loading | `src/services/skillLoader.ts`, `skills/**/SKILL.md` |

## Hard Constraints

- **No package version upgrades** — only add new devDeps
- **Never log full API keys** — suffix only (`key.slice(-4)`)
- **Migrations append-only** — never alter or delete existing `.sql` files
- **SSE routes** — `res.flushHeaders()` must be called immediately after setting SSE headers
- **TypeScript strict** — no implicit any; explicit casts on DB results

## Copy Platforms

| Platform | Template |
|---|---|
| 官網 | `src/prompts/platforms/官網.md` |
| Facebook | `src/prompts/platforms/Facebook.md` |
| 8891 | `src/prompts/platforms/8891.md` |

## Deployment Notes

- Docker: `TZ=Asia/Taipei` env var required (set in Dockerfile)
- Volume: `/app/data` → SQLite DB + user prompt overrides
- CI/CD: GitHub Actions → DockerHub (`secrets.DOCKERHUB_USERNAME`)
- `@kevinsisi/ai-core` installed via `github:kevinsisi/ai-core` (CJS-compatible commit pinned in lockfile)
