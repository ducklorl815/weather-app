# API Map

> **[差量]** Little Reply 已無 Reply Pop／viewing 的 30s 獨立 list poll；見 [`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)。

## Google APIs（googleapis + oauth2Client）

| API | 主要 Function | Caller | 用途 | 頻率 | 重複 |
|---|---|---|---|---|---|
| Gmail v1 | `refreshGmailList`, `fetchMessageDetail` | `runSync` 60s, IPC get-gmail* | 郵件列表/詳情/回覆/已讀 | 60s + on-demand | — |
| Calendar v3 | `get-calendar` handler | meetingTimer 30s | 事件列表/建立 | 30s + on-demand | — |
| Tasks v1 | get/add/update-task | IPC on-demand | 待辦 CRUD | on-demand | — |
| People v1 | `refreshContacts` | Gmail sync | 通訊錄 | 隨 Gmail sync | — |
| Sheets v4 | `fetchSheetSource`, bug-report, sites | sheetsTimer 60s, IPC | 9527/Bug/Sites log | 60s + on-demand | 多 feature 共用 Sheets client |
| Drive v3 | bug-report-submit | IPC | 截圖上傳 | on-demand | — |
| Chat v1 | 見下方 Chat 專表 | 多處 | 訊息/空間/反應 | **高頻** | **多 caller 重複** |

---

## Google Chat API — 詳細 Caller 表

| API 操作 | Function | Caller | 用途 | 頻率 |
|---|---|---|---|---|
| `spaces.messages:search` | `searchUnreadChatMessages` | cache-repository.syncInboxFromServer, prefetchGchatTodayCache | 未讀 inbox | 30s + manual refresh |
| `spaces.messages.list` | `listSpaceMessages`, `listThreadMessages` | gchat-detail, gchat-open-space | thread/space 歷史 | on-demand |
| `spaces.messages.list` (pageSize 3/12) | `syncRegistryReplyPopBadges` | scheduler onAfterSync | Reply Bar badge | **30s × N bars** |
| `spaces.messages.list` | `pingViewingGchatThread` | viewingRefreshTimer 30s | 正在查看 thread 更新 | 30s |
| `spaces.messages.list` | `refreshLiveThreadCacheFirst` | gchat-reply-pop livePollTimer | Reply Pop live poll | **30s × N pops** |
| `spaces.messages.create` | gchat-reply handler | IPC | 發送訊息 | on-demand |
| `spaces.messages.reactions` | gchat-react handler | IPC | 表情反應 | on-demand |
| `spaces.messages:markRead` | `markChatMessageReadRemote` | read-sync flush | 標已讀 | flush 時 |
| `spaces:markRead` | `markGchatSpaceReadRemote` | read-sync | 空間已讀 | flush 時 |
| `customEmojis` REST | `refreshCustomEmojiCache` | bootstrap, IPC | 自訂 emoji | 低頻 |
| Chat HTTP search | `chatHttp` helpers | gchat-search | 全文搜尋 | on-demand |

### API 重複風險（Chat messages.list）

```text
spaces.messages.list
├── searchUnreadChatMessages     → inbox 30s（經 cache-repository）
├── syncRegistryReplyPopBadges   → 每個 minimized bar 30s
├── pingViewingGchatThread         → viewing 30s
├── refreshLiveThreadCacheFirst  → 每個 open reply pop 30s
├── listSpaceMessages            → open-space / detail miss
└── listThreadMessages           → detail load

→ 同一空間可能被 3–4 個 timer 同時 poll（inbox + bar + viewing + pop）
```

---

## HTTP fetch（非 googleapis）

| 端點 | Caller | 用途 | 頻率 |
|---|---|---|---|
| 任意 URL | `fetch-weather` IPC | 天氣 CORS proxy | on-demand |
| `oauth2.googleapis.com/tokeninfo` | scope 驗證 | auth | 登入時 |
| `oauth2.googleapis.com/v3/userinfo` | ensure session | email | session |
| `generativelanguage.googleapis.com/.../generateContent` | chat-ask | Gemini API Key | on-demand |
| `{location}-aiplatform.googleapis.com` | chat-ask | Gemini Enterprise | on-demand |
| `{location}-discoveryengine.googleapis.com` | chat-ask | Enterprise 檢索 | on-demand |
| `chat.googleapis.com/v1/customEmojis` | emoji download | 自訂 emoji 圖 | 低頻 |

---

## MSSQL（mssql）

| 用途 | Function | Caller | 頻率 |
|---|---|---|---|
| ERP 同仁 enrichment | `fetchEmployeesByEmails` | sites-visits-report IPC | on-demand |
| ERP 部門階層 | `fetchDeptHierarchy` | dept-org | on-demand |
| 報表 SQL | report-run handler | chat-ask / report IPC | on-demand |

模組：`main/modules/sites-visits/enrich.js`；連線池 `erpPool`。

---

## electron-updater

| 操作 | Function | 頻率 |
|---|---|---|
| checkForUpdates | `checkForAppUpdates` | 啟動延遲 + ~1h |
| downloadUpdate | IPC | 使用者觸發 |
| quitAndInstall | IPC | 使用者觸發 |

Feed：`https://storage.googleapis.com/lifetour-releases/`

---

## 外部 Web App

| 服務 | 用途 |
|---|---|
| Google Apps Script Web App | Sites 追蹤事件上報（config 設定 URL） |
| 注入 tracker script | `sites-visits-tracker-script` 產生 JS，含 `setInterval(flushBeat, 10000)` 在**追蹤頁面**執行 |

---

## API 統一候選（僅列出不實作）

| 候選 | 理由 |
|---|---|
| `ChatApiService` | 集中 messages.list/search/create、quota 退避、retry | 
| `SheetsService` | Bug/9527/Sites 共用 append/read |
| `GeminiClient` | Enterprise vs API Key 雙路徑 |
| `ErpRepository` | MSSQL 連線池 + query |
