/**
 * Detail Cache — Cache First 讀取（gchat-detail / thread-refresh / open-space）
 */
const { gchatSyncLog } = require('./sync-log');

/**
 * @param {{
 *   findReadyPacket: (messageName: string, hint?: object|null) => object|null,
 *   findReadyPacketBySpace: (spaceName: string, opts?: object) => object|null,
 *   getInboxMessages: () => object[],
 *   getTodayTouched: () => object[],
 *   shouldRefreshPacket: (cached: object, listHit?: object|null) => boolean,
 *   packetNeedsEmojiRepair: (thread: object[]) => boolean,
 *   messageHasDisplayContent: (m: object) => boolean
 * }} deps
 */
function createDetailCache(deps) {
  function resolveListHit(messageName) {
    const key = String(messageName || '').trim();
    if (!key) return null;
    return deps.getInboxMessages().find((m) => m.name === key)
      || deps.getTodayTouched().find((m) => m.name === key)
      || null;
  }

  function resolveMessagePacket(messageName) {
    const listHit = resolveListHit(messageName);
    const cached = deps.findReadyPacket(messageName, listHit);
    return { cached, listHit };
  }

  function resolveSpacePacket(spaceName, { isDm = false } = {}) {
    const key = String(spaceName || '').trim();
    if (!key) return null;
    return deps.findReadyPacketBySpace(key, { isDm });
  }

  function canServeMessageCache(messageName) {
    const { cached, listHit } = resolveMessagePacket(messageName);
    return canServePacket(cached, listHit);
  }

  function canServeSpaceCache(spaceName, opts = {}) {
    const cached = resolveSpacePacket(spaceName, opts);
    return canServePacket(cached, null);
  }

  function canServePacket(cached, listHit) {
    if (!cached?.historyReady || !cached?.detail || !Array.isArray(cached.thread)) return false;
    if (!cached.thread.length) return false;
    if (deps.packetNeedsEmojiRepair(cached.thread)) return false;
    if (deps.shouldRefreshPacket(cached, listHit)) return false;
    if (cached.thread.every((m) => !deps.messageHasDisplayContent(m))) return false;
    return true;
  }

  function logCacheHit(kind, id) {
    gchatSyncLog('[CACHE] hit', `${kind} ${String(id || '').slice(-28)}`);
  }

  return {
    resolveListHit,
    resolveMessagePacket,
    resolveSpacePacket,
    canServeMessageCache,
    canServeSpaceCache,
    canServePacket,
    logCacheHit
  };
}

module.exports = { createDetailCache };
