# Pagination + Infinite Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace full-data-load with server-side pagination (SQLite) + frontend infinite scroll, latest items first.

**Architecture:** New `cars` table in SQLite stores individual records (replacing JSON blob cache). API returns paginated results with server-side filtering/sorting. Frontend uses Intersection Observer for infinite scroll, appending pages as user scrolls down.

**Tech Stack:** Express.js + TypeScript backend, better-sqlite3, Alpine.js frontend, Intersection Observer API

**Spec:** `docs/superpowers/specs/2026-04-04-pagination-lazy-load-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/db/migrations/003_cars_table.sql` | New `cars` table + indexes |
| Modify | `src/services/carInventory.ts` | Rewrite: upsert sync, paginated query, 12h TTL |
| Modify | `src/routes/api.ts` | Add pagination params, new response format |
| Modify | `src/public/js/app.js` | Infinite scroll, server-side filtering |
| Modify | `src/public/index.html` | Sentinel element, loading indicators, remove client filter logic |
| Modify | `src/services/agentTools.ts:~line 60` | `search_cars` tool uses `all=true` |

---

### Task 1: Database Migration — `cars` table

**Files:**
- Create: `src/db/migrations/003_cars_table.sql`

This task is independent — no dependencies on other tasks.

- [ ] **Step 1: Create the migration file**

Create `src/db/migrations/003_cars_table.sql`:

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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cars_item_desc ON cars(item DESC);
CREATE INDEX IF NOT EXISTS idx_cars_status ON cars(status);
CREATE INDEX IF NOT EXISTS idx_cars_brand ON cars(brand);
CREATE INDEX IF NOT EXISTS idx_cars_po_status ON cars(po_status);
```

- [ ] **Step 2: Verify migration runs**

Run: `cd /d D:\GitClone\_HomeProject\_car-maintain\sheet-to-car && npx ts-node -e "import {runMigrations} from './src/db/migrate'; runMigrations();"`

Expected: `Running migration: 003_cars_table.sql` then `Migration applied: 003_cars_table.sql`

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/003_cars_table.sql
git commit -m "feat: add cars table migration for pagination support"
```

---

### Task 2: Rewrite `carInventory.ts` — Upsert Sync + Paginated Query

**Files:**
- Modify: `src/services/carInventory.ts` (full rewrite)

This task depends on Task 1 (migration must exist). This is the core backend logic.

- [ ] **Step 1: Rewrite carInventory.ts**

Replace the entire file `src/services/carInventory.ts` with:

```typescript
import { readCarsFromSheet } from '../lib/sheets/reader';
import { updatePoStatus } from '../lib/sheets/writer';
import { CarRecord } from '../lib/sheets/types';
import db from '../db/connection';

const SYNC_TTL = 12 * 60 * 60 * 1000; // 12 hours

function getSpreadsheetId(): string {
  const fromDb = db.prepare("SELECT value FROM settings WHERE key = 'spreadsheet_id'").get() as any;
  return fromDb?.value || process.env.SPREADSHEET_ID || '';
}

/** Check if sync is needed based on last sync time */
function needsSync(): boolean {
  const row = db.prepare('SELECT fetched_at FROM car_cache ORDER BY fetched_at DESC LIMIT 1').get() as any;
  if (!row) return true;
  const lastSync = new Date(row.fetched_at + 'Z').getTime();
  return Date.now() - lastSync > SYNC_TTL;
}

/** Sync all cars from Google Sheets into cars table */
export async function syncCarsToDb(forceRefresh = false): Promise<number> {
  if (!forceRefresh && !needsSync()) {
    const count = db.prepare('SELECT COUNT(*) as c FROM cars').get() as any;
    if (count.c > 0) return count.c;
  }

  const spreadsheetId = getSpreadsheetId();
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID not configured');

  const cars = await readCarsFromSheet(spreadsheetId);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO cars (item, source, brand, year, manufacture_date, mileage, model, vin, condition, status, exterior_color, interior_color, modification, note, po_status, owner, price, bg_color, updated_at)
    VALUES (@item, @source, @brand, @year, @manufactureDate, @mileage, @model, @vin, @condition, @status, @exteriorColor, @interiorColor, @modification, @note, @poStatus, @owner, @price, @bgColor, datetime('now'))
  `);

  const runUpsert = db.transaction((records: CarRecord[]) => {
    for (const car of records) {
      upsert.run(car);
    }
  });
  runUpsert(cars);

  // Update sync timestamp in car_cache
  db.prepare('DELETE FROM car_cache').run();
  db.prepare('INSERT INTO car_cache (data) VALUES (?)').run(JSON.stringify([]));

  return cars.length;
}

