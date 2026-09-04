# modules/gchat

## 說明
Google Chat 同步、快取、API 與 IPC。

## 目錄

```text
gchat/
  chat-api-service.js   # Phase 2A — Google API
  search-service.js     # Phase 4A — 聯絡人／空間搜尋
  message-transform-service.js  # Phase 4B — 訊息正規化／顯示強化
  detail-pack-service.js      # Phase 4C — 對話打包／開啟空間
  read-mark-service.js        # Phase 4D — 已讀標記／Server 同步
  cache-repository.js   # Phase 2B — inbox
  packet-repository.js
  poll-coordinator.js   # Phase 2C
  sync-service.js / sync-scheduler.js / read-sync.js / detail-cache.js
  ipc/                  # Phase 3A+ — ipcMain handlers（薄 wiring）
    index.js            # registerGchatIpc()
    handlers/
      prefs.js          # gchat-get-prefs / gchat-save-prefs
      inbox.js          # gchat-status / list / refresh
      detail.js         # gchat-detail / thread-refresh
      messaging.js      # gchat-reply / react / mark-read
      search.js         # gchat-search / open-space / pin / emoji / quick-search
      ui.js             # toast / compact / bar / viewing / setup links
```

## IPC 註冊

`runtime.js` 呼叫：

```javascript
registerGchatIpc(ipcMain, createGchatIpcDeps());
```

業務邏輯仍多在 `runtime.js`；Phase 4 逐步迁入 `services/`（4A–4D 已完成）。
