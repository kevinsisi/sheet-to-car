import { google } from 'googleapis';
import { authorize } from './auth';
import { CarRecord, CAR_HEADERS } from './types';

/**
 * Read car inventory from 整合庫存 sheet ONLY.
 * Does NOT touch 車源 or 庫存 sheets.
 */
export async function readCarsFromSheet(spreadsheetId: string): Promise<CarRecord[]> {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('[sheets] Reading 整合庫存...');

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: '整合庫存!A1:Q1000',
  });

  const rows = resp.data.values || [];
  if (rows.length < 2) {
    console.log('[sheets] 整合庫存 is empty');
    return [];
  }

  // First row is header, parse the rest
  const headers = rows[0];
  const cars: CarRecord[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const item = (row[0] || '').trim();
    if (!item) continue;

    cars.push({
      item,
      source: row[1] || '',
      brand: row[2] || '',
      year: row[3] || '',
      manufactureDate: row[4] || '',
      mileage: row[5] || '',
      model: row[6] || '',
      vin: row[7] || '',
      condition: row[8] || '',
      status: row[9] || '在庫',
      exteriorColor: row[10] || '',
      interiorColor: row[11] || '',
      modification: row[12] || '',
      poStatus: row[13] || '未PO',
      owner: row[14] || '',
      price: row[15] || '',
      note: row[16] || '',
      bgColor: '',
    });
  }

  console.log(`[sheets] Parsed ${cars.length} cars from 整合庫存`);
  return cars;
}
