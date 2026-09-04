const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ---------------------------------------------------------------------------
  // Shell：Partial View（「加入功能」載入 renderer/features/<type>/view.html）
  // ---------------------------------------------------------------------------
  loadFeaturePartial: (type) => ipcRenderer.invoke('load-feature-partial', type),

  // 系統與登入功能
  fetchWeather: (url) => ipcRenderer.invoke('fetch-weather', url),
  checkLogin: () => ipcRenderer.invoke('check-login'),
  ensureSession: () => ipcRenderer.invoke('ensure-session'),
  reconnectGoogle: () => ipcRenderer.invoke('reconnect-google'),
  credentialProbe: () => ipcRenderer.invoke('credential-probe'),
  featureAuthStatus: (type) => ipcRenderer.invoke('feature-auth-status', type),
  authGoogleFeature: (type) => ipcRenderer.invoke('auth-google-feature', type),
  authGoogleFeatures: (types) => ipcRenderer.invoke('auth-google-features', types),
  onSessionStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('session-status', listener);
    return () => ipcRenderer.removeListener('session-status', listener);
  },
  authGoogle: () => ipcRenderer.invoke('auth-google'),
  authGoogleSheets: () => ipcRenderer.invoke('auth-google-sheets'),
  authGoogleChat: () => ipcRenderer.invoke('auth-google-chat'),
  sheetsOpenSetup: (payload) => ipcRenderer.invoke('sheets-open-setup', payload),
  sheetsStatus: () => ipcRenderer.invoke('sheets-status'),
  gchatOpenSetup: () => ipcRenderer.invoke('gchat-open-setup'),
  gchatOpenAppConfig: () => ipcRenderer.invoke('gchat-open-app-config'),
  gchatOpenAdminSetup: () => ipcRenderer.invoke('gchat-open-admin-setup'),
  gchatStatus: () => ipcRenderer.invoke('gchat-status'),
  gchatList: () => ipcRenderer.invoke('gchat-list'),
  gchatRefresh: () => ipcRenderer.invoke('gchat-refresh'),
  gchatDetail: (messageName) => ipcRenderer.invoke('gchat-detail', messageName),
  gchatReply: (payload) => ipcRenderer.invoke('gchat-reply', payload),
  gchatReact: (payload) => ipcRenderer.invoke('gchat-react', payload),
  gchatCustomEmojis: () => ipcRenderer.invoke('gchat-custom-emojis'),
  gchatThreadRefresh: (detail) => ipcRenderer.invoke('gchat-thread-refresh', detail),
  gchatMarkRead: (payload) => ipcRenderer.invoke('gchat-mark-read', payload),
  gchatSearch: (payload) => ipcRenderer.invoke('gchat-search', payload),
  gchatSpaceMembers: (payload) => ipcRenderer.invoke('gchat-space-members', payload),
  getCursorPoint: () => ipcRenderer.invoke('get-cursor-point'),
  gchatQuickSearchShow: () => ipcRenderer.invoke('gchat-quick-search-show'),
  gchatQuickSearchHide: () => ipcRenderer.invoke('gchat-quick-search-hide'),
  gchatOpenSpace: (payload) => ipcRenderer.invoke('gchat-open-space', payload),
  gchatPinToggle: (payload) => ipcRenderer.invoke('gchat-pin-toggle', payload),
  gchatGetPrefs: () => ipcRenderer.invoke('gchat-get-prefs'),
  gchatSavePrefs: (prefs) => ipcRenderer.invoke('gchat-save-prefs', prefs),
  gchatShowToast: (message) => ipcRenderer.invoke('gchat-show-toast', message),
  gchatToastHide: () => ipcRenderer.invoke('gchat-toast-hide'),
  gchatToastResize: (height) => ipcRenderer.invoke('gchat-toast-resize', height),
  gchatToastOpen: (name) => ipcRenderer.invoke('gchat-toast-open', name),
  gchatCompactOpen: (payload) => ipcRenderer.invoke('gchat-compact-open', payload),
  gchatAlertWatch: (enabled) => ipcRenderer.invoke('gchat-alert-watch', enabled),
  gchatSetViewing: (ctx) => ipcRenderer.invoke('gchat-set-viewing', ctx),
  gchatCompactClose: () => ipcRenderer.invoke('gchat-compact-close'),
  gchatCompactCloseNamed: (messageName) => ipcRenderer.invoke('gchat-compact-close', messageName),
  gchatCompactMinimize: (payload) => ipcRenderer.invoke('gchat-compact-minimize', payload),
  gchatCompactRestore: (messageName) => ipcRenderer.invoke('gchat-compact-restore', messageName),
  gchatCompactToggleFullscreen: () => ipcRenderer.invoke('gchat-compact-toggle-fullscreen'),
  gchatCompactSetTitle: (payload) => ipcRenderer.invoke('gchat-compact-set-title', payload),
  gchatBarClick: (convKey) => ipcRenderer.invoke('gchat-bar-click', convKey),
  gchatBarClose: (convKey) => ipcRenderer.invoke('gchat-bar-close', convKey),
  gchatBarState: (convKey) => ipcRenderer.invoke('gchat-bar-state', convKey),
  onGchatBarUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('gchat-bar-update', listener);
    return () => ipcRenderer.removeListener('gchat-bar-update', listener);
  },
  getAppTheme: () => ipcRenderer.invoke('get-app-theme'),
  setAppTheme: (theme) => ipcRenderer.invoke('set-app-theme', theme),
  onAppTheme: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on('app-theme', listener);
    return () => ipcRenderer.removeListener('app-theme', listener);
  },
  getAppFontScale: () => ipcRenderer.invoke('get-app-font-scale'),
  setAppFontScale: (scale) => ipcRenderer.invoke('set-app-font-scale', scale),
  onAppFontScale: (callback) => {
    const listener = (_event, scale) => callback(scale);
    ipcRenderer.on('app-font-scale', listener);
    return () => ipcRenderer.removeListener('app-font-scale', listener);
  },
  onFeatureSyncTick: (callback) => {
    const listener = (_event, type) => callback(type);
    ipcRenderer.on('feature-sync-tick', listener);
    return () => ipcRenderer.removeListener('feature-sync-tick', listener);
  },
  onFeaturesSynced: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('features-synced', listener);
    return () => ipcRenderer.removeListener('features-synced', listener);
  },
  onGchatCompactMode: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('gchat-compact-mode', listener);
    return () => ipcRenderer.removeListener('gchat-compact-mode', listener);
  },
  onGchatCompactIcon: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('gchat-compact-icon', listener);
    return () => ipcRenderer.removeListener('gchat-compact-icon', listener);
  },
  gchatCompactOpenMain: (name) => ipcRenderer.invoke('gchat-compact-open-main', name),
  onGchatCompactLoad: (callback) => {
    const listener = (_event, name) => callback(name);
    ipcRenderer.on('gchat-compact-load', listener);
    return () => ipcRenderer.removeListener('gchat-compact-load', listener);
  },
  onGchatQuickSearchOpen: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('gchat-quick-search-open', listener);
    return () => ipcRenderer.removeListener('gchat-quick-search-open', listener);
  },
  onGchatScrollOpen: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('gchat-scroll-open', listener);
    return () => ipcRenderer.removeListener('gchat-scroll-open', listener);
  },
  onGchatToastPush: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('gchat-toast-push', listener);
    return () => ipcRenderer.removeListener('gchat-toast-push', listener);
  },
  onGchatToastDismiss: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('gchat-toast-dismiss', listener);
    return () => ipcRenderer.removeListener('gchat-toast-dismiss', listener);
  },
  onGchatOpenMessage: (callback) => {
    const listener = (_event, name) => callback(name);
    ipcRenderer.on('gchat-open-message', listener);
    return () => ipcRenderer.removeListener('gchat-open-message', listener);
  },
  // [Temporary] gchat-list-updated 已停發；保留 no-op 避免舊訂閱報錯
  onGchatListUpdated: (_callback) => () => {},
  onGchatCacheChanged: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('gchat-cache-changed', listener);
    return () => ipcRenderer.removeListener('gchat-cache-changed', listener);
  },
  onGchatThreadPing: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('gchat-thread-ping', listener);
    return () => ipcRenderer.removeListener('gchat-thread-ping', listener);
  },
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowShow: () => ipcRenderer.invoke('window-show'),
  appQuit: () => ipcRenderer.invoke('app-quit'),
  logout: () => ipcRenderer.send('logout'),
  getOpenAtLogin: () => ipcRenderer.invoke('get-open-at-login'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('set-open-at-login', enabled),
  getAppMode: () => ipcRenderer.invoke('get-app-mode'),
  getDistFeatures: () => ipcRenderer.invoke('get-dist-features'),
  setDistFeature: (payload) => ipcRenderer.invoke('set-dist-feature', payload),
  appGetVersion: () => ipcRenderer.invoke('app-get-version'),
  appGetUpdateStatus: () => ipcRenderer.invoke('app-get-update-status'),
  appCheckUpdate: (payload) => ipcRenderer.invoke('app-check-update', payload),
  appDownloadUpdate: () => ipcRenderer.invoke('app-download-update'),
  appInstallUpdate: () => ipcRenderer.invoke('app-install-update'),
  onAppUpdateStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('app-update-status', listener);
    return () => ipcRenderer.removeListener('app-update-status', listener);
  },
  openExternal: (url) => ipcRenderer.send('open-url', url),
  sheetsListSources: () => ipcRenderer.invoke('sheets-list-sources'),
  sheetsAddSource: (payload) => ipcRenderer.invoke('sheets-add-source', payload),
  sheetsRemoveSource: (id) => ipcRenderer.invoke('sheets-remove-source', id),
  sheetsInbox: () => ipcRenderer.invoke('sheets-inbox'),
  sheetsSaveNote: (payload) => ipcRenderer.invoke('sheets-save-note', payload),
  sheetsMarkDone: (payload) => ipcRenderer.invoke('sheets-mark-done', payload),
  bugReportSubmit: (payload) => ipcRenderer.invoke('bug-report-submit', payload),
  bugReportList: () => ipcRenderer.invoke('bug-report-list'),
  bugReportFeatures: () => ipcRenderer.invoke('bug-report-features'),
  bugReportSetStatus: (payload) => ipcRenderer.invoke('bug-report-set-status', payload),
  bugReportOpenSheet: () => ipcRenderer.invoke('bug-report-open-sheet'),
  bugReportSetSheet: (payload) => ipcRenderer.invoke('bug-report-set-sheet', payload),
  sitesVisitsGetConfig: () => ipcRenderer.invoke('sites-visits-get-config'),
  sitesVisitsSaveConfig: (payload) => ipcRenderer.invoke('sites-visits-save-config', payload),
  sitesVisitsAddProject: (payload) => ipcRenderer.invoke('sites-visits-add-project', payload),
  sitesVisitsRemoveProject: (id) => ipcRenderer.invoke('sites-visits-remove-project', id),
  sitesVisitsTrackerScript: () => ipcRenderer.invoke('sites-visits-tracker-script'),
  sitesVisitsBuildLinks: (payload) => ipcRenderer.invoke('sites-visits-build-links', payload),
  sitesVisitsOpenLogSheet: () => ipcRenderer.invoke('sites-visits-open-log-sheet'),
  sitesVisitsExportTracker: () => ipcRenderer.invoke('sites-visits-export-tracker'),
  sitesVisitsReport: (payload) => ipcRenderer.invoke('sites-visits-report', payload),
  sitesVisitsSaveColumnPrefs: (payload) => ipcRenderer.invoke('sites-visits-save-column-prefs', payload),
  sitesVisitsExportExcel: (payload) => ipcRenderer.invoke('sites-visits-export-excel', payload),
  sitesVisitsDeptOrgOpen: () => ipcRenderer.invoke('sites-visits-dept-org-open'),
  sitesVisitsDeptOrgGet: () => ipcRenderer.invoke('sites-visits-dept-org-get'),
  sitesVisitsDeptOrgMove: (payload) => ipcRenderer.invoke('sites-visits-dept-org-move', payload),
  sitesVisitsDeptOrgExport: (payload) => ipcRenderer.invoke('sites-visits-dept-org-export', payload),
  sitesVisitsClearLocal: () => ipcRenderer.invoke('sites-visits-clear-local'),
  sitesVisitsRecord: (payload) => ipcRenderer.invoke('sites-visits-record', payload),
  sitesVisitsOpenTrack: (projectId) => ipcRenderer.invoke('sites-visits-open-track', projectId),

  // Tasks (待辦事項)
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  addTask: (payload) => ipcRenderer.invoke('add-task', payload),
  updateTask: (taskId, fields) => ipcRenderer.invoke('update-task', taskId, fields),

  // Calendar (日曆)
  getCalendar: () => ipcRenderer.invoke('get-calendar'),
  // ✨ 新增的建立行程通道
  createCalendarEvent: (eventDetails) => ipcRenderer.invoke('calendar:createEvent', eventDetails),

  // Gmail (郵件)
  getGmail: (labelId) => ipcRenderer.invoke('get-gmail', labelId),
  getGmailDetail: (msgId) => ipcRenderer.invoke('get-gmail-detail', msgId),
  replyGmail: (replyData) => ipcRenderer.invoke('reply-gmail', replyData),
  markGmailRead: (msgId) => ipcRenderer.invoke('mark-gmail-read', msgId),
  getContacts: () => ipcRenderer.invoke('get-contacts'),
  geminiGetConfig: () => ipcRenderer.invoke('gemini-get-config'),
  geminiSaveConfig: (cfg) => ipcRenderer.invoke('gemini-save-config', cfg),
  knowledgeList: () => ipcRenderer.invoke('knowledge-list'),
  knowledgeAdd: () => ipcRenderer.invoke('knowledge-add'),
  knowledgeRemove: (id) => ipcRenderer.invoke('knowledge-remove', id),
  knowledgeSearch: (query) => ipcRenderer.invoke('knowledge-search', query),
  chatAsk: (payload) => ipcRenderer.invoke('chat-ask', payload),
  reportTables: () => ipcRenderer.invoke('report-tables'),
  reportSaveTable: (table) => ipcRenderer.invoke('report-save-table', table),
  reportPresets: () => ipcRenderer.invoke('report-presets'),
  reportRun: (payload) => ipcRenderer.invoke('report-run', payload),
  onGmailPacket: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('gmail-packet', listener);
    return () => ipcRenderer.removeListener('gmail-packet', listener);
  }
});
