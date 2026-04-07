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
| post-helper | `src/prompts/platforms/post-helper.md` |
| 8891 | Handled inline (no separate template file) |

## Deployment Notes

- Docker: `TZ=Asia/Taipei` env var required (set in Dockerfile)
- Volume: `/app/data` → SQLite DB + user prompt overrides
- CI/CD: GitHub Actions → DockerHub (`secrets.DOCKERHUB_USERNAME`)
- `@kevinsisi/ai-core` installed via `github:kevinsisi/ai-core` (CJS-compatible commit pinned in lockfile)
