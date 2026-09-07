# Reply Bar Alert：置頂未 @ 走 Bar／Toast，不進 Inbox

Little Reply 要把「提醒我」從 Inbox 列表拆開：Reply Bar（最小 bar）是主要、可常駐的提醒捷徑；Toast 可對同一套優先事件叮一声，但仍受既有抑制／去重約束。

**Reply Bar Alert** 觸發：置頂 Space／置頂私人的他人新訊、所有私人新訊、群組 @我。沒有對應 bar 就新建；有就 badge＋1。群組顯示：Thread 內 → Focus Thread bar，標題 `{群組名} · {根訊息摘要}`；Space-level（最外層）→ 一般 bar，標題為群組名。同一空間可同時有空間 bar 與專注 bar。

**Inbox 不變窄**：Mosaic Inbox 仍以私人／@我為主，不因「置頂群組未 @」灌入列表。置頂未 @ 的未讀改由獨立監看路徑驅動 Bar／Toast（例如置頂空間輪詢／packet），而不是放寬 `isInboxGchatMessage`／Inbox snapshot。

## Considered Options

- 放寬 sync／Inbox，讓置頂群組未 @ 也進列表再走同一提醒管線：實作單純，但 Inbox 變吵，與「Inbox＝該處理的私人／@」衝突
- 只靠既有 minimized bar badge 輪詢、從不新建 bar：較省，但無法兌現「沒開過也要被提醒」
- Toast 維持只叮私人／@、Bar 才吃置頂閒聊：較不吵，但與「該出 Bar 也允許 Toast」的產品選擇不一致

## Consequences

提醒資格與 Inbox 列資格必須分開實作與測試。未來若覺得置頂太吵，應調 Alert／Toast 抑制或置頂集合，而不是先把未 @ 塞進 Inbox。
