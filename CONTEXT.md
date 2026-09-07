# LifeTour

Desktop productivity hub that integrates Google workspace features and internal tools. This glossary covers product language for the app. Active design work spans Little Reply (Reply Bar／Toast 提醒、@ 真提及／僅參考標籤), Google authorization / session, and 9527 Sheets Inbox.

## Language

### Google Authorization & Session

**Google Session**:
The app-level signed-in state: a usable Google credential exists (on disk and/or in memory) so the workspace can open without a full login screen. Missing feature scopes do not end the Session.
_Avoid_: treating every OAuth browser prompt as “logged out”; conflating Feature Scope Gate with Session loss

**Credential**:
The persisted Google OAuth tokens (access, refresh, granted scopes) stored as `google_token.json` under the app userData path. Only explicit Logout may delete the Credential file.
_Avoid_: calling the Credential “session” alone; assuming hard refresh failure deletes the file (it must not)

**Full Login**:
The first-time (or post-Logout) OAuth that requests the full application scope set so the user can use LifeTour’s Google features without immediately hitting gates.
_Avoid_: “sign in” when you only mean Incremental Auth; identity-only login as the product default (code comments that say base scopes only are outdated relative to this policy)

**Incremental Auth**:
A later OAuth that only requests scopes still missing for one or more features, without clearing the existing Credential.
_Avoid_: forceReauth / cleanReauth as the normal path; calling Incremental Auth “login”

**Feature Scope Gate**:
UI or API block when the Session is present but the feature’s required scopes are not all granted; resolved by Incremental Auth, not Logout.
_Avoid_: “needs login” copy when Credential still exists

**Reconnect**:
Recovery after refresh/hard auth failure while the Credential file is still kept (`AUTH_REVOKED`). Preferred path is a new OAuth / Full Login **without** deleting Credential first; Logout (clear file + relaunch) is an explicit fallback.
_Avoid_: silent token deletion; making Logout the default Reconnect action; calling Reconnect the same as Feature Scope Gate

**Scope Registry**:
The single source of truth for which OAuth scopes each feature needs (`FEATURE_SCOPE_MAP` and related helpers). Feature gates, API asserts, and sync checks must not invent parallel scope lists.
_Avoid_: `hasChatScopes`-only shortcuts that disagree with the registry; duplicating scope arrays in renderer copy

**Little Reply Core Scopes**:
The minimum Chat scopes required to run Inbox / Reply Pop main paths (messages, read state, space settings, and other registry-defined core entries).
_Avoid_: blocking the whole Little Reply surface when only extended scopes are missing

**Little Reply Extended Scopes**:
Optional Chat-related scopes (e.g. directory, contacts, custom emoji) requested at Full Login when possible, but enforceable via Incremental Auth only when that capability is used.
_Avoid_: treating extended gaps as Session loss or as a full Little Reply Feature Scope Gate

**Credential Path Probe**:
Startup/login diagnostics that show the active userData Credential path (details collapsed by default) and can detect another known directory that still has a Credential. If the active path has no Credential and a known alternate does, auto-copy into the active path and record the migrate in expandable diagnostics.
_Avoid_: silently switching the whole app userData root; forcing forever-shared dev/packaged userData without an explicit later decision; deleting the alternate copy as part of migrate

### Little Reply

**Little Reply**:
The LifeTour feature for Google Chat: an unread/@me Inbox in the mosaic, satellite reply surfaces (Reply Pop, Reply Bar, Toast, Quick Search), and the main-process sync, cache, and IPC that feed them.
_Avoid_: GChat (as a product name), Chat (alone — collides with AI Chat), Google Chat (as the in-app feature name)

**gchat**:
The technical prefix for Little Reply's code, IPC channels, and `main/modules/gchat` module. Not a user-facing name.
_Avoid_: using gchat in UI copy or product docs aimed at end users

**Inbox**:
The Mosaic tile list of Little Reply conversations the user should act on: primarily unread DMs and @mentions. It is **not** the full Google Chat history, and it does **not** list every unread message from a Pinned Space that did not @ the user.
_Avoid_: Message List (as the canonical name), gchat-list (IPC only); treating Inbox as the only place pinned activity appears

**Reply Pop**:
The dedicated BrowserWindow for reading a thread and sending a reply.
_Avoid_: compact window, bubble window, 精簡窗 (as the canonical English term); "bubble" when meaning the window (message bubbles in the thread UI are different)

**Reply Bar**:
The minimized strip at the corner of the screen that stands in for a Reply Pop: a lasting shortcut with an unread badge. Creating or updating a Reply Bar (and its badge) is the primary “remind me” surface for priority activity. Also called 最小 bar in product talk.
_Avoid_: taskbar substitute, mini player; calling Toast a Reply Bar

