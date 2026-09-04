# GChat Phase 2 Refactor Strategy

> **阶段：Analyze → Map → Strategy（歷史策略稿；不修改程式码當時）**  
> 目标模块：`ChatApiService`、`PacketRepository`、`PollCoordinator`  
> 扫描基准：`main/runtime.js`、`main/modules/gchat/*`、`gchat-reply-pop.html`  
>  
> **[差量／現行]** Phase 2A–2C 與 Little Reply phase 1 多數目標已落地（API／Packet／PollCoordinator、移除 viewing／livePoll timer、Cache Push 單一化、Toast Main-only、Reply Pop 元件粗拆）。完整對照：[`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)、[`../little-reply/behavior-catalog.md`](../little-reply/behavior-catalog.md)。下文步驟表請當歷史，勿當待辦清單。

---

## 0. 目标架构（确认用）

```text
                   Scheduler（何时执行：30s tick）
                      │
                      ▼
               PollCoordinator（有哪些同步需求 + 去重）
                      │
                      ▼
                 SyncService（编排：API → Repository → Event）
                  /        \
                 /          \
                ▼            ▼
       ChatApiService    CacheRepository（inbox）
       PacketRepository（packets）
                │            │
                ▼            ▼
             Server        gchatCache
                              │
                              ▼
                    emitGchatCacheChanged
                              │
                  ┌───────────┼───────────┐
                  ▼           ▼           ▼
                List        Popup       Badge/Toast
```

**禁止**：
- ChatApiService → Cache
- PacketRepository → Google API
- SyncService → DOM / Toast UI

---

## Phase 2A：ChatApiService

### A.1 完整 API Map

#### API-001 `messages:search`（HTTP POST）

| 项目 | 内容 |
|---|---|
| **Endpoint** | `POST https://chat.googleapis.com/v1/spaces/-/messages:search` |
| **Function** | `searchChatMessages(filter)` L10273 |
| **底层** | `chatHttp()` L8628 → `oauth2Client.request` |
| **Caller** | `searchUnreadChatMessages` L10322（×2 filter：mention + unread） |
| | `gchat-status` IPC probe L11594 |
| **用途** | Inbox 未读/@我 搜索 |
| **回传** | `data.results[]` → `{ message, read, spaceMuteSetting }` |
| **Transform** | `searchUnreadChatMessages` → `normalizeChatMessage` → inbox items |
| **Retry** | `withTransientRetry` tries=3, baseMs=500 |
| **Error** | mention 失败 log 继续；unread 失败 transient 时返回本地 cache |
| **Quota** | 经 `isChatQuotaError` → `markChatApiQuotaBlocked` |

#### API-002 `spaces.messages.list`

| 项目 | 内容 |
|---|---|
| **Function** | `listSpaceMessages` L10882、`listThreadMessages` L10907 |
| **Caller** | `loadConversationHistory` L10980 |
| | `syncRegistryReplyPopBadges` L3495/L3507（pageSize 3/12） |
| | `enrichSpaceThreadMessages` 等 |
| **用途** | Space/thread 历史、bar badge 侦测 |
| **回传** | `res.data.messages[]` → `normalizeChatMessage` |
| **Retry** | badge sync 用 `withTransientRetry`；list 函数内 quota throw |
| **Quota** | `isChatApiQuotaBlocked()` 预检 + catch `markChatApiQuotaBlocked` |

#### API-003 `spaces.messages.get`

| 项目 | 内容 |
|---|---|
| **Caller** | `gchat-detail` IPC L11810（cache miss 且无 listHit） |
| **用途** | 单则消息详情 |
| **Transform** | `normalizeChatMessage` + `ensureSpaceMeta` |

#### API-004 `spaces.messages.create`

| 项目 | 内容 |
|---|---|
| **Caller** | `gchat-reply` IPC L11903 |
| **用途** | 发送回复（含 quote、thread、attachment） |
| **后续** | runtime 内 `appendMessageToGchatPacket` + readSync（非 API 层） |

#### API-005 `spaces.messages.reactions.*`

| 项目 | 内容 |
|---|---|
| **Caller** | `gchat-react` IPC L12022 list, L12120 delete, L12131 create |
| **用途** | 表情反应 CRUD |

#### API-006 `users.spaces.updateSpaceReadState`

| 项目 | 内容 |
|---|---|
| **Function** | `markGchatSpaceReadRemote` L10624 |
| **Caller** | `markChatMessageReadRemote` L10658 → ReadSync flush |
| **Retry** | `withTransientRetry` tries=3, baseMs=400 |
| **Scope** | 需 `hasChatReadStateScope` |

#### API-007 `spaces.get`

| 项目 | 内容 |
|---|---|
| **Function** | `ensureSpaceMeta` L10200 区域 |
| **Caller** | `searchUnreadChatMessages`、`packGchatSpaceHistory`、`syncRegistryReplyPopBadges` title 等 |
| **副作用** | 写 `gchatCache.spaceNames/spaceTypes`（**应留在 Sync/Repository 层，非 ApiService**） |

#### API-008 `spaces.members.get/list`

| 项目 | 内容 |
|---|---|
| **Caller** | `resolveMyChatUserFromSpace` L10059、L10067 |
| **用途** | 解析 `myUserName` |

#### API-009 `spaces.list`

| 项目 | 内容 |
|---|---|
| **Function** | `listKnownGchatSpaces` L12412 |
| **Caller** | `searchGchatSpaces` → `gchat-search` IPC |
| **Cache** | `gchatCache.spaceList` 5min TTL（**元数据，非 ApiService 职责**） |

#### API-010 `spaces.findDirectMessage` / `spaces.setup`

| 项目 | 内容 |
|---|---|
| **Function** | `findOrOpenDmSpace` L12485 |
| **Caller** | `gchat-open-space` IPC、`gchat-pin-toggle` |
| **用途** | 开 DM 空间 |

#### API-011 `media.upload` / `media.download`

| 项目 | 内容 |
|---|---|
| **Function** | `uploadChatAttachment` L8638、`hydrateChatMedia` L9862 区域 |
| **Caller** | `gchat-reply` attachments、`loadConversationHistory` media hydrate |
| **用途** | 附件上传、媒体下载 |

#### API-012 `customEmojis` REST

| 项目 | 内容 |
|---|---|
| **Caller** | `refreshCustomEmojiCache` L9367、`fetchHttpBinary` |
| **用途** | 自定义 emoji registry |
| **注** | Phase 2A 可列为 **ApiService 扩展组**，不阻塞 inbox/thread 主路径 |

#### API-013 People / OAuth userinfo

| 项目 | 内容 |
|---|---|
| **Caller** | `ensureMyChatUserName`、`searchGchatContacts` |
| **注** | 目录搜索，非 Chat API 核心；可 Phase 2A+ 或独立 `DirectoryApiService` |

---

### A.2 ChatApiService 建议 Interface

```javascript
// 仅 Server 通讯 + 原始/轻度 normalized 回传
createChatApiService({ chatService, chatHttp, oauth2Client, isReady, withRetry, quotaGuard })

// Inbox
searchUnreadMentioned()   // filter: is_unread + @me
searchUnreadAll()         // filter: is_unread

// Messages
listSpaceMessages(spaceName, { pageSize, orderBy })
listThreadMessages(spaceName, threadName, { pageSize, orderBy })
getMessage(messageName)
createMessage(spaceName, requestBody, { replyOptions })
listReactions(messageName)
createReaction(messageName, emoji)
deleteReaction(reactionName)

// Read state
updateSpaceReadState(spaceName, lastReadTime)

// Space
getSpace(spaceName)
listSpaces({ filter, pageToken })
findDirectMessage(userResource)
setupSpace(requestBody)

// Media
uploadAttachment(spaceName, file)
downloadMedia(resourceName)

// 共用
request(method, url, body)  // chatHttp 封装
```

**不包含**：`normalizeChatMessage`、`ensureSpaceMeta` 写 cache、`indexGchatPacket`、`emitGchatCacheChanged`。

**Retry/Quota**：集中在 ApiService 内部：
- 所有方法经 `quotaGuard()` 预检
- 可变重试策略 `withRetry(fn, opts)` 替代散落 `withTransientRetry`

---

### A.3 现有 Data Flow vs 目标 Data Flow

#### Inbox Sync（现有）

```text
sync-scheduler tick
  → sync-service.syncUnreadInbox()
      → readSync.flushPending() [API-006 via ReadSync]
      → cache-repository.syncInboxFromServer()
          → searchUnreadChatMessages() [API-001 ×2 + ensureSpaceMeta API-007]
          → mergeUnreadInbox()
      → emitChanged
  → onAfterSync: badges [API-002] + viewing ping [间接] + toast [UI]
```

#### Inbox Sync（目标）

```text
scheduler tick
  → pollCoordinator.request({ key: 'inbox' })
  → syncService.syncUnreadInbox()
      → readSync.flushPending() → chatApiService.updateSpaceReadState
      → chatApiService.searchUnread*()
      → cacheRepository.mergeUnreadInbox(normalizedItems)
      → cacheRepository.emitChanged('sync')
  → onAfterSync: pollCoordinator 协调 badge/viewing（见 2C）
```

---

### A.4 Migration 顺序（ChatApiService）

| Step | 改什么 | 为什么 | 风险 | 验证 | 完成后 |
|---|---|---|---|---|---|
| **2A-1** | 扩展 stub：`searchUnread()` 改为内部实现 `searchChatMessages`×2 + normalize 移到 SyncService 外 | 最小切入点；cache-repository 已 expect `searchUnreadChatMessages` deps | 低 | inbox sync 30s、manual refresh 列表一致 | runtime `searchChatMessages` 标 LEGACY |
| **2A-2** | `listSpaceMessages` / `listThreadMessages` 迁入 | thread sync 第二大 API 用量 | 中 | gchat-detail、thread-refresh 内容一致 | 标 LEGACY |
| **2A-3** | `getMessage` 迁入 | detail cache miss 路径 | 低 | 点开未缓存消息 | 标 LEGACY |
| **2A-4** | Read state API 迁入；ReadSync deps 改 inject `chatApiService.updateSpaceReadState` | 清晰 Read 边界 | 中 | mark read + flush pending | 标 LEGACY markGchatSpaceReadRemote |
| **2A-5** | `createMessage` + reactions + media | reply 路径 | 高 | 发送、react、附件 | 标 LEGACY |
| **2A-6** | Space API（get/list/find/setup） | open-space、search | 中 | 开 DM、搜索 | 标 LEGACY |

**2A-1 具体**：`cache-repository.syncInboxFromServer` deps 从 `searchUnreadChatMessages` 改为：

```text
syncService:
  raw = await chatApiService.fetchUnreadInboxItems()  // 含 normalize 在 SyncService
  cacheRepository.mergeUnreadInbox(raw)
```

Normalize 留在 **SyncService**（非 ApiService），ApiService 只回 `results[].message` 原始或轻量 parse。

---

## Phase 2B：PacketRepository

### B.1 资料结构（实际）

```text
gchatCache.packets: Record<string, Packet>

Packet {
  detail: MessageModel      // 对话「标题」消息（最新/焦点）
  thread: MessageModel[]    // 完整串（可能已 groupGchatMessagesByThread）
  packedAt: number          // 毫秒时间戳，用于选最新
  historyReady: boolean     // 是否已加载历史
  mediaHydrated?: boolean   // 媒体是否已 hydrate
}

MessageModel {
  name: string              // spaces/.../messages/...  【Message Key】
  spaceName: string         // spaces/...               【Space Key】
  threadName?: string       // spaces/.../threads/...   【Thread Key】
  createTime: ISO string    【时间权威：新者覆盖 snippet/text】
  isRead?: boolean
  isMine?: boolean
  sender, snippet, text, media, ...
}

Index Keys（同一 Packet 多键指向）:
  - messageName          e.g. spaces/A/messages/M1
  - space:spaces/A       gchatSpacePacketKey()
  - 同 space 所有旧 messageName 键会被 indexGchatPacket 覆写指向同一 packet
  - thread 内每条 message.name 也作为键
```

**Disk**：`serializeGchatPacketsForDisk()` 最多 48 包，pin 优先；`loadGchatPacketsFromDisk` 后 `indexGchatPacket` 统一 space 键。

---

### B.2 所有 packets 写操作盘点

| # | 位置 | 操作 | Function | 触发 |
|---|---|---|---|---|
| W1 | L930 | `gchatCache.packets = {}` | logout/clear | 登出 |
| W2 | L8323–8345 | 磁盘加载赋值 + index | `loadGchatPacketsFromDisk` | 启动 |
| W3 | L11130–11148 | 多键索引写入 | `indexGchatPacket` | **核心写入口** |
| W4 | L11152–11208 | merge thread + index | `upsertGchatLivePacket` | thread-refresh、live update |
| W5 | L11212–11238 | append msg + upsert | `appendMessageToGchatPacket` | gchat-reply 发送后 |
| W6 | L11240–11279 | load history + index | `packGchatDetailForItem` | detail、toast 预热、notify |
| W7 | L11388 | index | `packGchatSpaceHistory` | open-space、pin 预热 |
| W8 | L11478–11487 | delete stale keys | `pruneGchatPackets`? | finalize inbox |
| W9 | L11511–11514 | pack + index | `packGchatPackets` | inbox finalize |
| W10 | L11698–11719 | direct assign | `gchat-detail` handler | detail IPC |
| W11 | L12070–12075 | spread update | `gchat-reply` handler | reply 更新 thread |
| W12 | L12272–12290 | upsert + index | `gchat-thread-refresh` IPC | Reply Pop poll |
| W13 | L12537 | index | `buildOpenSpaceResult` 区域 | open-space |

**读操作**（不经过 Repository）：
- `findReadyGchatPacket` L11282
- `findReadyGchatPacketBySpace` L11315
- `detail-cache.js` 经 deps 调用上述 find

---

### B.3 Merge Policy（Packet / Thread）

已有实现：`cache-repository.mergeMessageFields` / `mergeMessages`（L13–101）— **可复用到 PacketRepository**。

#### 规则 1：新 Message（Server 有、Cache 无）

```text
→ insert by message.name
→ thread 按 createTime 排序
```

#### 规则 2：已存在 Message

```text
→ mergeMessageFields(existing, incoming)
→ createTime 较新者赢得 snippet/text/createTime/unreadCount
→ sender/spaceDisplayName 用 pickLabel 保留较完整者
→ media 合并保留已有 dataUrl/previewUrl
```

#### 规则 3：Timestamp 冲突

```text
incomingTime >= existingTime → incoming 字段优先（snippet/text）
否则 → 保留 existing
packedAt →  always Date.now() on write（用于 findReady 选最新 packet）
```

#### 规则 4：Local Read（**仅 inbox messages[]，非 packets thread**）

```text
inbox merge（cache-repository.mergeUnreadInbox）:
  isLocallyReadMessage(name) → skip（不插入 unread inbox）
  server isRead=true → out.isRead=true

packets thread 内 isRead:
  不因 inbox sync 覆盖；thread refresh 从 server 拉回时由 normalize 决定
  [Important] 当前 thread 消息无 gchatLocallyRead 过滤 — Phase 2B 需确认是否要在 packet merge 加 read overlay
```

#### 规则 5：Space 级索引

```text
indexPacket(packet):
  所有同 spaceName 的旧键 → 指向新 packet
  写入 space:{spaceName}、detail.name、thread[].name
```

#### 规则 6：Disk Persist

```text
save() → debounced saveGchatDisk（serialize 48 caps）
不在每次 index 同步写盘 — 由 SyncService 结束调用 repository.persist()
```

---

### B.4 PacketRepository 建议 Interface

```javascript
createPacketRepository({ getPackets, setPackets, mergeMessages, onPersist })

// Read
getByMessageName(name)
getBySpace(spaceName, { isDm })
findReady(messageName, hint)
findReadyBySpace(spaceName, { isDm })

// Write（唯一写入口）
indexPacket(packet)              // 替代 indexGchatPacket
upsertLivePacket(meta, thread)   // 替代 upsertGchatLivePacket
appendMessage(msg, extras)       // 替代 appendMessageToGchatPacket
mergeThread(spaceName, incomingThread, opts)
setPacket(messageName, packet)   // 仅 IPC 过渡用

// Lifecycle
pruneStale({ keepSpaceNames })
serializeForDisk()
loadFromDisk(raw)
persist()                        // debounced
```

**不做**：`loadConversationHistory`（留在 SyncService，调 ApiService 后 call repository.upsert）。

---

### B.5 Migration 顺序（PacketRepository）

| Step | 改什么 | 风险 | 验证 |
|---|---|---|---|
| **2B-1** | 建立 `packet-repository.js`；`indexGchatPacket` → `repo.indexPacket` 委托 | 低 | 单元：多键索引、space 覆写 |
| **2B-2** | `findReady*` 迁入 repo | 低 | detail-cache 行为不变 |
| **2B-3** | `upsertGchatLivePacket` / `appendMessageToGchatPacket` 迁入 | 中 | thread-refresh、reply 发送 |
| **2B-4** | `gchat-thread-refresh` IPC 改经 SyncService.syncThread → repo | 高 | Reply Pop 30s poll |
| **2B-5** | `packGchatDetailForItem` 拆：SyncService.syncThread + repo | 高 | gchat-detail、toast 预热 |
| **2B-6** | 禁止 runtime direct `gchatCache.packets[...]=`（lint/comment） | — | grep 零 direct write |

---

## Phase 2C：PollCoordinator

### C.1 Timer 现状（完整表）

| Timer | 状态 | 间隔 | Start | Stop | Owner | 实际行为 | API | Cache | UI |
|---|---|---|---|---|---|---|---|---|---|
| **sync-scheduler** | ✅ 现行 | 30s | `startGchatSyncScheduler` / Chat auth | logout / `stopGchatSyncScheduler` | `sync-scheduler.js` | `syncUnreadInbox` + onAfterSync | API-001 | inbox merge | emitChanged |
| **mainGchatAlertTimer** | ❌ 已移除 | 10s | — | — | backup only | — | — | — | — |
| **gchatPollTimer** (Renderer) | ❌ 已移除 | 10s | — | — | backup index.html | loadGchat | — | — | — |
| **viewingRefreshTimer** | ✅ 现行 | 30s | `gchat-set-viewing` | viewing clear / logout | runtime L3149 | `pingViewingGchatThread` → **thread-ping push** | 间接→API-002 | 间接→packets | Reply Pop refresh |
| **livePollTimer** | ✅ 现行 | 30s | Reply Pop open | Pop close | gchat-reply-pop.html L2908 | `refreshLiveThreadCacheFirst` → IPC thread-refresh | API-002 | packets | Pop DOM |
| **syncRegistryReplyPopBadges** | ✅ 每 tick | 30s | scheduler onAfterSync | — | runtime L3481 | 每 minimized bar `messages.list` | API-002 | bar badge 状态 | bar UI |

**结论**：真正打 Google API 的 30s 路径有 **3 条**（inbox + bar + thread-refresh），viewing timer 与 livePoll 在 open 时 **功能重叠**。

---

### C.2 Scheduler vs Coordinator

| | Scheduler | PollCoordinator |
|---|---|---|
| **职责** | 何时 tick（30s） | 本轮有哪些 sync 需求 |
| **现有** | `sync-scheduler.js` ✅ | **不存在** — 逻辑散落在 onAfterSync + viewing timer + pop poll |
| **不管** | 同步什么、去重 | 间隔设定（仍由 Scheduler 触发） |

---

### C.3 Request Key 设计

基于现有 Cache Key：

```text
'inbox'                              → syncUnreadInbox（已有 mutex in sync-service）
'space:{spaceName}'                  → syncSpaceHistory（loadConversationHistory 类）
'thread:{spaceName}:{threadName}'    → syncThread（focus thread）
'bar:{spaceName}:{threadFocus?}'     → syncBarBadge（syncRegistryReplyPopBadges 单 entry）
'viewing:{spaceName}:{threadName}'   → 可与 thread key 合并
```

**去重策略**：

```text
activeRequests: Map<key, Promise>

request(key, fn):
  if activeRequests.has(key): return activeRequests.get(key)
  p = fn().finally(() => activeRequests.delete(key))
  activeRequests.set(key, p)
  return p
```

**冲突消解**：
- `thread:...` 进行中 → `space:...` 请求可等待 thread 完成或合并（同 space 的 space sync 包含 thread 时 skip space）
- `inbox` 与 `space` **不合并**（不同数据源 API-001 vs API-002）

---

### C.4 使用者操作作为 Sync Trigger

| 触发 | 现有 | 目标 |
|---|---|---|
| 30s tick | scheduler → syncUnreadInbox | scheduler → coordinator.request('inbox') |
| 手动 refresh | `gchat-refresh` → prefetchGchatTodayCache | coordinator.request('inbox', { force }) |
| 点击消息 | gchat-detail IPC | coordinator.request('thread:...') 或 cache hit skip |
| gchat-set-viewing | start viewingRefreshTimer | coordinator.registerInterest('viewing:...') + 取消独立 timer |
| Reply Pop open | livePollTimer | coordinator.registerInterest('thread:...') |
| Bar minimized | onAfterSync badges | coordinator.request('bar:...') 批量 |

---

### C.5 目标 Data Flow（Poll 统一后）

```text
Scheduler tick (30s)
  → PollCoordinator.collectDueRequests()
      → [inbox, bar:*, viewing:*, pop:*]
  → 对每个 key: SyncService.run(key)  // mutex per key
  → SyncService 结束 → CacheRepository + PacketRepository emit
  → NotificationService（toast/badge）读 cache diff — **仍在 runtime，Phase 2D**

User click thread
  → IPC gchat-detail
  → PollCoordinator.request('thread:space:thread', () => syncService.syncThread(...))
  → 若已有同 key active → 返回同一 Promise
```

**Phase 2C 不删除 viewingRefreshTimer / livePollTimer** — 先改为 **调用 coordinator.request** 而非独立 IPC/API；验证后再移除 timer。

---

### C.6 Migration 顺序（PollCoordinator）

| Step | 改什么 | 风险 | 验证 |
|---|---|---|---|
| **2C-1** | 新建 `poll-coordinator.js` + `activeRequests` map | 低 | 单元：并发同 key 合并 |
| **2C-2** | `sync-service.syncUnreadInbox` 经 coordinator.request('inbox') | 低 | inbox 30s 行为不变 |
| **2C-3** | `syncRegistryReplyPopBadges` 改为 coordinator 批量 `bar:*` | 中 | minimized bar badge |
| **2C-4** | `gchat-thread-refresh` IPC → syncService.syncThread + coordinator | 高 | Reply Pop 刷新 |
| **2C-5** | viewingRefreshTimer tick → coordinator.request(viewing key) 而非 ping-only | 中 | 减少 duplicate API |
| **2C-6** | Reply Pop livePollTimer → coordinator.register + scheduler 驱动 | 高 | 需协调 UI 不在 renderer poll |
| **2C-7** | 移除 viewingRefreshTimer / livePollTimer | 中 | 对比 API 调用次数 |

---

## Phase 2D：Legacy Cleanup（策略预留）

- 标记 `@deprecated` / `LEGACY: migrated to X`
- grep 零 caller 后删除
- runtime.js 目标：GChat 区段从 ~4000 行降至 ~500 行（IPC 薄 handler + wiring）

---

## 模块责任边界（确认清单）

### ChatApiService ✅

| 负责 | 不负责 |
|---|---|
| HTTP/googleapis 呼叫 | Cache read/write |
| Retry、Quota  guard | normalize 业务（可选轻量 parse） |
| 原始 response 回传 | Timer、Event、UI |

### PacketRepository ✅

| 负责 | 不负责 |
|---|---|
| packets 读写 merge index | Google API |
| merge policy 执行 | inbox messages（属 CacheRepository） |
| persist 触发 | DOM、Toast |

### PollCoordinator ✅

| 负责 | 不负责 |
|---|---|
| 同步需求登记 | 实际 API 呼叫（交 SyncService） |
| per-key 去重 mutex | Cache merge |
| interest 注册（viewing/pop/bar） | UI render |

### SyncService（扩展）

| 负责 | 不负责 |
|---|---|
| 编排 ApiService + Repository | DOM |
| normalize（inbox/thread） | Toast/Badge UI（读 diff 后可 emit 事件） |
| flush readSync 协调 | Renderer |

### ReadSync（保持）

| 负责 | 不负责 |
|---|---|
| local read queue | inbox merge |
| flush → ApiService mark read | UI |

### CacheRepository（保持）

| 负责 | 不负责 |
|---|---|
| inbox messages merge | packets |
| locallyRead 优先 | API |

---

## Event Boundary

**`gchat-cache-changed` 可作为主要数据事件** ✅

目标：

```text
Repository.emitChanged(reason)
  → runtime emitGchatCacheChanged (薄)
  → webContents.send('gchat-cache-changed')
  → Renderer / Reply Pop 订阅更新
```

**不应**：
- Timer → 直接 send thread-ping 触发 API（Phase 2C 后改为 cache-changed 或 coalesced thread-ping）
- API handler → 直接 multiple send（合并经 emitChanged）

**过渡**：`gchat-list-updated` 与 `gchat-cache-changed` 可合并 payload（Phase 2D）。

---

## 执行总顺序

```text
Phase 2A: ChatApiService
  2A-1 searchUnread → 2A-2 list → 2A-3 get → 2A-4 read → 2A-5 create/react → 2A-6 space

Phase 2B: PacketRepository（可与 2A-2 并行）
  2B-1 index → 2B-2 find → 2B-3 upsert → 2B-4 thread-refresh → 2B-5 pack detail

Phase 2C: PollCoordinator（依赖 2A-2 + 2B-3 至少）
  2C-1 scaffold → 2C-2 inbox → 2C-3 bar → 2C-4 thread IPC → 2C-5 viewing → 2C-6 pop → 2C-7 移除旧 timer

Phase 2D: Legacy cleanup
```

**每步验证矩阵**：
1. 登录 + Chat 授权
2. Inbox 30s 更新、手动 refresh
3. 点开 DM / 群组 / 讨论串
4. Reply Pop 发送 + mark read
5. Minimized bar badge
6. Toast 新消息
7. Quota blocked 时 cache fallback

---

## 本阶段不做

- ❌ gchat-reply-pop.html 组件化
- ❌ app.js 拆分
- ❌ Authorization 目录化
- ❌ 删除 Legacy function（仅标记）

---

*待确认：ChatApiService / PacketRepository / PollCoordinator 三界线是否合理。确认后开始 2A-1 实作。*

---

## Phase 2A-1 实作记录（已完成）

| 项目 | 变更 |
|---|---|
| `chat-api-service.js` | 实现 `searchMessages` / `searchUnreadMentioned` / `searchUnreadAll` / `probeUnreadSearch` |
| `cache-repository.js` | `fetchUnreadInboxItems` dep；`mergeUnreadInboxFromServer()` 为 merge 入口 |
| `sync-service.js` | 改调用 `mergeUnreadInboxFromServer` |
| `runtime.js` | `fetchUnreadInboxItems` + `normalizeUnreadSearchResults`；`ensureGchatChatApiService`；LEGACY 标记 `searchChatMessages` / `searchUnreadChatMessages` |

**下一步**：Phase 2A-3（`getMessage` 迁入 ChatApiService）

---

## Phase 2A-2 实作记录（已完成）

| 项目 | 变更 |
|---|---|
| `chat-api-service.js` | `listMessagesRaw` / `listSpaceMessagesRaw` / `listThreadMessagesRaw` / `listSpaceMessagesRawRetry`；quota guard |
| `runtime.js` | `listSpaceMessages` / `listThreadMessages` 改经 ApiService + `normalizeChatMessages` |
| `runtime.js` | `syncRegistryReplyPopBadges` 改经 `listSpaceMessagesRawRetry` |

**下一步**：Phase 2A-6（Space API：`get` / `list` / `findDirectMessage` / `setup`）

---

## Phase 2A-4 實作記錄（已完成）

| 項目 | 變更 |
|---|---|
| `chat-api-service.js` | 新增 `updateSpaceReadState(spaceName, lastReadTime)` |
| `read-sync.js` | 空間已讀 flush 改 inject `chatApiService` + scope/readTime helpers |
| `runtime.js` | `assertChatReadStateScopeForGchat`、`applyGchatSpaceReadLocal` |
| `runtime.js` | `markGchatSpaceReadRemote` 改委派 ApiService |

**下一步**：Phase 2D Legacy cleanup

---

## Phase 2C 實作記錄（已完成）

| 步驟 | 項目 | 變更 |
|---|---|---|
| 2C-1 | `poll-coordinator.js` | `request` 去重、`registerInterest`、`runSchedulerTick` |
| 2C-2 | scheduler | tick 改經 `pollCoordinator.runSchedulerTick`（inbox mutex） |
| 2C-3 | bar badges | 併入 coordinator `bar:registry` |
| 2C-4 | `gchat-thread-refresh` | API 路徑改經 `coordinator.request(thread:...)` |
| 2C-5 | viewing | 移除 `viewingRefreshTimer`；改 `registerInterest` + scheduler 驅動 |
| 2C-6 | Reply Pop | 移除 `livePollTimer`；依 `gchat-thread-ping` + scheduler |
| 2C-7 | 合併 | 30s 統一由 scheduler → coordinator 編排 |

**下一步**：Phase 2D Legacy cleanup

---

## Phase 2D 實作記錄（已完成）

| 項目 | 變更 |
|---|---|
| 已刪除 | `searchChatMessages`、`searchUnreadChatMessages`（零 caller） |
| 已刪除 | `pingViewingGchatThread`、`startMainGchatAlertWatch`、`stopMainGchatAlertWatch` |
| 已刪除 | `viewingRefreshTimer`、`GCHAT_VIEWING_REFRESH_MS` |
| 重構 | `uploadChatAttachment` → `bufferChatAttachmentForUpload` + ApiService |
| 重構 | `downloadChatMediaDataUrl` → `mediaResourceToDataUrl` |
| 已刪除 | `cache-repository.syncInboxFromServer` |
| 精簡 | 移除未使用 `mergeMessages` import |
| 保留 | PacketRepository 薄包裝（`indexGchatPacket` 等） |

**Phase 2（2A–2D）完成**

---

## Phase 3A 實作記錄（IPC 拆分 — 已完成）

| 項目 | 變更 |
|---|---|
| `ipc/index.js` | `registerGchatIpc(ipcMain, deps)` 統一註冊入口 |
| `ipc/handlers/prefs.js` | `gchat-get-prefs` / `gchat-save-prefs` |
| `runtime.js` | `createGchatIpcDeps()` + 移除 inline prefs handlers |

**下一步**：Phase 3B（inbox / status / refresh handlers）

---

## Phase 3B 實作記錄（已完成）

| 項目 | 變更 |
|---|---|
| `ipc/handlers/inbox.js` | `gchat-status` / `gchat-list` / `gchat-refresh` |
| `createGchatIpcDeps().inbox` | session、snapshot、syncInbox 等注入 |
| `runtime.js` | 移除 inline inbox handlers |

**下一步**：Phase 3C（detail / thread-refresh）

---

## Phase 3C 實作記錄（已完成）

| 項目 | 變更 |
|---|---|
| `ipc/handlers/detail.js` | `gchat-detail` / `gchat-thread-refresh` |
| `createGchatIpcDeps().detail` | detailCache、pack、poll sync 等注入 |
| `runtime.js` | 移除 inline detail handlers；保留 `buildGchatDetailResponse` 等業務函式 |

**下一步**：Phase 3D（reply / react / mark-read）

---

## Phase 3D 實作記錄（已完成）

| 項目 | 變更 |
|---|---|
| `ipc/handlers/messaging.js` | `gchat-reply` / `gchat-react` / `gchat-mark-read` |
| `createGchatIpcDeps().messaging` | reply、react、read sync 等注入 |
| `runtime.js` | 移除 inline messaging handlers；保留 reaction helper 函式 |

**下一步**：Phase 3E（search / open-space / pin / emoji / quick-search）

---

## Phase 3E 實作記錄（已完成）

| 項目 | 變更 |
|---|---|
| `ipc/handlers/search.js` | `gchat-search` / `gchat-open-space` / `gchat-pin-toggle` / `gchat-custom-emojis` / quick-search（show/hide/arm） |
| `createGchatIpcDeps().search` | 搜尋、開空間、置頂、表情、Quick Search 注入 |
| `runtime.js` | 移除 inline search handlers；保留 `searchGchatContacts` 等業務函式 |

**下一步**：Phase 3F（UI handlers + events）

---

## Phase 3F 實作記錄（已完成）

| 項目 | 變更 |
|---|---|
| `ipc/handlers/ui.js` | toast / compact / bar / viewing / alert-watch / setup links（19 channels） |
| `createGchatIpcDeps().ui` | 視窗管理、viewing sync、外部連結注入 |
| `runtime.js` | 移除剩餘 inline GChat IPC；`applyGchatCompactTitle` 保留為業務函式 |

**Phase 3 IPC 拆分完成** — 所有 `gchat-*` handler 已迁入 `main/modules/gchat/ipc/handlers/`

---

## 回歸修正記錄（UI／行為）

| # | 項目 | 修正 |
|---|---|---|
| 1 | 回覆文字／icon 放大 | `gchat-reply-pop.html` 調整 reply-under、react-toggle、composer 字級 |
| 2–4 | PDF／圖片預覽 80% | lightbox 改 80vw×80vh；PDF 支援 inline 縮圖預覽 |
| 5 | 轉傳顯示（無文字） | `extractQuotedMessage` 支援 FORWARD／formattedText／attachments |
| 6–7 | 附加／笑臉按鈕 | 統一 40px icon 按鈕；笑臉 toggle 移除 X、背景加深 |
| 8 | 開啟捲動位置 | `scrollThreadToBottom` 多重 retry |
| 9 | 表情閃爍 | `mergeThreadPreservingReactions` 保留 optimistic |
| 10 | Ctrl+F 優先級 | 移除 globalShortcut；主視窗僅 Little Reply 啟用時攔截 |

---

## Phase 2B 實作記錄（已完成）

| 步驟 | 項目 | 變更 |
|---|---|---|
| 2B-1 | `packet-repository.js` | 新建；`indexPacket` / 磁碟序列化 |
| 2B-2 | find | `findReady` / `findReadyBySpace` 迁入 |
| 2B-3 | upsert | `upsertLivePacket` / `appendMessage` 迁入 |
| 2B-4 | thread sync | `sync-service.syncThread` + `syncGchatThreadFromServer` |
| 2B-5 | IPC | `buildGchatDetailResponse` / `patchMessageReactionsInCache` 改经 repo |
| 2B-6 | 禁止 direct write | runtime 已无 `gchatCache.packets[...]=` 直接写入 |

**下一步**：Phase 2C PollCoordinator

---

## Phase 2A-6 實作記錄（已完成）

| 項目 | 變更 |
|---|---|
| `chat-api-service.js` | 新增 `getSpaceRaw` / `getSpaceMemberRaw` / `listSpaceMembersRaw` / `listSpacesRaw` / `findDirectMessageRaw` / `setupSpaceRaw` |
| `runtime.js` | `ensureSpaceMeta` 改經 Space ApiService |
| `runtime.js` | `resolveMyChatUserFromSpace` 改經 members ApiService |
| `runtime.js` | `listKnownGchatSpaces` 改經 `listSpacesRaw` |
| `runtime.js` | `findOrOpenDmSpace` 改經 `findDirectMessageRaw` + `setupSpaceRaw` |

**Phase 2A 完成**：ChatApiService 主路徑 API 已全部迁入。

**下一步**：Phase 2B PacketRepository

| 項目 | 變更 |
|---|---|
| `chat-api-service.js` | 新增 `createMessageRaw` / `listReactionsRaw` / `createReactionRaw` / `deleteReactionRaw` / `uploadAttachmentRaw` / `downloadMediaRaw` |
| `runtime.js` | `gchat-reply` 改經 `createMessageRaw` |
| `runtime.js` | `gchat-react` 改經 reactions ApiService |
| `runtime.js` | `uploadChatAttachment` / `downloadChatMediaDataUrl` / `findMyReactionName` 改委派 ApiService（LEGACY 標記） |

**下一步**：Phase 2A-6（Space API）
