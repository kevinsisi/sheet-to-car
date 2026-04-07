# 🚀 改善後的 Google Apps Script (全自動修復版)

將此腳本貼入 Google Sheets 的「擴充功能 > Apps Script」中。它會在每次您開啟試算表或修改內容時，自動檢查標題結構是否正確、補齊 `PO_Facebook` / `PO_PostHelper` 並根據來源上色。

```javascript
/**
 * 每次打開檔案時，自動執行修復與格式化
 */
function onOpen() {
  formatIntegratedSheet();
}

/**
 * 每次修改內容時，自動更新格式與顏色
 */
function onEdit(e) {
  formatIntegratedSheet();
}

/**
 * 核心：強制整併標題 + 補齊 FB/PostHelper + 自動格式化
 */
function formatIntegratedSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('整合庫存');
  if (!sheet) return;

  var data = sheet.getDataRange().getValues();
  if (data.length < 1) return;

  var itemPos = {r: -1, c: -1};
  var poPos = {r: -1, c: -1};

  // 1. 偵測 item (標題前段) 與 PO狀態 (標題後段) 的位置
  for (var r = 0; r < Math.min(data.length, 5); r++) {
    for (var c = 0; c < data[r].length; c++) {
      var val = String(data[r][c]).trim();
      if (val.toLowerCase() === 'item' || val === '項目') itemPos = {r: r, c: c};
      if (val === 'PO狀態') poPos = {r: r, c: c};
    }
  }

  // 2. 如果標題破裂（Row 2 有 item, Row 1 有 PO），執行強制整併
  if (itemPos.r === 1 && poPos.r === 0) {
    var finalHeaders = [];
    var row1 = data[0]; // Row 1 (PO資訊)
    var row2 = data[1]; // Row 2 (車輛資訊)

    for (var i = 0; i < 30; i++) {
      var h = '';
      if (i < row2.length && String(row2[i]).trim() !== '') h = row2[i]; // A-W
      if (i >= 23 && i < row1.length && String(row1[i]).trim() !== '') h = row1[i]; // X-Z
      finalHeaders.push(h);
    }

    // 補齊缺失欄位
    finalHeaders[26] = 'PO_Facebook';
    finalHeaders[27] = 'PO_PostHelper';

    // 刪除原本亂掉的兩列標題，插入整併後的新標題
    sheet.deleteRows(1, 2);
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, 28).setValues([finalHeaders.slice(0, 28)]);
    data = sheet.getDataRange().getValues();
  }

  // 3. 標準化標題格式 (黑色背景)
  var totalCols = data[0].length;
  var totalRows = data.length;
  sheet.getRange(1, 1, 1, totalCols)
    .setBackground('#333333').setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.setFrozenRows(1);

  // 4. 自動偵測來源欄位並上色
  var sourceColIdx = -1;
  for (var k = 0; k < data[0].length; k++) {
    var title = String(data[0][k]).trim();
    if (title === '來源' || title === 'Source' || title === '車源') { sourceColIdx = k; break; }
  }

  if (totalRows > 1) {
    var dataRange = sheet.getRange(2, 1, totalRows - 1, totalCols);
    dataRange.setBackground(null); // 先清除舊色
    var bgMap = { '國外進口': '#e6f4ea', '台灣車': '#fef7e0', '託售': '#f1f3f4', '寄賣': '#e8f0fe' };
    var bgColors = [];
    for (var r = 1; r < totalRows; r++) {
      var color = '#ffffff';
      if (sourceColIdx !== -1) {
        var src = String(data[r][sourceColIdx]).trim();
        color = bgMap[src] || '#ffffff';
      }
      var colorRow = [];
      for (var c = 0; c < totalCols; c++) { colorRow.push(color); }
      bgColors.push(colorRow);
    }
    dataRange.setBackgrounds(bgColors);
  }

  sheet.autoResizeColumns(1, totalCols);
}
```
