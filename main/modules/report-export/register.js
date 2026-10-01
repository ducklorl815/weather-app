/**
 * modules/report-export — SQL 報表匯出
 * ----------------------------------------------------------------------------
 * [Important]
 * - Manual / Schedule / Test 一律走 ReportExportService（SQL：Preview／Test→test；Manual／Schedule→production；packaged 固定 test）
 * - Output：Local + GoogleDrive（Provider Pattern）
 * - App 內 Scheduler（Phase 3）；系統排程器為 Phase 5
 * - SQL 防呆：允許批次／#暫存表；禁止改正式表（見 sql-validate.js）
 * - SQL 連線：App 設定→開發者區（測試／正式雙設定；安裝包固定 test）
 * 見 docs/report-export/
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRepository } = require('./repository');
const { createSqlRunner } = require('./sql-runner');
const { createCsvWriter } = require('./csv-writer');
const { createExportService } = require('./export-service');
const { createOutputFactory } = require('./output/factory');
const { createDriveFolderHelpers, parseDriveFolderId } = require('./drive-folder');
const { createReportExportScheduler } = require('./scheduler');
const { computeNextRunAt, formatScheduleSummary, scheduleSignature } = require('./schedule-utils');

const FEATURE_TYPE = 'reportExport';
const PREVIEW_DEFAULT_LIMIT = 100;
const EXPORT_SOFT_MAX_ROWS = 500000;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFileNameBase(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/\.csv$/i, '');
  if (!s) throw new Error('請填寫檔案名稱');
  if (s.length > 120) throw new Error('檔案名稱過長');
  return s;
}

function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || 'Daily');
  const allowed = new Set(['EveryNMinutes', 'EveryNHours', 'Daily', 'Weekly', 'Monthly']);
  if (!allowed.has(type)) throw new Error('不支援的排程類型');
  let startAt = '';
  if (raw.startAt) {
    const d = new Date(raw.startAt);
    if (!Number.isNaN(d.getTime())) {
      // datetime-local 只有到分鐘，統一歸零秒數避免來回儲存誤判排程變更
      d.setSeconds(0, 0);
      startAt = d.toISOString();
    }
  }
  return {
    type,
    interval: Math.max(1, Number(raw.interval) || 1),
    time: String(raw.time || '16:00').trim() || '16:00',
    weekDays: Array.isArray(raw.weekDays)
      ? raw.weekDays.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6)
      : [1],
    dayOfMonth: Math.min(31, Math.max(1, Number(raw.dayOfMonth) || 1)),
    startAt,
    timezone: String(raw.timezone || 'Asia/Taipei')
  };
}

function normalizeOutputConfig(outputType, raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  if (outputType === 'Local') {
    return { localPath: String(cfg.localPath || '').trim() };
  }
  if (outputType === 'GoogleDrive') {
    return {
      googleAccountEmail: String(cfg.googleAccountEmail || '').trim(),
      folderId: parseDriveFolderId(cfg.folderId || ''),
      folderName: String(cfg.folderName || '').trim(),
      testFolderId: parseDriveFolderId(cfg.testFolderId || ''),
      testFolderName: String(cfg.testFolderName || '').trim(),
      lastGoogleDriveFileId: String(cfg.lastGoogleDriveFileId || '').trim() || undefined
    };
  }
  throw new Error('不支援的輸出類型');
}

function normalizeDefinitionInput(payload, existing) {
  const outputType = String(payload?.outputType || existing?.outputType || 'Local');
  if (outputType !== 'Local' && outputType !== 'GoogleDrive') {
    throw new Error('輸出類型僅支援 Local 或 GoogleDrive');
  }
  const overwriteMode = String(payload?.overwriteMode || existing?.overwriteMode || 'Overwrite');
  if (!['Overwrite', 'AppendTimestamp', 'FailIfExists'].includes(overwriteMode)) {
    throw new Error('不支援的覆蓋模式');
  }
  const scheduleEnabled = payload?.scheduleEnabled !== undefined
    ? !!payload.scheduleEnabled
    : !!existing?.scheduleEnabled;
  const schedule = payload?.schedule !== undefined
    ? normalizeSchedule(payload.schedule)
    : (existing?.schedule || null);

  const report = {
    reportName: String(payload?.reportName ?? existing?.reportName ?? '').trim(),
    department: String(payload?.department ?? existing?.department ?? '').trim(),
    description: String(payload?.description ?? existing?.description ?? '').trim(),
    fileNameBase: sanitizeFileNameBase(payload?.fileNameBase ?? existing?.fileNameBase ?? ''),
    sqlQuery: String(payload?.sqlQuery ?? existing?.sqlQuery ?? '').trim(),
    outputType,
    outputConfig: normalizeOutputConfig(
      outputType,
      payload?.outputConfig !== undefined ? payload.outputConfig : existing?.outputConfig
    ),
    overwriteMode,
    scheduleEnabled,
    schedule: scheduleEnabled ? (schedule || normalizeSchedule({ type: 'Daily', time: '16:00' })) : schedule,
    dateParams: payload?.dateParams !== undefined
      ? (payload.dateParams || { mode: 'None' })
      : (existing?.dateParams || { mode: 'None' }),
    enabled: payload?.enabled !== undefined ? !!payload.enabled : (existing?.enabled !== false)
  };

  if (!report.reportName) throw new Error('請填寫報表名稱');
  // 輸出路徑／Drive 資料夾在執行時再檢查（發布版使用者可不改輸出設定）
  return report;
}

function toListItem(report) {
  const dest = report.outputType === 'GoogleDrive'
    ? `Drive: ${report.outputConfig?.folderName || report.outputConfig?.folderId || '（未選資料夾）'}`
    : (report.outputConfig?.localPath || '');
  return {
    id: report.id,
    reportName: report.reportName,
    department: report.department,
    fileNameBase: report.fileNameBase,
    outputType: report.outputType,
    destinationSummary: dest,
    scheduleEnabled: !!report.scheduleEnabled,
    scheduleSummary: formatScheduleSummary(report.schedule),
    lastRunAt: report.lastRunAt || null,
    nextRunAt: report.nextRunAt || null,
    lastStatus: report.lastStatus || null,
    enabled: report.enabled !== false,
    updatedAt: report.updatedAt
  };
}

function registerReportExportModule(ctx) {
  const {
    ipcMain,
    app,
    dialog,
    getMainWindow,
    getSqlPool,
    loadGeminiConfig,
    saveGeminiConfig,
    isFeatureActive,
    getSheetsService,
    getDriveService,
    withGoogleApiRetry,
    grantedScopeText,
    hasSheetsScope,
    hasDriveFileScope,
    quoteSheetRange,
    resolveMyEmail
  } = ctx;

  const { createReportSqlConfigService } = require('./sql-config');
  const sqlConfig = createReportSqlConfigService({
    loadGeminiConfig,
    saveGeminiConfig,
    isPackaged: () => !!(app && app.isPackaged)
  });

  async function assertDriveReady() {
    const drive = typeof getDriveService === 'function' ? getDriveService() : null;
    if (!drive) {
      const err = new Error('請先用 Google 登入');
      err.needsAuth = true;
      throw err;
    }
    const scope = typeof grantedScopeText === 'function' ? await grantedScopeText() : '';
    if (typeof hasDriveFileScope === 'function' && !hasDriveFileScope(scope)) {
      const err = new Error('需要雲端硬碟（drive.file）權限，請補充授權');
      err.featureScopeMissing = true;
      err.needsAuth = true;
      throw err;
    }
  }

  const repo = createRepository({ app, fs, path });
  const { createSheetCatalog } = require('./sheet-catalog');
  const catalog = createSheetCatalog({
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
  });

  async function syncCatalogIfConnected() {
    const before = catalog.getCatalog();
    if (!before?.spreadsheetId) return;
    try {
      const result = await catalog.syncFromSheetToLocal();
      // 雲端檔被刪：Owner（或本機仍有報表）自動重建
      if (result?.missing) {
        const localCount = repo.listReports({ includeDisabled: true }).length;
        if (before.role !== 'collaborator' && localCount > 0) {
          console.warn('[report-export] recreating catalog after Drive delete');
          await catalog.ensureCatalogForOwner();
        }
      }
    } catch (err) {
      console.warn('[report-export] catalog sync failed', err?.message || err);
      // 協作者加錯 Sheet：清掉索引，避免每次開啟都卡住
      if (before.role === 'collaborator') {
        const msg = String(err?.message || '');
        if (/Unable to parse|invalidSheet|catalogId|不是.*共用|逾時/i.test(msg) || err?.invalidSheet) {
          catalog.clearCatalogIndex();
        }
      }
    }
  }

  async function pushReportIfConnected(report) {
    if (!catalog.getCatalog()?.spreadsheetId) return;
    const myEmail = ((await resolveMyEmail?.()) || '').toLowerCase();
    try {
      await catalog.pushReportToSheet(report, myEmail);
    } catch (err) {
      console.warn('[report-export] catalog push failed', err?.message || err);
      throw err;
    }
  }

  function notifyListChanged() {
    try {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send('report-export-list-changed');
      }
    } catch (_) {}
  }

  /** 執行後把本機 last/next 推上 Sheet，並通知 UI 刷新列表 */
  async function executeAndRefresh(opts) {
    try {
      const result = await exportService.execute(opts);
      const report = repo.getReport(opts.reportId);
      if (report) {
        try {
          await pushReportIfConnected(report);
        } catch (err) {
          console.warn('[report-export] post-exec catalog push failed', err?.message || err);
        }
      }
      notifyListChanged();
      return result;
    } catch (err) {
      const report = repo.getReport(opts.reportId);
      if (report) {
        try {
          await pushReportIfConnected(report);
        } catch (_) {}
      }
      notifyListChanged();
      throw err;
    }
  }

  const sqlRunner = createSqlRunner({
    // [Important] 必須把 resolvePoolConfig(profile) 傳進真正的 getSqlPool(cfg)
    getSqlPool: async (profile) => {
      const cfg = sqlConfig.resolvePoolConfig(profile);
      const hasConn = !!(String(cfg.sqlConnectionString || '').trim() || String(cfg.sqlServer || '').trim());
      if (!hasConn) {
        const label = profile === 'production' ? '正式' : '測試';
        throw new Error(`尚未設定「${label}」SQL 連線。請到 App 設定 → SQL 報表連線，切到「${label}」後儲存連線字串。`);
      }
      return getSqlPool(cfg);
    },
    previewDefaultLimit: PREVIEW_DEFAULT_LIMIT,
    exportSoftMaxRows: EXPORT_SOFT_MAX_ROWS
  });

  function assertManualAllowed() {
    if (app && app.isPackaged) {
      const err = new Error('「立即丟檔」僅開發者模式可用（npm start）');
      err.devOnly = true;
      throw err;
    }
  }
  const csvWriter = createCsvWriter({ useBom: true });
  const outputFactory = createOutputFactory({
    fs,
    path,
    getDriveService,
    withGoogleApiRetry,
    assertDriveReady
  });
  const exportService = createExportService({
    repo,
    sqlRunner,
    csvWriter,
    outputFactory,
    app,
    fs,
    path,
    computeNextRunAt,
    newId,
    nowIso
  });
  const driveFolders = createDriveFolderHelpers({
    getDriveService,
    withGoogleApiRetry,
    assertDriveReady
  });

  async function ensureNextRunAtForDue() {
    const dueMissing = repo.listReports({ includeDisabled: false }).filter(
      (r) => r.scheduleEnabled && r.schedule && !r.nextRunAt
    );
    for (const r of dueMissing) {
      const next = computeNextRunAt(r.schedule, new Date()).toISOString();
      repo.upsertReport({ ...r, nextRunAt: next, updatedAt: nowIso() });
    }
  }

  const scheduler = createReportExportScheduler({
    intervalMs: 30 * 1000,
    concurrency: 1,
    isReady: () => typeof isFeatureActive === 'function' && isFeatureActive(FEATURE_TYPE),
    listDueReports: async () => {
      await ensureNextRunAtForDue();
      return repo.listDueReports(new Date());
    },
    execute: (opts) => executeAndRefresh({
      ...opts,
      sqlProfile: sqlConfig.resolveProfileForExecution(opts.executionType || 'Schedule')
    }),
    log: (...args) => console.log('[report-export]', ...args)
  });

  function assertCanExecute() {
    if (typeof isFeatureActive === 'function' && !isFeatureActive(FEATURE_TYPE)) {
      const err = new Error('請先在工作台加入「SQL 清單列表」功能後再執行');
      err.featureInactive = true;
      throw err;
    }
  }

  async function pickLocalFolder() {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const picked = await dialog.showOpenDialog(win || undefined, {
      title: '選擇報表輸出資料夾',
      properties: ['openDirectory', 'createDirectory']
    });
    if (picked.canceled || !picked.filePaths?.length) {
      return { success: false, cancelled: true };
    }
    return { success: true, path: picked.filePaths[0] };
  }

  ipcMain.handle('report-export-list', async () => {
    try {
      await syncCatalogIfConnected();
      const status = await catalog.getStatus();
      const reports = repo.listReports({ includeDisabled: false }).map(toListItem);
      return { success: true, reports, catalog: status.catalog, collaborators: status.collaborators };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-get', async (_event, id) => {
    try {
      await syncCatalogIfConnected();
      const report = repo.getReport(String(id || ''));
      if (!report) return { success: false, error: '找不到報表' };
      const status = await catalog.getStatus();
      return { success: true, report, catalog: status.catalog, collaborators: status.collaborators };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-create', async (_event, payload) => {
    try {
      const fields = normalizeDefinitionInput(payload, null);
      const at = nowIso();
      const report = {
        id: newId('rpt'),
        ...fields,
        lastRunAt: null,
        nextRunAt: fields.scheduleEnabled && fields.schedule
          ? computeNextRunAt(fields.schedule, new Date()).toISOString()
          : null,
        lastStatus: null,
        lastError: null,
        createdAt: at,
        updatedAt: at
      };
      repo.upsertReport(report);
      await catalog.ensureCatalogForOwner();
      await pushReportIfConnected(report);
      return { success: true, report };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing
      };
    }
  });

  ipcMain.handle('report-export-update', async (_event, id, payload) => {
    try {
      const existing = repo.getReport(String(id || ''));
      if (!existing) return { success: false, error: '找不到報表' };
      const fields = normalizeDefinitionInput(payload, existing);

      // [Important] 僅排程設定變更／關閉／缺少下次時間時才重算。
      // 到期未跑的 nextRunAt 不因「詳細後儲存」而推進，留給排程器執行。
      let nextRunAt = existing.nextRunAt || null;
      if (!fields.scheduleEnabled) {
        nextRunAt = null;
      } else {
        const scheduleChanged = scheduleSignature(fields.schedule) !== scheduleSignature(existing.schedule)
          || !!existing.scheduleEnabled !== !!fields.scheduleEnabled;
        const nextDate = nextRunAt ? new Date(nextRunAt) : null;
        const nextInvalid = !nextDate || Number.isNaN(nextDate.getTime());
        if (scheduleChanged || nextInvalid || !nextRunAt) {
          nextRunAt = computeNextRunAt(fields.schedule, new Date()).toISOString();
        }
      }

      const report = {
        ...existing,
        ...fields,
        nextRunAt,
        updatedAt: nowIso()
      };
      repo.upsertReport(report);
      await catalog.ensureCatalogForOwner();
      await pushReportIfConnected(report);
      return { success: true, report };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing
      };
    }
  });

  ipcMain.handle('report-export-delete', async (_event, id) => {
    try {
      const existing = repo.getReport(String(id || ''));
      if (!existing) return { success: false, error: '找不到報表' };
      existing.enabled = false;
      existing.scheduleEnabled = false;
      existing.nextRunAt = null;
      existing.updatedAt = nowIso();
      repo.upsertReport(existing);
      await pushReportIfConnected(existing);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-catalog-status', async () => {
    try {
      const status = await catalog.getStatus();
      return { success: true, ...status };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-create-catalog', async () => {
    try {
      const result = await catalog.rewriteCatalogFromLocal();
      if (!result.success) return result;
      await syncCatalogIfConnected();
      return { success: true, catalog: result.catalog, count: result.count };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing
      };
    }
  });

  ipcMain.handle('report-export-join-catalog', async (_event, payload) => {
    const previousCatalog = catalog.getCatalog();
    try {
      const spreadsheetId = catalog.extractSpreadsheetId(
        payload?.spreadsheetId || payload?.url || payload
      );
      if (!spreadsheetId) return { success: false, error: '請貼上有效的 Google 試算表 ID 或網址' };

      const myEmail = ((await resolveMyEmail?.()) || '').toLowerCase();
      // [Important] 先驗證格式並試讀，成功才寫本機；失敗保持「未導入」
      const validated = await catalog.assertValidCatalogSpreadsheet(spreadsheetId);
      const { meta, reports, collaborators } = validated;

      const store = catalog.loadStore();
      if (store.catalog?.spreadsheetId === spreadsheetId) {
        return { success: true, catalog: store.catalog, already: true };
      }

      const ownerEmail = String(meta.ownerEmail || '').toLowerCase();
      const role = ownerEmail && ownerEmail === myEmail ? 'owner' : 'collaborator';
      const nextCatalog = {
        catalogId: meta.catalogId,
        spreadsheetId,
        role,
        ownerEmail,
        title: meta.title || '共用 SQL 報表',
        updatedAt: meta.updatedAt || new Date().toISOString(),
        folderPath: meta.folderPath || 'LifeTourTools/SQL報表',
        hasCollaborators: (collaborators || []).length > 0
      };

      store.catalog = nextCatalog;
      catalog.saveStore(store);

      try {
        for (const report of reports || []) {
          if (!report?.id) continue;
          if (!['Local', 'GoogleDrive'].includes(report.outputType)) continue;
          repo.upsertReport(report);
        }
      } catch (syncErr) {
        // 導入資料失敗 → 回滾到加入前狀態
        catalog.saveStore({ catalog: previousCatalog || null });
        return {
          success: false,
          error: `導入報表資料失敗：${catalog.friendlyJoinError(syncErr)}（已取消加入，未保留此 Sheet）`
        };
      }

      return { success: true, catalog: nextCatalog, count: (reports || []).length };
    } catch (err) {
      // 確保失敗時不留下錯誤 catalog
      try {
        const cur = catalog.getCatalog();
        if (cur && previousCatalog?.spreadsheetId !== cur.spreadsheetId) {
          catalog.saveStore({ catalog: previousCatalog || null });
        }
      } catch (_) {}
      return {
        success: false,
        error: catalog.friendlyJoinError(err),
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing,
        invalidSheet: !!err.invalidSheet
      };
    }
  });

  ipcMain.handle('report-export-share', async (_event, payload) => {
    try {
      const peerEmail = String(payload?.email || '').trim().toLowerCase();
      if (!peerEmail.includes('@')) return { success: false, error: '請輸入有效 email' };
      const cat = catalog.getCatalog();
      if (!cat?.spreadsheetId) return { success: false, error: '請先建立共用報表庫' };
      if (cat.role !== 'owner') return { success: false, error: '僅 Owner 可邀請' };
      const { sheetsService, driveService } = await catalog.assertSheetsReady();
      await withGoogleApiRetry(() => driveService.permissions.create({
        fileId: cat.spreadsheetId,
        requestBody: { type: 'user', role: 'writer', emailAddress: peerEmail },
        sendNotificationEmail: true
      }));
      const collab = await catalog.readCollaborators(sheetsService, cat.spreadsheetId);
      collab.push(peerEmail);
      await catalog.writeCollaborators(sheetsService, cat.spreadsheetId, collab);
      const store = catalog.loadStore();
      if (store.catalog) {
        store.catalog.hasCollaborators = true;
        catalog.saveStore(store);
      }
      return {
        success: true,
        spreadsheetId: cat.spreadsheetId,
        message: `已邀請 ${peerEmail}。請對方在「SQL 清單列表」按「加入共享」並貼上 Sheet ID：\n${cat.spreadsheetId}`
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-revoke', async (_event, payload) => {
    try {
      const peerEmail = String(payload?.email || '').trim().toLowerCase();
      const cat = catalog.getCatalog();
      if (!cat?.spreadsheetId || cat.role !== 'owner') {
        return { success: false, error: '僅 Owner 可撤銷' };
      }
      const { sheetsService, driveService } = await catalog.assertSheetsReady();
      try {
        const perms = await withGoogleApiRetry(() => driveService.permissions.list({
          fileId: cat.spreadsheetId,
          fields: 'permissions(id,emailAddress,role)'
        }));
        for (const p of perms.data.permissions || []) {
          if (String(p.emailAddress || '').toLowerCase() === peerEmail && p.role !== 'owner') {
            await driveService.permissions.delete({
              fileId: cat.spreadsheetId,
              permissionId: p.id
            });
          }
        }
      } catch (_) {}
      const collab = (await catalog.readCollaborators(sheetsService, cat.spreadsheetId))
        .filter((e) => e !== peerEmail);
      await catalog.writeCollaborators(sheetsService, cat.spreadsheetId, collab);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-leave-catalog', async () => {
    try {
      const store = catalog.loadStore();
      if (!store.catalog) return { success: false, error: '尚未加入共用報表庫' };
      if (store.catalog.role === 'owner') {
        return { success: false, error: 'Owner 請改用撤銷協作者，不可離開自己的報表庫' };
      }
      store.catalog = null;
      catalog.saveStore(store);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-preview', async (_event, payload) => {
    try {
      const id = payload?.id ? String(payload.id) : '';
      let sql = String(payload?.sql || '').trim();
      if (!sql && id) {
        const report = repo.getReport(id);
        if (!report) return { success: false, error: '找不到報表' };
        sql = report.sqlQuery;
      }
      if (!sql) return { success: false, error: '請輸入 SQL' };
      const limit = Math.min(500, Math.max(1, Number(payload?.limit) || PREVIEW_DEFAULT_LIMIT));
      const result = await sqlRunner.preview(sql, {
        limit,
        profile: sqlConfig.resolveProfileForExecution('Preview')
      });
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-execute', async (_event, payload) => {
    try {
      assertCanExecute();
      const id = String(payload?.id || '');
      const mode = String(payload?.mode || 'Manual');
      if (!['Manual', 'Test'].includes(mode)) {
        return { success: false, error: '不支援的執行模式' };
      }
      if (mode === 'Manual') assertManualAllowed();
      const result = await executeAndRefresh({
        reportId: id,
        executionType: mode,
        sqlProfile: sqlConfig.resolveProfileForExecution(mode)
      });
      return { success: true, ...result };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        featureInactive: !!err.featureInactive,
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing
      };
    }
  });

  ipcMain.handle('report-export-executions', async (_event, payload) => {
    try {
      const id = String(payload?.id || '');
      if (!id) return { success: false, error: '缺少報表 id' };
      const limit = Math.min(200, Math.max(1, Number(payload?.limit) || 50));
      const offset = Math.max(0, Number(payload?.offset) || 0);
      const logs = repo.listLogs(id, { limit, offset });
      return { success: true, logs };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-pick-local-folder', async () => {
    try {
      return await pickLocalFolder();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-auth-status', async () => {
    try {
      const scope = typeof grantedScopeText === 'function' ? await grantedScopeText() : '';
      const hasDrive = typeof hasDriveFileScope === 'function' ? hasDriveFileScope(scope) : false;
      const hasSheets = typeof hasSheetsScope === 'function' ? hasSheetsScope(scope) : false;
      let email = '';
      try {
        if (typeof resolveMyEmail === 'function') email = (await resolveMyEmail()) || '';
      } catch (_) {}
      return {
        success: true,
        hasDriveFileScope: hasDrive,
        hasSheetsScope: hasSheets,
        email,
        authorized: hasDrive,
        catalogReady: hasDrive && hasSheets
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-drive-resolve-folder', async (_event, payload) => {
    try {
      const raw = payload?.folderIdOrUrl || payload?.value || '';
      const result = await driveFolders.resolveFolder(raw);
      return { success: true, ...result };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing
      };
    }
  });

  ipcMain.handle('report-export-drive-create-folder', async (_event, payload) => {
    try {
      const result = await driveFolders.createFolder(payload?.name, payload?.parentId);
      return { success: true, ...result };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing
      };
    }
  });

  ipcMain.handle('report-export-drive-list-folders', async () => {
    try {
      const folders = await driveFolders.listFolders({ pageSize: 50 });
      return { success: true, folders };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing
      };
    }
  });

  ipcMain.handle('report-export-get-sql-config', async () => {
    try {
      return sqlConfig.getPublicState();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-save-sql-config', async (_event, payload) => {
    try {
      const state = sqlConfig.save(payload || {});
      return state;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('report-export-set-sql-profile', async (_event, profile) => {
    try {
      return sqlConfig.setActiveProfile(profile);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  return {
    FEATURE_TYPE,
    exportService,
    repo,
    scheduler,
    sqlConfig,
    startScheduler: () => scheduler.start(),
    stopScheduler: () => scheduler.stop()
  };
}

module.exports = { registerReportExportModule, FEATURE_TYPE };
