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

  // 1. Find the actual header row dynamically
  const fullSheetResp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: '整合庫存!A1:Z10', // Scan first 10 rows
  });
  const rows = fullSheetResp.data.values || [];
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((cell: string) => {
      const c = (cell || '').toLowerCase().trim();
      return c === 'item' || c === 'brand' || c === '項目' || c === '負責人';
    })) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.warn('[writer] Could not find header row, defaulting to row 0');
    headerIdx = 0;
  }

  const headers = rows[headerIdx] || [];
  let colIndex = headers.findIndex((h: string) => (h || '').trim() === headerName);

  // If column doesn't exist, append it to the header row
  if (colIndex === -1) {
    colIndex = headers.length;
    const colLetter = indexToColumn(colIndex);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `整合庫存!${colLetter}${headerIdx + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[headerName]] },
    });
    console.log(`[writer] Created new column "${headerName}" at ${colLetter}${headerIdx + 1}`);
  }

  // 2. Find the row by item, searching AFTER the header
  const itemHeader = headers.find((h: string) => {
    const c = (h || '').toLowerCase().trim();
    return c === 'item' || c === '項目';
  });
  const itemColIndex = itemHeader ? headers.indexOf(itemHeader) : 0;
  const itemColLetter = indexToColumn(itemColIndex);

  const dataResp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `整合庫存!${itemColLetter}:${itemColLetter}`,
  });
  const allItems = dataResp.data.values || [];
  let rowIndex = -1;
  for (let i = headerIdx + 1; i < allItems.length; i++) {
    if ((allItems[i][0] || '').trim() === item) {
      rowIndex = i + 1; // 1-based absolute row
      break;
    }
  }

  if (rowIndex === -1) {
    console.warn(`[writer] Item "${item}" not found in 整合庫存 after header row ${headerIdx + 1}`);
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
