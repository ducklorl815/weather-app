const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, screen, Notification } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');
const updateConfig = require('./update-config');

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
const GOOGLE_CLIENT_ID = '527885749373-vkikdv228mjj95n6rsgel6nsbfvv1vpi.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
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
function gchatPacketPath() { return path.join(app.getPath('userData'), 'gchat_packet.json'); }
function gchatPrefsPath() { return path.join(app.getPath('userData'), 'gchat-prefs.json'); }
function gchatReplyBoundsPath() { return path.join(app.getPath('userData'), 'gchat-reply-bounds.json'); }

/** spaceName／messageName → { x, y, width, height } */
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
let tray = null;
let toastWin = null;
let replyPopWin = null;
let replyPopMessageName = '';
/** 精簡回覆視窗：messageName → { win, minimized, title }；minimizedReplyOrder[0] 為最右側 */
const replyPopRegistry = new Map();
const minimizedReplyOrder = [];
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
/** 展開泡泡框預設位置：底緣離開右下角縮小 bar 的額外間距 */
const REPLY_BAR_STACK_CLEARANCE = 16;

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

function broadcastAppTheme(theme = currentAppTheme) {
  const id = APP_THEME_PALETTE[theme] ? theme : 'light';
  currentAppTheme = id;
  const bg = themeCardBg(id);
  const sendAll = (targetWin) => {
    if (!targetWin || targetWin.isDestroyed()) return;
    try {
      targetWin.setBackgroundColor(bg);
      targetWin.webContents.send('app-theme', id);
    } catch (_) {}
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
let tasksService, calendarService, gmailService, peopleService, sheetsService, chatService, adminService, driveService;
let syncTimer = null;
let meetingTimer = null;
const promptedMeetings = new Set();
let meetingPromptBusy = false;
let sessionWatchTimer = null;
const sessionState = { authed: false, offline: false, lastCheck: 0, lastError: '' };

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CHAT_MESSAGES_SCOPE = 'https://www.googleapis.com/auth/chat.messages';
const CHAT_READSTATE_SCOPE = 'https://www.googleapis.com/auth/chat.users.readstate';
const CHAT_SPACES_SCOPE = 'https://www.googleapis.com/auth/chat.spaces.readonly';
const CHAT_SPACES_WRITE_SCOPE = 'https://www.googleapis.com/auth/chat.spaces';
const CHAT_MEMBERSHIPS_SCOPE = 'https://www.googleapis.com/auth/chat.memberships.readonly';
const CHAT_SPACESETTINGS_SCOPE = 'https://www.googleapis.com/auth/chat.users.spacesettings';
const CHAT_SCOPES = [
  CHAT_MESSAGES_SCOPE,
  CHAT_READSTATE_SCOPE,
  CHAT_SPACES_SCOPE,
  CHAT_SPACES_WRITE_SCOPE,
  CHAT_MEMBERSHIPS_SCOPE,
  CHAT_SPACESETTINGS_SCOPE
];

/** 登入只要身分；各功能 scopes 在加入／使用時再獨立授權 */
const GOOGLE_BASE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

const FEATURE_SCOPE_MAP = {
  calendar: ['https://www.googleapis.com/auth/calendar'],
  tasks: ['https://www.googleapis.com/auth/tasks'],
  gmail: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/contacts.other.readonly'
  ],
  gchat: [
    ...CHAT_SCOPES,
    'https://www.googleapis.com/auth/directory.readonly',
    'https://www.googleapis.com/auth/contacts.readonly'
  ],
  sheets: [SHEETS_SCOPE, DRIVE_FILE_SCOPE],
  sitesVisits: [SHEETS_SCOPE],
  chat: ['https://www.googleapis.com/auth/cloud-platform']
};

const FEATURE_LABELS = {
  calendar: '預定行程',
  tasks: '待辦事項',
  gmail: '未讀郵件',
  gchat: 'Little Reply',
  sheets: '9527',
  sitesVisits: '網站瀏覽紀錄',
  chat: '詢問機器人'
};

/** @deprecated 僅相容舊流程；登入勿再一次要全部 */
const GOOGLE_SCOPES = [
  ...GOOGLE_BASE_SCOPES,
  ...FEATURE_SCOPE_MAP.calendar,
  ...FEATURE_SCOPE_MAP.tasks,
  ...FEATURE_SCOPE_MAP.gmail,
  ...FEATURE_SCOPE_MAP.gchat,
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
  directoryError: '',
  directoryStats: { admin: 0, people: 0 },
  lastSync: 0,
  syncing: false,
  packing: false,
  /** 今天點過／回過的對話，已讀後仍留在列表追蹤 */
  todayTouched: [],
  /** 本人已加的表情：messageName → { unicode → reactionResourceName } */
  myReactions: {}
};
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
  tasksService = google.tasks({ version: 'v1', auth: oauth2Client });
  calendarService = google.calendar({ version: 'v3', auth: oauth2Client });
  gmailService = google.gmail({ version: 'v1', auth: oauth2Client });
  peopleService = google.people({ version: 'v1', auth: oauth2Client });
  sheetsService = google.sheets({ version: 'v4', auth: oauth2Client });
  driveService = google.drive({ version: 'v3', auth: oauth2Client });
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
  if (fs.existsSync(packetPath())) fs.unlinkSync(packetPath());
  gchatCache.messages = [];
  gchatCache.spaceNames = {};
  gchatCache.spaceTypes = {};
  gchatCache.userNames = {};
  gchatCache.spaceMute = {};
  gchatCache.myUserName = '';
  gchatCache.myIds = [];
  gchatCache.myLabels = [];
  gchatCache.directoryWarmed = false;
  gchatCache.directoryError = '';
  gchatCache.directoryStats = { admin: 0, people: 0 };
  gchatCache.lastSync = 0;
  gchatCache.todayTouched = [];
  gchatPending.markRead.clear();
  gchatLocallyRead.clear();
  gchatLocallyReadSpaces.clear();
  gchatCache.packets = {};
  if (fs.existsSync(gchatPacketPath())) fs.unlinkSync(gchatPacketPath());
}

