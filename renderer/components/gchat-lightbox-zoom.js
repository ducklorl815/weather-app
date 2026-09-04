/**
 * Lightbox 圖片滾輪縮放：改變 img 實際寬高（非 transform 裁切）
 * 放大後可拖曳平移；供主視窗 gchat-lightbox、泡泡 media-lightbox 共用
 */
(function initGchatLightboxZoom(global) {
  const MIN_SCALE = 1;
  const MAX_SCALE = 6;
  const ZOOM_STEP = 1.12;

  /** @type {(() => void) | null} */
  let activeCleanup = null;

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function attach(bodyEl, imgEl, opts = {}) {
    if (!bodyEl || !imgEl) return null;
    detach();

    const viewport = document.createElement('div');
    viewport.className = 'gchat-lb-zoom-viewport';
    const stage = document.createElement('div');
    stage.className = 'gchat-lb-zoom-stage';
    imgEl.classList.add('gchat-lb-zoom-img');

    let baseW = 0;
    let baseH = 0;
    let scale = 1;
    let dragging = false;
    let dragPointerId = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let scrollStartX = 0;
    let scrollStartY = 0;

    function notifyScale() {
      if (opts.onScaleChange) opts.onScaleChange(scale);
    }

    function measureBase() {
      const inner = bodyEl.closest('.gchat-lb-inner');
      const vpW = viewport.clientWidth
        || inner?.clientWidth
        || Math.min(window.innerWidth * 0.8, window.innerWidth);
      const vpH = viewport.clientHeight
        || inner?.clientHeight
        || Math.min(window.innerHeight * 0.8, window.innerHeight);
      const maxW = Math.max(200, vpW - 8);
      const maxH = Math.max(160, vpH - 8);
      const nw = imgEl.naturalWidth || 0;
      const nh = imgEl.naturalHeight || 0;
      if (!nw || !nh) {
        baseW = maxW;
        baseH = maxH;
        return;
      }
      const fit = Math.min(1, maxW / nw, maxH / nh);
      baseW = Math.max(1, nw * fit);
      baseH = Math.max(1, nh * fit);
    }

    function updateStageSize() {
      const vpW = Math.max(1, viewport.clientWidth || 0);
      const vpH = Math.max(1, viewport.clientHeight || 0);
      const w = Math.round(baseW * scale);
      const h = Math.round(baseH * scale);
      stage.style.width = `${Math.max(vpW, w)}px`;
      stage.style.height = `${Math.max(vpH, h)}px`;
    }

    function applyImageSize() {
      const w = Math.round(baseW * scale);
      const h = Math.round(baseH * scale);
      imgEl.style.width = `${w}px`;
      imgEl.style.height = `${h}px`;
      imgEl.style.maxWidth = 'none';
      imgEl.style.maxHeight = 'none';
      updateStageSize();
      viewport.classList.toggle('is-pannable', scale > MIN_SCALE + 0.001);
      notifyScale();
    }

    function resetView() {
      scale = 1;
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
      applyImageSize();
    }

    function initLayout() {
      measureBase();
      resetView();
    }

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      dragPointerId = null;
      viewport.classList.remove('is-dragging');
    }

    const onWheel = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!baseW || !baseH) initLayout();

      const prevScale = scale;
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      scale = clamp(scale * factor, MIN_SCALE, MAX_SCALE);

      const rect = viewport.getBoundingClientRect();
      const offsetX = event.clientX - rect.left + viewport.scrollLeft;
      const offsetY = event.clientY - rect.top + viewport.scrollTop;
      const ratio = scale / prevScale;

      applyImageSize();

      if (scale <= MIN_SCALE + 0.001) {
        viewport.scrollLeft = 0;
        viewport.scrollTop = 0;
        return;
      }

      viewport.scrollLeft = offsetX * ratio - (event.clientX - rect.left);
      viewport.scrollTop = offsetY * ratio - (event.clientY - rect.top);
    };

    const onPointerDown = (event) => {
      if (scale <= MIN_SCALE + 0.001) return;
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      dragging = true;
      dragPointerId = event.pointerId;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      scrollStartX = viewport.scrollLeft;
      scrollStartY = viewport.scrollTop;
      viewport.classList.add('is-dragging');
      try { viewport.setPointerCapture(event.pointerId); } catch (_) {}
      event.preventDefault();
    };

    const onPointerMove = (event) => {
      if (!dragging || event.pointerId !== dragPointerId) return;
      viewport.scrollLeft = scrollStartX - (event.clientX - dragStartX);
      viewport.scrollTop = scrollStartY - (event.clientY - dragStartY);
      event.preventDefault();
    };

    const onPointerUp = (event) => {
      if (!dragging || event.pointerId !== dragPointerId) return;
      endDrag();
      try { viewport.releasePointerCapture(event.pointerId); } catch (_) {}
    };

    const onLoad = () => initLayout();
    imgEl.addEventListener('load', onLoad);

    stage.appendChild(imgEl);
    viewport.appendChild(stage);
    bodyEl.innerHTML = '';
    bodyEl.appendChild(viewport);

    if (imgEl.complete) {
      requestAnimationFrame(initLayout);
    }

    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);
    viewport.addEventListener('lostpointercapture', endDrag);

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (scale <= MIN_SCALE + 0.001) initLayout();
        else updateStageSize();
      });
      resizeObserver.observe(viewport);
      if (bodyEl.parentElement) resizeObserver.observe(bodyEl.parentElement);
    }

    activeCleanup = () => {
      endDrag();
      imgEl.removeEventListener('load', onLoad);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', onPointerUp);
      viewport.removeEventListener('pointercancel', onPointerUp);
      viewport.removeEventListener('lostpointercapture', endDrag);
      resizeObserver?.disconnect?.();
      resizeObserver = null;
      activeCleanup = null;
    };
    return activeCleanup;
  }

  function detach() {
    if (activeCleanup) activeCleanup();
  }

  global.GchatLightboxZoom = { attach, detach, MIN_SCALE, MAX_SCALE };
})(typeof window !== 'undefined' ? window : globalThis);
