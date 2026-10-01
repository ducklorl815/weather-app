/**
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
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, screen, Notification, protocol } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

// [Important] 本檔在 main/ 子目錄；專案根目錄資源（index.html、preload、icon…）必須用 APP_ROOT
const APP_ROOT = path.resolve(__dirname, '..');
const updateConfig = require(path.join(APP_ROOT, 'update-config'));
const { createSyncScheduler } = require('./modules/gchat/sync-scheduler');
const { createSyncService } = require('./modules/gchat/sync-service');
const { createCacheRepository, mergeUnreadInbox, applyInboxLocalRead, removeInboxBySpace } = require('./modules/gchat/cache-repository');
const { createReadSync } = require('./modules/gchat/read-sync');
const { createDetailCache } = require('./modules/gchat/detail-cache');
const { createChatApiService } = require('./modules/gchat/chat-api-service');
const { createPacketRepository } = require('./modules/gchat/packet-repository');
const { createPollCoordinator, threadPollKey } = require('./modules/gchat/poll-coordinator');
const { gchatSyncLog } = require('./modules/gchat/sync-log');
const { createGchatMediaCache } = require('./modules/gchat/media-cache');
const { createSearchService, canonicalGchatPersonKey } = require('./modules/gchat/search-service');
const { createMessageTransformService, isForwardQuoteType, reactionKeyForRow } = require('./modules/gchat/message-transform-service');
const { createDetailPackService } = require('./modules/gchat/detail-pack-service');
const { createReadMarkService } = require('./modules/gchat/read-mark-service');
const { createIconService } = require('./modules/gchat/icon-service');
const { registerGchatIpc } = require('./modules/gchat/ipc');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gchat-emoji',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  }
]);

// [Local Environment] Windows CMD 預設 Big5，UTF-8 繁中會變亂碼；啟動時切到 UTF-8
if (process.platform === 'win32') {
  try {
    execFileSync('chcp', ['65001'], { stdio: 'ignore', windowsHide: true });
  } catch (_) {}
  try {
    if (typeof process.stdout?.setDefaultEncoding === 'function') process.stdout.setDefaultEncoding('utf8');
    if (typeof process.stderr?.setDefaultEncoding === 'function') process.stderr.setDefaultEncoding('utf8');
  } catch (_) {}
}

// App 品牌名稱（避免工作列／系統顯示成 Electron）
const APP_DISPLAY_NAME = 'LifeTour';
const APP_USER_MODEL_ID = 'com.productivity.hub';
try {
  app.setName(APP_DISPLAY_NAME);
  if (process.platform === 'win32') {
    // 必須在 ready 前設定，工作列才不會掛在 Electron.exe 預設名稱
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
} catch (_) {}

// 延後載入 googleapis，避免安裝程式解壓時 uuid/v4.js 被系統鎖住
function getGoogle() {
  if (!getGoogle._api) {
    getGoogle._api = require('googleapis').google;
  }
  return getGoogle._api;
}

// 🔴 請填入您的金鑰

// ========== 【MODULE: authorization/config】OAuth 常數（[Manual] 依環境調整） ==========
const GOOGLE_CLIENT_ID = '527885749373-vkikdv228mjj95n6rsgel6nsbfvv1vpi.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
const OAUTH_CALLBACK_PORT = 3000;
const OAUTH_FLOW_TIMEOUT_MS = 300000;
let oauthHttpServer = null;
let oauthFlowTimer = null;
let oauthFlowChain = Promise.resolve();
const GOOGLE_PROJECT_NUMBER = String(GOOGLE_CLIENT_ID).split('-')[0];
function sheetsApiEnableUrl() {
  return `https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=${GOOGLE_PROJECT_NUMBER}`;
}
function driveApiEnableUrl() {
  return `https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=${GOOGLE_PROJECT_NUMBER}`;
}
function adminApiEnableUrl() {
  return `https://console.developers.google.com/apis/api/admin.googleapis.com/overview?project=${GOOGLE_PROJECT_NUMBER}`;
}
function chatApiEnableUrl() {
  return `https://console.developers.google.com/apis/api/chat.googleapis.com/overview?project=${GOOGLE_PROJECT_NUMBER}`;
}
function chatAppConfigUrl() {
  return `https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=${GOOGLE_PROJECT_NUMBER}`;
}
function tokenPath() { return path.join(app.getPath('userData'), 'google_token.json'); }
function packetPath() { return path.join(app.getPath('userData'), 'gmail_packet.json'); }

/** [Important] Credential Path Probe：開發／安裝版可能各有一份 userData */
let credentialProbeState = {
  migratedFrom: '',
  lastReason: '',
  alternateTokenPath: ''
};

function knownCredentialUserDataDirs() {
  const appData = app.getPath('appData');
  const names = ['LifeTour', 'Electron'];
  const out = [];
  const seen = new Set();
  for (const n of names) {
    const p = path.resolve(path.join(appData, n));
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  const current = path.resolve(app.getPath('userData'));
  if (!seen.has(current)) out.push(current);
  return out;
}

function readTokensFromPath(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const tokens = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!tokens?.access_token && !tokens?.refresh_token) return null;
    return tokens;
  } catch (_) {
    return null;
  }
}

/** 現行無 Credential、備援目錄有 → 自動複製到現行路徑（ADR 0002） */
function maybeMigrateCredentialFromAlternate() {
  const dest = tokenPath();
  if (readTokensFromPath(dest)) {
    credentialProbeState.lastReason = 'ok_present';
    return { migrated: false };
  }
  const activeDir = path.resolve(app.getPath('userData'));
  let best = null;
  for (const dir of knownCredentialUserDataDirs()) {
    if (dir === activeDir) continue;
    const src = path.join(dir, 'google_token.json');
    const tokens = readTokensFromPath(src);
    if (!tokens) continue;
    let mtime = 0;
    try { mtime = fs.statSync(src).mtimeMs || 0; } catch (_) {}
    if (!best || mtime > best.mtime) best = { src, dir, tokens, mtime };
  }
  if (!best) {
    credentialProbeState.lastReason = fs.existsSync(dest) ? 'corrupt_or_empty' : 'missing_file';
    credentialProbeState.alternateTokenPath = '';
    return { migrated: false };
  }
  credentialProbeState.alternateTokenPath = best.src;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(best.src, dest);
    credentialProbeState.migratedFrom = best.src;
    credentialProbeState.lastReason = 'migrated_from_alternate';
    console.log('[Auth] Credential 已從備援目錄複製:', best.src, '→', dest);
    return { migrated: true, from: best.src, to: dest };
  } catch (err) {
    console.warn('[Auth] Credential 遷移失敗:', err.message);
    credentialProbeState.lastReason = 'migrate_failed';
    return { migrated: false, error: err.message, from: best.src };
  }
}

function buildCredentialProbe({ authStatus = '', hasTokens = false } = {}) {
  const userDataPath = app.getPath('userData');
  const tok = tokenPath();
  const disk = readTokensFromPath(tok);
  const alternates = [];
  for (const dir of knownCredentialUserDataDirs()) {
    if (path.resolve(dir) === path.resolve(userDataPath)) continue;
    const p = path.join(dir, 'google_token.json');
    if (readTokensFromPath(p)) alternates.push(p);
  }
  let reason = credentialProbeState.lastReason || '';
  if (!reason) {
    if (disk) reason = hasTokens || authStatus === AUTH_STATUS.AUTHENTICATED ? 'ok_present' : 'present_but_unusable';
    else reason = fs.existsSync(tok) ? 'corrupt_or_empty' : 'missing_file';
  }
  return {
    userDataPath,
    tokenPath: tok,
    hasCredential: !!disk,
    hasRefreshToken: !!disk?.refresh_token,
    hasAccessToken: !!disk?.access_token,
    authStatus: authStatus || sessionState.authStatus,
    reason,
    migratedFrom: credentialProbeState.migratedFrom || '',
    alternateTokenPaths: alternates,
    message: credentialProbeUserMessage(reason, !!disk)
  };
}

function credentialProbeUserMessage(reason, hasDisk) {
  if (reason === 'migrated_from_alternate') {
    return '已從另一個 LifeTour／Electron 資料目錄還原登入資料';
  }
  if (reason === 'missing_file') return '找不到登入資料';
  if (reason === 'corrupt_or_empty') return '登入資料損壞或空白';
  if (reason === 'migrate_failed') return '發現另一份登入資料，但複製失敗';
  if (reason === 'present_but_unusable') return '登入資料在，但授權已失效，請重新連結';
  if (hasDisk) return '登入資料存在';
  return '需要登入或重新連結 Google';
}
function gchatPacketPath() { return path.join(app.getPath('userData'), 'gchat_packet.json'); }
function customEmojiRegistryPath() { return path.join(app.getPath('userData'), 'gchat_custom_emojis.json'); }
function customEmojiImageDir() { return path.join(app.getPath('userData'), 'gchat_custom_emoji_images'); }
function gchatPrefsPath() { return path.join(app.getPath('userData'), 'gchat-prefs.json'); }
function gchatReplyBoundsPath() { return path.join(app.getPath('userData'), 'gchat-reply-bounds.json'); }

/** spaceName／messageName → { x, y, width, height } */

// ========== 【MODULE: modules/gchat-ui】回覆泡泡／Toast／精簡窗 ==========
let replyPopBoundsStore = null;
let replyPopBoundsSaveTimer = null;

function loadReplyPopBoundsStore() {
  if (replyPopBoundsStore) return replyPopBoundsStore;
  replyPopBoundsStore = {};
  try {
    if (fs.existsSync(gchatReplyBoundsPath())) {
      const raw = JSON.parse(fs.readFileSync(gchatReplyBoundsPath(), 'utf8'));
      if (raw && typeof raw === 'object') replyPopBoundsStore = raw;
    }
  } catch (_) {}
  return replyPopBoundsStore;
}

function persistReplyPopBoundsStore() {
  try {
    loadReplyPopBoundsStore();
    fs.writeFileSync(gchatReplyBoundsPath(), JSON.stringify(replyPopBoundsStore));
  } catch (err) {
    console.warn('寫入回覆窗位置失敗:', err.message);
  }
}

function schedulePersistReplyPopBounds() {
  if (replyPopBoundsSaveTimer) clearTimeout(replyPopBoundsSaveTimer);
  replyPopBoundsSaveTimer = setTimeout(() => {
    replyPopBoundsSaveTimer = null;
    persistReplyPopBoundsStore();
  }, 400);
}

function replyPopBoundsKey(spaceName, messageName) {
  return String(spaceName || messageName || '').trim();
}

function clampReplyPopBounds(bounds) {
  const display = screen.getPrimaryDisplay().workArea;
  const minW = 320;
  const minH = 280;
  let width = Math.max(minW, Math.min(Number(bounds?.width) || REPLY_POP_WIDTH, display.width));
  let height = Math.max(minH, Math.min(Number(bounds?.height) || REPLY_POP_HEIGHT, display.height));
  let x = Number.isFinite(bounds?.x) ? Math.round(bounds.x) : Math.round(display.x + display.width - width - 16);
  const barReserve = replyPopBarStackReserve();
  let y = Number.isFinite(bounds?.y)
    ? Math.round(bounds.y)
    : Math.round(display.y + display.height - height - barReserve);
  x = Math.min(Math.max(display.x, x), display.x + display.width - Math.min(width, display.width));
  y = Math.min(Math.max(display.y, y), display.y + display.height - Math.min(height, display.height));
  return { x, y, width, height };
}

function getReplyPopWorkArea(win) {
  try {
    const b = win.getBounds();
    return screen.getDisplayMatching(b).workArea;
  } catch (_) {
    return screen.getPrimaryDisplay().workArea;
  }
}

/** Windows 無框視窗雙擊全螢幕常不會回報 isMaximized，改以尺寸判斷 */
function isReplyPopEffectivelyMaximized(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isFullScreen?.()) return true;
  if (win.isMaximized?.()) return true;
  try {
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const tol = 20;
    return b.width >= area.width - tol
      && b.height >= area.height - tol
      && Math.abs(b.x - area.x) <= tol
      && Math.abs(b.y - area.y) <= tol;
  } catch (_) {
    return false;
  }
}

function captureReplyPopDisplayMode(entry) {
  if (!entry?.win || entry.win.isDestroyed()) return 'normal';
  const win = entry.win;
  if (win.isFullScreen?.()) return 'fullscreen';
  if (win.isMaximized?.() || isReplyPopEffectivelyMaximized(win)) return 'maximized';
  return 'normal';
}

function fillReplyPopWorkArea(win) {
  if (!win || win.isDestroyed()) return;
  const area = getReplyPopWorkArea(win);
  win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height }, true);
}

async function applyReplyPopExpandedDisplayMode(entry) {
  if (!entry?.win || entry.win.isDestroyed() || entry.minimized) return;
  const mode = entry.expandedDisplayMode || 'normal';
  if (mode === 'normal') return;
  const win = entry.win;
  try {
    exitReplyPopExpandedDisplayStateSync(win);
    win.setResizable(true);
    win.setMaximizable(true);
    win.setMinimumSize(320, 280);
    win.setMaximumSize(10000, 10000);
  } catch (_) {}
  await new Promise(r => setTimeout(r, 40));
  try {
    if (mode === 'fullscreen') {
      try { win.setFullScreen(true); } catch (_) {}
      await new Promise(r => setTimeout(r, 60));
      if (!win.isFullScreen?.() && !isReplyPopEffectivelyMaximized(win)) fillReplyPopWorkArea(win);
    } else {
      fillReplyPopWorkArea(win);
    }
  } catch (_) {}
}

async function toggleReplyPopFullscreen(entry) {
  if (!entry?.win || entry.win.isDestroyed() || entry.minimized) {
    return { success: false, error: '視窗不可用' };
  }
  const win = entry.win;
  const expanded = entry.expandedDisplayMode === 'maximized'
    || entry.expandedDisplayMode === 'fullscreen'
    || captureReplyPopDisplayMode(entry) !== 'normal';

  if (expanded) {
    await exitReplyPopExpandedDisplayState(win);
    entry.expandedDisplayMode = 'normal';
    positionReplyPopExpanded(win, entry);
    return { success: true, mode: 'normal' };
  }

  captureReplyPopExpandedBounds(entry);
  entry.expandedDisplayMode = 'maximized';
  await applyReplyPopExpandedDisplayMode(entry);
  return { success: true, mode: 'maximized' };
}

function exitReplyPopExpandedDisplayStateSync(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isFullScreen()) win.setFullScreen(false);
  } catch (_) {}
  try {
    if (win.isMaximized()) win.unmaximize();
  } catch (_) {}
}

function exitReplyPopExpandedDisplayState(win) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    let waits = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const arm = (eventName, shouldAct, act) => {
      try {
        if (!shouldAct()) return;
        waits += 1;
        win.once(eventName, () => {
          waits -= 1;
          if (waits <= 0) finish();
        });
        act();
      } catch (_) {}
    };
    arm('leave-full-screen', () => win.isFullScreen(), () => win.setFullScreen(false));
    arm('unmaximize', () => win.isMaximized(), () => win.unmaximize());
    if (waits === 0) finish();
    else setTimeout(finish, 280);
  });
}

function captureReplyPopExpandedBounds(entry) {
  if (!entry || entry.minimized || !entry.win || entry.win.isDestroyed()) return null;
  try {
    const win = entry.win;
    // [Important] 全螢幕／最大化時的 bounds 不可當成還原尺寸
    if (win.isMaximized?.() || win.isFullScreen?.() || isReplyPopEffectivelyMaximized(win)) {
      return entry.expandedBounds || null;
    }
    const b = win.getBounds();
    if (!b || b.width < 200 || b.height < 120) return entry.expandedBounds || null;
    entry.expandedBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    const key = replyPopBoundsKey(entry.spaceName, entry.messageName);
    if (key) {
      loadReplyPopBoundsStore();
      replyPopBoundsStore[key] = { ...entry.expandedBounds };
      schedulePersistReplyPopBounds();
    }
    return entry.expandedBounds;
  } catch (_) {
    return entry.expandedBounds || null;
  }
}

function resolveReplyPopExpandedBounds(entry) {
  const key = replyPopBoundsKey(entry?.spaceName, entry?.messageName);
  loadReplyPopBoundsStore();
  const saved = entry?.expandedBounds
    || (key && replyPopBoundsStore[key])
    || null;
  if (saved) return clampReplyPopBounds(saved);
  const display = screen.getPrimaryDisplay().workArea;
  return clampReplyPopBounds({
    width: REPLY_POP_WIDTH,
    height: Math.min(REPLY_POP_HEIGHT, Math.floor(display.height * 0.78))
  });
}

function loadGchatPrefs() {
  try {
    if (fs.existsSync(gchatPrefsPath())) {
      const raw = JSON.parse(fs.readFileSync(gchatPrefsPath(), 'utf8'));
      return {
        alertPopup: true,
        closeToTray: true,
        pinnedContacts: [],
        pinnedSpaces: [],
        ...raw,
        pinnedContacts: Array.isArray(raw.pinnedContacts) ? raw.pinnedContacts.slice(0, 40) : [],
        pinnedSpaces: Array.isArray(raw.pinnedSpaces) ? raw.pinnedSpaces.slice(0, 40) : []
      };
    }
  } catch (_) {}
  return { alertPopup: true, closeToTray: true, pinnedContacts: [], pinnedSpaces: [] };
}

function saveGchatPrefs(prefs) {
  const prev = loadGchatPrefs();
  const next = {
    alertPopup: prefs?.alertPopup !== undefined ? !!prefs.alertPopup : prev.alertPopup !== false,
    closeToTray: prefs?.closeToTray !== undefined ? !!prefs.closeToTray : prev.closeToTray !== false,
    pinnedContacts: Array.isArray(prefs?.pinnedContacts)
      ? prefs.pinnedContacts.slice(0, 40)
      : (prev.pinnedContacts || []),
    pinnedSpaces: Array.isArray(prefs?.pinnedSpaces)
      ? prefs.pinnedSpaces.slice(0, 40)
      : (prev.pinnedSpaces || [])
  };
  fs.writeFileSync(gchatPrefsPath(), JSON.stringify(next));
  return next;
}

let win;
/** [Important] report-export 模組控制項（Scheduler start/stop）；register 後賦值 */
let reportExportControls = null;
let sitesDeptOrgWin = null;
let tray = null;
let toastWin = null;
let replyPopWin = null;
let replyPopMessageName = '';
/** 精簡回覆視窗：messageName → { win, minimized, title }；minimizedReplyOrder[0] 為最右側 */
const replyPopRegistry = new Map();
const minimizedReplyOrder = [];
/** bar 預打包進行中，避免同一對話重複請求 */
const replyPopPrefetchInFlight = new Set();
const REPLY_POP_WIDTH = 440;
const REPLY_POP_HEIGHT = 700;
const REPLY_BAR_WIDTH = 220;
const REPLY_BAR_HEIGHT = 36;
const REPLY_BAR_GAP = 8;
const REPLY_BAR_MARGIN = 12;
/** 紅點凸出 bar 外所需邊距（避免被視窗裁切） */
const REPLY_BAR_BADGE_PAD = 10;
/**
 * [Manual] 右下角第 1 格留給系統／其他功能，最小化 bar 從第 2 格起往左排
 * 0 = 貼最右；1 = 空出一格（預設）
 */
const REPLY_BAR_RIGHT_SLOT_SKIP = 1;
/** [Manual] 最小化 bar 額外下移，置頂但貼近工作區底緣 */
const REPLY_BAR_BOTTOM_EXTRA = -5;
/** 展開泡泡框預設位置：底緣離開右下角縮小 bar 的額外間距 */
const REPLY_BAR_STACK_CLEARANCE = 16;
/** [Important] 最小化 bar 視窗必須全透明；切換主題時不可套用 cardBg */
const REPLY_BAR_WINDOW_BG = '#00000000';

/** 與主視窗風格一致的主題色（泡泡框／最小化 bar 共用） */
const APP_THEME_PALETTE = {
  light: { cardBg: '#fffcf7', bg: '#ebe6df' },
  dark: { cardBg: '#1c1b20', bg: '#0f0e11' },
  forest: { cardBg: '#f3faf1', bg: '#d7e6d4' },
  ocean: { cardBg: '#f1f7fb', bg: '#d4e3ee' },
  clay: { cardBg: '#fbf4ed', bg: '#ead8ca' },
  ink: { cardBg: '#172033', bg: '#0c1220' },
  matcha: { cardBg: '#f7f5e6', bg: '#e5e2c8' }
};
let currentAppTheme = 'light';

function appThemePath() {
  return path.join(app.getPath('userData'), 'app-theme.json');
}

function loadAppTheme() {
  try {
    const raw = JSON.parse(fs.readFileSync(appThemePath(), 'utf8'));
    if (raw?.theme && APP_THEME_PALETTE[raw.theme]) currentAppTheme = raw.theme;
  } catch (_) {}
  return currentAppTheme;
}

function saveAppTheme(theme) {
  const id = APP_THEME_PALETTE[theme] ? theme : 'light';
  currentAppTheme = id;
  try {
    fs.writeFileSync(appThemePath(), JSON.stringify({ theme: id }));
  } catch (_) {}
  return id;
}

function themeCardBg(theme = currentAppTheme) {
  return APP_THEME_PALETTE[theme]?.cardBg || APP_THEME_PALETTE.light.cardBg;
}

function isReplyPopBarWindow(targetWin) {
  if (!targetWin) return false;
  for (const entry of replyPopRegistry.values()) {
    if (entry.barWin === targetWin) return true;
  }
  return false;
}

let gchatQuickSearchWin = null;

function clampQuickSearchBounds(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  const maxX = area.x + area.width - width - 8;
  const maxY = area.y + area.height - height - 8;
  return {
    x: Math.min(Math.max(area.x + 8, x), maxX),
    y: Math.min(Math.max(area.y + 8, y), maxY),
    width,
    height
  };
}

let gchatQuickSearchBlurTimer = null;

function openGchatQuickSearchWindow() {
  // [Important] ADR 0006：Little Reply Feature Off 時停用 Quick Search
  if (!isFeatureActive('gchat')) return null;
  const pt = screen.getCursorScreenPoint();
  const width = 340;
  const height = 420;
  const bounds = clampQuickSearchBounds(pt.x, pt.y + 14, width, height);
  if (gchatQuickSearchWin && !gchatQuickSearchWin.isDestroyed()) {
    gchatQuickSearchWin.setBounds(bounds);
    if (!gchatQuickSearchWin.isVisible()) gchatQuickSearchWin.show();
    try { app.focus({ steal: true }); } catch (_) {}
    gchatQuickSearchWin.focus();
    try { gchatQuickSearchWin.webContents.send('app-theme', currentAppTheme); } catch (_) {}
    try { gchatQuickSearchWin.webContents.send('gchat-quick-search-open'); } catch (_) {}
    return gchatQuickSearchWin;
  }
  gchatQuickSearchWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  try {
    gchatQuickSearchWin.setAlwaysOnTop(true, GCHAT_REPLY_Z);
    gchatQuickSearchWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (_) {}
  gchatQuickSearchWin.loadFile(path.join(APP_ROOT, 'gchat-quick-search-pop.html'));
  gchatQuickSearchWin.webContents.on('did-finish-load', () => {
    if (!gchatQuickSearchWin || gchatQuickSearchWin.isDestroyed()) return;
    try { gchatQuickSearchWin.webContents.send('app-theme', currentAppTheme); } catch (_) {}
  });
  gchatQuickSearchWin.once('ready-to-show', () => {
    if (!gchatQuickSearchWin || gchatQuickSearchWin.isDestroyed()) return;
    gchatQuickSearchWin.show();
    try { app.focus({ steal: true }); } catch (_) {}
    gchatQuickSearchWin.focus();
  });
  gchatQuickSearchWin.on('blur', () => {
    if (gchatQuickSearchBlurTimer) clearTimeout(gchatQuickSearchBlurTimer);
    gchatQuickSearchBlurTimer = setTimeout(() => {
      gchatQuickSearchBlurTimer = null;
      if (!gchatQuickSearchWin || gchatQuickSearchWin.isDestroyed()) return;
      if (!gchatQuickSearchWin.isFocused()) hideGchatQuickSearchWindow();
    }, 320);
  });
  gchatQuickSearchWin.on('focus', () => {
    if (gchatQuickSearchBlurTimer) {
      clearTimeout(gchatQuickSearchBlurTimer);
      gchatQuickSearchBlurTimer = null;
    }
  });
  gchatQuickSearchWin.on('closed', () => {
    gchatQuickSearchWin = null;
  });
  return gchatQuickSearchWin;
}

function hideGchatQuickSearchWindow() {
  if (!gchatQuickSearchWin || gchatQuickSearchWin.isDestroyed()) return;
  gchatQuickSearchWin.hide();
}

function broadcastAppTheme(theme = currentAppTheme) {
  const id = APP_THEME_PALETTE[theme] ? theme : 'light';
  currentAppTheme = id;
  const bg = themeCardBg(id);
  const sendTheme = (targetWin) => {
    if (!targetWin || targetWin.isDestroyed()) return;
    try {
      // bar 為 transparent 視窗；setBackgroundColor(cardBg) 會出現整條白底
      targetWin.setBackgroundColor(isReplyPopBarWindow(targetWin) ? REPLY_BAR_WINDOW_BG : bg);
      targetWin.webContents.send('app-theme', id);
    } catch (_) {}
  };
  sendTheme(win);
  sendTheme(toastWin);
  sendTheme(gchatQuickSearchWin);
  for (const entry of replyPopRegistry.values()) {
    sendTheme(entry.win);
    sendTheme(entry.barWin);
  }
}

const FONT_SCALE_OPTIONS = [0.75, 1, 1.25, 1.5];
let currentAppFontScale = 1;

function appFontScalePath() {
  return path.join(app.getPath('userData'), 'app-font-scale.json');
}

function normalizeFontScale(scale) {
  const n = Number(scale);
  return FONT_SCALE_OPTIONS.some((v) => Math.abs(v - n) < 0.001) ? n : 1;
}

function loadAppFontScale() {
  try {
    const raw = JSON.parse(fs.readFileSync(appFontScalePath(), 'utf8'));
    if (raw?.scale != null) currentAppFontScale = normalizeFontScale(raw.scale);
  } catch (_) {}
  return currentAppFontScale;
}

function saveAppFontScale(scale) {
  const s = normalizeFontScale(scale);
  currentAppFontScale = s;
  try {
    fs.writeFileSync(appFontScalePath(), JSON.stringify({ scale: s }));
  } catch (_) {}
  return s;
}

function broadcastAppFontScale(scale = currentAppFontScale) {
  const s = normalizeFontScale(scale);
  currentAppFontScale = s;
  const sendAll = (targetWin) => {
    if (!targetWin || targetWin.isDestroyed()) return;
    try { targetWin.webContents.send('app-font-scale', s); } catch (_) {}
  };
  sendAll(win);
  sendAll(toastWin);
  for (const entry of replyPopRegistry.values()) {
    sendAll(entry.win);
    sendAll(entry.barWin);
  }
}

function replyPopBarStackReserve() {
  return REPLY_BAR_HEIGHT + REPLY_BAR_BADGE_PAD + REPLY_BAR_MARGIN + REPLY_BAR_STACK_CLEARANCE;
}
let isQuitting = false;
let oauth2Client;
let calendarService, gmailService, peopleService, sheetsService, chatService, adminService, driveService, keepService;
let syncTimer = null;
let meetingTimer = null;
const GMAIL_SYNC_MS = 60 * 1000;
const promptedMeetings = new Set();
let meetingPromptBusy = false;
let sessionWatchTimer = null;

/**
 * [Important] ADR 0006 — Active Feature List
 * Renderer mosaic 為準；未收到清單前不得啟動任何功能背景。
 */
let activeFeaturesReceived = false;
const activeFeatureSet = new Set();

function isFeatureActive(type) {
  return activeFeaturesReceived && activeFeatureSet.has(String(type || '').trim());
}

function getActiveFeatureList() {
  return [...activeFeatureSet];
}

/** Phase 1：授權 UI 狀態（與磁碟 credential 分離） */
const AUTH_STATUS = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_REFRESHING: 'AUTH_REFRESHING',
  AUTHENTICATED: 'AUTHENTICATED',
  AUTH_REVOKED: 'AUTH_REVOKED',
  FEATURE_SCOPE_MISSING: 'FEATURE_SCOPE_MISSING',
  OFFLINE: 'OFFLINE'
};

const sessionState = {
  authed: false,
  offline: false,
  lastCheck: 0,
  lastError: '',
  authStatus: AUTH_STATUS.AUTH_REQUIRED
};

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CHAT_MESSAGES_SCOPE = 'https://www.googleapis.com/auth/chat.messages';
const CHAT_READSTATE_SCOPE = 'https://www.googleapis.com/auth/chat.users.readstate';
const CHAT_SPACES_SCOPE = 'https://www.googleapis.com/auth/chat.spaces.readonly';
const CHAT_SPACES_WRITE_SCOPE = 'https://www.googleapis.com/auth/chat.spaces';
const CHAT_MEMBERSHIPS_SCOPE = 'https://www.googleapis.com/auth/chat.memberships.readonly';
const CHAT_SPACESETTINGS_SCOPE = 'https://www.googleapis.com/auth/chat.users.spacesettings';
const CHAT_CUSTOM_EMOJI_SCOPE = 'https://www.googleapis.com/auth/chat.customemojis.readonly';
const CHAT_DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/directory.readonly';
const CHAT_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
/** Little Reply Core：Inbox／Reply Pop 主路徑（Scope Registry） */
const GCHAT_CORE_SCOPES = [
  CHAT_MESSAGES_SCOPE,
  CHAT_READSTATE_SCOPE,
  CHAT_SPACES_SCOPE,
  CHAT_SPACES_WRITE_SCOPE,
  CHAT_MEMBERSHIPS_SCOPE,
  CHAT_SPACESETTINGS_SCOPE
];
/** Little Reply Extended：目錄／表情等，缺了不擋主路徑 */
const GCHAT_EXTENDED_SCOPES = [
  CHAT_CUSTOM_EMOJI_SCOPE,
  CHAT_DIRECTORY_SCOPE,
  CHAT_CONTACTS_SCOPE
];
/** @deprecated 用 GCHAT_CORE_SCOPES + GCHAT_EXTENDED_SCOPES */
const CHAT_SCOPES = [
  ...GCHAT_CORE_SCOPES,
  CHAT_CUSTOM_EMOJI_SCOPE
];

/** 登入只要身分；各功能 scopes 在加入／使用時再獨立授權 */
const GOOGLE_BASE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

const FEATURE_SCOPE_MAP = {
  calendar: ['https://www.googleapis.com/auth/calendar'],
  gmail: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/contacts.other.readonly'
  ],
  // [Important] Scope Registry：gchat gate = Core；Extended 另列，Full Login 仍一次請求
  gchat: [...GCHAT_CORE_SCOPES],
  sheets: [SHEETS_SCOPE, DRIVE_FILE_SCOPE],
  // 記事：Sheets by spreadsheetId（列表用本機索引；內容只打該 Sheet ID）
  notes: [SHEETS_SCOPE, DRIVE_FILE_SCOPE],
  sitesVisits: [SHEETS_SCOPE],
  chat: ['https://www.googleapis.com/auth/cloud-platform'],
  // SQL 報表匯出：Google Drive 輸出需要 drive.file（Local 不強制，但 Scope Registry 仍登錄）
  reportExport: [SHEETS_SCOPE, DRIVE_FILE_SCOPE]
};

const FEATURE_LABELS = {
  calendar: '預定行程',
  gmail: '未讀郵件',
  gchat: 'Little Reply',
  sheets: '9527',
  notes: '記事',
  sitesVisits: '網站瀏覽紀錄',
  chat: '詢問機器人',
  reportExport: 'SQL 清單列表'
};

/** [Important] 授權一律請求全部功能 scope，不再依工作台 widget 分批 */
function allFeatureTypes() {
  return Object.keys(FEATURE_SCOPE_MAP);
}

function allApplicationScopes() {
  const seen = new Set();
  const scopes = [];
  const add = (s) => {
    const v = String(s || '').trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      scopes.push(v);
    }
  };
  for (const s of GOOGLE_BASE_SCOPES) add(s);
  for (const list of Object.values(FEATURE_SCOPE_MAP)) {
    for (const s of list) add(s);
  }
  for (const s of GCHAT_EXTENDED_SCOPES) add(s);
  return scopes;
}

/** 授權後同步順序：Little Reply → 郵件 → 行程 → 其餘 */
const FEATURE_SYNC_PRIORITY = ['gchat', 'gmail', 'calendar', 'notes', 'sheets', 'sitesVisits', 'chat'];

/** @deprecated 僅相容舊流程；登入勿再一次要全部 */
const GOOGLE_SCOPES = [
  ...GOOGLE_BASE_SCOPES,
  ...FEATURE_SCOPE_MAP.calendar,
  ...FEATURE_SCOPE_MAP.gmail,
  ...GCHAT_CORE_SCOPES,
  ...GCHAT_EXTENDED_SCOPES,
  ...FEATURE_SCOPE_MAP.sheets,
  ...FEATURE_SCOPE_MAP.chat
];

const cache = {
  emails: [],
  labels: [],
  allLabels: [],
  details: {},
  contacts: [],
  myEmail: '',
  lastSync: 0,
  syncing: false
};
const pending = {
  markRead: new Set(),
  replies: []
};

const gchatCache = {
  messages: [],
  packets: {},
  spaceNames: {},
  spaceTypes: {},
  userNames: {},
  spaceMute: {},
  myUserName: '',
  myIds: [],
  myLabels: [],
  spaceList: [],
  spaceListAt: 0,
  directoryWarmed: false,
  directorySyncedAt: 0,
  directoryError: '',
  directoryStats: { admin: 0, people: 0 },
  lastSync: 0,
  syncing: false,
  packing: false,
  /** 今天點過／回過的對話，已讀後仍留在列表追蹤 */
  todayTouched: [],
  /** 本人已加的表情：messageName → { reactionKey → reactionResourceName } */
  myReactions: {},
  /** uid → { uid, emojiName, imageUrl, name } */
  customEmojis: {},
  /** normalized name → uid */
  customEmojisByName: {},
  customEmojisAt: 0,
  /** users/{id} → { emoji, iconUrl }（People photos／Chat member） */
  userIcons: {},
  /** spaces/{id} → { emoji, iconUrl }（spaces.get 探測＋ DM 對方大頭） */
  spaceIcons: {}
};
let gchatIconService = null;
/** ListCustomEmojis 配額用盡時暫停 API 直到此時間 */
let customEmojiQuotaBlockedUntil = 0;
let customEmojiQuotaLogged = false;
const customEmojiDownloadQueue = new Set();
const CUSTOM_EMOJI_HYDRATE_BATCH = 36;
const CUSTOM_EMOJI_HYDRATE_GAP_MS = 150;
const CHAT_API_QUOTA_BACKOFF_MS = 30 * 60 * 1000;
const CHAT_MEDIA_HYDRATE_LIMIT = 12;
let chatApiQuotaBlockedUntil = 0;
let chatApiQuotaLogged = false;
let gchatAuthBootstrapAt = 0;
const CUSTOM_EMOJI_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 網域通訊錄快取：每日最多向 API 同步一次（啟動時優先用磁碟快取） */
const GCHAT_DIRECTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CUSTOM_EMOJI_QUOTA_BACKOFF_MS = 12 * 60 * 60 * 1000;
const gchatPending = {
  /** @type {Map<string, { createTime?: string, threadName?: string, spaceName?: string }>} */
  markRead: new Map()
};
/** 本機已讀（含串訊息 API 無法標已讀時），避免一直再出現 */
const gchatLocallyRead = new Set();
/** 空間級已讀水位：createTime <= 此值視為已讀（Google 未同步時仍擋重複提醒） */
const gchatLocallyReadSpaces = new Map();

function initGoogleServices() {
  const google = getGoogle();
  calendarService = google.calendar({ version: 'v3', auth: oauth2Client });
  gmailService = google.gmail({ version: 'v1', auth: oauth2Client });
  peopleService = google.people({ version: 'v1', auth: oauth2Client });
  sheetsService = google.sheets({ version: 'v4', auth: oauth2Client });
  driveService = google.drive({ version: 'v3', auth: oauth2Client });
  try {
    keepService = google.keep({ version: 'v1', auth: oauth2Client });
  } catch (_) {
    keepService = null;
  }
  chatService = google.chat({ version: 'v1', auth: oauth2Client });
  adminService = null; // 一般員工改用 People directory.readonly，不再打 Admin SDK
}

function loadDiskPacket() {
  try {
    if (!fs.existsSync(packetPath())) return;
    const data = JSON.parse(fs.readFileSync(packetPath(), 'utf8'));
    cache.emails = data.emails || [];
    cache.labels = data.labels || [];
    cache.contacts = data.contacts || [];
    cache.myEmail = data.myEmail || '';
    cache.lastSync = data.lastSync || 0;
    pending.markRead = new Set(data.pendingMarkRead || []);
    pending.replies = data.pendingReplies || [];
  } catch (err) {
    console.error('讀取暫存封包失敗:', err.message);
  }
}

function saveDiskPacket() {
  try {
    fs.writeFileSync(packetPath(), JSON.stringify({
      emails: cache.emails,
      labels: cache.labels,
      contacts: cache.contacts,
      myEmail: cache.myEmail,
      lastSync: cache.lastSync,
      pendingMarkRead: [...pending.markRead],
      pendingReplies: pending.replies
    }));
  } catch (err) {
    console.error('寫入暫存封包失敗:', err.message);
  }
}

function safeUnlinkSync(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    fs.unlinkSync(filePath);
    return;
  } catch (err) {
    const code = String(err?.code || '');
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
      try { fs.writeFileSync(filePath, '{}'); } catch (_) {}
    }
  }
}

function clearPacket() {
  cache.emails = [];
  cache.labels = [];
  cache.allLabels = [];
  cache.details = {};
  cache.contacts = [];
  cache.myEmail = '';
  cache.lastSync = 0;
  pending.markRead.clear();
  pending.replies = [];
  safeUnlinkSync(packetPath());
  gchatCache.messages = [];
  gchatCache.spaceNames = {};
  gchatCache.spaceTypes = {};
  gchatCache.userNames = {};
  gchatCache.userIcons = {};
  gchatCache.spaceIcons = {};
  gchatCache.spaceMute = {};
  gchatIconService = null;
  gchatCache.myUserName = '';
  gchatCache.myIds = [];
  gchatCache.myLabels = [];
  gchatCache.directoryWarmed = false;
  gchatCache.directorySyncedAt = 0;
  gchatCache.directoryError = '';
  gchatCache.directoryStats = { admin: 0, people: 0 };
  gchatCache.lastSync = 0;
  gchatCache.todayTouched = [];
  gchatPending.markRead.clear();
  gchatLocallyRead.clear();
  gchatLocallyReadSpaces.clear();
  ensureGchatPacketRepository().clear();
  if (gchatPollCoordinator) gchatPollCoordinator.clearInterests();
  gchatPollCoordinator = null;
  safeUnlinkSync(gchatPacketPath());
}

function shutdownLittleReplyForLogout() {
  stopGchatSyncScheduler();
  stopViewingRefreshWatch();
  gchatViewing = null;
  if (gchatQuickSearchWin && !gchatQuickSearchWin.isDestroyed()) {
    try { gchatQuickSearchWin.destroy(); } catch (_) {}
    gchatQuickSearchWin = null;
  }
  const entries = [...replyPopRegistry.values()];
  for (const entry of entries) {
    try {
      if (entry.barWin && !entry.barWin.isDestroyed()) entry.barWin.destroy();
    } catch (_) {}
    try {
      if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
    } catch (_) {}
  }
  replyPopRegistry.clear();
  minimizedReplyOrder.length = 0;
  replyPopWin = null;
  replyPopMessageName = '';
}

/**
 * Little Reply Feature Off（ADR 0006）：關衛星窗＋停背景，保留 Session／Credential／磁碟 cache。
 * 與 logout 不同：不清 Credential、不 unlink packet 檔。
 */
function featureOffLittleReply() {
  shutdownLittleReplyForLogout();
  if (gchatPollCoordinator) {
    try { gchatPollCoordinator.clearInterests(); } catch (_) {}
  }
  mainGchatAlertSeeded = false;
  mainGchatAlerted.clear();
  mainGchatAlertedAt.clear();
  pinnedGroupAlertCursors.clear();
  try {
    if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
  } catch (_) {}
}

function packetSnapshot(labelId) {
  let emails = cache.emails.filter(e => e.isUnread !== false && (e.labelIds || []).includes('UNREAD'));
  if (labelId) {
    emails = emails.filter(e => (e.labelIds || []).includes(labelId));
  }
  const inboxLabel = (cache.allLabels || []).find(l => l.id === 'INBOX');
  return {
    success: true,
    emails,
    labels: cache.labels,
    inboxUnread: Number(inboxLabel?.messagesUnread) || 0,
    contacts: cache.contacts,
    lastSync: cache.lastSync,
    syncing: cache.syncing,
    pending: { markRead: pending.markRead.size, replies: pending.replies.length }
  };
}

function notifyRenderer() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('gmail-packet', packetSnapshot());
  }
}

function startSyncLoop() {
  // [Important] ADR 0006：Gmail 背景僅在 Active Feature 時啟動；會議提醒改綁 Calendar
  if (!isFeatureActive('gmail')) return;
  loadDiskPacket();
  notifyRenderer();
  if (syncTimer) clearInterval(syncTimer);
  runSync();
  syncTimer = setInterval(runSync, GMAIL_SYNC_MS);
}

function stopSyncLoop() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

function extractMeetingUrl(event) {
  if (event?.hangoutLink) return event.hangoutLink;
  const entries = event?.conferenceData?.entryPoints || [];
  const video = entries.find(e => e.entryPointType === 'video' && e.uri);
  if (video?.uri) return video.uri;
  const more = entries.find(e => e.uri && /^https?:\/\//i.test(e.uri));
  if (more?.uri) return more.uri;
  const blob = [event?.location, event?.description].filter(Boolean).join('\n');
  const match = blob.match(
    /https?:\/\/(?:meet\.google\.com\/[^\s<>"'）】]+|(?:[\w.-]+\.)?zoom\.us\/[^\s<>"'）】]+|(?:teams\.microsoft\.com|teams\.live\.com)\/[^\s<>"'）】]+|(?:[\w.-]+\.)?webex\.com\/[^\s<>"'）】]+)/i
  );
  return match ? match[0].replace(/[),.，。]+$/, '') : null;
}

function startMeetingWatch() {
  // [Important] ADR 0006：會議提醒綁 Calendar Active，不掛在 Gmail sync loop
  if (!isFeatureActive('calendar')) return;
  if (meetingTimer) clearInterval(meetingTimer);
  checkMeetingReminders();
  meetingTimer = setInterval(checkMeetingReminders, 30000);
}

function stopMeetingWatch() {
  if (meetingTimer) {
    clearInterval(meetingTimer);
    meetingTimer = null;
  }
}

async function tryStartGmailBackground() {
  if (!isFeatureActive('gmail') || !oauth2Client) return;
  try {
    const scope = await grantedScopeText();
    if (!scopeListHas(scope, FEATURE_SCOPE_MAP.gmail)) return;
  } catch (_) {
    return;
  }
  if (!syncTimer) startSyncLoop();
}

async function tryStartLittleReplyBackground() {
  if (!isFeatureActive('gchat') || !oauth2Client || !chatService) return;
  try {
    const scope = await grantedScopeText();
    if (!hasChatScopes(scope)) return;
  } catch (_) {
    return;
  }
  // [Important] ADR 0006：僅 Active Feature 才預載／開 scheduler（勿綁 Session）
  bootstrapGchatAuthCache({ force: false }).catch((err) => {
    console.warn('[GChat] Active Feature 預載通訊錄／表情失敗:', err?.message || err);
  });
  startGchatSyncScheduler();
}

/** 依 Active Feature List 對齊背景（未收到清單則 no-op） */
async function reconcileActiveFeatureBackgrounds() {
  if (!activeFeaturesReceived) return;
  if (isFeatureActive('gmail')) await tryStartGmailBackground();
  else stopSyncLoop();
  if (isFeatureActive('calendar')) startMeetingWatch();
  else stopMeetingWatch();
  if (isFeatureActive('gchat')) await tryStartLittleReplyBackground();
  else featureOffLittleReply();
  // SQL 報表匯出：App 內 Scheduler（Phase 3）
  if (isFeatureActive('reportExport')) {
    try { reportExportControls?.startScheduler?.(); } catch (_) {}
  } else {
    try { reportExportControls?.stopScheduler?.(); } catch (_) {}
  }
}

/**
 * Renderer 推送 Active Feature List（mosaic 為準）。
 * @param {string[]} types
 */
function setActiveFeatureList(types) {
  const next = new Set(
    (Array.isArray(types) ? types : [])
      .map((t) => String(t || '').trim())
      .filter(Boolean)
  );
  const prevHadGchat = activeFeatureSet.has('gchat');
  activeFeaturesReceived = true;
  activeFeatureSet.clear();
  for (const t of next) activeFeatureSet.add(t);

  if (prevHadGchat && !next.has('gchat')) {
    featureOffLittleReply();
  } else if (!next.has('gchat')) {
    stopGchatSyncScheduler();
    try {
      if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
    } catch (_) {}
  }
  if (!next.has('gmail')) stopSyncLoop();
  if (!next.has('calendar')) stopMeetingWatch();
  if (!next.has('reportExport')) {
    try { reportExportControls?.stopScheduler?.(); } catch (_) {}
  }

  reconcileActiveFeatureBackgrounds().catch((err) => {
    console.warn('[ActiveFeatures] reconcile failed:', err?.message || err);
  });
  return { success: true, features: getActiveFeatureList(), received: true };
}

async function checkMeetingReminders() {
  if (!calendarService || meetingPromptBusy) return;
  try {
    const calList = await withGoogleApiRetry(() => calendarService.calendarList.list({ maxResults: 250 }));
    const calendars = (calList.data.items || []).filter(c => c.hidden !== true);
    const now = Date.now();
    const timeMin = new Date(now - 2 * 60 * 1000).toISOString();
    const timeMax = new Date(now + 10 * 60 * 1000).toISOString();
    const candidates = [];

    await Promise.all(calendars.map(async (cal) => {
      try {
        const res = await calendarService.events.list({
          calendarId: cal.id,
          timeMin,
          timeMax,
          maxResults: 20,
          singleEvents: true,
          orderBy: 'startTime'
        });
        (res.data.items || []).forEach(e => {
          if (!e.start?.dateTime) return;
          const url = extractMeetingUrl(e);
          if (!url) return;
          const startMs = new Date(e.start.dateTime).getTime();
          if (startMs < now - 60 * 1000 || startMs > now + 2 * 60 * 1000) return;
          const key = `${e.id}|${e.start.dateTime}`;
          if (promptedMeetings.has(key)) return;
          candidates.push({
            key,
            summary: e.summary || '無標題會議',
            start: e.start.dateTime,
            url,
            calendarName: cal.summaryOverride || cal.summary || ''
          });
        });
      } catch (err) {
        console.error('會議提醒讀取失敗:', cal.id, err.message);
      }
    }));

    candidates.sort((a, b) => new Date(a.start) - new Date(b.start));
    for (const meeting of candidates) {
      promptedMeetings.add(meeting.key);
      meetingPromptBusy = true;
      try {
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
        const startLabel = new Date(meeting.start).toLocaleString('zh-TW', {
          month: 'numeric', day: 'numeric', weekday: 'short',
          hour: '2-digit', minute: '2-digit', hour12: false
        });
        const { response } = await dialog.showMessageBox(win || undefined, {
          type: 'question',
          buttons: ['前往會議', '稍後'],
          defaultId: 0,
          cancelId: 1,
          title: '會議即將開始',
          message: meeting.summary,
          detail: `時間：${startLabel}\n日曆：${meeting.calendarName || '—'}\n連結：${meeting.url}\n\n是否直接前往會議？`
        });
        if (response === 0) await shell.openExternal(meeting.url);
      } finally {
        meetingPromptBusy = false;
      }
    }

    if (promptedMeetings.size > 200) {
      const keep = [...promptedMeetings].slice(-100);
      promptedMeetings.clear();
      keep.forEach(k => promptedMeetings.add(k));
    }
  } catch (err) {
    if (!/Insufficient Permission|permission|403|401/i.test(String(err?.message || ''))) {
      console.error('會議提醒檢查失敗:', err.message);
    }
  }
}


// ========== 【MODULE: framework/tray】系統匣 ==========
function ensureTray() {
  if (tray || process.platform === 'darwin') return;
  try {
    const iconPath = path.join(APP_ROOT, 'icon.png');
    const image = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
    tray = new Tray(image.isEmpty() ? nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==') : image);
    tray.setToolTip('LifeTour');
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: '顯示 LifeTour',
        click: () => {
          if (!win) return;
          win.show();
          win.focus();
        }
      },
      {
        label: '隱藏到背景',
        click: () => win?.hide()
      },
      { type: 'separator' },
      {
        label: '結束程式',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]));
    tray.on('double-click', () => {
      if (!win) return;
      win.show();
      win.focus();
    });
  } catch (err) {
    console.warn('建立系統匣失敗:', err.message);
  }
}

const GCHAT_TOAST_WIDTH = 380;

function positionToastWindow(height = 160) {
  if (!toastWin || toastWin.isDestroyed()) return;
  const display = screen.getPrimaryDisplay().workArea;
  const width = GCHAT_TOAST_WIDTH;
  const h = Math.max(80, Math.min(height || 160, Math.floor(display.height * 0.5)));
  try {
    toastWin.setContentSize(width, h);
  } catch (_) {
    toastWin.setSize(width, h);
  }
  toastWin.setPosition(
    Math.round(display.x + display.width - width - 12),
    Math.round(display.y + display.height - h - 12)
  );
}

function isMainWindowHidden() {
  return !win || win.isDestroyed() || !win.isVisible() || win.isMinimized();
}

// [Important] 回覆框必須永遠高於泡泡；否則新提醒 moveTop 會蓋住正在回覆的視窗
const GCHAT_TOAST_Z = 'floating';
const GCHAT_REPLY_Z = 'screen-saver';

function isReplyPopExpandedVisible() {
  for (const entry of replyPopRegistry.values()) {
    if (entry.win && !entry.win.isDestroyed() && entry.win.isVisible() && !entry.minimized) return true;
  }
  return false;
}

function isReplyPopVisible() {
  for (const entry of replyPopRegistry.values()) {
    if (entry.win && !entry.win.isDestroyed() && entry.win.isVisible()) return true;
    if (entry.barWin && !entry.barWin.isDestroyed() && entry.barWin.isVisible()) return true;
  }
  return !!(replyPopWin && !replyPopWin.isDestroyed() && replyPopWin.isVisible());
}

function replyPopUserConvKey(userName) {
  const u = String(userName || '').trim();
  if (!u) return '';
  return u.startsWith('user:') ? u : `user:${u}`;
}

function replyPopConvKey(spaceName, messageName, threadFocus = '') {
  // [Important] 專注討論串用獨立鍵（thread 資源名或訊息錨點），可與同空間一般泡泡並存
  const th = String(threadFocus || '').trim();
  if (th) return th.startsWith('focus:') ? th : `focus:${th}`;
  const sn = String(spaceName || '').trim();
  if (sn) return sn;
  const msg = String(messageName || '').trim();
  if (!msg) return '';
  const hit = gchatCache.messages.find((m) => m.name === msg)
    || gchatCache.packets?.[msg]?.detail
    || findReadyGchatPacket(msg)?.detail
    || null;
  if (hit?.spaceName) return String(hit.spaceName).trim();
  return msg;
}

function findReplyPopEntryForSpace(spaceName, { excludeFocus = true } = {}) {
  const sn = String(spaceName || '').trim();
  if (!sn) return null;
  for (const entry of replyPopRegistry.values()) {
    if (excludeFocus && entry.threadFocus) continue;
    if (entry.spaceName === sn) return entry;
  }
  return null;
}

/** 同空間是否已有最小化 bar（泡泡已 hide） */
function findMinimizedReplyBarForSpace(spaceName) {
  const sn = String(spaceName || '').trim();
  if (!sn) return null;
  for (const entry of replyPopRegistry.values()) {
    if (!entry?.minimized || entry.spaceName !== sn) continue;
    if (!entry.barWin || entry.barWin.isDestroyed()) continue;
    return entry;
  }
  return null;
}

/**
 * 最小化 bar 可接收未讀的條件：
 * 1. 置頂個人／群組 → 任一未讀
 * 2. @我 → 未讀
 * 3. 私人訊息 → 未讀（等同給我）
 * 4. 專注討論串 bar → 僅該串內訊息
 */
function isReplyBarPriorityMessage(message, entry = null) {
  if (!message || isOwnGchatMessage(message)) return false;
  if (entry?.threadFocus) return messageBelongsToFocusEntry(message, entry);
  const spaceName = String(message.spaceName || entry?.spaceName || '').trim();
  if (spaceName && isPinnedGchatSpace(spaceName)) return true;
  if (message.mentionedMe === true) return true;
  if (message.isDm || isDirectMessageContext(message) || isDirectMessageContext(entry)) return true;
  return false;
}

/** 將 API raw 訊息轉成 bar 優先判斷用格式 */
function syntheticMessageFromRaw(raw, entry) {
  if (!raw) return null;
  return {
    name: raw.name,
    spaceName: entry?.spaceName || '',
    threadName: String(raw?.thread?.name || '').trim(),
    createTime: raw.createTime || '',
    isDm: !!(entry?.isDm || isDirectMessageContext(entry)),
    mentionedMe: messageMentionsMe(raw, gchatCache.myUserName || ''),
    text: raw.text || raw.formattedText || '',
    snippet: raw.text || raw.formattedText || ''
  };
}

/** 最小化 bar：僅推進水位，不累加 badge／不更新預覽 */
function advanceReplyPopWatchOnly(entry, createTimeHint = '') {
  if (!entry) return;
  seedReplyPopWatchCursor(entry, createTimeHint);
}

/** 開啟 Conversation 前快照 readUntil（Phase 2A） */
function snapshotReadUntilBeforeOpen(opts = {}) {
  const explicit = String(opts.readUntil != null ? opts.readUntil : '').trim();
  if (explicit) return explicit;
  const spaceName = String(opts.spaceName || '').trim();
  if (spaceName) return String(gchatLocallyReadSpaces.get(spaceName) || '').trim();
  return '';
}

async function snapshotReadUntilForMessage(messageName) {
  const name = String(messageName || '').trim();
  if (!name) return '';
  const hit = gchatCache.messages.find((m) => m.name === name)
    || gchatCache.packets?.[name]?.detail
    || findReadyGchatPacket(name)?.detail;
  const spaceName = String(hit?.spaceName || '').trim();
  return snapshotReadUntilBeforeOpen({ spaceName });
}

/** 同空間一般泡泡只留一筆 registry（避免同一人兩個 bar） */
function dedupeReplyPopRegistryBySpace() {
  const winners = new Map();
  for (const [key, entry] of replyPopRegistry.entries()) {
    if (entry.threadFocus || !entry.spaceName) continue;
    const sn = entry.spaceName;
    const prev = winners.get(sn);
    if (!prev) {
      winners.set(sn, { key, entry });
      continue;
    }
    const keep = prev.entry;
    const dropKey = key;
    const drop = entry;
    if ((drop.unreadBadge || 0) > (keep.unreadBadge || 0)) keep.unreadBadge = drop.unreadBadge;
    if (drop.lastSeenCreateTime && (!keep.lastSeenCreateTime || drop.lastSeenCreateTime < keep.lastSeenCreateTime)) {
      keep.lastSeenCreateTime = drop.lastSeenCreateTime;
    }
    if (!keep.barWin && drop.barWin) keep.barWin = drop.barWin;
    if (!keep.win && drop.win) keep.win = drop.win;
    if (!keep.messageName && drop.messageName) keep.messageName = drop.messageName;
    const keepKey = entryConvKey(keep);
    if (keepKey && keep.convKey !== keepKey) {
      replyPopRegistry.delete(prev.key);
      keep.convKey = keepKey;
      replyPopRegistry.set(keepKey, keep);
      const oi = minimizedReplyOrder.indexOf(prev.key);
      if (oi >= 0) minimizedReplyOrder[oi] = keepKey;
      winners.set(sn, { key: keepKey, entry: keep });
    }
    replyPopRegistry.delete(dropKey);
    const di = minimizedReplyOrder.indexOf(dropKey);
    if (di >= 0) minimizedReplyOrder.splice(di, 1);
    if (drop.barWin && drop.barWin !== keep.barWin) destroyReplyBarWindow(drop);
  }
}

function maxMinimizedReplyBarSlots(display = screen.getPrimaryDisplay().workArea) {
  const w = REPLY_BAR_WIDTH + REPLY_BAR_BADGE_PAD;
  const stride = REPLY_BAR_WIDTH + REPLY_BAR_GAP;
  const avail = display.width - REPLY_BAR_MARGIN * 2 - w;
  return Math.max(1, Math.floor(avail / stride) - REPLY_BAR_RIGHT_SLOT_SKIP);
}

function pruneExcessMinimizedBars() {
  const display = screen.getPrimaryDisplay().workArea;
  const max = maxMinimizedReplyBarSlots(display);
  while (minimizedReplyOrder.length > max) {
    const oldest = minimizedReplyOrder[0];
    closeReplyPopCompletely(oldest).catch(() => {});
  }
}

function findReplyPopEntry({ messageName = '', spaceName = '', win = null, convKey = '', threadName = '', focusOnly = false } = {}) {
  if (win) {
    for (const entry of replyPopRegistry.values()) {
      if (entry.win === win || entry.barWin === win) return entry;
    }
  }
  const key = String(convKey || '').trim()
    || (threadName ? replyPopConvKey(spaceName, messageName, threadName) : '')
    || (!focusOnly ? replyPopConvKey(spaceName, messageName, '') : '');
  if (key && replyPopRegistry.has(key)) {
    return replyPopRegistry.get(key);
  }
  if (threadName) {
    const want = replyPopConvKey('', '', threadName);
    for (const entry of replyPopRegistry.values()) {
      if (!entry.threadFocus) continue;
      if (entry.threadName === threadName || entry.convKey === threadName || entry.convKey === want) {
        return entry;
      }
    }
    // 專注串查詢：不要再落到「同 messageName 的一般泡泡」
    return null;
  }
  if (focusOnly) return null;
  if (spaceName) {
    for (const entry of replyPopRegistry.values()) {
      if (entry.threadFocus) continue;
      if (entry.spaceName && entry.spaceName === spaceName) return entry;
    }
  }
  if (messageName) {
    for (const entry of replyPopRegistry.values()) {
      if (entry.threadFocus) continue;
      if (entry.messageName === messageName) return entry;
    }
  }
  return null;
}

function getReplyPopEntry(messageName) {
  return findReplyPopEntry({ messageName });
}

function entryConvKey(entry) {
  if (entry?.convKey) return entry.convKey;
  if (entry?.spaceName) {
    return replyPopConvKey(
      entry.spaceName,
      entry.messageName,
      entry.threadFocus ? entry.threadName : ''
    );
  }
  if (entry?.userName) return replyPopUserConvKey(entry.userName);
  return replyPopConvKey(entry?.spaceName, entry?.messageName);
}

/** 搜尋開 DM 先以 user: 鍵註冊；空間解析後改以 spaceName 為鍵 */
function migrateReplyPopConvKey(entry, { spaceName = '', messageName = '' } = {}) {
  if (!entry) return;
  if (messageName && !entry.messageName) entry.messageName = messageName;
  const sn = String(spaceName || entry.spaceName || '').trim();
  if (!sn) return;
  entry.spaceName = sn;
  const newKey = replyPopConvKey(
    sn,
    entry.messageName,
    entry.threadFocus ? entry.threadName : ''
  );
  const oldKey = entry.convKey || entryConvKey(entry);
  if (!newKey || newKey === oldKey) return;
  if (oldKey && replyPopRegistry.get(oldKey) === entry) {
    replyPopRegistry.delete(oldKey);
  }
  entry.convKey = newKey;
  replyPopRegistry.set(newKey, entry);
  const oi = minimizedReplyOrder.indexOf(oldKey);
  if (oi >= 0) minimizedReplyOrder[oi] = newKey;
  else if (entry.minimized && !minimizedReplyOrder.includes(newKey)) {
    minimizedReplyOrder.push(newKey);
  }
  dedupeReplyPopRegistryBySpace();
  if (entry.barWin && !entry.barWin.isDestroyed()) syncReplyBarUi(entry);
  if (entry.minimized) {
    rememberDockedBar(entry);
    positionMinimizedReplyBars();
  }
}

function destroyReplyBarWindow(entry) {
  if (!entry?.barWin || entry.barWin.isDestroyed()) return;
  try { entry.barWin.destroy(); } catch (_) {}
  entry.barWin = null;
}

function removeReplyPopEntry(entryOrKey) {
  let key = '';
  let entry = null;
  if (typeof entryOrKey === 'string') {
    key = entryOrKey;
    entry = replyPopRegistry.get(key) || null;
  } else if (entryOrKey) {
    entry = entryOrKey;
    key = entryConvKey(entryOrKey);
  }
  if (entry) destroyReplyBarWindow(entry);
  if (!key) return;
  replyPopRegistry.delete(key);
  const idx = minimizedReplyOrder.indexOf(key);
  if (idx >= 0) minimizedReplyOrder.splice(idx, 1);
  positionMinimizedReplyBars();
}

function syncReplyBarUi(entry) {
  if (!entry) return;
  if (entry.threadFocus) refreshFocusEntryTitle(entry);
  ensureReplyEntryIcon(entry);
  syncReplyPopIcon(entry);
  if (!entry.barWin || entry.barWin.isDestroyed()) return;
  const key = entryConvKey(entry);
  try {
    entry.barWin.webContents.send('gchat-bar-update', {
      convKey: key,
      title: entry.title || 'Little Reply',
      badge: Number(entry.unreadBadge || 0) || 0,
      bubbleOpen: !entry.minimized && !!(entry.win && !entry.win.isDestroyed() && entry.win.isVisible()),
      theme: currentAppTheme,
      iconUrl: entry.iconUrl || '',
      emoji: entry.emoji || ''
    });
  } catch (_) {}
}

function syncReplyPopIcon(entry) {
  if (!entry?.win || entry.win.isDestroyed()) return;
  if (!entry.iconUrl && !entry.emoji) return;
  try {
    entry.win.webContents.send('gchat-compact-icon', {
      iconUrl: entry.iconUrl || '',
      emoji: entry.emoji || ''
    });
  } catch (_) {}
}

function lookupPinnedIconForEntry(entry) {
  if (!entry) return { emoji: '', iconUrl: '' };
  try {
    const prefs = loadGchatPrefs();
    const peer = String(entry.peerUserName || entry.userName || '').trim();
    const spaceName = String(entry.spaceName || '').trim();
    if (peer) {
      const c = (prefs.pinnedContacts || []).find((x) => x?.userName === peer);
      if (c && (c.iconUrl || c.emoji)) {
        return { iconUrl: String(c.iconUrl || '').trim(), emoji: String(c.emoji || '').trim() };
      }
    }
    if (spaceName) {
      const s = (prefs.pinnedSpaces || []).find((x) => x?.spaceName === spaceName);
      if (s && (s.iconUrl || s.emoji)) {
        return { iconUrl: String(s.iconUrl || '').trim(), emoji: String(s.emoji || '').trim() };
      }
      const c2 = (prefs.pinnedContacts || []).find((x) => x?.spaceName === spaceName);
      if (c2 && (c2.iconUrl || c2.emoji)) {
        return { iconUrl: String(c2.iconUrl || '').trim(), emoji: String(c2.emoji || '').trim() };
      }
    }
  } catch (_) {}
  return { emoji: '', iconUrl: '' };
}

/** 非同步補齊 reply bar／泡泡 entry 的頭像（不阻塞 UI） */
function ensureReplyEntryIcon(entry) {
  if (!entry || entry._iconResolving) return;
  const spaceName = String(entry.spaceName || '').trim();
  const isDm = !!(entry.isDm || isDirectMessageContext(entry));
  let peer = String(entry.peerUserName || entry.userName || '').trim();
  if (peer) {
    const keys = gchatMyIdentityKeys();
    const bare = peer.replace(/^users\//i, '');
    const isSelf = keys.size
      ? (keys.has(peer) || keys.has(peer.toLowerCase()) || keys.has(bare) || keys.has(`users/${bare}`))
      : (peer === gchatCache.myUserName);
    if (isSelf) peer = '';
  }

  if (!entry.iconUrl && !entry.emoji) {
    const pinned = lookupPinnedIconForEntry(entry);
    if (pinned.iconUrl || pinned.emoji) {
      entry.iconUrl = pinned.iconUrl || '';
      entry.emoji = pinned.emoji || '';
    }
  }

  const peerCached = peer ? (gchatCache.userIcons?.[peer] || {}) : {};
  const spaceCached = spaceName ? (gchatCache.spaceIcons?.[spaceName] || {}) : {};
  // [Important] 密語只用對方 userIcons；群組才用 spaceIcons
  if (isDm) {
    if (peerCached.iconUrl || peerCached.emoji) {
      entry.iconUrl = peerCached.iconUrl || entry.iconUrl || '';
      entry.emoji = peerCached.emoji || entry.emoji || '';
      entry._dmIconReady = true;
      syncReplyPopIcon(entry);
      return;
    }
    // 尚無 peer：用過一次兜底圖就停；有 peer 則繼續抓對方
    if (!peer && entry._dmIconReady && (entry.iconUrl || entry.emoji)) {
      syncReplyPopIcon(entry);
      return;
    }
  } else if (!entry.iconUrl && !entry.emoji) {
    entry.iconUrl = spaceCached.iconUrl || peerCached.iconUrl || '';
    entry.emoji = spaceCached.emoji || peerCached.emoji || '';
  }

  if (!isDm && (entry.iconUrl || entry.emoji)) {
    syncReplyPopIcon(entry);
    return;
  }

  entry._iconResolving = true;
  ensureGchatIconService().resolveSpaceIcon(spaceName, {
    isDm,
    peerUserName: peer,
    label: entry.contactTitle || entry.title || '',
    force: !!(isDm && peer)
  }).then((icon) => {
    entry._iconResolving = false;
    entry._dmIconReady = true;
    if (!icon?.iconUrl && !icon?.emoji) return;
    entry.iconUrl = icon.iconUrl || '';
    entry.emoji = icon.emoji || '';
    if (peer) entry.peerUserName = peer;
    syncReplyBarUi(entry);
  }).catch(() => {
    entry._iconResolving = false;
    entry._dmIconReady = true;
  });
}

function ensureReplyBarWindow(entry) {
  if (!entry) return null;
  if (entry.barWin && !entry.barWin.isDestroyed()) {
    syncReplyBarUi(entry);
    return entry.barWin;
  }
  const key = entryConvKey(entry);
  const bar = new BrowserWindow({
    width: REPLY_BAR_WIDTH + REPLY_BAR_BADGE_PAD,
    height: REPLY_BAR_HEIGHT + REPLY_BAR_BADGE_PAD,
    frame: false,
    transparent: true,
    backgroundColor: REPLY_BAR_WINDOW_BG,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  entry.barWin = bar;
  try {
    bar.setAlwaysOnTop(true, GCHAT_REPLY_Z);
    bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (_) {}
  bar.loadFile(path.join(APP_ROOT, 'gchat-reply-bar.html'), {
    query: { key }
  });
  bar.webContents.on('did-finish-load', () => {
    try { bar.webContents.send('app-theme', currentAppTheme); } catch (_) {}
    try { bar.webContents.send('app-font-scale', currentAppFontScale); } catch (_) {}
    syncReplyBarUi(entry);
  });
  bar.on('closed', () => {
    if (entry.barWin === bar) entry.barWin = null;
  });
  return bar;
}

function rememberDockedBar(entry) {
  const key = entryConvKey(entry);
  if (!key) return;
  dedupeReplyPopRegistryBySpace();
  if (!minimizedReplyOrder.includes(key)) minimizedReplyOrder.push(key);
  pruneExcessMinimizedBars();
}

/** [Important] bar 常駐於右下角；泡泡展開時 bar 仍在 */
function positionMinimizedReplyBars() {
  dedupeReplyPopRegistryBySpace();
  const display = screen.getPrimaryDisplay().workArea;
  const alive = minimizedReplyOrder.filter((convKey) => {
    const entry = replyPopRegistry.get(convKey);
    return !!(entry?.barWin && !entry.barWin.isDestroyed());
  });
  if (alive.length !== minimizedReplyOrder.length) {
    minimizedReplyOrder.splice(0, minimizedReplyOrder.length, ...alive);
  }
  minimizedReplyOrder.forEach((convKey, idxFromRight) => {
    const entry = replyPopRegistry.get(convKey);
    if (!entry?.barWin || entry.barWin.isDestroyed()) return;
    const w = REPLY_BAR_WIDTH + REPLY_BAR_BADGE_PAD;
    const h = REPLY_BAR_HEIGHT + REPLY_BAR_BADGE_PAD;
    // 從「第 2 格」起算：空出最右側一格
    const slot = idxFromRight + REPLY_BAR_RIGHT_SLOT_SKIP;
    const x = Math.round(
      display.x + display.width - REPLY_BAR_MARGIN - w - slot * (REPLY_BAR_WIDTH + REPLY_BAR_GAP)
    );
    const y = Math.round(display.y + display.height - h - REPLY_BAR_MARGIN - REPLY_BAR_BOTTOM_EXTRA);
    try {
      entry.barWin.setBounds({ x, y, width: w, height: h }, false);
      if (typeof entry.barWin.showInactive === 'function') entry.barWin.showInactive();
      else entry.barWin.show();
      syncReplyBarUi(entry);
    } catch (_) {}
  });
}

function positionReplyPopExpanded(win, entry = null) {
  if (!win || win.isDestroyed()) return;
  exitReplyPopExpandedDisplayStateSync(win);
  const bounds = resolveReplyPopExpandedBounds(entry);
  try {
    win.setResizable(true);
    win.setMaximizable(true);
    win.setMinimumSize(320, 280);
    win.setMaximumSize(10000, 10000);
    win.setBounds(bounds, false);
  } catch (_) {}
}

function raiseGchatReplyBarsTop() {
  for (const entry of replyPopRegistry.values()) {
    if (!entry.barWin || entry.barWin.isDestroyed() || !entry.barWin.isVisible()) continue;
    try {
      entry.barWin.setAlwaysOnTop(true, GCHAT_REPLY_Z);
      entry.barWin.moveTop();
    } catch (_) {}
  }
}

/** 依目前是否在回覆，調整泡泡／回覆框層級 */
function syncGchatOverlayZOrder() {
  try {
    if (toastWin && !toastWin.isDestroyed() && toastWin.isVisible()) {
      if (isReplyPopExpandedVisible()) {
        toastWin.setAlwaysOnTop(true, GCHAT_TOAST_Z);
      } else if (gchatViewing && !isMainWindowHidden()) {
        toastWin.setAlwaysOnTop(false);
      } else {
        toastWin.setAlwaysOnTop(true, GCHAT_TOAST_Z);
      }
    }
    // [Important] 僅最小化 bar 置頂；展開泡泡框不搶 z-index
    raiseGchatReplyBarsTop();
  } catch (_) {}
}

function showToastWindowBelowReply(w) {
  if (!w || w.isDestroyed()) return;
  try {
    w.setAlwaysOnTop(true, GCHAT_TOAST_Z);
    w.show();
    if (isReplyPopExpandedVisible()) {
      raiseGchatReplyBarsTop();
    } else if (gchatViewing && !isMainWindowHidden()) {
      w.setAlwaysOnTop(false);
    } else {
      w.moveTop();
    }
  } catch (_) {
    try { w.show(); } catch (__) {}
  }
}

function createReplyPopWindow(messageName, {
  spaceName = '',
  title = '',
  createBar = false,
  convKey: convKeyOpt = '',
  threadFocus = false,
  threadName = ''
} = {}) {
  // [Important] 專注討論串以 threadName 為獨立 registry 鍵
  const convKey = String(convKeyOpt || '').trim()
    || replyPopConvKey(spaceName, messageName, threadFocus ? threadName : '');
  const bg = themeCardBg();
  const win = new BrowserWindow({
    width: REPLY_POP_WIDTH,
    height: REPLY_POP_HEIGHT,
    frame: false,
    transparent: false,
    backgroundColor: bg,
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    focusable: true,
    show: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  loadReplyPopBoundsStore();
  const boundsKey = replyPopBoundsKey(spaceName, threadFocus ? threadName : messageName);
  const entry = {
    win,
    barWin: null,
    minimized: false,
    unreadBadge: 0,
    expandedDisplayMode: 'normal',
    title: formatGchatBubbleTitle(title, { isDm: false }),
    isDm: false,
    messageName,
    spaceName: spaceName || '',
    convKey,
    threadFocus: !!threadFocus,
    threadName: threadFocus ? String(threadName || '').trim() : '',
    expandedBounds: boundsKey && replyPopBoundsStore[boundsKey] ? { ...replyPopBoundsStore[boundsKey] } : null,
    pendingOpenMessageName: '',
    pendingOpenThreadName: ''
  };
  replyPopRegistry.set(convKey, entry);
  replyPopWin = win;
  replyPopMessageName = messageName;
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (_) {}
  const rememberBounds = () => {
    if (entry.minimized) return;
    captureReplyPopExpandedBounds(entry);
  };
  win.on('moved', rememberBounds);
  win.on('resized', () => {
    if (entry.minimized) return;
    if (isReplyPopEffectivelyMaximized(entry.win)) {
      entry.expandedDisplayMode = entry.win.isFullScreen?.() ? 'fullscreen' : 'maximized';
    } else if (!entry.win.isMaximized?.() && !entry.win.isFullScreen?.()) {
      entry.expandedDisplayMode = 'normal';
    }
    rememberBounds();
  });
  win.on('maximize', () => {
    if (!entry.minimized && !entry.win.isFullScreen?.()) entry.expandedDisplayMode = 'maximized';
  });
  win.on('enter-full-screen', () => {
    if (!entry.minimized) entry.expandedDisplayMode = 'fullscreen';
  });
  win.on('leave-full-screen', () => {
    if (!entry.minimized && !entry.win.isMaximized?.()) entry.expandedDisplayMode = 'normal';
  });
  win.on('unmaximize', () => {
    if (!entry.minimized && !entry.win.isFullScreen?.()) entry.expandedDisplayMode = 'normal';
  });
  win.on('closed', () => {
    captureReplyPopExpandedBounds(entry);
    entry.win = null;
    if (replyPopRegistry.get(convKey) !== entry) return;
    // 泡泡關閉時若還有 bar，只清泡泡；關掉 bar 才整筆移除
    if (!entry.barWin || entry.barWin.isDestroyed()) {
      removeReplyPopEntry(entry);
    } else {
      entry.minimized = true;
      rememberDockedBar(entry);
      syncReplyBarUi(entry);
      positionMinimizedReplyBars();
    }
    if (replyPopMessageName === entry.messageName) {
      replyPopMessageName = '';
      replyPopWin = null;
    }
    if (gchatViewing?.messageName === entry.messageName
      || (entry.spaceName && gchatViewing?.spaceName === entry.spaceName)) {
      gchatViewing = null;
      stopViewingRefreshWatch();
    }
    syncGchatOverlayZOrder();
  });
  win.on('show', () => {
    if (!entry.minimized) raiseGchatReplyBarsTop();
  });
  win.on('focus', () => {
    raiseGchatReplyBarsTop();
  });
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.send('app-theme', currentAppTheme); } catch (_) {}
    try { win.webContents.send('app-font-scale', currentAppFontScale); } catch (_) {}
  });
  if (createBar) {
    ensureReplyBarWindow(entry);
    rememberDockedBar(entry);
    positionMinimizedReplyBars();
  }
  return entry;
}

async function minimizeReplyPop(messageNameOrEntry, title = '') {
  const entry = typeof messageNameOrEntry === 'object' && messageNameOrEntry?.win
    ? messageNameOrEntry
    : findReplyPopEntry({ messageName: messageNameOrEntry });
  if (!entry) return { success: false };
  if (entry.win && !entry.win.isDestroyed()) {
    const captured = captureReplyPopDisplayMode(entry);
    if (captured !== 'normal') {
      entry.expandedDisplayMode = captured;
    } else if (entry.expandedDisplayMode !== 'maximized' && entry.expandedDisplayMode !== 'fullscreen') {
      entry.expandedDisplayMode = 'normal';
    }
    captureReplyPopExpandedBounds(entry);
    await exitReplyPopExpandedDisplayState(entry.win);
    try {
      entry.win.webContents.send('gchat-compact-mode', {
        minimized: true,
        title: entry.title
      });
    } catch (_) {}
    try { entry.win.hide(); } catch (_) {}
  }
  entry.minimized = true;
  // [Important] 縮成 bar 後不算「正在看」，新訊息要繼續累加紅點
  if (gchatViewing
    && (gchatViewing.messageName === entry.messageName
      || (entry.spaceName && gchatViewing.spaceName === entry.spaceName))) {
    gchatViewing = null;
    stopViewingRefreshWatch();
  }
  // 種子水位：之後只對「更新」的訊息加未讀，避免縮小時把舊訊息當新未讀
  seedReplyPopWatchCursor(entry);
  // [Important] 專注串標題不可被 pickGchatBubbleTitle 洗成只有聯絡人
  if (entry.threadFocus) {
    if (title && (String(title).includes('★') || String(title).includes('·'))) {
      const parsed = parseFocusThreadBarTitle(title);
      entry.contactTitle = entry.contactTitle || parsed.contactTitle;
      if (parsed.focusRootText) entry.focusRootText = parsed.focusRootText;
    }
    refreshFocusEntryTitle(entry);
  } else {
    const rawTitle = title || entry.title || '';
    if (title || rawTitle) {
      const next = pickGchatBubbleTitle({
        isDm: !!entry.isDm,
        spaceDisplayName: rawTitle,
        spaceName: entry.spaceName || '',
        fallback: entry.title
      });
      if (!isWeakGchatBubbleTitle(next) || isWeakGchatBubbleTitle(entry.title)) {
        entry.title = next;
      }
    }
    if (entry.spaceName && isWeakGchatBubbleTitle(String(entry.title || ''))) {
      ensureSpaceMeta(entry.spaceName).then((meta) => {
        if (!meta?.label || isWeakGchatBubbleTitle(meta.label)) return;
        const resolved = pickGchatBubbleTitle({
          isDm: !!entry.isDm,
          spaceDisplayName: meta.label,
          spaceName: entry.spaceName
        });
        if (isWeakGchatBubbleTitle(resolved)) return;
        entry.title = resolved;
        syncReplyBarUi(entry);
      }).catch(() => {});
    }
  }
  ensureReplyBarWindow(entry);
  rememberDockedBar(entry);
  positionMinimizedReplyBars();
  setTimeout(() => positionMinimizedReplyBars(), 0);
  syncReplyBarUi(entry);
  syncGchatOverlayZOrder();
  prefetchReplyPopEntryCache(entry);
  return { success: true };
}

async function restoreReplyPop(messageNameOrEntry) {
  const entry = typeof messageNameOrEntry === 'object'
    ? messageNameOrEntry
    : findReplyPopEntry({ messageName: messageNameOrEntry });
  if (!entry) return { success: false };
  const restoreMode = entry.expandedDisplayMode || 'normal';
  const scrollReadUntil = String(
    entry.lastSeenCreateTime
    || (entry.spaceName ? gchatLocallyReadSpaces.get(entry.spaceName) : '')
    || ''
  ).trim();

  const focusOpen = resolveUnreadFocusThreadOpen(entry);
  if (focusOpen) {
    const anchorName = String(focusOpen.openMessageName || focusOpen.messageName || '').trim();
    entry.minimized = false;
    entry.unreadBadge = 0;
    clearReplyPopOpenTarget(entry);
    ensureReplyBarWindow(entry);
    rememberDockedBar(entry);
    return await openCompactGchatReply(focusOpen.messageName, {
      spaceName: focusOpen.spaceName || entry.spaceName,
      threadName: focusOpen.threadName,
      focusThread: true,
      rootMessageName: focusOpen.rootMessageName,
      focusRootText: focusOpen.focusRootText,
      title: entry.contactTitle || entry.title,
      isDm: !!entry.isDm,
      readUntil: scrollReadUntil,
      jumpToMessage: true,
      jumpMessageName: anchorName
    });
  }

  const restoreJumpName = String(entry.pendingOpenMessageName || '').trim();
  entry.minimized = false;
  entry.unreadBadge = 0;
  // [Important] 展開泡泡時 bar 仍留在右下角
  ensureReplyBarWindow(entry);
  rememberDockedBar(entry);

  if (!entry.win || entry.win.isDestroyed()) {
    const openName = entry.messageName || '';
    if (!openName) return { success: false };
    const bg = themeCardBg();
    const bubble = new BrowserWindow({
      width: REPLY_POP_WIDTH,
      height: REPLY_POP_HEIGHT,
      frame: false,
      transparent: false,
      backgroundColor: bg,
      alwaysOnTop: false,
      skipTaskbar: true,
      resizable: true,
      movable: true,
      focusable: true,
      show: false,
      hasShadow: true,
      webPreferences: {
        preload: path.join(APP_ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    entry.win = bubble;
    replyPopWin = bubble;
    replyPopMessageName = openName;
    try {
      bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (_) {}
    const rememberBounds = () => {
      if (entry.minimized) return;
      captureReplyPopExpandedBounds(entry);
    };
    bubble.on('moved', rememberBounds);
    bubble.on('resized', () => {
      if (entry.minimized) return;
      rememberBounds();
    });
    bubble.on('closed', () => {
      captureReplyPopExpandedBounds(entry);
      entry.win = null;
      entry.minimized = true;
      rememberDockedBar(entry);
      syncReplyBarUi(entry);
      positionMinimizedReplyBars();
      if (replyPopMessageName === entry.messageName) {
        replyPopMessageName = '';
        replyPopWin = null;
      }
      syncGchatOverlayZOrder();
    });
    bubble.webContents.on('did-finish-load', () => {
      try { bubble.webContents.send('app-theme', currentAppTheme); } catch (_) {}
      try { bubble.webContents.send('app-font-scale', currentAppFontScale); } catch (_) {}
    });
    try {
      const packSrc = buildPackSourceFromReplyPopEntry(entry);
      const prev = findReadyGchatPacket(openName, packSrc);
      if (!(prev?.historyReady)) {
        if (entry.threadFocus) {
          await packGchatDetailForItem(packSrc, { withHistory: true });
        } else if (packSrc?.spaceName) {
          await packGchatSpaceHistory(packSrc.spaceName, packSrc);
        } else {
          await packGchatDetailForItem(packSrc, { withHistory: true });
        }
      }
    } catch (_) {}
    // 還原前保留 jump，供 query／scroll-open；load 後再清
    if (restoreJumpName) entry.pendingOpenMessageName = restoreJumpName;
    await bubble.loadFile(path.join(APP_ROOT, 'gchat-reply-pop.html'), {
      query: {
        name: openName,
        focusThread: entry.threadFocus ? '1' : '',
        threadName: entry.threadFocus ? (entry.threadName || '') : '',
        focusRootText: entry.threadFocus ? (entry.focusRootText || '') : '',
        contactTitle: entry.threadFocus ? (entry.contactTitle || '') : '',
        rootMessageName: entry.threadFocus ? (entry.rootMessageName || '') : '',
        readUntil: entry.pendingOpenReadUntil || scrollReadUntil,
        jumpTo: restoreJumpName || ''
      }
    });
    entry.pendingOpenReadUntil = '';
  }

  if (restoreMode === 'normal') {
    positionReplyPopExpanded(entry.win, entry);
  } else {
    try {
      entry.win.setResizable(true);
      entry.win.setMaximizable(true);
      entry.win.setMinimumSize(320, 280);
      entry.win.setMaximumSize(10000, 10000);
    } catch (_) {}
  }
  positionMinimizedReplyBars();
  try {
    entry.win.webContents.send('gchat-compact-mode', { minimized: false, title: entry.title });
    entry.win.webContents.send('app-theme', currentAppTheme);
    entry.win.webContents.send('app-font-scale', currentAppFontScale);
    entry.win.show();
    entry.win.focus();
    entry.win.moveTop();
  } catch (_) {
    try { entry.win.show(); } catch (__) {}
  }
  prefetchReplyPopEntryCache(entry, {
    name: entry.messageName,
    spaceName: entry.spaceName,
    isDm: !!entry.isDm,
    spaceType: entry.spaceType || ''
  });
  try {
    if (entry.win && !entry.win.isDestroyed()) {
      const scrollPayload = buildReplyPopScrollOpenPayload(entry, scrollReadUntil);
      entry.win.webContents.send('gchat-scroll-open', scrollPayload);
      clearReplyPopOpenTarget(entry);
      entry.win.webContents.send('gchat-thread-ping', {
        spaceName: entry.spaceName || '',
        threadName: entry.threadName || '',
        messageName: '',
        isDm: !!entry.isDm
      });
    }
  } catch (_) {}
  if (restoreMode !== 'normal') {
    await applyReplyPopExpandedDisplayMode(entry);
  }
  try {
    if (entry.messageName) await markGchatConversationReadByName(entry.messageName);
  } catch (_) {}
  seedReplyPopWatchCursor(entry);
  if (entry.spaceName) {
    gchatViewing = {
      spaceName: entry.spaceName,
      threadName: '',
      messageName: entry.messageName || '',
      isDm: !!entry.isDm
    };
  }
  syncReplyBarUi(entry);
  raiseGchatReplyBarsTop();
  syncGchatOverlayZOrder();
  return { success: true };
}

async function toggleReplyPopFromBar(convKeyOrEntry) {
  const entry = typeof convKeyOrEntry === 'object'
    ? convKeyOrEntry
    : findReplyPopEntry({ convKey: convKeyOrEntry });
  if (!entry) return { success: false };
  const bubbleOpen = !entry.minimized
    && entry.win
    && !entry.win.isDestroyed()
    && entry.win.isVisible();
  if (bubbleOpen) {
    return minimizeReplyPop(entry, entry.title);
  }
  return restoreReplyPop(entry);
}

async function closeReplyPopCompletely(convKeyOrEntry) {
  const entry = typeof convKeyOrEntry === 'object'
    ? convKeyOrEntry
    : findReplyPopEntry({ convKey: convKeyOrEntry })
      || findReplyPopEntry({ messageName: convKeyOrEntry });
  const win = entry?.win;
  const bar = entry?.barWin;
  if (entry) removeReplyPopEntry(entry);
  else if (typeof convKeyOrEntry === 'string' && convKeyOrEntry) {
    replyPopRegistry.delete(convKeyOrEntry);
    const idx = minimizedReplyOrder.indexOf(convKeyOrEntry);
    if (idx >= 0) minimizedReplyOrder.splice(idx, 1);
  }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
  try { if (bar && !bar.isDestroyed()) bar.destroy(); } catch (_) {}
  positionMinimizedReplyBars();
  syncGchatOverlayZOrder();
  return { success: true, removed: !!entry };
}

/** 專注討論串標題：{群組名} · {根訊息摘要} */
function formatFocusThreadBarTitle(contactTitle, rootText) {
  const contact = String(contactTitle || '').trim()
    .replace(/^★\s*/, '')
    .split(/★|·/)[0]
    .trim() || '對話';
  let root = String(rootText || '').replace(/\s+/g, ' ').trim();
  // 若誤傳整段「聯絡人★／·根訊息」，只留分隔後
  if (root.includes('★')) root = root.split('★').slice(1).join('★').trim();
  if (root.includes('·')) {
    const parts = root.split('·').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) root = parts.slice(1).join(' · ');
  }
  if (root.length > 28) root = `${root.slice(0, 28)}…`;
  return root ? `${contact} · ${root}` : `${contact} · 討論串`;
}

/** 解析舊 ★ 或新 · 格式的專注 bar 標題 */
function parseFocusThreadBarTitle(rawTitle) {
  const raw = String(rawTitle || '').trim();
  if (!raw) return { contactTitle: '', focusRootText: '' };
  if (raw.includes('★')) {
    const parts = raw.split('★');
    return {
      contactTitle: parts[0].trim(),
      focusRootText: parts.slice(1).join('★').trim()
    };
  }
  if (raw.includes('·')) {
    const parts = raw.split('·').map((p) => p.trim()).filter(Boolean);
    return {
      contactTitle: parts[0] || '',
      focusRootText: parts.slice(1).join(' · ')
    };
  }
  return { contactTitle: raw.replace(/^★\s*/, ''), focusRootText: '' };
}

function refreshFocusEntryTitle(entry) {
  if (!entry?.threadFocus) return entry?.title || '';
  const title = formatFocusThreadBarTitle(
    entry.contactTitle || entry.title || '',
    entry.focusRootText || ''
  );
  entry.title = title;
  return title;
}

/** 判斷訊息是否屬於某個專注討論串 entry */
function messageBelongsToFocusEntry(message, entry) {
  if (!message || !entry?.threadFocus) return false;
  let th = String(entry.threadName || '').replace(/^focus:/, '');
  const msgTh = String(message.threadName || '').trim();
  const msgName = String(message.name || '').trim();
  const rootName = String(entry.rootMessageName || '').trim();
  if (/\/threads\//.test(th)) {
    return msgTh === th || msgName === th || (rootName && msgName === rootName && msgTh === th);
  }
  if (th.startsWith('anchor:')) th = th.slice('anchor:'.length);
  if (th.startsWith('msg:')) th = th.slice('msg:'.length);
  if (rootName && (msgName === rootName || message?.quoted?.name === rootName)) return true;
  if (th && (msgName === th || message?.quoted?.name === th)) return true;
  // 同 API thread
  if (entry.apiThreadName && msgTh && msgTh === entry.apiThreadName) return true;
  return false;
}

function rawMessageBelongsToFocusEntry(raw, entry) {
  if (!raw || !entry?.threadFocus) return false;
  let th = String(entry.threadName || '').replace(/^focus:/, '');
  const rawTh = String(raw?.thread?.name || '').trim();
  const rawName = String(raw?.name || '').trim();
  const rootName = String(entry.rootMessageName || '').trim();
  const quotedName = String(
    raw?.quotedMessageMetadata?.quotedMessageSnapshot?.name
    || raw?.quotedMessageMetadata?.name
    || ''
  ).trim();
  if (/\/threads\//.test(th)) {
    return rawTh === th || rawName === th;
  }
  if (th.startsWith('anchor:')) th = th.slice('anchor:'.length);
  if (th.startsWith('msg:')) th = th.slice('msg:'.length);
  if (rootName && (rawName === rootName || quotedName === rootName)) return true;
  if (th && (rawName === th || quotedName === th)) return true;
  if (entry.apiThreadName && rawTh === entry.apiThreadName) return true;
  return false;
}

function positionReplyPopWindow() {
  const entry = replyPopMessageName ? getReplyPopEntry(replyPopMessageName) : null;
  const win = entry?.win || replyPopWin;
  if (!win || win.isDestroyed()) return;
  positionReplyPopExpanded(win, entry);
}

async function openCompactGchatReply(messageName, opts = {}) {
  // [Important] ADR 0006：Little Reply Feature Off 時不開 Reply Pop
  if (!isFeatureActive('gchat')) {
    return { success: false, error: 'Little Reply 未加入工作台', inactive: true };
  }
  if (!messageName && !opts.spaceName && !opts.userName) return { success: false };
  if (!messageName && opts.spaceName) {
    const spacePack = findReadyGchatPacketBySpace(opts.spaceName, { isDm: !!opts.isDm });
    const pick = spacePack?.detail?.name
      || [...(spacePack?.thread || [])].reverse().find((m) => messageHasDisplayContent(m))?.name
      || spacePack?.thread?.[spacePack.thread.length - 1]?.name
      || '';
    if (pick) messageName = pick;
  }
  const hit = messageName
    ? ((gchatCache.messages || []).find(m => m.name === messageName)
      || gchatCache.packets?.[messageName]?.detail
      || findReadyGchatPacket(messageName)?.detail
      || (gchatCache.todayTouched || []).find(m => m.name === messageName))
    : null;
  // [Important] focusThread：以討論串獨立開泡泡＋bar，不與同空間一般泡泡共用
  let openName = messageName || hit?.name || '';
  let threadName = String(
    opts.threadName || hit?.threadName || (opts.focusThread ? openName : '') || ''
  ).trim();
  const dmContext = isDirectMessageContext({
    isDm: !!(opts.isDm ?? hit?.isDm),
    spaceName: opts.spaceName || hit?.spaceName || '',
    spaceType: opts.spaceType || hit?.spaceType || ''
  });
  let focusThread = !!(opts.focusThread && threadName && !dmContext);
  // [Important] 使用者明確要求專注串時，以 anchor 訊息名補齊 threadName
  if (opts.focusThread && !focusThread && !dmContext && openName) {
    const anchorKey = resolveFocusThreadKeyFromParts(openName, threadName);
    if (anchorKey) {
      threadName = anchorKey;
      focusThread = true;
    }
  }
  if (opts.focusThread && !focusThread) {
    return { success: false, error: '無法辨識討論串，無法開啟專注模式' };
  }
  const spaceName = opts.spaceName || hit?.spaceName || '';
  const userOnlyOpen = !openName && !spaceName && !!opts.userName;
  const convKey = userOnlyOpen
    ? replyPopUserConvKey(opts.userName)
    : replyPopConvKey(spaceName, openName, focusThread ? threadName : '');

  // [Important] 專注串只依 thread／convKey 查找，禁止誤重用同空間一般泡泡
  const spaceForReadEarly = spaceName || hit?.spaceName || '';
  const readUntilBeforeOpen = String(
    opts.readUntil != null && String(opts.readUntil).trim()
      ? opts.readUntil
      : (spaceForReadEarly ? gchatLocallyReadSpaces.get(spaceForReadEarly) : '')
  ).trim();
  let existing = focusThread
    ? findReplyPopEntry({ convKey, threadName, focusOnly: true })
    : findReplyPopEntryForSpace(spaceForReadEarly || spaceName || hit?.spaceName || '')
      || findReplyPopEntry({
        messageName: openName,
        spaceName,
        convKey
      });
  // [Important] 明確要求專注串時，絕不可重用一般空間泡泡
  if (opts.focusThread && existing && !existing.threadFocus) {
    existing = null;
  }
  if (existing) {
    replyPopMessageName = openName || existing.messageName;
    if (existing.win && !existing.win.isDestroyed()) replyPopWin = existing.win;
    if (spaceName) existing.spaceName = spaceName;
    if (opts.userName) existing.peerUserName = String(opts.userName).trim();
    if (opts.iconUrl) existing.iconUrl = String(opts.iconUrl).trim();
    if (opts.emoji) existing.emoji = String(opts.emoji).trim();
    if (opts.isDm != null) existing.isDm = !!opts.isDm;
    existing.pendingOpenReadUntil = readUntilBeforeOpen;
    ensureReplyEntryIcon(existing);
    syncReplyBarUi(existing);
    const reuseJumpTarget = String(
      opts.jumpMessageName || opts.openMessageName || ''
    ).trim() || (opts.jumpToMessage && openName ? openName : '');
    if (reuseJumpTarget) {
      existing.pendingOpenMessageName = reuseJumpTarget;
      if (!existing.threadFocus && hit) {
        rememberReplyPopOpenTarget(existing, {
          ...hit,
          name: reuseJumpTarget,
          threadName: hit.threadName || threadName || ''
        });
      } else if (existing.threadFocus) {
        rememberFocusPopOpenTarget(existing, {
          name: reuseJumpTarget,
          threadName: threadName || existing.threadName || ''
        });
      }
    }
    if (focusThread && threadName) {
      existing.threadFocus = true;
      existing.threadName = threadName;
      existing.convKey = convKey;
      if (opts.focusRootText || opts.rootText) {
        existing.focusRootText = String(opts.focusRootText || opts.rootText || '').trim();
      }
      if (opts.rootMessageName) existing.rootMessageName = String(opts.rootMessageName).trim();
      if (opts.title) {
        existing.contactTitle = pickGchatBubbleTitle({
          isDm: !!(opts.isDm ?? hit?.isDm ?? existing.isDm),
          spaceDisplayName: opts.title,
          sender: hit?.sender || '',
          spaceName
        }) || existing.contactTitle;
      }
      refreshFocusEntryTitle(existing);
      syncReplyBarUi(existing);
    }
    // 勿把一般泡泡改成 threadFocus（已用 focusOnly 隔離）
    if (openName && openName !== existing.messageName) {
      existing.messageName = openName;
      if (hit) rememberReplyPopOpenTarget(existing, hit);
      try {
        if (existing.win && !existing.win.isDestroyed()) {
          existing.win.webContents.send('gchat-compact-load', openName);
        }
      } catch (_) {}
    }
    if (existing.minimized || !existing.win || existing.win.isDestroyed() || !existing.win.isVisible()) {
      await restoreReplyPop(existing);
    } else if (opts.stealFocus === false) {
      // 背景更新：不搶焦點／置頂
      try {
        if (!existing.win.isVisible()) existing.win.show();
      } catch (_) {}
    } else {
      try {
        existing.win.show();
        existing.win.focus();
        existing.win.moveTop();
      } catch (_) {}
      raiseGchatReplyBarsTop();
    }
    try {
      if (existing.win && !existing.win.isDestroyed()) {
        const scrollPayload = buildReplyPopScrollOpenPayload(existing, readUntilBeforeOpen);
        existing.win.webContents.send('gchat-scroll-open', scrollPayload);
        clearReplyPopOpenTarget(existing);
      }
      existing.pendingOpenReadUntil = '';
    } catch (_) {}
    if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
    return { success: true, compact: true, reused: true, focusThread };
  }

  let stillSpaceOnly = !openName && !!spaceName;
  // userOnlyOpen 已在上方計算 convKey
  // [Phase 4] 搜尋開 DM／空間：不阻塞等歷史，由泡泡 load() 背景撈取
  if (!openName && !stillSpaceOnly && !userOnlyOpen) return { success: false, error: '缺少訊息' };

  replyPopMessageName = openName || '';
  if (openName && !opts.skipMarkRead) {
    try {
      await markGchatConversationReadByName(openName);
    } catch (err) {
      console.warn('精簡回覆標已讀失敗:', err.message);
    }
  }
  if (spaceName || hit?.spaceName) {
    gchatViewing = {
      spaceName: spaceName || hit.spaceName,
      threadName: threadName || hit?.threadName || '',
      messageName: openName,
      isDm: !!(opts.isDm ?? hit?.isDm)
    };
  }
  try {
    const packSrc = hit || { name: openName, spaceName };
    if (openName) {
      const prev = findReadyGchatPacket(openName, packSrc);
      if (!(prev?.historyReady)) {
        await packGchatDetailForItem(packSrc, { withHistory: true });
      }
    }
  } catch (_) {}

  const baseTitle = pickGchatBubbleTitle({
    isDm: !!(opts.isDm ?? hit?.isDm),
    spaceDisplayName: opts.title || hit?.spaceDisplayName || '',
    sender: hit?.sender || '',
    spaceName: spaceName || hit?.spaceName || '',
    fallback: 'Little Reply'
  });
  const titleBase = baseTitle;
  const focusRootText = String(opts.focusRootText || opts.rootText || hit?.text || hit?.snippet || '')
    .replace(/\s+/g, ' ')
    .trim();
  const rootMessageName = String(opts.rootMessageName || (focusThread ? openName : '') || '').trim();
  // ADR-0005：Focus Thread 也可 jump 到 Alert Anchor（勿因 focusThread 關掉 jump）
  const jumpTarget = String(opts.jumpMessageName || opts.openMessageName || '').trim()
    || (opts.jumpToMessage && openName ? openName : '');
  const jumpToMessage = !!jumpTarget;
  // [Important] 專注串標題：{群組名} · {根訊息摘要}
  const titleHint = focusThread
    ? formatFocusThreadBarTitle(titleBase, focusRootText)
    : titleBase;
  const entry = createReplyPopWindow(openName, {
    spaceName: spaceName || hit?.spaceName || '',
    title: titleHint,
    convKey,
    threadFocus: focusThread,
    threadName: focusThread ? threadName : ''
  });
  entry.isDm = !!(opts.isDm ?? hit?.isDm);
  if (userOnlyOpen) entry.userName = String(opts.userName || '').trim();
  if (opts.userName) entry.peerUserName = String(opts.userName || '').trim();
  if (opts.iconUrl) entry.iconUrl = String(opts.iconUrl || '').trim();
  if (opts.emoji) entry.emoji = String(opts.emoji || '').trim();
  entry.title = titleHint;
  entry.threadFocus = focusThread;
  entry.threadName = focusThread ? threadName : (threadName || '');
  entry.contactTitle = titleBase;
  entry.focusRootText = focusRootText;
  entry.rootMessageName = rootMessageName;
  entry.pendingOpenReadUntil = readUntilBeforeOpen;
  ensureReplyEntryIcon(entry);
  syncReplyPopIcon(entry);
  if (jumpToMessage) {
    entry.pendingOpenMessageName = jumpTarget;
    if (focusThread) {
      entry.pendingOpenThreadName = threadName || '';
    }
  }
  if (focusThread) refreshFocusEntryTitle(entry);
  if (focusThread && /\/threads\//.test(threadName)) {
    entry.apiThreadName = threadName.replace(/^focus:/, '');
  } else if (focusThread && hit?.threadName && /\/threads\//.test(hit.threadName)) {
    entry.apiThreadName = hit.threadName;
  }
  const w = entry.win;
  positionReplyPopExpanded(w, entry);
  await w.loadFile(path.join(APP_ROOT, 'gchat-reply-pop.html'), {
    query: {
      name: openName,
      space: stillSpaceOnly ? spaceName : '',
      user: userOnlyOpen ? String(opts.userName || '') : '',
      contactTitle: focusThread ? titleBase : String(opts.title || opts.contactTitle || ''),
      isDm: (opts.isDm ?? hit?.isDm) ? '1' : '',
      focusThread: focusThread ? '1' : '',
      threadName: focusThread ? threadName : '',
      focusRootText: focusThread ? focusRootText : '',
      rootMessageName: focusThread ? rootMessageName : '',
      readUntil: readUntilBeforeOpen || '',
      jumpTo: jumpToMessage ? jumpTarget : '',
      iconUrl: entry.iconUrl || '',
      emoji: entry.emoji || ''
    }
  });
  entry.pendingOpenReadUntil = '';
  if (jumpToMessage) {
    try {
      w.webContents.send('gchat-scroll-open', buildReplyPopScrollOpenPayload(entry, readUntilBeforeOpen));
      clearReplyPopOpenTarget(entry);
    } catch (_) {}
  }
  try {
    w.show();
    // [Important] 明確開啟（Inbox／Toast／Search）預設搶焦點；stealFocus:false 僅顯示
    if (opts.stealFocus !== false) {
      w.focus();
      syncGchatOverlayZOrder();
    }
  } catch (_) {
    w.show();
  }
  const metaSpaceName = spaceName || hit?.spaceName || '';
  if (metaSpaceName) {
    ensureSpaceMeta(metaSpaceName).then((meta) => {
      if (!meta?.label || isWeakGchatBubbleTitle(meta.label)) return;
      const resolved = pickGchatBubbleTitle({
        isDm: !!(opts.isDm ?? hit?.isDm ?? entry.isDm),
        spaceDisplayName: meta.label,
        sender: hit?.sender || '',
        spaceName: metaSpaceName
      });
      if (isWeakGchatBubbleTitle(resolved)) return;
      entry.title = resolved;
      entry.contactTitle = resolved;
      refreshFocusEntryTitle(entry);
      syncReplyBarUi(entry);
      try {
        if (w && !w.isDestroyed()) w.setTitle(resolved);
      } catch (_) {}
    }).catch(() => {});
  }
  if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
  return { success: true, compact: true, focusThread };
}

function ensureToastWindow() {
  if (toastWin && !toastWin.isDestroyed()) {
    const size = toastWin.getSize();
    const curW = size?.[0] || 0;
    // 寬度若被改過（例如先前實驗 560），重建回原本 380
    if (Math.abs(curW - GCHAT_TOAST_WIDTH) > 12) {
      try { toastWin.destroy(); } catch (_) {}
      toastWin = null;
    } else {
      const content = toastWin.getContentSize();
      positionToastWindow(Math.max(80, content?.[1] || 160));
      return toastWin;
    }
  }
  toastWin = new BrowserWindow({
    width: GCHAT_TOAST_WIDTH,
    height: 170,
    frame: false,
    // Windows 透明視窗最小化後常無法顯示，改實心底色
    transparent: false,
    backgroundColor: '#1c2230',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: true,
    show: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  try {
    toastWin.setAlwaysOnTop(true, GCHAT_TOAST_Z);
    toastWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (_) {}
  toastWin.loadFile(path.join(APP_ROOT, 'gchat-toast.html'));
  toastWin.on('closed', () => { toastWin = null; });
  return toastWin;
}

function flashGchatNativeNotification(message) {
  try {
    if (!Notification.isSupported()) return;
    const title = message.isDm ? 'Little Reply · 私人密語' : 'Little Reply · @提及你';
    const body = `${message.sender || '成員'}\n${message.snippet || message.text || ''}`.slice(0, 180);
    const note = new Notification({
      title,
      body,
      silent: false
    });
    note.on('click', () => {
      // 系統通知點擊＝準備回覆：同步標已讀
      markGchatConversationReadByName(message.name).catch(() => {});
      if (isMainWindowHidden()) {
        openCompactGchatReply(message.name);
        return;
      }
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('gchat-open-message', message.name);
    });
    note.show();
  } catch (err) {
    console.warn('系統通知失敗:', err.message);
  }
}

/** 通知／bar 顯示前：先把私人聯絡人／空間名稱解完，避免出現「私人訊息／對話」 */
function buildPackSourceFromReplyPopEntry(entry, message = null) {
  if (!entry) return null;
  const msg = message && typeof message === 'object' ? message : null;
  const threadName = entry.threadFocus
    ? (entry.apiThreadName || entry.threadName || msg?.threadName || '')
    : (entry.threadName || msg?.threadName || '');
  return {
    name: entry.messageName || msg?.name || '',
    spaceName: entry.spaceName || msg?.spaceName || '',
    isDm: !!(entry.isDm ?? msg?.isDm),
    spaceType: msg?.spaceType || '',
    spaceDisplayName: entry.contactTitle || entry.title || msg?.spaceDisplayName || '',
    threadName: String(threadName || '').replace(/^focus:/, ''),
    focusThread: !!entry.threadFocus,
    rootMessageName: entry.rootMessageName || '',
    text: entry.focusRootText || msg?.text || '',
    snippet: entry.focusRootText || msg?.snippet || msg?.text || ''
  };
}

function replyPopPrefetchKey(entry) {
  if (!entry) return '';
  if (entry.threadFocus) {
    const th = String(entry.apiThreadName || entry.threadName || entry.messageName || '').trim();
    return `focus:${entry.spaceName || ''}:${th}`;
  }
  return `space:${entry.spaceName || entry.messageName || ''}`;
}

/** bar 出現時背景預打包歷史，點 bar 展開可立即走暫存 */
function prefetchReplyPopEntryCache(entry, message = null) {
  if (!entry || !oauth2Client || !chatService) return;
  const key = replyPopPrefetchKey(entry);
  if (!key || replyPopPrefetchInFlight.has(key)) return;
  const src = buildPackSourceFromReplyPopEntry(entry, message);
  if (!src?.spaceName && !src?.name) return;
  const openName = src.name || entry.messageName || '';
  const prev = findReadyGchatPacket(openName, src);
  const msgTime = String(message?.createTime || '').trim();
  const cachedTime = String(prev?.detail?.createTime || '').trim();
  const cacheStale = msgTime && cachedTime && msgTime > cachedTime;
  if (prev?.historyReady && !cacheStale) return;
  replyPopPrefetchInFlight.add(key);
  (async () => {
    try {
      if (entry.threadFocus) {
        await packGchatDetailForItem(src, { withHistory: true });
      } else if (src.spaceName) {
        await packGchatSpaceHistory(src.spaceName, src);
      } else if (openName) {
        await packGchatDetailForItem(src, { withHistory: true });
      }
    } catch (err) {
      console.warn('[GChat] prefetch reply bar cache:', err.message);
    } finally {
      replyPopPrefetchInFlight.delete(key);
    }
  })();
}

async function resolveAlertDisplayTitle(message) {
  if (!message) return 'Little Reply';
  const spaceName = message.spaceName || '';
  let spaceLabel = message.spaceDisplayName || '';
  let sender = message.sender || '';
  if (spaceName) {
    try {
      const meta = await ensureSpaceMeta(spaceName);
      if (meta?.label && !isWeakGchatBubbleTitle(meta.label)) {
        spaceLabel = meta.label;
        message.spaceDisplayName = meta.label;
      }
      if (meta?.spaceType === 'DIRECT_MESSAGE') message.isDm = true;
    } catch (_) {}
  }
  // sender 仍是佔位時，再解一次寄件者
  if ((!sender || isWeakGchatBubbleTitle(sender) || sender === '成員') && message.senderName && spaceName) {
    try {
      sender = await resolveSenderName({ name: message.senderName, displayName: message.sender }, spaceName);
      if (sender && !isWeakGchatBubbleTitle(sender)) message.sender = sender;
    } catch (_) {}
  }
  return pickGchatBubbleTitle({
    isDm: !!message.isDm,
    spaceDisplayName: spaceLabel,
    sender: message.sender || sender,
    spaceName,
    fallback: 'Little Reply'
  });
}

/** 記錄從 bar 展開時要捲動／展開的討論串訊息（串內 @我 等） */
function rememberReplyPopOpenTarget(entry, message) {
  if (!entry || entry.threadFocus || !message) return;
  const name = String(message.name || '').trim();
  if (!name) return;
  entry.pendingOpenMessageName = name;
  entry.pendingOpenThreadName = String(
    message.threadName || message.thread?.name || ''
  ).trim();
}

function buildReplyPopScrollOpenPayload(entry, readUntil = '') {
  const payload = { readUntil: String(readUntil || '').trim() };
  const jump = String(entry?.pendingOpenMessageName || '').trim();
  // ADR-0005：Focus Thread 與一般泡泡都要能 jump 到 Alert Anchor
  if (jump) payload.jumpMessageName = jump;
  return payload;
}

function clearReplyPopOpenTarget(entry) {
  if (!entry) return;
  entry.pendingOpenMessageName = '';
  entry.pendingOpenThreadName = '';
}

function snippetForFocusTitleRuntime(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 36);
}

function resolveFocusThreadKeyFromParts(messageName, threadName = '') {
  const th = String(threadName || '').trim().replace(/^focus:/, '');
  if (/\/threads\//.test(th)) return th;
  if (th.startsWith('anchor:')) return th;
  if (th.startsWith('msg:')) return `anchor:${th.slice(4)}`;
  const msg = String(messageName || '').trim();
  if (msg.includes('/messages/')) return `anchor:${msg}`;
  return '';
}

function isGchatApiThreadName(threadName) {
  return /\/threads\//.test(String(threadName || '').trim());
}

function isDirectMessageContext(ctx = {}) {
  if (!ctx) return false;
  if (ctx.isDm === true) return true;
  const sn = String(ctx.spaceName || '').trim();
  const spaceType = String(ctx.spaceType || gchatCache.spaceTypes[sn] || '').trim();
  return spaceType === 'DIRECT_MESSAGE';
}

/** 關閉同空間誤開的 DM 專注 bar（私人訊息應只用一般對話 bar） */
async function closeDmFocusBarsForSpace(spaceName) {
  const sn = String(spaceName || '').trim();
  if (!sn) return;
  const keys = [];
  for (const [key, entry] of replyPopRegistry.entries()) {
    if (!entry?.threadFocus) continue;
    if (entry.spaceName !== sn) continue;
    if (isDirectMessageContext(entry)) keys.push(key);
  }
  for (const key of keys) {
    try { await closeReplyPopCompletely(key); } catch (_) {}
  }
}

function findThreadRootInList(list, clicked) {
  const raw = Array.isArray(list) ? list : [];
  const byName = new Map(raw.filter((m) => m?.name).map((m) => [m.name, m]));
  const th = String(clicked?.threadName || '').trim();
  if (isGchatApiThreadName(th)) {
    const inThread = raw
      .filter((m) => m?.threadName === th)
      .sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
    if (inThread.length) return inThread[0];
  }
  let cur = clicked;
  for (let i = 0; i < 30; i++) {
    const qn = cur?.quoted?.name;
    if (!qn || !byName.has(qn)) break;
    cur = byName.get(qn);
  }
  return cur || clicked;
}

/** 未讀在討論串內 → 改開專注討論串（不留在主泡泡收合視圖） */
function resolveUnreadFocusThreadOpen(entry) {
  if (!entry || entry.threadFocus) return null;
  const msgName = String(entry.pendingOpenMessageName || '').trim();
  const threadName = String(entry.pendingOpenThreadName || '').trim();
  if (!msgName || !isGchatApiThreadName(threadName)) return null;
  return resolveFocusThreadFromMessage(
    { name: msgName, threadName, spaceName: entry.spaceName, isDm: entry.isDm },
    entry.contactTitle || entry.title
  );
}

function messageThreadName(message) {
  return String(message?.threadName || message?.thread?.name || '').trim();
}

function isMessageInReplyThread(message) {
  if (isDirectMessageContext(message)) return false;
  return isGchatApiThreadName(messageThreadName(message));
}

/** 由訊息解析專注討論串開啟參數（API thread 路徑才成立） */
function resolveFocusThreadFromMessage(message, contactTitleHint = '') {
  if (isDirectMessageContext(message)) return null;
  const msgName = String(message?.name || '').trim();
  const threadName = messageThreadName(message);
  if (!msgName || !isGchatApiThreadName(threadName)) return null;
  const spaceName = String(message?.spaceName || '').trim();
  const packet = findReadyGchatPacket(msgName, {
    name: msgName,
    spaceName,
    threadName
  });
  const thread = packet?.thread || [];
  const clicked = thread.find((m) => m?.name === msgName)
    || packet?.detail
    || { name: msgName, threadName, spaceName, text: message?.text, snippet: message?.snippet };
  const merged = {
    ...clicked,
    threadName: clicked.threadName || threadName
  };
  const root = findThreadRootInList(thread, merged);
  const rootText = snippetForFocusTitleRuntime(
    (root?.name === msgName ? (merged.text || merged.snippet) : null)
      || root?.text || root?.snippet || merged.text || merged.snippet || ''
  );
  return {
    messageName: root?.name || msgName,
    openMessageName: msgName,
    threadName,
    rootMessageName: root?.name || msgName,
    focusRootText: rootText,
    spaceName,
    isDm: !!message?.isDm,
    contactTitle: String(contactTitleHint || '').trim()
  };
}

function rememberFocusPopOpenTarget(entry, message) {
  if (!entry?.threadFocus || !message?.name) return;
  entry.pendingOpenMessageName = String(message.name).trim();
  entry.pendingOpenThreadName = messageThreadName(message);
}

/** 確保專注討論串 bar 存在（不開泡泡，僅 bar） */
function ensureFocusBarEntry(focusOpen) {
  if (!focusOpen?.threadName || !focusOpen?.spaceName) return null;
  const convKey = replyPopConvKey(focusOpen.spaceName, focusOpen.messageName, focusOpen.threadName);
  let entry = findReplyPopEntry({ convKey, threadName: focusOpen.threadName, focusOnly: true });
  if (entry) {
    if (focusOpen.rootMessageName) entry.rootMessageName = focusOpen.rootMessageName;
    if (focusOpen.focusRootText) entry.focusRootText = focusOpen.focusRootText;
    if (focusOpen.contactTitle && (!entry.contactTitle || isWeakGchatBubbleTitle(entry.contactTitle))) {
      entry.contactTitle = focusOpen.contactTitle;
    }
    if (/\/threads\//.test(focusOpen.threadName)) {
      entry.apiThreadName = focusOpen.threadName.replace(/^focus:/, '');
    }
    refreshFocusEntryTitle(entry);
    return entry;
  }
  const titleBase = focusOpen.contactTitle || 'Little Reply';
  entry = {
    win: null,
    barWin: null,
    minimized: true,
    unreadBadge: 0,
    expandedDisplayMode: 'normal',
    title: formatFocusThreadBarTitle(titleBase, focusOpen.focusRootText || ''),
    isDm: !!focusOpen.isDm,
    messageName: focusOpen.messageName,
    spaceName: focusOpen.spaceName,
    convKey,
    expandedBounds: null,
    threadFocus: true,
    threadName: focusOpen.threadName,
    rootMessageName: focusOpen.rootMessageName || focusOpen.messageName,
    focusRootText: focusOpen.focusRootText || '',
    contactTitle: titleBase,
    pendingOpenMessageName: '',
    pendingOpenThreadName: '',
    apiThreadName: /\/threads\//.test(focusOpen.threadName)
      ? focusOpen.threadName.replace(/^focus:/, '')
      : ''
  };
  replyPopRegistry.set(convKey, entry);
  refreshFocusEntryTitle(entry);
  return entry;
}

async function routeThreadUnreadToFocusBar(message, titleHint = '') {
  const focusOpen = resolveFocusThreadFromMessage(message, titleHint);
  if (!focusOpen) return null;
  const focusEntry = ensureFocusBarEntry(focusOpen);
  if (!focusEntry) return null;
  rememberFocusPopOpenTarget(focusEntry, message);
  await bumpReplyPopUnread(focusEntry, message, '');
  prefetchReplyPopEntryCache(focusEntry, message);
  // ADR-0005：串內只推 Focus Thread bar；若空間 bar 本來就在，只寫 Anchor 不新建／不加 badge
  mirrorExistingSpaceBarAlertAnchor(message);
  return focusEntry;
}

/**
 * 串內提醒：僅當同空間「一般 bar 已存在」時寫入 Alert Anchor（點群組名 bar 可轉進串）。
 * [Important] 不新建空間 bar、不累加 badge、不強制把 bar 叫回螢幕。
 */
function mirrorExistingSpaceBarAlertAnchor(message) {
  const spaceName = String(message?.spaceName || '').trim();
  if (!spaceName || isDirectMessageContext(message)) return null;
  if (!isMessageInReplyThread(message)) return null;

  const spaceEntry = findReplyPopEntryForSpace(spaceName);
  if (!spaceEntry || spaceEntry.threadFocus) return null;

  rememberReplyPopOpenTarget(spaceEntry, message);
  return spaceEntry;
}

/**
 * Toast／提醒點開：依 Alert Anchor 落地（串→Focus＋jump；外層／私人→jump）
 */
async function openFromAlertAnchor(messageName, opts = {}) {
  const name = String(messageName || '').trim();
  if (!name) return { success: false, error: '缺少訊息' };

  let message = (gchatCache.messages || []).find((m) => m.name === name)
    || findReadyGchatPacket(name)?.detail
    || (gchatCache.todayTouched || []).find((m) => m.name === name)
    || null;
  if (!message) {
    try {
      message = await fetchGchatMessageDetail(name);
    } catch (_) {}
  }
  if (!message) {
    return openCompactGchatReply(name, {
      jumpToMessage: true,
      jumpMessageName: name,
      readUntil: opts.readUntil,
      skipMarkRead: opts.skipMarkRead,
      stealFocus: opts.stealFocus
    });
  }

  const titleHint = await resolveAlertDisplayTitle(message);
  if (isMessageInReplyThread(message)) {
    const focusOpen = resolveFocusThreadFromMessage(message, titleHint);
    if (focusOpen) {
      return openCompactGchatReply(focusOpen.messageName, {
        spaceName: focusOpen.spaceName || message.spaceName,
        threadName: focusOpen.threadName,
        focusThread: true,
        rootMessageName: focusOpen.rootMessageName,
        focusRootText: focusOpen.focusRootText,
        title: titleHint,
        isDm: !!message.isDm,
        jumpToMessage: true,
        jumpMessageName: focusOpen.openMessageName || name,
        readUntil: opts.readUntil,
        skipMarkRead: opts.skipMarkRead,
        stealFocus: opts.stealFocus
      });
    }
  }

  return openCompactGchatReply(name, {
    spaceName: message.spaceName || '',
    isDm: !!message.isDm || isDirectMessageContext(message),
    title: titleHint,
    jumpToMessage: true,
    jumpMessageName: name,
    readUntil: opts.readUntil,
    skipMarkRead: opts.skipMarkRead,
    stealFocus: opts.stealFocus
  });
}

async function bumpReplyPopUnread(entry, message, titleHint = '') {
  if (!entry) return;
  const bubbleOpen = !!(entry
    && !entry.minimized
    && entry.win
    && !entry.win.isDestroyed()
    && entry.win.isVisible());
  if (bubbleOpen) {
    entry.unreadBadge = 0;
    seedReplyPopWatchCursor(entry, message?.createTime || '');
    rememberReplyPopOpenTarget(entry, message);
    const focusOpen = resolveUnreadFocusThreadOpen(entry);
    clearReplyPopOpenTarget(entry);
    if (focusOpen) {
      const readUntil = String(entry.lastSeenCreateTime || '').trim();
      await openCompactGchatReply(focusOpen.messageName, {
        spaceName: focusOpen.spaceName || entry.spaceName,
        threadName: focusOpen.threadName,
        focusThread: true,
        rootMessageName: focusOpen.rootMessageName,
        focusRootText: focusOpen.focusRootText,
        title: entry.contactTitle || entry.title,
        isDm: !!entry.isDm,
        readUntil
      });
      syncReplyBarUi(entry);
      return;
    }
    notifyOpenGchatThread(message, { silentRefresh: true });
    syncReplyBarUi(entry);
    return;
  }
  if (titleHint && !entry.threadFocus) {
    if (isReplyBarPriorityMessage(message, entry)
      && (!isWeakGchatBubbleTitle(titleHint) || isWeakGchatBubbleTitle(entry.title))) {
      entry.title = titleHint;
    }
  }
  if (message?.name) {
    if (entry.threadFocus) {
      if (isReplyBarPriorityMessage(message, entry)) {
        rememberFocusPopOpenTarget(entry, message);
      }
    } else if (isReplyBarPriorityMessage(message, entry)) {
      entry.messageName = message.name;
      rememberReplyPopOpenTarget(entry, message);
    }
  }
  if (message?.isDm != null) entry.isDm = !!message.isDm;
  // [Important] 密語 bar 綁對方 sender，供頭像解析（不可用自己）
  if ((entry.isDm || message?.isDm || isDirectMessageContext(message)) && message?.senderName) {
    const sn = String(message.senderName || '').trim();
    if (sn && !isOwnGchatMessage(message)) {
      entry.peerUserName = sn;
      entry.isDm = true;
    }
  }
  if (entry.minimized && message && !isReplyBarPriorityMessage(message, entry)) {
    advanceReplyPopWatchOnly(entry, message?.createTime || '');
    return;
  }
  entry.unreadBadge = (Number(entry.unreadBadge) || 0) + 1;
  entry.minimized = true;
  entry.watchSeeded = true;
  ensureReplyBarWindow(entry);
  rememberDockedBar(entry);
  syncReplyBarUi(entry);
  prefetchReplyPopEntryCache(entry, message);
}

async function showFloatingGchatToast(message) {
  if (!isFeatureActive('gchat')) return { success: false, inactive: true };
  const prefs = loadGchatPrefs();
  if (prefs.alertPopup === false) return { success: false, skipped: true };
  if (!message?.name) return { success: false };

  const spaceName = message.spaceName || '';
  const openName = message.name || '';
  const convKey = replyPopConvKey(spaceName, openName);

  // 主泡泡（非專注）
  let spaceEntry = findReplyPopEntry({ messageName: openName, spaceName, convKey });
  // 同空間、訊息屬於該串的專注 bar
  const focusHits = [...replyPopRegistry.values()].filter(e =>
    e.threadFocus
    && e.spaceName
    && spaceName
    && e.spaceName === spaceName
    && messageBelongsToFocusEntry(message, e)
  );

  const anyOpen = [spaceEntry, ...focusHits].some(entry => entry
    && !entry.minimized
    && entry.win
    && !entry.win.isDestroyed()
    && entry.win.isVisible()
    && isViewingGchatMessage(message));

  if (shouldSuppressGchatToast(message) && anyOpen) {
    notifyOpenGchatThread(message, { silentRefresh: true });
    return { success: true, skipped: true };
  }
  if (shouldSuppressGchatToast(message) && !spaceEntry && !focusHits.length) {
    if (isViewingGchatMessage(message)) {
      notifyOpenGchatThread(message, { silentRefresh: true });
      return { success: true, skipped: true };
    }
  }

  const titleHint = await resolveAlertDisplayTitle(message);
  const minimizedBar = findMinimizedReplyBarForSpace(spaceName)
    || focusHits.find((e) => e?.minimized && e?.barWin && !e.barWin.isDestroyed());
  const priorityForBar = isReplyBarPriorityMessage(message, minimizedBar || spaceEntry || focusHits[0]);

  // [Important] 已縮成 bar：一般群組閒聊只推進水位，不累加 badge／不跳通知
  if (minimizedBar && !priorityForBar) {
    const target = spaceEntry || minimizedBar;
    if (target && message?.createTime) {
      advanceReplyPopWatchOnly(target, message.createTime);
    }
    if (toastWin && !toastWin.isDestroyed()) {
      try { toastWin.hide(); } catch (_) {}
    }
    return { success: true, bar: true, skipped: true, minimizedBar: true };
  }

  // [Important] 討論串回覆 → 僅專注 bar；一般訊息 → 僅群組/私人 bar（不可兩個同時累加）
  if (isMessageInReplyThread(message)) {
    const focusEntry = await routeThreadUnreadToFocusBar(message, titleHint);
    if (focusEntry) {
      positionMinimizedReplyBars();
      if (toastWin && !toastWin.isDestroyed()) {
        try { toastWin.hide(); } catch (_) {}
      }
      return {
        success: true,
        bar: true,
        badge: focusEntry.unreadBadge,
        focusOnly: true
      };
    }
  }

  // [Important] 無既有 bar：非置頂／非 @我／非私人 → 不開新最小 bar、不跳通知
  if (!priorityForBar) {
    if (toastWin && !toastWin.isDestroyed()) {
      try { toastWin.hide(); } catch (_) {}
    }
    return { success: true, skipped: true, reason: 'not-priority' };
  }

  const mainHidden = !win || win.isDestroyed() || !win.isVisible();
  if (mainHidden && !minimizedBar) flashGchatNativeNotification(message);

  if (isDirectMessageContext(message)) {
    await closeDmFocusBarsForSpace(spaceName);
  }

  // [Important] 主聯絡人 bar：僅一般空間訊息
  if (!spaceEntry && spaceName) {
    spaceEntry = findReplyPopEntryForSpace(spaceName);
  }
  if (!spaceEntry) {
    const peerFromMsg = (message.isDm || isDirectMessageContext(message))
      && message.senderName
      && !isOwnGchatMessage(message)
      ? String(message.senderName).trim()
      : '';
    spaceEntry = {
      win: null,
      barWin: null,
      minimized: true,
      unreadBadge: 0,
      expandedDisplayMode: 'normal',
      title: titleHint,
      isDm: !!message.isDm || isDirectMessageContext(message),
      messageName: openName,
      spaceName,
      convKey,
      peerUserName: peerFromMsg,
      iconUrl: '',
      emoji: '',
      expandedBounds: null,
      threadFocus: false,
      pendingOpenMessageName: '',
      pendingOpenThreadName: ''
    };
    replyPopRegistry.set(convKey, spaceEntry);
  } else if ((message.isDm || isDirectMessageContext(message)) && message.senderName && !isOwnGchatMessage(message)) {
    spaceEntry.peerUserName = String(message.senderName).trim();
    spaceEntry.isDm = true;
  }
  await bumpReplyPopUnread(spaceEntry, message, titleHint);
  prefetchReplyPopEntryCache(spaceEntry, message);

  positionMinimizedReplyBars();
  if (toastWin && !toastWin.isDestroyed()) {
    try { toastWin.hide(); } catch (_) {}
  }
  return {
    success: true,
    bar: true,
    badge: spaceEntry.unreadBadge,
    focusBadges: focusHits.map(e => e.unreadBadge)
  };
}


// ========== 【MODULE: framework/window】主視窗 BrowserWindow ==========
// ========== 【MODULE: framework/partial-views】Renderer Partial 讀取 ==========
// [Important] 「加入功能」時 renderer 會請求此 IPC，讀取 features/<type>/view.html
const FEATURE_PARTIAL_ALLOW = new Set([
  'calendar', 'gmail', 'gchat', 'sheets', 'notes', 'sitesVisits', 'chat', 'reportExport'
]);

ipcMain.handle('load-feature-partial', async (_event, type) => {
  try {
    const key = String(type || '');
    if (!FEATURE_PARTIAL_ALLOW.has(key)) {
      return { success: false, error: `未知功能：${key}` };
    }
    const file = path.join(APP_ROOT, 'renderer', 'features', key, 'view.html');
    if (!fs.existsSync(file)) {
      return { success: false, error: `找不到 partial：${key}` };
    }
    return { success: true, html: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

function createWindow () {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    title: APP_DISPLAY_NAME, autoHideMenuBar: true,
    icon: path.join(APP_ROOT, 'icon.png'),
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.setTitle(APP_DISPLAY_NAME);
  win.loadFile(path.join(APP_ROOT, 'index.html'));
  try { win.webContents.setBackgroundThrottling(false); } catch (_) {}
  // 清掉開發模式下 Electron 預設的工作列捷徑項目
  try { app.setUserTasks([]); } catch (_) {}
  ensureTray();
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(APP_DISPLAY_NAME);
  });
  win.on('close', (event) => {
    if (isQuitting) return;
    const prefs = loadGchatPrefs();
    if (prefs.closeToTray !== false) {
      event.preventDefault();
      win.hide();
    }
  });
}

ipcMain.handle('window-minimize', async () => {
  if (!win) return { success: false };
  win.hide();
  return { success: true };
});

ipcMain.handle('window-show', async () => {
  if (!win) return { success: false };
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return { success: true };
});

ipcMain.handle('app-quit', async () => {
  isQuitting = true;
  if (toastWin && !toastWin.isDestroyed()) toastWin.close();
  for (const entry of replyPopRegistry.values()) {
    if (!entry.win.isDestroyed()) entry.win.close();
  }
  replyPopRegistry.clear();
  minimizedReplyOrder.length = 0;
  if (replyPopWin && !replyPopWin.isDestroyed()) replyPopWin.close();
  app.quit();
  return { success: true };
});

ipcMain.handle('get-app-theme', async () => ({
  success: true,
  theme: currentAppTheme || loadAppTheme()
}));

ipcMain.handle('set-app-theme', async (_event, theme) => {
  const id = saveAppTheme(theme);
  broadcastAppTheme(id);
  return { success: true, theme: id };
});

ipcMain.handle('get-app-font-scale', async () => ({
  success: true,
  scale: currentAppFontScale || loadAppFontScale()
}));

ipcMain.handle('set-app-font-scale', async (_event, scale) => {
  const s = saveAppFontScale(scale);
  broadcastAppFontScale(s);
  return { success: true, scale: s };
});

let mainGchatAlertSeeded = false;
/** Little Reply 背景同步間隔（唯一 Scheduler） */
const GCHAT_ALERT_POLL_MS = 30 * 1000;
/** @type {{ scheduler: object, syncService: object, cacheRepository: object } | null} */
let gchatSyncStack = null;
let gchatChatApiService = null;
let gchatSearchService = null;
let gchatMessageTransformService = null;
let gchatDetailPackService = null;
let gchatReadMarkService = null;
let gchatMediaCache = null;

function ensureGchatMediaCache() {
  if (gchatMediaCache) return gchatMediaCache;
  gchatMediaCache = createGchatMediaCache({
    getUserDataPath: () => app.getPath('userData'),
    log: (msg, detail) => gchatSyncLog(msg, detail || '')
  });
  return gchatMediaCache;
}
let gchatPacketRepository = null;
let gchatPollCoordinator = null;

function ensureGchatPollCoordinator() {
  if (gchatPollCoordinator) return gchatPollCoordinator;
  ensureGchatSyncStack();
  return gchatPollCoordinator;
}

function collectGchatPinSpaceKeys() {
  const pinKeys = new Set();
  try {
    const prefs = loadGchatPrefs();
    for (const s of prefs.pinnedSpaces || []) {
      if (s?.spaceName) pinKeys.add(gchatSpacePacketKey(s.spaceName));
    }
    for (const c of prefs.pinnedContacts || []) {
      if (c?.spaceName) pinKeys.add(gchatSpacePacketKey(c.spaceName));
    }
  } catch (_) {}
  return pinKeys;
}

function ensureGchatPacketRepository() {
  if (gchatPacketRepository) return gchatPacketRepository;
  gchatPacketRepository = createPacketRepository({
    getPackets: () => gchatCache.packets,
    setPackets: (packets) => { gchatCache.packets = packets; },
    getInboxMessages: () => gchatCache.messages || [],
    getTodayTouched: () => gchatCache.todayTouched || [],
    getSpaceNames: () => gchatCache.spaceNames || {},
    setSpaceName: (spaceName, label) => { gchatCache.spaceNames[spaceName] = label; },
    getSpaceTypes: () => gchatCache.spaceTypes || {},
    spacePacketKey: gchatSpacePacketKey,
    trackKey: gchatTrackKey,
    annotateThreadMine: annotateGchatThreadMine,
    groupMessagesByThread: groupGchatMessagesByThread,
    isOwnMessage: isOwnGchatMessage,
    cleanSpaceLabel: cleanGchatSpaceLabel,
    pickLabel: pickGoodGchatLabel,
    threadNeedsMediaHydration,
    slimMessageForDisk: slimGchatMessageForDisk,
    getPinSpaceKeys: collectGchatPinSpaceKeys
  });
  return gchatPacketRepository;
}

function ensureGchatChatApiService() {
  if (gchatChatApiService) return gchatChatApiService;
  gchatChatApiService = createChatApiService({
    chatHttp,
    getChatService: () => chatService,
    withRetry: withTransientRetry,
    withAuthRetry: withGoogleApiRetry,
    isReady: () => !!(oauth2Client && chatService),
    isQuotaBlocked: isChatApiQuotaBlocked,
    markQuotaBlocked: markChatApiQuotaBlocked,
    isQuotaError: isChatQuotaError
  });
  return gchatChatApiService;
}

function ensureGchatIconService() {
  if (gchatIconService) return gchatIconService;
  gchatIconService = createIconService({
    getUserIcons: () => gchatCache.userIcons || {},
    setUserIcon: (userName, icon) => {
      if (!userName || !icon) return;
      if (!gchatCache.userIcons) gchatCache.userIcons = {};
      gchatCache.userIcons[userName] = {
        emoji: String(icon.emoji || '').trim().slice(0, 16),
        iconUrl: String(icon.iconUrl || '').trim()
      };
    },
    getSpaceIcons: () => gchatCache.spaceIcons || {},
    setSpaceIcon: (spaceName, icon) => {
      if (!spaceName || !icon) return;
      if (!gchatCache.spaceIcons) gchatCache.spaceIcons = {};
      gchatCache.spaceIcons[spaceName] = {
        emoji: String(icon.emoji || '').trim().slice(0, 16),
        iconUrl: String(icon.iconUrl || '').trim()
      };
    },
    getPeopleService: () => peopleService,
    getSpaceRaw: (spaceName) => ensureGchatChatApiService().getSpaceRaw(spaceName),
    listSpaceMembersRaw: (spaceName, opts) => ensureGchatChatApiService().listSpaceMembersRaw(spaceName, opts),
    isSelfUserName: (userName) => {
      const un = String(userName || '').trim();
      if (!un) return false;
      if (un === 'users/me' || un.endsWith('/me')) return true;
      const keys = gchatMyIdentityKeys();
      if (!keys.size) {
        if (un === gchatCache.myUserName) return true;
        if (Array.isArray(gchatCache.myIds) && gchatCache.myIds.includes(un)) return true;
        return false;
      }
      if (keys.has(un) || keys.has(un.toLowerCase())) return true;
      const bare = un.startsWith('users/') ? un.slice(6) : un;
      return !!(bare && (keys.has(bare) || keys.has(bare.toLowerCase()) || keys.has(`users/${bare}`)));
    },
    withAuthRetry: withGoogleApiRetry
  });
  return gchatIconService;
}

/**
 * 從伺服器補齊置頂聯絡人／群組 icon（People photos / spaces 欄位）
 * [Important] 不做本機手動設定；只寫回伺服器能拿到的 iconUrl／emoji
 */
async function hydratePinnedIcons() {
  if (!oauth2Client) return false;
  const prefs = loadGchatPrefs();
  let changed = false;
  const iconSvc = ensureGchatIconService();

  const apply = (item, icon) => {
    if (!item || !icon) return;
    const nextUrl = String(icon.iconUrl || '').trim();
    const nextEmoji = String(icon.emoji || '').trim().slice(0, 16);
    if (nextUrl && nextUrl !== item.iconUrl) {
      item.iconUrl = nextUrl;
      changed = true;
    }
    if (nextEmoji && nextEmoji !== item.emoji) {
      item.emoji = nextEmoji;
      changed = true;
    }
    // 有頭像 URL 時不再依賴佔位／舊本機 emoji
    if (nextUrl && item.emoji && !nextEmoji) {
      // keep existing emoji only if no photo-derived emoji
    }
  };

  for (const c of prefs.pinnedContacts || []) {
    if (!c?.userName) continue;
    try {
      const icon = await iconSvc.resolveContactIcon(c.userName);
      apply(c, icon);
      if (c.spaceName && (icon.iconUrl || icon.emoji)) {
        iconSvc.rememberSpaceIcon(c.spaceName, icon);
      }
    } catch (_) {}
  }
  for (const s of prefs.pinnedSpaces || []) {
    if (!s?.spaceName) continue;
    try {
      const icon = await iconSvc.resolveSpaceIcon(s.spaceName, {
        isDm: !!s.isDm,
        label: s.label || ''
      });
      apply(s, icon);
    } catch (_) {}
  }

  if (changed) {
    saveGchatPrefs({
      ...prefs,
      pinnedContacts: prefs.pinnedContacts || [],
      pinnedSpaces: prefs.pinnedSpaces || []
    });
    broadcastGchatListUpdate();
  }
  return changed;
}

function ensureGchatSearchService() {
  if (gchatSearchService) return gchatSearchService;
  gchatSearchService = createSearchService({
    getUserNames: () => gchatCache.userNames || {},
    getUserIcons: () => gchatCache.userIcons || {},
    getSpaceIcons: () => gchatCache.spaceIcons || {},
    getSpaceListState: () => ({
      list: gchatCache.spaceList,
      at: gchatCache.spaceListAt || 0
    }),
    setSpaceList: (list) => {
      gchatCache.spaceList = list;
      gchatCache.spaceListAt = Date.now();
    },
    getSpaceNames: () => gchatCache.spaceNames || {},
    getSpaceTypes: () => gchatCache.spaceTypes || {},
    getPinnedSpaces: () => {
      const prefs = loadGchatPrefs();
      const out = [];
      for (const s of prefs.pinnedSpaces || []) {
        if (!s?.spaceName) continue;
        out.push({
          spaceName: s.spaceName,
          label: s.label || s.spaceName,
          spaceType: s.spaceType || '',
          isDm: !!s.isDm
        });
      }
      for (const c of prefs.pinnedContacts || []) {
        if (!c?.spaceName) continue;
        out.push({
          spaceName: c.spaceName,
          label: c.label || c.userName || c.spaceName,
          spaceType: 'DIRECT_MESSAGE',
          isDm: true
        });
      }
      return out;
    },
    getTodayTouchedSpaces: () => (gchatCache.todayTouched || []).map((item) => ({
      spaceName: item?.spaceName || '',
      spaceDisplayName: item?.spaceDisplayName || gchatCache.spaceNames?.[item?.spaceName] || '',
      spaceType: item?.spaceType || gchatCache.spaceTypes?.[item?.spaceName] || '',
      isDm: !!(item?.isDm || item?.spaceType === 'DIRECT_MESSAGE')
    })),
    setSpaceName: (spaceName, label) => { gchatCache.spaceNames[spaceName] = label; },
    setSpaceType: (spaceName, spaceType) => { gchatCache.spaceTypes[spaceName] = spaceType; },
    isChatReady: () => !!chatService,
    getPeopleService: () => peopleService,
    listSpaces: (opts) => ensureGchatChatApiService().listSpacesRaw(opts),
    findDirectMessage: (resource) => ensureGchatChatApiService().findDirectMessageRaw(resource),
    setupSpace: (body) => ensureGchatChatApiService().setupSpaceRaw(body),
    pickRicherLabel: pickRicherGchatLabel,
    ingestDirectoryPerson,
    noteDirectoryError,
    googleErrText
  });
  return gchatSearchService;
}

function ensureGchatMessageTransformService() {
  if (gchatMessageTransformService) return gchatMessageTransformService;
  gchatMessageTransformService = createMessageTransformService({
    getUserNames: () => gchatCache.userNames || {},
    getSpaceNames: () => gchatCache.spaceNames || {},
    getUserIcons: () => gchatCache.userIcons || {},
    getSpaceIcons: () => gchatCache.spaceIcons || {},
    getPackets: () => gchatCache.packets || {},
    getMessages: () => gchatCache.messages || [],
    getMyReactions: () => gchatCache.myReactions || {},
    pickGoodLabel: pickGoodGchatLabel,
    cleanSpaceLabel: cleanGchatSpaceLabel,
    extractChatMediaMeta,
    mediaSnippet,
    extractChatCardText,
    extractChatCardLinks,
    extractChatCardModels,
    buildChatCardsHtml,
    compactEmojiAnnotations,
    buildChatMessageTextHtml,
    rebuildChatMessageTextHtml,
    repairCustomEmojiImgHtml,
    scrubCustomEmojiPlaceholders,
    plainChatBody,
    parseChatResource,
    snippetFromText,
    resolveSenderName,
    chatOpenUrl,
    ingestCustomEmojisFromMessageRaw,
    isCustomEmojiShortcode,
    resolveCustomEmojiFromShortcode,
    resolveCustomEmojiByUid,
    resolveCustomEmojiDisplayUrl
  });
  return gchatMessageTransformService;
}

function ensureGchatDetailPackService() {
  if (gchatDetailPackService) return gchatDetailPackService;
  gchatDetailPackService = createDetailPackService({
    isChatReady: () => !!chatService,
    hydrateChatMedia,
    isInboxMessage: isInboxGchatMessage,
    isPinnedSpace: isPinnedGchatSpace,
    isQuotaBlocked: isChatApiQuotaBlocked,
    findReadyPacketBySpace: findReadyGchatPacketBySpace,
    loadConversationHistory,
    indexPacket: indexGchatPacket,
    ensureSpaceMeta,
    cleanSpaceLabel: cleanGchatSpaceLabel,
    setSpaceName: (spaceName, label) => { gchatCache.spaceNames[spaceName] = label; },
    setSpaceType: (spaceName, spaceType) => { gchatCache.spaceTypes[spaceName] = spaceType; },
    getSpaceNames: () => gchatCache.spaceNames || {},
    annotateThreadMine: annotateGchatThreadMine,
    chatOpenUrl,
    isOwnMessage: isOwnGchatMessage,
    ensureThreadMediaHydrated,
    threadNeedsMediaHydration,
    rememberTodayTouch: rememberGchatTodayTouch,
    ensureMyChatUserName,
    saveDisk: saveGchatDisk,
    getIdentitySnapshot: () => ({
      myUserName: gchatCache.myUserName || '',
      myIds: gchatCache.myIds || [],
      myLabels: gchatCache.myLabels || []
    }),
    getDetailCache: ensureGchatDetailCache,
    enrichMessageForDisplay: enrichChatMessageForDisplay,
    enrichThreadForDisplay: enrichChatThreadForDisplay,
    annotateGchatThreadMine,
    getPacketRepository: ensureGchatPacketRepository
  });
  return gchatDetailPackService;
}

function ensureGchatReadMarkService() {
  if (gchatReadMarkService) return gchatReadMarkService;
  gchatReadMarkService = createReadMarkService({
    getMessages: () => gchatCache.messages || [],
    getPackets: () => gchatCache.packets || {},
    findReadyPacketBySpace: findReadyGchatPacketBySpace,
    getSpaceTypes: () => gchatCache.spaceTypes || {},
    getPendingMarkRead: () => gchatPending.markRead,
    addLocallyRead: (name) => { if (name) gchatLocallyRead.add(name); },
    getLocallyReadSpaces: () => gchatLocallyReadSpaces,
    setLocallyReadSpace: (spaceName, readUntil) => {
      if (spaceName) gchatLocallyReadSpaces.set(spaceName, readUntil);
    },
    pickGoodLabel: pickGoodGchatLabel,
    rememberTodayTouch: rememberGchatTodayTouch,
    applyInboxLocalRead: (opts) => {
      const repo = getGchatCacheRepository();
      if (repo) repo.applyInboxLocalRead(opts);
      else applyInboxLocalRead(getGchatRepoContext(), opts);
    },
    trackKey: gchatTrackKey,
    markAlertSeen: (trackKey, createTime) => {
      if (!trackKey) return;
      mainGchatAlerted.add(trackKey);
      if (createTime) mainGchatAlertedAt.set(trackKey, createTime);
    },
    dismissToast: (payload) => {
      try {
        if (toastWin && !toastWin.isDestroyed()) {
          toastWin.webContents.send('gchat-toast-dismiss', payload);
        }
      } catch (_) {}
    },
    getReadSync: () => ensureGchatSyncStack().readSync,
    snapshot: gchatSnapshot,
    broadcastListUpdate: broadcastGchatListUpdate,
    saveDisk: saveGchatDisk,
    logIssue: logGchatApiIssue,
    assertChatReadStateScope: assertChatReadStateScopeForGchat,
    updateSpaceReadState: (spaceName, lastReadTime) => ensureGchatChatApiService().updateSpaceReadState(spaceName, lastReadTime),
    parseChatResource,
    findReadyPacket: findReadyGchatPacket,
    getTodayTouched: () => gchatCache.todayTouched || [],
    isTransientGoogleError,
    removeInboxBySpace: (spaceName) => {
      const repo = getGchatCacheRepository();
      if (repo) repo.removeInboxBySpace(spaceName);
      else removeInboxBySpace(getGchatRepoContext(), spaceName);
    },
    hasLocallyRead: (messageName) => gchatLocallyRead.has(messageName)
  });
  return gchatReadMarkService;
}
let gchatDetailCache = null;

function ensureGchatDetailCache() {
  if (gchatDetailCache) return gchatDetailCache;
  gchatDetailCache = createDetailCache({
    findReadyPacket: findReadyGchatPacket,
    findReadyPacketBySpace: findReadyGchatPacketBySpace,
    getInboxMessages: () => gchatCache.messages || [],
    getTodayTouched: () => gchatCache.todayTouched || [],
    shouldRefreshPacket: shouldRefreshGchatPacket,
    packetNeedsEmojiRepair,
    messageHasDisplayContent
  });
  return gchatDetailCache;
}

async function buildThreadRefreshFromCache(detail, cached, { fromCache = true } = {}) {
  let thread = [...(cached.thread || [])];
  if (detail?.focusThread && detail?.threadName) {
    const th = String(detail.threadName || '').trim();
    thread = thread.filter((m) => {
      const mth = String(m?.threadName || '').trim();
      return mth === th || m?.name === th || m?.name === detail.rootMessageName;
    });
  }
  if (threadNeedsMediaHydration(thread)) {
    await ensureThreadMediaHydrated(thread);
  }
  cached.mediaHydrated = !threadNeedsMediaHydration(thread);
  const threadOut = enrichChatThreadForDisplay(annotateGchatThreadMine(thread));
  return {
    success: true,
    thread: threadOut,
    fromCache: !!fromCache,
    myUserName: gchatCache.myUserName || '',
    myIds: gchatCache.myIds || [],
    myLabels: gchatCache.myLabels || [],
    ...chatApiQuotaStatus()
  };
}
const mainGchatAlerted = new Set();
/** trackKey → 上次提醒時的 createTime；僅更新訊息才重跳泡泡 */
const mainGchatAlertedAt = new Map();
/**
 * 置頂群組 Reply Bar Alert 水位（spaceName → createTime）
 * [Important] 不進 Inbox；只驅動 Bar／Toast。首次只種子、不重放歷史。
 */
const pinnedGroupAlertCursors = new Map();
/** 前端目前正在看的對話（開著 modal 時不要彈 toast） */
let gchatViewing = null;
/** 剛回覆過的空間：短暫抑制 toast，避免自己回話又跳提醒 */
const recentReplySpaces = new Map();
/** 開著回覆時由 PollCoordinator 登記 thread interest */
let gchatViewingInterestKey = '';

function buildViewingSyncDetail(ctx) {
  if (!ctx?.spaceName) return null;
  return {
    spaceName: String(ctx.spaceName || ''),
    threadName: String(ctx.threadName || ''),
    name: String(ctx.messageName || ctx.name || ''),
    isDm: !!ctx.isDm,
    spaceType: ctx.spaceType || (ctx.isDm ? 'DIRECT_MESSAGE' : ''),
    spaceDisplayName: ctx.spaceDisplayName || '',
    sender: ctx.sender || '',
    focusThread: !!ctx.focusThread,
    rootMessageName: ctx.rootMessageName || ''
  };
}

function stopViewingRefreshWatch() {
  if (gchatViewingInterestKey) {
    if (gchatPollCoordinator) gchatPollCoordinator.unregisterInterest(gchatViewingInterestKey);
    gchatViewingInterestKey = '';
  }
}

function startViewingRefreshWatch() {
  stopViewingRefreshWatch();
  if (!gchatViewing?.spaceName) return;
  const coord = ensureGchatPollCoordinator();
  gchatViewingInterestKey = threadPollKey(gchatViewing.spaceName, gchatViewing.threadName);
  const detail = buildViewingSyncDetail(gchatViewing);
  coord.registerInterest(gchatViewingInterestKey, { detail, source: 'viewing' });
}

/** 停止 Background Sync Scheduler（僅登出／Little Reply Feature Off 時呼叫） */
function stopGchatSyncScheduler() {
  if (gchatSyncStack?.scheduler) {
    gchatSyncStack.scheduler.stop();
  }
}

function isOwnGchatMessage(m) {
  if (m?.isMine === true || m?.sender === '我') return true;
  const sender = String(m?.senderName || '').trim();
  if (sender) {
    const keys = gchatMyIdentityKeys();
    if (keys.size) {
      if (keys.has(sender)) return true;
      const senderId = sender.startsWith('users/') ? sender.slice(6) : sender;
      if (senderId && keys.has(senderId)) return true;
      if (senderId && keys.has(`users/${senderId}`)) return true;
      const lower = senderId.toLowerCase();
      if (lower.includes('@') && keys.has(lower)) return true;
    }
  }
  // 備援：完整顯示名稱（含分機）與本人目錄姓名相符
  const label = String(m?.sender || '').trim();
  if (label && Array.isArray(gchatCache.myLabels) && gchatCache.myLabels.includes(label)) {
    return true;
  }
  return false;
}

function gchatMyIdentityKeys() {
  const keys = new Set();
  const add = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    keys.add(s);
    keys.add(s.toLowerCase());
    if (s.startsWith('users/')) {
      const bare = s.slice(6);
      keys.add(bare);
      keys.add(bare.toLowerCase());
      if (bare.startsWith('c') && bare.length > 1) {
        keys.add(bare.slice(1));
        keys.add(`users/${bare.slice(1)}`);
      }
    } else {
      keys.add(`users/${s}`);
      keys.add(`users/${s.toLowerCase()}`);
      if (s.startsWith('c') && s.length > 1) {
        keys.add(s.slice(1));
        keys.add(`users/${s.slice(1)}`);
      }
    }
  };
  add(gchatCache.myUserName);
  add(cache.myEmail);
  if (Array.isArray(gchatCache.myIds)) gchatCache.myIds.forEach(add);
  return keys;
}

function rememberMyGchatIdentity(senderName, extra) {
  if (!gchatCache.myIds) gchatCache.myIds = [];
  if (!gchatCache.myLabels) gchatCache.myLabels = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (!gchatCache.myUserName) gchatCache.myUserName = s.startsWith('users/') ? s : `users/${s}`;
    if (!gchatCache.myIds.includes(s)) gchatCache.myIds.push(s);
    if (s.startsWith('users/c') && s.length > 7) {
      const stripped = `users/${s.slice(7)}`;
      if (!gchatCache.myIds.includes(stripped)) gchatCache.myIds.push(stripped);
    }
  };
  add(senderName);
  add(extra);
  if (gchatCache.myIds.length > 30) gchatCache.myIds = gchatCache.myIds.slice(-30);
}

function rememberMyGchatLabel(label) {
  const s = String(label || '').trim();
  if (!s || s === '我' || s === '成員' || s === '未知') return;
  if (!gchatCache.myLabels) gchatCache.myLabels = [];
  if (!gchatCache.myLabels.includes(s)) gchatCache.myLabels.push(s);
  if (gchatCache.myLabels.length > 12) gchatCache.myLabels = gchatCache.myLabels.slice(-12);
}

/** 取顯示名尾段（例如 …_廖家毅3013 → 廖家毅3013）供比對本人 */
function gchatDisplayLabelTail(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const idx = t.lastIndexOf('_');
  if (idx >= 0 && idx < t.length - 1) return t.slice(idx + 1).trim();
  return t;
}

function isGchatSelfDisplayLabel(part) {
  const s = String(part || '').trim();
  if (!s || s === '我') return true;
  const labels = gchatCache.myLabels || [];
  const myTail = gchatDisplayLabelTail(s);
  for (const lab of labels) {
    if (!lab) continue;
    if (s === lab || s.includes(lab) || lab.includes(s)) return true;
    const labTail = gchatDisplayLabelTail(lab);
    if (myTail && labTail && myTail === labTail) return true;
  }
  const email = String(cache.myEmail || '').trim().toLowerCase();
  if (email) {
    const local = email.split('@')[0];
    if (local && s.toLowerCase().includes(local)) return true;
  }
  return false;
}

/** 泡泡／bar 標題若是佔位字，視為無效（應改用 sender／空間成員名） */
function isWeakGchatBubbleTitle(label) {
  const s = String(label || '').trim().replace(/^★\s*/, '');
  if (!s) return true;
  if (/^users\//i.test(s)) return true;
  return /^(對話|私人訊息|私人|成員|未知|Little Reply|群組)$/i.test(s);
}

/**
 * 私人訊息空間常把雙方用「、」串在一起；標題只留對方。
 * [Important] 影響列表／對話框／toast 顯示名稱
 */
function preferOtherPartyDmLabel(label) {
  const s = String(label || '').trim();
  if (!s) return '';
  if (!/[、,]/.test(s)) return isGchatSelfDisplayLabel(s) ? '' : s;
  const parts = s.split(/[、,]/).map(x => x.trim()).filter(Boolean);
  if (parts.length <= 1) return s;
  const others = parts.filter(p => !isGchatSelfDisplayLabel(p));
  if (others.length >= 1) return others[0];
  return parts[0];
}

/** 私人訊息標題：只留最後一段底線後（如 徐元宏3016） */
function gchatDmShortLabel(label) {
  let s = String(label || '').trim();
  if (!s || isWeakGchatBubbleTitle(s)) return '';
  s = preferOtherPartyDmLabel(s) || s;
  if (isWeakGchatBubbleTitle(s)) return '';
  const usIdx = s.lastIndexOf('_');
  if (usIdx >= 0 && usIdx < s.length - 1) {
    s = s.slice(usIdx + 1).trim();
  }
  return isWeakGchatBubbleTitle(s) ? '' : s;
}

/** 從多個候選挑出可用的泡泡／bar 標題 */
function pickGchatBubbleTitle({
  isDm = false,
  spaceDisplayName = '',
  sender = '',
  spaceName = '',
  fallback = ''
} = {}) {
  const cached = spaceName ? (gchatCache.spaceNames?.[spaceName] || '') : '';
  const userNames = gchatCache.userNames || {};
  const fromUserResource = (value) => {
    const key = String(value || '').trim();
    if (!/^users\//i.test(key)) return '';
    return userNames[key] || '';
  };
  const candidates = [
    spaceDisplayName,
    fromUserResource(spaceDisplayName),
    sender,
    fromUserResource(sender),
    cached,
    fallback
  ];
  for (const c of candidates) {
    let s = String(c || '').trim();
    if (!s || isWeakGchatBubbleTitle(s)) continue;
    if (isDm) {
      s = gchatDmShortLabel(s) || preferOtherPartyDmLabel(s) || s;
    }
    if (s && !isWeakGchatBubbleTitle(s)) return s.slice(0, 80);
  }
  return isDm ? '私人訊息' : 'Little Reply';
}

/** 泡泡框 title（縮小 bar 與標題列共用） */
function formatGchatBubbleTitle(label, { isDm = false } = {}) {
  return pickGchatBubbleTitle({ isDm, spaceDisplayName: label, fallback: label });
}

function enforceReplyPopWindowState(entry) {
  if (!entry) return;
  rememberDockedBar(entry);
  ensureReplyBarWindow(entry);
  positionMinimizedReplyBars();
}

function cleanGchatSpaceLabel(label, spaceType, isDm) {
  const dm = !!(isDm || spaceType === 'DIRECT_MESSAGE');
  if (!dm) return String(label || '').trim();
  return preferOtherPartyDmLabel(label) || String(label || '').trim();
}

function annotateGchatThreadMine(thread) {
  const list = thread || [];
  const byName = new Map(list.filter(m => m?.name).map(m => [m.name, m]));
  return list.map(m => {
    const isMine = m?.isMine === true || isOwnGchatMessage(m) || m?.sender === '我';
    let quoted = m?.quoted || null;
    // 引用 snapshot 若缺文字，用同串訊息補上
    if (quoted?.name && !quoted.text) {
      const hit = byName.get(quoted.name);
      if (hit) {
        quoted = {
          ...quoted,
          sender: quoted.sender || hit.sender || '訊息',
          text: String(hit.text || hit.snippet || '').slice(0, 400)
        };
      }
    }
    if (quoted?.name && !quoted.text && quoted.media?.length) {
      const hint = mediaSnippet(quoted.media);
      if (hint) quoted = { ...quoted, text: hint };
    }
    return {
      ...m,
      isMine,
      sender: isMine ? '我' : m?.sender,
      quoted,
      reactions: Array.isArray(m?.reactions)
        ? m.reactions.map((r) => enrichReactionRow(r))
        : m?.reactions
    };
  });
}

/** 討論串分組鍵：thread.name 優先；無 thread 則以訊息自身為一組 */
function gchatThreadGroupKey(m) {
  const th = String(m?.threadName || '').trim();
  if (th) return th;
  return String(m?.name || '').trim();
}

/**
 * [Important] 先依討論串 ID 分組、組內再依時間，避免不同串的回覆因時間相鄰而誤掛到上一則
 */
function groupGchatMessagesByThread(list) {
  const raw = Array.isArray(list) ? list : [];
  const byName = new Map();
  for (const m of raw) {
    if (m?.name && !byName.has(m.name)) byName.set(m.name, m);
  }
  const groups = new Map();
  for (const m of byName.values()) {
    const key = gchatThreadGroupKey(m);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const blocks = [...groups.values()].map((msgs) => {
    const sorted = [...msgs].sort((a, b) =>
      String(a.createTime || '').localeCompare(String(b.createTime || ''))
    );
    return { anchor: sorted[0]?.createTime || '', sorted };
  });
  blocks.sort((a, b) => String(a.anchor).localeCompare(String(b.anchor)));
  return blocks.flatMap((b) => b.sorted);
}

function isViewingGchatMessage(m) {
  if (!gchatViewing?.spaceName || !m?.spaceName) return false;
  if (gchatViewing.spaceName !== m.spaceName) return false;
  if (gchatViewing.isDm || m.isDm) return true;
  if (!gchatViewing.threadName || !m.threadName) return true;
  return gchatViewing.threadName === m.threadName;
}

function shouldSuppressGchatToast(m) {
  if (!m?.name) return true;
  if (isOwnGchatMessage(m)) return true;
  const entry = findReplyPopEntry({
    spaceName: m.spaceName || '',
    messageName: m.name || '',
    threadName: m.threadName || ''
  });
  const bubbleOpen = !!(entry
    && !entry.minimized
    && entry.win
    && !entry.win.isDestroyed()
    && entry.win.isVisible());
  // 泡泡正展開才壓提醒；最小化 bar 存在時不跳 toast／系統通知（由 showFloatingGchatToast 處理 badge）
  if (bubbleOpen && isViewingGchatMessage(m)) return true;
  if (!entry && isViewingGchatMessage(m)) return true;
  if (m.spaceName && findMinimizedReplyBarForSpace(m.spaceName)) return true;
  const until = recentReplySpaces.get(m.spaceName);
  if (until && Date.now() < until) {
    // 剛回過：若已是最小化 bar，仍允許累加
    if (entry?.minimized) return false;
    return true;
  }
  return false;
}

/** 種子／推進最小化 bar 的未讀水位 */
function seedReplyPopWatchCursor(entry, createTimeHint = '') {
  if (!entry) return;
  entry.watchSeeded = true;
  let t = String(createTimeHint || '').trim();
  if (!t) {
    try {
      const pack = findReadyGchatPacket(entry.messageName, {
        name: entry.messageName,
        spaceName: entry.spaceName
      });
      const thread = pack?.thread || [];
      const last = thread.length ? thread[thread.length - 1] : pack?.detail;
      t = String(last?.createTime || pack?.detail?.createTime || '');
    } catch (_) {}
  }
  if (t && (!entry.lastSeenCreateTime || t > String(entry.lastSeenCreateTime))) {
    entry.lastSeenCreateTime = t;
  }
}

function isOwnChatApiRawMessage(msg) {
  if (!msg) return true;
  return isOwnGchatMessage({
    senderName: msg.sender?.name || '',
    sender: msg.sender?.displayName || '',
    isMine: false
  });
}

/**
 * [Important] 週期輪詢：對已存在的最小化 bar，直接查該空間最新訊息並累加未讀數字；
 * 不依賴「未讀／@我」列表，群組討論串回覆也能更新。
 */
async function syncRegistryReplyPopBadges() {
  if (!isFeatureActive('gchat') || !oauth2Client || !chatService) return;
  const entries = [...replyPopRegistry.values()].filter(e => e?.spaceName);
  if (!entries.length) return;

  for (const entry of entries) {
    const bubbleOpen = !!(entry
      && !entry.minimized
      && entry.win
      && !entry.win.isDestroyed()
      && entry.win.isVisible());
    if (bubbleOpen) {
      // 正開著看：只推進水位、不加 badge
      try {
        const msgs = await ensureGchatChatApiService().listSpaceMessagesRawRetry(entry.spaceName, {
          pageSize: 3,
          orderBy: 'createTime desc'
        });
        const newest = msgs[0];
        if (newest?.createTime) seedReplyPopWatchCursor(entry, newest.createTime);
      } catch (_) {}
      continue;
    }

    try {
      let msgs = await ensureGchatChatApiService().listSpaceMessagesRawRetry(entry.spaceName, {
        pageSize: 12,
        orderBy: 'createTime desc'
      });
      // 專注討論串 bar：只計該回覆串；一般 bar：計整個空間
      if (entry.threadFocus) {
        msgs = msgs.filter((m) => rawMessageBelongsToFocusEntry(m, entry));
      }
      if (!msgs.length) continue;

      const newestTime = String(msgs[0]?.createTime || '');
      if (!entry.watchSeeded || !entry.lastSeenCreateTime) {
        entry.watchSeeded = true;
        entry.lastSeenCreateTime = newestTime;
        continue;
      }

      const lastSeen = String(entry.lastSeenCreateTime || '');
      const fresh = [];
      const threadFresh = new Map();
      for (const m of msgs) {
        const ct = String(m?.createTime || '');
        if (!ct || ct <= lastSeen) break;
        if (isOwnChatApiRawMessage(m)) continue;
        const rawTh = String(m?.thread?.name || '').trim();
        if (!entry.threadFocus && isGchatApiThreadName(rawTh) && !isDirectMessageContext(entry)) {
          if (!threadFresh.has(rawTh)) threadFresh.set(rawTh, []);
          threadFresh.get(rawTh).push(m);
          continue;
        }
        fresh.push(m);
      }
      if (!fresh.length && !threadFresh.size) {
        if (newestTime > lastSeen) entry.lastSeenCreateTime = newestTime;
        continue;
      }

      if (!entry.threadFocus && threadFresh.size) {
        for (const group of threadFresh.values()) {
          const raw = group[0];
          if (!raw?.name) continue;
          const synthetic = {
            name: raw.name,
            spaceName: entry.spaceName,
            threadName: String(raw.thread?.name || '').trim(),
            createTime: raw.createTime || '',
            isDm: !!entry.isDm,
            text: raw.text || raw.formattedText || '',
            snippet: raw.text || ''
          };
          const focusEntry = await routeThreadUnreadToFocusBar(
            synthetic,
            entry.contactTitle || entry.title || ''
          );
          if (focusEntry && group.length > 1) {
            focusEntry.unreadBadge = (Number(focusEntry.unreadBadge) || 0) + (group.length - 1);
            syncReplyBarUi(focusEntry);
          }
        }
      }

      if (!fresh.length) {
        if (newestTime > lastSeen) entry.lastSeenCreateTime = newestTime;
        continue;
      }

      let badgeFresh = fresh;
      if (entry.minimized) {
        badgeFresh = fresh.filter((m) => {
          const syn = syntheticMessageFromRaw(m, entry);
          return syn && isReplyBarPriorityMessage(syn, entry);
        });
        if (!badgeFresh.length) {
          entry.lastSeenCreateTime = String(fresh[0]?.createTime || newestTime);
          entry.watchSeeded = true;
          continue;
        }
      }

      entry.unreadBadge = (Number(entry.unreadBadge) || 0) + badgeFresh.length;
      entry.lastSeenCreateTime = String(fresh[0]?.createTime || newestTime);
      entry.watchSeeded = true;
      entry.minimized = true;
      const topFresh = badgeFresh[0] || fresh[0];
      const allowBarPreviewUpdate = !entry.minimized || entry.threadFocus;
      if (topFresh?.name && allowBarPreviewUpdate && !entry.threadFocus) {
        const syn = syntheticMessageFromRaw(topFresh, entry);
        if (syn && isReplyBarPriorityMessage(syn, entry)) {
          entry.messageName = topFresh.name;
          rememberReplyPopOpenTarget(entry, {
            name: topFresh.name,
            threadName: topFresh.thread?.name || '',
            createTime: topFresh.createTime || ''
          });
        }
      }
      if (topFresh?.name && entry.threadFocus) {
        const syn = syntheticMessageFromRaw(topFresh, entry);
        if (syn && isReplyBarPriorityMessage(syn, entry)) {
          rememberFocusPopOpenTarget(entry, {
            name: topFresh.name,
            threadName: topFresh.thread?.name || entry.threadName || '',
            createTime: topFresh.createTime || ''
          });
        }
      }
      const senderName = topFresh?.sender?.displayName || '';
      if (!entry.threadFocus && !entry.minimized) {
        try {
          const meta = await ensureSpaceMeta(entry.spaceName);
          const resolved = pickGchatBubbleTitle({
            isDm: !!entry.isDm,
            spaceDisplayName: meta?.label || gchatCache.spaceNames?.[entry.spaceName] || '',
            sender: senderName,
            spaceName: entry.spaceName,
            fallback: entry.title
          });
          if (!isWeakGchatBubbleTitle(resolved)) entry.title = resolved;
        } catch (_) {
          if (isWeakGchatBubbleTitle(entry.title) && senderName) {
            entry.title = pickGchatBubbleTitle({
              isDm: !!entry.isDm,
              sender: senderName,
              spaceName: entry.spaceName
            });
          }
        }
      } else if (entry.contactTitle || entry.focusRootText) {
        entry.title = formatFocusThreadBarTitle(entry.contactTitle || entry.title, entry.focusRootText || '');
      }
      ensureReplyBarWindow(entry);
      rememberDockedBar(entry);
      positionMinimizedReplyBars();
      syncReplyBarUi(entry);
      prefetchReplyPopEntryCache(entry, {
        name: topFresh?.name || entry.messageName,
        spaceName: entry.spaceName,
        createTime: topFresh?.createTime || '',
        isDm: !!entry.isDm,
        spaceType: entry.spaceType || ''
      });
      if (!entry.minimized) {
        notifyOpenGchatThread({
          spaceName: entry.spaceName,
          threadName: entry.threadName || '',
          isDm: !!entry.isDm
        }, { silentRefresh: true });
      }
    } catch (err) {
      logGchatApiIssue('最小化 bar 未讀同步', err);
    }
  }
}

function notifyOpenGchatThread(message, opts = {}) {
  // [Important] thread-ping 不開窗、不搶焦點；僅刷新已開的 Reply Pop（焦點政策 Q12）
  const silentRefresh = !!opts.silentRefresh;
  const payload = {
    spaceName: message?.spaceName || '',
    threadName: message?.threadName || '',
    messageName: silentRefresh ? '' : String(message?.name || message?.messageName || ''),
    jumpToMessage: !!opts.jumpToMessage,
    isDm: !!message?.isDm,
    forceRefresh: !!opts.forceRefresh || !!opts.silentRefresh
  };
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('gchat-thread-ping', payload);
    }
  } catch (_) {}
  // 精簡回覆窗也要即時更新；最小化 bar 不 ping（避免隱藏泡泡被 refresh／捲動）
  try {
    for (const entry of replyPopRegistry.values()) {
      if (!entry.win || entry.win.isDestroyed() || entry.minimized) continue;
      entry.win.webContents.send('gchat-thread-ping', payload);
    }
    if (replyPopWin && !replyPopWin.isDestroyed()) {
      const activeEntry = replyPopMessageName
        ? findReplyPopEntry({ messageName: replyPopMessageName })
        : null;
      if (!activeEntry?.minimized) {
        replyPopWin.webContents.send('gchat-thread-ping', payload);
      }
    }
  } catch (_) {}
}

function emitGchatCacheChanged(snapshot, _meta = {}) {
  // [Important] Cache Push 唯一通道：gchat-cache-changed（ADR 0001）
  // gchat-list-updated 已停發，避免 Inbox 雙重刷新
  const payload = snapshot || gchatSnapshot();
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('gchat-cache-changed', payload);
    }
  } catch (_) {}
  try {
    for (const entry of replyPopRegistry.values()) {
      if (!entry.win || entry.win.isDestroyed()) continue;
      entry.win.webContents.send('gchat-cache-changed', payload);
    }
    if (replyPopWin && !replyPopWin.isDestroyed()) {
      replyPopWin.webContents.send('gchat-cache-changed', payload);
    }
  } catch (_) {}
}

function broadcastGchatListUpdate() {
  emitGchatCacheChanged(gchatSnapshot());
}

async function notifyNewGchatAlerts() {
  if (!isFeatureActive('gchat')) return;
  if (loadGchatPrefs().alertPopup === false) return;
  const inboxAlerts = (gchatSnapshot().messages || []).filter((m) => isInboxGchatMessage(m) && (m.isDm || m.mentionedMe));
  if (!mainGchatAlertSeeded) {
    // [Important] 以對話（空間）為單位記住；啟動時只種子、不重跳既有未讀
    inboxAlerts.forEach(m => {
      const key = gchatTrackKey(m) || m.name;
      if (!key) return;
      mainGchatAlerted.add(key);
      mainGchatAlertedAt.set(key, String(m.createTime || ''));
    });
    mainGchatAlertSeeded = true;
    await seedPinnedGroupAlertCursors();
    return;
  }

  let pinnedAlerts = [];
  try {
    pinnedAlerts = await collectPinnedGroupAlertMessages();
  } catch (err) {
    console.warn('[GChat] 置頂群組提醒掃描失敗:', err?.message || err);
  }

  const byName = new Map();
  for (const m of [...inboxAlerts, ...pinnedAlerts]) {
    const name = String(m?.name || '').trim();
    if (!name || byName.has(name)) continue;
    byName.set(name, m);
  }
  const messages = [...byName.values()];
  if (!messages.length) return;

  const fresh = [];
  const updates = [];
  for (const m of messages) {
    const key = gchatTrackKey(m) || m.name;
    if (!key) continue;
    const curTime = String(m.createTime || '');
    const prevTime = String(mainGchatAlertedAt.get(key) || '');
    if (mainGchatAlerted.has(key)) {
      // 僅當同對話出現「更新」的訊息才替換泡泡；勿把啟動前舊未讀當更新重送
      if (curTime && prevTime && curTime > prevTime) {
        mainGchatAlertedAt.set(key, curTime);
        updates.push({ ...m, trackKey: key, replace: true });
      } else if (curTime && !prevTime) {
        mainGchatAlertedAt.set(key, curTime);
      }
      continue;
    }
    mainGchatAlerted.add(key);
    mainGchatAlertedAt.set(key, curTime);
    fresh.push({ ...m, trackKey: key });
  }
  if (!fresh.length && !updates.length) return;

  // 泡泡跳出前先打包歷史（私人＋群組 @／置頂都一樣），點開才能秒回
  await Promise.all([...fresh, ...updates].slice(0, 6).map(async (m) => {
    try {
      const full = gchatCache.messages.find(x => x.name === m.name) || m;
      await packGchatDetailForItem(full, { withHistory: true });
      const siblings = (gchatCache.messages || []).filter(x =>
        x?.spaceName && m.spaceName && x.spaceName === m.spaceName && x.name !== m.name
      );
      await Promise.all(siblings.slice(0, 3).map(s =>
        packGchatDetailForItem(s, { withHistory: true }).catch(() => null)
      ));
    } catch (err) {
      console.warn('提醒前打包歷史失敗:', err.message);
    }
  }));

  for (const m of [...fresh, ...updates]) {
    if (shouldSuppressGchatToast(m)) {
      if (isViewingGchatMessage(m)) notifyOpenGchatThread(m, { silentRefresh: true });
      else if (findMinimizedReplyBarForSpace(m.spaceName) && isReplyBarPriorityMessage(m)) {
        showFloatingGchatToast(m).catch(() => {});
      } else if (findMinimizedReplyBarForSpace(m.spaceName)) {
        const bar = findMinimizedReplyBarForSpace(m.spaceName);
        advanceReplyPopWatchOnly(bar, m.createTime || '');
      }
      continue;
    }
    showFloatingGchatToast(m);
  }
}

/**
 * 列出已置頂的群組 Space（不含私人；私人走 Inbox）
 */
function listPinnedGroupSpacesForAlert() {
  const prefs = loadGchatPrefs();
  const out = [];
  const seen = new Set();
  for (const s of prefs.pinnedSpaces || []) {
    const spaceName = String(s?.spaceName || '').trim();
    if (!spaceName || seen.has(spaceName)) continue;
    if (s?.isDm || String(s?.spaceType || '') === 'DIRECT_MESSAGE') continue;
    if (isMutedSpaceSetting(gchatCache.spaceMute?.[spaceName])) continue;
    seen.add(spaceName);
    out.push(spaceName);
  }
  return out;
}

/** 啟動／重設提醒時：置頂群組只種子水位，不重放歷史 */
async function seedPinnedGroupAlertCursors() {
  if (!oauth2Client || !chatService) return;
  const spaces = listPinnedGroupSpacesForAlert().slice(0, 12);
  const api = ensureGchatChatApiService();
  for (const spaceName of spaces) {
    try {
      ensurePinnedSpaceUnreadBaseline(spaceName, false);
      const msgs = await api.listSpaceMessagesRawRetry(spaceName, {
        pageSize: 1,
        orderBy: 'createTime desc'
      });
      const newestTime = String(msgs[0]?.createTime || '').trim();
      const baseline = String(gchatLocallyReadSpaces.get(spaceName) || '').trim();
      const seed = [newestTime, baseline].filter(Boolean).sort().pop() || newestTime;
      if (seed) pinnedGroupAlertCursors.set(spaceName, seed);
    } catch (err) {
      logGchatApiIssue('置頂群組提醒種子', err);
    }
  }
}

/**
 * 置頂群組未 @／一般新訊 → Reply Bar Alert 候選（不寫入 Inbox）
 * ADR-0004：Inbox 維持私人／@我；此路徑只餵 notify → Bar／Toast。
 * 若該空間已有 Reply Pop／Bar，水位仍推進，未讀改由 syncRegistryReplyPopBadges 累加（避免雙重 badge）。
 */
async function collectPinnedGroupAlertMessages() {
  if (!oauth2Client || !chatService) return [];
  const spaces = listPinnedGroupSpacesForAlert().slice(0, 12);
  if (!spaces.length) return [];

  const api = ensureGchatChatApiService();
  const myUserName = gchatCache.myUserName || await ensureMyChatUserName();
  const out = [];

  for (const spaceName of spaces) {
    try {
      const msgs = await api.listSpaceMessagesRawRetry(spaceName, {
        pageSize: 8,
        orderBy: 'createTime desc'
      });
      if (!msgs.length) continue;
      const newestTime = String(msgs[0]?.createTime || '').trim();
      if (!pinnedGroupAlertCursors.has(spaceName)) {
        ensurePinnedSpaceUnreadBaseline(spaceName, false);
        const baseline = String(gchatLocallyReadSpaces.get(spaceName) || '').trim();
        const seed = [newestTime, baseline].filter(Boolean).sort().pop() || newestTime;
        if (seed) pinnedGroupAlertCursors.set(spaceName, seed);
        continue;
      }

      // 已有 bar／泡泡：只推進水位，讓 registry badge 路徑處理
      if (findReplyPopEntryForSpace(spaceName) || findMinimizedReplyBarForSpace(spaceName)) {
        if (newestTime) pinnedGroupAlertCursors.set(spaceName, newestTime);
        continue;
      }

      const cursor = String(pinnedGroupAlertCursors.get(spaceName) || '');
      const meta = await ensureSpaceMeta(spaceName);
      if (meta?.spaceType === 'DIRECT_MESSAGE') {
        pinnedGroupAlertCursors.set(spaceName, newestTime || cursor);
        continue;
      }
      for (const raw of msgs) {
        const ct = String(raw?.createTime || '').trim();
        if (!ct || (cursor && ct <= cursor)) break;
        if (isOwnChatApiRawMessage(raw)) continue;
        if (isLocallyReadMessage(raw.name, { spaceName, createTime: ct })) continue;

        const mentionedMe = messageMentionsMe(raw, myUserName);
        const item = await normalizeChatMessage(raw, meta.label || '');
        item.spaceType = meta.spaceType || 'SPACE';
        item.isDm = false;
        item.mentionedMe = !!mentionedMe;
        item.spaceDisplayName = meta.label || item.spaceDisplayName || '';
        item.threadName = String(raw?.thread?.name || item.threadName || '').trim();
        item.pinnedAlert = true;
        out.push(item);
        if (out.length >= 20) break;
      }
      if (newestTime) pinnedGroupAlertCursors.set(spaceName, newestTime);
      if (out.length >= 20) break;
    } catch (err) {
      logGchatApiIssue('置頂群組提醒掃描', err);
    }
  }
  return out;
}

/**
 * 啟動 Background Sync Scheduler（冪等：已運行則不重啟）
 * [Important] ADR 0006：生命週期綁 Active Feature（gchat），不綁 Toast 設定、不綁 Session  alone
 */
function startGchatSyncScheduler() {
  if (!isFeatureActive('gchat')) return;
  ensureGchatSyncStack().scheduler.start();
}

ipcMain.on('open-url', (event, url) => { shell.openExternal(url); });
ipcMain.on('open-internal-url', (event, url) => {
  const childWin = new BrowserWindow({ parent: win, modal: false, width: 1000, height: 700, autoHideMenuBar: true });
  childWin.loadURL(url);
});

const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_LOGIN_VALUE = 'LifeTour';
const WIN_LEGACY_LOGIN_VALUES = ['electron.app.Electron', 'electron.app.productivity-hub', 'electron.app.LifeTour'];
const INSTALLED_LIFETOUR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LifeTour', 'LifeTour.exe');

function winLoginCommand() {
  if (app.isPackaged) return `"${process.execPath}"`;
  if (fs.existsSync(INSTALLED_LIFETOUR)) return `"${INSTALLED_LIFETOUR}"`;
  const unpacked = path.join(APP_ROOT, 'dist', 'win-unpacked', 'LifeTour.exe');
  if (fs.existsSync(unpacked)) return `"${unpacked}"`;
  return `"${process.execPath}" "${APP_ROOT}"`;
}

function winRegQuery(valueName) {
  try {
    const out = execFileSync('reg', ['query', WIN_RUN_KEY, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true
    });
    return /REG_SZ/i.test(out);
  } catch (_) {
    return false;
  }
}

function winRegDelete(valueName) {
  try {
    execFileSync('reg', ['delete', WIN_RUN_KEY, '/v', valueName, '/f'], {
      encoding: 'utf8',
      windowsHide: true
    });
  } catch (_) {}
}

function isOpenAtLoginEnabled() {
  if (process.platform === 'win32') {
    return winRegQuery(WIN_LOGIN_VALUE) || WIN_LEGACY_LOGIN_VALUES.some(winRegQuery);
  }
  return !!app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLoginEnabled(enabled) {
  if (process.platform === 'win32') {
    WIN_LEGACY_LOGIN_VALUES.forEach(winRegDelete);
    if (enabled) {
      execFileSync(
        'reg',
        ['add', WIN_RUN_KEY, '/v', WIN_LOGIN_VALUE, '/t', 'REG_SZ', '/d', winLoginCommand(), '/f'],
        { encoding: 'utf8', windowsHide: true }
      );
    } else {
      winRegDelete(WIN_LOGIN_VALUE);
    }
    try {
      app.setLoginItemSettings({ openAtLogin: false });
    } catch (_) {}
    return isOpenAtLoginEnabled();
  }

  const opts = { openAtLogin: !!enabled };
  if (!app.isPackaged) {
    opts.path = process.execPath;
    opts.args = [APP_ROOT];
  }
  app.setLoginItemSettings(opts);
  return !!enabled;
}

ipcMain.handle('get-open-at-login', async () => {
  try {
    return { success: true, openAtLogin: isOpenAtLoginEnabled() };
  } catch (err) {
    return { success: false, openAtLogin: false, error: err.message };
  }
});

ipcMain.handle('set-open-at-login', async (event, enabled) => {
  try {
    const openAtLogin = setOpenAtLoginEnabled(!!enabled);
    return { success: true, openAtLogin };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// [Important] ADR 0006：Active Feature List（Renderer mosaic → Main）
ipcMain.handle('set-active-features', async (_event, types) => {
  try {
    return setActiveFeatureList(types);
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('get-active-features', async () => ({
  success: true,
  received: activeFeaturesReceived,
  features: getActiveFeatureList()
}));

// 💡 新增：清除 Token 並重新啟動 APP
ipcMain.on('logout', () => {
  isQuitting = true;
  stopSyncLoop();
  stopMeetingWatch();
  stopSessionWatch();
  try { reportExportControls?.stopScheduler?.(); } catch (_) {}
  shutdownLittleReplyForLogout();
  clearPacket();
  clearOAuthClientMemory();
  // 登出時清掉授權與 Chat 暫存，下次視為全新授權
  safeUnlinkSync(tokenPath());
  app.relaunch();
  app.exit();
});


// ========== 【MODULE: modules/weather】天氣 ==========
ipcMain.handle('fetch-weather', async (event, url) => {
  try {
    const response = await fetch(String(url || ''), {
      headers: { Accept: 'application/json', 'User-Agent': 'LifeTour/1.0' }
    });
    if (!response.ok) {
      return { success: false, error: `天氣服務回應 ${response.status}` };
    }
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message || '天氣讀取失敗' };
  }
});

/** 網路／暫時性錯誤：不可刪除本機 Token */
function isNetworkAuthError(err) {
  const code = String(err?.code || '');
  const msg = googleErrText(err);
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_NETWORK'].includes(code)) {
    return true;
  }
  if (/fetch failed|network|socket hang up|getaddrinfo|timed out|timeout|ECONN|offline|Unable to connect/i.test(msg)) {
    return true;
  }
  const status = Number(err?.response?.status || err?.code || 0);
  if (!status && /failed/i.test(msg)) return true;
  return isTransientGoogleError(err);
}

/** 授權真的失效（refresh token 無效等） */
function isHardAuthError(err) {
  const msg = googleErrText(err);
  return /invalid_grant|invalid_token|Token has been expired or revoked|unauthorized_client|Account has been deleted|invalid_client|token.?revoked/i.test(msg);
}

function readTokensFromDisk() {
  if (!fs.existsSync(tokenPath())) return null;
  try {
    const tokens = JSON.parse(fs.readFileSync(tokenPath(), 'utf8'));
    if (!tokens?.access_token && !tokens?.refresh_token) return null;
    return tokens;
  } catch (_) {
    return null;
  }
}

function persistOAuthTokens(tokens) {
  if (!tokens) return null;
  try {
    const prev = readTokensFromDisk();
    const merged = prev ? mergeGoogleTokens(prev, tokens) : { ...tokens };
    fs.writeFileSync(tokenPath(), JSON.stringify(merged));
    if (oauth2Client) oauth2Client.setCredentials(merged);
    return merged;
  } catch (err) {
    console.warn('寫入 Token 失敗:', err.message);
    return tokens;
  }
}

function bindOAuthTokenPersistence(client) {
  if (!client || client.__tokenPersistBound) return;
  client.__tokenPersistBound = true;
  client.on('tokens', (tokens) => {
    try {
      const prev = readTokensFromDisk();
      persistOAuthTokens(prev ? mergeGoogleTokens(prev, tokens) : tokens);
    } catch (_) {}
  });
}

function setSessionAuthStatus(authStatus, { error = '' } = {}) {
  sessionState.authStatus = authStatus;
  sessionState.lastCheck = Date.now();
  if (error) sessionState.lastError = error;
  if (authStatus === AUTH_STATUS.AUTHENTICATED) {
    sessionState.authed = true;
    sessionState.offline = false;
    sessionState.lastError = '';
  } else if (authStatus === AUTH_STATUS.OFFLINE) {
    sessionState.authed = true;
    sessionState.offline = true;
  } else if (authStatus === AUTH_STATUS.AUTH_REVOKED) {
    sessionState.authed = false;
    sessionState.offline = false;
  } else if (authStatus === AUTH_STATUS.AUTH_REQUIRED) {
    sessionState.authed = false;
    sessionState.offline = false;
    sessionState.lastError = '';
  }
}

function broadcastSessionStatus() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('session-status', {
      authed: sessionState.authed,
      offline: sessionState.offline,
      authStatus: sessionState.authStatus,
      lastCheck: sessionState.lastCheck,
      error: sessionState.lastError
    });
  }
}

function isGoogle401Error(err) {
  const status = Number(err?.code || err?.status || err?.response?.status || 0);
  return status === 401;
}

/** 僅清記憶體中的 OAuth client／服務；不刪除 google_token.json */
function clearOAuthClientMemory() {
  stopSyncLoop();
  stopMeetingWatch();
  oauth2Client = null;
  calendarService = null;
  gmailService = null;
  peopleService = null;
  sheetsService = null;
  driveService = null;
  keepService = null;
  chatService = null;
  adminService = null;
}

async function refreshGoogleAccessToken() {
  const tokens = readTokensFromDisk();
  if (!tokens) {
    return { success: false, error: 'no credential', authStatus: AUTH_STATUS.AUTH_REQUIRED };
  }
  const google = getGoogle();
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    oauth2Client.setCredentials(tokens);
    bindOAuthTokenPersistence(oauth2Client);
  }
  const refreshToken = oauth2Client.credentials?.refresh_token || tokens.refresh_token;
  if (!refreshToken) {
    return { success: false, error: 'no refresh token', authStatus: AUTH_STATUS.AUTH_REVOKED, revoked: true };
  }
  try {
    setSessionAuthStatus(AUTH_STATUS.AUTH_REFRESHING);
    const refreshed = await oauth2Client.refreshAccessToken();
    if (refreshed?.credentials) {
      const merged = mergeGoogleTokens(readTokensFromDisk(), refreshed.credentials);
      oauth2Client.setCredentials(merged);
      persistOAuthTokens(merged);
      if (!gmailService) initGoogleServices();
      setSessionAuthStatus(AUTH_STATUS.AUTHENTICATED);
      return { success: true, authStatus: AUTH_STATUS.AUTHENTICATED };
    }
    return { success: false, error: 'refresh returned no credentials' };
  } catch (err) {
    if (isHardAuthError(err)) {
      clearOAuthClientMemory();
      const msg = err.message || String(err);
      setSessionAuthStatus(AUTH_STATUS.AUTH_REVOKED, { error: msg });
      return { success: false, revoked: true, authStatus: AUTH_STATUS.AUTH_REVOKED, error: msg };
    }
    if (isNetworkAuthError(err)) {
      setSessionAuthStatus(AUTH_STATUS.OFFLINE, { error: err.message || String(err) });
      return { success: false, offline: true, authStatus: AUTH_STATUS.OFFLINE, error: err.message || String(err) };
    }
    throw err;
  }
}

/** API 401：先 refresh，成功後 retry 一次 */
async function withGoogleApiRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isGoogle401Error(err)) throw err;
    const refresh = await refreshGoogleAccessToken();
    if (!refresh.success) {
      if (refresh.revoked) {
        err.authRevoked = true;
        err.authStatus = AUTH_STATUS.AUTH_REVOKED;
      }
      throw err;
    }
    return await fn();
  }
}

/**
 * 確保 Google 授權可用；離線時保留 Token，不視為登出。
 * [Important] Phase 1：授權失效 ≠ 刪除 credential；僅 Logout 可清磁碟 token。
 * @returns {{ success?: boolean, offline?: boolean, needsAuth?: boolean, needsReconnect?: boolean, authRevoked?: boolean, hasTokens?: boolean, authStatus?: string, restored?: boolean, error?: string }}
 */
async function ensureGoogleSession({ silent = false } = {}) {
  const tokens = readTokensFromDisk();
  if (!tokens) {
    setSessionAuthStatus(AUTH_STATUS.AUTH_REQUIRED);
    return { success: false, needsAuth: true, authStatus: AUTH_STATUS.AUTH_REQUIRED };
  }

  const google = getGoogle();
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    oauth2Client.setCredentials(tokens);
    bindOAuthTokenPersistence(oauth2Client);
  }

  const wasDown = !sessionState.authed;
  try {
    setSessionAuthStatus(AUTH_STATUS.AUTH_REFRESHING);
    const tok = await oauth2Client.getAccessToken();
    if (!tok?.token) throw new Error('no access token');
    persistOAuthTokens(oauth2Client.credentials || tokens);

    if (!gmailService) initGoogleServices();
    // [Important] ADR 0006：背景啟動改由 Active Feature List reconcile，不在 Session 成功時無條件開
    reconcileActiveFeatureBackgrounds().catch((err) => {
      console.warn('[ActiveFeatures] session reconcile failed:', err?.message || err);
    });

    setSessionAuthStatus(AUTH_STATUS.AUTHENTICATED);
    // [Important] ADR 0006：有 Chat scope ≠ 可打 Chat API；預載改由 tryStartLittleReplyBackground
    return { success: true, restored: wasDown, authStatus: AUTH_STATUS.AUTHENTICATED };
  } catch (err) {
    const errMsg = err.message || String(err);
    sessionState.lastCheck = Date.now();
    sessionState.lastError = errMsg;

    if (isNetworkAuthError(err)) {
      setSessionAuthStatus(AUTH_STATUS.OFFLINE, { error: errMsg });
      if (!gmailService) initGoogleServices();
      if (!silent) console.warn('[Session] 離線中，保留授權:', errMsg);
      return {
        success: false,
        offline: true,
        hasTokens: true,
        authStatus: AUTH_STATUS.OFFLINE,
        error: '目前離線，授權仍保留'
      };
    }

    if (isHardAuthError(err)) {
      if (!silent) console.warn('[Session] Refresh 失效，需重新連結 Google（保留本機 credential）:', errMsg);
      clearOAuthClientMemory();
      setSessionAuthStatus(AUTH_STATUS.AUTH_REVOKED, { error: errMsg });
      return {
        success: false,
        needsReconnect: true,
        authRevoked: true,
        hasTokens: true,
        authStatus: AUTH_STATUS.AUTH_REVOKED,
        error: 'Google 授權已失效，請重新連結帳號'
      };
    }

    // 未知錯誤：保守保留 Token，視為暫時離線
    setSessionAuthStatus(AUTH_STATUS.OFFLINE, { error: errMsg });
    if (!gmailService) initGoogleServices();
    if (!silent) console.warn('[Session] 暫時無法驗證，保留授權:', errMsg);
    return {
      success: false,
      offline: true,
      hasTokens: true,
      authStatus: AUTH_STATUS.OFFLINE,
      error: errMsg
    };
  }
}

async function requireGoogleSession() {
  if (oauth2Client && sessionState.authStatus === AUTH_STATUS.AUTHENTICATED) {
    return { ok: true, offline: sessionState.offline, authStatus: sessionState.authStatus };
  }
  const res = await ensureGoogleSession({ silent: true });
  if (res.success) return { ok: true, authStatus: AUTH_STATUS.AUTHENTICATED };
  if (res.offline) return { ok: true, offline: true, authStatus: AUTH_STATUS.OFFLINE };
  if (res.authRevoked || res.needsReconnect) {
    return { ok: false, authRevoked: true, needsReconnect: true, authStatus: AUTH_STATUS.AUTH_REVOKED, ...res };
  }
  return { ok: false, ...res };
}

async function runSessionWatch() {
  const prevOffline = sessionState.offline;
  const prevAuthed = sessionState.authed;
  const res = await ensureGoogleSession({ silent: true });
  if (res.success && res.restored) {
    notifyRenderer();
    try {
      if (win && !win.isDestroyed()) {
        emitGchatCacheChanged(gchatSnapshot());
      }
    } catch (_) {}
  }
  if (prevOffline !== sessionState.offline || prevAuthed !== sessionState.authed || res.success) {
    broadcastSessionStatus();
  }
}

function startSessionWatch() {
  if (sessionWatchTimer) clearInterval(sessionWatchTimer);
  runSessionWatch().catch(() => {});
  sessionWatchTimer = setInterval(() => runSessionWatch().catch(() => {}), 60000);
}

function stopSessionWatch() {
  if (sessionWatchTimer) {
    clearInterval(sessionWatchTimer);
    sessionWatchTimer = null;
  }
}


// ========== 【MODULE: authorization】登入／Session／OAuth ==========
ipcMain.handle('check-login', async () => {
  try {
    maybeMigrateCredentialFromAlternate();
    const tokens = readTokensFromDisk();
    if (!tokens) {
      const probe = buildCredentialProbe({ authStatus: AUTH_STATUS.AUTH_REQUIRED, hasTokens: false });
      return {
        success: false,
        needsAuth: true,
        authStatus: AUTH_STATUS.AUTH_REQUIRED,
        credentialProbe: probe
      };
    }
    const res = await ensureGoogleSession();
    if (res.success) {
      broadcastSessionStatus();
      credentialProbeState.lastReason = credentialProbeState.migratedFrom
        ? 'migrated_from_alternate'
        : 'ok_present';
      return {
        success: true,
        authStatus: AUTH_STATUS.AUTHENTICATED,
        credentialProbe: buildCredentialProbe({ authStatus: AUTH_STATUS.AUTHENTICATED, hasTokens: true })
      };
    }
    if (res.offline) {
      broadcastSessionStatus();
      return {
        success: false,
        offline: true,
        hasTokens: true,
        authStatus: AUTH_STATUS.OFFLINE,
        error: res.error,
        credentialProbe: buildCredentialProbe({ authStatus: AUTH_STATUS.OFFLINE, hasTokens: true })
      };
    }
    if (res.authRevoked || res.needsReconnect) {
      broadcastSessionStatus();
      credentialProbeState.lastReason = 'present_but_unusable';
      return {
        success: false,
        needsReconnect: true,
        hasTokens: true,
        authStatus: AUTH_STATUS.AUTH_REVOKED,
        error: res.error,
        credentialProbe: buildCredentialProbe({ authStatus: AUTH_STATUS.AUTH_REVOKED, hasTokens: true })
      };
    }
    broadcastSessionStatus();
    return {
      success: false,
      needsAuth: true,
      authStatus: AUTH_STATUS.AUTH_REQUIRED,
      error: res.error,
      hasTokens: !!readTokensFromDisk(),
      credentialProbe: buildCredentialProbe({ authStatus: AUTH_STATUS.AUTH_REQUIRED, hasTokens: !!readTokensFromDisk() })
    };
  } catch (error) {
    return {
      success: false,
      needsAuth: true,
      authStatus: AUTH_STATUS.AUTH_REQUIRED,
      error: error.message,
      credentialProbe: buildCredentialProbe({ authStatus: AUTH_STATUS.AUTH_REQUIRED })
    };
  }
});

ipcMain.handle('ensure-session', async () => {
  try {
    const res = await ensureGoogleSession();
    broadcastSessionStatus();
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function mergeGoogleTokens(prev, next) {
  const merged = { ...(prev || {}), ...(next || {}) };
  // [Important] 新 OAuth 回應常不帶 refresh_token，絕不可覆蓋掉既有值
  if (prev?.refresh_token && !next?.refresh_token) {
    merged.refresh_token = prev.refresh_token;
  }
  if (!merged.refresh_token && prev?.refresh_token) merged.refresh_token = prev.refresh_token;
  const scopes = new Set(
    `${prev?.scope || ''} ${next?.scope || ''}`.split(/[,\s]+/).filter(Boolean)
  );
  if (scopes.size) merged.scope = [...scopes].join(' ');
  return merged;
}

/** 以 tokeninfo 回傳的 scope 校正本機紀錄，避免「檔案有、token 沒有」 */
function syncCredentialsScope(liveScope) {
  const scope = String(liveScope || '').trim();
  if (!scope || !oauth2Client) return;
  try {
    oauth2Client.setCredentials({ ...oauth2Client.credentials, scope });
    persistOAuthTokens(oauth2Client.credentials);
  } catch (_) {}
}

async function tokeninfoScopeForAccessToken(accessToken) {
  const access = String(accessToken || '').trim();
  if (!access) return '';
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(access)}`);
    const data = await res.json();
    if (data?.scope) return data.scope;
  } catch (_) {}
  return '';
}

async function finalizeOAuthCredentials(client, merged) {
  const prevDisk = readTokensFromDisk();
  let out = mergeGoogleTokens(prevDisk, merged || {});
  oauth2Client = client;
  oauth2Client.setCredentials(out);
  bindOAuthTokenPersistence(oauth2Client);
  try {
    const refreshed = await oauth2Client.refreshAccessToken();
    if (refreshed?.credentials) {
      out = mergeGoogleTokens(out, refreshed.credentials);
      oauth2Client.setCredentials(out);
      bindOAuthTokenPersistence(oauth2Client);
    }
  } catch (err) {
    console.warn('[OAuth] refreshAccessToken:', err.message);
  }
  const live = await tokeninfoScopeForAccessToken(out.access_token || oauth2Client.credentials?.access_token);
  if (live) {
    out.scope = live;
    syncCredentialsScope(live);
  }
  persistOAuthTokens(out);
  initGoogleServices();
  setSessionAuthStatus(AUTH_STATUS.AUTHENTICATED);
  return out;
}

async function scopesMissingFromToken(needed) {
  const list = [...new Set((needed || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (!list.length) return [];
  const live = await grantedScopeText();
  return list.filter((s) => !scopeListHas(live, [s]));
}

function hasSheetsScope(scopeText) {
  return /spreadsheets/i.test(String(scopeText || ''));
}

function hasDriveFileScope(scopeText) {
  return /auth\/drive(?:\.file)?(?:\s|$|,)/i.test(String(scopeText || ''))
    || /auth\/drive(?:\s|$|,)/i.test(String(scopeText || ''));
}

function hasChatMessagesScope(scopeText) {
  return /(?:^|[\s,])https:\/\/www\.googleapis\.com\/auth\/chat\.messages(?:[\s,]|$)/.test(String(scopeText || ''));
}

function hasChatReadStateScope(scopeText) {
  return /chat\.users\.readstate/.test(String(scopeText || ''));
}

function hasChatScopes(scopeText) {
  // [Important] 與 Scope Registry 的 Little Reply Core 對齊（ADR 0003）
  return scopeListHas(scopeText, GCHAT_CORE_SCOPES);
}

function hasGchatExtendedScopes(scopeText) {
  return scopeListHas(scopeText, GCHAT_EXTENDED_SCOPES);
}

function scopeListHas(scopeText, needed) {
  const granted = new Set(
    String(scopeText || '').split(/[,\s]+/).filter(Boolean)
  );
  return (needed || []).every((s) => granted.has(s));
}

function featureScopes(type) {
  return FEATURE_SCOPE_MAP[type] || [];
}

async function getFeatureAuthStatus(type) {
  const needed = featureScopes(type);
  if (!needed.length) {
    return { success: true, type, authorized: true, authStatus: AUTH_STATUS.AUTHENTICATED, label: FEATURE_LABELS[type] || type };
  }
  const tokens = readTokensFromDisk();
  if (!tokens) {
    return {
      success: true,
      type,
      authorized: false,
      needsLogin: true,
      needsAuth: true,
      authStatus: AUTH_STATUS.AUTH_REQUIRED,
      label: FEATURE_LABELS[type] || type,
      scopes: needed
    };
  }
  const session = await ensureGoogleSession({ silent: true });
  if (session.authRevoked || session.needsReconnect) {
    return {
      success: true,
      type,
      authorized: false,
      needsReconnect: true,
      authStatus: AUTH_STATUS.AUTH_REVOKED,
      label: FEATURE_LABELS[type] || type,
      scopes: needed
    };
  }
  if (session.offline) {
    const scope = await grantedScopeText().catch(() => '');
    const authorized = isFeatureAuthorized(type, scope);
    return {
      success: true,
      type,
      authorized,
      needsAuth: !authorized,
      offline: true,
      authStatus: authorized ? AUTH_STATUS.OFFLINE : AUTH_STATUS.FEATURE_SCOPE_MISSING,
      label: FEATURE_LABELS[type] || type,
      scopes: needed
    };
  }
  const scope = await grantedScopeText();
  const authorized = isFeatureAuthorized(type, scope);
  return {
    success: true,
    type,
    authorized,
    needsAuth: !authorized,
    needsLogin: false,
    featureScopeMissing: !authorized,
    authStatus: authorized ? AUTH_STATUS.AUTHENTICATED : AUTH_STATUS.FEATURE_SCOPE_MISSING,
    label: FEATURE_LABELS[type] || type,
    scopes: needed
  };
}

async function grantedScopeText() {
  const saved = oauth2Client?.credentials || {};
  try {
    if (!oauth2Client) {
      const tokens = readTokensFromDisk();
      if (!tokens) return '';
      const google = getGoogle();
      oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
      oauth2Client.setCredentials(tokens);
      bindOAuthTokenPersistence(oauth2Client);
    }
    const tokenRes = await oauth2Client.getAccessToken();
    const access = tokenRes?.token || saved.access_token || '';
    let live = await tokeninfoScopeForAccessToken(access);
    if (live) {
      syncCredentialsScope(live);
      return live;
    }
    try {
      const refreshed = await oauth2Client.refreshAccessToken();
      if (refreshed?.credentials) {
        const merged = mergeGoogleTokens(oauth2Client.credentials || saved, refreshed.credentials);
        oauth2Client.setCredentials(merged);
        bindOAuthTokenPersistence(oauth2Client);
        live = await tokeninfoScopeForAccessToken(merged.access_token);
        if (live) {
          syncCredentialsScope(live);
          return live;
        }
      }
    } catch (_) {}
  } catch (_) {}
  return saved.scope || oauth2Client?.credentials?.scope || readTokensFromDisk()?.scope || '';
}

function finishOAuthHttpServer() {
  if (oauthFlowTimer) {
    clearTimeout(oauthFlowTimer);
    oauthFlowTimer = null;
  }
  if (!oauthHttpServer) return;
  try { oauthHttpServer.close(); } catch (_) {}
  oauthHttpServer = null;
}

function runGoogleOAuthFlow(scopes, {
  forceConsent,
  includeGrantedScopes = true,
  allowOnlyBase = false
} = {}) {
  const hadRefresh = !!readTokensFromDisk()?.refresh_token;
  const useConsent = forceConsent === true || (forceConsent !== false && !hadRefresh);
  let scopeList = [...new Set((scopes || []).map(s => String(s || '').trim()).filter(Boolean))];
  if (allowOnlyBase) {
    const baseSet = new Set(GOOGLE_BASE_SCOPES);
    scopeList = scopeList.filter(s => baseSet.has(s));
    if (!scopeList.length) scopeList = [...GOOGLE_BASE_SCOPES];
  }
  return new Promise((resolve) => {
    finishOAuthHttpServer();
    const google = getGoogle();
    const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: useConsent ? 'consent' : 'select_account',
      include_granted_scopes: includeGrantedScopes !== false,
      scope: scopeList
    });
    console.log('[OAuth] 請求 scopes:', scopeList.join(' | '), '| include_granted=', includeGrantedScopes !== false, '| consent=', useConsent);
    const settle = (result) => {
      finishOAuthHttpServer();
      resolve(result);
    };
    oauthFlowTimer = setTimeout(() => {
      settle({ success: false, error: '授權逾時。請關閉瀏覽器授權頁後再試。' });
    }, OAUTH_FLOW_TIMEOUT_MS);
    oauthHttpServer = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/oauth2callback')) return;
      const q = new URL(req.url, `http://localhost:${OAUTH_CALLBACK_PORT}`).searchParams;
      const denied = q.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (denied) {
        res.end('<h1>授權取消</h1><p>請回到 APP 再試一次。</p>');
        settle({ success: false, error: '授權被取消' });
        return;
      }
      res.end('<h1>授權成功！</h1><p>請關閉網頁，回到 APP。</p><script>window.close()</script>');
      try {
        const { tokens } = await client.getToken(q.get('code'));
        const hadPrev = fs.existsSync(tokenPath());
        let merged;
        if (hadPrev) {
          try {
            const prev = JSON.parse(fs.readFileSync(tokenPath(), 'utf8'));
            merged = prev?.refresh_token ? mergeGoogleTokens(prev, tokens) : { ...tokens };
          } catch (_) {
            merged = { ...tokens };
          }
        } else {
          merged = { ...tokens };
        }
        if (!merged.refresh_token && tokens.refresh_token) merged.refresh_token = tokens.refresh_token;
        merged = await finalizeOAuthCredentials(client, merged);
        try {
          // [Important] ADR 0006：OAuth 成功不直接開背景；等 Active Feature List
          reconcileActiveFeatureBackgrounds().catch(() => {});
        } catch (_) {}
        sessionState.authed = true;
        sessionState.offline = false;
        settle({ success: true, scope: merged.scope || tokens.scope || '', firstAuth: !hadPrev });
      } catch (err) {
        settle({ success: false, error: err.message || '授權換取 Token 失敗' });
      }
    });
    oauthHttpServer.on('error', (err) => {
      finishOAuthHttpServer();
      settle({
        success: false,
        error: err.code === 'EADDRINUSE'
          ? '授權埠 3000 被占用。請關閉其他授權視窗或占用該埠的程式後再試。'
          : err.message
      });
    });
    oauthHttpServer.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => { shell.openExternal(authUrl); });
  });
}

/** [Important] 佇列化 OAuth，避免多次授權同時占用 3000 */
function runGoogleOAuth(scopes, options = {}) {
  const job = () => runGoogleOAuthFlow(scopes, options);
  const chained = oauthFlowChain.then(job, job);
  oauthFlowChain = chained.catch(() => {});
  return chained;
}

ipcMain.handle('auth-google', async () => {
  try {
    return await runFeaturesOAuth(allFeatureTypes());
  } catch (err) { return { success: false, error: err.message }; }
});

/** [Important] Reconnect：不刪 Credential，強制 consent 重拿 token（ADR 0002） */
ipcMain.handle('reconnect-google', async () => {
  try {
    clearOAuthClientMemory();
    const res = await runFeaturesOAuth(allFeatureTypes(), {
      forceReauth: true,
      forceConsent: true,
      cleanReauth: false
    });
    if (res?.success) {
      setSessionAuthStatus(AUTH_STATUS.AUTHENTICATED);
      broadcastSessionStatus();
    }
    return res;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('credential-probe', async () => {
  try {
    return { success: true, credentialProbe: buildCredentialProbe() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function scopesForFeatureTypes(types) {
  const seen = new Set();
  const scopes = [];
  for (const raw of types || []) {
    for (const s of featureScopes(String(raw || '').trim())) {
      if (!seen.has(s)) {
        seen.add(s);
        scopes.push(s);
      }
    }
  }
  return scopes;
}

function isFeatureAuthorized(type, scopeText, fallbackScope = '') {
  const needed = featureScopes(type);
  if (!needed.length) return true;
  const live = String(scopeText || '');
  if (scopeListHas(live, needed) || scopeListHas(fallbackScope, needed)) return true;
  return false;
}

/** 僅清記憶體 OAuth 狀態；不刪除 google_token.json（登出請用 logout IPC） */
function resetOAuthTokensOnly() {
  clearOAuthClientMemory();
  setSessionAuthStatus(AUTH_STATUS.AUTH_REQUIRED);
}

function scopesNeededForFeatures(types) {
  const seen = new Set();
  const scopes = [];
  const add = (s) => {
    const v = String(s || '').trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      scopes.push(v);
    }
  };
  for (const s of GOOGLE_BASE_SCOPES) add(s);
  for (const raw of types || []) {
    const key = String(raw || '').trim();
    for (const s of featureScopes(key)) add(s);
    // Full Login／授權 gchat 時一併請求 Extended；gate 仍只驗 Core
    if (key === 'gchat') {
      for (const s of GCHAT_EXTENDED_SCOPES) add(s);
    }
  }
  return scopes;
}

function afterFeaturesOAuth(featureList) {
  if (!Array.isArray(featureList) || !featureList.length) return;
  setTimeout(() => {
    syncAuthorizedFeatures(featureList).catch((err) => {
      console.warn('[Sync] 功能同步失敗:', err.message);
    });
  }, 0);
}

function messageHasDisplayContent(m) {
  if (!m) return false;
  const t = String(m.text || m.cardText || m.snippet || '').trim();
  if (t && t !== '（無文字）' && t !== '开始对话' && t !== '開始對話') return true;
  if (m.media?.length) return true;
  const q = m.quoted;
  if (q && (q.text || q.textHtml || q.media?.length || q.name)) return true;
  return false;
}

function shouldRefreshGchatPacket(cached, listHit) {
  if (isChatApiQuotaBlocked()) return false;
  // [Important] 今日已讀不走 API 重撈歷史，只用本機暫存
  if (listHit?.isRead === true) return false;
  if (!cached?.historyReady || !Array.isArray(cached.thread)) return true;
  if (!cached.thread.length) return true;
  if (listHit?.createTime && cached.detail?.createTime
    && String(listHit.createTime) > String(cached.detail.createTime)) {
    return true;
  }
  const detailName = listHit?.name || cached.detail?.name;
  if (detailName) {
    const hit = cached.thread.find((m) => m.name === detailName) || cached.detail;
    if (hit && !messageHasDisplayContent(hit)) return true;
  }
  if (cached.thread.every((m) => !messageHasDisplayContent(m))) return true;
  return false;
}

async function syncAuthorizedFeatures(types) {
  const scope = await grantedScopeText();
  const ordered = [
    ...FEATURE_SYNC_PRIORITY.filter((t) => types.includes(t)),
    ...types.filter((t) => !FEATURE_SYNC_PRIORITY.includes(t))
  ];
  for (const type of ordered) {
    // [Important] ADR 0006：未 Active 的功能不跑背景／tick
    if (!isFeatureActive(type)) continue;
    if (!isFeatureAuthorized(type, scope)) continue;
    try {
      if (type === 'gchat') {
        if (!oauth2Client || !chatService || !hasChatScopes(scope)) continue;
        await bootstrapGchatAuthCache({ force: true });
        startGchatSyncScheduler();
        await ensureGchatSyncStack().syncService.syncUnreadInbox().catch((err) => {
          console.warn('[GChat] 初始 inbox 同步失敗:', err.message);
        });
      } else if (type === 'gmail') {
        if (!scopeListHas(scope, FEATURE_SCOPE_MAP.gmail)) continue;
        if (!syncTimer) startSyncLoop();
        else await runSync();
      } else if (type === 'calendar') {
        startMeetingWatch();
        if (win && !win.isDestroyed()) {
          win.webContents.send('feature-sync-tick', type);
        }
      } else if (win && !win.isDestroyed()) {
        win.webContents.send('feature-sync-tick', type);
      }
    } catch (err) {
      console.warn('[Sync]', type, err.message);
    }
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('features-synced', { types: ordered.filter((t) => isFeatureActive(t)) });
  }
}

async function runFeaturesOAuth(types, { cleanReauth = false, forceReauth = false, forceConsent = false } = {}) {
  const featureList = [...new Set(
    (types || []).map((t) => String(t || '').trim()).filter((t) => FEATURE_SCOPE_MAP[t])
  )];
  if (!featureList.length) featureList.push(...allFeatureTypes());

  const neededScopes = scopesNeededForFeatures(featureList);

  const finishSuccess = async (resultScope = '') => {
    const scope = resultScope || await grantedScopeText();
    const toSync = allFeatureTypes().filter((t) => isFeatureAuthorized(t, scope));
    afterFeaturesOAuth(toSync.length ? toSync : featureList);
    setSessionAuthStatus(AUTH_STATUS.AUTHENTICATED);
    return {
      success: true,
      types: featureList,
      authorized: true,
      scope,
      authStatus: AUTH_STATUS.AUTHENTICATED,
      labels: featureList.map((t) => FEATURE_LABELS[t] || t),
      cleanReauth,
      forceReauth
    };
  };

  const failUnauthorized = async (stillMissing = []) => {
    const scope = await grantedScopeText();
    const unauthorized = featureList.filter((t) => !isFeatureAuthorized(t, scope));
    const names = unauthorized.map((t) => FEATURE_LABELS[t] || t).join('、');
    if (unauthorized.includes('gchat')) {
      return {
        success: false,
        needsApi: true,
        setupUrl: chatApiEnableUrl(),
        error: 'Google 沒有核發 Chat 權限。請到 Google Cloud 啟用 Google Chat API，並在「OAuth 同意畫面」加入 Chat 範圍後再授權。'
      };
    }
    if (unauthorized.includes('sheets')) {
      return {
        success: false,
        needsApi: true,
        error: 'Google 沒有核發試算表權限。請到 Google Cloud 啟用 Google Sheets API，並在「OAuth 同意畫面」加入試算表範圍後再授權。'
      };
    }
    const scopeHint = stillMissing.length ? `（仍缺 ${stillMissing.length} 項權限）` : '';
    return {
      success: false,
      needsAuth: true,
      featureScopeMissing: true,
      authStatus: AUTH_STATUS.FEATURE_SCOPE_MISSING,
      error: `尚未取得「${names}」所需權限${scopeHint}，請在授權頁勾選允許。`
    };
  };

  const runIncrementalOAuth = async (scopeList) => {
    const hadRefresh = !!readTokensFromDisk()?.refresh_token;
    const useConsent = forceConsent || !hadRefresh;
    console.log('[OAuth] 增量授權 scopes:', scopeList.length, '| consent:', useConsent);
  // [TODO] Phase 2: Extract incremental scope authorization into GoogleAuthorizationService
    return runGoogleOAuth(scopeList, {
      forceConsent: useConsent,
      includeGrantedScopes: true,
      allowOnlyBase: false
    });
  };

  const tokens = readTokensFromDisk();

  if (tokens && !forceReauth && !cleanReauth) {
    try {
      const scopeNow = await grantedScopeText();
      const unauthorized = featureList.filter((t) => !isFeatureAuthorized(t, scopeNow));
      const missing = await scopesMissingFromToken(neededScopes);
      if (!missing.length && !unauthorized.length) {
        return await finishSuccess();
      }
    } catch (_) {}
  }

  let scopesToRequest = neededScopes;
  if (tokens) {
    const missing = await scopesMissingFromToken(neededScopes);
    if (missing.length) {
      const seen = new Set();
      scopesToRequest = [];
      for (const s of [...GOOGLE_BASE_SCOPES, ...missing]) {
        const v = String(s || '').trim();
        if (v && !seen.has(v)) {
          seen.add(v);
          scopesToRequest.push(v);
        }
      }
    }
  }

  console.log(
    '[OAuth] 功能授權',
    '| 功能:', featureList.join(', '),
    '| 請求 scopes:', scopesToRequest.length,
    '| forceReauth:', forceReauth,
    '| cleanReauth:', cleanReauth
  );

  const result = await runIncrementalOAuth(scopesToRequest);
  if (!result.success) return result;

  const stillMissing = await scopesMissingFromToken(neededScopes);
  const scopeAfter = await grantedScopeText();
  const stillUnauthorized = featureList.filter((t) => !isFeatureAuthorized(t, scopeAfter, result.scope));

  // [Important] Extended scopes 可缺，不擋功能 gate 成功（ADR 0003）
  if (stillUnauthorized.length) {
    console.warn(
      '[OAuth] 授權後功能未就緒',
      '| 缺 scope:', stillMissing.length,
      '| 未授權:', stillUnauthorized.map((t) => FEATURE_LABELS[t] || t).join('、')
    );
    return await failUnauthorized(stillMissing);
  }
  if (stillMissing.length) {
    console.warn('[OAuth] 授權後仍缺延伸 scope（不擋主功能）:', stillMissing.length);
  }
  return await finishSuccess(result.scope);
}

async function runFeatureOAuth(feature) {
  return runFeaturesOAuth([feature]);
}

ipcMain.handle('auth-google-feature', async (_event, type) => {
  try {
    return await runFeatureOAuth(type);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('auth-google-features', async (_event, payload) => {
  try {
    const types = Array.isArray(payload) ? payload : (payload?.types || []);
    const cleanReauth = !Array.isArray(payload) && payload?.cleanReauth === true;
    const forceReauth = !Array.isArray(payload) && payload?.forceReauth === true;
    return await runFeaturesOAuth(types, { cleanReauth, forceReauth });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('feature-auth-status', async (_event, type) => {
  try {
    return await getFeatureAuthStatus(String(type || ''));
  } catch (err) {
    return { success: false, authorized: false, error: err.message };
  }
});

ipcMain.handle('auth-google-sheets', async () => {
  try {
    const result = await runFeatureOAuth('sheets');
    if (!result.success) return result;
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('auth-google-chat', async () => {
  try {
    const result = await runFeatureOAuth('gchat');
    if (!result.success) return result;
    // ADR 0006：由 Active Feature／syncAuthorizedFeatures 決定是否開 scheduler
    await reconcileActiveFeatureBackgrounds();
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

function sheetsConfigPath() { return path.join(app.getPath('userData'), 'sheets.json'); }
function sheetsStatePath() { return path.join(app.getPath('userData'), 'sheets-state.json'); }

/** 特規綁死：只讀 9527 試算表 */
const SHEETS_9527_ID = '1wYWAqZQbYOp5M7xWPt63rQo3cAODKliN3X9PAyxxUBo';
const SHEETS_9527_SOURCE = {
  id: 'builtin-9527',
  name: '9527',
  spreadsheetId: SHEETS_9527_ID,
  url: `https://docs.google.com/spreadsheets/d/${SHEETS_9527_ID}/edit`,
  gid: ''
};

function getBuiltin9527Source() {
  const cfg = loadSheetsConfig();
  const prev = (cfg.sources || []).find(s =>
    s.id === 'builtin-9527' || s.spreadsheetId === SHEETS_9527_ID || /9527/.test(String(s.name || ''))
  );
  return {
    ...SHEETS_9527_SOURCE,
    gid: prev?.gid != null && prev.gid !== '' ? String(prev.gid) : '',
    url: prev?.url || SHEETS_9527_SOURCE.url
  };
}

const SHEET_STATUS_HEADER = /處理進度|處理狀態|處理狀況|^狀態$|^進度$|status|processed/i;
const SHEET_TIME_HEADER = /時間戳記|timestamp|提交時間|建立時間|來電日|^時間$|^日期$/i;
const SHEET_TITLE_HEADERS = ['問題內容', '問題類型', '通報問題單位'];
const SHEET_SKIP_TITLE = /值班人員|電話來源|負責|分機|自動帶入|^處$|處理進度|狀態/;
const SHEET_STATUS_COL_L = 11;
const SHEET_NOTE_COL_M = 12;
const SHEET_TYPE_COL_H = 7;
const SHEET_UNIT_COL_J = 9;
/** 有實質內容才撈取：C–G、L（避開僅預填的空列） */
const SHEET_CONTENT_COLS = [2, 3, 4, 5, 6, 11];
const SHEET_STATUS_VALUES = ['新建立', '已分派', '處理中', '待確認', '已完成', '暫緩'];

function loadSheetsConfig() {
  try {
    if (fs.existsSync(sheetsConfigPath())) {
      const data = JSON.parse(fs.readFileSync(sheetsConfigPath(), 'utf8'));
      return { sources: Array.isArray(data.sources) ? data.sources : [] };
    }
  } catch (_) {}
  return { sources: [] };
}

function saveSheetsConfig(cfg) {
  fs.writeFileSync(sheetsConfigPath(), JSON.stringify({ sources: cfg.sources || [] }, null, 2));
}

function loadSheetsState() {
  try {
    if (fs.existsSync(sheetsStatePath())) {
      const data = JSON.parse(fs.readFileSync(sheetsStatePath(), 'utf8'));
      return {
        cursors: data.cursors && typeof data.cursors === 'object' ? data.cursors : {},
        done: Array.isArray(data.done) ? data.done : []
      };
    }
  } catch (_) {}
  return { cursors: {}, done: [] };
}

function saveSheetsState(state) {
  fs.writeFileSync(sheetsStatePath(), JSON.stringify({
    cursors: state.cursors || {},
    done: state.done || []
  }, null, 2));
}

function parseSpreadsheetRef(input) {
  const text = String(input || '').trim();
  const idMatch = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || text.match(/^([a-zA-Z0-9-_]{30,})$/);
  const gidMatch = text.match(/[?&#]gid=([0-9]+)/);
  return {
    spreadsheetId: idMatch ? idMatch[1] : '',
    gid: gidMatch ? gidMatch[1] : ''
  };
}

function quoteSheetRange(sheetName, a1) {
  const safe = String(sheetName || '').replace(/'/g, "''");
  return `'${safe}'!${a1}`;
}

function colLetter(index) {
  let n = Number(index) + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function googleErrText(err) {
  const data = err?.response?.data?.error;
  if (typeof data === 'string') return data;
  return data?.message || err?.errors?.[0]?.message || err?.message || String(err || '');
}

/** Google 端暫時故障／限流（非本機設定問題） */
function isChatQuotaError(err) {
  const status = Number(err?.code || err?.status || err?.response?.status || 0);
  const msg = googleErrText(err);
  return status === 429 || /RESOURCE_EXHAUSTED|Resource has been exhausted|exceeded the API quota/i.test(msg);
}

function clearChatApiQuotaBlockedIfExpired() {
  if (chatApiQuotaBlockedUntil && Date.now() >= chatApiQuotaBlockedUntil) {
    chatApiQuotaBlockedUntil = 0;
    chatApiQuotaLogged = false;
  }
}

function isChatApiQuotaBlocked() {
  clearChatApiQuotaBlockedIfExpired();
  return chatApiQuotaBlockedUntil > 0 && Date.now() < chatApiQuotaBlockedUntil;
}

function markChatApiQuotaBlocked(err, kind = 'Chat API') {
  // 已讀同步不應封鎖整體 Chat API，否則待同步已讀永遠無法重試
  if (/已讀|readState|ReadState|標已讀|markRead|媒體下載|自訂表情/i.test(String(kind || ''))) return;
  chatApiQuotaBlockedUntil = Date.now() + CHAT_API_QUOTA_BACKOFF_MS;
  if (!chatApiQuotaLogged) {
    chatApiQuotaLogged = true;
    console.warn(
      `[Chat] ${kind}（API 配額已滿，已改用本機暫存，約 ${Math.round(CHAT_API_QUOTA_BACKOFF_MS / 60000)} 分鐘後再試）:`,
      googleErrText(err)
    );
  }
  try { saveGchatDisk(); } catch (_) {}
}

function chatApiQuotaStatus() {
  clearChatApiQuotaBlockedIfExpired();
  return {
    quotaBlocked: isChatApiQuotaBlocked(),
    quotaBlockedUntil: chatApiQuotaBlockedUntil || 0
  };
}

function isTransientGoogleError(err) {
  const status = Number(err?.code || err?.status || err?.response?.status || 0);
  const msg = googleErrText(err);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /Internal error|UNAVAILABLE|Deadline exceeded|Try again|Retry the request|rate.?limit|RESOURCE_EXHAUSTED|backendError/i.test(msg);
}

async function withTransientRetry(fn, { tries = 3, baseMs = 450 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientGoogleError(err) || isChatQuotaError(err) || i === tries - 1) throw err;
      await new Promise(r => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw lastErr;
}

function logGchatApiIssue(kind, err) {
  const msg = googleErrText(err);
  const blob = `${err?.code || ''} ${msg}`;
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication|insufficient.?permission|Request had insufficient/i.test(blob)) {
    console.warn(`[Chat] ${kind}:`, msg, '（功能 scope 不足，請在 Little Reply 補充授權）');
    return;
  }
  if (isCustomEmojiQuotaError(err)) {
    if (!customEmojiQuotaLogged) {
      customEmojiQuotaLogged = true;
      console.warn(`[Chat] ${kind}（API 配額已滿，已停止重試，約 12 小時後再試）:`, msg);
    }
    return;
  }
  if (isChatQuotaError(err)) {
    markChatApiQuotaBlocked(err, kind);
    return;
  }
  if (isTransientGoogleError(err)) {
    // 暫時故障：降噪，避免 CMD 一直紅字嚇到人
    console.warn(`[Chat] ${kind}（Google 暫時忙碌，稍後自動再試）:`, msg);
    return;
  }
  console.warn(`[Chat] ${kind}:`, msg);
}

function explainSheetsError(err) {
  const status = err?.code || err?.status || err?.response?.status;
  const msg = googleErrText(err);
  const blob = `${status || ''} ${msg}`;
  const apiDisabled = /has not been used|is disabled|access not configured|API has not been/i.test(blob);
  // [Important] Drive／Sheets 停用訊息很像，依關鍵字分開，避免已啟用 Sheets 仍被誤導
  if (apiDisabled && /drive|Drive/i.test(blob)) {
    return {
      needsApi: true,
      needsDriveApi: true,
      setupUrl: driveApiEnableUrl(),
      error: `Google Cloud 專案尚未啟用 Google Drive API（上傳截圖需要）。專案 ${GOOGLE_PROJECT_NUMBER}：請按「啟用／ENABLE」，約一分鐘後再送出回報。`
    };
  }
  if (apiDisabled) {
    return {
      needsApi: true,
      needsSheetsApi: true,
      setupUrl: sheetsApiEnableUrl(),
      error: `Google Cloud 專案尚未啟用 Google Sheets API。專案 ${GOOGLE_PROJECT_NUMBER}：請按「啟用／ENABLE」，等約一分鐘後再試。若已啟用，請改按「重新授權 Google 試算表」（並確認 OAuth 同意畫面有試算表／雲端硬碟範圍）。`
    };
  }
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication|insufficient.?permission|Request had insufficient/i.test(blob)) {
    return {
      featureScopeMissing: true,
      needsAuth: true,
      authStatus: AUTH_STATUS.FEATURE_SCOPE_MISSING,
      error: '目前登入權限不足（試算表或雲端硬碟）。請補充授權。'
    };
  }
  if (status === 404 || /Requested entity was not found|Unable to parse range/i.test(blob)) {
    return { error: '找不到這份試算表或工作表。請確認網址正確，且目前帳號可以開啟。' };
  }
  if (status === 403) {
    return {
      error: '沒有這份試算表的權限。請把回報用試算表分享給目前登入的 Google 帳號（至少編輯者），或重新授權後再試。'
    };
  }
  if (status === 401) {
    return {
      authRevoked: true,
      authStatus: AUTH_STATUS.AUTH_REVOKED,
      error: '登入已過期，請重新連結 Google 帳號。'
    };
  }
  return { error: msg };
}

function sheetsRowKey(spreadsheetId, sheetName, rowNumber) {
  return `${spreadsheetId}:${sheetName}:${rowNumber}`;
}

function findHeaderRowIndex(rows) {
  const max = Math.min(rows.length, 12);
  for (let i = 0; i < max; i++) {
    const headers = (rows[i] || []).map(h => String(h || '').replace(/\s+/g, '').trim());
    if (headers.some(h => /處理進度|問題內容/.test(h))) return i;
  }
  return -1;
}

function normalizeSheetCell(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function padSheetRow(row, len) {
  const next = (row || []).map(normalizeSheetCell);
  while (next.length < len) next.push('');
  return next;
}

function findStatusColumn(headers) {
  const normalized = headers.map(h => String(h || '').replace(/\s+/g, ''));
  const preferred = normalized.findIndex(h => h === '處理進度' || h.includes('處理進度'));
  if (preferred >= 0) return preferred;
  const byName = normalized.findIndex(h => SHEET_STATUS_HEADER.test(h));
  if (byName >= 0) return byName;
  return SHEET_STATUS_COL_L;
}

function lookupStatus(headers, values) {
  const padded = padSheetRow(values, Math.max(headers.length, SHEET_STATUS_COL_L + 1));
  const idx = findStatusColumn(headers);
  const fromCol = normalizeSheetCell(padded[idx]);
  if (SHEET_STATUS_VALUES.includes(fromCol)) return fromCol;
  const fromL = normalizeSheetCell(padded[SHEET_STATUS_COL_L]);
  if (SHEET_STATUS_VALUES.includes(fromL)) return fromL;
  return fromCol || fromL;
}

function findNoteColumn(headers) {
  const normalized = headers.map(h => String(h || '').replace(/\s+/g, ''));
  const idx = normalized.findIndex(h => h === '備註' || h.includes('備註') || /說明|處理紀錄/.test(h));
  return idx >= 0 ? idx : SHEET_NOTE_COL_M;
}

function lookupNote(headers, values) {
  const padded = padSheetRow(values, Math.max(headers.length, SHEET_NOTE_COL_M + 1));
  return padded[findNoteColumn(headers)] || '';
}

function findHeaderColumn(headers, ...names) {
  const normalized = headers.map(h => String(h || '').replace(/\s+/g, ''));
  for (const name of names) {
    const key = String(name || '').replace(/\s+/g, '');
    if (!key) continue;
    const exact = normalized.findIndex(h => h === key);
    if (exact >= 0) return exact;
    // 短關鍵字（如「處」）避免誤配「處理進度」
    if (key.length <= 2) {
      const tight = normalized.findIndex(h =>
        h === key || h.startsWith(`${key}(`) || h.startsWith(`${key}（`)
      );
      if (tight >= 0) return tight;
      continue;
    }
    const soft = normalized.findIndex(h => h.includes(key));
    if (soft >= 0) return soft;
  }
  return -1;
}

function lookupIssueType(headers, values) {
  const padded = padSheetRow(values, Math.max(headers.length, SHEET_TYPE_COL_H + 1));
  const idx = findHeaderColumn(headers, '問題類型');
  return normalizeSheetCell(padded[idx >= 0 ? idx : SHEET_TYPE_COL_H]);
}

function lookupUnit(headers, values) {
  const padded = padSheetRow(values, Math.max(headers.length, SHEET_UNIT_COL_J + 1));
  const idx = findHeaderColumn(headers, '負責單位');
  return normalizeSheetCell(padded[idx >= 0 ? idx : SHEET_UNIT_COL_J]);
}

/** 僅當 C–G 或 L 有內容才視為有效資料列 */
function sheetRowHasContent(values) {
  const padded = padSheetRow(values, SHEET_STATUS_COL_L + 1);
  return SHEET_CONTENT_COLS.some(idx => normalizeSheetCell(padded[idx]));
}

function isSheetRowDone(status) {
  return normalizeSheetCell(status) === '已完成';
}

function sheetDoneWriteValue(header) {
  return /進度/.test(header || '') ? '已完成' : '已處理';
}

function pickSheetTitle(headers, values) {
  for (const name of SHEET_TITLE_HEADERS) {
    const idx = headers.findIndex(h => (h || '').includes(name));
    if (idx >= 0) {
      const text = String(values[idx] || '').trim();
      if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
  }
  for (let i = 0; i < headers.length; i++) {
    if (SHEET_TIME_HEADER.test(headers[i] || '')) continue;
    if (SHEET_SKIP_TITLE.test(headers[i] || '')) continue;
    const text = String(values[i] || '').trim();
    if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }
  return values.find(v => String(v || '').trim()) || '空白列';
}

function pickSheetTime(headers, values) {
  const idx = headers.findIndex(h => SHEET_TIME_HEADER.test(h || ''));
  return idx >= 0 ? String(values[idx] || '').trim() : '';
}

function isReportSheet(name) {
  return /分析|報表|統計|彙總|dashboard|report/i.test(String(name || ''));
}

function isMonthlyDataSheet(name) {
  const n = String(name || '').replace(/\s+/g, '');
  if (!n || isReportSheet(n)) return false;
  return /^(20\d{2}年)?(0?[1-9]|1[0-2])月(份)?$/.test(n);
}

function monthNumberFromSheetName(name) {
  const m = String(name || '').replace(/\s+/g, '').match(/(0?[1-9]|1[0-2])月/);
  return m ? Number(m[1]) : 0;
}

function pickDataTabs(tabs) {
  const monthly = (tabs || []).filter(t => isMonthlyDataSheet(t.sheetName));
  if (monthly.length) {
    return monthly.sort((a, b) => monthNumberFromSheetName(b.sheetName) - monthNumberFromSheetName(a.sheetName));
  }
  return (tabs || []).filter(t => !isReportSheet(t.sheetName));
}

async function listSheetTabs(spreadsheetId) {
  const meta = await withGoogleApiRetry(() => sheetsService.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties'
  }));
  return {
    title: meta.data.properties?.title || '未命名試算表',
    tabs: (meta.data.sheets || [])
      .map(s => ({
        sheetName: s.properties?.title || '',
        sheetId: s.properties?.sheetId ?? 0
      }))
      .filter(t => t.sheetName)
  };
}

async function resolveSheetTab(spreadsheetId, gid) {
  const { title, tabs } = await listSheetTabs(spreadsheetId);
  const wanted = gid === '' || gid == null ? null : Number(gid);
  const match = wanted == null
    ? tabs[0]
    : tabs.find(t => Number(t.sheetId) === wanted) || tabs[0];
  return {
    title,
    sheetName: match?.sheetName || '工作表1',
    sheetId: match?.sheetId ?? 0,
    tabs
  };
}

function parseSheetRows(rows, source, tab, state) {
  const headerIdx = findHeaderRowIndex(rows);
  if (headerIdx < 0) {
    return { items: [], pending: 0, newest: 0 };
  }
  const headers = padSheetRow(rows[headerIdx], Math.max((rows[headerIdx] || []).length, SHEET_NOTE_COL_M + 1));
  if (!headers[SHEET_STATUS_COL_L]) headers[SHEET_STATUS_COL_L] = '處理進度';
  if (!headers[SHEET_NOTE_COL_M]) headers[SHEET_NOTE_COL_M] = '備註';
  const statusIdx = findStatusColumn(headers);
  const noteIdx = findNoteColumn(headers);
  const statusHeader = statusIdx >= 0 ? headers[statusIdx] : '';
  const prevMax = Number(state.cursors[source.id]?.maxRow || 0);
  const items = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const values = padSheetRow(rows[i], Math.max(headers.length, SHEET_NOTE_COL_M + 1));
    if (!sheetRowHasContent(values)) continue;
    const rowNumber = i + 1;
    const status = lookupStatus(headers, values);
    const note = lookupNote(headers, values);
    const issueType = lookupIssueType(headers, values);
    const unit = lookupUnit(headers, values);
    const done = isSheetRowDone(status);
    const fields = headers.map((name, idx) => ({
      name: name || `欄${idx + 1}`,
      value: values[idx] || ''
    })).filter((f, idx) => f.value && idx !== noteIdx);
    items.push({
      key: sheetsRowKey(source.spreadsheetId, tab.sheetName, rowNumber),
      sourceId: source.id,
      sourceName: source.name,
      spreadsheetId: source.spreadsheetId,
      sheetName: tab.sheetName,
      sheetId: tab.sheetId,
      rowNumber,
      title: pickSheetTitle(headers, values),
      time: pickSheetTime(headers, values),
      status,
      issueType,
      unit,
      done,
      isNew: !done && prevMax > 0 && rowNumber > prevMax,
      canWriteStatus: statusIdx >= 0,
      statusColumn: statusIdx >= 0 ? colLetter(statusIdx) : 'L',
      note,
      noteColumn: colLetter(noteIdx),
      doneValue: sheetDoneWriteValue(statusHeader),
      url: `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/edit#gid=${tab.sheetId}&range=A${rowNumber}`,
      fields
    });
  }
  return {
    items,
    pending: items.filter(i => !i.done).length,
    newest: items.filter(i => i.isNew).length
  };
}

async function fetchSheetSource(source, state) {
  const meta = await listSheetTabs(source.spreadsheetId);
  const tabs = pickDataTabs(meta.tabs.length ? meta.tabs : [{ sheetName: '工作表1', sheetId: 0 }]);
  if (!tabs.length) {
    return {
      id: source.id,
      name: source.name,
      spreadsheetId: source.spreadsheetId,
      spreadsheetTitle: meta.title,
      pending: 0,
      newest: 0,
      items: [],
      error: '找不到 1～12 月資料工作表（已略過「分析／報表」頁）'
    };
  }
  const ranges = tabs.map(t => quoteSheetRange(t.sheetName, 'A1:AZ'));
  const res = await withGoogleApiRetry(() => sheetsService.spreadsheets.values.batchGet({
    spreadsheetId: source.spreadsheetId,
    ranges,
    majorDimension: 'ROWS',
    valueRenderOption: 'FORMATTED_VALUE'
  }));
  const valueRanges = res.data.valueRanges || [];
  const usable = tabs.map((tab, idx) => {
    const rows = valueRanges[idx]?.values || [];
    return { tab, rows, parsed: parseSheetRows(rows, source, tab, state) };
  }).filter(entry => findHeaderRowIndex(entry.rows) >= 0);

  if (!usable.length) {
    return {
      id: source.id,
      name: source.name,
      spreadsheetId: source.spreadsheetId,
      spreadsheetTitle: meta.title,
      pending: 0,
      newest: 0,
      items: [],
      error: '找不到 1～12 月資料工作表（已略過「分析／報表」頁）'
    };
  }

  const items = [];
  const seen = new Set();
  for (const entry of usable) {
    for (const item of entry.parsed.items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      items.push(item);
    }
  }
  items.sort((a, b) => {
    const monthDiff = monthNumberFromSheetName(b.sheetName) - monthNumberFromSheetName(a.sheetName);
    if (monthDiff) return monthDiff;
    return (b.rowNumber || 0) - (a.rowNumber || 0);
  });

  const tab = usable[0].tab;
  const maxRow = usable.reduce((m, entry) => Math.max(m, (entry.rows || []).length), 0);
  state.cursors[source.id] = { maxRow: Math.max(Number(state.cursors[source.id]?.maxRow || 0), maxRow) };
  return {
    id: source.id,
    name: source.name,
    spreadsheetId: source.spreadsheetId,
    spreadsheetTitle: meta.title,
    sheetName: tab.sheetName,
    sheetId: tab.sheetId,
    url: `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/edit#gid=${tab.sheetId}`,
    pending: items.filter(i => !i.done).length,
    newest: items.filter(i => i.isNew).length,
    items
  };
}

ipcMain.handle('sheets-open-setup', async (_event, payload) => {
  const kind = String(payload?.kind || payload || 'sheets').toLowerCase();
  const url = kind === 'drive' ? driveApiEnableUrl() : sheetsApiEnableUrl();
  await shell.openExternal(url);
  return { success: true, url };
});

/** —— Bug／優化回報（固定寫入開發者 Google Sheet）—— */
// [Manual] 開發者統一回報表（勿改成使用者個資試算表）
const BUG_REPORT_SPREADSHEET_ID = '1TlTrqJC5cFBg6cI6beTZubCcoUY1hF3FJd-x2TJiePU';
const BUG_REPORT_SHEET_GID = 1106117164;
const BUG_REPORT_SHEET_NAME_FALLBACK = '問題回報';
const BUG_REPORT_HEADERS = ['時間', '分類', '功能', '內容', '回報者', 'Email', '狀態', '回覆', 'App版本', '附件1', '附件2', '附件3'];
const BUG_REPORT_MAX_IMAGES = 3;
/** 對應「加入功能」目錄；實際選項只含 dist-features 有開放的 */
const BUG_REPORT_FEATURE_CATALOG = [
  { type: 'calendar', label: '預定行程' },
  { type: 'gmail', label: '未讀郵件' },
  { type: 'gchat', label: 'Little Reply' },
  { type: 'sheets', label: '9527' },
  { type: 'notes', label: '記事' },
  { type: 'sitesVisits', label: '網站瀏覽紀錄' },
  { type: 'chat', label: '詢問機器人' }
];

function getBugReportFeatureOptions() {
  const { widgets } = loadDistFeatures();
  return BUG_REPORT_FEATURE_CATALOG
    .filter(f => widgets[f.type] === true)
    .map(f => f.label);
}

function bugReportSheetUrl() {
  return `https://docs.google.com/spreadsheets/d/${BUG_REPORT_SPREADSHEET_ID}/edit#gid=${BUG_REPORT_SHEET_GID}`;
}

async function ensureMyEmailForBugReport() {
  if (cache.myEmail) return cache.myEmail;
  try {
    if (gmailService) {
      const profile = await gmailService.users.getProfile({ userId: 'me' });
      cache.myEmail = profile.data.emailAddress || '';
    }
  } catch (_) {}
  return cache.myEmail || '';
}

async function resolveBugReportSheet() {
  if (!sheetsService) throw new Error('請先用 Google 登入');
  const scope = await grantedScopeText();
  if (!hasSheetsScope(scope)) {
    const err = new Error('尚未授權 Google 試算表權限');
    err.featureScopeMissing = true;
    err.needsAuth = true;
    throw err;
  }
  const meta = await withGoogleApiRetry(() => sheetsService.spreadsheets.get({
    spreadsheetId: BUG_REPORT_SPREADSHEET_ID,
    fields: 'spreadsheetId,sheets(properties(sheetId,title))'
  }));
  const tabs = meta.data.sheets || [];
  const hit = tabs.find(t => Number(t.properties?.sheetId) === BUG_REPORT_SHEET_GID);
  const sheetName = hit?.properties?.title
    || tabs.find(t => t.properties?.title === BUG_REPORT_SHEET_NAME_FALLBACK)?.properties?.title
    || tabs[0]?.properties?.title
    || BUG_REPORT_SHEET_NAME_FALLBACK;

  // 確認／補齊表頭（舊格式會遷移；並確保有附件欄）
  try {
    const head = await sheetsService.spreadsheets.values.get({
      spreadsheetId: BUG_REPORT_SPREADSHEET_ID,
      range: quoteSheetRange(sheetName, 'A:L')
    });
    const rows = head.data.values || [];
    const row0 = rows[0] || [];
    const hasFeatureReply = row0.includes('功能') && row0.includes('回覆');
    const hasAttach = row0.includes('附件1');
    const hasOld = String(row0[0] || '') === '時間' && String(row0[2] || '') === '內容' && !row0.includes('功能');
    if (!row0.length || String(row0[0] || '') !== '時間') {
      await sheetsService.spreadsheets.values.update({
        spreadsheetId: BUG_REPORT_SPREADSHEET_ID,
        range: quoteSheetRange(sheetName, 'A1:L1'),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [BUG_REPORT_HEADERS] }
      });
    } else if (hasOld && !hasFeatureReply) {
      const migrated = [BUG_REPORT_HEADERS];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] || [];
        migrated.push([
          r[0] || '', r[1] || '', '', r[2] || '', r[3] || '', r[4] || '', r[5] || '待處理', '', r[6] || '', '', '', ''
        ]);
      }
      await sheetsService.spreadsheets.values.clear({
        spreadsheetId: BUG_REPORT_SPREADSHEET_ID,
        range: quoteSheetRange(sheetName, 'A:L')
      });
      await sheetsService.spreadsheets.values.update({
        spreadsheetId: BUG_REPORT_SPREADSHEET_ID,
        range: quoteSheetRange(sheetName, 'A1'),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: migrated }
      });
    } else if (!hasAttach || !hasFeatureReply) {
      // 只更新表頭列，保留既有資料
      await sheetsService.spreadsheets.values.update({
        spreadsheetId: BUG_REPORT_SPREADSHEET_ID,
        range: quoteSheetRange(sheetName, 'A1:L1'),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [BUG_REPORT_HEADERS] }
      });
    }
  } catch (err) {
    const explained = explainSheetsError(err);
    if (explained.needsApi || explained.authRevoked || explained.featureScopeMissing || explained.needsAuth) {
      throw Object.assign(new Error(explained.error), explained);
    }
    throw err;
  }

  return { spreadsheetId: BUG_REPORT_SPREADSHEET_ID, sheetName };
}

function mapBugReportHeader(headerRow) {
  const row = headerRow || [];
  const idx = {};
  row.forEach((h, i) => {
    const key = String(h || '').trim();
    if (key) idx[key] = i;
  });
  if (idx['功能'] != null || idx['回覆'] != null || idx['附件1'] != null) {
    return {
      time: idx['時間'] ?? 0,
      category: idx['分類'] ?? 1,
      feature: idx['功能'] ?? -1,
      message: idx['內容'] ?? 3,
      reporter: idx['回報者'] ?? 4,
      email: idx['Email'] ?? idx['email'] ?? 5,
      status: idx['狀態'] ?? 6,
      reply: idx['回覆'] ?? -1,
      version: idx['App版本'] ?? 8,
      attach1: idx['附件1'] ?? 9,
      attach2: idx['附件2'] ?? 10,
      attach3: idx['附件3'] ?? 11
    };
  }
  // 舊表：時間 分類 內容 回報者 Email 狀態 App版本
  return {
    time: idx['時間'] ?? 0,
    category: idx['分類'] ?? 1,
    feature: -1,
    message: idx['內容'] ?? 2,
    reporter: idx['回報者'] ?? 3,
    email: idx['Email'] ?? idx['email'] ?? 4,
    status: idx['狀態'] ?? 5,
    reply: -1,
    version: idx['App版本'] ?? 6,
    attach1: -1,
    attach2: -1,
    attach3: -1
  };
}

function extractBugImageUrl(cell) {
  const s = String(cell || '').trim();
  if (!s) return '';
  const m = s.match(/IMAGE\s*\(\s*"([^"]+)"\s*\)/i) || s.match(/IMAGE\s*\(\s*'([^']+)'\s*\)/i);
  if (m) return m[1];
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

async function uploadBugReportImage(img, email) {
  if (!driveService) throw new Error('雲端硬碟服務尚未就緒');
  const scope = await grantedScopeText();
  if (!hasDriveFileScope(scope)) {
    const err = new Error('需要雲端硬碟權限才能上傳截圖，請補充授權');
    err.featureScopeMissing = true;
    err.needsAuth = true;
    throw err;
  }
  const mime = String(img?.mimeType || 'image/png').split(';')[0] || 'image/png';
  const raw = String(img?.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('圖片資料無效');
  if (buf.length > 8 * 1024 * 1024) throw new Error('單張圖片請小於 8MB');
  const safeName = String(img?.name || `lifetour-bug-${Date.now()}.png`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const created = await withGoogleApiRetry(() => driveService.files.create({
    requestBody: { name: safeName, mimeType: mime },
    media: { mimeType: mime, body: Readable.from(buf) },
    fields: 'id'
  }));
  const fileId = created.data?.id;
  if (!fileId) throw new Error('上傳圖片失敗');
  try {
    await driveService.permissions.create({
      fileId,
      requestBody: { type: 'anyone', role: 'reader' }
    });
  } catch (_) {
    const domain = String(email || '').split('@')[1] || '';
    if (domain) {
      try {
        await driveService.permissions.create({
          fileId,
          requestBody: { type: 'domain', role: 'reader', domain }
        });
      } catch (__) {}
    }
  }
  // Sheets IMAGE() 對 googleusercontent 較穩定；同時可在 App 內預覽
  return `https://lh3.googleusercontent.com/d/${fileId}`;
}

function cellAt(row, index) {
  if (index == null || index < 0) return '';
  return normalizeSheetCell(row?.[index]);
}


// ========== 【MODULE: modules/bug-report】Bug 回報 ==========
ipcMain.handle('bug-report-features', async () => ({
  success: true,
  features: getBugReportFeatureOptions()
}));

ipcMain.handle('bug-report-submit', async (_event, payload) => {
  try {
    if (!oauth2Client || !sheetsService) {
      return { success: false, error: '請先用 Google 登入' };
    }
    const category = String(payload?.category || '').trim();
    const feature = String(payload?.feature || '').trim();
    const message = String(payload?.message || '').trim();
    const images = Array.isArray(payload?.images) ? payload.images.slice(0, BUG_REPORT_MAX_IMAGES) : [];
    const allowedFeatures = getBugReportFeatureOptions();
    if (!category || !['Bug', '優化'].includes(category)) {
      return { success: false, error: '請選擇問題分類：Bug 或 優化' };
    }
    if (category === 'Bug' && !feature) {
      return { success: false, error: '請選擇要回報的功能' };
    }
    if (category === 'Bug' && feature && !allowedFeatures.includes(feature)) {
      return { success: false, error: '功能選項無效' };
    }
    if (!message && !images.length) return { success: false, error: '請輸入內容或貼上截圖' };
    if (message.length > 4000) return { success: false, error: '內容太長（上限約 4000 字）' };

    // [Important] 回報寫 Sheet；有截圖還要 Drive。缺 scope 先引導重新授權，勿誤報「未啟用 API」
    const scope = await grantedScopeText();
    const needDrive = images.length > 0;
    if (!hasSheetsScope(scope) || (needDrive && !hasDriveFileScope(scope))) {
      return {
        success: false,
        featureScopeMissing: true,
        needsAuth: true,
        authStatus: AUTH_STATUS.FEATURE_SCOPE_MISSING,
        error: needDrive
          ? '尚未授權「試算表 + 雲端硬碟」權限（上傳截圖需要）。請補充授權後再送出。'
          : '尚未授權 Google 試算表權限。請補充授權後再送出。'
      };
    }

    const cfg = await resolveBugReportSheet();
    const email = await ensureMyEmailForBugReport();
    const reporter = email ? email.split('@')[0] : '使用者';
    const now = new Date().toLocaleString('zh-TW', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    let appVersion = '1.0.0';
    try { appVersion = String(app.getVersion?.() || require(path.join(APP_ROOT, 'package.json')).version || '1.0.0'); } catch (_) {}

    const imageFormulas = ['', '', ''];
    for (let i = 0; i < images.length; i++) {
      try {
        const url = await uploadBugReportImage(images[i], email);
        // Sheets 以 IMAGE 公式顯示圖片
        imageFormulas[i] = `=IMAGE("${url}")`;
      } catch (upErr) {
        if (upErr?.featureScopeMissing || upErr?.needsAuth) throw upErr;
        throw Object.assign(upErr instanceof Error ? upErr : new Error(googleErrText(upErr)), explainSheetsError(upErr));
      }
    }

    const featureCol = category === 'Bug' ? feature : '';
    await withGoogleApiRetry(() => sheetsService.spreadsheets.values.append({
      spreadsheetId: cfg.spreadsheetId,
      range: quoteSheetRange(cfg.sheetName, 'A:L'),
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          now, category, featureCol, message || '（見附件截圖）', reporter, email,
          '待處理', '', appVersion,
          imageFormulas[0], imageFormulas[1], imageFormulas[2]
        ]]
      }
    }));

    return { success: true };
  } catch (err) {
    if (err?.authRevoked) {
      return {
        success: false,
        authRevoked: true,
        needsReconnect: true,
        authStatus: AUTH_STATUS.AUTH_REVOKED,
        error: err.message || 'Google 授權已失效，請重新連結帳號'
      };
    }
    if (err?.needsReauth || err?.featureScopeMissing) {
      return {
        success: false,
        featureScopeMissing: true,
        needsAuth: true,
        authStatus: AUTH_STATUS.FEATURE_SCOPE_MISSING,
        error: err.message || '需要補充 Google 授權（含雲端硬碟）才能上傳截圖'
      };
    }
    const explained = err?.needsApi || err?.needsDriveApi || err?.needsSheetsApi
      ? {
          needsApi: !!err.needsApi,
          needsDriveApi: !!err.needsDriveApi,
          needsSheetsApi: !!err.needsSheetsApi,
          setupUrl: err.setupUrl,
          error: err.message || googleErrText(err)
        }
      : explainSheetsError(err);
    console.warn('[BugReport] 送出失敗:', googleErrText(err));
    return { success: false, ...explained };
  }
});

ipcMain.handle('bug-report-list', async () => {
  try {
    if (!oauth2Client || !sheetsService) {
      return { success: false, error: '請先用 Google 登入' };
    }
    const cfg = await resolveBugReportSheet();
    const myEmail = String(await ensureMyEmailForBugReport() || '').trim().toLowerCase();
    // [Important] FORMULA 才能讀回 =IMAGE("url")，預設值渲染會變成空白
    const res = await sheetsService.spreadsheets.values.get({
      spreadsheetId: cfg.spreadsheetId,
      range: quoteSheetRange(cfg.sheetName, 'A:L'),
      valueRenderOption: 'FORMULA'
    });
    const rows = res.data.values || [];
    const col = mapBugReportHeader(rows[0] || []);
    const items = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const category = cellAt(r, col.category);
      const message = cellAt(r, col.message);
      const attachUrls = [
        extractBugImageUrl(cellAt(r, col.attach1)),
        extractBugImageUrl(cellAt(r, col.attach2)),
        extractBugImageUrl(cellAt(r, col.attach3))
      ].filter(Boolean);
      if (!category && !message && !attachUrls.length) continue;
      const email = cellAt(r, col.email);
      const emailNorm = String(email || '').trim().toLowerCase();
      // 只回傳自己的回報
      if (!myEmail || emailNorm !== myEmail) continue;
      items.push({
        row: i + 1,
        time: cellAt(r, col.time),
        category: category || 'Bug',
        feature: cellAt(r, col.feature),
        message,
        reporter: cellAt(r, col.reporter),
        email,
        status: cellAt(r, col.status) || '待處理',
        reply: cellAt(r, col.reply),
        version: cellAt(r, col.version),
        images: attachUrls
      });
    }
    items.reverse();
    return {
      success: true,
      items,
      features: getBugReportFeatureOptions(),
      pending: items.filter(x => x.status !== '已處理').length,
      // [Development Only] 開發模式才回傳總表連結
      sheetUrl: app.isPackaged ? '' : bugReportSheetUrl(),
      canOpenSheet: !app.isPackaged
    };
  } catch (err) {
    return { success: false, ...explainSheetsError(err) };
  }
});

// 狀態僅開發者在 Sheet 維護；使用者端不再開放改狀態
ipcMain.handle('bug-report-set-status', async () => ({
  success: false,
  error: '狀態由開發者處理，使用者無法變更'
}));

ipcMain.handle('bug-report-open-sheet', async () => {
  // [Development Only] 正式版不開放開啟總表
  if (app.isPackaged) {
    return { success: false, error: '正式版不開放開啟試算表' };
  }
  try {
    const url = bugReportSheetUrl();
    await shell.openExternal(url);
    return { success: true, url };
  } catch (err) {
    return { success: false, error: err.message || '無法開啟試算表' };
  }
});

ipcMain.handle('bug-report-set-sheet', async () => ({
  success: false,
  error: '回報表已固定為開發者試算表，無需自行設定'
}));

ipcMain.handle('sheets-status', async () => {
  try {
    if (!oauth2Client || !sheetsService) {
      return { success: false, error: '請先用 Google 登入' };
    }
    const scope = await grantedScopeText();
    const hasScope = hasSheetsScope(scope);
    try {
      await withGoogleApiRetry(() => sheetsService.spreadsheets.get({
        spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        fields: 'spreadsheetId'
      }));
    } catch (err) {
      const explained = explainSheetsError(err);
      if (explained.needsApi) {
        return { success: true, ready: false, hasScope, ...explained };
      }
    }
    return {
      success: true,
      ready: hasScope,
      hasScope,
      featureScopeMissing: !hasScope,
      needsAuth: !hasScope,
      authStatus: hasScope ? AUTH_STATUS.AUTHENTICATED : AUTH_STATUS.FEATURE_SCOPE_MISSING,
      setupUrl: sheetsApiEnableUrl()
    };
  } catch (err) {
    return { success: false, ...explainSheetsError(err), setupUrl: sheetsApiEnableUrl() };
  }
});

ipcMain.handle('sheets-list-sources', async () => {
  try {
    return { success: true, sources: [getBuiltin9527Source()], locked: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// [Manual] dist 功能開關：專案根目錄 dist-features.json；打勾的才會在正式包出現
const DIST_WIDGET_KEYS = ['calendar', 'gmail', 'gchat', 'sheets', 'notes', 'sitesVisits', 'chat', 'reportExport'];

function distFeaturesPath() {
  return path.join(APP_ROOT, 'dist-features.json');
}

/** 預設關閉；只有 dist-features.json 明確打勾才進正式包（避免漏設就曝光） */
function defaultDistWidgets() {
  return Object.fromEntries(DIST_WIDGET_KEYS.map(k => [k, false]));
}

function loadDistFeatures() {
  const widgets = defaultDistWidgets();
  try {
    const raw = JSON.parse(fs.readFileSync(distFeaturesPath(), 'utf8'));
    const src = raw?.widgets && typeof raw.widgets === 'object' ? raw.widgets : raw;
    for (const key of DIST_WIDGET_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src || {}, key)) {
        widgets[key] = src[key] === true;
      }
    }
  } catch (_) {}
  return { widgets };
}

function saveDistFeatures(widgets) {
  const next = defaultDistWidgets();
  for (const key of DIST_WIDGET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(widgets || {}, key)) {
      next[key] = !!widgets[key];
    }
  }
  const payload = {
    _comment: '[Manual] 加入功能左側打勾＝正式版會提供。未勾＝僅 npm start 可測，正式安裝包不會出現。',
    widgets: next
  };
  fs.writeFileSync(distFeaturesPath(), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { widgets: next };
}

ipcMain.handle('get-app-mode', async () => ({
  success: true,
  dev: !app.isPackaged,
  packaged: !!app.isPackaged
}));

ipcMain.handle('get-dist-features', async () => {
  const packaged = !!app.isPackaged;
  try {
    const { widgets } = loadDistFeatures();
    return {
      success: true,
      // [Important] 正式安裝包一律非開發；不可因讀檔失敗誤開全部功能
      dev: !packaged,
      packaged,
      widgets
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      widgets: defaultDistWidgets(),
      dev: !packaged,
      packaged
    };
  }
});

ipcMain.handle('set-dist-feature', async (_event, payload) => {
  try {
    // [Development Only] 正式包不可改開關，避免使用者改到打包設定
    if (app.isPackaged) {
      return { success: false, error: '正式版無法變更打包功能開關' };
    }
    const type = String(payload?.type || '').trim();
    if (!DIST_WIDGET_KEYS.includes(type)) {
      return { success: false, error: '未知功能' };
    }
    const { widgets } = loadDistFeatures();
    widgets[type] = !!payload?.enabled;
    const saved = saveDistFeatures(widgets);
    return { success: true, ...saved, dev: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sheets-add-source', async (event, payload) => {
  try {
    if (!sheetsService) return { success: false, error: '請先用 Google 登入' };
    const name = String(payload?.name || '').trim();
    const parsed = parseSpreadsheetRef(payload?.url || payload?.spreadsheetId);
    if (!name) return { success: false, error: '請填名稱，例如報修單或提問' };
    if (!parsed.spreadsheetId) return { success: false, error: '請貼上 Google 試算表網址' };
    const scope = await grantedScopeText();
    if (!hasSheetsScope(scope)) {
      return {
        success: false,
        featureScopeMissing: true,
        needsAuth: true,
        authStatus: AUTH_STATUS.FEATURE_SCOPE_MISSING,
        error: '目前登入還沒有試算表權限，將打開 Google 授權頁。請允許「查看、編輯 Google 試算表」。'
      };
    }
    const tab = await resolveSheetTab(parsed.spreadsheetId, parsed.gid);
    const cfg = loadSheetsConfig();
    const existing = cfg.sources.find(s => s.spreadsheetId === parsed.spreadsheetId && String(s.gid || '') === String(parsed.gid || ''));
    if (existing) {
      existing.name = name;
      existing.url = String(payload?.url || existing.url || '').trim();
    } else {
      cfg.sources.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        url: String(payload?.url || '').trim(),
        spreadsheetId: parsed.spreadsheetId,
        gid: parsed.gid || String(tab.sheetId)
      });
    }
    saveSheetsConfig(cfg);
    return { success: true, sources: cfg.sources, sheetName: tab.sheetName, spreadsheetTitle: tab.title };
  } catch (err) {
    return { success: false, ...explainSheetsError(err) };
  }
});

ipcMain.handle('sheets-remove-source', async (event, id) => {
  try {
    const cfg = loadSheetsConfig();
    cfg.sources = cfg.sources.filter(s => s.id !== id);
    saveSheetsConfig(cfg);
    const state = loadSheetsState();
    delete state.cursors[id];
    saveSheetsState(state);
    return { success: true, sources: cfg.sources };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sheets-inbox', async () => {
  try {
    if (!sheetsService) return { success: false, error: '請先用 Google 登入' };
    const source = getBuiltin9527Source();
    const state = loadSheetsState();
    const groups = [];
    try {
      const tab = await resolveSheetTab(source.spreadsheetId, source.gid);
      const locked = {
        ...source,
        gid: String(tab.sheetId),
        name: '9527'
      };
      saveSheetsConfig({ sources: [locked] });
      groups.push(await fetchSheetSource(locked, state));
    } catch (err) {
      const explained = explainSheetsError(err);
      if (explained.needsApi || explained.authRevoked || explained.featureScopeMissing || explained.needsAuth) {
        return { success: false, ...explained };
      }
      groups.push({
        id: source.id,
        name: '9527',
        error: explained.error,
        pending: 0,
        newest: 0,
        items: []
      });
    }
    saveSheetsState(state);
    const allItems = groups.flatMap(g => g.items || []);
    const typeSet = new Set();
    const unitSet = new Set();
    for (const item of allItems) {
      if (item.issueType) typeSet.add(item.issueType);
      if (item.unit) unitSet.add(item.unit);
    }
    return {
      success: true,
      groups,
      pending: groups.reduce((n, g) => n + (g.pending || 0), 0),
      newest: groups.reduce((n, g) => n + (g.newest || 0), 0),
      facets: {
        issueTypes: [...typeSet].sort((a, b) => a.localeCompare(b, 'zh-Hant')),
        units: [...unitSet].sort((a, b) => a.localeCompare(b, 'zh-Hant'))
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sheets-save-note', async (event, payload) => {
  try {
    if (!sheetsService) return { success: false, error: '請先用 Google 登入' };
    const spreadsheetId = String(payload?.spreadsheetId || '');
    const sheetName = String(payload?.sheetName || '');
    const rowNumber = Number(payload?.rowNumber);
    const col = String(payload?.noteColumn || 'M').replace(/[^A-Z]/gi, '') || 'M';
    if (!spreadsheetId || !sheetName || !rowNumber) return { success: false, error: '缺少列資料' };
    const note = String(payload?.note ?? '');
    await sheetsService.spreadsheets.values.update({
      spreadsheetId,
      range: quoteSheetRange(sheetName, `${col}${rowNumber}`),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[note]] }
    });
    return { success: true, note };
  } catch (err) {
    return { success: false, ...explainSheetsError(err) };
  }
});

ipcMain.handle('sheets-mark-done', async (event, payload) => {
  try {
    if (!sheetsService) return { success: false, error: '請先用 Google 登入' };
    const key = String(payload?.key || '');
    const spreadsheetId = String(payload?.spreadsheetId || '');
    const sheetName = String(payload?.sheetName || '');
    const rowNumber = Number(payload?.rowNumber);
    if (!key || !spreadsheetId || !sheetName || !rowNumber) return { success: false, error: '缺少列資料' };
    if (payload?.canWriteStatus && payload?.statusColumn) {
      await sheetsService.spreadsheets.values.update({
        spreadsheetId,
        range: quoteSheetRange(sheetName, `${payload.statusColumn}${rowNumber}`),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[payload?.doneValue || '已完成']] }
      });
    }
    const state = loadSheetsState();
    if (!state.done.includes(key)) state.done.push(key);
    if (state.done.length > 4000) state.done = state.done.slice(-3000);
    saveSheetsState(state);
    return { success: true };
  } catch (err) {
    return { success: false, ...explainSheetsError(err) };
  }
});


// ========== 【MODULE: modules/sites-visits】Sites 瀏覽紀錄 ==========
// [Important] mssql 需先 patch diagnostics_channel（Electron Node 相容）
patchDiagnosticsChannel();
const sitesVisitsEnrich = require('./modules/sites-visits/enrich');
// --- Google Sites 瀏覽紀錄（Site ID 設定 → 資訊寫入本機 App） ---
function sitesVisitsConfigPath() {
  return path.join(app.getPath('userData'), 'sites-visits.json');
}
function sitesVisitsStorePath() {
  return path.join(app.getPath('userData'), 'sites-visits-store.json');
}

const SITES_VISITS_HEADERS = ['時間', '同仁', '專案', '網站', '秒數', 'SiteID', '點擊數', '超連結數'];
// [Important] 業務全在台灣：瀏覽時間一律以台北時區存／讀／顯示（避免試算表預設 UTC 差 8 小時）
const SITES_VISITS_TIMEZONE = 'Asia/Taipei';

function padSitesVisit2(n) {
  return String(n).padStart(2, '0');
}

function formatSitesVisitTimeLabel(ms) {
  const t = Number(ms) || 0;
  if (!t) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: SITES_VISITS_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(new Date(t));
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    let hour = Number(map.hour);
    if (hour === 24) hour = 0;
    return `${map.year}/${Number(map.month)}/${Number(map.day)} ${padSitesVisit2(hour)}:${map.minute}:${map.second}`;
  } catch (_) {
    return new Date(t).toISOString();
  }
}

/** 將試算表「牆上時鐘」數字解成 Asia/Taipei 絕對時間 */
function sitesVisitWallTimeToMs(year, month, day, hour, minute, second) {
  const iso = `${year}-${padSitesVisit2(month)}-${padSitesVisit2(day)}T${padSitesVisit2(hour)}:${padSitesVisit2(minute)}:${padSitesVisit2(second)}+08:00`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

async function ensureSitesVisitsSpreadsheetTimezone(spreadsheetId) {
  if (!sheetsService || !spreadsheetId) return { changed: false };
  const cfg = loadSitesVisitsConfig();
  try {
    const meta = await sheetsService.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.timeZone,properties.locale'
    });
    const prevTz = String(meta.data?.properties?.timeZone || 'UTC') || 'UTC';
    const locale = String(meta.data?.properties?.locale || '');
    const fields = [];
    const properties = {};
    if (prevTz !== SITES_VISITS_TIMEZONE) {
      properties.timeZone = SITES_VISITS_TIMEZONE;
      fields.push('timeZone');
    }
    if (locale !== 'zh_TW') {
      properties.locale = 'zh_TW';
      fields.push('locale');
    }
    if (fields.length) {
      await sheetsService.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            updateSpreadsheetProperties: {
              properties,
              fields: fields.join(',')
            }
          }]
        }
      });
    }
    // 歷史修正只做一次：舊時區牆上時鐘 → 台北；若已標台北仍可能是未換算的 UTC 值
    if (!cfg.logTimezoneNormalized) {
      const fromTz = prevTz === SITES_VISITS_TIMEZONE ? 'UTC' : prevTz;
      await shiftSitesVisitsSheetTimesToTaipei(spreadsheetId, fromTz);
      cfg.logTimezoneNormalized = true;
      saveSitesVisitsConfig(cfg);
    }
    return { changed: true, prevTz };
  } catch (_) {
    return { changed: false };
  }
}

/** 依舊時區與台北的偏移，把時間欄 Date 序號改寫成台北牆上時鐘 */
async function shiftSitesVisitsSheetTimesToTaipei(spreadsheetId, prevTz) {
  if (!sheetsService || !spreadsheetId) return;
  const cfg = loadSitesVisitsConfig();
  const sheetName = cfg.logSheetName || '瀏覽紀錄';
  const res = await sheetsService.spreadsheets.values.get({
    spreadsheetId,
    range: quoteSheetRange(sheetName, 'A2:A'),
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const rows = res.data.values || [];
  if (!rows.length) return;
  const out = [];
  let changed = 0;
  for (const row of rows) {
    const raw = row[0];
    if (raw == null || raw === '') {
      out.push(['']);
      continue;
    }
    let absoluteMs = 0;
    if (typeof raw === 'number' && raw > 20000 && raw < 200000) {
      absoluteMs = sheetSerialAsTimezoneToMs(raw, prevTz);
    } else {
      absoluteMs = parseWallTimeInTimezone(String(raw), prevTz);
    }
    if (!absoluteMs) {
      out.push([raw]);
      continue;
    }
    const label = formatSitesVisitTimeLabel(absoluteMs);
    out.push([label]);
    changed += 1;
  }
  if (!changed) return;
  await sheetsService.spreadsheets.values.update({
    spreadsheetId,
    range: quoteSheetRange(sheetName, `A2:A${rows.length + 1}`),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: out }
  });
}

function tzOffsetMsAt(ms, timeZone) {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const name = String(map.timeZoneName || 'GMT');
  const m = name.match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 3600000 + Number(m[3] || 0) * 60000);
}

function sheetSerialAsTimezoneToMs(serial, timeZone) {
  const wholeDays = Math.floor(serial);
  let millis = Math.round((serial - wholeDays) * 86400000);
  let dayOffset = wholeDays;
  if (millis >= 86400000) {
    millis -= 86400000;
    dayOffset += 1;
  } else if (millis < 0) {
    millis += 86400000;
    dayOffset -= 1;
  }
  const base = new Date(Date.UTC(1899, 11, 30) + dayOffset * 86400000);
  const y = base.getUTCFullYear();
  const mo = base.getUTCMonth() + 1;
  const d = base.getUTCDate();
  const h = Math.floor(millis / 3600000);
  const mi = Math.floor((millis % 3600000) / 60000);
  const s = Math.floor((millis % 60000) / 1000);
  // 先當 UTC 牆上，再扣掉該時區相對 UTC 的偏移 → 絕對時間
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const guess = asUtc;
  const off = tzOffsetMsAt(guess, timeZone);
  return asUtc - off;
}

function absoluteMsToSheetSerialInTimezone(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // 少數環境 24:00
  const y = Number(map.year);
  const mo = Number(map.month);
  const d = Number(map.day);
  const mi = Number(map.minute);
  const s = Number(map.second);
  const utcWall = Date.UTC(y, mo - 1, d, hour, mi, s);
  return (utcWall - Date.UTC(1899, 11, 30)) / 86400000;
}

function parseWallTimeInTimezone(text, timeZone) {
  const m = String(text || '').trim().match(
    /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s*(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i
  );
  if (!m) return 0;
  let hour = Number(m[5]);
  const ap = String(m[4] || '').toLowerCase();
  if ((ap === '下午' || ap === 'pm') && hour < 12) hour += 12;
  if ((ap === '上午' || ap === 'am') && hour === 12) hour = 0;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, Number(m[6]), Number(m[7] || 0));
  return asUtc - tzOffsetMsAt(asUtc, timeZone);
}

function loadSitesVisitsConfig() {
  try {
    if (fs.existsSync(sitesVisitsConfigPath())) {
      const data = JSON.parse(fs.readFileSync(sitesVisitsConfigPath(), 'utf8'));
      return {
        logSpreadsheetId: String(data.logSpreadsheetId || ''),
        logSheetName: String(data.logSheetName || '瀏覽紀錄'),
        deployWebAppUrl: String(data.deployWebAppUrl || ''),
        projects: Array.isArray(data.projects) ? data.projects : [],
        erpConnectionString: String(data.erpConnectionString || '').trim(),
        columnPrefs: sitesVisitsEnrich.normalizeColumnPrefs(data.columnPrefs),
        // [Important] 歷史時間是否已換算成台北（只做一次，避免重複 +8）
        logTimezoneNormalized: !!data.logTimezoneNormalized
      };
    }
  } catch (_) {}
  return {
    logSpreadsheetId: '',
    logSheetName: '瀏覽紀錄',
    deployWebAppUrl: '',
    projects: [],
    erpConnectionString: '',
    columnPrefs: sitesVisitsEnrich.defaultColumnPrefs(),
    logTimezoneNormalized: false
  };
}

function saveSitesVisitsConfig(cfg) {
  const current = loadSitesVisitsConfig();
  fs.writeFileSync(sitesVisitsConfigPath(), JSON.stringify({
    logSpreadsheetId: cfg.logSpreadsheetId || '',
    logSheetName: cfg.logSheetName || '瀏覽紀錄',
    deployWebAppUrl: cfg.deployWebAppUrl || '',
    projects: cfg.projects || [],
    erpConnectionString: cfg.erpConnectionString === undefined
      ? (current.erpConnectionString || '')
      : String(cfg.erpConnectionString || '').trim(),
    columnPrefs: cfg.columnPrefs === undefined
      ? current.columnPrefs
      : sitesVisitsEnrich.normalizeColumnPrefs(cfg.columnPrefs),
    logTimezoneNormalized: cfg.logTimezoneNormalized === undefined
      ? !!current.logTimezoneNormalized
      : !!cfg.logTimezoneNormalized
  }, null, 2));
}

function resolveSitesVisitsErpConnectionString(cfg) {
  const fromCfg = String(cfg?.erpConnectionString || '').trim();
  if (fromCfg) return fromCfg;
  try {
    const gemini = loadGeminiConfig();
    const fromGemini = String(gemini.sqlConnectionString || '').trim();
    if (fromGemini) return fromGemini;
  } catch (_) {}
  return sitesVisitsEnrich.DEFAULT_ERP_CONNECTION_STRING;
}

async function enrichSitesVisitsReportItems(items, cfg) {
  const connectionString = resolveSitesVisitsErpConnectionString(cfg);
  const emails = (items || []).map(i => i.person);
  try {
    const employeeMap = await sitesVisitsEnrich.fetchEmployeesByEmails(connectionString, emails);
    const deptMap = await sitesVisitsEnrich.fetchDeptHierarchy(connectionString);
    return {
      items: sitesVisitsEnrich.enrichSitesVisitsItems(items, employeeMap, deptMap),
      erpEnriched: true,
      erpError: ''
    };
  } catch (err) {
    return {
      items: sitesVisitsEnrich.enrichSitesVisitsItems(items, new Map(), new Map()),
      erpEnriched: false,
      erpError: err.message || String(err)
    };
  }
}

function loadSitesVisitsStore() {
  try {
    if (fs.existsSync(sitesVisitsStorePath())) {
      const data = JSON.parse(fs.readFileSync(sitesVisitsStorePath(), 'utf8'));
      return {
        events: Array.isArray(data.events) ? data.events : [],
        syncedAt: String(data.syncedAt || ''),
        items: Array.isArray(data.items) ? data.items : []
      };
    }
  } catch (_) {}
  return { events: [], syncedAt: '', items: [] };
}

function saveSitesVisitsStore(store) {
  fs.writeFileSync(sitesVisitsStorePath(), JSON.stringify({
    events: store.events || [],
    syncedAt: store.syncedAt || '',
    items: store.items || []
  }, null, 2));
}

function parseGoogleSiteRef(input) {
  const text = String(input || '').trim();
  if (!text) return { siteId: '', pageId: '', siteUrl: '', siteSlug: '' };
  // /d/{SITE_ID}/p/{PAGE_ID}/...  ← Site ID 在 /d/ 後，不是 /p/ 後
  const withPage = text.match(/sites\.google\.com\/d\/([a-zA-Z0-9_-]+)\/p\/([a-zA-Z0-9_-]+)/i);
  if (withPage) {
    return {
      siteId: withPage[1],
      pageId: withPage[2],
      siteUrl: `https://sites.google.com/d/${withPage[1]}/view`,
      siteSlug: ''
    };
  }
  const fromPath = text.match(/sites\.google\.com\/d\/([a-zA-Z0-9_-]+)/i)
    || text.match(/\/d\/([a-zA-Z0-9_-]{20,})(?:\/|$)/i);
  if (fromPath) {
    const siteId = fromPath[1];
    return { siteId, pageId: '', siteUrl: `https://sites.google.com/d/${siteId}/view`, siteSlug: '' };
  }
  // 自訂網域發布網址：sites.google.com/公司網域/站台路徑/...
  const published = text.match(/sites\.google\.com\/([^/]+)\/([^/?#]+)/i);
  if (published && !/^d$/i.test(published[1])) {
    return {
      siteId: '',
      pageId: '',
      siteUrl: text.split('?')[0],
      siteSlug: decodeURIComponent(published[2])
    };
  }
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) {
    return { siteId: text, pageId: '', siteUrl: `https://sites.google.com/d/${text}/view`, siteSlug: '' };
  }
  if (/^https?:\/\//i.test(text)) {
    return { siteId: '', pageId: '', siteUrl: text, siteSlug: '' };
  }
  return { siteId: text, pageId: '', siteUrl: '', siteSlug: '' };
}

/** 網頁應用程式部署網址必須是 …/macros/s/…/exec，不可用 Drive／編輯器網址 */
function normalizeSitesDeployWebAppUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, url: '', error: '請貼上部署後的網頁應用程式網址' };
  let url = raw.split('#')[0].trim();
  // 常見錯誤：貼了編輯器、Drive、試算表
  if (/drive\.google\.com/i.test(url) || /docs\.google\.com\/spreadsheets/i.test(url)) {
    return {
      ok: false,
      url: '',
      error: '這是雲端硬碟／試算表網址。請改貼「部署 → 網頁應用程式」產生的網址（含 /macros/s/…/exec）'
    };
  }
  if (/script\.google\.com\/home\/projects/i.test(url) || /script\.google\.com\/d\//i.test(url)) {
    return {
      ok: false,
      url: '',
      error: '這是 Apps Script 編輯器網址。請到「部署 → 管理部署」複製「網頁應用程式」網址'
    };
  }
  if (/\/dev(?:\?|$)/i.test(url)) {
    return {
      ok: false,
      url: '',
      error: '請勿使用 /dev 測試網址（只有你能開）。請用正式部署的 /exec 網址'
    };
  }
  const m = url.match(/^(https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec)/i)
    || url.match(/^(https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\/[^/?#]+\/exec)/i);
  if (!m) {
    return {
      ok: false,
      url: '',
      error: '格式不對。正確示例：https://script.google.com/macros/s/AKfycb…/exec'
    };
  }
  return { ok: true, url: m[1], error: '' };
}

function buildSitesTrackLinkUrls(deployUrl, siteKey, opts = {}) {
  const base = String(deployUrl || '').replace(/\?.*$/, '').replace(/\/$/, '');
  const sid = encodeURIComponent(String(siteKey || ''));
  const label = encodeURIComponent(String(opts.label || '按鈕'));
  const target = encodeURIComponent(String(opts.targetUrl || 'https://example.com'));
  const logSheet = String(opts.logSpreadsheetId || '').trim();
  const logQ = logSheet ? `&logSheet=${encodeURIComponent(logSheet)}` : '';
  return {
    embed: `${base}?siteId=${sid}${logQ}`,
    click: `${base}?siteId=${sid}&event=click&label=${label}${logQ}`,
    link: `${base}?siteId=${sid}&event=link&url=${target}&label=${label}${logQ}`
  };
}

function sitesVisitsTrackerScript(cfg) {
  const list = (cfg.projects || []).map(p => ({
    id: p.id,
    name: p.name,
    siteId: p.siteId || '',
    pageId: p.pageId || '',
    siteSlug: p.siteSlug || '',
    url: p.siteUrl || ''
  }));
  const sheetId = cfg.logSpreadsheetId || 'PASTE_SPREADSHEET_ID';
  return `/**
 * LifeTour × Google Sites 瀏覽追蹤
 *
 * 部署網址必須是：https://script.google.com/macros/s/XXXX/exec
 * （若出現「無法開啟這個檔案／雲端硬碟」，代表貼錯成 Drive 或編輯器網址）
 *
 * 造訪：每次進入網頁 +1（約 90 秒內重複載入不重複計，避免 iframe 重載誤算）
 * 點擊：嵌入區需點「點擊監控區」；或 ?event=click 再按確認才 +1
 * 超連結：?event=link&url=… 再按「前往並計數」才 +1（開啟頁面不計）
 * 停留時間：嵌入頁每約 10 秒回報實際可見秒數（分頁隱藏時暫停），不是固定 +30 秒
 *
 * 權限：執行身分＝我；誰可以存取＝網域內的所有人
 * 改碼後務必：管理部署 → 編輯 → 新版本
 *
 * ★ 時區：試算表強制 Asia/Taipei（台北），避免出現凌晨 1～7 點的錯位
 * ★ 若同仁看到「LOG_SHEET_ID 未設定」：把下面這行改成 LifeTour 設定頁顯示的試算表 ID
 */
var LOG_SHEET_ID = '${sheetId}';
var LOG_SHEET_NAME = '瀏覽紀錄';
var LOG_TIMEZONE = 'Asia/Taipei';
var PROJECTS = ${JSON.stringify(list, null, 2)};

function ensureTaipeiTimezone_(ss) {
  try {
    if (ss.getSpreadsheetTimeZone() !== LOG_TIMEZONE) {
      ss.setSpreadsheetTimeZone(LOG_TIMEZONE);
    }
  } catch (eTz) {}
}

function nowForLog_() {
  return new Date();
}

function getLogSheetId_() {
  var id = String(LOG_SHEET_ID || '').trim();
  if (id && id !== 'PASTE_SPREADSHEET_ID') return id;
  try {
    id = String(PropertiesService.getScriptProperties().getProperty('LOG_SHEET_ID') || '').trim();
  } catch (e1) { id = ''; }
  if (id && id !== 'PASTE_SPREADSHEET_ID') return id;
  throw new Error('LOG_SHEET_ID 未設定：請在 Apps Script 開頭把 LOG_SHEET_ID 改成 LifeTour 顯示的試算表 ID，再「管理部署→新版本」');
}

function rememberLogSheetId_(raw) {
  var id = String(raw || '').trim();
  if (!id || id === 'PASTE_SPREADSHEET_ID') return '';
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(id)) return '';
  try { PropertiesService.getScriptProperties().setProperty('LOG_SHEET_ID', id); } catch (e2) {}
  LOG_SHEET_ID = id;
  return id;
}

function safeHttpUrl_(u) {
  u = String(u || '').trim();
  if (!/^https?:\\/\\//i.test(u)) return '';
  return u;
}

function page_(body, title) {
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + (title || 'LifeTour') + '</title></head>' +
    '<body style="margin:0;font:13px/1.45 sans-serif;padding:12px;color:#333;background:#fff;">' +
    body + '</body></html>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doGet(e) {
  var siteId = '';
  var eventName = 'open';
  var label = '';
  var targetUrl = '';
  var logSheetParam = '';
  try {
    siteId = String((e && e.parameter && (e.parameter.siteId || e.parameter.project)) || '');
    eventName = String((e && e.parameter && e.parameter.event) || 'open').toLowerCase();
    label = String((e && e.parameter && e.parameter.label) || '');
    targetUrl = safeHttpUrl_((e && e.parameter && (e.parameter.url || e.parameter.to || e.parameter.href)) || '');
    logSheetParam = String((e && e.parameter && (e.parameter.logSheet || e.parameter.logSpreadsheetId)) || '');
  } catch (err1) {}
  if (logSheetParam) rememberLogSheetId_(logSheetParam);
  if (!siteId && PROJECTS && PROJECTS.length === 1) {
    siteId = String(PROJECTS[0].siteId || PROJECTS[0].siteSlug || '');
  }

  if (eventName === 'click') {
    // 不在伺服器 GET 記數；必須使用者再按一次按鈕才 +1
    var clickHtml = HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'body{margin:0;font:14px/1.5 sans-serif;padding:24px;color:#333;text-align:center;background:#fff;}' +
      '#go{font:14px sans-serif;padding:10px 18px;cursor:pointer;margin-top:14px;}' +
      '</style></head><body>' +
      '<div id="msg">請確認點擊' + (label ? ('「' + label + '」') : '') + '</div>' +
      '<button type="button" id="go">確認點擊並返回</button>' +
      '<script>' +
      'var SITE_ID=' + JSON.stringify(siteId) + ';' +
      'var LABEL=' + JSON.stringify(label || 'button') + ';' +
      'var done=false;' +
      'function go(){' +
      '  if(done) return; done=true;' +
      '  var msg=document.getElementById("msg");' +
      '  if(msg) msg.textContent="已記錄點擊…";' +
      '  function back(){ setTimeout(function(){ history.length>1 ? history.back() : null; }, 400); }' +
      '  if(!(window.google&&google.script&&google.script.run)){ back(); return; }' +
      '  google.script.run.withSuccessHandler(back).withFailureHandler(back).logVisit(SITE_ID, 0, "click", LABEL);' +
      '}' +
      'document.getElementById("go").addEventListener("click", go);' +
      '</script></body></html>'
    );
    clickHtml.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    return clickHtml;
  }

  if (eventName === 'link' || eventName === 'redirect') {
    if (!targetUrl) {
      return page_('<div>缺少 url 參數，無法轉址（超連結未計數）</div>');
    }
    // 必須再按「前往」才記數並轉址（開啟頁面／預抓不計）
    var linkHtml = HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'body{margin:0;font:14px/1.5 sans-serif;padding:24px;color:#333;text-align:center;background:#fff;}' +
      '#go{font:14px sans-serif;padding:10px 18px;cursor:pointer;margin-top:14px;}' +
      '</style></head><body>' +
      '<div id="msg">即將前往' + (label ? ('「' + label + '」') : '目標頁面') + '<br><small>請再按一次下方按鈕才會計入超連結</small></div>' +
      '<button type="button" id="go">前往並計數</button>' +
      '<script>' +
      'var SITE_ID=' + JSON.stringify(siteId) + ';' +
      'var LABEL=' + JSON.stringify(label || targetUrl) + ';' +
      'var TARGET=' + JSON.stringify(targetUrl) + ';' +
      'var done=false;' +
      'function finish(){ try{ location.replace(TARGET); }catch(e){ location.href=TARGET; } }' +
      'function go(){' +
      '  if(done) return; done=true;' +
      '  var msg=document.getElementById("msg");' +
      '  if(msg) msg.textContent="記錄中，即將轉址…";' +
      '  if(!(window.google&&google.script&&google.script.run)){ finish(); return; }' +
      '  google.script.run' +
      '    .withSuccessHandler(function(){ finish(); })' +
      '    .withFailureHandler(function(){ finish(); })' +
      '    .logVisit(SITE_ID, 0, "link", LABEL);' +
      '}' +
      'document.getElementById("go").addEventListener("click", go);' +
      '</script></body></html>'
    );
    linkHtml.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    linkHtml.setTitle('LifeTour link');
    return linkHtml;
  }

  var openErr = '';
  try { logVisit(siteId, 0, 'open', ''); } catch (err2) { openErr = String(err2 && err2.message || err2); }

  var status = openErr
    ? ('<div style="color:#b00;font-size:12px;line-height:1.5;">寫入失敗：' + openErr +
      '<br><br>請更新嵌入網址，加上 logSheet=你的試算表ID，或修正 Apps Script 的 LOG_SHEET_ID 後部署新版本。</div>')
    : ('<div style="color:#6a6;font-size:11px;">追蹤就緒 · siteId=' + (siteId || '(空)') + '</div>');

  var html = HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;width:100%;height:100%;min-height:120px;background:transparent;}' +
    '#wrap{box-sizing:border-box;width:100%;height:100%;min-height:120px;padding:8px;}' +
    '#hit{box-sizing:border-box;width:100%;min-height:72px;cursor:pointer;' +
    'display:flex;align-items:center;justify-content:center;font:12px/1.4 sans-serif;color:#9aa;' +
    'border:1px dashed rgba(0,0,0,.12);border-radius:8px;user-select:none;}' +
    '#hit:active{background:rgba(0,0,0,.04);}' +
    '</style></head><body><div id="wrap">' + status +
    '<div id="hit" title="點此區塊可記錄互動點擊">點擊監控區</div></div>' +
    '<script>' +
    'var SITE_ID=' + JSON.stringify(siteId) + ';' +
    'var lastClick=0;' +
    'var lastBeatAt=Date.now();' +
    'var visibleSince=document.hidden?0:Date.now();' +
    'function send(kind,label,secs){' +
    '  var n = (kind==="beat") ? Math.max(0, Math.min(120, Math.round(Number(secs)||0))) : 0;' +
    '  if(kind==="beat" && n<=0) return;' +
    '  google.script.run.withFailureHandler(function(err){' +
    '    var el=document.getElementById("hit"); if(el) el.textContent="失敗："+String(err&&err.message||err);' +
    '  }).logVisit(SITE_ID, n, kind, label||"");' +
    '}' +
    'function flushBeat(){' +
    '  if(document.hidden) return;' +
    '  var now=Date.now();' +
    '  var sec=Math.round((now-lastBeatAt)/1000);' +
    '  lastBeatAt=now;' +
    '  if(sec>0) send("beat","",sec);' +
    '}' +
    'function onHit(ev){' +
    '  if(ev){ ev.preventDefault(); ev.stopPropagation(); }' +
    '  var now=Date.now(); if(now-lastClick<800) return; lastClick=now;' +
    '  send("click", "embed");' +
    '  var el=document.getElementById("hit");' +
    '  if(el){ el.textContent="已點擊 ✓"; setTimeout(function(){ el.textContent="點擊監控區"; }, 700); }' +
    '}' +
    'document.getElementById("hit").addEventListener("click", onHit);' +
    'document.addEventListener("visibilitychange", function(){' +
    '  if(document.hidden){ flushBeat(); visibleSince=0; }' +
    '  else { lastBeatAt=Date.now(); visibleSince=Date.now(); }' +
    '});' +
    'window.addEventListener("pagehide", flushBeat);' +
    'window.addEventListener("beforeunload", flushBeat);' +
    'setInterval(flushBeat, 10000);' +
    '</script></body></html>'
  );
  html.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  html.setTitle('LifeTour tracker');
  return html;
}

function resolveProject(siteId) {
  var key = String(siteId || '');
  var keyLower = key.toLowerCase();
  for (var i = 0; i < (PROJECTS || []).length; i++) {
    var p = PROJECTS[i];
    if (!p) continue;
    if (p.siteId && p.siteId === key) return p;
    if (p.pageId && p.pageId === key) return p;
    if (p.id && p.id === key) return p;
    if (p.name && p.name === key) return p;
    if (p.siteSlug && String(p.siteSlug).toLowerCase() === keyLower) return p;
    if (p.url && key && String(p.url).indexOf(key) >= 0) return p;
  }
  if (!key && PROJECTS && PROJECTS.length === 1) return PROJECTS[0] || {};
  return {};
}

function ensureHeader_(sh) {
  if (sh.getLastRow() === 0) {
    sh.appendRow(['時間', '同仁', '專案', '網站', '秒數', 'SiteID', '點擊數', '超連結數']);
    return;
  }
  var head = sh.getRange(1, 1, 1, 8).getValues()[0];
  if (String(head[6] || '') !== '點擊數') sh.getRange(1, 7).setValue('點擊數');
  if (String(head[7] || '') !== '超連結數') sh.getRange(1, 8).setValue('超連結數');
}

function findSessionRow_(sh, sid, projectName, person, now, SESSION_MS) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var vals = sh.getRange(2, 1, last, 8).getValues();
  var personKey = String(person || '');
  for (var r = vals.length - 1; r >= 0; r--) {
    var rowSid = String(vals[r][5] || '');
    var rowProject = String(vals[r][2] || '');
    var rowPerson = String(vals[r][1] || '');
    var rowTime = vals[r][0] ? new Date(vals[r][0]).getTime() : 0;
    if (SESSION_MS > 0 && !(rowTime && (now - rowTime) <= SESSION_MS)) continue;
    // 必須同一同仁，避免多人互相覆寫成一列
    if (personKey && personKey !== '未知同仁' && rowPerson && rowPerson !== personKey) continue;
    if (personKey === '未知同仁' && rowPerson && rowPerson !== '未知同仁') continue;
    if ((sid && rowSid === sid) || (projectName && rowProject === projectName)) return r + 2;
  }
  return -1;
}

function touchSession_(sh, row, person) {
  sh.getRange(row, 1).setValue(nowForLog_());
  if (person && person !== '未知同仁') {
    var cur = String(sh.getRange(row, 2).getValue() || '');
    if (!cur || cur === '未知同仁') sh.getRange(row, 2).setValue(person);
  }
}

function logVisit(siteId, seconds, kind, label) {
  kind = kind || 'open';
  label = label || '';
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheetIdResolved = getLogSheetId_();
    var ss = SpreadsheetApp.openById(sheetIdResolved);
    ensureTaipeiTimezone_(ss);
    var sh = ss.getSheetByName(LOG_SHEET_NAME) || ss.insertSheet(LOG_SHEET_NAME);
    ensureHeader_(sh);
    var user = '';
    try {
      user = Session.getActiveUser().getEmail() || '';
      if (!user) user = Session.getEffectiveUser().getEmail() || '';
    } catch (err) {}
    var meta = resolveProject(siteId);
    if ((!siteId || !String(siteId)) && (meta.siteId || meta.siteSlug)) {
      siteId = meta.siteId || meta.siteSlug;
    }
    var sid = String(siteId || meta.siteId || meta.siteSlug || '');
    var person = user || '未知同仁';
    var projectName = meta.name || sid || '未命名';
    var siteUrl = meta.url || '';
    // 造訪：每次進入都算，僅 90 秒內防 iframe 重載
    var OPEN_DEBOUNCE_MS = 90 * 1000;
    // 點擊／超連結／心跳：寫入「最近一次造訪」列（12 小時內）
    var ACTIVE_VISIT_MS = 12 * 60 * 60 * 1000;
    var addSec = (kind === 'beat') ? Math.max(0, Number(seconds) || 0) : 0;
    var now = new Date().getTime();
    var cache = CacheService.getScriptCache();
    var openCacheKey = 'open_' + sid + '_' + person;

    if (kind === 'open') {
      if (sid && cache.get(openCacheKey)) {
        var dup = findSessionRow_(sh, sid, projectName, person, now, OPEN_DEBOUNCE_MS);
        if (dup > 0) touchSession_(sh, dup, person);
        return;
      }
      var recentOpen = findSessionRow_(sh, sid, projectName, person, now, OPEN_DEBOUNCE_MS);
      if (recentOpen > 0) {
        touchSession_(sh, recentOpen, person);
        if (sid) cache.put(openCacheKey, '1', 90);
        return;
      }
      sh.appendRow([nowForLog_(), person, projectName, siteUrl, 0, sid, 0, 0]);
      if (sid) cache.put(openCacheKey, '1', 90);
      return;
    }

    var row = findSessionRow_(sh, sid, projectName, person, now, ACTIVE_VISIT_MS);

    if (kind === 'click') {
      if (row > 0) {
        var prevClicks = Number(sh.getRange(row, 7).getValue()) || 0;
        touchSession_(sh, row, person);
        sh.getRange(row, 7).setValue(prevClicks + 1);
        return;
      }
      sh.appendRow([nowForLog_(), person, projectName, siteUrl, 0, sid, 1, 0]);
      return;
    }

    if (kind === 'link' || kind === 'redirect') {
      if (row > 0) {
        var prevLinks = Number(sh.getRange(row, 8).getValue()) || 0;
        touchSession_(sh, row, person);
        sh.getRange(row, 8).setValue(prevLinks + 1);
        return;
      }
      sh.appendRow([nowForLog_(), person, projectName, siteUrl, 0, sid, 0, 1]);
      return;
    }

    if (kind === 'beat') {
      if (row < 0) return;
      var prevSec = Number(sh.getRange(row, 5).getValue()) || 0;
      touchSession_(sh, row, person);
      sh.getRange(row, 5).setValue(prevSec + addSec);
      return;
    }
  } finally {
    lock.releaseLock();
  }
}
`;
}


function findSitesVisitsColumns(headers) {
  const names = headers.map(h => String(h || '').replace(/\s+/g, ''));
  const find = (...keys) => {
    for (const key of keys) {
      const idx = names.findIndex(h => h === key || h.includes(key));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  return {
    time: find('時間', 'timestamp', '日期'),
    person: find('同仁', '人員', '姓名', '帳號', 'email', 'Email'),
    project: find('專案', '網站名稱', 'Site'),
    site: find('網站', '網址', 'URL', 'Url'),
    seconds: find('秒數', '秒', '時長', '停留', 'duration', 'Duration'),
    siteId: find('SiteID', 'siteid', '網站ID'),
    clicks: find('點擊數', '點擊', 'clicks', 'Clicks'),
    links: find('超連結數', '超連結', '轉址', 'links', 'Links', 'redirects')
  };
}

function parseDurationSeconds(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Number(text));
  const hm = text.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hm) {
    return Number(hm[1]) * 3600 + Number(hm[2]) * 60 + Number(hm[3] || 0);
  }
  const hour = text.match(/(\d+)\s*小時/);
  const min = text.match(/(\d+)\s*分/);
  const sec = text.match(/(\d+)\s*秒/);
  if (hour || min || sec) {
    return (hour ? Number(hour[1]) * 3600 : 0)
      + (min ? Number(min[1]) * 60 : 0)
      + (sec ? Number(sec[1]) : 0);
  }
  return 0;
}

function formatDurationLabel(totalSec) {
  const s = Math.max(0, Math.round(Number(totalSec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} 時 ${m} 分`;
  if (m) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

function parseSheetTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Sheets 序號＝試算表牆上時鐘；一律當台北解（勿用 Date.UTC 當絕對時間）
    if (value > 20000 && value < 200000) {
      const wholeDays = Math.floor(value);
      let millis = Math.round((value - wholeDays) * 86400000);
      let dayOffset = wholeDays;
      if (millis >= 86400000) {
        millis -= 86400000;
        dayOffset += 1;
      } else if (millis < 0) {
        millis += 86400000;
        dayOffset -= 1;
      }
      const base = new Date(Date.UTC(1899, 11, 30) + dayOffset * 86400000);
      return sitesVisitWallTimeToMs(
        base.getUTCFullYear(),
        base.getUTCMonth() + 1,
        base.getUTCDate(),
        Math.floor(millis / 3600000),
        Math.floor((millis % 3600000) / 60000),
        Math.floor((millis % 60000) / 1000)
      );
    }
    if (value > 1e11) return value;
  }
  const text = String(value || '').trim();
  if (!text) return 0;
  // 帶明確 offset／Z 的 ISO 直接用
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    const iso = Date.parse(text);
    if (!Number.isNaN(iso)) return iso;
  }
  const m = text.match(
    /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s*(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i
  );
  if (m) {
    let hour = Number(m[5]);
    const ap = String(m[4] || '').toLowerCase();
    if ((ap === '下午' || ap === 'pm') && hour < 12) hour += 12;
    if ((ap === '上午' || ap === 'am') && hour === 12) hour = 0;
    return sitesVisitWallTimeToMs(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      hour,
      Number(m[6]),
      Number(m[7] || 0)
    );
  }
  const d = text.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (d) return sitesVisitWallTimeToMs(Number(d[1]), Number(d[2]), Number(d[3]), 0, 0, 0);
  // 無 offset 的字串：勿讓主機時區左右結果，改當台北
  const loose = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (loose) {
    return sitesVisitWallTimeToMs(
      Number(loose[1]),
      Number(loose[2]),
      Number(loose[3]),
      Number(loose[4]),
      Number(loose[5]),
      Number(loose[6] || 0)
    );
  }
  return 0;
}

function isJunkSitesProjectName(name) {
  const n = String(name || '').replace(/\s+/g, '');
  return !n || /^(未命名|未命名專案|siteid|網站id|專案名稱)$/i.test(n);
}

function resolveSitesProjectMeta(ev, projects) {
  const list = projects || [];
  const sid = String(ev.siteId || '').trim();
  const name = String(ev.project || '').trim();
  const byId = sid ? list.find(p => p.siteId && p.siteId === sid) : null;
  if (byId) {
    return {
      project: byId.name || name || '未命名專案',
      siteId: byId.siteId || sid,
      site: byId.siteUrl || ev.site || ''
    };
  }
  const byName = name
    ? list.find(p => String(p.name || '').toLowerCase() === name.toLowerCase())
    : null;
  if (byName) {
    return {
      project: byName.name,
      siteId: byName.siteId || sid,
      site: byName.siteUrl || ev.site || ''
    };
  }
  // 測試殘留名稱（網站ID / SiteID / 未命名…）→ 併進現有專案
  if (isJunkSitesProjectName(name) || /^siteid$/i.test(name.replace(/\s+/g, ''))) {
    if (list.length === 1) {
      return {
        project: list[0].name,
        siteId: list[0].siteId || sid,
        site: list[0].siteUrl || ev.site || ''
      };
    }
    if (sid) {
      const hit = list.find(p => p.siteId === sid);
      if (hit) {
        return {
          project: hit.name,
          siteId: hit.siteId,
          site: hit.siteUrl || ev.site || ''
        };
      }
    }
  }
  return {
    project: name || (sid ? `Site ${sid.slice(0, 8)}…` : '未命名專案'),
    siteId: sid,
    site: ev.site || ''
  };
}

function aggregateSitesVisits(events, projects) {
  // 僅合併約 90 秒內的重複列（iframe 重載）；關掉再進來視為新造訪
  const VISIT_GAP_MS = 90 * 1000;
  const list = (events || []).map(ev => {
    const meta = resolveSitesProjectMeta(ev, projects);
    return {
      ...ev,
      timeMs: Number(ev.timeMs) || parseSheetTime(ev.time) || 0,
      seconds: Math.max(0, Number(ev.seconds) || 0),
      clicks: Math.max(0, Number(ev.clicks) || 0),
      links: Math.max(0, Number(ev.links) || 0),
      person: ev.person || '未知同仁',
      project: meta.project,
      siteId: meta.siteId,
      site: meta.site || ev.site || ''
    };
  }).sort((a, b) => (a.timeMs || 0) - (b.timeMs || 0));

  // 以「同仁 + SiteID」合併（不再把未知同仁填成同站其他人）
  const groups = new Map();
  for (const ev of list) {
    const siteKey = ev.siteId || `name:${ev.project}`;
    const key = `${ev.person}||${siteKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  const items = [];
  for (const [key, evs] of groups) {
    const hasTime = evs.some(e => e.timeMs > 0);
    let visits = 0;
    let interactionClicks = 0;
    let linkClicks = 0;
    let totalSeconds = 0;
    let lastAt = '';
    let lastAtMs = 0;
    let site = '';
    let siteId = '';
    const nameCount = new Map();
    for (const ev of evs) nameCount.set(ev.project, (nameCount.get(ev.project) || 0) + 1);
    let project = evs[evs.length - 1].project;
    let best = 0;
    for (const [n, c] of nameCount) {
      if (c >= best && !/^(未命名|未命名專案)$/i.test(n)) {
        best = c;
        project = n;
      }
    }

    if (!hasTime) {
      visits = evs.length;
      interactionClicks = evs.reduce((n, e) => n + (e.clicks || 0), 0);
      linkClicks = evs.reduce((n, e) => n + (e.links || 0), 0);
      totalSeconds = evs.reduce((n, e) => n + (e.seconds || 0), 0);
      const latest = evs[evs.length - 1] || {};
      lastAt = latest.time || '';
      site = latest.site || '';
      siteId = latest.siteId || '';
    } else {
      const sessions = [];
      for (const ev of evs) {
        const last = sessions[sessions.length - 1];
        const inSame = last && (ev.timeMs - (last.endMs || 0) <= VISIT_GAP_MS);
        if (inSame) {
          last.endMs = Math.max(last.endMs || 0, ev.timeMs);
          // 同一造訪的重複同步列：取最大累計值
          last.seconds = Math.max(last.seconds || 0, ev.seconds || 0);
          last.clicks = Math.max(last.clicks || 0, ev.clicks || 0);
          last.links = Math.max(last.links || 0, ev.links || 0);
          if (ev.timeMs >= (last.lastAtMs || 0)) {
            last.lastAtMs = ev.timeMs;
            last.lastAt = ev.time || last.lastAt;
          }
          if (ev.site) last.site = ev.site;
          if (ev.siteId) last.siteId = ev.siteId;
        } else {
          sessions.push({
            endMs: ev.timeMs,
            seconds: ev.seconds,
            clicks: ev.clicks || 0,
            links: ev.links || 0,
            lastAt: ev.time || '',
            lastAtMs: ev.timeMs,
            site: ev.site || '',
            siteId: ev.siteId || ''
          });
        }
      }
      visits = sessions.length;
      interactionClicks = sessions.reduce((n, s) => n + (s.clicks || 0), 0);
      linkClicks = sessions.reduce((n, s) => n + (s.links || 0), 0);
      totalSeconds = sessions.reduce((n, s) => n + (s.seconds || 0), 0);
      const latest = sessions[sessions.length - 1] || {};
      lastAt = latest.lastAt || '';
      lastAtMs = latest.lastAtMs || 0;
      site = latest.site || '';
      siteId = latest.siteId || '';
    }

    items.push({
      key,
      person: evs[0].person,
      project,
      site,
      siteId,
      visits,
      clicks: interactionClicks,
      links: linkClicks,
      totalSeconds,
      lastAt: formatSitesVisitTimeLabel(lastAtMs) || lastAt,
      lastAtMs,
      durationLabel: formatDurationLabel(totalSeconds)
    });
  }

  return items.sort((a, b) => b.lastAtMs - a.lastAtMs || b.clicks - a.clicks || b.links - a.links);
}

function eventFingerprint(ev) {
  return [ev.time, ev.person, ev.project, ev.siteId || '', ev.seconds, ev.clicks || 0, ev.links || 0].join('|');
}

function mergeSitesVisitEvents(localEvents, incoming) {
  const map = new Map();
  for (const ev of [...(localEvents || []), ...(incoming || [])]) {
    map.set(eventFingerprint(ev), ev);
  }
  return [...map.values()].sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0));
}

async function ensureSitesVisitsLogSheet(cfg) {
  if (!sheetsService) throw new Error('請先用 Google 登入');
  if (!cfg.logSpreadsheetId) throw new Error('尚未建立 App 紀錄庫');
  await ensureSitesVisitsSpreadsheetTimezone(cfg.logSpreadsheetId);
  const sheetName = cfg.logSheetName || '瀏覽紀錄';
  const range = quoteSheetRange(sheetName, 'A1:H1');
  const res = await sheetsService.spreadsheets.values.get({
    spreadsheetId: cfg.logSpreadsheetId,
    range
  });
  const row = res.data.values?.[0] || [];
  if (!row.length) {
    await sheetsService.spreadsheets.values.update({
      spreadsheetId: cfg.logSpreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [SITES_VISITS_HEADERS] }
    });
  } else {
    const updates = [];
    if (!row[6] || String(row[6]).replace(/\s+/g, '') !== '點擊數') {
      updates.push({ range: quoteSheetRange(sheetName, 'G1'), values: [['點擊數']] });
    }
    if (!row[7] || String(row[7]).replace(/\s+/g, '') !== '超連結數') {
      updates.push({ range: quoteSheetRange(sheetName, 'H1'), values: [['超連結數']] });
    }
    for (const u of updates) {
      await sheetsService.spreadsheets.values.update({
        spreadsheetId: cfg.logSpreadsheetId,
        range: u.range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: u.values }
      });
    }
  }
  return sheetName;
}

async function ensureSitesVisitsBackend(cfg) {
  if (!sheetsService) throw new Error('請先用 Google 登入');
  if (cfg.logSpreadsheetId) {
    await ensureSitesVisitsLogSheet(cfg);
    return cfg;
  }
  const created = await sheetsService.spreadsheets.create({
    requestBody: {
      properties: {
        title: `LifeTour 網站瀏覽紀錄 ${new Date().toISOString().slice(0, 10)}`,
        timeZone: SITES_VISITS_TIMEZONE,
        locale: 'zh_TW'
      },
      sheets: [{ properties: { title: '瀏覽紀錄' } }]
    }
  });
  cfg.logSpreadsheetId = created.data.spreadsheetId;
  cfg.logSheetName = '瀏覽紀錄';
  cfg.logTimezoneNormalized = true;
  await sheetsService.spreadsheets.values.update({
    spreadsheetId: cfg.logSpreadsheetId,
    range: quoteSheetRange('瀏覽紀錄', 'A1:H1'),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [SITES_VISITS_HEADERS] }
  });
  saveSitesVisitsConfig(cfg);
  return cfg;
}

async function fetchSitesVisitsEventsFromSheet(cfg) {
  const sheetName = await ensureSitesVisitsLogSheet(cfg);
  const res = await sheetsService.spreadsheets.values.get({
    spreadsheetId: cfg.logSpreadsheetId,
    range: quoteSheetRange(sheetName, 'A:H')
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];
  const headers = padSheetRow(rows[0], 8);
  const cols = findSitesVisitsColumns(headers);
  const events = [];
  for (let i = 1; i < rows.length; i++) {
    const values = padSheetRow(rows[i], headers.length);
    const person = normalizeSheetCell(values[cols.person >= 0 ? cols.person : 1]);
    const project = normalizeSheetCell(values[cols.project >= 0 ? cols.project : 2]);
    const site = normalizeSheetCell(values[cols.site >= 0 ? cols.site : 3]);
    const siteId = normalizeSheetCell(values[cols.siteId >= 0 ? cols.siteId : 5]);
    const timeRaw = values[cols.time >= 0 ? cols.time : 0];
    const seconds = parseDurationSeconds(values[cols.seconds >= 0 ? cols.seconds : 4]);
    const clicks = Number(values[cols.clicks >= 0 ? cols.clicks : 6]) || 0;
    const links = Number(values[cols.links >= 0 ? cols.links : 7]) || 0;
    if (!person && !project) continue;
    const timeMs = parseSheetTime(timeRaw);
    events.push({
      person: person || '未知同仁',
      project: project || '未命名專案',
      site,
      siteId,
      time: formatSitesVisitTimeLabel(timeMs) || String(timeRaw || ''),
      timeMs,
      seconds,
      clicks,
      links,
      source: 'sheet'
    });
  }
  return events;
}

async function appendSitesVisitToSheet(cfg, ev) {
  if (!cfg.logSpreadsheetId || !sheetsService) return;
  const sheetName = await ensureSitesVisitsLogSheet(cfg);
  await sheetsService.spreadsheets.values.append({
    spreadsheetId: cfg.logSpreadsheetId,
    range: quoteSheetRange(sheetName, 'A:H'),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        ev.time,
        ev.person,
        ev.project,
        ev.site || '',
        ev.seconds,
        ev.siteId || '',
        ev.clicks || 0,
        ev.links || 0
      ]]
    }
  });
}

function writeSitesVisitIntoApp(ev) {
  const cfg = loadSitesVisitsConfig();
  const store = loadSitesVisitsStore();
  const event = {
    person: ev.person || '未知同仁',
    project: ev.project || '未命名專案',
    site: ev.site || '',
    siteId: ev.siteId || '',
    time: ev.time || formatSitesVisitTimeLabel(Date.now()) || new Date().toLocaleString('zh-TW', {
      timeZone: SITES_VISITS_TIMEZONE,
      hour12: false
    }),
    timeMs: ev.timeMs || Date.now(),
    seconds: Math.max(0, Number(ev.seconds) || 0),
    clicks: Math.max(0, Number(ev.clicks) || 0),
    links: Math.max(0, Number(ev.links) || 0),
    source: ev.source || 'app'
  };
  store.events = mergeSitesVisitEvents(store.events, [event]);
  store.items = aggregateSitesVisits(store.events, cfg.projects);
  store.syncedAt = new Date().toISOString();
  saveSitesVisitsStore(store);
  return store;
}

async function syncSitesVisitsIntoApp(cfg) {
  const store = loadSitesVisitsStore();
  let remote = [];
  if (cfg.logSpreadsheetId && sheetsService) {
    try {
      remote = await fetchSitesVisitsEventsFromSheet(cfg);
    } catch (_) {}
  }
  // 試算表列會被心跳更新時間／秒數；每次同步以試算表為準，避免本機堆出多人幽靈列
  const localOnly = (store.events || []).filter(e => e.source && e.source !== 'sheet');
  store.events = mergeSitesVisitEvents(localOnly, remote);
  store.items = aggregateSitesVisits(store.events, cfg.projects);
  store.syncedAt = new Date().toISOString();
  saveSitesVisitsStore(store);
  return store;
}

ipcMain.handle('sites-visits-get-config', async () => {
  try {
    const cfg = loadSitesVisitsConfig();
    const store = loadSitesVisitsStore();
    const deploy = normalizeSitesDeployWebAppUrl(cfg.deployWebAppUrl || '');
    const primary = cfg.projects[0] || {};
    const siteKey = primary.siteId || primary.siteSlug || '';
    const links = deploy.ok && siteKey
      ? buildSitesTrackLinkUrls(deploy.url, siteKey, {
        label: '測試按鈕',
        targetUrl: 'https://www.google.com',
        logSpreadsheetId: cfg.logSpreadsheetId
      })
      : null;
    return {
      success: true,
      ...cfg,
      deployWebAppUrlValid: deploy.ok,
      trackLinks: links,
      localCount: store.events.length,
      syncedAt: store.syncedAt,
      storePath: sitesVisitsStorePath()
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-save-config', async (event, payload) => {
  try {
    const prev = loadSitesVisitsConfig();
    const cfg = {
      logSpreadsheetId: prev.logSpreadsheetId,
      logSheetName: prev.logSheetName || '瀏覽紀錄',
      deployWebAppUrl: prev.deployWebAppUrl || '',
      projects: Array.isArray(payload?.projects) ? payload.projects : prev.projects,
      erpConnectionString: prev.erpConnectionString || '',
      columnPrefs: prev.columnPrefs
    };
    if (payload?.logUrl || payload?.logSpreadsheetId) {
      const parsed = parseSpreadsheetRef(payload?.logUrl || payload?.logSpreadsheetId || '');
      if (!parsed.spreadsheetId) return { success: false, error: '試算表網址無效' };
      cfg.logSpreadsheetId = parsed.spreadsheetId;
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'deployWebAppUrl')) {
      const raw = String(payload.deployWebAppUrl || '').trim();
      if (!raw) {
        cfg.deployWebAppUrl = '';
      } else {
        const checked = normalizeSitesDeployWebAppUrl(raw);
        if (!checked.ok) return { success: false, error: checked.error };
        cfg.deployWebAppUrl = checked.url;
      }
    }
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'erpConnectionString')) {
      cfg.erpConnectionString = String(payload.erpConnectionString || '').trim();
    }
    saveSitesVisitsConfig(cfg);
    const primary = (cfg.projects || [])[0] || {};
    const siteKey = primary.siteId || primary.siteSlug || '';
    const links = cfg.deployWebAppUrl && siteKey
      ? buildSitesTrackLinkUrls(cfg.deployWebAppUrl, siteKey, {
        label: '測試按鈕',
        targetUrl: 'https://www.google.com',
        logSpreadsheetId: cfg.logSpreadsheetId
      })
      : null;
    return { success: true, ...cfg, trackLinks: links };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-add-project', async (event, payload) => {
  try {
    if (!sheetsService) return { success: false, error: '請先用 Google 登入' };
    const nameInput = String(payload?.name || '').trim();
    const rawId = String(payload?.siteId || payload?.siteUrl || payload?.url || '').trim();
    const parsed = parseGoogleSiteRef(rawId);
    if (!parsed.siteId && !parsed.siteUrl) {
      return { success: false, error: '請輸入 Google Site ID 或 Site 網址' };
    }
    let cfg = loadSitesVisitsConfig();
    cfg = await ensureSitesVisitsBackend(cfg);
    const name = nameInput || parsed.siteId || '未命名 Site';
    if (cfg.projects.some(p => p.siteId && parsed.siteId && p.siteId === parsed.siteId)) {
      return { success: false, error: '這個 Site ID 已加入' };
    }
    if (cfg.projects.some(p => p.name === name)) {
      return { success: false, error: '這個專案名稱已存在' };
    }
    cfg.projects.push({
      id: `site_${Date.now().toString(36)}`,
      name,
      siteId: parsed.siteId,
      pageId: parsed.pageId || '',
      siteSlug: parsed.siteSlug || '',
      siteUrl: parsed.siteUrl || (parsed.siteId ? `https://sites.google.com/d/${parsed.siteId}/view` : '')
    });
    saveSitesVisitsConfig(cfg);
    await syncSitesVisitsIntoApp(cfg);
    return {
      success: true,
      ...cfg,
      trackerScript: sitesVisitsTrackerScript(cfg),
      parsedSiteId: parsed.siteId || '',
      message: parsed.siteId
        ? `已設定。嵌入請用 ?siteId=${parsed.siteId}（/d/ 後面那串，不是 /p/）`
        : (parsed.siteSlug
          ? `已用發布路徑「${parsed.siteSlug}」加入，但同仁追蹤較不穩。請改在編輯畫面複製 /d/ 後面的網站 ID 再加入一次。`
          : '已加入。請改貼編輯網址（含 /d/網站ID）以便對應專案')
    };
  } catch (err) {
    return { success: false, ...explainSheetsError(err) };
  }
});

ipcMain.handle('sites-visits-remove-project', async (event, id) => {
  try {
    const cfg = loadSitesVisitsConfig();
    cfg.projects = cfg.projects.filter(p => p.id !== id);
    saveSitesVisitsConfig(cfg);
    return { success: true, ...cfg };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-tracker-script', async () => {
  try {
    let cfg = loadSitesVisitsConfig();
    if (!sheetsService) {
      return { success: false, error: '請先用 Google 登入，才能建立／讀取紀錄試算表' };
    }
    cfg = await ensureSitesVisitsBackend(cfg);
    if (!cfg.logSpreadsheetId) {
      return { success: false, error: '尚無紀錄試算表 ID，請先加入一個 Site 專案以建立紀錄庫' };
    }
    const script = sitesVisitsTrackerScript(cfg);
    const logLine = `var LOG_SHEET_ID = '${cfg.logSpreadsheetId}'`;
    if (!script.includes(logLine)) {
      return { success: false, error: '產生程式失敗：試算表 ID 未寫入，請重試' };
    }
    const primary = cfg.projects[0] || {};
    const siteKey = primary.siteId || primary.siteSlug || '';
    const deploy = normalizeSitesDeployWebAppUrl(cfg.deployWebAppUrl || '');
    const links = deploy.ok && siteKey
      ? buildSitesTrackLinkUrls(deploy.url, siteKey, {
        label: '測試按鈕',
        targetUrl: 'https://www.google.com',
        logSpreadsheetId: cfg.logSpreadsheetId
      })
      : null;
    return {
      success: true,
      script,
      logSpreadsheetId: cfg.logSpreadsheetId,
      logSheetUrl: `https://docs.google.com/spreadsheets/d/${cfg.logSpreadsheetId}/edit`,
      deployWebAppUrl: cfg.deployWebAppUrl || '',
      trackLinks: links,
      siteKey
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-export-tracker', async () => {
  try {
    let cfg = loadSitesVisitsConfig();
    if (!sheetsService) {
      return { success: false, error: '請先用 Google 登入' };
    }
    cfg = await ensureSitesVisitsBackend(cfg);
    if (!cfg.logSpreadsheetId) {
      return { success: false, error: '尚無紀錄試算表 ID' };
    }
    const script = sitesVisitsTrackerScript(cfg);
    const outDir = app.getPath('desktop');
    const outPath = path.join(outDir, 'LifeTour-Sites-Tracker.gs');
    fs.writeFileSync(outPath, script, 'utf8');
    await shell.openPath(outPath);
    return {
      success: true,
      path: outPath,
      logSpreadsheetId: cfg.logSpreadsheetId,
      message: `已存到桌面：LifeTour-Sites-Tracker.gs（請整份貼到 script.google.com）`
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-open-log-sheet', async () => {
  try {
    let cfg = loadSitesVisitsConfig();
    if (!cfg.logSpreadsheetId && sheetsService) {
      cfg = await ensureSitesVisitsBackend(cfg);
    }
    if (!cfg.logSpreadsheetId) {
      return { success: false, error: '尚無紀錄試算表，請先加入專案' };
    }
    await shell.openExternal(`https://docs.google.com/spreadsheets/d/${cfg.logSpreadsheetId}/edit`);
    return {
      success: true,
      logSpreadsheetId: cfg.logSpreadsheetId,
      logSheetUrl: `https://docs.google.com/spreadsheets/d/${cfg.logSpreadsheetId}/edit`
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-build-links', async (event, payload) => {
  try {
    const cfg = loadSitesVisitsConfig();
    const checked = normalizeSitesDeployWebAppUrl(payload?.deployWebAppUrl || cfg.deployWebAppUrl || '');
    if (!checked.ok) return { success: false, error: checked.error };
    const project = cfg.projects.find(p => p.id === payload?.projectId)
      || cfg.projects.find(p => p.siteId && p.siteId === payload?.siteId)
      || cfg.projects[0];
    const siteKey = String(payload?.siteId || project?.siteId || project?.siteSlug || '').trim();
    if (!siteKey) return { success: false, error: '請先加入專案（建議貼 /d/ 後面的網站 ID）' };
    const links = buildSitesTrackLinkUrls(checked.url, siteKey, {
      label: payload?.label || '按鈕',
      targetUrl: payload?.targetUrl || 'https://www.google.com',
      logSpreadsheetId: cfg.logSpreadsheetId || payload?.logSpreadsheetId || ''
    });
    return { success: true, deployWebAppUrl: checked.url, siteKey, links };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-record', async (event, payload) => {
  try {
    const cfg = loadSitesVisitsConfig();
    const project = cfg.projects.find(p =>
      p.id === payload?.projectId
      || p.siteId === payload?.siteId
      || p.name === payload?.project
    );
    const person = String(payload?.person || cache.myEmail || '本機使用者').trim();
    const ev = {
      person,
      project: project?.name || payload?.project || '未命名專案',
      site: project?.siteUrl || payload?.site || '',
      siteId: project?.siteId || payload?.siteId || '',
      time: new Date().toLocaleString('zh-TW', { hour12: false }),
      timeMs: Date.now(),
      seconds: Math.max(1, Number(payload?.seconds) || 0),
      source: 'app'
    };
    const store = writeSitesVisitIntoApp(ev);
    try { await appendSitesVisitToSheet(cfg, ev); } catch (_) {}
    return { success: true, items: store.items, localCount: store.events.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-open-track', async (event, projectId) => {
  try {
    const cfg = loadSitesVisitsConfig();
    const project = cfg.projects.find(p => p.id === projectId);
    if (!project?.siteUrl) return { success: false, error: '找不到此 Site' };
    const started = Date.now();
    const child = new BrowserWindow({
      parent: win || undefined,
      width: 1200,
      height: 800,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    await child.loadURL(project.siteUrl);
    await new Promise(resolve => {
      child.on('closed', resolve);
    });
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    const person = cache.myEmail || '本機使用者';
    const ev = {
      person,
      project: project.name,
      site: project.siteUrl,
      siteId: project.siteId || '',
      time: new Date().toLocaleString('zh-TW', { hour12: false }),
      timeMs: Date.now(),
      seconds,
      source: 'app'
    };
    const store = writeSitesVisitIntoApp(ev);
    try { await appendSitesVisitToSheet(cfg, ev); } catch (_) {}
    return { success: true, seconds, items: store.items };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-clear-local', async () => {
  try {
    saveSitesVisitsStore({ events: [], items: [], syncedAt: '' });
    const cfg = loadSitesVisitsConfig();
    if (cfg.logSpreadsheetId && sheetsService) {
      try { await syncSitesVisitsIntoApp(cfg); } catch (_) {}
    }
    const store = loadSitesVisitsStore();
    return {
      success: true,
      localCount: store.events.length,
      items: store.items,
      message: '已清除本機快取並重新同步試算表'
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-report', async (event, payload) => {
  try {
    const cfg = loadSitesVisitsConfig();
    if (!cfg.projects.length) {
      return {
        success: false,
        needsSetup: true,
        error: '請先在設定輸入 Google Site ID 並加入專案'
      };
    }
    if (sheetsService && cfg.logSpreadsheetId) {
      try { await syncSitesVisitsIntoApp(cfg); } catch (_) {}
    } else if (sheetsService && !cfg.logSpreadsheetId) {
      try {
        const ready = await ensureSitesVisitsBackend(cfg);
        await syncSitesVisitsIntoApp(ready);
      } catch (_) {}
    }
    const store = loadSitesVisitsStore();
    store.items = aggregateSitesVisits(store.events, cfg.projects);
    saveSitesVisitsStore(store);
    const projectFilter = String(payload?.project || '').trim();
    const items = projectFilter
      ? store.items.filter(i =>
        i.project === projectFilter
        || cfg.projects.some(p => p.name === projectFilter && p.siteId && p.siteId === i.siteId)
      )
      : store.items;
    const enriched = await enrichSitesVisitsReportItems(items, cfg);
    const reportItems = enriched.items;
    const totalVisits = reportItems.reduce((n, i) => n + (i.visits || 0), 0);
    const totalClicks = reportItems.reduce((n, i) => n + (i.clicks || 0), 0);
    const totalLinks = reportItems.reduce((n, i) => n + (i.links || 0), 0);
    return {
      success: true,
      items: reportItems,
      projects: cfg.projects,
      localCount: store.events.length,
      syncedAt: store.syncedAt,
      storedInApp: true,
      totalVisits,
      totalClicks,
      totalLinks,
      totalSeconds: reportItems.reduce((n, i) => n + i.totalSeconds, 0),
      durationLabel: formatDurationLabel(reportItems.reduce((n, i) => n + i.totalSeconds, 0)),
      columns: sitesVisitsEnrich.SITES_VISITS_COLUMN_DEFS,
      columnPrefs: cfg.columnPrefs,
      erpEnriched: enriched.erpEnriched,
      erpError: enriched.erpError || ''
    };
  } catch (err) {
    return { success: false, ...explainSheetsError(err) };
  }
});

ipcMain.handle('sites-visits-save-column-prefs', async (event, payload) => {
  try {
    const cfg = loadSitesVisitsConfig();
    const columnPrefs = sitesVisitsEnrich.normalizeColumnPrefs(payload?.columnPrefs);
    saveSitesVisitsConfig({ ...cfg, columnPrefs });
    return { success: true, columnPrefs };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-export-excel', async (event, payload) => {
  try {
    const cfg = loadSitesVisitsConfig();
    if (!cfg.projects.length) {
      return { success: false, error: '請先在設定輸入 Google Site ID 並加入專案' };
    }
    const projectFilter = String(payload?.project || '').trim();
    const store = loadSitesVisitsStore();
    store.items = aggregateSitesVisits(store.events, cfg.projects);
    const items = projectFilter
      ? store.items.filter(i =>
        i.project === projectFilter
        || cfg.projects.some(p => p.name === projectFilter && p.siteId && p.siteId === i.siteId)
      )
      : store.items;
    const enriched = await enrichSitesVisitsReportItems(items, cfg);
    const reportItems = enriched.items;
    const columnPrefs = sitesVisitsEnrich.normalizeColumnPrefs(
      payload?.columnPrefs || cfg.columnPrefs
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `網站瀏覽紀錄-${stamp}.xlsx`;
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : undefined, {
      title: '輸出 Excel',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (picked.canceled || !picked.filePath) {
      return { success: false, canceled: true };
    }
    sitesVisitsEnrich.writeSitesVisitsExcel(picked.filePath, reportItems, columnPrefs);
    await shell.openPath(picked.filePath);
    return { success: true, path: picked.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-dept-org-open', async () => {
  try {
    if (sitesDeptOrgWin && !sitesDeptOrgWin.isDestroyed()) {
      if (sitesDeptOrgWin.isMinimized()) sitesDeptOrgWin.restore();
      sitesDeptOrgWin.show();
      sitesDeptOrgWin.focus();
      return { success: true, reused: true };
    }
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.workAreaSize;
    sitesDeptOrgWin = new BrowserWindow({
      width,
      height,
      x: display.workArea.x,
      y: display.workArea.y,
      title: '部門組織',
      autoHideMenuBar: true,
      backgroundColor: '#f0f2f5',
      webPreferences: {
        preload: path.join(APP_ROOT, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    sitesDeptOrgWin.setMenuBarVisibility(false);
    sitesDeptOrgWin.on('closed', () => { sitesDeptOrgWin = null; });
    await sitesDeptOrgWin.loadFile(path.join(APP_ROOT, 'sites-dept-org.html'));
    sitesDeptOrgWin.maximize();
    sitesDeptOrgWin.show();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-dept-org-get', async () => {
  try {
    const cfg = loadSitesVisitsConfig();
    const connectionString = resolveSitesVisitsErpConnectionString(cfg);
    const flat = await sitesVisitsEnrich.fetchDeptOrgList(connectionString);
    const tree = sitesVisitsEnrich.buildDeptOrgTree(flat);
    return {
      success: true,
      rootId: sitesVisitsEnrich.DEPT_ROOT_ID,
      flat,
      tree
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sites-visits-dept-org-move', async (_event, payload) => {
  try {
    const deptId = String(payload?.deptId || '').trim();
    const newParentId = String(payload?.newParentId || sitesVisitsEnrich.DEPT_ROOT_ID).trim();
    if (!deptId) return { success: false, error: '缺少部門 ID' };
    const cfg = loadSitesVisitsConfig();
    const connectionString = resolveSitesVisitsErpConnectionString(cfg);
    const flat = await sitesVisitsEnrich.fetchDeptOrgList(connectionString);
    if (sitesVisitsEnrich.wouldCreateDeptCycle(flat, deptId, newParentId)) {
      return { success: false, error: '無法移動：會造成循環階層' };
    }
    await sitesVisitsEnrich.updateDeptParent(connectionString, deptId, newParentId);
    const nextFlat = await sitesVisitsEnrich.fetchDeptOrgList(connectionString);
    return {
      success: true,
      tree: sitesVisitsEnrich.buildDeptOrgTree(nextFlat),
      flat: nextFlat
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

async function captureDeptOrgHtmlToPng(htmlContent, filePath) {
  const tmpPath = path.join(app.getPath('temp'), `dept-org-export-${Date.now()}.html`);
  fs.writeFileSync(tmpPath, htmlContent, 'utf8');
  const capWin = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  try {
    await capWin.loadFile(tmpPath);
    await capWin.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
    );
    const size = await capWin.webContents.executeJavaScript(`({
      width: Math.max(800, Math.ceil(document.documentElement.scrollWidth)),
      height: Math.max(600, Math.ceil(document.documentElement.scrollHeight))
    })`);
    const w = Math.min(size.width, 16384);
    const h = Math.min(size.height, 16384);
    capWin.setContentSize(w, h);
    await new Promise((r) => setTimeout(r, 400));
    const image = await capWin.webContents.capturePage();
    fs.writeFileSync(filePath, image.toPNG());
  } finally {
    if (!capWin.isDestroyed()) capWin.destroy();
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

ipcMain.handle('sites-visits-dept-org-export', async (event, payload) => {
  try {
    const format = String(payload?.format || 'html').toLowerCase();
    let tree = payload?.tree;
    let flat = payload?.flat;
    const cfg = loadSitesVisitsConfig();
    const connectionString = resolveSitesVisitsErpConnectionString(cfg);
    if (!Array.isArray(flat) || !flat.length) {
      flat = await sitesVisitsEnrich.fetchDeptOrgList(connectionString);
    }
    if (!Array.isArray(tree) || !tree.length) {
      tree = sitesVisitsEnrich.buildDeptOrgTree(flat);
    }
    const exportedAt = new Date().toLocaleString('zh-TW', { hour12: false });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const formatMeta = {
      html: { ext: 'html', label: 'HTML 網頁', filters: [{ name: 'HTML 網頁', extensions: ['html'] }] },
      png: { ext: 'png', label: 'PNG 圖片', filters: [{ name: 'PNG 圖片', extensions: ['png'] }] },
      json: { ext: 'json', label: 'JSON 資料', filters: [{ name: 'JSON 資料', extensions: ['json'] }] },
      excel: { ext: 'xlsx', label: 'Excel 清單', filters: [{ name: 'Excel', extensions: ['xlsx'] }] }
    };
    const meta = formatMeta[format] || formatMeta.html;
    const defaultName = `部門組織-${stamp}.${meta.ext}`;
    const parentWin = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showSaveDialog(
      parentWin && !parentWin.isDestroyed() ? parentWin : undefined,
      {
        title: `輸出部門組織 — ${meta.label}`,
        defaultPath: path.join(app.getPath('documents'), defaultName),
        filters: meta.filters
      }
    );
    if (picked.canceled || !picked.filePath) {
      return { success: false, canceled: true };
    }
    const exportPayload = {
      tree,
      flat,
      rootId: sitesVisitsEnrich.DEPT_ROOT_ID,
      exportedAt,
      zoom: payload?.zoom
    };
    if (format === 'html') {
      fs.writeFileSync(
        picked.filePath,
        sitesVisitsEnrich.buildDeptOrgExportHtml(exportPayload),
        'utf8'
      );
    } else if (format === 'json') {
      fs.writeFileSync(
        picked.filePath,
        sitesVisitsEnrich.buildDeptOrgExportJson(exportPayload),
        'utf8'
      );
    } else if (format === 'excel') {
      sitesVisitsEnrich.writeDeptOrgExcel(picked.filePath, flat);
    } else if (format === 'png') {
      const html = sitesVisitsEnrich.buildDeptOrgExportHtml({ ...exportPayload, zoom: 1 });
      await captureDeptOrgHtmlToPng(html, picked.filePath);
    } else {
      return { success: false, error: `不支援的格式：${format}` };
    }
    await shell.openPath(picked.filePath);
    return { success: true, path: picked.filePath, format };
  } catch (err) {
    return { success: false, error: err.message };
  }
});


// ========== 【MODULE: modules/notes】記事 ==========
try {
  const { registerNotesModule } = require('./modules/notes/register');
  registerNotesModule({
    ipcMain,
    app,
    path,
    fs,
    getSheetsService: () => sheetsService,
    getDriveService: () => driveService,
    withGoogleApiRetry,
    grantedScopeText,
    hasSheetsScope,
    hasDriveFileScope,
    quoteSheetRange,
    resolveMyEmail: ensureMyEmailForBugReport
  });
} catch (err) {
  console.error('[notes] register failed', err);
}

const GMAIL_LABEL_NAMES = {
  CATEGORY_PERSONAL: '主要',
  CATEGORY_SOCIAL: '社交',
  CATEGORY_PROMOTIONS: '促銷',
  CATEGORY_UPDATES: '最新消息',
  CATEGORY_FORUMS: '論壇',
  IMPORTANT: '重要',
  STARRED: '已加星號'
};
const GMAIL_SKIP_LABELS = new Set([
  'UNREAD', 'INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT', 'YELLOW_STAR'
]);

// Calendar APIs：列出使用者所有日曆，並依日曆分組回傳行程

// ========== 【MODULE: modules/calendar】Calendar ==========
ipcMain.handle('get-calendar', async () => {
  try {
    const calList = await withGoogleApiRetry(() => calendarService.calendarList.list({ maxResults: 250 }));
    const calendars = (calList.data.items || []).filter(c => c.hidden !== true);
    const timeMin = new Date().toISOString();
    const writable = [];
    const groups = [];

    await Promise.all(calendars.map(async (cal) => {
      if (['owner', 'writer'].includes(cal.accessRole)) {
        writable.push({
          id: cal.id,
          name: cal.summaryOverride || cal.summary || '未命名日曆',
          color: cal.backgroundColor || '#2563eb',
          primary: !!cal.primary
        });
      }
      try {
        const res = await withGoogleApiRetry(() => calendarService.events.list({
          calendarId: cal.id,
          timeMin,
          maxResults: cal.primary ? 12 : 8,
          singleEvents: true,
          orderBy: 'startTime'
        }));
        const events = (res.data.items || []).map(e => ({
          id: e.id,
          summary: e.summary,
          description: e.description,
          location: e.location,
          start: e.start,
          end: e.end,
          htmlLink: e.htmlLink,
          hangoutLink: e.hangoutLink || null,
          conferenceData: e.conferenceData || null,
          meetingUrl: extractMeetingUrl(e),
          calendarId: cal.id,
          calendarName: cal.summaryOverride || cal.summary || '未命名日曆',
          calendarColor: cal.backgroundColor || '#2563eb'
        }));
        if (events.length === 0 && !cal.primary) return;
        groups.push({
          id: cal.id,
          name: cal.summaryOverride || cal.summary || '未命名日曆',
          color: cal.backgroundColor || '#2563eb',
          primary: !!cal.primary,
          events
        });
      } catch (err) {
        console.error('讀取日曆失敗:', cal.id, err.message);
      }
    }));

    groups.sort((a, b) => {
      if (a.primary && !b.primary) return -1;
      if (!a.primary && b.primary) return 1;
      return a.name.localeCompare(b.name, 'zh-Hant');
    });
    writable.sort((a, b) => {
      if (a.primary && !b.primary) return -1;
      if (!a.primary && b.primary) return 1;
      return a.name.localeCompare(b.name, 'zh-Hant');
    });

    return { success: true, groups, calendars: writable };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ✨ 新增：建立日曆行程的 API
ipcMain.handle('calendar:createEvent', async (event, eventDetails) => {
  if (!oauth2Client) throw new Error('尚未授權 Google 帳號');
  
  try {
    const res = await withGoogleApiRetry(() => calendarService.events.insert({
      calendarId: eventDetails.calendarId || 'primary',
      requestBody: {
        summary: eventDetails.summary,
        description: eventDetails.description,
        location: eventDetails.location,
        start: {
          dateTime: eventDetails.startDateTime,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        end: {
          dateTime: eventDetails.endDateTime,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      },
    }));
    return { success: true, data: res.data };
  } catch (error) {
    console.error('建立行程失敗:', error);
    return { success: false, error: error.message };
  }
});


function parseAddresses(raw) {
  if (!raw) return [];
  const result = [];
  const re = /(?:"([^"]*)"|([^,<]*?))?\s*<([^>]+)>|([^\s,;]+@[^\s,;]+)/g;
  let m;
  while ((m = re.exec(raw))) {
    const email = (m[3] || m[4] || '').trim();
    const name = (m[1] || m[2] || '').trim();
    if (email && !result.some(p => p.email.toLowerCase() === email.toLowerCase())) {
      result.push({ name, email });
    }
  }
  return result;
}

function toAddrList(list) {
  return (Array.isArray(list) ? list : []).map(item => {
    if (typeof item === 'string') return item.trim();
    if (item?.email) return item.email.trim();
    return '';
  }).filter(Boolean);
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelNameMap() {
  const map = {};
  (cache.allLabels || []).forEach(l => { map[l.id] = GMAIL_LABEL_NAMES[l.id] || l.name; });
  return map;
}

function tagsFromLabelIds(labelIds, map) {
  return (labelIds || [])
    .filter(id => !['UNREAD', 'INBOX'].includes(id) && (GMAIL_LABEL_NAMES[id] || !GMAIL_SKIP_LABELS.has(id)))
    .map(id => ({ id, name: map[id] || id }));
}

function rebuildDisplayLabels() {
  // [Important] 僅顯示 Gmail 側欄的自訂標籤（不含促銷／社交等系統分類）
  cache.labels = (cache.allLabels || [])
    .filter(l => l.type === 'user')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
    .map(l => ({
      id: l.id,
      name: l.name,
      type: 'user',
      unreadCount: Number(l.messagesUnread) || 0
    }));
}

async function fetchMessageMeta(id, map) {
  const detail = await withGoogleApiRetry(() => gmailService.users.messages.get({
    userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From']
  }));
  const headers = detail.data.payload.headers;
  const labelIds = detail.data.labelIds || [];
  return {
    id,
    subject: headers.find(h => h.name === 'Subject')?.value || '無主旨',
    from: (headers.find(h => h.name === 'From')?.value || '未知').split('<')[0].trim(),
    snippet: detail.data.snippet || '無預覽',
    labelIds,
    isUnread: labelIds.includes('UNREAD'),
    isImportant: labelIds.includes('IMPORTANT'),
    inInbox: labelIds.includes('INBOX'),
    tags: tagsFromLabelIds(labelIds, map)
  };
}

async function fetchMessageDetail(msgId) {
  const res = await withGoogleApiRetry(() => gmailService.users.messages.get({ userId: 'me', id: msgId, format: 'full' }));
  const headers = res.data.payload.headers;
  const header = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  const subject = header('Subject') || '無主旨';
  const from = header('From') || '未知';
  const to = header('To');
  const cc = header('Cc');
  const replyTo = header('Reply-To') || from;
  const fromParsed = parseAddresses(from)[0] || { name: from, email: '' };
  const replyToParsed = parseAddresses(replyTo)[0] || fromParsed;
  function decodeBase64(data) { return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'); }
  let htmlBody = ''; let plainBody = '';
  function parseParts(part) {
    if (part.mimeType === 'text/html' && part.body && part.body.data) htmlBody = decodeBase64(part.body.data);
    else if (part.mimeType === 'text/plain' && part.body && part.body.data) plainBody = decodeBase64(part.body.data);
    if (part.parts) for (let p of part.parts) parseParts(p);
  }
  parseParts(res.data.payload);
  return {
    id: msgId,
    threadId: res.data.threadId,
    subject,
    from,
    fromParsed,
    replyTo,
    replyToParsed,
    toParsed: parseAddresses(to),
    ccParsed: parseAddresses(cc),
    myEmail: cache.myEmail,
    messageIdHeader: header('Message-ID'),
    isHtml: !!htmlBody,
    body: htmlBody || plainBody || res.data.snippet
  };
}

async function sendQueuedReply(payload) {
  const { subject, threadId, messageIdHeader, html, text, replyTo } = payload;
  const toList = toAddrList(payload.to?.length ? payload.to : [replyTo]);
  const ccList = toAddrList(payload.cc);
  const bccList = toAddrList(payload.bcc);
  if (!toList.length) throw new Error('請至少填寫一位收件人');

  const replySubject = /^(re:|回覆:)/i.test(subject || '') ? subject : `Re: ${subject || ''}`;
  const boundary = `mix_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const plain = (text && String(text).trim()) || stripHtml(html) || '(無內容)';
  const htmlBody = html && String(html).trim()
    ? `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#333;">${html}</div>`
    : `<pre style="font-family:sans-serif;white-space:pre-wrap;">${plain}</pre>`;

  const lines = [
    `To: ${toList.join(', ')}`,
    ccList.length ? `Cc: ${ccList.join(', ')}` : null,
    bccList.length ? `Bcc: ${bccList.join(', ')}` : null,
    `Subject: =?utf-8?B?${Buffer.from(replySubject).toString('base64')}?=`,
    messageIdHeader ? `In-Reply-To: ${messageIdHeader}` : null,
    messageIdHeader ? `References: ${messageIdHeader}` : null,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(plain, 'utf8').toString('base64'),
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(htmlBody, 'utf8').toString('base64'),
    `--${boundary}--`
  ].filter(line => line !== null);

  const encodedEmail = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await withGoogleApiRetry(() => gmailService.users.messages.send({
    userId: 'me', requestBody: { raw: encodedEmail, threadId }
  }));
}

async function flushPending() {
  const readIds = [...pending.markRead];
  if (readIds.length) {
    try {
      await withGoogleApiRetry(() => gmailService.users.messages.batchModify({
        userId: 'me',
        requestBody: { ids: readIds, removeLabelIds: ['UNREAD'] }
      }));
      readIds.forEach(id => pending.markRead.delete(id));
    } catch (err) {
      console.error('批次已讀失敗:', err.message);
    }
  }

  const replies = pending.replies.splice(0);
  for (const payload of replies) {
    try {
      await sendQueuedReply(payload);
    } catch (err) {
      console.error('佇列寄信失敗:', err.message);
      pending.replies.push(payload);
    }
  }
}

/** 分頁撈取未讀 id：收件匣 + 各自訂標籤（對齊 Gmail 側欄未讀計數） */
async function listGmailUnreadIds() {
  const idSet = new Set();
  const HARD_CAP = 500;

  const pullIds = async (params) => {
    let pageToken = '';
    do {
      const res = await withGoogleApiRetry(() => gmailService.users.messages.list({
        userId: 'me',
        maxResults: 100,
        pageToken: pageToken || undefined,
        ...params
      }));
      for (const m of res.data.messages || []) {
        if (m?.id) idSet.add(m.id);
        if (idSet.size >= HARD_CAP) return;
      }
      pageToken = idSet.size >= HARD_CAP ? '' : (res.data.nextPageToken || '');
    } while (pageToken);
  };

  await pullIds({ q: 'in:inbox is:unread' });

  const userLabels = (cache.allLabels || []).filter(l => l.type === 'user');
  for (const label of userLabels) {
    if (idSet.size >= HARD_CAP) break;
    if ((label.messagesUnread || 0) <= 0) continue;
    await pullIds({ labelIds: [label.id], q: 'is:unread' });
  }

  return [...idSet];
}

async function refreshGmailList() {
  const labelsRes = await withGoogleApiRetry(() => gmailService.users.labels.list({ userId: 'me' }));
  cache.allLabels = labelsRes.data.labels || [];
  const map = labelNameMap();

  const ids = await listGmailUnreadIds();
  const oldMap = new Map(cache.emails.map(e => [e.id, e]));
  const next = [];
  const missing = [];

  ids.forEach(id => {
    if (pending.markRead.has(id)) return;
    if (oldMap.has(id)) next.push(oldMap.get(id));
    else missing.push(id);
  });

  for (let i = 0; i < missing.length; i += 8) {
    const chunk = missing.slice(i, i + 8);
    const fetched = await Promise.all(chunk.map(id => fetchMessageMeta(id, map).catch(() => null)));
    fetched.filter(Boolean).forEach(item => next.push(item));
  }

  const order = new Map(ids.map((id, idx) => [id, idx]));
  next.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  cache.emails = next;
  rebuildDisplayLabels();
}

async function refreshContacts() {
  if (!peopleService) return;
  const contacts = [];
  const seen = new Set();
  const addPerson = (person, source) => {
    const emails = (person.emailAddresses || []).map(e => e.value).filter(Boolean);
    const name = person.names?.[0]?.displayName || '';
    const org = person.organizations?.[0]?.name || person.organizations?.[0]?.department || '';
    const label = name || emails[0] || '';
    if (label) {
      const pretty = org && name && !name.includes(org) ? `${org}_${name}` : label;
      ingestDirectoryPerson(person, pretty);
    }
    emails.forEach(email => {
      const key = email.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      contacts.push({ name: name || email.split('@')[0], email, org, source });
    });
  };

  async function paginate(fn, listKey, source) {
    let pageToken;
    do {
      const res = await fn(pageToken);
      (res.data[listKey] || []).forEach(p => addPerson(p, source));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  try {
    await paginate(
      (pageToken) => peopleService.people.listDirectoryPeople({
        readMask: 'names,emailAddresses,organizations,metadata',
        sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
        pageSize: 1000,
        pageToken
      }),
      'people',
      'directory'
    );
  } catch (err) {
    // 一般員工若網域未開通訊錄分享會失敗，不刷屏
    if (!/Not Authorized|403|forbidden/i.test(String(err?.message || ''))) {
      console.error('機構目錄讀取失敗（可能不是 Workspace 或尚未開啟 People API）:', err.message);
    }
    try {
      await paginate(
        (pageToken) => peopleService.people.listDirectoryPeople({
          readMask: 'names,emailAddresses,organizations',
          sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
          pageSize: 1000,
          pageToken
        }),
        'people',
        'directory'
      );
    } catch (err2) {
      if (!/Not Authorized|403|forbidden/i.test(String(err2?.message || ''))) {
        console.error('機構目錄備援讀取失敗:', err2.message);
      }
    }
  }

  try {
    await paginate(
      (pageToken) => peopleService.people.connections.list({
        resourceName: 'people/me',
        personFields: 'names,emailAddresses,organizations,metadata',
        pageSize: 1000,
        pageToken
      }),
      'connections',
      'contacts'
    );
  } catch (err) {
    // Sync quota exceeded：Google 聯絡人同步配額，稍後會自動恢復，不必一直刷 CMD
    if (!/Sync quota exceeded|RESOURCE_EXHAUSTED|429|quota/i.test(String(err?.message || ''))) {
      console.error('聯絡人讀取失敗:', err.message);
    }
  }

  try {
    await paginate(
      (pageToken) => peopleService.otherContacts.list({
        readMask: 'names,emailAddresses',
        pageSize: 1000,
        pageToken
      }),
      'otherContacts',
      'other'
    );
  } catch (err) {
    if (!/Sync quota exceeded|RESOURCE_EXHAUSTED|429|quota/i.test(String(err?.message || ''))) {
      console.error('其他聯絡人讀取失敗:', err.message);
    }
  }

  contacts.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'zh-Hant'));
  cache.contacts = contacts;
}

async function prefetchDetails() {
  const targets = cache.emails.filter(e => !cache.details[e.id]).slice(0, 4);
  for (const item of targets) {
    try {
      cache.details[item.id] = await fetchMessageDetail(item.id);
    } catch (err) {
      console.error('預取信件失敗:', item.id, err.message);
    }
  }
}

async function runSync() {
  if (!gmailService || cache.syncing) return;
  cache.syncing = true;
  notifyRenderer();
  try {
    if (!cache.myEmail) {
      try {
        const profile = await withGoogleApiRetry(() => gmailService.users.getProfile({ userId: 'me' }));
        cache.myEmail = profile.data.emailAddress || '';
      } catch (_) {}
    }
    await flushPending();
    await refreshGmailList();
    // 聯絡人同步配額很緊，改約 10 分鐘才重抓一次，避免 Sync quota exceeded
    const contactsAge = Date.now() - (cache.contactsSyncedAt || 0);
    if (!cache.contacts?.length || contactsAge > 10 * 60 * 1000) {
      await refreshContacts();
      cache.contactsSyncedAt = Date.now();
    }
    await prefetchDetails();
    cache.lastSync = Date.now();
    saveDiskPacket();
  } catch (err) {
    // Sync quota exceeded 多半來自 People 聯絡人同步，略過不刷屏
    if (!/Sync quota exceeded|RESOURCE_EXHAUSTED|429|Insufficient Permission|permission|403|401/i.test(String(err?.message || ''))) {
      console.error('同步封包失敗:', err.message);
    }
  } finally {
    cache.syncing = false;
    notifyRenderer();
  }
}


// ========== 【MODULE: modules/gmail】Gmail IPC ==========
ipcMain.handle('get-gmail', async (event, labelId) => packetSnapshot(labelId));
ipcMain.handle('get-contacts', async () => ({ success: true, contacts: cache.contacts }));

ipcMain.handle('get-gmail-detail', async (event, msgId) => {
  try {
    if (cache.details[msgId]) return { success: true, detail: cache.details[msgId], cached: true };
    const detail = await fetchMessageDetail(msgId);
    cache.details[msgId] = detail;
    return { success: true, detail };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('reply-gmail', async (event, payload) => {
  const toList = toAddrList(payload.to?.length ? payload.to : [payload.replyTo]);
  if (!toList.length) return { success: false, error: '請至少填寫一位收件人' };
  pending.replies.push(payload);
  saveDiskPacket();
  notifyRenderer();
  return { success: true, queued: true };
});

ipcMain.handle('mark-gmail-read', async (event, msgId) => {
  pending.markRead.add(msgId);
  cache.emails = cache.emails.filter(e => e.id !== msgId);
  rebuildDisplayLabels();
  saveDiskPacket();
  notifyRenderer();
  return { success: true, queued: true };
});

function explainChatError(err) {
  const status = err?.code || err?.status || err?.response?.status;
  const msg = googleErrText(err);
  const blob = `${status || ''} ${msg}`;
  if (/Chat app not found|configure the app in the Google Cloud console/i.test(blob)) {
    return {
      needsChatApp: true,
      setupUrl: chatAppConfigUrl(),
      error: '還不能傳送訊息：Google Cloud 專案尚未「設定 Chat 應用程式」。\n\n請在 Configuration 頁只做這些：\n1) App name（例如 LifeTour）\n2) Avatar URL：https://developers.google.com/chat/images/quickstart-app-avatar.png\n3) Description（隨便寫一句）\n4) 「互動功能／Interactive features」請關閉（不要選 HTTP、不要填任何端點網址）\n5) 儲存後回 App 重試送出。\n\n那些 HTTP 端點是給 Chat 機器人用的，本 App 用不到。'
    };
  }
  if (/has not been used|is disabled|access not configured|API has not been/i.test(blob)) {
    return {
      needsApi: true,
      setupUrl: chatApiEnableUrl(),
      error: 'Google Cloud 專案尚未啟用 Google Chat API。請到設定開啟啟用頁，按「啟用／ENABLE」，約一分鐘後再授權。'
    };
  }
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication|insufficient.?permission|Request had insufficient/i.test(blob)) {
    return {
      featureScopeMissing: true,
      needsAuth: true,
      authStatus: AUTH_STATUS.FEATURE_SCOPE_MISSING,
      error: '目前登入還沒有 Google Chat 權限，請允許「查看、傳送 Chat 訊息」與「讀取狀態」。'
    };
  }
  if (status === 401) {
    return {
      authRevoked: true,
      authStatus: AUTH_STATUS.AUTH_REVOKED,
      error: '登入已過期，請重新連結 Google 帳號。'
    };
  }
  return { error: msg };
}

function scrubBadGchatUserNames(map) {
  const next = { ...(map || {}) };
  for (const [key, value] of Object.entries(next)) {
    const v = String(value || '');
    if (!v || v === '成員' || v === '未知' || v.startsWith('使用者 ')) {
      delete next[key];
    }
  }
  return next;
}

/** 依 canonical key 合併同一人多個 resource 的標籤，統一為最詳細姓名 */
function scrubGchatUserNamesByPerson(map) {
  const next = { ...(map || {}) };
  const groups = new Map();
  for (const [resource, label] of Object.entries(next)) {
    const key = canonicalGchatPersonKey(resource, label);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ resource, label });
  }
  for (const entries of groups.values()) {
    const richest = entries.reduce(
      (best, e) => pickRicherGchatLabel(best, e.label),
      ''
    );
    if (!richest) continue;
    for (const e of entries) {
      next[e.resource] = richest;
    }
  }
  return next;
}

function loadGchatDisk() {
  loadCustomEmojiRegistry();
  try {
    if (!fs.existsSync(gchatPacketPath())) return;
    const data = JSON.parse(fs.readFileSync(gchatPacketPath(), 'utf8'));
    gchatCache.messages = Array.isArray(data.messages) ? data.messages : [];
    gchatCache.spaceNames = data.spaceNames && typeof data.spaceNames === 'object' ? data.spaceNames : {};
    gchatCache.spaceTypes = data.spaceTypes && typeof data.spaceTypes === 'object' ? data.spaceTypes : {};
    gchatCache.userNames = scrubGchatUserNamesByPerson(scrubBadGchatUserNames(data.userNames));
    gchatCache.userIcons = data.userIcons && typeof data.userIcons === 'object' ? data.userIcons : {};
    gchatCache.spaceIcons = data.spaceIcons && typeof data.spaceIcons === 'object' ? data.spaceIcons : {};
    gchatCache.spaceMute = data.spaceMute && typeof data.spaceMute === 'object' ? data.spaceMute : {};
    gchatCache.myUserName = data.myUserName || '';
    gchatCache.myIds = Array.isArray(data.myIds) ? data.myIds.filter(Boolean).slice(0, 30) : [];
    gchatCache.myLabels = Array.isArray(data.myLabels) ? data.myLabels.filter(Boolean).slice(0, 12) : [];
    loadGchatPacketsFromDisk(data.packets);
    gchatCache.directorySyncedAt = Number(data.directorySyncedAt) || 0;
    gchatAuthBootstrapAt = Number(data.gchatAuthBootstrapAt) || 0;
    const cachedNameCount = Object.keys(gchatCache.userNames || {}).length;
    const dirFresh = gchatCache.directorySyncedAt
      && (Date.now() - gchatCache.directorySyncedAt < GCHAT_DIRECTORY_CACHE_TTL_MS);
    gchatCache.directoryWarmed = dirFresh && cachedNameCount > 5;
    gchatCache.lastSync = data.lastSync || 0;
    gchatPending.markRead = new Map();
    const pendingRaw = data.pendingMarkRead || [];
    for (const entry of pendingRaw) {
      if (typeof entry === 'string') gchatPending.markRead.set(entry, {});
      else if (entry?.name) gchatPending.markRead.set(entry.name, {
        createTime: entry.createTime || '',
        threadName: entry.threadName || '',
        spaceName: entry.spaceName || '',
        attempts: Number(entry.attempts || 0),
        lastAttemptAt: Number(entry.lastAttemptAt || 0),
        lastError: entry.lastError || ''
      });
    }
    gchatLocallyRead.clear();
    for (const id of data.locallyRead || []) {
      if (id) gchatLocallyRead.add(id);
    }
    gchatLocallyReadSpaces.clear();
    const spaceRead = data.locallyReadSpaces && typeof data.locallyReadSpaces === 'object'
      ? data.locallyReadSpaces
      : {};
    chatApiQuotaBlockedUntil = Number(data.chatApiQuotaBlockedUntil) || chatApiQuotaBlockedUntil || 0;
    for (const [spaceName, until] of Object.entries(spaceRead)) {
      if (spaceName && until) gchatLocallyReadSpaces.set(spaceName, String(until));
    }
    gchatCache.todayTouched = Array.isArray(data.todayTouched) ? data.todayTouched.map(t => {
      const spaceLabel = t?.spaceName ? (gchatCache.spaceNames[t.spaceName] || '') : '';
      return {
        ...t,
        trackKey: gchatTrackKey(t) || t.trackKey,
        sender: pickGoodGchatLabel(t.sender) || t.sender || '',
        spaceDisplayName: pickGoodGchatLabel(t.spaceDisplayName, spaceLabel) || t.spaceDisplayName || ''
      };
    }) : [];
    pruneGchatTodayTouched();
    // 舊快取若把寄件者寫成「成員」，下次同步時重解
    gchatCache.messages = gchatCache.messages.map(m => {
      const next = !m?.sender || m.sender === '成員' || m.sender === '未知' || String(m.sender).startsWith('使用者 ')
        ? { ...m, sender: '' }
        : { ...m };
      if (next.spaceType == null && next.spaceName) {
        next.spaceType = gchatCache.spaceTypes[next.spaceName] || '';
      }
      if (next.isDm == null) next.isDm = next.spaceType === 'DIRECT_MESSAGE';
      if (next.mentionedMe == null) next.mentionedMe = false;
      return next;
    }).filter(isInboxGchatMessage);
  } catch (err) {
    console.error('讀取 Chat 暫存失敗:', err.message);
  }
}

function slimGchatMediaItemForDisk(item) {
  if (!item || typeof item !== 'object') return item;
  const { dataUrl, ...rest } = item;
  const out = { ...rest };
  // previewUrl 若為本機 base64，體積與 dataUrl 相同，不可寫入暫存
  if (typeof out.previewUrl === 'string' && out.previewUrl.startsWith('data:')) {
    delete out.previewUrl;
  }
  return out;
}

function slimGchatMessageForDisk(m) {
  if (!m || typeof m !== 'object') return m;
  const next = { ...m };
  if (Array.isArray(next.media)) {
    // dataUrl / base64 previewUrl 不寫入暫存；媒體二進位改存 userData/gchat_media_cache/
    next.media = next.media.map(slimGchatMediaItemForDisk);
  }
  return next;
}

function slimGchatListForDisk(list) {
  return (Array.isArray(list) ? list : []).map(slimGchatMessageForDisk);
}

function serializeGchatPacketsForDisk() {
  return ensureGchatPacketRepository().serializeForDisk();
}

function loadGchatPacketsFromDisk(raw) {
  ensureGchatPacketRepository().loadFromDisk(raw);
}

function saveGchatDisk() {
  try {
    pruneGchatTodayTouched();
    const pendingMarkRead = [...gchatPending.markRead.entries()].map(([name, meta]) => ({
      name,
      createTime: meta?.createTime || '',
      threadName: meta?.threadName || '',
      spaceName: meta?.spaceName || '',
      attempts: Number(meta?.attempts || 0),
      lastAttemptAt: Number(meta?.lastAttemptAt || 0),
      lastError: meta?.lastError || ''
    }));
    fs.writeFileSync(gchatPacketPath(), JSON.stringify({
      messages: slimGchatListForDisk(gchatCache.messages),
      spaceNames: gchatCache.spaceNames,
      spaceTypes: gchatCache.spaceTypes,
      userNames: gchatCache.userNames,
      userIcons: gchatCache.userIcons || {},
      spaceIcons: gchatCache.spaceIcons || {},
      spaceMute: gchatCache.spaceMute,
      myUserName: gchatCache.myUserName || '',
      myIds: gchatCache.myIds || [],
      myLabels: gchatCache.myLabels || [],
      packets: serializeGchatPacketsForDisk(),
      lastSync: gchatCache.lastSync,
      directorySyncedAt: gchatCache.directorySyncedAt || 0,
      gchatAuthBootstrapAt: gchatAuthBootstrapAt || 0,
      pendingMarkRead,
      locallyRead: [...gchatLocallyRead].slice(-500),
      locallyReadSpaces: Object.fromEntries([...gchatLocallyReadSpaces.entries()].slice(-80)),
      todayTouched: slimGchatListForDisk(gchatCache.todayTouched || []),
      chatApiQuotaBlockedUntil: chatApiQuotaBlockedUntil || 0
    }));
  } catch (err) {
    console.error('寫入 Chat 暫存失敗:', err.message);
  }
}

function localDayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function gchatTrackKey(m) {
  if (!m) return '';
  const spaceType = m.spaceType || gchatCache.spaceTypes[m.spaceName] || '';
  const isDm = m.isDm === true || spaceType === 'DIRECT_MESSAGE';
  // 私人／群組都依空間合併：同一人密語、同一群組只留一筆
  if (m.spaceName) return `${isDm ? 'dm' : 'sp'}:${m.spaceName}`;
  if (m.threadName) return `th:${m.threadName}`;
  return m.name ? `msg:${m.name}` : '';
}

function isGoodGchatLabel(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  if (s === '成員' || s === '未知' || s === '對話') return false;
  if (s.startsWith('使用者 ')) return false;
  if (s.includes('解析寄件者')) return false;
  return true;
}

function pickGoodGchatLabel(...vals) {
  for (const v of vals) {
    if (isGoodGchatLabel(v)) return String(v).trim();
  }
  return '';
}

function pruneGchatTodayTouched() {
  const day = localDayKey();
  gchatCache.todayTouched = (gchatCache.todayTouched || []).filter(t => t && t.day === day && t.trackKey);
}

function rememberGchatTodayTouch(item, { read = true } = {}) {
  if (!item) return;
  pruneGchatTodayTouched();
  const key = gchatTrackKey(item);
  if (!key) return;
  const day = localDayKey();
  const list = gchatCache.todayTouched || [];
  const idx = list.findIndex(t => t.trackKey === key);
  const prev = idx >= 0 ? list[idx] : null;
  const packet = (item.name && gchatCache.packets?.[item.name]?.detail) || null;
  const spaceLabel = item.spaceName ? (gchatCache.spaceNames[item.spaceName] || '') : '';
  const senderFromId = item.senderName ? (gchatCache.userNames[item.senderName] || '') : '';

  const sender = pickGoodGchatLabel(
    item.sender,
    packet?.sender,
    prev?.sender,
    senderFromId
  );
  const spaceDisplayName = cleanGchatSpaceLabel(
    pickGoodGchatLabel(
      item.spaceDisplayName,
      packet?.spaceDisplayName,
      prev?.spaceDisplayName,
      spaceLabel,
      sender
    ),
    item.spaceType || packet?.spaceType || prev?.spaceType,
    item.isDm ?? packet?.isDm ?? prev?.isDm
  );
  const snippet = pickGoodGchatLabel(
    item.snippet,
    item.text,
    packet?.snippet,
    prev?.snippet
  ) || (item.snippet || item.text || packet?.snippet || prev?.snippet || '');

  const row = {
    trackKey: key,
    day,
    read: !!read,
    isRead: !!read,
    touchedAt: Date.now(),
    name: item.name || prev?.name || '',
    spaceName: item.spaceName || prev?.spaceName || '',
    threadName: item.threadName || prev?.threadName || '',
    createTime: item.createTime || prev?.createTime || '',
    createTimeLabel: item.createTimeLabel || prev?.createTimeLabel || '',
    sender,
    senderName: item.senderName || packet?.senderName || prev?.senderName || '',
    spaceDisplayName,
    snippet,
    text: item.text || prev?.text || '',
    isDm: !!(item.isDm || prev?.isDm || item.spaceType === 'DIRECT_MESSAGE'),
    mentionedMe: !!(item.mentionedMe || prev?.mentionedMe),
    spaceType: item.spaceType || prev?.spaceType || '',
    openUrl: item.openUrl || prev?.openUrl || '',
    media: Array.isArray(item.media) && item.media.length ? item.media : (prev?.media || [])
  };
  if (idx >= 0) {
    list[idx] = {
      ...prev,
      ...row,
      read: !!(read || prev.read),
      isRead: !!(read || prev.read),
      // 空值不覆蓋既有好資料
      sender: pickGoodGchatLabel(row.sender, prev.sender),
      spaceDisplayName: pickGoodGchatLabel(row.spaceDisplayName, prev.spaceDisplayName),
      snippet: pickGoodGchatLabel(row.snippet, prev.snippet) || row.snippet || prev.snippet || ''
    };
    const [hit] = list.splice(idx, 1);
    list.unshift(hit);
  } else {
    list.unshift(row);
  }
  gchatCache.todayTouched = list.slice(0, 100);
}

function collapseGchatByConversation(items) {
  const map = new Map();
  for (const raw of items || []) {
    if (!raw) continue;
    const key = gchatTrackKey(raw) || raw.name;
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        ...raw,
        unreadCount: raw.unreadCount || 1,
        memberNames: raw.memberNames || (raw.name ? [raw.name] : [])
      });
      continue;
    }
    const newer = String(raw.createTime || '') > String(prev.createTime || '');
    const top = newer ? raw : prev;
    const other = newer ? prev : raw;
    map.set(key, {
      ...top,
      sender: pickGoodGchatLabel(top.sender, other.sender, prev.sender),
      spaceDisplayName: pickGoodGchatLabel(top.spaceDisplayName, other.spaceDisplayName, prev.spaceDisplayName),
      snippet: pickGoodGchatLabel(top.snippet, other.snippet) || top.snippet || other.snippet || '',
      unreadCount: (prev.unreadCount || 1) + (raw.unreadCount || 1),
      memberNames: [...new Set([
        ...(prev.memberNames || (prev.name ? [prev.name] : [])),
        ...(raw.memberNames || (raw.name ? [raw.name] : []))
      ].filter(Boolean))]
    });
  }
  return [...map.values()].sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')));
}

function enrichGchatListItem(m) {
  return ensureGchatMessageTransformService().enrichGchatListItem(m);
}

function isLocallyReadMessage(name, hint = null) {
  if (name && (gchatPending.markRead.has(name) || gchatLocallyRead.has(name))) return true;
  const spaceName = hint?.spaceName
    || (name && gchatCache.messages.find(m => m.name === name)?.spaceName)
    || (name && gchatCache.packets?.[name]?.detail?.spaceName)
    || '';
  if (!spaceName || !gchatLocallyReadSpaces.has(spaceName)) return false;
  const until = String(gchatLocallyReadSpaces.get(spaceName) || '');
  const createTime = String(
    hint?.createTime
    || (name && gchatCache.messages.find(m => m.name === name)?.createTime)
    || (name && gchatCache.packets?.[name]?.detail?.createTime)
    || ''
  );
  // 無時間時：同空間曾標已讀就不當未讀 inbox（避免重跳）
  if (!createTime) return true;
  return createTime <= until;
}

function isLocallyReadConversation(item = {}) {
  if (!item) return false;
  if (item.name && isLocallyReadMessage(item.name, item)) return true;
  const trackKey = gchatTrackKey(item);
  if (!trackKey) return false;
  const until = item.spaceName ? String(gchatLocallyReadSpaces.get(item.spaceName) || '') : '';
  if (until && String(item.createTime || '') && String(item.createTime) <= until) return true;
  return false;
}

function isInboxGchatMessage(m) {
  if (!m?.name) return false;
  if (isLocallyReadMessage(m.name, m)) return false;
  const spaceType = m.spaceType || gchatCache.spaceTypes[m.spaceName] || '';
  // 私人：僅 DIRECT_MESSAGE
  if (spaceType === 'DIRECT_MESSAGE') return true;
  // 群組 SPACE / GROUP_CHAT / 未知：必須明確 @我
  if (spaceType === 'SPACE' || spaceType === 'GROUP_CHAT') return m.mentionedMe === true;
  // 類型未知時寧可少顯示，避免群組未 @ 的訊息混進來
  return m.mentionedMe === true && m.isDm !== true;
}

/** 置頂對話：若尚無本機已讀水位，以目前最新訊息為基準（避免重新授權後把整段歷史當未讀） */
function ensurePinnedSpaceUnreadBaseline(spaceName, isDm = false) {
  const sn = String(spaceName || '').trim();
  if (!sn) return '';
  const existing = String(gchatLocallyReadSpaces.get(sn) || '').trim();
  if (existing) return existing;
  const packet = findReadyGchatPacketBySpace(sn, { isDm });
  let newest = '';
  for (const m of packet?.thread || []) {
    const ct = String(m?.createTime || '').trim();
    if (ct && ct > newest) newest = ct;
  }
  if (!newest) newest = String(packet?.detail?.createTime || '').trim();
  if (newest) gchatLocallyReadSpaces.set(sn, newest);
  return newest;
}

/** 置頂聯絡人／群組未讀數（不含自己送的訊息；僅統計已置頂項目） */
function countPinnedSpaceUnread(spaceName, isDm = false) {
  const sn = String(spaceName || '').trim();
  if (!sn) return 0;
  const seenNames = new Set();
  let count = 0;

  // [Important] 無水位時先以最新訊息建基準，不可把預打包歷史整段算未讀
  const readUntil = ensurePinnedSpaceUnreadBaseline(sn, isDm);

  const addUnreadMessage = (m) => {
    if (!m || isOwnGchatMessage(m)) return;
    const name = String(m.name || '').trim();
    const ct = String(m.createTime || '');
    if (readUntil && ct && ct <= readUntil) return;
    if (name) {
      if (seenNames.has(name)) return;
      if (isLocallyReadMessage(name, { spaceName: sn, createTime: m.createTime || '' })) return;
      seenNames.add(name);
    }
    count += 1;
  };

  // inbox：同步進來的未讀（私人／@我等）
  for (const m of gchatCache.messages || []) {
    if (String(m?.spaceName || '').trim() !== sn) continue;
    if (m.read === true || m.isRead === true) continue;
    addUnreadMessage(m);
  }

  const packet = findReadyGchatPacketBySpace(sn, { isDm });
  for (const m of packet?.thread || []) {
    if (!m || isOwnGchatMessage(m)) continue;
    const ct = String(m.createTime || '');
    if (!ct || (readUntil && ct <= readUntil)) continue;
    addUnreadMessage(m);
  }
  return count;
}

function buildPinnedUnreadCounts() {
  const prefs = loadGchatPrefs();
  const contacts = {};
  const spaces = {};
  for (const c of prefs.pinnedContacts || []) {
    const userName = String(c?.userName || '').trim();
    const spaceName = String(c?.spaceName || '').trim();
    if (!userName) continue;
    const n = spaceName ? countPinnedSpaceUnread(spaceName, true) : 0;
    if (n > 0) contacts[userName] = n;
  }
  for (const s of prefs.pinnedSpaces || []) {
    const spaceName = String(s?.spaceName || '').trim();
    if (!spaceName) continue;
    const n = countPinnedSpaceUnread(spaceName, !!s.isDm);
    if (n > 0) spaces[spaceName] = n;
  }
  return { contacts, spaces };
}

function gchatSnapshot() {
  pruneGchatTodayTouched();
  const unread = collapseGchatByConversation(
    (gchatCache.messages || [])
      .filter(isInboxGchatMessage)
      .map(m => ({ ...m, isRead: false, trackedToday: false }))
  ).map(enrichGchatListItem);

  const unreadKeys = new Set(unread.map(gchatTrackKey).filter(Boolean));
  const tracked = collapseGchatByConversation(
    (gchatCache.todayTouched || [])
      .filter(t => t.read && t.trackKey && !unreadKeys.has(t.trackKey))
      .map(t => ({ ...t, isRead: true, trackedToday: true }))
  ).map(enrichGchatListItem);

  const messages = [...unread, ...tracked];
  scheduleHydrateListIcons(messages);
  const unresolved = unread.filter(m => !isGoodGchatLabel(m.sender)).length;
  return {
    success: true,
    messages,
    lastSync: gchatCache.lastSync,
    syncing: gchatCache.syncing,
    packing: !!gchatCache.packing,
    pending: { markRead: gchatPending.markRead.size },
    directoryError: gchatCache.directoryError || '',
    directoryStats: gchatCache.directoryStats || { admin: 0, people: 0 },
    unresolvedSenders: unresolved,
    namedUsers: Object.keys(gchatCache.userNames || {}).length,
    todayTracked: tracked.length,
    myUserName: gchatCache.myUserName || '',
    myIds: gchatCache.myIds || [],
    myLabels: gchatCache.myLabels || [],
    pinnedContacts: loadGchatPrefs().pinnedContacts || [],
    pinnedSpaces: loadGchatPrefs().pinnedSpaces || [],
    pinnedUnread: buildPinnedUnreadCounts(),
    ...chatApiQuotaStatus()
  };
}

let listIconHydrateTimer = null;
function scheduleHydrateListIcons(messages) {
  clearTimeout(listIconHydrateTimer);
  listIconHydrateTimer = setTimeout(() => {
    hydrateListIcons(messages).catch(() => {});
  }, 120);
}

/** 背景補齊未讀／已讀列表的大頭／空間 icon */
async function hydrateListIcons(messages) {
  if (!oauth2Client) return;
  const iconSvc = ensureGchatIconService();
  let changed = false;
  for (const m of (messages || []).slice(0, 36)) {
    if (!m || m.iconUrl) continue;
    try {
      if (m.isDm) {
        const icon = m.senderName
          ? await iconSvc.resolveContactIcon(m.senderName)
          : await iconSvc.resolveSpaceIcon(m.spaceName, {
            isDm: true,
            label: m.spaceDisplayName || m.sender || ''
          });
        if (icon?.iconUrl || icon?.emoji) {
          if (m.spaceName) iconSvc.rememberSpaceIcon(m.spaceName, icon);
          changed = true;
        }
      } else if (m.spaceName) {
        const icon = await iconSvc.resolveSpaceIcon(m.spaceName, {
          isDm: false,
          label: m.spaceDisplayName || ''
        });
        if (icon?.iconUrl || icon?.emoji) changed = true;
      }
    } catch (_) {}
  }
  if (!changed) return;
  try { saveGchatDisk(); } catch (_) {}
  broadcastGchatListUpdate();
}

async function chatHttp(method, url, data) {
  const res = await oauth2Client.request({
    method,
    url,
    data,
    headers: { 'Content-Type': 'application/json' }
  });
  return res.data;
}

async function bufferChatAttachmentForUpload(file) {
  if (!file) return null;
  const filename = String(file.name || 'file').slice(0, 200);
  const mimeType = String(file.mimeType || 'application/octet-stream');
  let buf;
  if (Buffer.isBuffer(file.data)) buf = file.data;
  else if (file.dataBase64) buf = Buffer.from(String(file.dataBase64), 'base64');
  else if (file.data) buf = Buffer.from(file.data);
  else return null;
  if (!buf.length) return null;
  if (buf.length > 25 * 1024 * 1024) {
    throw new Error(`檔案太大：${filename}（上限約 25MB）`);
  }
  return { filename, mimeType, data: buf };
}

function parseChatResource(name) {
  const parts = String(name || '').split('/');
  const spaceIdx = parts.indexOf('spaces');
  const msgIdx = parts.indexOf('messages');
  const threadIdx = parts.indexOf('threads');
  return {
    spaceName: spaceIdx >= 0 && parts[spaceIdx + 1] ? `spaces/${parts[spaceIdx + 1]}` : '',
    spaceId: spaceIdx >= 0 ? parts[spaceIdx + 1] || '' : '',
    messageId: msgIdx >= 0 ? parts[msgIdx + 1] || '' : '',
    threadName: threadIdx >= 0 && parts[threadIdx + 1]
      ? `spaces/${parts[spaceIdx + 1]}/threads/${parts[threadIdx + 1]}`
      : '',
    threadId: threadIdx >= 0 ? parts[threadIdx + 1] || '' : ''
  };
}

function senderDisplay(sender) {
  if (!sender) return '未知';
  if (sender.displayName) return sender.displayName;
  if (sender.name?.startsWith('users/')) {
    const id = sender.name.slice('users/'.length);
    if (id.includes('@')) return id;
  }
  return sender.type === 'BOT' ? '機器人' : '成員';
}

function snippetFromText(text, max = 90) {
  const plain = String(text || '').replace(/\s+/g, ' ').trim();
  if (!plain) return '（無文字）';
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

function chatOpenUrl(spaceId, threadId) {
  if (!spaceId) return 'https://chat.google.com/';
  if (threadId) return `https://mail.google.com/chat/u/0/#chat/space/${spaceId}/${threadId}`;
  return `https://mail.google.com/chat/u/0/#chat/space/${spaceId}`;
}

function isChatImageType(contentType, contentName) {
  if (/^image\//i.test(contentType || '')) return true;
  return /\.(gif|png|jpe?g|webp|bmp|heic)$/i.test(contentName || '');
}

function isChatPdfType(contentType, contentName) {
  return /pdf/i.test(contentType || '') || /\.pdf$/i.test(contentName || '');
}

function extractChatMediaMeta(raw) {
  const media = [];
  for (const gif of raw?.attachedGifs || []) {
    if (!gif?.uri) continue;
    media.push({
      kind: 'gif',
      uri: gif.uri,
      previewUrl: gif.uri,
      name: 'GIF'
    });
  }
  for (const att of raw?.attachment || []) {
    const contentType = att.contentType || '';
    const contentName = att.contentName || '附件';
    const resourceName = att.attachmentDataRef?.resourceName || '';
    const driveId = att.driveDataRef?.driveFileId || '';
    let kind = 'file';
    if (isChatImageType(contentType, contentName)) kind = 'image';
    else if (isChatPdfType(contentType, contentName)) kind = 'pdf';
    media.push({
      kind,
      name: contentName,
      contentType,
      thumbnailUri: att.thumbnailUri || '',
      downloadUri: att.downloadUri || '',
      resourceName,
      driveFileId: driveId,
      previewUrl: ''
    });
  }
  // [Important] 卡片 header／startIcon 是小圖示，不可當一般媒體大圖（會爆出超大 Docker logo）
  // 真實內容圖（widgets.image）仍保留，但標 cardDecor 供有 cardHtml 時過濾
  for (const card of raw?.cardsV2 || []) {
    const headerUrl = String(card?.card?.header?.imageUrl || '').trim();
    if (headerUrl) {
      media.push({
        kind: 'image',
        name: '卡片圖示',
        previewUrl: headerUrl,
        uri: headerUrl,
        cardDecor: true
      });
    }
    const widgets = card?.card?.sections?.flatMap(s => s.widgets || []) || [];
    for (const w of widgets) {
      const iconUrl = String(w.decoratedText?.startIcon?.iconUrl || '').trim();
      if (iconUrl) {
        media.push({
          kind: 'image',
          name: '卡片圖示',
          previewUrl: iconUrl,
          uri: iconUrl,
          cardDecor: true
        });
      }
      const imgUrl = String(w.image?.imageUrl || '').trim();
      if (imgUrl) {
        media.push({
          kind: 'image',
          name: '圖片',
          previewUrl: imgUrl,
          uri: imgUrl,
          cardDecor: true
        });
      }
    }
  }
  return media;
}

/** 從 onClick 取出 openLink URL（卡片按鈕／酷連結） */
function pickChatOpenLinkUrl(onClick) {
  if (!onClick || typeof onClick !== 'object') return '';
  const direct = String(onClick.openLink?.url || '').trim();
  if (direct) return direct;
  const nested = String(
    onClick.openDynamicLinkAction?.url
    || onClick.openDynamicLinkAction?.openLink?.url
    || ''
  ).trim();
  return nested;
}

/**
 * 從 cardsV2／cards／annotations 抽出可開啟的連結（酷連結按鈕、裝飾文字連點、URL annotation）
 * @returns {{ text: string, url: string }[]}
 */
function extractChatCardLinks(raw) {
  const links = [];
  const seen = new Set();
  const add = (text, url) => {
    const u = String(url || '').trim();
    if (!u || !/^https?:\/\//i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    const label = String(text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    links.push({ text: label || u, url: u });
  };

  const walkWidgets = (widgets) => {
    for (const w of widgets || []) {
      if (!w || typeof w !== 'object') continue;
      const dt = w.decoratedText;
      if (dt) {
        add(dt.text || dt.bottomLabel || dt.topLabel, pickChatOpenLinkUrl(dt.onClick));
        if (dt.button) add(dt.button.text, pickChatOpenLinkUrl(dt.button.onClick));
      }
      for (const b of w.buttonList?.buttons || []) {
        add(b.text || b.altText || b.icon?.altText, pickChatOpenLinkUrl(b.onClick));
      }
      // cards v1
      for (const b of w.buttons || []) {
        add(b.text || b.textButton?.text, pickChatOpenLinkUrl(b.onClick) || pickChatOpenLinkUrl(b.textButton?.onClick));
      }
      if (w.image) add(w.image.altText, pickChatOpenLinkUrl(w.image.onClick));
      // [Important] columns／grid 內嵌 widgets／items 也要掃連結
      for (const col of w.columns?.columnItems || w.columns?.columns || []) {
        walkWidgets(col.widgets || []);
      }
      for (const item of w.grid?.items || []) {
        if (item?.onClick) add(item.title || item.subtitle, pickChatOpenLinkUrl(item.onClick));
        walkWidgets(item.widgets || (item.textParagraph || item.decoratedText ? [item] : []));
      }
    }
  };

  for (const card of raw?.cardsV2 || []) {
    walkWidgets(card?.card?.sections?.flatMap((s) => s.widgets || []) || []);
  }
  for (const card of raw?.cards || []) {
    walkWidgets(card?.sections?.flatMap((s) => s.widgets || []) || []);
  }

  for (const a of raw?.annotations || []) {
    const url = a?.urlMetadata?.url
      || a?.richLinkMetadata?.uri
      || '';
    const title = a?.urlMetadata?.title
      || a?.urlMetadata?.displayName
      || a?.richLinkMetadata?.title
      || '';
    if (url && /^https?:\/\//i.test(String(url))) add(title, url);
  }
  return links;
}

function stripChatCardPlain(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function formatChatCardInlineText(text) {
  const esc = escapeHtmlLite(stripChatCardPlain(text));
  if (!esc) return '';
  // 分支名等 `code` 樣式
  return esc.replace(/`([^`]+)`/g, '<code class="gchat-msg-card-code">$1</code>');
}

function pickChatCardIconUrl(icon) {
  if (!icon || typeof icon !== 'object') return '';
  const url = String(icon.iconUrl || icon.imageUrl || '').trim();
  if (url && /^https?:\/\//i.test(url)) return url;
  return '';
}

/** 結構化抽出卡片（供表格感 UI） */
function extractChatCardModels(raw) {
  const cards = [];

  const pushDecoratedRow = (sec, dt) => {
    if (!dt || !sec) return;
    const topLabel = stripChatCardPlain(dt.topLabel);
    const text = stripChatCardPlain(dt.text);
    const bottomLabel = stripChatCardPlain(dt.bottomLabel);
    const url = pickChatOpenLinkUrl(dt.onClick);
    const iconUrl = pickChatCardIconUrl(dt.startIcon) || pickChatCardIconUrl(dt.endIcon);
    if (topLabel || text || bottomLabel) {
      sec.rows.push({ kind: 'row', topLabel, text, bottomLabel, url, iconUrl });
    }
    if (dt.button) {
      sec.buttons.push({
        text: stripChatCardPlain(dt.button.text || '開啟'),
        url: pickChatOpenLinkUrl(dt.button.onClick)
      });
    }
  };

  const ingestWidgetInto = (sec, w) => {
    if (!w || !sec) return;
    if (w.textParagraph?.text) {
      const t = stripChatCardPlain(w.textParagraph.text);
      if (t) sec.rows.push({ kind: 'text', text: t });
    }
    if (w.decoratedText) pushDecoratedRow(sec, w.decoratedText);
    for (const b of w.buttonList?.buttons || []) {
      sec.buttons.push({
        text: stripChatCardPlain(b.text || b.altText || b.icon?.altText || '開啟連結'),
        url: pickChatOpenLinkUrl(b.onClick)
      });
    }
    for (const b of w.buttons || []) {
      sec.buttons.push({
        text: stripChatCardPlain(b.text || b.textButton?.text || '開啟連結'),
        url: pickChatOpenLinkUrl(b.onClick) || pickChatOpenLinkUrl(b.textButton?.onClick)
      });
    }
    // [Important] Google Chat 多欄（PR 詳細資訊等）→ columns.columnItems[].widgets
    const columnItems = w.columns?.columnItems || w.columns?.columns || [];
    if (columnItems.length) {
      const cells = [];
      for (const col of columnItems) {
        const cell = { rows: [], buttons: [] };
        for (const cw of col.widgets || []) ingestWidgetInto(cell, cw);
        if (cell.rows.length || cell.buttons.length) cells.push(cell);
      }
      if (cells.length) {
        sec.rows.push({ kind: 'columns', cells });
        for (const cell of cells) {
          for (const b of cell.buttons || []) sec.buttons.push(b);
        }
      }
    }
    // [Important] Grid（常見 3 欄 PR 資訊）→ grid.title + grid.items[{title,subtitle}]
    if (w.grid && typeof w.grid === 'object') {
      const gridTitle = stripChatCardPlain(w.grid.title);
      if (gridTitle && !sec.header) sec.header = gridTitle;
      else if (gridTitle && sec.header !== gridTitle) {
        sec.rows.push({ kind: 'text', text: gridTitle });
      }
      const items = Array.isArray(w.grid.items) ? w.grid.items : [];
      const colCount = Math.max(1, Number(w.grid.columnCount) || items.length || 1);
      if (items.length) {
        const cells = items.map((item) => {
          const topLabel = stripChatCardPlain(item?.title);
          const text = stripChatCardPlain(item?.subtitle || item?.text);
          const url = pickChatOpenLinkUrl(item?.onClick);
          const iconUrl = pickChatCardIconUrl(item?.image) || String(item?.image?.imageUrl || '').trim();
          const rows = [];
          if (topLabel || text) {
            rows.push({ kind: 'row', topLabel, text, bottomLabel: '', url, iconUrl });
          }
          return { rows, buttons: [] };
        }).filter((c) => c.rows.length);
        if (cells.length) {
          sec.rows.push({ kind: 'columns', cells, columnCount: colCount });
        }
      }
    }
  };

  const pushCard = (cardObj) => {
    if (!cardObj || typeof cardObj !== 'object') return;
    const header = cardObj.header || {};
    const model = {
      title: stripChatCardPlain(header.title),
      subtitle: stripChatCardPlain(header.subtitle),
      imageUrl: String(header.imageUrl || '').trim(),
      sections: []
    };
    for (const section of cardObj.sections || []) {
      const sec = {
        header: stripChatCardPlain(section.header),
        rows: [],
        buttons: []
      };
      for (const w of section.widgets || []) ingestWidgetInto(sec, w);
      if (sec.header || sec.rows.length || sec.buttons.length) model.sections.push(sec);
    }
    if (model.title || model.subtitle || model.sections.length) cards.push(model);
  };

  for (const c of raw?.cardsV2 || []) pushCard(c?.card);
  for (const c of raw?.cards || []) pushCard(c);
  return cards;
}

function buildChatCardsHtml(cards) {
  if (!Array.isArray(cards) || !cards.length) return '';

  const renderRow = (row) => {
    if (!row) return '';
    if (row.kind === 'text') {
      return `<div class="gchat-msg-card-para">${formatChatCardInlineText(row.text)}</div>`;
    }
    if (row.kind === 'columns' && Array.isArray(row.cells)) {
      const n = Math.max(1, Number(row.columnCount) || row.cells.length || 1);
      const cols = row.cells.map((cell) => {
        const inner = (cell.rows || []).map(renderRow).join('');
        return `<div class="gchat-msg-card-col">${inner}</div>`;
      }).join('');
      return `<div class="gchat-msg-card-cols" style="--gchat-card-cols:${n}">${cols}</div>`;
    }
    const parts = ['<div class="gchat-msg-card-row">'];
    if (row.iconUrl && /^https?:\/\//i.test(row.iconUrl)) {
      parts.push(`<img class="gchat-msg-card-row-icon" src="${escapeHtmlLite(row.iconUrl)}" alt="" draggable="false">`);
    } else {
      parts.push('<span class="gchat-msg-card-row-icon is-empty" aria-hidden="true"></span>');
    }
    parts.push('<div class="gchat-msg-card-row-body">');
    if (row.topLabel) parts.push(`<div class="gchat-msg-card-label">${escapeHtmlLite(row.topLabel)}</div>`);
    const valueHtml = formatChatCardInlineText(row.text);
    if (valueHtml) {
      if (row.url && /^https?:\/\//i.test(row.url)) {
        const u = escapeHtmlLite(row.url);
        parts.push(`<div class="gchat-msg-card-value"><a class="gchat-text-link gchat-card-link" href="${u}" title="${u}" rel="noopener noreferrer" data-open-url="${u}">${valueHtml}</a></div>`);
      } else {
        parts.push(`<div class="gchat-msg-card-value">${valueHtml}</div>`);
      }
    }
    if (row.bottomLabel) parts.push(`<div class="gchat-msg-card-hint">${escapeHtmlLite(row.bottomLabel)}</div>`);
    parts.push('</div></div>');
    return parts.join('');
  };

  return cards.map((card) => {
    const parts = ['<div class="gchat-msg-card">'];
    if (card.title || card.subtitle || card.imageUrl) {
      parts.push('<div class="gchat-msg-card-head">');
      if (card.imageUrl && /^https?:\/\//i.test(card.imageUrl)) {
        parts.push(`<img class="gchat-msg-card-avatar" src="${escapeHtmlLite(card.imageUrl)}" alt="" draggable="false">`);
      }
      parts.push('<div class="gchat-msg-card-head-text">');
      if (card.title) parts.push(`<div class="gchat-msg-card-title">${escapeHtmlLite(card.title)}</div>`);
      if (card.subtitle) parts.push(`<div class="gchat-msg-card-sub">${escapeHtmlLite(card.subtitle)}</div>`);
      parts.push('</div></div>');
    }
    for (const sec of card.sections || []) {
      parts.push('<div class="gchat-msg-card-section">');
      if (sec.header) parts.push(`<div class="gchat-msg-card-sec-title">${escapeHtmlLite(sec.header)}</div>`);
      for (const row of sec.rows || []) parts.push(renderRow(row));
      if (sec.buttons?.length) {
        parts.push('<div class="gchat-msg-card-actions">');
        for (const b of sec.buttons) {
          const label = escapeHtmlLite(b.text || '開啟連結');
          if (b.url && /^https?:\/\//i.test(b.url)) {
            const u = escapeHtmlLite(b.url);
            parts.push(`<a class="gchat-msg-card-btn gchat-card-link" href="${u}" title="${u}" rel="noopener noreferrer" data-open-url="${u}">${label}</a>`);
          } else {
            parts.push(`<span class="gchat-msg-card-btn is-disabled">${label}</span>`);
          }
        }
        parts.push('</div>');
      }
      parts.push('</div>');
    }
    parts.push('</div>');
    return parts.join('');
  }).join('');
}

function cardLinksToHtml(links) {
  return (links || []).map((l) => {
    const u = escapeHtmlLite(l.url);
    const label = escapeHtmlLite(l.text || l.url);
    return `<a class="gchat-msg-card-btn gchat-card-link" href="${u}" title="${u}" rel="noopener noreferrer" data-open-url="${u}">${label}</a>`;
  }).join('');
}

function appendCardLinksToHtml(html, links) {
  const list = links || [];
  if (!list.length) return html || '';
  const base = String(html || '');
  // 已有卡片按鈕／同 URL 則不重複貼裸連結
  if (base.includes('gchat-msg-card')) return base;
  const missing = list.filter((l) => l?.url && !base.includes(escapeHtmlLite(l.url)) && !base.includes(l.url));
  if (!missing.length) return base;
  const block = `<div class="gchat-msg-card-actions">${cardLinksToHtml(missing)}</div>`;
  return base ? `${base}${block}` : block;
}

/** 從 cardsV2 抽出可讀文字（引用／預覽用；不含裸 URL） */
function extractChatCardText(raw) {
  const parts = [];
  const push = (s) => {
    const t = stripChatCardPlain(s);
    if (t) parts.push(t);
  };
  const walkWidgets = (widgets) => {
    for (const w of widgets || []) {
      if (!w) continue;
      push(w.textParagraph?.text);
      push(w.decoratedText?.topLabel);
      push(w.decoratedText?.text);
      push(w.decoratedText?.bottomLabel);
      if (w.buttonList?.buttons) {
        for (const b of w.buttonList.buttons) push(b.text);
      }
      if (w.buttons) {
        for (const b of w.buttons) push(b.text || b.textButton?.text);
      }
      for (const col of w.columns?.columnItems || w.columns?.columns || []) {
        walkWidgets(col.widgets || []);
      }
      if (w.grid) {
        push(w.grid.title);
        for (const item of w.grid.items || []) {
          push(item?.title);
          push(item?.subtitle);
          push(item?.text);
        }
      }
    }
  };
  for (const card of raw?.cardsV2 || []) {
    push(card?.card?.header?.title);
    push(card?.card?.header?.subtitle);
    for (const section of card?.card?.sections || []) {
      push(section?.header);
      walkWidgets(section.widgets || []);
    }
  }
  for (const card of raw?.cards || []) {
    push(card?.header?.title);
    push(card?.header?.subtitle);
    for (const section of card?.sections || []) {
      push(section?.header);
      walkWidgets(section.widgets || []);
    }
  }
  return parts.join('\n').slice(0, 1200);
}

/** 純文字訊息本文（不含卡片 fallback，避免與 cardHtml 重複） */
function plainChatMessageText(raw) {
  const direct = String(raw?.text || raw?.argumentText || '').trim();
  if (direct) return direct;
  const fmt = String(raw?.formattedText || '')
    .replace(/<users\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return fmt;
}

/** 從 API 原始訊息抽出可顯示文字（含 formattedText／argumentText） */
function plainChatBody(raw) {
  const direct = String(raw?.text || raw?.argumentText || '').trim();
  if (direct) return direct;
  const fmt = String(raw?.formattedText || '')
    .replace(/<users\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (fmt) return fmt;
  return extractChatCardText(raw);
}

function escapeHtmlLite(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function customEmojiImgHtml(hit, alt = '') {
  const src = resolveCustomEmojiDisplayUrl(hit);
  if (!src) return escapeHtmlLite(hit?.emojiName || alt || '');
  const label = escapeHtmlLite(hit?.emojiName || alt || ':emoji:');
  return `<img class="msg-custom-emoji-img" src="${escapeHtmlLite(src)}" alt="${label}" title="${label}" />`;
}

function customEmojiLocalImageCandidates(uid) {
  const dir = customEmojiImageDir();
  const base = path.join(dir, String(uid || '').trim());
  return ['.png', '.gif', '.webp', '.jpg', '.jpeg'].map((ext) => base + ext);
}

function findCustomEmojiLocalImage(uid) {
  const id = String(uid || '').trim();
  if (!id) return '';
  for (const p of customEmojiLocalImageCandidates(id)) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function customEmojiLocalImagePath(uid, ext = '.png') {
  return path.join(customEmojiImageDir(), `${String(uid || '').trim()}${ext}`);
}

function customEmojiProtocolUrl(uid) {
  const id = String(uid || '').trim();
  return id ? `gchat-emoji://${encodeURIComponent(id)}` : '';
}

function parseCustomEmojiProtocolUid(requestUrl) {
  const raw = String(requestUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const pathPart = decodeURIComponent(String(u.pathname || '').replace(/^\/+/, ''));
    const hostPart = decodeURIComponent(String(u.hostname || ''));
    return pathPart || hostPart;
  } catch (_) {
    return decodeURIComponent(raw.replace(/^gchat-emoji:\/\//i, '').replace(/\?.*$/, '').replace(/^\/+/, ''));
  }
}

function resolveCustomEmojiDisplayUrl(hit) {
  if (!hit) return '';
  const uid = String(hit.uid || '').trim();
  const local = uid ? findCustomEmojiLocalImage(uid) : '';
  if (local) {
    try {
      return pathToFileURL(local).href;
    } catch (_) {
      return customEmojiProtocolUrl(uid);
    }
  }
  const remote = String(hit.imageUrl || '').trim();
  if (remote && !remote.startsWith('gchat-emoji://')) return remote;
  return '';
}

async function fetchHttpBinary(url, { useAuth = false } = {}) {
  const target = String(url || '').trim();
  if (!target) throw new Error('缺少 URL');
  if (useAuth && oauth2Client) {
    const res = await oauth2Client.request({
      url: target,
      responseType: 'arraybuffer',
      headers: { Accept: 'image/*' }
    });
    return {
      data: Buffer.from(res.data || []),
      headers: res.headers || {}
    };
  }
  const client = target.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    client.get(target, (res) => {
      const status = Number(res.statusCode || 0);
      const loc = res.headers?.location;
      if (status >= 300 && status < 400 && loc) {
        fetchHttpBinary(loc, { useAuth: false }).then(resolve).catch(reject);
        res.resume();
        return;
      }
      if (status !== 200) {
        reject(new Error(`HTTP ${status}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ data: Buffer.concat(chunks), headers: res.headers || {} }));
    }).on('error', reject);
  });
}

function guessCustomEmojiImageExt(remoteUrl, contentType = '') {
  const blob = `${remoteUrl || ''} ${contentType || ''}`.toLowerCase();
  if (/gif/.test(blob)) return '.gif';
  if (/webp/.test(blob)) return '.webp';
  if (/jpe?g/.test(blob)) return '.jpg';
  return '.png';
}

async function downloadCustomEmojiImageToDisk(uid, remoteUrl) {
  const id = String(uid || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!id || !url) return false;
  if (findCustomEmojiLocalImage(id)) return true;
  try {
    fs.mkdirSync(customEmojiImageDir(), { recursive: true });
    let res = null;
    // Google 簽名圖 URL 帶 Authorization 反而會失敗，先裸 GET
    try {
      res = await fetchHttpBinary(url, { useAuth: false });
    } catch (_) {
      res = await fetchHttpBinary(url, { useAuth: true });
    }
    const buf = Buffer.from(res?.data || []);
    if (!buf.length) return false;
    const ext = guessCustomEmojiImageExt(url, res.headers?.['content-type'] || '');
    fs.writeFileSync(customEmojiLocalImagePath(id, ext), buf);
    return true;
  } catch (err) {
    console.warn('[GChat] 自訂表情圖片下載失敗:', id, err.message);
    return false;
  }
}

function queueCustomEmojiImageDownload(uid, remoteUrl) {
  const id = String(uid || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!id || !url || findCustomEmojiLocalImage(id) || customEmojiDownloadQueue.has(id)) return;
  customEmojiDownloadQueue.add(id);
  downloadCustomEmojiImageToDisk(id, url)
    .then((ok) => {
      customEmojiDownloadQueue.delete(id);
      if (!ok) return;
      const hit = gchatCache.customEmojis?.[id];
      if (hit) {
        hit.imageUrl = customEmojiProtocolUrl(id);
        saveCustomEmojiRegistry();
      }
    })
    .catch(() => customEmojiDownloadQueue.delete(id));
}

async function getCustomEmojiFromApi(entry = {}) {
  if (!oauth2Client) return null;
  const uid = String(entry.uid || '').trim();
  const emojiName = String(entry.emojiName || '').trim();
  const candidates = [];
  if (emojiName) {
    const tagged = /^:/.test(emojiName) ? emojiName : `:${emojiName.replace(/^:+|:+$/g, '')}:`;
    candidates.push(`https://chat.googleapis.com/v1/customEmojis/${encodeURIComponent(tagged)}`);
  }
  if (uid) candidates.push(`https://chat.googleapis.com/v1/customEmojis/${encodeURIComponent(uid)}`);
  let lastErr = null;
  for (const apiUrl of candidates) {
    try {
      return await chatHttp('GET', apiUrl);
    } catch (err) {
      lastErr = err;
      if (isCustomEmojiQuotaError(err)) throw err;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

async function hydrateCustomEmojiImages({ max = CUSTOM_EMOJI_HYDRATE_BATCH } = {}) {
  if (!oauth2Client) return { hydrated: 0, skipped: 0 };
  const scope = await grantedScopeText();
  if (!scopeListHas(scope, [CHAT_CUSTOM_EMOJI_SCOPE])) return { hydrated: 0, skipped: 0 };
  const now = Date.now();
  if (customEmojiQuotaBlockedUntil && now < customEmojiQuotaBlockedUntil) {
    return { hydrated: 0, skipped: Object.keys(gchatCache.customEmojis || {}).length, quotaBlocked: true };
  }
  const missing = Object.values(gchatCache.customEmojis || {})
    .filter((e) => e?.uid && !findCustomEmojiLocalImage(e.uid))
    .slice(0, Math.max(1, Number(max) || CUSTOM_EMOJI_HYDRATE_BATCH));
  let hydrated = 0;
  for (const entry of missing) {
    if (customEmojiQuotaBlockedUntil && Date.now() < customEmojiQuotaBlockedUntil) break;
    try {
      const row = await getCustomEmojiFromApi(entry);
      const remoteUrl = String(row?.temporaryImageUri || row?.temporary_image_uri || '').trim();
      if (!remoteUrl) continue;
      rememberCustomEmojiFromSource({
        uid: entry.uid,
        emojiName: entry.emojiName || row?.emojiName || '',
        name: row?.name || entry.name || `customEmojis/${entry.uid}`,
        temporaryImageUri: remoteUrl
      });
      const ok = await downloadCustomEmojiImageToDisk(entry.uid, remoteUrl);
      if (ok) {
        const hit = gchatCache.customEmojis?.[entry.uid];
        if (hit) hit.imageUrl = customEmojiProtocolUrl(entry.uid);
        hydrated++;
      }
    } catch (err) {
      if (isCustomEmojiQuotaError(err)) {
        customEmojiQuotaBlockedUntil = Date.now() + CUSTOM_EMOJI_QUOTA_BACKOFF_MS;
        saveCustomEmojiRegistry();
        break;
      }
    }
    await new Promise((r) => setTimeout(r, CUSTOM_EMOJI_HYDRATE_GAP_MS));
  }
  if (hydrated) saveCustomEmojiRegistry();
  return { hydrated, skipped: missing.length - hydrated };
}

function rememberCustomEmojiFromSource(custom = {}) {
  if (!custom || typeof custom !== 'object') return;
  const uid = String(custom.uid || '').trim()
    || String(custom.name || '').replace(/^customEmojis\//i, '').trim();
  if (!uid) return;
  const emojiName = String(custom.emojiName || '').trim();
  const imageUrl = String(
    custom.temporaryImageUri || custom.temporary_image_uri || custom.imageUrl || ''
  ).trim();
  const { byUid, byName } = ensureCustomEmojiMaps();
  const prev = byUid[uid] || {};
  const localReady = !!findCustomEmojiLocalImage(uid);
  const next = {
    uid,
    emojiName: emojiName || prev.emojiName || '',
    name: String(custom.name || prev.name || `customEmojis/${uid}`),
    imageUrl: localReady ? customEmojiProtocolUrl(uid) : (imageUrl || prev.imageUrl || '')
  };
  const changed = !prev.uid
    || (imageUrl && imageUrl !== prev.imageUrl)
    || (emojiName && emojiName !== prev.emojiName)
    || (localReady && next.imageUrl !== prev.imageUrl);
  if (!changed && prev.uid) return;
  byUid[uid] = next;
  const key = normalizeCustomEmojiKey(next.emojiName);
  if (key) byName[key] = uid;
  if (imageUrl && !localReady) queueCustomEmojiImageDownload(uid, imageUrl);
  if (localReady || imageUrl) {
    gchatCache.customEmojisAt = gchatCache.customEmojisAt || Date.now();
    saveCustomEmojiRegistry();
  }
}

function ingestCustomEmojisFromMessageRaw(raw) {
  const anns = Array.isArray(raw?.annotations) ? raw.annotations : [];
  for (const a of anns) {
    const custom = a?.customEmojiMetadata?.customEmoji;
    if (custom) rememberCustomEmojiFromSource(custom);
  }
  for (const s of raw?.emojiReactionSummaries || []) {
    const custom = s?.emoji?.customEmoji;
    if (custom) rememberCustomEmojiFromSource(custom);
  }
}

function resolveCustomEmojiFromMessageMeta(custom) {
  if (!custom) return null;
  const uid = String(custom.uid || '').trim();
  if (uid) {
    const hit = resolveCustomEmojiByUid(uid);
    if (hit) return hit;
  }
  const name = String(custom.name || '').trim();
  if (name) {
    const id = name.replace(/^customEmojis\//i, '');
    const hit = resolveCustomEmojiByUid(id);
    if (hit) return hit;
  }
  const emojiName = String(custom.emojiName || '').trim();
  if (emojiName) return resolveCustomEmojiFromShortcode(emojiName);
  return null;
}

function resolveCustomEmojiFromShortcode(value) {
  const key = normalizeCustomEmojiKey(value);
  if (!key) return null;
  const byUid = resolveCustomEmojiByUid(key);
  if (byUid) return byUid;
  const mapped = gchatCache.customEmojisByName?.[key];
  if (mapped) return resolveCustomEmojiByUid(mapped);
  return null;
}

function mapOutsideHtmlImgTags(text, mapper) {
  return String(text || '').split(/(<img\b[^>]*>)/gi).map((part) => {
    if (/^<img\b/i.test(part)) return part;
    return mapper(part);
  }).join('');
}

function replaceCustomEmojiPlaceholders(text, annotations = []) {
  let out = String(text || '');
  const anns = (annotations || [])
    .filter((a) => a?.customEmojiMetadata || /CUSTOM_EMOJI/i.test(String(a?.type || '')))
    .map((a) => {
      const custom = a.customEmojiMetadata?.customEmoji || {};
      const hit = resolveCustomEmojiFromMessageMeta(custom);
      const uid = String(custom.uid || custom.name?.replace(/^customEmojis\//i, '') || '').trim();
      const fallback = String(out.slice(Number(a.startIndex) || 0, (Number(a.startIndex) || 0) + (Number(a.length) || 0)) || '').trim()
        || (uid ? `:${uid}:` : '');
      return {
        start: Number(a.startIndex) || 0,
        len: Number(a.length) || 0,
        hit,
        fallback
      };
    })
    .filter((a) => a.len > 0 && a.start >= 0 && a.start + a.len <= out.length)
    .sort((a, b) => b.start - a.start);
  for (const ann of anns) {
    const html = resolveCustomEmojiDisplayUrl(ann.hit)
      ? customEmojiImgHtml(ann.hit)
      : escapeHtmlLite(ann.fallback || '');
    out = out.slice(0, ann.start) + html + out.slice(ann.start + ann.len);
  }
  return out;
}

function expandInlineCustomEmojiMarkup(text) {
  return mapOutsideHtmlImgTags(text, (segment) => {
    let out = segment;
    out = out.replace(/<customEmojis\/([^>\s]+)>/gi, (_, id) => {
      const hit = resolveCustomEmojiByUid(String(id || '').trim());
      return resolveCustomEmojiDisplayUrl(hit) ? customEmojiImgHtml(hit) : '';
    });
    out = out.replace(/<chat-emoji\b[^>]*\/?>/gi, (tag) => {
      const ref = tag.match(/data-custom-emoji="([^"]+)"/i)?.[1] || '';
      const name = tag.match(/data-emoji-name="([^"]+)"/i)?.[1] || '';
      if (ref) {
        const id = ref.replace(/^customEmojis\//i, '');
        const hit = resolveCustomEmojiByUid(id);
        if (resolveCustomEmojiDisplayUrl(hit)) return customEmojiImgHtml(hit);
      }
      if (name) {
        const hit = resolveCustomEmojiFromShortcode(name);
        if (hit?.imageUrl) return customEmojiImgHtml(hit, name);
      }
      return '';
    });
    return out.replace(/:{1,2}([a-z0-9_-]+):{1,2}/gi, (match) => {
      const hit = resolveCustomEmojiFromShortcode(match);
      return resolveCustomEmojiDisplayUrl(hit) ? customEmojiImgHtml(hit, match) : match;
    });
  });
}

function repairCustomEmojiImgHtml(html) {
  return String(html || '').replace(/<img\b([^>]*)>/gi, (full, attrs) => {
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    const label = attrs.match(/\btitle\s*=\s*["']([^"']*)["']/i)?.[1]
      || attrs.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1]
      || '';
    let hit = null;
    if (src.startsWith('gchat-emoji://')) {
      hit = resolveCustomEmojiByUid(parseCustomEmojiProtocolUid(src));
    }
    if (!hit) {
      hit = resolveCustomEmojiFromShortcode(label) || resolveCustomEmojiByUid(
        String(label || '').trim().replace(/^:+|:+$/g, '')
      );
    }
    const displayUrl = resolveCustomEmojiDisplayUrl(hit);
    if (displayUrl) return customEmojiImgHtml(hit, label || hit?.emojiName || '');
    if (src && !src.startsWith('gchat-emoji://')) return full;
    const plain = String(label || '').trim();
    return plain ? escapeHtmlLite(plain) : '';
  });
}

function finalizeChatMessageTextHtml(mixed) {
  if (!mixed) return '';
  return String(mixed).split(/(<img\b[^>]*>)/gi).map((part) => {
    if (/^<img\b/i.test(part)) return part;
    return escapeHtmlLite(part);
  }).join('');
}

function scrubCustomEmojiPlaceholders(text) {
  return String(text || '')
    .replace(/\uFFFC/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/\uFEFF/g, '');
}

function compactEmojiAnnotations(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.annotations || []);
  return list
    .filter((a) => a?.customEmojiMetadata || /CUSTOM_EMOJI/i.test(String(a?.type || '')))
    .map((a) => ({
      s: Number(a.startIndex) || 0,
      l: Number(a.length) || 0,
      u: String(a.customEmojiMetadata?.customEmoji?.uid || '').trim(),
      e: String(a.customEmojiMetadata?.customEmoji?.emojiName || '').trim(),
      n: String(a.customEmojiMetadata?.customEmoji?.name || '').trim()
    }))
    .filter((a) => a.l > 0);
}

function emojiAnnotationsToApi(compact) {
  return (compact || []).map((a) => ({
    startIndex: a.s,
    length: a.l,
    type: 'CUSTOM_EMOJI',
    customEmojiMetadata: {
      customEmoji: {
        uid: a.u,
        emojiName: a.e,
        name: a.n || (a.u ? `customEmojis/${a.u}` : '')
      }
    }
  }));
}

function rebuildChatMessageTextHtml(msg) {
  const cardHtml = String(msg?.cardHtml || '').trim();
  const text = String(msg?.text || '').trim();
  // 有卡片 UI 時：本文若只是卡片摘要文字，避免再平鋪一次
  const textLooksLikeCardDump = !!(cardHtml && text && msg?.cardText && text === String(msg.cardText || '').trim());
  let textHtml = '';
  if (text && !textLooksLikeCardDump) {
    let mixed = replaceCustomEmojiPlaceholders(text, emojiAnnotationsToApi(msg?.emojiAnnotations));
    mixed = expandInlineCustomEmojiMarkup(mixed);
    mixed = scrubCustomEmojiPlaceholders(mixed);
    textHtml = repairCustomEmojiImgHtml(finalizeChatMessageTextHtml(mixed));
  }
  if (cardHtml) {
    return textHtml ? `${textHtml}${cardHtml}` : cardHtml;
  }
  if (!textHtml && !(msg?.cardLinks?.length)) return '';
  return appendCardLinksToHtml(textHtml, msg?.cardLinks);
}

function buildChatMessageTextHtml(raw, fallbackText = '') {
  const cardHtml = buildChatCardsHtml(extractChatCardModels(raw));
  const text = scrubCustomEmojiPlaceholders(String(plainChatMessageText(raw) || (!cardHtml ? fallbackText : '') || '').trim());
  const links = extractChatCardLinks(raw);
  if (!text && !cardHtml && !links.length) return '';
  let textHtml = '';
  if (text) {
    let mixed = replaceCustomEmojiPlaceholders(text, raw?.annotations || []);
    mixed = expandInlineCustomEmojiMarkup(mixed);
    mixed = scrubCustomEmojiPlaceholders(mixed);
    textHtml = repairCustomEmojiImgHtml(finalizeChatMessageTextHtml(mixed));
  }
  if (cardHtml) {
    return textHtml ? `${textHtml}${cardHtml}` : cardHtml;
  }
  return appendCardLinksToHtml(textHtml, links);
}

function buildChatMessageTextHtmlFromText(text) {
  const t = scrubCustomEmojiPlaceholders(String(text || '').trim());
  if (!t) return '';
  return repairCustomEmojiImgHtml(finalizeChatMessageTextHtml(expandInlineCustomEmojiMarkup(t)));
}

function enrichChatMessageForDisplay(msg) {
  return ensureGchatMessageTransformService().enrichChatMessageForDisplay(msg);
}

function enrichChatThreadForDisplay(thread) {
  return ensureGchatMessageTransformService().enrichChatThreadForDisplay(thread);
}

function findCachedChatMessageByName(messageName) {
  return ensureGchatMessageTransformService().findCachedChatMessageByName(messageName);
}

function hydrateQuotedFromCache(quoted) {
  return ensureGchatMessageTransformService().hydrateQuotedFromCache(quoted);
}

function extractQuotedMessage(raw) {
  return ensureGchatMessageTransformService().extractQuotedMessage(raw);
}

function normalizeCustomEmojiKey(value) {
  const t = String(value || '').trim().toLowerCase();
  if (!t) return '';
  return t.replace(/^:+|:+$/g, '');
}

function isCustomEmojiShortcode(value) {
  const s = String(value || '').trim();
  return /^:{1,2}[a-z0-9_-]+:{1,2}$/i.test(s);
}

function ensureCustomEmojiMaps() {
  if (!gchatCache.customEmojis || typeof gchatCache.customEmojis !== 'object') gchatCache.customEmojis = {};
  if (!gchatCache.customEmojisByName || typeof gchatCache.customEmojisByName !== 'object') {
    gchatCache.customEmojisByName = {};
  }
  return { byUid: gchatCache.customEmojis, byName: gchatCache.customEmojisByName };
}

function isCustomEmojiQuotaError(err) {
  const msg = googleErrText(err);
  return /exceeded the API quota|customEmoji_reads|RESOURCE_EXHAUSTED|rate.?limit/i.test(msg);
}

function customEmojiCacheSnapshot() {
  const count = Object.keys(gchatCache.customEmojis || {}).length;
  const withImage = Object.values(gchatCache.customEmojis || {}).filter((e) => {
    if (!e?.uid) return false;
    return !!findCustomEmojiLocalImage(e.uid) || !!resolveCustomEmojiDisplayUrl(e);
  }).length;
  return { count, withImage };
}

function loadCustomEmojiRegistry() {
  try {
    const p = customEmojiRegistryPath();
    if (!fs.existsSync(p)) return;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const { byUid, byName } = ensureCustomEmojiMaps();
    customEmojiQuotaBlockedUntil = Number(data.quotaBlockedUntil) || 0;
    for (const e of data.emojis || []) {
      const uid = String(e?.uid || '').trim();
      if (!uid) continue;
      const emojiName = String(e.emojiName || '').trim();
      const local = findCustomEmojiLocalImage(uid);
      let storedUrl = String(e.imageUrl || '').trim();
      if (!local && storedUrl.startsWith('gchat-emoji://')) storedUrl = '';
      byUid[uid] = {
        uid,
        emojiName,
        name: String(e.name || `customEmojis/${uid}`),
        imageUrl: local ? customEmojiProtocolUrl(uid) : storedUrl
      };
      const key = normalizeCustomEmojiKey(emojiName);
      if (key) byName[key] = uid;
    }
    gchatCache.customEmojisAt = Number(data.updatedAt) || 0;
  } catch (err) {
    console.warn('[GChat] 讀取自訂表情登錄失敗:', err.message);
  }
}

function saveCustomEmojiRegistry(extra = {}) {
  try {
    const emojis = Object.values(gchatCache.customEmojis || {}).map((e) => ({
      uid: e.uid,
      emojiName: e.emojiName || '',
      name: e.name || '',
      imageUrl: String(e.imageUrl || '').trim()
    }));
    fs.writeFileSync(customEmojiRegistryPath(), JSON.stringify({
      updatedAt: gchatCache.customEmojisAt || Date.now(),
      quotaBlockedUntil: customEmojiQuotaBlockedUntil || 0,
      emojis,
      ...extra
    }));
  } catch (err) {
    console.warn('[GChat] 寫入自訂表情登錄失敗:', err.message);
  }
}

async function listAllCustomEmojisFromApi() {
  if (!oauth2Client) return [];
  const all = [];
  let pageToken = '';
  do {
    const url = new URL('https://chat.googleapis.com/v1/customEmojis');
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await chatHttp('GET', url.toString());
    all.push(...(data.customEmojis || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return all;
}

async function refreshCustomEmojiCache({ force = false } = {}) {
  if (!oauth2Client) return { success: false, error: '未登入' };
  const scope = await grantedScopeText();
  if (!scopeListHas(scope, [CHAT_CUSTOM_EMOJI_SCOPE])) {
    return { success: false, error: '缺少自訂表情讀取權限', needsAuth: true };
  }
  const now = Date.now();
  const snap = customEmojiCacheSnapshot();
  const hasRegistry = snap.count > 0;
  const hasLiveUrls = snap.withImage > 0;
  const cacheFresh = gchatCache.customEmojisAt && (now - gchatCache.customEmojisAt < CUSTOM_EMOJI_CACHE_TTL_MS);
  const quotaBlocked = customEmojiQuotaBlockedUntil && now < customEmojiQuotaBlockedUntil;

  if (quotaBlocked) {
    if (hasRegistry) {
      return {
        success: true,
        cached: true,
        count: snap.count,
        withImage: snap.withImage,
        quotaBlocked: true,
        warning: '自訂表情 API 配額已滿，使用本機快取'
      };
    }
    return {
      success: false,
      quotaBlocked: true,
      error: '自訂表情 API 配額已滿，請稍後再試（通常每日重置，重新登入無法解決）'
    };
  }

  if (!force && cacheFresh && hasRegistry) {
    return {
      success: true,
      cached: true,
      count: snap.count,
      withImage: snap.withImage
    };
  }
  try {
    const list = await listAllCustomEmojisFromApi();
    const { byUid, byName } = ensureCustomEmojiMaps();
    const nextUid = {};
    const nextName = {};
    for (const e of list) {
      const uid = String(e?.uid || '').trim();
      if (!uid) continue;
      const emojiName = String(e.emojiName || '').trim();
      const imageUrl = String(e.temporaryImageUri || e.temporary_image_uri || '').trim();
      const prev = byUid[uid] || {};
      const row = {
        uid,
        emojiName,
        imageUrl: imageUrl || prev.imageUrl || '',
        name: String(e.name || prev.name || `customEmojis/${uid}`)
      };
      nextUid[uid] = row;
      const key = normalizeCustomEmojiKey(emojiName);
      if (key) nextName[key] = uid;
      if (imageUrl) queueCustomEmojiImageDownload(uid, imageUrl);
    }
    gchatCache.customEmojis = nextUid;
    gchatCache.customEmojisByName = nextName;
    gchatCache.customEmojisAt = now;
    customEmojiQuotaBlockedUntil = 0;
    for (const uid of Object.keys(nextUid)) {
      if (findCustomEmojiLocalImage(uid)) {
        nextUid[uid].imageUrl = customEmojiProtocolUrl(uid);
      }
    }
    saveCustomEmojiRegistry();
    return { success: true, count: Object.keys(nextUid).length };
  } catch (err) {
    if (isCustomEmojiQuotaError(err)) {
      customEmojiQuotaBlockedUntil = now + CUSTOM_EMOJI_QUOTA_BACKOFF_MS;
      saveCustomEmojiRegistry();
      if (hasRegistry) {
        console.warn('[Chat] 自訂表情 API 配額已滿，改用本機快取（', snap.withImage, ' 個含圖片）');
        return {
          success: true,
          cached: true,
          quotaBlocked: true,
          count: snap.count,
          withImage: snap.withImage,
          warning: '自訂表情 API 配額已滿，使用本機快取'
        };
      }
    }
    logGchatApiIssue('自訂表情載入失敗', err);
    if (hasRegistry) {
      return {
        success: true,
        cached: true,
        count: snap.count,
        withImage: snap.withImage,
        warning: googleErrText(err) || err.message
      };
    }
    return { success: false, error: googleErrText(err) || err.message, quotaBlocked: isCustomEmojiQuotaError(err) };
  }
}

function resolveCustomEmojiByUid(uid) {
  const id = String(uid || '').trim();
  if (!id) return null;
  return gchatCache.customEmojis?.[id] || null;
}

/** 建立 reaction 前解析自訂表情；API 輸入需 resource name，非 output-only 的 uid */
async function resolveCustomEmojiForReaction(customUid) {
  const id = String(customUid || '').trim();
  if (!id) return null;
  let hit = resolveCustomEmojiByUid(id);
  if (!hit) return null;
  const uid = String(hit.uid || id).trim();
  const storedName = String(hit.name || '').trim();
  const name = /^customEmojis\//.test(storedName) ? storedName : `customEmojis/${uid}`;
  return {
    uid,
    name,
    emojiName: hit.emojiName || '',
    imageUrl: resolveCustomEmojiDisplayUrl(hit)
  };
}

function enrichReactionRow(row) {
  return ensureGchatMessageTransformService().enrichReactionRow(row);
}

function listCustomEmojisForUi() {
  return Object.values(gchatCache.customEmojis || {})
    .filter((e) => e?.uid)
    .map((e) => ({
      uid: e.uid,
      emojiName: e.emojiName || '',
      imageUrl: resolveCustomEmojiDisplayUrl(e),
      label: e.emojiName || e.uid
    }))
    .sort((a, b) => a.emojiName.localeCompare(b.emojiName));
}

function extractReactionSummaries(raw, messageName = '') {
  return ensureGchatMessageTransformService().extractReactionSummaries(raw, messageName);
}

function mediaSnippet(media) {
  if (!media?.length) return '';
  const gifs = media.filter(m => m.kind === 'gif').length;
  const images = media.filter(m => m.kind === 'image').length;
  const pdfs = media.filter(m => m.kind === 'pdf').length;
  const files = media.filter(m => m.kind === 'file').length;
  const parts = [];
  if (gifs) parts.push(gifs === 1 ? '[GIF]' : `[GIF×${gifs}]`);
  if (images) parts.push(images === 1 ? '[圖片]' : `[圖片×${images}]`);
  if (pdfs) parts.push(pdfs === 1 ? '[PDF]' : `[PDF×${pdfs}]`);
  if (files) parts.push(files === 1 ? '[附件]' : `[附件×${files}]`);
  return parts.join(' ');
}

function gchatLabelRichness(label) {
  const s = String(label || '').trim();
  if (!s) return 0;
  const segments = s.split(/[-_]/).filter(Boolean).length;
  return segments * 100 + s.length;
}

function pickRicherGchatLabel(a, b) {
  const sa = String(a || '').trim();
  const sb = String(b || '').trim();
  if (!sa) return sb;
  if (!sb) return sa;
  if (sa.includes(sb) && sa.length > sb.length) return sa;
  if (sb.includes(sa) && sb.length > sa.length) return sb;
  return gchatLabelRichness(sa) >= gchatLabelRichness(sb) ? sa : sb;
}

function buildDirectoryPersonLabel(person, labelOverride) {
  const override = String(labelOverride || '').trim();
  const displayName = String(person?.names?.[0]?.displayName || '').trim();
  const base = displayName || person?.emailAddresses?.[0]?.value || '';
  if (!base) return override;
  if (override) return pickRicherGchatLabel(override, displayName);
  if (displayName && (displayName.includes('_') || displayName.includes('-'))) return displayName;
  const org = (person?.organizations || [])[0] || {};
  const dept = String(org.department || org.name || '').trim();
  const title = String(org.title || '').trim();
  let constructed = base;
  if (dept && !base.includes(dept)) {
    constructed = title && !dept.includes(title) && !base.includes(title)
      ? `${dept}_${title}_${base}`
      : `${dept}_${base}`;
  }
  return pickRicherGchatLabel(displayName, constructed);
}

function rememberGchatUserName(resource, label) {
  const name = String(label || '').trim();
  if (!resource || !name || name === '成員' || name === '未知' || name.startsWith('使用者 ')) return '';
  const prev = gchatCache.userNames[resource];
  gchatCache.userNames[resource] = pickRicherGchatLabel(prev, name);
  return gchatCache.userNames[resource];
}

/** 把 People / Directory 回傳的各種 ID 都對到 users/{id}，才能對上 Chat sender */
function ingestDirectoryPerson(person, labelOverride) {
  if (!person) return;
  const label = buildDirectoryPersonLabel(person, labelOverride);
  if (!label) return;
  const touched = [];

  const remember = (resource) => {
    if (!resource) return;
    touched.push(resource);
    rememberGchatUserName(resource, label);
  };

  const rn = String(person.resourceName || '');
  if (rn.startsWith('people/')) {
    const rawId = rn.slice('people/'.length);
    if (rawId) {
      remember(`users/${rawId}`);
      if (rawId.startsWith('c')) {
        remember(`users/${rawId.slice(1)}`);
      }
    }
  }
  for (const source of person.metadata?.sources || []) {
    const sid = String(source?.id || '').trim();
    if (!sid) continue;
    remember(`users/${sid}`);
    if (sid.startsWith('c')) remember(`users/${sid.slice(1)}`);
  }
  for (const email of person.emailAddresses || []) {
    if (email?.value) remember(`users/${email.value}`);
  }

  // [Important] 同一人多個 resource key 統一成最詳細姓名，避免搜尋雙重身分
  const richest = touched.reduce(
    (best, key) => pickRicherGchatLabel(best, gchatCache.userNames[key]),
    label
  );
  for (const key of touched) {
    gchatCache.userNames[key] = richest;
  }

  // 大頭照（Google Chat 聯絡人 Icon）
  try {
    ensureGchatIconService().ingestPersonPhotos(person);
  } catch (_) {}
}

function noteDirectoryError(err) {
  const msg = googleErrText(err);
  const blob = `${err?.code || ''} ${msg}`;
  if (/has not been used|is disabled|access not configured|API has not been/i.test(blob)) {
    gchatCache.directoryError = '請確認有 directory.readonly（網域通訊錄）權限';
    return;
  }
  if (/Not Authorized|not an admin|ADMIN_NOT_AUTHORIZED|403|forbidden|insufficient/i.test(blob)) {
    if (!gchatCache.directoryError) {
      gchatCache.directoryError = '目錄查詢被拒：請確認 OAuth 有「網域通訊錄／directory.readonly」權限';
    }
    return;
  }
  if (!gchatCache.directoryError && msg) gchatCache.directoryError = msg;
}

async function warmPeopleWithMask(readMask) {
  if (!peopleService) return 0;
  let count = 0;
  let pageToken;
  let pages = 0;
  do {
    const res = await peopleService.people.listDirectoryPeople({
      readMask,
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
      pageSize: 1000,
      pageToken
    });
    for (const person of res.data.people || []) {
      ingestDirectoryPerson(person);
      count += 1;
    }
    pageToken = res.data.nextPageToken;
    pages += 1;
  } while (pageToken && pages < 20);
  return count;
}

async function warmFromPeopleDirectory() {
  const masks = [
    'names,emailAddresses,metadata,organizations,photos',
    'names,emailAddresses,metadata,photos',
    'names,emailAddresses,metadata,organizations',
    'names,emailAddresses,metadata',
    'names,emailAddresses,organizations',
    'names,emailAddresses'
  ];
  for (const readMask of masks) {
    try {
      const n = await warmPeopleWithMask(readMask);
      if (n > 0) {
        if (gchatCache.directoryError && /Admin SDK/i.test(gchatCache.directoryError)) {
          // People 成功即可清掉「只有 Admin 失敗」的提示
          gchatCache.directoryError = '';
        }
        return n;
      }
    } catch (err) {
      // 一般員工常見：網域未開通訊錄分享 → 安靜略過，避免 CMD 刷屏
      if (!/Not Authorized|403|forbidden|insufficient/i.test(String(err?.message || ''))) {
        console.warn('People 目錄預熱失敗:', readMask, err.message);
      }
      noteDirectoryError(err);
    }
  }
  return 0;
}

async function warmGchatUserDirectory(force = false) {
  if (gchatCache.directoryWarmed && !force) return;
  const peopleCount = await warmFromPeopleDirectory();
  gchatCache.directoryStats = { admin: 0, people: peopleCount };
  if (peopleCount > 0) {
    gchatCache.userNames = scrubGchatUserNamesByPerson(gchatCache.userNames);
    gchatCache.directoryWarmed = true;
    gchatCache.directorySyncedAt = Date.now();
    gchatCache.directoryError = '';
    saveGchatDisk();
    hydratePinnedIcons().catch(() => {});
  } else {
    gchatCache.directoryWarmed = true;
    if (!gchatCache.directoryError) {
      gchatCache.directoryError = '無法讀取網域通訊錄姓名（需 directory.readonly）';
    }
    setTimeout(() => { gchatCache.directoryWarmed = false; }, 5 * 60 * 1000);
  }
}

async function lookupPeopleUser(id) {
  if (!peopleService || !id) return '';
  const resourceNames = [`people/${id}`, id.startsWith('c') ? `people/${id}` : `people/c${id}`];
  for (const resourceName of resourceNames) {
    try {
      const person = await peopleService.people.get({
        resourceName,
        personFields: 'names,emailAddresses,metadata,organizations'
      });
      ingestDirectoryPerson(person.data);
      const label = gchatCache.userNames[`users/${id}`]
        || person.data.names?.[0]?.displayName
        || person.data.emailAddresses?.[0]?.value
        || '';
      if (label) return label;
    } catch (_) {}
  }
  return '';
}

async function resolveSenderName(sender, spaceName) {
  if (!sender) return '未知';
  if (sender.displayName) return rememberGchatUserName(sender.name, sender.displayName) || sender.displayName;
  if (sender.type === 'BOT') return '機器人';
  const resource = sender.name || '';
  if (!resource.startsWith('users/')) return '未知寄件者';
  const cached = gchatCache.userNames[resource];
  if (cached && cached !== '成員' && cached !== '未知' && !cached.startsWith('使用者 ')) return cached;

  const id = resource.slice('users/'.length);
  if (id.includes('@')) return rememberGchatUserName(resource, id) || id;
  return id ? `使用者 ${id.slice(-6)}` : '未知寄件者';
}

async function mediaResourceToDataUrl(resourceName, contentType) {
  if (!resourceName || !oauth2Client || !chatService) return '';
  if (isChatApiQuotaBlocked()) return '';
  const name = String(resourceName).trim();
  try {
    const cache = ensureGchatMediaCache();
    const cached = cache.read(name);
    let buf = cached?.buf || null;
    let mime = String(contentType || cached?.mime || '').trim();
    if (!buf) {
      buf = await cache.getOrDownload(
        name,
        () => ensureGchatChatApiService().downloadMediaRaw(name),
        contentType
      );
    }
    if (!buf || !buf.length || buf.length > 20 * 1024 * 1024) return '';
    if (!mime || mime === 'application/octet-stream') {
      const lower = name.toLowerCase();
      if (/\.png(\b|$)/i.test(lower) || /png/i.test(mime)) mime = 'image/png';
      else if (/\.jpe?g(\b|$)/i.test(lower)) mime = 'image/jpeg';
      else if (/\.gif(\b|$)/i.test(lower)) mime = 'image/gif';
      else if (/\.webp(\b|$)/i.test(lower)) mime = 'image/webp';
      else if (/\.pdf(\b|$)/i.test(lower)) mime = 'application/pdf';
      else mime = mime || 'image/png';
    }
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (err) {
    if (isChatQuotaError(err)) markChatApiQuotaBlocked(err, 'Chat 媒體下載');
    throw err;
  }
}

async function hydrateChatMedia(media) {
  if (isChatApiQuotaBlocked()) {
    return (media || []).map((item) => {
      const copy = { ...item };
      if (!copy.previewUrl && copy.thumbnailUri) copy.previewUrl = copy.thumbnailUri;
      return copy;
    });
  }
  const next = [];
  for (const item of media || []) {
    const copy = { ...item };
    // 檔名 image.png 但 contentType 空／octet-stream 時，仍當圖片
    if (copy.kind === 'file' && isChatImageType(copy.contentType, copy.name)) {
      copy.kind = 'image';
    }
    if (copy.kind === 'file' && isChatPdfType(copy.contentType, copy.name)) {
      copy.kind = 'pdf';
    }
    const isImage = copy.kind === 'image' || copy.kind === 'gif' || isChatImageType(copy.contentType, copy.name);
    const isPdf = copy.kind === 'pdf' || isChatPdfType(copy.contentType, copy.name);
    if (copy.kind === 'gif' && copy.uri) {
      copy.previewUrl = copy.uri;
      copy.dataUrl = copy.uri;
    } else if ((isImage || isPdf) && copy.resourceName && !copy.dataUrl) {
      try {
        copy.dataUrl = await mediaResourceToDataUrl(
          copy.resourceName,
          copy.contentType || (isPdf ? 'application/pdf' : (isChatImageType(copy.contentType, copy.name) ? guessImageMime(copy.name) : 'image/png'))
        );
        if (copy.dataUrl && isImage) {
          copy.kind = copy.kind === 'gif' ? 'gif' : 'image';
          copy.previewUrl = copy.dataUrl;
        }
        if (copy.dataUrl && isPdf) copy.kind = 'pdf';
      } catch (err) {
        if (isChatQuotaError(err)) markChatApiQuotaBlocked(err, 'Chat 媒體下載');
      }
      // [Important] thumbnailUri 僅供人工預覽，不可當 Chat app 的 img src
    } else if (copy.thumbnailUri && !copy.previewUrl && !copy.dataUrl && copy.kind !== 'image' && copy.kind !== 'pdf') {
      copy.previewUrl = copy.thumbnailUri;
    }
    if (copy.driveFileId && !copy.dataUrl) {
      copy.openUrl = `https://drive.google.com/file/d/${copy.driveFileId}/view`;
    }
    if (isPdf && copy.kind !== 'pdf') copy.kind = 'pdf';
    next.push(copy);
  }
  return next;
}

function guessImageMime(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}

/** 暫存可能剝掉 dataUrl：開啟對話前補下載，否則 image.png 無法預覽 */
function threadNeedsMediaHydration(thread) {
  const list = Array.isArray(thread) ? thread : [];
  for (const m of list) {
    if (!m?.media?.length) continue;
    for (const x of m.media) {
      if (!x) continue;
      if (x.dataUrl) continue;
      const imageLike = x.kind === 'image' || x.kind === 'gif' || x.kind === 'pdf'
        || isChatImageType(x.contentType, x.name)
        || isChatPdfType(x.contentType, x.name);
      if (imageLike && !!(x.resourceName || x.uri || x.thumbnailUri || x.previewUrl)) return true;
    }
  }
  return false;
}

async function ensureThreadMediaHydrated(thread) {
  if (isChatApiQuotaBlocked()) return Array.isArray(thread) ? thread : [];
  const list = Array.isArray(thread) ? thread : [];
  const candidates = [];
  for (const m of list) {
    if (!m?.media?.length) continue;
    const needs = m.media.some((x) => {
      if (!x) return false;
      if (x.dataUrl) return false;
      const imageLike = x.kind === 'image' || x.kind === 'gif' || x.kind === 'pdf'
        || isChatImageType(x.contentType, x.name)
        || isChatPdfType(x.contentType, x.name);
      return imageLike && !!(x.resourceName || x.uri);
    });
    if (needs) candidates.push(m);
  }
  candidates.sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')));
  let hydrated = 0;
  for (const m of candidates) {
    if (hydrated >= CHAT_MEDIA_HYDRATE_LIMIT) break;
    try {
      m.media = await hydrateChatMedia(m.media);
      hydrated++;
    } catch (_) {}
  }
  return list;
}

async function normalizeChatMessage(raw, spaceDisplayName) {
  return ensureGchatMessageTransformService().normalizeChatMessage(raw, spaceDisplayName);
}

function isMutedSpaceSetting(setting) {
  const mute = String(setting || '').toUpperCase();
  return mute === 'MUTED' || mute === 'MUTE_NOTIFICATIONS';
}

/** Chat API 的 users/me → 真實 users/{id}（左右對齊最準） */
async function resolveMyChatUserFromSpace(spaceName) {
  if (!chatService || !spaceName) return '';
  const rememberFromMembership = (mem) => {
    const userName = String(mem?.member?.name || '').trim();
    const resource = String(mem?.name || '').trim(); // spaces/.../members/users/xxx
    let resolved = '';
    if (userName.startsWith('users/') && userName !== 'users/me') resolved = userName;
    else {
      const m = resource.match(/\/members\/(users\/[^/]+)$/i);
      if (m && m[1] !== 'users/me') resolved = m[1];
    }
    if (!resolved) return '';
    rememberMyGchatIdentity(resolved);
    gchatCache.myUserName = resolved;
    if (mem?.member?.displayName) rememberMyGchatLabel(mem.member.displayName);
    return resolved;
  };
  try {
    const mem = await ensureGchatChatApiService().getSpaceMemberRaw(`${spaceName}/members/users/me`);
    const hit = rememberFromMembership(mem);
    if (hit) return hit;
  } catch (_) {}
  // 備援：列出成員，比對 email／已記 id，或抓 users/me 那筆
  try {
    const memberships = await ensureGchatChatApiService().listSpaceMembersRaw(spaceName, { pageSize: 50 });
    for (const mem of memberships) {
      const name = String(mem?.member?.name || '');
      const email = String(mem?.member?.email || '').toLowerCase();
      if (name === 'users/me' || name.endsWith('/me')) {
        const hit = rememberFromMembership(mem);
        if (hit) return hit;
      }
      if (cache.myEmail && email && email === String(cache.myEmail).toLowerCase()) {
        const hit = rememberFromMembership(mem);
        if (hit) return hit;
      }
      if (name && gchatMyIdentityKeys().has(name)) {
        rememberMyGchatIdentity(name);
        gchatCache.myUserName = name;
        return name;
      }
    }
  } catch (_) {}
  return '';
}

async function ensureMyChatUserName(spaceName) {
  const remember = (id) => {
    if (!id) return;
    rememberMyGchatIdentity(id);
  };
  try {
    const info = await oauth2Client.request({
      url: 'https://www.googleapis.com/oauth2/v3/userinfo'
    });
    if (info?.data?.sub) remember(`users/${info.data.sub}`);
    if (info?.data?.email) {
      cache.myEmail = info.data.email;
      remember(`users/${info.data.email}`);
      remember(info.data.email);
    }
    if (info?.data?.name) rememberMyGchatLabel(info.data.name);
  } catch (_) {}
  try {
    if (peopleService) {
      const me = await peopleService.people.get({
        resourceName: 'people/me',
        personFields: 'metadata,emailAddresses,names'
      });
      for (const source of me.data.metadata?.sources || []) {
        if ((source.type === 'PROFILE' || source.type === 'DOMAIN_PROFILE' || source.type === 'ACCOUNT') && source.id) {
          remember(`users/${source.id}`);
          if (String(source.id).startsWith('c')) remember(`users/${String(source.id).slice(1)}`);
        }
      }
      const email = me.data.emailAddresses?.[0]?.value || cache.myEmail;
      if (email) {
        cache.myEmail = email;
        remember(`users/${email}`);
        remember(email);
      }
      for (const n of me.data.names || []) {
        if (n.displayName) rememberMyGchatLabel(n.displayName);
        if (n.unstructuredName) rememberMyGchatLabel(n.unstructuredName);
      }
    }
  } catch (_) {}
  if (cache.myEmail) {
    remember(`users/${cache.myEmail}`);
    remember(cache.myEmail);
  }
  if (spaceName) {
    await resolveMyChatUserFromSpace(spaceName);
  }
  if (!gchatCache.myUserName && gchatCache.myIds?.length) {
    gchatCache.myUserName = gchatCache.myIds.find(x => String(x).startsWith('users/') && !String(x).includes('@'))
      || gchatCache.myIds.find(x => String(x).startsWith('users/'))
      || gchatCache.myIds[0];
  }
  return gchatCache.myUserName || '';
}

function messageMentionsMe(msg, myUserName) {
  const myIds = new Set();
  if (myUserName) {
    myIds.add(myUserName);
    if (myUserName.startsWith('users/')) myIds.add(myUserName.slice('users/'.length));
    else myIds.add(`users/${myUserName}`);
  }
  if (cache.myEmail) {
    myIds.add(`users/${cache.myEmail}`);
    myIds.add(cache.myEmail);
  }
  // Chat 搜尋／註解有時直接給 users/me
  myIds.add('users/me');
  myIds.add('me');

  for (const ann of msg?.annotations || []) {
    const mention = ann.userMention || {};
    const name = String(mention.user?.name || '').trim();
    const type = String(ann.type || mention.type || '').toUpperCase();
    // 沒有明確類型時，只要有 userMention 也當提及
    const looksMention = !type
      || type === 'USER_MENTION'
      || type === 'MENTION'
      || !!ann.userMention;
    if (!looksMention) continue;
    if (!name) {
      // 有 USER_MENTION 卻沒帶 name：保守當作可能是 @我（交給搜尋路徑再確認）
      if (type === 'USER_MENTION' || ann.userMention) continue;
      continue;
    }
    if (myIds.has(name)) return true;
    const bare = name.startsWith('users/') ? name.slice('users/'.length) : name;
    if (bare && myIds.has(bare)) return true;
    if (name === 'users/me' || bare === 'me') return true;
  }

  const formatted = String(msg?.formattedText || msg?.argumentText || '');
  for (const id of myIds) {
    if (!id) continue;
    const bare = String(id).replace(/^users\//, '');
    if (!bare || bare === 'me') continue;
    if (formatted.includes(`<users/${bare}>`)) return true;
    if (formatted.includes(`users/${bare}`)) return true;
  }
  // 常見格式：@DisplayName 在純文字（備援，較寬鬆但只在有 @ 時）
  if (cache.myEmail) {
    const local = String(cache.myEmail).split('@')[0];
    if (local && msg?.text && new RegExp(`@${local}\\b`, 'i').test(msg.text)) return true;
  }
  return false;
}

async function ensureSpaceMeta(spaceName) {
  if (!spaceName) return { label: '對話', spaceType: '' };
  const cachedType = gchatCache.spaceTypes[spaceName];
  const cachedLabel = gchatCache.spaceNames[spaceName];
  // 快取若已是可用名稱就直接用；私人卻是「對話／私人訊息」則強制重解成員
  const cacheOk = !!(cachedType && cachedLabel && !(
    cachedType === 'DIRECT_MESSAGE' && isWeakGchatBubbleTitle(cachedLabel)
  ));
  if (cacheOk) {
    let label = cachedLabel;
    const spaceType = cachedType;
    if (spaceType === 'DIRECT_MESSAGE' && /[、,]/.test(String(label || ''))) {
      const cleaned = preferOtherPartyDmLabel(label);
      if (cleaned && cleaned !== label) {
        gchatCache.spaceNames[spaceName] = cleaned;
        label = cleaned;
      }
    }
    return { label, spaceType };
  }
  try {
    const space = await ensureGchatChatApiService().getSpaceRaw(spaceName);
    if (!space) throw new Error('無法取得空間');
    const spaceType = space.spaceType || cachedType || '';
    gchatCache.spaceTypes[spaceName] = spaceType;
    // [Important] 私人空間不要從 space raw 深掃圖（易誤抓），頭像改走對方成員
    if (spaceType !== 'DIRECT_MESSAGE') {
      try {
        const iconSvc = ensureGchatIconService();
        const fromSpace = iconSvc.extractIconFromSpaceRaw(space);
        iconSvc.rememberSpaceIcon(spaceName, fromSpace);
      } catch (_) {}
    }
    let label = space.displayName || '';
    // 私人：一律從成員名單取「對方」；群組無 displayName 時才用成員拼
    if (spaceType === 'DIRECT_MESSAGE' || (!label && spaceType === 'GROUP_CHAT')) {
      try {
        const memberships = await ensureGchatChatApiService().listSpaceMembersRaw(spaceName, { pageSize: 20 });
        const others = [];
        let peerUserName = '';
        const selfKeys = gchatMyIdentityKeys();
        for (const m of memberships) {
          const member = m.member || {};
          if (member.type === 'BOT') continue;
          if (member.name === 'users/me' || member.name?.endsWith('/me')) continue;
          const un = String(member.name || '').trim();
          if (un) {
            const bare = un.replace(/^users\//i, '');
            if (selfKeys.has(un) || selfKeys.has(un.toLowerCase()) || selfKeys.has(bare) || selfKeys.has(`users/${bare}`)) {
              continue;
            }
            if (gchatCache.myUserName && un === gchatCache.myUserName) continue;
            if (Array.isArray(gchatCache.myIds) && gchatCache.myIds.includes(un)) continue;
          }
          if (!peerUserName && un) {
            peerUserName = un;
          }
          const n = await resolveSenderName(member, spaceName);
          const candidate = (n && n !== '成員' && !String(n).startsWith('使用者 '))
            ? n
            : (member.displayName || '');
          if (!candidate || isGchatSelfDisplayLabel(candidate)) continue;
          others.push(candidate);
        }
        if (spaceType === 'DIRECT_MESSAGE' && peerUserName) {
          // 背景補齊對方大頭照（不阻塞 meta）
          ensureGchatIconService().resolveContactIcon(peerUserName).then((icon) => {
            if (icon?.iconUrl || icon?.emoji) {
              ensureGchatIconService().rememberSpaceIcon(spaceName, icon);
              ensureGchatIconService().rememberUserIcon(peerUserName, icon);
            }
          }).catch(() => {});
        }
        if (spaceType === 'DIRECT_MESSAGE' && others.length) {
          label = others[0];
        } else if (others.length) {
          label = others.slice(0, 3).join('、');
        }
      } catch (_) {}
    }
    if (spaceType === 'DIRECT_MESSAGE' && label) {
      label = preferOtherPartyDmLabel(label) || label;
    }
    if (!label || isWeakGchatBubbleTitle(label)) {
      label = spaceType === 'DIRECT_MESSAGE' ? '私人訊息' : spaceName.replace('spaces/', '');
    }
    gchatCache.spaceNames[spaceName] = label;
    return { label, spaceType };
  } catch (_) {
    const fallback = cachedLabel || spaceName.replace('spaces/', '');
    if (!gchatCache.spaceNames[spaceName]) gchatCache.spaceNames[spaceName] = fallback;
    return { label: gchatCache.spaceNames[spaceName], spaceType: gchatCache.spaceTypes[spaceName] || '' };
  }
}

async function ensureSpaceDisplayName(spaceName) {
  const meta = await ensureSpaceMeta(spaceName);
  return meta.label;
}

function resolveMarkReadLastTime(maxCreateTime = '') {
  return ensureGchatReadMarkService().resolveMarkReadLastTime(maxCreateTime);
}

function newestCreateTimeInSpace(spaceName) {
  return ensureGchatReadMarkService().newestCreateTimeInSpace(spaceName);
}

function queueGchatMarkRead(messageName, meta = {}) {
  return ensureGchatReadMarkService().queueMarkRead(messageName, meta);
}

async function markGchatSpaceReadBySpaceName(spaceName, extra = {}) {
  return ensureGchatReadMarkService().markSpaceReadBySpaceName(spaceName, extra);
}

/** 點泡泡／開回覆：立刻把該對話當下未讀全部標已讀 */
async function markGchatConversationReadByName(messageName, extra = {}) {
  return ensureGchatReadMarkService().markConversationReadByName(messageName, extra);
}

function clearGchatPendingForSpace(spaceName, spaceKey) {
  ensureGchatReadMarkService().clearPendingForSpace(spaceName, spaceKey);
}

function clearGchatPendingForMessage(messageName, spaceName = '') {
  ensureGchatReadMarkService().clearPendingForMessage(messageName, spaceName);
}

/**
 * 將 Chat API search 結果 normalize 成 inbox items（Sync 層；不含 HTTP）
 */
async function normalizeUnreadSearchResults(mentionRows, unreadRows, myUserName) {
  const items = [];
  const seen = new Set();

  const pushItem = async (row, { forceMentioned, requireDm }) => {
    const msg = row?.message;
    if (!msg?.name) return;
    if (seen.has(msg.name)) return;
    const parsed = parseChatResource(msg.name);
    if (isLocallyReadMessage(msg.name, {
      spaceName: parsed.spaceName,
      createTime: msg.createTime || ''
    }) || isLocallyReadConversation({ name: msg.name, spaceName: parsed.spaceName, createTime: msg.createTime || '' })) return;
    if (row.read === true) return;

    const mute = row.spaceMuteSetting || '';
    if (mute) gchatCache.spaceMute[parsed.spaceName] = mute;
    if (isMutedSpaceSetting(mute) || isMutedSpaceSetting(gchatCache.spaceMute[parsed.spaceName])) {
      return;
    }

    const meta = await ensureSpaceMeta(parsed.spaceName);
    const spaceType = meta.spaceType || '';
    const isDm = spaceType === 'DIRECT_MESSAGE';
    if (requireDm && !isDm) return;
    if (requireDm && !spaceType) return;

    let mentionedMe = messageMentionsMe(msg, myUserName);
    if (forceMentioned) mentionedMe = true;
    if (!isDm && !mentionedMe) return;

    const item = await normalizeChatMessage(msg, meta.label);
    item.spaceType = spaceType;
    item.isDm = isDm;
    item.mentionedMe = !!mentionedMe;
    items.push(item);
    seen.add(msg.name);
  };

  for (const row of mentionRows) {
    await pushItem(row, { forceMentioned: true, requireDm: false });
  }

  for (const row of unreadRows) {
    const msg = row?.message;
    if (!msg?.name || seen.has(msg.name)) continue;
    const parsed = parseChatResource(msg.name);
    const meta = await ensureSpaceMeta(parsed.spaceName);
    const isDm = meta.spaceType === 'DIRECT_MESSAGE';
    if (isDm) {
      await pushItem(row, { forceMentioned: false, requireDm: true });
    } else if (messageMentionsMe(msg, myUserName)) {
      await pushItem(row, { forceMentioned: true, requireDm: false });
    }
  }

  items.sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')));
  return items;
}

/** Inbox sync：ChatApiService 取資料 + normalize（Sync 層入口） */
async function fetchUnreadInboxItems() {
  const api = ensureGchatChatApiService();
  const myUserName = await ensureMyChatUserName();

  let mentionRows = [];
  let unreadRows = [];
  try {
    mentionRows = await api.searchUnreadMentioned();
  } catch (err) {
    logGchatApiIssue('提及搜尋失敗', err);
  }
  try {
    unreadRows = await api.searchUnreadAll();
  } catch (err) {
    logGchatApiIssue('未讀搜尋失敗', err);
    if (isTransientGoogleError(err)) {
      return Array.isArray(gchatCache.messages) ? [...gchatCache.messages] : [];
    }
    throw err;
  }

  return normalizeUnreadSearchResults(mentionRows, unreadRows, myUserName);
}

async function flushGchatPending() {
  const stack = ensureGchatSyncStack();
  await stack.readSync.flushToServer();
}

async function assertChatReadStateScopeForGchat() {
  const scope = await grantedScopeText();
  if (!hasChatReadStateScope(scope)) {
    throw new Error('缺少 Chat 已讀狀態權限');
  }
}

function applyGchatSpaceReadLocal(spaceName, readTime) {
  ensureGchatReadMarkService().applySpaceReadLocal(spaceName, readTime);
}

async function markGchatSpaceReadRemote(spaceName, lastReadTime) {
  return ensureGchatReadMarkService().markSpaceReadRemote(spaceName, lastReadTime);
}

async function markChatMessageReadRemote(messageName, meta = {}) {
  return ensureGchatReadMarkService().markMessageReadRemote(messageName, meta);
}

async function bootstrapGchatAuthCache({ force = false } = {}) {
  if (!oauth2Client || !chatService) return { skipped: true };
  // [Important] ADR 0006：通訊錄／表情預載也綁 Active Feature
  if (!isFeatureActive('gchat')) return { skipped: true, reason: 'feature_inactive' };
  const scope = await grantedScopeText();
  if (!hasChatScopes(scope)) return { skipped: true };
  if (isChatApiQuotaBlocked()) return { skipped: true, quotaBlocked: true };
  const now = Date.now();
  loadGchatDisk();
  loadCustomEmojiRegistry();
  const nameCount = Object.keys(gchatCache.userNames || {}).length;
  const directoryStale = force
    || !gchatCache.directorySyncedAt
    || (now - gchatCache.directorySyncedAt > GCHAT_DIRECTORY_CACHE_TTL_MS)
    || nameCount < 5;
  if (directoryStale) {
    try {
      if (scopeListHas(scope, [CHAT_DIRECTORY_SCOPE])) {
        await warmGchatUserDirectory(force);
      } else if (!gchatCache.directoryError) {
        // Extended 缺權限：不擋主路徑
        gchatCache.directoryError = '缺少網域通訊錄延伸權限（可稍後補充授權）';
      }
    } catch (err) {
      logGchatApiIssue('通訊錄預載失敗', err);
    }
  } else {
    gchatCache.directoryWarmed = true;
  }
  const emojiStale = force
    || !gchatAuthBootstrapAt
    || (now - gchatAuthBootstrapAt > CUSTOM_EMOJI_CACHE_TTL_MS);
  if (emojiStale) {
    try {
      if (scopeListHas(scope, [CHAT_CUSTOM_EMOJI_SCOPE])) {
        await refreshCustomEmojiCache({ force: false });
        await hydrateCustomEmojiImages({ max: CUSTOM_EMOJI_HYDRATE_BATCH });
      }
    } catch (err) {
      logGchatApiIssue('自訂表情預載失敗', err);
    }
    gchatAuthBootstrapAt = now;
  }
  saveGchatDisk();
  saveCustomEmojiRegistry();
  return { success: true, directoryStale, emojiStale };
}

/** 啟動後背景預載通訊錄（僅 Little Reply 為 Active Feature 時；優先磁碟快取） */
function scheduleGchatDirectoryWarmOnStartup() {
  setTimeout(async () => {
    try {
      const session = await ensureGoogleSession({ silent: true });
      if (!session?.success) return;
      // [Important] ADR 0006：未加入工作台不打 Chat API（清單未到則略過，等 reconcile）
      if (!isFeatureActive('gchat')) return;
      const scope = await grantedScopeText();
      if (!hasChatScopes(scope)) return;
      if (!oauth2Client || !chatService) initGoogleServices();
      await bootstrapGchatAuthCache({ force: false });
    } catch (err) {
      console.warn('[GChat] 啟動預載通訊錄失敗:', err.message);
    }
  }, 600);
}

function getGchatRepoContext() {
  return {
    getMessages: () => gchatCache.messages || [],
    setMessages: (msgs) => { gchatCache.messages = Array.isArray(msgs) ? msgs : []; },
    isLocallyReadMessage,
    rememberGchatTodayTouch,
    pickLabel: pickGoodGchatLabel,
    markLocallyRead: (name) => { if (name) gchatLocallyRead.add(name); }
  };
}

function getGchatCacheRepository() {
  return gchatSyncStack?.cacheRepository || null;
}

/** @returns {Promise<boolean>} false = 略過本輪 sync（未授權／配額） */
async function prepareGchatInboxSync() {
  if (!oauth2Client || !chatService) return false;
  const scope = await grantedScopeText();
  if (!hasChatScopes(scope)) return false;
  clearChatApiQuotaBlockedIfExpired();
  loadGchatDisk();
  if (isChatApiQuotaBlocked()) return false;

  const keepNames = scrubBadGchatUserNames(gchatCache.userNames);
  const keepWarmed = gchatCache.directoryWarmed && Object.keys(keepNames).length > 5;
  gchatCache.userNames = { ...gchatCache.userNames, ...keepNames };
  if (keepWarmed) gchatCache.directoryWarmed = true;
  if (!cache.myEmail && gmailService) {
    try {
      const profile = await gmailService.users.getProfile({ userId: 'me' });
      cache.myEmail = profile.data.emailAddress || '';
    } catch (_) {}
  }
  return true;
}

async function finalizeGchatInboxSync() {
  gchatCache.lastSync = Date.now();
  await packGchatPackets(gchatCache.messages);
  await packPinnedGchatConversations();
  saveGchatDisk();
}

async function prefetchGchatTodayCache({ notify = true } = {}) {
  // [Important] ADR 0006：未 Active 不拉 inbox／不打包歷史（避免 messages.list 背景打量）
  if (!isFeatureActive('gchat')) {
    gchatSyncLog('[SYNC] prefetch skipped (gchat not active)');
    return { skipped: true, reason: 'feature_inactive' };
  }
  const repo = getGchatCacheRepository();
  const syncSvc = gchatSyncStack?.syncService;
  let stats;
  let emittedBySyncService = false;
  if (syncSvc) {
    stats = await syncSvc.syncUnreadInbox();
    emittedBySyncService = true;
  } else if (repo) {
    stats = await repo.mergeUnreadInboxFromServer();
  } else {
    const prepared = await prepareGchatInboxSync();
    if (!prepared) {
      if (notify && win && !win.isDestroyed()) {
        emitGchatCacheChanged(gchatSnapshot());
      }
      return { skipped: true };
    }
    gchatSyncLog('[SYNC] search unread');
    const unread = await fetchUnreadInboxItems();
    stats = mergeUnreadInbox(getGchatRepoContext(), unread);
    gchatSyncLog('[CACHE] merged', `inbox=${stats?.count ?? 0} +${stats?.inserted ?? 0} ~${stats?.updated ?? 0} -${stats?.removed ?? 0}`);
    if (stats?.preservedRead > 0) {
      gchatSyncLog('[CACHE] locallyRead preserved', stats.preservedRead);
    }
    await finalizeGchatInboxSync();
  }

  if (notify && win && !win.isDestroyed() && !emittedBySyncService) {
    emitGchatCacheChanged(gchatSnapshot());
  }
  return stats;
}

function localDayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function localDayEndIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** [Important] Chat search API 欄位為 create_time，非 createTime */
function buildTodayMessagesSearchFilter() {
  const start = localDayStartIso();
  const end = localDayEndIso();
  return `create_time >= "${start}" AND create_time < "${end}"`;
}

async function ingestGchatTodaySearchRow(row) {
  const msg = row?.message;
  if (!msg?.name) return null;
  const parsed = parseChatResource(msg.name);
  const locallyRead = isLocallyReadMessage(msg.name, {
    spaceName: parsed.spaceName,
    createTime: msg.createTime || ''
  });
  const isUnread = row.read !== true && !locallyRead;

  const mute = row.spaceMuteSetting || '';
  if (mute) gchatCache.spaceMute[parsed.spaceName] = mute;
  if (isMutedSpaceSetting(mute) || isMutedSpaceSetting(gchatCache.spaceMute[parsed.spaceName])) {
    return null;
  }

  const meta = await ensureSpaceMeta(parsed.spaceName);
  const spaceType = meta.spaceType || '';
  const isDm = spaceType === 'DIRECT_MESSAGE';
  const myUserName = gchatCache.myUserName || await ensureMyChatUserName();
  const mentionedMe = messageMentionsMe(msg, myUserName);

  const item = await normalizeChatMessage(msg, meta.label);
  item.spaceType = spaceType;
  item.isDm = isDm;
  item.mentionedMe = !!mentionedMe;
  item.isRead = !isUnread;
  rememberGchatTodayTouch(item, { read: !isUnread });
  return item;
}

async function refreshGchatList() {
  await prefetchGchatTodayCache({ notify: false });
}

/** Sync 層：從 Server 拉討論串並寫入 PacketRepository */
async function syncGchatThreadFromServer(detail, { notifyUi = false } = {}) {
  if (!isFeatureActive('gchat')) {
    gchatSyncLog('[SYNC] thread skipped (gchat not active)');
    return null;
  }
  await ensureMyChatUserName(detail.spaceName);
  const thread = await loadConversationHistory({
    spaceName: detail.spaceName,
    threadName: detail.threadName || '',
    name: detail.name || detail.messageName || '',
    isDm: !!detail.isDm,
    spaceType: detail.spaceType || (detail.isDm ? 'DIRECT_MESSAGE' : ''),
    focusThread: !!detail.focusThread,
    rootMessageName: detail.rootMessageName || ''
  });
  const annotated = enrichChatThreadForDisplay(annotateGchatThreadMine(thread));
  if (!isChatApiQuotaBlocked()) {
    await ensureThreadMediaHydrated(annotated);
  }
  const packetRepo = ensureGchatPacketRepository();
  packetRepo.upsertLivePacket({
    spaceName: detail.spaceName,
    threadName: detail.threadName || '',
    name: detail.name || detail.messageName || '',
    isDm: !!detail.isDm,
    spaceType: detail.spaceType || (detail.isDm ? 'DIRECT_MESSAGE' : ''),
    spaceDisplayName: detail.spaceDisplayName || '',
    sender: detail.sender || ''
  }, annotated);
  const cachedAfter = packetRepo.findReadyBySpace(detail.spaceName, {
    isDm: !!(detail.isDm || detail.spaceType === 'DIRECT_MESSAGE')
  });
  const threadForUi = cachedAfter?.thread || annotated;
  if (!isChatApiQuotaBlocked() && threadNeedsMediaHydration(threadForUi)) {
    await ensureThreadMediaHydrated(threadForUi);
    if (cachedAfter) {
      cachedAfter.mediaHydrated = !threadNeedsMediaHydration(threadForUi);
      packetRepo.indexPacket(cachedAfter);
    }
  }
  const threadOut = enrichChatThreadForDisplay(annotateGchatThreadMine(threadForUi));
  setTimeout(() => { try { saveGchatDisk(); } catch (_) {} }, 0);
  if (notifyUi) {
    notifyOpenGchatThread({
      spaceName: detail.spaceName,
      threadName: detail.threadName || '',
      isDm: !!detail.isDm
    }, { silentRefresh: true });
  }
  return {
    success: true,
    thread: threadOut,
    myUserName: gchatCache.myUserName || '',
    myIds: gchatCache.myIds || [],
    myLabels: gchatCache.myLabels || [],
    ...chatApiQuotaStatus()
  };
}

function ensureGchatSyncStack() {
  if (gchatSyncStack) return gchatSyncStack;
  const chatApiService = ensureGchatChatApiService();
  const readSync = createReadSync({
    queueMarkRead: queueGchatMarkRead,
    getPendingEntries: () => [...gchatPending.markRead.entries()],
    getPendingCount: () => gchatPending.markRead.size,
    updatePendingMeta: (name, patch) => {
      const prev = gchatPending.markRead.get(name) || {};
      gchatPending.markRead.set(name, { ...prev, ...patch });
    },
    deletePending: (name) => { gchatPending.markRead.delete(name); },
    clearPendingForSpace: clearGchatPendingForSpace,
    clearPendingForMessage: clearGchatPendingForMessage,
    markLocallyRead: (name) => { if (name) gchatLocallyRead.add(name); },
    chatApiService,
    assertChatReadStateScope: assertChatReadStateScopeForGchat,
    resolveSpaceReadTime: (spaceName, rawTime) => resolveMarkReadLastTime(
      rawTime || newestCreateTimeInSpace(spaceName) || ''
    ),
    onSpaceReadApplied: applyGchatSpaceReadLocal,
    markMessageReadRemote: markChatMessageReadRemote,
    newestCreateTimeInSpace,
    saveDisk: saveGchatDisk,
    logIssue: logGchatApiIssue
  });
  const cacheRepository = createCacheRepository({
    prepareInboxSync: prepareGchatInboxSync,
    fetchUnreadInboxItems,
    finalizeInboxSync: finalizeGchatInboxSync,
    getRepoContext: getGchatRepoContext,
    gchatSnapshot,
    getInboxCount: () => (gchatCache.messages || []).filter(isInboxGchatMessage).length,
    onCacheChanged: (snapshot, meta) => emitGchatCacheChanged(snapshot, meta)
  });
  const packetRepository = ensureGchatPacketRepository();
  const syncService = createSyncService({
    // [Important] ADR 0006：SyncService 與 Scheduler 同樣閘 Active Feature
    isReady: () => !!(oauth2Client && chatService && isFeatureActive('gchat')),
    readSync,
    cacheRepository,
    setSyncing: (v) => { gchatCache.syncing = !!v; },
    syncThread: syncGchatThreadFromServer
  });
  gchatPollCoordinator = createPollCoordinator({
    runInbox: () => syncService.syncUnreadInbox(),
    runBarRegistry: () => syncRegistryReplyPopBadges(),
    runThreadSync: (detail, opts) => syncGchatThreadFromServer(detail, opts),
    afterTick: () => notifyNewGchatAlerts()
  });
  const pollCoordinator = gchatPollCoordinator;
  const scheduler = createSyncScheduler({
    syncService,
    pollCoordinator,
    isReady: () => !!(oauth2Client && chatService && isFeatureActive('gchat')),
    intervalMs: GCHAT_ALERT_POLL_MS
  });
  gchatSyncStack = { scheduler, syncService, cacheRepository, readSync, chatApiService, packetRepository, pollCoordinator };
  return gchatSyncStack;
}

/** Sync 層：將 API 原始 message 转为 inbox/thread 模型 */
async function normalizeChatMessages(rawList) {
  return ensureGchatMessageTransformService().normalizeChatMessages(rawList);
}

async function listSpaceMessages(spaceName, { pageSize = 50 } = {}) {
  const api = ensureGchatChatApiService();
  const raw = await api.listSpaceMessagesRaw(spaceName, { pageSize, orderBy: 'createTime desc' });
  const ordered = [...raw].reverse();
  return normalizeChatMessages(ordered);
}

async function listThreadMessages(spaceName, threadName) {
  const api = ensureGchatChatApiService();
  const raw = await api.listThreadMessagesRaw(spaceName, threadName, {
    pageSize: 50,
    orderBy: 'createTime asc'
  });
  return normalizeChatMessages(raw);
}

/** Sync 層：以 messageName 向 Server 取單則訊息並 normalize 成 detail 模型 */
async function fetchGchatMessageDetail(messageName) {
  const raw = await ensureGchatChatApiService().getMessageRaw(messageName);
  if (!raw) return null;
  const parsed = parseChatResource(messageName);
  const spaceLabel = await ensureSpaceDisplayName(parsed.spaceName);
  const detail = await normalizeChatMessage(raw, spaceLabel);
  const meta = await ensureSpaceMeta(parsed.spaceName);
  detail.spaceType = meta.spaceType;
  detail.isDm = meta.spaceType === 'DIRECT_MESSAGE';
  detail.mentionedMe = messageMentionsMe(raw, await ensureMyChatUserName());
  return detail;
}

/**
 * 空間近期訊息若只含討論串回覆、缺根訊息，階梯會誤掛到上一則。
 * 對「看起來缺根」或「正在開啟的串」補抓 thread 完整內容。
 */
async function enrichSpaceThreadMessages(spaceName, thread, hintDetail = null) {
  if (!spaceName || !Array.isArray(thread) || !thread.length) return thread || [];
  if (isChatApiQuotaBlocked()) return thread || [];
  const list = [...thread];
  const names = new Set(list.map(m => m?.name).filter(Boolean));
  const byThread = new Map();
  for (const m of list) {
    const th = String(m.threadName || '').trim();
    if (!th) continue;
    if (!byThread.has(th)) byThread.set(th, []);
    byThread.get(th).push(m);
  }
  const hintTh = String(hintDetail?.threadName || '').trim().replace(/^focus:/, '');
  const hintName = String(hintDetail?.name || '').trim();
  const fetchKeys = [];
  for (const [th, subset] of byThread.entries()) {
    const sorted = [...subset].sort((a, b) =>
      String(a.createTime || '').localeCompare(String(b.createTime || ''))
    );
    const first = sorted[0];
    const priority = th === hintTh || subset.some(m => m.name === hintName);
    const rootInNames = names.has(th) || sorted.some(m => m.name === th);
    const needsFetch = priority && (!rootInNames || first?.quoted?.name);
    if (needsFetch) fetchKeys.push(th);
  }
  for (const th of fetchKeys.slice(0, 6)) {
    try {
      const full = await listThreadMessages(spaceName, th);
      for (const m of full) {
        if (m?.name && !names.has(m.name)) {
          names.add(m.name);
          list.push(m);
        }
      }
    } catch (_) {}
  }
  list.sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
  return list;
}

/** 開啟對話時載入歷史：私人／群組（含 SPACE 房間）都抓空間近期，體感一致 */
async function loadConversationHistory(detail) {
  if (!detail?.spaceName) return detail ? [detail] : [];

  const loadCachedThread = () => {
    const cached = findReadyGchatPacketBySpace(detail.spaceName, {
      isDm: !!(detail.isDm || detail.spaceType === 'DIRECT_MESSAGE')
    });
    if (cached?.thread?.length) return groupGchatMessagesByThread([...cached.thread]);
    return null;
  };

  if (isChatApiQuotaBlocked()) {
    const cached = loadCachedThread();
    if (cached?.length) return cached;
  }

  const isDm = detail.isDm || detail.spaceType === 'DIRECT_MESSAGE';
  const focusThread = !!detail.focusThread;
  let threadKey = String(detail.threadName || '').trim().replace(/^focus:/, '');
  const isApiThread = /\/threads\//.test(threadKey);
  const anchorMsg = threadKey.startsWith('anchor:')
    ? threadKey.slice('anchor:'.length)
    : (threadKey.startsWith('msg:') ? threadKey.slice('msg:'.length) : '');

  // [Important] 專注討論串：只載該 thread／錨點，不跟整個空間混在一起
  if (focusThread && isApiThread) {
    try {
      let thread = await listThreadMessages(detail.spaceName, threadKey);
      if (!thread.length && detail.name) thread = [{ ...detail }];
      thread.sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
      // 專注回覆串：根訊息＋回覆（星星只亮根訊息）
      for (const m of thread) {
        if (!m.media?.length) continue;
        const needs = m.media.some(x => !x.dataUrl && (x.resourceName || x.uri || x.previewUrl));
        if (!needs) continue;
        try { m.media = await hydrateChatMedia(m.media); } catch (_) {}
      }
      return thread;
    } catch (err) {
      if (isChatQuotaError(err)) markChatApiQuotaBlocked(err, '專注討論串載入');
      else console.warn('專注討論串載入失敗:', err.message);
      const cached = loadCachedThread();
      if (cached?.length) return cached;
    }
  }

  // GROUP_CHAT、SPACE、以及 @我 的群組房間：與私訊一樣先抓空間近期
  const isGroupRoom = detail.spaceType === 'GROUP_CHAT'
    || detail.spaceType === 'SPACE'
    || (!!detail.mentionedMe && !isDm);
  let thread = [];
  try {
    if (isDm || isGroupRoom) {
      thread = await listSpaceMessages(detail.spaceName, { pageSize: isDm ? 50 : 60 });
      thread = await enrichSpaceThreadMessages(detail.spaceName, thread, detail);
      // 群組若有討論串且空間歷史偏少，再合併串內訊息
      if (!isDm && detail.threadName && thread.length < 12 && isApiThread) {
        try {
          const th = await listThreadMessages(detail.spaceName, threadKey || detail.threadName);
          const byName = new Map(thread.map(m => [m.name, m]));
          for (const m of th) {
            if (m?.name) byName.set(m.name, m);
          }
          thread = [...byName.values()];
        } catch (_) {}
      }
    } else if (isApiThread) {
      thread = await listThreadMessages(detail.spaceName, threadKey || detail.threadName);
      if (thread.length <= 1) {
        const spaceHist = await listSpaceMessages(detail.spaceName, { pageSize: 40 });
        if (spaceHist.length > thread.length) thread = spaceHist;
      }
    } else {
      thread = await listSpaceMessages(detail.spaceName, { pageSize: 40 });
      thread = await enrichSpaceThreadMessages(detail.spaceName, thread, detail);
    }
  } catch (err) {
    if (isChatQuotaError(err)) markChatApiQuotaBlocked(err, '載入 Chat 歷史');
    else console.warn('載入 Chat 歷史失敗:', err.message);
    const cached = loadCachedThread();
    if (cached?.length) return cached;
  }

  if (!thread.length && detail) thread = [{ ...detail }];
  if (detail?.name && !thread.some(m => m.name === detail.name)) {
    thread.push({ ...detail });
  }

  // 錨點專注：以該則訊息為根，收齊引用鏈（含根訊息，星星只亮根）
  if (focusThread && anchorMsg) {
    const include = new Set([anchorMsg]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of thread) {
        if (!m?.name || include.has(m.name)) continue;
        if (m.quoted?.name && include.has(m.quoted.name)) {
          include.add(m.name);
          changed = true;
        }
        if (m.threadName && include.has(m.threadName)) {
          include.add(m.name);
          changed = true;
        }
      }
    }
    const filtered = thread.filter(m => include.has(m.name));
    thread = filtered.length ? filtered : thread.filter(m => m.name === anchorMsg);
    if (!thread.length && detail) thread = [{ ...detail }];
  }

  // 媒體：有附件才下載，配額用盡或過多附件時只處理近期少量
  let mediaHydrated = 0;
  const mediaLimit = isChatApiQuotaBlocked() ? 0 : CHAT_MEDIA_HYDRATE_LIMIT;
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (mediaHydrated >= mediaLimit) break;
    if (!m.media?.length) continue;
    const needs = m.media.some(x => !x.dataUrl && (x.resourceName || x.uri || x.previewUrl));
    if (!needs) continue;
    try {
      m.media = await hydrateChatMedia(m.media);
      mediaHydrated++;
    } catch (_) {}
  }
  return groupGchatMessagesByThread(thread);
}

function isPinnedGchatSpace(spaceName) {
  const key = String(spaceName || '').trim();
  if (!key) return false;
  const prefs = loadGchatPrefs();
  for (const s of prefs.pinnedSpaces || []) {
    if (String(s?.spaceName || '').trim() === key) return true;
  }
  for (const c of prefs.pinnedContacts || []) {
    if (String(c?.spaceName || '').trim() === key) return true;
  }
  return false;
}

// [Important] gchatCache.packets 寫入請一律經 PacketRepository（Phase 2B）
function gchatSpacePacketKey(spaceName) {
  const s = String(spaceName || '').trim();
  return s ? `space:${s}` : '';
}

/**
 * PacketRepository 薄包裝（runtime 內呼叫點沿用舊名稱）
 */
function indexGchatPacket(packet) {
  return ensureGchatPacketRepository().indexPacket(packet);
}

/** 即時把對話串寫回暫存（回覆／Little Reply 刷新用，不等 10 秒打包） */
function upsertGchatLivePacket(meta, threadIn) {
  return ensureGchatPacketRepository().upsertLivePacket(meta, threadIn);
}

/** 把單則新訊息併入既有暫存（送出回覆後立刻更新） */
function appendMessageToGchatPacket(msg, extras = {}) {
  return ensureGchatPacketRepository().appendMessage(msg, extras);
}

async function packGchatDetailForItem(item, opts = {}) {
  return ensureGchatDetailPackService().packDetailForItem(item, opts);
}

function findReadyGchatPacket(messageName, hint = null) {
  return ensureGchatPacketRepository().findReady(messageName, hint);
}

function findReadyGchatPacketBySpace(spaceName, { isDm = false } = {}) {
  return ensureGchatPacketRepository().findReadyBySpace(spaceName, { isDm });
}

/** 打包單一空間歷史（置頂／開啟對話共用） */
async function packGchatSpaceHistory(spaceName, extras = {}) {
  return ensureGchatDetailPackService().packSpaceHistory(spaceName, extras);
}

/** 置頂私人／群組預打包，點芯片才能走暫存 */
async function packPinnedGchatConversations() {
  if (!isFeatureActive('gchat') || !chatService || !oauth2Client) return;
  const prefs = loadGchatPrefs();
  const jobs = [];

  for (const s of prefs.pinnedSpaces || []) {
    if (!s?.spaceName) continue;
    jobs.push({
      spaceName: s.spaceName,
      label: s.label || '',
      isDm: !!s.isDm,
      spaceType: s.spaceType || (s.isDm ? 'DIRECT_MESSAGE' : '')
    });
  }
  for (const c of prefs.pinnedContacts || []) {
    if (!c) continue;
    if (c.spaceName) {
      jobs.push({
        spaceName: c.spaceName,
        label: c.label || '',
        isDm: true,
        spaceType: 'DIRECT_MESSAGE',
        userName: c.userName || ''
      });
      continue;
    }
    if (!c.userName) continue;
    try {
      const sp = await findOrOpenDmSpace(c.userName);
      if (!sp?.name) continue;
      c.spaceName = sp.name;
      jobs.push({
        spaceName: sp.name,
        label: c.label || '',
        isDm: true,
        spaceType: 'DIRECT_MESSAGE',
        userName: c.userName
      });
    } catch (_) {}
  }

  // 回寫聯絡人 spaceName，之後開啟更快
  try {
    saveGchatPrefs({
      ...prefs,
      pinnedContacts: prefs.pinnedContacts || []
    });
  } catch (_) {}

  for (const job of jobs.slice(0, 40)) {
    const prev = findReadyGchatPacketBySpace(job.spaceName, { isDm: job.isDm });
    if (prev?.historyReady && Date.now() - Number(prev.packedAt || 0) < 8 * 60 * 1000) {
      ensurePinnedSpaceUnreadBaseline(job.spaceName, !!job.isDm);
      continue;
    }
    try {
      await packGchatSpaceHistory(job.spaceName, job);
      ensurePinnedSpaceUnreadBaseline(job.spaceName, !!job.isDm);
    } catch (err) {
      console.warn('置頂對話預打包失敗:', job.spaceName, err.message);
    }
  }
  try {
    await hydratePinnedIcons();
  } catch (_) {}
  try { saveGchatDisk(); } catch (_) {}
}

async function packGchatPackets(messages) {
  pruneGchatTodayTouched();
  // [Important] 配額節省：只預打包未讀 inbox；今日已讀不撈歷史（開啟時走本機暫存）
  const inbox = (messages || []).filter(isInboxGchatMessage);
  const list = [...inbox];
  const keep = new Set(list.map(m => m.name).filter(Boolean));
  const todayKeys = new Set((gchatCache.todayTouched || []).map(t => t.trackKey).filter(Boolean));
  const pinSpaceKeys = new Set();
  const prefs = loadGchatPrefs();
  for (const s of prefs.pinnedSpaces || []) {
    if (s?.spaceName) {
      pinSpaceKeys.add(gchatSpacePacketKey(s.spaceName));
      pinSpaceKeys.add(gchatTrackKey({ spaceName: s.spaceName, isDm: !!s.isDm, spaceType: s.spaceType || '' }));
    }
  }
  for (const c of prefs.pinnedContacts || []) {
    if (c?.spaceName) {
      pinSpaceKeys.add(gchatSpacePacketKey(c.spaceName));
      pinSpaceKeys.add(gchatTrackKey({ spaceName: c.spaceName, isDm: true, spaceType: 'DIRECT_MESSAGE' }));
    }
  }
  ensureGchatPacketRepository().pruneStale({
    keepMessageNames: keep,
    todayTrackKeys: todayKeys,
    pinSpaceKeys
  });
  gchatCache.packing = true;
  try {
    const queue = list.filter(item => {
      if (!item?.name) return false;
      const prev = findReadyGchatPacket(item.name, item);
      if (!prev?.historyReady) return true;
      if (item.createTime && prev.detail?.createTime && prev.detail.createTime !== item.createTime) {
        return !!inbox.find(m => m.name === item.name);
      }
      return false;
    });
    queue.sort((a, b) => {
      const score = (m) => (m.mentionedMe ? 4 : 0) + (m.isDm ? 2 : 0)
        + (m.spaceType === 'SPACE' || m.spaceType === 'GROUP_CHAT' ? 1 : 0)
        + (inbox.some(x => x.name === m.name) ? 2 : 0);
      return score(b) - score(a);
    });
    const workers = Array.from({ length: Math.min(4, Math.max(1, queue.length)) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) break;
        try {
          await packGchatDetailForItem(item, { withHistory: true });
        } catch (err) {
          console.warn('Chat 詳情打包失敗:', err.message);
          indexGchatPacket({
            detail: item,
            thread: [item],
            packedAt: Date.now(),
            historyReady: false
          });
        }
      }
    });
    await Promise.all(workers);
    // 置頂私人／群組一併預熱
    await packPinnedGchatConversations();
  } finally {
    gchatCache.packing = false;
  }
}


// ========== 【MODULE: modules/gchat】GChat 資料 IPC ==========

function applyGchatCompactTitle(fromWin, payload) {
  const messageName = payload?.messageName || replyPopMessageName;
  const entry = findReplyPopEntry({
    win: fromWin,
    messageName,
    spaceName: ''
  }) || findReplyPopEntry({ win: fromWin });
  if (entry && payload?.title) {
    entry.isDm = !!payload.isDm;
    if (payload?.spaceName) {
      migrateReplyPopConvKey(entry, {
        spaceName: payload.spaceName,
        messageName: payload?.messageName || entry.messageName || ''
      });
    }
    const rawTitle = String(payload.title || '').trim();
    if (entry.threadFocus) {
      if (payload.focusRootText) entry.focusRootText = String(payload.focusRootText).trim();
      if (payload.contactTitle) entry.contactTitle = String(payload.contactTitle).trim();
      if (rawTitle.includes('★') || rawTitle.includes('·')) {
        const parsed = parseFocusThreadBarTitle(rawTitle);
        if (parsed.contactTitle) entry.contactTitle = parsed.contactTitle;
        if (parsed.focusRootText) entry.focusRootText = parsed.focusRootText;
      } else if (!entry.contactTitle) {
        entry.contactTitle = rawTitle;
      }
      refreshFocusEntryTitle(entry);
      syncReplyBarUi(entry);
      return { success: true };
    }
    const parsedBody = parseFocusThreadBarTitle(rawTitle);
    const body = parsedBody.contactTitle || rawTitle.replace(/^★\s*/, '');
    const next = pickGchatBubbleTitle({
      isDm: entry.isDm,
      spaceDisplayName: body,
      sender: payload?.sender || '',
      spaceName: entry.spaceName || payload?.spaceName || '',
      fallback: entry.title
    });
    if (!isWeakGchatBubbleTitle(next) || isWeakGchatBubbleTitle(entry.title)) {
      entry.title = next;
    }
    if (entry.spaceName && isWeakGchatBubbleTitle(entry.title)) {
      ensureSpaceMeta(entry.spaceName).then((meta) => {
        if (!meta?.label || isWeakGchatBubbleTitle(meta.label)) return;
        const resolved = pickGchatBubbleTitle({
          isDm: entry.isDm,
          spaceDisplayName: meta.label,
          spaceName: entry.spaceName
        });
        if (isWeakGchatBubbleTitle(resolved)) return;
        entry.title = resolved;
        syncReplyBarUi(entry);
      }).catch(() => {});
    }
    syncReplyBarUi(entry);
  }
  return { success: true };
}

/** Phase 3A：GChat IPC deps 工廠（逐步擴充） */
function createGchatIpcDeps() {
  return {
    prefs: {
      load: loadGchatPrefs,
      save: saveGchatPrefs
    },
    onPrefsSaved(prefs, next) {
      if (next.alertPopup === false) {
        if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
      } else if (prefs?.alertPopup !== undefined) {
        mainGchatAlertSeeded = false;
        mainGchatAlerted.clear();
        mainGchatAlertedAt.clear();
        pinnedGroupAlertCursors.clear();
      }
      // ADR 0006：僅 Active 時 start；Toast 偏好變更不強制開背景
      if (isFeatureActive('gchat')) startGchatSyncScheduler();
    },
    inbox: {
      isChatReady: () => !!(oauth2Client && chatService),
      requireSession: () => requireGoogleSession(),
      getScope: () => grantedScopeText(),
      hasChatScopes,
      loadDisk: loadGchatDisk,
      snapshot: gchatSnapshot,
      probeUnread: () => ensureGchatChatApiService().probeUnreadSearch(),
      explainError: explainChatError,
      setupUrl: chatApiEnableUrl,
      syncInbox: async () => {
        if (!isFeatureActive('gchat')) {
          return { skipped: true, inactive: true };
        }
        await ensureGchatSyncStack().syncService.syncUnreadInbox();
        await notifyNewGchatAlerts();
      },
      onSyncError: () => { gchatCache.syncing = false; }
    },
    detail: {
      isChatReady: () => !!(oauth2Client && chatService),
      explainError: explainChatError,
      getDetailCache: ensureGchatDetailCache,
      buildDetailResponse: buildGchatDetailResponse,
      buildThreadRefreshFromCache,
      isMessageUnread: (messageName) => gchatCache.messages.some((m) => m.name === messageName),
      isPinnedSpace: isPinnedGchatSpace,
      hasIdentity: () => !!(gchatCache.myUserName || (gchatCache.myIds && gchatCache.myIds.length)),
      ensureMyUserName: (spaceName) => ensureMyChatUserName(spaceName),
      resolveMyUserFromSpace: resolveMyChatUserFromSpace,
      fetchMessageDetail: fetchGchatMessageDetail,
      packDetailForItem: packGchatDetailForItem,
      rememberTodayTouch: rememberGchatTodayTouch,
      saveDisk: saveGchatDisk,
      formatDetail: (d) => enrichChatMessageForDisplay({ ...d, isMine: isOwnGchatMessage(d) }),
      formatThread: (thread) => enrichChatThreadForDisplay(annotateGchatThreadMine(thread)),
      getIdentitySnapshot: () => ({
        myUserName: gchatCache.myUserName || '',
        myIds: gchatCache.myIds || [],
        myLabels: gchatCache.myLabels || []
      }),
      quotaStatus: chatApiQuotaStatus,
      findReadyPacketBySpace: findReadyGchatPacketBySpace,
      threadPollKey,
      requestThreadSync: (pollKey, payload) => ensureGchatPollCoordinator().request(
        pollKey,
        () => ensureGchatSyncStack().syncService.syncThread(payload)
      ),
      markQuotaBlocked: markChatApiQuotaBlocked,
      isQuotaError: isChatQuotaError
    },
    messaging: {
      isChatReady: () => !!(oauth2Client && chatService),
      explainError: explainChatError,
      findQuoteLastUpdateTime: (quoteMessageName) => {
        for (const p of Object.values(gchatCache.packets || {})) {
          const hit = (p?.thread || []).find((m) => m?.name === quoteMessageName)
            || (p?.detail?.name === quoteMessageName ? p.detail : null);
          if (hit) {
            const t = String(hit.lastUpdateTime || hit.createTime || '');
            if (t) return t;
          }
        }
        return '';
      },
      bufferAttachment: bufferChatAttachmentForUpload,
      uploadAttachment: (spaceName, prepared) => ensureGchatChatApiService().uploadAttachmentRaw(spaceName, prepared),
      createMessage: (params) => ensureGchatChatApiService().createMessageRaw(params),
      onReplySent: (spaceName, payload, createdName) => {
        if (spaceName) {
          mainGchatAlerted.add(gchatTrackKey({
            spaceName,
            isDm: !!payload.isDm,
            spaceType: payload.spaceType || ''
          }) || spaceName);
          recentReplySpaces.set(spaceName, Date.now() + 20000);
        }
        if (createdName) mainGchatAlerted.add(createdName);
      },
      markReadAfterReply: (messageName, payload, text) => {
        const readSync = ensureGchatSyncStack().readSync;
        readSync.markReadLocal(messageName, {
          createTime: payload.createTime || '',
          threadName: payload.threadName || '',
          spaceName: payload.spaceName || '',
          sender: payload.sender || '',
          spaceDisplayName: payload.spaceDisplayName || '',
          snippet: text || payload.snippet || '',
          isDm: !!payload.isDm,
          spaceType: payload.spaceType || ''
        });
        saveGchatDisk();
        readSync.tryFlushMessage(messageName, {
          createTime: payload.createTime || '',
          threadName: payload.threadName || '',
          spaceName: payload.spaceName || ''
        }).catch((err) => {
          console.error('回覆後標已讀失敗:', err.message);
        });
      },
      normalizeMessage: normalizeChatMessage,
      rememberIdentityFromMessage: (createdData, createdMsg) => {
        if (createdData?.sender?.name) {
          rememberMyGchatIdentity(createdData.sender.name);
        } else if (createdMsg?.senderName) {
          rememberMyGchatIdentity(createdMsg.senderName);
        }
        if (createdMsg?.sender) rememberMyGchatLabel(createdMsg.sender);
      },
      rememberTodayTouch: rememberGchatTodayTouch,
      appendToPacket: appendMessageToGchatPacket,
      saveDisk: saveGchatDisk,
      snapshot: gchatSnapshot,
      broadcastListUpdate: broadcastGchatListUpdate,
      notifyOpenThread: notifyOpenGchatThread,
      reactionKeyForRow,
      parseChatResource,
      ensureMyUserName: ensureMyChatUserName,
      resolveCustomEmoji: resolveCustomEmojiForReaction,
      resolveCustomEmojiByUid,
      enrichReactionRow,
      getStoredReactionName: getStoredMyReactionName,
      setStoredReactionName: setStoredMyReactionName,
      findMyReactionName,
      deleteReaction: (reactionName) => ensureGchatChatApiService().deleteReactionRaw(reactionName),
      createReaction: (messageName, requestBody) => ensureGchatChatApiService().createReactionRaw(messageName, requestBody),
      patchReactionsInCache: patchMessageReactionsInCache,
      googleErrText,
      markConversationRead: markGchatConversationReadByName
    },
    search: {
      isOAuthReady: () => !!oauth2Client,
      isChatReady: () => !!(oauth2Client && chatService),
      explainError: explainChatError,
      googleErrText,
      loadEmojiRegistry: loadCustomEmojiRegistry,
      customEmojiSnapshot: customEmojiCacheSnapshot,
      isEmojiQuotaBlocked: () => !!(customEmojiQuotaBlockedUntil && Date.now() < customEmojiQuotaBlockedUntil),
      refreshEmojiCache: refreshCustomEmojiCache,
      logApiIssue: logGchatApiIssue,
      hydrateEmojiImages: hydrateCustomEmojiImages,
      emojiHydrateBatch: () => CUSTOM_EMOJI_HYDRATE_BATCH,
      listEmojisForUi: listCustomEmojisForUi,
      openQuickSearchWindow: openGchatQuickSearchWindow,
      hideQuickSearchWindow: hideGchatQuickSearchWindow,
      searchContacts: searchGchatContacts,
      searchSpaces: searchGchatSpaces,
      listSpaceMembersForMention: listGchatSpaceMembersForMention,
      getDirectoryError: () => gchatCache.directoryError || '',
      findPinnedContactSpaceName: (userName) => {
        try {
          const pin = (loadGchatPrefs().pinnedContacts || []).find((c) => c.userName === userName);
          return pin?.spaceName || '';
        } catch (_) {
          return '';
        }
      },
      updatePinnedContactSpaceName: (userName, spaceName) => {
        try {
          const prefs = loadGchatPrefs();
          const list = [...(prefs.pinnedContacts || [])];
          const idx = list.findIndex((x) => x.userName === userName);
          if (idx >= 0 && !list[idx].spaceName) {
            list[idx] = { ...list[idx], spaceName };
            saveGchatPrefs({ ...prefs, pinnedContacts: list });
          }
        } catch (_) {}
      },
      findOrOpenDm: findOrOpenDmSpace,
      buildOpenSpaceResult,
      loadPrefs: loadGchatPrefs,
      savePrefs: saveGchatPrefs,
      snapshot: gchatSnapshot,
      broadcastListUpdate: broadcastGchatListUpdate,
      packPinnedConversations: packPinnedGchatConversations,
      hydratePinnedIcons,
      saveDisk: saveGchatDisk
    },
    ui: {
      showToast: showFloatingGchatToast,
      hideToast: () => { if (toastWin && !toastWin.isDestroyed()) toastWin.hide(); },
      resizeToast: (height) => positionToastWindow(Number(height) || 160),
      markConversationRead: markGchatConversationReadByName,
      markSpaceRead: markGchatSpaceReadBySpaceName,
      snapshotReadUntilBeforeOpen,
      snapshotReadUntilForMessage,
      openCompactReply: openCompactGchatReply,
      openFromAlertAnchor,
      getWindowFromEvent: (event) => BrowserWindow.fromWebContents(event.sender),
      getMainWindow: () => win,
      findReplyEntry: findReplyPopEntry,
      getReplyPopEntry,
      getActiveReplyPopMessageName: () => replyPopMessageName,
      setActiveReplyPop: (messageName, replyWin) => {
        replyPopMessageName = messageName;
        replyPopWin = replyWin;
      },
      closeReplyCompletely: closeReplyPopCompletely,
      toggleReplyFromBar: toggleReplyPopFromBar,
      minimizeReply: minimizeReplyPop,
      restoreReply: restoreReplyPop,
      toggleReplyFullscreen: toggleReplyPopFullscreen,
      positionMinimizedBars: positionMinimizedReplyBars,
      entryConvKey,
      syncOverlayZOrder: syncGchatOverlayZOrder,
      clearViewingIfClosed: (closedName, entry) => {
        if (!closedName || gchatViewing?.messageName === closedName
          || (entry?.spaceName && gchatViewing?.spaceName === entry.spaceName)) {
          gchatViewing = null;
          stopViewingRefreshWatch();
        }
      },
      applyCompactTitle: applyGchatCompactTitle,
      getAppTheme: () => currentAppTheme,
      setViewing: (ctx) => {
        if (!ctx || !ctx.spaceName) {
          gchatViewing = null;
          stopViewingRefreshWatch();
        } else {
          gchatViewing = {
            spaceName: String(ctx.spaceName || ''),
            threadName: String(ctx.threadName || ''),
            messageName: String(ctx.messageName || ''),
            isDm: !!ctx.isDm,
            spaceType: ctx.spaceType || '',
            spaceDisplayName: ctx.spaceDisplayName || '',
            sender: ctx.sender || '',
            focusThread: !!ctx.focusThread,
            rootMessageName: ctx.rootMessageName || ''
          };
          startViewingRefreshWatch();
          const detail = buildViewingSyncDetail(gchatViewing);
          const key = gchatViewingInterestKey;
          if (key && detail) {
            ensureGchatPollCoordinator().request(
              key,
              () => syncGchatThreadFromServer(detail, { notifyUi: true })
            ).catch(() => {});
          }
        }
        syncGchatOverlayZOrder();
        return { success: true, viewing: gchatViewing };
      },
      alertWatch: (enabled) => {
        if (!isFeatureActive('gchat')) {
          try {
            if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
          } catch (_) {}
          stopGchatSyncScheduler();
          return { success: true, enabled: false, inactive: true };
        }
        if (enabled) {
          mainGchatAlertSeeded = false;
          mainGchatAlerted.clear();
          mainGchatAlertedAt.clear();
          pinnedGroupAlertCursors.clear();
        } else if (toastWin && !toastWin.isDestroyed()) {
          toastWin.hide();
        }
        startGchatSyncScheduler();
        return { success: true, enabled: !!enabled };
      },
      openExternal: (url) => shell.openExternal(url),
      setupUrl: chatApiEnableUrl,
      appConfigUrl: chatAppConfigUrl,
      adminSetupUrl: adminApiEnableUrl
    }
  };
}

registerGchatIpc(ipcMain, createGchatIpcDeps());

function packetNeedsEmojiRepair(thread) {
  return (thread || []).some((m) => /[\uFFFC\uFFFD]/.test(String(m?.text || ''))
    && !(Array.isArray(m?.emojiAnnotations) && m.emojiAnnotations.length));
}

async function buildGchatDetailResponse(cached, listHit, opts = {}) {
  return ensureGchatDetailPackService().buildDetailResponse(cached, listHit, opts);
}

/** 本人已加的表情 reaction 資源名稱 */
function ensureMyReactionsStore() {
  if (!gchatCache.myReactions || typeof gchatCache.myReactions !== 'object') {
    gchatCache.myReactions = {};
  }
  return gchatCache.myReactions;
}

function getStoredMyReactionName(messageName, reactionKey) {
  return ensureMyReactionsStore()[messageName]?.[reactionKey] || '';
}

function setStoredMyReactionName(messageName, reactionKey, reactionName) {
  const store = ensureMyReactionsStore();
  if (!store[messageName]) store[messageName] = {};
  if (reactionName) store[messageName][reactionKey] = reactionName;
  else delete store[messageName][reactionKey];
  if (!Object.keys(store[messageName]).length) delete store[messageName];
}

async function findMyReactionName(messageName, reactionKey) {
  if (!chatService || !messageName || !reactionKey) return '';
  const parsed = parseChatResource(messageName);
  const myUser = await ensureMyChatUserName(parsed.spaceName);
  if (!myUser) return '';
  let filter = '';
  if (String(reactionKey).startsWith('custom:')) {
    const uid = String(reactionKey).slice(7).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (!uid) return '';
    filter = `emoji.custom_emoji.uid = "${uid}" AND user.name = "${myUser}"`;
  } else {
    const esc = String(reactionKey).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    filter = `emoji.unicode = "${esc}" AND user.name = "${myUser}"`;
  }
  try {
    const reactions = await ensureGchatChatApiService().listReactionsRaw(messageName, {
      filter,
      pageSize: 1
    });
    return reactions[0]?.name || '';
  } catch (_) {
    return '';
  }
}

function patchMessageReactionsInCache(messageName, reactionKey, action, patchMeta = {}) {
  const patch = (m) => {
    if (!m || m.name !== messageName) return m;
    let reactions = Array.isArray(m.reactions) ? m.reactions.map((r) => enrichReactionRow({ ...r })) : [];
    const idx = reactions.findIndex((r) => {
      if (r.reactionKey && r.reactionKey === reactionKey) return true;
      if (reactionKey.startsWith('custom:') && r.customUid === reactionKey.slice(7)) return true;
      return r.unicode && r.unicode === reactionKey;
    });
    if (action === 'removed') {
      if (idx >= 0) {
        const count = Math.max(0, (reactions[idx].count || 0) - 1);
        if (count <= 0) reactions.splice(idx, 1);
        else reactions[idx] = { ...reactions[idx], count, reactedByMe: false };
      }
      return { ...m, reactions };
    }
    if (idx >= 0) {
      reactions[idx] = {
        ...reactions[idx],
        count: (reactions[idx].count || 0) + 1,
        reactedByMe: true
      };
    } else {
      reactions.push(enrichReactionRow({
        unicode: patchMeta.unicode || (reactionKey.startsWith('custom:') ? '' : reactionKey),
        customUid: patchMeta.customUid || (reactionKey.startsWith('custom:') ? reactionKey.slice(7) : ''),
        label: patchMeta.label || reactionKey,
        imageUrl: patchMeta.imageUrl || '',
        reactionKey,
        count: 1,
        reactedByMe: true
      }));
    }
    return { ...m, reactions };
  };
  gchatCache.messages = (gchatCache.messages || []).map(patch);
  ensureGchatPacketRepository().patchMessageInPackets(messageName, patch);
}

async function searchGchatContacts(query, limit = 12) {
  return ensureGchatSearchService().searchContacts(query, limit);
}

async function listKnownGchatSpaces({ force = false } = {}) {
  return ensureGchatSearchService().listKnownSpaces({ force });
}

async function searchGchatSpaces(query, limit = 12) {
  return ensureGchatSearchService().searchSpaces(query, limit);
}

/** 群組 @ 用：列出空間成員（不含自己／BOT） */
async function listGchatSpaceMembersForMention(spaceName) {
  const parent = String(spaceName || '').trim();
  if (!parent) return [];
  const api = ensureGchatChatApiService();
  const out = [];
  const seen = new Set();
  let pageToken = '';
  let pages = 0;
  do {
    let memberships = [];
    try {
      const res = await api.listSpaceMembersRaw(parent, { pageSize: 100 });
      // listSpaceMembersRaw 目前單頁；若之後支援 token 再接
      memberships = Array.isArray(res) ? res : [];
      pageToken = '';
    } catch (_) {
      break;
    }
    for (const row of memberships) {
      const member = row?.member || {};
      if (member.type === 'BOT') continue;
      const userName = String(member.name || '').trim();
      if (!userName || userName === 'users/me' || userName.endsWith('/me')) continue;
      if (gchatCache.myUserName && userName === gchatCache.myUserName) continue;
      if (Array.isArray(gchatCache.myIds) && gchatCache.myIds.includes(userName)) continue;
      if (seen.has(userName)) continue;
      seen.add(userName);
      let label = '';
      try {
        label = await resolveSenderName(member, parent);
      } catch (_) {}
      if (!label || label === '成員' || String(label).startsWith('使用者 ')) {
        label = member.displayName || gchatCache.userNames?.[userName] || userName;
      }
      const icon = gchatCache.userIcons?.[userName] || {};
      out.push({
        kind: 'contact',
        userName,
        label,
        email: '',
        hint: '群組成員',
        iconUrl: icon.iconUrl || '',
        emoji: icon.emoji || '',
        inSpace: true
      });
    }
    pages += 1;
  } while (pageToken && pages < 5);
  out.sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'zh-Hant'));
  return out;
}

async function findOrOpenDmSpace(userName) {
  return ensureGchatSearchService().findOrOpenDmSpace(userName);
}

async function buildOpenSpaceFromCachedPacket(cached, space, extras = {}) {
  return ensureGchatDetailPackService().buildOpenSpaceFromCachedPacket(cached, space, extras);
}

async function buildOpenSpaceResult(space, extras = {}) {
  return ensureGchatDetailPackService().buildOpenSpaceResult(space, extras);
}

ipcMain.handle('get-cursor-point', async () => {
  try {
    const pt = screen.getCursorScreenPoint();
    return { x: pt.x, y: pt.y };
  } catch (_) {
    return { x: 0, y: 0 };
  }
});

function geminiConfigPath() { return path.join(app.getPath('userData'), 'gemini.json'); }
function knowledgeDir() { return path.join(app.getPath('userData'), 'knowledge'); }
function knowledgeIndexPath() { return path.join(knowledgeDir(), 'index.json'); }

function defaultGeminiConfig() {
  return {
    apiKey: '',
    model: 'gemini-2.5-flash',
    projectId: '',
    location: 'us-central1',
    engineId: '',
    searchKind: 'engine',
    searchLocation: 'global',
    sqlConnectionString: '',
    sqlServer: '',
    sqlPort: 1433,
    sqlDatabase: 'erp',
    sqlTable: 'dbo.EMRequestForm',
    sqlUser: '',
    sqlPassword: '',
    sqlEncrypt: false,
    sqlTrustCert: true
  };
}

function loadGeminiConfig() {
  const defaults = defaultGeminiConfig();
  try {
    if (fs.existsSync(geminiConfigPath())) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(geminiConfigPath(), 'utf8')) };
    }
  } catch (_) {}
  return defaults;
}

function saveGeminiConfig(cfg) {
  const current = loadGeminiConfig();
  const next = {
    apiKey: cfg.apiKey === undefined ? (current.apiKey || '') : cfg.apiKey,
    model: cfg.model || current.model || 'gemini-2.5-flash',
    projectId: cfg.projectId === undefined ? (current.projectId || '') : String(cfg.projectId || '').trim(),
    location: cfg.location || current.location || 'us-central1',
    engineId: cfg.engineId === undefined ? (current.engineId || '') : String(cfg.engineId || '').trim(),
    searchKind: cfg.searchKind || current.searchKind || 'engine',
    searchLocation: cfg.searchLocation || current.searchLocation || 'global',
    sqlConnectionString: cfg.sqlConnectionString === undefined ? (current.sqlConnectionString || '') : String(cfg.sqlConnectionString || '').trim(),
    sqlServer: cfg.sqlServer === undefined ? (current.sqlServer || '') : String(cfg.sqlServer || '').trim(),
    sqlPort: cfg.sqlPort === undefined ? (current.sqlPort || 1433) : Number(cfg.sqlPort) || 1433,
    sqlDatabase: cfg.sqlDatabase === undefined ? (current.sqlDatabase || 'erp') : String(cfg.sqlDatabase || '').trim() || 'erp',
    sqlTable: cfg.sqlTable === undefined ? (current.sqlTable || 'dbo.EMRequestForm') : String(cfg.sqlTable || '').trim() || 'dbo.EMRequestForm',
    sqlUser: cfg.sqlUser === undefined ? (current.sqlUser || '') : String(cfg.sqlUser || '').trim(),
    sqlPassword: cfg.sqlPassword === undefined || cfg.sqlPassword === '' ? (current.sqlPassword || '') : cfg.sqlPassword,
    sqlEncrypt: cfg.sqlEncrypt === undefined ? !!current.sqlEncrypt : !!cfg.sqlEncrypt,
    sqlTrustCert: cfg.sqlTrustCert === undefined ? current.sqlTrustCert !== false : !!cfg.sqlTrustCert,
    // [Important] 報表匯出：測試／正式雙連線（開發者設定）
    sqlProfiles: cfg.sqlProfiles === undefined ? (current.sqlProfiles || undefined) : cfg.sqlProfiles,
    reportSqlActiveProfile: cfg.reportSqlActiveProfile === undefined
      ? (current.reportSqlActiveProfile || 'test')
      : (cfg.reportSqlActiveProfile === 'production' ? 'production' : 'test')
  };
  if (!next.sqlProfiles) delete next.sqlProfiles;
  fs.writeFileSync(geminiConfigPath(), JSON.stringify(next));
}

function loadKnowledgeIndex() {
  try {
    if (!fs.existsSync(knowledgeDir())) fs.mkdirSync(knowledgeDir(), { recursive: true });
    if (fs.existsSync(knowledgeIndexPath())) return JSON.parse(fs.readFileSync(knowledgeIndexPath(), 'utf8'));
  } catch (_) {}
  return [];
}

function saveKnowledgeIndex(list) {
  if (!fs.existsSync(knowledgeDir())) fs.mkdirSync(knowledgeDir(), { recursive: true });
  fs.writeFileSync(knowledgeIndexPath(), JSON.stringify(list, null, 2));
}

function loadKnowledgeDocs() {
  return loadKnowledgeIndex().map(doc => {
    const text = doc.text || (doc.file && fs.existsSync(doc.file) ? fs.readFileSync(doc.file, 'utf8') : '');
    return { id: doc.id, name: doc.name, text: String(text || '') };
  }).filter(d => d.text);
}

function queryTerms(query) {
  const q = String(query || '').toLowerCase();
  const terms = new Set();
  const words = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const w of words) {
    if (w.length > 1) terms.add(w);
    else if (/[\u4e00-\u9fff]/.test(w)) terms.add(w);
    if (/[\u4e00-\u9fff]/.test(w)) {
      for (let i = 0; i < w.length - 1; i++) terms.add(w.slice(i, i + 2));
      if (w.length >= 3) {
        for (let i = 0; i < w.length - 2; i++) terms.add(w.slice(i, i + 3));
      }
    }
  }
  return [...terms];
}

function splitChunks(text, size = 1800, overlap = 240) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const parts = [];
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < clean.length; i += step) {
    parts.push(clean.slice(i, i + size));
    if (i + size >= clean.length) break;
  }
  return parts;
}

function scoreChunk(query, text) {
  const terms = queryTerms(query);
  const hay = String(text || '').toLowerCase();
  if (!terms.length) return 0;
  let score = 0;
  for (const t of terms) {
    if (!hay.includes(t)) continue;
    const hits = hay.split(t).length - 1;
    score += t.length >= 3 ? (4 + Math.min(4, hits)) : (2 + Math.min(3, hits));
  }
  return score;
}

const KB_ALL_LIMIT = 120000;
const KB_CONTEXT_LIMIT = 90000;

function retrieveKnowledge(query) {
  const docs = loadKnowledgeDocs();
  const files = docs.map(d => d.name);
  const totalChars = docs.reduce((s, d) => s + d.text.length, 0);
  if (!docs.length) return { mode: 'empty', snippets: [], files: [], totalChars: 0 };
  if (totalChars <= KB_ALL_LIMIT) {
    return { mode: 'all', snippets: docs.map(d => ({ name: d.name, text: d.text })), files, totalChars };
  }
  const chunks = [];
  docs.forEach(doc => {
    splitChunks(doc.text).forEach(part => {
      chunks.push({ name: doc.name, text: part, score: scoreChunk(query, part) });
    });
  });
  chunks.sort((a, b) => b.score - a.score);
  const ranked = chunks.filter(c => c.score > 0);
  const picked = [];
  let used = 0;
  for (const c of (ranked.length ? ranked : chunks)) {
    if (picked.length >= 16 || used >= KB_CONTEXT_LIMIT) break;
    picked.push({ name: c.name, text: c.text });
    used += c.text.length;
  }
  return {
    mode: ranked.length ? 'search' : 'fallback',
    snippets: picked,
    files: [...new Set(picked.map(p => p.name))],
    totalChars
  };
}

function extractFileText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const allowed = ['.txt', '.md', '.csv', '.json', '.html', '.htm', '.log'];
  if (!allowed.includes(ext)) throw new Error('目前支援 txt、md、csv、json、html');
  return fs.readFileSync(filePath, 'utf8');
}

async function getEnterpriseToken() {
  if (!oauth2Client) throw new Error('請先用 Google 登入，才能呼叫 Gemini Enterprise');
  const tokenRes = await oauth2Client.getAccessToken();
  const token = tokenRes?.token || oauth2Client.credentials?.access_token;
  if (!token) throw new Error('無法取得 Google Cloud 授權，請登出後重新授權');
  return token;
}

function enterpriseServingConfig(cfg) {
  const resource = String(cfg.engineId || '').trim();
  if (!resource) return '';
  const cleaned = resource.replace(/:search$/, '').replace(/\/$/, '');
  if (cleaned.includes('/servingConfigs/')) return cleaned;
  if (cleaned.startsWith('projects/')) return `${cleaned}/servingConfigs/default_search`;
  const projectId = String(cfg.projectId || '').trim();
  if (!projectId) return '';
  const searchLocation = cfg.searchLocation || 'global';
  const kind = cfg.searchKind === 'datastore' ? 'dataStores' : 'engines';
  return `projects/${projectId}/locations/${searchLocation}/collections/default_collection/${kind}/${cleaned}/servingConfigs/default_search`;
}

function discoveryHost(searchLocation) {
  return !searchLocation || searchLocation === 'global'
    ? 'https://discoveryengine.googleapis.com'
    : `https://${searchLocation}-discoveryengine.googleapis.com`;
}

function structValue(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] != null) return obj[key];
  }
  return undefined;
}

function snippetText(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  return item.content || item.snippet || item.text || item.extractiveAnswer || '';
}

function parseSearchResults(data) {
  const snippets = [];
  const summary = data.summary?.summaryText || data.summary?.summary_text || '';
  if (summary) snippets.push({ name: '搜尋摘要', text: summary, uri: '' });
  for (const result of data.results || []) {
    const doc = result.document || {};
    const derived = doc.derivedStructData || doc.derived_struct_data || {};
    const struct = doc.structData || doc.struct_data || {};
    const title = structValue(derived, 'title', 'name') || structValue(struct, 'title', 'name') || doc.name || doc.id || '未命名文件';
    const parts = [];
    const answers = structValue(derived, 'extractive_answers', 'extractiveAnswers') || [];
    const segments = structValue(derived, 'extractive_segments', 'extractiveSegments') || [];
    const snips = structValue(derived, 'snippets') || [];
    for (const item of [...answers, ...segments, ...snips]) {
      const text = snippetText(item);
      if (text) parts.push(text);
    }
    if (result.chunk?.content) parts.push(result.chunk.content);
    const fallback = structValue(derived, 'content', 'body', 'description') || structValue(struct, 'content', 'body', 'description') || '';
    const text = parts.join('\n\n') || String(fallback || '');
    snippets.push({
      name: String(title),
      text: text || `（搜尋 API 找到文件，但沒有抽出內文）`,
      uri: String(structValue(derived, 'link', 'uri', 'url') || '')
    });
  }
  return snippets;
}

function patchDiagnosticsChannel() {
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
    patchDiagnosticsChannel();
    getMssql._api = require('mssql');
  }
  return getMssql._api;
}

function looksLikeConnectionString(value) {
  const text = String(value || '').trim();
  return /[=;]/.test(text) && /server\s*=|data source\s*=/i.test(text);
}

function normalizeConnectionString(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';

  // .NET / ADO.NET 常見鍵名 → node-mssql（tedious）較能辨識的鍵名
  text = text
    .replace(/Data\s*Source\s*=/gi, 'Server=')
    .replace(/Initial\s*Catalog\s*=/gi, 'Database=')
    .replace(/User\s*ID\s*=/gi, 'User Id=')
    .replace(/UID\s*=/gi, 'User Id=')
    .replace(/PWD\s*=/gi, 'Password=');

  // Server=tcp:HOST → Server=HOST
  text = text.replace(/(Server\s*=\s*)tcp:/gi, '$1');

  // 移除對 tedious 無用／易誤判的鍵
  text = text
    .replace(/Integrated\s*Security\s*=\s*[^;]*/gi, '')
    .replace(/Pooling\s*=\s*[^;]*/gi, '')
    .replace(/;;+/g, ';')
    .replace(/^;|;$/g, '');

  if (!/Encrypt\s*=/i.test(text)) text += (text.endsWith(';') ? '' : ';') + 'Encrypt=false';
  if (!/TrustServerCertificate\s*=/i.test(text)) text += ';TrustServerCertificate=true';
  return text;
}

function resolveConnectionString(cfg) {
  const dedicated = String(cfg.sqlConnectionString || '').trim();
  if (dedicated) return normalizeConnectionString(dedicated);
  if (looksLikeConnectionString(cfg.sqlServer)) return normalizeConnectionString(cfg.sqlServer);
  return '';
}

let sqlPool = null;
let sqlPoolKey = '';

function safeSqlIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`無效的資料庫識別名稱：${name}`);
  return `[${name}]`;
}

function parseTableName(raw) {
  const parts = String(raw || 'dbo.EMRequestForm').split('.').map(p => p.replace(/[\[\]]/g, '').trim()).filter(Boolean);
  if (parts.length === 1) return { schema: 'dbo', table: parts[0] };
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  if (parts.length === 3) return { schema: parts[1], table: parts[2] };
  throw new Error('資料表名稱格式應為 dbo.EMRequestForm');
}

function formatSqlCell(value) {
  if (value == null) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).trim();
}

function formatRequestRow(row) {
  const no = formatSqlCell(row.RequestNo) || formatSqlCell(row.ID);
  const lines = [
    `單號：${no}`,
    row.ProjectName ? `專案：${formatSqlCell(row.ProjectName)}` : '',
    row.RequestMan ? `申請人：${formatSqlCell(row.RequestMan)}` : '',
    row.ItMan ? `資訊人員：${formatSqlCell(row.ItMan)}` : '',
    row.Type ? `類型：${formatSqlCell(row.Type)}` : '',
    row.OccurDate ? `發生日：${formatSqlCell(row.OccurDate)}` : '',
    row.FinishDate ? `完成日：${formatSqlCell(row.FinishDate)}` : '',
    `問題狀況：${formatSqlCell(row.Situation) || '（無）'}`,
    `解決方式：${formatSqlCell(row.Process) || '（無）'}`
  ].filter(Boolean);
  return { name: `單號 ${no}`, text: lines.join('\n') };
}

function sqlLikeTerms(query) {
  const raw = String(query || '').trim();
  const terms = queryTerms(raw)
    .filter(t => t.length >= 2 && !/^[的了嗎呢是在有和與或到會就]$/.test(t))
    .sort((a, b) => b.length - a.length);
  const uniq = [];
  for (const t of terms) {
    if (uniq.length >= 6) break;
    if (uniq.some(u => u.includes(t))) continue;
    uniq.push(t);
  }
  if (!uniq.length && raw) uniq.push(raw.slice(0, 40));
  return uniq;
}

async function getSqlPool(cfg) {
  const connectionString = resolveConnectionString(cfg);
  const key = JSON.stringify({
    connectionString,
    server: cfg.sqlServer,
    port: cfg.sqlPort,
    database: cfg.sqlDatabase,
    user: cfg.sqlUser,
    password: cfg.sqlPassword,
    encrypt: cfg.sqlEncrypt,
    trust: cfg.sqlTrustCert
  });
  if (sqlPool && sqlPoolKey === key) return sqlPool;
  if (sqlPool) {
    try { await sqlPool.close(); } catch (_) {}
    sqlPool = null;
  }
  const sql = getMssql();
  if (connectionString) {
    sqlPool = await sql.connect(connectionString);
    sqlPoolKey = key;
    return sqlPool;
  }
  let server = String(cfg.sqlServer || '').trim();
  let instanceName;
  if (server.includes('\\')) {
    const parts = server.split('\\');
    server = parts[0];
    instanceName = parts.slice(1).join('\\');
  }
  const config = {
    server,
    database: String(cfg.sqlDatabase || 'erp').trim(),
    user: String(cfg.sqlUser || '').trim() || undefined,
    password: cfg.sqlPassword || '',
    options: {
      encrypt: cfg.sqlEncrypt === true,
      trustServerCertificate: cfg.sqlTrustCert !== false,
      enableArithAbort: true
    },
    connectionTimeout: 15000,
    requestTimeout: 20000
  };
  if (instanceName) config.options.instanceName = instanceName;
  else config.port = Number(cfg.sqlPort) || 1433;
  sqlPool = await sql.connect(config);
  sqlPoolKey = key;
  return sqlPool;
}

let lastSqlRetrieval = null;

async function retrieveSql(query) {
  const cfg = loadGeminiConfig();
  const connectionString = resolveConnectionString(cfg);
  if (!connectionString && !String(cfg.sqlServer || '').trim()) {
    return { success: false, error: '請在設定填入 SQL 連線字串或 SQL Server 位址' };
  }
  if (!connectionString && !String(cfg.sqlUser || '').trim()) {
    return { success: false, error: '請在設定填入 SQL 帳號，或改貼完整連線字串' };
  }
  const sql = getMssql();
  const pool = await getSqlPool(cfg);
  const { schema, table } = parseTableName(cfg.sqlTable || 'dbo.EMRequestForm');
  const tableRef = `${safeSqlIdent(schema)}.${safeSqlIdent(table)}`;
  const terms = sqlLikeTerms(query);
  const req = pool.request();
  const likes = terms.map((term, i) => {
    req.input(`t${i}`, sql.NVarChar, `%${term}%`);
    return `(Situation LIKE @t${i} OR Process LIKE @t${i} OR ProjectName LIKE @t${i} OR RequestNo LIKE @t${i})`;
  });
  const where = [
    '(Deleted = 0 OR Deleted IS NULL)',
    likes.length ? `(${likes.join(' OR ')})` : null
  ].filter(Boolean).join(' AND ');
  const sqlText = `
    SELECT TOP (30)
      [ID], [Seq], [RequestNo], [RequestMan], [Situation], [Process],
      [ProjectName], [ItMan], [OccurDate], [FinishDate], [Type]
    FROM ${tableRef}
    WHERE ${where}
    ORDER BY [ModifyDate] DESC, [CreateDate] DESC
  `;
  const result = await req.query(sqlText);
  const snippets = (result.recordset || []).map(formatRequestRow);
  lastSqlRetrieval = {
    query: String(query || '').trim(),
    snippets,
    at: Date.now()
  };
  return {
    success: true,
    mode: 'sql',
    api: `SELECT TOP (30) Situation, Process FROM ${cfg.sqlDatabase || 'erp'}.${schema}.${table}`,
    files: snippets.map(s => s.name),
    snippets
  };
}

let lastEnterpriseRetrieval = null;

async function retrieveEnterprise(query) {
  const cfg = loadGeminiConfig();
  const servingConfig = enterpriseServingConfig(cfg);
  if (!servingConfig) {
    return { success: false, error: '請在設定填入 Gemini Enterprise 搜尋應用或資料庫 ID' };
  }
  const token = await getEnterpriseToken();
  const host = discoveryHost(cfg.searchLocation || 'global');
  const url = `${host}/v1/${servingConfig}:search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: String(query || '').trim(),
      pageSize: 8,
      languageCode: 'zh-TW',
      queryExpansionSpec: { condition: 'AUTO' },
      spellCorrectionSpec: { mode: 'AUTO' },
      contentSearchSpec: {
        snippetSpec: { returnSnippet: true, maxSnippetCount: 3 },
        extractiveContentSpec: {
          maxExtractiveAnswerCount: 3,
          maxExtractiveSegmentCount: 3
        }
      }
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error?.message || `搜尋 API 錯誤 ${res.status}`;
    if (res.status === 401) {
      return { success: false, error: 'Google Cloud 授權不足。請登出後重新授權，並同意雲端平台權限。' };
    }
    if (res.status === 403) {
      return { success: false, error: `${msg}。請啟用 Discovery Engine / Agent Search API（discoveryengine.googleapis.com），並確認搜尋應用 ID 正確。` };
    }
    if (res.status === 404) {
      return { success: false, error: `找不到搜尋應用或資料庫。目前路徑：${servingConfig}` };
    }
    return { success: false, error: msg };
  }
  const snippets = parseSearchResults(data);
  lastEnterpriseRetrieval = {
    query: String(query || '').trim(),
    snippets,
    servingConfig,
    at: Date.now(),
    total: (data.results || []).length
  };
  return {
    success: true,
    mode: 'api',
    api: url,
    servingConfig,
    files: snippets.map(s => s.name),
    snippets,
    total: lastEnterpriseRetrieval.total
  };
}

ipcMain.handle('gemini-get-config', async () => {
  const cfg = loadGeminiConfig();
  return {
    success: true,
    hasKey: !!cfg.apiKey,
    loggedIn: !!oauth2Client,
    model: cfg.model || 'gemini-2.5-flash',
    projectId: cfg.projectId || '',
    location: cfg.location || 'us-central1',
    engineId: cfg.engineId || '',
    searchKind: cfg.searchKind || 'engine',
    searchLocation: cfg.searchLocation || 'global',
    sqlConnectionString: cfg.sqlConnectionString || '',
    hasSqlConnectionString: !!cfg.sqlConnectionString,
    sqlServer: cfg.sqlServer || '',
    sqlPort: cfg.sqlPort || 1433,
    sqlDatabase: cfg.sqlDatabase || 'erp',
    sqlTable: cfg.sqlTable || 'dbo.EMRequestForm',
    sqlUser: cfg.sqlUser || '',
    hasSqlPassword: !!cfg.sqlPassword,
    sqlEncrypt: !!cfg.sqlEncrypt,
    sqlTrustCert: cfg.sqlTrustCert !== false
  };
});

ipcMain.handle('gemini-save-config', async (event, cfg) => {
  saveGeminiConfig(cfg || {});
  return { success: true };
});

ipcMain.handle('knowledge-list', async () => {
  const list = loadKnowledgeIndex().map(({ id, name, addedAt, chars }) => ({ id, name, addedAt, chars }));
  return { success: true, files: list };
});

ipcMain.handle('knowledge-add', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: '加入知識庫檔案',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '文件', extensions: ['txt', 'md', 'csv', 'json', 'html', 'htm', 'log'] }]
  });
  if (picked.canceled || !picked.filePaths.length) return { success: true, added: 0 };
  const index = loadKnowledgeIndex();
  let added = 0;
  for (const filePath of picked.filePaths) {
    try {
      const text = extractFileText(filePath);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const name = path.basename(filePath);
      const stored = path.join(knowledgeDir(), `${id}.txt`);
      fs.writeFileSync(stored, text);
      index.push({ id, name, file: stored, addedAt: Date.now(), chars: text.length });
      added += 1;
    } catch (err) {
      console.error('匯入失敗:', filePath, err.message);
    }
  }
  saveKnowledgeIndex(index);
  return { success: true, added, files: index.map(({ id, name, addedAt, chars }) => ({ id, name, addedAt, chars })) };
});

ipcMain.handle('knowledge-remove', async (event, id) => {
  const next = loadKnowledgeIndex().filter(item => {
    if (item.id !== id) return true;
    try { if (item.file && fs.existsSync(item.file)) fs.unlinkSync(item.file); } catch (_) {}
    return false;
  });
  saveKnowledgeIndex(next);
  return { success: true, files: next.map(({ id, name, addedAt, chars }) => ({ id, name, addedAt, chars })) };
});

ipcMain.handle('knowledge-search', async (event, query) => {
  try {
    const retrieved = await retrieveSql(query);
    if (!retrieved.success) return retrieved;
    return {
      success: true,
      mode: 'sql',
      api: retrieved.api,
      files: retrieved.files,
      totalChars: retrieved.snippets.reduce((sum, s) => sum + String(s.text || '').length, 0),
      snippets: retrieved.snippets.map(s => ({
        name: s.name,
        excerpt: String(s.text || '').slice(0, 280),
        chars: String(s.text || '').length
      }))
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});


// ========== 【MODULE: modules/ai-chat】詢問機器人 ==========
ipcMain.handle('chat-ask', async (event, { question, history }) => {
  try {
    const q = String(question || '').trim();
    if (!q) return { success: false, error: '請輸入問題' };
    const cfg = loadGeminiConfig();
    const model = cfg.model || 'gemini-2.5-flash';
    const projectId = String(cfg.projectId || '').trim();
    const location = String(cfg.location || 'us-central1').trim();
    const useEnterprise = !!projectId;

    if (useEnterprise && !oauth2Client) {
      return { success: false, error: '請先用 Google 登入，才能使用 Gemini Enterprise' };
    }
    if (!useEnterprise && !cfg.apiKey) {
      return { success: false, error: '請在設定填入 Google Cloud 專案 ID（Gemini Enterprise）' };
    }

    let retrieved = lastSqlRetrieval
      && lastSqlRetrieval.query === q
      && Date.now() - lastSqlRetrieval.at < 120000
      ? lastSqlRetrieval
      : null;
    if (!retrieved) {
      const search = await retrieveSql(q);
      if (!search.success) return search;
      retrieved = lastSqlRetrieval;
    }
    const used = retrieved?.snippets || [];
    const context = used.length
      ? used.map(c => `【${c.name}】\n${c.text}`).join('\n\n---\n\n')
      : '（SQL 查詢沒有撈到相關問題單）';

    const system = `你是 LifeTour 的 ERP 問題單助理。資料來自 SQL 資料表 EMRequestForm：
- Situation = 問題狀況
- Process = 解決方式
規則：
1. 只能根據查詢到的問題單回答，不可編造資料庫沒有的內容。
2. 回答時先對應類似的問題狀況，再說明當時的解決方式。
3. 若沒有足夠資訊，明確回答「資料庫中找不到足夠資訊」。
4. 用繁體中文，條理清楚。引用時標示單號。`;

    const past = Array.isArray(history) ? history.slice(-8) : [];
    const contents = [
      ...past.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.text || '') }]
      })),
      {
        role: 'user',
        parts: [{ text: `以下是從 [erp].[dbo].[EMRequestForm] 查到的問題單（Situation=問題狀況，Process=解決方式）：\n${context}\n\n使用者問題：${q}` }]
      }
    ];

    const payload = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.2 }
    };

    let url;
    const headers = { 'Content-Type': 'application/json' };
    if (useEnterprise) {
      const tokenRes = await oauth2Client.getAccessToken();
      const token = tokenRes?.token || oauth2Client.credentials?.access_token;
      if (!token) return { success: false, error: '無法取得 Google Cloud 授權，請登出後重新授權' };
      headers.Authorization = `Bearer ${token}`;
      const host = location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${location}-aiplatform.googleapis.com`;
      url = `${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    } else {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    }

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) {
      const msg = data.error?.message || `Gemini 錯誤 ${res.status}`;
      if (res.status === 401 || /unauth|invalid.?credential/i.test(msg)) {
        return { success: false, error: 'Google Cloud 授權不足。請登出後重新授權，並同意雲端平台權限。' };
      }
      if (res.status === 403) {
        return { success: false, error: `${msg}。請在該專案啟用 Vertex AI API（aiplatform.googleapis.com），並確認帳號有權限。` };
      }
      return { success: false, error: msg };
    }
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!text) return { success: false, error: '模型沒有回傳內容' };
    return { success: true, text, sources: [...new Set(used.map(u => u.name))] };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function reportSchemaPath() { return path.join(app.getPath('userData'), 'report-schema.json'); }

function defaultReportTables() {
  return [
    {
      id: 'EMRequestForm',
      schema: 'dbo',
      table: 'EMRequestForm',
      title: '需求單',
      behavior: '需求單 9527 主檔。一筆代表一張需求／問題單：Situation 是問題狀況，Process 是解決方式。Deleted=1 不列入報表。FinishDate 有值視為已結案，空值視為未結案。常用分析維度：Type、ItMan、ProjectName、RequestMan，以及 OccurDate／FinishDate／CreateDate。',
      columns: [
        { name: 'ID', type: 'int', meaning: '主鍵' },
        { name: 'Seq', type: 'int', meaning: '序號' },
        { name: 'RequestNo', type: 'nvarchar', meaning: '需求單單號' },
        { name: 'RequestMan', type: 'nvarchar', meaning: '申請人' },
        { name: 'Situation', type: 'nvarchar', meaning: '問題狀況（發生了什麼事）' },
        { name: 'Process', type: 'nvarchar', meaning: '解決方式（後來怎麼處理）' },
        { name: 'ProjectName', type: 'nvarchar', meaning: '專案或系統名稱' },
        { name: 'ItMan', type: 'nvarchar', meaning: '資訊處理人員' },
        { name: 'OccurDate', type: 'datetime', meaning: '問題發生日期' },
        { name: 'FinishDate', type: 'datetime', meaning: '完成日期；空值多半代表尚未完成' },
        { name: 'CreateDate', type: 'datetime', meaning: '建立時間' },
        { name: 'CreateUser', type: 'nvarchar', meaning: '建立者' },
        { name: 'CreateDept', type: 'nvarchar', meaning: '建立部門' },
        { name: 'ModifyDate', type: 'datetime', meaning: '最後修改時間' },
        { name: 'ModifyUser', type: 'nvarchar', meaning: '最後修改者' },
        { name: 'ModifyDept', type: 'nvarchar', meaning: '最後修改部門' },
        { name: 'Enabled', type: 'bit', meaning: '是否啟用；0 視為停用' },
        { name: 'Deleted', type: 'bit', meaning: '是否刪除；1 不要列入報表' },
        { name: 'Type', type: 'nvarchar', meaning: '需求單類型' }
      ]
    }
  ];
}

function loadReportTables() {
  const map = new Map();
  defaultReportTables().forEach(t => map.set(t.id, t));
  try {
    if (fs.existsSync(reportSchemaPath())) {
      const saved = JSON.parse(fs.readFileSync(reportSchemaPath(), 'utf8'));
      (saved.tables || []).forEach(t => {
        if (!t?.id) return;
        map.set(t.id, { ...map.get(t.id), ...t });
      });
    }
  } catch (_) {}
  return [...map.values()];
}

function saveReportTables(tables) {
  fs.writeFileSync(reportSchemaPath(), JSON.stringify({ tables: tables || [] }, null, 2));
}

function schemaGuide(tables) {
  return (tables || []).map(t => {
    const cols = (t.columns || []).map(c => `- ${c.name} (${c.type || 'unknown'}): ${c.meaning || ''}`).join('\n');
    return `資料表 ${t.schema || 'dbo'}.${t.table}（${t.title || t.table}）\n行為：${t.behavior || '無'}\n欄位：\n${cols}`;
  }).join('\n\n');
}

const REQUEST_FORM_WHERE = '(Deleted = 0 OR Deleted IS NULL)';

function reportPresets() {
  return [
    {
      id: 'summary',
      label: '總覽',
      title: '需求單總覽',
      question: '需求單整體件數、未結案與已結案',
      sql: `SELECT
        COUNT(*) AS 全部件數,
        SUM(CASE WHEN FinishDate IS NULL THEN 1 ELSE 0 END) AS 未結案,
        SUM(CASE WHEN FinishDate IS NOT NULL THEN 1 ELSE 0 END) AS 已結案,
        SUM(CASE WHEN FinishDate IS NULL AND OccurDate < DATEADD(day, -14, GETDATE()) THEN 1 ELSE 0 END) AS 超過14天未結案
      FROM dbo.EMRequestForm
      WHERE ${REQUEST_FORM_WHERE}`
    },
    {
      id: 'open',
      label: '未結案',
      title: '未結案需求單',
      question: '列出尚未結案的需求單',
      sql: `SELECT TOP 100 RequestNo, RequestMan, ProjectName, ItMan, Type, Situation, Process, OccurDate, CreateDate
      FROM dbo.EMRequestForm
      WHERE ${REQUEST_FORM_WHERE} AND FinishDate IS NULL
      ORDER BY OccurDate DESC, CreateDate DESC`
    },
    {
      id: 'by-person',
      label: '依處理人',
      title: '需求單依處理人統計',
      question: '依 ItMan 統計處理件數與未結案件數',
      sql: `SELECT TOP 50
        ISNULL(NULLIF(LTRIM(RTRIM(ItMan)), ''), N'未指定') AS 處理人,
        COUNT(*) AS 全部,
        SUM(CASE WHEN FinishDate IS NULL THEN 1 ELSE 0 END) AS 未結案,
        SUM(CASE WHEN FinishDate IS NOT NULL THEN 1 ELSE 0 END) AS 已結案
      FROM dbo.EMRequestForm
      WHERE ${REQUEST_FORM_WHERE}
      GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(ItMan)), ''), N'未指定')
      ORDER BY 未結案 DESC, 全部 DESC`
    },
    {
      id: 'by-type',
      label: '依類型',
      title: '需求單依類型統計',
      question: '依 Type 統計數量，並對照常見問題狀況',
      sql: `SELECT TOP 50
        ISNULL(NULLIF(LTRIM(RTRIM(Type)), ''), N'未分類') AS 類型,
        COUNT(*) AS 全部,
        SUM(CASE WHEN FinishDate IS NULL THEN 1 ELSE 0 END) AS 未結案,
        SUM(CASE WHEN FinishDate IS NOT NULL THEN 1 ELSE 0 END) AS 已結案
      FROM dbo.EMRequestForm
      WHERE ${REQUEST_FORM_WHERE}
      GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(Type)), ''), N'未分類')
      ORDER BY 全部 DESC`
    },
    {
      id: 'by-project',
      label: '依專案',
      title: '需求單依專案統計',
      question: '依 ProjectName 統計需求單',
      sql: `SELECT TOP 50
        ISNULL(NULLIF(LTRIM(RTRIM(ProjectName)), ''), N'未填專案') AS 專案,
        COUNT(*) AS 全部,
        SUM(CASE WHEN FinishDate IS NULL THEN 1 ELSE 0 END) AS 未結案
      FROM dbo.EMRequestForm
      WHERE ${REQUEST_FORM_WHERE}
      GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(ProjectName)), ''), N'未填專案')
      ORDER BY 未結案 DESC, 全部 DESC`
    },
    {
      id: 'this-month',
      label: '本月',
      title: '本月需求單',
      question: '本月新增、發生或結案的需求單',
      sql: `SELECT TOP 100 RequestNo, RequestMan, ProjectName, ItMan, Type, Situation, Process, OccurDate, FinishDate, CreateDate
      FROM dbo.EMRequestForm
      WHERE ${REQUEST_FORM_WHERE}
        AND (
          CreateDate >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
          OR OccurDate >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
          OR FinishDate >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
        )
      ORDER BY ISNULL(ModifyDate, CreateDate) DESC`
    },
    {
      id: 'solutions',
      label: '近期解法',
      title: '近 90 天已結案解法',
      question: '近 90 天已結案需求單的問題狀況與解決方式',
      sql: `SELECT TOP 80 RequestNo, ProjectName, Type, Situation, Process, ItMan, FinishDate
      FROM dbo.EMRequestForm
      WHERE ${REQUEST_FORM_WHERE}
        AND FinishDate IS NOT NULL
        AND FinishDate >= DATEADD(day, -90, GETDATE())
      ORDER BY FinishDate DESC`
    }
  ];
}

async function callGemini({ system, contents, temperature = 0.2 }) {
  const cfg = loadGeminiConfig();
  const model = cfg.model || 'gemini-2.5-flash';
  const projectId = String(cfg.projectId || '').trim();
  const location = String(cfg.location || 'us-central1').trim();
  const useEnterprise = !!projectId;
  if (useEnterprise && !oauth2Client) throw new Error('請先用 Google 登入，才能使用 Gemini Enterprise');
  if (!useEnterprise && !cfg.apiKey) throw new Error('請在設定填入 Google Cloud 專案 ID（Gemini Enterprise）');

  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature }
  };
  let url;
  const headers = { 'Content-Type': 'application/json' };
  if (useEnterprise) {
    const tokenRes = await oauth2Client.getAccessToken();
    const token = tokenRes?.token || oauth2Client.credentials?.access_token;
    if (!token) throw new Error('無法取得 Google Cloud 授權，請登出後重新授權');
    headers.Authorization = `Bearer ${token}`;
    const host = location === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${location}-aiplatform.googleapis.com`;
    url = `${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error?.message || `Gemini 錯誤 ${res.status}`;
    if (res.status === 401 || /unauth|invalid.?credential/i.test(msg)) {
      throw new Error('Google Cloud 授權不足。請登出後重新授權，並同意雲端平台權限。');
    }
    if (res.status === 403) throw new Error(`${msg}。請在該專案啟用 Vertex AI API。`);
    throw new Error(msg);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('模型沒有回傳內容');
  return text;
}

function parseJsonFromModel(text) {
  const raw = String(text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型沒有回傳可用的 JSON');
  return JSON.parse(body.slice(start, end + 1));
}

function extractSqlTables(sql) {
  return [...String(sql || '').matchAll(/\b(?:FROM|JOIN)\s+((?:\[[^\]]+\]|[A-Za-z0-9_]+)(?:\s*\.\s*(?:\[[^\]]+\]|[A-Za-z0-9_]+)){0,2})/ig)]
    .map(m => m[1].replace(/[\[\]]/g, '').replace(/\s+/g, '').toLowerCase());
}

function allowedTableAliases(table, database) {
  const schema = String(table.schema || 'dbo').toLowerCase();
  const name = String(table.table || '').toLowerCase();
  const db = String(database || 'erp').toLowerCase();
  return new Set([name, `${schema}.${name}`, `${db}.${schema}.${name}`]);
}

function validateReportSql(sql, tables) {
  const text = String(sql || '').replace(/^\uFEFF/, '').trim().replace(/;+\s*$/, '');
  if (!text) throw new Error('沒有產生 SQL');
  if (!/^\s*(SELECT|WITH)\b/i.test(text)) throw new Error('報表查詢必須是 SELECT');
  if (/;/.test(text)) throw new Error('不可一次執行多段 SQL');
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|MERGE|EXEC|EXECUTE|TRUNCATE|CREATE|GRANT|REVOKE|INTO|XP_)\b/i.test(text)) {
    throw new Error('只允許讀取資料，不能修改資料庫');
  }
  const used = extractSqlTables(text);
  if (!used.length) throw new Error('SQL 缺少 FROM 資料表');
  const cfg = loadGeminiConfig();
  const allowed = new Set();
  tables.forEach(t => allowedTableAliases(t, cfg.sqlDatabase).forEach(n => allowed.add(n)));
  const unknown = used.filter(n => !allowed.has(n));
  if (unknown.length) throw new Error(`SQL 使用了尚未訓練的資料表：${unknown.join(', ')}`);
  return text;
}

function serializeReportValue(value) {
  if (value == null) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  const text = String(value);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

async function executeReportSql(sql) {
  const pool = await getSqlPool(loadGeminiConfig());
  const result = await pool.request().query(sql);
  const recordset = result.recordset || [];
  const columns = recordset.length ? Object.keys(recordset[0]) : [];
  const rows = recordset.slice(0, 200).map(row => {
    const item = {};
    columns.forEach(col => { item[col] = serializeReportValue(row[col]); });
    return item;
  });
  return { columns, rows, total: recordset.length };
}

ipcMain.handle('report-tables', async () => {
  return { success: true, tables: loadReportTables() };
});

ipcMain.handle('report-save-table', async (event, table) => {
  try {
    const name = String(table?.table || '').replace(/[\[\]]/g, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('資料表名稱無效');
    const schema = String(table?.schema || 'dbo').replace(/[\[\]]/g, '').trim() || 'dbo';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('結構描述名稱無效');
    const id = String(table?.id || name).trim();
    const current = loadReportTables();
    const nextTable = {
      id,
      schema,
      table: name,
      title: String(table?.title || name).trim(),
      behavior: String(table?.behavior || '').trim(),
      columns: Array.isArray(table?.columns) ? table.columns.map(c => ({
        name: String(c.name || '').trim(),
        type: String(c.type || '').trim(),
        meaning: String(c.meaning || '').trim()
      })).filter(c => c.name) : []
    };
    const idx = current.findIndex(t => t.id === id);
    if (idx >= 0) current[idx] = { ...current[idx], ...nextTable };
    else current.push(nextTable);
    saveReportTables(current);
    return { success: true, tables: loadReportTables() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('report-presets', async () => {
  return {
    success: true,
    presets: reportPresets().map(({ id, label, title, question }) => ({ id, label, title, question }))
  };
});

ipcMain.handle('report-run', async (event, { question, presetId }) => {
  try {
    const tables = loadReportTables();
    if (!tables.length) return { success: false, error: '還沒有訓練任何資料表' };
    const guide = schemaGuide(tables);
    const preset = reportPresets().find(p => p.id === presetId);
    const q = String(question || preset?.question || '').trim();
    if (!q && !preset) return { success: false, error: '請輸入要產出的報表' };

    let sql;
    let title;
    if (preset) {
      sql = validateReportSql(preset.sql, tables);
      title = preset.title;
    } else {
      const planText = await callGemini({
        temperature: 0.1,
        system: `你是需求單 9527 的 SQL Server 報表規劃器。只能查 dbo.EMRequestForm。
規則：
1. 只輸出 JSON，格式 {"sql":"SELECT ...","title":"報表標題"}。
2. sql 必須是單一 SELECT 或 WITH...SELECT，不可修改資料。
3. 排除 Deleted = 1；FinishDate 為空視為未結案。
4. Situation=問題狀況，Process=解決方式。
5. 明細最多 TOP 100；統計用 GROUP BY。
6. 使用 SQL Server T-SQL，不可臆造欄位。`,
        contents: [{
          role: 'user',
          parts: [{ text: `資料字典：\n${guide}\n\n使用者要的報表：${q}` }]
        }]
      });
      const plan = parseJsonFromModel(planText);
      sql = validateReportSql(plan.sql, tables);
      title = plan.title || '需求單報表';
    }

    const data = await executeReportSql(sql);
    const preview = data.rows.slice(0, 80);
    const analysis = await callGemini({
      temperature: 0.2,
      system: `你是 LifeTour 需求單 9527 報表助理。資料來自 EMRequestForm：Situation=問題狀況，Process=解決方式，FinishDate 空值=未結案。
只能根據查詢結果分析，不可編造數字。用繁體中文，先結論再重點與建議。引用單號 RequestNo。`,
      contents: [{
        role: 'user',
        parts: [{ text: `資料字典：\n${guide}\n\n報表需求：${q}\n標題：${title}\nSQL：\n${sql}\n\n查詢結果（${data.total} 筆，以下最多 80 筆）：\n${JSON.stringify(preview, null, 2)}` }]
      }]
    });
    return {
      success: true,
      title,
      sql,
      columns: data.columns,
      rows: data.rows,
      total: data.total,
      analysis
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ========== 【MODULE: modules/report-export】SQL 報表匯出 ==========
try {
  const { registerReportExportModule } = require('./modules/report-export/register');
  reportExportControls = registerReportExportModule({
    ipcMain,
    app,
    dialog,
    getMainWindow: () => win,
    getSqlPool: (cfg) => getSqlPool(cfg || loadGeminiConfig()),
    loadGeminiConfig,
    saveGeminiConfig,
    isFeatureActive,
    getSheetsService: () => sheetsService,
    getDriveService: () => driveService,
    withGoogleApiRetry,
    grantedScopeText,
    hasSheetsScope,
    hasDriveFileScope,
    quoteSheetRange,
    resolveMyEmail: ensureMyEmailForBugReport
  });
} catch (err) {
  console.error('[report-export] register failed', err);
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  // Windows：統一 App 識別，避免工作列／通知顯示成 Electron
  if (process.platform === 'win32') {
    try { app.setAppUserModelId(APP_USER_MODEL_ID); } catch (_) {}
  }
  try { app.setName(APP_DISPLAY_NAME); } catch (_) {}
  app.whenReady().then(() => {
    try {
      protocol.registerFileProtocol('gchat-emoji', (request, callback) => {
        try {
          const uid = parseCustomEmojiProtocolUid(request.url);
          const local = findCustomEmojiLocalImage(uid);
          if (local) callback({ path: path.normalize(local) });
          else callback({ error: -6 });
        } catch (_) {
          callback({ error: -2 });
        }
      });
    } catch (err) {
      console.warn('[GChat] 自訂表情本機協定註冊失敗:', err.message);
    }
    try { app.setUserTasks([]); } catch (_) {}
    loadAppTheme();
    loadAppFontScale();
    loadGchatDisk();
    createWindow();
    startSessionWatch();
    scheduleGchatDirectoryWarmOnStartup();
    // [Important] ADR 0006：背景輪詢僅在 Active Feature（gchat）時由 renderer 推清單後啟動
    // showWorkspace → setActiveFeatures →（若有 gchat）gchat-alert-watch
    setupAutoUpdater();
  });
}

let allowingQuit = false;
app.on('before-quit', (e) => {
  if (gchatQuickSearchWin && !gchatQuickSearchWin.isDestroyed()) {
    try { gchatQuickSearchWin.close(); } catch (_) {}
    gchatQuickSearchWin = null;
  }
  if (allowingQuit || !gmailService) return;
  if (pending.markRead.size === 0 && pending.replies.length === 0) return;
  e.preventDefault();
  flushPending()
    .catch(() => {})
    .finally(() => {
      saveDiskPacket();
      allowingQuit = true;
      app.quit();
    });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});
app.on('activate', () => {
  if (win) {
    win.show();
    win.focus();
  } else {
    createWindow();
  }
});


// ========== 【MODULE: framework/updater】自動更新 ==========
// ─── GCP / Cloud Storage 自動更新（electron-updater）────────────────────────
let autoUpdaterRef = null;
let updateCheckTimer = null;
const updateState = {
  checking: false,
  available: false,
  downloaded: false,
  version: '',
  error: '',
  currentVersion: '',
  promptedVersion: ''
};

function getAppVersion() {
  try {
    return String(app.getVersion?.() || require(path.join(APP_ROOT, 'package.json')).version || '0.0.0');
  } catch (_) {
    return '0.0.0';
  }
}

function broadcastUpdateStatus(extra = {}) {
  updateState.currentVersion = getAppVersion();
  const payload = { success: true, ...updateState, ...extra };
  try {
    if (win && !win.isDestroyed()) win.webContents.send('app-update-status', payload);
  } catch (_) {}
  return payload;
}

function setupAutoUpdater() {
  updateState.currentVersion = getAppVersion();
  // [Development Only] 開發模式不檢查更新
  if (!app.isPackaged) {
    broadcastUpdateStatus({ checking: false, error: '' });
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[LifeTour] 無法載入自動更新模組：', err.message);
    broadcastUpdateStatus({ error: '自動更新模組未安裝' });
    return;
  }

  autoUpdaterRef = autoUpdater;
  // [Important] 公司環境：禁止自動下載／結束時自動安裝，一律等使用者按確認
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  const feed = String(updateConfig.updateFeedUrl || '').trim();
  if (!feed) {
    console.warn('[LifeTour] 未設定 updateFeedUrl，略過自動更新');
    return;
  }
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  } catch (err) {
    console.warn('[LifeTour] 設定更新來源失敗：', err.message);
  }

  autoUpdater.on('checking-for-update', () => {
    updateState.checking = true;
    updateState.error = '';
    broadcastUpdateStatus();
  });

  autoUpdater.on('update-available', (info) => {
    updateState.checking = false;
    updateState.available = true;
    updateState.downloaded = false;
    updateState.version = info?.version || '';
    updateState.error = '';
    broadcastUpdateStatus();
    const ver = updateState.version || '新版本';
    // 同一版本只跳一次確認框，避免背景檢查一直打斷；設定頁仍可手動確認更新
    if (updateState.promptedVersion === ver) return;
    updateState.promptedVersion = ver;
    dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'info',
      title: 'LifeTour 發現新版本',
      message: `有新版本 ${ver}（目前 ${getAppVersion()}）`,
      detail: '不會自動更新。請按「確認更新」才會開始下載；也可稍後到「設定 → 版本與更新」再按確認。',
      buttons: ['確認更新', '稍後'],
      defaultId: 1,
      cancelId: 1
    }).then((res) => {
      if (res.response === 0) {
        try { autoUpdater.downloadUpdate(); } catch (err) {
          console.warn('[LifeTour] 開始下載更新失敗：', err.message);
        }
      }
    }).catch(() => {});
  });

  autoUpdater.on('update-not-available', () => {
    updateState.checking = false;
    updateState.available = false;
    updateState.error = '';
    broadcastUpdateStatus();
  });

  autoUpdater.on('error', (err) => {
    updateState.checking = false;
    updateState.error = err?.message || String(err || '更新檢查失敗');
    console.warn('[LifeTour] 自動更新錯誤：', updateState.error);
    broadcastUpdateStatus();
  });

  autoUpdater.on('download-progress', (p) => {
    broadcastUpdateStatus({
      downloading: true,
      percent: Math.round(Number(p?.percent || 0))
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState.checking = false;
    updateState.downloaded = true;
    updateState.available = true;
    updateState.version = info?.version || updateState.version;
    broadcastUpdateStatus({ downloading: false, percent: 100 });
    dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'info',
      title: '更新已下載完成',
      message: `版本 ${updateState.version || ''} 已下載`,
      detail: '不會自動安裝。請按「確認安裝並重開」才會安裝；按取消可稍後到設定再安裝。',
      buttons: ['確認安裝並重開', '取消'],
      defaultId: 1,
      cancelId: 1
    }).then((res) => {
      if (res.response === 0) {
        try {
          isQuitting = true;
          autoUpdater.quitAndInstall(false, true);
        } catch (err) {
          console.warn('[LifeTour] 安裝更新失敗：', err.message);
        }
      }
    }).catch(() => {});
  });

  const delay = Math.max(0, Number(updateConfig.checkDelayMs) || 5000);
  setTimeout(() => {
    // 啟動時檢查版本
    checkForAppUpdates({ silent: true }).catch(() => {});
  }, delay);

  // [Important] 預設每 1 小時檢查；設定檔可覆寫
  const interval = Number(updateConfig.checkIntervalMs);
  const period = Number.isFinite(interval) && interval > 0
    ? interval
    : (60 * 60 * 1000);
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  updateCheckTimer = setInterval(() => {
    checkForAppUpdates({ silent: true }).catch(() => {});
  }, period);
  console.log(`[LifeTour] 版本檢查：啟動後 ${delay}ms，之後每 ${Math.round(period / 60000)} 分鐘`);
}

async function checkForAppUpdates({ silent = false } = {}) {
  updateState.currentVersion = getAppVersion();
  if (!silent) {
    // 手動檢查：允許再跳出確認框
    updateState.promptedVersion = '';
  }
  if (!app.isPackaged) {
    const msg = '開發模式不會檢查更新（請用正式安裝包測試）';
    if (!silent) {
      dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
        type: 'info',
        title: '檢查更新',
        message: msg
      }).catch(() => {});
    }
    return broadcastUpdateStatus({ error: msg });
  }
  if (!autoUpdaterRef) {
    const msg = '自動更新尚未初始化';
    return broadcastUpdateStatus({ error: msg });
  }
  try {
    updateState.checking = true;
    broadcastUpdateStatus();
    const result = await autoUpdaterRef.checkForUpdates();
    return broadcastUpdateStatus({
      checking: false,
      updateInfo: result?.updateInfo || null
    });
  } catch (err) {
    updateState.checking = false;
    updateState.error = err?.message || '檢查更新失敗';
    if (!silent) {
      dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
        type: 'warning',
        title: '檢查更新失敗',
        message: updateState.error
      }).catch(() => {});
    }
    return broadcastUpdateStatus();
  }
}

ipcMain.handle('app-get-version', async () => ({
  success: true,
  version: getAppVersion(),
  packaged: !!app.isPackaged,
  feedUrl: updateConfig.updateFeedUrl || ''
}));

ipcMain.handle('app-get-update-status', async () => broadcastUpdateStatus());

ipcMain.handle('app-check-update', async (_event, payload) => {
  const silent = !!(payload && payload.silent);
  return checkForAppUpdates({ silent });
});

ipcMain.handle('app-download-update', async () => {
  if (!autoUpdaterRef) return { success: false, error: '自動更新尚未初始化' };
  if (!updateState.available) return { success: false, error: '目前沒有可下載的更新' };
  try {
    await autoUpdaterRef.downloadUpdate();
    return { success: true, ...updateState };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('app-install-update', async () => {
  if (!autoUpdaterRef) return { success: false, error: '自動更新尚未初始化' };
  if (!updateState.downloaded) return { success: false, error: '更新尚未下載完成' };
  try {
    isQuitting = true;
    autoUpdaterRef.quitAndInstall(false, true);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
