/**
 * GChat Read/Mark Service — 已讀標記與 Server 同步（Phase 4D）
 * 搭配 read-sync.js flush；不含 IPC。
 */

function bumpReadTimestamp(iso) {
  const raw = String(iso || '').trim();
  if (!raw) return new Date().toISOString();
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return new Date().toISOString();
  return new Date(ms + 1000).toISOString();
}

/**
 * @param {{
 *   getMessages: () => object[],
 *   getPackets: () => Record<string, object>,
 *   findReadyPacketBySpace: (spaceName: string, opts: object) => object | null,
 *   getSpaceTypes: () => Record<string, string>,
 *   getPendingMarkRead: () => Map<string, object>,
 *   addLocallyRead: (name: string) => void,
 *   getLocallyReadSpaces: () => Map<string, string>,
 *   setLocallyReadSpace: (spaceName: string, readUntil: string) => void,
 *   pickGoodLabel: (...labels: string[]) => string,
 *   rememberTodayTouch: (item: object, opts: object) => void,
 *   applyInboxLocalRead: (opts: object) => void,
 *   trackKey: (item: object) => string,
 *   markAlertSeen: (trackKey: string, createTime: string) => void,
 *   dismissToast: (payload: object) => void,
 *   getReadSync: () => { markReadLocal: Function, tryFlushMessage: Function },
 *   snapshot: () => object,
 *   broadcastListUpdate: () => void,
 *   saveDisk: () => void,
 *   logIssue: (kind: string, err: Error) => void,
 *   assertChatReadStateScope: () => Promise<void>,
 *   updateSpaceReadState: (spaceName: string, lastReadTime: string) => Promise<object>,
 *   parseChatResource: (name: string) => object,
 *   findReadyPacket: (messageName: string) => object | null,
 *   getTodayTouched: () => object[],
 *   isTransientGoogleError: (err: unknown) => boolean,
 *   removeInboxBySpace: (spaceName: string) => void
 * }} deps
 */
