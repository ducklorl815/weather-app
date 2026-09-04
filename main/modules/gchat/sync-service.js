/**
 * Background Sync Service — inbox 同步編排（mutex 保護）
 * 編排：ReadSync flush → API fetch → CacheRepository merge → finalize → emit
 */
const { gchatSyncLog } = require('./sync-log');

/**
 * @param {{
 *   isReady: () => boolean,
 *   readSync: { flushPending: () => Promise<void> },
 *   cacheRepository: {
 *     mergeUnreadInboxFromServer: () => Promise<object>,
 *     emitChanged: (reason?: string) => void
 *   },
 *   setSyncing?: (syncing: boolean) => void,
 *   syncThread?: (detail: object) => Promise<object>
 * }} deps
 */
function createSyncService(deps) {
  /** @type {Promise<object|null>|null} */
  let activeSync = null;

  async function runSync() {
    gchatSyncLog('[SYNC] started');
    if (!deps.isReady()) {
      gchatSyncLog('[SYNC] skipped (not ready)');
      return { skipped: true, reason: 'not_ready' };
    }
    deps.setSyncing?.(true);
    try {
      await deps.readSync.flushPending();
      const result = await deps.cacheRepository.mergeUnreadInboxFromServer();
      gchatSyncLog('[SYNC] received', result?.count ?? 0);
      gchatSyncLog('[SYNC] saved');
      deps.cacheRepository.emitChanged('sync');
      gchatSyncLog('[SYNC] completed');
      return { success: true, ...result };
    } catch (err) {
      gchatSyncLog('[SYNC] failed', err?.message || String(err));
      throw err;
    } finally {
      deps.setSyncing?.(false);
    }
  }

  return {
    isSyncing() {
      return !!activeSync;
    },

    /**
     * 同步未讀 inbox；若上一輪尚未完成則共用同一 Promise（mutex）
     */
    syncUnreadInbox() {
      if (activeSync) {
        gchatSyncLog('[SYNC] skipped (mutex: already running)');
        return activeSync;
      }
      activeSync = runSync().finally(() => {
        activeSync = null;
      });
      return activeSync;
    },

    /**
     * 從 Server 同步討論串並寫入 PacketRepository
     */
    syncThread(detail, opts) {
      if (!deps.syncThread) {
        return Promise.reject(new Error('syncThread 未設定'));
      }
      return deps.syncThread(detail, opts);
    }
  };
}

module.exports = { createSyncService };
