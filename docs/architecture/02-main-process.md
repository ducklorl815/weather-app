# Main Process 地圖

> **[差量]** Little Reply：[`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)、[`../little-reply/behavior-catalog.md`](../little-reply/behavior-catalog.md)。

## 啟動鏈

```text
main.js
  require('./main/runtime')
    app.whenReady → createWindow()
    ensureTray()
    loadDiskPacket() / loadGchatDisk()
    ensureGoogleSession({ silent: true })
    startSyncLoop()          // Gmail 60s
    startMeetingWatch()      // 30s
    startSessionWatch()      // 60s
    scheduleUpdateCheck()    // ~1h
```

Session 登入成功後額外：
```text
syncAuthorizedFeatures()
  → bootstrap GChat (prefetchGchatTodayCache)
  → startGchatSyncScheduler()  // 30s
```

---

## runtime.js 【MODULE】區段（實際行號）

| 行號 | MODULE 標記 | 職責 |
|---|---|---|
| L1–76 | Bootstrap | Electron import、APP_ROOT、GChat 模組 require、gchat-emoji protocol |
| L77–111 | authorization/config | OAuth 常數、Google Console URL |
| L112–1108 | modules/gchat-ui | Reply Pop bounds/prefs、主題/字級、Quick Search 視窗 |
| L1109–2763 | framework/tray + gchat-ui | Tray、Reply Pop 註冊表/Bar/Toast、BrowserWindow 子視窗 |
| L2764–3912 | framework/window + partial-views | 主視窗、視窗 IPC、viewing watch、開機啟動 |
| L3913–4122 | modules/weather | 天氣 proxy fetch |
| L4123–5462 | authorization | Session/OAuth IPC、Sheets helper、Google 服務初始化 |
| L5463–5924 | modules/bug-report | Bug 回報 |
| L5925–7497 | modules/sites-visits | Sites 瀏覽紀錄 IPC |
| L7498–7618 | modules/tasks | Google Tasks |
| L7619–8110 | modules/calendar | Calendar + 會議提醒 |
| L8111–11531 | modules/gmail + GChat 核心 | Gmail sync + GChat API/快取/同步（最大區塊） |
| L11532–13418 | modules/gchat IPC | GChat 資料 IPC handlers |
| L13419–13959 | modules/ai-chat | Gemini、知識庫、報表 |
| L13960–14202 | framework/updater | electron-updater |

---

## 已拆模組

### main/modules/gchat/

| 檔案 | 職責 | runtime 接點 |
|---|---|---|
| `sync-scheduler.js` | 唯一 30s inbox 背景定時器 | `ensureGchatSyncStack().scheduler` |
| `sync-service.js` | mutex inbox sync | `syncUnreadInbox()` |
| `cache-repository.js` | inbox cache **唯一寫入入口** | `syncInboxFromServer()` |
| `read-sync.js` | 本機已讀佇列 flush | `markGchatConversationReadByName` |
| `detail-cache.js` | cache-first detail/thread | `gchat-detail` IPC |
| `sync-log.js` | 開發日誌 | — |
| `chat-api-service.js` | Google Chat API | **已接入**（Phase 2A；呼叫多經 runtime deps） |

### main/modules/sites-visits/

| 檔案 | 職責 |
|---|---|
| `enrich.js` | ERP MSSQL、Excel 匯出、組織樹 HTML |

---

## 關鍵 Main 函式群（依功能）

### 視窗 / Tray
- `createWindow()`、`ensureTray()`
- `openCompactGchatReply()`、`showFloatingGchatToast()`
- `replyPopRegistry`、`ensureReplyBarWindow()`

### Authorization
- `ensureGoogleSession()`、`runGoogleOAuth()`
- `syncAuthorizedFeatures()`、`broadcastSessionStatus()`
- `startSessionWatch()` / `stopSessionWatch()`

### Gmail
- `runSync()`、`refreshGmailList()`、`packetSnapshot()`
- `loadDiskPacket()` / `saveDiskPacket()`

### GChat 核心（仍在 runtime）
- `searchUnreadChatMessages()` — 未讀搜尋 API
- `prefetchGchatTodayCache()` / `refreshGchatList()`
- `loadConversationHistory()`、`normalizeChatMessage()`
- `markGchatConversationReadByName()` → read-sync
- `emitGchatCacheChanged()`、`notifyNewGchatAlerts()`
- `syncRegistryReplyPopBadges()`、`pingViewingGchatThread()`

### GChat 模組組裝
- `ensureGchatSyncStack()` L10833 — 組裝 scheduler + syncService + cacheRepository + readSync
- `startGchatSyncScheduler()` L3767

---

## Main → Renderer 推送

| 事件 | 觸發時機 |
|---|---|
| `session-status` | 登入/登出/離線 |
| `gmail-packet` | Gmail sync 完成 |
| `gchat-cache-changed` | GChat cache 更新 |
| `gchat-cache-changed` | Cache Push（Inbox + Reply Pop；取代舊 `gchat-list-updated`） |
| `gchat-thread-ping` | 正在查看的 thread 有新訊息 |
| `gchat-bar-update` | Reply Bar badge 更新 |
| `gchat-toast-push/dismiss` | Toast 顯示/關閉 |
| `app-theme` / `app-font-scale` | 主題/字級變更 |
| `app-update-status` | 更新狀態 |
| `feature-sync-tick` / `features-synced` | Feature 授權同步 |

---

## 磁碟持久化（userData）

| 檔案 | Owner |
|---|---|
| `google_token.json` | Authorization |
| `gmail_packet.json` | Gmail cache + pending |
| `gchat_packet.json` | GChat messages + packets |
| `gchat-prefs.json` | GChat 偏好 |
| `gchat-reply-bounds.json` | Reply Pop 位置 |
| `gchat_custom_emojis.json` | Custom emoji registry |
| `app-theme.json` | 主題 |
| `sheets.json` / `sheets-state.json` | 9527 |
| `sites-visits.json` / `sites-visits-store.json` | Sites |
| `gemini.json` | AI 設定 |
| `knowledge/index.json` | 知識庫 |
| `report-schema.json` | 報表 schema |

專案根目錄：`dist-features.json`（正式包功能開關）
