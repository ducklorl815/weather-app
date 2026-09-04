/**
 * Google Chat API 封裝（Phase 2A：Server 通訊層）
 * 只負責 HTTP / googleapis 呼叫，不含 Cache、normalize、UI。
 */
const { Readable } = require('stream');
const { gchatSyncLog } = require('./sync-log');

const MESSAGES_SEARCH_URL = 'https://chat.googleapis.com/v1/spaces/-/messages:search';

const FILTERS = {
  UNREAD_MENTION: 'is_unread() AND annotations.user_mentions.user.name:users/me',
  UNREAD_ALL: 'is_unread()'
};

/**
 * @param {{
 *   chatHttp: (method: string, url: string, data?: object) => Promise<object>,
 *   getChatService: () => object|null,
 *   withRetry?: (fn: () => Promise<unknown>, opts?: object) => Promise<unknown>,
 *   withAuthRetry?: (fn: () => Promise<unknown>) => Promise<unknown>,
 *   isReady: () => boolean,
 *   isQuotaBlocked?: () => boolean,
 *   markQuotaBlocked?: (err: Error, kind?: string) => void,
 *   isQuotaError?: (err: unknown) => boolean
 * }} deps
 */
function createChatApiService(deps) {
  const withRetry = deps.withRetry || ((fn) => fn());
  const withAuthRetry = deps.withAuthRetry || ((fn) => fn());

  async function callAuthApi(fn) {
    return withAuthRetry(fn);
  }

  function assertNotQuotaBlocked(kind = 'Chat API') {
    if (!deps.isQuotaBlocked?.()) return;
    const err = new Error('Resource has been exhausted (e.g. check quota).');
    err.code = 429;
    throw err;
  }

  function handleQuotaError(err, kind) {
    if (deps.isQuotaError?.(err)) {
      deps.markQuotaBlocked?.(err, kind);
    }
    throw err;
  }

  /**
   * @param {string} filter
   * @param {{ pageSize?: number }} [opts]
   * @returns {Promise<object[]>} search API results rows
   */
  async function searchMessages(filter, { pageSize = 50 } = {}) {
    if (!deps.isReady?.()) {
      gchatSyncLog('[API] search skipped (not ready)');
      return [];
    }
    gchatSyncLog('[API] messages:search', String(filter || '').slice(0, 48));
    const data = await withRetry(
      () => callAuthApi(() => deps.chatHttp('POST', MESSAGES_SEARCH_URL, {
        filter,
        pageSize,
        orderBy: 'createTime desc',
        view: 'SEARCH_MESSAGES_VIEW_FULL'
      })),
      { tries: 3, baseMs: 500 }
    );
    return Array.isArray(data?.results) ? data.results : [];
  }

  /**
   * spaces.messages.list — 回傳 API 原始 message 物件（未 normalize）
   * @param {string} spaceName
   * @param {{ pageSize?: number, orderBy?: string, filter?: string, threadName?: string }} [opts]
   */
  async function listMessagesRaw(spaceName, {
    pageSize = 50,
    orderBy = 'createTime desc',
    filter = '',
    threadName = ''
  } = {}) {
    const chatService = deps.getChatService?.();
    if (!deps.isReady?.() || !spaceName || !chatService) return [];
    assertNotQuotaBlocked('列出訊息');

    const params = {
      parent: spaceName,
      pageSize: Math.min(pageSize, 100),
      orderBy
    };
    const threadFilter = String(threadName || '').trim();
    if (threadFilter) {
      params.filter = `thread.name = "${threadFilter}"`;
    } else if (filter) {
      params.filter = filter;
    }

    gchatSyncLog('[API] messages.list', `${spaceName.slice(-20)} ps=${params.pageSize}`);
    try {
      const res = await callAuthApi(() => chatService.spaces.messages.list(params));
      return Array.isArray(res?.data?.messages) ? res.data.messages : [];
    } catch (err) {
      handleQuotaError(err, '列出訊息');
    }
  }

  async function listSpaceMessagesRaw(spaceName, { pageSize = 50, orderBy = 'createTime desc' } = {}) {
    return listMessagesRaw(spaceName, { pageSize, orderBy });
  }

  async function listThreadMessagesRaw(spaceName, threadName, { pageSize = 50, orderBy = 'createTime asc' } = {}) {
    if (!spaceName) return [];
    return listMessagesRaw(spaceName, { pageSize, orderBy, threadName });
  }

  /**
   * Reply Bar badge 用：帶 retry 的最新訊息列表（原始 API 物件）
   */
  async function listSpaceMessagesRawRetry(spaceName, { pageSize = 12, orderBy = 'createTime desc' } = {}) {
    return withRetry(
      () => listSpaceMessagesRaw(spaceName, { pageSize, orderBy }),
      { tries: 3, baseMs: 450 }
    );
  }

  /**
   * spaces.messages.get — 回傳 API 原始 message 物件（未 normalize）
   * @param {string} messageName
   */
  async function getMessageRaw(messageName) {
    const chatService = deps.getChatService?.();
    const name = String(messageName || '').trim();
    if (!deps.isReady?.() || !name || !chatService) return null;
    assertNotQuotaBlocked('取得訊息');

    gchatSyncLog('[API] messages.get', name.slice(-32));
    try {
      const res = await callAuthApi(() => chatService.spaces.messages.get({ name }));
      return res?.data || null;
    } catch (err) {
      handleQuotaError(err, '取得訊息');
    }
  }

  /**
   * spaces.get — 回傳 API 原始 space 物件
   */
  async function getSpaceRaw(spaceName) {
    const chatService = deps.getChatService?.();
    const name = String(spaceName || '').trim();
    if (!deps.isReady?.() || !name || !chatService) return null;
    assertNotQuotaBlocked('取得空間');

    gchatSyncLog('[API] spaces.get', name.slice(-20));
    try {
      const res = await callAuthApi(() => chatService.spaces.get({ name }));
      return res?.data || null;
    } catch (err) {
      handleQuotaError(err, '取得空間');
    }
  }

  /**
   * spaces.members.get — 回傳 API 原始 membership 物件
   */
  async function getSpaceMemberRaw(memberName) {
    const chatService = deps.getChatService?.();
    const name = String(memberName || '').trim();
    if (!deps.isReady?.() || !name || !chatService) return null;
    assertNotQuotaBlocked('取得成員');

    try {
      const res = await chatService.spaces.members.get({ name });
      return res?.data || null;
    } catch (err) {
      handleQuotaError(err, '取得成員');
    }
  }

  /**
   * spaces.members.list — 回傳 memberships[]（原始 API 物件）
   */
  async function listSpaceMembersRaw(spaceName, { pageSize = 50 } = {}) {
    const chatService = deps.getChatService?.();
    const parent = String(spaceName || '').trim();
    if (!deps.isReady?.() || !parent || !chatService) return [];
    assertNotQuotaBlocked('列出成員');

    try {
      const res = await chatService.spaces.members.list({
        parent,
        pageSize: Math.min(pageSize, 100)
      });
      return Array.isArray(res?.data?.memberships) ? res.data.memberships : [];
    } catch (err) {
      handleQuotaError(err, '列出成員');
    }
  }

  /**
   * spaces.list — 單頁空間列表（原始 API 物件）
   */
  async function listSpacesRaw({ pageSize = 100, pageToken = '', filter = '' } = {}) {
    const chatService = deps.getChatService?.();
    if (!deps.isReady?.() || !chatService) return { spaces: [], nextPageToken: '' };
    assertNotQuotaBlocked('列出空間');

    gchatSyncLog('[API] spaces.list', `ps=${pageSize} f=${String(filter || '').slice(0, 24)}`);
    try {
      const res = await chatService.spaces.list({
        pageSize: Math.min(pageSize, 100),
        pageToken: pageToken || undefined,
        filter: filter || undefined
      });
      return {
        spaces: Array.isArray(res?.data?.spaces) ? res.data.spaces : [],
        nextPageToken: res?.data?.nextPageToken || ''
      };
    } catch (err) {
      handleQuotaError(err, '列出空間');
    }
  }

  /**
   * spaces.findDirectMessage — 嘗試兩種參數格式，找不到回傳 null
   */
  async function findDirectMessageRaw(userResource) {
    const chatService = deps.getChatService?.();
    const resource = String(userResource || '').trim();
    if (!deps.isReady?.() || !resource || !chatService) return null;
    assertNotQuotaBlocked('尋找私人訊息');

    const tryFind = async (params) => {
      try {
        const res = await chatService.spaces.findDirectMessage(params);
        return res?.data?.name ? res.data : null;
      } catch (err) {
        if (deps.isQuotaError?.(err)) {
          deps.markQuotaBlocked?.(err, '尋找私人訊息');
        }
        return null;
      }
    };

    gchatSyncLog('[API] spaces.findDirectMessage', resource.slice(-24));
    return (await tryFind({ requestBody: { name: resource } }))
      || (await tryFind({ name: resource }));
  }

  /**
   * spaces.setup — 回傳建立的 space 物件（原始 API）
   */
  async function setupSpaceRaw(requestBody) {
    const chatService = deps.getChatService?.();
    if (!deps.isReady?.() || !chatService) return null;
    assertNotQuotaBlocked('建立空間');

    gchatSyncLog('[API] spaces.setup', String(requestBody?.space?.spaceType || 'SPACE'));
    try {
      const created = await chatService.spaces.setup({ requestBody });
      return created?.data?.space || created?.data || null;
    } catch (err) {
      handleQuotaError(err, '建立空間');
    }
  }

  /**
   * spaces.messages.create — 回傳 API 原始 message 物件（未 normalize）
   * @param {{ parent: string, requestBody: object, messageReplyOption?: string }} params
   */
  async function createMessageRaw(params) {
    const chatService = deps.getChatService?.();
    if (!deps.isReady?.() || !chatService) return null;
    const parent = String(params?.parent || '').trim();
    if (!parent) return null;
    assertNotQuotaBlocked('發送訊息');

    gchatSyncLog('[API] messages.create', parent.slice(-20));
    try {
      const res = await callAuthApi(() => chatService.spaces.messages.create(params));
      return res?.data || null;
    } catch (err) {
      handleQuotaError(err, '發送訊息');
    }
  }

  /**
   * spaces.messages.reactions.list — 回傳 reactions[]（原始 API 物件）
   */
  async function listReactionsRaw(messageName, { filter = '', pageSize = 1 } = {}) {
    const chatService = deps.getChatService?.();
    const parent = String(messageName || '').trim();
    if (!deps.isReady?.() || !parent || !chatService) return [];
    assertNotQuotaBlocked('列出表情');

    try {
      const res = await chatService.spaces.messages.reactions.list({
        parent,
        filter,
        pageSize
      });
      return Array.isArray(res?.data?.reactions) ? res.data.reactions : [];
    } catch (err) {
      handleQuotaError(err, '列出表情');
    }
  }

  /**
   * spaces.messages.reactions.create — 回傳 API 原始 reaction 物件
   */
  async function createReactionRaw(messageName, requestBody) {
    const chatService = deps.getChatService?.();
    const parent = String(messageName || '').trim();
    if (!deps.isReady?.() || !parent || !chatService) return null;
    assertNotQuotaBlocked('新增表情');

    gchatSyncLog('[API] reactions.create', parent.slice(-24));
    try {
      const res = await chatService.spaces.messages.reactions.create({
        parent,
        requestBody
      });
      return res?.data || null;
    } catch (err) {
      handleQuotaError(err, '新增表情');
    }
  }

  /**
   * spaces.messages.reactions.delete
   */
  async function deleteReactionRaw(reactionName) {
    const chatService = deps.getChatService?.();
    const name = String(reactionName || '').trim();
    if (!deps.isReady?.() || !name || !chatService) return false;
    assertNotQuotaBlocked('刪除表情');

    gchatSyncLog('[API] reactions.delete', name.slice(-24));
    try {
      await chatService.spaces.messages.reactions.delete({ name });
      return true;
    } catch (err) {
      handleQuotaError(err, '刪除表情');
    }
  }

  /**
   * media.upload — 回傳 attachment 中繼資料（原始 API 物件）
   * @param {string} spaceName
   * @param {{ filename?: string, mimeType?: string, data: Buffer|Uint8Array }} file
   */
  async function uploadAttachmentRaw(spaceName, file) {
    const chatService = deps.getChatService?.();
    const parent = String(spaceName || '').trim();
    if (!chatService || !parent || !file?.data) return null;
    assertNotQuotaBlocked('上傳附件');

    const buf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    if (!buf.length) return null;

    const filename = String(file.filename || 'file').slice(0, 200);
    const mimeType = String(file.mimeType || 'application/octet-stream');
    gchatSyncLog('[API] media.upload', `${parent.slice(-16)} ${filename.slice(0, 24)}`);
    try {
      const res = await chatService.media.upload({
        parent,
        requestBody: { filename },
        media: {
          mimeType,
          body: Readable.from(buf)
        }
      });
      return res?.data || null;
    } catch (err) {
      handleQuotaError(err, '上傳附件');
    }
  }

  /**
   * media.download — 回傳二進位 Buffer（不含 data URL 轉換）
   */
  async function downloadMediaRaw(resourceName) {
    const chatService = deps.getChatService?.();
    const name = String(resourceName || '').trim();
    if (!deps.isReady?.() || !name || !chatService) return null;
    assertNotQuotaBlocked('媒體下載');

    gchatSyncLog('[API] media.download', name.slice(-32));
    try {
      const res = await callAuthApi(() => chatService.media.download({
        resourceName: name,
        alt: 'media'
      }, { responseType: 'arraybuffer' }));
      const buf = Buffer.from(res.data);
      return buf.length ? buf : null;
    } catch (err) {
      handleQuotaError(err, '媒體下載');
    }
  }

  async function updateSpaceReadState(spaceName, lastReadTime) {
    const chatService = deps.getChatService?.();
    const key = String(spaceName || '').trim();
    const spaceId = key.replace(/^spaces\//, '');
    const readTime = String(lastReadTime || '').trim();
    if (!spaceId || !chatService) throw new Error('空間格式無效');
    if (!readTime) throw new Error('缺少 lastReadTime');
    if (!deps.isReady?.()) throw new Error('Chat 未就緒');

    gchatSyncLog('[API] updateSpaceReadState', spaceId.slice(-16));
    try {
      await withRetry(
        () => chatService.users.spaces.updateSpaceReadState({
          name: `users/me/spaces/${spaceId}/spaceReadState`,
          updateMask: 'lastReadTime',
          requestBody: {
            name: `users/me/spaces/${spaceId}/spaceReadState`,
            lastReadTime: readTime
          }
        }),
        { tries: 3, baseMs: 400 }
      );
      return { spaceOk: true, lastReadTime: readTime };
    } catch (err) {
      handleQuotaError(err, '更新已讀狀態');
    }
  }

  return {
    searchMessages,
    searchUnreadMentioned(opts) {
      return searchMessages(FILTERS.UNREAD_MENTION, opts);
    },
    searchUnreadAll(opts) {
      return searchMessages(FILTERS.UNREAD_ALL, opts);
    },
    probeUnreadSearch() {
      return searchMessages(FILTERS.UNREAD_ALL, { pageSize: 1 });
    },
    listMessagesRaw,
    listSpaceMessagesRaw,
    listThreadMessagesRaw,
    listSpaceMessagesRawRetry,
    getMessageRaw,
    getSpaceRaw,
    getSpaceMemberRaw,
    listSpaceMembersRaw,
    listSpacesRaw,
    findDirectMessageRaw,
    setupSpaceRaw,
    createMessageRaw,
    listReactionsRaw,
    createReactionRaw,
    deleteReactionRaw,
    uploadAttachmentRaw,
    downloadMediaRaw,
    updateSpaceReadState,
    FILTERS,
    MESSAGES_SEARCH_URL
  };
}

module.exports = { createChatApiService, FILTERS, MESSAGES_SEARCH_URL };