**Toast**:
The short-lived floating desktop alert for new Little Reply activity that can open a Reply Pop. Toast may fire for the same priority events as Reply Bar, but existing suppress／dedupe rules still apply (e.g. already viewing that conversation; often badge-only when a bar already exists).
_Avoid_: notification (alone — OS notifications may differ), alert popup; using “Toast” when you mean the lasting Reply Bar

**Reply Bar Alert**:
An event that should create a Reply Bar if none exists for that conversation target, or increment its badge if one exists: (1) any new message from others in a Pinned Space or pinned DM, (2) any DM, (3) a group message that @mentions me. Inbox membership is separate from Reply Bar Alert eligibility.
_Avoid_: conflating Alert with Inbox rows; “notification” alone

**Pinned Space**:
A Space or DM the user starred for watching. Unreads from a Pinned Space can drive Reply Bar／Toast even when they do not appear as Inbox rows (group traffic without @me).
_Avoid_: favorite (as canonical), pin chip (UI only)

**Space-level message**:
A group message that is not inside an API reply Thread (the “outer” space timeline). A Reply Bar Alert for it uses a normal (non–Focus Thread) Reply Bar titled with the Space display name.
_Avoid_: channel root, main chat (as canonical)

**Focus Thread**:
A Reply Pop／Reply Bar mode locked to one reply Thread in a group Space. When an @mention (or other Alert) lands in a Thread, the Reminder uses Focus Thread: bar title `{Space name} · {root snippet}`.
_Avoid_: 專注討論串 as a separate product from Focus Thread; opening the whole Space when the Alert was in-thread

**Alert Anchor**:
The concrete message (and its Thread, if any) that caused the latest Reply Bar Alert／Toast for a conversation target. Opening from Bar or Toast must land on this message when possible: Thread → Focus Thread Pop scrolled to the Anchor; Space-level → space Pop jumped to the Anchor (else firstUnread, else bottom). For in-thread Alerts, only a Focus Thread Reply Bar is created or badged—do not spawn a second space-level bar for the same Alert.
_Avoid_: “open the space” without an Anchor; treating badge count alone as enough to find the unread; mirroring every Thread Alert onto a new space-level bar

**Space**:
A Google Chat room or DM container identified by a space name; Little Reply opens threads inside a Space.
_Avoid_: room, channel (as canonical terms)

**Thread**:
A reply chain within a Space (or the space-level conversation when there is no separate thread id) shown in a Reply Pop.
_Avoid_: conversation (when you mean the concrete Thread entity), chat (alone)

**Packet**:
The cached Thread detail payload for a Space/Thread key (messages plus metadata) used to open and refresh a Reply Pop cache-first.
_Avoid_: snapshot (when you mean Packet), cache (alone — Inbox list cache is separate)

**Failed Optimistic Reply**:
A Reply Pop composer send that showed a local “me” bubble before the server accepted it; on failure the bubble stays visible, marked unsent, and can be retried.
_Avoid_: phantom message, fake bubble (as canonical terms)

**Cache Push**:
The Main→Renderer signal that Little Reply cache state changed; canonical channel is `gchat-cache-changed` for both Inbox and Reply Pop.
_Avoid_: treating `gchat-list-updated` as a separate semantic event after phase 1

**Toast Dedupe Owner**:
Main process is the only authority for whether a Little Reply Toast has already been shown for a track key; the renderer must not keep a second alerted-id set.
_Avoid_: dual dedupe, renderer-local alert memory (as the source of truth)

**Behavior Catalog**:
A post-change document of Little Reply's user-visible behavior and the logic behind it at `docs/little-reply/behavior-catalog.md`; main paths are detailed, other A+B+C surfaces are summarized. Architecture inventory lag is tracked in `docs/architecture/15-little-reply-doc-delta.md`.
_Avoid_: treating `docs/architecture/00–14` inventory notes as the behavior source of truth after phase 1

**真提及**:
In a group Space, an @ of a person who is a member of that Space. Sending it notifies them (Chat user-mention). UI chip is solid / accent.
_Avoid_: @ tag（含糊）, mention（未區分是否在群組）

**僅參考標籤**:
In a group Space, an @-shaped label for someone who is **not** in that Space. It is reference text only: looks like `@名字`, does **not** notify and must **not** invite them into the Space. UI chip is dashed / muted.
_Avoid_: 假 @, 無效 mention（易誤解成錯誤）；邀請（禁止由此路徑發生）

### 9527 Sheets Inbox

**9527**:
The LifeTour mosaic feature that shows an inbox of rows from the locked Google Spreadsheet used for IT request / issue tickets.
_Avoid_: Sheets (alone as the product name), Google Sheets inbox (as the in-app feature name)

**編號**:
The Google Sheets native 1-based row number of a ticket row. In the UI it is written as `#N` (for example `#8`). It identifies the row inside a sheet tab; it is not the filtered list position and not an API request serial.
_Avoid_: list index, 陣列 index, RequestNo / `9527-000…`（unless explicitly talking about the external API serial）
