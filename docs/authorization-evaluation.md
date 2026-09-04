# LifeTour Google 授權 — 現況評估文件

> 用途：供評估是否進行授權架構重構，以及優先順序決策。  
> 狀態：**部分已實作**（見下方差量）；原文 2026-09-02 盤點請當歷史  
> 掃描基準：`main/runtime.js`、`renderer/shell/app.js`、`preload.js`  
> 撰寫日期：2026-09-02  
> **詞彙／決策**：根目錄 `CONTEXT.md`；`docs/adr/0002-google-session-credential-probe-and-reconnect.md`；`docs/adr/0003-scope-registry-and-little-reply-scope-tiers.md`

---

## 差量（相對本文 2026-09-02 盤點）

| 主題 | 盤點當時 | 現行（止血階段） |
|---|---|---|
| hard auth 刪檔 | `ensureGoogleSession` 失敗 unlink | **不刪**；`AUTH_REVOKED` + Reconnect |
| `runCleanReauth` 清 token | 會刪檔再 OAuth | **已移除／不再清檔** |
| `forceReauth` 預設 | Renderer 功能授權預設 true | **已取消預設**；增量授權 |
| Reconnect UX | 黃條 → 登出重整 | **優先 `reconnect-google`（不刪 Credential）**；失敗才可選 Logout |
| 雙 userData | 未處理 | **Credential Path Probe**；空檔時自動從 `LifeTour`／`Electron` 備援複製 |
| 登入診斷 | 無 | 登入頁摘要 + 可展開細節（預設收合） |
| gchat scope 雙軌 | `hasChatScopes` 3 項 vs map 9 項 | **Scope Registry**：Core = gate／sync；Extended = 目錄／表情 |
| `main/authorization/` | 空 README | **仍未抽出服務**（刻意第二階段） |
| Token 加密 | 明文 | **仍明文**（不在本階段） |

**驗收（止血）**
- [ ] 授權一次後，開發／安裝版切換時，空目錄可自動還原 Credential（診斷可見 migratedFrom）
- [ ] 重開 App 不因「誤點登出重整」而整頁登入（失效改走重新連結）
- [ ] Little Reply 主路徑不因缺 directory／custom emoji 整頁 Gate
- [ ] Access token 過期仍走 refresh（既有）；hard revoke 不刪檔

---

## 一、Executive Summary

| 項目 | 結論 |
|---|---|
| 是否有 Token 持久化 | **有** — `%APPDATA%\LifeTour\google_token.json`（開發時亦可能曾在 `Electron`） |
| 設計上重開 App 是否應重新登入 | **不應該** — 啟動時讀檔 + refresh；可自備援目錄遷移 |
| 使用者實際感受（歷史） | 關 App 再開、或點功能時，常再次看到 Google 授權 |
| 主要根因（歷史） | Token 被刪除／refresh 失敗 + 功能層強制全量 OAuth + 雙 userData |
| 建議方向 | 止血（本差量）→ 再抽出 `main/authorization` 統一服務 |
| 預估工作量 | Phase 1 止血：進行中／已落地核心；完整重構：另案 |

---

## 二、目前授權邏輯（實際行為）

### 2.1 架構位置

```
Renderer (app.js)
  └─ window.api.checkLogin / authGoogleFeatures / reconnectGoogle / featureAuthStatus / logout
       └─ IPC
Main (runtime.js) — 授權邏輯集中於此，約 L81–4415
  ├─ oauth2Client（記憶體單例，App 重開歸零）
  ├─ sessionState（記憶體：authed / offline）
  ├─ google_token.json（磁碟持久化）
  └─ runFeaturesOAuth → runGoogleOAuthFlow（瀏覽器 OAuth）
```

規劃中的 `main/authorization/` 目錄**尚未實作**，僅有 README placeholder。

### 2.2 Token 存放

| 項目 | 位置 |
|---|---|
| Access Token | `oauth2Client.credentials` + `google_token.json` |
| Refresh Token | 同上 |
| 儲存方式 | 明文 JSON，路徑 `app.getPath('userData')/google_token.json` |
| 安全儲存 | **無**（未使用 Windows Credential Manager / keytar） |

### 2.3 App 啟動流程

