/**
 * [Manual] 一次性拆分腳本：將巨型 index.html / main.js 收成大框架 + partial / modules。
 * 執行：node scripts/split-to-partials.js
 *
 * 目標：
 * - index.html 只留殼層（chrome / auth / mosaic / overlays）
 * - 各「加入功能」widget → renderer/features/<id>/view.html (+ logic.js)
 * - CSS / 共用 JS → renderer/shell/
 * - main.js 改為薄入口；現行邏輯搬到 main/runtime.js，並加上模組區段註解
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function write(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, 'utf8');
  console.log('write', path.relative(ROOT, file), `(${content.length} chars)`);
}

function extractBetween(src, startTag, endTag) {
  const s = src.indexOf(startTag);
  const e = src.indexOf(endTag, s + startTag.length);
  if (s < 0 || e < 0) throw new Error(`Cannot find ${startTag} ... ${endTag}`);
  return {
    before: src.slice(0, s),
    inner: src.slice(s + startTag.length, e),
    after: src.slice(e + endTag.length),
    start: s,
    end: e + endTag.length
  };
}

// ─── Widget partial bodies（與現行 WIDGET_CATALOG.body 對齊）───
const WIDGET_BODIES = {
  calendar: {
    title: '預定行程 (calendar)',
    body: '<div class="card-body" id="cal-list"></div>'
  },
  tasks: {
    title: '待辦事項 (tasks)',
    body: `<div class="card-body" id="task-list"></div>
                    <div class="task-input-area"><input type="text" id="new-task" class="task-input" placeholder="新增任務..."
                    onkeypress="if(event.key==='Enter') addTask()"><button class="add-btn" onclick="addTask()">+</button></div>`
  },
  gmail: {
    title: '未讀郵件 (gmail)',
    body: '<div class="filter-chips" id="mail-chips"></div><div class="card-body" id="gmail-list"></div>'
  },
  gchat: {
    title: 'Little Reply (gchat)',
    body: `<div class="gchat-panel">
                    <div class="gchat-search-row">
                        <input type="search" id="gchat-search-input" class="gchat-search-input" placeholder="搜尋姓名、分機、群組…"
                            oninput="onGchatSearchInput(event)" onkeydown="if(event.key==='Escape'){this.value='';onGchatSearchInput(event);}">
                    </div>
                    <div id="gchat-pinned-block" class="gchat-pinned-block"></div>
                    <div id="gchat-search-results" class="gchat-search-results" hidden></div>
                    <div class="card-body" id="gchat-list"></div>
                </div>`
  },
  sheets: {
    title: '9527 (sheets)',
    body: `<div class="sheets-filter-bar" id="sheets-filter-bar">
                        <div class="filter-chips sheets-filter-main" id="sheets-status-chips">
                            <button class="chip active" data-status="pending" onclick="event.stopPropagation(); setSheetsStatusFilter('pending')">待處理</button>
                            <button class="chip" data-status="all" onclick="event.stopPropagation(); setSheetsStatusFilter('all')">全部</button>
                        </div>
                        <div class="sheets-facet-inline" id="sheets-type-row"></div>
                        <div class="sheets-facet-inline" id="sheets-unit-row"></div>
                    </div>
                    <div class="sheets-facet-panel" id="sheets-facet-panel"></div>
                    <div class="card-body" id="sheets-list"></div>`
  },
  sitesVisits: {
    title: '網站瀏覽紀錄 (sitesVisits)',
    body: `<div class="filter-chips" id="sites-visits-chips"></div>
                    <div class="sites-visits-summary" id="sites-visits-summary"></div>
                    <div class="card-body" id="sites-visits-list"></div>`
  },
  chat: {
    title: '詢問機器人 (chat)',
    body: `
                    <div class="chat-root">
                    <div class="chat-wrap" id="chat-main">
                        <div class="chat-log" id="chat-log">
                            <div class="chat-bubble bot">先在設定填 SQL Server。提問時會先查 [erp].[dbo].[EMRequestForm] 的問題狀況（Situation）與解決方式（Process），再交給 Gemini 回答。</div>
                        </div>
                        <div class="chat-composer">
                            <textarea id="chat-input" placeholder="問知識庫一個問題..." onkeydown="onChatKey(event)"></textarea>
                            <button class="btn-primary" id="chat-send" onclick="sendChat()">送出</button>
                        </div>
                    </div>
                    <div class="chat-panel" id="chat-kb">
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                            <button class="btn-ghost" onclick="showChatView('chat')">← 對話</button>
                            <button class="btn-primary" onclick="addKnowledgeFiles()">加入檔案</button>
                        </div>
                        <div id="kb-list" class="card-body" style="padding:0;"></div>
                    </div>
                    <div class="chat-panel" id="chat-settings">
                        <button class="btn-ghost" onclick="showChatView('chat')" style="align-self:flex-start;">← 對話</button>
                        <label>SQL 連線字串</label>
                        <textarea id="sql-connection-string" placeholder="Server=192.168.1.10;Database=erp;User Id=帳號;Password=密碼;Encrypt=false;TrustServerCertificate=true;"></textarea>
                        <label>SQL Server（沒有連線字串時才填）</label>
                        <input type="text" id="sql-server" placeholder="例如 192.168.1.10 或 HOST\\SQLEXPRESS">
                        <label>連接埠</label>
                        <input type="text" id="sql-port" placeholder="1433">
                        <label>資料庫</label>
                        <input type="text" id="sql-database" placeholder="erp">
                        <label>資料表</label>
                        <input type="text" id="sql-table" placeholder="dbo.EMRequestForm">
                        <label>SQL 帳號</label>
                        <input type="text" id="sql-user" placeholder="資料庫登入帳號">
                        <label>SQL 密碼</label>
                        <input type="password" id="sql-password" placeholder="貼上密碼">
                        <label>Google Cloud 專案 ID（回答用）</label>
                        <input type="text" id="gemini-project" placeholder="例如 my-gcp-project">
                        <label>Gemini 區域</label>
                        <select id="gemini-location">
                            <option value="us-central1">us-central1</option>
                            <option value="global">global</option>
                            <option value="asia-east1">asia-east1</option>
                            <option value="asia-northeast1">asia-northeast1</option>
                            <option value="europe-west1">europe-west1</option>
                        </select>
                        <label>模型</label>
                        <input type="text" id="gemini-model" placeholder="gemini-2.5-flash">
                        <button class="btn-primary" onclick="saveGeminiSettings()">儲存設定</button>
                        <div class="loading" id="gemini-status" style="margin:0;padding:0;text-align:left;"></div>
                        <div class="loading" style="margin:0;padding:0;text-align:left;">提問會先用 SQL 查 EMRequestForm（Situation=問題狀況、Process=解決方式），再把結果交給 Gemini。連線帳密只存在本機。</div>
                    </div>
                    </div>`
  }
};

const FEATURE_META = {
  calendar: {
    summary: 'Google 日曆行程列表與建立行程。',
    mount: 'loadCalendar',
    mainModule: 'modules/calendar.js'
  },
  tasks: {
    summary: 'Google Tasks 待辦列表與新增／勾選。',
    mount: 'loadTasks',
    mainModule: 'modules/tasks.js'
  },
  gmail: {
    summary: 'Gmail 未讀列表、詳情、回覆。',
    mount: 'loadGmail',
    mainModule: 'modules/gmail.js'
  },
  gchat: {
    summary: 'Little Reply（Google Chat）列表、搜尋、釘選、泡泡回覆。',
    mount: 'loadGchat',
    mainModule: 'modules/gchat/'
  },
  sheets: {
    summary: '9527 試算表收件匣與篩選。',
    mount: 'loadSheets',
    mainModule: 'modules/sheets.js'
  },
  sitesVisits: {
    summary: 'Google Sites 瀏覽紀錄報表。',
    mount: 'loadSitesVisits',
    mainModule: 'modules/sites-visits.js'
  },
  chat: {
    summary: '詢問機器人（SQL 知識庫 + Gemini）。',
    mount: 'mountChat',
    mainModule: 'modules/ai-chat.js'
  }
};

function featureReadme(id) {
  const meta = FEATURE_META[id];
  const w = WIDGET_BODIES[id];
  return `# Feature: ${w.title}

## 說明
${meta.summary}

## 檔案
| 檔案 | 用途 |
|------|------|
| \`view.html\` | 「加入功能」後 mosaic tile 的 **partial view**（僅 body） |
| \`logic.js\` | 此功能的前端邏輯（由 shell 載入） |
| \`README.md\` | 本說明（人工維護入口） |

## 掛載
- Catalog type: \`${id}\`
- Mount 函式: \`${meta.mount}\`
- Main process: \`main/${meta.mainModule}\`（逐步自 runtime 拆出）

## [Important]
修改 \`view.html\` 內的 DOM id 時，必須同步檢查 \`logic.js\` 與 \`main\` IPC。
`;
}

function partialLoaderJs() {
  return `/**
 * ============================================================================
 * Partial View Loader（Shell 組件）
 * ----------------------------------------------------------------------------
 * [Important] 「＋加入功能」時，由此載入各 feature 的 view.html，
 * 不要再把 widget HTML 內嵌在巨型 index.html。
 *
 * 載入路徑：renderer/features/<type>/view.html
 * ============================================================================
 */