/** Paginated query parameters */
export interface PaginationParams {
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
  poStatus?: string;
  copyStatus?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

/** Paginated query result */
export interface PaginatedResult {
  cars: CarRecord[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Column name mapping: API sort key -> DB column */
const SORT_COLUMNS: Record<string, string> = {
  item: 'item',
  brand: 'brand',
  model: 'model',
  year: 'year',
  status: 'status',
};

/** Get paginated cars from DB */
export function getCarsPaginated(params: PaginationParams): PaginatedResult {
  const { page, pageSize, search, status, poStatus, copyStatus, sort = 'item', order = 'desc' } = params;

  const conditions: string[] = [];
  const bindings: any[] = [];

  if (search) {
    conditions.push('(c.item LIKE ? OR c.brand LIKE ? OR c.model LIKE ? OR c.vin LIKE ?)');
    const q = `%${search}%`;
    bindings.push(q, q, q, q);
  }
  if (status) {
    conditions.push('c.status = ?');
    bindings.push(status);
  }
  if (poStatus) {
    conditions.push('c.po_status = ?');
    bindings.push(poStatus);
  }
  if (copyStatus === 'has_copy') {
    conditions.push('(SELECT COUNT(*) FROM car_copies cc WHERE cc.item = c.item) > 0');
  } else if (copyStatus === 'no_copy') {
    conditions.push('(SELECT COUNT(*) FROM car_copies cc WHERE cc.item = c.item) = 0');
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const sortCol = SORT_COLUMNS[sort] || 'item';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * pageSize;

  // Count total
  const countSql = `SELECT COUNT(*) as total FROM cars c ${whereClause}`;
  const { total } = db.prepare(countSql).get(...bindings) as any;

  // Fetch page
  const dataSql = `SELECT c.* FROM cars c ${whereClause} ORDER BY c.${sortCol} ${sortDir} LIMIT ? OFFSET ?`;
  const rows = db.prepare(dataSql).all(...bindings, pageSize, offset) as any[];

  const cars: CarRecord[] = rows.map(row => ({
    item: row.item,
    source: row.source,
    brand: row.brand,
    year: row.year,
    manufactureDate: row.manufacture_date,
    mileage: row.mileage,
    model: row.model,
    vin: row.vin,
    condition: row.condition,
    status: row.status,
    exteriorColor: row.exterior_color,
    interiorColor: row.interior_color,
    modification: row.modification,
    note: row.note,
    poStatus: row.po_status,
    owner: row.owner,
    price: row.price,
    bgColor: row.bg_color,
  }));

  return {
    cars,
    total,
    page,
    pageSize,
    hasMore: offset + cars.length < total,
  };
}

/** Get ALL cars (for AI agent, batch operations) */
export function getAllCars(): CarRecord[] {
  return getCarsPaginated({ page: 1, pageSize: 999999 }).cars;
}

/** Get inventory stats from DB */
export function getStats(): {
  total: number;
  byStatus: Record<string, number>;
  byBrand: Record<string, number>;
  bySource: Record<string, number>;
  byPoStatus: Record<string, number>;
} {
  const cars = getAllCars();
  const byStatus: Record<string, number> = {};
  const byBrand: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byPoStatus: Record<string, number> = {};

  for (const car of cars) {
    byStatus[car.status] = (byStatus[car.status] || 0) + 1;
    if (car.brand) byBrand[car.brand] = (byBrand[car.brand] || 0) + 1;
    bySource[car.source] = (bySource[car.source] || 0) + 1;
    byPoStatus[car.poStatus] = (byPoStatus[car.poStatus] || 0) + 1;
  }

  return { total: cars.length, byStatus, byBrand, bySource, byPoStatus };
}

/** Update PO status in DB and sync to sheet */
export async function setPoStatus(item: string, poStatus: string): Promise<boolean> {
  const spreadsheetId = getSpreadsheetId();
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID not configured');

  const success = await updatePoStatus(spreadsheetId, item, poStatus);
  if (success) {
    db.prepare('UPDATE cars SET po_status = ?, updated_at = datetime(\'now\') WHERE item = ?').run(poStatus, item);
  }
  return success;
}

/** Force sync from sheet */
export async function syncFromSheet(): Promise<number> {
  return syncCarsToDb(true);
}

// ── Backward compat exports (used by agentTools.ts) ──

/** getCars now returns all from DB; forces sync if needed */
export async function getCars(forceRefresh = false): Promise<CarRecord[]> {
  await syncCarsToDb(forceRefresh);
  return getAllCars();
}

export async function getCarsByStatus(status: string): Promise<CarRecord[]> {
  const cars = await getCars();
  return cars.filter(c => c.status === status);
}

export async function getNewCars(): Promise<CarRecord[]> {
  return getCarsByStatus('新到貨');
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /d D:\GitClone\_HomeProject\_car-maintain\sheet-to-car && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/services/carInventory.ts
git commit -m "feat: rewrite carInventory with DB upsert sync and paginated query"
```

---

### Task 3: Update API Routes — Pagination Support

**Files:**
- Modify: `src/routes/api.ts` (lines 1-32, the GET /cars handler)

This task depends on Task 2 (needs new carInventory exports).

- [ ] **Step 1: Update api.ts**

Replace `src/routes/api.ts` entirely with:

```typescript
import { Router, Request, Response } from 'express';
import { getCarsPaginated, syncCarsToDb, getNewCars, getStats, setPoStatus, syncFromSheet, getAllCars } from '../services/carInventory';

const router = Router();

// GET /api/cars — paginated cars with server-side filtering
router.get('/cars', async (req: Request, res: Response) => {
  try {
    const refresh = req.query.refresh === 'true';
    const all = req.query.all === 'true';

    // Sync if refresh requested or on first load
    await syncCarsToDb(refresh);

    if (all) {
      const cars = getAllCars();
      return res.json({ cars, total: cars.length });
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize as string) || 50));
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const poStatus = req.query.poStatus as string | undefined;
    const copyStatus = req.query.copyStatus as string | undefined;
    const sort = req.query.sort as string || 'item';
    const order = (req.query.order as string || 'desc') as 'asc' | 'desc';

    const result = getCarsPaginated({ page, pageSize, search, status, poStatus, copyStatus, sort, order });
    return res.json(result);
  } catch (err: any) {
    console.error('[api] Error fetching cars:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/cars/new — new arrivals
router.get('/cars/new', async (_req: Request, res: Response) => {
  try {
    const cars = await getNewCars();
    return res.json({ cars, total: cars.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/cars/stats — aggregate stats
router.get('/cars/stats', async (_req: Request, res: Response) => {
  try {
    await syncCarsToDb();
    const stats = getStats();
    return res.json(stats);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/cars/:item/po — update PO status
router.post('/cars/:item/po', async (req: Request, res: Response) => {
  try {
    const { item } = req.params;
    const { poStatus } = req.body;
    if (!poStatus) return res.status(400).json({ error: 'poStatus is required' });

    const success = await setPoStatus(item, poStatus);
    if (!success) return res.status(404).json({ error: `Car "${item}" not found in sheet` });

    return res.json({ success: true, item, poStatus });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/sync — force refresh from Google Sheets
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const count = await syncFromSheet();
    return res.json({ success: true, count });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /d D:\GitClone\_HomeProject\_car-maintain\sheet-to-car && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/routes/api.ts
git commit -m "feat: add pagination params to GET /api/cars endpoint"
```

---

### Task 4: Frontend — Infinite Scroll + Server-Side Filtering

**Files:**
- Modify: `src/public/js/app.js` (full rewrite of data loading and filtering logic)
- Modify: `src/public/index.html` (sentinel element, loading indicators, update template bindings)

This task depends on Task 3 (needs the new API response format).

- [ ] **Step 1: Update app.js state and loadCars**

In `src/public/js/app.js`, replace lines 1-11 (the state declarations up to `sort`) with:

```javascript
function app() {
  return {
    view: 'dashboard',
    loading: false,
    syncing: false,
    cars: [],
    stats: {},
    filter: { search: '', status: '', poStatus: '', copyStatus: '' },
    copySummary: {},
    sort: { key: 'item', asc: false },  // default desc
    dark: localStorage.getItem('dark') === 'true',
    lastUpdated: null,
    batchRunning: false,
    batchProgress: null,
    batchLimit: 5,
    maxSelect: 20,
    copyToast: '',
    selectedItems: new Set(),

    // Pagination
    page: 1,
    pageSize: 50,
    totalCars: 0,
    hasMore: true,
    loadingMore: false,
    _searchDebounce: null,
```

- [ ] **Step 2: Replace loadCars method**

In `src/public/js/app.js`, replace the existing `loadCars()` method (lines 147-158) with:

```javascript
    async loadCars(reset = false) {
      if (reset) {
        this.cars = [];
        this.page = 1;
        this.hasMore = true;
      }
      if (!this.hasMore && !reset) return;

      if (this.page === 1) {
        this.loading = true;
      } else {
        this.loadingMore = true;
      }

      try {
        const params = new URLSearchParams({
          page: String(this.page),
          pageSize: String(this.pageSize),
          sort: this.sort.key,
          order: this.sort.asc ? 'asc' : 'desc',
        });
        if (this.filter.search) params.set('search', this.filter.search);
        if (this.filter.status) params.set('status', this.filter.status);
        if (this.filter.poStatus) params.set('poStatus', this.filter.poStatus);
        if (this.filter.copyStatus) {
          // Map UI values to API values
          const map = { '未生成': 'no_copy', '部分': 'has_copy', '完整': 'has_copy' };
          const val = map[this.filter.copyStatus];
          if (val) params.set('copyStatus', val);
        }

        const resp = await fetch(`/api/cars?${params}`);
        const data = await resp.json();

        if (reset || this.page === 1) {
          this.cars = data.cars || [];
        } else {
          this.cars = [...this.cars, ...(data.cars || [])];
        }
        this.totalCars = data.total;
        this.hasMore = data.hasMore;
        this.lastUpdated = new Date();
      } catch (err) {
        console.error('Failed to load cars:', err);
      }

      this.loading = false;
      this.loadingMore = false;
    },

    loadNextPage() {
      if (!this.hasMore || this.loadingMore || this.loading) return;
      this.page++;
      this.loadCars();
    },
```

- [ ] **Step 3: Replace filteredCars and sortBy**

Remove the `get filteredCars()` getter (lines 106-129) and replace with:

```javascript
    get filteredCars() {
      // Filtering is now server-side; just return loaded cars
      return this.cars;
    },
```

Replace `sortBy` (lines 131-138) with:

```javascript
    sortBy(key) {
      if (this.sort.key === key) {
        this.sort.asc = !this.sort.asc;
      } else {
        this.sort.key = key;
        this.sort.asc = false;
      }
      this.loadCars(true);
    },
```

- [ ] **Step 4: Replace syncSheet to use the new flow**

Replace `syncSheet()` (lines 167-176) with:

```javascript
    async syncSheet() {
      this.syncing = true;
      try {
        await fetch('/api/sync', { method: 'POST' });
        await Promise.all([this.loadCars(true), this.loadStats()]);
      } catch (err) {
        alert('同步失敗: ' + err.message);
      }
      this.syncing = false;
    },
```

- [ ] **Step 5: Add filter watchers in init**

Replace `init()` (lines 47-49) with:

```javascript
    async init() {
      this.applyDark();
      await Promise.all([this.loadCars(true), this.loadStats(), this.checkBatchStatus(), this.loadCopySummary()]);

      // Watch filters — reload on change
      this.$watch('filter.status', () => this.loadCars(true));
      this.$watch('filter.poStatus', () => this.loadCars(true));
      this.$watch('filter.copyStatus', () => this.loadCars(true));
      this.$watch('filter.search', () => {
        clearTimeout(this._searchDebounce);
        this._searchDebounce = setTimeout(() => this.loadCars(true), 300);
      });
    },
```

- [ ] **Step 6: Add Intersection Observer setup in init**

After the `init()` method, add a new method:

```javascript
    setupScrollObserver() {
      const sentinel = document.getElementById('scroll-sentinel');
      if (!sentinel) return;
      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          this.loadNextPage();
        }
      }, { rootMargin: '200px' });
      observer.observe(sentinel);
    },
```

And at the end of `init()`, after the `$watch` calls, add:

```javascript
      this.$nextTick(() => this.setupScrollObserver());
```

- [ ] **Step 7: Update index.html — sentinel element and loading indicators**

In `src/public/index.html`, find the closing `</table>` tag for the car table. After it (but still inside the `overflow-x-auto` div), add:

```html
        <!-- Scroll sentinel for infinite loading -->
        <div id="scroll-sentinel" class="h-1"></div>

        <!-- Loading more indicator -->
        <div x-show="loadingMore" class="flex justify-center py-4">
          <svg class="animate-spin h-6 w-6 text-purple-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          <span class="ml-2 text-sm text-gray-500">載入更多...</span>
        </div>

        <!-- All loaded indicator -->
        <div x-show="!hasMore && cars.length > 0 && !loading" class="text-center py-3 text-sm text-gray-400">
          已載入全部 <span x-text="totalCars"></span> 筆資料
        </div>
```

- [ ] **Step 8: Update the total count display**

In `src/public/index.html`, find the line with `filteredCars.length` (around line 126):

```html
<span class="text-sm text-gray-500 dark:text-gray-400" x-text="`共 ${filteredCars.length} 台`"></span>
```

Replace with:

```html
<span class="text-sm text-gray-500 dark:text-gray-400" x-text="`共 ${totalCars} 台 (已載入 ${cars.length})`"></span>
```

- [ ] **Step 9: Verify the app builds and runs**

Run: `cd /d D:\GitClone\_HomeProject\_car-maintain\sheet-to-car && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add src/public/js/app.js src/public/index.html
git commit -m "feat: add infinite scroll with server-side pagination and filtering"
```

---

### Task 5: Update Agent Tools for Compatibility

**Files:**
- Modify: `src/services/agentTools.ts` (~line 60, the `search_cars` tool handler)

This task depends on Task 2. Small change to ensure AI agent still gets full data.

- [ ] **Step 1: Check current search_cars handler**

Read `src/services/agentTools.ts` to find the `search_cars` handler function. It currently calls `getCars()` which now returns all cars from DB. This should continue working as-is because `getCars()` backward-compat export still returns all cars.

Verify no changes needed — the backward-compat `getCars()` in Task 2 already handles this.

- [ ] **Step 2: Commit (if changes were needed)**

If no changes needed, skip this step.

---

### Task 6: End-to-End Verification

**Files:** None (testing only)

This task depends on all previous tasks.

- [ ] **Step 1: Build and start the server**

Run: `cd /d D:\GitClone\_HomeProject\_car-maintain\sheet-to-car && npm run build && npm start`

Expected: Server starts without errors

- [ ] **Step 2: Test paginated API**

Run: `curl http://localhost:5223/api/cars?page=1&pageSize=5`

Expected: Response with `{ cars: [...5 items], total: N, page: 1, pageSize: 5, hasMore: true }`

- [ ] **Step 3: Test filtered API**

Run: `curl "http://localhost:5223/api/cars?page=1&pageSize=5&status=在庫"`

Expected: Only cars with status `在庫`, correct total count

- [ ] **Step 4: Test all=true for backward compat**

Run: `curl "http://localhost:5223/api/cars?all=true"`

Expected: All cars in one response (same format as before)

- [ ] **Step 5: Test sync**

Run: `curl -X POST http://localhost:5223/api/sync`

Expected: `{ success: true, count: N }`

- [ ] **Step 6: Test in browser**

Open `https://car.sisihome.org` and verify:
1. Page loads fast with first 50 records (item desc)
2. Scrolling down loads more records
3. Changing filters reloads from page 1
4. Search debounces and filters server-side
5. "同步" button triggers immediate sheet refresh
6. Stats display correctly

- [ ] **Step 7: Final commit with version bump**

Bump version in relevant files, then commit and push.
