'use strict';

/**
 * SQL 報表共用目錄（Google Sheet）
 * - 一個 Spreadsheet 存全部報表定義；email 邀請同記事
 * - 本機 report-export-store.json 只存 catalog 索引
 */

const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const CATALOG_TITLE_PREFIX = 'LifeTour SQL 報表 · ';
const META_SHEET = 'meta';
const REPORTS_SHEET = 'reports';
const COLLAB_SHEET = 'collaborators';
const REPORT_HEADERS = [
  'id', 'reportName', 'department', 'description', 'fileNameBase', 'sqlQuery',
  'outputType', 'outputConfigJson', 'overwriteMode', 'scheduleEnabled', 'scheduleJson',
  'dateParamsJson', 'enabled', 'lastRunAt', 'nextRunAt', 'lastStatus', 'lastError',
  'createdAt', 'updatedAt', 'updatedBy'
];
const COLLAB_HEADERS = ['email', 'addedAt', 'status'];

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function extractSpreadsheetId(input) {
  const text = String(input || '').trim();
  const m = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || text.match(/^([a-zA-Z0-9-_]{30,})$/);
  return m ? m[1] : '';
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(String(raw || ''));
  } catch (_) {
    return fallback;
  }
}

/** SQL 含換行，寫入 Sheet 易造成欄位錯位 → 一律 base64 */
function encodeSqlForSheet(sql) {
  return `b64:${Buffer.from(String(sql || ''), 'utf8').toString('base64')}`;
}

function decodeSqlFromSheet(raw) {
  const s = String(raw || '');
  if (s.startsWith('b64:')) {
    try {
      return Buffer.from(s.slice(4), 'base64').toString('utf8');
    } catch (_) {
      return '';
    }
  }
  return s;
}

function looksLikeSql(text) {
  return /\b(SELECT|DECLARE|USE)\b/i.test(String(text || ''));
}

function normalizeReportFields(report) {
  if (!report || typeof report !== 'object') return null;
  const OVERWRITE = ['Overwrite', 'AppendTimestamp', 'FailIfExists'];
  const OUT = ['Local', 'GoogleDrive'];
  const r = { ...report };

  // 修復：SQL 被錯放到 outputType
  if (looksLikeSql(r.outputType)) {
    if (!looksLikeSql(r.sqlQuery) || String(r.sqlQuery || '').length < String(r.outputType).length) {
      r.sqlQuery = r.outputType;
    }
    const maybeCfg = typeof r.overwriteMode === 'string' && r.overwriteMode.trim().startsWith('{')
      ? safeJsonParse(r.overwriteMode, null)
      : null;
    if (maybeCfg && typeof maybeCfg === 'object') {
      r.outputConfig = { ...(r.outputConfig || {}), ...maybeCfg };
    }
    r.outputType = r.outputConfig?.folderId ? 'GoogleDrive' : 'Local';
    r.overwriteMode = 'Overwrite';
  }

  // 修復：overwriteMode 變成 JSON
  if (typeof r.overwriteMode === 'string' && r.overwriteMode.trim().startsWith('{')) {
    const maybeCfg = safeJsonParse(r.overwriteMode, null);
    if (maybeCfg && typeof maybeCfg === 'object') {
      r.outputConfig = { ...(maybeCfg || {}), ...(r.outputConfig || {}) };
    }
    r.overwriteMode = 'Overwrite';
  }

  if (typeof r.outputConfig === 'string') {
    r.outputConfig = safeJsonParse(r.outputConfig, {});
  }
  if (!r.outputConfig || typeof r.outputConfig !== 'object') r.outputConfig = {};

  if (!OUT.includes(r.outputType)) {
    r.outputType = r.outputConfig.folderId ? 'GoogleDrive' : 'Local';
  }
  if (!OVERWRITE.includes(r.overwriteMode)) r.overwriteMode = 'Overwrite';
  if (!r.id) return null;
  return r;
}

