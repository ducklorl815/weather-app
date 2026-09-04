# gchat-reply-pop components

Reply Pop shell: repo-root `gchat-reply-pop.html` (DOM only).

| File | Role |
|---|---|
| `styles.css` | UI styles |
| `state.js` | Shared runtime state (`var` globals for classic scripts) |
| `shell.js` | Header, minimize/restore, opening-scroll helpers, media lightbox |
| `thread-view.js` | Thread render, reactions, message HTML, scroll restore |
| `composer.js` | Mentions, attachments, send, Failed Optimistic Reply |
| `live-refresh.js` | Cache-first refresh, thread-ping, load/open |
| `app.js` | Boot: wire DOM/IPC, theme/font, call `load()` |

Load order is fixed in `gchat-reply-pop.html`. Further splits only when a surface is being changed (ADR 0001).