function createReadMarkService(deps) {
  function resolveMarkReadLastTime(maxCreateTime = '') {
    const bumped = bumpReadTimestamp(maxCreateTime);
    const now = new Date().toISOString();
    return String(bumped || '') > now ? bumped : now;
  }

  function newestCreateTimeInSpace(spaceName) {
    const key = String(spaceName || '').trim();
    if (!key) return '';
    const spaceTypes = deps.getSpaceTypes() || {};
    let max = '';
    const consider = (createTime) => {
      const t = String(createTime || '').trim();
      if (t && (!max || t > max)) max = t;
    };
    for (const m of deps.getMessages() || []) {
      if (m?.spaceName === key) consider(m.createTime);
    }
    const packet = deps.findReadyPacketBySpace(key, { isDm: spaceTypes[key] === 'DIRECT_MESSAGE' });
    for (const m of packet?.thread || []) {
      if (m?.spaceName === key) consider(m.createTime);
    }
    if (packet?.detail?.spaceName === key) consider(packet.detail.createTime);
    return max;
  }

  function queueMarkRead(messageName, meta = {}) {
    if (!messageName) return { namesToClear: [], maxCreateTime: '', spaceName: '' };
    const messages = deps.getMessages() || [];
    const packets = deps.getPackets() || {};
    const pending = deps.getPendingMarkRead();
    const cached = messages.find((m) => m.name === messageName)
      || packets[messageName]?.detail
      || null;
    const spaceName = meta.spaceName || cached?.spaceName || '';
    const related = messages.filter((m) => {
      if (!m?.name) return false;
      if (m.name === messageName) return true;
      if (spaceName && m.spaceName === spaceName) return true;
      if (cached?.spaceName && m.spaceName === cached.spaceName) return true;
      return false;
    });
    const fromMembers = Array.isArray(meta.memberNames) ? meta.memberNames : [];
    const namesToClear = [...new Set([
      messageName,
      ...fromMembers,
      ...related.map((m) => m.name)
    ].filter(Boolean))];

    let maxCreateTime = meta.createTime || cached?.createTime || newestCreateTimeInSpace(spaceName) || '';
    for (const n of namesToClear) {
      const hit = messages.find((m) => m.name === n) || (n === messageName ? cached : null);
      if (hit?.createTime && String(hit.createTime) > String(maxCreateTime || '')) {
        maxCreateTime = hit.createTime;
      }
    }
    const spaceNewest = newestCreateTimeInSpace(spaceName);
    if (spaceNewest && String(spaceNewest) > String(maxCreateTime || '')) maxCreateTime = spaceNewest;
    const readUntil = resolveMarkReadLastTime(maxCreateTime);

    const touchItem = {
      ...(cached || {}),
      name: messageName,
      createTime: readUntil || maxCreateTime || meta.createTime || cached?.createTime || '',
      threadName: meta.threadName || cached?.threadName || '',
      spaceName: spaceName || '',
      sender: deps.pickGoodLabel(meta.sender, cached?.sender),
      senderName: meta.senderName || cached?.senderName || '',
      spaceDisplayName: deps.pickGoodLabel(meta.spaceDisplayName, cached?.spaceDisplayName),
      snippet: deps.pickGoodLabel(meta.snippet, cached?.snippet) || meta.snippet || cached?.snippet || '',
      isDm: meta.isDm != null ? !!meta.isDm : !!cached?.isDm,
      mentionedMe: meta.mentionedMe != null ? !!meta.mentionedMe : !!cached?.mentionedMe,
      spaceType: meta.spaceType || cached?.spaceType || '',
      openUrl: meta.openUrl || cached?.openUrl || '',
      createTimeLabel: meta.createTimeLabel || cached?.createTimeLabel || '',
      memberNames: namesToClear
    };
    deps.rememberTodayTouch(touchItem, { read: true });

    for (const name of namesToClear) {
      const hit = messages.find((m) => m.name === name) || cached || touchItem;
      const prev = pending.get(name) || {};
      pending.set(name, {
        createTime: maxCreateTime || hit?.createTime || prev.createTime || '',
        threadName: meta.threadName || hit?.threadName || prev.threadName || '',
        spaceName: spaceName || hit?.spaceName || prev.spaceName || ''
      });
      deps.addLocallyRead(name);
    }

    const locallyReadSpaces = deps.getLocallyReadSpaces();
    const resolvedSpace = spaceName || cached?.spaceName || '';
    if (resolvedSpace && readUntil) {
      const prevUntil = String(locallyReadSpaces.get(resolvedSpace) || '');
      if (!prevUntil || String(readUntil) > prevUntil) {
        deps.setLocallyReadSpace(resolvedSpace, String(readUntil));
      }
    }
    if (resolvedSpace) {
      const until = String(locallyReadSpaces.get(resolvedSpace) || readUntil || maxCreateTime || '');
      deps.applyInboxLocalRead({ namesToClear, spaceName: resolvedSpace, readUntil: until });
    } else {
      deps.applyInboxLocalRead({ namesToClear });
    }

    const trackKey = deps.trackKey(touchItem);
    if (trackKey) deps.markAlertSeen(trackKey, String(maxCreateTime || ''));
    deps.dismissToast({ trackKey, spaceName: resolvedSpace, names: namesToClear });

    return { namesToClear, maxCreateTime: readUntil || maxCreateTime, spaceName: resolvedSpace };
  }

  function clearPendingForSpace(spaceName, spaceKey) {
    const pending = deps.getPendingMarkRead();
    for (const [n, m] of [...pending.entries()]) {
      if (n === spaceKey || m?.spaceName === spaceName) pending.delete(n);
    }
  }

  function clearPendingForMessage(messageName, spaceName = '') {
    const pending = deps.getPendingMarkRead();
    for (const [n, m] of [...pending.entries()]) {
      if (n === messageName || (spaceName && m?.spaceName === spaceName)) {
        pending.delete(n);
        if (!String(n).startsWith('__space:')) deps.addLocallyRead(n);
      }
    }
    if (spaceName) pending.delete(`__space:${spaceName}`);
  }

  function applySpaceReadLocal(spaceName, readTime) {
    const key = String(spaceName || '').trim();
    if (key) deps.setLocallyReadSpace(key, readTime);
  }

  async function markSpaceReadRemote(spaceName, lastReadTime) {
    const key = String(spaceName || '').trim();
    await deps.assertChatReadStateScope();
    const readTime = resolveMarkReadLastTime(lastReadTime);
    const result = await deps.updateSpaceReadState(key, readTime);
    applySpaceReadLocal(key, readTime);
    return result;
  }

  async function markMessageReadRemote(messageName, meta = {}) {
    const parsed = deps.parseChatResource(messageName);
    const messages = deps.getMessages() || [];
    const packets = deps.getPackets() || {};
    const cached = messages.find((m) => m.name === messageName) || packets[messageName]?.detail || {};
    const spaceName = meta.spaceName || cached.spaceName || parsed.spaceName || '';
    const spaceNewest = newestCreateTimeInSpace(spaceName);
    const createTime = meta.createTime || cached.createTime || spaceNewest || '';
    const lastReadTime = resolveMarkReadLastTime(createTime || spaceNewest);

    if (!parsed.spaceId && !spaceName) throw new Error('訊息格式無效');

    try {
      const result = await markSpaceReadRemote(
        spaceName || `spaces/${parsed.spaceId}`,
        lastReadTime
      );
      return {
        ...result,
        threadId: deps.parseChatResource(meta.threadName || cached.threadName || '').threadId || parsed.threadId || ''
      };
    } catch (err) {
      deps.logIssue('spaceReadState 更新失敗', err);
      const soft = deps.isTransientGoogleError(err)
        ? 'Google Chat 暫時無法同步已讀，本機已標已讀，稍後會再試'
        : '無法把已讀狀態同步到 Google Chat';
      const e = new Error(soft);
      e.transient = deps.isTransientGoogleError(err);
      throw e;
    }
  }

  async function markSpaceReadBySpaceName(spaceName, extra = {}) {
    const key = String(spaceName || extra.spaceName || '').trim();
    if (!key) return { success: false, error: '缺少對話空間' };
    const spaceTypes = deps.getSpaceTypes() || {};
    const cached = deps.findReadyPacketBySpace(key, {
      isDm: !!(extra.isDm || spaceTypes[key] === 'DIRECT_MESSAGE')
    });
    const anchorName = extra.name
      || cached?.detail?.name
      || (deps.getMessages() || []).find((m) => m.spaceName === key)?.name
      || '';
    if (anchorName) {
      return markConversationReadByName(anchorName, { ...extra, spaceName: key });
    }
    const readUntil = resolveMarkReadLastTime(newestCreateTimeInSpace(key));
    deps.setLocallyReadSpace(key, readUntil);
    deps.removeInboxBySpace(key);
    deps.saveDisk();
    deps.broadcastListUpdate();
    const pending = deps.getPendingMarkRead();
    try {
      await markSpaceReadRemote(key, readUntil);
      pending.delete(`__space:${key}`);
      deps.saveDisk();
      return { success: true, serverSynced: true, ...deps.snapshot() };
    } catch (err) {
      deps.logIssue('空間已讀同步', err);
      pending.set(`__space:${key}`, { spaceName: key, createTime: readUntil });
      deps.saveDisk();
      return { success: true, serverSynced: false, pending: pending.size, ...deps.snapshot() };
    }
  }

  async function markConversationReadByName(messageName, extra = {}) {
    if (!messageName) return { success: false, error: '缺少訊息' };
    const pending = deps.getPendingMarkRead();
    const readSync = deps.getReadSync();
    if (deps.hasLocallyRead?.(messageName) && !pending.has(messageName)) {
      return {
        success: true,
        serverSynced: true,
        pending: pending.size,
        skipped: true,
        ...deps.snapshot()
      };
    }
    const messages = deps.getMessages() || [];
    const packets = deps.getPackets() || {};
    const cached = messages.find((m) => m.name === messageName)
      || packets[messageName]?.detail
      || deps.findReadyPacket(messageName)?.detail
      || (deps.getTodayTouched() || []).find((m) => m.name === messageName)
      || {};
    const meta = {
      createTime: extra.createTime || cached.createTime || '',
      threadName: extra.threadName || cached.threadName || '',
      spaceName: extra.spaceName || cached.spaceName || '',
      sender: deps.pickGoodLabel(extra.sender, cached.sender),
      senderName: extra.senderName || cached.senderName || '',
      spaceDisplayName: deps.pickGoodLabel(extra.spaceDisplayName, cached.spaceDisplayName),
      snippet: deps.pickGoodLabel(extra.snippet, cached.snippet) || extra.snippet || cached.snippet || '',
      isDm: extra.isDm != null ? !!extra.isDm : !!cached.isDm,
      mentionedMe: extra.mentionedMe != null ? !!extra.mentionedMe : !!cached.mentionedMe,
      spaceType: extra.spaceType || cached.spaceType || '',
      openUrl: extra.openUrl || cached.openUrl || '',
      createTimeLabel: extra.createTimeLabel || cached.createTimeLabel || '',
      memberNames: Array.isArray(extra.memberNames) ? extra.memberNames : (cached.memberNames || [])
    };
    const queued = readSync.markReadLocal(messageName, meta);
    deps.saveDisk();
    deps.broadcastListUpdate();
    const flushResult = await readSync.tryFlushMessage(messageName, {
      ...meta,
      createTime: queued.maxCreateTime || meta.createTime,
      spaceName: queued.spaceName || meta.spaceName
    });
    return {
      success: true,
      serverSynced: !!flushResult.serverSynced,
      pending: flushResult.pending ?? pending.size,
      ...deps.snapshot()
    };
  }

  return {
    queueMarkRead,
    resolveMarkReadLastTime,
    newestCreateTimeInSpace,
    markSpaceReadBySpaceName,
    markConversationReadByName,
    clearPendingForSpace,
    clearPendingForMessage,
    applySpaceReadLocal,
    markSpaceReadRemote,
    markMessageReadRemote
  };
}

module.exports = { createReadMarkService };