(function (global) {
  const cache = Object.create(null);
  const loading = Object.create(null);

  function partialUrl(type) {
    return new URL(\`renderer/features/\${type}/view.html\`, document.baseURI).href;
  }

  /**
   * 取得 widget body HTML（有快取）。
   * @param {string} type WIDGET_CATALOG key
   * @returns {Promise<string>}
   */
  async function loadFeaturePartial(type) {
    if (cache[type]) return cache[type];
    if (loading[type]) return loading[type];
    loading[type] = (async () => {
      const res = await fetch(partialUrl(type));
      if (!res.ok) throw new Error(\`無法載入功能畫面：\${type} (\${res.status})\`);
      const html = await res.text();
      // 去掉 HTML 註解區塊開頭說明，只留實際 markup（保留註解也可；此處全保留）
      cache[type] = html.trim();
      delete loading[type];
      return cache[type];
    })();
    return loading[type];
  }

  /** 預載目前已在 mosaic 的功能，加快啟動 */
  async function preloadPartials(types) {
    await Promise.all((types || []).map((t) => loadFeaturePartial(t).catch(() => null)));
  }

  global.PartialViews = {
    load: loadFeaturePartial,
    preload: preloadPartials,
    cache
  };
})(window);
`;
}

function cleanWidgetCatalog() {
  return `        // =====================================================================
        // [MODULE: Mosaic / WIDGET_CATALOG]
        // body 不內嵌於此；「加入功能」時載入 renderer/features/<type>/view.html
        // =====================================================================
        const WIDGET_CATALOG = {
            calendar: {
                title: '📅 預定行程',
                minW: 3, minH: 4, w: 4, h: 7,
                partial: true,
                extra: '<button class="add-btn" onclick="event.stopPropagation(); showCreateEventModal()">+</button>',
                mount: () => loadCalendar()
            },
            tasks: {
                title: '☑️ 待辦事項',
                minW: 3, minH: 4, w: 4, h: 7,
                partial: true,
                extra: '',
                mount: () => loadTasks()
            },
            gmail: {
                title: '📧 未讀郵件',
                minW: 3, minH: 4, w: 4, h: 7,
                partial: true,
                extra: '<span class="sync-hint" id="mail-sync-hint"></span>',
                mount: () => loadGmail()
            },
            gchat: {
                title: '💬 Little Reply',
                addLabel: '加入 Little Reply',
                minW: 3, minH: 4, w: 4, h: 7,
                partial: true,
                extra: '<span class="sync-hint" id="gchat-sync-hint"></span>',
                mount: () => loadGchat({ startPoll: true })
            },
            sheets: {
                title: '📋 9527',
                addLabel: '加入9527',
                minW: 3, minH: 4, w: 4, h: 8,
                partial: true,
                extra: '<span class="sync-hint" id="sheets-sync-hint"></span>',
                mount: () => loadSheets({ startPoll: true })
            },
            sitesVisits: {
                title: '🌐 網站瀏覽紀錄',
                minW: 4, minH: 4, w: 5, h: 7,
                partial: true,
                extra: '<span class="sync-hint" id="sites-visits-sync-hint"></span>',
                mount: () => loadSitesVisits({ startPoll: true })
            },
            chat: {
                title: '🤖 詢問機器人',
                minW: 4, minH: 5, w: 5, h: 8,
                partial: true,
                extra: \`<button class="link-btn" onclick="event.stopPropagation(); showChatView('kb')">資料庫</button>
                    <button class="link-btn" onclick="event.stopPropagation(); showChatView('settings')">設定</button>\`,
                mount: () => mountChat()
            }
        };
`;
}

function transformCatalogAndRender(script) {
  // 1) 以乾淨 catalog 取代整段 WIDGET_CATALOG（去掉內嵌 body HTML）
  const catStart = script.indexOf('        const WIDGET_CATALOG = {');
  const catEnd = script.indexOf('        let mosaicItems = [];');
  if (catStart < 0 || catEnd < 0 || catEnd <= catStart) {
    throw new Error('WIDGET_CATALOG block not found');
  }
  script = script.slice(0, catStart) + cleanWidgetCatalog() + '\n' + script.slice(catEnd);

  // 2) Replace renderMosaic with async partial loader version
  const renderStart = script.indexOf('        function renderMosaic({ mountType } = {}) {');
  if (renderStart < 0) throw new Error('renderMosaic not found');
  const renderEnd = script.indexOf('        function startMosaicDrag', renderStart);
  if (renderEnd < 0) throw new Error('startMosaicDrag not found after renderMosaic');

  const newRender = `        async function renderMosaic({ mountType } = {}) {
            const board = document.getElementById('mosaic');
            if (!mosaicItems.length) {
                board.innerHTML = \`<div class="mosaic-empty"><div>工作台還是空的</div><div>用左上角「加入功能」把日曆、待辦、郵件拼進來</div></div>\`;
                return;
            }
            const existing = new Set([...board.querySelectorAll('.tile')].map(el => el.dataset.type));
            if (board.querySelector('.mosaic-empty')) board.innerHTML = '';

            // [Important] 並行載入尚未掛上的 partial view
            const needTypes = mosaicItems
                .map(i => i.type)
                .filter(type => !document.getElementById('tile-' + type) && WIDGET_CATALOG[type]);
            const bodies = {};
            await Promise.all(needTypes.map(async (type) => {
                try {
                    bodies[type] = await window.PartialViews.load(type);
                } catch (err) {
                    console.error(err);
                    bodies[type] = \`<div class="card-body"><div class="loading">無法載入畫面：\${escapeHtml(err.message || String(err))}</div></div>\`;
                }
            }));

            for (const item of mosaicItems) {
                if (document.getElementById('tile-' + item.type)) continue;
                const def = WIDGET_CATALOG[item.type];
                if (!def) continue;
                const tile = document.createElement('div');
                tile.className = 'tile';
                tile.id = 'tile-' + item.type;
                tile.dataset.type = item.type;
                const bodyHtml = bodies[item.type] || '';
                tile.innerHTML = \`
                    <div class="tile-header" onpointerdown="startMosaicDrag(event, '\${item.type}', 'move')">
                        <span class="tile-title" ondblclick="event.stopPropagation(); refreshWidget('\${item.type}')" title="雙擊重新連線">\${def.title}</span>
                        \${def.extra || ''}
                        <button class="tile-remove" title="移除此功能" onclick="event.stopPropagation(); removeWidget('\${item.type}')">✕</button>
                    </div>
                    \${bodyHtml}
                    <div class="tile-resize" onpointerdown="startMosaicDrag(event, '\${item.type}', 'resize')"></div>
                \`;
                board.appendChild(tile);
                if (mountType === item.type || !existing.has(item.type)) def.mount?.();
            }

            [...board.querySelectorAll('.tile')].forEach(el => {
                if (!mosaicItems.some(i => i.type === el.dataset.type)) el.remove();
            });
            applyTileGeometry();
        }

`;
  script = script.slice(0, renderStart) + newRender + script.slice(renderEnd);

  // 3) addWidget / removeWidget / restoreMosaic → await partial render
  script = script.replace(
    `        function addWidget(type) {
            if (!isWidgetAvailable(type)) return;
            if (mosaicItems.some(i => i.type === type)) return;
            const def = WIDGET_CATALOG[type];
            const spot = findMosaicPlace(def.w, def.h);
            mosaicItems.push({ type, x: spot.x, y: spot.y, w: def.w, h: def.h });
            document.getElementById('add-menu').classList.remove('open');
            renderMosaic({ mountType: type });
            saveMosaic();
            ensureSessionForWidget().then(() => refreshWidget(type));
        }`,
    `        async function addWidget(type) {
            if (!isWidgetAvailable(type)) return;
            if (mosaicItems.some(i => i.type === type)) return;
            const def = WIDGET_CATALOG[type];
            const spot = findMosaicPlace(def.w, def.h);
            mosaicItems.push({ type, x: spot.x, y: spot.y, w: def.w, h: def.h });
            document.getElementById('add-menu').classList.remove('open');
            // [Important] 加入功能 = 載入對應 partial view 再掛上 mosaic
            await renderMosaic({ mountType: type });
            saveMosaic();
            ensureSessionForWidget().then(() => refreshWidget(type));
        }`
  );

  script = script.replace(
    `            compactMosaic();
            renderMosaic();
            saveMosaic();
        }

        function findMosaicPlace(w, h) {`,
    `            compactMosaic();
            renderMosaic().catch((err) => console.error(err));
            saveMosaic();
        }

        function findMosaicPlace(w, h) {`
  );

  script = script.replace(
    `            pruneUnavailableMosaicItems();
            renderMosaic();
            if (!restoreMosaic.bound) {`,
    `            pruneUnavailableMosaicItems();
            renderMosaic().catch((err) => console.error(err));
            if (!restoreMosaic.bound) {`
  );

  return script;
}

async function main() {
  const indexPath = path.join(ROOT, 'index.html');
  const mainPath = path.join(ROOT, 'main.js');
  const html = fs.readFileSync(indexPath, 'utf8');
  const mainJs = fs.readFileSync(mainPath, 'utf8');

  // Backup once
  const backupDir = path.join(ROOT, '.refactor-backup');
  ensureDir(backupDir);
  if (!fs.existsSync(path.join(backupDir, 'index.html'))) {
    fs.copyFileSync(indexPath, path.join(backupDir, 'index.html'));
    console.log('backup index.html');
  }
  if (!fs.existsSync(path.join(backupDir, 'main.js'))) {
    fs.copyFileSync(mainPath, path.join(backupDir, 'main.js'));
    console.log('backup main.js');
  }

  const style = extractBetween(html, '<style>', '</style>');
  const script = extractBetween(html, '<script>', '</script>');

  // Body chrome: between <body> and <script>
  const bodyStart = html.indexOf('<body>');
  const scriptTag = html.indexOf('<script>', bodyStart);
  const bodyChrome = html.slice(bodyStart + '<body>'.length, scriptTag).trim();

  // Write CSS
  write(
    path.join(ROOT, 'renderer/shell/shell.css'),
    `/**
 * ============================================================================
 * Shell CSS — 全域主題、layout、header、mosaic、共用元件
 * ----------------------------------------------------------------------------
 * Feature 專屬樣式目前仍集中於此（後續可再拆到 features/<id>/styles.css）。
 * [Important] 修改主題變數會影響所有功能。
 * ============================================================================
 */
` + style.inner
  );

  // Partial loader
  write(path.join(ROOT, 'renderer/shell/partial-loader.js'), partialLoaderJs());

  // Transform app script
  let appScript = script.inner;
  appScript = transformCatalogAndRender(appScript);

  write(
    path.join(ROOT, 'renderer/shell/app.js'),
    `/**
 * ============================================================================
 * Shell App JS — 登入閘道、mosaic 引擎、共用工具、WIDGET_CATALOG 註冊
 * ----------------------------------------------------------------------------
 * [Important]
 * - 這是「大框架」前端邏輯；各功能細節在 renderer/features/<id>/logic.js
 * - 「加入功能」透過 PartialViews.load(type) 載入 view.html
 *
 * 組織（搜尋這些標題即可跳轉）：
 * 1. Boot / Session
 * 2. Weather / Focus / Bug Report（header chrome）
 * 3. Auth / Workspace
 * 4. Mosaic / WIDGET_CATALOG / Dist Features
 * 5. Shared helpers
 * 6. Feature logic（暫仍同檔；逐步下沉到 features/*/logic.js）
 * 7. Theme / Settings / Update
 * ============================================================================
 */
` + appScript
  );

  // Feature partials + README
  for (const [id, def] of Object.entries(WIDGET_BODIES)) {
    const dir = path.join(ROOT, 'renderer/features', id);
    write(
      path.join(dir, 'view.html'),
      `<!--
  ============================================================================
  Partial View: ${def.title}
  ----------------------------------------------------------------------------
  [Important] 此檔由「＋加入功能」→ PartialViews.load('${id}') 載入，
  注入 mosaic tile 的 body 區域。請勿在 index.html 重複內嵌此 markup。
  修改 DOM id 請同步 logic / main IPC。
  ============================================================================
-->
${def.body.trim()}
`
    );
    write(path.join(dir, 'README.md'), featureReadme(id));
    // Placeholder logic file pointing maintainers
    write(
      path.join(dir, 'logic.js'),
      `/**
 * ============================================================================
 * Feature Logic: ${def.title}
 * ----------------------------------------------------------------------------
 * [TODO] 將 renderer/shell/app.js 中與此功能相關的函式逐步搬移到本檔。
 * 目前邏輯仍由 shell/app.js 提供（全域函式），本檔先保留組織入口。
 *
 * 掛載：WIDGET_CATALOG['${id}'].mount → ${FEATURE_META[id].mount}
 * Partial：view.html
 * Main：main/${FEATURE_META[id].mainModule}
 * ============================================================================
 */
(function () {
  // [Temporary] 佔位：避免未來 script 標籤 404；實作下沉後刪除此註解區塊。
  window.__featureReady = window.__featureReady || {};
  window.__featureReady['${id}'] = true;
})();
`
    );
  }

  // Renderer README
  write(
    path.join(ROOT, 'renderer/README.md'),
    `# Renderer 架構地圖

## 核心目標
\`index.html\` 只當**大框架（Shell）**；每個功能在「＋加入功能」時以 **Partial View** 載入。

## 目錄

\`\`\`text
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
\`\`\`

## 流程
1. 使用者按「＋加入功能」→ \`addWidget(type)\`
2. \`renderMosaic\` → \`PartialViews.load(type)\` → \`features/<type>/view.html\`
3. 注入 tile → 呼叫 \`WIDGET_CATALOG[type].mount()\`
`
  );

  // New slim index.html
  const slimIndex = `<!DOCTYPE html>
<html lang="zh-TW" data-theme="light">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LifeTour</title>
    <!--
      ============================================================================
      index.html = Application Shell（大框架）
      ----------------------------------------------------------------------------
      [Important] 本檔只放：文件頭、共用 chrome、auth、mosaic 空殼、overlays。
      各功能畫面請放到 renderer/features/<id>/view.html（Partial View）。
      不要再把數千行功能 markup / 邏輯塞回本檔。
      ============================================================================
    -->
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&display=swap">
    <link rel="stylesheet" href="renderer/shell/shell.css">
</head>

<body>
${bodyChrome}

    <!-- Shell：Partial loader → 功能邏輯佔位 → App 框架 -->
    <script src="renderer/shell/partial-loader.js"></script>
    <script src="renderer/features/calendar/logic.js"></script>
    <script src="renderer/features/tasks/logic.js"></script>
    <script src="renderer/features/gmail/logic.js"></script>
    <script src="renderer/features/gchat/logic.js"></script>
    <script src="renderer/features/sheets/logic.js"></script>
    <script src="renderer/features/sitesVisits/logic.js"></script>
    <script src="renderer/features/chat/logic.js"></script>
    <script src="renderer/shell/app.js"></script>
</body>

</html>
`;
  write(indexPath, slimIndex);

  // ─── main.js → thin entry + runtime ───
  const runtimePath = path.join(ROOT, 'main/runtime.js');
  const bannered = addMainSectionBanners(mainJs);
  write(
    runtimePath,
    `/**
 * ============================================================================
 * Main Runtime（主程序業務邏輯總集）
 * ----------------------------------------------------------------------------
 * [Important]
 * - 入口請看專案根目錄 main.js（薄框架）。
 * - 本檔為現行完整實作；請用下方【MODULE】標題搜尋功能區塊。
 * - 後續請把各【MODULE】搬到 main/modules/* 或 main/authorization/*，
 *   搬完後在 main.js 改為 require 該模組。
 * ============================================================================
 */
` + bannered
  );

  // Module README stubs
  const mainModules = [
    ['framework', 'App lifecycle、BrowserWindow、Tray、通用 IPC、Updater'],
    ['authorization', 'Google OAuth、Token、Feature scopes、Session'],
    ['modules/weather', '天氣 HTTP proxy IPC'],
    ['modules/tasks', 'Google Tasks IPC'],
    ['modules/calendar', 'Calendar IPC／會議提醒'],
    ['modules/gmail', 'Gmail 同步與 IPC'],
    ['modules/gchat', 'Chat API + 泡泡／Toast UI'],
    ['modules/sheets', '9527 試算表'],
    ['modules/bug-report', 'Bug／優化回報'],
    ['modules/sites-visits', 'Sites 瀏覽紀錄'],
    ['modules/ai-chat', 'Gemini／知識庫／chat-ask'],
    ['modules/report', '報表 SQL + Gemini']
  ];
  for (const [rel, desc] of mainModules) {
    write(
      path.join(ROOT, 'main', rel, 'README.md'),
      `# ${rel}

## 說明
${desc}

## 現況
實作仍集中在 \`main/runtime.js\` 對應【MODULE】區段。

## [TODO]
將 runtime 中本模組區段搬到此目錄的 \`.js\` 檔，並由根目錄 \`main.js\` \`require\` 註冊。
`
    );
  }

  write(
    path.join(ROOT, 'main/README.md'),
    `# Main Process 架構地圖

\`\`\`text
main.js                 ← 薄入口（大框架：啟動順序與模組註冊）
main/
├── runtime.js          ← 現行完整邏輯（搜尋 【MODULE: xxx】）
├── framework/          ← 生命週期／視窗／更新
├── authorization/      ← OAuth／權限（必須集中）
└── modules/            ← 各功能 IPC 實作（逐步自 runtime 拆出）
\`\`\`

## 啟動順序
1. 環境／品牌設定
2. require runtime（或未來各 module.register）
3. app.whenReady → createWindow → load index.html shell
`
  );

  write(
    mainPath,
    `/**
 * ============================================================================
 * main.js — Electron Main Process 大框架（薄入口）
 * ----------------------------------------------------------------------------
 * [Important]
 * 本檔只負責：啟動說明、模組掛載順序。業務實作在 main/runtime.js（與後續
 * main/modules/*）。請勿再把數千行功能邏輯直接堆回本檔。
 *
 * 對應前端：
 * - index.html              → Renderer Shell
 * - renderer/features/*/view.html → 「加入功能」Partial View
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// 1. Configuration / Local Environment
// ---------------------------------------------------------------------------
// UTF-8、品牌名稱等在 runtime 開頭處理。

// ---------------------------------------------------------------------------
// 2. Authorization / Modules / Framework（現行：單一 runtime）
// ---------------------------------------------------------------------------
// [Temporary] 完整邏輯暫由 runtime 載入；拆模組後改為：
//   require('./main/authorization/google-auth').register(...)
//   require('./main/modules/gmail').register(...)
//   ...
require('./main/runtime');

// ---------------------------------------------------------------------------
// 3. 架構地圖（人工維護）
// ---------------------------------------------------------------------------
// 詳見 main/README.md 與各子目錄 README.md
`
  );

  console.log('\\nDone. index.html shell + partials + main thin entry ready.');
}

function addMainSectionBanners(src) {
  // Insert searchable MODULE banners near known landmarks (first occurrence)
  const markers = [
    { needle: 'function createWindow ', banner: '【MODULE: framework/window】主視窗 BrowserWindow' },
    { needle: 'ipcMain.handle(\'fetch-weather\'', banner: '【MODULE: modules/weather】天氣' },
    { needle: 'ipcMain.handle(\'check-login\'', banner: '【MODULE: authorization】登入／Session／OAuth' },
    { needle: '// --- Google Sites', banner: '【MODULE: modules/sites-visits】Sites 瀏覽紀錄' },
    { needle: '// Tasks APIs', banner: '【MODULE: modules/tasks】Tasks' },
    { needle: 'ipcMain.handle(\'get-calendar\'', banner: '【MODULE: modules/calendar】Calendar' },
    { needle: 'ipcMain.handle(\'get-gmail\'', banner: '【MODULE: modules/gmail】Gmail IPC' },
    { needle: 'ipcMain.handle(\'gchat-get-prefs\'', banner: '【MODULE: modules/gchat】GChat 資料 IPC' },
    { needle: 'ipcMain.handle(\'chat-ask\'', banner: '【MODULE: modules/ai-chat】詢問機器人' },
    { needle: '// ─── GCP / Cloud Storage', banner: '【MODULE: framework/updater】自動更新' },
    { needle: 'function ensureTray', banner: '【MODULE: framework/tray】系統匣' },
    { needle: 'let replyPopBoundsStore', banner: '【MODULE: modules/gchat-ui】回覆泡泡／Toast／精簡窗' },
    { needle: 'const GOOGLE_CLIENT_ID', banner: '【MODULE: authorization/config】OAuth 常數（[Manual] 依環境調整）' },
    { needle: 'ipcMain.handle(\'bug-report', banner: '【MODULE: modules/bug-report】Bug 回報' }
  ];

  let out = src;
  for (const { needle, banner } of markers) {
    const idx = out.indexOf(needle);
    if (idx < 0) {
      console.warn('marker not found:', needle.slice(0, 40));
      continue;
    }
    // avoid double insert
    const guard = `// ========== ${banner} ==========`;
    if (out.includes(guard)) continue;
    out = out.slice(0, idx) + `\n${guard}\n` + out.slice(idx);
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
