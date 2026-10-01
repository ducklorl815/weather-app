# 10 — 實作計畫（Phases）

> **現階段：只到文件確認。** 以下在你 Approve 後才 Coding。

---

## Phase 0 — 確認（本階段）

- [x] 分析現有架構  
- [x] 產出 `docs/report-export/*`  
- [x] 你確認：放置位置、白名單 SQL、Overwrite 預設、日期參數、Drive Picker、App 退出（Phase1 App 內／最終系統排程器）  

---

## Phase 1 — 骨架 + CRUD + Local Export

**狀態：已實作（待手動驗收）**

**Backend**

- `main/modules/report-export/`  
  - `register.js`（IPC）  
  - `repository.js`（JSON definitions／logs）  
  - `sql-runner.js`（validate + preview + export query）  
  - `csv-writer.js`  
  - `export-service.js`  
  - `schedule-utils.js`（nextRunAt 計算；執行器 Phase 3）  
  - `output/local-provider.js`  
  - `output/factory.js`

**Frontend**

- `renderer/features/reportExport/` 列表 + 詳細（Local）  
- preload API  
- Mosaic catalog + dist-features flag  

**不做（本 Phase）**：Scheduler 背景 tick、Google Drive

**驗收**：手動丟檔到本機路徑；Preview；Execution Log；排程欄位可存（尚未自動跑）

---

## Phase 2 — Google Drive Output

**狀態：已實作（待手動驗收）**

- `output/google-drive-provider.js`
- `drive-folder.js`（Folder ID／建立／列表）
- Scope Registry：`reportExport` → `drive.file`
- UI：輸出方式 Google Drive、授權、選／建資料夾、測試資料夾

---

## Phase 3 — Scheduler

**狀態：已實作（待手動驗收）**

- `scheduler.js` + Active Feature 閘門
- nextRunAt／missed catch-up once
- concurrency = 1；單報表失敗不拖垮
- Feature Off／Logout 停止

---

## Phase 4 — 強化

- 日期參數 BoundParams UI  
- CSV BOM／格式選項  
- 執行進度事件  
- SQL 格式化（可選依賴）  
- soft max rows、更好的大型查詢  
- 預留／實作 `--report-export-run=<id>` 單次入口（給之後系統排程器用）

---

## Phase 5 — 系統排程器（已確認要做，但不在 Phase 1）

**目標**：App 退出後仍能丟檔。

- Windows Task Scheduler（或同等）登錄／更新／刪除  
- 與 App 內 Scheduler 的切換或並存策略  
- 單次啟動、無 UI／最小化執行、執行完退出  
- 權限、失敗重試、與 Google Token 路徑一致性  

Phase 1～3 只做 App 內排程，但 Export／IPC／資料模型不得阻礙本 Phase。

---

## 檔案新增預估（Approve 後）

```text
main/modules/report-export/
  register.js
  repository.js
  sql-runner.js
  csv-writer.js
  export-service.js
  schedule-utils.js
  scheduler.js
  output/types.js（或 JSDoc）
  output/factory.js
  output/local-provider.js
  output/google-drive-provider.js
  README.md

renderer/features/reportExport/
  view.html
  logic.js
  README.md

docs/report-export/   （已有）

preload.js            （薄包裝）
main/runtime.js       （僅 register 掛載＋必要 DI）
renderer/shell/app.js （catalog mount 最小）
dist-features.json
FEATURE_SCOPE_MAP     （reportExport）
```

---

## 風險與影響現有系統

| 風險 | 緩解 |
|---|---|
| 共用 `sqlPool` 長查詢卡住 AI Chat | Export 獨立 timeout；可評估獨立 pool |
| `runtime.js` 再膨脹 | 新邏輯幾乎全在 module；runtime 只 wiring |
| `drive.file` 選夾困難 | Picker；文件說明限制 |
| 排程與 GChat timer 搶資源 | 獨立 interval、低 concurrency |
| Active Feature 忘記閘門 | 對齊 ADR 0006 測試清單 |
| 與 `report-*` IPC 名稱混淆 | 一律 `report-export-*` |

---

## 建議實作順序（Approve 後）

1. Repository + IPC CRUD  
2. SQL preview（重用 validate）  
3. CSV + Local provider + Manual execute + Log  
4. UI List/Detail  
5. Drive provider + auth  
6. Scheduler  
7. 打磨 Test／Overwrite／日期參數
