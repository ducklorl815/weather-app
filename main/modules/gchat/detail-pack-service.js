/**
 * GChat Detail/Pack Service — 對話打包與開啟空間（Phase 4C）
 * 不含 IPC；由 runtime 注入 cache、API、transform helper。
 */

/**
 * @param {{
 *   isChatReady: () => boolean,
 *   hydrateChatMedia: (media: object[]) => Promise<object[]>,
 *   isInboxMessage: (item: object) => boolean,
 *   isPinnedSpace: (spaceName: string) => boolean,
 *   isQuotaBlocked: () => boolean,
 *   findReadyPacketBySpace: (spaceName: string, opts: object) => object | null,
 *   loadConversationHistory: (detail: object) => Promise<object[]>,
 *   indexPacket: (packet: object) => object,
 *   ensureSpaceMeta: (spaceName: string) => Promise<{ label: string, spaceType: string }>,
 *   cleanSpaceLabel: (label: string, spaceType: string, isDm: boolean) => string,
 *   setSpaceName: (spaceName: string, label: string) => void,
 *   setSpaceType: (spaceName: string, spaceType: string) => void,
 *   getSpaceNames: () => Record<string, string>,
 *   annotateThreadMine: (thread: object[]) => object[],
 *   chatOpenUrl: (spaceId: string, threadId: string) => string,
 *   isOwnMessage: (msg: object) => boolean,
 *   ensureThreadMediaHydrated: (thread: object[]) => Promise<object[]>,
 *   threadNeedsMediaHydration: (thread: object[]) => boolean,
 *   rememberTodayTouch: (detail: object, opts: object) => void,
 *   ensureMyChatUserName: (spaceName: string) => Promise<string>,
 *   saveDisk: () => void,
 *   getIdentitySnapshot: () => { myUserName: string, myIds: string[], myLabels: string[] },
 *   getDetailCache: () => object,
 *   enrichMessageForDisplay: (msg: object) => object,
 *   enrichThreadForDisplay: (thread: object[]) => object[],
 *   annotateGchatThreadMine: (thread: object[]) => object[],
 *   getPacketRepository: () => object
 * }} deps
 */
