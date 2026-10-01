# 記事 uses Sheets one-file-per-note, not Google Keep API

**Status:** superseded by [ADR 0010](./0010-notes-embed-google-keep-webview.md) for the shipped 記事 UI.

Historically, 記事 was designed as Keep-style UI on Google Sheets + Drive ACL because the official Keep enterprise API cannot update note／checklist content after create. That Sheets MVP proved too slow on load; the product switched to embedding `keep.google.com` (ADR 0010). The Sheets module code may remain unregistered for reference.
