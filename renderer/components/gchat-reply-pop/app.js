// [Important] Reply Pop · boot — classic script; shared state in state.js (var/function globals)
    document.getElementById('btn-close').onclick = (e) => {
      e.stopPropagation();
      // 主行程用 event.sender 對應視窗關閉，不依訊息名（避免同對話不同 messageName 關不到）
      window.api.gchatCompactClose?.();
    };
    document.getElementById('btn-minimize').onclick = (e) => {
      e.stopPropagation();
      minimizePop();
    };
    document.getElementById('top-bar').addEventListener('click', (e) => {
      if (!minimized) return;
      if (e.target.closest('button')) return;
      restorePop();
    });
    // [Important] 雙擊 title：展開時切換全螢幕（主行程記錄 mode）；bar 上雙擊恢復
    document.getElementById('top-bar').addEventListener('dblclick', async (e) => {
      if (e.target.closest('button')) return;
      if (minimized) {
        e.preventDefault();
        e.stopPropagation();
        restorePop();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      await window.api.gchatCompactToggleFullscreen?.();
    });
    window.api.onGchatCompactMode?.((data) => {
      const wasMinimized = minimized;
      setMinimizedMode(!!data?.minimized, data?.title || currentTitleText());
      if (wasMinimized && !data?.minimized) {
        restoreFromMinibar();
      }
    });
    window.api.onGchatCompactIcon?.((data) => {
      headerIconUrl = String(data?.iconUrl || headerIconUrl || '').trim();
      headerEmoji = String(data?.emoji || headerEmoji || '').trim();
      paintHeaderIcon(headerIconUrl, headerEmoji);
    });
    paintHeaderIcon(headerIconUrl, headerEmoji);
    window.api.onAppTheme?.((theme) => {
      document.documentElement.setAttribute('data-theme', theme || 'light');
    });
    function applyFontScale(scale) {
      const opts = [0.75, 1, 1.25, 1.5];
      const n = Number(scale);
      const next = opts.some((v) => Math.abs(v - n) < 0.001) ? n : 1;
      document.documentElement.style.setProperty('--ui-scale', String(next));
    }
    window.api.onAppFontScale?.((scale) => applyFontScale(scale));
    (async () => {
      try {
        const res = await window.api.getAppTheme?.();
        if (res?.theme) document.documentElement.setAttribute('data-theme', res.theme);
        const fs = await window.api.getAppFontScale?.();
        if (fs?.scale != null) applyFontScale(fs.scale);
      } catch (_) {}
    })();
    document.getElementById('btn-send').onclick = send;
    const composeEmojiBtn = document.getElementById('btn-compose-emoji');
    if (composeEmojiBtn) {
      composeEmojiBtn.innerHTML = reactFaceIconHtml();
      composeEmojiBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openComposeEmojiPicker(composeEmojiBtn);
      });
    }
    document.getElementById('reply-chip-clear').onclick = clearReplyTarget;
    document.getElementById('reply').addEventListener('input', onReplyInputForMention);
    document.getElementById('reply').addEventListener('keyup', onReplyInputForMention);
    document.getElementById('reply').addEventListener('keydown', (e) => {
      onReplyKeydownForMention(e);
      if (e.defaultPrevented) return;
      const box = document.getElementById('mention-suggest');
      if (box && !box.hidden) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    document.addEventListener('click', (e) => {
      if (e.target.closest('#mention-suggest') || e.target.closest('#reply')) return;
      hideMentionSuggest();
    });
    document.getElementById('thread')?.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.gchat-media-card, .gchat-pdf-thumb, .gchat-media')) {
        e.preventDefault();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const box = document.getElementById('media-lightbox');
      if (box?.classList.contains('is-open')) {
        event.stopPropagation();
        closeMediaLightbox();
      }
    });
    document.getElementById('thread')?.addEventListener('click', (e) => {
      const starBtn = e.target.closest('.focus-star');
      if (starBtn) {
        e.preventDefault();
        e.stopPropagation();
        const bubble = starBtn.closest('.bubble');
        const text = (bubble?.querySelector('.text')?.innerText || '').trim();
        openFocusThread(
          bubble?.dataset?.msgName || '',
          bubble?.dataset?.threadName || bubble?.dataset?.focusId || '',
          text
        );
        return;
      }
      const mediaBtn = e.target.closest('[data-media-id]');
      if (mediaBtn && (mediaBtn.classList.contains('gchat-media-card')
        || mediaBtn.classList.contains('gchat-pdf-thumb')
        || mediaBtn.classList.contains('gchat-pdf-preview-card'))) {
        e.preventDefault();
        e.stopPropagation();
        const id = mediaBtn.dataset.mediaId;
        if (id) openMediaPreview(id);
        return;
      }
      const reactToggle = e.target.closest('.react-toggle');
      if (reactToggle) {
        e.preventDefault();
        e.stopPropagation();
        openPopEmojiPicker(reactToggle);
        return;
      }
      if (e.target.closest('#btn-compose-emoji')) return;
      const btn = e.target.closest('.react-chip, .react-add');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const wrap = btn.closest('.reactions-picker, .reactions-chips, .reactions');
      const msg = wrap?.dataset?.msgName || '';
      const reactPayload = readPopReactPayload(btn);
      if (msg && reactPayload.reactionKey) reactToMessage(msg, reactPayload);
      if (btn.classList.contains('react-add')) {
        window.GchatEmojiPicker?.close?.();
        document.querySelectorAll('.react-toggle.is-open').forEach((t) => {
          t.classList.remove('is-open');
          t.title = '表情回覆';
        });
      }
    });

    window.api.onGchatCompactLoad?.((name) => {
      if (name) location.search = `?name=${encodeURIComponent(name)}`;
    });

    window.api.onGchatScrollOpen?.((data) => {
      const readUntil = String(data?.readUntil != null ? data.readUntil : '').trim();
      const jumpMessageName = String(data?.jumpMessageName || '').trim();
      mergeOpenScrollIntent({
        readUntil: readUntil || undefined,
        jumpMessageName: jumpMessageName || undefined
      });
      scrollDebugLog('OPEN', `jump=${jumpMessageName || '-'} readUntil=${readUntil ? 'set' : '-'}`);

      const openingActive = isOpeningScrollActive();
      const box = document.getElementById('thread');

      if (openingActive) {
        if (ctx?.spaceName && liveThread.length) {
          renderThread(ctx, liveThread, {
            useInitialScroll: true,
            scrollMode: 'initial',
            threadForScroll: liveThread,
            readUntil,
            jumpMessageName
          });
        } else if (ctx?.spaceName) {
          refreshLiveThreadCacheFirst({ force: true });
        }
        return;
      }

      if (jumpMessageName) {
        if (ctx?.spaceName && liveThread.length) {
          renderThread(ctx, liveThread, { scrollMode: 'jump', jumpMessageName });
          scheduleJumpToMessage(jumpMessageName);
          return;
        }
        scheduleJumpToMessage(jumpMessageName);
        return;
      }

      if (ctx?.spaceName && liveThread.length) {
        const target = resolveInitialScrollTarget(liveThread);
        if (target.mode === 'firstUnread') {
          renderThread(ctx, liveThread, { scrollMode: 'open', readUntil: target.readUntil });
        } else {
          renderThread(ctx, liveThread, { scrollMode: 'bottom' });
        }
        return;
      }
      if (ctx?.spaceName) {
        refreshLiveThreadCacheFirst({ force: true }).then(() => {
          if (liveThread.length) {
            const target = resolveInitialScrollTarget(liveThread);
            if (target.mode === 'firstUnread') {
              renderThread(ctx, liveThread, { scrollMode: 'open', readUntil: target.readUntil });
            } else {
              renderThread(ctx, liveThread, { scrollMode: 'bottom' });
            }
          } else if (box) {
            scrollThreadToBottom(box);
          }
        });
        return;
      }
      if (box) {
        scrollThreadToBottom(box);
      }
    });

    window.api.onGchatCacheChanged?.(() => {
      if (minimized || !ctx?.spaceName) return;
      // [Important] 開著的 Reply Pop：Cache Push 走 cache-first + 背景網路刷新
      refreshLiveThreadCacheFirst({ force: false }).catch(() => {});
    });

    load();

    window.GchatQuickSearch?.init({
      listenIpc: true,
      onOpenContact: (item) => window.GchatQuickSearch.openCompactFromSearchItem(item, 'contact'),
      onOpenSpace: (item) => window.GchatQuickSearch.openCompactFromSearchItem(item, 'space')
    });
