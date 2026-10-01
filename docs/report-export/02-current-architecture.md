# 02 — 現有專案架構分析（對照報表匯出）

> 掃描基準：`package.json`、`docs/architecture/*`、`main/runtime.js`、`preload.js`、`main/modules/*`  
> 結論導向：新功能必須**嵌入現行 Electron 架構**，不可假設 ASP.NET / REST / ORM。

---

## 1. 專案是什麼

**LifeTour**（repo 名 weather-app）是 **Electron 28 桌面 App**：

| 層 | 技術 |
|---|---|
| Main | Node.js、`googleapis`、`mssql`、`electron-updater` |
| Renderer | 原生 HTML/CSS/JS（無 React/Vue） |
| 通訊 | `preload.js` → `contextBridge` → `window.api` → IPC |
| 持久化 | `app.getPath('userData')` + JSON 檔（**無 ORM / Migration**） |

不存在獨立 HTTP API Server、Hangfire、Quartz、EF Core、Windows Service Worker。

---

## 2. 程序與模組結構

```text
main.js
  └── main/runtime.js          ← 多數業務仍在此 monolith
preload.js                     ← window.api 閘道
index.html + renderer/shell/   ← Mosaic 工作台
renderer/features/*/           ← partial view（多數 logic 仍在 app.js）
main/modules/gchat/            ← 已部分模組化（含 sync-scheduler）
main/modules/notes/            ← 已拆出 register 模式
main/modules/sites-visits/     ← enrich.js（MSSQL ERP）
```

未來目標結構見 `docs/architecture/13-future-architecture.md`：新功能應以 **`main/modules/<feature>/`** 新增，避免再往 `runtime.js` 堆萬行。

---

## 3. 資料庫連線（MSSQL）

### 現況

- 套件：`mssql`  
- 連線設定：存在 `userData/gemini.json`（`loadGeminiConfig()`）  
  - `sqlConnectionString` 或分散欄位（server/port/database/user/password）  
- 連線池：`getSqlPool(cfg)`（runtime 內全域 `sqlPool`）  
- 其他 caller：  
  - AI 報表：`executeReportSql` / `retrieveSql`  
  - Sites Visits：`main/modules/sites-visits/enrich.js`（另有 `erpPool`）

### 對報表匯出的意涵

| 可重用 | 注意 |
|---|---|
| 同一套 Gemini SQL 設定／連線字串 | Export 與 AI Chat **共用連線池**時，長查詢可能互卡 |
| `requestTimeout` 現為 20s | 正式匯出可能需要可設定較長 timeout |
| 已有 `validateReportSql`（僅 SELECT、禁多段、禁 DML、表白名單） | 新功能是否沿用「已訓練表」需產品決策 |

**建議**：新模組抽 `SqlConnectionService`／共用 `getSqlPool`，但 Export 用**獨立 request timeout** 與**執行中 mutex**，避免拖垮 AI Chat。

---

## 4. 現有「報表」能力（勿混淆）

| 項目 | 現有 AI Report（`report-*`） | 本文件新功能 Report Export |
|---|---|---|
| 觸發 | 使用者問句 / preset | 手動丟檔 / 排程 |
| SQL 來源 | Gemini 或寫死 preset | 使用者保存的報表定義 |
| 輸出 | UI 表格 + 分析文字 | CSV → Local / Google Drive |
| 持久化 | `report-schema.json`（資料字典） | 報表定義 + 執行 Log |
| 排程 | 無 | 有 |

**結論**：應新增獨立 Feature／Module（建議 id：`reportExport`），**不要**把排程與 Drive 上傳塞進現有 `report-run`。

---

## 5. Google OAuth / Drive

### 既有機制

- Credential：`userData/google_token.json`  
- Client：`oauth2Client` + `initGoogleServices()` → 已建立 `driveService = google.drive({ version: 'v3' })`  
- Scope：`DRIVE_FILE_SCOPE = https://www.googleapis.com/auth/drive.file`  
  - 已掛在 `FEATURE_SCOPE_MAP.sheets`、`notes`  
- 既有上傳：Bug 回報截圖 `uploadBugReportImage` → `drive.files.create`  
- 記事：以 spreadsheetId／drive.file 建立檔案，**刻意不掃 Drive list**（ADR 0013）

