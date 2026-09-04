# Feature: Little Reply (gchat)

## 說明
Little Reply（Google Chat）列表、搜尋、釘選、泡泡回覆。

## 檔案
| 檔案 | 用途 |
|------|------|
| `view.html` | 「加入功能」後 mosaic tile 的 **partial view**（僅 body） |
| `logic.js` | 此功能的前端邏輯（由 shell 載入） |
| `README.md` | 本說明（人工維護入口） |

## 掛載
- Catalog type: `gchat`
- Mount 函式: `loadGchat`
- Main process: `main/modules/gchat/`（逐步自 runtime 拆出）

## [Important]
修改 `view.html` 內的 DOM id 時，必須同步檢查 `logic.js` 與 `main` IPC。