function packetSnapshot(labelId = 'ALL') {
  let emails = cache.emails;
  if (labelId && labelId !== 'ALL') {
    emails = emails.filter(e => (e.labelIds || []).includes(labelId));
  }
  return {
    success: true,
    emails,
    labels: cache.labels,
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
  loadDiskPacket();
  notifyRenderer();
  if (syncTimer) clearInterval(syncTimer);
  runSync();
  syncTimer = setInterval(runSync, 30000);
  startMeetingWatch();
}

function stopSyncLoop() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  stopMeetingWatch();
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

async function checkMeetingReminders() {
  if (!calendarService || meetingPromptBusy) return;
  try {
    const calList = await calendarService.calendarList.list({ maxResults: 250 });
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
    console.error('會議提醒檢查失敗:', err.message);
  }
}

function ensureTray() {
  if (tray || process.platform === 'darwin') return;
  try {
    const iconPath = path.join(__dirname, 'icon.png');
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

function replyPopConvKey(spaceName, messageName, threadFocus = '') {
  // [Important] 專注討論串用獨立鍵（thread 資源名或訊息錨點），可與同空間一般泡泡並存
  const th = String(threadFocus || '').trim();
  if (th) return th.startsWith('focus:') ? th : `focus:${th}`;
  return String(spaceName || messageName || '').trim();
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
  return entry?.convKey || replyPopConvKey(entry?.spaceName, entry?.messageName);
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
  if (!entry?.barWin || entry.barWin.isDestroyed()) return;
  if (entry.threadFocus) refreshFocusEntryTitle(entry);
  const key = entryConvKey(entry);
  try {
    entry.barWin.webContents.send('gchat-bar-update', {
      convKey: key,
      title: entry.title || 'Little Reply',
      badge: Number(entry.unreadBadge || 0) || 0,
      bubbleOpen: !entry.minimized && !!(entry.win && !entry.win.isDestroyed() && entry.win.isVisible()),
      theme: currentAppTheme
    });
  } catch (_) {}
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
    backgroundColor: '#00000000',
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
      preload: path.join(__dirname, 'preload.js'),
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
  bar.loadFile(path.join(__dirname, 'gchat-reply-bar.html'), {
    query: { key }
  });
  bar.webContents.on('did-finish-load', () => syncReplyBarUi(entry));
  bar.on('closed', () => {
    if (entry.barWin === bar) entry.barWin = null;
  });
  return bar;
}

function rememberDockedBar(entry) {
  const key = entryConvKey(entry);
  if (!key) return;
  if (!minimizedReplyOrder.includes(key)) minimizedReplyOrder.push(key);
}

/** [Important] bar 常駐於右下角；泡泡展開時 bar 仍在 */
function positionMinimizedReplyBars() {
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
    const y = Math.round(display.y + display.height - h - REPLY_BAR_MARGIN);
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

function raiseGchatReplyAboveToast() {
  for (const entry of replyPopRegistry.values()) {
    if (!entry.win || entry.win.isDestroyed() || !entry.win.isVisible() || entry.minimized) continue;
    try {
      entry.win.setAlwaysOnTop(true, GCHAT_REPLY_Z);
      entry.win.moveTop();
      return;
    } catch (_) {}
  }
  if (replyPopWin && !replyPopWin.isDestroyed() && replyPopWin.isVisible()) {
    try {
      replyPopWin.setAlwaysOnTop(true, GCHAT_REPLY_Z);
      replyPopWin.moveTop();
    } catch (_) {}
  }
}

/** 依目前是否在回覆，調整泡泡／回覆框層級 */
function syncGchatOverlayZOrder() {
  try {
    if (toastWin && !toastWin.isDestroyed() && toastWin.isVisible()) {
      if (isReplyPopExpandedVisible()) {
        // 精簡回覆開著：泡泡仍可顯示，但層級較低
        toastWin.setAlwaysOnTop(true, GCHAT_TOAST_Z);
      } else if (gchatViewing && !isMainWindowHidden()) {
        // 主視窗訊息框開著：泡泡不要蓋住 App
        toastWin.setAlwaysOnTop(false);
      } else {
        toastWin.setAlwaysOnTop(true, GCHAT_TOAST_Z);
      }
    }
    raiseGchatReplyAboveToast();
  } catch (_) {}
}

function showToastWindowBelowReply(w) {
  if (!w || w.isDestroyed()) return;
  try {
    w.setAlwaysOnTop(true, GCHAT_TOAST_Z);
    w.show();
    if (isReplyPopExpandedVisible()) {
      raiseGchatReplyAboveToast();
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
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    focusable: true,
    show: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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
    expandedBounds: boundsKey && replyPopBoundsStore[boundsKey] ? { ...replyPopBoundsStore[boundsKey] } : null
  };
  replyPopRegistry.set(convKey, entry);
  replyPopWin = win;
  replyPopMessageName = messageName;
  try {
    win.setAlwaysOnTop(true, GCHAT_REPLY_Z);
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
    if (!entry.minimized) raiseGchatReplyAboveToast();
  });
  win.on('focus', () => {
    if (!entry.minimized) raiseGchatReplyAboveToast();
  });
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.send('app-theme', currentAppTheme); } catch (_) {}
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
    if (title && String(title).includes('★')) {
      const parts = String(title).split('★');
      entry.contactTitle = entry.contactTitle || parts[0].trim();
      if (parts[1]) entry.focusRootText = parts.slice(1).join('★').trim();
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
  return { success: true };
}

async function restoreReplyPop(messageNameOrEntry) {
  const entry = typeof messageNameOrEntry === 'object'
    ? messageNameOrEntry
    : findReplyPopEntry({ messageName: messageNameOrEntry });
  if (!entry) return { success: false };
  const restoreMode = entry.expandedDisplayMode || 'normal';
  entry.minimized = false;
  entry.unreadBadge = 0;
  seedReplyPopWatchCursor(entry);
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
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      movable: true,
      focusable: true,
      show: false,
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    entry.win = bubble;
    replyPopWin = bubble;
    replyPopMessageName = openName;
    try {
      bubble.setAlwaysOnTop(true, GCHAT_REPLY_Z);
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
    });
    try {
      const packSrc = { name: openName, spaceName: entry.spaceName };
      const prev = findReadyGchatPacket(openName, packSrc);
      if (!(prev?.historyReady)) {
        await packGchatDetailForItem(packSrc, { withHistory: true });
      }
    } catch (_) {}
    await bubble.loadFile(path.join(__dirname, 'gchat-reply-pop.html'), {
      query: {
        name: openName,
        focusThread: entry.threadFocus ? '1' : '',
        threadName: entry.threadFocus ? (entry.threadName || '') : '',
        focusRootText: entry.threadFocus ? (entry.focusRootText || '') : '',
        contactTitle: entry.threadFocus ? (entry.contactTitle || '') : '',
        rootMessageName: entry.threadFocus ? (entry.rootMessageName || '') : '',
        readUntil: entry.pendingOpenReadUntil || ''
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
    entry.win.show();
    entry.win.focus();
    entry.win.moveTop();
  } catch (_) {
    try { entry.win.show(); } catch (__) {}
  }
  if (restoreMode !== 'normal') {
    await applyReplyPopExpandedDisplayMode(entry);
  }
  try {
    if (entry.messageName) await markGchatConversationReadByName(entry.messageName);
  } catch (_) {}
  if (entry.spaceName) {
    gchatViewing = {
      spaceName: entry.spaceName,
      threadName: '',
      messageName: entry.messageName || '',
      isDm: !!entry.isDm
    };
  }
  syncReplyBarUi(entry);
  raiseGchatReplyAboveToast();
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
  minimizeOtherExpandedReplyPops(entryConvKey(entry), {
    keepSpacePeers: true,
    spaceName: entry.spaceName || ''
  });
  return restoreReplyPop(entry);
}

async function closeReplyPopCompletely(convKeyOrEntry) {
  const entry = typeof convKeyOrEntry === 'object'
    ? convKeyOrEntry
    : findReplyPopEntry({ convKey: convKeyOrEntry });
  if (!entry) return { success: false };
  const win = entry.win;
  const bar = entry.barWin;
  removeReplyPopEntry(entry);
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
  try { if (bar && !bar.isDestroyed()) bar.destroy(); } catch (_) {}
  syncGchatOverlayZOrder();
  return { success: true };
}

function minimizeOtherExpandedReplyPops(exceptConvKeyOrMessage, opts = {}) {
  const keepSpacePeers = opts.keepSpacePeers !== false; // 預設同空間一般／專注並存
  const spaceName = String(opts.spaceName || '').trim();
  for (const [key, entry] of replyPopRegistry) {
    if (key === exceptConvKeyOrMessage || entry.messageName === exceptConvKeyOrMessage) continue;
    // 同空間：王婷薇3014 與 王婷薇3014★討論串 可同時展開
    if (keepSpacePeers && spaceName && entry.spaceName === spaceName) continue;
    if (entry.minimized || !entry.win || entry.win.isDestroyed()) continue;
    if (!entry.win.isVisible()) continue;
    minimizeReplyPop(entry, entry.title).catch(() => {});
  }
}

/** 專注討論串標題：王婷薇3014★讓我們乘著陽光 */
function formatFocusThreadBarTitle(contactTitle, rootText) {
  const contact = String(contactTitle || '').trim()
    .replace(/^★\s*/, '')
    .split('★')[0]
    .trim() || '對話';
  let root = String(rootText || '').replace(/\s+/g, ' ').trim();
  // 若誤傳整段「聯絡人★根訊息」，只留 ★ 後面
  if (root.includes('★')) root = root.split('★').slice(1).join('★').trim();
  if (root.length > 28) root = `${root.slice(0, 28)}…`;
  return root ? `${contact}★${root}` : `${contact}★討論串`;
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
  if (!messageName && !opts.spaceName) return { success: false };
  const hit = messageName
    ? ((gchatCache.messages || []).find(m => m.name === messageName)
      || gchatCache.packets?.[messageName]?.detail
      || findReadyGchatPacket(messageName)?.detail
      || (gchatCache.todayTouched || []).find(m => m.name === messageName))
    : null;
  // [Important] focusThread：以討論串獨立開泡泡＋bar，不與同空間一般泡泡共用
  const openName = messageName || hit?.name || '';
  const threadName = String(
    opts.threadName || hit?.threadName || (opts.focusThread ? openName : '') || ''
  ).trim();
  const focusThread = !!(opts.focusThread && threadName);
  const spaceName = opts.spaceName || hit?.spaceName || '';
  const convKey = replyPopConvKey(spaceName, openName, focusThread ? threadName : '');

  // [Important] 專注串只依 thread／convKey 查找，禁止誤重用同空間一般泡泡
  const spaceForReadEarly = spaceName || hit?.spaceName || '';
  const readUntilBeforeOpen = spaceForReadEarly
    ? String(gchatLocallyReadSpaces.get(spaceForReadEarly) || '')
    : '';
  const existing = focusThread
    ? findReplyPopEntry({ convKey, threadName, focusOnly: true })
    : findReplyPopEntry({
      messageName: openName,
      spaceName,
      convKey
    });
  if (existing) {
    replyPopMessageName = openName || existing.messageName;
    if (existing.win && !existing.win.isDestroyed()) replyPopWin = existing.win;
    if (spaceName) existing.spaceName = spaceName;
    existing.pendingOpenReadUntil = readUntilBeforeOpen;
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
      try {
        if (existing.win && !existing.win.isDestroyed()) {
          existing.win.webContents.send('gchat-compact-load', openName);
        }
      } catch (_) {}
    }
    if (existing.minimized || !existing.win || existing.win.isDestroyed() || !existing.win.isVisible()) {
      await restoreReplyPop(existing);
    } else {
      try {
        existing.win.show();
        existing.win.focus();
        existing.win.moveTop();
      } catch (_) {}
      raiseGchatReplyAboveToast();
    }
    try {
      if (existing.win && !existing.win.isDestroyed()) {
        existing.win.webContents.send('gchat-scroll-open', { readUntil: readUntilBeforeOpen });
      }
      existing.pendingOpenReadUntil = '';
    } catch (_) {}
    if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
    return { success: true, compact: true, reused: true, focusThread };
  }

  if (!openName) return { success: false, error: '缺少訊息' };

  // 同空間一般泡泡與專注討論串並存
  minimizeOtherExpandedReplyPops(convKey, {
    keepSpacePeers: true,
    spaceName: spaceName || hit?.spaceName || ''
  });
  replyPopMessageName = openName;
  try {
    await markGchatConversationReadByName(openName);
  } catch (err) {
    console.warn('精簡回覆標已讀失敗:', err.message);
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
    const prev = findReadyGchatPacket(openName, packSrc);
    if (!(prev?.historyReady)) {
      await packGchatDetailForItem(packSrc, { withHistory: true });
    }
  } catch (_) {}

  const baseTitle = pickGchatBubbleTitle({
    isDm: !!(opts.isDm ?? hit?.isDm),
    spaceDisplayName: opts.title || hit?.spaceDisplayName || '',
    sender: hit?.sender || '',
    spaceName: spaceName || hit?.spaceName || '',
    fallback: 'Little Reply'
  });
  // 開窗時再解一次空間成員名，避免 bar 卡在「對話／私人訊息」
  if (spaceName || hit?.spaceName) {
    try {
      const meta = await ensureSpaceMeta(spaceName || hit.spaceName);
      if (meta?.label && !isWeakGchatBubbleTitle(meta.label)) {
        const resolved = pickGchatBubbleTitle({
          isDm: !!(opts.isDm ?? hit?.isDm),
          spaceDisplayName: meta.label,
          sender: hit?.sender || '',
          spaceName: spaceName || hit?.spaceName || ''
        });
        if (!isWeakGchatBubbleTitle(resolved)) {
          // mutate base via titleHint below
          opts = { ...opts, title: resolved };
        }
      }
    } catch (_) {}
  }
  const titleBase = pickGchatBubbleTitle({
    isDm: !!(opts.isDm ?? hit?.isDm),
    spaceDisplayName: opts.title || hit?.spaceDisplayName || '',
    sender: hit?.sender || '',
    spaceName: spaceName || hit?.spaceName || '',
    fallback: baseTitle
  });
  const focusRootText = String(opts.focusRootText || opts.rootText || hit?.text || hit?.snippet || '')
    .replace(/\s+/g, ' ')
    .trim();
  const rootMessageName = String(opts.rootMessageName || (focusThread ? openName : '') || '').trim();
  // [Important] 專注串標題：王婷薇3014★讓我們乘著陽光
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
  entry.title = titleHint;
  entry.threadFocus = focusThread;
  entry.threadName = focusThread ? threadName : (threadName || '');
  entry.contactTitle = titleBase;
  entry.focusRootText = focusRootText;
  entry.rootMessageName = rootMessageName;
  entry.pendingOpenReadUntil = readUntilBeforeOpen;
  if (focusThread) refreshFocusEntryTitle(entry);
  if (focusThread && /\/threads\//.test(threadName)) {
    entry.apiThreadName = threadName.replace(/^focus:/, '');
  } else if (focusThread && hit?.threadName && /\/threads\//.test(hit.threadName)) {
    entry.apiThreadName = hit.threadName;
  }
  const w = entry.win;
  positionReplyPopExpanded(w, entry);
  await w.loadFile(path.join(__dirname, 'gchat-reply-pop.html'), {
    query: {
      name: openName,
      focusThread: focusThread ? '1' : '',
      threadName: focusThread ? threadName : '',
      focusRootText: focusThread ? focusRootText : '',
      contactTitle: focusThread ? titleBase : '',
      rootMessageName: focusThread ? rootMessageName : '',
      readUntil: readUntilBeforeOpen || ''
    }
  });
  entry.pendingOpenReadUntil = '';
  try {
    w.setAlwaysOnTop(true, GCHAT_REPLY_Z);
    w.show();
    w.focus();
    w.moveTop();
    syncGchatOverlayZOrder();
  } catch (_) {
    w.show();
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  try {
    toastWin.setAlwaysOnTop(true, GCHAT_TOAST_Z);
    toastWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (_) {}
  toastWin.loadFile(path.join(__dirname, 'gchat-toast.html'));
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
    notifyOpenGchatThread(message);
    syncReplyBarUi(entry);
    return;
  }
  if (titleHint && !entry.threadFocus) {
    if (!isWeakGchatBubbleTitle(titleHint) || isWeakGchatBubbleTitle(entry.title)) {
      entry.title = titleHint;
    }
  }
  if (message?.name && !entry.threadFocus) entry.messageName = message.name;
  if (message?.isDm != null) entry.isDm = !!message.isDm;
  entry.unreadBadge = (Number(entry.unreadBadge) || 0) + 1;
  entry.minimized = true;
  const msgTime = String(message?.createTime || '');
  if (msgTime && (!entry.lastSeenCreateTime || msgTime > String(entry.lastSeenCreateTime))) {
    entry.lastSeenCreateTime = msgTime;
  }
  entry.watchSeeded = true;
  ensureReplyBarWindow(entry);
  rememberDockedBar(entry);
  syncReplyBarUi(entry);
}

async function showFloatingGchatToast(message) {
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
    notifyOpenGchatThread(message);
    return { success: true, skipped: true };
  }
  if (shouldSuppressGchatToast(message) && !spaceEntry && !focusHits.length) {
    if (isViewingGchatMessage(message)) {
      notifyOpenGchatThread(message);
      return { success: true, skipped: true };
    }
  }

  const titleHint = await resolveAlertDisplayTitle(message);
  const mainHidden = !win || win.isDestroyed() || !win.isVisible();
  if (mainHidden) flashGchatNativeNotification(message);

  // [Important] 主聯絡人 bar：串內／串外未讀都算在這人身上
  if (!spaceEntry) {
    spaceEntry = {
      win: null,
      barWin: null,
      minimized: true,
      unreadBadge: 0,
      expandedDisplayMode: 'normal',
      title: titleHint,
      isDm: !!message.isDm,
      messageName: openName,
      spaceName,
      convKey,
      expandedBounds: null,
      threadFocus: false
    };
    replyPopRegistry.set(convKey, spaceEntry);
  }
  await bumpReplyPopUnread(spaceEntry, message, titleHint);

  // [Important] 專注討論串 bar：只有「屬於該回覆串」的訊息才累加
  for (const fe of focusHits) {
    await bumpReplyPopUnread(fe, message, '');
  }

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

function createWindow () {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    title: APP_DISPLAY_NAME, autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.setTitle(APP_DISPLAY_NAME);
  win.loadFile(path.join(__dirname, 'index.html'));
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

ipcMain.handle('gchat-show-toast', async (_event, message) => showFloatingGchatToast(message));

ipcMain.handle('gchat-toast-hide', async () => {
  if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
  return { success: true };
});

ipcMain.handle('gchat-toast-resize', async (_event, height) => {
  positionToastWindow(Number(height) || 160);
  return { success: true };
});

ipcMain.handle('gchat-toast-open', async (_event, messageName) => {
  if (!messageName) return { success: false };
  if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
  try {
    await markGchatConversationReadByName(messageName);
  } catch (err) {
    console.warn('泡泡開啟標已讀失敗:', err.message);
  }
  // [Important] 一律開泡泡訊息框（可最小化），不再改開主視窗 modal
  return openCompactGchatReply(messageName);
});

ipcMain.handle('gchat-compact-open', async (_event, payload) => {
  const messageName = typeof payload === 'string' ? payload : (payload?.messageName || payload?.name || '');
  const spaceName = typeof payload === 'object' ? (payload?.spaceName || '') : '';
  if (!messageName && !spaceName) return { success: false };
  if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
  if (messageName) {
    try { await markGchatConversationReadByName(messageName); } catch (_) {}
  }
  return openCompactGchatReply(messageName, {
    spaceName,
    title: typeof payload === 'object' ? (payload?.title || '') : '',
    isDm: typeof payload === 'object' ? !!payload?.isDm : undefined,
    threadName: typeof payload === 'object' ? (payload?.threadName || '') : '',
    focusThread: typeof payload === 'object' ? !!payload?.focusThread : false,
    focusRootText: typeof payload === 'object' ? (payload?.focusRootText || payload?.rootText || '') : '',
    rootMessageName: typeof payload === 'object' ? (payload?.rootMessageName || '') : ''
  });
});

ipcMain.handle('gchat-compact-close', async (event, messageName) => {
  const fromWin = BrowserWindow.fromWebContents(event.sender);
  const entry = findReplyPopEntry({
    win: fromWin,
    messageName: messageName || '',
    spaceName: ''
  }) || (messageName ? getReplyPopEntry(messageName) : null)
    || (replyPopMessageName ? getReplyPopEntry(replyPopMessageName) : null);
  // ✕ 關閉＝整組關掉（泡泡＋bar）
  if (entry) {
    await closeReplyPopCompletely(entry);
  } else if (fromWin && !fromWin.isDestroyed() && fromWin !== win) {
    fromWin.close();
  }
  const closedName = entry?.messageName || messageName || '';
  if (!closedName || gchatViewing?.messageName === closedName
    || (entry?.spaceName && gchatViewing?.spaceName === entry.spaceName)) {
    gchatViewing = null;
    stopViewingRefreshWatch();
  }
  syncGchatOverlayZOrder();
  return { success: true };
});

ipcMain.handle('gchat-bar-click', async (_event, convKey) => {
  return toggleReplyPopFromBar(String(convKey || ''));
});

ipcMain.handle('gchat-bar-close', async (_event, convKey) => {
  return closeReplyPopCompletely(String(convKey || ''));
});

ipcMain.handle('gchat-bar-state', async (_event, convKey) => {
  const entry = findReplyPopEntry({ convKey: String(convKey || '') });
  if (!entry) return null;
  return {
    convKey: entryConvKey(entry),
    title: entry.title || 'Little Reply',
    badge: Number(entry.unreadBadge || 0) || 0,
    bubbleOpen: !entry.minimized && !!(entry.win && !entry.win.isDestroyed() && entry.win.isVisible()),
    theme: currentAppTheme
  };
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

ipcMain.handle('gchat-compact-minimize', async (event, payload) => {
  const fromWin = BrowserWindow.fromWebContents(event.sender);
  const messageName = payload?.messageName || '';
  const entry = findReplyPopEntry({
    win: fromWin,
    messageName,
    spaceName: payload?.spaceName || ''
  }) || (messageName ? getReplyPopEntry(messageName) : null)
    || (replyPopMessageName ? getReplyPopEntry(replyPopMessageName) : null);
  if (!entry) return { success: false, error: '找不到回覆窗' };
  if (payload?.isDm != null) entry.isDm = !!payload.isDm;
  return minimizeReplyPop(entry, payload?.title || entry.title || '');
});

ipcMain.handle('gchat-compact-restore', async (event, messageName) => {
  const fromWin = BrowserWindow.fromWebContents(event.sender);
  const entry = findReplyPopEntry({
    win: fromWin,
    messageName: messageName || '',
    spaceName: ''
  }) || (messageName ? getReplyPopEntry(messageName) : null)
    || (replyPopMessageName ? getReplyPopEntry(replyPopMessageName) : null);
  if (!entry) return { success: false };
  minimizeOtherExpandedReplyPops(entryConvKey(entry));
  replyPopMessageName = entry.messageName;
  replyPopWin = entry.win;
  return restoreReplyPop(entry);
});

ipcMain.handle('gchat-compact-toggle-fullscreen', async (event) => {
  const fromWin = BrowserWindow.fromWebContents(event.sender);
  const entry = findReplyPopEntry({ win: fromWin });
  if (!entry) return { success: false, error: '找不到回覆窗' };
  return toggleReplyPopFullscreen(entry);
});

ipcMain.handle('gchat-compact-set-title', async (event, payload) => {
  const fromWin = BrowserWindow.fromWebContents(event.sender);
  const messageName = payload?.messageName || replyPopMessageName;
  const entry = findReplyPopEntry({
    win: fromWin,
    messageName,
    spaceName: '' // 只用 win 對應，避免誤改同空間一般泡泡標題
  }) || findReplyPopEntry({ win: fromWin });
  if (entry && payload?.title) {
    entry.isDm = !!payload.isDm;
    const rawTitle = String(payload.title || '').trim();
    // 專注串：一律重建「聯絡人★根訊息」
    if (entry.threadFocus) {
      if (payload.focusRootText) entry.focusRootText = String(payload.focusRootText).trim();
      if (payload.contactTitle) entry.contactTitle = String(payload.contactTitle).trim();
      if (rawTitle.includes('★')) {
        const parts = rawTitle.split('★');
        if (parts[0].trim()) entry.contactTitle = parts[0].trim();
        if (parts.slice(1).join('★').trim()) {
          entry.focusRootText = parts.slice(1).join('★').trim();
        }
      } else if (!entry.contactTitle) {
        entry.contactTitle = rawTitle;
      }
      refreshFocusEntryTitle(entry);
      syncReplyBarUi(entry);
      return { success: true };
    }
    const body = rawTitle.includes('★') ? rawTitle.split('★')[0].trim() : rawTitle.replace(/^★\s*/, '');
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
});

ipcMain.handle('gchat-compact-open-main', async (event, messageName) => {
  const fromWin = BrowserWindow.fromWebContents(event.sender);
  const entry = findReplyPopEntry({
    win: fromWin,
    messageName: messageName || '',
    spaceName: ''
  }) || (messageName ? getReplyPopEntry(messageName) : null);
  const name = entry?.messageName || messageName || replyPopMessageName;
  if (entry && entry.win && !entry.win.isDestroyed() && !entry.minimized) {
    await minimizeReplyPop(entry, entry.title);
  }
  if (!win || win.isDestroyed()) return { success: false };
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // 只顯示主視窗列表，不要再重複開同一個泡泡框
  syncGchatOverlayZOrder();
  return { success: true };
});

let mainGchatAlertTimer = null;
let mainGchatAlertSeeded = false;
let mainGchatAlertBusy = false;
const mainGchatAlerted = new Set();
/** trackKey → 上次提醒時的 createTime；僅更新訊息才重跳泡泡 */
const mainGchatAlertedAt = new Map();
/** 前端目前正在看的對話（開著 modal 時不要彈 toast） */
let gchatViewing = null;
/** 剛回覆過的空間：短暫抑制 toast，避免自己回話又跳提醒 */
const recentReplySpaces = new Map();
/** 開著回覆時較密集催促前端更新對話 */
let viewingRefreshTimer = null;

function stopViewingRefreshWatch() {
  if (viewingRefreshTimer) {
    clearInterval(viewingRefreshTimer);
    viewingRefreshTimer = null;
  }
}

function startViewingRefreshWatch() {
  stopViewingRefreshWatch();
  viewingRefreshTimer = setInterval(() => {
    if (!gchatViewing?.spaceName) {
      stopViewingRefreshWatch();
      return;
    }
    pingViewingGchatThread();
  }, 3000);
}

function stopMainGchatAlertWatch() {
  if (mainGchatAlertTimer) {
    clearInterval(mainGchatAlertTimer);
    mainGchatAlertTimer = null;
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
  const candidates = [spaceDisplayName, sender, cached, fallback];
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
    return {
      ...m,
      isMine,
      sender: isMine ? '我' : m?.sender,
      quoted
    };
  });
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
  // 泡泡正展開才壓提醒；最小化 bar 要繼續累加紅點
  if (bubbleOpen && isViewingGchatMessage(m)) return true;
  if (!entry && isViewingGchatMessage(m)) return true;
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
 * [Important] 每約 10 秒：對已存在的最小化 bar，直接查該空間最新訊息並累加未讀數字；
 * 不依賴「未讀／@我」列表，群組討論串回覆也能更新。
 */
async function syncRegistryReplyPopBadges() {
  if (!oauth2Client || !chatService) return;
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
        const res = await withTransientRetry(() => chatService.spaces.messages.list({
          parent: entry.spaceName,
          pageSize: 3,
          orderBy: 'createTime desc'
        }));
        const newest = (res.data.messages || [])[0];
        if (newest?.createTime) seedReplyPopWatchCursor(entry, newest.createTime);
      } catch (_) {}
      continue;
    }

    try {
      const res = await withTransientRetry(() => chatService.spaces.messages.list({
        parent: entry.spaceName,
        pageSize: 12,
        orderBy: 'createTime desc'
      }));
      let msgs = res.data.messages || [];
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
      for (const m of msgs) {
        const ct = String(m?.createTime || '');
        if (!ct || ct <= lastSeen) break;
        if (isOwnChatApiRawMessage(m)) continue;
        fresh.push(m);
      }
      if (!fresh.length) {
        if (newestTime > lastSeen) entry.lastSeenCreateTime = newestTime;
        continue;
      }

      entry.unreadBadge = (Number(entry.unreadBadge) || 0) + fresh.length;
      entry.lastSeenCreateTime = String(fresh[0].createTime || newestTime);
      entry.watchSeeded = true;
      entry.minimized = true;
      if (fresh[0]?.name && !entry.threadFocus) entry.messageName = fresh[0].name;
      const senderName = fresh[0]?.sender?.displayName || '';
      if (!entry.threadFocus) {
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
      notifyOpenGchatThread({
        spaceName: entry.spaceName,
        threadName: entry.threadName || '',
        name: fresh[0]?.name || entry.messageName,
        isDm: !!entry.isDm
      });
    } catch (err) {
      logGchatApiIssue('最小化 bar 未讀同步', err);
    }
  }
}

function notifyOpenGchatThread(message) {
  const payload = {
    spaceName: message?.spaceName || '',
    threadName: message?.threadName || '',
    messageName: message?.name || '',
    isDm: !!message?.isDm
  };
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('gchat-thread-ping', payload);
    }
  } catch (_) {}
  // 精簡回覆窗也要即時更新，不然開著回覆時對方新訊息不會進來
  try {
    for (const entry of replyPopRegistry.values()) {
      if (!entry.win || entry.win.isDestroyed() || !entry.win.isVisible()) continue;
      entry.win.webContents.send('gchat-thread-ping', payload);
    }
    if (replyPopWin && !replyPopWin.isDestroyed() && replyPopWin.isVisible()) {
      replyPopWin.webContents.send('gchat-thread-ping', payload);
    }
  } catch (_) {}
}

/** 回覆視窗開著時主動催促前端刷新對話（不等泡泡） */
function pingViewingGchatThread() {
  if (!gchatViewing?.spaceName) return;
  notifyOpenGchatThread({
    spaceName: gchatViewing.spaceName,
    threadName: gchatViewing.threadName || '',
    name: gchatViewing.messageName || '',
    isDm: !!gchatViewing.isDm
  });
}

function broadcastGchatListUpdate() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('gchat-list-updated', gchatSnapshot());
  } catch (_) {}
}

async function notifyNewGchatAlerts() {
  if (loadGchatPrefs().alertPopup === false) return;
  const messages = (gchatSnapshot().messages || []).filter(m => m?.name && !m.isRead && (m.isDm || m.mentionedMe));
  if (!mainGchatAlertSeeded) {
    // [Important] 以對話（空間）為單位記住；啟動時只種子、不重跳既有未讀
    messages.forEach(m => {
      const key = gchatTrackKey(m) || m.name;
      if (!key) return;
      mainGchatAlerted.add(key);
      mainGchatAlertedAt.set(key, String(m.createTime || ''));
    });
    mainGchatAlertSeeded = true;
    return;
  }
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

  // 泡泡跳出前先打包歷史（私人＋群組 @ 都一樣），點開才能秒回
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
      if (isViewingGchatMessage(m)) notifyOpenGchatThread(m);
      continue;
    }
    showFloatingGchatToast(m);
  }
}

function startMainGchatAlertWatch() {
  stopMainGchatAlertWatch();
  // [Important] 無論是否勾選彈跳提醒，都要 10 秒輪詢以更新最小化 bar 未讀

  const tick = async () => {
    if (!oauth2Client || !chatService) return;
    if (mainGchatAlertBusy) return;
    mainGchatAlertBusy = true;
    try {
      let wait = 0;
      while (gchatCache.syncing && wait < 24) {
        await new Promise(r => setTimeout(r, 500));
        wait += 1;
      }
      const wantToast = loadGchatPrefs().alertPopup !== false;
      if (wantToast) {
        if (!gchatCache.syncing) {
          gchatCache.syncing = true;
          try {
            await refreshGchatList();
          } finally {
            gchatCache.syncing = false;
          }
        } else {
          await notifyNewGchatAlerts();
        }
        await notifyNewGchatAlerts();
      }
      // 已存在／最小化的聯絡人 bar：直接查空間最新訊息累加 1,2,3…
      await syncRegistryReplyPopBadges();
      // 開著回覆／訊息框：定期催促即時更新對方訊息
      if (gchatViewing?.spaceName) pingViewingGchatThread();
      if (win && !win.isDestroyed()) {
        win.webContents.send('gchat-list-updated', gchatSnapshot());
      }
    } catch (err) {
      gchatCache.syncing = false;
      logGchatApiIssue('背景提醒失敗', err);
    } finally {
      mainGchatAlertBusy = false;
    }
  };

  tick();
  mainGchatAlertTimer = setInterval(tick, 10000);
}

ipcMain.handle('gchat-set-viewing', async (_event, ctx) => {
  if (!ctx || !ctx.spaceName) {
    gchatViewing = null;
    stopViewingRefreshWatch();
  } else {
    gchatViewing = {
      spaceName: String(ctx.spaceName || ''),
      threadName: String(ctx.threadName || ''),
      messageName: String(ctx.messageName || ''),
      isDm: !!ctx.isDm
    };
    startViewingRefreshWatch();
    // 剛打開就催一次，對方新訊息較快進來
    setTimeout(() => pingViewingGchatThread(), 400);
  }
  syncGchatOverlayZOrder();
  return { success: true, viewing: gchatViewing };
});

ipcMain.handle('gchat-alert-watch', async (_event, enabled) => {
  if (enabled) {
    mainGchatAlertSeeded = false;
    mainGchatAlerted.clear();
    mainGchatAlertedAt.clear();
  } else if (toastWin && !toastWin.isDestroyed()) {
    toastWin.hide();
  }
  // 關閉彈跳提醒時仍保留 bar 未讀輪詢
  startMainGchatAlertWatch();
  return { success: true, enabled: !!enabled };
});

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
  const unpacked = path.join(__dirname, 'dist', 'win-unpacked', 'LifeTour.exe');
  if (fs.existsSync(unpacked)) return `"${unpacked}"`;
  return `"${process.execPath}" "${path.resolve(__dirname)}"`;
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
    opts.args = [path.resolve(__dirname)];
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

// 💡 新增：清除 Token 並重新啟動 APP
ipcMain.on('logout', () => {
  stopSyncLoop();
  stopSessionWatch();
  clearPacket();
  // 登出時清掉授權與 Chat 暫存，下次視為全新授權
  try { if (fs.existsSync(tokenPath())) fs.unlinkSync(tokenPath()); } catch (_) {}
  try { if (fs.existsSync(gchatPacketPath())) fs.unlinkSync(gchatPacketPath()); } catch (_) {}
  app.relaunch();
  app.exit();
});

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

function broadcastSessionStatus() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('session-status', {
      authed: sessionState.authed,
      offline: sessionState.offline,
      lastCheck: sessionState.lastCheck,
      error: sessionState.lastError
    });
  }
}

