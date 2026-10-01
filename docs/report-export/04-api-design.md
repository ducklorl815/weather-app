# 04 — API（IPC）設計

> LifeTour **沒有 REST `/api/*`**。對應層是 **IPC channel + `preload.js` → `window.api`**。  
> 下列以 REST 概念對照，實際實作為 IPC。

---

## 1. Pattern 對照

| REST 概念 | LifeTour 實作 |
|---|---|
| `GET /api/reports` | `ipcMain.handle('report-export-list')` |
| `GET /api/reports/:id` | `report-export-get` |
| `POST /api/reports` | `report-export-create` |
| `PUT /api/reports/:id` | `report-export-update` |
| `DELETE /api/reports/:id` | `report-export-delete`（建議 soft：`enabled=false`） |
| `POST .../preview` | `report-export-preview` |
| `POST .../execute` | `report-export-execute` |
| `GET .../executions` | `report-export-executions` |

命名前綴：`report-export-*`，避免與現有 `report-tables` / `report-run` 衝突。

---

## 2. Channel 清單

| Channel | preload API | 說明 |
|---|---|---|
| `report-export-list` | `reportExportList()` | 列表（含排程摘要、last/next、lastStatus） |
| `report-export-get` | `reportExportGet(id)` | 單筆完整定義 |
| `report-export-create` | `reportExportCreate(payload)` | 新增 |
| `report-export-update` | `reportExportUpdate(id, payload)` | 更新（儲存後重算 `nextRunAt`） |
| `report-export-delete` | `reportExportDelete(id)` | 刪除／停用 |
| `report-export-preview` | `reportExportPreview({ id?, sql, dateParams?, limit? })` | SQL 預覽 |
| `report-export-execute` | `reportExportExecute({ id, mode: 'Manual'\|'Test' })` | 正式／測試匯出 |
| `report-export-executions` | `reportExportExecutions({ id, limit, offset })` | 執行紀錄 |
| `report-export-pick-drive-folder` | `reportExportPickDriveFolder()` | 開啟 Google Picker／選資料夾 |
| `report-export-auth-status` | `reportExportAuthStatus()` | Drive scope／Session 狀態 |

可選推送：

| Event | 方向 | 用途 |
|---|---|---|
| `report-export-run-progress` | Main → Renderer | 長時間執行進度（開始／寫 CSV／上傳） |
| `report-export-run-finished` | Main → Renderer | 列表頁即時刷新 lastStatus |

---

## 3. 回應 Envelope（建議與現有一致）

現有多數 handler 回傳：

```js
{ success: true, ... }
{ success: false, error: '...', needsAuth?, featureScopeMissing? }
```

本功能沿用；Preview 成功例：

```js
{
  success: true,
  columns: ['Id', 'Name'],
  rows: [{ Id: 1, Name: '...' }],
  total: 100,
  truncated: true,
  limit: 100
}
```

Execute 成功例：

```js
{
  success: true,
  fileName: 'travel_push_updated_20260915.csv',
  destinationType: 'GoogleDrive',
  googleDriveFileId: '...',
  recordCount: 1250,
  durationMs: 3200,
  executionId: 'log_...'
}
```

---

## 4. Preview vs Execute 契約

| | Preview | Execute (Manual/Schedule/Test) |
|---|---|---|
| 驗證 SQL | 是 | 是 |
| 執行查詢 | 是（強制 LIMIT／TOP） | 是（可全量，需防護） |
| 產 CSV | 否 | 是 |
| Output Provider | 否 | 是 |
| Execution Log | 否 | 是（Test 標記 `executionType=Test`） |
| 更新 lastRunAt / nextRunAt | 否 | Manual/Schedule 是；Test 建議不更新 lastRunAt 或另欄 |

---

## 5. 權限與錯誤碼語意

| 情況 | 回傳 |
|---|---|
| 未登入且需要 Drive | `needsAuth: true` |
| 缺 drive.file | `featureScopeMissing: true` |
| SQL 非法 | `success: false, error: '...'` |
| 報表執行中 | `error: '此報表正在執行中'` |
| 路徑／權限／上傳失敗 | Failed Log + error message |

所有授權檢查走既有 Authorization／Scope Registry，**不在各 handler 散落第二套判斷邏輯**（可呼叫共用 `assertReportExportReady(outputType)`）。

---

## 6. 與 Active Feature

- Scheduler 受 Active Feature 閘門控制  
- IPC CRUD／Preview／Execute：即使 Feature Off，是否允許「僅編輯設定」？  

**建議**：  
- Feature Off：允許 list/get/update（管理設定）  
- Feature Off：拒絕 execute／scheduler tick（避免背景副作用）  
- 或更嚴：Feature Off 整組 IPC 提示「請先加入功能」

待產品確認；文件預設採「Off 可編輯、不可執行」。
