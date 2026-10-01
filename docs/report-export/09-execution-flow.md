# 09 — 執行流程

---

## 1. 手動丟檔

```text
UI [手動丟檔]
  → IPC report-export-execute { id, mode: Manual }
  → ReportExportService
  → SQL → CSV → OutputProvider
  → ExecutionLog (Manual)
  → 更新 lastRunAt / lastStatus / nextRunAt（若有排程）
  → 回傳成功訊息與檔名
```

---

## 2. 排程

```text
ReportExportScheduler tick
  → due reports
  → ReportExportService { executionType: Schedule }
  →（同上核心）
  → 單筆失敗只寫 Log，繼續下一筆
```

---

## 3. SQL 預覽

```text
UI [預覽]
  → report-export-preview
  → validate + limited query
  → 回傳 columns/rows
  → 不寫檔、不上傳、不寫正式 Log
```

---

## 4. 測試產生

```text
UI [測試產生]
  → execute mode=Test
  → Provider 指向 Test folder / Test path
  → Log executionType=Test
```

---

## 5. Google Drive 授權補齊

```text
Execute / Pick folder
  → 缺 drive.file
  → 回 featureScopeMissing
  → UI Incremental Auth（auth-google-feature reportExport）
  → 成功後重試
```

排程路徑無 UI：只記 Failed + lastError「需要重新授權雲端硬碟」。

---

## 6. 統一核心（必守）

```text
        Manual ──┐
        Schedule ┼→ ReportExportService → Csv → OutputProvider
        Test ────┘
```

Preview **不**進入 OutputProvider。
