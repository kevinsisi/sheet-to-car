# CLAUDE.md — sheet-to-car

Car garage management web app: syncs Google Sheets inventory → SQLite, serves paginated REST API, generates AI product copy with Gemini.

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node 22, TypeScript 5 (CommonJS) |
| Web | Express 4 |
| DB | SQLite via better-sqlite3 (WAL mode) |
| Frontend | Alpine.js + TailwindCSS (single-page, `src/public/index.html`) |
| AI | Google Gemini 2.5 Flash (`@google/generative-ai`) |
| Retry / Key pool | `@kevinsisi/ai-core` (custom lib, `github:kevinsisi/ai-core`) |
| Sheets | googleapis v4 |

## Architecture

### Google Sheets Sync (`src/lib/sheets/`)

- **reader.ts** — Reads `整合庫存!A1:AZ1000`, parses flexible Chinese/English headers, skips section rows (no digits in item column)
- **writer.ts** — Dynamically finds/creates columns by header name; updates PO status + per-platform flags back to sheet
- **auth.ts** — OAuth2 service account auth; credentials persist in `settings` table
- **parser.ts** — Row parsing helpers (truthy values: true/1/v/✓/yes)
- Sync TTL: 12 h (configurable in DB settings); forced via `POST /api/sync`

### Gemini AI Copy Generation (`src/services/copyGenerator.ts`)

- Prompt = car data + team member contact (resolved from `owner` field) + platform Markdown template + user preferences
- Platforms: **官網**, **8891**, **Facebook**, **post-helper**
- Copy lifecycle: `draft` → publish → `上架` (7-day expiry set) → hourly cleanup removes expired rows
- Platform templates: `src/prompts/platforms/*.md` (default); user overrides in `data/prompts/` (volume-mounted, highest priority)

### API Key Pool (`src/services/geminiKeys.ts`)

- Keys stored in env (`GEMINI_API_KEY`, comma-separated) **and** SQLite `settings` table (merged at runtime)
- In-memory cache refreshes every 60 s
- Cooldown durations: 429 → 2 min · 401/403 → 30 min · server errors → 30 s
- Usage tracked per key **suffix** in `api_key_usage` table (never log full key)
- `@kevinsisi/ai-core` `withRetry` drives automatic failover across the pool

### AI Chat Agent (`src/services/agent.ts` + `agentTools.ts`)

- SSE streaming via `POST /api/chat`
- Gemini function-calling with 6 declared tools:

  | Tool | Purpose |
  |---|---|
  | `search_cars` | Filter inventory |
  | `get_stats` | Aggregate counts |
  | `update_po` | Mutate PO status |
  | `generate_copy` | Generate product copy |
  | `remember_preference` | Persist user tone/style/rules |
  | `update_platform_prompt` | View / edit / reset platform prompt |

- History persisted in `chat_history` by `sessionId`

## Database Schema

SQLite at `data/sheet-to-car.db`, WAL mode, `PRAGMA foreign_keys = ON`.

| Table | Purpose |
|---|---|
| `settings` | Key-value config (spreadsheet_id, gemini_api_keys, gemini_model, system_prompt) |
| `cars` | Main inventory (item PK, 20+ columns, 4 per-platform PO flags) |
| `car_copies` | Generated copy (per platform, draft / 上架, 7-day expiry) |
| `chat_history` | Chat sessions (role, content, sessionId, indexed) |
| `api_key_usage` | Token tracking per key suffix |
| `api_key_cooldowns` | Rate-limit cooldown state |
| `user_preferences` | AI agent memory (tone, style, custom_rules) |
| `team_members` | Sales team contact info (seeded) |

Migrations run at startup from `src/db/migrations/*.sql` (state tracked in DB). Migrations are **append-only** — never drop or rename columns.

## API Reference

### Inventory

```
GET  /api/cars                    paginated: ?page&pageSize&search&status&poStatus&copyStatus&sort&order
GET  /api/cars?all=true           all cars (used by AI agent tools)
GET  /api/cars/stats              aggregate counts by status / brand / source / PO
GET  /api/cars/new                new arrivals (status = 新到貨)
POST /api/cars/:item/po           update PO status
POST /api/cars/:item/po-platform  update per-platform PO flag
POST /api/sync                    force Google Sheets refresh
```