function createDetailPackService(deps) {
  async function packDetailForItem(item, { withHistory = true } = {}) {
    if (!item?.name) return null;
    const detail = { ...item };
    try {
      detail.media = await deps.hydrateChatMedia(item.media || []);
    } catch (_) {
      detail.media = item.media || [];
    }
    const allowHistory = withHistory && (
      (deps.isInboxMessage(item) && !item.isRead)
      || deps.isPinnedSpace(item.spaceName)
    );
    let thread = [detail];
    if (allowHistory) {
      try {
        if (deps.isQuotaBlocked()) {
          const cached = deps.findReadyPacketBySpace(detail.spaceName, {
            isDm: !!(detail.isDm || detail.spaceType === 'DIRECT_MESSAGE')
          });
          thread = cached?.thread?.length ? [...cached.thread] : [detail];
        } else {
          thread = await deps.loadConversationHistory(detail);
        }
      } catch (_) {
        const cached = deps.findReadyPacketBySpace(detail.spaceName, {
          isDm: !!(detail.isDm || detail.spaceType === 'DIRECT_MESSAGE')
        });
        thread = cached?.thread?.length ? [...cached.thread] : [detail];
      }
    }
    if (!thread.some((m) => m.name === detail.name)) thread.push(detail);
    thread.sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
    return deps.indexPacket({
      detail,
      thread,
      packedAt: Date.now(),
      historyReady: !!withHistory,
      mediaHydrated: !!withHistory
    });
  }

  async function packSpaceHistory(spaceName, extras = {}) {
    if (!spaceName || !deps.isChatReady()) return null;
    const meta = await deps.ensureSpaceMeta(spaceName);
    const spaceType = extras.spaceType || meta.spaceType || '';
    const isDm = !!extras.isDm || spaceType === 'DIRECT_MESSAGE';
    const label = deps.cleanSpaceLabel(
      extras.label || meta.label || deps.getSpaceNames()?.[spaceName] || '對話',
      spaceType,
      isDm
    );
    deps.setSpaceName(spaceName, label);
    if (spaceType) deps.setSpaceType(spaceName, spaceType);

    const thread = deps.annotateThreadMine(await deps.loadConversationHistory({
      spaceName,
      isDm,
      spaceType,
      spaceDisplayName: label
    }));
    const focus = thread[thread.length - 1] || null;
    const detail = {
      name: focus?.name || '',
      spaceName,
      spaceDisplayName: label,
      spaceType,
      isDm,
      sender: extras.sender || label,
      senderName: extras.userName || focus?.senderName || '',
      snippet: focus?.snippet || focus?.text || '開始對話',
      text: focus?.text || '',
      createTime: focus?.createTime || '',
      createTimeLabel: focus?.createTimeLabel || '',
      threadName: focus?.threadName || '',
      openUrl: deps.chatOpenUrl(spaceName.replace(/^spaces\//, ''), ''),
      mentionedMe: false,
      isMine: focus ? deps.isOwnMessage(focus) : false,
      media: focus?.media || []
    };
    const packet = {
      detail,
      thread,
      packedAt: Date.now(),
      historyReady: true,
      mediaHydrated: false
    };
    deps.indexPacket(packet);
    deps.ensureThreadMediaHydrated(thread).then(() => {
      packet.mediaHydrated = true;
    }).catch(() => {});
    return packet;
  }

  async function buildDetailResponse(cached, listHit, { fromCache = false } = {}) {
    const detail = { ...cached.detail };
    if (listHit) {
      detail.name = listHit.name || detail.name;
      detail.isDm = listHit.isDm ?? detail.isDm;
      detail.mentionedMe = listHit.mentionedMe ?? detail.mentionedMe;
      detail.spaceType = listHit.spaceType || detail.spaceType;
      detail.spaceDisplayName = listHit.spaceDisplayName || detail.spaceDisplayName;
      detail.snippet = listHit.snippet || detail.snippet;
      detail.createTime = listHit.createTime || detail.createTime;
      detail.createTimeLabel = listHit.createTimeLabel || detail.createTimeLabel;
    }
    deps.rememberTodayTouch(detail, { read: true });
    const packetRepo = deps.getPacketRepository();
    if (detail.name) {
      packetRepo.setPacket(detail.name, {
        detail,
        thread: cached.thread,
        packedAt: cached.packedAt || Date.now(),
        historyReady: true,
        mediaHydrated: !!cached.mediaHydrated
      });
    }
    if (deps.threadNeedsMediaHydration(cached.thread)) {
      await deps.ensureThreadMediaHydrated(cached.thread);
    }
    if (Array.isArray(detail.media) && detail.media.some((x) => x?.resourceName && !x.dataUrl)) {
      try {
        detail.media = await deps.hydrateChatMedia(detail.media);
      } catch (_) {}
    }
    cached.mediaHydrated = !deps.threadNeedsMediaHydration(cached.thread);
    if (detail.name) {
      packetRepo.updatePacket(detail.name, {
        detail,
        thread: cached.thread,
        mediaHydrated: cached.mediaHydrated
      });
    }
    setTimeout(() => { try { deps.saveDisk(); } catch (_) {} }, 0);
    const id = deps.getIdentitySnapshot();
    const threadOut = deps.enrichThreadForDisplay(deps.annotateGchatThreadMine(cached.thread));
    return {
      success: true,
      detail: deps.enrichMessageForDisplay({ ...detail, isMine: deps.isOwnMessage(detail) }),
      thread: threadOut,
      myUserName: id.myUserName || '',
      myIds: id.myIds || [],
      myLabels: id.myLabels || [],
      fromCache: !!fromCache
    };
  }

  async function buildOpenSpaceFromCachedPacket(cached, space, extras = {}) {
    const spaceName = space?.name || space?.spaceName || extras.spaceName || cached?.detail?.spaceName || '';
    const isDmHint = !!extras.isDm
      || extras.spaceType === 'DIRECT_MESSAGE'
      || space?.spaceType === 'DIRECT_MESSAGE';
    const spaceType = extras.spaceType || space?.spaceType || cached.detail?.spaceType || '';
    const isDm = spaceType === 'DIRECT_MESSAGE' || isDmHint || !!cached.detail?.isDm;
    const label = deps.cleanSpaceLabel(
      extras.label
        || space?.displayName
        || cached.detail?.spaceDisplayName
        || deps.getSpaceNames()?.[spaceName]
        || '對話',
      spaceType,
      isDm
    );
    const detail = {
      ...cached.detail,
      spaceDisplayName: label,
      isDm,
      spaceType: spaceType || cached.detail?.spaceType || ''
    };
    deps.ensureMyChatUserName(spaceName).catch(() => {});
    deps.rememberTodayTouch(detail, { read: true });
    deps.indexPacket({
      ...cached,
      detail,
      historyReady: true
    });
    if (deps.threadNeedsMediaHydration(cached.thread)) {
      await deps.ensureThreadMediaHydrated(cached.thread);
    }
    cached.mediaHydrated = !deps.threadNeedsMediaHydration(cached.thread);
    setTimeout(() => { try { deps.saveDisk(); } catch (_) {} }, 0);
    const id = deps.getIdentitySnapshot();
    return {
      success: true,
      detail: { ...detail, isMine: deps.isOwnMessage(detail) },
      thread: deps.enrichThreadForDisplay(deps.annotateGchatThreadMine(cached.thread)),
      myUserName: id.myUserName || '',
      myIds: id.myIds || [],
      myLabels: id.myLabels || [],
      fromCache: true,
      pendingHistory: false
    };
  }

  async function buildOpenSpaceResult(space, extras = {}) {
    const spaceName = space?.name || space?.spaceName || extras.spaceName;
    if (!spaceName) throw new Error('缺少對話空間');
    const isDmHint = !!extras.isDm
      || extras.spaceType === 'DIRECT_MESSAGE'
      || space?.spaceType === 'DIRECT_MESSAGE';

    const detailCache = deps.getDetailCache();
    const cached = detailCache.resolveSpacePacket(spaceName, { isDm: isDmHint });

    if (extras.cacheOnly) {
      if (detailCache.canServePacket(cached, null)) {
        detailCache.logCacheHit('space', spaceName);
        return buildOpenSpaceFromCachedPacket(cached, space, extras);
      }
      return { success: false, cached: false };
    }

    if (detailCache.canServePacket(cached, null)) {
      return buildOpenSpaceFromCachedPacket(cached, space, extras);
    }

    const metaHint = await deps.ensureSpaceMeta(spaceName).catch(() => ({ label: '', spaceType: '' }));
    const spaceType = space?.spaceType || metaHint.spaceType || extras.spaceType || '';
    const isDm = spaceType === 'DIRECT_MESSAGE' || isDmHint;
    const label = deps.cleanSpaceLabel(
      extras.label || space?.displayName || metaHint.label || deps.getSpaceNames()?.[spaceName] || '對話',
      spaceType,
      isDm
    );
    if (label) deps.setSpaceName(spaceName, label);
    if (spaceType) deps.setSpaceType(spaceName, spaceType);

    if (extras.deferHistory) {
      deps.ensureMyChatUserName(spaceName).catch(() => {});
      const id = deps.getIdentitySnapshot();
      const detail = {
        name: '',
        spaceName,
        spaceDisplayName: label,
        spaceType,
        isDm,
        sender: extras.sender || label,
        senderName: extras.userName || '',
        snippet: '',
        text: '',
        createTime: '',
        createTimeLabel: '',
        threadName: '',
        media: [],
        isMine: false
      };
      return {
        success: true,
        detail,
        thread: [],
        myUserName: id.myUserName || '',
        myIds: id.myIds || [],
        myLabels: id.myLabels || [],
        fromCache: false,
        pendingHistory: true
      };
    }

    await deps.ensureMyChatUserName(spaceName);
    const packet = await packSpaceHistory(spaceName, {
      label,
      isDm,
      spaceType,
      userName: extras.userName || '',
      sender: extras.sender || label
    });
    const detail = packet?.detail || { spaceName, spaceDisplayName: label, isDm, spaceType };
    deps.rememberTodayTouch(detail, { read: true });
    deps.saveDisk();
    const id = deps.getIdentitySnapshot();
    return {
      success: true,
      detail,
      thread: packet?.thread || [detail],
      myUserName: id.myUserName || '',
      myIds: id.myIds || [],
      myLabels: id.myLabels || [],
      fromCache: false,
      pendingHistory: false
    };
  }

  return {
    packDetailForItem,
    packSpaceHistory,
    buildDetailResponse,
    buildOpenSpaceFromCachedPacket,
    buildOpenSpaceResult
  };
}

module.exports = { createDetailPackService };
