/**
 * 分頁表情選擇器（反應用）；無搜尋，11 類 + 自訂
 */
(function (global) {
  const FREQ_KEY = 'gchat-emoji-freq-v2';
  const LEGACY_FREQ_KEY = 'gchat-react-freq-v1';
  const PANEL_WIDTH = 420;
  const PANEL_HEIGHT = 480;
  const GRID_COLUMNS = 9;

  function loadFreqMap() {
    try {
      const raw = JSON.parse(localStorage.getItem(FREQ_KEY) || '{}');
      if (raw && typeof raw === 'object' && Object.keys(raw).length) return raw;
      const legacy = JSON.parse(localStorage.getItem(LEGACY_FREQ_KEY) || '{}');
      if (!legacy || typeof legacy !== 'object') return {};
      const next = {};
      for (const [k, v] of Object.entries(legacy)) {
        next[k] = { count: Number(v) || 0, lastAt: 0 };
      }
      return next;
    } catch (_) {
      return {};
    }
  }

  function saveFreqMap(map) {
    try { localStorage.setItem(FREQ_KEY, JSON.stringify(map)); } catch (_) {}
  }

  function bumpFreq(reactionKey) {
    const key = String(reactionKey || '').trim();
    if (!key) return;
    const map = loadFreqMap();
    const prev = map[key] || { count: 0, lastAt: 0 };
    map[key] = { count: (Number(prev.count) || 0) + 1, lastAt: Date.now() };
    saveFreqMap(map);
  }

  function buildRecentList(freq, customByUid) {
    const keys = Object.keys(freq || {});
    return keys
      .sort((a, b) => {
        const fa = freq[a] || {};
        const fb = freq[b] || {};
        const diff = (Number(fb.count) || 0) - (Number(fa.count) || 0);
        if (diff !== 0) return diff;
        return (Number(fb.lastAt) || 0) - (Number(fa.lastAt) || 0);
      })
      .filter((k) => {
        if (!k.startsWith('custom:')) return true;
        const uid = k.slice(7);
        return customByUid?.[uid]?.imageUrl;
      })
      .slice(0, 56);
  }

  let panelEl = null;
  let tabsEl = null;
  let gridEl = null;
  let titleEl = null;
  let activeTab = 'recent';
  let customEmojis = [];
  let customByUid = {};
  let customEmptyHint = '';
  let loadCustomFn = null;

  function applyCustomEmojiResult(result) {
    const list = Array.isArray(result) ? result : (result?.emojis || []);
    customEmptyHint = Array.isArray(result) ? '' : String(result?.warning || result?.error || '').trim();
    customEmojis = Array.isArray(list) ? list : [];
    customByUid = {};
    for (const e of customEmojis) {
      if (e?.uid) customByUid[e.uid] = e;
    }
    if (activeTab === 'custom' || activeTab === 'recent') paintGrid();
  }
  let onPick = null;
  let anchorBtn = null;
  let outsideBound = false;

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function encodeUnicodeAttr(value) {
    return encodeURIComponent(String(value || ''));
  }

  function readUnicodeFromCell(btn) {
    if (!btn) return '';
    let raw = btn.getAttribute('data-unicode') || '';
    try { raw = decodeURIComponent(raw); } catch (_) {}
    return String(raw).normalize('NFC');
  }

  function renderTabIcon(tab) {
    const name = String(tab?.icon || '').trim();
    if (/^[a-z0-9_]+$/.test(name)) {
      return `<span class="material-symbols-outlined gchat-emoji-tab-icon" aria-hidden="true">${escapeHtml(name)}</span>`;
    }
    return escapeHtml(name);
  }

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'gchat-emoji-panel';
    panelEl.style.setProperty('--gchat-emoji-cols', String(GRID_COLUMNS));
    panelEl.innerHTML = `
      <div class="gchat-emoji-panel-head">
        <span class="gchat-emoji-panel-title"></span>
      </div>
      <div class="gchat-emoji-tabs"></div>
      <div class="gchat-emoji-grid"></div>
    `;
    titleEl = panelEl.querySelector('.gchat-emoji-panel-title');
    tabsEl = panelEl.querySelector('.gchat-emoji-tabs');
    gridEl = panelEl.querySelector('.gchat-emoji-grid');
    document.body.appendChild(panelEl);

    const catalog = global.GchatEmojiCatalog;
    if (catalog?.TABS) {
      tabsEl.innerHTML = catalog.TABS.map((t) =>
        `<button type="button" class="gchat-emoji-tab" data-tab="${escapeHtml(t.id)}" title="${escapeHtml(t.label)}" aria-label="${escapeHtml(t.label)}">${renderTabIcon(t)}</button>`
      ).join('');
      tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.gchat-emoji-tab');
        if (!btn) return;
        e.stopPropagation();
        setTab(btn.dataset.tab || 'recent');
      });
    }

    gridEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.gchat-emoji-cell');
      if (!btn) return;
      e.stopPropagation();
      const customUid = String(btn.dataset.customUid || '').trim();
      const unicode = customUid ? '' : readUnicodeFromCell(btn);
      const reactionKey = customUid ? `custom:${customUid}` : unicode;
      if (!reactionKey) return;
      bumpFreq(reactionKey);
      if (onPick) onPick({ unicode, customUid, reactionKey });
      close();
    });

    return panelEl;
  }

  function setTab(tabId) {
    activeTab = tabId || 'recent';
    tabsEl?.querySelectorAll('.gchat-emoji-tab').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.tab === activeTab);
    });
    const catalog = global.GchatEmojiCatalog;
    const tabMeta = catalog?.TABS?.find((t) => t.id === activeTab);
    if (titleEl) titleEl.textContent = tabMeta?.label || '';
    if (activeTab === 'custom' && loadCustomFn) {
      const missingImage = !(customEmojis || []).some((e) => e?.imageUrl);
      if (missingImage) {
        loadCustomFn({ force: true }).then(applyCustomEmojiResult).catch(() => {});
      }
    }
    paintGrid();
  }

  function paintGrid() {
    if (!gridEl) return;
    const catalog = global.GchatEmojiCatalog;
    const freq = loadFreqMap();
    let cells = [];

    if (activeTab === 'recent') {
      const recent = buildRecentList(freq, customByUid);
      cells = recent.map((key) => {
        if (key.startsWith('custom:')) {
          const uid = key.slice(7);
          const e = customByUid[uid];
          if (!e?.imageUrl) return '';
          return `<button type="button" class="gchat-emoji-cell" data-custom-uid="${escapeHtml(uid)}" title="${escapeHtml(e.emojiName || uid)}"><img src="${escapeHtml(e.imageUrl)}" alt="" /></button>`;
        }
        return `<button type="button" class="gchat-emoji-cell" data-unicode="${encodeUnicodeAttr(key)}" title="${escapeHtml(key)}">${escapeHtml(key)}</button>`;
      }).filter(Boolean);
      if (!cells.length) {
        gridEl.innerHTML = '<div class="gchat-emoji-empty">尚無使用紀錄</div>';
        return;
      }
    } else if (activeTab === 'custom') {
      cells = (customEmojis || []).map((e) => {
        if (!e?.uid) return '';
        const title = escapeHtml(e.emojiName || e.uid);
        if (e.imageUrl) {
          return `<button type="button" class="gchat-emoji-cell" data-custom-uid="${escapeHtml(e.uid)}" title="${title}"><img src="${escapeHtml(e.imageUrl)}" alt="" /></button>`;
        }
        return `<button type="button" class="gchat-emoji-cell gchat-emoji-cell--text" data-custom-uid="${escapeHtml(e.uid)}" title="${title}">${title}</button>`;
      }).filter(Boolean);
      if (!cells.length) {
        const hint = customEmptyHint || '自訂表情圖片下載中（配額用盡時會先顯示名稱）';
        gridEl.innerHTML = `<div class="gchat-emoji-empty">${escapeHtml(hint)}</div>`;
        return;
      }
    } else if (catalog && catalog[activeTab]) {
      cells = catalog[activeTab].map((u) =>
        `<button type="button" class="gchat-emoji-cell" data-unicode="${encodeUnicodeAttr(u)}" title="${escapeHtml(u)}">${escapeHtml(u)}</button>`
      );
    }

    gridEl.innerHTML = cells.join('');
  }

  function positionPanel(anchor) {
    if (!panelEl || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const pw = Math.min(PANEL_WIDTH, window.innerWidth - 16);
    const ph = Math.min(PANEL_HEIGHT, window.innerHeight - 16);
    let left = rect.left + rect.width / 2 - pw / 2;
    let top = rect.top - ph - 10;
    if (top < 8) top = rect.bottom + 10;
    if (top + ph > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - ph - 8);
    }
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    panelEl.style.width = `${pw}px`;
    panelEl.style.height = `${ph}px`;
    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;
  }

  function bindOutside() {
    if (outsideBound) return;
    outsideBound = true;
    document.addEventListener('mousedown', (e) => {
      if (!panelEl?.classList.contains('is-open')) return;
      if (panelEl.contains(e.target) || anchorBtn?.contains(e.target)) return;
      close();
    }, true);
    window.addEventListener('resize', () => {
      if (panelEl?.classList.contains('is-open') && anchorBtn) positionPanel(anchorBtn);
    });
  }

  function open(anchor, options = {}) {
    const catalog = global.GchatEmojiCatalog;
    if (!catalog) return;
    ensurePanel();
    bindOutside();
    anchorBtn = anchor;
    onPick = options.onPick || null;
    panelEl.classList.add('is-open');
    positionPanel(anchor);
    setTab(options.initialTab || 'recent');

    loadCustomFn = options.loadCustom || null;
    if (options.loadCustom) {
      options.loadCustom().then(applyCustomEmojiResult).catch(() => {});
    }
  }

  function close() {
    if (panelEl) panelEl.classList.remove('is-open');
    anchorBtn = null;
    onPick = null;
  }

  function isOpen() {
    return !!(panelEl && panelEl.classList.contains('is-open'));
  }

  global.GchatEmojiPicker = {
    FREQ_KEY,
    open,
    close,
    isOpen,
    bumpFreq,
    loadFreqMap
  };
})(typeof window !== 'undefined' ? window : globalThis);
