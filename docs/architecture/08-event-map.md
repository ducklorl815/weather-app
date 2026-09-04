# Event Map

> **[差量]** Cache Push 只留 `gchat-cache-changed`；見 [`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)。

## DOM / UI 事件（Renderer）

| 事件 | 發出位置 | 接收 / Handler | 用途 | 生命週期 |
|---|---|---|---|---|
| `window.onload` | Browser | app.js L23 | 啟動、checkLogin | 一次 |
| `window online` | Browser | app.js | session 重連 | 持久 |
| `document click` | User | app.js | 關閉 dropdown、mosaic 外部點擊 | 持久 |
| `document pointermove/up` | User | app.js | mosaic 拖曳 | drag 期間 |
| `document keydown` | User | app.js | gchat 快捷鍵、bug panel | 持久 |
| `onclick` (HTML attr) | index.html | app.js 全域函式 | 40+ 處橋接 | 持久 |
| Partial view onclick | features/*/view.html | app.js | addTask, gchat search 等 | tile mounted |

---

## IPC 推送事件（Main → Renderer）

| 事件 | 發出 Function | 訂閱 (preload) | 接收方 | 用途 |
|---|---|---|---|---|
| `session-status` | `broadcastSessionStatus` | `onSessionStatus` | app.js | 登入狀態 |
| `gmail-packet` | Gmail sync | `onGmailPacket` | app.js | 郵件列表更新 |
| `gchat-cache-changed` | `emitGchatCacheChanged` | `onGchatCacheChanged` | app.js, reply-pop | Cache Push（inbox + pop） |
| ~~`gchat-list-updated`~~ | — | preload no-op | — | **已停發** |
| `gchat-thread-ping` | `pingViewingGchatThread`, badge sync | `onGchatThreadPing` | app.js, reply-pop | thread 新訊息 |
| `gchat-bar-update` | `syncReplyBarUi` | `onGchatBarUpdate` | reply-bar.html | bar badge |
| `gchat-toast-push` | `showFloatingGchatToast` | `onGchatToastPush` | toast.html | 新 toast |
| `gchat-toast-dismiss` | toast dismiss | `onGchatToastDismiss` | toast.html | 關 toast |
| `gchat-compact-load` | open reply pop | `onGchatCompactLoad` | reply-pop | 載入訊息 |
| `gchat-compact-mode` | minimize/restore | `onGchatCompactMode` | reply-pop | 視窗模式 |
| `gchat-scroll-open` | scroll to message | `onGchatScrollOpen` | reply-pop | 捲動定位 |
| `gchat-quick-search-open` | shortcut | `onGchatQuickSearchOpen` | quick-search | 開浮窗 |
| `gchat-open-message` | toast → main | `onGchatOpenMessage` | app.js | 開主視窗訊息 |
| `app-theme` | `broadcastAppTheme` | `onAppTheme` | 所有子視窗 | 主題同步 |
| `app-font-scale` | `broadcastAppFontScale` | `onAppFontScale` | 所有子視窗 | 字級同步 |
| `app-update-status` | updater | `onAppUpdateStatus` | app.js | 更新 UI |
| `feature-sync-tick` | `syncAuthorizedFeatures` | `onFeatureSyncTick` | app.js | 授權進度 |
| `features-synced` | sync complete | `onFeaturesSynced` | app.js | 授權完成 |

---

## Electron App 生命週期事件

| 事件 | Handler | 用途 |
|---|---|---|
| `app.whenReady` | createWindow, timers | 啟動 |
| `app.on('window-all-closed')` | tray/quit 邏輯 | 關閉行為 |
| `app.on('activate')` | 恢復視窗 | macOS（有限） |
| `win.on('close')` | closeToTray hide | 托盤 |
| `autoUpdater` events | updateState | 更新狀態 |

---

## BrowserWindow 事件（子視窗）

| 視窗 | 事件 | 用途 |
|---|---|---|
| replyPopRegistry | `move`, `resize` | bounds 持久化 |
| toastWin | `blur`, `ready-to-show` | 定位/顯示 |
| gchatQuickSearchWin | `blur` | 自動 hide |
| Tray | `double-click`, `click` | 顯示主視窗 |

---

## 內部 Event-like 模式（無 EventEmitter）

Legacy code 以 **直接函式呼叫 + webContents.send** 代替 Event Bus：

| 模式 | 範例 |
|---|---|
| Cache 變更通知 | `emitGchatCacheChanged()` → send |
| 主題廣播 | `broadcastAppTheme()` → 遍歷子視窗 send |
| Session 廣播 | `broadcastSessionStatus()` |
| Feature sync | `feature-sync-tick` / `features-synced` |

**無集中 EventBus**；未來可抽 `shared/events`。

---

## Behavior Flow — 收到新 GChat 訊息

```text
[Main] sync-scheduler tick
  → syncInboxFromServer → 新訊息 merge 入 gchatCache.messages
  → notifyNewGchatAlerts()
      → showFloatingGchatToast() → gchat-toast-push
  → emitGchatCacheChanged() → gchat-cache-changed
  → syncRegistryReplyPopBadges() → gchat-bar-update (若 bar 存在)

[Renderer] onGchatCacheChanged
  → loadGchat({ silent: true }) 或局部重繪
  → 更新 inbox badge

[Toast Window] onGchatToastPush
  → 渲染 toast card
  → 使用者點擊 → gchatToastOpen → open reply pop
```

---

## Behavior Flow — 設定變更（主題）

```text
toggleTheme() → window.api.setAppTheme(theme)
  → saveAppTheme() + broadcastAppTheme()
  → win + replyPop + bar + toast + quickSearch 各 send 'app-theme'
  → 各視窗 CSS data-theme 更新
```

---

## Behavior Flow — App Update

```text
updateCheckTimer / 手動 check
  → checkForAppUpdates()
  → autoUpdater.checkForUpdates()
  → event → broadcastUpdateStatus()
  → app-update-status → app.js 更新 UI
  → download → install → quitAndInstall
```
