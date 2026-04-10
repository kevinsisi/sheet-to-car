import db from '../db/connection';
import { CarRecord } from '../lib/sheets/types';

export interface VinDecodeRecord {
  vin: string;
  make: string;
  model: string;
  year: string;
  engineCylinders: string;
  engineDisplacementL: string;
  engineModel: string;
  fuelType: string;
  horsepower: string;
  driveType: string;
  bodyClass: string;
  doors: string;
  transmissionStyle: string;
  decodedAt: string;
}

const VIN_CACHE_MAX_AGE_DAYS = 30;

function isValidVin(vin: string): boolean {
  const normalized = (vin || '').trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{11,17}$/.test(normalized);
}

function parseRow(row: any): VinDecodeRecord {
  return {
    vin: row.vin,
    make: row.make || '',
    model: row.model || '',
    year: row.year || '',
    engineCylinders: row.engine_cylinders || '',
    engineDisplacementL: row.engine_displacement_l || '',
    engineModel: row.engine_model || '',
    fuelType: row.fuel_type || '',
    horsepower: row.horsepower || '',
    driveType: row.drive_type || '',
    bodyClass: row.body_class || '',
    doors: row.doors || '',
    transmissionStyle: row.transmission_style || '',
    decodedAt: row.decoded_at,
  };
}

function isFresh(decodedAt: string): boolean {
  if (!decodedAt) return false;
  const age = Date.now() - new Date(decodedAt).getTime();
  return age < VIN_CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function extractVehicleInfo(results: any[]) {
  const getValue = (variableId: number) => {
    const item = results.find((entry: any) => entry.VariableId === variableId);
    return item?.Value || '';
  };

  return {
    make: String(getValue(26) || ''),
    model: String(getValue(28) || ''),
    year: String(getValue(29) || ''),
    engineCylinders: String(getValue(9) || ''),
    engineDisplacementL: String(getValue(11) || ''),
    engineModel: String(getValue(18) || ''),
    fuelType: String(getValue(24) || ''),
    horsepower: String(getValue(71) || ''),
    driveType: String(getValue(15) || ''),
    bodyClass: String(getValue(5) || ''),
    doors: String(getValue(14) || ''),
    transmissionStyle: String(getValue(37) || ''),
  };
}

async function fetchVinDecode(vin: string): Promise<VinDecodeRecord | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${encodeURIComponent(vin)}?format=json`, {
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`VIN decode request failed: ${resp.status}`);
    }

    const json = await resp.json() as any;
    const info = extractVehicleInfo(Array.isArray(json.Results) ? json.Results : []);

    db.prepare(`
      INSERT INTO vin_decodes (
        vin, make, model, year, engine_cylinders, engine_displacement_l, engine_model,
        fuel_type, horsepower, drive_type, body_class, doors, transmission_style,
        raw_json, decoded_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(vin) DO UPDATE SET
        make = excluded.make,
        model = excluded.model,
        year = excluded.year,
        engine_cylinders = excluded.engine_cylinders,
        engine_displacement_l = excluded.engine_displacement_l,
        engine_model = excluded.engine_model,
        fuel_type = excluded.fuel_type,
        horsepower = excluded.horsepower,
        drive_type = excluded.drive_type,
        body_class = excluded.body_class,
        doors = excluded.doors,
        transmission_style = excluded.transmission_style,
        raw_json = excluded.raw_json,
        decoded_at = datetime('now'),
        updated_at = datetime('now')
    `).run(
      vin,
      info.make,
      info.model,
      info.year,
      info.engineCylinders,
      info.engineDisplacementL,
      info.engineModel,
      info.fuelType,
      info.horsepower,
      info.driveType,
      info.bodyClass,
      info.doors,
      info.transmissionStyle,
      JSON.stringify(json),
    );

    return getCachedVinDecode(vin);
  } finally {
    clearTimeout(timeout);
  }
}

export function getCachedVinDecode(vin: string): VinDecodeRecord | null {
  const normalized = (vin || '').trim().toUpperCase();
  if (!isValidVin(normalized)) return null;
  const row = db.prepare('SELECT * FROM vin_decodes WHERE vin = ?').get(normalized) as any;
  return row ? parseRow(row) : null;
}

export async function getVinDecode(vin: string, allowRemote = true): Promise<VinDecodeRecord | null> {
  const normalized = (vin || '').trim().toUpperCase();
  if (!isValidVin(normalized)) return null;

  const cached = getCachedVinDecode(normalized);
  if (cached && isFresh(cached.decodedAt)) {
    return cached;
  }

  if (!allowRemote) {
    return cached;
  }

  try {
    return await fetchVinDecode(normalized);
  } catch (err: any) {
    console.warn(`[vin] decode failed for ${normalized.slice(-6)}: ${err.message}`);
    return cached;
  }
}

export async function getVinDecodeForCar(car: CarRecord, allowRemote = true): Promise<VinDecodeRecord | null> {
  return getVinDecode(car.vin, allowRemote);
}