function createSheetCatalog(deps) {
  const {
    app,
    fs,
    path,
    repo,
    getSheetsService,
    getDriveService,
    withGoogleApiRetry,
    grantedScopeText,
    hasSheetsScope,
    hasDriveFileScope,
    quoteSheetRange,
    resolveMyEmail
  } = deps;

  function storePath() {
    return path.join(app.getPath('userData'), 'report-export-store.json');
  }

  function loadStore() {
    try {
      if (fs.existsSync(storePath())) {
        const data = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
        if (data && typeof data === 'object') {
          return { schemaVersion: SCHEMA_VERSION, catalog: data.catalog || null };
        }
      }
    } catch (_) {}
    return { schemaVersion: SCHEMA_VERSION, catalog: null };
  }

  function saveStore(store) {
    const next = { schemaVersion: SCHEMA_VERSION, catalog: store.catalog || null };
    fs.writeFileSync(storePath(), JSON.stringify(next, null, 2));
    return next;
  }

  function getCatalog() {
    return loadStore().catalog;
  }

  function clearCatalogIndex() {
    const store = loadStore();
    store.catalog = null;
    saveStore(store);
  }

  function isMissingDriveFileError(err) {
    const msg = String(err?.message || err || '');
    const code = err?.code || err?.status || err?.response?.status;
    return code === 404
      || /File not found|not found|Requested entity was not found|404/i.test(msg);
  }

  async function probeCatalogExists(spreadsheetId) {
    const id = String(spreadsheetId || '').trim();
    if (!id) return false;
    const { driveService } = await assertSheetsReady();
    try {
      const res = await withGoogleApiRetry(() => driveService.files.get({
        fileId: id,
        fields: 'id,trashed'
      }));
      if (res.data?.trashed) return false;
      return true;
    } catch (err) {
      if (isMissingDriveFileError(err)) return false;
      throw err;
    }
  }

  async function assertSheetsReady() {
    const sheetsService = getSheetsService?.();
    const driveService = getDriveService?.();
    if (!sheetsService || !driveService) {
      const err = new Error('請先用 Google 登入');
      err.needsAuth = true;
      throw err;
    }
    const scope = typeof grantedScopeText === 'function' ? await grantedScopeText() : '';
    if (!hasSheetsScope?.(scope) || !hasDriveFileScope?.(scope)) {
      const err = new Error('報表共用需要 Google 試算表與雲端硬碟（drive.file）權限');
      err.featureScopeMissing = true;
      err.needsAuth = true;
      throw err;
    }
    return { sheetsService, driveService };
  }

  function withJoinTimeout(promise, ms = 20000) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('連線逾時：無法讀取試算表，請確認 Sheet ID、網路與權限後再試')), ms);
      })
    ]);
  }

  function friendlyJoinError(err) {
    const msg = String(err?.message || err || '');
    const status = Number(err?.code || err?.status || err?.response?.status || 0);
    if (status === 404 || /not found|Requested entity was not found/i.test(msg)) {
      return '找不到此試算表，或您沒有存取權限。請確認 Sheet ID，並請 Owner 先邀請您的 Google 帳號。';
    }
    if (/Unable to parse range|Unable to parse|not found within/i.test(msg)) {
      return '此試算表不是 LifeTour「SQL 報表」共用庫格式（需有 meta、reports 工作表）。請向分享者索取正確的報表庫 Sheet ID。';
    }
    if (/逾時|timeout|ETIMEDOUT/i.test(msg)) {
      return msg.includes('連線逾時') ? msg : '連線逾時，導入已取消，未寫入本機。';
    }
    if (/權限|permission|forbidden|403/i.test(msg) || status === 403) {
      return '沒有此試算表的權限。請請 Owner 用 email 邀請後再加入。';
    }
    if (err?.invalidSheet) return msg;
    return msg || '加入失敗，未寫入本機。';
  }

  /** 嚴格驗證 SQL 報表共用庫；失敗不寫本機 */
  async function assertValidCatalogSpreadsheet(spreadsheetId) {
    const { sheetsService } = await assertSheetsReady();
    const metaRes = await withJoinTimeout(withGoogleApiRetry(() => sheetsService.spreadsheets.get({
      spreadsheetId,
      fields: 'spreadsheetId,properties/title,sheets/properties/title'
    })));
    const titles = new Set(
      (metaRes.data?.sheets || []).map((s) => String(s.properties?.title || ''))
    );
    if (!titles.has(META_SHEET) || !titles.has(REPORTS_SHEET)) {
      const err = new Error('此試算表不是 LifeTour「SQL 報表」共用庫（需有 meta、reports 工作表）');
      err.invalidSheet = true;
      throw err;
    }
    const meta = await withJoinTimeout(readMeta(sheetsService, spreadsheetId));
    if (!String(meta.catalogId || '').trim()) {
      const err = new Error('此試算表缺少報表庫識別（catalogId），可能加錯 Sheet。請向分享者索取正確的「SQL 報表共用庫」Sheet ID（不是記事或其他試算表）。');
      err.invalidSheet = true;
      throw err;
    }
    // 試讀報表列；失敗＝格式不對
    const reports = await withJoinTimeout(readAllReports(sheetsService, spreadsheetId));
    const collaborators = titles.has(COLLAB_SHEET)
      ? await withJoinTimeout(readCollaborators(sheetsService, spreadsheetId))
      : [];
    return { meta, reports, collaborators, sheetsService };
  }

  async function valuesGet(sheetsService, spreadsheetId, sheetName, a1) {
    const res = await withGoogleApiRetry(() => sheetsService.spreadsheets.values.get({
      spreadsheetId,
      range: quoteSheetRange(sheetName, a1)
    }));
    return res.data.values || [];
  }

  async function valuesUpdate(sheetsService, spreadsheetId, sheetName, a1, values) {
    await withGoogleApiRetry(() => sheetsService.spreadsheets.values.update({
      spreadsheetId,
      range: quoteSheetRange(sheetName, a1),
      valueInputOption: 'RAW',
      requestBody: { values }
    }));
  }

  async function valuesClear(sheetsService, spreadsheetId, sheetName, a1) {
    await withGoogleApiRetry(() => sheetsService.spreadsheets.values.clear({
      spreadsheetId,
      range: quoteSheetRange(sheetName, a1)
    }));
  }

  function metaMapFromRows(rows) {
    const map = {};
    for (const row of rows || []) {
      const k = String(row[0] || '').trim();
      if (k) map[k] = String(row[1] ?? '');
    }
    return map;
  }

  async function readMeta(sheetsService, spreadsheetId) {
    const rows = await valuesGet(sheetsService, spreadsheetId, META_SHEET, 'A:B');
    return metaMapFromRows(rows);
  }

  async function writeMeta(sheetsService, spreadsheetId, meta) {
    const rows = Object.entries(meta).map(([k, v]) => [k, String(v ?? '')]);
    await valuesClear(sheetsService, spreadsheetId, META_SHEET, 'A:B');
    if (rows.length) await valuesUpdate(sheetsService, spreadsheetId, META_SHEET, 'A1', rows);
  }

  async function readCollaborators(sheetsService, spreadsheetId) {
    const rows = await valuesGet(sheetsService, spreadsheetId, COLLAB_SHEET, 'A:C');
    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const email = String(rows[i]?.[0] || '').trim().toLowerCase();
      const status = String(rows[i]?.[2] || 'active');
      if (email && status !== 'revoked') list.push(email);
    }
    return list;
  }

  async function writeCollaborators(sheetsService, spreadsheetId, emails) {
    const rows = [COLLAB_HEADERS, ...[...new Set(emails)].map((em) => [em, new Date().toISOString(), 'active'])];
    await valuesClear(sheetsService, spreadsheetId, COLLAB_SHEET, 'A:C');
    await valuesUpdate(sheetsService, spreadsheetId, COLLAB_SHEET, 'A1', rows);
  }

  function reportToRow(report, updatedBy) {
    return [
      report.id,
      report.reportName || '',
      report.department || '',
      report.description || '',
      report.fileNameBase || '',
      encodeSqlForSheet(report.sqlQuery || ''),
      report.outputType || 'Local',
      JSON.stringify(report.outputConfig || {}),
      report.overwriteMode || 'Overwrite',
      report.scheduleEnabled ? 'true' : 'false',
      JSON.stringify(report.schedule || null),
      JSON.stringify(report.dateParams || { mode: 'None' }),
      report.enabled === false ? 'false' : 'true',
      report.lastRunAt || '',
      report.nextRunAt || '',
      report.lastStatus || '',
      report.lastError || '',
      report.createdAt || '',
      report.updatedAt || '',
      updatedBy || ''
    ];
  }

  function rowToReport(row) {
    if (!row?.[0]) return null;
    return normalizeReportFields({
      id: String(row[0]),
      reportName: String(row[1] || ''),
      department: String(row[2] || ''),
      description: String(row[3] || ''),
      fileNameBase: String(row[4] || ''),
      sqlQuery: decodeSqlFromSheet(row[5]),
      outputType: String(row[6] || 'Local'),
      outputConfig: safeJsonParse(row[7], {}),
      overwriteMode: String(row[8] || 'Overwrite'),
      scheduleEnabled: String(row[9]) === 'true',
      schedule: safeJsonParse(row[10], null),
      dateParams: safeJsonParse(row[11], { mode: 'None' }),
      enabled: String(row[12]) !== 'false',
      lastRunAt: row[13] || null,
      nextRunAt: row[14] || null,
      lastStatus: row[15] || null,
      lastError: row[16] || null,
      createdAt: row[17] || null,
      updatedAt: row[18] || null,
      updatedBy: row[19] || ''
    });
  }

  async function readAllReports(sheetsService, spreadsheetId) {
    const rows = await valuesGet(sheetsService, spreadsheetId, REPORTS_SHEET, 'A:T');
    const reports = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rowToReport(rows[i]);
      if (r) reports.push(r);
    }
    return reports;
  }

  function dedupeReportsById(reports) {
    const map = new Map();
    for (const r of reports || []) {
      if (!r?.id) continue;
      map.set(r.id, r);
    }
    return [...map.values()];
  }

  async function writeAllReports(sheetsService, spreadsheetId, reports, updatedBy) {
    // [Important] 共用庫只放啟用中的報表，避免「停用後再建同名」在 Sheet 看起來像重複
    const active = dedupeReportsById(reports).filter((r) => r.enabled !== false);
    const rows = [REPORT_HEADERS, ...active.map((r) => reportToRow(r, updatedBy))];
    await valuesClear(sheetsService, spreadsheetId, REPORTS_SHEET, 'A:T');
    await valuesUpdate(sheetsService, spreadsheetId, REPORTS_SHEET, 'A1', rows);
  }

  async function createCatalogSpreadsheet(ownerEmail) {
    const { sheetsService, driveService } = await assertSheetsReady();
    const catalogId = newId('cat');
    const now = new Date().toISOString();
    const created = await withGoogleApiRetry(() => sheetsService.spreadsheets.create({
      requestBody: {
        properties: {
          title: `${CATALOG_TITLE_PREFIX}共用報表`.slice(0, 80),
          locale: 'zh_TW'
        },
        sheets: [
          { properties: { title: META_SHEET } },
          { properties: { title: REPORTS_SHEET } },
          { properties: { title: COLLAB_SHEET } }
        ]
      }
    }));
    const spreadsheetId = created.data.spreadsheetId;
    // 放到 我的雲端硬碟/LifeTourTools/SQL報表
    let folderPath = 'LifeTourTools/SQL報表';
    try {
      const { createLifeTourDriveFolders } = require('../../common/lifetour-drive-folders');
      const folders = createLifeTourDriveFolders({
        getDriveService: () => driveService,
        withGoogleApiRetry
      });
      const sqlFolder = await folders.ensureSqlReportsFolder();
      await folders.moveFileToFolder(spreadsheetId, sqlFolder.folderId);
      folderPath = sqlFolder.path;
    } catch (err) {
      console.warn('[report-export] move to LifeTourTools/SQL報表 failed', err?.message || err);
    }
    await writeMeta(sheetsService, spreadsheetId, {
      schemaVersion: String(SCHEMA_VERSION),
      catalogId,
      title: '共用 SQL 報表',
      ownerEmail: ownerEmail || '',
      folderPath,
      createdAt: now,
      updatedAt: now
    });
    await valuesUpdate(sheetsService, spreadsheetId, REPORTS_SHEET, 'A1', [REPORT_HEADERS]);
    await valuesUpdate(sheetsService, spreadsheetId, COLLAB_SHEET, 'A1', [COLLAB_HEADERS]);
    return { catalogId, spreadsheetId, updatedAt: now, folderPath };
  }

  /** 已有 catalog 時，盡量移到標準資料夾；檔案已刪除則清掉本機索引 */
  async function ensureCatalogInStandardFolder() {
    const cat = getCatalog();
    if (!cat?.spreadsheetId) return { moved: false };
    try {
      const exists = await probeCatalogExists(cat.spreadsheetId);
      if (!exists) {
        console.warn('[report-export] catalog sheet deleted on Drive, clearing local index');
        clearCatalogIndex();
        return { moved: false, missing: true };
      }
      const { driveService } = await assertSheetsReady();
      const { createLifeTourDriveFolders } = require('../../common/lifetour-drive-folders');
      const folders = createLifeTourDriveFolders({
        getDriveService: () => driveService,
        withGoogleApiRetry
      });
      const sqlFolder = await folders.ensureSqlReportsFolder();
      const result = await folders.moveFileToFolder(cat.spreadsheetId, sqlFolder.folderId);
      const store = loadStore();
      if (store.catalog) {
        store.catalog.folderPath = sqlFolder.path;
        saveStore(store);
      }
      return { ...result, folderPath: sqlFolder.path };
    } catch (err) {
      if (isMissingDriveFileError(err)) {
        clearCatalogIndex();
        return { moved: false, missing: true };
      }
      console.warn('[report-export] ensure catalog folder failed', err?.message || err);
      return { moved: false, error: err.message };
    }
  }

  async function syncFromSheetToLocal() {
    const catalog = getCatalog();
    if (!catalog?.spreadsheetId) return { synced: false };
    try {
      const { sheetsService } = await assertSheetsReady();
      const reports = await readAllReports(sheetsService, catalog.spreadsheetId);
      for (const report of reports) {
        if (!report?.id || looksLikeSql(report.outputType)) continue;
        if (!['Local', 'GoogleDrive'].includes(report.outputType)) continue;
        // 雲端列若 SQL 空、本機已有內容，勿用空值覆寫
        const existing = repo.getReport(report.id);
        if (existing?.sqlQuery && !report.sqlQuery) {
          report.sqlQuery = existing.sqlQuery;
        }
        // [Important] 排程執行只寫本機時，勿被 Sheet 較舊的上次／下次蓋掉
        if (existing) {
          const localRun = existing.lastRunAt ? Date.parse(existing.lastRunAt) : 0;
          const sheetRun = report.lastRunAt ? Date.parse(report.lastRunAt) : 0;
          const localOk = Number.isFinite(localRun) && localRun > 0;
          const sheetOk = Number.isFinite(sheetRun) && sheetRun > 0;
          if (localOk && (!sheetOk || localRun > sheetRun)) {
            report.lastRunAt = existing.lastRunAt;
            report.nextRunAt = existing.nextRunAt;
            report.lastStatus = existing.lastStatus;
            report.lastError = existing.lastError;
          }
        }
        repo.upsertReport(report);
      }
      const meta = await readMeta(sheetsService, catalog.spreadsheetId);
      const collaborators = await readCollaborators(sheetsService, catalog.spreadsheetId);
      const store = loadStore();
      if (store.catalog) {
        store.catalog.updatedAt = meta.updatedAt || store.catalog.updatedAt;
        store.catalog.hasCollaborators = collaborators.length > 0;
        saveStore(store);
      }
      return { synced: true, count: reports.length, collaborators };
    } catch (err) {
      if (isMissingDriveFileError(err)) {
        console.warn('[report-export] catalog sheet missing during sync, clearing local index');
        clearCatalogIndex();
        return { synced: false, missing: true };
      }
      throw err;
    }
  }

  async function pushReportToSheet(report, updatedBy) {
    let catalog = getCatalog();
    if (!catalog?.spreadsheetId) return { pushed: false };
    try {
      const { sheetsService } = await assertSheetsReady();
      let reports = dedupeReportsById(await readAllReports(sheetsService, catalog.spreadsheetId));
      const idx = reports.findIndex((r) => r.id === report.id);
      if (report.enabled === false) {
        // 停用＝從共用庫移除（本機仍保留紀錄）
        if (idx >= 0) reports.splice(idx, 1);
      } else if (idx >= 0) {
        reports[idx] = report;
      } else {
        reports.push(report);
      }
      await writeAllReports(sheetsService, catalog.spreadsheetId, reports, updatedBy);
      const meta = await readMeta(sheetsService, catalog.spreadsheetId);
      meta.updatedAt = new Date().toISOString();
      await writeMeta(sheetsService, catalog.spreadsheetId, meta);
      const store = loadStore();
      if (store.catalog) {
        store.catalog.updatedAt = meta.updatedAt;
        saveStore(store);
      }
      return { pushed: true };
    } catch (err) {
      if (!isMissingDriveFileError(err)) throw err;
      // 雲端檔被刪：Owner 重建後再推；協作者則清索引
      if (catalog.role === 'owner') {
        clearCatalogIndex();
        catalog = await ensureCatalogForOwner();
        if (!catalog?.spreadsheetId) return { pushed: false, recreated: false };
        return pushReportToSheet(report, updatedBy);
      }
      clearCatalogIndex();
      throw new Error('共用報表庫已在雲端刪除，請重新加入共享');
    }
  }

  async function ensureCatalogForOwner() {
    let catalog = getCatalog();
    if (catalog?.spreadsheetId) {
      const exists = await probeCatalogExists(catalog.spreadsheetId);
      if (!exists) {
        console.warn('[report-export] catalog sheet missing, recreating…');
        clearCatalogIndex();
        catalog = null;
      } else {
        await ensureCatalogInStandardFolder();
        return getCatalog();
      }
    }
    const myEmail = ((await resolveMyEmail?.()) || '').toLowerCase();
    const created = await createCatalogSpreadsheet(myEmail);
    // 只上傳啟用中的報表
    const localReports = repo.listReports({ includeDisabled: false });
    if (localReports.length) {
      const { sheetsService } = await assertSheetsReady();
      await writeAllReports(sheetsService, created.spreadsheetId, localReports, myEmail);
    }
    catalog = {
      catalogId: created.catalogId,
      spreadsheetId: created.spreadsheetId,
      role: 'owner',
      ownerEmail: myEmail,
      title: '共用 SQL 報表',
      updatedAt: created.updatedAt,
      folderPath: created.folderPath || 'LifeTourTools/SQL報表',
      hasCollaborators: false
    };
    saveStore({ catalog });
    return catalog;
  }

  /** Owner：用本機啟用報表覆寫雲端 reports 分頁（清理重複／停用列） */
  async function rewriteCatalogFromLocal() {
    const cat = await ensureCatalogForOwner();
    if (!cat?.spreadsheetId) return { success: false, error: '無法建立共用報表庫' };
    const myEmail = ((await resolveMyEmail?.()) || '').toLowerCase();
    const { sheetsService } = await assertSheetsReady();
    const localReports = repo.listReports({ includeDisabled: false });
    await writeAllReports(sheetsService, cat.spreadsheetId, localReports, myEmail);
    const meta = await readMeta(sheetsService, cat.spreadsheetId);
    meta.updatedAt = new Date().toISOString();
    await writeMeta(sheetsService, cat.spreadsheetId, meta);
    const store = loadStore();
    if (store.catalog) {
      store.catalog.updatedAt = meta.updatedAt;
      saveStore(store);
    }
    return { success: true, catalog: getCatalog(), count: localReports.length };
  }

  async function getStatus() {
    let catalog = getCatalog();
    const myEmail = ((await resolveMyEmail?.()) || '').toLowerCase();
    let collaborators = [];
    if (catalog?.spreadsheetId) {
      try {
        const exists = await probeCatalogExists(catalog.spreadsheetId);
        if (!exists) {
          clearCatalogIndex();
          catalog = null;
        } else {
          const { sheetsService } = await assertSheetsReady();
          collaborators = await readCollaborators(sheetsService, catalog.spreadsheetId);
        }
      } catch (err) {
        if (isMissingDriveFileError(err)) {
          clearCatalogIndex();
          catalog = null;
        }
      }
    }
    return {
      connected: !!catalog?.spreadsheetId,
      catalog,
      myEmail,
      collaborators
    };
  }

  return {
    loadStore,
    saveStore,
    getCatalog,
    clearCatalogIndex,
    extractSpreadsheetId,
    assertSheetsReady,
    readMeta,
    readCollaborators,
    writeCollaborators,
    createCatalogSpreadsheet,
    syncFromSheetToLocal,
    pushReportToSheet,
    ensureCatalogForOwner,
    ensureCatalogInStandardFolder,
    rewriteCatalogFromLocal,
    assertValidCatalogSpreadsheet,
    friendlyJoinError,
    getStatus,
    readAllReports
  };
}

module.exports = { createSheetCatalog };
