/**
 * GChat IPC — 訊息詳情 / 討論串刷新
 */

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../index').GchatIpcDeps} deps
 */
function registerDetailHandlers(ipcMain, deps) {
  const detail = deps.detail;

  ipcMain.handle('gchat-detail', async (_event, arg) => {
    try {
      if (!detail.isChatReady()) {
        return { success: false, error: '請先用 Google 登入' };
      }

      const opts = typeof arg === 'string' ? { messageName: arg } : (arg || {});
      const messageName = String(opts.messageName || opts.name || '').trim();
      const cacheOnly = !!opts.cacheOnly;
      if (!messageName) return { success: false, error: '缺少訊息' };

      const detailCache = detail.getDetailCache();
      const resolved = detailCache.resolveMessagePacket(messageName);
      const cached = resolved.cached;
      const listHit = resolved.listHit;
      const spaceHint = listHit?.spaceName || cached?.detail?.spaceName || '';
      const isUnread = detail.isMessageUnread(messageName);
      const isPinned = detail.isPinnedSpace(spaceHint);
      const hasIdentity = detail.hasIdentity();

      if (cacheOnly) {
        if (detailCache.canServePacket(cached, listHit)) {
          detailCache.logCacheHit('detail', messageName);
          if (!hasIdentity) {
            detail.ensureMyUserName(spaceHint).catch(() => {});
          }
          return await detail.buildDetailResponse(cached, listHit, { fromCache: true });
        }
        return { success: false, cached: false };
      }

      if (detailCache.canServePacket(cached, listHit)) {
        if (!hasIdentity) {
          detail.ensureMyUserName(cached.detail?.spaceName || spaceHint).catch(() => {});
        }
        return await detail.buildDetailResponse(cached, listHit, { fromCache: true });
      }

      if (listHit?.isRead && !isUnread && !isPinned) {
        if (cached?.detail) {
          return await detail.buildDetailResponse(cached, listHit, { fromCache: true });
        }
        const hit = { ...listHit };
        const packet = await detail.packDetailForItem(hit, { withHistory: false });
        const outDetail = packet?.detail || hit;
        return {
          success: true,
          detail: detail.formatDetail(outDetail),
          thread: detail.formatThread(packet?.thread || [hit]),
          ...detail.getIdentitySnapshot(),
          fromCache: true,
          readOnlyCache: true
        };
      }

      await detail.ensureMyUserName(spaceHint);

      let msgDetail = null;
      if (cached?.detail) {
        msgDetail = { ...cached.detail };
      } else if (listHit) {
        msgDetail = { ...listHit };
      }

      if (listHit && msgDetail) {
        msgDetail.isDm = listHit.isDm;
        msgDetail.mentionedMe = listHit.mentionedMe;
        msgDetail.spaceType = listHit.spaceType || msgDetail.spaceType;
        msgDetail.spaceDisplayName = listHit.spaceDisplayName || msgDetail.spaceDisplayName;
      }

      if (!msgDetail) {
        msgDetail = await detail.fetchMessageDetail(messageName);
      }

      if (msgDetail?.spaceName && !hasIdentity) {
        await detail.resolveMyUserFromSpace(msgDetail.spaceName);
      }
      const packet = await detail.packDetailForItem(msgDetail, {
        withHistory: isUnread || isPinned || !listHit?.isRead
      });
      const outDetail = packet?.detail || msgDetail;
      detail.rememberTodayTouch(outDetail, { read: true });
      detail.saveDisk();
      return {
        success: true,
        detail: detail.formatDetail(outDetail),
        thread: detail.formatThread(packet?.thread || [msgDetail]),
        ...detail.getIdentitySnapshot(),
        fromCache: false
      };
    } catch (err) {
      return { success: false, ...detail.explainError(err) };
    }
  });

  ipcMain.handle('gchat-thread-refresh', async (_event, payload) => {
    try {
      if (!detail.isChatReady()) {
        return { success: false, error: '請先用 Google 登入' };
      }
      if (!payload?.spaceName) return { success: false, error: '缺少對話空間' };
      const cacheOnly = !!payload?.cacheOnly;
      const detailCache = detail.getDetailCache();
      const isDmHint = !!(payload.isDm || payload.spaceType === 'DIRECT_MESSAGE');
      const cached = detailCache.resolveSpacePacket(payload.spaceName, { isDm: isDmHint });

      if (cacheOnly && detailCache.canServePacket(cached, null)) {
        detailCache.logCacheHit('thread', payload.spaceName);
        return await detail.buildThreadRefreshFromCache(payload, cached, { fromCache: true });
      }

      const quota = detail.quotaStatus();
      if (quota.quotaBlocked) {
        const fallback = detail.findReadyPacketBySpace(payload.spaceName, {
          isDm: !!(payload.isDm || payload.spaceType === 'DIRECT_MESSAGE')
        });
        if (fallback?.thread?.length) {
          return {
            success: true,
            thread: detail.formatThread([...fallback.thread]),
            fromCache: true,
            quotaBlocked: true,
            quotaBlockedUntil: quota.quotaBlockedUntil,
            warning: 'Google Chat API 配額已滿，顯示本機暫存',
            ...detail.getIdentitySnapshot()
          };
        }
        return {
          success: false,
          quotaBlocked: true,
          quotaBlockedUntil: quota.quotaBlockedUntil,
          error: 'Google Chat API 配額已滿，請稍後再試'
        };
      }

      const pollKey = detail.threadPollKey(
        payload.spaceName,
        payload.focusThread ? (payload.threadName || '') : (payload.threadName || '')
      );
      return await detail.requestThreadSync(pollKey, payload);
    } catch (err) {
      if (detail.isQuotaError(err)) {
        detail.markQuotaBlocked(err, '刷新 Chat 討論串');
        const cached = detail.findReadyPacketBySpace(payload?.spaceName, {
          isDm: !!(payload?.isDm || payload?.spaceType === 'DIRECT_MESSAGE')
        });
        if (cached?.thread?.length) {
          return {
            success: true,
            thread: detail.formatThread([...cached.thread]),
            fromCache: true,
            quotaBlocked: true,
            ...detail.quotaStatus(),
            warning: 'Google Chat API 配額已滿，顯示本機暫存'
          };
        }
      }
      return { success: false, ...detail.explainError(err), ...detail.quotaStatus() };
    }
  });
}

module.exports = { registerDetailHandlers };
