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
    const hasOrder = db.prepare('SELECT COUNT(*) as c FROM cars WHERE row_order > 0').get() as any;
    if (count.c > 0 && hasOrder.c > 0) return count.c;
  }

  const spreadsheetId = getSpreadsheetId();
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID not configured');

  const cars = await readCarsFromSheet(spreadsheetId);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO cars (item, source, brand, year, manufacture_date, mileage, model, vin, condition, status, exterior_color, interior_color, modification, note, po_status, owner, price, bg_color, row_order, po_official, po_8891, po_facebook, po_post_helper, updated_at)
    VALUES (@item, @source, @brand, @year, @manufactureDate, @mileage, @model, @vin, @condition, @status, @exteriorColor, @interiorColor, @modification, @note, @poStatus, @owner, @price, @bgColor, @rowOrder, @poOfficial, @po8891, @poFacebook, @poPostHelper, datetime('now'))
  `);

  const validItems = new Set(cars.map(c => c.item));
  const runSync = db.transaction((records: CarRecord[]) => {
    // Remove stale rows not in current sheet data
    const existing = db.prepare('SELECT item FROM cars').all() as { item: string }[];
    for (const row of existing) {
      if (!validItems.has(row.item)) {
        db.prepare('DELETE FROM cars WHERE item = ?').run(row.item);
      }
    }
    // row_order = index in sheet (0-based), last row = highest number = latest
    for (let i = 0; i < records.length; i++) {
      upsert.run({
        ...records[i],
        rowOrder: i,
        poOfficial: records[i].poOfficial ? 1 : 0,
        po8891: records[i].po8891 ? 1 : 0,
        poFacebook: records[i].poFacebook ? 1 : 0,
        poPostHelper: records[i].poPostHelper ? 1 : 0,
      });
    }
  });
  runSync(cars);

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

/** Column name mapping: API sort key -> DB column/expression */
const SORT_COLUMNS: Record<string, string> = {
  item: 'row_order',
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
    poOfficial: !!row.po_official,
    po8891: !!row.po_8891,
    poFacebook: !!row.po_facebook,
    poPostHelper: !!row.po_post_helper,
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

/** Update per-platform PO status in DB and sync to sheet */
export async function setPoPlatform(item: string, platform: string, value: boolean): Promise<boolean> {
  const spreadsheetId = getSpreadsheetId();
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID not configured');

  const { updatePoPlatform } = await import('../lib/sheets/writer');
  const success = await updatePoPlatform(spreadsheetId, item, platform, value);
  if (success) {
    const colMap: Record<string, string> = {
      official: 'po_official',
      '8891': 'po_8891',
      facebook: 'po_facebook',
      post_helper: 'po_post_helper',
    };
    const col = colMap[platform];
    if (col) {
      db.prepare(`UPDATE cars SET ${col} = ?, updated_at = datetime('now') WHERE item = ?`).run(value ? 1 : 0, item);
    }
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
