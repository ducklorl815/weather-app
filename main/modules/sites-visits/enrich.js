/**
 * Sites 瀏覽紀錄 — ERP 同仁 enrichment、欄位定義、Excel 匯出
 */
const XLSX = require('xlsx');

function patchMssqlDiagnosticsChannel() {
  try {
    const dc = require('node:diagnostics_channel');
    if (typeof dc.tracingChannel === 'function') return;
    dc.tracingChannel = function (name) {
      return {
        start: dc.channel(`${name}:start`),
        end: dc.channel(`${name}:end`),
        asyncStart: dc.channel(`${name}:asyncStart`),
        asyncEnd: dc.channel(`${name}:asyncEnd`),
        error: dc.channel(`${name}:error`),
        hasSubscribers: false,
        subscribe() {},
        unsubscribe() {},
        traceSync(fn) { return fn(); },
        tracePromise(fn) { return Promise.resolve().then(() => fn()); },
        traceCallback(fn, position, context, thisArg, ...args) { return fn.apply(thisArg, args); }
      };
    };
  } catch (_) {}
}

function getMssql() {
  if (!getMssql._api) {
    patchMssqlDiagnosticsChannel();
    getMssql._api = require('mssql');
  }
  return getMssql._api;
}

const DEPT_ROOT_ID = '00000000-0000-0000-0000-000000000000';

const SITES_VISITS_COLUMN_DEFS = [
  { id: 'person', label: '信箱', group: '同仁', default: true },
  { id: 'empNo', label: '員編', group: '同仁', default: true },
  { id: 'empCode', label: '科威帳號', group: '同仁', default: false },
  { id: 'empName', label: '姓名', group: '同仁', default: true },
  { id: 'jobTitle', label: '職稱', group: '同仁', default: true },
  { id: 'jobDuty', label: '職務', group: '同仁', default: false },
  { id: 'dept', label: '部門', group: '同仁', default: true },
  { id: 'region', label: '地區', group: '同仁', default: true },
  { id: 'extension', label: '分機', group: '同仁', default: false },
  { id: 'deptPath', label: '組織路徑', group: '同仁', default: false },
  { id: 'project', label: '專案', group: '瀏覽', default: true },
  { id: 'lastAt', label: '最近活動', group: '瀏覽', default: true },
  { id: 'visits', label: '造訪', group: '瀏覽', default: true },
  { id: 'clicks', label: '點擊', group: '瀏覽', default: true },
  { id: 'links', label: '超連結', group: '瀏覽', default: true },
  { id: 'durationLabel', label: '總時間', group: '瀏覽', default: true }
];

const DEFAULT_ERP_CONNECTION_STRING = 'Data Source=tcp:DBA-ERP;Initial Catalog=erp;User ID=MasteR1;Password=MasteR1;Integrated Security=false;Pooling=TRUE;';

let erpPool = null;
let erpPoolKey = '';

function normalizeConnectionString(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (!/Encrypt\s*=/i.test(text)) text += (text.endsWith(';') ? '' : ';') + 'Encrypt=false';
  if (!/TrustServerCertificate\s*=/i.test(text)) text += ';TrustServerCertificate=true';
  return text;
}

async function getErpPool(connectionString) {
  const key = normalizeConnectionString(connectionString);
  if (!key) throw new Error('未設定 ERP 連線字串');
  if (erpPool && erpPoolKey === key) return erpPool;
  if (erpPool) {
    try { await erpPool.close(); } catch (_) {}
    erpPool = null;
  }
  erpPool = await getMssql().connect(key);
  erpPoolKey = key;
  return erpPool;
}

function defaultColumnPrefs() {
  return SITES_VISITS_COLUMN_DEFS.filter(c => c.default).map(c => c.id);
}

function normalizeColumnPrefs(prefs) {
  const valid = new Set(SITES_VISITS_COLUMN_DEFS.map(c => c.id));
  const list = Array.isArray(prefs) ? prefs.filter(id => valid.has(id)) : [];
  return list.length ? list : defaultColumnPrefs();
}

