# 提醒點進去必須落到 Alert Anchor（串內只推 Focus Thread bar）

從 Reply Bar 或 Toast 打開對話時，使用者要直接看到觸發提醒的那則，而不是群組主時間軸的最後一則。我們把「最新觸發提醒的訊息」稱為 **Alert Anchor**，並規定：

- Anchor 在 API **Thread** 內 → **只**建立／更新 **Focus Thread** Reply Bar（不要同時再新建一條同群組的空間 bar）。開 Pop 時進 Focus Thread，並捲到該 Anchor（找不到再 firstUnread，再不行到底）。
- Anchor 在 **Space-level** → 開一般空間 Pop／Bar，jump 到該則（同樣 fallback）。
- 私人同理 jump／firstUnread。
- 若同空間的**空間 bar 本來就已存在**（使用者先前開過／縮過），其 pending Anchor 仍可指向串內訊息；點該空間 bar 時仍轉開對應 Focus Thread。串內**新提醒不得為了鏡像而額外生出**第二條空間 bar。
- 多個未讀串時，以 **最新一次 Alert** 的 Anchor 為準。

## Considered Options

- 串內提醒同時更新空間 bar＋專注 bar（曾採用）：點群組名 bar 較不易迷路，但右下角一次跳兩條，噪音大——已否決
- 只開整群並自動展開串：錨點易丟、實作重
- 空間 bar 點了只開整群、串內請點專注 bar：若空間 bar 本就存在仍可能點錯；故保留「已存在空間 bar → 可轉導」，但不新建

## Consequences

`mirrorExistingSpaceBarAlertAnchor` 僅在空間 bar 已存在時寫 pending Anchor；不得新建／加 badge。ADR-0004 的置頂提醒與本決策並存：串內仍只推 Focus Thread bar。
