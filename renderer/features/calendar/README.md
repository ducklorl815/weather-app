# Feature: 預定行程 (calendar)

## 說明
Google 日曆行程列表與建立行程。

## 檔案
| 檔案 | 用途 |
|------|------|
| `view.html` | 「加入功能」後 mosaic tile 的 **partial view**（僅 body） |
| `logic.js` | 此功能的前端邏輯（由 shell 載入） |
| `README.md` | 本說明（人工維護入口） |

## 掛載
- Catalog type: `calendar`
- Mount 函式: `loadCalendar`
- Main process: `main/modules/calendar.js`（逐步自 runtime 拆出）

## [Important]
修改 `view.html` 內的 DOM id 時，必須同步檢查 `logic.js` 與 `main` IPC。