/**
 * 確保 Google 授權可用；離線時保留 Token，不視為登出。
 * @returns {{ success?: boolean, offline?: boolean, needsAuth?: boolean, restored?: boolean, error?: string }}
 */
async function ensureGoogleSession({ silent = false } = {}) {
  const tokens = readTokensFromDisk();
  if (!tokens) {
    sessionState.authed = false;
    sessionState.offline = false;
    sessionState.lastCheck = Date.now();
    sessionState.lastError = '';
    return { success: false, needsAuth: true };
  }

  const google = getGoogle();
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    oauth2Client.setCredentials(tokens);
    bindOAuthTokenPersistence(oauth2Client);
  }

  try {
    const tok = await oauth2Client.getAccessToken();
    if (!tok?.token) throw new Error('no access token');
    persistOAuthTokens(oauth2Client.credentials || tokens);

    const wasDown = !oauth2Client || !sessionState.authed;
    if (!gmailService) initGoogleServices();
    // 有 Gmail 權限才跑郵件同步；沒有也不影響已登入
    try {
      const scope = await grantedScopeText();
      if (scopeListHas(scope, FEATURE_SCOPE_MAP.gmail) && !syncTimer) startSyncLoop();
    } catch (_) {
      if (!syncTimer) startSyncLoop();
    }

    sessionState.authed = true;
    sessionState.offline = false;
    sessionState.lastCheck = Date.now();
    sessionState.lastError = '';
    return { success: true, restored: wasDown };
  } catch (err) {
    sessionState.lastCheck = Date.now();
    sessionState.lastError = err.message || String(err);

    if (isNetworkAuthError(err)) {
      sessionState.authed = true;
      sessionState.offline = true;
      if (!gmailService) initGoogleServices();
      if (!silent) console.warn('[Session] 離線中，保留授權:', sessionState.lastError);
      return { success: false, offline: true, error: '目前離線，授權仍保留' };
    }

    if (isHardAuthError(err)) {
      if (!silent) console.warn('登入 Token 失效，需重新授權:', sessionState.lastError);
      try { fs.unlinkSync(tokenPath()); } catch (_) {}
      oauth2Client = null;
      stopSyncLoop();
      sessionState.authed = false;
      sessionState.offline = false;
      return { success: false, needsAuth: true, error: '授權已失效，請重新登入' };
    }

    // 未知錯誤：保守保留 Token，視為暫時離線
    sessionState.authed = true;
    sessionState.offline = true;
    if (!gmailService) initGoogleServices();
    if (!silent) console.warn('[Session] 暫時無法驗證，保留授權:', sessionState.lastError);
    return { success: false, offline: true, error: sessionState.lastError };
  }
}

