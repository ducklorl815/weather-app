# Renderer 架構地圖

## 核心目標
`index.html` 只當**大框架（Shell）**；每個功能在「＋加入功能」時以 **Partial View** 載入。

## 目錄

```text
renderer/
├── shell/                 # 大框架
│   ├── shell.css          # 全域樣式
│   ├── partial-loader.js  # PartialViews.load(type)
│   └── app.js             # mosaic / auth / catalog / 暫存功能邏輯
└── features/
    ├── calendar/          # 預定行程
    ├── tasks/             # 待辦
    ├── gmail/             # 郵件
    ├── gchat/             # Little Reply
    ├── sheets/            # 9527
    ├── sitesVisits/       # 網站瀏覽紀錄
    └── chat/              # 詢問機器人
        ├── README.md
        ├── view.html      # ← 「加入功能」載入的 partial
        └── logic.js       # ← 功能邏輯（逐步下沉）
```

## 流程
1. 使用者按「＋加入功能」→ `addWidget(type)`
2. `renderMosaic` → `PartialViews.load(type)` → `features/<type>/view.html`
3. 注入 tile → 呼叫 `WIDGET_CATALOG[type].mount()`
