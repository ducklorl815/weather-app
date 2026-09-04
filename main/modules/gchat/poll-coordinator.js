/**
 * Poll Coordinator — 合併 30s 同步需求、per-key 去重（Phase 2C）
 * 職責：登記 interest、排程 tick 時執行 inbox / bar / thread，不含 UI。
 */
const { gchatSyncLog } = require('./sync-log');

function threadPollKey(spaceName, threadName = '') {
  const space = String(spaceName || '').trim();
  const thread = String(threadName || '').trim();
  if (!space) return '';
  return thread ? `thread:${space}:${thread}` : `thread:${space}`;
}

function barPollKey(spaceName, { threadFocus = false } = {}) {
  const space = String(spaceName || '').trim();
  if (!space) return '';
  return `bar:${space}:${threadFocus ? 'focus' : 'space'}`;
}

/**
 * @param {{
 *   runInbox: () => Promise<unknown>,
 *   runBarRegistry: () => Promise<unknown>,
 *   runThreadSync: (detail: object, opts?: object) => Promise<unknown>,
 *   afterTick?: () => Promise<void>
 * }} deps
 */
function createPollCoordinator(deps) {
  /** @type {Map<string, Promise<unknown>>} */
  const activeRequests = new Map();
  /** @type {Map<string, { detail: object, source?: string }>} */
  const interests = new Map();

  async function request(key, fn) {
    const k = String(key || '').trim();
    if (!k) return null;
    if (activeRequests.has(k)) {
      gchatSyncLog('[POLL] dedupe', k.slice(0, 48));
      return activeRequests.get(k);
    }
    gchatSyncLog('[POLL] request', k.slice(0, 48));
    const p = Promise.resolve()
      .then(fn)
      .finally(() => activeRequests.delete(k));
    activeRequests.set(k, p);
    return p;
  }

  function registerInterest(key, meta = {}) {
    const k = String(key || '').trim();
    if (!k) return;
    interests.set(k, { ...meta, registeredAt: Date.now() });
    gchatSyncLog('[POLL] interest +', k.slice(0, 48));
  }

  function unregisterInterest(key) {
    const k = String(key || '').trim();
    if (!k) return false;
    const removed = interests.delete(k);
    if (removed) gchatSyncLog('[POLL] interest -', k.slice(0, 48));
    return removed;
  }

  function clearInterests() {
    interests.clear();
  }

  function getInterestKeys() {
    return [...interests.keys()];
  }

  async function runInterestSyncs() {
    const keys = getInterestKeys();
    for (const key of keys) {
      if (!key.startsWith('thread:')) continue;
      const meta = interests.get(key);
      const detail = meta?.detail;
      if (!detail?.spaceName) continue;
      await request(key, () => deps.runThreadSync(detail, { notifyUi: true })).catch((err) => {
        gchatSyncLog('[POLL] thread interest failed', err?.message || String(err));
      });
    }
  }

  /**
   * Scheduler 每輪 tick：inbox → bar badges → 已登記 thread interests
   */
  async function runSchedulerTick() {
    await request('inbox', () => deps.runInbox());
    await request('bar:registry', () => deps.runBarRegistry()).catch((err) => {
      gchatSyncLog('[POLL] bar sync failed', err?.message || String(err));
    });
    await runInterestSyncs();
    if (deps.afterTick) {
      await deps.afterTick().catch((err) => {
        gchatSyncLog('[POLL] afterTick failed', err?.message || String(err));
      });
    }
  }

  return {
    request,
    registerInterest,
    unregisterInterest,
    clearInterests,
    getInterestKeys,
    runSchedulerTick,
    runInterestSyncs,
    threadPollKey,
    barPollKey,
    isActive(key) {
      return activeRequests.has(String(key || '').trim());
    }
  };
}

module.exports = {
  createPollCoordinator,
  threadPollKey,
  barPollKey
};
