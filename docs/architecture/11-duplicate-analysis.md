# Duplicate Analysis

> **[差量]** 下列「三重 poll／雙 Toast 去重／雙 list event」多已在 Little Reply phase 1／Phase 2C 收斂；現行見 [`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)。本文保留盤點當時分析。

## 1. 重複 API 呼叫

### Chat `spaces.messages.list` — 多 Caller 同一 API

| Caller | 间隔 | 目的 | 关系 |
|---|---|---|---|
| `searchUnreadChatMessages` | 30s | inbox 未读 | **底层** |
| `syncRegistryReplyPopBadges` | 30s × N bars | bar badge | **部分重复** — 与 inbox 重叠但需 thread 粒度 |
| `pingViewingGchatThread` | 30s | viewing thread | **部分重复** — 同一 space 可能已在 inbox sync |
| `refreshLiveThreadCacheFirst` (Reply Pop) | 30s × N pops | open pop 更新 | **部分重复** — 与 viewing ping 重叠 |
| `listSpaceMessages` / `listThreadMessages` | on-demand | detail load | 合理 on-demand |

**结论**：**部分重复 + 上下游** — inbox sync 是上游；bar/viewing/pop poll 是下游细粒度刷新，但未协调 quota。

### Chat `spaces.messages:search`

| Caller | 用途 |
|---|---|
| cache-repository.syncInboxFromServer | 正式 inbox sync |
| prefetchGchatTodayCache fallback | cache miss 时直接 search |

**结论**：prefetch 与 repository 是 **上下游**，fallback 路径可统一。

### Google Sheets 读写

| Caller | Feature |
|---|---|
| fetchSheetSource | 9527 |
| bug-report-submit/list | Bug |
| appendSitesVisitToSheet | Sites |
| ensureSitesVisitsLogSheet | Sites |

**结论**：**不同用途，共享底层能力** — 适合 SheetsService。

---

## 2. 重複 Cache 操作

### gchatCache.messages

| 操作 | 位置 | 是否重复 |
|---|---|---|
| mergeUnreadInbox | cache-repository | 正規 |
| applyInboxLocalRead | cache-repository | 正規 |
| direct filter/map | notifyNewGchatAlerts, gchatSnapshot | 读重复 |
| backup 直接赋值 | .refactor-backup | **已移除** |

### gchatCache.packets

| 操作 | 位置 |
|---|---|
| loadConversationHistory 写入 | runtime |
| pingViewingGchatThread 合并 | runtime |
| gchat-reply 发送后更新 | runtime IPC handler |
| refreshLiveThreadCacheFirst | reply-pop via thread-refresh |
| buildThreadRefreshFromCache | detail-cache 读 |

**结论**：**多处写同一 State** — 应集中 GchatPacketRepository。

### saveGchatDisk()

```text
setTimeout(() => saveGchatDisk(), 0) 出现 5+ 次
```

**结论**：**重复模式** — 适合 debounced persist helper。

### emitGchatCacheChanged vs broadcastGchatListUpdate

两者常连续调用，都 send 到 renderer。

**结论**：**部分重复** — 可合并事件 payload。

---

## 3. 重複 Timer / Polling

| 行为 | Timer A | Timer B | 判定 |
|---|---|---|---|
| GChat inbox 更新 | scheduler 30s | (旧) renderer 10s | **已消除重复** |
| 同一 thread 更新 | viewingRefresh 30s | livePollTimer 30s | **完全重复**（open pop + viewing 同时） |
| viewing ping | viewingRefresh 30s | scheduler onAfterSync ping | **完全重复** |
| space 新消息 | inbox search 30s | bar poll 30s | **部分重复** |
| Gmail vs GChat | 60s vs 30s | — | 不同 domain，OK |

---

## 4. 重複 UI 更新

| 模式 | 位置 A | 位置 B |
|---|---|---|
| GChat list 重绘 | onGchatCacheChanged → loadGchat | onGchatListUpdated → loadGchat |
| Thread 更新 | onGchatThreadPing (app) | onGchatThreadPing (reply-pop) |
| Badge 更新 | syncReplyBarUi | gchat-bar-update event |
| 主题同步 | broadcastAppTheme 遍历 | 各窗口 onAppTheme 重复 CSS 逻辑 |
| scroll-to-message retry | app.js `[60,150,320,600]` | reply-pop 相同 pattern |

**结论**：scroll retry 是 **复制粘贴 Utility**；list 双 event 是 **重复订阅**。

---

## 5. 重複 Notification

| 路径 | 机制 |
|---|---|
| Main Toast | notifyNewGchatAlerts → showFloatingGchatToast |
| Renderer alerted ids | localStorage gchat-alerted-ids-v1 |
| mainGchatAlerted Set | Main 去重 |

**结论**：**双层去重** — Main + Renderer 各维护 alerted state，可能不一致。

---

## 6. 重複 Utility / Data Mapping

| 功能 | 重复实例 |
|---|---|
| API retry | `withTransientRetry` (runtime) — 仅一处，但 Gmail/GChat/Sheets 未共用 |
| Message normalize | `normalizeChatMessage` — 集中，OK |
| Quota block | `markChatApiQuotaBlocked` / customEmoji quota — 类似逻辑两套 |
| Debounce search | 280ms × 3 (weather, gchat, quick-search) — **可复制为 util** |
| OAuth scope check | feature auth 多处类似分支 | 类型 B 重复 if |
| Date/time format | 散落 app.js 与各 HTML | 未集中 |

---

## 7. 同名不同行为 Function

| Function | 名称暗示 | 实际行为 |
|---|---|---|
| `refreshGchatList()` | refresh list | 仅 `prefetchGchatTodayCache({ notify: false })` |
| `startMainGchatAlertWatch()` | alert watch | deprecated → 仅 `startGchatSyncScheduler()` |
| `gchat-alert-watch` IPC | 启用 alert | 清 alerted + **总是** start scheduler（与 alert 设定部分解耦） |

---

## 8. 冗長程式碼分类

### 类型 A — 合理偏长（保留）

- `normalizeChatMessage` — 复杂 API → UI model 转换
- `loadConversationHistory` — thread 加载 + media hydrate
- `syncRegistryReplyPopBadges` — 复杂 badge 逻辑（但应拆）

### 类型 B — 大量重复 if

- `syncAuthorizedFeatures` feature type 分支
- app.js 各 widget mount 错误处理
- OAuth feature scope 检查

### 类型 C — 单 Function 多责任

- `prefetchGchatTodayCache` — API + cache + notify + disk
- `openCompactGchatReply` — window + registry + scroll + IPC + theme
- `runSync` — Gmail fetch + pending flush + cache + push + disk
- gchat-reply IPC handler — create + cache update + push + mark read

### 类型 D — Legacy 累积

- runtime L8111–11531 Gmail+GChat 交界 — 历史堆叠
- gchat-reply-pop.html 3000 行 inline — 旧架构
- `.refactor-backup/` — 旧 monolith 参考

---

## 9. 重复关系总结表

| 重复类型 | 实例 | 关系 | 建议（仅设计） |
|---|---|---|---|
| API list poll | viewing + pop + bar | 完全/部分重复 | 统一 PollCoordinator |
| inbox sync | scheduler vs prefetch | 上下游 | 单一 SyncService 入口 |
| cache write packets | 4+ writers | 跨功能 direct write | PacketRepository |
| saveGchatDisk | 5+ setTimeout 0 | 重复模式 | debounced persist |
| list UI refresh | cache-changed + list-updated | 重复 event | 合并 push |
| toast dedupe | Main Set + localStorage | 双层 | 单一 dedupe owner |
| theme broadcast | 遍历 5 窗口 | 重复 send | WindowRegistry |