async function requireGoogleSession() {
  if (oauth2Client) {
    return { ok: true, offline: sessionState.offline };
  }
  const res = await ensureGoogleSession({ silent: true });
  if (res.success) return { ok: true };
  if (res.offline) return { ok: true, offline: true };
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
        win.webContents.send('gchat-list-updated', gchatSnapshot());
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

ipcMain.handle('check-login', async () => {
  try {
    const tokens = readTokensFromDisk();
    if (!tokens) {
      return { success: false, needsAuth: true };
    }
    const res = await ensureGoogleSession();
    if (res.success) {
      broadcastSessionStatus();
      return { success: true };
    }
    if (res.offline) {
      broadcastSessionStatus();
      return { success: false, offline: true, hasTokens: true, error: res.error };
    }
    broadcastSessionStatus();
    return { success: false, needsAuth: true, error: res.error };
  } catch (error) {
    return { success: false, needsAuth: true, error: error.message };
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
  if (!merged.refresh_token && prev?.refresh_token) merged.refresh_token = prev.refresh_token;
  const scopes = new Set(
    `${prev?.scope || ''} ${next?.scope || ''}`.split(/[,\s]+/).filter(Boolean)
  );
  if (scopes.size) merged.scope = [...scopes].join(' ');
  return merged;
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
  const s = String(scopeText || '');
  return hasChatMessagesScope(s)
    && hasChatReadStateScope(s)
    && /chat\.users\.spacesettings/.test(s);
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
  if (!needed.length) return { success: true, type, authorized: true, label: FEATURE_LABELS[type] || type };
  if (!oauth2Client && !readTokensFromDisk()) {
    return { success: true, type, authorized: false, needsLogin: true, label: FEATURE_LABELS[type] || type, scopes: needed };
  }
  const scope = await grantedScopeText();
  const authorized = scopeListHas(scope, needed);
  return {
    success: true,
    type,
    authorized,
    needsAuth: !authorized,
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
    if (access) {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(access)}`);
      const data = await res.json();
      if (data.scope) return data.scope;
    }
  } catch (_) {}
  return saved.scope || oauth2Client?.credentials?.scope || readTokensFromDisk()?.scope || '';
}

function runGoogleOAuth(scopes, {
  forceConsent,
  includeGrantedScopes = true,
  allowOnlyBase = false
} = {}) {
  const hadRefresh = !!readTokensFromDisk()?.refresh_token;
  // [Important] 已有 refresh_token 時不要每次 consent，否則開機像要重新授權
  const useConsent = forceConsent === true || (forceConsent !== false && !hadRefresh);
  let scopeList = [...new Set((scopes || []).map(s => String(s || '').trim()).filter(Boolean))];
  // [Important] 登入只允許身分 scope，避免誤傳功能權限
  if (allowOnlyBase) {
    const baseSet = new Set(GOOGLE_BASE_SCOPES);
    scopeList = scopeList.filter(s => baseSet.has(s));
    if (!scopeList.length) scopeList = [...GOOGLE_BASE_SCOPES];
  }
  return new Promise((resolve) => {
    const google = getGoogle();
    const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: useConsent ? 'consent' : 'select_account',
      // 登入：false（同意畫面只顯示身分）；功能增量：true（保留既有權限、只新求缺的）
      include_granted_scopes: includeGrantedScopes !== false,
      scope: scopeList
    });
    console.log('[OAuth] 請求 scopes:', scopeList.join(' | '), '| include_granted=', includeGrantedScopes !== false, '| consent=', useConsent);
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/oauth2callback')) return;
      const q = new URL(req.url, 'http://localhost:3000').searchParams;
      const denied = q.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (denied) {
        res.end('<h1>授權取消</h1><p>請回到 APP 再試一次。</p>');
        server.close();
        resolve({ success: false, error: '授權被取消' });
        return;
      }
      res.end('<h1>授權成功！</h1><p>請關閉網頁，回到 APP。</p><script>window.close()</script>');
      server.close();
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
          // [Important] 首次安裝：乾淨寫入，不合併任何舊檔
          merged = { ...tokens };
        }
        if (!merged.refresh_token && tokens.refresh_token) merged.refresh_token = tokens.refresh_token;
        oauth2Client = client;
        oauth2Client.setCredentials(merged);
        bindOAuthTokenPersistence(oauth2Client);
        fs.writeFileSync(tokenPath(), JSON.stringify(merged));
        initGoogleServices();
        try {
          const sc = merged.scope || tokens.scope || '';
          if (scopeListHas(sc, FEATURE_SCOPE_MAP.gmail)) startSyncLoop();
        } catch (_) {}
        sessionState.authed = true;
        sessionState.offline = false;
        resolve({ success: true, scope: merged.scope || tokens.scope || '', firstAuth: !hadPrev });
      } catch (err) {
        resolve({ success: false, error: err.message || '授權換取 Token 失敗' });
      }
    });
    server.on('error', (err) => {
      resolve({
        success: false,
        error: err.code === 'EADDRINUSE'
          ? '授權埠 3000 被占用。請關閉其他授權視窗或占用該埠的程式後再試。'
          : err.message
      });
    });
    server.listen(3000, '127.0.0.1', () => { shell.openExternal(authUrl); });
  });
}

ipcMain.handle('auth-google', async () => {
  try {
    // [Important] 登入只要身分；同意畫面不可出現日曆／郵件／Chat 等功能權限
    return await runGoogleOAuth(GOOGLE_BASE_SCOPES, {
      forceConsent: false,
      includeGrantedScopes: false,
      allowOnlyBase: true
    });
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('auth-google-feature', async (_event, type) => {
  try {
    const feature = String(type || '');
    const needed = featureScopes(feature);
    if (!needed.length) return { success: false, error: '未知功能' };
    const current = await grantedScopeText();
    // [Important] 只請求「尚未有」的 scope，同意畫面才不會列出全部功能
    const missing = needed.filter((s) => !scopeListHas(current, [s]));
    if (!missing.length) {
      return { success: true, type: feature, authorized: true, label: FEATURE_LABELS[feature] || feature };
    }
    const result = await runGoogleOAuth(missing, {
      forceConsent: true,
      includeGrantedScopes: true
    });
    if (!result.success) return result;
    const scope = await grantedScopeText();
    const authorized = scopeListHas(scope, needed) || scopeListHas(result.scope, needed);
    if (!authorized) {
      return {
        success: false,
        needsAuth: true,
        error: `尚未取得「${FEATURE_LABELS[feature] || feature}」所需權限，請在授權頁勾選允許。`
      };
    }
    return { success: true, type: feature, authorized: true, label: FEATURE_LABELS[feature] || feature };
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
    const needed = FEATURE_SCOPE_MAP.sheets;
    const current = await grantedScopeText();
    const missing = needed.filter((s) => !scopeListHas(current, [s]));
    if (!missing.length) return { success: true };
    const result = await runGoogleOAuth(missing, { forceConsent: true, includeGrantedScopes: true });
    if (!result.success) return result;
    const scope = await grantedScopeText();
    if (!hasSheetsScope(scope) && !hasSheetsScope(result.scope)) {
      return {
        success: false,
        needsApi: true,
        error: 'Google 沒有核發試算表權限。請到 Google Cloud 啟用 Google Sheets API，並在「OAuth 同意畫面」加入試算表範圍後再授權。'
      };
    }
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('auth-google-chat', async () => {
  try {
    const needed = FEATURE_SCOPE_MAP.gchat;
    const current = await grantedScopeText();
    const missing = needed.filter((s) => !scopeListHas(current, [s]));
    if (!missing.length) {
      startMainGchatAlertWatch();
      return { success: true };
    }
    const result = await runGoogleOAuth(missing, { forceConsent: true, includeGrantedScopes: true });
    if (!result.success) return result;
    const scope = await grantedScopeText();
    if (!hasChatScopes(scope) && !hasChatScopes(result.scope)) {
      return {
        success: false,
        needsApi: true,
        setupUrl: chatApiEnableUrl(),
        error: 'Google 沒有核發 Chat 權限。請到 Google Cloud 啟用 Google Chat API，並在「OAuth 同意畫面」加入 Chat 範圍後再授權。'
      };
    }
    startMainGchatAlertWatch();
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
      if (!isTransientGoogleError(err) || i === tries - 1) throw err;
      await new Promise(r => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw lastErr;
}

function logGchatApiIssue(kind, err) {
  const msg = googleErrText(err);
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
      needsReauth: true,
      error: '目前登入權限不足（試算表或雲端硬碟）。請重新授權 Google。'
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
    return { needsReauth: true, error: '登入已過期，將重新授權 Google 試算表。' };
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
  const meta = await sheetsService.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties'
  });
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
  const res = await sheetsService.spreadsheets.values.batchGet({
    spreadsheetId: source.spreadsheetId,
    ranges,
    majorDimension: 'ROWS',
    valueRenderOption: 'FORMATTED_VALUE'
  });
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
  { type: 'tasks', label: '待辦事項' },
  { type: 'gmail', label: '未讀郵件' },
  { type: 'gchat', label: 'Little Reply' },
  { type: 'sheets', label: '9527' },
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
    err.needsReauth = true;
    throw err;
  }
  const meta = await sheetsService.spreadsheets.get({
    spreadsheetId: BUG_REPORT_SPREADSHEET_ID,
    fields: 'spreadsheetId,sheets(properties(sheetId,title))'
  });
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
    if (explained.needsApi || explained.needsReauth) {
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
    const err = new Error('需要雲端硬碟權限才能上傳截圖，請重新授權 Google');
    err.needsReauth = true;
    throw err;
  }
  const mime = String(img?.mimeType || 'image/png').split(';')[0] || 'image/png';
  const raw = String(img?.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('圖片資料無效');
  if (buf.length > 8 * 1024 * 1024) throw new Error('單張圖片請小於 8MB');
  const safeName = String(img?.name || `lifetour-bug-${Date.now()}.png`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const created = await driveService.files.create({
    requestBody: { name: safeName, mimeType: mime },
    media: { mimeType: mime, body: Readable.from(buf) },
    fields: 'id'
  });
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
        needsReauth: true,
        error: needDrive
          ? '尚未授權「試算表 + 雲端硬碟」權限（上傳截圖需要）。請重新授權後再送出。'
          : '尚未授權 Google 試算表權限。請重新授權後再送出。'
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
    try { appVersion = String(app.getVersion?.() || require('./package.json').version || '1.0.0'); } catch (_) {}

    const imageFormulas = ['', '', ''];
    for (let i = 0; i < images.length; i++) {
      try {
        const url = await uploadBugReportImage(images[i], email);
        // Sheets 以 IMAGE 公式顯示圖片
        imageFormulas[i] = `=IMAGE("${url}")`;
      } catch (upErr) {
        if (upErr?.needsReauth) throw upErr;
        throw Object.assign(upErr instanceof Error ? upErr : new Error(googleErrText(upErr)), explainSheetsError(upErr));
      }
    }

    const featureCol = category === 'Bug' ? feature : '';
    await sheetsService.spreadsheets.values.append({
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
    });

    return { success: true };
  } catch (err) {
    if (err?.needsReauth) {
      return {
        success: false,
        needsReauth: true,
        error: err.message || '需要重新授權 Google（含雲端硬碟）才能上傳截圖'
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
      await sheetsService.spreadsheets.get({
        spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        fields: 'spreadsheetId'
      });
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
      needsReauth: !hasScope,
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
const DIST_WIDGET_KEYS = ['calendar', 'tasks', 'gmail', 'gchat', 'sheets', 'sitesVisits', 'chat'];

function distFeaturesPath() {
  return path.join(__dirname, 'dist-features.json');
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
        needsReauth: true,
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
      if (explained.needsReauth || explained.needsApi) {
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

// --- Google Sites 瀏覽紀錄（Site ID 設定 → 資訊寫入本機 App） ---
function sitesVisitsConfigPath() {
  return path.join(app.getPath('userData'), 'sites-visits.json');
}
function sitesVisitsStorePath() {
  return path.join(app.getPath('userData'), 'sites-visits-store.json');
}

const SITES_VISITS_HEADERS = ['時間', '同仁', '專案', '網站', '秒數', 'SiteID', '點擊數', '超連結數'];

function loadSitesVisitsConfig() {
  try {
    if (fs.existsSync(sitesVisitsConfigPath())) {
      const data = JSON.parse(fs.readFileSync(sitesVisitsConfigPath(), 'utf8'));
      return {
        logSpreadsheetId: String(data.logSpreadsheetId || ''),
        logSheetName: String(data.logSheetName || '瀏覽紀錄'),
        deployWebAppUrl: String(data.deployWebAppUrl || ''),
        projects: Array.isArray(data.projects) ? data.projects : []
      };
    }
  } catch (_) {}
  return { logSpreadsheetId: '', logSheetName: '瀏覽紀錄', deployWebAppUrl: '', projects: [] };
}

function saveSitesVisitsConfig(cfg) {
  fs.writeFileSync(sitesVisitsConfigPath(), JSON.stringify({
    logSpreadsheetId: cfg.logSpreadsheetId || '',
    logSheetName: cfg.logSheetName || '瀏覽紀錄',
    deployWebAppUrl: cfg.deployWebAppUrl || '',
    projects: cfg.projects || []
  }, null, 2));
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
 * ★ 若同仁看到「LOG_SHEET_ID 未設定」：把下面這行改成 LifeTour 設定頁顯示的試算表 ID
 */
var LOG_SHEET_ID = '${sheetId}';
var LOG_SHEET_NAME = '瀏覽紀錄';
var PROJECTS = ${JSON.stringify(list, null, 2)};

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
  sh.getRange(row, 1).setValue(new Date());
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
      sh.appendRow([new Date(), person, projectName, siteUrl, 0, sid, 0, 0]);
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
      sh.appendRow([new Date(), person, projectName, siteUrl, 0, sid, 1, 0]);
      return;
    }

    if (kind === 'link' || kind === 'redirect') {
      if (row > 0) {
        var prevLinks = Number(sh.getRange(row, 8).getValue()) || 0;
        touchSession_(sh, row, person);
        sh.getRange(row, 8).setValue(prevLinks + 1);
        return;
      }
      sh.appendRow([new Date(), person, projectName, siteUrl, 0, sid, 0, 1]);
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
    if (value > 20000 && value < 200000) return Date.UTC(1899, 11, 30) + value * 86400000;
    if (value > 1e11) return value;
  }
  const text = String(value || '').trim();
  if (!text) return 0;
  const iso = Date.parse(text);
  if (!Number.isNaN(iso)) return iso;
  const m = text.match(
    /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\s*(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i
  );
  if (m) {
    let hour = Number(m[5]);
    const ap = String(m[4] || '').toLowerCase();
    if ((ap === '下午' || ap === 'pm') && hour < 12) hour += 12;
    if ((ap === '上午' || ap === 'am') && hour === 12) hour = 0;
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      hour,
      Number(m[6]),
      Number(m[7] || 0)
    ).getTime();
  }
  const d = text.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime();
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
      lastAt,
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
      properties: { title: `LifeTour 網站瀏覽紀錄 ${new Date().toISOString().slice(0, 10)}` },
      sheets: [{ properties: { title: '瀏覽紀錄' } }]
    }
  });
  cfg.logSpreadsheetId = created.data.spreadsheetId;
  cfg.logSheetName = '瀏覽紀錄';
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
      time: String(timeRaw || ''),
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
    time: ev.time || new Date().toLocaleString('zh-TW', { hour12: false }),
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
      projects: Array.isArray(payload?.projects) ? payload.projects : prev.projects
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
    const totalVisits = items.reduce((n, i) => n + (i.visits || 0), 0);
    const totalClicks = items.reduce((n, i) => n + (i.clicks || 0), 0);
    const totalLinks = items.reduce((n, i) => n + (i.links || 0), 0);
    return {
      success: true,
      items,
      projects: cfg.projects,
      localCount: store.events.length,
      syncedAt: store.syncedAt,
      storedInApp: true,
      totalVisits,
      totalClicks,
      totalLinks,
      totalSeconds: items.reduce((n, i) => n + i.totalSeconds, 0),
      durationLabel: formatDurationLabel(items.reduce((n, i) => n + i.totalSeconds, 0))
    };
  } catch (err) {
    return { success: false, ...explainSheetsError(err) };
  }
});

// Tasks APIs
function normalizeTaskItem(t) {
  return {
    id: t.id,
    title: t.title || '',
    notes: t.notes || '',
    status: t.status || 'needsAction',
    parent: t.parent || '',
    position: t.position || '',
    updated: t.updated || '',
    due: t.due || '',
    completed: t.completed || '',
    hidden: !!t.hidden,
    deleted: !!t.deleted
  };
}

function buildTaskTree(items) {
  const map = {};
  for (const raw of items || []) {
    if (!raw?.id) continue;
    map[raw.id] = { ...normalizeTaskItem(raw), children: [] };
  }
  const roots = [];
  for (const t of Object.values(map)) {
    if (t.parent && map[t.parent]) map[t.parent].children.push(t);
    else roots.push(t);
  }
  const byPos = (a, b) => String(a.position || '').localeCompare(String(b.position || ''));
  const byNewest = (a, b) => new Date(b.updated || 0) - new Date(a.updated || 0);
  for (const t of Object.values(map)) t.children.sort(byPos);
  const incomplete = roots.filter(t => t.status !== 'completed').sort(byNewest);
  const complete = roots.filter(t => t.status === 'completed').sort(byNewest).slice(0, 30);
  return [...incomplete, ...complete];
}

ipcMain.handle('get-tasks', async () => {
  try {
    const res = await tasksService.tasks.list({
      tasklist: '@default',
      showCompleted: true,
      showHidden: true,
      maxResults: 100
    });
    const flat = (res.data.items || [])
      .filter(t => t.deleted !== true && (t.status === 'completed' || t.hidden !== true))
      .map(normalizeTaskItem);
    const tasks = buildTaskTree(flat);
    const byId = {};
    const walk = (list) => {
      for (const t of list || []) {
        byId[t.id] = t;
        walk(t.children);
      }
    };
    walk(tasks);
    return { success: true, tasks, byId, flat };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('add-task', async (event, payload) => {
  try {
    const title = typeof payload === 'string' ? payload : payload?.title;
    const notes = typeof payload === 'object' && payload ? String(payload.notes || '') : '';
    const parent = typeof payload === 'object' && payload ? String(payload.parent || '') : '';
    const trimmed = String(title || '').trim();
    if (!trimmed) return { success: false, error: '標題不能空白' };
    const requestBody = { title: trimmed };
    if (notes) requestBody.notes = notes;
    const params = { tasklist: '@default', requestBody };
    // [Important] 子工作用 parent 查詢參數掛到父任務下
    if (parent) params.parent = parent;
    await tasksService.tasks.insert(params);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// [Important] 用 patch 局部更新，避免只改 notes／狀態時把 title 清掉
ipcMain.handle('update-task', async (event, taskId, fields = {}, legacyStatus) => {
  try {
    if (!taskId) return { success: false, error: '缺少任務 ID' };
    let body = fields;
    if (typeof fields === 'string') {
      body = { title: fields };
      if (legacyStatus !== undefined) body.status = legacyStatus;
    }
    const requestBody = { id: taskId };
    if (body.title !== undefined) requestBody.title = String(body.title);
    if (body.notes !== undefined) requestBody.notes = String(body.notes ?? '');
    if (body.status !== undefined) requestBody.status = body.status;
    await tasksService.tasks.patch({
      tasklist: '@default',
      task: taskId,
      requestBody
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

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
ipcMain.handle('get-calendar', async () => {
  try {
    const calList = await calendarService.calendarList.list({ maxResults: 250 });
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
        const res = await calendarService.events.list({
          calendarId: cal.id,
          timeMin,
          maxResults: cal.primary ? 12 : 8,
          singleEvents: true,
          orderBy: 'startTime'
        });
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
    const res = await calendarService.events.insert({
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
    });
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
  const used = new Set(cache.emails.flatMap(e => e.labelIds || []));
  const labels = [];
  ['CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'CATEGORY_PROMOTIONS', 'IMPORTANT', 'STARRED'].forEach(id => {
    if (used.has(id)) labels.push({ id, name: GMAIL_LABEL_NAMES[id], type: 'system' });
  });
  (cache.allLabels || [])
    .filter(l => l.type === 'user' && used.has(l.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
    .forEach(l => labels.push({ id: l.id, name: l.name, type: 'user' }));
  cache.labels = labels;
}

async function fetchMessageMeta(id, map) {
  const detail = await gmailService.users.messages.get({
    userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From']
  });
  const headers = detail.data.payload.headers;
  const labelIds = detail.data.labelIds || [];
  return {
    id,
    subject: headers.find(h => h.name === 'Subject')?.value || '無主旨',
    from: (headers.find(h => h.name === 'From')?.value || '未知').split('<')[0].trim(),
    snippet: detail.data.snippet || '無預覽',
    labelIds,
    tags: tagsFromLabelIds(labelIds, map)
  };
}

async function fetchMessageDetail(msgId) {
  const res = await gmailService.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
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
  await gmailService.users.messages.send({
    userId: 'me', requestBody: { raw: encodedEmail, threadId }
  });
}

async function flushPending() {
  const readIds = [...pending.markRead];
  if (readIds.length) {
    try {
      await gmailService.users.messages.batchModify({
        userId: 'me',
        requestBody: { ids: readIds, removeLabelIds: ['UNREAD'] }
      });
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

/** 分頁撈取全部未讀 id（Gmail 單次上限 500；超過則翻頁） */
async function listAllUnreadGmailIds() {
  const ids = [];
  let pageToken = '';
  // [Important] 過去 maxResults:50 且不分頁，超過 50 封的未讀會漏掉
  const PAGE = 100;
  const HARD_CAP = 500;
  do {
    const res = await gmailService.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: PAGE,
      pageToken: pageToken || undefined
    });
    for (const m of res.data.messages || []) {
      if (m?.id) ids.push(m.id);
      if (ids.length >= HARD_CAP) break;
    }
    pageToken = ids.length >= HARD_CAP ? '' : (res.data.nextPageToken || '');
  } while (pageToken);
  return ids;
}

async function refreshGmailList() {
  const labelsRes = await gmailService.users.labels.list({ userId: 'me' });
  cache.allLabels = labelsRes.data.labels || [];
  const map = labelNameMap();

  const ids = await listAllUnreadGmailIds();
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
        const profile = await gmailService.users.getProfile({ userId: 'me' });
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
    if (!/Sync quota exceeded|RESOURCE_EXHAUSTED|429/i.test(String(err?.message || ''))) {
      console.error('同步封包失敗:', err.message);
    }
  } finally {
    cache.syncing = false;
    notifyRenderer();
  }
}

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
      needsReauth: true,
      error: '目前登入還沒有 Google Chat 權限，請允許「查看、傳送 Chat 訊息」與「讀取狀態」。'
    };
  }
  if (status === 401) {
    return { needsReauth: true, error: '登入已過期，請重新授權 Google Chat。' };
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

function loadGchatDisk() {
  try {
    if (!fs.existsSync(gchatPacketPath())) return;
    const data = JSON.parse(fs.readFileSync(gchatPacketPath(), 'utf8'));
    gchatCache.messages = Array.isArray(data.messages) ? data.messages : [];
    gchatCache.spaceNames = data.spaceNames && typeof data.spaceNames === 'object' ? data.spaceNames : {};
    gchatCache.spaceTypes = data.spaceTypes && typeof data.spaceTypes === 'object' ? data.spaceTypes : {};
    gchatCache.userNames = scrubBadGchatUserNames(data.userNames);
    gchatCache.spaceMute = data.spaceMute && typeof data.spaceMute === 'object' ? data.spaceMute : {};
    gchatCache.myUserName = data.myUserName || '';
    gchatCache.myIds = Array.isArray(data.myIds) ? data.myIds.filter(Boolean).slice(0, 30) : [];
    gchatCache.myLabels = Array.isArray(data.myLabels) ? data.myLabels.filter(Boolean).slice(0, 12) : [];
    loadGchatPacketsFromDisk(data.packets);
    gchatCache.directoryWarmed = false;
    gchatCache.lastSync = data.lastSync || 0;
    gchatPending.markRead = new Map();
    const pendingRaw = data.pendingMarkRead || [];
    for (const entry of pendingRaw) {
      if (typeof entry === 'string') gchatPending.markRead.set(entry, {});
      else if (entry?.name) gchatPending.markRead.set(entry.name, {
        createTime: entry.createTime || '',
        threadName: entry.threadName || '',
        spaceName: entry.spaceName || ''
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

function slimGchatMessageForDisk(m) {
  if (!m || typeof m !== 'object') return m;
  const next = { ...m };
  if (Array.isArray(next.media)) {
    next.media = next.media.map((x) => {
      if (!x || typeof x !== 'object') return x;
      const { dataUrl, ...rest } = x;
      return rest;
    });
  }
  return next;
}

function serializeGchatPacketsForDisk() {
  const packets = gchatCache.packets || {};
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
  const entries = Object.entries(packets)
    .filter(([, p]) => p?.historyReady && p?.detail && Array.isArray(p.thread))
    .sort((a, b) => {
      const aPin = pinKeys.has(a[0]) || (a[1].detail?.spaceName && pinKeys.has(gchatSpacePacketKey(a[1].detail.spaceName))) ? 1 : 0;
      const bPin = pinKeys.has(b[0]) || (b[1].detail?.spaceName && pinKeys.has(gchatSpacePacketKey(b[1].detail.spaceName))) ? 1 : 0;
      if (bPin !== aPin) return bPin - aPin;
      return Number(b[1].packedAt || 0) - Number(a[1].packedAt || 0);
    })
    .slice(0, 48);
  const out = {};
  for (const [key, p] of entries) {
    out[key] = {
      packedAt: p.packedAt || Date.now(),
      historyReady: true,
      detail: slimGchatMessageForDisk(p.detail),
      thread: (p.thread || []).map(slimGchatMessageForDisk)
    };
  }
  return out;
}

function loadGchatPacketsFromDisk(raw) {
  if (!raw || typeof raw !== 'object') return;
  gchatCache.packets = gchatCache.packets || {};
  for (const [key, p] of Object.entries(raw)) {
    if (!p?.historyReady || !p?.detail || !Array.isArray(p.thread)) continue;
    gchatCache.packets[key] = {
      packedAt: p.packedAt || Date.now(),
      historyReady: true,
      detail: p.detail,
      thread: p.thread,
      mediaHydrated: !!p.mediaHydrated
    };
  }
  // 同一空間多鍵時，全部指到最新那包，避免 Little Reply 開到舊暫存
  const newestBySpace = new Map();
  for (const p of Object.values(gchatCache.packets)) {
    const sn = p?.detail?.spaceName;
    if (!sn || !p.historyReady) continue;
    const prev = newestBySpace.get(sn);
    if (!prev || Number(p.packedAt || 0) >= Number(prev.packedAt || 0)) {
      newestBySpace.set(sn, p);
    }
  }
  for (const p of newestBySpace.values()) {
    indexGchatPacket(p);
  }
}

function saveGchatDisk() {
  try {
    pruneGchatTodayTouched();
    const pendingMarkRead = [...gchatPending.markRead.entries()].map(([name, meta]) => ({
      name,
      createTime: meta?.createTime || '',
      threadName: meta?.threadName || '',
      spaceName: meta?.spaceName || ''
    }));
    fs.writeFileSync(gchatPacketPath(), JSON.stringify({
      messages: gchatCache.messages,
      spaceNames: gchatCache.spaceNames,
      spaceTypes: gchatCache.spaceTypes,
      userNames: gchatCache.userNames,
      spaceMute: gchatCache.spaceMute,
      myUserName: gchatCache.myUserName || '',
      myIds: gchatCache.myIds || [],
      myLabels: gchatCache.myLabels || [],
      packets: serializeGchatPacketsForDisk(),
      lastSync: gchatCache.lastSync,
      pendingMarkRead,
      locallyRead: [...gchatLocallyRead].slice(-500),
      locallyReadSpaces: Object.fromEntries([...gchatLocallyReadSpaces.entries()].slice(-80)),
      todayTouched: gchatCache.todayTouched || []
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
  if (!m) return m;
  const spaceLabel = m.spaceName ? (gchatCache.spaceNames[m.spaceName] || '') : '';
  const senderFromId = m.senderName ? (gchatCache.userNames[m.senderName] || '') : '';
  const sender = pickGoodGchatLabel(m.sender, senderFromId);
  const spaceDisplayName = cleanGchatSpaceLabel(
    pickGoodGchatLabel(m.spaceDisplayName, spaceLabel, sender),
    m.spaceType,
    m.isDm
  );
  return {
    ...m,
    sender: sender || m.sender || '',
    spaceDisplayName: spaceDisplayName || m.spaceDisplayName || ''
  };
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
    pinnedSpaces: loadGchatPrefs().pinnedSpaces || []
  };
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

async function uploadChatAttachment(spaceName, file) {
  if (!chatService || !spaceName || !file) return null;
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
  const res = await chatService.media.upload({
    parent: spaceName,
    requestBody: { filename },
    media: {
      mimeType,
      body: Readable.from(buf)
    }
  });
  return res.data;
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
      previewUrl: att.thumbnailUri || ''
    });
  }
  for (const card of raw?.cardsV2 || []) {
    const widgets = card?.card?.sections?.flatMap(s => s.widgets || []) || [];
    for (const w of widgets) {
      const src = w.image?.imageUrl || w.decoratedText?.startIcon?.iconUrl || '';
      if (src) media.push({ kind: 'image', name: '圖片', previewUrl: src, uri: src });
    }
  }
  return media;
}

/** 從 cardsV2 抽出可讀文字（引用／預覽用） */
function extractChatCardText(raw) {
  const parts = [];
  const push = (s) => {
    const t = String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  };
  for (const card of raw?.cardsV2 || []) {
    push(card?.card?.header?.title);
    push(card?.card?.header?.subtitle);
    for (const section of card?.card?.sections || []) {
      push(section?.header);
      for (const w of section.widgets || []) {
        push(w.textParagraph?.text);
        push(w.decoratedText?.topLabel);
        push(w.decoratedText?.text);
        push(w.decoratedText?.bottomLabel);
        if (w.buttonList?.buttons) {
          for (const b of w.buttonList.buttons) push(b.text);
        }
      }
    }
  }
  return parts.join('\n').slice(0, 800);
}

function extractQuotedMessage(raw) {
  const q = raw?.quotedMessageMetadata;
  if (!q?.name) return null;
  const snap = q.quotedMessageSnapshot || {};
  const sender = snap.sender?.displayName
    || snap.sender?.name
    || '';
  const text = String(snap.text || snap.fallbackText || snap.argumentText || '').trim()
    || extractChatCardText(snap)
    || '';
  return {
    name: q.name,
    lastUpdateTime: q.lastUpdateTime || snap.lastUpdateTime || snap.createTime || '',
    sender: sender || '訊息',
    text: text.slice(0, 400),
    quoteType: q.quoteType || 'REPLY'
  };
}

function extractReactionSummaries(raw, messageName = '') {
  const msgName = messageName || raw?.name || '';
  const myRx = gchatCache.myReactions?.[msgName] || {};
  return (raw?.emojiReactionSummaries || []).map((s) => {
    const unicode = String(s?.emoji?.unicode || '').trim();
    const custom = s?.emoji?.customEmoji || null;
    const customUid = String(custom?.uid || custom?.emojiName || '').trim();
    const label = unicode
      || (custom?.emojiName ? `:${custom.emojiName}:` : '')
      || '🙂';
    return {
      unicode,
      customUid,
      label,
      count: Number(s?.reactionCount || 0) || 0,
      reactedByMe: !!(unicode && myRx[unicode])
    };
  }).filter(r => (r.unicode || r.customUid) && r.count > 0);
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

function rememberGchatUserName(resource, label) {
  const name = String(label || '').trim();
  if (!resource || !name || name === '成員' || name === '未知' || name.startsWith('使用者 ')) return '';
  gchatCache.userNames[resource] = name;
  return name;
}

/** 把 People / Directory 回傳的各種 ID 都對到 users/{id}，才能對上 Chat sender */
function ingestDirectoryPerson(person, labelOverride) {
  if (!person) return;
  const orgDept = (person.organizations || []).map(o => o.department || o.name).find(Boolean) || '';
  const base = labelOverride
    || person.names?.[0]?.displayName
    || person.emailAddresses?.[0]?.value
    || '';
  const label = orgDept && base && !String(base).includes(orgDept) ? `${orgDept}_${base}` : base;
  if (!label) return;

  const rn = String(person.resourceName || '');
  if (rn.startsWith('people/')) {
    const rawId = rn.slice('people/'.length);
    if (rawId) {
      rememberGchatUserName(`users/${rawId}`, label);
      // people/c123… 有時是聯絡人 ID；同時留下去 c 的版本
      if (rawId.startsWith('c') && /^\d/.test(rawId.slice(1)) === false) {
        // no-op
      }
      if (rawId.startsWith('c')) {
        rememberGchatUserName(`users/${rawId.slice(1)}`, label);
      }
    }
  }
  for (const source of person.metadata?.sources || []) {
    const sid = String(source?.id || '').trim();
    if (!sid) continue;
    rememberGchatUserName(`users/${sid}`, label);
    if (sid.startsWith('c')) rememberGchatUserName(`users/${sid.slice(1)}`, label);
  }
  for (const email of person.emailAddresses || []) {
    if (email?.value) rememberGchatUserName(`users/${email.value}`, label);
  }
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
    gchatCache.directoryWarmed = true;
    gchatCache.directoryError = '';
    saveGchatDisk();
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

  await warmGchatUserDirectory();
  if (gchatCache.userNames[resource] && !String(gchatCache.userNames[resource]).startsWith('使用者 ')) {
    return gchatCache.userNames[resource];
  }

  const id = resource.slice('users/'.length);
  if (id.includes('@')) return rememberGchatUserName(resource, id) || id;

  const peopleLabel = await lookupPeopleUser(id);
  if (peopleLabel) return rememberGchatUserName(resource, peopleLabel) || peopleLabel;

  if (spaceName && chatService) {
    try {
      const mem = await chatService.spaces.members.get({
        name: `${spaceName}/members/${resource}`
      });
      const label = mem.data.member?.displayName || mem.data.displayName || '';
      if (label) return rememberGchatUserName(resource, label) || label;
    } catch (_) {}
  }

  return id ? `使用者 ${id.slice(-6)}` : '未知寄件者';
}

async function downloadChatMediaDataUrl(resourceName, contentType) {
  if (!resourceName || !oauth2Client) return '';
  // resourceName 形如 spaces/.../attachments/...；路徑分段編碼，避免下載失敗
  const encoded = String(resourceName)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const res = await oauth2Client.request({
    method: 'GET',
    url: `https://chat.googleapis.com/v1/media/${encoded}?alt=media`,
    responseType: 'arraybuffer'
  });
  const buf = Buffer.from(res.data);
  if (!buf.length || buf.length > 20 * 1024 * 1024) return '';
  let mime = String(contentType || '').trim();
  if (!mime || mime === 'application/octet-stream') {
    const lower = String(resourceName).toLowerCase();
    if (/\.png(\b|$)/i.test(lower) || /png/i.test(mime)) mime = 'image/png';
    else if (/\.jpe?g(\b|$)/i.test(lower)) mime = 'image/jpeg';
    else if (/\.gif(\b|$)/i.test(lower)) mime = 'image/gif';
    else if (/\.webp(\b|$)/i.test(lower)) mime = 'image/webp';
    else if (/\.pdf(\b|$)/i.test(lower)) mime = 'application/pdf';
    else mime = mime || 'image/png';
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function hydrateChatMedia(media) {
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
        copy.dataUrl = await downloadChatMediaDataUrl(
          copy.resourceName,
          copy.contentType || (isPdf ? 'application/pdf' : (isChatImageType(copy.contentType, copy.name) ? guessImageMime(copy.name) : 'image/png'))
        );
        if (copy.dataUrl && isImage) {
          copy.kind = copy.kind === 'gif' ? 'gif' : 'image';
          copy.previewUrl = copy.dataUrl;
        }
        if (copy.dataUrl && isPdf) copy.kind = 'pdf';
      } catch (err) {
        console.warn('Chat 媒體下載失敗:', err.message);
      }
      if (!copy.dataUrl && copy.thumbnailUri) copy.previewUrl = copy.thumbnailUri;
    } else if (copy.thumbnailUri && !copy.previewUrl && !copy.dataUrl) {
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
async function ensureThreadMediaHydrated(thread) {
  const list = Array.isArray(thread) ? thread : [];
  for (const m of list) {
    if (!m?.media?.length) continue;
    const needs = m.media.some(x => {
      if (!x) return false;
      if (x.dataUrl) return false;
      const imageLike = x.kind === 'image' || x.kind === 'gif' || x.kind === 'pdf'
        || isChatImageType(x.contentType, x.name)
        || isChatPdfType(x.contentType, x.name);
      return imageLike && !!(x.resourceName || x.uri || x.thumbnailUri || x.previewUrl);
    });
    if (!needs) continue;
    try {
      m.media = await hydrateChatMedia(m.media);
    } catch (_) {}
  }
  return list;
}

async function normalizeChatMessage(raw, spaceDisplayName) {
  const name = raw?.name || '';
  const parsed = parseChatResource(name);
  const threadName = raw?.thread?.name || parsed.threadName || '';
  const threadParsed = parseChatResource(threadName);
  const createTime = raw?.createTime || '';
  const lastUpdateTime = raw?.lastUpdateTime || createTime || '';
  const media = extractChatMediaMeta(raw);
  const cardText = extractChatCardText(raw);
  const text = raw?.text || '';
  const displayText = text || cardText || '';
  const snippetBase = displayText ? snippetFromText(displayText) : '';
  const mediaHint = mediaSnippet(media);
  const sender = await resolveSenderName(raw?.sender, parsed.spaceName);
  const quoted = extractQuotedMessage(raw);
  const reactions = extractReactionSummaries(raw, name);
  return {
    name,
    spaceName: parsed.spaceName,
    spaceId: parsed.spaceId,
    spaceDisplayName: spaceDisplayName || gchatCache.spaceNames[parsed.spaceName] || parsed.spaceId || '對話',
    messageId: parsed.messageId,
    threadName: threadName || '',
    threadId: threadParsed.threadId || '',
    text: displayText,
    cardText: cardText || '',
    snippet: snippetBase && mediaHint ? `${snippetBase} ${mediaHint}` : (snippetBase || mediaHint || '（無文字）'),
    sender,
    senderName: raw?.sender?.name || '',
    media,
    quoted,
    reactions,
    createTime,
    lastUpdateTime,
    createTimeLabel: createTime
      ? new Date(createTime).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '',
    openUrl: chatOpenUrl(parsed.spaceId, threadParsed.threadId)
  };
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
    const mem = await chatService.spaces.members.get({
      name: `${spaceName}/members/users/me`
    });
    const hit = rememberFromMembership(mem.data);
    if (hit) return hit;
  } catch (_) {}
  // 備援：列出成員，比對 email／已記 id，或抓 users/me 那筆
  try {
    const members = await chatService.spaces.members.list({
      parent: spaceName,
      pageSize: 50
    });
    for (const mem of members.data.memberships || []) {
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
    const res = await chatService.spaces.get({ name: spaceName });
    const spaceType = res.data.spaceType || cachedType || '';
    gchatCache.spaceTypes[spaceName] = spaceType;
    let label = res.data.displayName || '';
    // 私人：一律從成員名單取「對方」；群組無 displayName 時才用成員拼
    if (spaceType === 'DIRECT_MESSAGE' || (!label && spaceType === 'GROUP_CHAT')) {
      try {
        const members = await chatService.spaces.members.list({
          parent: spaceName,
          pageSize: 20
        });
        const others = [];
        for (const m of members.data.memberships || []) {
          const member = m.member || {};
          if (member.type === 'BOT') continue;
          if (member.name === 'users/me' || member.name?.endsWith('/me')) continue;
          if (gchatCache.myUserName && member.name === gchatCache.myUserName) continue;
          if (Array.isArray(gchatCache.myIds) && member.name && gchatCache.myIds.includes(member.name)) continue;
          const n = await resolveSenderName(member, spaceName);
          const candidate = (n && n !== '成員' && !String(n).startsWith('使用者 '))
            ? n
            : (member.displayName || '');
          if (!candidate || isGchatSelfDisplayLabel(candidate)) continue;
          others.push(candidate);
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

async function searchChatMessages(filter) {
  const data = await withTransientRetry(() => chatHttp(
    'POST',
    'https://chat.googleapis.com/v1/spaces/-/messages:search',
    {
      filter,
      pageSize: 50,
      orderBy: 'createTime desc',
      view: 'SEARCH_MESSAGES_VIEW_FULL'
    }
  ), { tries: 3, baseMs: 500 });
  return data.results || [];
}

function bumpReadTimestamp(iso) {
  const raw = String(iso || '').trim();
  if (!raw) return new Date().toISOString();
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return new Date().toISOString();
  // 略往後推，確保該則訊息 createTime <= lastReadTime
  return new Date(ms + 1000).toISOString();
}

async function searchUnreadChatMessages() {
  await warmGchatUserDirectory();
  const myUserName = await ensureMyChatUserName();

  // 兩路分開：@我未讀（群組用）＋ 全部未讀（私人＋備援抓群組提及）
  let mentionRows = [];
  let unreadRows = [];
  try {
    mentionRows = await searchChatMessages(
      'is_unread() AND annotations.user_mentions.user.name:users/me'
    );
  } catch (err) {
    logGchatApiIssue('提及搜尋失敗', err);
  }
  try {
    unreadRows = await searchChatMessages('is_unread()');
  } catch (err) {
    logGchatApiIssue('未讀搜尋失敗', err);
    // [Important] Google Internal error 時不要整輪掛掉；沿用本機暫存
    if (isTransientGoogleError(err)) {
      return Array.isArray(gchatCache.messages) ? [...gchatCache.messages] : [];
    }
    throw err;
  }

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
    })) return;
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
    // 類型未知時：群組路徑不要用「未讀全部」硬塞
    if (requireDm && !spaceType) return;

    let mentionedMe = messageMentionsMe(msg, myUserName);
    if (forceMentioned) {
      // 提及專用搜尋（users/me）已命中：信任結果
      // 過去若註解 ID 對不到 myUserName，會把群組 @ 整筆丟掉，導致不跳泡泡
      mentionedMe = true;
    }
    if (!isDm && !mentionedMe) return;

    const item = await normalizeChatMessage(msg, meta.label);
    item.spaceType = spaceType;
    item.isDm = isDm;
    item.mentionedMe = !!mentionedMe;
    items.push(item);
    seen.add(msg.name);
  };

  // A) @我未讀：群組主要來源（私人若有 @ 也會進來）
  for (const row of mentionRows) {
    await pushItem(row, { forceMentioned: true, requireDm: false });
  }

  // B) 全部未讀：私人一律收；群組僅在能確認 @我 時收（備援，避免提及搜尋漏掉）
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

function queueGchatMarkRead(messageName, meta = {}) {
  if (!messageName) return { namesToClear: [], maxCreateTime: '', spaceName: '' };
  const cached = gchatCache.messages.find(m => m.name === messageName)
    || gchatCache.packets?.[messageName]?.detail
    || null;
  const spaceName = meta.spaceName || cached?.spaceName || '';
  const related = (gchatCache.messages || []).filter(m => {
    if (!m?.name) return false;
    if (m.name === messageName) return true;
    if (spaceName && m.spaceName === spaceName) return true;
    if (cached?.spaceName && m.spaceName === cached.spaceName) return true;
    return false;
  });
  // 同空間所有未讀一併納入（含列表合併後的 memberNames）
  const fromMembers = Array.isArray(meta.memberNames) ? meta.memberNames : [];
  const namesToClear = [...new Set([
    messageName,
    ...fromMembers,
    ...related.map(m => m.name)
  ].filter(Boolean))];

  let maxCreateTime = meta.createTime || cached?.createTime || '';
  for (const n of namesToClear) {
    const hit = gchatCache.messages.find(m => m.name === n)
      || (n === messageName ? cached : null);
    if (hit?.createTime && String(hit.createTime) > String(maxCreateTime || '')) {
      maxCreateTime = hit.createTime;
    }
  }

  const touchItem = {
    ...(cached || {}),
    name: messageName,
    createTime: maxCreateTime || meta.createTime || cached?.createTime || '',
    threadName: meta.threadName || cached?.threadName || '',
    spaceName: spaceName || '',
    sender: pickGoodGchatLabel(meta.sender, cached?.sender),
    senderName: meta.senderName || cached?.senderName || '',
    spaceDisplayName: pickGoodGchatLabel(meta.spaceDisplayName, cached?.spaceDisplayName),
    snippet: pickGoodGchatLabel(meta.snippet, cached?.snippet) || meta.snippet || cached?.snippet || '',
    isDm: meta.isDm != null ? !!meta.isDm : !!cached?.isDm,
    mentionedMe: meta.mentionedMe != null ? !!meta.mentionedMe : !!cached?.mentionedMe,
    spaceType: meta.spaceType || cached?.spaceType || '',
    openUrl: meta.openUrl || cached?.openUrl || '',
    createTimeLabel: meta.createTimeLabel || cached?.createTimeLabel || '',
    memberNames: namesToClear
  };
  rememberGchatTodayTouch(touchItem, { read: true });

  for (const name of namesToClear) {
    const hit = gchatCache.messages.find(m => m.name === name) || cached || touchItem;
    const prev = gchatPending.markRead.get(name) || {};
    gchatPending.markRead.set(name, {
      createTime: maxCreateTime || hit?.createTime || prev.createTime || '',
      threadName: meta.threadName || hit?.threadName || prev.threadName || '',
      spaceName: spaceName || hit?.spaceName || prev.spaceName || ''
    });
    gchatLocallyRead.add(name);
  }
  // 空間水位：之後同步回來、時間不新於此次的訊息一律當已讀
  const resolvedSpace = spaceName || cached?.spaceName || '';
  if (resolvedSpace && maxCreateTime) {
    const prevUntil = String(gchatLocallyReadSpaces.get(resolvedSpace) || '');
    if (!prevUntil || String(maxCreateTime) > prevUntil) {
      gchatLocallyReadSpaces.set(resolvedSpace, String(maxCreateTime));
    }
  }
  // 同空間尚在 cache、但 createTime <= 水位的也一併清掉
  if (resolvedSpace) {
    const until = String(gchatLocallyReadSpaces.get(resolvedSpace) || maxCreateTime || '');
    gchatCache.messages = (gchatCache.messages || []).filter(m => {
      if (!m?.name) return false;
      if (namesToClear.includes(m.name)) return false;
      if (m.spaceName === resolvedSpace && until && String(m.createTime || '') <= until) {
        gchatLocallyRead.add(m.name);
        return false;
      }
      return true;
    });
  } else {
    gchatCache.messages = gchatCache.messages.filter(m => !namesToClear.includes(m.name));
  }

  // 已讀後不再用該對話洗泡泡
  const trackKey = gchatTrackKey(touchItem);
  if (trackKey) {
    mainGchatAlerted.add(trackKey);
    if (maxCreateTime) mainGchatAlertedAt.set(trackKey, String(maxCreateTime));
  }
  try {
    if (toastWin && !toastWin.isDestroyed()) {
      toastWin.webContents.send('gchat-toast-dismiss', { trackKey, spaceName: resolvedSpace, names: namesToClear });
    }
  } catch (_) {}

  return { namesToClear, maxCreateTime, spaceName: resolvedSpace };
}

/** 點泡泡／開回覆：立刻把該對話當下未讀全部標已讀 */
async function markGchatConversationReadByName(messageName, extra = {}) {
  if (!messageName) return { success: false, error: '缺少訊息' };
  const cached = gchatCache.messages.find(m => m.name === messageName)
    || gchatCache.packets?.[messageName]?.detail
    || findReadyGchatPacket(messageName)?.detail
    || (gchatCache.todayTouched || []).find(m => m.name === messageName)
    || {};
  const meta = {
    createTime: extra.createTime || cached.createTime || '',
    threadName: extra.threadName || cached.threadName || '',
    spaceName: extra.spaceName || cached.spaceName || '',
    sender: pickGoodGchatLabel(extra.sender, cached.sender),
    senderName: extra.senderName || cached.senderName || '',
    spaceDisplayName: pickGoodGchatLabel(extra.spaceDisplayName, cached.spaceDisplayName),
    snippet: pickGoodGchatLabel(extra.snippet, cached.snippet) || extra.snippet || cached.snippet || '',
    isDm: extra.isDm != null ? !!extra.isDm : !!cached.isDm,
    mentionedMe: extra.mentionedMe != null ? !!extra.mentionedMe : !!cached.mentionedMe,
    spaceType: extra.spaceType || cached.spaceType || '',
    openUrl: extra.openUrl || cached.openUrl || '',
    createTimeLabel: extra.createTimeLabel || cached.createTimeLabel || '',
    memberNames: Array.isArray(extra.memberNames) ? extra.memberNames : (cached.memberNames || [])
  };
  const queued = queueGchatMarkRead(messageName, meta);
  saveGchatDisk();
  broadcastGchatListUpdate();
  try {
    await markChatMessageReadRemote(messageName, {
      ...meta,
      createTime: queued.maxCreateTime || meta.createTime,
      spaceName: queued.spaceName || meta.spaceName
    });
    for (const n of queued.namesToClear || []) {
      gchatPending.markRead.delete(n);
      gchatLocallyRead.add(n);
    }
    saveGchatDisk();
  } catch (err) {
    logGchatApiIssue('已讀延後同步', err);
  }
  return { success: true, ...gchatSnapshot() };
}

async function flushGchatPending() {
  const entries = [...gchatPending.markRead.entries()];
  for (const [name, meta] of entries) {
    try {
      await markChatMessageReadRemote(name, meta || {});
      gchatPending.markRead.delete(name);
      gchatLocallyRead.add(name);
    } catch (err) {
      logGchatApiIssue('標已讀失敗', err);
      // 失敗也留在 locallyRead，本 App 不再顯示；下次 flush 再試伺服器
      gchatLocallyRead.add(name);
    }
  }
}

async function markChatMessageReadRemote(messageName, meta = {}) {
  const parsed = parseChatResource(messageName);
  if (!parsed.spaceId) throw new Error('訊息格式無效');

  const cached = gchatCache.messages.find(m => m.name === messageName)
    || gchatCache.packets?.[messageName]?.detail
    || {};
  const createTime = meta.createTime || cached.createTime || '';
  const threadName = meta.threadName || cached.threadName || '';
  const threadParsed = parseChatResource(threadName);
  const threadId = threadParsed.threadId || parsed.threadId || '';
  // 若同空間有更新的訊息，必須用最新 createTime，否則後面幾則仍會被 Google 當未讀
  const lastReadTime = bumpReadTimestamp(createTime);

  let spaceOk = false;
  let lastErr = null;

  // 官方支援：更新空間已讀（對私人對話／頂層訊息有效）
  try {
    await withTransientRetry(() => chatService.users.spaces.updateSpaceReadState({
      name: `users/me/spaces/${parsed.spaceId}/spaceReadState`,
      updateMask: 'lastReadTime',
      requestBody: {
        name: `users/me/spaces/${parsed.spaceId}/spaceReadState`,
        lastReadTime
      }
    }), { tries: 3, baseMs: 400 });
    spaceOk = true;
  } catch (err) {
    lastErr = err;
    logGchatApiIssue('spaceReadState 更新失敗', err);
  }

  // 串內已讀：Google 公開 API 只有 getThreadReadState，沒有 update → 不再呼叫（會 Method not found）

  if (!spaceOk) {
    const soft = isTransientGoogleError(lastErr)
      ? 'Google Chat 暫時無法同步已讀，本機已標已讀，稍後會再試'
      : '無法把已讀狀態同步到 Google Chat';
    const e = new Error(soft);
    e.transient = isTransientGoogleError(lastErr);
    throw e;
  }
  return { spaceOk, lastReadTime, threadId: threadId || '' };
}

async function refreshGchatList() {
  if (!oauth2Client || !chatService) return;
  const keepNames = scrubBadGchatUserNames(gchatCache.userNames);
  const keepWarmed = gchatCache.directoryWarmed && Object.keys(keepNames).length > 5;
  loadGchatDisk();
  gchatCache.userNames = { ...gchatCache.userNames, ...keepNames };
  if (keepWarmed) gchatCache.directoryWarmed = true;
  if (!cache.myEmail && gmailService) {
    try {
      const profile = await gmailService.users.getProfile({ userId: 'me' });
      cache.myEmail = profile.data.emailAddress || '';
    } catch (_) {}
  }
  await flushGchatPending();
  gchatCache.messages = await searchUnreadChatMessages();
  gchatCache.lastSync = Date.now();
  saveGchatDisk();
  await packGchatPackets(gchatCache.messages);
}

async function listSpaceMessages(spaceName, { pageSize = 50 } = {}) {
  if (!spaceName || !chatService) return [];
  const res = await chatService.spaces.messages.list({
    parent: spaceName,
    pageSize: Math.min(pageSize, 100),
    orderBy: 'createTime desc'
  });
  const raw = [...(res.data.messages || [])].reverse();
  const msgs = [];
  for (const m of raw) {
    msgs.push(await normalizeChatMessage(m));
  }
  return msgs;
}

async function listThreadMessages(spaceName, threadName) {
  if (!spaceName) return [];
  const params = {
    parent: spaceName,
    pageSize: 50,
    orderBy: 'createTime asc'
  };
  if (threadName) {
    params.filter = `thread.name = "${threadName}"`;
  }
  const res = await chatService.spaces.messages.list(params);
  const msgs = [];
  for (const m of res.data.messages || []) {
    msgs.push(await normalizeChatMessage(m));
  }
  return msgs;
}

/** 開啟對話時載入歷史：私人／群組（含 SPACE 房間）都抓空間近期，體感一致 */
async function loadConversationHistory(detail) {
  if (!detail?.spaceName) return detail ? [detail] : [];
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
      console.warn('專注討論串載入失敗:', err.message);
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
    }
  } catch (err) {
    console.warn('載入 Chat 歷史失敗:', err.message);
  }

  if (!thread.length && detail) thread = [{ ...detail }];
  if (detail?.name && !thread.some(m => m.name === detail.name)) {
    thread.push({ ...detail });
  }
  thread.sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));

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

  // 媒體：有附件才下載，避免整串太慢
  for (const m of thread) {
    if (!m.media?.length) continue;
    const needs = m.media.some(x => !x.dataUrl && (x.resourceName || x.uri || x.previewUrl));
    if (!needs) continue;
    try {
      m.media = await hydrateChatMedia(m.media);
    } catch (_) {}
  }
  return thread;
}

function gchatSpacePacketKey(spaceName) {
  const s = String(spaceName || '').trim();
  return s ? `space:${s}` : '';
}

/**
 * 寫入／更新對話暫存。同一空間舊的 messageName 鍵也一併指向新 packet，
 * 避免 Little Reply 重開仍讀到 10 秒前的舊串。
 */
function indexGchatPacket(packet) {
  if (!packet?.detail) return packet;
  if (!gchatCache.packets) gchatCache.packets = {};
  const d = packet.detail;
  const spaceName = String(d.spaceName || '').trim();
  if (spaceName) {
    for (const [key, p] of Object.entries(gchatCache.packets)) {
      if (p?.detail?.spaceName === spaceName) {
        gchatCache.packets[key] = packet;
      }
    }
    const spaceKey = gchatSpacePacketKey(spaceName);
    if (spaceKey) gchatCache.packets[spaceKey] = packet;
  }
  if (d.name) gchatCache.packets[d.name] = packet;
  for (const m of packet.thread || []) {
    if (m?.name) gchatCache.packets[m.name] = packet;
  }
  return packet;
}

/** 即時把對話串寫回暫存（回覆／Little Reply 刷新用，不等 10 秒打包） */
function upsertGchatLivePacket(meta, threadIn) {
  const spaceName = String(meta?.spaceName || '').trim();
  if (!spaceName || !Array.isArray(threadIn) || !threadIn.length) return null;
  const isDm = !!(meta.isDm || meta.spaceType === 'DIRECT_MESSAGE');
  const spaceType = meta.spaceType || (isDm ? 'DIRECT_MESSAGE' : '') || gchatCache.spaceTypes[spaceName] || '';
  const thread = annotateGchatThreadMine(threadIn);
  thread.sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
  const newest = thread[thread.length - 1] || null;
  const prev = findReadyGchatPacketBySpace(spaceName, { isDm })
    || (meta.name && gchatCache.packets?.[meta.name])
    || null;
  const label = cleanGchatSpaceLabel(
    meta.spaceDisplayName
      || prev?.detail?.spaceDisplayName
      || gchatCache.spaceNames[spaceName]
      || newest?.spaceDisplayName
      || '對話',
    spaceType,
    isDm
  );
  if (label) gchatCache.spaceNames[spaceName] = label;
  const detail = {
    ...(prev?.detail || {}),
    ...(newest || {}),
    name: newest?.name || meta.name || prev?.detail?.name || '',
    spaceName,
    spaceDisplayName: label,
    spaceType,
    isDm,
    threadName: meta.threadName || newest?.threadName || prev?.detail?.threadName || '',
    sender: (newest && !isOwnGchatMessage(newest) ? newest.sender : null)
      || meta.sender
      || prev?.detail?.sender
      || label,
    senderName: newest?.senderName || meta.senderName || prev?.detail?.senderName || '',
    snippet: newest?.snippet || newest?.text || prev?.detail?.snippet || '',
    text: newest?.text || '',
    createTime: newest?.createTime || prev?.detail?.createTime || '',
    createTimeLabel: newest?.createTimeLabel || prev?.detail?.createTimeLabel || '',
    media: newest?.media || [],
    isMine: newest ? isOwnGchatMessage(newest) : false
  };
  const packet = {
    detail,
    thread,
    packedAt: Date.now(),
    historyReady: true,
    mediaHydrated: !!prev?.mediaHydrated
  };
  indexGchatPacket(packet);
  return packet;
}

/** 把單則新訊息併入既有暫存（送出回覆後立刻更新） */
function appendMessageToGchatPacket(msg, extras = {}) {
  if (!msg) return null;
  const spaceName = String(msg.spaceName || extras.spaceName || '').trim();
  if (!spaceName) return null;
  const isDm = !!(extras.isDm ?? msg.isDm ?? (extras.spaceType === 'DIRECT_MESSAGE'));
  const prev = findReadyGchatPacketBySpace(spaceName, { isDm })
    || (msg.name && gchatCache.packets?.[msg.name])
    || null;
  const thread = Array.isArray(prev?.thread) ? [...prev.thread] : [];
  const annotatedMsg = { ...msg, isMine: true, sender: msg.sender === '我' || msg.isMine ? '我' : msg.sender };
  if (annotatedMsg.name) {
    const idx = thread.findIndex(m => m.name === annotatedMsg.name);
    if (idx >= 0) thread[idx] = { ...thread[idx], ...annotatedMsg };
    else thread.push(annotatedMsg);
  } else {
    thread.push(annotatedMsg);
  }
  return upsertGchatLivePacket({
    spaceName,
    isDm,
    spaceType: extras.spaceType || msg.spaceType || (isDm ? 'DIRECT_MESSAGE' : ''),
    spaceDisplayName: extras.spaceDisplayName || msg.spaceDisplayName || prev?.detail?.spaceDisplayName || '',
    threadName: extras.threadName || msg.threadName || '',
    sender: extras.sender || prev?.detail?.sender || '',
    name: msg.name || prev?.detail?.name || ''
  }, thread);
}

async function packGchatDetailForItem(item, { withHistory = true } = {}) {
  if (!item?.name) return null;
  const detail = { ...item };
  try {
    detail.media = await hydrateChatMedia(item.media || []);
  } catch (_) {
    detail.media = item.media || [];
  }
  let thread = [detail];
  if (withHistory) {
    try {
      thread = await loadConversationHistory(detail);
    } catch (_) {
      thread = [detail];
    }
  }
  if (!thread.some(m => m.name === detail.name)) thread.push(detail);
  thread.sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
  const packet = {
    detail,
    thread,
    packedAt: Date.now(),
    historyReady: !!withHistory,
    mediaHydrated: !!withHistory
  };
  return indexGchatPacket(packet);
}

function findReadyGchatPacket(messageName, hint = null) {
  const packets = gchatCache.packets || {};
  const byName = (messageName && packets[messageName]?.historyReady && Array.isArray(packets[messageName].thread))
    ? packets[messageName]
    : null;
  const touch = hint
    || (gchatCache.messages || []).find(m => m.name === messageName)
    || (gchatCache.todayTouched || []).find(m => m.name === messageName)
    || byName?.detail
    || null;
  let bySpace = null;
  if (touch?.spaceName) {
    bySpace = findReadyGchatPacketBySpace(touch.spaceName, {
      isDm: !!(touch.isDm || touch.spaceType === 'DIRECT_MESSAGE')
    });
  }
  // 優先較新的空間暫存（對話中已即時寫入），不要被舊 messageName 鍵卡住
  if (byName && bySpace) {
    return Number(bySpace.packedAt || 0) >= Number(byName.packedAt || 0) ? bySpace : byName;
  }
  if (byName) return byName;
  if (bySpace) return bySpace;
  const key = gchatTrackKey(touch || {});
  if (!key) return null;
  let best = null;
  for (const p of Object.values(packets)) {
    if (!p?.historyReady || !p.detail || !Array.isArray(p.thread)) continue;
    if (gchatTrackKey(p.detail) !== key) continue;
    if (!best || Number(p.packedAt || 0) > Number(best.packedAt || 0)) best = p;
  }
  return best;
}

function findReadyGchatPacketBySpace(spaceName, { isDm = false } = {}) {
  if (!spaceName) return null;
  const packets = gchatCache.packets || {};
  const spaceKey = gchatSpacePacketKey(spaceName);
  if (spaceKey && packets[spaceKey]?.historyReady && Array.isArray(packets[spaceKey].thread)) {
    return packets[spaceKey];
  }
  const track = gchatTrackKey({
    spaceName,
    isDm: !!isDm,
    spaceType: isDm ? 'DIRECT_MESSAGE' : ''
  });
  let best = null;
  for (const p of Object.values(packets)) {
    if (!p?.historyReady || !p.detail || !Array.isArray(p.thread)) continue;
    if (p.detail.spaceName === spaceName) {
      if (!best || Number(p.packedAt || 0) > Number(best.packedAt || 0)) best = p;
      continue;
    }
    if (track && gchatTrackKey(p.detail) === track) {
      if (!best || Number(p.packedAt || 0) > Number(best.packedAt || 0)) best = p;
    }
  }
  return best;
}

/** 打包單一空間歷史（置頂／開啟對話共用） */
async function packGchatSpaceHistory(spaceName, extras = {}) {
  if (!spaceName || !chatService) return null;
  const meta = await ensureSpaceMeta(spaceName);
  const spaceType = extras.spaceType || meta.spaceType || '';
  const isDm = !!extras.isDm || spaceType === 'DIRECT_MESSAGE';
  // [Important] 私人訊息標題只留對方，不要「對方、自己」
  const label = cleanGchatSpaceLabel(
    extras.label || meta.label || gchatCache.spaceNames[spaceName] || '對話',
    spaceType,
    isDm
  );
  gchatCache.spaceNames[spaceName] = label;
  if (spaceType) gchatCache.spaceTypes[spaceName] = spaceType;

  const thread = annotateGchatThreadMine(await loadConversationHistory({
    spaceName,
    isDm,
    spaceType,
    spaceDisplayName: label
  }));
  const focus = thread[thread.length - 1] || null;
  const detail = {
    name: focus?.name || '',
    spaceName,
    spaceDisplayName: label,
    spaceType,
    isDm,
    sender: extras.sender || label,
    senderName: extras.userName || focus?.senderName || '',
    snippet: focus?.snippet || focus?.text || '開始對話',
    text: focus?.text || '',
    createTime: focus?.createTime || '',
    createTimeLabel: focus?.createTimeLabel || '',
    threadName: focus?.threadName || '',
    openUrl: chatOpenUrl(spaceName.replace(/^spaces\//, ''), ''),
    mentionedMe: false,
    isMine: focus ? isOwnGchatMessage(focus) : false,
    media: focus?.media || []
  };
  const packet = {
    detail,
    thread,
    packedAt: Date.now(),
    historyReady: true,
    mediaHydrated: false
  };
  indexGchatPacket(packet);
  // 背景補圖，不擋置頂預熱
  ensureThreadMediaHydrated(thread).then(() => {
    packet.mediaHydrated = true;
  }).catch(() => {});
  return packet;
}

/** 置頂私人／群組預打包，點芯片才能走暫存 */
async function packPinnedGchatConversations() {
  if (!chatService || !oauth2Client) return;
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
    if (prev?.historyReady && Date.now() - Number(prev.packedAt || 0) < 8 * 60 * 1000) continue;
    try {
      await packGchatSpaceHistory(job.spaceName, job);
    } catch (err) {
      console.warn('置頂對話預打包失敗:', job.spaceName, err.message);
    }
  }
}

async function packGchatPackets(messages) {
  pruneGchatTodayTouched();
  // 未讀 inbox + 今天已開啟／已回覆：都預先打包歷史，點開才不用等 Loading
  const inbox = (messages || []).filter(isInboxGchatMessage);
  const today = (gchatCache.todayTouched || []).filter(t => t?.name);
  const byName = new Map();
  for (const t of today) byName.set(t.name, t);
  for (const m of inbox) byName.set(m.name, m); // 未讀覆蓋同名
  const list = [...byName.values()];
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
  gchatCache.packets = gchatCache.packets || {};
  for (const key of Object.keys(gchatCache.packets)) {
    if (keep.has(key)) continue;
    if (key.startsWith('space:') && pinSpaceKeys.has(key)) continue;
    const detail = gchatCache.packets[key]?.detail;
    const trackKey = detail ? gchatTrackKey(detail) : '';
    if (trackKey && todayKeys.has(trackKey)) continue;
    if (trackKey && pinSpaceKeys.has(trackKey)) continue;
    if (detail?.spaceName && pinSpaceKeys.has(gchatSpacePacketKey(detail.spaceName))) continue;
    delete gchatCache.packets[key];
  }
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

ipcMain.handle('gchat-get-prefs', async () => {
  try {
    return { success: true, ...loadGchatPrefs() };
  } catch (err) {
    return { success: false, alertPopup: true, error: err.message };
  }
});

ipcMain.handle('gchat-save-prefs', async (event, prefs) => {
  try {
    const next = saveGchatPrefs(prefs || {});
    if (next.alertPopup === false) {
      if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
    } else if (prefs?.alertPopup !== undefined) {
      mainGchatAlertSeeded = false;
      mainGchatAlerted.clear();
      mainGchatAlertedAt.clear();
    }
    // bar 未讀輪詢持續跑；彈跳與否由 prefs.alertPopup 控制
    startMainGchatAlertWatch();
    return { success: true, ...next };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('gchat-open-setup', async () => {
  const url = chatApiEnableUrl();
  await shell.openExternal(url);
  return { success: true, url };
});

ipcMain.handle('gchat-open-app-config', async () => {
  const url = chatAppConfigUrl();
  await shell.openExternal(url);
  return { success: true, url };
});

ipcMain.handle('gchat-open-admin-setup', async () => {
  const url = adminApiEnableUrl();
  await shell.openExternal(url);
  return { success: true, url };
});

ipcMain.handle('gchat-status', async () => {
  try {
    if (!oauth2Client || !chatService) {
      return { success: false, error: '請先用 Google 登入' };
    }
    const scope = await grantedScopeText();
    const hasScope = hasChatScopes(scope);
    if (!hasScope) {
      return {
        success: true,
        ready: false,
        hasScope: false,
        needsReauth: true,
        setupUrl: chatApiEnableUrl()
      };
    }
    try {
      await chatHttp('POST', 'https://chat.googleapis.com/v1/spaces/-/messages:search', {
        filter: 'is_unread()',
        pageSize: 1,
        orderBy: 'createTime desc'
      });
    } catch (err) {
      const explained = explainChatError(err);
      if (explained.needsApi || explained.needsReauth) {
        return { success: true, ready: false, hasScope, ...explained };
      }
    }
    return { success: true, ready: true, hasScope, setupUrl: chatApiEnableUrl() };
  } catch (err) {
    return { success: false, ...explainChatError(err), setupUrl: chatApiEnableUrl() };
  }
});

ipcMain.handle('gchat-list', async () => {
  try {
    const sess = await requireGoogleSession();
    if (!sess.ok) {
      loadGchatDisk();
      return {
        success: false,
        needsAuth: true,
        error: sess.error || '請重新登入',
        setupUrl: chatApiEnableUrl()
      };
    }
    if (!oauth2Client || !chatService) {
      loadGchatDisk();
      return { ...gchatSnapshot(), offline: !!sess.offline };
    }
    const scope = await grantedScopeText();
    if (!hasChatScopes(scope)) {
      loadGchatDisk();
      return {
        ...gchatSnapshot(),
        success: false,
        needsReauth: true,
        setupUrl: chatApiEnableUrl(),
        error: '尚未授權 Google Chat。請到設定啟用 API 並授權。'
      };
    }
    if (sess.offline) {
      loadGchatDisk();
      return { ...gchatSnapshot(), offline: true };
    }
    gchatCache.syncing = true;
    try {
      await refreshGchatList();
      await notifyNewGchatAlerts();
    } finally {
      gchatCache.syncing = false;
    }
    return gchatSnapshot();
  } catch (err) {
    gchatCache.syncing = false;
    return { success: false, ...explainChatError(err), setupUrl: chatApiEnableUrl() };
  }
});

ipcMain.handle('gchat-refresh', async () => {
  try {
    const sess = await requireGoogleSession();
    if (!sess.ok) {
      return { success: false, needsAuth: true, error: sess.error || '請重新登入' };
    }
    if (!oauth2Client || !chatService) {
      loadGchatDisk();
      return { ...gchatSnapshot(), offline: true };
    }
    const scope = await grantedScopeText();
    if (!hasChatScopes(scope)) {
      return {
        success: false,
        needsReauth: true,
        setupUrl: chatApiEnableUrl(),
        error: '尚未授權 Google Chat'
      };
    }
    if (sess.offline) {
      loadGchatDisk();
      return { ...gchatSnapshot(), offline: true };
    }
    gchatCache.syncing = true;
    await refreshGchatList();
    gchatCache.syncing = false;
    await notifyNewGchatAlerts();
    return gchatSnapshot();
  } catch (err) {
    gchatCache.syncing = false;
    return { success: false, ...explainChatError(err), setupUrl: chatApiEnableUrl() };
  }
});

ipcMain.handle('gchat-detail', async (event, messageName) => {
  try {
    if (!oauth2Client || !chatService) {
      return { success: false, error: '請先用 Google 登入' };
    }

    const listHit = gchatCache.messages.find(m => m.name === messageName)
      || (gchatCache.todayTouched || []).find(m => m.name === messageName);
    const cached = findReadyGchatPacket(messageName, listHit);
    const spaceHint = listHit?.spaceName || cached?.detail?.spaceName || '';
    const hasIdentity = !!(gchatCache.myUserName || (gchatCache.myIds && gchatCache.myIds.length));

    // 同步／今天歷史已打包：先立刻回快取（勿等媒體下載，否則每次都像「重新抓取」）
    if (cached?.historyReady && cached?.detail && Array.isArray(cached.thread)) {
      const detail = { ...cached.detail };
      if (listHit) {
        detail.name = listHit.name || detail.name;
        detail.isDm = listHit.isDm ?? detail.isDm;
        detail.mentionedMe = listHit.mentionedMe ?? detail.mentionedMe;
        detail.spaceType = listHit.spaceType || detail.spaceType;
        detail.spaceDisplayName = listHit.spaceDisplayName || detail.spaceDisplayName;
        detail.snippet = listHit.snippet || detail.snippet;
        detail.createTime = listHit.createTime || detail.createTime;
        detail.createTimeLabel = listHit.createTimeLabel || detail.createTimeLabel;
      }
      if (!hasIdentity) {
        // 身分補齊不阻塞回傳：背景做
        ensureMyChatUserName(detail.spaceName || spaceHint).catch(() => {});
      }
      rememberGchatTodayTouch(detail, { read: true });
      if (detail.name) {
        gchatCache.packets = gchatCache.packets || {};
        gchatCache.packets[detail.name] = {
          detail,
          thread: cached.thread,
          packedAt: cached.packedAt || Date.now(),
          historyReady: true,
          mediaHydrated: !!cached.mediaHydrated
        };
      }
      // 磁碟寫入延後，避免每次點開都卡 I/O
      setTimeout(() => { try { saveGchatDisk(); } catch (_) {} }, 0);

      const threadOut = annotateGchatThreadMine(cached.thread);
      // 背景補圖片；完成後通知開著的回覆窗刷新（泡泡框才能顯示預覽）
      if (!cached.mediaHydrated) {
        ensureThreadMediaHydrated(cached.thread).then(async () => {
          if (Array.isArray(detail.media) && detail.media.length) {
            detail.media = await hydrateChatMedia(detail.media);
          }
          if (gchatCache.packets?.[detail.name]) {
            gchatCache.packets[detail.name].mediaHydrated = true;
            gchatCache.packets[detail.name].detail = detail;
            gchatCache.packets[detail.name].thread = cached.thread;
          }
          notifyOpenGchatThread(detail);
        }).catch(() => {});
      }

      return {
        success: true,
        detail: { ...detail, isMine: isOwnGchatMessage(detail) },
        thread: threadOut,
        myUserName: gchatCache.myUserName || '',
        myIds: gchatCache.myIds || [],
        myLabels: gchatCache.myLabels || [],
        fromCache: true
      };
    }

    await ensureMyChatUserName(spaceHint);

    let detail = null;
    if (cached?.detail) {
      detail = { ...cached.detail };
    } else if (listHit) {
      detail = { ...listHit };
    }

    if (listHit && detail) {
      detail.isDm = listHit.isDm;
      detail.mentionedMe = listHit.mentionedMe;
      detail.spaceType = listHit.spaceType || detail.spaceType;
      detail.spaceDisplayName = listHit.spaceDisplayName || detail.spaceDisplayName;
    }

    if (!detail) {
      const res = await chatService.spaces.messages.get({ name: messageName });
      const parsed = parseChatResource(messageName);
      const spaceLabel = await ensureSpaceDisplayName(parsed.spaceName);
      detail = await normalizeChatMessage(res.data, spaceLabel);
      const meta = await ensureSpaceMeta(parsed.spaceName);
      detail.spaceType = meta.spaceType;
      detail.isDm = meta.spaceType === 'DIRECT_MESSAGE';
      detail.mentionedMe = messageMentionsMe(res.data, await ensureMyChatUserName());
    }

    if (detail?.spaceName && !hasIdentity) {
      await resolveMyChatUserFromSpace(detail.spaceName);
    }
    const packet = await packGchatDetailForItem(detail, { withHistory: true });
    const outDetail = packet?.detail || detail;
    rememberGchatTodayTouch(outDetail, { read: true });
    saveGchatDisk();
    return {
      success: true,
      detail: { ...outDetail, isMine: isOwnGchatMessage(outDetail) },
      thread: annotateGchatThreadMine(packet?.thread || [detail]),
      myUserName: gchatCache.myUserName || '',
      myIds: gchatCache.myIds || [],
      myLabels: gchatCache.myLabels || [],
      fromCache: false
    };
  } catch (err) {
    return { success: false, ...explainChatError(err) };
  }
});

ipcMain.handle('gchat-reply', async (event, payload) => {
  try {
    if (!oauth2Client || !chatService) {
      return { success: false, error: '請先用 Google 登入' };
    }
    const text = String(payload?.text || '').trim();
    const spaceName = payload?.spaceName;
    const attachmentsIn = Array.isArray(payload?.attachments) ? payload.attachments : [];
    if (!spaceName) return { success: false, error: '缺少對話空間' };
    if (!text && !attachmentsIn.length) return { success: false, error: '請輸入回覆內容或附加檔案' };

    const requestBody = {};
    if (text) requestBody.text = text;
    const params = { parent: spaceName, requestBody };
    const replyInThread = payload?.replyInThread === true;
    const quoteMessageName = String(payload?.quoteMessageName || '').trim();
    let quoteLastUpdateTime = String(
      payload?.quoteLastUpdateTime || payload?.quoteCreateTime || ''
    ).trim();
    if (quoteMessageName && !quoteLastUpdateTime) {
      for (const p of Object.values(gchatCache.packets || {})) {
        const hit = (p?.thread || []).find(m => m?.name === quoteMessageName)
          || (p?.detail?.name === quoteMessageName ? p.detail : null);
        if (hit) {
          quoteLastUpdateTime = String(hit.lastUpdateTime || hit.createTime || '');
          if (quoteLastUpdateTime) break;
        }
      }
    }

    // [Important] 引用前言：帶 quotedMessageMetadata，Google Chat 才會顯示引用卡
    if (quoteMessageName && quoteLastUpdateTime) {
      requestBody.quotedMessageMetadata = {
        name: quoteMessageName,
        lastUpdateTime: quoteLastUpdateTime
      };
    } else if (quoteMessageName && !quoteLastUpdateTime) {
      console.warn('引用回覆缺少 lastUpdateTime，改以討論串回覆（無引用卡）');
    }

    if (replyInThread) {
      // 在討論串內回覆（或以此訊息開新串）
      const threadTarget = payload.threadName || payload.messageName || quoteMessageName;
      if (threadTarget) {
        requestBody.thread = { name: threadTarget };
        params.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
      }
    }
    // 未勾選：最外層發言，不帶 thread（仍可帶引用）

    if (attachmentsIn.length) {
      const uploadedList = [];
      for (const file of attachmentsIn.slice(0, 5)) {
        const uploaded = await uploadChatAttachment(spaceName, file);
        if (uploaded) uploadedList.push(uploaded);
      }
      if (uploadedList.length) requestBody.attachment = uploadedList;
    }

    const created = await chatService.spaces.messages.create(params);
    const createdName = created?.data?.name || '';
    if (spaceName) {
      mainGchatAlerted.add(gchatTrackKey({ spaceName, isDm: !!payload.isDm, spaceType: payload.spaceType || '' }) || spaceName);
      recentReplySpaces.set(spaceName, Date.now() + 20000);
    }
    if (createdName) mainGchatAlerted.add(createdName);

    if (payload.messageName) {
      queueGchatMarkRead(payload.messageName, {
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
      try {
        await markChatMessageReadRemote(payload.messageName, {
          createTime: payload.createTime || '',
          threadName: payload.threadName || '',
          spaceName: payload.spaceName || ''
        });
        gchatPending.markRead.delete(payload.messageName);
        gchatLocallyRead.add(payload.messageName);
        saveGchatDisk();
      } catch (err) {
        console.error('回覆後標已讀失敗:', err.message);
      }
    }

    let createdMsg = null;
    try {
      if (created?.data) {
        createdMsg = await normalizeChatMessage(created.data);
        // 自己送出的訊息：記住 Chat 真實 senderName，之後才能左右對齊
        if (created?.data?.sender?.name) {
          rememberMyGchatIdentity(created.data.sender.name);
        } else if (createdMsg?.senderName) {
          rememberMyGchatIdentity(createdMsg.senderName);
        }
        if (createdMsg?.sender) rememberMyGchatLabel(createdMsg.sender);
        createdMsg.isMine = true;
        createdMsg.sender = '我';
        rememberGchatTodayTouch({
          ...(createdMsg || {}),
          spaceName: spaceName || createdMsg?.spaceName,
          threadName: payload.threadName || createdMsg?.threadName || '',
          isDm: !!payload.isDm,
          spaceType: payload.spaceType || createdMsg?.spaceType || '',
          spaceDisplayName: payload.spaceDisplayName || createdMsg?.spaceDisplayName || '',
          sender: payload.sender || createdMsg?.sender || '我',
          snippet: text || createdMsg?.snippet || '[附件]',
          isMine: true
        }, { read: true });
        // [Important] 立刻寫入對話暫存，Little Reply 不必等 10 秒打包
        appendMessageToGchatPacket(createdMsg, {
          spaceName,
          isDm: !!payload.isDm,
          spaceType: payload.spaceType || '',
          spaceDisplayName: payload.spaceDisplayName || '',
          threadName: payload.threadName || createdMsg?.threadName || '',
          sender: payload.sender || ''
        });
        saveGchatDisk();
      }
    } catch (_) {}

    const snap = gchatSnapshot();
    broadcastGchatListUpdate();
    // 開著回覆窗時立刻催刷新，畫面與暫存同步
    if (spaceName) {
      notifyOpenGchatThread({
        spaceName,
        threadName: payload.threadName || createdMsg?.threadName || '',
        name: createdMsg?.name || payload.messageName || '',
        isDm: !!payload.isDm
      });
    }
    return { success: true, created: createdMsg, ...snap };
  } catch (err) {
    return { success: false, ...explainChatError(err) };
  }
});

/** 本人已加的表情 reaction 資源名稱 */
function ensureMyReactionsStore() {
  if (!gchatCache.myReactions || typeof gchatCache.myReactions !== 'object') {
    gchatCache.myReactions = {};
  }
  return gchatCache.myReactions;
}

function getStoredMyReactionName(messageName, unicode) {
  return ensureMyReactionsStore()[messageName]?.[unicode] || '';
}

function setStoredMyReactionName(messageName, unicode, reactionName) {
  const store = ensureMyReactionsStore();
  if (!store[messageName]) store[messageName] = {};
  if (reactionName) store[messageName][unicode] = reactionName;
  else delete store[messageName][unicode];
  if (!Object.keys(store[messageName]).length) delete store[messageName];
}

async function findMyReactionName(messageName, unicode) {
  if (!chatService || !messageName || !unicode) return '';
  const parsed = parseChatResource(messageName);
  const myUser = await ensureMyChatUserName(parsed.spaceName);
  if (!myUser) return '';
  const esc = unicode.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const filter = `emoji.unicode = "${esc}" AND user.name = "${myUser}"`;
  try {
    const res = await chatService.spaces.messages.reactions.list({
      parent: messageName,
      filter,
      pageSize: 1
    });
    return res.data?.reactions?.[0]?.name || '';
  } catch (_) {
    return '';
  }
}

function patchMessageReactionsInCache(messageName, unicode, action) {
  const patch = (m) => {
    if (!m || m.name !== messageName) return m;
    let reactions = Array.isArray(m.reactions) ? m.reactions.map(r => ({ ...r })) : [];
    const idx = reactions.findIndex(r => r.unicode === unicode);
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
      reactions.push({ unicode, customUid: '', label: unicode, count: 1, reactedByMe: true });
    }
    return { ...m, reactions };
  };
  gchatCache.messages = (gchatCache.messages || []).map(patch);
  for (const [key, p] of Object.entries(gchatCache.packets || {})) {
    if (!p?.thread) continue;
    if (!p.thread.some(m => m?.name === messageName) && p.detail?.name !== messageName) continue;
    const thread = (p.thread || []).map(patch);
    const detail = patch(p.detail);
    gchatCache.packets[key] = { ...p, detail, thread };
  }
}

/** 對訊息加／收回表情（Icon 回覆，可 toggle） */
ipcMain.handle('gchat-react', async (_event, payload) => {
  try {
    if (!oauth2Client || !chatService) {
      return { success: false, error: '請先用 Google 登入' };
    }
    const messageName = String(payload?.messageName || '').trim();
    const unicode = String(payload?.unicode || '').trim();
    if (!messageName) return { success: false, error: '缺少訊息' };
    if (!unicode) return { success: false, error: '請選擇表情' };

    const parsed = parseChatResource(messageName);
    await ensureMyChatUserName(parsed.spaceName);

    let reactionName = getStoredMyReactionName(messageName, unicode);
    if (!reactionName) {
      reactionName = await findMyReactionName(messageName, unicode);
      if (reactionName) setStoredMyReactionName(messageName, unicode, reactionName);
    }

    if (reactionName) {
      await chatService.spaces.messages.reactions.delete({ name: reactionName });
      setStoredMyReactionName(messageName, unicode, '');
      patchMessageReactionsInCache(messageName, unicode, 'removed');
      return { success: true, action: 'removed', messageName, unicode };
    }

    try {
      const created = await chatService.spaces.messages.reactions.create({
        parent: messageName,
        requestBody: { emoji: { unicode } }
      });
      const createdName = created.data?.name || '';
      if (createdName) setStoredMyReactionName(messageName, unicode, createdName);
      patchMessageReactionsInCache(messageName, unicode, 'added');
      return { success: true, action: 'added', messageName, unicode, reactionName: createdName };
    } catch (err) {
      const msg = googleErrText(err);
      if (/ALREADY_EXISTS|already exists|duplicate/i.test(msg)) {
        const existing = await findMyReactionName(messageName, unicode);
        if (existing) {
          await chatService.spaces.messages.reactions.delete({ name: existing });
          setStoredMyReactionName(messageName, unicode, '');
          patchMessageReactionsInCache(messageName, unicode, 'removed');
          return { success: true, action: 'removed', messageName, unicode, already: true };
        }
        patchMessageReactionsInCache(messageName, unicode, 'added');
        return { success: true, action: 'added', messageName, unicode, already: true };
      }
      return { success: false, ...explainChatError(err), error: msg || err.message };
    }
  } catch (err) {
    const msg = googleErrText(err);
    return { success: false, ...explainChatError(err), error: msg || err.message };
  }
});

ipcMain.handle('gchat-thread-refresh', async (_event, detail) => {
  try {
    if (!oauth2Client || !chatService) {
      return { success: false, error: '請先用 Google 登入' };
    }
    if (!detail?.spaceName) return { success: false, error: '缺少對話空間' };
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
    const annotated = annotateGchatThreadMine(thread);
    await ensureThreadMediaHydrated(annotated);
    // [Important] Little Reply 即時刷新也寫回暫存，下次點開用最新串
    upsertGchatLivePacket({
      spaceName: detail.spaceName,
      threadName: detail.threadName || '',
      name: detail.name || detail.messageName || '',
      isDm: !!detail.isDm,
      spaceType: detail.spaceType || (detail.isDm ? 'DIRECT_MESSAGE' : ''),
      spaceDisplayName: detail.spaceDisplayName || '',
      sender: detail.sender || ''
    }, annotated);
    setTimeout(() => { try { saveGchatDisk(); } catch (_) {} }, 0);
    return {
      success: true,
      thread: annotated,
      myUserName: gchatCache.myUserName || '',
      myIds: gchatCache.myIds || [],
      myLabels: gchatCache.myLabels || []
    };
  } catch (err) {
    return { success: false, ...explainChatError(err) };
  }
});

function gchatPersonSearchFields(person) {
  const label = person?.names?.[0]?.displayName
    || person?.emailAddresses?.[0]?.value
    || '';
  const emails = (person?.emailAddresses || []).map(e => e?.value).filter(Boolean);
  const phones = (person?.phoneNumbers || []).map(p => String(p?.value || '').replace(/\D/g, '')).filter(Boolean);
  const orgs = (person?.organizations || []).map(o => [o?.title, o?.department, o?.name].filter(Boolean).join(' ')).filter(Boolean);
  const ids = [];
  for (const source of person?.metadata?.sources || []) {
    if (!source?.id) continue;
    ids.push(`users/${source.id}`);
    if (String(source.id).startsWith('c')) ids.push(`users/${String(source.id).slice(1)}`);
  }
  for (const email of emails) ids.push(`users/${email}`);
  const hay = [label, ...emails, ...phones, ...orgs].join(' ').toLowerCase();
  return { label, emails, phones, orgs, ids, hay };
}

function matchGchatQuery(hay, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return false;
  if (hay.includes(q)) return true;
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 2 && hay.replace(/\D/g, '').includes(digits)) return true;
  return false;
}

async function searchGchatContacts(query, limit = 12) {
  const q = String(query || '').trim();
  if (!q) return [];
  const results = [];
  const seen = new Set();
  const push = (item) => {
    const key = item.userName || item.email || item.label;
    if (!key || seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };

  // 本機已解析姓名（含分機常嵌在 displayName）
  for (const [userName, label] of Object.entries(gchatCache.userNames || {})) {
    if (!matchGchatQuery(`${label} ${userName}`, q)) continue;
    push({
      kind: 'contact',
      userName,
      label: label || userName,
      email: userName.includes('@') ? userName.replace(/^users\//, '') : '',
      hint: '通訊錄快取'
    });
    if (results.length >= limit) return results;
  }

  if (peopleService) {
    try {
      const res = await peopleService.people.searchDirectoryPeople({
        query: q,
        readMask: 'names,emailAddresses,organizations,phoneNumbers,metadata',
        sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
        pageSize: Math.min(20, limit)
      });
      for (const person of res.data.people || []) {
        ingestDirectoryPerson(person);
        const f = gchatPersonSearchFields(person);
        if (!f.label && !f.emails.length) continue;
        const userName = f.ids.find(id => id.startsWith('users/') && !id.includes('@'))
          || (f.emails[0] ? `users/${f.emails[0]}` : '')
          || f.ids[0]
          || '';
        push({
          kind: 'contact',
          userName,
          label: f.label || f.emails[0] || userName,
          email: f.emails[0] || '',
          hint: f.orgs[0] || (f.phones[0] ? `分機/電話 ${f.phones[0]}` : '網域通訊錄')
        });
        if (results.length >= limit) break;
      }
    } catch (err) {
      noteDirectoryError(err);
    }
  }
  return results.slice(0, limit);
}

async function listKnownGchatSpaces({ force = false } = {}) {
  if (!chatService) return [];
  if (!force && Array.isArray(gchatCache.spaceList) && gchatCache.spaceListAt
      && Date.now() - gchatCache.spaceListAt < 5 * 60 * 1000) {
    return gchatCache.spaceList;
  }
  const spaces = [];
  let pageToken = '';
  let pages = 0;
  const pull = async (filter) => {
    const res = await chatService.spaces.list({
      pageSize: 100,
      pageToken: pageToken || undefined,
      filter: filter || undefined
    });
    for (const s of res.data.spaces || []) {
      const spaceName = s.name || '';
      if (!spaceName) continue;
      const spaceType = s.spaceType || '';
      const label = s.displayName
        || gchatCache.spaceNames[spaceName]
        || (spaceType === 'DIRECT_MESSAGE' ? '私人訊息' : spaceName.replace('spaces/', ''));
      gchatCache.spaceNames[spaceName] = label;
      gchatCache.spaceTypes[spaceName] = spaceType;
      spaces.push({
        kind: 'space',
        spaceName,
        label,
        spaceType,
        isDm: spaceType === 'DIRECT_MESSAGE'
      });
    }
    pageToken = res.data.nextPageToken || '';
  };
  try {
    do {
      await pull('spaceType = "SPACE" OR spaceType = "GROUP_CHAT" OR spaceType = "DIRECT_MESSAGE"');
      pages += 1;
    } while (pageToken && pages < 8);
  } catch (err) {
    pageToken = '';
    pages = 0;
    do {
      await pull('');
      pages += 1;
    } while (pageToken && pages < 8);
  }
  gchatCache.spaceList = spaces;
  gchatCache.spaceListAt = Date.now();
  return spaces;
}

async function searchGchatSpaces(query, limit = 12) {
  const q = String(query || '').trim();
  if (!q) return [];
  let spaces = [];
  try {
    spaces = await listKnownGchatSpaces();
  } catch (err) {
    console.warn('列出 Chat 空間失敗:', err.message);
  }
  const hits = [];
  for (const s of spaces) {
    if (!matchGchatQuery(`${s.label} ${s.spaceName}`, q)) continue;
    hits.push({
      ...s,
      hint: s.isDm ? '私人訊息' : (s.spaceType === 'GROUP_CHAT' ? '群組' : '空間')
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

async function findOrOpenDmSpace(userName) {
  const name = String(userName || '').trim();
  if (!name) throw new Error('缺少聯絡人');
  const resource = name.startsWith('users/') ? name : `users/${name}`;
  try {
    const found = await chatService.spaces.findDirectMessage({
      requestBody: { name: resource }
    });
    if (found?.data?.name) return found.data;
  } catch (_) {}
  try {
    // 部分客戶端用 name 參數
    const found2 = await chatService.spaces.findDirectMessage({ name: resource });
    if (found2?.data?.name) return found2.data;
  } catch (_) {}
  try {
    const created = await chatService.spaces.setup({
      requestBody: {
        space: { spaceType: 'DIRECT_MESSAGE' },
        memberships: [{ member: { name: resource, type: 'HUMAN' } }]
      }
    });
    return created.data?.space || created.data;
  } catch (err) {
    throw new Error(googleErrText(err) || '無法開啟私人訊息（可能尚未有對話，或需重新授權 Chat）');
  }
}

async function buildOpenSpaceResult(space, extras = {}) {
  const spaceName = space?.name || space?.spaceName || extras.spaceName;
  if (!spaceName) throw new Error('缺少對話空間');
  const isDmHint = !!extras.isDm
    || extras.spaceType === 'DIRECT_MESSAGE'
    || space?.spaceType === 'DIRECT_MESSAGE';

  // 置頂／曾開啟：先走暫存，不先打 meta／歷史 API
  const cached = findReadyGchatPacketBySpace(spaceName, { isDm: isDmHint });
  if (cached?.historyReady && Array.isArray(cached.thread)) {
    const spaceType = extras.spaceType || space?.spaceType || cached.detail?.spaceType || '';
    const isDm = spaceType === 'DIRECT_MESSAGE' || isDmHint || !!cached.detail?.isDm;
    const label = cleanGchatSpaceLabel(
      extras.label
        || space?.displayName
        || cached.detail?.spaceDisplayName
        || gchatCache.spaceNames[spaceName]
        || '對話',
      spaceType,
      isDm
    );
    const detail = {
      ...cached.detail,
      spaceDisplayName: label,
      isDm,
      spaceType: spaceType || cached.detail?.spaceType || ''
    };
    ensureMyChatUserName(spaceName).catch(() => {});
    rememberGchatTodayTouch(detail, { read: true });
    indexGchatPacket({
      ...cached,
      detail,
      historyReady: true
    });
    setTimeout(() => { try { saveGchatDisk(); } catch (_) {} }, 0);
    if (!cached.mediaHydrated) {
      ensureThreadMediaHydrated(cached.thread).then(() => {
        cached.mediaHydrated = true;
      }).catch(() => {});
    }
    return {
      success: true,
      detail: { ...detail, isMine: isOwnGchatMessage(detail) },
      thread: annotateGchatThreadMine(cached.thread),
      myUserName: gchatCache.myUserName || '',
      myIds: gchatCache.myIds || [],
      myLabels: gchatCache.myLabels || [],
      fromCache: true,
      pendingHistory: false
    };
  }

  const metaHint = await ensureSpaceMeta(spaceName).catch(() => ({ label: '', spaceType: '' }));
  const spaceType = space?.spaceType || metaHint.spaceType || extras.spaceType || '';
  const isDm = spaceType === 'DIRECT_MESSAGE' || isDmHint;
  const label = cleanGchatSpaceLabel(
    extras.label || space?.displayName || metaHint.label || gchatCache.spaceNames[spaceName] || '對話',
    spaceType,
    isDm
  );
  if (label) gchatCache.spaceNames[spaceName] = label;
  if (spaceType) gchatCache.spaceTypes[spaceName] = spaceType;

  // 先回傳可輸入的空白殼，歷史背景再撈（搜尋開啟體驗）
  if (extras.deferHistory) {
    ensureMyChatUserName(spaceName).catch(() => {});
    const detail = {
      name: '',
      spaceName,
      spaceDisplayName: label,
      spaceType,
      isDm,
      sender: extras.sender || label,
      senderName: extras.userName || '',
      snippet: '',
      text: '',
      createTime: '',
      createTimeLabel: '',
      threadName: '',
      media: [],
      isMine: false
    };
    return {
      success: true,
      detail,
      thread: [],
      myUserName: gchatCache.myUserName || '',
      myIds: gchatCache.myIds || [],
      myLabels: gchatCache.myLabels || [],
      fromCache: false,
      pendingHistory: true
    };
  }

  await ensureMyChatUserName(spaceName);
  const packet = await packGchatSpaceHistory(spaceName, {
    label,
    isDm,
    spaceType,
    userName: extras.userName || '',
    sender: extras.sender || label
  });
  const detail = packet?.detail || { spaceName, spaceDisplayName: label, isDm, spaceType };
  rememberGchatTodayTouch(detail, { read: true });
  saveGchatDisk();
  return {
    success: true,
    detail,
    thread: packet?.thread || [detail],
    myUserName: gchatCache.myUserName || '',
    myIds: gchatCache.myIds || [],
    myLabels: gchatCache.myLabels || [],
    fromCache: false,
    pendingHistory: false
  };
}

ipcMain.handle('gchat-search', async (_event, payload) => {
  try {
    if (!oauth2Client || !chatService) {
      return { success: false, error: '請先用 Google 登入', contacts: [], spaces: [] };
    }
    const query = String(payload?.query || '').trim();
    if (!query) return { success: true, contacts: [], spaces: [] };
    const [contacts, spaces] = await Promise.all([
      searchGchatContacts(query, 12),
      searchGchatSpaces(query, 12)
    ]);
    return { success: true, contacts, spaces, directoryError: gchatCache.directoryError || '' };
  } catch (err) {
    return { success: false, error: googleErrText(err) || err.message, contacts: [], spaces: [] };
  }
});

ipcMain.handle('gchat-open-space', async (_event, payload) => {
  try {
    if (!oauth2Client || !chatService) {
      return { success: false, error: '請先用 Google 登入' };
    }
    let spaceName = String(payload?.spaceName || '').trim();
    let space = null;
    if (!spaceName && payload?.userName) {
      // 置頂私人若已解過 spaceName，免再打 findOrOpen
      try {
        const pin = (loadGchatPrefs().pinnedContacts || []).find(c => c.userName === payload.userName);
        if (pin?.spaceName) spaceName = pin.spaceName;
      } catch (_) {}
    }
    if (!spaceName && payload?.userName) {
      space = await findOrOpenDmSpace(payload.userName);
      spaceName = space?.name || '';
      // 回寫置頂聯絡人 spaceName，利於之後暫存／開啟
      if (spaceName) {
        try {
          const prefs = loadGchatPrefs();
          const list = [...(prefs.pinnedContacts || [])];
          const idx = list.findIndex(x => x.userName === payload.userName);
          if (idx >= 0 && !list[idx].spaceName) {
            list[idx] = { ...list[idx], spaceName };
            saveGchatPrefs({ ...prefs, pinnedContacts: list });
          }
        } catch (_) {}
      }
    }
    if (!spaceName) return { success: false, error: '找不到對話空間' };
    if (!space) space = { name: spaceName, spaceType: payload?.spaceType || '', displayName: payload?.label || '' };
    return await buildOpenSpaceResult(space, {
      spaceName,
      label: payload?.label || '',
      isDm: !!payload?.isDm || payload?.spaceType === 'DIRECT_MESSAGE' || !!payload?.userName,
      spaceType: payload?.spaceType || space.spaceType || '',
      userName: payload?.userName || '',
      sender: payload?.label || '',
      deferHistory: !!payload?.deferHistory
    });
  } catch (err) {
    return { success: false, ...explainChatError(err), error: googleErrText(err) || err.message };
  }
});

ipcMain.handle('gchat-pin-toggle', async (_event, payload) => {
  try {
    const prefs = loadGchatPrefs();
    const kind = String(payload?.kind || '').trim();
    let justPinned = false;
    if (kind === 'contact') {
      const userName = String(payload?.userName || '').trim();
      if (!userName) return { success: false, error: '缺少聯絡人' };
      const list = [...(prefs.pinnedContacts || [])];
      const idx = list.findIndex(x => x.userName === userName);
      if (idx >= 0) list.splice(idx, 1);
      else {
        justPinned = true;
        let spaceName = String(payload?.spaceName || '').trim();
        if (!spaceName && chatService) {
          try {
            const sp = await findOrOpenDmSpace(userName);
            spaceName = sp?.name || '';
          } catch (_) {}
        }
        list.unshift({
          userName,
          label: String(payload?.label || userName).trim(),
          email: String(payload?.email || '').trim(),
          spaceName: spaceName || '',
          pinnedAt: Date.now()
        });
      }
      const next = saveGchatPrefs({ ...prefs, pinnedContacts: list.slice(0, 40) });
      broadcastGchatListUpdate();
      if (justPinned) {
        setTimeout(() => {
          packPinnedGchatConversations()
            .then(() => { try { saveGchatDisk(); } catch (_) {} })
            .catch(() => {});
        }, 0);
      }
      return { success: true, ...next, ...gchatSnapshot() };
    }
    if (kind === 'space') {
      const spaceName = String(payload?.spaceName || '').trim();
      if (!spaceName) return { success: false, error: '缺少群組' };
      const list = [...(prefs.pinnedSpaces || [])];
      const idx = list.findIndex(x => x.spaceName === spaceName);
      if (idx >= 0) list.splice(idx, 1);
      else {
        justPinned = true;
        list.unshift({
          spaceName,
          label: String(payload?.label || spaceName).trim(),
          spaceType: String(payload?.spaceType || '').trim(),
          isDm: !!payload?.isDm,
          pinnedAt: Date.now()
        });
      }
      const next = saveGchatPrefs({ ...prefs, pinnedSpaces: list.slice(0, 40) });
      broadcastGchatListUpdate();
      if (justPinned) {
        setTimeout(() => {
          packPinnedGchatConversations()
            .then(() => { try { saveGchatDisk(); } catch (_) {} })
            .catch(() => {});
        }, 0);
      }
      return { success: true, ...next, ...gchatSnapshot() };
    }
    return { success: false, error: '未知置頂類型' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('gchat-mark-read', async (event, payload) => {
  try {
    const messageName = typeof payload === 'string' ? payload : payload?.name;
    if (!messageName) return { success: false, error: '缺少訊息' };
    const p = typeof payload === 'object' && payload ? payload : {};
    return await markGchatConversationReadByName(messageName, p);
  } catch (err) {
    return { success: false, ...explainChatError(err) };
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
  fs.writeFileSync(geminiConfigPath(), JSON.stringify({
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
    sqlTrustCert: cfg.sqlTrustCert === undefined ? current.sqlTrustCert !== false : !!cfg.sqlTrustCert
  }));
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
    try { app.setUserTasks([]); } catch (_) {}
    loadAppTheme();
    createWindow();
    startSessionWatch();
    // 登入後若已開提醒，背景輪詢會在 renderer 呼叫 gchat-alert-watch 啟動
    setupAutoUpdater();
  });
}

let allowingQuit = false;
app.on('before-quit', (e) => {
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
    return String(app.getVersion?.() || require('./package.json').version || '0.0.0');
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
