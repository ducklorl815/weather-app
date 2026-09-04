# Timer Map

> **[差量]** Little Reply：`viewingRefreshTimer`／Reply Pop `livePollTimer` **已移除**；見 [`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)。下表「現行」欄已標註；其餘歷史分析保留供對照。

## Main Process — 週期性（setInterval）

| ID / 變數 | 間隔 | 建立位置 | 停止位置 | 執行內容 | API | Cache/UI | 生命週期 | 重複問題 |
|---|---|---|---|---|---|---|---|---|
| `syncTimer` | **60s** | `startSyncLoop` runtime L982 | logout/stopSyncLoop | `runSync` Gmail | Gmail API | cache → gmail-packet push | Session 登入後 | — |
| `meetingTimer` | **30s** | `startMeetingWatch` L1013 | stopMeetingWatch | `checkMeetingReminders` | Calendar API | Notification | Session | — |
| ~~`viewingRefreshTimer`~~ | — | — | — | **已移除**；改 PollCoordinator + `gchat-thread-ping` | — | — | — | — |
| `sessionWatchTimer` | **60s** | `startSessionWatch` L4109 | stopSessionWatch | `runSessionWatch` | token refresh | session-status | app 啟動後 | — |
| GChat scheduler | **30s** | `sync-scheduler.js` L48 via `startGchatSyncScheduler` | stopGchatSyncScheduler / logout | inbox sync + onAfterSync | searchUnread + bar badges | gchatCache, toast, bar | Chat 授權後 | **核心 inbox 定時器** |
| `updateCheckTimer` | **~1h** | runtime L14117 | app quit | `checkForAppUpdates` | electron-updater | update-status push | app 啟動後 | — |

### GChat scheduler onAfterSync 鏈（每 30s）

```text
syncUnreadInbox()
  → syncRegistryReplyPopBadges()     [N × messages.list per bar]
  → pingViewingGchatThread()         [若 viewing，可能與 viewingRefreshTimer 重複]
  → notifyNewGchatAlerts()           [Toast]
```

---

## Main Process — 單次 / 防抖（setTimeout）

| 情境 | 延遲 | 位置 | 用途 |
|---|---|---|---|
| `replyPopBoundsSaveTimer` | debounce | runtime L139 | 持久化 pop bounds |
| `gchatQuickSearchBlurTimer` | blur | L507 | 隱藏 Quick Search |
| `oauthFlowTimer` | 300s | L4348 | OAuth 逾時 |
| ping viewing 立即 | 400ms | L3789 | 開啟 viewing 後立即 ping |
| bootstrap GChat | session 後 | L4040 | prefetchGchatTodayCache |
| `saveGchatDisk` | 0ms | 多處 | 非同步寫碟 |
| update 首次檢查 | 啟動 delay | L14106 | 延遲 check update |
| Reply pop 動畫 | 40/60/280ms | L218–286 | 視窗動畫 |
| `withTransientRetry` | 450ms×n | L4858 | Google API 重試 |
| directoryWarmed 失效 | 5min | L9819 | 目錄快取 |
| custom emoji hydrate gap | CUSTOM_EMOJI_HYDRATE_GAP_MS | L9003 | 下載節流 |

---

## Renderer — 週期性

| ID | 間隔 | 位置 | 用途 | 重複問題 |
|---|---|---|---|---|
| `clockTimer` | 1s | app.js L355 | 時鐘 | — |
| `focusTimer` | 1s | app.js L165 | Focus 倒數 | — |
| `sheetsTimer` | **60s** | app.js L1642 | loadSheets | — |
| `sitesVisitsTimer` | **60s** | app.js L2022 | loadSitesVisits | — |

**已移除**（舊 backup）：`gchatPollTimer` 10s `loadGchat({ silent: true })` — 改由 Main scheduler 推送 `gchat-cache-changed`。

---

## Renderer — 防抖

| ID | 延遲 | 位置 | 用途 |
|---|---|---|---|
| `weatherSearchTimer` | 280ms | app.js L226 | 天氣搜尋 |
| `gchatSearchTimer` | 280ms | app.js L3084 | GChat 搜尋 |
| `GchatQuickSearch._timer` | SEARCH_DEBOUNCE_MS | gchat-quick-search.js L224 | 浮窗搜尋 |

---

## Satellite 視窗 Timer

| 位置 | 間隔 | 用途 | 重複問題 |
|---|---|---|---|
| `gchat-reply-pop` live refresh | **事件驅動** | `onGchatThreadPing` + Cache Push → `refreshLiveThreadCacheFirst` | ~~`livePollTimer` 30s 已移除~~ |
| Tracker script 字串 | 10s | 注入追蹤頁 `flushBeat` | 非 app 程序 |

---

## Timer 重疊矩陣（GChat 同一 thread）

| Timer | 做什麼 | 是否打同一 API |
|---|---|---|
| sync-scheduler 30s | inbox 未讀列表 | messages:search |
| viewingRefreshTimer 30s | 正在看 thread 更新 | messages.list (space) |
| syncRegistryReplyPopBadges 30s | minimized bar badge | messages.list (space) |
| livePollTimer 30s (Reply Pop) | open pop thread 更新 | gchat-thread-refresh / detail |
| scheduler onAfterSync ping | 若 viewing 存在再 ping | **可能與 viewingRefreshTimer 同 tick 雙重呼叫** |

**結論**：GChat 存在 **4 層 30s 輪詢**，對同一 space 可能並發 `messages.list`；quota 退避 `chatApiQuotaBlockedUntil` 為緩解但非根本解。

---

## Timer 生命週期圖

```text
App Start
├── sessionWatchTimer (60s) ──────────────── app lifetime
├── updateCheckTimer (~1h) ───────────────── app lifetime
├── syncTimer (60s) ──────────────────────── login → logout
├── meetingTimer (30s) ───────────────────── login → logout
└── GChat scheduler (30s) ────────────────── chat auth → logout
      └── onAfterSync → bar badges + viewing ping + toast

gchat-set-viewing
└── viewingRefreshTimer (30s) ────────────── viewing set → clear

open reply pop
└── livePollTimer (30s) ──────────────────── pop open → close

mosaic mount sheets/sites
├── sheetsTimer (60s) ──────────────────── tile mounted
└── sitesVisitsTimer (60s) ───────────────── tile mounted
```

---

## 舊版 vs 現版

| 項目 | .refactor-backup | 現版 |
|---|---|---|
| GChat Main alert | `mainGchatAlertTimer` 10s | 併入 scheduler 30s |
| GChat Renderer poll | `gchatPollTimer` 10s | **已移除**，靠 push |
| Gmail sync | 30s | **60s** |
