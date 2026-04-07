import { google } from 'googleapis';
import { authorize } from './auth';
import { CarRecord } from './types';

function isTruthy(val: string): boolean {
  const v = (val || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'v' || v === '✓' || v === 'yes';
}

/**
 * Read car inventory from 整合庫存 sheet ONLY.
 * Does NOT touch 車源 or 庫存 sheets.
 *
 * Actual sheet columns (0-indexed):
 *  0: item
 *  1: (來源/空)
 *  2: Brand
 *  3: 年式
 *  4: 出廠年月
 *  5: 里程
 *  6: Model
 *  7: vin
 *  8: 車況
 *  9: 狀態
 * 10: 備註
 * 11: 外觀色
 * 12: 內裝色
 * 13: 到港日
 * 14: 分配 (負責人)
 * 15: 買進業務
 * 16: 售出業務
 * 17: (空)
 * 18: 到港日
 * 19: 到港天數
 * 20: 車牌
 * 21: 客戶名稱
 * 22: 領牌名稱
 */
export async function readCarsFromSheet(spreadsheetId: string): Promise<CarRecord[]> {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('[sheets] Reading 整合庫存...');

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: '整合庫存!A1:AZ1000',
  });

  const rows = resp.data.values || [];
  if (rows.length < 1) {
    console.log('[sheets] 整合庫存 is empty');
    return [];
  }

  // Find the actual header row (look for "item" or "Brand" or "項目" in the first 10 rows)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i];
    if (row.some((cell: string) => {
      const c = (cell || '').toLowerCase().trim();
      return c === 'item' || c === 'brand' || c === '項目' || c === '負責人';
    })) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.warn('[sheets] Could not find header row in 整合庫存, defaulting to row 0');
    headerIdx = 0;
  }

  // Build a header→index map for flexibility
  const headerRow = rows[headerIdx];
  const colMap: Record<string, number> = {};
  headerRow.forEach((h: string, i: number) => {
    const key = (h || '').trim();
    if (key && !(key in colMap)) colMap[key] = i;
  });

  console.log(`[sheets] Found header at row ${headerIdx}. Header map:`, JSON.stringify(colMap));

  const cars: CarRecord[] = [];

  // Start parsing data from the row AFTER the header
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const col = (name: string) => {
      const idx = colMap[name];
      return idx !== undefined ? (row[idx] || '') : '';
    };

    // "item" is usually in column 0, but we should be flexible
    const itemIdx = colMap['item'] ?? colMap['項目'] ?? 0;
    const item = (row[itemIdx] || '').trim();
    if (!item) continue;
    // Skip section headers — valid items contain at least one digit (e.g. A67, T7, T25)
    if (!/\d/.test(item)) continue;

    // Source mapping (legacy mapping support)
    const sourceIdx = colMap['來源'] ?? 1;
    const sourceVal = row[sourceIdx] || '';

    cars.push({
      item,
      source: sourceVal,
      brand: col('Brand') || col('brand') || col('品牌') || '',
      year: col('年式') || '',
      manufactureDate: col('出廠年月') || '',
      mileage: col('里程') || '',
      model: col('Model') || col('model') || col('型號') || '',
      vin: col('vin') || col('VIN') || col('引擎碼(VIN)') || '',
      condition: col('車況') || '',
      status: col('狀態') || '在庫',
      exteriorColor: col('外觀色') || '',
      interiorColor: col('內裝色') || '',
      modification: col('改裝') || '',
      note: col('備註') || '',
      poStatus: col('PO狀態') || '未PO',
      poOfficial: isTruthy(col('PO_官網') || col('官網')),
      po8891: isTruthy(col('PO_8891') || col('8891')),
      poFacebook: isTruthy(col('PO_Facebook') || col('FB')),
      poPostHelper: isTruthy(col('PO_PostHelper')),
      owner: col('分配') || col('負責人') || '',
      price: col('開價') || col('售價') || '',
      bgColor: '',
    });
  }

  console.log(`[sheets] Parsed ${cars.length} cars from 整合庫存`);
  return cars;
}
