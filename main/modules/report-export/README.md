# modules/report-export

SQL 報表自動匯出（CSV → Local／Google Drive）。

## Phase 狀態

| Phase | 狀態 |
|---|---|
| 1 Local CRUD + Preview + Manual Export | 已做 |
| 2 Google Drive | 已做 |
| 3 App 內 Scheduler | 已做 |
| 5 系統排程器 | 已確認要做，未做 |

## 文件

見 `docs/report-export/`。

## 掛載

由 `main/runtime.js` `registerReportExportModule(...)`；Active Feature On 時 `startScheduler()`。
