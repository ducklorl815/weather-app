# 記事 replaces Tasks via Import then retire

**記事** is the long-term checklist product; Mosaic **Tasks** remains only during a transition. The original plan was: on first open of 記事, run **Tasks Import**, then prompt to remove Tasks.

**Update (product feedback):** auto Tasks Import on first open is **disabled**. Users create notes in 記事 directly; Tasks mosaic may still exist in parallel until an explicit cutover is chosen later. Import IPC may remain for a future manual action but must not run unsolicited.

Endless two-way sync with Tasks was rejected. Shipping without any migration path was accepted for now in favor of a quiet first-run.

## Consequences

Do not prompt or run `notes-import-tasks` on `loadNotes`. Full Login may still include `tasks` while Tasks remains in the catalog.
