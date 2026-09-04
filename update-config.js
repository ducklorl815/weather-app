/**
 * LifeTour 自動更新來源（Google Cloud Storage）
 *
 * [Manual] 請改成你的公開 GCS 目錄網址（結尾務必有 /）
 * 例：https://storage.googleapis.com/lifetour-releases/
 *
 * Bucket 內需放：
 * - latest.yml（每次發版覆蓋）
 * - LifeTour-Setup-x.x.x.exe（與 latest.yml 同目錄）
 *
 * 更新政策：只「檢查／通知」，下載與安裝必須使用者按確認，不會自動更新。
 */
module.exports = {
  // [Manual] GCP Cloud Storage 公開更新目錄
  updateFeedUrl: 'https://storage.googleapis.com/lifetour-releases/',

  // 啟動後延遲幾毫秒再檢查（避免擋開機）
  checkDelayMs: 5000,

  // [Important] 背景定期再檢查：每 1 小時；僅通知，不會自動下載
  checkIntervalMs: 60 * 60 * 1000
};
