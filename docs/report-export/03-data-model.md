# 03 — 資料模型設計

> 專案**沒有 ORM／Migration**。持久化以 `userData` JSON 為主（與 notes／report-schema／gemini 一致）。  
> 下列「資料表」語意 = **JSON Collection／Record Schema**，非 SQL DDL（除非後續改存 MSSQL）。

---

## 1. 設計原則

1. 不以單一 `OutputPath` 字串代表所有目的地  
2. 使用 `OutputType` + `OutputConfig`（依類型不同欄位）  
3. 執行紀錄與報表定義分離  
4. Schema 帶 `schemaVersion`，方便日後遷移  
5. ID 使用字串（如 `rpt_` + hex），與 notes 模組風格一致

---

## 2. ReportDefinition（報表定義）

建議檔案：`userData/report-export-definitions.json`

```json
{
  "schemaVersion": 1,
  "reports": [ /* ReportDefinition */ ]
}
```

### 欄位

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | 主鍵 |
| `reportName` | string | 報表名稱 |
| `department` | string | 需求單位 |
| `description` | string | 說明 |
| `fileNameBase` | string | 基本檔名（不含日期／副檔名） |
| `sqlQuery` | string | SQL 文字 |
| `outputType` | `'Local' \| 'GoogleDrive'` | 輸出方式 |
| `outputConfig` | object | 依 outputType（見下） |
| `overwriteMode` | `'Overwrite' \| 'AppendTimestamp' \| 'FailIfExists'` | 檔案存在策略 |
| `scheduleEnabled` | boolean | 是否開啟排程 |
| `schedule` | object \| null | 排程設定（關閉時可保留上次設定） |
| `dateParams` | object | 日期參數策略（見 §5） |
| `enabled` | boolean | 報表是否啟用（軟刪除／停用） |
| `lastRunAt` | string \| null | ISO 時間 |
| `nextRunAt` | string \| null | ISO 時間（Scheduler 維護） |
| `lastStatus` | `'Success' \| 'Failed' \| null` | 最後結果 |
| `lastError` | string \| null | 最後錯誤摘要 |
| `createdAt` | string | ISO |
| `updatedAt` | string | ISO |

### outputConfig — Local

```json
{
  "localPath": "D:\\\\Report\\\\Travel"
}
```

### outputConfig — GoogleDrive

```json
{
  "googleAccountEmail": "user@company.com",
  "folderId": "xxxxxxxxxxxxxxxx",
  "folderName": "Marketing Reports / Travel",
  "testFolderId": "yyyyyyyyyyyyyyyy",
  "testFolderName": "Test"
}
```

說明：

- 系統執行以上傳 **`folderId`** 為準；`folderName` 僅 UI 顯示  
- Credential 不存在報表定義內，一律用 App 級 `google_token.json`  
- Phase 1 假設「目前登入的 Google Session」即上傳帳號（單使用者桌面 App）

### schedule

```json
{
  "type": "EveryNMinutes | EveryNHours | Daily | Weekly | Monthly",
  "interval": 5,
  "time": "16:00",
  "weekDays": [1, 3, 5],
  "dayOfMonth": 1,
  "timezone": "Asia/Taipei"
}
```

| type | 使用欄位 |
|---|---|
| EveryNMinutes | `interval`（分鐘） |
| EveryNHours | `interval`（小時）；對齊整點／interval 邊界 |
| Daily | `time` |
| Weekly | `weekDays` + `time` |
| Monthly | `dayOfMonth` + `time` |

`weekDays`：建議 `0=Sun … 6=Sat` 或 `1=Mon … 7=Sun`——實作前在程式常數固定一種並寫進 UI。

---

## 3. ReportExecutionLog（執行紀錄）

建議檔案：`userData/report-export-logs.json`