function normalizeGuid(id) {
  return String(id || '').trim().toLowerCase();
}

function extractEmail(person) {
  const text = String(person || '').trim();
  const m = text.match(/[\w.+-]+@[\w.-]+\.\w+/i);
  return m ? m[0].toLowerCase() : text.toLowerCase();
}

function buildDeptPath(deptId, deptMap) {
  const parts = [];
  let cur = normalizeGuid(deptId);
  const seen = new Set();
  while (cur && cur !== DEPT_ROOT_ID && !seen.has(cur)) {
    seen.add(cur);
    const d = deptMap.get(cur);
    if (!d) break;
    parts.unshift(d.deptName || d.shortName || '');
    cur = normalizeGuid(d.parentId);
  }
  return parts.filter(Boolean).join(' / ');
}

async function fetchEmployeesByEmails(connectionString, emails) {
  const unique = [...new Set((emails || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;

  const pool = await getErpPool(connectionString);
  const request = pool.request();
  const placeholders = unique.map((email, i) => {
    const key = `email${i}`;
    request.input(key, getMssql().NVarChar, email);
    return `@${key}`;
  });
  const query = `
    SELECT em.EmpNo AS EmpNo
          ,em.EmpCode AS EmpCode
          ,em.EmpName AS EmpName
          ,c1.CodeName AS JobTitle
          ,c2.CodeName AS JobDuty
          ,dept.DeptName AS DeptName
          ,em.EmpEmail AS EmpEmail
          ,em.Extension AS Extension
          ,lc.Name AS Region
          ,em.DeptMainID AS DeptMainID
      FROM erp.dbo.EmployeeMain em
      JOIN erp.dbo.CodeMain c1 ON c1.ID = em.CodeMainID
      JOIN erp.dbo.CodeMain c2 ON c2.ID = em.JobTitleID
      JOIN erp.dbo.DeptMain dept ON dept.ID = em.DeptMainID
      JOIN erp.dbo.LifeCompany lc ON lc.ID = dept.CompanyID
      WHERE em.EmpEmail IN (${placeholders.join(', ')})
        AND em.Enabled = 1
        AND em.Deleted = 0
        AND em.IsActive = 1
  `;
  const result = await request.query(query);
  for (const row of result.recordset || []) {
    const email = String(row.EmpEmail || '').trim().toLowerCase();
    if (!email) continue;
    map.set(email, {
      empNo: String(row.EmpNo || '').trim(),
      empCode: String(row.EmpCode || '').trim(),
      empName: String(row.EmpName || '').trim(),
      jobTitle: String(row.JobTitle || '').trim(),
      jobDuty: String(row.JobDuty || '').trim(),
      dept: String(row.DeptName || '').trim(),
      email,
      extension: String(row.Extension || '').trim(),
      region: String(row.Region || '').trim(),
      deptMainId: row.DeptMainID
    });
  }
  return map;
}

async function fetchDeptHierarchy(connectionString) {
  const pool = await getErpPool(connectionString);
  const result = await pool.request().query(`
    SELECT dept.ID AS Id
          ,DeptCode
          ,DeptName
          ,lc.Name AS Region
          ,ShortName
          ,detl.ParentDeptMainID AS ParentId
      FROM erp.dbo.DeptMain dept
      JOIN erp.dbo.LifeCompany lc ON lc.ID = dept.CompanyID
      --JOIN trdata.dbo.TRDEPT trdept ON trdept.DEPT_CD = dept.DeptCode AND trdept.STUS_CD = 'Y'
      JOIN erp.dbo.DeptMainDetl detl ON detl.DeptMainID = dept.ID
      WHERE dept.Enabled = 1
        AND dept.Deleted = 0
        AND lc.Enabled = 1
        AND lc.Deleted = 0
      ORDER BY lc.BranchCode
  `);
  const map = new Map();
  for (const row of result.recordset || []) {
    const id = normalizeGuid(row.Id);
    map.set(id, {
      id,
      deptCode: String(row.DeptCode || '').trim(),
      deptName: String(row.DeptName || '').trim(),
      region: String(row.Region || '').trim(),
      shortName: String(row.ShortName || '').trim(),
      parentId: row.ParentId
    });
  }
  return map;
}

function enrichSitesVisitsItems(items, employeeMap, deptMap) {
  return (items || []).map(item => {
    const email = extractEmail(item.person);
    const emp = employeeMap.get(email);
    const deptPath = emp?.deptMainId ? buildDeptPath(emp.deptMainId, deptMap) : '';
    return {
      ...item,
      email,
      empNo: emp?.empNo || '',
      empCode: emp?.empCode || '',
      empName: emp?.empName || '',
      jobTitle: emp?.jobTitle || '',
      jobDuty: emp?.jobDuty || '',
      dept: emp?.dept || '',
      region: emp?.region || '',
      extension: emp?.extension || '',
      deptPath,
      erpFound: !!emp
    };
  });
}

function getColumnValue(item, columnId) {
  switch (columnId) {
    case 'person': return item.person || item.email || '';
    case 'empNo': return item.empNo || '';
    case 'empCode': return item.empCode || '';
    case 'empName': return item.empName || '';
    case 'jobTitle': return item.jobTitle || '';
    case 'jobDuty': return item.jobDuty || '';
    case 'dept': return item.dept || '';
    case 'region': return item.region || '';
    case 'extension': return item.extension || '';
    case 'deptPath': return item.deptPath || '';
    case 'project': return item.project || '';
    case 'lastAt': return item.lastAt || '';
    case 'visits': return item.visits ?? 0;
    case 'clicks': return item.clicks ?? 0;
    case 'links': return item.links ?? 0;
    case 'durationLabel': return item.durationLabel || '0 秒';
    default: return '';
  }
}

function pct(part, total) {
  if (!total) return '0%';
  return `${(100 * part / total).toFixed(1)}%`;
}

function aggregateAnalysis(items, keyFn, unknownLabel) {
  const map = new Map();
  let totVisits = 0;
  let totClicks = 0;
  let totLinks = 0;
  let totSeconds = 0;
  for (const item of items || []) {
    const visits = Number(item.visits) || 0;
    const clicks = Number(item.clicks) || 0;
    const links = Number(item.links) || 0;
    const seconds = Number(item.totalSeconds) || 0;
    totVisits += visits;
    totClicks += clicks;
    totLinks += links;
    totSeconds += seconds;
    const name = String(keyFn(item) || '').trim() || unknownLabel;
    if (!map.has(name)) {
      map.set(name, { name, people: 0, visits: 0, clicks: 0, links: 0, totalSeconds: 0 });
    }
    const row = map.get(name);
    row.people += 1;
    row.visits += visits;
    row.clicks += clicks;
    row.links += links;
    row.totalSeconds += seconds;
  }
  const rows = [...map.values()].sort((a, b) => b.visits - a.visits || b.totalSeconds - a.totalSeconds);
  return { rows, totVisits, totClicks, totLinks, totSeconds };
}

function buildAnalysisRows(items, sectionTitle, keyFn, unknownLabel) {
  const { rows, totVisits, totClicks, totLinks, totSeconds } = aggregateAnalysis(items, keyFn, unknownLabel);
  const out = [
    [sectionTitle],
  ];
  out.push(['名稱', '人數', '造訪', '造訪占比', '點擊', '點擊占比', '超連結', '超連結占比', '總秒數', '時間占比']);
  for (const row of rows) {
    out.push([
      row.name,
      row.people,
      row.visits,
      pct(row.visits, totVisits),
      row.clicks,
      pct(row.clicks, totClicks),
      row.links,
      pct(row.links, totLinks),
      row.totalSeconds,
      pct(row.totalSeconds, totSeconds)
    ]);
  }
  out.push([]);
  out.push(['合計', items.length, totVisits, '100%', totClicks, '100%', totLinks, '100%', totSeconds, '100%']);
  return out;
}

function buildDataSheetRows(items, columnIds) {
  const defs = SITES_VISITS_COLUMN_DEFS;
  const cols = columnIds.map(id => defs.find(c => c.id === id)).filter(Boolean);
  const header = cols.map(c => c.label);
  const rows = (items || []).map(item => cols.map(c => getColumnValue(item, c.id)));
  return [header, ...rows];
}

function writeSitesVisitsExcel(filePath, items, columnIds) {
  const dataRows = buildDataSheetRows(items, columnIds);
  const analysisRows = [
  ...buildAnalysisRows(items, '各地區分析', i => i.region, '未知地區'),
  [],
  ...buildAnalysisRows(items, '各部門分析', i => i.dept, '未知部門')
  ];
  const wb = XLSX.utils.book_new();
  const dataSheet = XLSX.utils.aoa_to_sheet(dataRows);
  const analysisSheet = XLSX.utils.aoa_to_sheet(analysisRows);
  XLSX.utils.book_append_sheet(wb, dataSheet, '瀏覽資料');
  XLSX.utils.book_append_sheet(wb, analysisSheet, '分析報表');
  XLSX.writeFile(wb, filePath);
}

async function fetchDeptOrgList(connectionString) {
  const map = await fetchDeptHierarchy(connectionString);
  return [...map.values()];
}

function normalizeParentId(parentId) {
  const id = normalizeGuid(parentId);
  if (!id || id === DEPT_ROOT_ID) return DEPT_ROOT_ID;
  return String(parentId || '').trim();
}

function wouldCreateDeptCycle(flatList, deptId, newParentId) {
  const id = normalizeGuid(deptId);
  const targetParent = normalizeGuid(newParentId);
  if (!id) return true;
  if (id === targetParent) return true;
  const byId = new Map((flatList || []).map((d) => [normalizeGuid(d.id), d]));
  let cur = targetParent;
  const seen = new Set();
  while (cur && cur !== DEPT_ROOT_ID && !seen.has(cur)) {
    if (cur === id) return true;
    seen.add(cur);
    const node = byId.get(cur);
    cur = normalizeGuid(node?.parentId);
  }
  return false;
}

function buildDeptOrgTree(flatList) {
  const list = Array.isArray(flatList) ? flatList : [];
  const byId = new Map();
  for (const raw of list) {
    const id = normalizeGuid(raw.id);
    byId.set(id, {
      id,
      deptCode: raw.deptCode || '',
      deptName: raw.deptName || '',
      region: raw.region || '',
      shortName: raw.shortName || '',
      parentId: normalizeParentId(raw.parentId),
      children: []
    });
  }
  const roots = [];
  for (const node of byId.values()) {
    const pid = normalizeGuid(node.parentId);
    if (!pid || pid === DEPT_ROOT_ID || !byId.has(pid)) {
      roots.push(node);
    } else {
      byId.get(pid).children.push(node);
    }
  }
  const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
      const ra = String(a.region || '').localeCompare(String(b.region || ''), 'zh-Hant');
      if (ra) return ra;
      return String(a.deptName || a.shortName || '').localeCompare(String(b.deptName || b.shortName || ''), 'zh-Hant');
    });
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);
  return roots;
}

