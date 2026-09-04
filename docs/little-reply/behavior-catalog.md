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
- Pref `alertPopup` still toggled from settings; watch/start remains Main-driven.
- Suppress rules (viewing same Space, minimized bar badge vs new Toast, etc.) stay in Main.

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
