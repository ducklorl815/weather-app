# Cache Map

> **[差量]** Toast：只用 Main `mainGchatAlerted*`；Renderer `gchat-alerted-ids-v1` 已廢止。見 [`15-little-reply-doc-delta.md`](./15-little-reply-doc-delta.md)。

## 記憶體快取

| Cache | Owner | 結構 | Read | Write | Persistence |
|---|---|---|---|---|---|
| `cache` | Gmail | emails, labels, contacts, details | packetSnapshot, get-gmail* | runSync, refreshGmailList | gmail_packet.json |
| `pending` | Gmail | markRead queue, reply queue | runSync flush | reply-gmail, mark-gmail-read | gmail_packet.json |
| `gchatCache` | GChat | messages, packets, spaceMeta, todayTouched, customEmojis, syncing | gchatSnapshot, gchat-detail | **cache-repository（inbox）** + 多處 direct write | gchat_packet.json |
| `gchatPending.markRead` | GChat read-sync | Map<messageName, meta> | read-sync flush | mark-gchat-read | 随 gchat flush |
| `gchatLocallyRead` / `gchatLocallyReadSpaces` | GChat | Set 去重 | mark read 判斷 | mark read | 記憶體 |
| `mainGchatAlerted` / `mainGchatAlertedAt` | Toast | Map 去重 | notifyNewGchatAlerts | sync 後 | 記憶體 |
| `replyPopRegistry` | Reply Pop | Map<convKey, entry> | bar/pop UI | open/close/minimize | bounds → gchat-reply-bounds.json |
| `replyPopBoundsStore` | Reply Pop | bounds per window | open pop | drag resize debounce | gchat-reply-bounds.json |
| `recentReplySpaces` | GChat | 近期空間 | open space | reply 後 | 記憶體 |
| `promptedMeetings` | Calendar | 會議提醒去重 | checkMeetingReminders | 提醒後 | 記憶體 |
| `customEmojiDownloadQueue` | GChat | 下載佇列 | emoji render | refreshCustomEmojiCache | disk images |
| `chatApiQuotaBlockedUntil` | GChat | quota 退避 timestamp | isChatApiQuotaBlocked | markChatApiQuotaBlocked | 記憶體 |
| `gchatDetailCache` | detail-cache 模組 | ready packet 判斷 | gchat-detail IPC | loadConversationHistory | 間接 gchatCache.packets |
| `gchatSyncStack` | 模組組裝 | scheduler, services | ensureGchatSyncStack | 首次建立 | — |
| `lastSqlRetrieval` / `lastEnterpriseRetrieval` | AI | 檢索快取 | chat-ask | 每次 ask | 記憶體 |
| `updateState` | Updater | 更新狀態 | app-get-update-status | updater events | — |
| `erpPool` | enrich.js | MSSQL 連線 | ERP queries | 首次連線 | — |

---

## gchatCache 子結構

```text
gchatCache
├── messages[]          ← inbox 列表（cache-repository 唯一 merge 寫入）
├── packets{}             ← thread/space 詳情 cache（多處直接寫）
├── spaceMeta{}           ← 空間顯示名稱等
├── todayTouched{}        ← 今日互動追蹤
├── customEmojis{}        ← emoji registry
├── directoryWarmed       ← 目錄快取 flag（5min 失效）
└── syncing               ← sync mutex flag
```

---

## 磁碟持久化（userData）

| 檔案 | 內容 | 寫入 Function |
|---|---|---|
| `google_token.json` | OAuth tokens | saveCredentials |
| `gmail_packet.json` | cache + pending | saveDiskPacket |
| `gchat_packet.json` | messages + packets + spaceMeta | saveGchatDisk |
| `gchat-prefs.json` | closeToTray, alertPopup, pins | saveGchatPrefs |
| `gchat-reply-bounds.json` | pop bounds | debounced save |
| `gchat_custom_emojis.json` | emoji metadata | saveCustomEmojiRegistry |
| `gchat_custom_emoji_images/` | emoji 二進位 | download queue |
| `app-theme.json` | theme id | saveAppTheme |
| `sheets.json` | 9527 sources | saveSheetsConfig |
| `sheets-state.json` | row state | saveSheetsState |
| `sites-visits.json` | config | saveSitesVisitsConfig |
| `sites-visits-store.json` | local events | saveSitesVisitsStore |
| `gemini.json` | AI config | saveGeminiConfig |
| `knowledge/index.json` | 知識庫索引 | knowledge-add |
| `report-schema.json` | 報表 schema | report-save-table |

專案根：`dist-features.json`

---

## Renderer localStorage

| Key | 內容 |
|---|---|
| `mosaic-layout-v1` | Widget 布局 |
| `weather-location-v1` | 天氣地點 |
| `ui-font-scale-v1` | 字級（可能與 Main 同步） |
| ~~`gchat-alerted-ids-v1`~~ | **已廢止**（Toast Dedupe Owner = Main） |

---

## Cache 寫入路徑分析

### gchatCache.messages（inbox）

| Writer | 路徑 | 是否應集中 |
|---|---|---|
| `cache-repository.mergeUnreadInbox` | syncInboxFromServer | **唯一正規入口** |
| `cache-repository.applyInboxLocalRead` | mark read local | 正規 |
| Legacy direct assign | `.refactor-backup` 有 `gchatCache.messages = await search...` | 已移除 |

### gchatCache.packets（thread detail）

| Writer | 路徑 | 是否應集中 |
|---|---|---|
| `loadConversationHistory` | detail load 後寫入 | 主要 |
| `gchat-reply` handler | 發送後更新 | 分散 |
| `pingViewingGchatThread` | viewing 更新 | 分散 |
| `refreshLiveThreadCacheFirst` | Reply Pop poll | 分散 |
| `buildThreadRefreshFromCache` | cache-first refresh | 讀多寫少 |

**判斷**：packets 應抽 **GchatPacketRepository**；inbox 已有 cache-repository。

---

## Sync 策略

| Cache | Sync 機制 |
|---|---|
| Gmail | Main 60s runSync → saveDiskPacket |
| GChat inbox | scheduler 30s → cache-repository → saveGchatDisk (debounced setTimeout 0) |
| GChat read | read-sync flush → API → cache update |
| Sheets 9527 | Renderer 60s loadSheets → IPC sheets-inbox |
| Sites | Renderer 60s + Main sheet sync on report |

---

## Cache 操作重複（詳見 11-duplicate-analysis.md）

- `saveGchatDisk()` 多處 `setTimeout(..., 0)` 非同步寫碟
- `emitGchatCacheChanged()` vs 直接 `webContents.send` 部分路徑並行
- Reply Pop / viewing / bar 各自 poll 後寫 packets，可能覆蓋