async function updateDeptParent(connectionString, deptId, newParentId) {
  const id = String(deptId || '').trim();
  if (!id) throw new Error('缺少部門 ID');
  const parentRaw = normalizeParentId(newParentId);
  const parentId = parentRaw === DEPT_ROOT_ID ? DEPT_ROOT_ID : String(newParentId || '').trim();
  const pool = await getErpPool(connectionString);
  const sql = getMssql();
  const request = pool.request();
  request.input('deptId', sql.UniqueIdentifier, id);
  request.input('parentId', sql.UniqueIdentifier, parentId);
  const result = await request.query(`
    UPDATE erp.dbo.DeptMainDetl
       SET ParentDeptMainID = @parentId
     WHERE DeptMainID = @deptId
  `);
  const affected = result?.rowsAffected?.[0] ?? 0;
  if (!affected) throw new Error('找不到可更新的部門明細（DeptMainDetl）');
  return { deptId: id, parentId };
}

function escapeHtmlExport(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildDeptOrgPathMap(flatList) {
  const byId = new Map((flatList || []).map((d) => [normalizeGuid(d.id), d]));
  const cache = new Map();
  const pathFor = (id) => {
    const key = normalizeGuid(id);
    if (cache.has(key)) return cache.get(key);
    const parts = [];
    let cur = key;
    const seen = new Set();
    while (cur && cur !== DEPT_ROOT_ID && !seen.has(cur)) {
      seen.add(cur);
      const n = byId.get(cur);
      if (!n) break;
      parts.unshift(n.deptName || n.shortName || n.deptCode || cur);
      cur = normalizeGuid(n.parentId);
    }
    const text = parts.join(' / ');
    cache.set(key, text);
    return text;
  };
  return { pathFor, depthFor: (id) => Math.max(0, pathFor(id).split(' / ').filter(Boolean).length) };
}

function renderDeptOrgNodeReadOnly(node) {
  const label = node.deptName || node.shortName || node.deptCode || node.id;
  const meta = [node.region, node.deptCode].filter(Boolean).join(' · ');
  return `
    <div class="dept-org-node">
      <span class="dept-org-node-name">${escapeHtmlExport(label)}</span>
      ${meta ? `<span class="dept-org-node-meta">${escapeHtmlExport(meta)}</span>` : ''}
    </div>`;
}

const DEPT_SLOT_GAP = 16;
const DEPT_SLOT_MIN = 120;
const DEPT_SLOT_MAX = 200;

function deptOrgNodeSlotWidth(node) {
  const label = node?.deptName || node?.shortName || node?.deptCode || '';
  const len = String(label).length;
  return Math.min(DEPT_SLOT_MAX, Math.max(DEPT_SLOT_MIN, Math.ceil(len * 13) + 28));
}

function computeDeptOrgSubtreeWidth(node) {
  const children = Array.isArray(node?.children) ? node.children : [];
  const selfW = deptOrgNodeSlotWidth(node);
  if (!children.length) return selfW;
  let total = 0;
  for (let i = 0; i < children.length; i += 1) {
    total += computeDeptOrgSubtreeWidth(children[i]);
    if (i > 0) total += DEPT_SLOT_GAP;
  }
  return Math.max(selfW, total);
}

function deptOrgSlotStyle(width) {
  const w = Math.ceil(width);
  return `flex:0 0 ${w}px;width:${w}px;min-width:${w}px;max-width:${w}px;`;
}

function renderDeptOrgChildColumnReadOnly(node) {
  const slotW = computeDeptOrgSubtreeWidth(node);
  const children = Array.isArray(node.children) ? node.children : [];
  const childrenHtml = children.length ? renderDeptOrgChildrenGroupReadOnly(children) : '';
  return `
    <div class="dept-org-tb-child-col" style="${deptOrgSlotStyle(slotW)}">
      <div class="dept-org-tb-v-link"></div>
      <div class="dept-org-tb-node-anchor">
        ${renderDeptOrgNodeReadOnly(node)}
        ${childrenHtml}
      </div>
    </div>`;
}

function renderDeptOrgChildrenGroupReadOnly(children) {
  return `
    <div class="dept-org-tb-children dept-org-tb-slot-children">
      <div class="dept-org-tb-v-stub"></div>
      <div class="dept-org-tb-h-stack${children.length === 1 ? ' is-single' : ''}">
        ${children.map((child) => renderDeptOrgChildColumnReadOnly(child)).join('')}
      </div>
    </div>`;
}

function renderDeptOrgBranchReadOnly(node) {
  const children = Array.isArray(node.children) ? node.children : [];
  const childrenHtml = children.length ? renderDeptOrgChildrenGroupReadOnly(children) : '';
  return `
    <div class="dept-org-tb-branch">
      <div class="dept-org-tb-node-slot">${renderDeptOrgNodeReadOnly(node)}</div>
      ${childrenHtml}
    </div>`;
}

function renderDeptOrgTreeHtml(tree) {
  if (!Array.isArray(tree) || !tree.length) {
    return '<div class="loading">尚無部門資料</div>';
  }
  return `<div class="dept-org-tb-forest">${tree.map((n) => renderDeptOrgBranchReadOnly(n)).join('')}</div>`;
}

const DEPT_ORG_EXPORT_CSS = `
:root {
  --bg: #f0f2f5;
  --panel: #ffffff;
  --text: #1a1815;
  --text-sub: #5c5650;
  --border: #d0d5dc;
  --accent: #2f5a8a;
  --connector: #4a90d9;
  --node-bg: #e8f0fa;
  --node-border: #4a90d9;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  min-height: 100%;
  font-family: "Segoe UI", "Microsoft JhengHei", sans-serif;
  background: var(--bg);
  color: var(--text);
}
.export-head {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  padding: 10px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}
.export-head h1 { margin: 0; font-size: 1.05rem; flex: 1; }
.export-meta { font-size: 0.78rem; color: var(--text-sub); }
.export-btn {
  border: 1px solid var(--border);
  background: var(--panel);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 0.82rem;
  cursor: pointer;
}
.export-btn:hover { background: #eef2f7; }
.zoom-label { font-size: 0.78rem; color: var(--text-sub); min-width: 48px; text-align: center; }
.canvas-wrap {
  overflow: auto;
  padding: 16px;
  background:
    radial-gradient(circle at 1px 1px, rgba(0, 0, 0, 0.04) 1px, transparent 0) 0 0 / 20px 20px,
    var(--bg);
  min-height: calc(100vh - 56px);
}
.canvas-inner {
  transform-origin: top center;
  padding: 24px 32px 48px;
  min-width: min-content;
  margin: 0 auto;
}
.dept-org-tb-forest {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: center;
  align-items: flex-start;
  gap: 48px;
}
.dept-org-tb-branch {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
}
.dept-org-tb-children {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.dept-org-tb-v-stub {
  width: 2px;
  height: 28px;
  background: var(--connector);
}
.dept-org-tb-h-stack {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: center;
  gap: 16px;
  position: relative;
  border-top: 2px solid var(--connector);
}
.dept-org-tb-h-stack.is-single { border-top-color: transparent; }
.dept-org-tb-child-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  flex: 0 0 auto;
  box-sizing: border-box;
}
.dept-org-tb-node-anchor {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}
.dept-org-tb-slot-children {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.dept-org-tb-child-col:first-child::before,
.dept-org-tb-child-col:last-child::before {
  content: '';
  position: absolute;
  top: -2px;
  height: 2px;
  background: var(--bg);
  z-index: 1;
}
.dept-org-tb-child-col:first-child::before { left: 0; right: 50%; }
.dept-org-tb-child-col:last-child::before { left: 50%; right: 0; }
.dept-org-tb-h-stack.is-single .dept-org-tb-child-col::before { display: none; }
.dept-org-tb-v-link {
  width: 2px;
  height: 28px;
  background: var(--connector);
  margin-top: -2px;
}
.dept-org-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 110px;
  max-width: 180px;
  padding: 10px 12px;
  border: 2px solid var(--node-border);
  border-radius: 6px;
  background: var(--node-bg);
  text-align: center;
  line-height: 1.35;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}
.dept-org-node-name {
  font-weight: 600;
  font-size: 0.86em;
  word-break: break-word;
}
.dept-org-node-meta {
  font-size: 0.72em;
  color: var(--text-sub);
  word-break: break-word;
}
.loading { text-align: center; padding: 48px; color: var(--text-sub); }
`;

function buildDeptOrgExportHtml({ tree, flat, rootId, exportedAt, zoom = 1 }) {
  const stamp = exportedAt || new Date().toLocaleString('zh-TW', { hour12: false });
  const count = Array.isArray(flat) ? flat.length : 0;
  const treeHtml = renderDeptOrgTreeHtml(tree || []);
  const safeZoom = Math.min(2.5, Math.max(0.25, Number(zoom) || 1));
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>部門組織 — ${escapeHtmlExport(stamp)}</title>
  <style>${DEPT_ORG_EXPORT_CSS}</style>
</head>
<body>
  <header class="export-head">
    <h1>部門組織</h1>
    <span class="export-meta">匯出 ${escapeHtmlExport(stamp)} · 共 ${count} 個部門 · 唯讀檢視</span>
    <button type="button" class="export-btn" onclick="zoomOut()">－</button>
    <span class="zoom-label" id="zoom-label">${Math.round(safeZoom * 100)}%</span>
    <button type="button" class="export-btn" onclick="zoomIn()">＋</button>
    <button type="button" class="export-btn" onclick="zoomReset()">重設</button>
  </header>
  <div class="canvas-wrap" id="canvas-wrap">
    <div class="canvas-inner" id="canvas-inner" style="transform:scale(${safeZoom})">
      ${treeHtml}
    </div>
  </div>
  <script>
    let zoom = ${safeZoom};
    function applyZoom() {
      const inner = document.getElementById('canvas-inner');
      const label = document.getElementById('zoom-label');
      if (inner) inner.style.transform = 'scale(' + zoom + ')';
      if (label) label.textContent = Math.round(zoom * 100) + '%';
    }
    function zoomIn() { zoom = Math.min(2.5, Math.round((zoom + 0.1) * 10) / 10); applyZoom(); }
    function zoomOut() { zoom = Math.max(0.25, Math.round((zoom - 0.1) * 10) / 10); applyZoom(); }
    function zoomReset() { zoom = 1; applyZoom(); }
    document.getElementById('canvas-wrap')?.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn(); else zoomOut();
    }, { passive: false });
  </script>
