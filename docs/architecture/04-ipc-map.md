# IPC Map

> 全部 handler 在 `main/runtime.js`（除非註明）。Renderer 一律經 `preload.js` → `window.api`。  
> **[差量]** Little Reply push：只保留 `gchat-cache-changed`（[`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)）。

---

## IPC 架構

```text
Channel
  ↓ Renderer Caller (window.api.xxx)
  ↓ preload.js (ipcRenderer.invoke/send)
  ↓ Main Handler (ipcMain.handle/on)
  ↓ Function
  ↓ API / Cache / webContents.send
```

---

## Framework / 視窗

| Channel | preload API | Main Handler | 下游 |
|---|---|---|---|
| `load-feature-partial` | `loadFeaturePartial` | inline L2771 | 讀 `renderer/features/*/view.html` |
| `window-minimize` | `windowMinimize` | inline L2823 | `win.minimize()` |
| `window-show` | `windowShow` | inline L2829 | `win.show()` |
| `app-quit` | `appQuit` | inline L2837 | 關子視窗 + quit |
| `get-app-theme` | `getAppTheme` | L2951 | `loadAppTheme` |
| `set-app-theme` | `setAppTheme` | L2956 | `saveAppTheme` + broadcast |
| `get-app-font-scale` | `getAppFontScale` | L2962 | `loadAppFontScale` |
| `set-app-font-scale` | `setAppFontScale` | L2967 | `saveAppFontScale` + broadcast |
| `get-open-at-login` | `getOpenAtLogin` | L3882 | Registry 讀取 |
| `set-open-at-login` | `setOpenAtLogin` | L3890 | Registry 寫入 |
| `get-app-mode` | `getAppMode` | L5727 | dev/dist |
| `get-dist-features` | `getDistFeatures` | L5733 | `dist-features.json` |
| `set-dist-feature` | `setDistFeature` | L5755 | 寫入 dist features |
| `get-cursor-point` | `getCursorPoint` | L12647 | `screen.getCursorScreenPoint()` |
| `open-url` | `openExternal` (send) | on L3808 | `shell.openExternal` |
| `open-internal-url` | — (send) | on L3809 | 子 BrowserWindow |
| `logout` | `logout` (send) | on L3900 | clearPacket + stop timers |

---

## GChat UI / Overlay

| Channel | preload API | Main Function |
|---|---|---|
| `gchat-show-toast` | `gchatShowToast` | `showFloatingGchatToast` |
| `gchat-toast-hide/resize/open` | `gchatToastHide/Resize/Open` | toast 視窗控制 |
| `gchat-compact-open/close/minimize/restore` | `gchatCompactOpen/Close/...` | `openCompactGchatReply` 等 |
| `gchat-compact-toggle-fullscreen` | `gchatCompactToggleFullscreen` | 全螢幕切換 |
| `gchat-compact-set-title` | `gchatCompactSetTitle` | 標題更新 |
| `gchat-compact-open-main` | `gchatCompactOpenMain` | 開主視窗對應訊息 |
| `gchat-bar-click/close/state` | `gchatBarClick/Close/State` | Reply Bar |
| `gchat-set-viewing` | `gchatSetViewing` | `gchatViewing` + viewing watch |
| `gchat-alert-watch` | `gchatAlertWatch` | Toast 設定 + **startGchatSyncScheduler** |
| `gchat-quick-search-show/hide/arm` | `gchatQuickSearchShow/Hide/Arm` | Quick Search 視窗 |
| `gchat-get-prefs/save-prefs` | `gchatGetPrefs/SavePrefs` | `load/saveGchatPrefs` |

---

## Authorization

| Channel | preload API | Main Function |
|---|---|---|
| `check-login` | `checkLogin` | `ensureGoogleSession` |
| `ensure-session` | `ensureSession` | `ensureGoogleSession` |
| `auth-google` | `authGoogle` | `runGoogleOAuth(GOOGLE_SCOPES)` |
| `auth-google-feature` | `authGoogleFeature` | `runFeatureOAuth` |
| `auth-google-features` | `authGoogleFeatures` | `runFeaturesOAuth` |
| `feature-auth-status` | `featureAuthStatus` | `getFeatureAuthStatus` |
| `auth-google-sheets` | `authGoogleSheets` | Sheets OAuth |
| `auth-google-chat` | `authGoogleChat` | Chat OAuth |

---

## GChat 資料

| Channel | preload API | Main Function | API/Cache |
|---|---|---|---|
| `gchat-list` | `gchatList` | `gchatSnapshot()` | gchatCache |
| `gchat-refresh` | `gchatRefresh` | `prefetchGchatTodayCache` | searchUnread + cache-repository |
| `gchat-detail` | `gchatDetail` | `loadConversationHistory` | detail-cache, packets |
| `gchat-reply` | `gchatReply` | create message | Chat API create |
| `gchat-react` | `gchatReact` | reaction | Chat API |
| `gchat-mark-read` | `gchatMarkRead` | `markGchatConversationReadByName` | read-sync |
| `gchat-thread-refresh` | `gchatThreadRefresh` | `buildThreadRefreshFromCache` | detail-cache |
| `gchat-search` | `gchatSearch` | 搜尋 | Chat search API |
| `gchat-open-space` | `gchatOpenSpace` | 開空間 | listSpaceMessages |
| `gchat-pin-toggle` | `gchatPinToggle` | 釘選 | gchatCache + prefs |
| `gchat-custom-emojis` | `gchatCustomEmojis` | emoji registry | custom emoji cache |
| `gchat-status` | `gchatStatus` | 授權/同步狀態 | — |

---

## Gmail / Calendar / Tasks

| Channel | preload API | Main |
|---|---|---|
| `get-gmail` | `getGmail` | `packetSnapshot` |
| `get-gmail-detail` | `getGmailDetail` | `fetchMessageDetail` |
| `reply-gmail` | `replyGmail` | pending queue |
| `mark-gmail-read` | `markGmailRead` | pending + sync |
| `get-contacts` | `getContacts` | `cache.contacts` |
| `get-calendar` | `getCalendar` | Calendar API |
| `calendar:createEvent` | `createCalendarEvent` | Calendar insert |
| `get-tasks/add-task/update-task` | `getTasks/addTask/updateTask` | Tasks API |

---

## 其他 Feature IPC

完整列表見 `preload.js` L7–223。主要群組：
- **Weather**: `fetch-weather`
- **Sheets**: `sheets-*`（12 通道）
- **Sites**: `sites-visits-*`（18 通道）
- **Bug**: `bug-report-*`（7 通道）
- **AI**: `gemini-*`, `knowledge-*`, `chat-ask`, `report-*`
- **Update**: `app-get-version`, `app-check-update`, `app-download-update`, `app-install-update`

---

## Main → Renderer 推送（非 ipcMain）

| 事件 | preload 訂閱 | 發送位置 |
|---|---|---|
| `session-status` | `onSessionStatus` | `broadcastSessionStatus` |
| `gmail-packet` | `onGmailPacket` | Gmail sync |
| `gchat-cache-changed` | `onGchatCacheChanged` | `emitGchatCacheChanged` |
| `gchat-cache-changed` | `onGchatCacheChanged` | Cache Push（inbox + pop） |
| ~~`gchat-list-updated`~~ | preload no-op | **已停發** |
| `gchat-thread-ping` | `onGchatThreadPing` | viewing ping / badge sync |
| `gchat-bar-update` | `onGchatBarUpdate` | Reply Bar badge |
| `gchat-toast-push/dismiss` | `onGchatToastPush/Dismiss` | Toast |
| `gchat-compact-load/mode/scroll-open` | 各 onXxx | Reply Pop |
| `gchat-quick-search-open` | `onGchatQuickSearchOpen` | 快捷鍵 |
| `gchat-open-message` | `onGchatOpenMessage` | 從 toast 開主視窗 |
| `app-theme/font-scale` | `onAppTheme/onAppFontScale` | 主題廣播 |
| `app-update-status` | `onAppUpdateStatus` | updater |
| `feature-sync-tick/features-synced` | 各 onXxx | feature auth |

---

## 典型 Behavior Flow

### 使用者點擊 GChat 訊息

```text
app.js click handler
  → window.api.gchatCompactOpen({ messageName, ... })
  → ipcMain 'gchat-compact-open'
  → openCompactGchatReply()
  → BrowserWindow load gchat-reply-pop.html
  → webContents.send('gchat-compact-load', messageName)
  → Reply Pop: window.api.gchatDetail(messageName)
  → ipcMain 'gchat-detail'
  → loadConversationHistory() [cache-first via detail-cache]
  → Chat API (若 cache miss)
  → 渲染 thread
  → window.api.gchatSetViewing({ spaceName, threadName })
  → startViewingRefreshWatch() + pingViewingGchatThread
```

### 30 秒 GChat 背景同步

```text
sync-scheduler tick (30s)
  → sync-service.syncUnreadInbox()
      → readSync.flushPending()
      → cacheRepository.syncInboxFromServer()
          → searchUnreadChatMessages() [Chat API]
          → merge inbox → gchatCache.messages
  → onAfterSync:
      → syncRegistryReplyPopBadges() [Reply Bar API]
      → pingViewingGchatThread() [若 viewing]
      → notifyNewGchatAlerts() [Toast]
  → emitGchatCacheChanged()
  → webContents.send('gchat-cache-changed')
  → app.js onGchatCacheChanged → 重繪列表
```

### 使用者登入

```text
loginGoogle() → window.api.authGoogle()
  → runGoogleOAuth()
  → save token → init google services
  → syncAuthorizedFeatures()
  → broadcastSessionStatus({ loggedIn: true })
  → prefetchGchatTodayCache()
  → startGchatSyncScheduler()
  → app.js showWorkspace()
```

### 標記 GChat 已讀

```text
Reply Pop / app.js → window.api.gchatMarkRead({ messageName })
  → markGchatConversationReadByName()
  → readSync.markReadLocal() [立即更新 gchatCache]
  → readSync.tryFlushMessage() → markChatMessageReadRemote() [Chat API]
  → emitGchatCacheChanged()
  → UI 更新 badge
```
