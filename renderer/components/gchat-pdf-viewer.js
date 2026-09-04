/**
 * Google Chat PDF 預覽：將 data:application/pdf 轉成 blob URL，供 iframe / embed 在 Electron 內顯示。
 * 主視窗與 compact reply 泡泡共用。
 */
(function initGchatPdfViewer(global) {
  const blobCache = new Map();

  function isPdfDataUrl(src) {
    const s = String(src || '').trim();
    if (!s.startsWith('data:')) return false;
    return /application\/pdf|\.pdf/i.test(s.slice(0, 80));
  }

  function resolvePdfViewerSrc(rawSrc) {
    const src = String(rawSrc || '').trim();
    if (!src) return '';
    if (src.startsWith('blob:')) return src;
    if (!isPdfDataUrl(src)) return src;

    const cached = blobCache.get(src);
    if (cached) return cached;

    try {
      const comma = src.indexOf(',');
      if (comma < 0) return src;
      const meta = src.slice(0, comma);
      const b64 = src.slice(comma + 1);
      const mimeMatch = /^data:([^;,]+)/i.exec(meta);
      const mime = mimeMatch ? mimeMatch[1] : 'application/pdf';
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      blobCache.set(src, blobUrl);
      return blobUrl;
    } catch (_) {
      return src;
    }
  }

  function appendPdfViewer(container, rawSrc, opts = {}) {
    const viewerSrc = resolvePdfViewerSrc(rawSrc);
    if (!container || !viewerSrc) return false;

    const frame = document.createElement('iframe');
    frame.title = opts.title || 'PDF';
    if (opts.className) frame.className = opts.className;
    frame.src = viewerSrc;
    frame.setAttribute('loading', 'lazy');
    container.appendChild(frame);
    return true;
  }

  function revokeCachedBlobUrls() {
    for (const url of blobCache.values()) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
    blobCache.clear();
  }

  global.GchatPdfViewer = {
    resolvePdfViewerSrc,
    appendPdfViewer,
    revokeCachedBlobUrls
  };
})(typeof window !== 'undefined' ? window : globalThis);