### 對 Google Drive 輸出的意涵

| 可共用 | 限制 |
|---|---|
| 同一套 OAuth / Token refresh / `withGoogleApiRetry` | `drive.file` **無法任意列出使用者全部資料夾** |
| 既有 `driveService` | 選資料夾需 **Google Picker**（或使用者貼 Folder ID，且該資料夾須對 App 可見） |
| Feature Scope Gate / Incremental Auth | 排程失敗時不可刪 Credential；應記 Log + 要求重新授權 |

**強烈建議**：不要另建第二套 Google OAuth；把 `reportExport` 加入 Scope Registry，scopes = `[DRIVE_FILE_SCOPE]`（Local-only 報表可不強制）。

---

## 6. Scheduler / Background

| 現有機制 | 用途 |
|---|---|
| `main/modules/gchat/sync-scheduler.js` | setInterval + tickRunning 防重入 |
| Gmail `syncTimer` 60s | 郵件同步 |
| Session watch 60s | Token |
| Meeting watch 30s | 行程提醒 |
| closeToTray | 關主視窗可藏托盤，Main 繼續跑 |

**沒有** Hangfire／Quartz／獨立 Worker Service。

### Active Feature 閘門（ADR 0006）

背景工作必須依 Mosaic **Active Feature List**，不可只看 Session。  
→ Report Export Scheduler 應在 Feature On 時啟動、Feature Off／Logout 時停止。

### 桌面 App 硬限制

```text
App 程序在跑（含托盤）→ 排程可執行
使用者完全退出 App → 排程不會跑
```

若業務要求「電腦開機、App 未開也要丟檔」，需另議 Windows Task Scheduler／獨立服務——**超出現行架構預設**，本設計文件標為可選 Phase 後續。

---

## 7. Authentication / Authorization

- App 層：Google Session + Feature Scope Gate  
- **沒有**傳統 RBAC／Role 表  
- SQL 帳號權限：取決於 `gemini.json` 內設定的 DB User（人工維護）

報表功能授權建議：

1. 需已登入 Google Session（Drive 輸出時）  
2. Feature Scope：`reportExport` → `drive.file`（僅 GoogleDrive 目的地需要）  
3. SQL：僅 SELECT；連線帳號建議唯讀（文件要求人工確認）

---

## 8. Logging

- 無統一結構化 logging framework  
- 常見：`console`／模組內 log helper（如 `gchatSyncLog`）  
- 業務結果：本功能需自建 **Execution Log JSON**（或之後可選寫 MSSQL）

---

## 9. Configuration

| 設定 | 位置 |
|---|---|
| SQL / Gemini | `gemini.json` |
| Feature 包裝開關 | `dist-features.json` |
| Theme／GChat prefs 等 | 各自 JSON |

報表定義建議獨立：`report-export-definitions.json`、`report-export-logs.json`（見資料模型）。

---

## 10. Frontend 現況

- Mosaic Catalog：`WIDGET_CATALOG` in `renderer/shell/app.js`  
- Feature partial：`renderer/features/<type>/view.html`  
- 多數 UI 邏輯仍在 `app.js`（stub logic.js）  
- 新功能建議：`renderer/features/reportExport/` + 儘量把 UI 寫在 feature 目錄，減少再膨脹 app.js

現有相近 UI：`chat`（詢問機器人）有 SQL／報表預覽概念，但用途不同。

---

## 11. 適合放置此功能的位置（結論）

| 層 | 建議路徑 |
|---|---|
| Main Module | `main/modules/report-export/`（新建，參考 notes register 模式） |
| Renderer Feature | `renderer/features/reportExport/` |
| Catalog type | `reportExport` |
| dist-features | 新增 `widgets.reportExport`（建議預設 `false`，開發先開） |
| Scope Registry | `FEATURE_SCOPE_MAP.reportExport = [DRIVE_FILE_SCOPE]` |
| 持久化 | `userData/report-export-*.json` |
| 共用依賴 | 既有 `oauth2Client`／`driveService`／`getSqlPool`／Active Feature List |

**不要**：塞進 `report-run`、不要新建 REST `/api/reports`、不要為本功能重寫 OAuth。
