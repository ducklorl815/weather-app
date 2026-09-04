# Future Modular Architecture（设计提案）

> **仅设计，不创建文件（當時）。** 基于 01–12 分析结果，非套用模板。  
> **[差量]** Reply Pop 元件粗拆、PollCoordinator、Cache Push 等已部分落地：[`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)。

---

## 设计原则

1. **行为不变优先** — 先搬 Segment，后删重复
2. **数据流单向** — API → Repository → Service → IPC → Renderer
3. **Timer 集中** — GChat 所有 30s poll 经 PollCoordinator
4. **Authorization 唯一入口** — 所有 feature 经 auth service
5. **Renderer 薄层** — UI + 调用 window.api，无业务逻辑

---

## 目标结构

```text
main.js                          ← 薄入口 + register 顺序

main/
├── framework/
│   ├── lifecycle.js             ← app.whenReady, quit
│   ├── window-manager.js        ← createWindow, WindowRegistry
│   ├── tray.js                  ← ensureTray
│   └── updater.js               ← electron-updater
│
├── authorization/
│   ├── config.js                ← OAuth 常数 (SEG-M-002)
│   ├── google-auth.js           ← OAuth flow (SEG-M-013)
│   ├── session-service.js       ← ensureSession, watch 60s
│   └── feature-scopes.js        ← syncAuthorizedFeatures
│
├── shared/
│   ├── api/
│   │   ├── google-client.js
│   │   ├── retry.js
│   │   └── quota-backoff.js
│   ├── cache/
│   │   └── persist-debounce.js
│   ├── events/
│   │   └── window-broadcast.js
│   └── timer/
│       ├── poll-coordinator.js
│       └── scheduler-lifecycle.js
│
└── modules/
    ├── gchat/
    │   ├── ipc/                 ← SEG-M-025 handlers
    │   ├── ui/                  ← SEG-M-003~008 (pop/bar/toast/quick-search)
    │   ├── sync/                ← scheduler, sync-service (已有)
    │   ├── cache/               ← cache-repository, detail-cache, packet-repository (新)
    │   ├── read/                ← read-sync (已有)
    │   ├── api/                 ← chat-api-service (接入)
    │   ├── notification/        ← toast, badge (从 SEG-M-007,010 抽)
    │   └── viewing/             ← viewing watch (从 SEG-M-010 抽)
    │
    ├── gmail/
    │   ├── sync-service.js
    │   ├── ipc.js
    │   └── packet-repository.js
    │
    ├── calendar/
    ├── tasks/
    ├── sheets/
    ├── sites-visits/
    │   ├── ipc.js
    │   └── enrich.js            (已有)
    ├── weather/
    ├── bug-report/
    └── ai-chat/

renderer/
├── shell/
│   ├── app.js                   ← 仅 Boot + Mosaic + Settings (~1200 行目标)
│   ├── partial-loader.js
│   └── shell.css
├── components/
│   ├── gchat-reply-pop/         ← 从 gchat-reply-pop.html 拆
│   ├── gchat-quick-search.js
│   └── gchat-lightbox-zoom.js
└── features/
    ├── gchat/
    │   ├── view.html
    │   └── logic.js             ← 从 app.js SEG-R-011 搬
    ├── gmail/
    │   ├── view.html
    │   └── logic.js
    └── ... (各 feature 同上)

preload.js                       ← 维持 API 面稳定（兼容）
```

---

## 核心：GChat 模块内数据流（目标）

```text
                    ┌─────────────────────┐
                    │  PollCoordinator    │
                    │  (single 30s tick)  │
                    └──────────┬──────────┘
                               │
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
    SyncService          ViewingService      BadgeService
           │                   │                   │
           ▼                   ▼                   ▼
   InboxRepository      PacketRepository     BarRegistry
           │                   │                   │
           └───────────────────┼───────────────────┘
                               ▼
                      ChatApiService
                               ▼
                        Google Chat API
```

---

## IPC 注册模式（目标）

```javascript
// main.js 未来形态（示意，不实施）
const { registerGchatIpc } = require('./main/modules/gchat/ipc');
const { registerAuthIpc } = require('./main/authorization/ipc');

app.whenReady().then(async () => {
  await framework.lifecycle.init();
  registerAuthIpc();
  registerGchatIpc(deps);
  // ...
});
```

---

## runtime.js 消亡路径

| 阶段 | 动作 | runtime.js 剩余 |
|---|---|---|
| Phase 2a | GChat API + packet-repository 接入 | ~12,000 行 |
| Phase 2b | GChat UI (pop/bar/toast) 搬 modules/gchat/ui | ~9,000 行 |
| Phase 2c | Authorization → authorization/ | ~7,500 行 |
| Phase 2d | Framework 搬 framework/ | ~6,000 行 |
| Phase 2e | 其余 modules 逐个搬 | ~2,000 行 |
| Phase 3 | runtime.js 删或仅 re-export 兼容 | 0 |

---

## Renderer 目标

| 文件 | 当前 | 目标 |
|---|---|---|
| index.html | 220 行 Shell | 维持 |
| app.js | 5,428 行 | ~1,200 行（Boot+Mosaic+Settings） |
| features/*/logic.js | stub | 各 feature 完整逻辑 |
| gchat-reply-pop.html | 3,266 行 | ~100 行 shell + components |

---

## 共用 vs Feature 边界

| 层 | 内容 | 示例 |
|---|---|---|
| **Core** | 进程生命周期、窗口、授权 | framework/, authorization/ |
| **Shared** | 跨 feature 能力 | retry, persist-debounce, poll-coordinator |
| **Features** | 业务闭环 | gchat/, gmail/, sites-visits/ |

---

## 风险与约束

1. **preload API 不变** — 拆 main 时不改 channel 名，避免 renderer 全改
2. **disk format 不变** — gchat_packet.json 结构保持，避免用户数据迁移
3. **行为验证矩阵** — 每搬一 Segment 需跑：登录、inbox sync、reply、mark read、toast、bar badge
4. **quota** — 合并 poll 前需 A/B 对比 API 调用次数

---

## 与现有 modulization 对齐

已完成的 GChat Phase 1–2：
- ✅ sync-scheduler（唯一 inbox 30s）
- ✅ sync-service（mutex）
- ✅ cache-repository（inbox 唯一写）
- ✅ read-sync（mark read flush）
- ✅ detail-cache（cache-first read）

下一步 natural fit：
1. 接入 chat-api-service
2. packet-repository
3. poll-coordinator（viewing + pop + bar）
4. notification service（toast + badge）

---

## 成功指标（Phase 2 完成时）

| 指标 | 当前 | 目标 |
|---|---|---|
| runtime.js 行数 | ~14,202 | < 3,000 或删除 |
| app.js 行数 | ~5,428 | < 1,500 |
| GChat 30s API callers | 4+ | 1 coordinator |
| packets 写入口 | 4+ | 1 repository |
| features logic.js stub | 7/7 | 0/7 |
