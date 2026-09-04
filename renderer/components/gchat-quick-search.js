/**
 * Little Reply 浮動快速搜尋：姓名、分機、群組
 * 供 gchat-reply-pop、gchat-reply-bar、浮動視窗共用。
 */
(function initGchatQuickSearch(global) {
  const SEARCH_DEBOUNCE_MS = 280;
  const PANEL_WIDTH = 320;
  const STYLE_ID = 'gchat-quick-search-styles';

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const GchatQuickSearch = {
    _root: null,
    _panel: null,
    _input: null,
    _results: null,
    _timer: null,
    _seq: 0,
    _open: false,
    _onOpenContact: null,
    _onOpenSpace: null,
    _keydownBound: false,
    _useFloatingWindow: false,
    _themeBound: false,
    _picking: false,

    init(opts = {}) {
      this._onOpenContact = typeof opts.onOpenContact === 'function' ? opts.onOpenContact : null;
      this._onOpenSpace = typeof opts.onOpenSpace === 'function' ? opts.onOpenSpace : null;
      this._useFloatingWindow = !!opts.useFloatingWindow;
      this.injectStyles();
      this.bindThemeSync();
      this._bindGlobalKeys();
      if (opts.listenIpc !== false && global.api?.onGchatQuickSearchOpen) {
        global.api.onGchatQuickSearchOpen(() => {
          if (this._useFloatingWindow) {
            this.toggle();
            return;
          }
          if (this._open) {
            this._input?.focus();
            this._input?.select();
            return;
          }
          this.open();
        });
      }
    },

    injectStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const marker = document.createElement('meta');
      marker.id = STYLE_ID;
      document.head.appendChild(marker);
      // 主視窗已有 shell.css；Little Reply 泡泡已有內嵌主題 — 不重複載入
      const hasHostTheme = !!document.querySelector('link[href*="shell.css"]')
        || !!document.getElementById('thread');
      if (!hasHostTheme && !document.querySelector('link[data-gchat-qs="gchat-theme-vars.css"]')) {
        const themeLink = document.createElement('link');
        themeLink.rel = 'stylesheet';
        themeLink.href = 'renderer/components/gchat-theme-vars.css';
        themeLink.dataset.gchatQs = 'gchat-theme-vars.css';
        document.head.appendChild(themeLink);
      }
      if (!document.querySelector('link[data-gchat-qs="gchat-quick-search.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'renderer/components/gchat-quick-search.css';
        link.dataset.gchatQs = 'gchat-quick-search.css';
        document.head.appendChild(link);
      }
    },

    bindThemeSync() {
      if (this._themeBound || !global.document?.documentElement) return;
      this._themeBound = true;
      const apply = (theme) => {
        document.documentElement.setAttribute('data-theme', theme || 'light');
      };
      global.api?.onAppTheme?.(apply);
      global.api?.getAppTheme?.()
        .then((res) => { if (res?.theme) apply(res.theme); })
        .catch(() => {});
    },

    _bindGlobalKeys() {
      if (this._keydownBound) return;
      this._keydownBound = true;
      document.addEventListener('keydown', (e) => {
        if (!this._open) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        }
      }, true);
    },

    _ensureDom() {
      if (this._root) return;
      const root = document.createElement('div');
      root.className = 'gchat-qs-root';
      root.hidden = true;
      root.innerHTML = `
        <div class="gchat-qs-panel" role="dialog" aria-label="快速搜尋">
          <input type="search" class="gchat-qs-input" placeholder="搜尋姓名、分機、群組…" autocomplete="off" spellcheck="false">
          <div class="gchat-qs-results"></div>
        </div>`;
      document.body.appendChild(root);
      this._root = root;
      this._panel = root.querySelector('.gchat-qs-panel');
      this._input = root.querySelector('.gchat-qs-input');
      this._results = root.querySelector('.gchat-qs-results');

      root.addEventListener('mousedown', (e) => {
        if (e.target === root) this.close();
      });
      this._bindResultsWheel(this._results);
      this._input.addEventListener('input', () => this._onInput());
      this._input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = this._results.querySelector('.gchat-qs-item');
          if (first) this._pick(first);
        }
      });
    },

    async toggle() {
      if (this._useFloatingWindow) {
        await global.api?.gchatQuickSearchShow?.();
        return;
      }
      if (this._open) {
        this.close();
        return;
      }
      await this.open();
    },

    _bindResultsWheel(el) {
      if (!el || el._gchatQsWheelBound) return;
      el._gchatQsWheelBound = true;
      el.addEventListener('wheel', (e) => {
        if (el.scrollHeight <= el.clientHeight + 1) return;
        el.scrollTop += e.deltaY;
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });
    },

    mountInline(hostEl) {
      this._ensureDom();
      this._root.classList.add('is-inline');
      this._root.hidden = false;
      hostEl.appendChild(this._root);
      this._open = true;
      this._input.focus();
    },

    async open() {
      this._ensureDom();
      let x;
      let y;
      try {
        const pt = await global.api?.getCursorPoint?.();
        if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
          x = pt.x - window.screenX;
          y = pt.y - window.screenY + 14;
        }
      } catch (_) {}
      if (!Number.isFinite(x)) {
        x = Math.max(8, (window.innerWidth - PANEL_WIDTH) / 2);
        y = 72;
      }
      const maxX = Math.max(8, window.innerWidth - PANEL_WIDTH - 8);
      const maxY = Math.max(8, window.innerHeight - 120);
      x = Math.min(Math.max(8, x), maxX);
      y = Math.min(Math.max(8, y), maxY);
      const panelH = Math.min(420, Math.max(280, Math.round(window.innerHeight * 0.72)));
      this._panel.style.left = `${x}px`;
      this._panel.style.top = `${y}px`;
      this._panel.style.height = `${panelH}px`;
      this._panel.style.maxHeight = `${panelH}px`;
      this._open = true;
      this._root.hidden = false;
      this._input.value = '';
      this._results.innerHTML = '';
      this._input.focus();
      this._input.select();
    },

    close() {
      this._open = false;
      clearTimeout(this._timer);
      if (this._root) this._root.hidden = true;
    },

    _onInput() {
      const q = String(this._input?.value || '').trim();
      clearTimeout(this._timer);
      if (!q) {
        if (this._results) this._results.innerHTML = '';
        return;
      }
      this._timer = setTimeout(() => this.runSearch(q), SEARCH_DEBOUNCE_MS);
    },

    async runSearch(query) {
      const seq = ++this._seq;
      if (!this._results) return;
      this._results.innerHTML = `<div class="gchat-qs-empty">搜尋中…</div>`;
      const res = await global.api?.gchatSearch?.({ query });
      if (seq !== this._seq || !this._open) return;
      if (!res?.success) {
        this._results.innerHTML = `<div class="gchat-qs-empty">${escapeHtml(res?.error || '搜尋失敗')}</div>`;
        return;
      }
      const contacts = res.contacts || [];
      const spaces = res.spaces || [];
      if (!contacts.length && !spaces.length) {
        this._results.innerHTML = `<div class="gchat-qs-empty">找不到「${escapeHtml(query)}」</div>`;
        return;
      }
      let html = '';
      if (contacts.length) {
        html += `<div class="gchat-qs-sec">聯絡人</div>`;
        html += contacts.map((c) => this._renderItem(c, 'contact')).join('');
      }
      if (spaces.length) {
        html += `<div class="gchat-qs-sec">群組／空間</div>`;
        html += spaces.map((s) => this._renderItem(s, 'space')).join('');
      }
      this._results.innerHTML = html;
      this._results.querySelectorAll('.gchat-qs-item').forEach((el) => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._pick(el);
        });
      });
    },

    _renderItem(item, kind) {
      const label = escapeHtml(item.label || item.userName || item.spaceName || '未命名');
      const hint = escapeHtml(item.hint || item.email || (item.isDm ? '私人' : (kind === 'space' ? '群組' : '聯絡人')));
      const payload = encodeURIComponent(JSON.stringify({ kind, item }));
      return `
        <div class="gchat-qs-item" data-payload="${payload}">
          <div class="gchat-qs-main">
            <div class="gchat-qs-label">${label}</div>
            <div class="gchat-qs-hint">${hint}</div>
          </div>
        </div>`;
    },

    async _pick(el) {
      if (this._picking) return;
      let data;
      try {
        data = JSON.parse(decodeURIComponent(el.dataset.payload || ''));
      } catch (_) {
        return;
      }
      const { kind, item } = data || {};
      if (!item) return;
      this._picking = true;
      this.close();
      try {
        if (kind === 'contact' && this._onOpenContact) {
          await this._onOpenContact(item);
        } else if (kind === 'space' && this._onOpenSpace) {
          await this._onOpenSpace(item);
        }
      } catch (err) {
        global.alert?.(err?.message || '無法開啟對話');
      } finally {
        this._picking = false;
        try { await global.api?.gchatQuickSearchHide?.(); } catch (_) {}
      }
    }
  };

  /** 泡泡／最小化 bar 共用：開啟聯絡人或群組（先開窗，歷史由泡泡背景載入） */
  async function openCompactFromSearchItem(item, kind) {
    const isContact = kind === 'contact';
    const payload = isContact
      ? {
          userName: item.userName,
          label: item.label || item.userName,
          isDm: true,
          spaceName: item.spaceName || undefined,
          deferHistory: true
        }
      : {
          spaceName: item.spaceName,
          label: item.label || item.spaceName,
          spaceType: item.spaceType || '',
          isDm: !!item.isDm,
          deferHistory: true
        };
    const res = await global.api?.gchatOpenSpace?.(payload);
    if (!res?.success) {
      global.alert?.(res?.error || '無法開啟對話');
      return;
    }
    const detail = res.detail || {};
    const openRes = await global.api?.gchatCompactOpen?.({
      messageName: detail.name || '',
      spaceName: detail.spaceName || item.spaceName || '',
      isDm: isContact || !!item.isDm,
      title: item.label || detail.spaceDisplayName || detail.sender || '',
      userName: isContact ? (item.userName || '') : ''
    });
    if (openRes?.success === false) {
      global.alert?.(openRes?.error || '無法開啟對話');
    }
  }

  GchatQuickSearch.openCompactFromSearchItem = openCompactFromSearchItem;
  global.GchatQuickSearch = GchatQuickSearch;
})(typeof window !== 'undefined' ? window : global);