```
app.whenReady
  → createWindow
  → startSessionWatch（每 60 秒檢查 session）

Renderer window.onload
  → check-login（IPC）
      → readTokensFromDisk()
          ├─ 無檔案 → needsAuth → 顯示登入畫面
          └─ 有檔案 → ensureGoogleSession()
              → oauth2Client.getAccessToken()（內部可 refresh）
              ├─ 成功 → showWorkspace()
              ├─ 網路錯誤 → offline，仍進工作台
              └─ hard auth 錯誤 → 刪除 google_token.json → needsAuth
```

### 2.4 使用者登入（第一次）

```
點「使用 Google 帳號登入並授權」
  → authGoogleFeatures({ types: 全部功能 })
  → runFeaturesOAuth()
  → 若缺 scope → runFullOAuth()（開瀏覽器）
  → localhost:3000/oauth2callback 收 code
  → getToken → finalizeOAuthCredentials → 寫入 google_token.json
  → showWorkspace()
```

### 2.5 功能內授權（已登入後）

```
各 Widget「授權」按鈕 / authorizeFeature()
  → authGoogleFeatures({ types: 全部功能, forceReauth: true })  ⚠️
  → runFullOAuth()（forceConsent: true，一定開瀏覽器）
  → 若 scope 仍不足 → runCleanReauth()
      → resetOAuthTokensOnly()（刪除 google_token.json）⚠️
      → 再全量 OAuth
```

### 2.6 支援的 Google 功能與 Scope

| 功能 | Scope（摘要） | 備註 |
|---|---|---|
| calendar | `auth/calendar` | — |
| tasks | `auth/tasks` | — |
| gmail | `gmail.modify` + contacts ×2 | contacts 與 gchat 重複 |
| gchat | Chat 7 項 + `directory.readonly` + `contacts.readonly` | 判定邏輯與實際 scope 不一致（見問題 #11） |
| sheets | `spreadsheets` + `drive.file` | — |
| sitesVisits | `spreadsheets` | 與 sheets 完全重複 |
| chat（Gemini） | `cloud-platform` | 範圍偏大 |

授權時已改為一次請求 `allApplicationScopes()`（全部 scope 合併去重），但 UI 文案仍寫「各功能分別授權」。

### 2.7 Logout

```
使用者確認登出
  → 刪除 google_token.json
  → 停止背景 sync
  → app.relaunch()
```

---

## 三、理想 vs 現況對照

| 情境 | 理想行為 | 目前實際 |
|---|---|---|
| 第一次使用 | Google OAuth → 存 refresh token | ✅ 大致符合 |
| App 重開 | 讀檔 + silent refresh，不開瀏覽器 | ⚠️ 設計有，但 token 常已不存在 |
| Access Token 過期 | refresh → retry API | ⚠️ 有 refresh，但 401 常直接 needsReauth |
| Refresh 失效 | 才要求重新 OAuth | ⚠️ 啟動時 hard auth 會直接刪檔 |
| 功能缺 scope | 增量補 scope | ❌ 常 forceReauth 全量 + 可能清 token |
| 使用者 Logout | 清 credential | ✅ 符合 |
| 統一授權服務 | 各功能共用 | ❌ 邏輯散落 runtime monolith |

---

## 四、遇到的問題

### 4.1 使用者可感知症狀

1. 關閉 App 再開啟，需重新 Google 授權
2. 使用某功能時再次跳出 Google 授權頁
3. 短時間內多次授權，Google 偶爾拒絕或要求等待
4. 已登入仍看到「需要授權」的功能閘道

### 4.2 根因分析

#### RC-1：啟動時 hard auth 失敗會刪除 Token 檔（Critical）

`ensureGoogleSession()` 遇到 `invalid_grant` 等錯誤時，會 `unlink(google_token.json)`。  
下一次啟動必然進登入畫面。

常見觸發：OAuth 同意畫面在 Testing 模式（refresh token 7 天失效）、使用者撤銷存取、refresh token 從未成功寫入。

#### RC-2：功能授權流程會主動清 Token（Critical）

`runCleanReauth()` → `resetOAuthTokensOnly()` 在 scope 驗證失敗時刪除 token 再全量 OAuth。  
若流程中斷或 scope 判定永遠不過，會陷入反覆授權。

#### RC-3：已登入仍強制全量 OAuth（High）

`authorizeFeature()` 固定帶 `forceReauth: true`，`runFullOAuth()` 固定 `forceConsent: true`。  
即使已有有效 credential，仍開瀏覽器走完整 consent 流程。

#### RC-4：Refresh Token 穩定性無保障（High）

