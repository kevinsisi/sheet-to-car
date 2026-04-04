import { google } from 'googleapis';
import { authorize } from './auth';

/**
 * Update a cell value for a car in 整合庫存 sheet.
 * Dynamically finds the column by header name.
 */
export async function updateCarField(
  spreadsheetId: string,
  item: string,
  headerName: string,
  value: string
): Promise<boolean> {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  // Read header row to find column
  const headerResp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: '整合庫存!1:1',
  });
  const headers = headerResp.data.values?.[0] || [];
  let colIndex = headers.findIndex((h: string) => (h || '').trim() === headerName);

  // If column doesn't exist, expand grid and append it
  if (colIndex === -1) {
    colIndex = headers.length;

    // Get sheet ID and current column count
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties)' });
    const sheet = meta.data.sheets?.find(s => s.properties?.title === '整合庫存');
    if (sheet && sheet.properties) {
      const currentCols = sheet.properties.gridProperties?.columnCount || 0;
      if (colIndex >= currentCols) {
        // Expand grid to fit new column
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              appendDimension: {
                sheetId: sheet.properties.sheetId!,
                dimension: 'COLUMNS',
                length: colIndex - currentCols + 1,
              },
            }],
          },
        });
        console.log(`[writer] Expanded grid from ${currentCols} to ${colIndex + 1} columns`);
      }
    }

    const colLetter = indexToColumn(colIndex);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `整合庫存!${colLetter}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [[headerName]] },
    });
    console.log(`[writer] Created new column "${headerName}" at ${colLetter}`);
  }

  // Find the row by item
  const itemResp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: '整合庫存!A:A',
  });
  const items = itemResp.data.values || [];
  let rowIndex = -1;
  for (let i = 0; i < items.length; i++) {
    if ((items[i][0] || '').trim() === item) {
      rowIndex = i + 1; // 1-based
      break;
    }
  }

  if (rowIndex === -1) {
    console.warn(`[writer] Item "${item}" not found in 整合庫存`);
    return false;
  }

  const colLetter = indexToColumn(colIndex);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `整合庫存!${colLetter}${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });

  console.log(`[writer] Updated ${headerName}: ${item} → ${value}`);
  return true;
}

/** Update PO status — creates PO狀態 column if needed */
export async function updatePoStatus(
  spreadsheetId: string,
  item: string,
  poStatus: string
): Promise<boolean> {
  return updateCarField(spreadsheetId, item, 'PO狀態', poStatus);
}

/** Update per-platform PO status — creates column if needed */
export async function updatePoPlatform(
  spreadsheetId: string,
  item: string,
  platform: string,
  value: boolean
): Promise<boolean> {
  const headerMap: Record<string, string> = {
    official: 'PO_官網',
    '8891': 'PO_8891',
    facebook: 'PO_Facebook',
    post_helper: 'PO_PostHelper',
  };
  const headerName = headerMap[platform];
  if (!headerName) return false;
  return updateCarField(spreadsheetId, item, headerName, value ? 'TRUE' : 'FALSE');
}

/** Convert 0-based column index to letter (0→A, 25→Z, 26→AA) */
function indexToColumn(index: number): string {
  let col = '';
  let n = index;
  while (n >= 0) {
    col = String.fromCharCode(65 + (n % 26)) + col;
    n = Math.floor(n / 26) - 1;
  }
  return col;
}
