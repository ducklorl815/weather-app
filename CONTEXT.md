# LifeTour

Desktop productivity hub that integrates Google workspace features and internal tools. This glossary covers product language for the app. Active design work spans Little Reply and Google authorization / session.

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
The Mosaic tile list of Little Reply conversations the user should act on (unread and/or @mentions), not the full Google Chat history.
_Avoid_: Message List (as the canonical name), gchat-list (IPC only)

**Reply Pop**:
The dedicated BrowserWindow for reading a thread and sending a reply.
_Avoid_: compact window, bubble window, 精簡窗 (as the canonical English term); "bubble" when meaning the window (message bubbles in the thread UI are different)

**Reply Bar**:
The minimized strip window that stands in for a Reply Pop when the user collapses it.
_Avoid_: taskbar substitute, mini player

**Toast**:
The floating desktop alert for new Little Reply activity that can open a Reply Pop.
_Avoid_: notification (alone — OS notifications may differ), alert popup

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
A Reply Pop composer send that showed a local "me" bubble before the server accepted it; on failure the bubble stays visible, marked unsent, and can be retried.
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
