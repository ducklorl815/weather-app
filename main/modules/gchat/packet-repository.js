/**
 * Packet Repository — gchatCache.packets 唯一寫入入口（Phase 2B）
 * 負責多鍵索引、thread merge、find ready、磁碟序列化。
 */
const { mergeMessages } = require('./cache-repository');

/**
 * @param {{
 *   getPackets: () => Record<string, object>,
 *   setPackets: (packets: Record<string, object>) => void,
 *   getInboxMessages: () => object[],
 *   getTodayTouched: () => object[],
 *   getSpaceNames: () => Record<string, string>,
 *   setSpaceName: (spaceName: string, label: string) => void,
 *   getSpaceTypes: () => Record<string, string>,
 *   spacePacketKey: (spaceName: string) => string,
 *   trackKey: (item: object) => string,
 *   annotateThreadMine: (thread: object[]) => object[],
 *   groupMessagesByThread: (thread: object[]) => object[],
 *   isOwnMessage: (msg: object) => boolean,
 *   cleanSpaceLabel: (label: string, spaceType: string, isDm: boolean) => string,
 *   pickLabel: (a: string, b: string) => string,
 *   threadNeedsMediaHydration: (thread: object[]) => boolean,
 *   slimMessageForDisk: (msg: object) => object,
 *   getPinSpaceKeys: () => Set<string>
 * }} deps
 */
