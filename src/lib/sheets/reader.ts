import { google } from 'googleapis';
import { authorize } from './auth';
import { parseSourceRows, mergeInventoryRows } from './parser';
import { CarRecord } from './types';

/**
 * Read car inventory from Google Sheets.
 * Fetches 車源 and 庫存 worksheets, parses and merges them.
 */
export async function readCarsFromSheet(spreadsheetId: string): Promise<CarRecord[]> {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('[sheets] Reading car data...');

  const [sourceResp, invResp] = await Promise.all([
    sheets.spreadsheets.get({
      spreadsheetId,
      ranges: ['車源!A1:Z1000'],
      includeGridData: true,
    }),
    sheets.spreadsheets.get({
      spreadsheetId,
      ranges: ['庫存!A1:Z500'],
      includeGridData: true,
    }),
  ]);

  const sourceRows = sourceResp.data.sheets?.[0]?.data?.[0]?.rowData || [];
  const invRows = invResp.data.sheets?.[0]?.data?.[0]?.rowData || [];

  console.log(`[sheets] Source: ${sourceRows.length} rows, Inventory: ${invRows.length} rows`);

  const cars = parseSourceRows(sourceRows);
  mergeInventoryRows(cars, invRows);

  console.log(`[sheets] Parsed ${cars.length} cars`);
  return cars;
}

/**
 * Read the integrated sheet (整合庫存) for PO status data.
 */
export async function readIntegratedSheet(spreadsheetId: string): Promise<string[][]> {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: '整合庫存!A1:Q1000',
  });

  return resp.data.values || [];
}
