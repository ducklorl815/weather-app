# LifeTour（weather-app）系統總覽

> 逆向工程盤點文件 · 第一階段 · **不修改程式碼**  
> 掃描基準：`main/runtime.js`（約 14,202 行）、`renderer/shell/app.js`（約 5,428 行）、`index.html`（約 220 行 Shell）  
>  
> **[差量]** Little Reply 現行行為／結構以 [`../little-reply/behavior-catalog.md`](../little-reply/behavior-catalog.md) 與 [`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md) 為準；下文部分敘述已過時。

---

## 這個 App 是什麼

**LifeTour**（package 名 `LifeTour`，productName 同）是一款 **Electron 桌面生產力中心**，整合：

- Google 生態：Gmail、Google Chat（Little Reply）、Calendar、Tasks、Sheets
- 內部工具：網站瀏覽紀錄（Sites Visits + ERP）、9527 試算表 inbox、Bug 回報
- AI：Gemini 詢問機器人 + SQL 報表
- 桌面能力：系統匣、多視窗 GChat 回覆、Toast 提醒、自動更新
- Header 附帶：天氣 Widget、Focus Timer

品牌定位是「一站式工作台」，不是純天氣 App；天氣只是 Header 常駐小功能。

---

## 技術棧

| 層 | 技術 |
|---|---|
| 框架 | Electron 28 |
| Main | Node.js、`googleapis`、`mssql`、`electron-updater` |
| Renderer | 原生 HTML/CSS/JS（無 React/Vue） |
| IPC | `preload.js` → `contextBridge` → `window.api` |
| 持久化 | `app.getPath('userData')` + JSON 檔（非 electron-store） |

---

## 程序架構（實際）

```text
main.js（33 行薄入口）
  └── require('./main/runtime')   ← 現行全部 Main 邏輯

preload.js
  └── window.api（90+ IPC 方法）

index.html（Application Shell）
  ├── renderer/shell/shell.css
  ├── renderer/shell/partial-loader.js
  ├── renderer/shell/app.js       ← Renderer 主邏輯 monolith
  ├── renderer/components/*       ← GChat 共用元件
  └── renderer/features/*/view.html + logic.js（stub）

Satellite BrowserWindows
  ├── gchat-reply-pop.html（DOM shell）+ renderer/components/gchat-reply-pop/*
  ├── gchat-reply-bar.html
  ├── gchat-toast.html
  ├── gchat-quick-search-pop.html
  └── sites-dept-org.html
```

### 規劃 vs 現實

| 目錄 | 規劃 | 現實 |
|---|---|---|
| `main/framework/` | 生命週期、視窗、Tray、Updater | 僅 README；實作在 `runtime.js` 【MODULE】區段 |
| `main/authorization/` | OAuth、Session | 僅 README；實作在 `runtime.js` L4123+ |
| `main/modules/gchat/` | GChat 模組化 | **已部分拆出**（sync/cache/read/detail） |
| `main/modules/sites-visits/` | ERP enrichment | **已拆出** `enrich.js` |
| `renderer/features/*/logic.js` | Feature 邏輯下沉 | **全為 stub**，邏輯仍在 `app.js` |

---

## Main Process 做什麼

1. **視窗生命週期**：主視窗、Tray、GChat Reply Pop/Bar/Toast、Quick Search
2. **OAuth / Session**：Google 登入、Feature scope、Token 刷新、Session watch
3. **背景同步**：Gmail 60s、GChat inbox 30s、Calendar 會議提醒 30s、Session 60s
4. **IPC 閘道**：107 個 `ipcMain.handle` + 3 個 `ipcMain.on`
5. **外部 API**：Google APIs、Gemini、MSSQL ERP、天氣 fetch proxy
6. **快取與持久化**：Gmail packet、GChat packet、各設定 JSON
7. **自動更新**：electron-updater + GCS feed

---

## Renderer 做什麼

1. **登入閘道**：未登入顯示 `#auth-container`
2. **Mosaic 工作台**：拖放 Widget tile，Partial View 動態注入
3. **Feature UI**：Gmail / GChat / Calendar / Tasks / Sheets / Sites / AI Chat
4. **Header Chrome**：主題、設定、天氣、Focus、Bug 回報
5. **IPC 呼叫**：一律透過 `window.api`，不直接碰 `ipcRenderer`
6. **本機 UI 狀態**：`localStorage`（mosaic layout、weather location、font scale 等）

---

## IPC 怎麼運作

```text
Renderer (app.js / satellite HTML)
    │ window.api.xxx()
    ▼
preload.js
    │ ipcRenderer.invoke / send / on
    ▼
main/runtime.js
    │ ipcMain.handle / on
    ▼
Business Logic → API / Cache / webContents.send 推送
```

**推送事件**（Main → Renderer）：`session-status`、`gmail-packet`、`gchat-cache-changed`（Cache Push；**不再發** `gchat-list-updated`）、`gchat-thread-ping`、`app-theme`、`app-update-status` 等。

---

## 主要生命週期

```text
app.whenReady
  → createWindow() → load index.html
  → ensureTray()
  → loadDiskPacket / loadGchatDisk
  → ensureGoogleSession (silent)
  → startSyncLoop (Gmail 60s)
  → startMeetingWatch (30s)
  → startSessionWatch (60s)
  → startGchatSyncScheduler (30s, 需 Chat 授權)
  → scheduleUpdateCheck (~1h)

使用者登入
  → runGoogleOAuth → syncAuthorizedFeatures
  → bootstrap GChat cache → startGchatSyncScheduler

使用者登出 (ipc send 'logout')
  → clearPacket → stop timers → reload auth UI

關閉主視窗
  → closeToTray 設定決定 hide vs quit
```

---

## 文件索引

| 文件 | 內容 |
|---|---|
| [01-feature-map.md](./01-feature-map.md) | 功能地圖與功能卡 |
| [02-main-process.md](./02-main-process.md) | Main Process 詳細地圖 |
| [03-renderer.md](./03-renderer.md) | Renderer / Shell / Satellite 地圖 |
| [04-ipc-map.md](./04-ipc-map.md) | IPC 通道完整對照 |
| [05-api-map.md](./05-api-map.md) | 外部 API 與 Caller |
| [06-cache-map.md](./06-cache-map.md) | 快取與持久化 |
| [07-timer-map.md](./07-timer-map.md) | 計時器與輪詢 |
| [08-event-map.md](./08-event-map.md) | 事件與 Listener |
| [09-code-segments.md](./09-code-segments.md) | **Code Segment Map（拆碼基礎）** |
| [10-dependency-map.md](./10-dependency-map.md) | 依賴關係圖 |
| [11-duplicate-analysis.md](./11-duplicate-analysis.md) | 重複行為分析 |
| [12-refactor-candidates.md](./12-refactor-candidates.md) | 重構候選分級 |
| [13-future-architecture.md](./13-future-architecture.md) | 未來模組化設計（僅設計） |

---

## 重要備註

- **Legacy 備份**：`.refactor-backup/index.html`（8,082 行）、`.refactor-backup/main.js` 保留重構前單檔版本
- **index.html 已 Shell 化**：不再 10,000+ 行；巨型邏輯在 `app.js` + `runtime.js`；Reply Pop 邏輯在 `renderer/components/gchat-reply-pop/*`
- **GChat 同步已模組化 Phase 1–2**：scheduler / sync-service / cache-repository / read-sync 已拆出，但 API 核心仍在 runtime
