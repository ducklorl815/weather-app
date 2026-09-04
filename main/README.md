# Main Process 架構地圖

```text
main.js                 ← 薄入口（大框架：啟動順序與模組註冊）
main/
├── runtime.js          ← 現行完整邏輯（搜尋 【MODULE: xxx】）
├── framework/          ← 生命週期／視窗／更新
├── authorization/      ← OAuth／權限（必須集中）
└── modules/            ← 各功能 IPC 實作（逐步自 runtime 拆出）
```

## 啟動順序
1. 環境／品牌設定
2. require runtime（或未來各 module.register）
3. app.whenReady → createWindow → load index.html shell
