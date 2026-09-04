/**
 * Background Sync Scheduler — 唯一 30 秒定時器
 * 生命週期：Session 登入啟動 / 登出停止；與 UI 完全解耦
 */
const { gchatSyncLog } = require('./sync-log');

const DEFAULT_INTERVAL_MS = 30 * 1000;

/**
 * @param {{
 *   syncService: { syncUnreadInbox: () => Promise<object|null> },
 *   pollCoordinator?: { runSchedulerTick: () => Promise<void> },
 *   onAfterSync?: () => Promise<void>,
 *   isReady: () => boolean,
 *   intervalMs?: number
 * }} deps
 */
function createSyncScheduler(deps) {
  let timer = null;
  let tickRunning = false;

  async function tick() {
    if (tickRunning) {
      gchatSyncLog('[SYNC] scheduler tick skipped (previous tick still running)');
      return;
    }
    if (!deps.isReady()) return;
    tickRunning = true;
    try {
      if (deps.pollCoordinator?.runSchedulerTick) {
        await deps.pollCoordinator.runSchedulerTick();
      } else {
        await deps.syncService.syncUnreadInbox();
        if (deps.onAfterSync) {
          await deps.onAfterSync();
        }
      }
    } catch (err) {
      gchatSyncLog('[SYNC] scheduler tick failed', err?.message || String(err));
    } finally {
      tickRunning = false;
    }
  }

  return {
    start() {
      if (timer) {
        gchatSyncLog('[SYNC] scheduler already running');
        return;
      }
      gchatSyncLog('[SYNC] scheduler started', `${deps.intervalMs ?? DEFAULT_INTERVAL_MS}ms`);
      tick();
      timer = setInterval(tick, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        gchatSyncLog('[SYNC] scheduler stopped');
      }
    },

    tickNow: tick,

    isRunning() {
      return !!timer;
    }
  };
}

module.exports = { createSyncScheduler, DEFAULT_INTERVAL_MS };
