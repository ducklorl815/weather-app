# 07 — Export／CSV／Output Provider 設計

---

## 1. 總流程

```text
ReportExportService.execute(ctx)
  → load ReportDefinition
  → acquire report lock
  → create ExecutionLog (Running)
  → validate SQL
  → resolve date params
  → run SQL (streaming cursor if possible)
  → CsvWriter (UTF-8 BOM 可選)
  → build fileName by OverwriteMode
  → IReportOutputProvider.write(stream, meta)
  → update Log Success + definition lastRunAt/lastStatus
  → release lock
```

Preview：

```text
validate → (optional params) → SQL with hard limit → return rows
（無 CSV、無 Provider、無正式 Log）
```

---

## 2. ReportExportService 職責邊界

**負責**：編排、驗證、計時、Log、檔名、呼叫 Provider  

**不負責**：Drive API 細節、本機 `fs` 細節、OAuth refresh 實作（呼叫既有 auth）

---

## 3. Output Provider Pattern

```text
IReportOutputProvider
  ├── LocalFileOutputProvider
  └── GoogleDriveOutputProvider
```

概念介面：

```js
/**
 * @typedef {object} ReportOutputContext
 * @property {string} reportId
 * @property {'Local'|'GoogleDrive'} outputType
 * @property {object} outputConfig
 * @property {'Overwrite'|'AppendTimestamp'|'FailIfExists'} overwriteMode
 * @property {'Manual'|'Schedule'|'Test'} executionType
 */

/**
 * @returns {Promise<{ fileName: string, filePath?: string, googleDriveFileId?: string, googleDriveFolderId?: string }>}
 */
async function write(stream, fileName, context) {}
```

Factory：

```js
function getOutputProvider(outputType) {
  switch (outputType) {
    case 'Local': return localProvider;
    case 'GoogleDrive': return driveProvider;
    default: throw new Error('不支援的輸出類型');
  }
}
```

**禁止**在 ExportService 散落 `if (outputType === 'GoogleDrive')` 上傳邏輯。

---

## 4. CSV 產生

### 必須處理

| 議題 | 作法 |
|---|---|
| UTF-8 中文 | UTF-8；Excel 友善可加 BOM `\uFEFF`（建議可設定，預設開） |
| Header | 使用 recordset column 名 |
| 逗號／換行／雙引號 | RFC 4180：欄位包 `"`，`"` → `""` |
| NULL | 空字串 |
| DateTime | 建議 `yyyy-MM-dd HH:mm:ss`（與現有 `serializeReportValue` 對齊，可設定） |
| Decimal | 原樣字串化，避免科學記號意外 |
| Boolean | `true`/`false` 或 `1`/`0`（建議固定一種） |
| 大量資料 | **串流寫入**：`mssql` request stream 或分批 fetch → `PassThrough` → Provider |

### 禁止

```js
rows.map(r => values.join(',')) // 不足以正確 escape
```

### Streaming

```text
SQL stream rows
  → transform row to csv line
  → PassThrough / temp file
  → Provider.upload(stream)
```

若 Google Drive API 對未知長度 stream 不穩，可：

1. 先寫 **temp file**（`userData/report-export-temp/`）  
2. 再 upload／copy  
3. finally 刪 temp  

**建議 Phase 1**：temp file 路徑（實作簡單、易重試、記憶體可控）。

現有 `executeReportSql` 一次載入並 `slice(0,200)`——**不可**直接重用於正式 Export。

---

## 5. 檔名與 OverwriteMode

基本：`{fileNameBase}_{yyyyMMdd}.csv`

| Mode | 行為 | Drive | Local |
|---|---|---|---|
| **Overwrite**（建議預設） | 同名覆蓋 | 找同名 fileId → `files.update` media；沒有則 create | `fs.writeFile` 覆蓋 |
| AppendTimestamp | `{base}_{yyyyMMdd}_{HHmmss}.csv` | 一律 create | 新檔 |
| FailIfExists | 已存在則失敗 | list/get by name 於 folder | `fs.existsSync` |

### 為何建議預設 Overwrite？

- 業務「每天固定檔名給下游系統撿檔」最常見  
- 與需求示例 `travel_push_updated_20260915.csv` 一致  
- Catch-up／同日重跑不會堆大量檔案  

仍須在 UI 明確可改。

---

## 6. LocalFileOutputProvider

- 確認目錄存在；可選 `fs.mkdirSync(path, { recursive: true })`（建議開，並在 UI 說明）  
- 無權限／磁碟滿 → Failed Log  
- Test mode：寫入 `{localPath}/Test/` 或平行 testPath

---

## 7. GoogleDriveOutputProvider

### 上傳

```text
取得 folderId（Test 時用 testFolderId 若有）
依 OverwriteMode 決定 create vs update
drive.files.create / update
  media: { mimeType: 'text/csv', body: fs.createReadStream(temp) }
  parents: [folderId]（create 時）
fields: id, name
回傳 googleDriveFileId
```

### Token

- 使用既有 `oauth2Client`；googleapis 會 refresh  
- 401／invalid_grant → 拋可辨識錯誤 → Log Failed → **不中止 Scheduler**

### Scope

- `drive.file`：僅 App 建立或使用者經 Picker 選過的檔／夾  
- 覆蓋同名：需能在該 folder 查到 App 可見檔案；查不到則 create 新檔（可能造成重複）——實作時用 `appProperties` 或保存上次 `googleDriveFileId` 於 definition／last log 輔助 update

**建議**：Definition 可選存 `lastGoogleDriveFileIdByDay` 或僅用「folder 內 name = exact」搜尋（q 參數）且限於 App 可見。

---

## 8. SQL 執行建議

| 項目 | Preview | Export |
|---|---|---|
| Timeout | 短（如 20s） | 可設定（如 120～300s） |
| Row limit | 強制 TOP／FETCH 100（可設定） | 預設無上限，但可設 soft max（如 500k）超限失敗 |
| 驗證 | `validateReportSql` 精神 | 同左 |
| 參數 | dateParams | 同左 |

實作可抽 `ReportSqlRunner`：`preview(sql, opts)` / `stream(sql, opts)`。

是否沿用「已訓練表白名單」見 `08-security.md`。

---

## 9. 測試產生（Test）

- `executionType = 'Test'`  
- 目的地：Drive `testFolderId` 或 Local `...\Test\`  
- 若未設 Test 資料夾：拒絕並提示設定，避免誤蓋正式檔  
- 建議仍寫 Log，但不更新「業務用」lastRunAt（或 UI 標註測試）

---

## 10. 錯誤處理矩陣（摘要）

| 錯誤 | 處理 |
|---|---|
| SQL timeout | Failed + message |
| SQL syntax／權限 | Failed |
| 驗證擋下 DML | 不執行 |
| 路徑不存在 | mkdir 或 Failed（依設定） |
| 磁碟權限 | Failed |
| Drive quota／403 | Failed；提示授權／資料夾 |
| 並行衝突 | 回執行中，不開第二條 |

單報表失敗不影響其他報表 tick。
