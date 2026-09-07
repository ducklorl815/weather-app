# Feature: 9527 (sheets)

## 說明
9527 試算表收件匣與篩選。

## 檔案
| 檔案 | 用途 |
|------|------|
| `view.html` | 「加入功能」後 mosaic tile 的 **partial view**（僅 body） |
| `logic.js` | 此功能的前端邏輯（由 shell 載入） |
| `README.md` | 本說明（人工維護入口） |

## 掛載
- Catalog type: `sheets`
- Mount 函式: `loadSheets`
- Main process: `main/modules/sheets.js`（逐步自 runtime 拆出）

## [Important]
修改 `view.html` 內的 DOM id 時，必須同步檢查 `logic.js` 與 `main` IPC。

## 編號（列號）
- 領域用語見根目錄 `CONTEXT.md`（**編號** = 試算表原生列號，UI 寫成 `#N`）。
- 資料來源：Main `parseSheetRows` 的 `rowNumber`。
- 顯示：主列表標題上方、編輯 modal 標題上方（`app.js` `renderSheetsList` / `showSheetRowModal`）。
