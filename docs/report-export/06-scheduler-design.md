# 06 — Scheduler 設計

---

## 1. 現況結論

專案已有 **setInterval + 防重入** 的模組化排程（`main/modules/gchat/sync-scheduler.js`）。  
**沒有** Hangfire／Quartz／獨立 Windows Service。

**建議**：仿造 GChat，新增輕量 `ReportExportScheduler`（Main Process），**不引入大型第三方排程套件**。

---

## 2. 職責分離

```text
ReportExportScheduler
  └─ 只回答：現在有哪些報表 due？觸發誰？

ReportExportService
  └─ 只回答：如何 Preview／Export（SQL→CSV→Output）
```

Scheduler **不得**直接寫 CSV 或呼叫 Drive API。

---

## 3. 建議實作

檔案：`main/modules/report-export/scheduler.js`

```text
tick every 30s～60s（建議 30s，與 GChat 同級但獨立 timer）
  → if !ActiveFeature(reportExport) return
  → if !Session（Drive 報表需要）→ 對 due 的 Drive 報表記失敗或 skip+log
  → load definitions
  → due = scheduleEnabled && enabled && nextRunAt <= now
  → for each due (concurrency limit = 1 or 2):
        if runningSet.has(reportId) skip
        await ReportExportService.execute({ id, executionType: 'Schedule' })
        recalculate nextRunAt
```

### 為何用輪詢而不是精確 cron？

- 與現有架構一致、易測試  
- 桌面 App 休眠／醒過來可在下一 tick 補抓 due  
- 分鐘級業務足夠；「每 N 分鐘」對齊牆鐘邊界即可

---

## 4. nextRunAt 計算

儲存／Scheduler 完成後呼叫 `computeNextRunAt(schedule, fromTime)`：

| type | 規則（建議） |
|---|---|
| EveryNMinutes | 下一個 `floor(now/interval)*interval + interval` |
| EveryNHours | 對齊小時邊界（例 interval=2 → 0,2,4…） |
| Daily | 今日 time；已過則明日 |
| Weekly | 下一個符合 weekDays 的 date+time |
| Monthly | 本月 dayOfMonth+time；已過或無此日則下月（**缺日策略待確認**：跳過／最後一天） |

Timezone：Phase 1 建議固定使用本機時區或 `Asia/Taipei`（與公司情境相符）；寫入 `schedule.timezone` 以便日後顯式化。

---

## 5. 錯過執行（Missed runs）

| 策略 | 說明 | 建議 |
|---|---|---|
| **Catch-up once** | 醒來發現 `nextRunAt` 已過 → 立刻執行一次 → 重算下一個未來時間 | **預設建議** |
| Skip to next | 只重算下一個未來時間，不補跑 | 適合同日覆蓋檔、不在乎漏次 |
| Run all missed | 補跑所有間隔 | 易打爆 DB／Drive；不建議 |

文件預設：**Catch-up once**。若 `OverwriteMode=Overwrite`，補跑一次通常足夠。

---

## 6. 並行與鎖定

1. **同 reportId**：`runningSet`／檔案鎖；第二次 Manual／Schedule 回「執行中」  
2. **跨報表**：全域 concurrency 上限（建議 1～2），避免 MSSQL／磁碟／Drive 打滿  
3. tick 本身 `tickRunning` 防重入（抄 sync-scheduler）

---

## 7. 生命週期

| 事件 | 行為 |
|---|---|
| Active Feature On + Session | `scheduler.start()` |
| Feature Off | `scheduler.stop()`；不清定義 |
| Logout | stop；進行中的 execute 應 abort／標記 Failed |
| App quit | 無法繼續（桌面限制） |
| closeToTray | Main 仍在 → 排程繼續 |

---

## 8. 與 Google Drive／OAuth

- Scheduler 在 Main 跑，**不依賴 Renderer**  
- Token 過期：走既有 `oauth2Client` refresh  
- Refresh 失敗：該次 Log=Failed，**不 stop 整個 Scheduler**；其他報表繼續  
- 通知：Phase 1 可寫 lastError；Phase 2 再接 Toast／郵件

---

## 9. 不採用的方案（本階段）

| 方案 | 原因 |
|---|---|
| node-cron / agenda / bull | 額外依賴與持久 queue，收益有限 |
| 獨立 Worker 程序 | 需第二套 OAuth／設定同步 |
| Renderer setInterval | 違反「不依賴前端」；頁面關閉即停 |

---

## 10. 已確認：最終要接到系統排程器（Phase 1 先 App 內）

**產品決策（2026-09-15）**：

- 最終目標：App **退出後仍要跑** → 排程應寫到 **系統排程器**（例如 Windows Task Scheduler）
- **目前／Phase 1**：先實作 **App 內 Scheduler**（本文件 §2～§8）
- **之後再調整**：改為（或並行）註冊 OS 排程；不阻塞 Phase 1 Coding

### 過渡期設計約束（現在就要遵守，避免之後大改）

1. **執行核心只在 `ReportExportService`**  
   OS 排程器、App 內 tick、手動按鈕，最後都只能呼叫同一套 execute。
2. **預留 CLI／單次啟動入口（可先不實作，但介面要留）**  
   概念：`LifeTour.exe --report-export-run=<reportId>`  
   → 啟動 Main → 執行一筆 → exit（給 Task Scheduler 用）。
3. **`nextRunAt`／schedule 欄位留在 ReportDefinition**  
   之後可由「App 同步到 schtasks」或「改由 OS 當唯一觸發源、App 只存設定」。
4. **不要把「下次何時跑」寫死在只能靠常駐 setInterval 的假設**  
   Interval tick 是 Phase 1 觸發器，不是唯一允許的觸發器。

### 未來 Phase（系統排程器）草圖

```text
使用者儲存並開啟排程
  → App 將排程登錄／更新到 Windows Task Scheduler
  → 到點：Task 啟動 LifeTour（或 helper）單次模式
  → ReportExportService.execute({ executionType: 'Schedule' })
  → process exit

App 完全退出時：仍可由 OS 喚醒執行
```

細節（帳號權限、隱藏視窗、與 closeToTray 衝突、多報表多 task）等到該 Phase 再設計；Phase 1 不實作 schtasks。
