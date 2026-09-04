/**
 * GChat IPC — 搜尋 / 開啟空間 / 置頂 / 自訂表情 / Quick Search
 */

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../index').GchatIpcDeps} deps
 */
function registerSearchHandlers(ipcMain, deps) {
  const search = deps.search;

  ipcMain.handle('gchat-custom-emojis', async (_event, payload = {}) => {
    try {
      if (!search.isOAuthReady()) return { success: false, error: '請先用 Google 登入' };
      search.loadEmojiRegistry();
      const force = !!(payload?.force);
      let snap = search.customEmojiSnapshot();
      const needHydrate = force || snap.withImage < Math.min(24, snap.count);
      if (needHydrate && snap.count) {
        const quotaBlocked = search.isEmojiQuotaBlocked();
        if (!quotaBlocked) {
          try {
            await search.refreshEmojiCache({ force: false });
          } catch (err) {
            search.logApiIssue('自訂表情列表更新', err);
          }
          await search.hydrateEmojiImages({ max: force ? 72 : search.emojiHydrateBatch() });
        }
        snap = search.customEmojiSnapshot();
      }
      const emojis = search.listEmojisForUi();
      const withImage = emojis.filter((e) => e.imageUrl).length;
      if (emojis.length) {
        return {
          success: true,
          emojis,
          cached: true,
          count: emojis.length,
          withImage,
          quotaBlocked: search.isEmojiQuotaBlocked(),
          warning: withImage
            ? (withImage < emojis.length ? `部分自訂表情 (${withImage}/${emojis.length}) 圖片仍在載入` : '')
            : (snap.count
              ? '自訂表情快取尚未下載完成，正在背景載入'
              : '尚無自訂表情快取，請重新登入後再試')
        };
      }
      return {
        success: true,
        emojis: [],
        cached: true,
        warning: '尚無自訂表情快取，請重新登入後再試'
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('gchat-quick-search-show', async () => {
    try {
      search.openQuickSearchWindow();
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('gchat-quick-search-hide', async () => {
    search.hideQuickSearchWindow();
    return { success: true };
  });

  ipcMain.handle('gchat-quick-search-arm', async (_event, payload) => {
    const armed = search.setQuickSearchArmed?.(!!payload?.active);
    return { success: true, armed: !!armed };
  });

  ipcMain.handle('gchat-search', async (_event, payload) => {
    try {
      if (!search.isChatReady()) {
        return { success: false, error: '請先用 Google 登入', contacts: [], spaces: [] };
      }
      const query = String(payload?.query || '').trim();
      if (!query) return { success: true, contacts: [], spaces: [] };
      const [contacts, spaces] = await Promise.all([
        search.searchContacts(query, 20),
        search.searchSpaces(query, 20)
      ]);
      return {
        success: true,
        contacts,
        spaces,
        directoryError: search.getDirectoryError()
      };
    } catch (err) {
      return {
        success: false,
        error: search.googleErrText(err) || err.message,
        contacts: [],
        spaces: []
      };
    }
  });

  // 群組 @ 建議：只撈該空間成員（不做邀請）
  ipcMain.handle('gchat-space-members', async (_event, payload) => {
    try {
      if (!search.isChatReady()) {
        return { success: false, error: '請先用 Google 登入', members: [] };
      }
      const spaceName = String(payload?.spaceName || '').trim();
      if (!spaceName) return { success: false, error: '缺少空間', members: [] };
      const members = await search.listSpaceMembersForMention?.(spaceName) || [];
      return { success: true, members, spaceName };
    } catch (err) {
      return {
        success: false,
        error: search.googleErrText?.(err) || err.message,
        members: []
      };
    }
  });

  ipcMain.handle('gchat-open-space', async (_event, payload) => {
    try {
      if (!search.isChatReady()) {
        return { success: false, error: '請先用 Google 登入' };
      }
      let spaceName = String(payload?.spaceName || '').trim();
      let space = null;
      if (!spaceName && payload?.userName) {
        spaceName = search.findPinnedContactSpaceName(payload.userName);
      }
      if (!spaceName && payload?.userName) {
        space = await search.findOrOpenDm(payload.userName);
        spaceName = space?.name || '';
        if (spaceName) {
          search.updatePinnedContactSpaceName(payload.userName, spaceName);
        }
      }
      if (!spaceName) return { success: false, error: '找不到對話空間' };
      if (!space) {
        space = {
          name: spaceName,
          spaceType: payload?.spaceType || '',
          displayName: payload?.label || ''
        };
      }
      return await search.buildOpenSpaceResult(space, {
        spaceName,
        label: payload?.label || '',
        isDm: !!payload?.isDm || payload?.spaceType === 'DIRECT_MESSAGE' || !!payload?.userName,
        spaceType: payload?.spaceType || space.spaceType || '',
        userName: payload?.userName || '',
        sender: payload?.label || '',
        deferHistory: !!payload?.deferHistory,
        cacheOnly: !!payload?.cacheOnly
      });
    } catch (err) {
      return {
        success: false,
        ...search.explainError(err),
        error: search.googleErrText(err) || err.message
      };
    }
  });

  ipcMain.handle('gchat-pin-toggle', async (_event, payload) => {
    try {
      const prefs = search.loadPrefs();
      const kind = String(payload?.kind || '').trim();
      // 僅從伺服器／名稱開頭 emoji 帶入；不做本機手動設定
      const pickEmoji = (label, explicit) => {
        const e = String(explicit || '').trim();
        if (e) return e.slice(0, 16);
        const s = String(label || '').trim();
        try {
          const m = s.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u);
          return m ? m[1] : '';
        } catch (_) {
          return '';
        }
      };
      let justPinned = false;
      if (kind === 'contact') {
        const userName = String(payload?.userName || '').trim();
        if (!userName) return { success: false, error: '缺少聯絡人' };
        const list = [...(prefs.pinnedContacts || [])];
        const idx = list.findIndex((x) => x.userName === userName);
        if (idx >= 0) list.splice(idx, 1);
        else {
          justPinned = true;
          let spaceName = String(payload?.spaceName || '').trim();
          if (!spaceName && search.isChatReady()) {
            try {
              const sp = await search.findOrOpenDm(userName);
              spaceName = sp?.name || '';
            } catch (_) {}
          }
          const label = String(payload?.label || userName).trim();
          list.unshift({
            userName,
            label,
            email: String(payload?.email || '').trim(),
            spaceName: spaceName || '',
            emoji: pickEmoji(label, payload?.emoji),
            iconUrl: String(payload?.iconUrl || '').trim(),
            pinnedAt: Date.now()
          });
        }
        const next = search.savePrefs({ ...prefs, pinnedContacts: list.slice(0, 40) });
        search.broadcastListUpdate();
        if (justPinned) {
          setTimeout(() => {
            Promise.resolve()
              .then(() => search.hydratePinnedIcons?.())
              .then(() => search.packPinnedConversations())
              .then(() => { try { search.saveDisk(); } catch (_) {} })
              .catch(() => {});
          }, 0);
        }
        return { success: true, ...next, ...search.snapshot() };
      }
      if (kind === 'space') {
        const spaceName = String(payload?.spaceName || '').trim();
        if (!spaceName) return { success: false, error: '缺少群組' };
        const list = [...(prefs.pinnedSpaces || [])];
        const idx = list.findIndex((x) => x.spaceName === spaceName);
        if (idx >= 0) list.splice(idx, 1);
        else {
          justPinned = true;
          const label = String(payload?.label || spaceName).trim();
          list.unshift({
            spaceName,
            label,
            spaceType: String(payload?.spaceType || '').trim(),
            isDm: !!payload?.isDm,
            emoji: pickEmoji(label, payload?.emoji),
            iconUrl: String(payload?.iconUrl || '').trim(),
            pinnedAt: Date.now()
          });
        }
        const next = search.savePrefs({ ...prefs, pinnedSpaces: list.slice(0, 40) });
        search.broadcastListUpdate();
        if (justPinned) {
          setTimeout(() => {
            Promise.resolve()
              .then(() => search.hydratePinnedIcons?.())
              .then(() => search.packPinnedConversations())
              .then(() => { try { search.saveDisk(); } catch (_) {} })
              .catch(() => {});
          }, 0);
        }
        return { success: true, ...next, ...search.snapshot() };
      }
      return { success: false, error: '未知置頂類型' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerSearchHandlers };
