# 8891 Skill Guardrails

## Problem Statement
8891 JSON 目前會使用 AI 推測多個規格欄位，但這些欄位大多沒有 Google Sheets 的直接來源，容易出現看似完整但實際不可靠的資料。

## Proposed Solution
- 在專案內新增可載入的 skill 機制，讓 Agent 與 8891 文案生成流程能依情境自動套用專用 skill。
- 先實作 `8891-spec-inference` skill，明確規範哪些欄位可直接使用、哪些只能在明確車型對照時推測、哪些在證據不足時必須保守輸出。
- 在 8891 單平台生成完成後回傳 `reviewHints`，標示需要人工確認的欄位，供後續 UI 確認流程使用。

## Success Criteria
- [x] 8891 生成流程會自動載入 `8891-spec-inference` skill。
- [x] Chat agent 在 8891 / post-helper / JSON / 規格相關對話時會自動附加對應 skill。
- [x] 8891 單平台生成 API 會回傳需人工確認的欄位提示。
