/**
 * ============================================================================
 * Partial View Loader（Shell 組件）
 * ----------------------------------------------------------------------------
 * [Important] 「＋加入功能」時，由此載入各 feature 的 view.html，
 * 不要再把 widget HTML 內嵌在巨型 index.html。
 *
 * 載入路徑：renderer/features/<type>/view.html
 * 優先 fetch；失敗則走 main process IPC（打包／file 協議較穩）。
 * ============================================================================
 */
(function (global) {
  const cache = Object.create(null);
  const loading = Object.create(null);

  function partialUrl(type) {
    return new URL(`renderer/features/${type}/view.html`, document.baseURI).href;
  }

  async function loadViaFetch(type) {
    const res = await fetch(partialUrl(type));
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return (await res.text()).trim();
  }

  async function loadViaIpc(type) {
    if (!global.api?.loadFeaturePartial) throw new Error('IPC loadFeaturePartial 不可用');
    const res = await global.api.loadFeaturePartial(type);
    if (!res?.success) throw new Error(res?.error || 'IPC 載入失敗');
    return String(res.html || '').trim();
  }

  /**
   * 取得 widget body HTML（有快取）。
   * @param {string} type WIDGET_CATALOG key
   * @returns {Promise<string>}
   */
  async function loadFeaturePartial(type) {
    if (cache[type]) return cache[type];
    if (loading[type]) return loading[type];
    loading[type] = (async () => {
      let html = '';
      try {
        html = await loadViaFetch(type);
      } catch (fetchErr) {
        try {
          html = await loadViaIpc(type);
        } catch (ipcErr) {
          throw new Error(
            `無法載入功能畫面：${type}（fetch: ${fetchErr.message}; ipc: ${ipcErr.message}）`
          );
        }
      }
      cache[type] = html;
      delete loading[type];
      return cache[type];
    })();
    return loading[type];
  }

  /** 預載目前已在 mosaic 的功能，加快啟動 */
  async function preloadPartials(types) {
    await Promise.all((types || []).map((t) => loadFeaturePartial(t).catch(() => null)));
  }

  global.PartialViews = {
    load: loadFeaturePartial,
    preload: preloadPartials,
    cache
  };
})(window);
