# Little Reply 文件差量（相對 architecture 00–14 盤點）

> **行為真相**：[`docs/little-reply/behavior-catalog.md`](../little-reply/behavior-catalog.md)  
> **詞彙**：根目錄 `CONTEXT.md`  
> **決策**：`docs/adr/0001-little-reply-phase1-pop-and-event-unification.md`  
>  
> `docs/architecture/00–14` 多為較早逆向盤點／Phase 2 策略草稿；下列條目已與**現行碼**對齊。未列出的段落仍可能過時，實作前請以 Behavior Catalog + 程式為準。

---

## 已變更（差量）

| 主題 | 盤點當時 | 現行 |
|---|---|---|
| Cache Push | `gchat-cache-changed` + `gchat-list-updated` 雙發 | **只發** `gchat-cache-changed`；`gchat-list-updated` 停發（preload no-op） |
| Toast 去重 | Main Set + Renderer `localStorage gchat-alerted-ids-v1` | **Main only**（`notifyNewGchatAlerts`） |
| `viewingRefreshTimer` | Main 30s 獨立 timer | **已移除**；改 PollCoordinator interest + `gchat-thread-ping` |
| Reply Pop `livePollTimer` | Renderer 30s `setInterval` | **已移除**（變數殘留無害）；訂閱 `gchat-thread-ping` + Cache Push |
| `chat-api-service.js` | stub／未接入 | **已接入**（Phase 2A）；業務仍多經 runtime deps |
| Reply Pop 結構 | 單檔 ~3k–4k 行 inline CSS/JS | DOM shell `gchat-reply-pop.html` + `renderer/components/gchat-reply-pop/{styles,state,shell,thread-view,composer,live-refresh,app}.js` |
| Failed Optimistic Reply | 失敗 alert、氣泡可能假成功 | 氣泡標未送出 + **重試** |
| 開窗焦點 | 一律 show/focus | 明確開啟搶焦點；`stealFocus:false`／thread-ping **不搶焦點** |

---

## 仍有效／未在 phase 1 收斂

- Inbox／大量邏輯仍在 `renderer/shell/app.js`（`features/gchat/logic.js` 仍 stub）
- 視窗 registry、Toast 視窗本體、多數 orchestration 仍在 `main/runtime.js`
- Authorization／gchat scope 集中化：見 `docs/authorization-evaluation.md`（不在 Little Reply phase 1）
- `docs/architecture/14` 內「策略步驟」多為歷史；文末「已完成」段落較接近現況，但仍以本差量為準

---

## 維護約定

1. 改 Little Reply **使用者可見行為** → 先更新 Behavior Catalog。  
2. 改硬決策 → ADR。  
3. 改詞 → `CONTEXT.md`。  
4. 盤點章（00–14）僅在大重構後做差量，不要求每次同步全文。
