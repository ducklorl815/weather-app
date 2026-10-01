# Per-user 記事 Index Spreadsheet and Pending Invite

Discovery of owned and shared 清單筆記 uses a per-user App-created private **記事 Index Spreadsheet** (Share Index), not Drive listing alone and not a single company-wide index. When an Owner shares by email, the app writes the peer’s index when `drive.file` allows; otherwise it records a **Pending Invite** and merges it the next time that Collaborator opens 記事.

`drive.file` cannot reliably see or write another user’s never-opened App files, so “push index only” would fail on first share. A company mega-sheet (9527-style) was rejected as the sole truth: it weakens Private Note isolation and conflates 記事 with inbox ops. Pure local index was rejected because reinstall／new device would lose “shared with me” discovery.

## Consequences

Share and first-open paths must implement Pending Invite merge. Personal **Note Color** and **Pinned Note** live on the viewer’s Share Index rows, not as shared fields on the Note Spreadsheet.