function createPacketRepository(deps) {
  function packetsStore() {
    const store = deps.getPackets?.();
    if (!store || typeof store !== 'object') {
      deps.setPackets?.({});
      return deps.getPackets();
    }
    return store;
  }

  /**
   * 寫入／更新對話暫存。同一空間舊的 messageName 鍵也一併指向新 packet。
   */
  function indexPacket(packet) {
    if (!packet?.detail) return packet;
    const packets = packetsStore();
    const d = packet.detail;
    const spaceName = String(d.spaceName || '').trim();
    if (spaceName) {
      for (const [key, p] of Object.entries(packets)) {
        if (p?.detail?.spaceName === spaceName) {
          packets[key] = packet;
        }
      }
      const spaceKey = deps.spacePacketKey?.(spaceName) || '';
      if (spaceKey) packets[spaceKey] = packet;
    }
    if (d.name) packets[d.name] = packet;
    for (const m of packet.thread || []) {
      if (m?.name) packets[m.name] = packet;
    }
    return packet;
  }

  function findReadyBySpace(spaceName, { isDm = false } = {}) {
    if (!spaceName) return null;
    const packets = packetsStore();
    const spaceKey = deps.spacePacketKey?.(spaceName) || '';
    if (spaceKey && packets[spaceKey]?.historyReady && Array.isArray(packets[spaceKey].thread)) {
      return packets[spaceKey];
    }
    const track = deps.trackKey?.({
      spaceName,
      isDm: !!isDm,
      spaceType: isDm ? 'DIRECT_MESSAGE' : ''
    }) || '';
    let best = null;
    for (const p of Object.values(packets)) {
      if (!p?.historyReady || !p.detail || !Array.isArray(p.thread)) continue;
      if (p.detail.spaceName === spaceName) {
        if (!best || Number(p.packedAt || 0) > Number(best.packedAt || 0)) best = p;
        continue;
      }
      if (track && deps.trackKey?.(p.detail) === track) {
        if (!best || Number(p.packedAt || 0) > Number(best.packedAt || 0)) best = p;
      }
    }
    return best;
  }

  function findReady(messageName, hint = null) {
    const packets = packetsStore();
    const byName = (messageName && packets[messageName]?.historyReady && Array.isArray(packets[messageName].thread))
      ? packets[messageName]
      : null;
    const touch = hint
      || (deps.getInboxMessages?.() || []).find((m) => m.name === messageName)
      || (deps.getTodayTouched?.() || []).find((m) => m.name === messageName)
      || byName?.detail
      || null;
    let bySpace = null;
    if (touch?.spaceName) {
      bySpace = findReadyBySpace(touch.spaceName, {
        isDm: !!(touch.isDm || touch.spaceType === 'DIRECT_MESSAGE')
      });
    }
    if (byName && bySpace) {
      return Number(bySpace.packedAt || 0) >= Number(byName.packedAt || 0) ? bySpace : byName;
    }
    if (byName) return byName;
    if (bySpace) return bySpace;
    const key = deps.trackKey?.(touch || {}) || '';
    if (!key) return null;
    let best = null;
    for (const p of Object.values(packets)) {
      if (!p?.historyReady || !p.detail || !Array.isArray(p.thread)) continue;
      if (deps.trackKey?.(p.detail) !== key) continue;
      if (!best || Number(p.packedAt || 0) > Number(best.packedAt || 0)) best = p;
    }
    return best;
  }

  function getByMessageName(name) {
    const key = String(name || '').trim();
    if (!key) return null;
    return packetsStore()[key] || null;
  }

  function getBySpace(spaceName, opts = {}) {
    return findReadyBySpace(spaceName, opts);
  }

  /** 即時把對話串寫回暫存（回覆／Little Reply 刷新用） */
  function upsertLivePacket(meta, threadIn) {
    const spaceName = String(meta?.spaceName || '').trim();
    if (!spaceName || !Array.isArray(threadIn) || !threadIn.length) return null;
    const spaceTypes = deps.getSpaceTypes?.() || {};
    const isDm = !!(meta.isDm || meta.spaceType === 'DIRECT_MESSAGE');
    const spaceType = meta.spaceType || (isDm ? 'DIRECT_MESSAGE' : '') || spaceTypes[spaceName] || '';
    const annotatedIncoming = deps.annotateThreadMine?.(threadIn) || threadIn;
    const prev = findReadyBySpace(spaceName, { isDm })
      || (meta.name && packetsStore()[meta.name])
      || null;
    const mergedRaw = mergeMessages(prev?.thread || [], annotatedIncoming, {
      pickLabel: deps.pickLabel
    });
    const thread = mergedRaw;
    const grouped = deps.groupMessagesByThread?.(thread) || thread;
    const newest = thread.reduce((best, m) => {
      if (!m) return best;
      if (!best || String(m.createTime || '') > String(best.createTime || '')) return m;
      return best;
    }, null);
    const spaceNames = deps.getSpaceNames?.() || {};
    const label = deps.cleanSpaceLabel?.(
      meta.spaceDisplayName
        || prev?.detail?.spaceDisplayName
        || spaceNames[spaceName]
        || newest?.spaceDisplayName
        || '對話',
      spaceType,
      isDm
    ) || '對話';
    if (label) deps.setSpaceName?.(spaceName, label);
    const detail = {
      ...(prev?.detail || {}),
      ...(newest || {}),
      name: newest?.name || meta.name || prev?.detail?.name || '',
      spaceName,
      spaceDisplayName: label,
      spaceType,
      isDm,
      threadName: meta.threadName || newest?.threadName || prev?.detail?.threadName || '',
      sender: (newest && !deps.isOwnMessage?.(newest) ? newest.sender : null)
        || meta.sender
        || prev?.detail?.sender
        || label,
      senderName: newest?.senderName || meta.senderName || prev?.detail?.senderName || '',
      snippet: newest?.snippet || newest?.text || prev?.detail?.snippet || '',
      text: newest?.text || '',
      createTime: newest?.createTime || prev?.detail?.createTime || '',
      createTimeLabel: newest?.createTimeLabel || prev?.detail?.createTimeLabel || '',
      media: newest?.media || [],
      isMine: newest ? !!deps.isOwnMessage?.(newest) : false
    };
    const packet = {
      detail,
      thread: grouped,
      packedAt: Date.now(),
      historyReady: true,
      mediaHydrated: !deps.threadNeedsMediaHydration?.(grouped)
    };
    return indexPacket(packet);
  }

  /** 把單則新訊息併入既有暫存（送出回覆後立刻更新） */
  function appendMessage(msg, extras = {}) {
    if (!msg) return null;
    const spaceName = String(msg.spaceName || extras.spaceName || '').trim();
    if (!spaceName) return null;
    const isDm = !!(extras.isDm ?? msg.isDm ?? (extras.spaceType === 'DIRECT_MESSAGE'));
    const prev = findReadyBySpace(spaceName, { isDm })
      || (msg.name && packetsStore()[msg.name])
      || null;
    const thread = Array.isArray(prev?.thread) ? [...prev.thread] : [];
    const annotatedMsg = {
      ...msg,
      isMine: true,
      sender: msg.sender === '我' || msg.isMine ? '我' : msg.sender
    };
    if (annotatedMsg.name) {
      const idx = thread.findIndex((m) => m.name === annotatedMsg.name);
      if (idx >= 0) thread[idx] = { ...thread[idx], ...annotatedMsg };
      else thread.push(annotatedMsg);
    } else {
      thread.push(annotatedMsg);
    }
    return upsertLivePacket({
      spaceName,
      isDm,
      spaceType: extras.spaceType || msg.spaceType || (isDm ? 'DIRECT_MESSAGE' : ''),
      spaceDisplayName: extras.spaceDisplayName || msg.spaceDisplayName || prev?.detail?.spaceDisplayName || '',
      threadName: extras.threadName || msg.threadName || '',
      sender: extras.sender || prev?.detail?.sender || '',
      name: msg.name || prev?.detail?.name || ''
    }, thread);
  }

  /**
   * IPC 過渡：以 detail.name 為鍵寫入 packet 並重新索引
   */
  function setPacket(messageName, packet) {
    const name = String(messageName || packet?.detail?.name || '').trim();
    if (!name || !packet) return null;
    const packets = packetsStore();
    packets[name] = {
      ...packet,
      packedAt: packet.packedAt || Date.now(),
      historyReady: packet.historyReady !== false
    };
    return indexPacket(packets[name]);
  }

  /**
   * 更新已索引 packet 的 detail / thread / mediaHydrated
   */
  function updatePacket(messageName, patch) {
    const name = String(messageName || '').trim();
    if (!name) return null;
    const existing = packetsStore()[name];
    if (!existing) return null;
    const next = {
      ...existing,
      ...patch,
      detail: patch.detail ? { ...existing.detail, ...patch.detail } : existing.detail,
      thread: patch.thread || existing.thread
    };
    return indexPacket(next);
  }

  /**
   * 對所有含指定 message 的 packet 套用 patch 函式（reaction 等）
   */
  function patchMessageInPackets(messageName, patchFn) {
    const target = String(messageName || '').trim();
    if (!target || typeof patchFn !== 'function') return;
    const seen = new Set();
    const packets = packetsStore();
    for (const p of Object.values(packets)) {
      if (!p?.thread || seen.has(p)) continue;
      if (!p.thread.some((m) => m?.name === target) && p.detail?.name !== target) continue;
      seen.add(p);
      const thread = (p.thread || []).map((m) => patchFn(m));
      const detail = patchFn(p.detail);
      indexPacket({ ...p, detail, thread });
    }
  }

  function clear() {
    deps.setPackets?.({});
  }

  /**
   * 移除過期 packet 鍵（inbox finalize 用）
   */
  function pruneStale({ keepMessageNames = new Set(), todayTrackKeys = new Set(), pinSpaceKeys = new Set() } = {}) {
    const packets = packetsStore();
    for (const key of Object.keys(packets)) {
      if (keepMessageNames.has(key)) continue;
      if (key.startsWith('space:') && pinSpaceKeys.has(key)) continue;
      const detail = packets[key]?.detail;
      const trackKey = detail ? deps.trackKey?.(detail) : '';
      if (trackKey && todayTrackKeys.has(trackKey)) continue;
      if (trackKey && pinSpaceKeys.has(trackKey)) continue;
      if (detail?.spaceName && pinSpaceKeys.has(deps.spacePacketKey?.(detail.spaceName) || '')) continue;
      delete packets[key];
    }
  }

  function serializeForDisk() {
    const packets = packetsStore();
    const pinKeys = deps.getPinSpaceKeys?.() || new Set();
    const entries = Object.entries(packets)
      .filter(([, p]) => p?.historyReady && p?.detail && Array.isArray(p.thread))
      .sort((a, b) => {
        const aPin = pinKeys.has(a[0]) || (a[1].detail?.spaceName && pinKeys.has(deps.spacePacketKey?.(a[1].detail.spaceName))) ? 1 : 0;
        const bPin = pinKeys.has(b[0]) || (b[1].detail?.spaceName && pinKeys.has(deps.spacePacketKey?.(b[1].detail.spaceName))) ? 1 : 0;
        if (bPin !== aPin) return bPin - aPin;
        return Number(b[1].packedAt || 0) - Number(a[1].packedAt || 0);
      })
      .slice(0, 48);
    const slim = deps.slimMessageForDisk || ((m) => m);
    const out = {};
    for (const [key, p] of entries) {
      out[key] = {
        packedAt: p.packedAt || Date.now(),
        historyReady: true,
        detail: slim(p.detail),
        thread: (p.thread || []).map(slim)
      };
    }
    return out;
  }

  function loadFromDisk(raw) {
    if (!raw || typeof raw !== 'object') return;
    const packets = packetsStore();
    for (const [key, p] of Object.entries(raw)) {
      if (!p?.historyReady || !p?.detail || !Array.isArray(p.thread)) continue;
      packets[key] = {
        packedAt: p.packedAt || Date.now(),
        historyReady: true,
        detail: p.detail,
        thread: p.thread,
        mediaHydrated: !!p.mediaHydrated
      };
    }
    const newestBySpace = new Map();
    for (const p of Object.values(packets)) {
      const sn = p?.detail?.spaceName;
      if (!sn || !p.historyReady) continue;
      const prev = newestBySpace.get(sn);
      if (!prev || Number(p.packedAt || 0) >= Number(prev.packedAt || 0)) {
        newestBySpace.set(sn, p);
      }
    }
    for (const p of newestBySpace.values()) {
      indexPacket(p);
    }
  }

  return {
    indexPacket,
    findReady,
    findReadyBySpace,
    getByMessageName,
    getBySpace,
    upsertLivePacket,
    appendMessage,
    setPacket,
    updatePacket,
    patchMessageInPackets,
    clear,
    pruneStale,
    serializeForDisk,
    loadFromDisk
  };
}

module.exports = { createPacketRepository };
