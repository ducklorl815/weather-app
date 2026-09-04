// [Important] Reply Pop · live-refresh — classic script; shared state in state.js (var/function globals)
    function threadFingerprint(thread) {
      const list = thread || [];
      const last = list[list.length - 1];
      const mediaSig = list.flatMap((m) => (m.media || []).map((x) => {
        const key = x?.resourceName || x?.name || '';
        return `${key}:${x?.dataUrl ? '1' : '0'}`;
      })).join(';');
      return `${list.length}|${last?.name || ''}|${last?.createTime || ''}|${last?.text || last?.snippet || ''}|${mediaSig}`;
    }

    async function refreshLiveThread({ force, cacheOnly } = {}) {
      if (!ctx?.spaceName || refreshBusy) return;
      if (!cacheOnly && apiQuotaBlockedUntil && Date.now() < apiQuotaBlockedUntil) return;
      refreshBusy = true;
      try {
        const res = await window.api.gchatThreadRefresh?.({
          spaceName: ctx.spaceName,
          threadName: (isFocusThreadMode ? focusThreadName : '') || ctx.threadName || '',
          name: ctx.name || focusName || '',
          isDm: !!ctx.isDm,
          spaceType: ctx.spaceType || '',
          spaceDisplayName: ctx.spaceDisplayName || '',
          sender: ctx.sender || '',
          focusThread: isFocusThreadMode,
          rootMessageName: focusRootMessageName || '',
          cacheOnly: !!cacheOnly
        });
        if (res?.quotaBlocked) {
          apiQuotaBlockedUntil = Number(res.quotaBlockedUntil) || (Date.now() + 30 * 60 * 1000);
        }
        if (!res?.success || !Array.isArray(res.thread)) return;
        if (res.myUserName) myUserName = res.myUserName;
        if (Array.isArray(res.myIds)) myIds = res.myIds;
        if (Array.isArray(res.myLabels)) myLabels = res.myLabels;
        const next = filterThreadForFocus(res.thread, ctx);
        const merged = mergeThreadPreservingReactions(liveThread, next);
        if (!force && !cacheOnly && threadFingerprint(merged) === threadFingerprint(liveThread)) return;
        liveThread = merged;
        const newest = [...next].reverse().find(m => m?.name) || ctx;
        const keepName = ctx.name || newest?.name || '';
        ctx = {
          ...ctx,
          ...newest,
          name: keepName,
          spaceName: ctx.spaceName,
          spaceDisplayName: ctx.spaceDisplayName || newest.spaceDisplayName,
          isDm: ctx.isDm,
          spaceType: ctx.spaceType || newest.spaceType,
          threadName: isFocusThreadMode
            ? (focusThreadName || ctx.threadName || newest.threadName || '')
            : (ctx.threadName || newest.threadName || '')
        };
        await loadPopCustomEmojisOnce();
        const openingActive = isOpeningScrollActive();
        if (openingActive) {
          renderThread(ctx, merged, {
            useInitialScroll: true,
            scrollMode: 'initial',
            threadForScroll: merged,
            readUntil: openScrollIntent?.readUntil,
            jumpMessageName: openScrollIntent?.jumpMessageName
          });
        } else {
          renderThread(ctx, merged, { preserveScroll: true });
        }
        if (!cacheOnly && newest?.name) {
          window.api.gchatMarkRead?.({
            name: newest.name,
            createTime: newest.createTime || '',
            threadName: newest.threadName || ctx.threadName || '',
            spaceName: newest.spaceName || ctx.spaceName || '',
            isDm: !!ctx.isDm,
            spaceType: ctx.spaceType || ''
          });
        }
      } catch (_) {
      } finally {
        refreshBusy = false;
      }
    }

    async function refreshLiveThreadCacheFirst(opts = {}) {
      if (historyHydrating) return;
      await refreshLiveThread({ ...opts, cacheOnly: true });
      refreshLiveThread({ ...opts, cacheOnly: false, force: !!opts.force }).catch(() => {});
    }

    function startLiveRefresh() {
      // [Phase 2C] 30s API 輪詢改由 Main PollCoordinator + scheduler 驅動；此處僅訂閱 thread-ping
      if (!pingBound) {
        pingBound = true;
        window.api.onGchatThreadPing?.((data) => {
          if (minimized) return;
          if (!ctx?.spaceName) return;
          if (data?.spaceName && data.spaceName !== ctx.spaceName) return;
          const pingName = String(data?.messageName || '').trim();
          const jumpRequested = !!data?.jumpToMessage && pingName;
          const isNewPing = pingName && pingName !== lastThreadPingMessageName;
          if (isNewPing) {
            expandThreadForMessage(pingName, data.threadName || '');
            lastThreadPingMessageName = pingName;
          }
          const box = document.getElementById('thread');
          const nearBottom = isThreadNearBottom(box);
          refreshLiveThreadCacheFirst({ force: isNewPing || !!data?.forceRefresh }).then(() => {
            if (isOpeningScrollActive()) {
              scrollDebugLog('REFRESH_SKIPPED', 'reason=opening');
              return;
            }
            if (jumpRequested) scheduleJumpToMessage(pingName);
            else if (isNewPing && nearBottom) scheduleJumpToMessage(pingName);
          });
        });
      }
    }

    async function applyLoadResult(res, opts = {}) {
      ctx = res.detail;
      if (isFocusThreadMode && focusThreadName) {
        ctx = { ...ctx, threadName: focusThreadName || ctx.threadName || '' };
      }
      liveThread = filterThreadForFocus(res.thread || [res.detail], ctx);
      window.__popThreadCache = liveThread;
      if (ctx?.spaceName && !ctx.isDm && ctx.spaceType !== 'DIRECT_MESSAGE') {
        ensureSpaceMembersLoaded().catch(() => {});
      }
      if (res.myUserName) myUserName = res.myUserName;
      if (Array.isArray(res.myIds)) myIds = res.myIds;
      if (Array.isArray(res.myLabels)) myLabels = res.myLabels;
      clearReplyTarget();
      await loadPopCustomEmojisOnce();
      window.api.gchatSetViewing?.({
        spaceName: ctx.spaceName,
        threadName: (isFocusThreadMode ? focusThreadName : '') || ctx.threadName || '',
        messageName: ctx.name,
        isDm: !!ctx.isDm
      });
      const hasMessages = liveThread.length > 0;
      ensureOpenScrollIntent();
      const openingActive = isOpeningScrollActive();
      let renderOpts = {};

      if (openingActive) {
        if (opts.deferScroll || (historyHydrating && !hasMessages)) {
          renderOpts = { scrollMode: 'none', useInitialScroll: false };
        } else {
          renderOpts = {
            useInitialScroll: true,
            scrollMode: 'initial',
            threadForScroll: liveThread,
            readUntil: openScrollIntent?.readUntil,
            jumpMessageName: openScrollIntent?.jumpMessageName
          };
        }
      } else {
        let scrollMode = 'bottom';
        if (openJumpTo) scrollMode = 'jump';
        else if (openReadUntil) scrollMode = 'open';
        else if (opts.deferScroll || (historyHydrating && !hasMessages)) scrollMode = 'none';
        renderOpts = {
          scrollMode,
          jumpMessageName: openJumpTo,
          readUntil: openReadUntil
        };
        openReadUntil = '';
        openJumpTo = '';
      }

      renderThread(ctx, liveThread, renderOpts);
      lastThreadPingMessageName = ctx?.name || focusName || '';
      document.getElementById('reply')?.focus();
      bindComposerAttach();
    }

    function buildSpaceOpenPayload() {
      if (focusSpace) {
        return { spaceName: focusSpace, isDm: focusSpaceIsDm };
      }
      return {
        userName: focusUser,
        label: focusContactLabel || focusUser,
        isDm: true
      };
    }

    async function loadSpaceConversation() {
      const basePayload = buildSpaceOpenPayload();
      const cachedSpace = await window.api.gchatOpenSpace?.({
        ...basePayload,
        cacheOnly: true
      });
      if (cachedSpace?.success && cachedSpace.detail && (cachedSpace.thread || []).length > 0) {
        await applyLoadResult(cachedSpace);
        startLiveRefresh();
        refreshLiveThread({ cacheOnly: false }).catch(() => {});
        return;
      }

      historyHydrating = true;
      const quick = await window.api.gchatOpenSpace?.({
        ...basePayload,
        deferHistory: true
      });
      if (!quick?.success || !quick.detail) {
        historyHydrating = false;
        document.getElementById('thread').innerHTML = `<div class="err">${escapeHtml(quick?.error || '無法開啟對話')}</div>`;
        return;
      }
      await applyLoadResult({
        success: true,
        detail: quick.detail,
        thread: quick.thread || [],
        fromCache: !!quick.fromCache,
        myUserName: quick.myUserName,
        myIds: quick.myIds,
        myLabels: quick.myLabels
      }, { deferScroll: true });
      startLiveRefresh();

      try {
        const full = await window.api.gchatOpenSpace?.({
          ...basePayload,
          spaceName: quick.detail.spaceName || basePayload.spaceName,
          deferHistory: false
        });
        if (full?.success && full.detail) {
          await applyLoadResult(full);
        }
      } catch (_) {
      } finally {
        historyHydrating = false;
        refreshLiveThread({ force: true }).catch(() => {});
      }
    }

    async function load() {
      if (!focusName && (focusSpace || focusUser)) {
        await loadSpaceConversation();
        return;
      }
      if (!focusName) {
        document.getElementById('thread').innerHTML = `<div class="err">缺少訊息</div>`;
        return;
      }
      const cachedTry = await window.api.gchatDetail?.({ messageName: focusName, cacheOnly: true });
      if (cacheDetailUsable(cachedTry)) {
        await applyLoadResult(cachedTry);
        startLiveRefresh();
        refreshLiveThreadCacheFirst({ force: true });
        window.api.gchatDetail(focusName).then(async (res) => {
          if (res?.success && cacheDetailUsable(res)) await applyLoadResult(res);
          refreshLiveThreadCacheFirst({ force: true });
        }).catch(() => {});
        return;
      }

      const res = await window.api.gchatDetail(focusName);
      if (!res?.success) {
        document.getElementById('thread').innerHTML = `<div class="err">${escapeHtml(res?.error || '讀取失敗')}</div>`;
        return;
      }
      await applyLoadResult(res);
      startLiveRefresh();
      refreshLiveThreadCacheFirst({ force: true });
    }
