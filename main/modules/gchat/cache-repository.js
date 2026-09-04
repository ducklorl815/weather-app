/**
 * Cache Repository — 唯一 Cache 寫入入口（Phase 2）
 * Inbox merge、message 去重、locallyRead 優先
 */
const { gchatSyncLog } = require('./sync-log');

/**
 * 合併單則訊息欄位（key = message.name）
 * @param {object|null|undefined} existing
 * @param {object} incoming
 * @param {{ pickLabel?: (a: string, b: string) => string }} [opts]
 */
function mergeMessageFields(existing, incoming, opts = {}) {
  if (!incoming || !incoming.name) return existing || null;
  if (!existing) return { ...incoming, isRead: incoming.isRead === true };
  const pick = opts.pickLabel || ((a, b) => (a && a !== '成員' && a !== '未知' ? a : b) || a || b || '');
  const incomingTime = String(incoming.createTime || '');
  const existingTime = String(existing.createTime || '');
  const incomingNewer = incomingTime && (!existingTime || incomingTime >= existingTime);
  const out = { ...existing, ...incoming };
  if (incomingNewer) {
    out.snippet = incoming.snippet ?? existing.snippet;
    out.text = incoming.text ?? existing.text;
    out.createTime = incoming.createTime ?? existing.createTime;
    out.createTimeLabel = incoming.createTimeLabel ?? existing.createTimeLabel;
    out.unreadCount = incoming.unreadCount ?? existing.unreadCount;
  } else {
    out.snippet = existing.snippet || incoming.snippet;
    out.text = existing.text || incoming.text;
    out.createTime = existing.createTime || incoming.createTime;
    out.createTimeLabel = existing.createTimeLabel || incoming.createTimeLabel;
  }
  out.sender = pick(incoming.sender, existing.sender) || existing.sender || incoming.sender;
  out.spaceDisplayName = pick(incoming.spaceDisplayName, existing.spaceDisplayName)
    || existing.spaceDisplayName || incoming.spaceDisplayName;
  out.spaceType = incoming.spaceType || existing.spaceType || '';
  out.isDm = incoming.isDm != null ? !!incoming.isDm : !!existing.isDm;
  out.mentionedMe = incoming.mentionedMe != null ? !!incoming.mentionedMe : !!existing.mentionedMe;
  if (incoming.isRead === true) out.isRead = true;
  else if (incoming.isRead === false) out.isRead = false;
  out.media = mergeMediaItems(existing.media, incoming.media);
  return out;
}

/** 合併 media 陣列：保留已下載的 dataUrl / previewUrl */
function mergeMediaItems(existingMedia, incomingMedia) {
  const existing = Array.isArray(existingMedia) ? existingMedia : [];
  const incoming = Array.isArray(incomingMedia) ? incomingMedia : [];
  if (!incoming.length) return existing.length ? [...existing] : [];
  if (!existing.length) return incoming.map((x) => ({ ...x }));

  const byKey = new Map();
  for (const x of existing) {
    const k = mediaItemKey(x);
    if (k) byKey.set(k, x);
  }

  return incoming.map((inc) => {
    const k = mediaItemKey(inc);
    const prev = k ? byKey.get(k) : null;
    if (!prev) return { ...inc };
    return {
      ...inc,
      dataUrl: inc.dataUrl || prev.dataUrl || '',
      previewUrl: inc.previewUrl || prev.previewUrl || inc.thumbnailUri || prev.thumbnailUri || '',
      thumbnailUri: inc.thumbnailUri || prev.thumbnailUri || '',
      resourceName: inc.resourceName || prev.resourceName || '',
      uri: inc.uri || prev.uri || ''
    };
  });
}

function mediaItemKey(item) {
  if (!item) return '';
  return String(item.resourceName || item.uri || item.name || '').trim();
}

/**
 * 合併訊息陣列（thread / packet），以 message.name 去重
 * @param {object[]} existingList
 * @param {object[]} incomingList
 * @param {object} [opts]
 * @returns {object[]}
 */
function mergeMessages(existingList, incomingList, opts = {}) {
  const byName = new Map();
  for (const m of existingList || []) {
    if (m?.name) byName.set(m.name, m);
  }
  for (const incoming of incomingList || []) {
    if (!incoming?.name) continue;
    const prev = byName.get(incoming.name);
    byName.set(incoming.name, prev ? mergeMessageFields(prev, incoming, opts) : { ...incoming });
  }
  return [...byName.values()].sort((a, b) => {
    const ta = String(a?.createTime || '');
    const tb = String(b?.createTime || '');
    if (ta === tb) return 0;
    return ta < tb ? -1 : 1;
  });
}

/**
 * @param {{
 *   getMessages: () => object[],
 *   setMessages: (msgs: object[]) => void,
 *   isLocallyReadMessage: (name: string, hint?: object) => boolean,
 *   rememberGchatTodayTouch: (item: object, opts?: object) => void,
 *   pickLabel?: (a: string, b: string) => string,
 *   markLocallyRead?: (name: string) => void
 * }} ctx
 * @param {object[]} serverItems
 */
