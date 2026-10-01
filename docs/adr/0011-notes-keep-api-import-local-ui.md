# 記事: custom UI + Keep API import + local store

**記事** is LifeTour’s own checklist UI. Existing Google Keep notes are pulled in via the official Keep API (`notes.list`／`notes.get`) into a fast local store (`userData/notes-store.json`). Users edit checkboxes and titles in LifeTour; those edits are **not** written back to Keep because the official API has no note-content update method.

This supersedes ADR 0010 (Keep webview embed) and the heavy Sheets-on-every-load MVP. Keep remains the **import source**; LifeTour owns the working copy after import. Keep `permissions` may still be used when sharing an imported note’s Keep resource.

## Consequences

`FEATURE_SCOPE_MAP.notes` requires `https://www.googleapis.com/auth/keep`. Keep API access is Workspace／admin-oriented; consumer accounts may fail until the API is enabled and authorized. Real-time multi-device sync of LifeTour edits needs a later sync layer; local store is intentionally first for load speed.