Google 僅在首次 consent 保證回傳 refresh_token。  
後續 OAuth 若未 merge 成功，磁碟可能只有短期 access_token，過期後 refresh 失敗 → 觸發 RC-1。

#### RC-5：「登入」與「功能授權」UI 混淆（Medium）

- **登入畫面**：`checkLogin` 失敗（無 token）
- **功能閘道**：工作台內 `paintFeatureAuthGate`（有 token 但 scope 不足）

兩者對使用者都是「又要授權」，但技術路徑不同。

### 4.3 問題清單（依嚴重度）

| 等級 | # | 問題 |
|---|---|---|
| **Critical** | 1 | hard auth 時自動刪 token，無緩衝 |
| **Critical** | 2 | `runCleanReauth` 自動清 token |
| **Critical** | 3 | Token 明文存放 + Client Secret 硬編碼於原始碼 |
| **High** | 4 | `forceReauth: true` 預設於功能授權 |
| **High** | 5 | `forceConsent: true` 預設於每次全量 OAuth |
| **High** | 6 | API 401 / scope 不足直接 needsReauth，未先 refresh + retry |
| **High** | 7 | `logGchatApiIssue` 在 scope 不足時刪除 credential.scope |
| **High** | 8 | 授權邏輯全在 13k+ 行 runtime，難維護 |
| **Medium** | 9 | `hasChatScopes()` 驗 3 項，`isFeatureAuthorized('gchat')` 要 9 項 |
| **Medium** | 10 | sitesVisits 與 sheets scope 重複卻分開管理 |
| **Medium** | 11 | UI 文案與實作不一致（分別授權 vs 一次全授權） |
| **Low** | 12 | OAuth callback port 3000 固定，可能衝突 |
| **Low** | 13 | `main/authorization/` 空殼，架構與實作脫節 |

---

## 五、預計處理方案

### 5.1 目標架構（終態）

```
App
  └── GoogleAuthorizationService        ← 唯一授權入口
        ├── CredentialStore               ← 加密持久化（DPAPI / keytar）
        ├── TokenManager                  ← getValidAccessToken / refresh
        ├── ScopeRegistry                 ← 功能 ↔ scope 對照、去重、增量授權
        └── OAuthFlowCoordinator          ← 佇列化 browser flow

Google API Services（Gmail / Calendar / Chat / Sheets / …）
  └─ 只透過 TokenManager 取 token，不自行觸發 OAuth
```

### 5.2 分階段計畫

#### Phase 1：止血（建議優先，1–2 天）

**目標**：減少不必要 OAuth，讓「重開 App 不需再授權」盡快改善。

| 修改項 | 說明 |
|---|---|
| 移除 `authorizeFeature` 預設 `forceReauth: true` | 先查 `featureAuthStatus`，只缺 scope 才 OAuth |
| `runFullOAuth` 僅在無 refresh_token 時 `forceConsent` | 避免每次都 consent |
| 停用 `runCleanReauth` 自動刪 token | scope 不足改增量 OAuth，不 unlink |
| `ensureGoogleSession` hard auth 不立刻刪檔 | 標記 REVOKED，由 UI 引導使用者重新連結 |
| API 401 統一：refresh → retry → 才 needsReauth | 避免 access token 過期就開瀏覽器 |
| 修正 `logGchatApiIssue` 不刪 scope | 避免破壞本機 scope 紀錄 |

**風險**：低～中。不改架構，行為調整需完整回歸登入／各 Widget。

**驗收標準**：
- [ ] 授權一次後，24 小時內重開 App 不出現登入畫面
- [ ] 已授權功能點擊不再無故開瀏覽器
- [ ] Access token 過期後 API 自動 refresh，使用者無感

---

#### Phase 2：抽取授權服務（3–5 天）

**目標**：集中授權邏輯，為後續擴充打底。

| 修改項 | 說明 |
|---|---|
| 建立 `main/authorization/google-auth-service.js` | 從 runtime 搬移 OAuth / session / scope |
| 建立 `CredentialStore` | 封裝讀寫 `google_token.json` |
| 建立 `TokenManager` | 封裝 getAccessToken / refresh / expiry |
| 建立 `ScopeRegistry` | 統一 `FEATURE_SCOPE_MAP` + 去重 |
| runtime / GChat deps 改呼叫新 Service | 保持 IPC 介面不變 |

