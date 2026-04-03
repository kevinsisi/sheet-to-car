import { readCarsFromSheet } from '../lib/sheets/reader';
import { updatePoStatus } from '../lib/sheets/writer';
import { CarRecord } from '../lib/sheets/types';
import db from '../db/connection';

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cachedCars: CarRecord[] = [];
let lastFetchTime = 0;

function getSpreadsheetId(): string {
  const fromDb = db.prepare("SELECT value FROM settings WHERE key = 'spreadsheet_id'").get() as any;
  return fromDb?.value || process.env.SPREADSHEET_ID || '';
}

/** Get all cars (from cache or fresh fetch) */
export async function getCars(forceRefresh = false): Promise<CarRecord[]> {
  const now = Date.now();

  if (!forceRefresh && cachedCars.length > 0 && now - lastFetchTime < CACHE_TTL) {
    return cachedCars;
  }

  const spreadsheetId = getSpreadsheetId();
  if (!spreadsheetId) {
    throw new Error('SPREADSHEET_ID not configured');
  }

  try {
    cachedCars = await readCarsFromSheet(spreadsheetId);
    lastFetchTime = Date.now();

    // Persist to DB for offline access
    db.prepare('DELETE FROM car_cache').run();
    db.prepare('INSERT INTO car_cache (data) VALUES (?)').run(JSON.stringify(cachedCars));

    return cachedCars;
  } catch (err) {
    // Fallback to DB cache
    if (cachedCars.length === 0) {
      const row = db.prepare('SELECT data FROM car_cache ORDER BY fetched_at DESC LIMIT 1').get() as any;
      if (row?.data) {
        cachedCars = JSON.parse(row.data);
        return cachedCars;
      }
    }
    throw err;
  }
}

/** Get cars filtered by status */
export async function getCarsByStatus(status: string): Promise<CarRecord[]> {
  const cars = await getCars();
  return cars.filter(c => c.status === status);
}

/** Get new arrivals */
export async function getNewCars(): Promise<CarRecord[]> {
  return getCarsByStatus('新到貨');
}

/** Get inventory stats */
export async function getStats(): Promise<{
  total: number;
  byStatus: Record<string, number>;
  byBrand: Record<string, number>;
  bySource: Record<string, number>;
  byPoStatus: Record<string, number>;
}> {
  const cars = await getCars();
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

/** Update PO status and sync to sheet */
export async function setPoStatus(item: string, poStatus: string): Promise<boolean> {
  const spreadsheetId = getSpreadsheetId();
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID not configured');

  const success = await updatePoStatus(spreadsheetId, item, poStatus);
  if (success) {
    // Update local cache
    const car = cachedCars.find(c => c.item === item);
    if (car) car.poStatus = poStatus;
  }
  return success;
}

/** Force refresh from sheet */
export async function syncFromSheet(): Promise<number> {
  const cars = await getCars(true);
  return cars.length;
}
