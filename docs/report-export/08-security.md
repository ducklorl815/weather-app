# 08 — 安全性設計

---

## 1. SQL 安全

### 現有資產

`validateReportSql`（runtime）已具備：

- 僅 `SELECT`／`WITH`  
- 禁多段 `;`  
- 禁 `INSERT/UPDATE/DELETE/DROP/...`  
- 資料表白名單（對照 `report-schema.json`）

### 新功能建議

| 控制 | Phase 1 |
|---|---|
| 語法白名單 | 重用／抽出共用 `validateReportSql` |
| 表白名單 | **建議沿用**（需你確認是否開放任意表） |
| 參數化 | 日期等用 `request.input`，禁止字串拼接使用者日期 |
| Timeout | Preview／Export 皆設 |
| Row cap | Preview 強制；Export soft max |
| DB 帳號 | **強烈建議唯讀帳號**（人工在 `gemini.json` 設定） |

即使有語法擋控，**DB 帳號唯讀仍是最後防線**。

---

## 2. SQL Injection

風險面：

- 使用者自行寫整段 SQL（本質是「授權使用者執行查詢」）  
- 若未來 UI 有「篩選條件」拼進 SQL → 必須參數化

定位：此功能是 **給可信內部使用者的報表工具**，不是對外匿名 API。  
仍應：擋 DML、表白名單、唯讀帳號、Audit Log。

---

## 3. Google Drive／OAuth

| 項目 | 建議 |
|---|---|
| Scope | 既有 `drive.file`（最小夠用上傳） |
| 不要 | `drive` 全盤管理 scope（除非 Picker／產品證實不夠） |
| Token 存放 | 既有 `google_token.json`；**不**存進報表 JSON |
| Refresh 失敗 | Log + Feature Scope／Reconnect；不刪檔（ADR 0002） |
| 權限 | 上傳到使用者選的 folder；不預設 `anyone` reader（Bug 截圖那套是特例，報表 CSV **不要**公開分享） |

---

## 4. 本機路徑

- 正規化 path，防止奇怪字元  
- 可選：限制在允許根目錄清單（若公司有規範）  
- 不跟隨任意 UNC？→ 待確認是否允許網路磁碟

---

## 5. 授權模型（App）

```text
Google Session
  → Feature Active?（執行／排程）
  → drive.file?（GoogleDrive 輸出）
  → SQL validate
  → DB login（gemini config）
```

集中在 Authorization／模組內 `assert*` helper，不散落 UI。

---

## 6. 敏感資料

- CSV 可能含個資／業績：Log 只存路徑／fileId／筆數，**不要**把列資料寫進 Log  
- Temp 檔執行後刪除  
- 錯誤訊息避免回傳完整連線字串

---

## 7. 多使用者桌面

LifeTour 現況是**單機單 Google 身分**。  
報表定義存在本機 userData → 同 Windows 使用者可見。  
不做跨 Windows 帳號 ACL（超出範圍）。
