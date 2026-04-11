# Tasks - New Car Analysis MVP

## ✅ Core Implementation
- [x] 新增 `vehicle_analysis` migration 與 baseline analysis service
- [x] 新車同步後自動標記並執行 baseline analysis
- [x] 新增 `/api/analysis/pending`、`/api/analysis/:item`、`/api/analysis/:item/run-baseline`
- [x] 儀表板新增待注意面板與跳轉展開互動

## ✅ Follow-up
- [x] 第二階段加入照片上傳與視覺分析
- [x] 使用者可接受/忽略/自填待確認項目，接受結果會回寫車輛資料
- [x] 使用者確認後將分析結果進一步回寫到文案與 8891/post-helper 流程
- [x] 使用者可在接受時選擇補充既有特徵或覆蓋同欄位既有特徵
- [x] AI chat 對直接生成 / owner 檢查 / readiness 問句加上 deterministic routing 與邊界防呆
- [x] AI chat 補強短句命令型 direct generation 與明確多平台 direct generation，避免口頭承諾但未真正輸出內容
