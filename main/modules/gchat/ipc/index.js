/**
 * GChat IPC 註冊入口（Phase 3A+）
 * Handler 僅負責 wiring；業務邏輯經 deps 注入。
 */
const { registerPrefsHandlers } = require('./handlers/prefs');
const { registerInboxHandlers } = require('./handlers/inbox');
const { registerDetailHandlers } = require('./handlers/detail');
const { registerMessagingHandlers } = require('./handlers/messaging');
const { registerSearchHandlers } = require('./handlers/search');
const { registerUiHandlers } = require('./handlers/ui');

/**
 * @typedef {object} GchatPrefsApi
 * @property {() => object} load
 * @property {(prefs: object) => object} save
 */

/**
 * @typedef {object} GchatInboxApi
 * @property {() => boolean} isChatReady
 * @property {() => Promise<object>} requireSession
 * @property {() => Promise<string>} getScope
 * @property {(scope: string) => boolean} hasChatScopes
 * @property {() => void} loadDisk
 * @property {() => object} snapshot
 * @property {() => Promise<unknown>} probeUnread
 * @property {(err: unknown) => object} explainError
 * @property {() => string} setupUrl
 * @property {() => Promise<void>} syncInbox
 * @property {() => void} [onSyncError]
 */

/**
 * @typedef {object} GchatDetailApi
 * @property {() => boolean} isChatReady
 * @property {(err: unknown) => object} explainError
 * @property {() => object} getDetailCache
 * @property {(cached: object, listHit: object|null, opts?: object) => Promise<object>} buildDetailResponse
 * @property {(detail: object, cached: object, opts?: object) => Promise<object>} buildThreadRefreshFromCache
 * @property {(messageName: string) => boolean} isMessageUnread
 * @property {(spaceName: string) => boolean} isPinnedSpace
 * @property {() => boolean} hasIdentity
 * @property {(spaceName: string) => Promise<string>} ensureMyUserName
 * @property {(spaceName: string) => Promise<string>} resolveMyUserFromSpace
 * @property {(messageName: string) => Promise<object|null>} fetchMessageDetail
 * @property {(item: object, opts?: object) => Promise<object|null>} packDetailForItem
 * @property {(item: object, opts?: object) => void} rememberTodayTouch
 * @property {() => void} saveDisk
 * @property {(detail: object) => object} formatDetail
 * @property {(thread: object[]) => object[]} formatThread
 * @property {() => { myUserName: string, myIds: string[], myLabels: string[] }} getIdentitySnapshot
 * @property {() => object} quotaStatus
 * @property {(spaceName: string, opts?: object) => object|null} findReadyPacketBySpace
 * @property {(spaceName: string, threadName?: string) => string} threadPollKey
 * @property {(pollKey: string, detail: object) => Promise<object>} requestThreadSync
 * @property {(err: unknown, kind: string) => void} markQuotaBlocked
 * @property {(err: unknown) => boolean} isQuotaError
 */

/**
 * @typedef {object} GchatMessagingApi
 * @property {() => boolean} isChatReady
 * @property {(err: unknown) => object} explainError
 * @property {(quoteMessageName: string) => string} findQuoteLastUpdateTime
 * @property {(file: object) => Promise<object|null>} bufferAttachment
 * @property {(spaceName: string, prepared: object) => Promise<object|null>} uploadAttachment
 * @property {(params: object) => Promise<object>} createMessage
 * @property {(spaceName: string, payload: object, createdName: string) => void} onReplySent
 * @property {(messageName: string, payload: object, text: string) => void} markReadAfterReply
 * @property {(data: object) => Promise<object>} normalizeMessage
 * @property {(createdData: object, createdMsg: object|null) => void} rememberIdentityFromMessage
 * @property {(item: object, opts?: object) => void} rememberTodayTouch
 * @property {(msg: object, ctx: object) => void} appendToPacket
 * @property {() => void} saveDisk
 * @property {() => object} snapshot
 * @property {() => void} broadcastListUpdate
 * @property {(detail: object, opts?: object) => void} notifyOpenThread
 * @property {(unicode: string, customUid: string) => string} reactionKeyForRow
 * @property {(name: string) => object} parseChatResource
 * @property {(spaceName: string) => Promise<string>} ensureMyUserName
 * @property {(uid: string) => Promise<object|null>} resolveCustomEmoji
 * @property {(uid: string) => object|null} resolveCustomEmojiByUid
 * @property {(row: object) => object} enrichReactionRow
 * @property {(messageName: string, reactionKey: string) => string} getStoredReactionName
 * @property {(messageName: string, reactionKey: string, reactionName: string) => void} setStoredReactionName
 * @property {(messageName: string, reactionKey: string) => Promise<string>} findMyReactionName
 * @property {(reactionName: string) => Promise<void>} deleteReaction
 * @property {(messageName: string, requestBody: object) => Promise<object>} createReaction
 * @property {(messageName: string, reactionKey: string, action: string, patchMeta?: object) => void} patchReactionsInCache
 * @property {(err: unknown) => string} googleErrText
 * @property {(messageName: string, extra?: object) => Promise<object>} markConversationRead
 */

