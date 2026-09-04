/**
 * ============================================================================
 * Feature Logic: 網站瀏覽紀錄 (sitesVisits)
 * ----------------------------------------------------------------------------
 * [TODO] 將 renderer/shell/app.js 中與此功能相關的函式逐步搬移到本檔。
 * 目前邏輯仍由 shell/app.js 提供（全域函式），本檔先保留組織入口。
 *
 * 掛載：WIDGET_CATALOG['sitesVisits'].mount → loadSitesVisits
 * Partial：view.html
 * Main：main/modules/sites-visits.js
 * ============================================================================
 */
(function () {
  // [Temporary] 佔位：避免未來 script 標籤 404；實作下沉後刪除此註解區塊。
  window.__featureReady = window.__featureReady || {};
  window.__featureReady['sitesVisits'] = true;
})();