function mergeUnreadInbox(ctx, serverItems) {
  const existingByName = new Map();
  for (const m of ctx.getMessages() || []) {
    if (m?.name) existingByName.set(m.name, m);
  }

  const resultByName = new Map();
  let inserted = 0;
  let updated = 0;
  let preservedRead = 0;

  for (const incoming of serverItems || []) {
    if (!incoming?.name) continue;

    if (ctx.isLocallyReadMessage(incoming.name, incoming)) {
      preservedRead += 1;
      ctx.rememberGchatTodayTouch(incoming, { read: true });
      continue;
    }

    const prev = existingByName.get(incoming.name);
    const merged = prev
      ? mergeMessageFields(prev, { ...incoming, isRead: false }, { pickLabel: ctx.pickLabel })
      : { ...incoming, isRead: false };

    if (!prev) inserted += 1;
    else updated += 1;

    resultByName.set(incoming.name, merged);
    ctx.rememberGchatTodayTouch(incoming, { read: false });
  }

  // [Important] Server 未讀清單為 inbox 權威來源；不在清單內的舊 inbox 項移除
  let removed = 0;
  for (const name of existingByName.keys()) {
    if (!resultByName.has(name)) removed += 1;
  }
  ctx.setMessages([...resultByName.values()]);

  return {
    count: resultByName.size,
    inserted,
    updated,
    preservedRead,
    removed
  };
}

/**
 * 本機已讀後更新 inbox（移除已讀項）
 * @param {{
 *   getMessages: () => object[],
 *   setMessages: (msgs: object[]) => void,
 *   markLocallyRead?: (name: string) => void
 * }} ctx
 */
function applyInboxLocalRead(ctx, { namesToClear = [], spaceName = '', readUntil = '' } = {}) {
  const names = new Set((namesToClear || []).filter(Boolean));
  const space = String(spaceName || '').trim();
  const until = String(readUntil || '').trim();
  const prev = ctx.getMessages() || [];
  const next = prev.filter((m) => {
    if (!m?.name) return false;
    if (names.has(m.name)) return false;
    if (space && m.spaceName === space && until && String(m.createTime || '') <= until) {
      ctx.markLocallyRead?.(m.name);
      return false;
    }
    return true;
  });
  ctx.setMessages(next);
  return { removed: prev.length - next.length };
}

/**
 * 移除整個 space 的 inbox 項（空間已讀）
 */
function removeInboxBySpace(ctx, spaceName) {
  const key = String(spaceName || '').trim();
  if (!key) return 0;
  const before = (ctx.getMessages() || []).length;
  ctx.setMessages((ctx.getMessages() || []).filter((m) => m?.spaceName !== key));
  return before - (ctx.getMessages() || []).length;
}

/**
 * @param {{
 *   prepareInboxSync: () => Promise<boolean>,
 *   fetchUnreadInboxItems: () => Promise<object[]>,
 *   finalizeInboxSync: () => Promise<void>,
 *   getRepoContext: () => object,
 *   gchatSnapshot: () => object,
 *   getInboxCount: () => number,
 *   onCacheChanged: (snapshot: object, meta: object) => void
 * }} deps
 */
function createCacheRepository(deps) {
  async function mergeUnreadInboxFromServer() {
    const prepared = await deps.prepareInboxSync();
    if (!prepared) {
      const count = deps.getInboxCount?.() ?? 0;
      return { count, skipped: true };
    }

    gchatSyncLog('[SYNC] search unread');
    const serverItems = await deps.fetchUnreadInboxItems();
    const stats = mergeUnreadInbox(deps.getRepoContext(), serverItems);

    await deps.finalizeInboxSync();

    gchatSyncLog('[CACHE] merged', `inbox=${stats.count} +${stats.inserted} ~${stats.updated} -${stats.removed || 0}`);
    if (stats.preservedRead > 0) {
      gchatSyncLog('[CACHE] locallyRead preserved', stats.preservedRead);
    }

    return {
      count: stats.count,
      inserted: stats.inserted,
      updated: stats.updated,
      preservedRead: stats.preservedRead,
      removed: stats.removed
    };
  }

  return {
    mergeMessageFields,
    mergeMessages,

    mergeUnreadInbox(serverItems) {
      return mergeUnreadInbox(deps.getRepoContext(), serverItems);
    },

    applyInboxLocalRead(opts) {
      return applyInboxLocalRead(deps.getRepoContext(), opts);
    },

    removeInboxBySpace(spaceName) {
      return removeInboxBySpace(deps.getRepoContext(), spaceName);
    },

    /** 編排入口：prepare → fetch → merge → finalize */
    mergeUnreadInboxFromServer,

    emitChanged(reason = 'update') {
      const snapshot = deps.gchatSnapshot();
      deps.onCacheChanged(snapshot, { reason });
    }
  };
}

module.exports = {
  createCacheRepository,
  mergeMessageFields,
  mergeMessages,
  mergeMediaItems,
  mergeUnreadInbox,
  applyInboxLocalRead,
  removeInboxBySpace
};
