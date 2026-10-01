# 00 — SQL 報表匯出總覽（含 Google Drive）

> Analyze + Design only。確認前不進入大量 Coding。  
> 相關文件：`01`～`10`。

---

## 目前架構 → 建議架構

```text
【目前】
Electron Main (runtime + modules)
  ├── Google OAuth / drive.file / driveService
  ├── mssql pool（gemini.json）
  ├── AI report-run（預覽，無排程／無 CSV 丟檔）
  └── setInterval schedulers（GChat 等）

【建議新增】
main/modules/report-export/
  ├── repository（JSON definitions + logs）
  ├── ReportExportScheduler          ← 何時
  ├── ReportExportService            ← 怎麼匯出
  ├── ReportSqlRunner                ← SQL preview/stream
  ├── CsvWriter
  └── IReportOutputProvider
        ├── LocalFileOutputProvider
        └── GoogleDriveOutputProvider  ← 共用既有 OAuth/driveService

renderer/features/reportExport/      ← 列表 + 設定 UI
IPC: report-export-*                 ← 非 REST /api
```

---

## 資料儲存（非 SQL Table）

專案無 ORM。Phase 1：

| Collection | 檔案 |
|---|---|
| ReportDefinition[] | `userData/report-export-definitions.json` |
| ReportExecutionLog[] | `userData/report-export-logs.json` |

重點欄位：`outputType` + `outputConfig`（取代單一 `OutputPath`）；Log 含 `googleDriveFileId`。

---

## API（IPC）

`report-export-list|get|create|update|delete|preview|execute|executions|pick-drive-folder|auth-status`

細節：`04-api-design.md`。

---

## Frontend

Mosaic feature `reportExport`：List + Detail（基本／輸出／SQL／排程／Log）。  
細節：`05-ui-design.md`。

---

## Scheduler

輕量 Main `setInterval`（仿 `sync-scheduler`）+ Active Feature 閘門 + 防重入。  
不引入 Hangfire／Quartz。  
細節：`06-scheduler-design.md`。

**Phase 1 行為**：排程跑在 App Main Process（含托盤常駐即可）。**完全退出則當下不執行**。

**已確認方向（之後調整）**：未來改為寫入 **系統排程器**（例如 Windows Task Scheduler），讓 App 退出後仍能觸發；App 內 Scheduler 僅作過渡，介面／資料模型需保持「可被外部觸發同一套 `ReportExportService`」。

---

## Export Service + Output Provider

Manual／Schedule／Test → **同一** `ReportExportService` → CSV → Provider。  
Preview 不上傳。  
細節：`07-export-design.md`。

---

## Google Drive OAuth

- **共用**現有 Session／`google_token.json`／refresh  
- Scope：既有 `drive.file`；Feature 登錄 `reportExport`  
- 選夾：Google Picker 優先（`drive.file` 無法任意 list）  
- Credential **不**寫進報表定義  

---

## Execution Log

每次 Manual／Schedule／Test 寫入；含目的地類型、FolderId、FileId、筆數、耗時、錯誤。

---

## Implementation Phases

| Phase | 內容 |
|---|---|
| 0 | 文件確認 |
| 1 | CRUD + Preview + Local CSV（已做） |
| 2 | Google Drive Provider（已做） |
| 3 | **App 內** Scheduler（已做） |
| 4 | 日期參數／強化／單次 CLI 入口預留 |
| 5 | **系統排程器**（App 退出後仍跑；已確認要做） |

---

## 給你確認的 12 點（摘要回答）

### 1. 功能放哪裡？

`main/modules/report-export/` + `renderer/features/reportExport/` + Mosaic type `reportExport`。  
**不要**塞進現有 `report-run`／詢問機器人。

### 2. 需新增哪些 Backend Module？

`repository`、`sql-runner`、`csv-writer`、`export-service`、`scheduler`、`schedule-utils`、`output/*`、`register`（IPC）。

### 3. 需新增哪些 Frontend Module？

`renderer/features/reportExport/`（view + logic）；preload 包裝；catalog／dist-features。

### 4. 需新增哪些 DB Table？

**無 SQL 表**（Phase 1）。改為兩個 JSON store。MSSQL 只當「查詢來源」。

### 5. Scheduler 用什麼？

Main Process 輕量 interval scheduler（仿 GChat），Active Feature 閘門；不引入大型套件。

### 6. SQL 怎麼執行？

抽出 Runner：重用 `validateReportSql` 精神 + `mssql` pool；Preview 強制 LIMIT；Export 串流／temp + 較長 timeout。

### 7. CSV 怎麼產生？

RFC 4180 writer + UTF-8（建議 BOM）+ temp 檔串流；禁止 naive `join(',')`。

### 8. 手動與排程如何共用？

兩者只呼叫 `ReportExportService.execute`；Scheduler 不碰 SQL／Drive。

### 9. Preview 如何設計？

獨立 IPC；只回表格；不產檔、不上傳、不寫正式業務 lastRun（正式 Log 不寫）。

### 10. 安全性？

SELECT-only、建議表白名單、唯讀 DB 帳號、`drive.file` 最小權、Token 不進報表檔、CSV 不公開分享、錯誤不洩漏連線字串。

### 11. 可能影響現有系統？

共用 sqlPool／Drive quota／runtime 掛載點／Scope Registry／Active Feature 清單／dist-features。應用模組化與獨立 timeout／concurrency 降低衝擊。

### 12. 建議幾個 Phase？

四個主要 Phase：Local 核心 → Drive → Scheduler → 強化（見 `10-implementation-plan.md`）。

---

## 待你拍板的決策

| # | 決策 | 文件建議預設 |
|---|---|---|
| D1 | OverwriteMode 預設 | `Overwrite` |
| D2 | SQL 是否限制已訓練表白名單 | **是（較安全）** |
| D3 | 日期參數預設 | `None`（SQL 內自寫 GETDATE） |
| D4 | Drive 選夾 | Picker 為主；Folder ID 後備 |
| D5 | App 完全退出後是否還要跑排程 | **最終要**（系統排程器）。Phase 1 **先做 App 內排程**；之後再接到 OS Scheduler |
| D6 | Feature Off 時可否編輯定義 | **可編輯、不可執行** |
| D7 | 測試產生是否強制 Test 資料夾 | **是** |
| D8 | CSV Excel BOM | **預設開啟** |

請回覆確認或修改上表後，再進入 Coding。
