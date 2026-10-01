/**
 * modules/notes — 記事（Sheets by spreadsheetId）
 * ----------------------------------------------------------------------------
 * [Important]
 * - 一則清單筆記 = 一個 Google Spreadsheet（用 spreadsheetId 精準讀寫，不掃 Drive）
 * - 本機 notes-store.json 只當「ID 索引＋個人偏好」（列表秒開）
 * - 分享 = 對該試算表加 writer（Sheet 檔分享）＋對方用 Sheet ID／網址加入索引
 * - 見 ADR 0013
 */
'use strict';

const crypto = require('crypto');

const NOTES_SCHEMA_VERSION = 3;
const NOTE_TITLE_PREFIX = 'LifeTour 記事 · ';
const META_SHEET = 'meta';
const ITEMS_SHEET = 'items';
const COLLAB_SHEET = 'collaborators';
const ITEMS_HEADERS = ['id', 'text', 'checked', 'parentId', 'position', 'updatedAt', 'detail'];
const COLLAB_HEADERS = ['email', 'addedAt', 'status'];
const NOTE_COLORS = [
  '', '#fff475', '#fbbc04', '#f28b82', '#fdcfe8',
  '#d7aefb', '#aecbfa', '#cbf0f8', '#a7ffeb', '#ccff90'
];

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function registerNotesModule(ctx) {
  const {
    ipcMain,
    app,
    path,
    fs,
    getSheetsService,
    getDriveService,
    withGoogleApiRetry,
    grantedScopeText,
    hasSheetsScope,
    hasDriveFileScope,
    quoteSheetRange,
    resolveMyEmail
  } = ctx;

  function storePath() {
    return path.join(app.getPath('userData'), 'notes-store.json');
  }

  function emptyStore() {
    return { schemaVersion: NOTES_SCHEMA_VERSION, notes: [] };
  }

  function loadStore() {
    try {
      if (fs.existsSync(storePath())) {
        const data = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
        if (data && Array.isArray(data.notes)) {
          return { schemaVersion: NOTES_SCHEMA_VERSION, notes: data.notes };
        }
      }
    } catch (_) {}
    return emptyStore();
  }

  function saveStore(store) {
    const next = { schemaVersion: NOTES_SCHEMA_VERSION, notes: store.notes || [] };
    fs.writeFileSync(storePath(), JSON.stringify(next, null, 2));
    return next;
  }

  async function assertSheetsReady() {
    const sheetsService = getSheetsService();
    const driveService = getDriveService();
    if (!sheetsService || !driveService) {
      const err = new Error('請先用 Google 登入');
      err.needsAuth = true;
      throw err;
    }
    const scope = await grantedScopeText();
    if (!hasSheetsScope(scope) || !hasDriveFileScope(scope)) {
      const err = new Error('記事需要 Google 試算表與雲端硬碟（drive.file）權限');
      err.featureScopeMissing = true;
      err.needsAuth = true;
      throw err;
    }
    return { sheetsService, driveService };
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
    return metaMapFromRows(await valuesGet(sheetsService, spreadsheetId, META_SHEET, 'A:B'));
  }

  async function writeMeta(sheetsService, spreadsheetId, map) {
    const rows = Object.entries(map).map(([k, v]) => [k, v == null ? '' : String(v)]);
    await valuesClear(sheetsService, spreadsheetId, META_SHEET, 'A:B');
    if (rows.length) await valuesUpdate(sheetsService, spreadsheetId, META_SHEET, 'A1', rows);
  }

  function parseItems(rows) {
    const out = [];
    for (let i = 1; i < (rows || []).length; i++) {
      const r = rows[i] || [];
      const id = String(r[0] || '').trim();
      if (!id) continue;
      out.push({
        id,
        text: String(r[1] || ''),
        checked: String(r[2] || '').toLowerCase() === 'true' || r[2] === '1',
        parentId: String(r[3] || ''),
        position: Number(r[4]) || i,
        updatedAt: String(r[5] || ''),
        detail: String(r[6] || '')
      });
    }
    out.sort((a, b) => a.position - b.position);
    return out;
  }

  function itemsToRows(items) {
    const sorted = [...(items || [])].sort((a, b) => (a.position || 0) - (b.position || 0));
    return [
      ITEMS_HEADERS,
      ...sorted.map((it, idx) => [
        it.id,
        it.text || '',
        it.checked ? 'true' : 'false',
        it.parentId || '',
        String(it.position != null ? it.position : idx + 1),
        it.updatedAt || new Date().toISOString(),
        it.detail || ''
      ])
    ];
  }

  async function readItems(sheetsService, spreadsheetId) {
    return parseItems(await valuesGet(sheetsService, spreadsheetId, ITEMS_SHEET, 'A:G'));
  }

  async function writeItems(sheetsService, spreadsheetId, items) {
    await valuesClear(sheetsService, spreadsheetId, ITEMS_SHEET, 'A:G');
    await valuesUpdate(sheetsService, spreadsheetId, ITEMS_SHEET, 'A1', itemsToRows(items));
  }

  function buildItemTree(items) {
    const map = {};
    for (const it of items || []) map[it.id] = { ...it, children: [] };
    const roots = [];
    for (const it of Object.values(map)) {
      if (it.parentId && map[it.parentId]) map[it.parentId].children.push(it);
      else roots.push(it);
    }
    const byPos = (a, b) => (a.position || 0) - (b.position || 0);
    for (const it of Object.values(map)) it.children.sort(byPos);
    roots.sort(byPos);
    return roots;
  }

  function extractSpreadsheetId(input) {
    const text = String(input || '').trim();
    const m = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || text.match(/^([a-zA-Z0-9-_]{30,})$/);
    return m ? m[1] : '';
  }

  function withJoinTimeout(promise, ms = 20000) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('連線逾時：無法讀取試算表，請確認 Sheet ID、網路與權限後再試')), ms);
      })
    ]);
  }

  function friendlyJoinError(err, kind) {
    const msg = String(err?.message || err || '');
    const status = Number(err?.code || err?.status || err?.response?.status || 0);
    if (status === 404 || /not found|Requested entity was not found/i.test(msg)) {
      return '找不到此試算表，或您沒有存取權限。請確認 Sheet ID，並請 Owner 先邀請您的 Google 帳號。';
    }
    if (/Unable to parse range|Unable to parse|Unable to parse the range|not found within/i.test(msg)) {
      return kind === 'notes'
        ? '此試算表不是 LifeTour「記事」格式（缺少 meta／items 工作表）。請向分享者索取正確的記事 Sheet ID。'
        : '此試算表不是 LifeTour「SQL 報表」共用庫格式。請向分享者索取正確的報表庫 Sheet ID。';
    }
    if (/逾時|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) {
      return msg.includes('連線逾時') ? msg : '連線逾時，導入已取消，未寫入本機。';
    }
    if (/權限|permission|forbidden|403/i.test(msg) || status === 403) {
      return '沒有此試算表的權限。請請 Owner 用 email 邀請後再加入。';
    }
    return msg || '加入失敗，未寫入本機。';
  }

  /** 嚴格驗證：必須是記事試算表，否則拋錯（不寫入本機） */
  async function assertValidNoteSpreadsheet(sheetsService, spreadsheetId) {
    const metaRes = await withJoinTimeout(withGoogleApiRetry(() => sheetsService.spreadsheets.get({
      spreadsheetId,
      fields: 'spreadsheetId,properties/title,sheets/properties/title'
    })));
    const titles = new Set(
      (metaRes.data?.sheets || []).map((s) => String(s.properties?.title || ''))
    );
    if (!titles.has(META_SHEET) || !titles.has(ITEMS_SHEET)) {
      const err = new Error('此試算表不是 LifeTour「記事」格式（需有 meta、items 工作表）');
      err.invalidSheet = true;
      throw err;
    }
    const meta = await withJoinTimeout(readMeta(sheetsService, spreadsheetId));
    if (!String(meta.noteId || '').trim()) {
      const err = new Error('此試算表缺少記事識別（noteId），可能加錯 Sheet。請向分享者索取正確的記事 Sheet ID。');
      err.invalidSheet = true;
      throw err;
    }
    // 試讀清單；失敗＝格式不對，不導入
    await withJoinTimeout(readItems(sheetsService, spreadsheetId));
    return meta;
  }

  async function createNoteSpreadsheet(title, ownerEmail, items) {
    const { sheetsService, driveService } = await assertSheetsReady();
    const noteId = newId('note');
    const safeTitle = String(title || '未命名清單').trim() || '未命名清單';
    const created = await withGoogleApiRetry(() => sheetsService.spreadsheets.create({
      requestBody: {
        properties: {
          title: `${NOTE_TITLE_PREFIX}${safeTitle}`.slice(0, 80),
          locale: 'zh_TW'
        },
        sheets: [
          { properties: { title: META_SHEET } },
          { properties: { title: ITEMS_SHEET } },
          { properties: { title: COLLAB_SHEET } }
        ]
      }
    }));
    const spreadsheetId = created.data.spreadsheetId;
    // 放到 我的雲端硬碟/LifeTourTools/記事
    try {
      const { createLifeTourDriveFolders } = require('../../common/lifetour-drive-folders');
      const folders = createLifeTourDriveFolders({
        getDriveService: () => driveService,
        withGoogleApiRetry
      });
      const notesFolder = await folders.ensureNotesFolder();
      await folders.moveFileToFolder(spreadsheetId, notesFolder.folderId);
    } catch (err) {
      console.warn('[notes] move to LifeTourTools/記事 failed', err?.message || err);
    }
    const now = new Date().toISOString();
    await writeMeta(sheetsService, spreadsheetId, {
      schemaVersion: String(NOTES_SCHEMA_VERSION),
      noteId,
      title: safeTitle,
      ownerEmail: ownerEmail || '',
      trashed: 'false',
      createdAt: now,
      updatedAt: now
    });
    await writeItems(sheetsService, spreadsheetId, items || []);
    await valuesUpdate(sheetsService, spreadsheetId, COLLAB_SHEET, 'A1', [COLLAB_HEADERS]);
    return { noteId, spreadsheetId, title: safeTitle, updatedAt: now };
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

  function indexEntryFromMeta(meta, spreadsheetId, prefs = {}) {
    return {
      noteId: meta.noteId || newId('note'),
      spreadsheetId,
      title: meta.title || '未命名',
      color: prefs.color || '',
      pinned: !!prefs.pinned,
      trashed: String(meta.trashed || '') === 'true' || !!prefs.trashed,
      role: prefs.role || 'owner',
      ownerEmail: String(meta.ownerEmail || prefs.ownerEmail || '').toLowerCase(),
      updatedAt: meta.updatedAt || new Date().toISOString(),
      source: 'sheets'
    };
  }

  /** 列表：只讀本機索引（快）；不批次打 Sheets／不掃 Drive */
  ipcMain.handle('notes-list', async (_e, payload) => {
    try {
      const view = payload?.view === 'trash' ? 'trash' : 'active';
      const store = loadStore();
      const notes = store.notes
        .filter((n) => (view === 'trash' ? !!n.trashed : !n.trashed))
        .map((n) => ({
          noteId: n.noteId,
          spreadsheetId: n.spreadsheetId || '',
          title: n.title || '未命名',
          color: n.color || '',
          pinned: !!n.pinned,
          role: n.role || 'owner',
          ownerEmail: n.ownerEmail || '',
          updatedAt: n.updatedAt || '',
          tabOrder: n.tabOrder != null ? Number(n.tabOrder) : null,
          hasCollaborators: !!n.hasCollaborators,
          source: n.source || (n.spreadsheetId ? 'sheets' : 'local')
        }))
        .sort((a, b) => {
          const ao = a.tabOrder != null ? a.tabOrder : 999999;
          const bo = b.tabOrder != null ? b.tabOrder : 999999;
          if (ao !== bo) return ao - bo;
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        });
      return {
        success: true,
        notes,
        colors: NOTE_COLORS,
        myEmail: (await resolveMyEmail()) || ''
      };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  /** 開啟一則：只讀該 spreadsheetId */
  ipcMain.handle('notes-get', async (_e, noteId) => {
    try {
      const store = loadStore();
      const entry = store.notes.find((n) => n.noteId === String(noteId || ''));
      if (!entry) return { success: false, error: '找不到此筆記' };

      // 舊本機筆記尚未上雲：先建 Sheet
      if (!entry.spreadsheetId) {
        const { sheetsService } = await assertSheetsReady();
        const myEmail = (await resolveMyEmail()) || '';
        const created = await createNoteSpreadsheet(entry.title, myEmail, entry.items || []);
        entry.spreadsheetId = created.spreadsheetId;
        entry.source = 'sheets';
        entry.updatedAt = created.updatedAt;
        entry.ownerEmail = myEmail.toLowerCase();
        entry.role = 'owner';
        delete entry.items;
        saveStore(store);
      }

      const { sheetsService } = await assertSheetsReady();
      let meta;
      let items;
      let collaborators;
      try {
        meta = await withJoinTimeout(readMeta(sheetsService, entry.spreadsheetId));
        items = await withJoinTimeout(readItems(sheetsService, entry.spreadsheetId));
        collaborators = await withJoinTimeout(readCollaborators(sheetsService, entry.spreadsheetId));
        if (!String(meta.noteId || '').trim() && entry.role === 'collaborator') {
          throw Object.assign(new Error('invalid'), { invalidSheet: true });
        }
      } catch (err) {
        // 協作者加錯過 Sheet：自動移出索引，回到未導入狀態
        if (entry.role === 'collaborator') {
          store.notes = store.notes.filter((n) => n.noteId !== entry.noteId);
          saveStore(store);
          return {
            success: false,
            error: friendlyJoinError(err, 'notes') + '（已自動移除此錯誤共享，未保留導入）',
            removed: true
          };
        }
        throw err;
      }

      if (meta.title) entry.title = meta.title;
      entry.trashed = String(meta.trashed || '') === 'true';
      entry.updatedAt = meta.updatedAt || entry.updatedAt;
      entry.ownerEmail = String(meta.ownerEmail || entry.ownerEmail || '').toLowerCase();
      entry.hasCollaborators = collaborators.length > 0;
      saveStore(store);

      return {
        success: true,
        note: {
          noteId: entry.noteId,
          spreadsheetId: entry.spreadsheetId,
          title: entry.title,
          color: entry.color || '',
          pinned: !!entry.pinned,
          trashed: !!entry.trashed,
          role: entry.role || 'owner',
          ownerEmail: entry.ownerEmail || '',
          collaborators,
          updatedAt: entry.updatedAt || '',
          source: 'sheets',
          items: buildItemTree(items),
          flatItems: items
        }
      };
    } catch (err) {
      return {
        success: false,
        error: err.message || String(err),
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing
      };
    }
  });

  ipcMain.handle('notes-create', async (_e, payload) => {
    try {
      await assertSheetsReady();
      const myEmail = (await resolveMyEmail()) || '';
      const created = await createNoteSpreadsheet(payload?.title, myEmail, []);
      const store = loadStore();
      store.notes.unshift({
        noteId: created.noteId,
        spreadsheetId: created.spreadsheetId,
        title: created.title,
        color: '',
        pinned: false,
        trashed: false,
        role: 'owner',
        ownerEmail: myEmail.toLowerCase(),
        updatedAt: created.updatedAt,
        source: 'sheets'
      });
      saveStore(store);
      return { success: true, noteId: created.noteId, spreadsheetId: created.spreadsheetId };
    } catch (err) {
      return {
        success: false,
        error: err.message || String(err),
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing
      };
    }
  });

  ipcMain.handle('notes-update-title', async (_e, payload) => {
    try {
      const noteId = String(payload?.noteId || '');
      const title = String(payload?.title || '').trim();
      if (!noteId || !title) return { success: false, error: '缺少標題' };
      const { sheetsService, driveService } = await assertSheetsReady();
      const store = loadStore();
      const entry = store.notes.find((n) => n.noteId === noteId);
      if (!entry?.spreadsheetId) return { success: false, error: '找不到試算表 ID' };
      const meta = await readMeta(sheetsService, entry.spreadsheetId);
      meta.title = title;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(sheetsService, entry.spreadsheetId, meta);
      try {
        await withGoogleApiRetry(() => driveService.files.update({
          fileId: entry.spreadsheetId,
          requestBody: { name: `${NOTE_TITLE_PREFIX}${title}`.slice(0, 80) }
        }));
      } catch (_) {}
      entry.title = title;
      entry.updatedAt = meta.updatedAt;
      saveStore(store);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('notes-save-items', async (_e, payload) => {
    try {
      const noteId = String(payload?.noteId || '');
      const { sheetsService } = await assertSheetsReady();
      const store = loadStore();
      const entry = store.notes.find((n) => n.noteId === noteId);
      if (!entry?.spreadsheetId) return { success: false, error: '找不到試算表 ID' };
      let flat = Array.isArray(payload?.flatItems) ? payload.flatItems : [];
      const ids = new Set(flat.map((f) => f.id));
      flat = flat.map((it, idx) => {
        let parentId = String(it.parentId || '');
        if (parentId && !ids.has(parentId)) parentId = '';
        const parent = flat.find((p) => p.id === parentId);
        if (parent?.parentId) parentId = parent.parentId;
        return {
          id: it.id || newId('item'),
          text: String(it.text || ''),
          checked: !!it.checked,
          parentId,
          position: it.position != null ? Number(it.position) : idx + 1,
          updatedAt: new Date().toISOString(),
          detail: String(it.detail || '')
        };
      });
      await writeItems(sheetsService, entry.spreadsheetId, flat);
      const meta = await readMeta(sheetsService, entry.spreadsheetId);
      meta.updatedAt = new Date().toISOString();
      await writeMeta(sheetsService, entry.spreadsheetId, meta);
      entry.updatedAt = meta.updatedAt;
      saveStore(store);
      return { success: true, items: buildItemTree(flat), flatItems: flat };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('notes-set-prefs', async (_e, payload) => {
    try {
      const store = loadStore();
      const entry = store.notes.find((n) => n.noteId === String(payload?.noteId || ''));
      if (!entry) return { success: false, error: '找不到此筆記' };
      if (payload.color !== undefined) entry.color = String(payload.color || '');
      if (payload.pinned !== undefined) entry.pinned = !!payload.pinned;
      saveStore(store);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  /** 分享：對該 Sheet（spreadsheetId）加 writer，不掃 Drive */
  ipcMain.handle('notes-share', async (_e, payload) => {
    try {
      const noteId = String(payload?.noteId || '');
      const peerEmail = String(payload?.email || '').trim().toLowerCase();
      if (!peerEmail.includes('@')) return { success: false, error: '請輸入有效 email' };
      const { sheetsService, driveService } = await assertSheetsReady();
      const store = loadStore();
      const entry = store.notes.find((n) => n.noteId === noteId);
      if (!entry?.spreadsheetId) return { success: false, error: '找不到試算表' };
      if (entry.role !== 'owner') return { success: false, error: '僅 Owner 可邀請' };

      await withGoogleApiRetry(() => driveService.permissions.create({
        fileId: entry.spreadsheetId,
        requestBody: { type: 'user', role: 'writer', emailAddress: peerEmail },
        sendNotificationEmail: true
      }));

      const collab = await readCollaborators(sheetsService, entry.spreadsheetId);
      collab.push(peerEmail);
      await writeCollaborators(sheetsService, entry.spreadsheetId, collab);
      entry.hasCollaborators = true;
      saveStore(store);

      return {
        success: true,
        spreadsheetId: entry.spreadsheetId,
        sheetUrl: `https://docs.google.com/spreadsheets/d/${entry.spreadsheetId}/edit`,
        message: `已分享試算表。請對方在記事按「加入共享」並貼上 Sheet ID：\n${entry.spreadsheetId}`
      };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('notes-revoke', async (_e, payload) => {
    try {
      const noteId = String(payload?.noteId || '');
      const peerEmail = String(payload?.email || '').trim().toLowerCase();
      const { sheetsService, driveService } = await assertSheetsReady();
      const store = loadStore();
      const entry = store.notes.find((n) => n.noteId === noteId);
      if (!entry?.spreadsheetId || entry.role !== 'owner') {
        return { success: false, error: '僅 Owner 可撤銷' };
      }
      try {
        const perms = await withGoogleApiRetry(() => driveService.permissions.list({
          fileId: entry.spreadsheetId,
          fields: 'permissions(id,emailAddress,role)'
        }));
        for (const p of perms.data.permissions || []) {
          if (String(p.emailAddress || '').toLowerCase() === peerEmail && p.role !== 'owner') {
            await driveService.permissions.delete({
              fileId: entry.spreadsheetId,
              permissionId: p.id
            });
          }
        }
      } catch (_) {}
      const collab = (await readCollaborators(sheetsService, entry.spreadsheetId))
        .filter((e) => e !== peerEmail);
      await writeCollaborators(sheetsService, entry.spreadsheetId, collab);
      entry.hasCollaborators = collab.length > 0;
      saveStore(store);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('notes-reorder-tabs', async (_e, payload) => {
    try {
      const ids = Array.isArray(payload?.noteIds) ? payload.noteIds.map(String) : [];
      if (!ids.length) return { success: false, error: '缺少分頁順序' };
      const store = loadStore();
      ids.forEach((id, idx) => {
        const entry = store.notes.find((n) => n.noteId === id);
        if (entry) entry.tabOrder = idx;
      });
      saveStore(store);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  /** 對方用 Sheet ID／網址加入本機索引（只打這一個 ID） */
  ipcMain.handle('notes-join-sheet', async (_e, payload) => {
    try {
      const spreadsheetId = extractSpreadsheetId(payload?.spreadsheetId || payload?.url || payload);
      if (!spreadsheetId) return { success: false, error: '請貼上有效的 Google 試算表 ID 或網址' };
      const { sheetsService } = await assertSheetsReady();
      const myEmail = ((await resolveMyEmail()) || '').toLowerCase();

      // [Important] 先完整驗證，成功才寫本機；加錯 ID 不留下半殘索引
      const meta = await assertValidNoteSpreadsheet(sheetsService, spreadsheetId);

      const store = loadStore();
      if (store.notes.some((n) => n.spreadsheetId === spreadsheetId)) {
        return {
          success: true,
          noteId: store.notes.find((n) => n.spreadsheetId === spreadsheetId).noteId,
          already: true
        };
      }
      const ownerEmail = String(meta.ownerEmail || '').toLowerCase();
      const entry = indexEntryFromMeta(meta, spreadsheetId, {
        role: ownerEmail && ownerEmail === myEmail ? 'owner' : 'collaborator',
        ownerEmail
      });
      store.notes.unshift(entry);
      saveStore(store);
      return { success: true, noteId: entry.noteId, spreadsheetId };
    } catch (err) {
      return {
        success: false,
        error: friendlyJoinError(err, 'notes'),
        needsAuth: !!err.needsAuth,
        featureScopeMissing: !!err.featureScopeMissing,
        invalidSheet: !!err.invalidSheet
      };
    }
  });

  ipcMain.handle('notes-leave', async (_e, payload) => {
    try {
      const store = loadStore();
      const id = String(payload?.noteId || '');
      const entry = store.notes.find((n) => n.noteId === id);
      if (!entry) return { success: false, error: '找不到此筆記' };
      if (entry.role === 'owner') return { success: false, error: 'Owner 請使用刪除' };
      store.notes = store.notes.filter((n) => n.noteId !== id);
      saveStore(store);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('notes-trash', async (_e, payload) => {
    try {
      const store = loadStore();
      const entry = store.notes.find((n) => n.noteId === String(payload?.noteId || ''));
      if (!entry) return { success: false, error: '找不到此筆記' };
      if (entry.role === 'owner' && entry.spreadsheetId) {
        const { sheetsService } = await assertSheetsReady();
        const meta = await readMeta(sheetsService, entry.spreadsheetId);
        meta.trashed = 'true';
        meta.updatedAt = new Date().toISOString();
        await writeMeta(sheetsService, entry.spreadsheetId, meta);
      }
      entry.trashed = true;
      entry.updatedAt = new Date().toISOString();
      saveStore(store);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('notes-restore', async (_e, payload) => {
    try {
      const store = loadStore();
      const entry = store.notes.find((n) => n.noteId === String(payload?.noteId || ''));
      if (!entry) return { success: false, error: '找不到此筆記' };
      if (entry.role === 'owner' && entry.spreadsheetId) {
        const { sheetsService } = await assertSheetsReady();
        const meta = await readMeta(sheetsService, entry.spreadsheetId);
        meta.trashed = 'false';
        meta.updatedAt = new Date().toISOString();
        await writeMeta(sheetsService, entry.spreadsheetId, meta);
      }
      entry.trashed = false;
      entry.updatedAt = new Date().toISOString();
      saveStore(store);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('notes-purge', async (_e, payload) => {
    try {
      const store = loadStore();
      const entry = store.notes.find((n) => n.noteId === String(payload?.noteId || ''));
      if (!entry) return { success: false, error: '找不到此筆記' };
      if (entry.role === 'owner' && entry.spreadsheetId) {
        const { driveService } = await assertSheetsReady();
        try {
          await withGoogleApiRetry(() => driveService.files.delete({ fileId: entry.spreadsheetId }));
        } catch (_) {
          try {
            await driveService.files.update({
              fileId: entry.spreadsheetId,
              requestBody: { trashed: true }
            });
          } catch (__) {}
        }
      }
      store.notes = store.notes.filter((n) => n.noteId !== entry.noteId);
      saveStore(store);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  // 相容舊 preload：明確回傳不可用
  ipcMain.handle('notes-import-keep', async () => ({
    success: false,
    keepApiUnavailable: true,
    error: 'Keep API 授權不可用；請使用試算表分享與「加入共享」。'
  }));

  ipcMain.handle('notes-import-status', async () => ({
    success: true,
    count: loadStore().notes.length,
    keepApiUnavailable: true
  }));

  return { NOTE_COLORS };
}

module.exports = { registerNotesModule };
