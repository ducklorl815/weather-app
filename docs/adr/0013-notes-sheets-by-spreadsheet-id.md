# 記事 uses Sheets by spreadsheetId (not Drive listing)

記事 stores each 清單筆記 as one Google Spreadsheet. The local `notes-store.json` is only an **ID index**（titles／pin／color／role）so the list opens without scanning Drive or batching every sheet. Opening or saving a note calls Sheets APIs **only for that spreadsheetId**.

Sharing grants writer on that spreadsheet and tells the peer to **加入共享** with the Sheet ID／URL—discovery is ID-based, not `drive.files.list`.

This replaces Keep-import／webview approaches for collaboration data and avoids slow full-Drive fetches.

## Consequences

`FEATURE_SCOPE_MAP.notes` uses spreadsheets + drive.file (needed to create／share the sheet file). List latency should stay local; first open of a note still pays one Sheets get for that ID.
