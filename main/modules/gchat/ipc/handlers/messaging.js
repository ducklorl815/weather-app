/**
 * GChat IPC — 回覆 / 表情 / 標已讀
 */

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../index').GchatIpcDeps} deps
 */
function registerMessagingHandlers(ipcMain, deps) {
  const msg = deps.messaging;

  ipcMain.handle('gchat-reply', async (_event, payload) => {
    try {
      if (!msg.isChatReady()) {
        return { success: false, error: '請先用 Google 登入' };
      }
      const text = String(payload?.text || '').trim();
      const spaceName = payload?.spaceName;
      const attachmentsIn = Array.isArray(payload?.attachments) ? payload.attachments : [];
      if (!spaceName) return { success: false, error: '缺少對話空間' };
      if (!text && !attachmentsIn.length) return { success: false, error: '請輸入回覆內容或附加檔案' };

      const requestBody = {};
      if (text) requestBody.text = text;
      const params = { parent: spaceName, requestBody };
      const replyInThread = payload?.replyInThread === true;
      const quoteMessageName = String(payload?.quoteMessageName || '').trim();
      let quoteLastUpdateTime = String(
        payload?.quoteLastUpdateTime || payload?.quoteCreateTime || ''
      ).trim();
      if (quoteMessageName && !quoteLastUpdateTime) {
        quoteLastUpdateTime = msg.findQuoteLastUpdateTime(quoteMessageName);
      }

      if (quoteMessageName && quoteLastUpdateTime) {
        requestBody.quotedMessageMetadata = {
          name: quoteMessageName,
          lastUpdateTime: quoteLastUpdateTime
        };
      } else if (quoteMessageName && !quoteLastUpdateTime) {
        console.warn('引用回覆缺少 lastUpdateTime，改以討論串回覆（無引用卡）');
      }

      if (replyInThread) {
        const threadTarget = payload.threadName || payload.messageName || quoteMessageName;
        if (threadTarget) {
          requestBody.thread = { name: threadTarget };
          params.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
        }
      }

      if (attachmentsIn.length) {
        const uploadedList = [];
        for (const file of attachmentsIn.slice(0, 5)) {
          const prepared = await msg.bufferAttachment(file);
          if (!prepared) continue;
          const uploaded = await msg.uploadAttachment(spaceName, prepared);
          if (uploaded) uploadedList.push(uploaded);
        }
        if (uploadedList.length) requestBody.attachment = uploadedList;
      }

      const createdData = await msg.createMessage(params);
      const createdName = createdData?.name || '';
      msg.onReplySent(spaceName, payload, createdName);

      if (payload.messageName) {
        msg.markReadAfterReply(payload.messageName, payload, text);
      }

      let createdMsg = null;
      try {
        if (createdData) {
          createdMsg = await msg.normalizeMessage(createdData);
          msg.rememberIdentityFromMessage(createdData, createdMsg);
          createdMsg.isMine = true;
          createdMsg.sender = '我';
          msg.rememberTodayTouch({
            ...(createdMsg || {}),
            spaceName: spaceName || createdMsg?.spaceName,
            threadName: payload.threadName || createdMsg?.threadName || '',
            isDm: !!payload.isDm,
            spaceType: payload.spaceType || createdMsg?.spaceType || '',
            spaceDisplayName: payload.spaceDisplayName || createdMsg?.spaceDisplayName || '',
            sender: payload.sender || createdMsg?.sender || '我',
            snippet: text || createdMsg?.snippet || '[附件]',
            isMine: true
          }, { read: true });
          msg.appendToPacket(createdMsg, {
            spaceName,
            isDm: !!payload.isDm,
            spaceType: payload.spaceType || '',
            spaceDisplayName: payload.spaceDisplayName || '',
            threadName: payload.threadName || createdMsg?.threadName || '',
            sender: payload.sender || ''
          });
          msg.saveDisk();
        }
      } catch (_) {}

      const snap = msg.snapshot();
      msg.broadcastListUpdate();
      if (spaceName) {
        msg.notifyOpenThread({
          spaceName,
          threadName: payload.threadName || createdMsg?.threadName || '',
          name: createdMsg?.name || payload.messageName || '',
          isDm: !!payload.isDm
        }, { silentRefresh: true });
      }
      return { success: true, created: createdMsg, ...snap };
    } catch (err) {
      return { success: false, ...msg.explainError(err) };
    }
  });

  ipcMain.handle('gchat-react', async (_event, payload) => {
    try {
      if (!msg.isChatReady()) {
        return { success: false, error: '請先用 Google 登入' };
      }
      const messageName = String(payload?.messageName || '').trim();
      const unicode = String(payload?.unicode || '').trim();
      const customUid = String(payload?.customUid || '').trim();
      const reactionKey = msg.reactionKeyForRow(unicode, customUid);
      if (!messageName) return { success: false, error: '缺少訊息' };
      if (!reactionKey) return { success: false, error: '請選擇表情' };

      const parsed = msg.parseChatResource(messageName);
      await msg.ensureMyUserName(parsed.spaceName);

      let resolvedCustom = null;
      if (customUid) {
        resolvedCustom = await msg.resolveCustomEmoji(customUid);
        if (!resolvedCustom) {
          return {
            success: false,
            error: '找不到此自訂表情，請重新整理表情列表後再試'
          };
        }
      }

      const patchMeta = msg.enrichReactionRow({
        unicode,
        customUid: resolvedCustom?.uid || customUid,
        label: resolvedCustom?.emojiName || unicode || customUid,
        imageUrl: resolvedCustom?.imageUrl || msg.resolveCustomEmojiByUid(customUid)?.imageUrl || ''
      });

      let reactionName = msg.getStoredReactionName(messageName, reactionKey);
      if (!reactionName) {
        reactionName = await msg.findMyReactionName(messageName, reactionKey);
        if (reactionName) msg.setStoredReactionName(messageName, reactionKey, reactionName);
      }

      if (reactionName) {
        await msg.deleteReaction(reactionName);
        msg.setStoredReactionName(messageName, reactionKey, '');
        msg.patchReactionsInCache(messageName, reactionKey, 'removed');
        return { success: true, action: 'removed', messageName, unicode, customUid, reactionKey };
      }

      const requestBody = resolvedCustom
        ? { emoji: { customEmoji: { name: resolvedCustom.name } } }
        : { emoji: { unicode } };

      try {
        const created = await msg.createReaction(messageName, requestBody);
        const createdName = created?.name || '';
        if (createdName) msg.setStoredReactionName(messageName, reactionKey, createdName);
        msg.patchReactionsInCache(messageName, reactionKey, 'added', patchMeta);
        return {
          success: true,
          action: 'added',
          messageName,
          unicode,
          customUid,
          reactionKey,
          reactionName: createdName
        };
      } catch (err) {
        const errText = msg.googleErrText(err);
        if (/ALREADY_EXISTS|already exists|duplicate/i.test(errText)) {
          const existing = await msg.findMyReactionName(messageName, reactionKey);
          if (existing) {
            await msg.deleteReaction(existing);
            msg.setStoredReactionName(messageName, reactionKey, '');
            msg.patchReactionsInCache(messageName, reactionKey, 'removed');
            return { success: true, action: 'removed', messageName, unicode, customUid, reactionKey, already: true };
          }
          msg.patchReactionsInCache(messageName, reactionKey, 'added', patchMeta);
          return { success: true, action: 'added', messageName, unicode, customUid, reactionKey, already: true };
        }
        return { success: false, ...msg.explainError(err), error: errText || err.message };
      }
    } catch (err) {
      const errText = msg.googleErrText(err);
      return { success: false, ...msg.explainError(err), error: errText || err.message };
    }
  });

  ipcMain.handle('gchat-mark-read', async (_event, payload) => {
    try {
      const messageName = typeof payload === 'string' ? payload : payload?.name;
      if (!messageName) return { success: false, error: '缺少訊息' };
      const p = typeof payload === 'object' && payload ? payload : {};
      return await msg.markConversationRead(messageName, p);
    } catch (err) {
      return { success: false, ...msg.explainError(err) };
    }
  });
}

module.exports = { registerMessagingHandlers };
