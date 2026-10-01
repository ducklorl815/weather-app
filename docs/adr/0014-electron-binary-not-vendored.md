# Electron binary is not vendored

GitHub rejects files over 100MB. `node_modules/electron/dist/electron.exe` for Electron 28.3.3 is about 168MB, so a clone that expects the committed binary cannot run `npm start` after that file is removed, and putting it back would be rejected on push.

**Decision:** Do not commit `node_modules` or `electron.exe`. From this commit onward `node_modules/` is gitignored. A machine gets the Electron 28.3.3 binary by running Electron’s own `install.js` (also invoked as the package `postinstall` during `npm install`). Published history is left as-is; this is not a force-push rewrite.

## Considered Options

- Vendor `electron.exe` in git. Rejected: push hits GitHub’s 100MB limit.
- Rewrite already-pushed `2192` history to delete `node_modules` and force-push. Rejected for this change: stopping tracking at HEAD is enough for new checkouts to use `npm install`.

## Consequences

A fresh checkout has no `node_modules` until `npm install`. `dist` build outputs stay tracked. `dist/win-unpacked/LifeTour.exe` stays uncommitted because it also exceeds 100MB.
