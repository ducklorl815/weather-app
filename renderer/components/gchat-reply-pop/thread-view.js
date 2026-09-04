// [Important] Reply Pop · thread-view — classic script; shared state in state.js (var/function globals)
    function isMineMessage(m) {
      if (!m) return false;
      if (m.isMine === true) return true;
      if (m.sender === '我') return true;
      const sender = String(m.senderName || '').trim();
      if (sender) {
        const keys = new Set();
        const add = (v) => {
          const s = String(v || '').trim();
          if (!s) return;
          keys.add(s);
          keys.add(s.toLowerCase());
          if (s.startsWith('users/')) {
            keys.add(s.slice(6));
            keys.add(s.slice(6).toLowerCase());
          } else {
            keys.add(`users/${s}`);
            keys.add(`users/${s.toLowerCase()}`);
          }
        };
        add(myUserName);
        (myIds || []).forEach(add);
        if (keys.has(sender)) return true;
        const senderId = sender.startsWith('users/') ? sender.slice(6) : sender;
        if (senderId && (keys.has(senderId) || keys.has(senderId.toLowerCase()))) return true;
      }
      const label = String(m.sender || '').trim();
      if (label && (myLabels || []).includes(label)) return true;
      return false;
    }

    function isSelfTitlePart(part) {
      const s = String(part || '').trim();
      if (!s || s === '我') return true;
      const labels = myLabels || [];
      const tail = (x) => {
        const t = String(x || '').trim();
        const i = t.lastIndexOf('_');
        return i >= 0 && i < t.length - 1 ? t.slice(i + 1).trim() : t;
      };
      const myTail = tail(s);
      for (const lab of labels) {
        if (!lab) continue;
        if (s === lab || s.includes(lab) || lab.includes(s)) return true;
        if (myTail && tail(lab) === myTail) return true;
      }
      return false;
    }

    function dmShortLabel(s) {
      const t = String(s || '').trim();
      if (!t) return t;
      const i = t.lastIndexOf('_');
      if (i >= 0 && i < t.length - 1) return t.slice(i + 1).trim();
      return t;
    }

    function conversationTitle(detail, threadList) {
      const isDm = !!(detail?.isDm || detail?.spaceType === 'DIRECT_MESSAGE');
      const weak = (v) => {
        const t = String(v || '').trim();
        return !t || /^users\//i.test(t)
          || /^(對話|私人訊息|私人|成員|未知|Little Reply|群組)$/i.test(t);
      };
      const peerFromThread = () => {
        const list = threadList || liveThread || [];
        for (const m of list) {
          if (isMineMessage(m)) continue;
          const s = String(m?.sender || '').trim();
          if (s && s !== '我' && !isSelfTitlePart(s) && !weak(s)) return s;
        }
        return '';
      };
      let s = String(detail?.spaceDisplayName || '').trim();
      if (weak(s)) s = '';
      if (!isDm) {
        if (s) return s;
        const fromThread = peerFromThread();
        if (fromThread) return fromThread;
        const sender = String(detail?.sender || '').trim();
        if (sender && sender !== '我' && !weak(sender)) return sender;
        return '對話';
      }
      if (/[、,]/.test(s)) {
        const parts = s.split(/[、,]/).map(x => x.trim()).filter(Boolean);
        const others = parts.filter(p => !isSelfTitlePart(p) && !weak(p));
        s = others[0] || parts.find(p => !weak(p)) || '';
      } else if (isSelfTitlePart(s)) {
        s = '';
      }
      if (!s) {
        const sender = String(detail?.sender || '').trim();
        if (sender && sender !== '我' && !isSelfTitlePart(sender) && !weak(sender)) s = sender;
      }
      if (!s) s = peerFromThread();
      return dmShortLabel(s) || s || '私人訊息';
    }

    function escapeHtml(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function replyIconHtml() {
      return `<svg class="reply-glyph" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>`;
    }

    function markReplyIconsMaterial() {
      /* [Important] 回覆圖示固定用 SVG，不依 Material Symbols（避免字型未載入時顯示文字 reply） */
    }

    function clearReplyTarget() {
      replyTarget = null;
      document.getElementById('reply-chip')?.classList.remove('is-on');
    }

    function setReplyTargetFromBubble(btn) {
      const el = btn?.closest?.('.bubble');
      if (!el?.dataset?.msgName) return;
      replyTarget = {
        messageName: el.dataset.msgName,
        threadName: el.dataset.threadName || el.dataset.msgName,
        sender: el.dataset.sender || '',
        preview: (el.querySelector('.text')?.innerText || '').trim().slice(0, 80),
        createTime: el.dataset.createTime || '',
        lastUpdateTime: el.dataset.lastUpdateTime || el.dataset.createTime || ''
      };
      const chip = document.getElementById('reply-chip');
      chip?.classList.add('is-on');
      const label = document.getElementById('reply-chip-label');
      const preview = document.getElementById('reply-chip-preview');
      if (label) label.textContent = `引用回覆 ${replyTarget.sender || '此訊息'}`;
      if (preview) preview.textContent = replyTarget.preview || '';
      document.getElementById('reply')?.focus();
    }

    function renderQuoteHtml(quoted) {
      if (!quoted?.text && !quoted?.textHtml && !quoted?.name && !quoted?.media?.length && !quoted?.forwardFrom) return '';
      const who = escapeHtml(quoted.sender || '引用訊息');
      const forwardHint = quoted.forwardFrom
        ? `<div class="quote-forward-from">${escapeHtml(quoted.forwardFrom)}</div>`
        : '';
      let body = '';
      if (quoted.textHtml) {
        body = linkifyMessageHtml(quoted.textHtml);
      } else if (quoted.media?.length) {
        body = `${renderMessageText(quoted.text || '')}${renderMediaHtml(quoted.media)}`;
      } else {
        body = renderMessageText(quoted.text || '（無文字）');
      }
      const qName = String(quoted?.name || '').trim();
      if (!qName) {
        return `<div class="quote">${forwardHint}<div class="quote-who">${who}</div>${body}</div>`;
      }
      return `<button type="button" class="quote is-jumpable" data-quote-name="${escapeHtml(qName)}" title="跳到被回覆的訊息">${forwardHint}<div class="quote-who">${who}</div>${body}</button>`;
    }

    function isThreadNearBottom(box, gapPx = 140) {
      if (!box) return true;
      const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
      return gap < gapPx;
    }

    function scrollElementToViewportCenter(scroller, element) {
      if (!scroller || !element) return false;
      const scrollerRect = scroller.getBoundingClientRect();
      const elRect = element.getBoundingClientRect();
      const elTopInScroll = scroller.scrollTop + (elRect.top - scrollerRect.top);
      const target = elTopInScroll - (scroller.clientHeight - elRect.height) / 2;
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.max(0, Math.min(target, maxScroll));
      return true;
    }

    function scrollToThreadMessage(messageName) {
      const box = document.getElementById('thread');
      if (!box || !messageName) return false;
      const esc = typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(messageName)
        : messageName.replace(/"/g, '\\"');
      const bubble = box.querySelector(`.bubble[data-msg-name="${esc}"]`);
      if (!bubble) return false;
      scrollElementToViewportCenter(box, bubble);
      bubble.classList.add('is-quote-highlight');
      setTimeout(() => bubble.classList.remove('is-quote-highlight'), 1500);
      return true;
    }

    function expandThreadForMessage(msgName, threadName = '') {
      const name = String(msgName || '').trim();
      if (!name) return;
      const th = String(threadName || '').trim();
      if (th) expandedThreadKeys.add(th);
      const hit = (liveThread || []).find((m) => m?.name === name);
      if (hit) expandedThreadKeys.add(gchatThreadGroupKey(hit));
    }

    /** 展開討論串並捲到指定訊息（Opening 期間由 Initial Scroll Controller 統一處理） */
    function scheduleJumpToMessage(msgName) {
      const name = String(msgName || '').trim();
      if (!name) return;
      if (isOpeningScrollActive()) {
        mergeOpenScrollIntent({ jumpMessageName: name });
        const box = document.getElementById('thread');
        if (box && ctx) {
          runInitialScrollController(box, liveThread);
        }
        return;
      }
      expandThreadForMessage(name);
      const attempt = () => scrollToThreadMessage(name);
      const rerenderExpanded = () => {
        if (!ctx) return;
        renderThread(ctx, liveThread, {
          preserveScroll: false,
          scrollMode: 'jump',
          jumpMessageName: name
        });
      };
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!attempt()) rerenderExpanded();
      }));
      setTimeout(() => {
        if (!attempt()) rerenderExpanded();
      }, 120);
      setTimeout(() => attempt(), 480);
    }

    async function jumpToQuotedMessage(quotedName) {
      const name = String(quotedName || '').trim();
      if (!name) return;
      if (scrollToThreadMessage(name)) return;
      const hit = (liveThread || []).find(m => m?.name === name)
        || (ctx?.name === name ? ctx : null);
      if (!hit) return;
      await openFocusThread(
        hit.name,
        hit.threadName || ctx?.threadName || '',
        hit.text || hit.snippet || ''
      );
      setTimeout(() => scrollToThreadMessage(name), 500);
    }

    function popReactionKey(r) {
      if (r?.reactionKey) return r.reactionKey;
      if (r?.customUid) return `custom:${r.customUid}`;
      return r?.unicode || '';
    }

    function loadPopCustomEmojisOnce({ force = false } = {}) {
      const cachedHasImage = Array.isArray(popCustomEmojiCache)
        && popCustomEmojiCache.some((e) => e?.imageUrl);
      if (popCustomEmojiCache && !force && cachedHasImage) {
        return Promise.resolve({ emojis: popCustomEmojiCache, warning: popCustomEmojiWarning });
      }
      if (!popCustomEmojiCachePromise || force) {
        popCustomEmojiCachePromise = window.api.gchatCustomEmojis?.({ force: !!force })
          .then((res) => {
            popCustomEmojiCache = res?.success ? (res.emojis || []) : [];
            popCustomEmojiWarning = String(
              res?.warning || res?.error || (res?.quotaBlocked ? '自訂表情 API 配額已滿，請稍後再試' : '')
            ).trim();
            return { emojis: popCustomEmojiCache, warning: popCustomEmojiWarning };
          })
          .catch(() => ({ emojis: [], warning: '' }));
      }
      return popCustomEmojiCachePromise;
    }

    function buildPopReactionEmojiHtml(r) {
      let imageUrl = String(r?.imageUrl || '').trim();
      let label = r?.label || r?.unicode || '';
      if (!imageUrl && r?.customUid && Array.isArray(popCustomEmojiCache)) {
        const hit = popCustomEmojiCache.find((e) => e.uid === r.customUid);
        if (hit) {
          imageUrl = hit.imageUrl || '';
          label = hit.emojiName || label;
        }
      }
      if (!imageUrl && r?.unicode && /^:{1,2}[a-z0-9_-]+:{1,2}$/i.test(String(r.unicode))) {
        const key = String(r.unicode).trim().toLowerCase().replace(/^:+|:+$/g, '');
        const hit = popCustomEmojiCache?.find((e) => {
          const n = String(e.emojiName || '').trim().toLowerCase().replace(/^:+|:+$/g, '');
          return n === key;
        });
        if (hit) {
          imageUrl = hit.imageUrl || '';
          label = hit.emojiName || label;
        }
      }
      const safeLabel = escapeHtml(label || r?.unicode || '');
      if (imageUrl) {
        return `<img class="react-custom-emoji-img" src="${escapeHtml(imageUrl)}" alt="${safeLabel}" title="${safeLabel}" />`;
      }
      return escapeHtml(r?.unicode || label || '');
    }

    function enrichPopReactPayload(payload) {
      if (typeof payload === 'string') {
        return { unicode: payload, customUid: '', reactionKey: payload, imageUrl: '', label: payload };
      }
      const p = { ...payload };
      if (p.customUid && !p.imageUrl && Array.isArray(popCustomEmojiCache)) {
        const hit = popCustomEmojiCache.find((e) => e.uid === p.customUid);
        if (hit) {
          p.imageUrl = hit.imageUrl || '';
          p.label = hit.emojiName || p.label || '';
        }
      }
      return p;
    }

    function resolvePopReactionEmojiHtml(payload) {
      const p = enrichPopReactPayload(payload);
      const html = buildPopReactionEmojiHtml(p);
      return html || escapeHtml(p.unicode || '');
    }

    function readPopReactPayload(btn) {
      const customUid = String(btn?.dataset?.customUid || '').trim();
      let unicode = '';
      try { unicode = decodeURIComponent(btn.dataset.unicode || ''); } catch (_) {}
      unicode = String(unicode).normalize('NFC');
      const reactionKey = customUid ? `custom:${customUid}` : unicode;
      return { unicode, customUid, reactionKey };
    }

    function renderReactionChipsHtml(m) {
      const list = Array.isArray(m.reactions) ? m.reactions : [];
      if (!list.length) return '';
      const chips = list.map((r) => {
        const count = Number(r.count || 0) || 0;
        const emoji = buildPopReactionEmojiHtml(r);
        const unicode = r.unicode || '';
        const customUid = r.customUid || '';
        const reactKey = encodeURIComponent(popReactionKey(r));
        const mine = r.reactedByMe ? ' is-mine' : '';
        if (!unicode && !customUid) {
          return `<span class="react-chip">${emoji} <span class="react-count">${count}</span></span>`;
        }
        return `<button type="button" class="react-chip${mine}" data-react-key="${reactKey}" data-unicode="${encodeURIComponent(unicode)}" data-custom-uid="${escapeHtml(customUid)}" data-mine="${r.reactedByMe ? '1' : '0'}">${emoji} <span class="react-count">${count}</span></button>`;
      }).join('');
      return `<div class="reactions-chips" data-msg-name="${escapeHtml(m?.name || '')}">${chips}</div>`;
    }

    function reactFaceIconHtml() {
      return `<svg class="react-face-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="9.25" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.75" cy="10" r="1.1" fill="currentColor" stroke="none"/><path d="M8.5 14.2c1.1 1.35 2.4 2 3.5 2s2.4-.65 3.5-2"/></svg>`;
    }

    function loadReactFreqMap() {
      try {
        const raw = JSON.parse(localStorage.getItem(REACT_FREQ_KEY) || '{}');
        return raw && typeof raw === 'object' ? raw : {};
      } catch (_) {
        return {};
      }
    }

    function saveReactFreqMap(map) {
      try { localStorage.setItem(REACT_FREQ_KEY, JSON.stringify(map)); } catch (_) {}
    }

    function bumpReactFreq(reactionKey) {
      if (!reactionKey) return;
      const map = loadReactFreqMap();
      map[reactionKey] = (Number(map[reactionKey]) || 0) + 1;
      saveReactFreqMap(map);
    }

    function buildQuickReactList() {
      const freq = loadReactFreqMap();
      const pool = new Set([...DEFAULT_QUICK_REACTS, ...Object.keys(freq)]);
      return [...pool]
        .sort((a, b) => {
          const diff = (Number(freq[b]) || 0) - (Number(freq[a]) || 0);
          if (diff !== 0) return diff;
          const ai = DEFAULT_QUICK_REACTS.indexOf(a);
          const bi = DEFAULT_QUICK_REACTS.indexOf(b);
          if (ai >= 0 && bi >= 0) return ai - bi;
          if (ai >= 0) return -1;
          if (bi >= 0) return 1;
          return a.localeCompare(b);
        })
        .slice(0, QUICK_REACT_SLOTS);
    }

    function renderReactionPickerHtml(m) {
      const name = m?.name || '';
      if (!name) return '';
      return `<div class="reactions-picker" data-msg-name="${escapeHtml(name)}">
        <button type="button" class="react-toggle" title="表情回覆" aria-label="表情回覆">${reactFaceIconHtml()}</button>
      </div>`;
    }

    function openPopEmojiPicker(btn) {
      const wrap = btn?.closest?.('.reactions-picker');
      const msgName = wrap?.dataset?.msgName || '';
      if (!msgName || !window.GchatEmojiPicker) return;
      if (window.GchatEmojiPicker.isOpen()) {
        window.GchatEmojiPicker.close();
        btn.classList.remove('is-open');
        btn.title = '表情回覆';
        return;
      }
      window.GchatEmojiPicker.open(btn, {
        onPick: (payload) => {
          reactToMessage(msgName, payload);
          btn.classList.remove('is-open');
          btn.title = '表情回覆';
        },
        loadCustom: (opts) => loadPopCustomEmojisOnce(opts || {})
      });
      btn.classList.add('is-open');
      btn.title = '收合';
    }

    function renderBubbleActionsHtml(m, showReply) {
      const picker = m?.name ? renderReactionPickerHtml(m) : '';
      const reply = showReply
        ? `<button type="button" class="reply-under" title="引用回覆此訊息">${replyIconHtml()}<span>回覆</span></button>`
        : '';
      if (!picker && !reply) return '';
      return `<div class="bubble-actions-corner"><div class="bubble-actions">${reply}${picker}</div></div>`;
    }

    function renderReactionsHtml(m) {
      const chips = renderReactionChipsHtml(m);
      const actions = renderBubbleActionsHtml(m, false);
      if (!chips && !actions) return '';
      return `${chips}${actions}`;
    }

    function findReactionChip(wrap, payload) {
      if (!wrap || !payload?.reactionKey) return null;
      const keyEnc = encodeURIComponent(payload.reactionKey);
      return [...wrap.querySelectorAll('.react-chip')].find((b) => {
        if (b.dataset.reactKey === keyEnc) return true;
        const p = readPopReactPayload(b);
        return p.reactionKey === payload.reactionKey;
      }) || null;
    }

    function popChipCount(chip) {
      const span = chip?.querySelector?.('.react-count');
      if (span) return parseInt(String(span.textContent).replace(/[^\d]/g, ''), 10) || 0;
      return parseInt(String(chip?.textContent).replace(/[^\d]/g, ''), 10) || 0;
    }

    function setPopChipCount(chip, n) {
      const span = chip?.querySelector?.('.react-count');
      if (span) span.textContent = String(n);
    }

    function patchLiveThreadReaction(messageName, payload, action) {
      const reactionKey = payload?.reactionKey;
      liveThread = liveThread.map(m => {
        if (m.name !== messageName) return m;
        let reactions = Array.isArray(m.reactions) ? m.reactions.map(r => ({ ...r })) : [];
        const idx = reactions.findIndex((r) => popReactionKey(r) === reactionKey);
        if (action === 'remove') {
          if (idx >= 0) {
            const count = Math.max(0, (reactions[idx].count || 0) - 1);
            if (count <= 0) reactions.splice(idx, 1);
            else reactions[idx] = { ...reactions[idx], count, reactedByMe: false };
          }
        } else if (idx >= 0) {
          reactions[idx] = {
            ...reactions[idx],
            count: (reactions[idx].count || 0) + 1,
            reactedByMe: true
          };
        } else {
          reactions.push({
            unicode: payload.unicode || '',
            customUid: payload.customUid || '',
            label: payload.label || payload.unicode || payload.customUid || '',
            imageUrl: payload.imageUrl || '',
            reactionKey,
            count: 1,
            reactedByMe: true
          });
        }
        return { ...m, reactions };
      });
    }

    function applyReactionDom(host, payload, action, emojiHtml = '') {
      if (!host || !payload?.reactionKey) return;
      const bubble = host.closest?.('.bubble') || null;
      let chipsWrap = bubble?.querySelector('.reactions-chips')
        || (host.classList?.contains('reactions-chips') ? host : null);
      const chip = findReactionChip(chipsWrap || host, payload) || findReactionChip(bubble, payload);
      if (action === 'remove') {
        if (!chip) return;
        const n = popChipCount(chip);
        if (n <= 1) chip.remove();
        else {
          setPopChipCount(chip, n - 1);
          chip.dataset.mine = '0';
          chip.classList.remove('is-mine');
        }
        if (chipsWrap && !chipsWrap.querySelector('.react-chip')) chipsWrap.remove();
        return;
      }
      if (chip) {
        setPopChipCount(chip, popChipCount(chip) + 1);
        chip.dataset.mine = '1';
        chip.classList.add('is-mine');
        return;
      }
      if (!chipsWrap && bubble) {
        chipsWrap = document.createElement('div');
        chipsWrap.className = 'reactions-chips';
        chipsWrap.dataset.msgName = bubble.dataset.msgName || '';
        const anchor = bubble.querySelector('.bubble-actions-corner')
          || bubble.querySelector('.reactions-picker')
          || null;
        if (anchor && anchor.parentElement === bubble) {
          bubble.insertBefore(chipsWrap, anchor);
        } else {
          bubble.appendChild(chipsWrap);
        }
      }
      if (!chipsWrap) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'react-chip is-mine';
      btn.dataset.reactKey = encodeURIComponent(payload.reactionKey);
      btn.dataset.unicode = encodeURIComponent(payload.unicode || '');
      btn.dataset.customUid = payload.customUid || '';
      btn.dataset.mine = '1';
      btn.innerHTML = `${emojiHtml || resolvePopReactionEmojiHtml(payload) || '🙂'} <span class="react-count">1</span>`;
      chipsWrap.appendChild(btn);
    }

    async function reactToMessage(messageName, payload) {
      await loadPopCustomEmojisOnce();
      const reactPayload = enrichPopReactPayload(typeof payload === 'string'
        ? { unicode: payload, customUid: '', reactionKey: payload }
        : payload);
      if (!messageName || !reactPayload?.reactionKey) return;
      const esc = typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(messageName)
        : messageName.replace(/"/g, '\\"');
      const bubbles = [...document.querySelectorAll(`.bubble[data-msg-name="${esc}"]`)];
      const chip = bubbles[0]
        ? findReactionChip(bubbles[0].querySelector('.reactions-chips') || bubbles[0], reactPayload)
        : null;
      const wasMine = chip?.dataset?.mine === '1';
      const optimistic = wasMine ? 'remove' : 'add';
      const emojiHtml = chip?.querySelector('img')
        ? chip.querySelector('img').outerHTML
        : resolvePopReactionEmojiHtml(reactPayload);

      bubbles.forEach(b => applyReactionDom(b, reactPayload, optimistic, emojiHtml));
      patchLiveThreadReaction(messageName, reactPayload, optimistic);

      const res = await window.api.gchatReact?.({
        messageName,
        unicode: reactPayload.unicode || '',
        customUid: reactPayload.customUid || '',
        toggle: true
      });
      if (!res?.success) {
        bubbles.forEach(b => applyReactionDom(b, reactPayload, wasMine ? 'add' : 'remove', emojiHtml));
        patchLiveThreadReaction(messageName, reactPayload, wasMine ? 'add' : 'remove');
        alert(res?.error || '表情回覆失敗');
        return;
      }
      if (!wasMine) window.GchatEmojiPicker?.bumpFreq?.(reactPayload.reactionKey);
      const final = res.action === 'removed' ? 'remove' : 'add';
      if (final !== optimistic) {
        bubbles.forEach(b => applyReactionDom(b, reactPayload, final, emojiHtml));
        patchLiveThreadReaction(messageName, reactPayload, final);
      }
    }

    function linkifyPlainEscapedText(escapedText) {
      const raw = String(escapedText || '');
      if (!raw) return '';
      const urlRe = /https?:\/\/[^\s<>"'{}|\\^`\[\]]+/gi;
      const chunks = [];
      let last = 0;
      let match;
      while ((match = urlRe.exec(raw)) !== null) {
        if (match.index > last) chunks.push({ type: 'text', value: raw.slice(last, match.index) });
        let url = match[0];
        let trailing = '';
        while (/[.,;:!?)]$/.test(url)) {
          trailing = url.slice(-1) + trailing;
          url = url.slice(0, -1);
        }
        if (url) chunks.push({ type: 'url', value: url });
        if (trailing) chunks.push({ type: 'text', value: trailing });
        last = match.index + match[0].length;
      }
      if (last < raw.length) chunks.push({ type: 'text', value: raw.slice(last) });
      if (!chunks.length) return raw;
      return chunks.map((part) => {
        if (part.type === 'url') {
          const u = part.value;
          return `<a class="gchat-text-link" href="${u}" title="${u}" rel="noopener noreferrer" onclick="event.preventDefault();event.stopPropagation();window.api.openExternal(this.getAttribute('href'))">${u}</a>`;
        }
        return part.value;
      }).join('');
    }

    function resolvePopCustomEmojiFromLabel(label) {
      const key = String(label || '').trim().toLowerCase().replace(/^:+|:+$/g, '');
      if (!key || !Array.isArray(popCustomEmojiCache)) return null;
      const byUid = popCustomEmojiCache.find((e) => e.uid === key);
      if (byUid?.imageUrl) return byUid;
      return popCustomEmojiCache.find((e) => {
        const n = String(e.emojiName || '').trim().toLowerCase().replace(/^:+|:+$/g, '');
        return n === key;
      }) || null;
    }

    function buildPopCustomEmojiImgHtml(hit, fallbackLabel = '') {
      if (!hit?.imageUrl) return '';
      const label = escapeHtml(hit.emojiName || fallbackLabel || ':emoji:');
      return `<img class="msg-custom-emoji-img" src="${escapeHtml(hit.imageUrl)}" alt="${label}" title="${label}" />`;
    }

    function repairPopMessageTextHtml(html) {
      return String(html || '').replace(/<img\b([^>]*)>/gi, (full, attrs) => {
        const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || '';
        if (src) return full;
        const rawLabel = attrs.match(/\btitle\s*=\s*["']([^"']*)["']/i)?.[1]
          || attrs.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1]
          || '';
        const hit = resolvePopCustomEmojiFromLabel(rawLabel);
        if (hit) return buildPopCustomEmojiImgHtml(hit, rawLabel);
        const plain = String(rawLabel || '').trim();
        return plain ? escapeHtml(plain) : '';
      });
    }

    function linkifyMessageHtml(html) {
      const repaired = repairPopMessageTextHtml(html);
      // [Important] 保留卡片結構／酷連結 <a>／emoji 圖，勿當純文字拆解
      return String(repaired || '').split(/(<img\b[^>]*>|<a\b[^>]*>[\s\S]*?<\/a>|<div\b[^>]*class="[^"]*gchat-msg-card[^"]*"[^>]*>[\s\S]*?<\/div>)/gi).map((part) => {
        if (/^<(img|a|div)\b/i.test(part)) return part;
        return linkifyPlainEscapedText(part);
      }).join('');
    }

    function cardLinksHtml(links) {
      return (links || []).map((l) => {
        const u = String(l?.url || '').trim();
        if (!/^https?:\/\//i.test(u)) return '';
        const label = escapeHtml(String(l.text || u).trim() || u);
        const safe = escapeHtml(u);
        return `<a class="gchat-msg-card-btn gchat-card-link" href="${safe}" title="${safe}" rel="noopener noreferrer" data-open-url="${safe}" onclick="event.preventDefault();event.stopPropagation();window.api.openExternal(this.getAttribute('href')||this.getAttribute('data-open-url'))">${label}</a>`;
      }).filter(Boolean).join('');
    }

    function appendCardLinksHtml(html, links) {
      const list = Array.isArray(links) ? links : [];
      if (!list.length) return html || '';
      const base = String(html || '');
      if (base.includes('gchat-msg-card')) return base;
      const missing = list.filter((l) => {
        const u = String(l?.url || '').trim();
        return u && !base.includes(u) && !base.includes(escapeHtml(u));
      });
      if (!missing.length) return base;
      const block = `<div class="gchat-msg-card-actions">${cardLinksHtml(missing)}</div>`;
      return base ? `${base}${block}` : block;
    }

    function expandPopCustomEmojiInPlainText(text) {
      return String(text || '').replace(/:{1,2}([a-z0-9_-]+):{1,2}/gi, (match) => {
        const hit = resolvePopCustomEmojiFromLabel(match);
        if (hit) return buildPopCustomEmojiImgHtml(hit, match);
        return escapeHtml(match);
      });
    }

    function popTextHtmlNeedsRepair(html, m) {
      if (!html) return true;
      if (/[\uFFFC\uFFFD]/.test(html)) return true;
      if ((m?.emojiAnnotations?.length || 0) > 0 && !/<img\b/i.test(html)) return true;
      return /<img\b(?![^>]*\bsrc=["'][^"']+["'])/i.test(html);
    }

    function rebuildPopMessageTextHtml(m) {
      const text = String(m?.text || '').trim();
      if (!text) return '';
      let out = text;
      const anns = [...(m?.emojiAnnotations || [])].sort((a, b) => (Number(b.s) || 0) - (Number(a.s) || 0));
      for (const a of anns) {
        const start = Number(a.s) || 0;
        const len = Number(a.l) || 0;
        if (len <= 0 || start < 0 || start + len > out.length) continue;
        const hit = popCustomEmojiCache?.find((e) => e.uid === a.u)
          || resolvePopCustomEmojiFromLabel(a.e || (a.u ? `:${a.u}:` : ''));
        const insert = hit?.imageUrl
          ? buildPopCustomEmojiImgHtml(hit, a.e || (a.u ? `:${a.u}:` : ''))
          : escapeHtml(a.e || (a.u ? `:${a.u}:` : ''));
        out = out.slice(0, start) + insert + out.slice(start + len);
      }
      out = out.replace(/\uFFFC|\uFFFD|\uFEFF/g, '');
      if (out.includes('<img')) {
        return out.split(/(<img\b[^>]*>)/gi).map((seg) => (/^<img\b/i.test(seg) ? seg : expandPopCustomEmojiInPlainText(seg))).join('');
      }
      return expandPopCustomEmojiInPlainText(out);
    }

    function renderMessageText(mOrText) {
      const m = typeof mOrText === 'object' && mOrText ? mOrText : { text: mOrText };
      // 卡片訊息：直接用表格感 cardHtml（按鈕文字即酷連結）
      if (m.cardHtml) {
        const extra = (m.textHtml && !String(m.textHtml).includes('gchat-msg-card'))
          ? linkifyMessageHtml(m.textHtml)
          : '';
        return `${extra || ''}${m.cardHtml}`;
      }
      if (m.textHtml && !popTextHtmlNeedsRepair(m.textHtml, m)) {
        return appendCardLinksHtml(linkifyMessageHtml(m.textHtml), m.cardLinks);
      }
      if (m.emojiAnnotations?.length || /[\uFFFC\uFFFD]/.test(m.text || '')) {
        const rebuilt = rebuildPopMessageTextHtml(m);
        if (rebuilt) return appendCardLinksHtml(linkifyMessageHtml(repairPopMessageTextHtml(rebuilt)), m.cardLinks);
      }
      if (m.textHtml) return appendCardLinksHtml(linkifyMessageHtml(repairPopMessageTextHtml(m.textHtml)), m.cardLinks);
      const raw = String(m.text || m.snippet || '').trim();
      if (!raw) {
        if (m.cardLinks?.length) return `<div class="gchat-msg-card-actions">${cardLinksHtml(m.cardLinks)}</div>`;
        if (m.media?.length) return '';
        if (m.quoted?.text || m.quoted?.textHtml || m.quoted?.media?.length) return '';
        return escapeHtml('（無文字）');
      }
      const urlRe = /https?:\/\/[^\s<>"'{}|\\^`\[\]]+/gi;
      const chunks = [];
      let last = 0;
      let match;
      while ((match = urlRe.exec(raw)) !== null) {
        if (match.index > last) chunks.push({ type: 'text', value: raw.slice(last, match.index) });
        let url = match[0];
        let trailing = '';
        while (/[.,;:!?)]$/.test(url)) {
          trailing = url.slice(-1) + trailing;
          url = url.slice(0, -1);
        }
        if (url) chunks.push({ type: 'url', value: url });
        if (trailing) chunks.push({ type: 'text', value: trailing });
        last = match.index + match[0].length;
      }
      if (last < raw.length) chunks.push({ type: 'text', value: raw.slice(last) });
      if (!chunks.length) return escapeHtml(raw || '（無文字）');

      return appendCardLinksHtml(chunks.map((part) => {
        if (part.type === 'url') {
          const u = escapeHtml(part.value);
          return `<a class="gchat-text-link" href="${u}" title="${u}" rel="noopener noreferrer" onclick="event.preventDefault();event.stopPropagation();window.api.openExternal(this.getAttribute('href'))">${u}</a>`;
        }
        const expanded = expandPopCustomEmojiInPlainText(part.value);
        if (expanded.includes('<img')) {
          return expanded.split(/(<img\b[^>]*>)/gi).map((seg) => (/^<img\b/i.test(seg) ? seg : escapeHtml(seg))).join('');
        }
        return escapeHtml(part.value);
      }).join(''), m.cardLinks);
    }

    function gchatThreadGroupKey(m) {
      const th = String(m?.threadName || '').trim();
      if (th) return th;
      return String(m?.name || '').trim();
    }

    /** 先依討論串 ID 分組，組內再依時間；各組依根訊息時間排序 */
    function groupGchatMessagesByThread(list) {
      const raw = Array.isArray(list) ? list : [];
      const byName = new Map();
      for (const m of raw) {
        if (m?.name && !byName.has(m.name)) byName.set(m.name, m);
      }
      const groups = new Map();
      for (const m of byName.values()) {
        const key = gchatThreadGroupKey(m);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      }
      const blocks = [...groups.values()].map((msgs) => {
        const sorted = [...msgs].sort((a, b) =>
          String(a.createTime || '').localeCompare(String(b.createTime || ''))
        );
        return { anchor: sorted[0]?.createTime || '', sorted };
      });
      blocks.sort((a, b) => String(a.anchor).localeCompare(String(b.anchor)));
      return blocks.flatMap((b) => b.sorted);
    }

    /** 主泡泡：每串只顯示根訊息，回覆收合為「N則回覆」 */
    function messageHasContent(m) {
      if (!m) return false;
      const t = String(m.text || m.snippet || m.cardText || '').trim();
      if (t && t !== '（無文字）') return true;
      return !!(m.media?.length);
    }

    /** 暫存只有佔位 stub（成員／無文字）時不走 cacheOnly，改走 API */
    function cacheDetailUsable(res) {
      if (!res?.success) return false;
      const thread = Array.isArray(res.thread) && res.thread.length
        ? res.thread
        : (res.detail ? [res.detail] : []);
      if (!thread.length) return false;
      const withContent = thread.filter(messageHasContent);
      if (!withContent.length) return false;
      if (thread.length === 1 && !messageHasContent(thread[0])) return false;
      return true;
    }

    function syncViewingContext() {
      if (!ctx?.spaceName) return;
      window.api.gchatSetViewing?.({
        spaceName: ctx.spaceName,
        threadName: (isFocusThreadMode ? focusThreadName : '') || ctx.threadName || '',
        messageName: ctx.name || focusName,
        isDm: !!ctx.isDm
      });
    }

    function restoreFromMinibar() {
      syncViewingContext();
      refreshLiveThreadCacheFirst({ force: true });
    }

    function pickThreadRoot(block) {
      if (!block?.length) return null;
      const byRootId = block.find((m) => m.threadName && m.name === m.threadName);
      if (byRootId && messageHasContent(byRootId)) return byRootId;
      const withText = block.find((m) => messageHasContent(m));
      if (withText) return withText;
      return block[0];
    }

    function buildMainThreadDisplay(list) {
      if (isFocusThreadMode) return { displayList: list, collapseByRoot: new Map() };
      const groups = new Map();
      for (const m of list || []) {
        const key = gchatThreadGroupKey(m);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      }
      const blocks = [...groups.values()].map((msgs) =>
        [...msgs].sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')))
      );
      blocks.sort((a, b) => String(a[0]?.createTime || '').localeCompare(String(b[0]?.createTime || '')));
      const displayList = [];
      const collapseByRoot = new Map();
      for (const block of blocks) {
        const root = pickThreadRoot(block);
        if (!root?.name) continue;
        const key = gchatThreadGroupKey(root);
        const shouldExpand = expandedThreadKeys.has(key);
        if (shouldExpand) {
          for (const m of block) displayList.push(m);
          continue;
        }
        displayList.push(root);
        if (block.length > 1) {
          collapseByRoot.set(root.name, {
            count: block.length - 1,
            root,
            threadName: root.threadName || '',
            rootText: snippetForFocusTitle(root.text || root.snippet || '')
          });
        }
      }
      return { displayList, collapseByRoot };
    }

    /** 依引用／同討論串關係計算階梯深度 */
    function computeThreadDepths(list) {
      const depthByName = new Map();
      const firstIndexByGroup = new Map();
      (list || []).forEach((m, i) => {
        const key = gchatThreadGroupKey(m);
        if (key && !firstIndexByGroup.has(key)) firstIndexByGroup.set(key, i);
      });

      return (list || []).map((m, i) => {
        let depth = 0;
        const groupKey = gchatThreadGroupKey(m);
        const rootIdx = groupKey ? firstIndexByGroup.get(groupKey) : i;
        const isThreadRoot = rootIdx === i;
        const quotedName = m?.quoted?.name || '';

        if (!isThreadRoot) {
          if (quotedName && depthByName.has(quotedName)) {
            const quoted = list.find((x) => x?.name === quotedName);
            const qKey = gchatThreadGroupKey(quoted);
            if (qKey === groupKey) {
              depth = Math.min(6, (depthByName.get(quotedName) || 0) + 1);
            } else {
              const rootMsg = list[rootIdx];
              const rootDepth = rootMsg?.name ? (depthByName.get(rootMsg.name) || 0) : 0;
              depth = Math.min(6, rootDepth + 1);
            }
          } else {
            const rootMsg = list[rootIdx];
            const rootDepth = rootMsg?.name ? (depthByName.get(rootMsg.name) || 0) : 0;
            depth = Math.min(6, rootDepth + 1);
          }
        }
        if (m?.name) depthByName.set(m.name, depth);
        return depth;
      });
    }

    function filterThreadForFocus(list, detail) {
      if (!isFocusThreadMode) return list || [];
      const key = String(focusThreadName || detail?.threadName || '').replace(/^focus:/, '');
      if (!key) return list || [];
      const raw = list || [];
      const rootName = String(focusRootMessageName || '').trim();

      let filtered = [];
      if (/\/threads\//.test(key)) {
        filtered = raw.filter((m) => m && (m.threadName === key || m.name === key));
      } else {
        const root = key.startsWith('anchor:') ? key.slice(7)
          : (key.startsWith('msg:') ? key.slice(4) : key);
        if (!root) return raw;
        const include = new Set([root]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const m of raw) {
            if (!m?.name || include.has(m.name)) continue;
            if (m.quoted?.name && include.has(m.quoted.name)) {
              include.add(m.name);
              changed = true;
            }
          }
        }
        filtered = raw.filter(m => include.has(m.name));
      }
      if (!filtered.length) return raw;
      filtered = [...filtered].sort((a, b) =>
        String(a.createTime || '').localeCompare(String(b.createTime || ''))
      );
      // 保留根訊息在最上方（星星只亮這一則）；其下為回覆串
      return filtered;
    }

    /** Google Chat 討論串資源名，或訊息錨點（無 thread 時） */
    function resolveFocusThreadKey(messageName, threadName) {
      const th = String(threadName || '').trim().replace(/^focus:/, '');
      if (/\/threads\//.test(th)) return th;
      if (th.startsWith('anchor:')) return th;
      if (th.startsWith('msg:')) return `anchor:${th.slice(4)}`;
      const msg = String(messageName || '').trim();
      if (msg.includes('/messages/')) return `anchor:${msg}`;
      return '';
    }

    function snippetForFocusTitle(text) {
      return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 36);
    }

    /** 從討論串找出根訊息（最早一則／被引用起點） */
    function findThreadRootMessage(list, clicked) {
      const raw = list || [];
      const byName = new Map(raw.filter(m => m?.name).map(m => [m.name, m]));
      const th = String(clicked?.threadName || '').trim();
      if (/\/threads\//.test(th)) {
        const inThread = raw
          .filter(m => m.threadName === th)
          .sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
        if (inThread.length) return inThread[0];
      }
      let cur = clicked;
      for (let i = 0; i < 30; i++) {
        const qn = cur?.quoted?.name;
        if (!qn || !byName.has(qn)) break;
        cur = byName.get(qn);
      }
      return cur || clicked;
    }

    function buildFocusBarTitle(contact, rootText) {
      const c = String(contact || '').trim() || '對話';
      const r = snippetForFocusTitle(rootText);
      return r ? `${c}★${r}` : `${c}★討論串`;
    }

    async function openFocusThread(messageName, threadName, clickedText = '') {
      const msg = messageName || '';
      if (!msg) return;
      if (ctx?.isDm || ctx?.spaceType === 'DIRECT_MESSAGE') return;
      const list = liveThread?.length ? liveThread : (ctx ? [ctx] : []);
      const clicked = list.find(m => m.name === msg) || {
        name: msg,
        threadName: threadName || '',
        text: clickedText || '',
        snippet: clickedText || ''
      };
      if (clickedText && !clicked.text) {
        clicked.text = clickedText;
        clicked.snippet = clickedText;
      }
      const root = findThreadRootMessage(list, clicked);
      // 點在根訊息上：優先用畫面上的文字當標題
      const rootText = snippetForFocusTitle(
        (root?.name === msg ? (clickedText || root?.text || root?.snippet) : null)
        || root?.text
        || root?.snippet
        || clickedText
        || ''
      );
      const th = resolveFocusThreadKey(root?.name || msg, root?.threadName || threadName || clicked.threadName);
      if (!th) {
        alert('此則訊息沒有可用的討論串識別，無法獨立專注。');
        return;
      }
      if (isFocusThreadMode) {
        const cur = String(focusThreadName || '').replace(/^focus:/, '');
        if (cur === th || cur === `anchor:${root?.name || msg}`) return;
      }
      const contact = conversationTitle(ctx, list);
      const res = await window.api.gchatCompactOpen?.({
        messageName: root?.name || msg,
        spaceName: ctx?.spaceName || '',
        threadName: th,
        focusThread: true,
        title: contact,
        focusRootText: rootText,
        rootMessageName: root?.name || msg,
        isDm: !!ctx?.isDm,
        skipMarkRead: true
      });
      if (res?.success === false) {
        console.warn('[LittleReply][Focus] open failed', res?.error || res);
        alert(res?.error || '無法開啟專注討論串');
      }
    }

    function renderThread(detail, thread, opts = {}) {
      let list = filterThreadForFocus(thread?.length ? thread : [detail], detail);
      if (!isFocusThreadMode) list = groupGchatMessagesByThread(list);
      const { displayList, collapseByRoot } = buildMainThreadDisplay(list);
      const renderList = isFocusThreadMode ? list : displayList;
      const contact = conversationTitle(detail, thread?.length ? thread : list);
      if (!focusContactTitle && contact) focusContactTitle = contact;
      if (contact && !isFocusThreadMode) {
        focusContactTitle = contact;
      }
      if (!focusRootText && isFocusThreadMode) {
        const rootHit = (thread || []).find(m => m.name === focusRootMessageName)
          || (thread || []).find(m => m.threadName && m.threadName === String(focusThreadName || '').replace(/^focus:/, ''));
        if (rootHit) focusRootText = snippetForFocusTitle(rootHit.text || rootHit.snippet || '');
      }
      const titleText = isFocusThreadMode
        ? buildFocusBarTitle(focusContactTitle || contact, focusRootText)
        : contact;
      const titleEl = document.getElementById('title');
      if (titleEl) titleEl.textContent = titleText;
      const isDm = !!(detail?.isDm || detail?.spaceType === 'DIRECT_MESSAGE');
      window.api.gchatCompactSetTitle?.({
        messageName: focusName,
        spaceName: detail?.spaceName || '',
        title: titleText,
        contactTitle: focusContactTitle || contact,
        focusRootText: focusRootText || '',
        sender: detail?.sender || '',
        isDm
      });
      const peer = contact;
      const sender = String(detail.sender || '').trim();
      const metaWho = (sender && sender !== '我' && !isSelfTitlePart(sender)) ? sender : peer;
      const focusHint = isFocusThreadMode
        ? ` · 專注：${snippetForFocusTitle(focusRootText) || '討論串'}`
        : '';
      document.getElementById('meta').textContent = `${metaWho}${detail.isDm ? ' · 私人' : ''}${focusHint}`.trim();
      const box = document.getElementById('thread');
      scrollDebugLog('RENDER');
      const openingActive = isOpeningScrollActive();
      // [Important] 刷新時記住閱讀錨點，勿把捲動甩回第一則／焦點則（Opening 期間不 capture）
      const scrollAnchor = (opts.preserveScroll && !openingActive)
        ? captureThreadScrollAnchor(box)
        : null;
      if (openingActive && opts.useInitialScroll && opts.scrollMode !== 'none') {
        box.classList.add('is-opening-scroll');
      }
      box.innerHTML = renderList.map((m, idx) => {
        const mine = isMineMessage(m);
        const showReply = m.name && !mine;
        const thName = m.threadName || '';
        const focusId = resolveFocusThreadKey(m.name, thName);
        const collapse = !isFocusThreadMode && collapseByRoot.has(m.name)
          ? collapseByRoot.get(m.name)
          : null;
        const isThreadRoot = !isFocusThreadMode
          || (focusRootMessageName && m.name === focusRootMessageName)
          || (!focusRootMessageName && idx === 0);
        // 只亮「你點擊專注的那一則」（根訊息），同串其他則保持淡色
        const starOn = !!(isFocusThreadMode
          && focusRootMessageName
          && m.name === focusRootMessageName);
        const rootCls = isThreadRoot ? ' is-thread-root' : '';
        const actionsHtml = renderBubbleActionsHtml(m, showReply);
        const actionCls = actionsHtml ? ' has-actions' : '';
        return `
        <div class="thread-step">
        <div class="bubble${rootCls}${actionCls} ${m.name === detail.name ? 'is-focus' : ''} ${mine ? 'is-mine' : ''}"
             data-msg-name="${escapeHtml(m.name || '')}"
             data-thread-name="${escapeHtml(thName)}"
             data-focus-id="${escapeHtml(focusId)}"
             data-sender="${escapeHtml(m.sender || '')}"
             data-create-time="${escapeHtml(m.createTime || '')}"
             data-last-update-time="${escapeHtml(m.lastUpdateTime || m.createTime || '')}"
             data-mine="${mine ? '1' : '0'}">
          ${m.name && !isDm ? `<button type="button" class="focus-star ${starOn ? 'is-on' : ''}" title="專注此回覆串（獨立置頂）" aria-label="專注討論串">★</button>` : ''}
          <div class="bubble-top">
            <div class="who">${escapeHtml(mine ? '我' : (m.sender || '成員'))} · ${escapeHtml(m.createTimeLabel || '')}</div>
          </div>
          ${renderQuoteHtml(m.quoted)}
          <div class="text">${renderMessageText(m)}</div>
          ${renderMediaHtml(m.media, { hideCardDecor: !!(m.cardHtml || m.cardLinks?.length) })}
          ${renderReactionChipsHtml(m)}
          ${actionsHtml}
        </div>
        ${collapse && !isDm ? `<button type="button" class="thread-collapse-link" data-root-name="${escapeHtml(m.name)}" data-thread-name="${escapeHtml(collapse.threadName || thName)}" data-root-text="${escapeHtml(collapse.rootText || '')}" title="開啟專注討論串">${collapse.count}則回覆</button>` : ''}
        </div>`;
      }).join('');
      box.querySelectorAll('.quote.is-jumpable').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          jumpToQuotedMessage(btn.dataset.quoteName || '');
        });
      });
      box.querySelectorAll('.reply-under').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          setReplyTargetFromBubble(btn);
        });
      });
      box.querySelectorAll('.thread-collapse-link').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openFocusThread(
            btn.dataset.rootName || '',
            btn.dataset.threadName || '',
            btn.dataset.rootText || ''
          );
        });
      });
      box.querySelectorAll('.focus-star').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const bubble = btn.closest('.bubble');
          const text = (bubble?.querySelector('.text')?.innerText || '').trim();
          openFocusThread(
            bubble?.dataset?.msgName || '',
            bubble?.dataset?.threadName || bubble?.dataset?.focusId || '',
            text
          );
        });
      });
      box.querySelectorAll('[data-open-url]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const url = el.getAttribute('data-open-url');
          if (url) window.api.openExternal(url);
        });
      });
      box.querySelectorAll('a.gchat-text-link').forEach(el => {
        if (el.getAttribute('data-open-url')) return;
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const url = el.getAttribute('href');
          if (url) window.api.openExternal(url);
        });
      });
      markReplyIconsMaterial();
      const applyScroll = () => {
        if (opts.preserveScroll) {
          if (openingActive) {
            scrollDebugLog('PRESERVE_SCROLL_SKIPPED', 'reason=opening');
          } else {
            stabilizeThreadScrollRestore(box, scrollAnchor);
            return;
          }
        }
        if (openingActive && opts.scrollMode !== 'none') {
          runInitialScrollController(box, opts.threadForScroll || renderList);
          return;
        }
        if (opts.scrollMode === 'jump' && opts.jumpMessageName) {
          const jumpName = String(opts.jumpMessageName).trim();
          const doJump = () => scrollToThreadMessage(jumpName);
          requestAnimationFrame(() => requestAnimationFrame(doJump));
          setTimeout(doJump, 120);
          setTimeout(doJump, 480);
          return;
        }
        if (opts.scrollMode === 'open') {
          scrollThreadOnOpen(box, opts.readUntil != null ? opts.readUntil : openReadUntil);
          return;
        }
        if (opts.scrollMode === 'bottom') {
          scrollThreadToBottom(box);
          return;
        }
        if (opts.scrollMode === 'none') {
          if (openingActive) {
            scrollDebugLog('PRESERVE_SCROLL_SKIPPED', 'reason=opening_defer');
          }
          return;
        }
        box.scrollTop = box.scrollHeight;
      };
      // 等 layout 完成再還原，避免 offsetTop 尚未穩定
      requestAnimationFrame(() => requestAnimationFrame(applyScroll));
    }

    function mergeThreadPreservingReactions(prev, next) {
      if (!Array.isArray(prev) || !Array.isArray(next)) return next;
      const prevMap = new Map(prev.filter((m) => m?.name).map((m) => [m.name, m]));
      return next.map((m) => {
        const p = prevMap.get(m.name);
        if (!p?.reactions?.length) return m;
        const nextRx = Array.isArray(m.reactions) ? m.reactions.map((r) => ({ ...r })) : [];
        if (!nextRx.length) return { ...m, reactions: p.reactions.map((r) => ({ ...r })) };
        const merged = nextRx.map((r) => {
          const hit = (p.reactions || []).find((pr) => popReactionKey(pr) === popReactionKey(r));
          if (hit?.reactedByMe && !r.reactedByMe) return { ...r, reactedByMe: true };
          if (hit && (hit.count || 0) > (r.count || 0)) return { ...r, count: hit.count, reactedByMe: hit.reactedByMe || r.reactedByMe };
          return r;
        });
        for (const pr of p.reactions || []) {
          const key = popReactionKey(pr);
          if (!key) continue;
          if (!merged.some((r) => popReactionKey(r) === key)) {
            merged.push({ ...pr });
            continue;
          }
          if (pr.reactedByMe) {
            const idx = merged.findIndex((r) => popReactionKey(r) === key);
            if (idx >= 0 && !merged[idx].reactedByMe) {
              merged[idx] = { ...merged[idx], reactedByMe: true };
            }
          }
        }
        return { ...m, reactions: merged };
      });
    }

    function scrollThreadToBottom(box) {
      if (!box) return;
      const run = () => { box.scrollTop = box.scrollHeight; };
      run();
      requestAnimationFrame(() => requestAnimationFrame(run));
      setTimeout(run, 120);
      setTimeout(run, 480);
    }

    /**
     * 剛打開泡泡：有未讀水位則置中第一則未讀（firstUnreadMessage）；否則捲到底
     * @returns {boolean} 是否成功定位到未讀（false 表示 fallback 到底）
     */
    function scrollThreadOnOpen(box, readUntil) {
      if (!box) return false;
      const until = String(readUntil || '').trim();
      if (!until) {
        scrollThreadToBottom(box);
        return true;
      }
      const bubbles = [...box.querySelectorAll('.bubble[data-msg-name]')];
      let firstUnreadEl = null;
      for (const el of bubbles) {
        const t = String(el.dataset.createTime || '');
        if (t && t > until) {
          firstUnreadEl = el;
          break;
        }
      }
      if (!firstUnreadEl) {
        scrollThreadToBottom(box);
        return true;
      }
      const centerUnread = () => scrollElementToViewportCenter(box, firstUnreadEl);
      centerUnread();
      requestAnimationFrame(() => requestAnimationFrame(centerUnread));
      setTimeout(centerUnread, 120);
      setTimeout(centerUnread, 480);
      firstUnreadEl.classList.add('is-focus');
      setTimeout(() => firstUnreadEl.classList.remove('is-focus'), 1200);
      return true;
    }

    /** 記住目前視線：貼底／或某一則訊息的相對偏移 */
    function captureThreadScrollAnchor(box) {
      if (!box) return { mode: 'bottom' };
      const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
      if (gap < 100) return { mode: 'bottom' };
      const bubbles = [...box.querySelectorAll('.bubble[data-msg-name]')];
      for (const el of bubbles) {
        const bottom = el.offsetTop + el.offsetHeight;
        if (bottom > box.scrollTop + 8) {
          return {
            mode: 'msg',
            name: el.dataset.msgName || '',
            offset: box.scrollTop - el.offsetTop,
            scrollTop: box.scrollTop
          };
        }
      }
      return { mode: 'pos', scrollTop: box.scrollTop };
    }

    function restoreThreadScrollAnchor(box, anchor) {
      if (!box) return;
      if (!anchor || anchor.mode === 'bottom') {
        if (anchor?.mode === 'bottom') {
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      if (anchor.mode === 'msg' && anchor.name) {
        const el = [...box.querySelectorAll('.bubble[data-msg-name]')]
          .find(n => n.dataset.msgName === anchor.name);
        if (el) {
          box.scrollTop = Math.max(0, el.offsetTop + (Number(anchor.offset) || 0));
          return;
        }
      }
      if (typeof anchor.scrollTop === 'number') {
        const max = Math.max(0, box.scrollHeight - box.clientHeight);
        box.scrollTop = Math.min(anchor.scrollTop, max);
      }
    }

    function stabilizeThreadScrollRestore(box, anchor) {
      if (!box || !anchor) return;
      if (isOpeningScrollActive()) {
        scrollDebugLog('PRESERVE_SCROLL_SKIPPED', 'reason=opening_stabilize');
        return;
      }
      const run = () => restoreThreadScrollAnchor(box, anchor);
      requestAnimationFrame(() => requestAnimationFrame(run));
      [60, 150, 320, 600].forEach((ms) => setTimeout(run, ms));
    }

