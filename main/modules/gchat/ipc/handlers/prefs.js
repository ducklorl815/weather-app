/**
 * GChat IPC — 使用者偏好（prefs）
 */

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../index').GchatIpcDeps} deps
 */
function registerPrefsHandlers(ipcMain, deps) {
  ipcMain.handle('gchat-get-prefs', async () => {
    try {
      return { success: true, ...deps.prefs.load() };
    } catch (err) {
      return { success: false, alertPopup: true, error: err.message };
    }
  });

  ipcMain.handle('gchat-save-prefs', async (_event, prefs) => {
    try {
      const next = deps.prefs.save(prefs || {});
      deps.onPrefsSaved?.(prefs, next);
      return { success: true, ...next };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerPrefsHandlers };
