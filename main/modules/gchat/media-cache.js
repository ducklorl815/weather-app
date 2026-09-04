/**
 * GChat 媒體本機快取 — 避免每次開啟對話都重複 media.download
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * @param {{
 *   getUserDataPath: () => string,
 *   log?: (msg: string, detail?: string) => void
 * }} deps
 */
function createGchatMediaCache(deps) {
  const inflight = new Map();

  function mediaDir() {
    const dir = path.join(deps.getUserDataPath(), 'gchat_media_cache');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function cacheKey(resourceName) {
    return crypto.createHash('sha256').update(String(resourceName || '')).digest('hex').slice(0, 40);
  }

  function cachePaths(resourceName) {
    const key = cacheKey(resourceName);
    const dir = mediaDir();
    return {
      data: path.join(dir, `${key}.bin`),
      meta: path.join(dir, `${key}.json`)
    };
  }

  function read(resourceName) {
    const name = String(resourceName || '').trim();
    if (!name) return null;
    const { data, meta } = cachePaths(name);
    if (!fs.existsSync(data)) return null;
    try {
      const buf = fs.readFileSync(data);
      if (!buf.length) return null;
      let mime = 'application/octet-stream';
      if (fs.existsSync(meta)) {
        const parsed = JSON.parse(fs.readFileSync(meta, 'utf8'));
        if (parsed?.mime) mime = parsed.mime;
      }
      deps.log?.('[MediaCache] hit', name.slice(-32));
      return { buf, mime };
    } catch (_) {
      return null;
    }
  }

  function write(resourceName, buf, mime) {
    const name = String(resourceName || '').trim();
    if (!name || !buf?.length) return;
    const { data, meta } = cachePaths(name);
    try {
      fs.writeFileSync(data, buf);
      fs.writeFileSync(meta, JSON.stringify({
        resourceName: name.slice(-160),
        mime: mime || 'application/octet-stream',
        savedAt: Date.now(),
        size: buf.length
      }));
      deps.log?.('[MediaCache] saved', name.slice(-32));
    } catch (err) {
      deps.log?.('[MediaCache] write failed', err.message);
    }
  }

  /**
   * 讀快取 → 否則下載（同 resourceName 併發只打一次 API）
   * @param {string} resourceName
   * @param {() => Promise<Buffer|null|undefined>} downloadFn
   * @param {string} [contentType]
   */
  async function getOrDownload(resourceName, downloadFn, contentType = '') {
    const name = String(resourceName || '').trim();
    if (!name) return null;

    const cached = read(name);
    if (cached?.buf?.length) return cached.buf;

    if (inflight.has(name)) return inflight.get(name);

    const job = (async () => {
      try {
        const buf = await downloadFn();
        if (buf?.length) write(name, buf, contentType);
        return buf?.length ? buf : null;
      } finally {
        inflight.delete(name);
      }
    })();

    inflight.set(name, job);
    return job;
  }

  return { read, write, getOrDownload, mediaDir };
}

module.exports = { createGchatMediaCache };
