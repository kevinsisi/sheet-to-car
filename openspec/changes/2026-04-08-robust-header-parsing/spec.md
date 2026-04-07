# Robust Header Parsing for Google Sheets

## Problem Statement
使用者回報 Google Sheets 的「第一列不統一」。經查，原代碼硬編碼 `rows[0]` 為標題列，若工作表上方有空列或說明文字，會導致欄位映射錯誤與數據解析失敗。

## Proposed Solution
- 實作動態標題偵測：掃描前 10 列以關鍵字（item, brand, 項目）定位標題。
- 增加中文別名支援（如 品牌, 型號, 負責人, 售價），提升欄位對應的容錯率。
- 自動從標題列下一列開始讀取數據。

## Success Criteria
- [x] 能正確識別非 Row 0 開始的表格標題。
- [x] 支持「負責人」、「品牌」等中文欄位標題。
- [x] 成功過濾掉表格上方的非數據行。
