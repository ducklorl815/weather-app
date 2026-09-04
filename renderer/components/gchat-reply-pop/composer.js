// [Important] Reply Pop · composer — classic script; shared state in state.js (var/function globals)
    function insertIntoReply(content) {
      const el = document.getElementById('reply');
      if (!el || !content) return;
      el.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(content));
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.appendChild(document.createTextNode(content));
      }
    }

    function openComposeEmojiPicker(btn) {
      if (!btn || !window.GchatEmojiPicker) return;
      if (window.GchatEmojiPicker.isOpen()) {
        window.GchatEmojiPicker.close();
        btn.classList.remove('is-open');
        btn.title = '插入表情';
        return;
      }
      window.GchatEmojiPicker.open(btn, {
        onPick: (payload) => {
          if (payload.customUid) {
            const hit = popCustomEmojiCache?.find((e) => e.uid === payload.customUid);
            const code = hit?.emojiName || `:${payload.customUid}:`;
            insertIntoReply(code);
          } else if (payload.unicode) {
            insertIntoReply(payload.unicode);
          }
          btn.classList.remove('is-open');
          btn.title = '插入表情';
        },
        loadCustom: (opts) => loadPopCustomEmojisOnce(opts || {})
      });
      btn.classList.add('is-open');
      btn.title = '收合';
    }

    function getText() {
      const el = document.getElementById('reply');
      if (!el) return '';
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        if (node.tagName === 'BR') return '\n';
        // @mention chip
        if (node.classList?.contains('mention-chip')) {
          // 群組外：只當純文字標籤，勿送 <users/…>（避免提醒／邀請）
          if (node.getAttribute('data-label-only') === '1') {
            return String(node.textContent || '').trim();
          }
          const user = String(node.getAttribute('data-user') || '').trim();
          if (user) return `<${user}>`;
          return String(node.textContent || '').trim();
        }
        const inner = [...node.childNodes].map(walk).join('');
        if (node.tagName === 'DIV' || node.tagName === 'P') return inner ? `${inner}\n` : '\n';
        return inner;
      };
      return walk(el).replace(/\n{3,}/g, '\n\n').trim();
    }

    // ---------- @ 聯絡人搜尋／標註 ----------

    function hideMentionSuggest() {
      const box = document.getElementById('mention-suggest');
      if (box) {
        box.hidden = true;
        box.innerHTML = '';
      }
      mentionHits = [];
      mentionActive = -1;
      mentionQuery = '';
    }

    function isGroupMentionContext() {
      return !!(ctx && !ctx.isDm && ctx.spaceType !== 'DIRECT_MESSAGE' && ctx.spaceName);
    }

    function getMentionContext() {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) return null;
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return null;
      const reply = document.getElementById('reply');
      if (!reply || !reply.contains(node)) return null;
      const text = node.nodeValue || '';
      const caret = range.startOffset;
      const before = text.slice(0, caret);
      const m = before.match(/(^|[\s\u3000])@([^\s@]*)$/);
      if (!m) return null;
      return {
        node,
        caret,
        atStart: before.length - m[2].length - 1,
        query: m[2] || '',
        range
      };
    }

    function paintMentionSuggest(items) {
      const box = document.getElementById('mention-suggest');
      if (!box) return;
      mentionHits = items || [];
      if (!mentionHits.length) {
        hideMentionSuggest();
        return;
      }
      mentionActive = 0;
      box.hidden = false;
      box.innerHTML = mentionHits.map((c, i) => {
        const label = escapeHtml(c.label || c.userName || '');
        const hint = escapeHtml(c.hint || c.email || '聯絡人');
        const iconUrl = String(c.iconUrl || '').trim();
        const letter = escapeHtml(String(c.label || '?').charAt(0));
        const avatar = (iconUrl && (/^https?:\/\//i.test(iconUrl) || /^data:image\//i.test(iconUrl)))
          ? `<img class="mention-suggest-avatar" src="${escapeHtml(iconUrl)}" alt="" referrerpolicy="no-referrer" />`
          : `<span class="mention-suggest-avatar is-letter">${letter}</span>`;
        return `<button type="button" class="mention-suggest-item${i === 0 ? ' is-active' : ''}" data-idx="${i}">
          ${avatar}
          <span class="mention-suggest-meta">
            <div class="mention-suggest-name">${label}</div>
            <div class="mention-suggest-hint">${hint}</div>
          </span>
        </button>`;
      }).join('');
      box.querySelectorAll('.mention-suggest-item').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const idx = Number(btn.getAttribute('data-idx'));
          insertMentionHit(mentionHits[idx]);
        });
      });
    }

    function shortMentionLabel(label) {
      const s = String(label || '').trim();
      const idx = s.lastIndexOf('_');
      if (idx >= 0 && idx < s.length - 1) {
        const tail = s.slice(idx + 1).trim();
        if (tail) return tail;
      }
      return s;
    }

    function placeCaretAfter(node) {
      const sel = window.getSelection();
      if (!sel || !node) return;
      const range = document.createRange();
      if (node.nodeType === Node.TEXT_NODE) {
        range.setStart(node, node.nodeValue?.length || 0);
      } else {
        range.setStartAfter(node);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function removeMentionChip(chip) {
      if (!chip || !chip.parentNode) return;
      const parent = chip.parentNode;
      const prev = chip.previousSibling;
      const next = chip.nextSibling;
      parent.removeChild(chip);
      // 清掉插入時留下的 NBSP
      if (next && next.nodeType === Node.TEXT_NODE && /^[\u00a0 ]/.test(next.nodeValue || '')) {
        next.nodeValue = String(next.nodeValue || '').replace(/^[\u00a0 ]/, '');
        if (!next.nodeValue) parent.removeChild(next);
      }
      if (prev && prev.nodeType === Node.TEXT_NODE) placeCaretAfter(prev);
      else if (next && next.parentNode) {
        const sel = window.getSelection();
        const range = document.createRange();
        if (next.nodeType === Node.TEXT_NODE) range.setStart(next, 0);
        else range.setStartBefore(next);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        const reply = document.getElementById('reply');
        reply?.focus();
      }
    }

    /** Backspace／Delete：整顆刪除 mention chip（contenteditable=false 時瀏覽器常刪不掉） */
    function tryDeleteAdjacentMention(e) {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
      const reply = document.getElementById('reply');
      const sel = window.getSelection();
      if (!reply || !sel || !sel.rangeCount) return false;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) {
        // 選取範圍含 chip → 交給預設；若只選到 chip 則手動刪
        const chip = range.commonAncestorContainer?.nodeType === Node.ELEMENT_NODE
          ? range.commonAncestorContainer.closest?.('.mention-chip')
          : range.commonAncestorContainer.parentElement?.closest?.('.mention-chip');
        if (chip && reply.contains(chip)) {
          e.preventDefault();
          removeMentionChip(chip);
          return true;
        }
        return false;
      }

      let node = range.startContainer;
      let offset = range.startOffset;

      if (e.key === 'Backspace') {
        if (node.nodeType === Node.TEXT_NODE) {
          const prev = node.previousSibling;
          if (prev?.classList?.contains('mention-chip')) {
            const val = node.nodeValue || '';
            // 游標緊貼 chip 後（含插入後的一個空白）→ 一次刪整顆
            if (offset === 0 || (offset <= 1 && /^[\u00a0 ]/.test(val.slice(0, offset)))) {
              e.preventDefault();
              if (offset > 0) node.nodeValue = val.slice(offset);
              removeMentionChip(prev);
              return true;
            }
          }
        }
        if (node === reply || (node.nodeType === Node.ELEMENT_NODE && reply.contains(node))) {
          const child = node.childNodes[offset - 1] || node.previousSibling;
          if (child?.classList?.contains('mention-chip')) {
            e.preventDefault();
            removeMentionChip(child);
            return true;
          }
        }
      }

      if (e.key === 'Delete') {
        if (node.nodeType === Node.TEXT_NODE && offset >= (node.nodeValue?.length || 0)) {
          const next = node.nextSibling;
          if (next?.classList?.contains('mention-chip')) {
            e.preventDefault();
            removeMentionChip(next);
            return true;
          }
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          const child = node.childNodes[offset];
          if (child?.classList?.contains('mention-chip')) {
            e.preventDefault();
            removeMentionChip(child);
            return true;
          }
        }
      }
      return false;
    }

    function insertMentionHit(hit) {
      if (!hit?.userName && !hit?.label) return;
      const mctx = getMentionContext();
      const reply = document.getElementById('reply');
      if (!reply) return;
      const userName = String(hit.userName || '').startsWith('users/')
        ? String(hit.userName)
        : (hit.userName ? `users/${hit.userName}` : '');
      const label = shortMentionLabel(hit.label || hit.email || userName);
      // 群組內成員 → 真 @；群組外／僅標籤 → 純文字（不提醒、不邀請）
      const labelOnly = hit.labelOnly === true || hit.inSpace === false;
      const chip = document.createElement('span');
      chip.className = 'mention-chip' + (labelOnly ? ' is-label-only' : '');
      if (userName && !labelOnly) chip.setAttribute('data-user', userName);
      if (labelOnly) chip.setAttribute('data-label-only', '1');
      chip.setAttribute('contenteditable', 'false');
      chip.textContent = `@${label}`;

      if (mctx) {
        const { node, atStart, caret } = mctx;
        const text = node.nodeValue || '';
        const before = text.slice(0, atStart);
        const after = text.slice(caret);
        const parent = node.parentNode;
        const beforeNode = document.createTextNode(before);
        // 後面用一般空白，Backspace 較好處理
        const afterNode = document.createTextNode(after || ' ');
        parent.insertBefore(beforeNode, node);
        parent.insertBefore(chip, node);
        parent.insertBefore(afterNode, node);
        parent.removeChild(node);
        const sel = window.getSelection();
        const range = document.createRange();
        range.setStart(afterNode, afterNode.nodeValue?.startsWith(' ') ? 1 : 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        reply.appendChild(chip);
        reply.appendChild(document.createTextNode(' '));
      }
      hideMentionSuggest();
      reply.focus();
    }

    async function ensureSpaceMembersLoaded() {
      const spaceName = String(ctx?.spaceName || '').trim();
      if (!spaceName) return [];
      if (spaceMembersCache.has(spaceName)) return spaceMembersCache.get(spaceName);
      if (spaceMembersLoading === spaceName) return [];
      spaceMembersLoading = spaceName;
      try {
        const res = await window.api.gchatSpaceMembers?.({ spaceName });
        const members = Array.isArray(res?.members) ? res.members : [];
        spaceMembersCache.set(spaceName, members);
        return members;
      } catch (_) {
        return [];
      } finally {
        if (spaceMembersLoading === spaceName) spaceMembersLoading = '';
      }
    }

    function filterByMentionQuery(list, q) {
      const query = String(q || '').trim().toLowerCase();
      if (!query) return list;
      return (list || []).filter((c) => {
        const hay = `${c.label || ''} ${c.userName || ''} ${c.email || ''} ${c.hint || ''}`.toLowerCase();
        return hay.includes(query);
      });
    }

    async function runMentionSearch(query) {
      mentionQuery = query;
      const q = String(query || '').trim();
      let contacts = [];
      const inGroup = isGroupMentionContext();

      if (inGroup) {
        // 群組：優先／預設只列群組成員（真 @）
        const members = await ensureSpaceMembersLoaded();
        if (mentionQuery !== query) return;
        contacts = filterByMentionQuery(members, q).map((m) => ({
          ...m,
          inSpace: true,
          hint: m.hint || '群組成員'
        }));

        // 有關鍵字時：目錄命中但不在群組 → 僅標籤（不提醒／不邀請）
        if (q) {
          const res = await window.api.gchatSearch?.({ query: q });
          if (mentionQuery !== query) return;
          const memberIds = new Set(members.map((m) => m.userName));
          for (const c of res?.contacts || []) {
            const un = String(c.userName || '').trim();
            if (!un || memberIds.has(un)) continue;
            if (contacts.some((x) => x.userName === un)) continue;
            contacts.push({
              ...c,
              inSpace: false,
              labelOnly: true,
              hint: '僅標籤・不提醒'
            });
            if (contacts.length >= 10) break;
          }
        }
      } else {
        // 私人：通訊錄搜尋
        if (q) {
          const res = await window.api.gchatSearch?.({ query: q });
          if (mentionQuery !== query) return;
          contacts = (res?.contacts || []).map((c) => ({ ...c, inSpace: true }));
        }
        const seen = new Set(contacts.map((c) => c.userName));
        const thread = Array.isArray(window.__popThreadCache) ? window.__popThreadCache : [];
        for (const m of thread) {
          const un = String(m?.senderName || '').trim();
          const label = String(m?.sender || '').trim();
          if (!un || seen.has(un) || m?.isMine) continue;
          if (q && !`${label} ${un}`.toLowerCase().includes(q.toLowerCase())) continue;
          seen.add(un);
          contacts.push({
            kind: 'contact',
            userName: un,
            label: label || un,
            hint: '此對話',
            iconUrl: m.iconUrl || '',
            inSpace: true
          });
          if (contacts.length >= 8) break;
        }
      }

      // @all（群組較有意義；私人也允許）
      if (!q || 'all'.startsWith(q.toLowerCase()) || '全部'.startsWith(q)) {
        contacts.unshift({
          kind: 'contact',
          userName: 'users/all',
          label: '全部成員',
          hint: '@all',
          iconUrl: '',
          inSpace: true
        });
      }
      paintMentionSuggest(contacts.slice(0, 10));
    }

    function onReplyInputForMention() {
      const mctx = getMentionContext();
      if (!mctx) {
        hideMentionSuggest();
        return;
      }
      clearTimeout(mentionTimer);
      mentionTimer = setTimeout(() => runMentionSearch(mctx.query), 160);
    }

    function onReplyKeydownForMention(e) {
      if (tryDeleteAdjacentMention(e)) return;

      const box = document.getElementById('mention-suggest');
      if (!box || box.hidden || !mentionHits.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionActive = (mentionActive + 1) % mentionHits.length;
        box.querySelectorAll('.mention-suggest-item').forEach((el, i) => {
          el.classList.toggle('is-active', i === mentionActive);
        });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionActive = (mentionActive - 1 + mentionHits.length) % mentionHits.length;
        box.querySelectorAll('.mention-suggest-item').forEach((el, i) => {
          el.classList.toggle('is-active', i === mentionActive);
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMentionHit(mentionHits[mentionActive] || mentionHits[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideMentionSuggest();
      }
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = String(reader.result || '');
          const i = raw.indexOf(',');
          resolve(i >= 0 ? raw.slice(i + 1) : raw);
        };
        reader.onerror = () => reject(reader.error || new Error('讀取檔案失敗'));
        reader.readAsDataURL(file);
      });
    }

    function renderAttachPreview() {
      const box = document.getElementById('attach-preview');
      if (!box) return;
      if (!pendingAttachments.length) {
        box.innerHTML = '';
        return;
      }
      box.innerHTML = pendingAttachments.map((f, i) => {
        const thumb = f.previewUrl
          ? `<img src="${escapeHtml(f.previewUrl)}" alt="">`
          : `<span>📎</span>`;
        return `<div class="attach-chip">${thumb}<span title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span><button type="button" data-attach-rm="${i}" title="移除">✕</button></div>`;
      }).join('');
      box.querySelectorAll('[data-attach-rm]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-attach-rm'));
          removeAttachment(idx);
        });
      });
    }

    function removeAttachment(index) {
      const removed = pendingAttachments.splice(index, 1)[0];
      if (removed?.previewUrl) {
        try { URL.revokeObjectURL(removed.previewUrl); } catch (_) {}
      }
      renderAttachPreview();
    }

    async function addAttachment(file) {
      if (!file) return;
      if (pendingAttachments.length >= 5) {
        alert('一次最多附加 5 個檔案');
        return;
      }
      if (file.size > 25 * 1024 * 1024) {
        alert(`檔案太大：${file.name}`);
        return;
      }
      const dataBase64 = await fileToBase64(file);
      const isImage = /^image\//i.test(file.type || '') || /\.(gif|png|jpe?g|webp|bmp)$/i.test(file.name || '');
      pendingAttachments.push({
        name: file.name || `file-${Date.now()}`,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
        previewUrl: isImage ? URL.createObjectURL(file) : ''
      });
      renderAttachPreview();
    }

    function bindComposerAttach() {
      const box = document.getElementById('composer');
      const editor = document.getElementById('reply');
      const input = document.getElementById('attach-input');
      if (!box || !editor || box.dataset.dropBound === '1') return;
      box.dataset.dropBound = '1';
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      ['dragenter', 'dragover'].forEach((ev) => {
        box.addEventListener(ev, (e) => {
          stop(e);
          box.classList.add('is-drop');
        });
      });
      box.addEventListener('dragleave', (e) => {
        if (!box.contains(e.relatedTarget)) box.classList.remove('is-drop');
      });
      box.addEventListener('drop', async (e) => {
        stop(e);
        box.classList.remove('is-drop');
        const files = [...(e.dataTransfer?.files || [])];
        for (const f of files) await addAttachment(f);
      });
      editor.addEventListener('paste', async (e) => {
        const items = [...(e.clipboardData?.items || [])];
        let handled = false;
        for (const it of items) {
          if (it.kind !== 'file') continue;
          const f = it.getAsFile();
          if (!f) continue;
          handled = true;
          await addAttachment(f);
        }
        if (handled) e.preventDefault();
      });
      input?.addEventListener('change', async () => {
        const files = [...(input.files || [])];
        for (const f of files) await addAttachment(f);
        input.value = '';
      });
    }

    /** 討論串分組鍵：thread.name 優先；無 thread 則訊息自身一組 */
    function markOptimisticFailed(bubbleEl, payload, errorText) {
      if (!bubbleEl) return;
      bubbleEl.classList.add('is-failed-optimistic');
      bubbleEl.dataset.failedOptimistic = '1';
      let status = bubbleEl.querySelector('.optimistic-status');
      if (!status) {
        status = document.createElement('div');
        status.className = 'optimistic-status';
        bubbleEl.appendChild(status);
      }
      const id = bubbleEl.dataset.optimisticId || ('opt-' + Date.now());
      bubbleEl.dataset.optimisticId = id;
      failedOptimisticById.set(id, payload);
      status.innerHTML = '<span class="optimistic-error">' + escapeHtml(errorText || '未送出') + '</span>' +
        '<button type="button" class="btn-retry-optimistic" data-optimistic-id="' + escapeHtml(id) + '">重試</button>';
    }

    function clearOptimisticFailed(bubbleEl) {
      if (!bubbleEl) return;
      const id = bubbleEl.dataset.optimisticId;
      if (id) failedOptimisticById.delete(id);
      bubbleEl.classList.remove('is-failed-optimistic');
      bubbleEl.querySelector('.optimistic-status')?.remove();
    }

    async function retryFailedOptimistic(optimisticId) {
      const payload = failedOptimisticById.get(optimisticId);
      const bubbleEl = document.querySelector('.bubble[data-optimistic-id="' + CSS.escape(optimisticId) + '"]');
      if (!payload || !ctx || sending) return;
      sending = true;
      if (bubbleEl) {
        const status = bubbleEl.querySelector('.optimistic-status');
        if (status) status.innerHTML = '<span class="optimistic-pending">重試中…</span>';
      }
      const res = await window.api.gchatReply(payload);
      sending = false;
      if (!res?.success) {
        markOptimisticFailed(bubbleEl, payload, res?.error || '重試失敗');
        return;
      }
      clearOptimisticFailed(bubbleEl);
      clearReplyTarget();
      setTimeout(() => refreshLiveThreadCacheFirst({ force: true }), 400);
      document.getElementById('reply')?.focus();
    }

    document.getElementById('thread')?.addEventListener('click', (e) => {
      const btn = e.target.closest?.('.btn-retry-optimistic');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      retryFailedOptimistic(btn.getAttribute('data-optimistic-id') || '');
    });

    async function send() {
      if (!ctx || sending) return;
      const text = getText();
      const attachments = pendingAttachments.map(a => ({
        name: a.name,
        mimeType: a.mimeType,
        dataBase64: a.dataBase64
      }));
      if (!text && !attachments.length) return;
      sending = true;
      const replyEl = document.getElementById('reply');
      const thread = document.getElementById('thread');
      const nowLabel = new Date().toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const useThread = !!replyTarget?.messageName || isFocusThreadMode;
      const replyThreadName = useThread
        ? (replyTarget?.threadName || replyTarget?.messageName || focusThreadName || ctx.threadName || ctx.name || '')
        : (ctx.threadName || '');
      const replyMessageName = useThread
        ? (replyTarget?.messageName || ctx.name || '')
        : ctx.name;
      const localMedia = pendingAttachments.map(a => ({
        kind: /^image\//i.test(a.mimeType) ? 'image' : 'file',
        name: a.name,
        previewUrl: a.previewUrl || '',
        dataUrl: a.previewUrl || ''
      }));
      const optimisticId = 'opt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      thread.insertAdjacentHTML('beforeend',
        '<div class="thread-step">' +
        '<div class="bubble is-mine" data-optimistic-id="' + optimisticId + '">' +
          '<div class="bubble-top"><div class="who">我 · ' + escapeHtml(nowLabel) + '</div></div>' +
          '<div class="text">' + renderMessageText(text || (attachments.length ? '（附件）' : '')) + '</div>' +
          renderMediaHtml(localMedia) +
        '</div></div>');
      const bubbleEl = thread.querySelector('.bubble[data-optimistic-id="' + CSS.escape(optimisticId) + '"]');
      thread.scrollTop = thread.scrollHeight;
      if (replyEl) replyEl.innerHTML = '';
      const keptPreviews = pendingAttachments.map(a => a.previewUrl).filter(Boolean);
      pendingAttachments = [];
      renderAttachPreview();
      const replyPayload = {
        text,
        spaceName: ctx.spaceName,
        threadName: replyThreadName,
        messageName: replyMessageName,
        createTime: ctx.createTime,
        isDm: !!ctx.isDm,
        spaceType: ctx.spaceType || '',
        spaceDisplayName: ctx.spaceDisplayName || '',
        sender: ctx.sender || '',
        replyInThread: useThread,
        quoteMessageName: replyTarget?.messageName || '',
        quoteLastUpdateTime: replyTarget
          ? (replyTarget.lastUpdateTime || replyTarget.createTime || '')
          : '',
        attachments
      };
      const res = await window.api.gchatReply(replyPayload);
      sending = false;
      keptPreviews.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
      if (!res?.success) {
        // Failed Optimistic Reply：氣泡保留並可重試
        markOptimisticFailed(bubbleEl, replyPayload, res?.error || '未送出');
      } else {
        clearOptimisticFailed(bubbleEl);
        clearReplyTarget();
        setTimeout(() => refreshLiveThreadCacheFirst({ force: true }), 400);
        document.getElementById('reply')?.focus();
      }
    }
