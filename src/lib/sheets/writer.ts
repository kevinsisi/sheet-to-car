import { google } from 'googleapis';
import { authorize } from './auth';

/**
 * Update PO status for a car in the 整合庫存 sheet.
 * Finds the row by item number and updates column N (index 13).
 */
export async function updatePoStatus(
  spreadsheetId: string,
  item: string,
  poStatus: string
): Promise<boolean> {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  // Read all items to find the row
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: '整合庫存!A:A',
  });

  const values = resp.data.values || [];
  let rowIndex = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i][0]?.trim() === item) {
      rowIndex = i + 1; // 1-based for Sheets API
      break;
    }
  }

  if (rowIndex === -1) {
    console.warn(`[writer] Item "${item}" not found in 整合庫存`);
    return false;
  }

  // Update PO status (column N = column 14)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `整合庫存!N${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[poStatus]],
    },
  });

  console.log(`[writer] Updated PO status: ${item} → ${poStatus}`);
  return true;
}
