# Renderer / index.html 地圖

> **現況**：`index.html` 已重構為 **220 行 Application Shell**。舊版 8,082 行備份在 `.refactor-backup/index.html`。  
> 巨型 Renderer 邏輯在 `renderer/shell/app.js`；Reply Pop：`gchat-reply-pop.html` + `renderer/components/gchat-reply-pop/*`。  
> **[差量]** [`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)、[`../little-reply/behavior-catalog.md`](../little-reply/behavior-catalog.md)。

---

## index.html 結構（Shell DOM）

| 區段 | 行號 | DOM / ID | 行為來源 |
|---|---|---|---|
| Header Chrome | L35–160 | `.header`, `.title-area` | app.js settings + theme |
| 主題切換 | L41–43 | `#theme-btn`, `#theme-menu` | `toggleThemeMenu()` |
| 應用設定 | L45–132 | `#app-settings-menu` | 版本、字級、Tray、dev panels |
| 登出 | L134 | `.logout-btn` | `logoutApp()` |
| 天氣 Widget | L137–159 | `#weather-widget`, `#local-clock` | `initWeatherAndClock()` |
| Focus Timer | L139 | `#focus-btn` | `toggleFocusTimer()` |
| Bug 回報 | L140–157 | `#bug-report-panel` | `toggleBugReportPanel()` |
| GChat Toast 宿主 | L162 | `#gchat-toast-stack` | 主視窗內 stack（另有獨立 toast 視窗） |
| 登入閘道 | L164–169 | `#auth-container` | `loginGoogle()` |
| 共用 Modal | L171–176 | `#detail-modal` | Gmail/Calendar 詳情 |
| GChat Lightbox | L178–190 | `#gchat-lightbox` | `GchatLightboxZoom` |
| Mosaic 工作台 | L192–202 | `#dashboard-shell`, `#mosaic` | `renderMosaic()` |
| Script 載入 | L205–217 | 13 個 `<script src>` | 見下方 |

**index.html 無 inline `<script>`、無 inline CSS、無 addEventListener** — 全在外部 JS。

---

## Script 載入順序

1. `renderer/shell/partial-loader.js`
2. `gchat-emoji-catalog.js` / `gchat-emoji-picker.js`
3. `renderer/components/gchat-quick-search.js`
4. `renderer/components/gchat-lightbox-zoom.js`
5. `renderer/features/*/logic.js`（7 個 **stub**）
6. `renderer/shell/app.js`

---

## app.js 【MODULE】區段

| 行號 | MODULE | 職責 |
|---|---|---|
| L23–347 | Boot / Session | `window.onload`、session hint、離線重連 |
| L348–372 | weather-focus | 天氣、時鐘、Focus Timer |
| L373–666 | bug-report | Bug 回報面板 |
| L667–800 | Authorization | 登入、feature auth gate |
| L803–1209 | Mosaic | `WIDGET_CATALOG`、drag/resize、partial 掛載 |
| L1210–1417 | tasks | 待辦 CRUD |
| L1418–1627 | calendar | 行程列表 |
| L1628–1876 | sheets | 9527 inbox |
| L1877–2173 | sitesVisits | 瀏覽紀錄 |
| L2174–3325 | gmail | 郵件列表、回覆 |
| L3326–4616 | gchat | **Little Reply 主面板（最大區塊）** |
| L4617–4771 | calendar create | 建立行程 modal |
| L4772–5216 | settings | 主題、字級、更新、Tray |
| L5217–5414 | chat | Gemini 機器人 |
| L5415–5428 | logout | 登出、Gmail packet listener |

---

## WIDGET_CATALOG

| type | 標題 | mount() | Partial View |
|---|---|---|---|
| `calendar` | 預定行程 | `loadCalendar()` | `features/calendar/view.html` |
| `tasks` | 待辦事項 | `loadTasks()` | `features/tasks/view.html` |
| `gmail` | 未讀郵件 | `loadGmail()` | `features/gmail/view.html` |
| `gchat` | Little Reply | `loadGchat()` | `features/gchat/view.html` |
| `sheets` | 9527 | `loadSheets()` | `features/sheets/view.html` |
| `sitesVisits` | 網站瀏覽紀錄 | `loadSitesVisits()` | `features/sitesVisits/view.html` |
| `chat` | 詢問機器人 | `mountChat()` | `features/chat/view.html` |

---

## Satellite HTML 視窗

### gchat-reply-pop.html（DOM shell）+ `renderer/components/gchat-reply-pop/*`

| 檔案 | 內容 |
|---|---|
| `gchat-reply-pop.html` | DOM shell |
| `styles.css` | 主題變數與 UI 樣式 |
| `state.js` | 共用執行期狀態 |
| `shell.js` | 標題列、縮小／還原、opening scroll、媒體 lightbox |
| `thread-view.js` | 串渲染、reaction、捲動 |
| `composer.js` | @提及、附件、送出、Failed Optimistic Reply |
| `live-refresh.js` | cache-first 刷新、`gchat-thread-ping`／Cache Push（**無** 30s `livePollTimer`） |
| `app.js` | boot：綁定 IPC／主題、呼叫 `load()` |

### gchat-reply-bar.html（~270 行）
- 最小化對話列 UI
- IPC：`gchatBarClick/Close/State`、`onGchatBarUpdate`

### gchat-toast.html（~249 行）
- 浮動 Toast 通知
- IPC：`gchatToastPush/Dismiss`、`gchatToastOpen`

### gchat-quick-search-pop.html（~57 行）
- 薄 wrapper，邏輯在 `renderer/components/gchat-quick-search.js`

### sites-dept-org.html（~1,123 行）
- 部門組織樹 drag/drop 編輯
- IPC：`sitesVisitsDeptOrgGet/Move/Export`

---

## Renderer 本機狀態

| 變數 / Key | 用途 |
|---|---|
| `localStorage: mosaic-layout-v1` | Widget 布局 |
| `localStorage: weather-location-v1` | 天氣地點 |
| `localStorage: ui-font-scale-v1` | 字級 |
| ~~`localStorage: gchat-alerted-ids-v1`~~ | **已廢止**；Toast 去重改 Main only |
| `mosaicItems`, `mosaicDrag` | Mosaic 執行期 |
| `currentGchatContext`, `gchatPinned*` | GChat 主面板 |
| `sheetsTimer`, `sitesVisitsTimer` | 60s 輪詢 |
| `gchatSearchTimer` | 280ms debounce |

---

## Partial View 載入流程

```text
addWidget(type)
  → renderMosaic()
  → PartialViews.load(type)
      → fetch(renderer/features/<type>/view.html)
      → fallback: window.api.loadFeaturePartial(type)
  → WIDGET_CATALOG[type].mount()
```

---

## 功能 → Code 對照（Renderer 側）

| 功能 | HTML | Renderer JS | 備註 |
|---|---|---|---|
| Shell | index.html | app.js L803 | Mosaic 引擎 |
| Weather | index.html L137 | app.js L348 | Header |
| Gmail | features/gmail/view.html | app.js L2174 | logic.js stub |
| Little Reply | features/gchat/view.html | app.js L3326 | + gchat-reply-pop.html |
| Calendar | features/calendar/view.html | app.js L1418 | |
| Tasks | features/tasks/view.html | app.js L1210 | |
| Sheets | features/sheets/view.html | app.js L1628 | |
| Sites | features/sitesVisits/view.html | app.js L1877 | + sites-dept-org.html |
| AI Chat | features/chat/view.html | app.js L5217 | |
