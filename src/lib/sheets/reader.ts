import { google } from 'googleapis';
import { authorize } from './auth';
import { CarRecord } from './types';

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
    range: '整合庫存!A1:W1000',
  });

  const rows = resp.data.values || [];
  if (rows.length < 2) {
    console.log('[sheets] 整合庫存 is empty');
    return [];
  }

  // Build a header→index map for flexibility
  const headerRow = rows[0];
  const colMap: Record<string, number> = {};
  headerRow.forEach((h: string, i: number) => {
    const key = (h || '').trim();
    if (key && !(key in colMap)) colMap[key] = i;
  });

  console.log(`[sheets] Header map:`, JSON.stringify(colMap));

  const cars: CarRecord[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const item = (row[0] || '').trim();
    if (!item) continue;

    const col = (name: string) => {
      const idx = colMap[name];
      return idx !== undefined ? (row[idx] || '') : '';
    };

    cars.push({
      item,
      source: row[1] || '',
      brand: col('Brand') || col('brand') || '',
      year: col('年式') || '',
      manufactureDate: col('出廠年月') || '',
      mileage: col('里程') || '',
      model: col('Model') || col('model') || '',
      vin: col('vin') || col('VIN') || col('引擎碼(VIN)') || '',
      condition: col('車況') || '',
      status: col('狀態') || '在庫',
      exteriorColor: col('外觀色') || '',
      interiorColor: col('內裝色') || '',
      modification: '',
      note: col('備註') || '',
      poStatus: col('PO狀態') || '未PO',
      owner: col('分配') || '',
      price: col('開價') || '',
      bgColor: '',
    });
  }

  console.log(`[sheets] Parsed ${cars.length} cars from 整合庫存`);
  return cars;
}
