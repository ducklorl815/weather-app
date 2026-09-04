/**
 * GChat Message Transform — 訊息正規化與顯示強化（Phase 4B）
 * 不含 IPC／Google API；由 runtime 注入 cache 與文字／媒體 helper。
 */

function isForwardQuoteType(quoteType) {
  if (quoteType === 2 || quoteType === '2') return true;
  return String(quoteType || '').toUpperCase() === 'FORWARD';
}

function reactionKeyForRow(unicode, customUid) {
  const uid = String(customUid || '').trim();
  if (uid) return `custom:${uid}`;
  return String(unicode || '').trim().normalize('NFC');
}

/**
 * @param {{
 *   getUserNames: () => Record<string, string>,
 *   getSpaceNames: () => Record<string, string>,
 *   getUserIcons?: () => Record<string, { emoji?: string, iconUrl?: string }>,
 *   getSpaceIcons?: () => Record<string, { emoji?: string, iconUrl?: string }>,
 *   getPackets: () => Record<string, object>,
 *   getMessages: () => object[],
 *   pickGoodLabel: (...labels: string[]) => string,
 *   cleanSpaceLabel: (label: string, spaceType: string, isDm: boolean) => string,
 *   extractChatMediaMeta: (raw: object) => object[],
 *   mediaSnippet: (media: object[]) => string,
 *   extractChatCardText: (raw: object) => string,
 *   extractChatCardLinks: (raw: object) => { text: string, url: string }[],
 *   extractChatCardModels: (raw: object) => object[],
 *   buildChatCardsHtml: (cards: object[]) => string,
 *   compactEmojiAnnotations: (raw: object) => object[],
 *   buildChatMessageTextHtml: (raw: object, fallbackText?: string) => string,
 *   rebuildChatMessageTextHtml: (msg: object) => string,
 *   repairCustomEmojiImgHtml: (html: string) => string,
 *   scrubCustomEmojiPlaceholders: (text: string) => string,
 *   plainChatBody: (raw: object) => string,
 *   parseChatResource: (name: string) => object,
 *   snippetFromText: (text: string) => string,
 *   resolveSenderName: (sender: object, spaceName: string) => Promise<string>,
 *   chatOpenUrl: (spaceId: string, threadId: string) => string,
 *   ingestCustomEmojisFromMessageRaw: (raw: object) => void,
 *   getMyReactions: () => Record<string, Record<string, string>>,
 *   isCustomEmojiShortcode: (value: string) => boolean,
 *   resolveCustomEmojiFromShortcode: (value: string) => object | null,
 *   resolveCustomEmojiByUid: (uid: string) => object | null,
 *   resolveCustomEmojiDisplayUrl: (hit: object | null) => string
 * }} deps
 */
