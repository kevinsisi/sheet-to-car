# 🚀 改善後的 Google Apps Script (動態標題偵測版)

將此腳本貼入 Google Sheets 的「擴充功能 > Apps Script」中。它會自動尋找包含 `item` 的列作為標頭，避免第一列不統一的問題。

```javascript
/**
 * 自動格式化「整合庫存」表
 * 具備動態標題偵測功能，不再鎖死 Row 1
 */
function formatIntegratedSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('整合庫存');
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  let headerRowIdx = -1;

  // 1. 動態尋找標題列 (掃描前 10 列)
  for (let i = 0; i < Math.min(data.length, 10); i++) {
    const row = data[i];
    if (row.some(cell => {
      const c = String(cell).toLowerCase().trim();
      return c === 'item' || c === 'brand' || c === '項目' || c === '負責人';
    })) {
      headerRowIdx = i + 1; // GAS 使用 1-based index
      break;
    }
  }

  if (headerRowIdx === -1) {
    console.warn('找不到標題列，預設使用第一列');
    headerRowIdx = 1;
  }

  const totalCols = data[0].length;
  const totalRows = data.length;

  // 2. 設定標題格式
  const headerRange = sheet.getRange(headerRowIdx, 1, 1, totalCols);
  headerRange
    .setBackground('#333333')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  // 3. 設定凍結列 (凍結到標題列)
  sheet.setFrozenRows(headerRowIdx);

  // 4. 動態上色數據行 (標題列之後)
  if (totalRows > headerRowIdx) {
    const dataRange = sheet.getRange(headerRowIdx + 1, 1, totalRows - headerRowIdx, totalCols);
    
    // 清除舊格式
    dataRange.setBackground(null).setFontColor(null);

    // 根據來源 (假設在第 2 欄，即 index 1) 設定顏色
    const bgColors = [];
    const fontColors = [];
    
    const bgMap = {
      '國外進口': '#e6f4ea', // 淺綠
      '台灣車': '#fef7e0',   // 淺黃
      '託售': '#f1f3f4',     // 淺灰
      '寄賣': '#e8f0fe',     // 淺藍
      '其他': '#ffffff'
    };

    for (let i = headerRowIdx; i < totalRows; i++) {
      const source = data[i][1] || '其他';
      const color = bgMap[source] || bgMap['其他'];
      bgColors.push(Array(totalCols).fill(color));
      fontColors.push(Array(totalCols).fill('#000000'));
    }

    dataRange.setBackgrounds(bgColors);
  }

  // 5. 自動調整欄寬
  sheet.autoResizeColumns(1, totalCols);
}
```

### 與 `sheet-helper` 的關聯：
我已經修正了 `sheet-helper/src/create-integrated-sheet.ts` 中的 Node.js 產生邏輯，確保它在**產生表格**時就遵循動態變數基準。配合這份 AppScript，您的 Google Sheets 將具備極高的強健性，不再受第一列不統一的困擾。
