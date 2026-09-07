/**
 * GChat IPC — UI 視窗 / Toast / Bar / Viewing / 設定連結
 */

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../index').GchatIpcDeps} deps
 */
function registerUiHandlers(ipcMain, deps) {
  const ui = deps.ui;

  ipcMain.handle('gchat-show-toast', async (_event, message) => ui.showToast(message));

  ipcMain.handle('gchat-toast-hide', async () => {
    ui.hideToast();
    return { success: true };
  });

  ipcMain.handle('gchat-toast-resize', async (_event, height) => {
    ui.resizeToast(height);
    return { success: true };
  });

  ipcMain.handle('gchat-toast-open', async (_event, messageName) => {
    if (!messageName) return { success: false };
    ui.hideToast();
    // [Important] Phase 2A：標已讀前先快照 readUntil，供 firstUnread 定位
    let readUntilBeforeOpen = '';
    try {
      readUntilBeforeOpen = await ui.snapshotReadUntilForMessage?.(messageName) || '';
    } catch (_) {}
    try {
      await ui.markConversationRead(messageName);
    } catch (err) {
      console.warn('泡泡開啟標已讀失敗:', err.message);
    }
    // ADR-0005：Toast 與 Bar 同一套 Alert Anchor 落地
    if (typeof ui.openFromAlertAnchor === 'function') {
      return ui.openFromAlertAnchor(messageName, {
        skipMarkRead: true,
        readUntil: readUntilBeforeOpen
      });
    }
    return ui.openCompactReply(messageName, { skipMarkRead: true, readUntil: readUntilBeforeOpen });
  });

  ipcMain.handle('gchat-compact-open', async (_event, payload) => {
    const messageName = typeof payload === 'string' ? payload : (payload?.messageName || payload?.name || '');
    const spaceName = typeof payload === 'object' ? (payload?.spaceName || '') : '';
    const userName = typeof payload === 'object' ? (payload?.userName || '') : '';
    if (!messageName && !spaceName && !userName) return { success: false };
    ui.hideToast();

    const payloadReadUntil = typeof payload === 'object' ? String(payload?.readUntil || '').trim() : '';
    let readUntilBeforeOpen = payloadReadUntil;
    if (!readUntilBeforeOpen && messageName) {
      try {
        readUntilBeforeOpen = await ui.snapshotReadUntilForMessage?.(messageName) || '';
      } catch (_) {}
    }
    if (!readUntilBeforeOpen) {
      readUntilBeforeOpen = ui.snapshotReadUntilBeforeOpen?.({ spaceName }) || '';
    }

    if (messageName && !payload?.focusThread && !payload?.skipMarkRead) {
      try {
        await ui.markConversationRead(messageName, { spaceName, isDm: !!payload?.isDm });
      } catch (_) {}
    } else if (spaceName && !payload?.focusThread && !payload?.skipMarkRead) {
      try {
        await ui.markSpaceRead(spaceName, { isDm: !!payload?.isDm });
      } catch (_) {}
    }
    return ui.openCompactReply(messageName, {
      spaceName,
      title: typeof payload === 'object' ? (payload?.title || '') : '',
      isDm: typeof payload === 'object' ? !!payload?.isDm : undefined,
      userName: typeof payload === 'object' ? (payload?.userName || '') : '',
      iconUrl: typeof payload === 'object' ? (payload?.iconUrl || '') : '',
      emoji: typeof payload === 'object' ? (payload?.emoji || '') : '',
      threadName: typeof payload === 'object' ? (payload?.threadName || '') : '',
      focusThread: typeof payload === 'object' ? !!payload?.focusThread : false,
      focusRootText: typeof payload === 'object' ? (payload?.focusRootText || payload?.rootText || '') : '',
      rootMessageName: typeof payload === 'object' ? (payload?.rootMessageName || '') : '',
      readUntil: readUntilBeforeOpen,
      jumpToMessage: typeof payload === 'object' ? !!payload?.jumpToMessage : false,
      skipMarkRead: true
    });
  });

  ipcMain.handle('gchat-compact-close', async (event, messageName) => {
    const fromWin = ui.getWindowFromEvent(event);
    const entry = ui.findReplyEntry({
      win: fromWin,
      messageName: messageName || '',
      spaceName: ''
    }) || (messageName ? ui.getReplyPopEntry(messageName) : null)
      || (ui.getActiveReplyPopMessageName() ? ui.getReplyPopEntry(ui.getActiveReplyPopMessageName()) : null);
    if (entry) {
      await ui.closeReplyCompletely(entry);
    } else if (fromWin && !fromWin.isDestroyed() && fromWin !== ui.getMainWindow()) {
      fromWin.close();
    }
    const closedName = entry?.messageName || messageName || '';
    ui.clearViewingIfClosed(closedName, entry);
    ui.syncOverlayZOrder();
    return { success: true };
  });

  ipcMain.handle('gchat-compact-minimize', async (event, payload) => {
    const fromWin = ui.getWindowFromEvent(event);
    const messageName = payload?.messageName || '';
    const entry = ui.findReplyEntry({
      win: fromWin,
      messageName,
      spaceName: payload?.spaceName || ''
    }) || (messageName ? ui.getReplyPopEntry(messageName) : null)
      || (ui.getActiveReplyPopMessageName() ? ui.getReplyPopEntry(ui.getActiveReplyPopMessageName()) : null);
    if (!entry) return { success: false, error: '找不到回覆窗' };
    if (payload?.isDm != null) entry.isDm = !!payload.isDm;
    return ui.minimizeReply(entry, payload?.title || entry.title || '');
  });

  ipcMain.handle('gchat-compact-restore', async (event, messageName) => {
    const fromWin = ui.getWindowFromEvent(event);
    const entry = ui.findReplyEntry({
      win: fromWin,
      messageName: messageName || '',
      spaceName: ''
    }) || (messageName ? ui.getReplyPopEntry(messageName) : null)
      || (ui.getActiveReplyPopMessageName() ? ui.getReplyPopEntry(ui.getActiveReplyPopMessageName()) : null);
    if (!entry) return { success: false };
    ui.setActiveReplyPop(entry.messageName, entry.win);
    return ui.restoreReply(entry);
  });

  ipcMain.handle('gchat-compact-toggle-fullscreen', async (event) => {
    const fromWin = ui.getWindowFromEvent(event);
    const entry = ui.findReplyEntry({ win: fromWin });
    if (!entry) return { success: false, error: '找不到回覆窗' };
    return ui.toggleReplyFullscreen(entry);
  });

  ipcMain.handle('gchat-compact-set-title', async (event, payload) => {
    const fromWin = ui.getWindowFromEvent(event);
    const messageName = payload?.messageName || ui.getActiveReplyPopMessageName();
    const entry = ui.findReplyEntry({
      win: fromWin,
      messageName,
      spaceName: ''
    });
    if (!entry) return { success: false };
    return ui.applyCompactTitle(fromWin, payload);
  });

  ipcMain.handle('gchat-compact-open-main', async (event, messageName) => {
    const fromWin = ui.getWindowFromEvent(event);
    const entry = ui.findReplyEntry({ win: fromWin, messageName });
    if (!entry) return { success: false };
    const mainWin = ui.getMainWindow();
    if (!mainWin || mainWin.isDestroyed()) return { success: false };
    try {
      mainWin.show();
      mainWin.focus();
      mainWin.webContents.send('gchat-open-message', messageName || entry.messageName);
    } catch (_) {}
    return { success: true };
  });

  ipcMain.handle('gchat-bar-click', async (_event, convKey) => {
    return ui.toggleReplyFromBar(String(convKey || ''));
  });

  ipcMain.handle('gchat-bar-close', async (_event, convKey) => {
    return ui.closeReplyCompletely(String(convKey || ''));
  });

  ipcMain.handle('gchat-bar-state', async (_event, convKey) => {
    const entry = ui.findReplyEntry({ convKey: String(convKey || '') });
    if (!entry) return null;
    return {
      convKey: ui.entryConvKey(entry),
      title: entry.title || 'Little Reply',
      badge: Number(entry.unreadBadge || 0) || 0,
      bubbleOpen: !entry.minimized && !!(entry.win && !entry.win.isDestroyed() && entry.win.isVisible()),
      theme: ui.getAppTheme(),
      iconUrl: entry.iconUrl || '',
      emoji: entry.emoji || ''
    };
  });

  ipcMain.handle('gchat-set-viewing', async (_event, ctx) => ui.setViewing(ctx));

  ipcMain.handle('gchat-alert-watch', async (_event, enabled) => ui.alertWatch(enabled));

  ipcMain.handle('gchat-open-setup', async () => {
    const url = ui.setupUrl();
    await ui.openExternal(url);
    return { success: true, url };
  });

  ipcMain.handle('gchat-open-app-config', async () => {
    const url = ui.appConfigUrl();
    await ui.openExternal(url);
    return { success: true, url };
  });

  ipcMain.handle('gchat-open-admin-setup', async () => {
    const url = ui.adminSetupUrl();
    await ui.openExternal(url);
    return { success: true, url };
  });
}

module.exports = { registerUiHandlers };
