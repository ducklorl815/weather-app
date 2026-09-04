// [Important] Reply Pop · shell — classic script; shared state in state.js (var/function globals)
    function paintHeaderIcon(iconUrl, emoji) {
      const avatar = document.getElementById('top-avatar');
      const emojiEl = document.getElementById('top-emoji');
      if (!avatar || !emojiEl) return;
      const url = String(iconUrl || '').trim();
      const em = String(emoji || '').trim();
      if (url && (/^https?:\/\//i.test(url) || /^data:image\//i.test(url))) {
        avatar.src = url;
        avatar.classList.add('is-on');
        emojiEl.textContent = '';
        emojiEl.classList.remove('is-on');
      } else if (em) {
        avatar.removeAttribute('src');
        avatar.classList.remove('is-on');
        emojiEl.textContent = em;
        emojiEl.classList.add('is-on');
      } else {
        avatar.removeAttribute('src');
        avatar.classList.remove('is-on');
        emojiEl.textContent = '';
        emojiEl.classList.remove('is-on');
      }
    }
    function scrollDebugLog(tag, detail = '') {
      if (!SCROLL_DEBUG) return;
      console.log(detail
        ? `[LittleReply][Scroll] ${tag} ${detail}`
        : `[LittleReply][Scroll] ${tag}`);
    }

    function isOpeningScrollActive() {
      return !!(openingScrollState.isOpening && !openingScrollState.initialScrollCompleted);
    }

    function mergeOpenScrollIntent(patch = {}) {
      const prev = openScrollIntent || {};
      const jumpMessageName = String(
        patch.jumpMessageName != null ? patch.jumpMessageName : (prev.jumpMessageName || openJumpTo || '')
      ).trim();
      const readUntil = String(
        patch.readUntil != null ? patch.readUntil : (prev.readUntil || openReadUntil || '')
      ).trim();
      let mode = 'bottom';
      if (jumpMessageName) mode = 'jump';
      else if (readUntil) mode = 'firstUnread';
      openScrollIntent = {
        jumpMessageName,
        readUntil,
        mode,
        initialScrollCompleted: false
      };
      if (!openingScrollState.initialScrollCompleted) {
        openingScrollState.isOpening = true;
      }
      return openScrollIntent;
    }

    function ensureOpenScrollIntent() {
      if (openScrollIntent && !openScrollIntent.initialScrollCompleted) return openScrollIntent;
      const intent = mergeOpenScrollIntent({});
      scrollDebugLog('OPEN', `mode=${intent.mode} jump=${intent.jumpMessageName || '-'} readUntil=${intent.readUntil ? 'set' : '-'}`);
      return intent;
    }

    /** firstUnreadMessage：createTime 由舊到新，第一個 createTime > readUntil */
    function findFirstUnreadMessageName(thread, readUntil) {
      const until = String(readUntil || '').trim();
      if (!until || !Array.isArray(thread)) return '';
      const sorted = [...thread].filter((m) => m?.name).sort((a, b) => {
        const ta = String(a.createTime || '');
        const tb = String(b.createTime || '');
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
      for (const m of sorted) {
        const ct = String(m.createTime || '').trim();
        if (ct && ct > until) return m.name;
      }
      return '';
    }

    function resolveInitialScrollTarget(thread) {
      const intent = ensureOpenScrollIntent();
      const jumpMessageName = String(intent.jumpMessageName || '').trim();
      const readUntil = String(intent.readUntil || '').trim();
      if (jumpMessageName) {
        scrollDebugLog('TARGET', `mode=jump target=${jumpMessageName}`);
        return { mode: 'jump', targetMessageName: jumpMessageName, readUntil };
      }
      const firstUnread = findFirstUnreadMessageName(thread, readUntil);
      if (firstUnread) {
        scrollDebugLog('TARGET', `mode=firstUnread target=${firstUnread}`);
        return { mode: 'firstUnread', targetMessageName: firstUnread, readUntil };
      }
      scrollDebugLog('TARGET', 'mode=bottom');
      return { mode: 'bottom', targetMessageName: '', readUntil };
    }

    function completeOpeningScroll() {
      document.getElementById('thread')?.classList.remove('is-opening-scroll');
      if (openingScrollState.initialScrollCompleted) return;
      openingScrollState.initialScrollCompleted = true;
      openingScrollState.isOpening = false;
      if (openScrollIntent) openScrollIntent.initialScrollCompleted = true;
      openReadUntil = '';
      openJumpTo = '';
      openScrollIntent = null;
      scrollDebugLog('INITIAL_SCROLL_SUCCESS');
      scrollDebugLog('OPEN_COMPLETE');
    }

    function runInitialScrollController(box, thread, target) {
      if (!box) return;
      if (openingScrollState.initialScrollCompleted) {
        box.classList.remove('is-opening-scroll');
        return;
      }
      const gen = ++openingScrollGeneration;
      const resolved = target || resolveInitialScrollTarget(thread);
      scrollDebugLog('INITIAL_SCROLL', `mode=${resolved.mode} target=${resolved.targetMessageName || 'bottom'}`);

      if (resolved.mode === 'jump' && resolved.targetMessageName) {
        expandThreadForMessage(resolved.targetMessageName);
      }

      const tryScroll = () => {
        if (gen !== openingScrollGeneration || openingScrollState.initialScrollCompleted) return true;
        if (resolved.mode === 'jump' && resolved.targetMessageName) {
          return scrollToThreadMessage(resolved.targetMessageName);
        }
        if (resolved.mode === 'firstUnread') {
          return scrollThreadOnOpen(box, resolved.readUntil);
        }
        scrollThreadToBottom(box);
        return true;
      };

      box.classList.add('is-opening-scroll');
      const finishIfDone = (ok) => {
        if (gen !== openingScrollGeneration) return ok;
        if (ok) completeOpeningScroll();
        return ok;
      };

      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (gen !== openingScrollGeneration) return;
        if (finishIfDone(tryScroll())) return;
        setTimeout(() => {
          if (gen !== openingScrollGeneration) return;
          if (finishIfDone(tryScroll())) return;
          setTimeout(() => {
            if (gen !== openingScrollGeneration) return;
            tryScroll();
            if (!openingScrollState.initialScrollCompleted) completeOpeningScroll();
          }, 480);
        }, 120);
      }));
    }
    function currentTitleText() {
      return document.getElementById('title')?.textContent?.trim() || 'Little Reply';
    }

    function setMinimizedMode(on, title) {
      minimized = !!on;
      document.body.classList.toggle('is-minimized', minimized);
      if (title) document.getElementById('title').textContent = title;
      const top = document.getElementById('top-bar');
      if (minimized) {
        top?.setAttribute('title', '點擊恢復對話');
      } else {
        top?.removeAttribute('title');
      }
    }

    async function minimizePop() {
      const isDm = !!(ctx?.isDm || ctx?.spaceType === 'DIRECT_MESSAGE');
      const title = ctx?.spaceDisplayName || currentTitleText();
      const res = await window.api.gchatCompactMinimize?.({
        messageName: ctx?.name || focusName,
        spaceName: ctx?.spaceName || focusSpace || '',
        title,
        isDm
      });
      if (res?.success !== false) {
        setMinimizedMode(true, conversationTitle(ctx) || currentTitleText());
      }
    }

    async function restorePop() {
      const res = await window.api.gchatCompactRestore?.(focusName);
      if (res?.success !== false) {
        setMinimizedMode(false);
        restoreFromMinibar();
        document.getElementById('reply')?.focus();
      }
    }

    function closeMediaLightbox(event) {
      if (event && event.target !== event.currentTarget) return;
      window.GchatLightboxZoom?.detach?.();
      document.getElementById('media-lightbox')?.classList.remove('is-open');
      const body = document.getElementById('media-lightbox-body');
      if (body) body.innerHTML = '';
      mediaLightboxExternalUrl = '';
      const hint = document.getElementById('media-lb-zoom-hint');
      if (hint) hint.textContent = '';
    }

    function stashMedia(item) {
      const id = `m${++mediaSeq}`;
      mediaStore[id] = item;
      return id;
    }

    function openMediaLightboxExternal() {
      if (mediaLightboxExternalUrl) window.api.openExternal(mediaLightboxExternalUrl);
    }

    function openMediaPreview(id) {
      const item = mediaStore[id];
      if (!item) return;
      const isPdf = item.kind === 'pdf' || /pdf/i.test(item.contentType || '') || /\.pdf$/i.test(item.name || '');
      const src = isPdf
        ? pickPdfPreviewSrc(item)
        : (pickImageSrc(item) || item.previewUrl || item.dataUrl || item.uri || '');
      const title = document.getElementById('media-lb-title');
      const extBtn = document.getElementById('media-lb-open-ext');
      const box = document.getElementById('media-lightbox');
      const body = document.getElementById('media-lightbox-body');
      if (!box || !body) return;

      if (title) title.textContent = item.name || (isPdf ? 'PDF 預覽' : '圖片預覽');
      mediaLightboxExternalUrl = item.openUrl || item.downloadUri || (src.startsWith('http') ? src : '');
      if (extBtn) extBtn.style.display = mediaLightboxExternalUrl ? 'inline-block' : 'none';

      body.innerHTML = '';
      if (isPdf && src) {
        if (!window.GchatPdfViewer?.appendPdfViewer?.(body, src, { title: 'PDF' })) {
          const frame = document.createElement('iframe');
          frame.title = 'PDF';
          frame.src = src;
          body.appendChild(frame);
        }
      } else if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = item.name || '圖片';
        img.draggable = false;
        window.GchatLightboxZoom?.attach?.(body, img, {
          onScaleChange(scale) {
            const hint = document.getElementById('media-lb-zoom-hint');
            if (!hint) return;
            if (scale <= 1.01) {
              hint.textContent = '滾輪縮放';
              return;
            }
            const img = document.querySelector('#media-lightbox-body .gchat-lb-zoom-img');
            const w = img ? Math.round(Number(img.style.width.replace('px', '')) || 0) : 0;
            const h = img ? Math.round(Number(img.style.height.replace('px', '')) || 0) : 0;
            hint.textContent = w && h ? `${w}×${h}px · 拖曳平移` : `${Math.round(scale * 100)}% · 拖曳平移`;
          }
        });
        const hint = document.getElementById('media-lb-zoom-hint');
        if (hint) hint.textContent = '滾輪縮放';
      } else if (item.openUrl || item.downloadUri) {
        window.api.openExternal(item.openUrl || item.downloadUri);
        return;
      } else {
        return;
      }
      box.classList.add('is-open');
    }

    function pickImageSrc(item) {
      const dataUrl = String(item?.dataUrl || '').trim();
      if (dataUrl.startsWith('data:')) return dataUrl;
      const preview = String(item?.previewUrl || '').trim();
      if (preview.startsWith('data:')) return preview;
      if (item?.kind === 'gif') {
        const uri = String(item.uri || '').trim();
        if (uri.startsWith('http')) return uri;
      }
      return '';
    }

    function pickPdfPreviewSrc(item) {
      const raw = pickImageSrc(item) || String(item?.previewUrl || item?.dataUrl || item?.uri || '').trim();
      if (!raw) return '';
      return window.GchatPdfViewer?.resolvePdfViewerSrc?.(raw) || raw;
    }

    function renderMediaHtml(media, opts = {}) {
      const list = (media || []).filter((item) => {
        if (item?.cardDecor) return false;
        // 卡片裝飾圖／遠端 icon：無 Chat 附件資源就不當大圖預覽
        if ((item?.kind === 'image' || /^image\//i.test(item?.contentType || ''))
          && !item?.resourceName
          && !item?.driveFileId
          && !String(item?.dataUrl || '').startsWith('data:')) {
          const src = String(item?.previewUrl || item?.uri || '');
          if (/^https?:\/\//i.test(src)) return false;
        }
        if (opts.hideCardDecor
          && !item?.resourceName
          && !item?.driveFileId
          && (item?.kind === 'image' || item?.kind === 'gif')) {
          const src = String(item?.previewUrl || item?.uri || item?.dataUrl || '');
          if (/^https?:\/\//i.test(src)) return false;
        }
        return true;
      });
      if (!list.length) return '';
      const parts = list.map(item => {
        const id = stashMedia(item);
        const src = pickImageSrc(item);
        const isImage = item.kind === 'gif' || item.kind === 'image' || /^image\//i.test(item.contentType || '');
        const isPdf = item.kind === 'pdf' || /pdf/i.test(item.contentType || '') || /\.pdf$/i.test(item.name || '');
        if (src && isImage) {
          const safe = escapeHtml(src).replace(/"/g, '&quot;');
          return `<button type="button" class="gchat-media-card" data-media-id="${id}" title="點擊放大預覽">
            <img class="gchat-media" src="${safe}" alt="${escapeHtml(item.name || '圖片')}" draggable="false">
            <span class="gchat-media-hint">點擊放大</span>
          </button>`;
        }
        if (isImage) {
          const label = escapeHtml(item.name || '圖片');
          if (item.openUrl || item.downloadUri) {
            const url = escapeHtml(item.openUrl || item.downloadUri).replace(/'/g, "\\'");
            return `<a class="gchat-file-link" href="#" data-open-url="${url}">🖼️ ${label}</a>`;
          }
          return `<div class="gchat-file-link gchat-media-pending">🖼️ ${label}（載入中…）</div>`;
        }
        if (isPdf) {
          const label = escapeHtml(item.name || 'PDF');
          const pdfSrc = pickPdfPreviewSrc(item);
          if (pdfSrc) {
            const safe = escapeHtml(pdfSrc).replace(/"/g, '&quot;');
            return `<button type="button" class="gchat-pdf-preview-card" data-media-id="${id}" title="點擊放大預覽">
              <iframe class="gchat-pdf-inline" src="${safe}" title="${label}" tabindex="-1"></iframe>
              <span class="gchat-media-hint">📄 ${label} · 點擊放大</span>
            </button>`;
          }
          return `<button type="button" class="gchat-pdf-thumb" data-media-id="${id}" title="點擊預覽">📄 ${label}<span class="gchat-media-hint">點擊預覽</span></button>`;
        }
        if (item.openUrl || item.downloadUri) {
          const url = escapeHtml(item.openUrl || item.downloadUri).replace(/'/g, "\\'");
          return `<a class="gchat-file-link" href="#" data-open-url="${url}">📎 ${escapeHtml(item.name || '附件')}</a>`;
        }
        return `<div class="gchat-file-link">📎 ${escapeHtml(item.name || '附件')}</div>`;
      }).join('');
      return `<div class="gchat-media-wrap">${parts}</div>`;
    }

