# Keep OAuth scope blocked for LifeTour client

Google consent rejects `https://www.googleapis.com/auth/keep` for this app（「Some requested scopes cannot be shown」）. The Keep API／scope is aimed at approved Workspace enterprise integrations, not a typical installed OAuth client.

**Decision:** Do not request Keep scopes in Full Login or Feature Scope Gate. 記事 remains a local custom UI（`notes-store.json`）. Keep Import via official API is unavailable until／unless Google grants the scope to this client (unlikely for standard OAuth).

## Consequences

`FEATURE_SCOPE_MAP.notes` is empty. Users create lists in-app. ADR 0011’s Keep-import path is disabled at the auth layer; do not re-add `auth/keep` to consent without verifying the Cloud project can show that scope.