### Chat

```
POST   /api/chat                      SSE stream (sessionId in body)
GET    /api/chat/history/:sessionId
DELETE /api/chat/history/:sessionId
```

### Copies

```
GET    /api/copies/:item              get copies for a car
POST   /api/copies/:item/generate     generate copy (body: platform or all)
POST   /api/copies/batch-generate     SSE batch generation (up to 20 cars)
PATCH  /api/copies/:id/publish        set 上架 + expires_at = now + 7d
PATCH  /api/copies/:id/unpublish      revert to draft
DELETE /api/copies/:id
POST   /api/copies/cleanup            remove expired copies
GET    /api/copies/summary/all        copy counts per car
GET    /api/copies/preferences/all
PUT    /api/copies/preferences
GET    /api/copies/team/members
```

### Settings

```
GET    /api/settings
PUT    /api/settings
GET    /api/settings/api-keys
POST   /api/settings/api-keys
POST   /api/settings/api-keys/batch   bulk import from newline-separated text
DELETE /api/settings/api-keys/:suffix
POST   /api/settings/validate-key
GET    /api/settings/token-usage      daily / weekly / monthly stats
```

### Prompts

```
GET  /api/prompts/:platform
PUT  /api/prompts/:platform
POST /api/prompts/:platform/reset
```

## Environment Variables

```
SPREADSHEET_ID=...    # Google Sheet ID (required)
GEMINI_API_KEY=...    # Comma-separated Gemini keys (required; also storable in DB)
PORT=3000             # Default 3000
TZ=Asia/Taipei        # Set in container
```

Google OAuth credentials are stored as JSON in the `settings` table (see `src/lib/sheets/auth.ts`).

## Deployment

Docker multi-stage build (builder → runtime on Node 22 Bookworm):

- **Builder**: `node:22-bookworm` (glibc consistent)
- **Runtime**: `node:22-bookworm-slim`
- **Hybrid Support**: Supports `INTERNAL_GIT_MIRROR` ARG for Git `insteadOf` redirection.

```bash
docker build -t sheet-to-car .
docker run -d -p 3000:3000 \
  -e SPREADSHEET_ID=... \
  -e GEMINI_API_KEY=... \
  -e TZ=Asia/Taipei \
  -v $(pwd)/data:/app/data \
  sheet-to-car
```

Volume mount `/app/data` is **required** for SQLite persistence and user prompt overrides.

## Development

```bash
npm run dev           # ts-node src/index.ts (no build step)
npm run build         # tsc → dist/
npm run start         # node dist/index.js
npm run lint          # ESLint (src/)
npm run lint:fix      # ESLint --fix
npm run format        # Prettier --write
npm run format:check  # Prettier --check (CI)
```

## Conventions & Constraints

- **TypeScript strict mode** — no implicit any; explicit casts on all DB query results
- **No ORM** — raw SQL via better-sqlite3; keep all SQL in service files, not in routes
- **CommonJS only** — `tsconfig.json` `module: commonjs`; no ESM imports (`import()` calls are fine for dynamic use)
- **No package upgrades** — do not change existing dependency versions; add new devDeps only as needed
- **Sensitive data** — log API keys by suffix only (`key.slice(-4)`); never expose full key in logs or API responses
- **Copy expiry** — always set `expires_at = strftime('%s','now') + 604800` on publish; rely on cleanup cron, never lazy-delete
- **Sheets writer** — auto-creates missing columns; never hardcode column indices
- **SSE routes** — set `Content-Type: text/event-stream` + `Cache-Control: no-cache` + `Connection: keep-alive`; call `res.flushHeaders()` immediately
- **AI agent tools** — declare schema in `agentTools.ts`; execute in the `executeTool()` switch; keep declarations and implementations in sync
- **Row order** — maintain `row_order` from sheet; UI sort order is independent and does not write back
- **Migrations** — append-only numbered SQL files; never alter existing migration files