**風險**：中。搬移範圍大，需確保 GChat deps 注入正常。

**驗收標準**：
- [ ] runtime.js 授權相關程式 < 200 行（其餘 delegate）
- [ ] 所有 Google API 經同一 `getValidAccessToken()`
- [ ] 現有 IPC 介面向後相容

---

#### Phase 3：安全與長期治理（3–5 天）

**目標**：符合安全最佳實務，支援日後新 scope。

| 修改項 | 說明 |
|---|---|
| Token 加密儲存 | Electron `safeStorage` 或 keytar |
| Client Secret 移出原始碼 | 評估 Desktop PKCE |
| Logout 可選 revoke | 呼叫 Google revoke endpoint |
| 新 scope 增量授權流程 | 啟動檢測 missing → 提示補權限（非登入畫面） |
| 禁止 log token | lint / code review 規則 |
| 合併 sitesVisits scope 到 sheets | 減少 feature type 複雜度 |

**風險**：高（涉及 GCP OAuth client 設定變更）。

---

### 5.3 各情境處理方式（終態設計）

| 情境 | 處理 |
|---|---|
| A. 第一次登入 | OAuth（offline + consent）→ 存 refresh token |
| B. App 重開 | 讀 credential → silent refresh → 進工作台 |
| C. Access Token 過期 | refresh → 更新磁碟 → retry API |
| D. Refresh 失效 | 標記 REVOKED → UI 提示 → 使用者確認後才 OAuth |
| E. 使用者 Logout | revoke（可選）+ 清 credential + 停 sync |
| F. 功能缺 scope | 增量 OAuth 只請求缺少的 scope |
| G. 新版本新增 scope | 啟動檢測 → 提示「新功能需額外權限」→ 增量 OAuth |

---

## 六、決策建議

### 建議採納

| 決策 | 理由 |
|---|---|
| **先做 Phase 1** | 成本低、見效快，直接改善使用者「每次都要授權」的感受 |
| **Phase 2 與產品路線圖綁定** | 若近期還會加 Google 功能，應盡快抽 Service |
| **Phase 3 排入安全 backlog** | Client Secret 外洩風險存在，但不阻擋 Phase 1 |

### 可暫緩

| 項目 | 理由 |
|---|---|
| 改用 PKCE | 需改 GCP OAuth client 類型，影響範圍大 |
| 完全移除 `forceConsent` | 需確認 Testing → Production 發布狀態 |

### 需先確認的事項

1. **Google Cloud OAuth 同意畫面是否仍在 Testing？**  
   Testing 模式下 refresh token 7 天失效，可能是反覆授權的主因之一。

2. **是否可接受第一次登入就請求全部 scope？**  
   程式已實作，但 UI 仍寫「分別授權」— 需統一產品策略。

3. **`cloud-platform` scope 是否必要？**  
   Gemini Enterprise 用，範圍大，可評估是否改更細粒度 scope。

4. **重構期間是否允許短暫 dual-write token？**  
   Phase 2 搬移時可能需要相容舊 `google_token.json` 格式。

---

## 七、相關檔案索引

| 檔案 | 內容 |
|---|---|
| `main/runtime.js` L81–90 | OAuth 常數、redirect URI |
| `main/runtime.js` L106 | `tokenPath()` |
| `main/runtime.js` L636–684 | `FEATURE_SCOPE_MAP`、`allApplicationScopes()` |
| `main/runtime.js` L3665–3795 | `readTokensFromDisk`、`ensureGoogleSession` |
| `main/runtime.js` L4035–4367 | `runGoogleOAuthFlow`、`runFeaturesOAuth` |
| `main/runtime.js` L3615–3625 | `logout` IPC |
| `renderer/shell/app.js` L31–39 | 啟動 `checkLogin` |
| `renderer/shell/app.js` L670–738 | `loginGoogle`、`authorizeFeature` |
| `preload.js` L11–23 | IPC 橋接 |
| `main/authorization/README.md` | 規劃 placeholder（未實作） |

---

## 八、一句話結論

**程式已有 Token 持久化，但「刪 token + 強制全量 OAuth」的邏輯過於激進，導致使用者頻繁看到 Google 授權頁。**  
建議先執行 Phase 1 止血（1–2 天），再視產品節奏推進統一 `GoogleAuthorizationService` 重構。

---

*本文件僅供內部評估，實作前請確認 GCP OAuth 設定與產品授權策略。*
