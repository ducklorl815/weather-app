# 05 — 前端 UI 設計

---

## 1. 功能掛載

| 項目 | 建議 |
|---|---|
| Catalog type | `reportExport` |
| 顯示名稱 | SQL 報表匯出（或「報表丟檔」） |
| 目錄 | `renderer/features/reportExport/view.html` + `logic.js` + `README.md` |
| Mosaic | 加入功能後出現 tile；點開進入管理 UI |
| dist-features | `widgets.reportExport` |

視覺風格：跟隨既有 Shell／tile 變數；本階段不另做 landing marketing。

---

## 2. 畫面結構

建議單 Feature 內兩個 view state（不必新開 BrowserWindow）：

```text
List View  ←→  Detail / Edit View
```

### 2.1 列表

```text
SQL 報表匯出                    [新增報表]

報表名稱 | 需求單位 | 檔名 | 目的地 | 排程 | 上次丟檔 | 下次 | 結果 | 操作
------------------------------------------------------------------------
Travel   | 行銷部   | travel_… | Drive:Travel | 每天16:00 | 09/15 16:00 | … | 成功 | …
```

操作按鈕：

- **詳細** → Detail（唯讀或可編輯）  
- **編輯** → 同 Detail 編輯模式  
- **手動丟檔** → confirm → `reportExportExecute({ mode:'Manual' })` → toast／對話框顯示檔名

### 2.2 詳細／編輯

分區塊（單欄捲動即可）：

1. **基本資料**  
   - 報表名稱、需求單位、說明、檔案名稱（基本檔名）

2. **輸出設定**  
   - ○ Local / Server　● Google Drive  
   - Local：路徑 input +（可選）選資料夾 dialog（Electron `dialog.showOpenDialog`）  
   - Google Drive：帳號顯示、資料夾路徑顯示、`[選擇資料夾]`、Folder ID 唯讀  
   - 檔案格式：CSV（Phase 1 固定）  
   - 檔案存在時：○ 覆蓋　○ 新增時間　○ 報錯

3. **SQL**  
   - textarea／簡易 editor（Phase 1 不必上 Monaco，除非你堅持）  
   - `[預覽]` `[格式化]`（格式化可選；無現成依賴則 Phase 2）  
   - 結果表：columns + rows（虛擬捲動可選）

4. **排程**  
   - ☑ 開啟排程  
   - 執行方式 radio：每 N 分鐘／小時／每天／每週／每月  
   - 依類型顯示 interval／time／weekDays／dayOfMonth  
   - 顯示下次執行預覽（client 計算或後端回傳）

5. **執行紀錄**  
   - 表格：時間｜方式｜筆數｜檔案｜目的地｜結果｜耗時

6. **底欄動作**  
   - `[儲存]` `[立即丟檔]` `[測試產生]`（Test → 建議寫入 testFolder／Local 子路徑 `Test\`）

---

## 3. UI 行為規則

| 動作 | 行為 |
|---|---|
| 改 SQL 後按預覽 | 只查詢；可未儲存用 payload.sql |
| 立即丟檔 | 建議先自動儲存或拒絕未儲存變更（二選一，建議：**先存再執行**） |
| 關閉排程 | 保留 schedule 物件；`scheduleEnabled=false`；清／停 nextRun |
| Drive 未授權 | 顯示 Feature Scope Gate → Incremental Auth |
| 執行中 | 該列按鈕 disable + spinner |
| 成功 | 「報表產生成功」+ 檔名；Drive 可附開啟連結（fileId） |

---

## 4. Google Drive 選資料夾 UX

```text
[選擇資料夾]
  → Main 開 Picker（或引導瀏覽器／BrowserWindow）
  → 使用者選 Folder
  → 回傳 { folderId, folderName }
  → 寫入表單（尚未按儲存前僅在 UI state）
```

**不要**要求使用者貼完整 Drive URL 作為唯一方式；可保留「進階：貼 Folder ID」作後備。

`drive.file` 限制：Picker 選過的資料夾／App 建立的資料夾才可靠——文件需在 UI 小字說明。

---

## 5. 與現有 chat 報表 UI 的關係

- **不合併**進詢問機器人 tile  
- 可在 chat README 加一句：「排程 CSV／Drive 請用 SQL 報表匯出」  
- 資料表白名單若共用，Detail 可連到「已訓練資料表」說明

---

## 6. 實作落點建議

為符合架構原則、避免再撐爆 `app.js`：

1. Partial：`renderer/features/reportExport/view.html`  
2. 邏輯優先寫在 `logic.js`（若現況仍強制 mount 於 app.js，則最小掛載函式 `mountReportExport` + 儘快下沉）  
3. CSS：feature 內 scoped class 前綴 `re-`（report-export）
