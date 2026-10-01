# Active Features gate background work (not Session alone)

Background work for Mosaic catalog features must follow **Active Feature** membership, not Google Session / OAuth scopes alone. The Renderer owns Mosaic layout and pushes an **Active Feature List** to Main; Main must not start (or keep) a feature’s background loops until that list says the feature is on. Restart with a feature absent from Mosaic must not revive its background.

**Feature Off** (remove tile) stops that feature’s background immediately. Little Reply Off is a full surface shutdown without Logout: stop sync scheduler, destroy Reply Pop／Reply Bar／Quick Search, clear in-memory／interest state as needed, disable related global shortcuts; Session and Credential remain. **Feature On** wakes background immediately (still subject to Feature Scope Gate). Toast／`alertPopup` prefs are unchanged by Off; they only apply while Little Reply is Active.

Meeting reminders are owned by **Calendar** Active membership and must not be hard-wired to the Gmail sync loop. Gmail Active controls mail sync only; Calendar Active controls meeting watch. Features without a background loop still participate in the list for a uniform gate.

## Considered Options

- Keep scheduler／sync tied to Session／auth (status quo): simple, but「沒加入功能」仍收密語／跑背景，與產品預期衝突
- Gate only Toast／alerts while sync keeps running: quieter UI, but background still “uses” the feature
- Persist a second enabled-features file in Main: Main can boot alone, but drifts from Mosaic and duplicates truth

## Consequences

Session bootstrap and OAuth success paths must not call `startSyncLoop`／`startGchatSyncScheduler`／`startMeetingWatch` until the Active Feature List allows it. `gchat-alert-watch(false)` is not Feature Off. Logout remains the only path that clears Credential.