</body>
</html>`;
}

function writeDeptOrgExcel(filePath, flatList) {
  const { pathFor, depthFor } = buildDeptOrgPathMap(flatList);
  const rows = [
    ['階層', '組織路徑', '部門名稱', '部門代碼', '地區', '簡稱', '部門ID', '上層ID'],
    ...(flatList || []).map((d) => [
      depthFor(d.id),
      pathFor(d.id),
      d.deptName || '',
      d.deptCode || '',
      d.region || '',
      d.shortName || '',
      d.id || '',
      d.parentId || DEPT_ROOT_ID
    ])
  ];
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, sheet, '部門組織');
  XLSX.writeFile(wb, filePath);
}

function buildDeptOrgExportJson({ tree, flat, rootId, exportedAt, zoom }) {
  return JSON.stringify({
    version: 1,
    exportedAt: exportedAt || new Date().toISOString(),
    rootId: rootId || DEPT_ROOT_ID,
    zoom: zoom || 1,
    flat: flat || [],
    tree: tree || []
  }, null, 2);
}

module.exports = {
  SITES_VISITS_COLUMN_DEFS,
  DEFAULT_ERP_CONNECTION_STRING,
  DEPT_ROOT_ID,
  defaultColumnPrefs,
  normalizeColumnPrefs,
  fetchEmployeesByEmails,
  fetchDeptHierarchy,
  fetchDeptOrgList,
  buildDeptOrgTree,
  wouldCreateDeptCycle,
  updateDeptParent,
  renderDeptOrgTreeHtml,
  buildDeptOrgExportHtml,
  buildDeptOrgExportJson,
  writeDeptOrgExcel,
  enrichSitesVisitsItems,
  writeSitesVisitsExcel,
  getColumnValue
};
