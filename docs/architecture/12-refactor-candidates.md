# Refactor Candidates

> 本阶段 **只列出，不实施**（盤點當時）。分级：Must / Should / Could / Do Not Yet。  
> **[差量]** 部分 Must 已推進：見 [`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)。

---

## A. Must Refactor（功能边界清楚、高度独立）

| 候选 | 理由 | 来源 Segment | 目标 | 現行 |
|---|---|---|---|---|
| **GChat API Layer** | search/list/create/markRead 散落 runtime | SEG-M-021, SEG-G-006 | `modules/gchat/chat-api-service.js` | **已接入**（仍經 runtime deps） |
| **GChat Packet Repository** | packets 多处 direct write | SEG-M-024, SEG-P-005 | `modules/gchat/packet-repository.js` | **已有** packet-repository |
| **Authorization 目录化** | 规则要求集中；现全在 runtime | SEG-M-013 | `main/authorization/google-auth.js` | **未做** |
| **gchat-reply-pop 拆分** | 曾为单档 inline | SEG-P-* | `renderer/components/gchat-reply-pop/*` | **已粗拆**（state/shell/thread/composer/live/boot） |

---

## B. Should Refactor（有耦合但拆分可改善）

| 候选 | 理由 | 来源 |
|---|---|---|
| **GChat Poll Coordinator** | 4 层 30s poll 重复 API | SEG-M-010, SEG-P-005, timer-map | **已有** poll-coordinator |
| **emitGchatCacheChanged 统一** | 双 event + 多窗口 send | SEG-M-010 | **已統一**單一 Cache Push |
| **debounced saveGchatDisk** | 5+ 重复 setTimeout(0) | SEG-M-019 |
| **app.js Feature 下沉** | logic.js 全 stub | SEG-R-006~014 → features/*/logic.js |
| **Framework 目录化** | Tray/Window/Updater 在 runtime | SEG-M-006, SEG-M-009, SEG-M-027 |
| **WindowRegistry + ThemeBus** | broadcast 硬编码遍历 | SEG-M-003 |
| **SheetsService** | Bug/9527/Sites 共用 | SEG-M-014, SEG-M-015, SEG-R-008 |
| **Toast dedupe 单一 owner** | Main + Renderer 双去重 | SEG-M-007, SEG-R-011 | **Main only** |

---

## C. Could Refactor（有收益但非紧急）

| 候选 | 理由 |
|---|---|
| Gmail module 化 | 边界清楚但体量小于 GChat |
| Calendar/Tasks module | IPC 块独立，耦合低 |
| Sites Visits IPC 下沉 | enrich 已拆，IPC 仍在 runtime |
| AI Chat module | 独立 feature，1340 行 |
| Bug Report module | 独立 460 行 |
| shared/debounce util | 280ms 重复 3 次 |
| shared/retry util | withTransientRetry 推广 |
| Renderer sheets/sites 改 push | 减 60s poll |

---

## D. Do Not Refactor Yet（成本高或本身是完整流程）

| 保留 | 理由 |
|---|---|
| `normalizeChatMessage` 整体搬移 | 复杂转换，搬移需完整测试矩阵 |
| Mosaic drag/resize 引擎 | 自 contained，搬移收益低 |
| ensureGchatSyncStack 注入模式 | 需先完成 API/Repository 拆后再改 |
| Weather proxy | 10 行 IPC，不值得独立模块 |
| Focus Timer | 纯 UI，无 IPC |
| electron-updater 块 | 已边界清楚，搬移仅 cosmetic |
| partial-loader.js | 已独立小文件 |

---

## 共用能力候选清单

### Cache Repository

```text
shared/cache/
├── gmail-packet-repository.js   (cache + pending + disk)
├── gchat-inbox-repository.js    (已有 cache-repository)
├── gchat-packet-repository.js   (packets 读写)
└── persist-debounce.js          (saveGchatDisk / saveDiskPacket)
```

### API

```text
shared/api/
├── google-client-factory.js     (oauth2Client + service init)
├── chat-api-service.js
├── sheets-api-service.js
├── retry.js                     (withTransientRetry)
└── quota-backoff.js
```

### Notification

```text
shared/notification/
├── toast-service.js             (showFloatingGchatToast + dedupe)
├── badge-sync.js                (syncRegistryReplyPopBadges)
└── meeting-reminder.js
```

### Timer

```text
shared/timer/
├── poll-coordinator.js          (合并 30s GChat polls)
├── scheduler-lifecycle.js       (login/logout start/stop all)
└── debounce.js
```

### Event

```text
shared/events/
├── window-broadcast.js          (theme/font/cache push)
└── ipc-push-names.js            (常量)
```

### Component (Renderer)

```text
renderer/components/
├── gchat-reply-pop/             (从 HTML 拆)
├── gchat-thread-view/
└── scroll-to-message.js         (retry pattern 共用)
```

---

## 功能 → Code 完整 Mapping

### Little Reply

```text
Little Reply
├── UI
│   ├── renderer/features/gchat/view.html
│   ├── renderer/shell/app.js (SEG-R-011)
│   ├── gchat-reply-pop.html
│   ├── gchat-reply-bar.html
│   ├── gchat-toast.html
│   └── gchat-quick-search-pop.html + gchat-quick-search.js
├── Renderer API
│   └── preload.js → window.api.gchat*
├── IPC
│   └── gchat-* (25+ channels)
├── Main
│   ├── runtime.js SEG-M-003~010, SEG-M-019~025
│   └── modules/gchat/*
├── API
│   └── Google Chat v1 + chatHttp search
└── Cache
    ├── gchatCache.messages → cache-repository
    ├── gchatCache.packets → runtime (待 packet-repository)
    └── gchat_packet.json
```

### Gmail

```text
Gmail
├── UI: features/gmail/view.html + app.js SEG-R-010
├── IPC: get-gmail*, reply-gmail, mark-gmail-read
├── Main: runtime SEG-M-018
├── API: Gmail v1
└── Cache: cache + pending → gmail_packet.json
```

---

## 拆分优先级建议（给 Phase 2）

1. 接入 `chat-api-service.js` + 迁移 `searchUnreadChatMessages`
2. 建立 `packet-repository.js`
3. GChat Poll Coordinator（消除 viewing/pop 重复）
4. Authorization → `main/authorization/`
5. app.js gchat → `features/gchat/logic.js`
6. gchat-reply-pop 组件化
7. Framework (tray/window/updater) 目录化
8. 其余 features 按 Must→Should 顺序
