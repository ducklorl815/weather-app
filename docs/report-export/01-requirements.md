# 01 — SQL 報表自動匯出需求

> 狀態：Analyze／Design（尚未 Coding）  
> 產品：LifeTour（Electron 桌面生產力中心）

---

## 1. 功能目的

讓使用者建立「報表定義」，依設定的 SQL 查詢 MSSQL，產生 CSV，並輸出到指定目的地（本機路徑或 Google Drive）。支援手動丟檔與排程自動執行。

與現有「詢問機器人 / report-run」（Gemini 產生 SQL → 畫面預覽）**不同**：本功能是**可保存、可排程、可匯出檔案**的報表管線。

---

## 2. 核心能力

| 能力 | 說明 |
|---|---|
| 報表 CRUD | 名稱、需求單位、說明、SQL、檔名、輸出目的地、排程 |
| SQL 預覽 | 只查詢、顯示表格；不寫檔、不上傳、不寫正式執行 Log |
| 手動丟檔 | 正式 Export → CSV → Output Provider |
| 排程丟檔 | Scheduler 觸發同一套 Export Service |
| 執行紀錄 | Manual / Schedule 皆留下 Log |
| 輸出目的地 | Phase 1：`Local` + `GoogleDrive`；架構預留擴充 |

---

## 3. CSV 檔名規則

```text
{使用者設定的基本檔名}_{yyyyMMdd}.csv
```

例：`travel_push_updated` + `2026/09/15` → `travel_push_updated_20260915.csv`

同日多次執行時，行為由 `OverwriteMode` 決定（見 `07-export-design.md`）。

---

## 4. 列表（Search List）欄位

| 欄位 | 說明 |
|---|---|
| 報表名稱 | ReportName |
| 需求單位 | Department |
| 檔案名稱 | FileNameBase（不含日期後綴） |
| 輸出目的地 | Local 路徑摘要 / Google Drive 資料夾顯示名 |
| 排程狀態 | 開啟 / 關閉 |
| 排程設定 | 人類可讀描述，如「每天 16:00」 |
| 上次丟檔 | LastRunAt |
| 下次執行 | NextRunAt |
| 最後結果 | Success / Failed |
| 操作 | 詳細 / 編輯 / 手動丟檔 |

---

## 5. 詳細設定區塊

1. **基本資訊**：報表名稱、需求單位、說明、檔案名稱  
2. **輸出設定**：OutputType（Local / GoogleDrive）+ 對應設定 + OverwriteMode  
3. **SQL**：編輯、儲存、預覽、結果表  
4. **排程**：開關 + 週期類型 + 時間／間隔／星期／日  
5. **執行紀錄**：近期 Log 列表  
6. **動作**：儲存、立即丟檔、（建議）測試產生至 Test 資料夾

---

## 6. 排程週期（需求）

- 每 N 分鐘  
- 每 N 小時  
- 每天（指定時間）  
- 每週（多選星期 + 時間）  
- 每月（日 + 時間）

---

## 7. 非功能需求（摘要）

| 類別 | 要求 |
|---|---|
| 安全 | 僅允許 SELECT／WITH；共用既有 SQL 驗證精神；Drive 最小 scope |
| 穩定 | 同報表不可並行；逾時／錯誤可記錄；單報表失敗不拖垮 Scheduler |
| 共用 | Manual 與 Schedule 共用 `ReportExportService` |
| 分離 | Preview ≠ Export；Export ≠ Output Provider 實作細節 |
| 擴充 | Output Provider Pattern；未來 OneDrive／SFTP 不改 Export 核心 |
| 生命週期 | 排程在 Main Process；不依賴瀏覽器／Renderer 開著 |

---

## 8. 明確不在本階段範圍

- 大量修改既有程式碼  
- 實作 OneDrive／SFTP／FTP  
- 引入 Hangfire／Quartz 等大型排程套件（除非確認必要）  
- 將此功能做成獨立後端 Web API 服務（與現行 Electron 架構不符）

---

## 9. 待確認項目（需你拍板）

見 `00-report-export-overview.md` 確認清單；重點包含：

1. 覆蓋策略預設值  
2. 日期參數模型  
3. Google Drive 資料夾選擇方式（Picker vs 手動 Folder ID）  
4. 報表設定是否允許「任意 SELECT」還是沿用「已訓練資料表白名單」  
5. ~~App 完全退出時排程是否必須仍執行~~ → **已確認：最終要（系統排程器）；Phase 1 先 App 內**