function createMessageTransformService(deps) {
  function findCachedChatMessageByName(messageName) {
    const name = String(messageName || '').trim();
    if (!name) return null;
    const packets = deps.getPackets() || {};
    const direct = packets[name]?.detail;
    if (direct?.name === name) return direct;
    for (const pack of Object.values(packets)) {
      if (!pack) continue;
      const inThread = (pack.thread || []).find((m) => m?.name === name);
      if (inThread) return inThread;
      if (pack.detail?.name === name) return pack.detail;
    }
    return (deps.getMessages() || []).find((m) => m?.name === name) || null;
  }

  function hydrateQuotedFromCache(quoted) {
    if (!quoted || typeof quoted !== 'object') return quoted;
    const hasBody = !!(quoted.text || quoted.textHtml || quoted.media?.length);
    if (hasBody) return quoted;
    const hit = findCachedChatMessageByName(quoted.name);
    if (!hit) return quoted;
    const sender = quoted.sender
      && !/^(轉傳訊息|訊息|引用訊息)$/.test(String(quoted.sender).trim())
      ? quoted.sender
      : (hit.sender || quoted.sender);
    return {
      ...quoted,
      sender: sender || quoted.sender || '訊息',
      text: hit.text || hit.snippet || quoted.text || '',
      textHtml: hit.textHtml || quoted.textHtml || '',
      media: hit.media?.length ? hit.media : (quoted.media || []),
      emojiAnnotations: quoted.emojiAnnotations?.length
        ? quoted.emojiAnnotations
        : (hit.emojiAnnotations || [])
    };
  }

  function extractQuotedMessage(raw) {
    const q = raw?.quotedMessageMetadata;
    if (!q?.name) return null;
    const snap = q.quotedMessageSnapshot || {};
    const isForward = isForwardQuoteType(q.quoteType);
    const userNames = deps.getUserNames() || {};
    let sender = '';
    if (typeof snap.sender === 'string') {
      sender = snap.sender.trim();
      if (sender.startsWith('users/')) {
        const label = userNames[sender] || '';
        if (label && label !== '成員' && label !== '未知') sender = label;
      }
    } else {
      sender = snap.sender?.displayName || snap.sender?.name || '';
    }
    const fmtPlain = String(snap.formattedText || '')
      .replace(/<users\/[^>]+>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const snapForMedia = Array.isArray(snap.attachments) && snap.attachments.length
      ? { attachment: snap.attachments }
      : snap;
    const snapMedia = deps.extractChatMediaMeta(snapForMedia);
    const mediaHint = deps.mediaSnippet(snapMedia);
    const text = String(snap.text || snap.fallbackText || snap.argumentText || fmtPlain || '').trim()
      || deps.extractChatCardText(snap)
      || mediaHint
      || '';
    const emojiAnnotations = deps.compactEmojiAnnotations(snap);
    const textHtml = (isForward && snap.formattedText)
      ? deps.buildChatMessageTextHtml({ ...snap, text: snap.text || fmtPlain, annotations: snap.annotations || [] })
      : '';
    const forwardFrom = q.forwardedMetadata?.spaceDisplayName
      ? String(q.forwardedMetadata.spaceDisplayName).trim()
      : (q.forwardedMetadata?.space?.displayName
        ? String(q.forwardedMetadata.space.displayName).trim()
        : '');
    return hydrateQuotedFromCache({
      name: q.name,
      lastUpdateTime: q.lastUpdateTime || snap.lastUpdateTime || snap.createTime || '',
      sender: sender || (isForward ? '轉傳訊息' : '訊息'),
      text: text.slice(0, 400),
      textHtml,
      emojiAnnotations,
      quoteType: q.quoteType || 'REPLY',
      forwardFrom,
      media: snapMedia
    });
  }

  function enrichReactionRow(row) {
    if (!row || typeof row !== 'object') return row;
    let customUid = String(row.customUid || '').trim();
    let unicode = String(row.unicode || '').trim();
    let label = String(row.label || '').trim();
    let imageUrl = String(row.imageUrl || '').trim();

    if (!customUid && deps.isCustomEmojiShortcode(unicode)) {
      const hit = deps.resolveCustomEmojiFromShortcode(unicode);
      if (hit) {
        customUid = hit.uid;
        label = hit.emojiName || label || unicode;
        imageUrl = hit.imageUrl || imageUrl;
        unicode = '';
      }
    }
    if (customUid) {
      const hit = deps.resolveCustomEmojiByUid(customUid);
      if (hit) {
        label = hit.emojiName || label;
        imageUrl = deps.resolveCustomEmojiDisplayUrl(hit) || imageUrl;
      }
    }
    const key = reactionKeyForRow(unicode, customUid);
    return {
      ...row,
      unicode,
      customUid,
      label: label || unicode || (customUid ? ':emoji:' : '🙂'),
      imageUrl,
      isCustom: !!customUid,
      reactionKey: key
    };
  }

  function enrichChatMessageForDisplay(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    const reactions = Array.isArray(msg.reactions)
      ? msg.reactions.map((r) => enrichReactionRow({ ...r }))
      : msg.reactions;
    let textHtml = deps.rebuildChatMessageTextHtml(msg);
    if (!textHtml && msg.textHtml) {
      textHtml = deps.repairCustomEmojiImgHtml(deps.scrubCustomEmojiPlaceholders(msg.textHtml));
    }
    let quoted = msg.quoted ? hydrateQuotedFromCache(msg.quoted) : msg.quoted;
    if (quoted && (quoted.text || quoted.textHtml)) {
      quoted = {
        ...quoted,
        textHtml: quoted.textHtml || deps.rebuildChatMessageTextHtml(quoted) || ''
      };
    }
    return { ...msg, reactions, textHtml, quoted };
  }

  function enrichChatThreadForDisplay(thread) {
    return (thread || []).map((m) => enrichChatMessageForDisplay(m));
  }

  function enrichGchatListItem(m) {
    if (!m) return m;
    const spaceNames = deps.getSpaceNames() || {};
    const userNames = deps.getUserNames() || {};
    const userIcons = deps.getUserIcons?.() || {};
    const spaceIcons = deps.getSpaceIcons?.() || {};
    const spaceLabel = m.spaceName ? (spaceNames[m.spaceName] || '') : '';
    const senderFromId = m.senderName ? (userNames[m.senderName] || '') : '';
    const sender = deps.pickGoodLabel(m.sender, senderFromId);
    const spaceDisplayName = deps.cleanSpaceLabel(
      deps.pickGoodLabel(m.spaceDisplayName, spaceLabel, sender),
      m.spaceType,
      m.isDm
    );
    const spaceIcon = m.spaceName ? (spaceIcons[m.spaceName] || {}) : {};
    const senderIcon = m.senderName ? (userIcons[m.senderName] || {}) : {};
    // [Important] 私人：優先寄件者大頭（對方）；群組：空間 icon
    const iconUrl = String(
      m.iconUrl
      || (m.isDm ? (senderIcon.iconUrl || spaceIcon.iconUrl) : (spaceIcon.iconUrl || senderIcon.iconUrl))
      || ''
    ).trim();
    const emoji = String(
      m.emoji
      || (m.isDm ? (senderIcon.emoji || spaceIcon.emoji) : (spaceIcon.emoji || senderIcon.emoji))
      || ''
    ).trim();
    return {
      ...m,
      sender: sender || m.sender || '',
      spaceDisplayName: spaceDisplayName || m.spaceDisplayName || '',
      iconUrl,
      emoji
    };
  }

  function extractReactionSummaries(raw, messageName = '') {
    const msgName = messageName || raw?.name || '';
    const myRx = deps.getMyReactions()?.[msgName] || {};
    return (raw?.emojiReactionSummaries || []).map((s) => {
      const custom = s?.emoji?.customEmoji || null;
      let customUid = String(custom?.uid || '').trim();
      let unicode = String(s?.emoji?.unicode || '').trim();
      let label = unicode
        || (custom?.emojiName ? String(custom.emojiName).trim() : '')
        || '🙂';

      if (!customUid && custom?.emojiName) {
        const hit = deps.resolveCustomEmojiFromShortcode(custom.emojiName);
        if (hit) {
          customUid = hit.uid;
          label = hit.emojiName || label;
        }
      }
      if (!customUid && deps.isCustomEmojiShortcode(unicode)) {
        const hit = deps.resolveCustomEmojiFromShortcode(unicode);
        if (hit) {
          customUid = hit.uid;
          label = hit.emojiName || label;
          unicode = '';
        }
      }

      const key = reactionKeyForRow(unicode, customUid);
      const resolved = customUid ? deps.resolveCustomEmojiByUid(customUid) : null;
      const imageUrl = deps.resolveCustomEmojiDisplayUrl(resolved);
      if (resolved?.emojiName) label = resolved.emojiName;

      return enrichReactionRow({
        unicode,
        customUid,
        label,
        imageUrl,
        count: Number(s?.reactionCount || 0) || 0,
        reactedByMe: !!(myRx[key] || (unicode && myRx[unicode]))
      });
    }).filter((r) => (r.unicode || r.customUid) && r.count > 0);
  }

  async function normalizeChatMessage(raw, spaceDisplayName) {
    deps.ingestCustomEmojisFromMessageRaw(raw);
    const name = raw?.name || '';
    const parsed = deps.parseChatResource(name);
    const threadName = raw?.thread?.name || parsed.threadName || '';
    const threadParsed = deps.parseChatResource(threadName);
    const createTime = raw?.createTime || '';
    const lastUpdateTime = raw?.lastUpdateTime || createTime || '';
    const media = deps.extractChatMediaMeta(raw);
    const cardText = deps.extractChatCardText(raw);
    const cardLinks = typeof deps.extractChatCardLinks === 'function'
      ? deps.extractChatCardLinks(raw)
      : [];
    const cardModels = typeof deps.extractChatCardModels === 'function'
      ? deps.extractChatCardModels(raw)
      : [];
    const cardHtml = typeof deps.buildChatCardsHtml === 'function'
      ? deps.buildChatCardsHtml(cardModels)
      : '';
    const displayText = deps.plainChatBody(raw) || cardText || '';
    const emojiAnnotations = deps.compactEmojiAnnotations(raw);
    const textHtml = deps.buildChatMessageTextHtml(raw, displayText);
    const snippetBase = displayText ? deps.snippetFromText(displayText) : '';
    const mediaHint = deps.mediaSnippet(media);
    const sender = await deps.resolveSenderName(raw?.sender, parsed.spaceName);
    const quoted = extractQuotedMessage(raw);
    const reactions = extractReactionSummaries(raw, name);
    const quotedSnippet = quoted?.text ? deps.snippetFromText(quoted.text) : '';
    const spaceNames = deps.getSpaceNames() || {};
    return {
      name,
      spaceName: parsed.spaceName,
      spaceId: parsed.spaceId,
      spaceDisplayName: spaceDisplayName || spaceNames[parsed.spaceName] || parsed.spaceId || '對話',
      messageId: parsed.messageId,
      threadName: threadName || '',
      threadId: threadParsed.threadId || '',
      text: displayText,
      textHtml,
      emojiAnnotations,
      cardText: cardText || '',
      cardLinks,
      cardHtml,
      snippet: snippetBase && mediaHint ? `${snippetBase} ${mediaHint}`
        : (snippetBase || mediaHint || quotedSnippet || (quoted ? '[轉傳訊息]' : '（無文字）')),
      sender,
      senderName: raw?.sender?.name || '',
      media,
      quoted,
      reactions,
      createTime,
      lastUpdateTime,
      createTimeLabel: createTime
        ? new Date(createTime).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '',
      openUrl: deps.chatOpenUrl(parsed.spaceId, threadParsed.threadId)
    };
  }

  async function normalizeChatMessages(rawList) {
    const msgs = [];
    for (const m of rawList || []) {
      msgs.push(await normalizeChatMessage(m));
    }
    return msgs;
  }

  return {
    findCachedChatMessageByName,
    hydrateQuotedFromCache,
    extractQuotedMessage,
    enrichReactionRow,
    enrichChatMessageForDisplay,
    enrichChatThreadForDisplay,
    enrichGchatListItem,
    normalizeChatMessage,
    normalizeChatMessages,
    extractReactionSummaries,
    reactionKeyForRow
  };
}

module.exports = {
  createMessageTransformService,
  isForwardQuoteType,
  reactionKeyForRow
};