```json
{
  "schemaVersion": 1,
  "logs": [ /* ReportExecutionLog */ ]
}
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | string | Log 主鍵 |
| `reportId` | string | 對應報表 |
| `executionType` | `'Manual' \| 'Schedule' \| 'Test'` | 觸發方式 |
| `startTime` | string | ISO |
| `endTime` | string \| null | ISO |
| `status` | `'Running' \| 'Success' \| 'Failed' \| 'Cancelled'` | |
| `recordCount` | number \| null | SQL 筆數 |
| `fileName` | string \| null | 最終檔名 |
| `destinationType` | `'Local' \| 'GoogleDrive'` | |
| `filePath` | string \| null | Local 完整路徑 |
| `googleDriveFolderId` | string \| null | |
| `googleDriveFileId` | string \| null | **上傳成功必存** |
| `errorMessage` | string \| null | |
| `durationMs` | number \| null | |
| `createdAt` | string | |

### 保留策略（建議）

- 每報表最多保留最近 N 筆（例如 100）  
- 或全域最多 2000 筆，超出 FIFO 刪除  
- Preview **不寫**此 Log

---

## 4. 為何不用 MSSQL 存報表定義？

| 方案 | 優點 | 缺點 |
|---|---|---|
| **JSON（建議 Phase 1）** | 符合專案慣例；離線可管；不依賴 ERP 寫入權 | 多裝置不同步；需自行做 schemaVersion |
| MSSQL 表 | 集中、可稽核 | 需寫入權；與「報表帳號唯讀」衝突；偏離現有 App 設定模式 |

**建議**：Phase 1 用 JSON。若未來要公司級共用報表目錄，再另開「伺服端報表目錄」專案。

---

## 5. 日期參數（DateParams）— 設計方案（待確認）

現有 AI 報表 SQL 多直接寫 `GETDATE()`／`DATEADD`，較少 `@StartDate` 參數。  
新功能若允許 `@StartDate`／`@EndDate`，建議**顯式設定**，不要猜。

### 建議模型

```json
"dateParams": {
  "mode": "None | SqlNative | BoundParams",
  "bindings": {
    "StartDate": { "strategy": "TodayStart | TodayEnd | ExecutionDate | ExecutionDateMinusDays | LastRunAt | Custom" },
    "EndDate":   { "strategy": "..." }
  },
  "customRange": { "start": null, "end": null },
  "minusDays": 1
}
```

| mode | 行為 |
|---|---|
| `None` | 不注入參數；SQL 自行用 `GETDATE()` 等 |
| `SqlNative` | 同上，UI 提示使用者在 SQL 內寫 T-SQL 日期函數 |
| `BoundParams` | Main 用 `mssql` `request.input('@StartDate', …)` 綁定 |

### 策略候選（供確認）

| strategy | 語意 |
|---|---|
| TodayStart | 執行當日 00:00:00 |
| TodayEnd | 執行當日 23:59:59.997（或翌日 00:00 exclusive） |
| ExecutionDate | 執行當下 timestamp |
| ExecutionDateMinusDays | 執行日 − N 天（配合 `minusDays`） |
| LastRunAt | 該報表 `lastRunAt`（首次可退回 TodayStart） |
| Custom | 手動指定（較適合測試，不適合排程） |

**預設建議（待你確認）**：`mode = None`（與現有 EMRequestForm preset 風格一致），進階報表再開 `BoundParams`。

---

## 6. 與現有 report-schema 的關係

- `report-schema.json`：AI 報表「可查資料字典／白名單」  
- Report Export：可選擇  
  - **A**：沿用同一白名單（較安全，與 `validateReportSql` 一致）  
  - **B**：允許任意 SELECT（較彈性，風險較高）  

**建議預設 A**，並在 UI 提示「請先在詢問機器人訓練資料表」或提供本功能內的表授權清單。此項需產品確認。

---

## 7. 索引與查詢需求（JSON 層）

Repository 需支援：

- list reports（含排序：updatedAt / nextRunAt）  
- get by id  
- upsert / soft-disable  
- list logs by reportId（分頁：offset/limit）  
- append log + trim  
- list due reports：`scheduleEnabled && enabled && nextRunAt <= now`
