# Code Segment Map

> **拆碼基礎文件**。Segment 依 Function / State / IPC / Data Flow 劃分，**非行號機械切分**。  
> 行號為掃描基準，後續 refactor 可能漂移，請以【MODULE】標記 + 函式名定位。  
> **[差量]** Reply Pop／timer／event 現行：[`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)。

---

## main/runtime.js（14,202 行）

### SEG-M-001 Bootstrap & Protocol

| 項目 | 內容 |
|---|---|
| **Reference** | L1–76 |
| **Purpose** | Electron imports、APP_ROOT、GChat 模組 require、gchat-emoji custom protocol、UTF-8 |
| **Functions** | protocol registration, lazy googleapis |
| **State** | APP_ROOT, oauth2Client (later) |
| **Dependencies** | Node fs/path, electron |
| **Used By** | 全檔 |

---

### SEG-M-002 Authorization Config

| 項目 | 內容 |
|---|---|
| **Reference** | L77–111 |
| **Purpose** | OAuth client id/secret、scope 常數、userData path helpers |
| **State** | GOOGLE_SCOPES, FEATURE_SCOPES |
| **Used By** | SEG-M-009 Authorization |

---

### SEG-M-003 GChat UI — Prefs & Theme Broadcast

| 項目 | 內容 |
|---|---|
| **Reference** | L112–326 |
| **Purpose** | Reply pop bounds、prefs 讀寫、主題/字級廣播至子視窗 |
| **Functions** | `loadGchatPrefs`, `saveGchatPrefs`, `loadReplyPopBoundsStore`, `broadcastAppTheme`, `broadcastAppFontScale` |
| **Storage** | gchat-prefs.json, gchat-reply-bounds.json, app-theme.json |
| **IPC** | get/set-app-theme, get/set-app-font-scale, gchat-get/save-prefs |
| **Used By** | 所有 GChat 子視窗 |

---

### SEG-M-004 GChat UI — Quick Search Window

| 項目 | 內容 |
|---|---|
| **Reference** | L327–590 |
| **Purpose** | 全域 Ctrl+F 浮窗 BrowserWindow |
| **Functions** | `ensureGchatQuickSearchWindow`, `syncGchatQuickSearchShortcut`, `broadcastGchatQuickSearchOpen` |
| **IPC** | gchat-quick-search-show/hide/arm |
| **Dependencies** | SEG-M-003 theme broadcast |

---

### SEG-M-005 GChat UI — Reply Pop Registry & Bar

| 項目 | 內容 |
|---|---|
| **Reference** | L591–1108 |
| **Purpose** | 回覆泡泡視窗生命週期、最小化 bar、registry 管理 |
| **Functions** | `openCompactGchatReply`, `toggleReplyPopFromBar`, `ensureReplyBarWindow`, `syncReplyBarUi`, `positionMinimizedReplyBars` |
| **State** | `replyPopRegistry`, `replyPopBoundsStore` |
| **IPC** | gchat-compact-*, gchat-bar-* |
| **Behavior** | 開啟/關閉/最小化/還原 reply pop；bar badge 同步 |
| **Used By** | Toast 開啟、主面板點擊、Quick Search |

---

### SEG-M-006 Framework — Tray

| 項目 | 內容 |
|---|---|
| **Reference** | L1109–1343 |
| **Purpose** | 系統匣圖示、右鍵選單、雙擊顯示 |
| **Functions** | `ensureTray` |
| **Dependencies** | win, icon.png |

---

### SEG-M-007 GChat UI — Toast & Focus Bar

| 項目 | 內容 |
|---|---|
| **Reference** | L1344–2244 |
| **Purpose** | 浮動 Toast 視窗、Focus bar entry、toast 去重 |
| **Functions** | `ensureToastWindow`, `showFloatingGchatToast`, `ensureFocusBarEntry`, `notifyNewGchatAlerts` |
| **State** | `mainGchatAlerted`, `mainGchatAlertedAt`, toastWin |
| **IPC** | gchat-show-toast, gchat-toast-* |
| **Dependencies** | SEG-M-005 registry, gchatCache.messages |
| **Behavior** | 新訊息 → toast push；點擊 → 開 reply pop |

---

### SEG-M-008 GChat UI — Reply Pop Open/Scroll/Animation

| 項目 | 內容 |
|---|---|
| **Reference** | L2245–2763 |
| **Purpose** | 開啟 pop 時 scroll payload、動畫、Z-order |
| **Functions** | `buildReplyPopScrollOpenPayload`, `syncGchatOverlayZOrder`, `refreshFocusEntryTitle` |
| **Event** | gchat-scroll-open, gchat-compact-load |
| **Type** | 類型 D（Legacy UI 累積 + 動畫細節） |

---

### SEG-M-009 Framework — Main Window & Partial Views

| 項目 | 內容 |
|---|---|
| **Reference** | L2764–2822, L2771 |
| **Purpose** | 主 BrowserWindow、Partial HTML 讀取 IPC |
| **Functions** | `createWindow`, load index.html |
| **IPC** | load-feature-partial, window-minimize/show, app-quit |

---

### SEG-M-010 GChat — Viewing Watch & Sync Scheduler Bridge

| 項目 | 內容 |
|---|---|
| **Reference** | L3092–3806 |
| **Purpose** | 正在查看 thread 的 30s ping；Background sync scheduler 啟動；alert watch IPC |
| **Functions** | `startViewingRefreshWatch`, `stopViewingRefreshWatch`, `pingViewingGchatThread`, `startGchatSyncScheduler`, `syncRegistryReplyPopBadges`, `ensureGchatSyncStack` (partial) |
| **State** | `gchatViewing`, `viewingRefreshTimer` |
| **IPC** | gchat-set-viewing, gchat-alert-watch |
| **Dependencies** | modules/gchat/sync-scheduler, sync-service, cache-repository |
| **Behavior** | 30s 多路 poll + badge + toast 觸發鏈 |
| **Type** | 類型 C（一區做 API + cache + UI + notification） |

---

### SEG-M-011 Framework — Open at Login & External URL

| 項目 | 內容 |
|---|---|
| **Reference** | L3807–3912 |
| **Purpose** | 開機啟動 Registry、open-url、logout |
| **IPC** | get/set-open-at-login, open-url, open-internal-url, logout |

---

### SEG-M-012 Weather Proxy

| 項目 | 內容 |
|---|---|
| **Reference** | L3913–4122 |
| **Purpose** | CORS bypass fetch |
| **IPC** | fetch-weather |
| **Dependencies** | 無 |

---

### SEG-M-013 Authorization — Session & OAuth

| 項目 | 內容 |
|---|---|
| **Reference** | L4123–5462 |
| **Purpose** | 登入、token 刷新、feature OAuth、Google service 初始化、session watch |
| **Functions** | `ensureGoogleSession`, `runGoogleOAuth`, `syncAuthorizedFeatures`, `startSessionWatch`, `initGoogleServices` |
| **Storage** | google_token.json |
| **IPC** | check-login, ensure-session, auth-google* |
| **Event** | session-status, feature-sync-tick, features-synced |
| **Used By** | 所有 Google features |

---

### SEG-M-014 Bug Report

| 項目 | 內容 |
|---|---|
| **Reference** | L5463–5924 |
| **IPC** | bug-report-* |
| **API** | Sheets append, Drive upload |

---

### SEG-M-015 Sites Visits

| 項目 | 內容 |
|---|---|
| **Reference** | L5925–7497 |
| **Purpose** | 追蹤設定、事件記錄、報表、組織樹 IPC |
| **Functions** | load/saveSitesVisitsConfig, syncSitesVisitsIntoApp, tracker script 產生 |
| **Dependencies** | modules/sites-visits/enrich.js |
| **IPC** | sites-visits-* (18) |

---

### SEG-M-016 Tasks

| 項目 | 內容 |
|---|---|
| **Reference** | L7498–7618 |
| **IPC** | get-tasks, add-task, update-task |

---

### SEG-M-017 Calendar & Meeting Reminder

| 項目 | 內容 |
|---|---|
| **Reference** | L7619–8110 |
| **Functions** | `checkMeetingReminders`, `startMeetingWatch` |
| **Timer** | meetingTimer 30s |
| **IPC** | get-calendar, calendar:createEvent |

---

### SEG-M-018 Gmail Sync & Packet

| 項目 | 內容 |
|---|---|
| **Reference** | L8111–8206 |
| **Purpose** | Gmail 背景同步、pending queue、disk packet |
| **Functions** | `runSync`, `refreshGmailList`, `loadDiskPacket`, `saveDiskPacket`, `packetSnapshot` |
| **State** | cache, pending |
| **Timer** | syncTimer 60s |
| **Event** | gmail-packet |
| **IPC** | get-gmail, get-gmail-detail, reply-gmail, mark-gmail-read |

---

### SEG-M-019 GChat — Disk Cache & Bootstrap

| 項目 | 內容 |
|---|---|
| **Reference** | L8207–8855 |
| **Purpose** | gchat 磁碟讀寫、packet 結構、bootstrap |
| **Functions** | `loadGchatDisk`, `saveGchatDisk`, `loadGchatPacketsFromDisk` |
| **State** | gchatCache |
| **Storage** | gchat_packet.json |

---

### SEG-M-020 GChat — Custom Emoji

| 項目 | 內容 |
|---|---|
| **Reference** | L8856–9376 |
| **Functions** | `refreshCustomEmojiCache`, `ensureCustomEmojiMaps`, download queue |
| **Storage** | gchat_custom_emojis.json, images/ |

---

### SEG-M-021 GChat — API Helpers & Normalization

| 項目 | 內容 |
|---|---|
| **Reference** | L9377–10321 |
| **Purpose** | Chat API 封裝、quota 退避、message normalize、space meta |
| **Functions** | `searchUnreadChatMessages`, `normalizeChatMessage`, `ensureSpaceMeta`, `withTransientRetry`, `markChatApiQuotaBlocked` |
| **Type** | 類型 A（複雜資料轉換，合理偏長） |

---

### SEG-M-022 GChat — Read Mark & Local Read

| 項目 | 內容 |
|---|---|
| **Reference** | L10322–10828 |
| **Purpose** | 標已讀 remote/local、prefetch inbox |
| **Functions** | `markGchatConversationReadByName`, `prefetchGchatTodayCache`, `refreshGchatList`, `queueGchatMarkRead` |
| **Dependencies** | read-sync.js, cache-repository.js |
| **Behavior** | prefetch → syncInboxFromServer **或** fallback searchUnread |

---

### SEG-M-023 GChat — Sync Stack Assembly

| 項目 | 內容 |
|---|---|
| **Reference** | L10829–10880 |
| **Purpose** | 組裝 scheduler + syncService + cacheRepository + readSync |
| **Functions** | `ensureGchatSyncStack`, `refreshGchatList` |
| **Dependencies** | main/modules/gchat/* |
| **Used By** | SEG-M-010 scheduler |

---

### SEG-M-024 GChat — Conversation Load & Reply Core

| 項目 | 內容 |
|---|---|
| **Reference** | L10881–11531 |
| **Purpose** | listSpaceMessages, loadConversationHistory, media hydrate, reply 核心邏輯 |
| **Functions** | `listSpaceMessages`, `listThreadMessages`, `loadConversationHistory`, `ensureThreadMediaHydrated` |
| **Cache** | gchatCache.packets |
| **Type** | 類型 C+D（API+cache+media 混合，Legacy 累積） |

---

### SEG-M-025 GChat — Data IPC Handlers

| 項目 | 內容 |
|---|---|
| **Reference** | L11532–13418 |
| **Purpose** | 所有 gchat-* 資料 IPC handler 集中區 |
| **IPC** | gchat-list/refresh/detail/reply/react/mark-read/search/open-space/pin/custom-emojis/thread-refresh |
| **Dependencies** | SEG-M-021~024, detail-cache.js |
| **Note** | `refreshGchatList()` 實際只做 prefetchGchatTodayCache — 名稱與行為不完全一致 |

---

### SEG-M-026 AI Chat & Report

| 項目 | 內容 |
|---|---|
| **Reference** | L13419–13959 |
| **IPC** | chat-ask, gemini-*, knowledge-*, report-* |
| **API** | Gemini, MSSQL, Discovery Engine |

---

### SEG-M-027 Updater

| 項目 | 內容 |
|---|---|
| **Reference** | L13960–14202 |
| **Functions** | `checkForAppUpdates`, `scheduleUpdateCheck`, autoUpdater wiring |
| **Timer** | updateCheckTimer ~1h |
| **IPC** | app-get-version, app-check-update, app-download-update, app-install-update |

---

## renderer/shell/app.js（5,428 行）

### SEG-R-001 Boot / Session

| Reference | L23–347 |
| Functions | window.onload, recoverSessionNow, sessionOffline handling |
| IPC | checkLogin, ensureSession, onSessionStatus |

### SEG-R-002 Weather / Focus

| Reference | L348–372 |
| Functions | initWeatherAndClock, toggleFocusTimer |
| Timer | clockTimer 1s, focusTimer 1s |

### SEG-R-003 Bug Report

| Reference | L373–666 |

### SEG-R-004 Authorization UI

| Reference | L667–800 |
| Functions | loginGoogle, showWorkspace, authorizeGchat/Sheets |

### SEG-R-005 Mosaic Engine

| Reference | L803–1209 |
| State | mosaicItems, WIDGET_CATALOG, localStorage mosaic-layout-v1 |
| Functions | renderMosaic, addWidget, drag/resize |

### SEG-R-006 Tasks

| Reference | L1210–1417 |

### SEG-R-007 Calendar

| Reference | L1418–1627 |

### SEG-R-008 Sheets 9527

| Reference | L1628–1876 |
| Timer | sheetsTimer 60s |

### SEG-R-009 Sites Visits

| Reference | L1877–2173 |
| Timer | sitesVisitsTimer 60s |

### SEG-R-010 Gmail

| Reference | L2174–3325 |
| State | currentMailContext, replyRecipients |
| IPC | getGmail, getGmailDetail, replyGmail, onGmailPacket |

### SEG-R-011 GChat Main Panel

| Reference | L3326–4616 |
| **最大 Segment** |
| Functions | loadGchat, renderGchatList, openGchatDetail, gchat search, pin, lightbox |
| IPC | gchatList, gchatDetail, gchatMarkRead, onGchatCacheChanged, onGchatListUpdated |
| Type | 類型 C+D |

### SEG-R-012 Calendar Create Modal

| Reference | L4617–4771 |

### SEG-R-013 Settings

| Reference | L4772–5216 |
| Functions | theme, font scale, update UI, tray prefs |

### SEG-R-014 AI Chat

| Reference | L5217–5414 |

### SEG-R-015 Logout

| Reference | L5415–5428 |

---

## index.html（220 行 — Shell Segments）

### SEG-H-001 Head & Shell Meta

| Reference | L1–19 |

### SEG-H-002 Header Chrome

| Reference | L35–160 |
| Sub | 主題 L41–43, 設定 L45–132, 登出 L134, 天氣 L137–159 |

### SEG-H-003 Overlays

| Reference | L162–190 |
| Sub | toast stack, auth, modal, lightbox |

### SEG-H-004 Mosaic Dashboard

| Reference | L192–202 |

### SEG-H-005 Script Includes

| Reference | L205–217 |

---

## gchat-reply-pop.html（~3,266 行）

### SEG-P-001 Inline CSS / Theme

| Reference | L1–~800 |

### SEG-P-002 DOM & Template

| Reference | L800–~1200 |

### SEG-P-003 Message Render & Thread UI

| Reference | L1200–~2400 |
| Functions | render thread, quote highlight, emoji picker integration |

### SEG-P-004 IPC & API Calls

| Reference | L2000–~2900 |
| IPC | gchatDetail, gchatReply, gchatReact, gchatSetViewing, gchatThreadRefresh |

### SEG-P-005 Live Poll Loop

| Reference | L2900–~3100 |
| Timer | livePollTimer 30s |
| Functions | refreshLiveThreadCacheFirst |
| **重複** | 與 Main viewingRefreshTimer |

---

## 模組檔案 Segments（已拆出）

| Segment | File | Purpose |
|---|---|---|
| SEG-G-001 | sync-scheduler.js | 30s timer |
| SEG-G-002 | sync-service.js | mutex sync |
| SEG-G-003 | cache-repository.js | inbox 唯一寫入 |
| SEG-G-004 | read-sync.js | mark read flush |
| SEG-G-005 | detail-cache.js | cache-first read |
| SEG-G-006 | chat-api-service.js | stub 未用 |
| SEG-S-001 | sites-visits/enrich.js | ERP enrichment |
