# New Car Analysis MVP

## Problem Statement
新車進入 sheet-to-car 後，系統目前不會先整理可用亮點、待確認特徵或建議補拍照片，使用者只能手動打開單車資料慢慢判斷。

## Proposed Solution
- 新增 `vehicle_analysis` 資料表，儲存新車的 baseline analysis 結果與待注意原因。
- 新車同步進來後，自動用 Gemini 先跑一次基礎特徵分析。
- 首次 bootstrap 現有庫存不回補分析，只對之後新出現的車觸發，避免既往不咎被破壞。
- 在儀表板新增「待注意車輛」面板，列出需要人工注意或補照片的車。
- 點擊提醒後自動跳到該車並展開分析原因。
- 單車展開區可補傳照片，觸發第二輪視覺分析，產出可見特色、待確認點與可補進介紹的句子。
- 使用者可對 baseline 與照片分析中的待確認項目執行接受、忽略或自填確認值；接受後會立即反映到車輛資料並降低待注意數量。
- 文案生成流程必須明確讀取已確認特徵，並將尚未確認欄位標示為不可寫成已確認事實。
- 每份生成後的 copy 需持久保存當次使用的已確認特徵數與未確認欄位數，供重新開頁時顯示可靠度提示。
- 已接受的分析結果應寫入結構化 confirmed-features 表，而不只散落在 note/modification 文字欄位，供後續平台生成穩定重用。
- VIN decode 只能作為輔助外部依據；若解碼失敗、逾時或無資料，主流程不得中斷，必須回退到既有資料與人工確認提示。
- 8891 產出在不改變外部 JSON 形狀的前提下，必須先組出與 post-helper schema 相容的 draft 結構，再由模型保守補齊缺值與 listing 文案。
- 8891 生成完成後，需在 sheet-to-car 端做與 post-helper 相容的基本驗證與常見值正規化；若不合法，必須回傳 review hints 而非直接把錯資料交給上傳工具。
- 每份 8891 copy 需持久保存 validation summary，讓 UI 能直接顯示是否可直接交給 post-helper、是否僅有警告、或有阻塞問題。
- Dashboard 應集中列出有 8891 阻塞問題的車，並支援一鍵跳到對應車輛處理。
- 前端應在使用者第一次打開新版本時顯示版本更新提示，內容由 changelog 資料驅動，而不是寫死在 modal 模板中。

## Success Criteria
- [x] 新車同步後會自動建立 baseline analysis。
- [x] 儀表板可看到待注意車輛清單。
- [x] 點擊清單項目會自動跳到對應車輛並展開。
- [x] 單車展開區可查看 baseline findings、review hints、recommended photos。
- [x] 單車展開區可上傳照片並查看最新照片分析結果。
- [x] 使用者可對待確認提示執行接受/忽略/自填，待注意清單會同步更新。
