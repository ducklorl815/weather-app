/**
 * Little Reply 背景同步開發日誌
 * [Development Only] 設 GCHAT_SYNC_LOG=0 可關閉
 */
function gchatSyncLog(tag, detail) {
  if (process.env.GCHAT_SYNC_LOG === '0') return;
  const msg = detail != null ? `${tag} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : tag;
  console.log(`[GCHAT]${msg}`);
}

module.exports = { gchatSyncLog };
