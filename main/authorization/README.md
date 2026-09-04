# authorization

## 說明
Google OAuth、Token、Feature scopes、Session

## 現況
實作仍集中在 `main/runtime.js` 對應【MODULE】區段。

止血階段已落地（見 ADR 0002／0003、`CONTEXT.md`）：
- Credential Path Probe + 空檔備援遷移
- Reconnect 不先刪 Credential
- Scope Registry（Little Reply Core／Extended）

## [TODO]
將 runtime 中本模組區段搬到此目錄的 `.js` 檔，並由根目錄 `main.js` `require` 註冊（第二階段，非止血範圍）。
