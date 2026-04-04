# Pagination + Infinite Scroll Design

## Status: Implemented (v1.1.0)

## Goal

Replace the current full-data-load approach with server-side pagination and frontend infinite scroll. Latest records (last row in Sheet) appear first; scrolling down loads older records.

## Problem Solved

- `GET /api/cars` used to fetch all records from Google Sheets (up to 1000 rows) and return them in one response
- Frontend received and rendered everything at once, causing slow page load
- 5-minute cache TTL caused frequent unnecessary Sheets API calls

---

## Database Changes

### `cars` table (migration `003_cars_table.sql`)

Individual car records stored per-row, replacing the old `car_cache` JSON blob.

```sql
CREATE TABLE IF NOT EXISTS cars (
  item TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  manufacture_date TEXT NOT NULL DEFAULT '',
  mileage TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  vin TEXT NOT NULL DEFAULT '',
  condition TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  exterior_color TEXT NOT NULL DEFAULT '',
  interior_color TEXT NOT NULL DEFAULT '',
  modification TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  po_status TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '',
  bg_color TEXT NOT NULL DEFAULT '',
  row_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `row_order` column (migration `004_cars_row_order.sql`)

Sort column based on Sheet row position. Last row in Sheet = highest `row_order` = latest record. Avoids string-based item sorting issues (e.g. T7 vs T27).

### Sync Logic

- `syncCarsToDb()`: fetches all data from Sheets, `INSERT OR REPLACE` each row with `row_order = index`
- Uses a transaction for atomic batch upsert
- Removes stale rows not present in current Sheet data
- Records sync timestamp via `car_cache.fetched_at`
- Auto re-sync when `row_order` values are all 0 (post-migration)

### Data Filtering in Reader

- `reader.ts` skips rows where `item` doesn't contain a digit (`/\d/` test)
- This filters out Sheet section headers like "寄賣", "台灣" that aren't real car records

### Writer Grid Expansion

- `writer.ts` uses `appendDimension` API to expand Sheet grid before adding new columns
- Required because Sheet only has 23 columns (A-W) and PO狀態 column doesn't exist initially

---

## Cache Strategy

| Trigger | Action |
|---------|--------|
| `GET /api/cars` (normal) | Query `cars` table directly, no Sheets call |
| `GET /api/cars?refresh=true` | Sync from Sheets immediately, then query |
| `POST /api/sync` | Sync from Sheets immediately |
| Auto-refresh | 12-hour TTL. On first request after 12h, trigger sync |
| Row order missing | Auto re-sync if all `row_order` values are 0 |

The old 5-minute in-memory cache is removed. All reads go to SQLite (WAL mode).

---

## API

### `GET /api/cars` — Paginated

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | `1` | Page number (1-based) |
| `pageSize` | number | `50` | Records per page (max 200) |
| `search` | string | - | Search across item, brand, model, vin |
| `status` | string | - | Filter by status |
| `poStatus` | string | - | Filter by PO status |
| `copyStatus` | string | - | `has_copy` or `no_copy` |
| `sort` | string | `item` | Sort field (maps to `row_order` for item) |
| `order` | string | `desc` | Sort direction |
| `all` | boolean | `false` | Return all records (AI agent / batch) |
| `refresh` | boolean | `false` | Force sync from Sheets |

**Response:**

```json
{
  "cars": [ ... ],
  "total": 572,
  "page": 1,
  "pageSize": 50,
  "hasMore": true
}
```

### Other endpoints — Unchanged

`/api/cars/stats`, `/api/cars/new`, `/api/cars/:item/po`, `/api/copies/*`, `/api/chat`

---

## Frontend

### Infinite Scroll (Intersection Observer)

1. Initial load: page 1 (50 records), latest first
2. Sentinel `<div id="scroll-sentinel">` at bottom of table
3. IntersectionObserver with 200px rootMargin triggers `loadNextPage()`
4. Appends new records to existing array
5. Shows spinner while loading, "已載入全部" when done

### Server-Side Filtering

- All filters (search, status, poStatus, copyStatus) sent as query params
- Filter change resets to page 1 and reloads
- Search debounced at 300ms
- `filteredCars` getter returns `this.cars` directly (no client-side filtering)

---

## Compatibility

| Consumer | Handling |
|----------|----------|
| AI Agent (`search_cars` tool) | Backward-compat `getCars()` returns all from DB |
| Batch copy generation | Uses `getCars()` backward-compat export |
| Stats endpoint | Queries all from `cars` table |
| PO status update | Updates DB row + syncs to Sheet (with grid expansion) |