/**
 * @typedef {object} GchatSearchApi
 * @property {() => boolean} isOAuthReady
 * @property {() => boolean} isChatReady
 * @property {(err: unknown) => object} explainError
 * @property {(err: unknown) => string} googleErrText
 * @property {() => void} loadEmojiRegistry
 * @property {() => object} customEmojiSnapshot
 * @property {() => boolean} isEmojiQuotaBlocked
 * @property {(opts?: object) => Promise<void>} refreshEmojiCache
 * @property {(label: string, err: unknown) => void} logApiIssue
 * @property {(opts?: object) => Promise<void>} hydrateEmojiImages
 * @property {() => number} emojiHydrateBatch
 * @property {() => object[]} listEmojisForUi
 * @property {() => void} openQuickSearchWindow
 * @property {() => void} hideQuickSearchWindow
 * @property {(query: string, limit?: number) => Promise<object[]>} searchContacts
 * @property {(query: string, limit?: number) => Promise<object[]>} searchSpaces
 * @property {() => string} getDirectoryError
 * @property {(userName: string) => string} findPinnedContactSpaceName
 * @property {(userName: string, spaceName: string) => void} updatePinnedContactSpaceName
 * @property {(userName: string) => Promise<object>} findOrOpenDm
 * @property {(space: object, extras?: object) => Promise<object>} buildOpenSpaceResult
 * @property {() => object} loadPrefs
 * @property {(prefs: object) => object} savePrefs
 * @property {() => object} snapshot
 * @property {() => void} broadcastListUpdate
 * @property {() => Promise<void>} packPinnedConversations
 * @property {() => void} saveDisk
 */

/**
 * @typedef {object} GchatUiApi
 * @property {(message: object) => unknown} showToast
 * @property {() => void} hideToast
 * @property {(height: number) => void} resizeToast
 * @property {(messageName: string, extra?: object) => Promise<object>} markConversationRead
 * @property {(spaceName: string, extra?: object) => Promise<object>} markSpaceRead
 * @property {(messageName: string, opts?: object) => Promise<object>} openCompactReply
 * @property {(event: object) => import('electron').BrowserWindow|null} getWindowFromEvent
 * @property {() => import('electron').BrowserWindow|null} getMainWindow
 * @property {(opts: object) => object|null} findReplyEntry
 * @property {(messageName: string) => object|null} getReplyPopEntry
 * @property {() => string} getActiveReplyPopMessageName
 * @property {(messageName: string, replyWin: object) => void} setActiveReplyPop
 * @property {(entry: object|string) => Promise<object>} closeReplyCompletely
 * @property {(convKey: string) => Promise<object>} toggleReplyFromBar
 * @property {(entry: object, title?: string) => Promise<object>} minimizeReply
 * @property {(entry: object) => Promise<object>} restoreReply
 * @property {(entry: object) => Promise<object>} toggleReplyFullscreen
 * @property {() => void} positionMinimizedBars
 * @property {(entry: object) => string} entryConvKey
 * @property {() => void} syncOverlayZOrder
 * @property {(closedName: string, entry: object|null) => void} clearViewingIfClosed
 * @property {(fromWin: object|null, payload: object) => object} applyCompactTitle
 * @property {() => string} getAppTheme
 * @property {(ctx: object|null) => object} setViewing
 * @property {(enabled: boolean) => object} alertWatch
 * @property {(url: string) => Promise<void>} openExternal
 * @property {() => string} setupUrl
 * @property {() => string} appConfigUrl
 * @property {() => string} adminSetupUrl
 */

/**
 * @typedef {object} GchatIpcDeps
 * @property {GchatPrefsApi} prefs
 * @property {GchatInboxApi} [inbox]
 * @property {GchatDetailApi} [detail]
 * @property {GchatMessagingApi} [messaging]
 * @property {GchatSearchApi} [search]
 * @property {GchatUiApi} [ui]
 * @property {(incoming: object, saved: object) => void} [onPrefsSaved]
 */

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {GchatIpcDeps} deps
 */
function registerGchatIpc(ipcMain, deps) {
  if (!ipcMain || !deps?.prefs?.load || !deps?.prefs?.save) {
    throw new Error('registerGchatIpc: 缺少 ipcMain 或 prefs deps');
  }
  registerPrefsHandlers(ipcMain, deps);
  if (deps.inbox) {
    registerInboxHandlers(ipcMain, deps);
  }
  if (deps.detail) {
    registerDetailHandlers(ipcMain, deps);
  }
  if (deps.messaging) {
    registerMessagingHandlers(ipcMain, deps);
  }
  if (deps.search) {
    registerSearchHandlers(ipcMain, deps);
  }
  if (deps.ui) {
    registerUiHandlers(ipcMain, deps);
  }
}

module.exports = {
  registerGchatIpc
};
