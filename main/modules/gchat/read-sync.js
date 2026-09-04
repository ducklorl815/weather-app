/**
 * ReadSync — 本機已讀 + Server flush + pending retry
 */
const { gchatSyncLog } = require('./sync-log');

const MAX_FLUSH_ATTEMPTS = 8;

/**
 * @param {{
 *   queueMarkRead: (messageName: string, meta?: object) => object,
 *   getPendingEntries: () => Array<[string, object]>,
 *   getPendingCount: () => number,
 *   updatePendingMeta: (name: string, patch: object) => void,
 *   deletePending: (name: string) => void,
 *   clearPendingForSpace: (spaceName: string, spaceKey: string) => void,
 *   clearPendingForMessage: (messageName: string, spaceName?: string) => void,
 *   markLocallyRead: (name: string) => void,
 *   chatApiService: { updateSpaceReadState: (spaceName: string, lastReadTime: string) => Promise<object> },
 *   assertChatReadStateScope: () => Promise<void>,
 *   resolveSpaceReadTime: (spaceName: string, rawTime?: string) => string,
 *   onSpaceReadApplied?: (spaceName: string, lastReadTime: string) => void,
 *   markMessageReadRemote: (messageName: string, meta?: object) => Promise<object>,
 *   newestCreateTimeInSpace?: (spaceName: string) => string,
 *   saveDisk: () => void,
 *   logIssue: (kind: string, err: Error) => void
 * }} deps
 */
function createReadSync(deps) {
  async function flushSpaceReadToServer(spaceName, meta, spaceKey) {
    await deps.assertChatReadStateScope();
    const raw = meta?.createTime || deps.newestCreateTimeInSpace?.(spaceName) || '';
    const lastRead = deps.resolveSpaceReadTime(spaceName, raw);
    await deps.chatApiService.updateSpaceReadState(spaceName, lastRead);
    deps.onSpaceReadApplied?.(spaceName, lastRead);
    deps.clearPendingForSpace(spaceName, spaceKey);
  }

  function markReadLocal(messageName, meta = {}) {
    if (!messageName) return { namesToClear: [], maxCreateTime: '', spaceName: '' };
    const result = deps.queueMarkRead(messageName, meta);
    gchatSyncLog('[READ] markReadLocal', `${messageName.slice(-24)} pending=${deps.getPendingCount()}`);
    return result;
  }

  async function flushToServer() {
    const entries = deps.getPendingEntries();
    if (!entries.length) {
      return { flushed: 0, failed: 0, pending: 0, skipped: true };
    }

    let flushed = 0;
    let failed = 0;
    let changed = false;
    const now = Date.now();

    for (const [name, meta] of entries) {
      const attempts = Number(meta?.attempts || 0);
      if (attempts >= MAX_FLUSH_ATTEMPTS) {
        gchatSyncLog('[READ] pending dropped (max attempts)', name);
        deps.deletePending(name);
        changed = true;
        continue;
      }

      if (String(name).startsWith('__space:')) {
        const spaceName = meta?.spaceName || String(name).slice('__space:'.length);
        try {
          await flushSpaceReadToServer(spaceName, meta, name);
          flushed += 1;
          changed = true;
        } catch (err) {
          deps.updatePendingMeta(name, {
            attempts: attempts + 1,
            lastAttemptAt: now,
            lastError: err?.message || String(err)
          });
          deps.logIssue('標已讀失敗', err);
          failed += 1;
        }
        continue;
      }

      try {
        await deps.markMessageReadRemote(name, meta || {});
        const spaceName = meta?.spaceName || '';
        deps.clearPendingForMessage(name, spaceName);
        deps.markLocallyRead(name);
        flushed += 1;
        changed = true;
      } catch (err) {
        deps.updatePendingMeta(name, {
          attempts: attempts + 1,
          lastAttemptAt: now,
          lastError: err?.message || String(err)
        });
        deps.markLocallyRead(name);
        deps.logIssue('標已讀失敗', err);
        failed += 1;
      }
    }

    if (changed) deps.saveDisk();

    const pending = deps.getPendingCount();
    gchatSyncLog('[READ] flush', `ok=${flushed} fail=${failed} pending=${pending}`);
    return { flushed, failed, pending };
  }

  async function flushPending() {
    try {
      return await flushToServer();
    } catch (err) {
      gchatSyncLog('[READ] flush pending failed', err?.message || String(err));
      return {
        flushed: 0,
        failed: 0,
        pending: deps.getPendingCount(),
        error: err?.message || String(err)
      };
    }
  }

  async function tryFlushMessage(messageName, meta = {}) {
    if (!messageName) return { success: false, error: '缺少訊息' };

    const pending = deps.getPendingEntries();
    if (!pending.some(([name]) => name === messageName)) {
      gchatSyncLog('[READ] tryFlush skip (not pending)', messageName.slice(-24));
      return { success: true, serverSynced: true, pending: deps.getPendingCount(), skipped: true };
    }

    try {
      await deps.markMessageReadRemote(messageName, meta);
      deps.clearPendingForMessage(messageName, meta?.spaceName || '');
      deps.markLocallyRead(messageName);
      deps.saveDisk();
      gchatSyncLog('[READ] tryFlush ok', messageName.slice(-24));
      return { success: true, serverSynced: true, pending: deps.getPendingCount() };
    } catch (err) {
      deps.updatePendingMeta(messageName, {
        attempts: Number(meta?.attempts || deps.getPendingEntries().find(([n]) => n === messageName)?.[1]?.attempts || 0) + 1,
        lastAttemptAt: Date.now(),
        lastError: err?.message || String(err)
      });
      deps.saveDisk();
      deps.logIssue('已讀延後同步', err);
      return { success: true, serverSynced: false, pending: deps.getPendingCount() };
    }
  }

  return {
    markReadLocal,
    flushToServer,
    flushPending,
    tryFlushMessage,
    getPendingCount: deps.getPendingCount
  };
}

module.exports = { createReadSync, MAX_FLUSH_ATTEMPTS };
