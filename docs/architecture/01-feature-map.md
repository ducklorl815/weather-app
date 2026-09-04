# 功能地圖（Feature Map）

> 依**實際行為**分類，非依檔名。每項附功能卡摘要；完整 IPC/API 見各專章。  
> **[差量]** Little Reply 請併讀 [`../little-reply/behavior-catalog.md`](../little-reply/behavior-catalog.md)、[`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)。

---

## Feature Map 總覽

```text
LifeTour
├── Core / Shell
│   ├── Application Shell（Header + Mosaic）
│   ├── Session & Authorization
│   ├── App Settings（主題／字級／Tray／開機啟動）
│   ├── Auto Update
│   └── Dist Feature Flags（正式包功能開關）
│
├── Header Widgets
│   ├── Weather & Clock
│   └── Focus Timer（25 分鐘）
│
├── Dashboard / Mosaic
│   ├── Widget Catalog & Layout
│   └── Partial View Loader
│
├── Little Reply（Google Chat）
│   ├── Message List（Inbox）
│   ├── Private Message / Group / Thread
│   ├── Read / Unread / Mark Read
│   ├── Reply Pop（精簡回覆視窗）
│   ├── Reply Bar（最小化列）
│   ├── Toast Notification
│   ├── Quick Search（Ctrl+F）
│   ├── Cache & Sync（30s Background）
│   ├── Custom Emoji
│   ├── Pin / Open Space
│   └── Lightbox（媒體預覽）
│
├── Gmail
│   ├── Unread List
│   ├── Detail / Reply
│   ├── Mark Read（本機佇列 + 同步）
│   └── Contacts
│
├── Calendar
│   ├── Event List
│   ├── Create Event
│   └── Meeting Reminder（Main 30s）
│
├── Tasks
│   └── Google Tasks CRUD
│
├── 9527 Sheets Inbox
│   ├── Multi-source Sheets
│   └── Note / Mark Done
│
├── Sites Visits（網站瀏覽紀錄）
│   ├── Tracker Script 部署
│   ├── Event Recording
│   ├── Report + ERP Enrichment
│   └── Dept Org Tree Editor
│
├── AI Chat（詢問機器人）
│   ├── Gemini Q&A
│   ├── Knowledge Base
│   └── SQL Report Bot
│
└── Bug Report
    ├── Submit（Sheets + Drive）
    └── List / Status
```

---

## 功能卡

### FC-001 Application Shell

| 欄位 | 內容 |
|---|---|
| **目的** | 提供常駐 Header、Mosaic 空殼、共用 Modal/Lightbox |
| **入口** | App 啟動 |
| **UI** | `index.html` L35–217；`renderer/shell/shell.css` |
| **IPC** | `load-feature-partial`、`window-minimize/show`、`app-quit` |
| **Main** | `createWindow()` runtime L2764+ |
| **State** | Mosaic layout → `localStorage: mosaic-layout-v1` |
| **依賴** | Authorization（登入後顯示 workspace） |

---

### FC-002 Session & Authorization

| 欄位 | 內容 |
|---|---|
| **目的** | Google OAuth、Token 管理、Feature scope 授權、Session 恢復 |
| **入口** | `#auth-container` 登入按鈕；設定面板各功能授權 |
| **UI** | `index.html` L164–169；`app.js` L667–800 |
| **IPC** | `check-login`、`ensure-session`、`auth-google*`、`feature-auth-status`、`logout` |
| **Main** | `ensureGoogleSession`、`runGoogleOAuth`、`syncAuthorizedFeatures` runtime L4001–4690 |
| **API** | Google OAuth2、`tokeninfo`、`userinfo` |
| **Storage** | `userData/google_token.json` |
| **Timer** | `sessionWatchTimer` 60s |
| **Event** | `session-status` 推送 |
| **被誰使用** | 幾乎所有 Google 功能 |

---

### FC-003 Weather & Clock

| 欄位 | 內容 |
|---|---|
| **目的** | Header 顯示本地時間、溫湿度、降雨；可搜尋地點 |
| **入口** | Header `#weather-widget`；搜尋面板 |
| **UI** | `index.html` L137–159；`app.js` L348–372 |
| **IPC** | `fetch-weather`（Main proxy fetch，繞 CORS） |
| **API** | 外部天氣 URL（Renderer 組裝） |
| **Storage** | `localStorage: weather-location-v1` |
| **Timer** | `clockTimer` 1s；`weatherSearchTimer` debounce 280ms |

---

### FC-004 Focus Timer

| 欄位 | 內容 |
|---|---|
| **目的** | 25 分鐘專注計時（Header 按鈕） |
| **UI** | `index.html` L139；`app.js` L165+ |
| **Timer** | `focusTimer` setInterval 1s |
| **依賴** | 無外部 API |

---

### FC-005 Mosaic Dashboard

| 欄位 | 內容 |
|---|---|
| **目的** | 可拖放調整的 Widget 工作台 |
| **入口** | `#add-menu` → 加入功能 |
| **UI** | `index.html` L192–202；`app.js` L803–1209 |
| **Renderer** | `WIDGET_CATALOG` 7 種 widget；`PartialViews.load()` |
| **Storage** | `localStorage: mosaic-layout-v1` |
| **依賴** | `renderer/features/*/view.html` |

---

### FC-006 Little Reply — Inbox List

| 欄位 | 內容 |
|---|---|
| **目的** | 顯示未讀/@我 GChat 訊息列表 |
| **入口** | Mosaic 加入「Little Reply」tile |
| **UI** | `renderer/features/gchat/view.html`；`app.js` L3326–4616 |
| **IPC** | `gchat-list`、`gchat-refresh`、`gchat-status`、`gchat-mark-read` |
| **Main** | `gchatSnapshot`、`prefetchGchatTodayCache`、`ensureGchatSyncStack` |
| **API** | `spaces.messages:search`（未讀）、`spaces.messages.list` |
| **Cache** | `gchatCache.messages`；`cache-repository.js` 唯一 inbox 寫入 |
| **Timer** | Main `sync-scheduler` 30s；**已移除** Renderer `gchatPollTimer`（舊 backup 有 10s） |
| **Event** | `gchat-cache-changed`（Cache Push；`gchat-list-updated` 已停發） |

---

### FC-007 Little Reply — Reply Pop / Bar / Toast

| 欄位 | 內容 |
|---|---|
| **目的** | 獨立視窗快速回覆、最小化 bar、桌面 Toast 提醒 |
| **入口** | 點擊訊息；Toast 點擊；Bar 點擊 |
| **UI** | `gchat-reply-pop.html` + `renderer/components/gchat-reply-pop/*`、`gchat-reply-bar.html`、`gchat-toast.html` |
| **IPC** | `gchat-compact-*`、`gchat-bar-*`、`gchat-show-toast`、`gchat-toast-*` |
| **Main** | `openCompactGchatReply`、`showFloatingGchatToast`、`replyPopRegistry` runtime L112–2763 |
| **Timer** | PollCoordinator + scheduler；`syncRegistryReplyPopBadges`（afterSync）；Reply Pop 訂閱 `gchat-thread-ping`（**無** `livePollTimer`／`viewingRefreshTimer`） |
| **Cache** | `gchatCache.packets`（thread 詳情） |

---

### FC-008 Little Reply — Thread Detail & Reply

| 欄位 | 內容 |
|---|---|
| **目的** | 載入對話歷史、發送回覆、Reaction、已讀同步 |
| **IPC** | `gchat-detail`、`gchat-reply`、`gchat-react`、`gchat-thread-refresh`、`gchat-set-viewing` |
| **Main** | `loadConversationHistory`、`markGchatConversationReadByName`；`read-sync.js` |
| **API** | `spaces.messages.list/create`、`spaces.messages.reactions` |
| **Cache** | `detail-cache.js` cache-first；`gchatCache.packets` |

---

### FC-009 Gmail

| 欄位 | 內容 |
|---|---|
| **目的** | 未讀郵件列表、詳情、回覆、標已讀 |
| **UI** | `app.js` L2174–3325 |
| **IPC** | `get-gmail`、`get-gmail-detail`、`reply-gmail`、`mark-gmail-read` |
| **Main** | `runSync`、`refreshGmailList` runtime L8111–8200 |
| **Cache** | `cache` + `pending`；`gmail_packet.json` |
| **Timer** | `syncTimer` 60s |
| **Event** | `gmail-packet` |

---

### FC-010 Calendar & Meeting Reminder

| 欄位 | 內容 |
|---|---|
| **目的** | 顯示行程、建立事件、會議前提醒 |
| **UI** | `app.js` L1418–1627、L4617–4771 |
| **IPC** | `get-calendar`、`calendar:createEvent` |
| **Main** | `checkMeetingReminders` runtime L7619–8110 |
| **Timer** | `meetingTimer` 30s |

---

### FC-011 Tasks

| 欄位 | 內容 |
|---|---|
| **IPC** | `get-tasks`、`add-task`、`update-task` |
| **Main** | runtime L7498–7618 |
| **API** | Google Tasks v1 |

---

### FC-012 9527 Sheets Inbox

| 欄位 | 內容 |
|---|---|
| **目的** | 多來源 Google Sheet 作為 inbox，備註、標完成 |
| **UI** | `app.js` L1628–1876 |
| **IPC** | `sheets-*` |
| **Timer** | `sheetsTimer` 60s（Renderer） |
| **Storage** | `sheets.json`、`sheets-state.json` |

---

### FC-013 Sites Visits

| 欄位 | 內容 |
|---|---|
| **目的** | 網站追蹤、瀏覽紀錄報表、ERP 同仁 enrichment、組織樹 |
| **UI** | `app.js` L1877–2173；`sites-dept-org.html` |
| **IPC** | `sites-visits-*` |
| **Main** | runtime L5925–7497；`modules/sites-visits/enrich.js` |
| **API** | Google Sheets、MSSQL ERP、Apps Script Web App |
| **Timer** | `sitesVisitsTimer` 60s |

---

### FC-014 AI Chat & Report

| 欄位 | 內容 |
|---|---|
| **目的** | Gemini 問答、本機知識庫、MSSQL 報表機器人 |
| **UI** | `app.js` L5217–5414 |
| **IPC** | `chat-ask`、`gemini-*`、`knowledge-*`、`report-*` |
| **Main** | runtime L13419–13959 |
| **API** | Gemini API / Vertex Enterprise、MSSQL |

---

### FC-015 Bug Report

| 欄位 | 內容 |
|---|---|
| **UI** | `index.html` L140–157；`app.js` L373–666 |
| **IPC** | `bug-report-*` |
| **Main** | runtime L5463–5924 |
| **API** | Google Sheets + Drive |

---

### FC-016 Auto Update

| 欄位 | 內容 |
|---|---|
| **UI** | 設定面板版本區；`app.js` settings 區段 |
| **IPC** | `app-get-version`、`app-check-update`、`app-download-update`、`app-install-update` |
| **Main** | runtime L13960–14202 |
| **Timer** | `updateCheckTimer` ~1h |

---

### FC-017 App Settings

| 欄位 | 內容 |
|---|---|
| **目的** | 主題、字級、Tray、開機啟動、GChat 偏好、開發者 API 設定 |
| **UI** | `index.html` L45–132；`app.js` L4772–5216 |
| **IPC** | `get/set-app-theme`、`get/set-app-font-scale`、`get/set-open-at-login`、`gchat-get/save-prefs`、`get/set-dist-feature` |
| **Storage** | `app-theme.json`、`gchat-prefs.json`、`dist-features.json` |
| **Event** | `app-theme`、`app-font-scale` 廣播至所有子視窗 |

---

## 系統功能總表

| Feature | Purpose | Main File | Renderer File | IPC（代表） | API | Cache | Timer |
|---|---|---|---|---|---|---|---|
| Shell | 工作台框架 | runtime.js L2764 | index.html, app.js L803 | load-feature-partial | — | localStorage mosaic | — |
| Authorization | Google 登入 | runtime.js L4123 | app.js L667 | auth-google*, check-login | OAuth2 | google_token.json | sessionWatch 60s |
| Weather | Header 天氣 | runtime.js L3913 | app.js L348 | fetch-weather | 外部 weather URL | localStorage | clock 1s |
| Focus | 專注計時 | — | app.js L165 | — | — | — | focus 1s |
| Mosaic | Widget 布局 | runtime.js L2765 | app.js L803 | load-feature-partial | — | localStorage | — |
| Little Reply | GChat 全套 | runtime.js L112–11531 + modules/gchat/* | app.js L3326, gchat-*.html | gchat-* | Chat API | gchatCache | sync 30s, viewing 30s |
| Gmail | 郵件 | runtime.js L8111 | app.js L2174 | get-gmail* | Gmail API | cache/pending | sync 60s |
| Calendar | 行程 | runtime.js L7619 | app.js L1418 | get-calendar | Calendar API | — | meeting 30s |
| Tasks | 待辦 | runtime.js L7498 | app.js L1210 | get-tasks* | Tasks API | — | — |
| Sheets 9527 | Inbox | runtime.js L5245 | app.js L1628 | sheets-* | Sheets API | sheets.json | sheets 60s |
| Sites Visits | 瀏覽紀錄 | runtime.js L5925, enrich.js | app.js L1877 | sites-visits-* | Sheets+MSSQL | sites-visits*.json | sites 60s |
| AI Chat | 機器人 | runtime.js L13419 | app.js L5217 | chat-ask, report-* | Gemini+MSSQL | knowledge/ | — |
| Bug Report | 回報 | runtime.js L5463 | app.js L373 | bug-report-* | Sheets+Drive | — | — |
| Update | 自動更新 | runtime.js L13960 | app.js settings | app-*-update | electron-updater | updateState | ~1h |
