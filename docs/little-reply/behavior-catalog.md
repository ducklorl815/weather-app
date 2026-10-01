# Little Reply Behavior Catalog

Post–phase-1 source of truth for **user-visible behavior** and the logic behind it.  
Glossary: see root `CONTEXT.md`. Hard decisions: `docs/adr/0001-little-reply-phase1-pop-and-event-unification.md`.  
Architecture inventory delta: `docs/architecture/15-little-reply-doc-delta.md` (00–14 may lag; prefer this catalog for behavior).

Main paths below are detailed; other A+B+C surfaces are summarized.

---

## Main path — Reply Pop

### Open

- **Entries**: Inbox click, Toast click, Reply Bar restore, Quick Search open.
- All converge on Main `openCompactGchatReply` → BrowserWindow loading `gchat-reply-pop.html`.
- Reuse: same Space/Thread convKey reuses an existing Reply Pop when possible.
- Before open (typical): capture `readUntil`, mark read (unless skipped), hide Toast.

### Focus policy

- **Explicit open** (Inbox / Toast / Search / Bar restore): show + focus + raise (`stealFocus` default true).
- **Background thread ping** (`gchat-thread-ping` / `notifyOpenGchatThread`): refreshes an open Reply Pop only; does **not** open a window or steal focus.
- Callers may pass `stealFocus: false` to show without focusing.

### Load & live update

- Content is **cache-first** (Packet), then background network refresh.
- While open and not minimized:
  - `gchat-thread-ping` → `refreshLiveThreadCacheFirst` (force when new message / forceRefresh).
  - **Cache Push** (`gchat-cache-changed`) → `refreshLiveThreadCacheFirst` (cache then network).
- Scroll: opening scroll / jump-to-message / near-bottom follow; opening scroll controller suppresses conflicting refreshes until complete.

### Send reply

1. Insert local “me” bubble (optimistic).
2. Clear composer; call `gchat-reply` IPC.
3. **Success**: clear Failed Optimistic state; refresh thread shortly after.
4. **Failure — Failed Optimistic Reply**: bubble stays, marked unsent, **Retry** resends the same payload; no fake “success” alert-only path.

### @ 真提及／僅參考標籤（群組 Space）

Glossary: **真提及**、**僅參考標籤** in root `CONTEXT.md`.

- Typing `@` in Reply Pop composer opens the mention suggest list.
- **群組成員** (top): people in the Space (true notify). **`@all`／全部成員** is pinned at the top of this section when the query matches.
- **不在此群・僅參考** (below): only appears after the user types a keyword; directory hits who are **not** in the Space. Selecting them inserts a dashed chip that serializes as plain `@名字` (no `<users/…>`, no invite, no notify).
- Default highlight: first **群組成員** hit when any exist; otherwise first 僅參考 hit.
- While members are loading: show「載入成員…」; directory refs may resolve in parallel; when members arrive the list refreshes. Already-inserted chips are **not** auto-upgraded from 僅參考 → 真提及.
- Chip look: solid accent = 真提及; dashed muted = 僅參考標籤.
- DM / private threads keep a flat suggest list (not partitioned).

### Shell files

- DOM: `gchat-reply-pop.html`
- Styles: `renderer/components/gchat-reply-pop/styles.css`
- Logic (load order): `state.js` → `shell.js` → `thread-view.js` → `composer.js` → `live-refresh.js` → `app.js` (boot)

---

## Cache Push

- Canonical Main→Renderer event: **`gchat-cache-changed`** only.
- Inbox and Reply Pop both consume this channel.
- **`gchat-list-updated` is not emitted**; preload keeps a no-op subscriber for compatibility.

---

## Toast

- **Toast Dedupe Owner = Main** (`notifyNewGchatAlerts` + `mainGchatAlerted*`).
- Renderer does **not** maintain a second alerted-id set or call show-toast from list polling.
- Pref `alertPopup` still toggled from settings; watch/start remains Main-driven **only while Little Reply is an Active Feature**.
- Suppress rules (viewing same Space, minimized bar badge vs new Toast, etc.) stay in Main.

## Active Feature gate

- Little Reply background (sync scheduler, Toast／Reply Bar Alert, Quick Search) runs only when **gchat** is an **Active Feature** (Mosaic tile present). See ADR 0006 / `CONTEXT.md` Active Features.
- **Feature Off** (remove tile): stop scheduler, destroy Reply Pop／Reply Bar／Quick Search, clear alert／interest memory; Session／Credential／disk packet kept. `alertPopup` pref unchanged.
- **Feature On** (add tile): wake background immediately (subject to Feature Scope Gate).
- Main must receive Active Feature List from Renderer before starting Little Reply background; Session／OAuth success alone must not start it.

---

## Summaries — rest of A+B+C

### Inbox (Mosaic)

- Lists unread DM and @mention items from Main snapshot / `gchat-list`.
- Updates on Cache Push; manual refresh via `gchat-refresh`.
- Click opens Reply Pop (steal focus).
- Mark-read via list actions / open path.

### Reply Bar

- Minimized stand-in for a Reply Pop; click toggles restore/minimize.
- Badge sync from Main registry / scheduler paths.
- Restore steals focus (explicit user action).

### Reply Bar Alert（最小 bar 提醒）

Glossary: **Reply Bar Alert**, **Pinned Space**, **Space-level message**, **Focus Thread**, **Alert Anchor** in root `CONTEXT.md`. ADR: `docs/adr/0004-reply-bar-alert-pinned-without-inbox.md`, `docs/adr/0005-alert-anchor-open-landing.md`.

**When** (create Reply Bar if none, else badge＋1; Toast may also fire under existing suppress／dedupe):

1. Any new message from others in a **Pinned Space** / pinned DM  
2. Any **DM**  
3. Group message that **@mentions me**

**Group display**

| Where the alert landed | Bar | Title |
|---|---|---|
| API reply **Thread** | Focus Thread bar | `{Space name} · {root snippet}` |
| **Space-level** (outer timeline) | Normal space bar | Space display name |
| Same Space, both kinds | Both bars may coexist | — |

**Open landing（Bar／Toast 同一套）**

| Alert Anchor | Opens | Scroll |
|---|---|---|
| In a **Thread** | **Focus Thread** Pop | Jump to **Anchor message** → else firstUnread → else bottom |
| **Space-level** / DM | Space or DM Pop | Jump to **Anchor** → else firstUnread → else bottom |

- In-thread Alerts create／badge **only** the Focus Thread bar (no second space-level bar for the same Alert).
- If a space-level bar **already exists**, its pending Anchor may be updated so clicking it still redirects into Focus Thread—without creating or badging a new space bar.
- Multiple unread threads: land on the **latest** Alert Anchor.
- Inbox stays narrow: pinned group traffic without @me does **not** become Inbox rows; scanned via pinned-space cursors into Bar／Toast only.
### Quick Search

- Ctrl+F / quick-search window; open contact or Space → may `gchat-open-space` then Reply Pop.

### Sync / cache / IPC (Main)

- Scheduler + PollCoordinator drive inbox/thread interests.
- Inbox list cache vs Packet (thread detail) remain separate stores.
- IPC handlers under `main/modules/gchat/ipc`; heavier orchestration still wired from `runtime.js` deps.
- Authorization / OAuth for gchat scopes: **out of this catalog’s phase-1 change set** (see `docs/authorization-evaluation.md`).

---

## Out of scope (this document)

- Full architecture remap of `docs/architecture/00–14` (may lag; prefer this catalog for behavior).
- Authorization service rewrite.
- Deep Reply Pop widget tree beyond the current component shell.
