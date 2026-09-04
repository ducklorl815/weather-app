/**
 * GChat IPC — Inbox / 狀態 / 手動刷新
 */

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../index').GchatIpcDeps} deps
 */
function registerInboxHandlers(ipcMain, deps) {
  const inbox = deps.inbox;

  ipcMain.handle('gchat-status', async () => {
    try {
      if (!inbox.isChatReady()) {
        return { success: false, error: '請先用 Google 登入' };
      }
      const scope = await inbox.getScope();
      const hasScope = inbox.hasChatScopes(scope);
      if (!hasScope) {
        return {
          success: true,
          ready: false,
          hasScope: false,
          needsReauth: true,
          setupUrl: inbox.setupUrl()
        };
      }
      try {
        await inbox.probeUnread();
      } catch (err) {
        const explained = inbox.explainError(err);
        if (explained.needsApi || explained.needsReauth) {
          return { success: true, ready: false, hasScope, ...explained };
        }
      }
      return { success: true, ready: true, hasScope, setupUrl: inbox.setupUrl() };
    } catch (err) {
      return { success: false, ...inbox.explainError(err), setupUrl: inbox.setupUrl() };
    }
  });

  ipcMain.handle('gchat-list', async () => {
    try {
      const sess = await inbox.requireSession();
      if (!sess.ok) {
        inbox.loadDisk();
        return {
          success: false,
          needsAuth: true,
          error: sess.error || '請重新登入',
          setupUrl: inbox.setupUrl()
        };
      }
      inbox.loadDisk();
      if (!inbox.isChatReady()) {
        return { ...inbox.snapshot(), offline: !!sess.offline };
      }
      const scope = await inbox.getScope();
      if (!inbox.hasChatScopes(scope)) {
        return {
          ...inbox.snapshot(),
          success: false,
          needsReauth: true,
          setupUrl: inbox.setupUrl(),
          error: '尚未授權 Google Chat。請到設定啟用 API 並授權。'
        };
      }
      if (sess.offline) {
        return { ...inbox.snapshot(), offline: true };
      }
      return inbox.snapshot();
    } catch (err) {
      return { success: false, ...inbox.explainError(err), setupUrl: inbox.setupUrl() };
    }
  });

  ipcMain.handle('gchat-refresh', async () => {
    try {
      const sess = await inbox.requireSession();
      if (!sess.ok) {
        return { success: false, needsAuth: true, error: sess.error || '請重新登入' };
      }
      if (!inbox.isChatReady()) {
        inbox.loadDisk();
        return { ...inbox.snapshot(), offline: true };
      }
      const scope = await inbox.getScope();
      if (!inbox.hasChatScopes(scope)) {
        return {
          success: false,
          needsReauth: true,
          setupUrl: inbox.setupUrl(),
          error: '尚未授權 Google Chat'
        };
      }
      if (sess.offline) {
        inbox.loadDisk();
        return { ...inbox.snapshot(), offline: true };
      }
      await inbox.syncInbox();
      return inbox.snapshot();
    } catch (err) {
      inbox.onSyncError?.();
      return { success: false, ...inbox.explainError(err), setupUrl: inbox.setupUrl() };
    }
  });
}

module.exports = { registerInboxHandlers };
