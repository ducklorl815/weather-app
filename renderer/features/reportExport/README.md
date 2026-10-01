# Feature: SQL 報表匯出 (reportExport)

## 說明
依保存的 SQL 產生 CSV，輸出到本機或 Google Drive；可開啟 App 內排程。系統排程器見 `docs/report-export/`。

## 檔案
| 檔案 | 用途 |
|------|------|
| `view.html` | Mosaic partial |
| `logic.js` | 佔位（實作暫在 shell/app.js） |
| `README.md` | 本說明 |

## 掛載
- Catalog type: `reportExport`
- Mount: `mountReportExport`
- Main: `main/modules/report-export/`
