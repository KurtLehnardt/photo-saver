// FrameFlow Content Script for icloud.com/photos
// Single-script: scrapes thumbnails, optionally loads hi-res via detail view.

(function() {
  'use strict';

  console.log('[FrameFlow] Content script loaded on', window.location.href);
  if (window !== window.top) return; // only run in top frame

  // ===== State =====
  const collectedUrls = new Set();
  const seenBlobUrls = new Set();
  const brokenUrls = new Set();
  let photoUrls = [];
  let isRunning = false, isPaused = false, isScrolling = false;
  let settings = {
    shuffle: true, transition: 'fade', fill: 'contain',
    kenBurns: true, duration: 8, targetPhotos: 500, hiRes: false
  };
  let slideTimer = null, controlsTimer = null, scrollTimer = null;
  let currentIndex = -1, shuffledOrder = [], shuffleIndex = 0;
  let activeLayer = 'a';
  let viewHistory = [], historyPos = -1;

  // ===== Hi-Res Cache =====
  // Maps photoUrls index → { url: blob URL, ts: timestamp }
  const hiResCache = new Map();
  const CACHE_SIZE = 12; // keep 10 + current + prefetch
  let prefetchingIdx = -1;

  function cacheSet(idx, blobUrl) {
    hiResCache.set(idx, { url: blobUrl, ts: Date.now() });
    // Evict oldest beyond CACHE_SIZE
    if (hiResCache.size > CACHE_SIZE) {
      let oldestKey = -1, oldestTs = Infinity;
      for (const [k, v] of hiResCache) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
      }
      if (oldestKey >= 0) {
        const old = hiResCache.get(oldestKey);
        if (old && old.url.startsWith('blob:')) URL.revokeObjectURL(old.url);
        hiResCache.delete(oldestKey);
      }
    }
  }

  function cacheGet(idx) {
    const entry = hiResCache.get(idx);
    if (entry) { entry.ts = Date.now(); return entry.url; } // touch on access
    return null;
  }

  function saveExtSettings() {
    chrome.storage.local.set({ frameflow_settings: settings });
  }

  // ===== Canvas capture =====
  const captureCanvas = document.createElement('canvas');
  const captureCtx = captureCanvas.getContext('2d');

  function captureImage(img, maxDim) {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (w < 50 || h < 50) return null;
      const cap = maxDim || 4096;
      let dw = w, dh = h;
      if (w > cap || h > cap) {
        const s = cap / Math.max(w, h);
        dw = Math.round(w * s); dh = Math.round(h * s);
      }
      captureCanvas.width = dw; captureCanvas.height = dh;
      captureCtx.drawImage(img, 0, 0, dw, dh);
      return new Promise(resolve => {
        captureCanvas.toBlob(b => resolve(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.95);
      });
    } catch (e) { return null; }
  }

  // ===== Scraping (thumbnails) =====
  const EXCLUDE = [/\.svg/i, /sprite/i, /favicon/i, /emoji/i, /apple-touch-icon/i];
  function isExcluded(url) {
    if (!url || url.length < 20 || url.startsWith('data:')) return true;
    for (const p of EXCLUDE) if (p.test(url)) return true;
    return false;
  }

  async function scrapeAll() {
    const before = collectedUrls.size;
    const docs = [document];
    document.querySelectorAll('iframe').forEach(f => {
      try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {}
    });

    for (const doc of docs) {
      for (const img of doc.querySelectorAll('img')) {
        const src = img.src || '';
        if (src.startsWith('blob:')) {
          if (seenBlobUrls.has(src) || !img.complete || img.naturalWidth < 50 || img.naturalHeight < 50) continue;
          seenBlobUrls.add(src);
          try { const c = await captureImage(img, 2048); if (c) collectedUrls.add(c); } catch (e) {}
        } else {
          if (isExcluded(src) || (img.naturalWidth > 0 && img.naturalWidth < 50)) continue;
          collectedUrls.add(src);
        }
      }
      doc.querySelectorAll('[style*="url"]').forEach(el => {
        const m = (el.getAttribute('style') || '').match(/url\(["']?([^"')]+)["']?\)/);
        if (m && m[1] && !isExcluded(m[1]) && !m[1].startsWith('blob:')) {
          const r = el.getBoundingClientRect();
          if (r.width >= 50 && r.height >= 50) collectedUrls.add(m[1]);
        }
      });
    }

    const added = collectedUrls.size - before;
    if (added > 0) {
      photoUrls = Array.from(collectedUrls);
      console.log('[FrameFlow] +' + added + ' photos (total: ' + photoUrls.length + ')');
    }
    return added;
  }

  // ===== Hi-Res: Automated click + screenshot approach =====
  // Uses chrome.debugger via background script for:
  // 1. Real mouse clicks (to open photo detail view)
  // 2. Real keyboard events (to navigate between photos)
  // 3. Tab screenshots (to capture the full-res rendered photo)

  function sendMessage(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, response => {
        if (chrome.runtime.lastError) {
          console.warn('[FrameFlow] sendMessage error:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });
  }

  async function captureScreenshot() {
    const resp = await sendMessage({ type: 'CAPTURE_TAB' });
    return resp ? resp.dataUrl : null;
  }

  async function sendRealKey(key) {
    return sendMessage({ type: 'SEND_KEY', key });
  }

  async function sendRealClick(x, y) {
    return sendMessage({ type: 'CLICK_AT', x, y });
  }

  async function loadHiResPhotos(target, onProgress, onDone) {
    const maxTarget = target || 10;
    console.log('[FrameFlow] Hi-res mode: target', maxTarget, 'photos');
    const overlay = document.getElementById('frameflow-overlay');

    // Hide our overlay so iCloud is visible for screenshots
    if (overlay) overlay.style.display = 'none';
    await new Promise(r => setTimeout(r, 500));

    // Find the first photo thumbnail and click it via debugger
    // Look for img elements and get their screen coordinates
    let clickTarget = null;
    const allImgs = document.querySelectorAll('img');
    for (const img of allImgs) {
      if (img.naturalWidth < 30 || img.naturalHeight < 30) continue;
      const src = img.src || '';
      if (!src.startsWith('blob:') && isExcluded(src)) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 20 && rect.top > 0 && rect.left > 0) {
        clickTarget = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        console.log('[FrameFlow] Found photo at', clickTarget.x, clickTarget.y, '(' + img.naturalWidth + 'x' + img.naturalHeight + ')');
        break;
      }
    }

    // Also check iframes
    if (!clickTarget) {
      document.querySelectorAll('iframe').forEach(iframe => {
        try {
          if (!iframe.contentDocument || clickTarget) return;
          for (const img of iframe.contentDocument.querySelectorAll('img')) {
            if (img.naturalWidth < 30) continue;
            const src = img.src || '';
            if (!src.startsWith('blob:') && isExcluded(src)) continue;
            // Get coordinates relative to viewport (accounting for iframe position)
            const iframeRect = iframe.getBoundingClientRect();
            const imgRect = img.getBoundingClientRect();
            clickTarget = {
              x: Math.round(iframeRect.left + imgRect.left + imgRect.width / 2),
              y: Math.round(iframeRect.top + imgRect.top + imgRect.height / 2)
            };
            console.log('[FrameFlow] Found photo in iframe at', clickTarget.x, clickTarget.y);
            break;
          }
        } catch (e) {}
      });
    }

    if (!clickTarget) {
      console.log('[FrameFlow] No clickable photo found');
      if (overlay) overlay.style.display = '';
      showStatus('No photos found to click. Try scrolling first.');
      onDone();
      return;
    }

    // Click the photo via chrome.debugger (real click that iCloud responds to)
    console.log('[FrameFlow] Clicking photo at', clickTarget.x, clickTarget.y);
    const clickResult = await sendRealClick(clickTarget.x, clickTarget.y);
    if (!clickResult || !clickResult.ok) {
      console.log('[FrameFlow] Click failed, trying double click');
      await sendRealClick(clickTarget.x, clickTarget.y);
    }

    // Wait for detail view to load
    await new Promise(r => setTimeout(r, 2500));

    // Now capture screenshots and advance
    let captured = 0;
    let lastScreenshot = null;
    let staleCount = 0;

    // Show a small progress indicator
    const progressDiv = document.createElement('div');
    progressDiv.id = 'ff-hires-progress';
    progressDiv.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(0,0,0,0.8);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);padding:12px 24px;border-radius:10px;font-family:-apple-system,sans-serif;color:#fff;font-size:14px;pointer-events:none;';
    progressDiv.textContent = 'Capturing 0 / ' + maxTarget + '...';
    document.body.appendChild(progressDiv);

    async function captureStep() {
      if (!isRunning || captured >= maxTarget) {
        finishCapture();
        return;
      }

      // Take screenshot
      const dataUrl = await captureScreenshot();

      if (dataUrl && dataUrl !== lastScreenshot) {
        lastScreenshot = dataUrl;
        collectedUrls.add(dataUrl);
        captured++;
        staleCount = 0;
        progressDiv.textContent = 'Capturing ' + captured + ' / ' + maxTarget + '...';
        onProgress(captured);
        console.log('[FrameFlow] Screenshot #' + captured);

        // Start slideshow after a few captures
        if (currentIndex < 0 && collectedUrls.size >= 2) {
          photoUrls = Array.from(collectedUrls);
          buildShuffleOrder();
        }
      } else {
        staleCount++;
      }

      if (staleCount > 5) {
        console.log('[FrameFlow] Stale, finishing capture');
        finishCapture();
        return;
      }

      // Send real ArrowRight via debugger to advance to next photo
      await sendRealKey('ArrowRight');

      // Wait for the photo to load
      await new Promise(r => setTimeout(r, 2000));
      scrollTimer = setTimeout(captureStep, 100);
    }

    async function finishCapture() {
      progressDiv.remove();

      // Close detail view
      await sendRealKey('Escape');
      await new Promise(r => setTimeout(r, 500));

      photoUrls = Array.from(collectedUrls);
      if (overlay) overlay.style.display = '';
      console.log('[FrameFlow] Hi-res complete:', captured, 'screenshots captured');
      onDone();
    }

    captureStep();
  }

  // ===== Auto-scroll (thumbnail mode) =====
  function findScrollContainer() {
    let best = null, bestScore = 0;
    const check = (doc, win) => {
      try {
        doc.querySelectorAll('*').forEach(el => {
          try {
            const s = win.getComputedStyle(el);
            if (s.overflowY === 'scroll' || s.overflowY === 'auto') {
              const score = el.scrollHeight - el.clientHeight;
              if (score > bestScore) { bestScore = score; best = el; }
            }
          } catch (e) {}
        });
      } catch (e) {}
    };
    check(document, window);
    document.querySelectorAll('iframe').forEach(f => {
      try { if (f.contentDocument && f.contentWindow) check(f.contentDocument, f.contentWindow); } catch (e) {}
    });
    return best || document.documentElement;
  }

  async function autoScroll(target, onProgress, onDone) {
    const container = findScrollContainer();
    let staleRounds = 0, lastCount = collectedUrls.size;
    isScrolling = true;
    console.log('[FrameFlow] Scrolling to load ~' + target + ' photos');

    async function tick() {
      if (!isScrolling || !isRunning) { onDone(); return; }
      if (target > 0 && collectedUrls.size >= target) { isScrolling = false; onDone(); return; }

      const before = container.scrollTop;
      container.scrollTop += container.clientHeight;
      window.scrollBy(0, window.innerHeight);
      document.body.scrollTop += window.innerHeight;

      await new Promise(r => setTimeout(r, 1000));
      await scrapeAll();

      if (collectedUrls.size > lastCount) { staleRounds = 0; onProgress(collectedUrls.size); }
      else { staleRounds++; if (container.scrollTop === before) staleRounds += 10; }
      lastCount = collectedUrls.size;

      if (staleRounds >= 20) { isScrolling = false; onDone(); return; }
      scrollTimer = setTimeout(tick, 500);
    }
    tick();
  }

  // ===== Pre-fetch next slide =====
  async function prefetchNext() {
    if (!isRunning || !settings.hiRes) return;

    // Determine what the next slide index will be
    let nextIdx;
    if (historyPos >= 0 && historyPos < viewHistory.length - 1) {
      nextIdx = viewHistory[historyPos + 1];
    } else if (settings.shuffle) {
      if (shuffleIndex < shuffledOrder.length) nextIdx = shuffledOrder[shuffleIndex];
      else nextIdx = 0;
    } else {
      nextIdx = (currentIndex + 1) % photoUrls.length;
    }

    if (nextIdx < 0 || nextIdx >= photoUrls.length) return;
    if (cacheGet(nextIdx)) return; // already cached
    if (prefetchingIdx === nextIdx) return; // already prefetching

    prefetchingIdx = nextIdx;
    const url = photoUrls[nextIdx];

    // Pre-load into an off-screen image
    const img = new Image();
    img.src = url;
    img.onload = () => {
      // Cache it (it's already a blob URL, just mark it as cached)
      cacheSet(nextIdx, url);
      prefetchingIdx = -1;
      console.log('[FrameFlow] Pre-cached slide', nextIdx);
    };
    img.onerror = () => { prefetchingIdx = -1; };
  }

  // ===== Shuffle =====
  function buildShuffleOrder() {
    shuffledOrder = photoUrls.map((_, i) => i);
    for (let i = shuffledOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = shuffledOrder[i]; shuffledOrder[i] = shuffledOrder[j]; shuffledOrder[j] = t;
    }
    shuffleIndex = 0;
  }
  function getNextIndex() {
    if (!photoUrls.length) return -1;
    if (settings.shuffle) {
      if (shuffleIndex >= shuffledOrder.length) buildShuffleOrder();
      return shuffledOrder[shuffleIndex++];
    }
    return (currentIndex + 1) % photoUrls.length;
  }

  // ===== Ken Burns =====
  const KB = ['ff-kb-1', 'ff-kb-2', 'ff-kb-3', 'ff-kb-4'];
  function applyKenBurns(layer) {
    KB.forEach(c => layer.classList.remove(c)); layer.classList.remove('ff-kenburns');
    if (settings.kenBurns) layer.classList.add('ff-kenburns', KB[Math.floor(Math.random() * KB.length)]);
  }

  // ===== Slideshow =====
  function getInactive() { return document.getElementById(activeLayer === 'a' ? 'ff-layer-b' : 'ff-layer-a'); }
  function getActive() { return document.getElementById(activeLayer === 'a' ? 'ff-layer-a' : 'ff-layer-b'); }

  function clearLayer(l) {
    if (!l) return;
    KB.forEach(c => l.classList.remove(c));
    l.classList.remove('ff-kenburns', 'slide-enter', 'slide-exit', 'no-transition', 'ff-fill-cover');
    l.innerHTML = '';
  }

  function swapLayers() {
    const inc = getInactive(), out = getActive();
    if (!inc || !out) return;
    if (settings.transition === 'fade') { inc.classList.add('active'); out.classList.remove('active'); }
    else if (settings.transition === 'slide') {
      inc.classList.remove('slide-enter', 'slide-exit'); out.classList.remove('slide-enter', 'slide-exit');
      void inc.offsetWidth; inc.classList.add('slide-enter'); void inc.offsetWidth;
      inc.classList.add('active'); out.classList.add('slide-exit'); out.classList.remove('active');
    } else {
      inc.classList.add('no-transition', 'active'); out.classList.remove('active');
      setTimeout(() => inc.classList.remove('no-transition'), 50);
    }
    activeLayer = activeLayer === 'a' ? 'b' : 'a';
  }

  let errCount = 0;
  function loadSlide(idx) {
    if (idx < 0 || idx >= photoUrls.length) return;
    if (errCount >= 10) { showStatus('Many photos failed to load.'); errCount = 0; return; }
    const url = cacheGet(idx) || photoUrls[idx]; // use cached hi-res if available
    if (brokenUrls.has(url)) { errCount++; setTimeout(showNext, 50); return; }

    const layer = getInactive();
    if (!layer) return;
    clearLayer(layer);
    currentIndex = idx;
    if (settings.fill === 'cover') layer.classList.add('ff-fill-cover');

    const img = document.createElement('img');
    img.onload = () => {
      errCount = 0;
      applyKenBurns(layer);
      swapLayers();
      scheduleNext();
      // Pre-fetch next slide in background
      setTimeout(prefetchNext, 200);
    };
    img.onerror = () => { brokenUrls.add(url); errCount++; setTimeout(showNext, 200); };
    img.src = url;
    layer.appendChild(img);
  }

  function showNext() {
    clearTimeout(slideTimer);
    if (historyPos >= 0 && historyPos < viewHistory.length - 1) {
      historyPos++;
      loadSlide(viewHistory[historyPos]);
      return;
    }
    const i = getNextIndex();
    if (i >= 0) {
      viewHistory.push(i);
      historyPos = viewHistory.length - 1;
      if (viewHistory.length > 500) { viewHistory.shift(); historyPos--; }
      loadSlide(i);
    }
  }

  function showPrev() {
    clearTimeout(slideTimer);
    if (!viewHistory.length || historyPos <= 0) return;
    historyPos--;
    loadSlide(viewHistory[historyPos]);
  }

  function scheduleNext() {
    clearTimeout(slideTimer);
    if (!isPaused && photoUrls.length) slideTimer = setTimeout(showNext, settings.duration * 1000);
  }

  // ===== Controls =====
  function toggleControls() {
    const c = document.getElementById('frameflow-controls');
    if (!c) return;
    c.classList.toggle('visible');
    clearTimeout(controlsTimer);
    if (c.classList.contains('visible')) controlsTimer = setTimeout(() => c.classList.remove('visible'), 5000);
  }
  function togglePause() {
    isPaused = !isPaused;
    const b = document.getElementById('ff-playpause');
    if (b) b.innerHTML = isPaused ? '&#9654;' : '&#10074;&#10074;';
    if (isPaused) clearTimeout(slideTimer); else scheduleNext();
  }
  function showStatus(t) {
    const el = document.getElementById('frameflow-status');
    if (!el) return;
    el.textContent = t; el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 4000);
  }
  function handleKeydown(e) {
    if (!isRunning) return;
    if (e.key === 'Escape') { e.preventDefault(); stopSlideshow(); }
    else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); showNext(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); showPrev(); }
  }

  // ===== Overlay =====
  function createOverlay() {
    removeOverlay();
    const ov = document.createElement('div');
    ov.id = 'frameflow-overlay';
    ov.innerHTML = '<div id="ff-layer-a" class="ff-layer active"></div><div id="ff-layer-b" class="ff-layer"></div>';

    const ctrl = document.createElement('div');
    ctrl.id = 'frameflow-controls';
    ctrl.innerHTML = '<button id="ff-prev" title="Previous">&#9664;</button><button id="ff-playpause" title="Pause">&#10074;&#10074;</button><button id="ff-next" title="Next">&#9654;</button><button id="ff-settings-btn" title="Settings">&#9881;</button><button id="ff-exit" title="Exit">&#10005;</button>';

    const sp = document.createElement('div');
    sp.id = 'ff-settings-panel';
    sp.innerHTML = `
      <div class="ff-settings-title">Settings</div>
      <div class="ff-setting"><span>Photo Fill</span>
        <select id="ff-set-fill"><option value="contain"${settings.fill==='contain'?' selected':''}>Fit</option><option value="cover"${settings.fill==='cover'?' selected':''}>Fill (crop)</option></select>
      </div>
      <div class="ff-setting"><span>Hi-Res Mode</span><input type="checkbox" id="ff-set-hires"${settings.hiRes?' checked':''}></div>
      <div class="ff-setting"><span>Shuffle</span><input type="checkbox" id="ff-set-shuffle"${settings.shuffle?' checked':''}></div>
      <div class="ff-setting"><span>Transition</span>
        <select id="ff-set-transition"><option value="fade"${settings.transition==='fade'?' selected':''}>Fade</option><option value="slide"${settings.transition==='slide'?' selected':''}>Slide</option><option value="none"${settings.transition==='none'?' selected':''}>None</option></select>
      </div>
      <div class="ff-setting"><span>Ken Burns</span><input type="checkbox" id="ff-set-kenburns"${settings.kenBurns?' checked':''}></div>
      <div class="ff-setting"><span>Duration</span><div class="ff-range-wrap"><input type="range" id="ff-set-duration" min="3" max="30" value="${settings.duration}"><span id="ff-duration-val">${settings.duration}s</span></div></div>
    `;

    const st = document.createElement('div'); st.id = 'frameflow-status';
    const ld = document.createElement('div'); ld.id = 'frameflow-loader';
    ld.innerHTML = '<div class="ff-count" id="ff-photo-count">0</div><div class="ff-label" id="ff-loader-label">loading photos...</div>';

    document.body.appendChild(ov); document.body.appendChild(ctrl);
    document.body.appendChild(sp); document.body.appendChild(st); document.body.appendChild(ld);

    ov.addEventListener('click', () => {
      const panel = document.getElementById('ff-settings-panel');
      if (panel && panel.classList.contains('visible')) { panel.classList.remove('visible'); return; }
      toggleControls();
    });
    document.getElementById('ff-prev').addEventListener('click', e => { e.stopPropagation(); showPrev(); });
    document.getElementById('ff-next').addEventListener('click', e => { e.stopPropagation(); showNext(); });
    document.getElementById('ff-playpause').addEventListener('click', e => { e.stopPropagation(); togglePause(); });
    document.getElementById('ff-exit').addEventListener('click', e => { e.stopPropagation(); stopSlideshow(); });
    document.getElementById('ff-settings-btn').addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById('ff-settings-panel').classList.toggle('visible');
    });
    sp.addEventListener('click', e => e.stopPropagation());
    sp.addEventListener('mousedown', e => e.stopPropagation());

    // Settings handlers
    document.getElementById('ff-set-fill').addEventListener('change', e => {
      settings.fill = e.target.value;
      const a = getActive(); if (a) a.classList.toggle('ff-fill-cover', settings.fill === 'cover');
      saveExtSettings();
    });
    document.getElementById('ff-set-hires').addEventListener('change', e => { settings.hiRes = e.target.checked; saveExtSettings(); });
    document.getElementById('ff-set-shuffle').addEventListener('change', e => { settings.shuffle = e.target.checked; if (settings.shuffle) buildShuffleOrder(); saveExtSettings(); });
    document.getElementById('ff-set-transition').addEventListener('change', e => { settings.transition = e.target.value; saveExtSettings(); });
    document.getElementById('ff-set-kenburns').addEventListener('change', e => { settings.kenBurns = e.target.checked; saveExtSettings(); });
    document.getElementById('ff-set-duration').addEventListener('input', e => {
      settings.duration = parseInt(e.target.value, 10);
      document.getElementById('ff-duration-val').textContent = settings.duration + 's';
    });
    document.getElementById('ff-set-duration').addEventListener('change', e => { settings.duration = parseInt(e.target.value, 10); saveExtSettings(); });

    document.addEventListener('keydown', handleKeydown);
  }

  function removeOverlay() {
    ['frameflow-overlay', 'frameflow-controls', 'ff-settings-panel', 'frameflow-status', 'frameflow-loader'].forEach(id => {
      const el = document.getElementById(id); if (el) el.remove();
    });
    document.removeEventListener('keydown', handleKeydown);
  }

  // ===== Start / Stop =====
  function startSlideshow(opts) {
    if (opts) {
      if (!opts.fill) opts.fill = 'contain';
      Object.assign(settings, opts);
    }

    isRunning = true; isPaused = false;
    currentIndex = -1; activeLayer = 'a';
    viewHistory = []; historyPos = -1;
    hiResCache.clear();
    photoUrls = Array.from(collectedUrls);

    createOverlay();
    document.getElementById('frameflow-overlay').classList.add('active');

    const countEl = document.getElementById('ff-photo-count');
    const labelEl = document.getElementById('ff-loader-label');

    if (settings.hiRes) {
      // Hi-res mode: reset counter and click through photos
      if (countEl) countEl.textContent = '0';
      if (labelEl) labelEl.textContent = 'opening photo viewer for hi-res capture...';

      const hiResTarget = settings.targetPhotos || 10;

      loadHiResPhotos(hiResTarget,
        (count) => {
          if (countEl) countEl.textContent = count + ' / ' + hiResTarget;
          if (labelEl) labelEl.textContent = 'capturing hi-res photos...';
          photoUrls = Array.from(collectedUrls);

          // Start slideshow as soon as we have a few photos
          if (currentIndex < 0 && photoUrls.length >= 3) {
            buildShuffleOrder();
            const ld = document.getElementById('frameflow-loader');
            if (ld) ld.style.display = 'none';
            showNext();
          }
          if (settings.shuffle) {
            for (let i = shuffledOrder.length; i < photoUrls.length; i++) {
              shuffledOrder.splice(Math.floor(Math.random() * (shuffledOrder.length + 1)), 0, i);
            }
          }
        },
        () => {
          photoUrls = Array.from(collectedUrls);
          showStatus(photoUrls.length + ' hi-res photos loaded');
          const ld = document.getElementById('frameflow-loader');
          if (ld) ld.style.display = 'none';
          if (currentIndex < 0 && photoUrls.length > 0) {
            buildShuffleOrder();
            showNext();
          }
        }
      );
    } else {
      // Thumbnail mode: scroll and scrape
      if (labelEl) labelEl.textContent = 'scrolling to find photos...';
      if (photoUrls.length > 0) {
        buildShuffleOrder();
        setTimeout(() => {
          const ld = document.getElementById('frameflow-loader');
          if (ld) ld.style.display = 'none';
          showNext();
        }, 1000);
      }

      autoScroll(settings.targetPhotos || 500,
        (count) => {
          photoUrls = Array.from(collectedUrls);
          if (countEl) countEl.textContent = count;
          if (currentIndex < 0 && photoUrls.length > 0) {
            buildShuffleOrder();
            const ld = document.getElementById('frameflow-loader');
            if (ld) ld.style.display = 'none';
            showNext();
          }
          if (settings.shuffle) {
            for (let i = shuffledOrder.length; i < photoUrls.length; i++) {
              shuffledOrder.splice(Math.floor(Math.random() * (shuffledOrder.length + 1)), 0, i);
            }
          }
        },
        () => {
          photoUrls = Array.from(collectedUrls);
          showStatus(photoUrls.length + ' photos loaded');
          const ld = document.getElementById('frameflow-loader');
          if (ld) ld.style.display = 'none';
          if (!photoUrls.length) showStatus('No photos found. Scroll the page manually first.');
        }
      );
    }

    return photoUrls.length;
  }

  function stopSlideshow() {
    isRunning = false; isPaused = false; isScrolling = false;
    clearTimeout(slideTimer); clearTimeout(scrollTimer);
    removeOverlay();
    currentIndex = -1;
  }

  // ===== Message Handler =====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true, running: isRunning, photoCount: collectedUrls.size });
    } else if (msg.type === 'START_SLIDESHOW') {
      const count = startSlideshow(msg.settings);
      sendResponse({ ok: true, photoCount: count });
    } else if (msg.type === 'STOP_SLIDESHOW') {
      stopSlideshow();
      sendResponse({ ok: true });
    }
    return true;
  });

  // ===== Background collection =====
  let scrapeTimer2 = null, isCollecting = false;
  async function bgScrape() {
    if (isCollecting) return;
    isCollecting = true; await scrapeAll(); isCollecting = false;
  }
  const observer = new MutationObserver(() => {
    clearTimeout(scrapeTimer2); scrapeTimer2 = setTimeout(bgScrape, 500);
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
  setInterval(bgScrape, 3000);
  scrapeAll().then(() => console.log('[FrameFlow] Initial:', collectedUrls.size, 'photos'));

})();
