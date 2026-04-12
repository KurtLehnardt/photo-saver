// FrameFlow Content Script for icloud.com/photos
// Runs in ALL frames. The iframe instance scrolls & scrapes.
// The top-level instance renders the slideshow overlay.
// They communicate via chrome.runtime messages.

(function() {
  'use strict';

  const isTopFrame = (window === window.top);
  console.log('[FrameFlow] Loaded in', isTopFrame ? 'TOP FRAME' : 'IFRAME', window.location.href.substring(0, 80));

  // ===== SHARED: Photo scraping =====
  const collectedUrls = new Set();
  const seenBlobUrls = new Set();
  const brokenUrls = new Set();
  const MIN_PHOTO_SIZE = 50;

  const EXCLUDE_PATTERNS = [
    /\.svg(\?|$)/i, /sprite/i, /favicon/i, /apple-touch-icon/i,
    /emoji/i, /\/ui\//i, /\/assets\//i
  ];

  function isExcluded(url) {
    if (!url || url === '' || url === 'about:blank') return true;
    if (url.startsWith('data:')) return true;
    if (url.length < 30) return true;
    for (const p of EXCLUDE_PATTERNS) { if (p.test(url)) return true; }
    return false;
  }

  const captureCanvas = document.createElement('canvas');
  const captureCtx = captureCanvas.getContext('2d');

  function captureImage(img) {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (w < MIN_PHOTO_SIZE || h < MIN_PHOTO_SIZE) return null;
      const maxDim = 2048;
      let dw = w, dh = h;
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        dw = Math.round(w * scale);
        dh = Math.round(h * scale);
      }
      captureCanvas.width = dw;
      captureCanvas.height = dh;
      captureCtx.drawImage(img, 0, 0, dw, dh);
      return new Promise(resolve => {
        captureCanvas.toBlob(blob => {
          resolve(blob ? URL.createObjectURL(blob) : null);
        }, 'image/jpeg', 0.92);
      });
    } catch (e) { return null; }
  }

  async function scrapeCurrentDoc() {
    const before = collectedUrls.size;

    // All img elements in THIS document
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      const src = img.src || '';
      if (src.startsWith('blob:')) {
        if (seenBlobUrls.has(src)) continue;
        if (!img.complete || img.naturalWidth < MIN_PHOTO_SIZE || img.naturalHeight < MIN_PHOTO_SIZE) continue;
        seenBlobUrls.add(src);
        try {
          const captured = await captureImage(img);
          if (captured) collectedUrls.add(captured);
        } catch (e) {}
        continue;
      }
      if (isExcluded(src)) continue;
      if (img.naturalWidth > 0 && img.naturalWidth < MIN_PHOTO_SIZE) continue;
      if (img.naturalHeight > 0 && img.naturalHeight < MIN_PHOTO_SIZE) continue;
      collectedUrls.add(src);
    }

    // Background images
    document.querySelectorAll('[style*="background"]').forEach(el => {
      const style = el.getAttribute('style') || '';
      const match = style.match(/url\(["']?([^"')]+)["']?\)/);
      if (match && match[1] && !isExcluded(match[1]) && !match[1].startsWith('blob:')) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= MIN_PHOTO_SIZE && rect.height >= MIN_PHOTO_SIZE) {
          collectedUrls.add(match[1]);
        }
      }
    });

    return collectedUrls.size - before;
  }

  // =============================================
  // IFRAME INSTANCE: Scrolling + scraping
  // =============================================
  if (!isTopFrame) {

    let isScrolling = false;
    let scrollInterval = null;

    function findScrollContainer() {
      let best = null, bestScore = 0;
      document.querySelectorAll('*').forEach(el => {
        const s = window.getComputedStyle(el);
        if (s.overflowY === 'scroll' || s.overflowY === 'auto') {
          const score = el.scrollHeight - el.clientHeight;
          if (score > bestScore + 100) { bestScore = score; best = el; }
        }
      });
      console.log('[FrameFlow/iframe] Scroll container:', best ? best.tagName + ' scrollHeight=' + best.scrollHeight : 'none');
      return best;
    }

    // Send photo data up to top frame
    function sendPhotosToTop() {
      const urls = Array.from(collectedUrls);
      window.top.postMessage({ type: 'FRAMEFLOW_PHOTOS', urls: urls }, '*');
    }

    // Debounced scraper
    let scrapeTimer = null;
    let isCollecting = false;
    async function debouncedScrape() {
      if (isCollecting) return;
      isCollecting = true;
      const added = await scrapeCurrentDoc();
      if (added > 0) sendPhotosToTop();
      isCollecting = false;
    }

    // MutationObserver
    const observer = new MutationObserver(() => {
      clearTimeout(scrapeTimer);
      scrapeTimer = setTimeout(debouncedScrape, 500);
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
    }

    // Periodic scrape
    setInterval(debouncedScrape, 2000);

    // Initial scrape
    scrapeCurrentDoc().then(() => {
      console.log('[FrameFlow/iframe] Initial scrape:', collectedUrls.size, 'photos');
      sendPhotosToTop();
    });

    // Listen for scroll commands from top frame
    window.addEventListener('message', async (e) => {
      if (!e.data || e.data.type !== 'FRAMEFLOW_SCROLL') return;

      const target = e.data.targetCount || 500;
      const container = findScrollContainer();

      if (!container) {
        console.log('[FrameFlow/iframe] No scroll container found');
        window.top.postMessage({ type: 'FRAMEFLOW_SCROLL_DONE', count: collectedUrls.size }, '*');
        return;
      }

      console.log('[FrameFlow/iframe] Starting scroll. Target:', target, 'Container scrollHeight:', container.scrollHeight);

      isScrolling = true;
      let staleRounds = 0;
      const maxStale = 25;
      let lastCount = collectedUrls.size;

      async function tick() {
        if (!isScrolling) return;
        if (target > 0 && collectedUrls.size >= target) {
          console.log('[FrameFlow/iframe] Reached target:', collectedUrls.size);
          finish();
          return;
        }

        // Scroll DOWN (iCloud shows newest at top, oldest at bottom)
        const beforeScroll = container.scrollTop;
        container.scrollTop += container.clientHeight;

        // Wait for render
        await new Promise(r => setTimeout(r, 1200));
        await scrapeCurrentDoc();

        const newCount = collectedUrls.size;
        if (newCount > lastCount) {
          staleRounds = 0;
          sendPhotosToTop();
          window.top.postMessage({
            type: 'FRAMEFLOW_SCROLL_PROGRESS',
            count: newCount,
            target: target
          }, '*');
        } else {
          staleRounds++;
        }
        lastCount = newCount;

        // Check if we're stuck (scrolled but nothing new)
        const didScroll = container.scrollTop !== beforeScroll;
        if (!didScroll) staleRounds += 5; // fast-forward if can't scroll further

        if (staleRounds >= maxStale) {
          console.log('[FrameFlow/iframe] Scroll complete. Found:', collectedUrls.size);
          finish();
          return;
        }

        setTimeout(tick, 300);
      }

      function finish() {
        isScrolling = false;
        sendPhotosToTop();
        window.top.postMessage({ type: 'FRAMEFLOW_SCROLL_DONE', count: collectedUrls.size }, '*');
        // Scroll back to top
        container.scrollTop = 0;
      }

      tick();
    });

    // Listen for stop
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'FRAMEFLOW_STOP_SCROLL') {
        isScrolling = false;
      }
    });

    return; // iframe instance ends here
  }

  // =============================================
  // TOP FRAME INSTANCE: Overlay + slideshow
  // =============================================
  let photoUrls = [];
  let isRunning = false;
  let settings = {
    shuffle: true, transition: 'fade', fill: 'contain',
    kenBurns: true, duration: 8, targetPhotos: 500
  };

  let slideTimer = null, controlsTimer = null;
  let scrollInterval = null;
  let currentIndex = -1, shuffledOrder = [], shuffleIndex = 0;
  let activeLayer = 'a', isPaused = false;

  function saveExtSettings() {
    chrome.storage.local.set({ frameflow_settings: settings });
  }

  // Receive photos from iframe
  window.addEventListener('message', (e) => {
    if (!e.data) return;

    if (e.data.type === 'FRAMEFLOW_PHOTOS') {
      const before = collectedUrls.size;
      e.data.urls.forEach(u => collectedUrls.add(u));
      if (collectedUrls.size > before) {
        photoUrls = Array.from(collectedUrls);
        console.log('[FrameFlow/top] Received photos from iframe. Total:', photoUrls.length);
      }
    }

    if (e.data.type === 'FRAMEFLOW_SCROLL_PROGRESS') {
      const countEl = document.getElementById('ff-photo-count');
      if (countEl) countEl.textContent = e.data.count;
      photoUrls = Array.from(collectedUrls);

      // Start slideshow as soon as we have some photos
      if (isRunning && currentIndex < 0 && photoUrls.length > 0) {
        buildShuffleOrder();
        const loader = document.getElementById('frameflow-loader');
        if (loader) loader.style.display = 'none';
        showNext();
      }

      // Extend shuffle
      if (settings.shuffle) {
        for (let i = shuffledOrder.length; i < photoUrls.length; i++) {
          shuffledOrder.splice(Math.floor(Math.random() * (shuffledOrder.length + 1)), 0, i);
        }
      }
    }

    if (e.data.type === 'FRAMEFLOW_SCROLL_DONE') {
      photoUrls = Array.from(collectedUrls);
      showStatus(photoUrls.length + ' photos loaded');
      const loader = document.getElementById('frameflow-loader');
      if (loader) loader.style.display = 'none';
      if (photoUrls.length === 0) {
        showStatus('No photos found. Make sure iCloud Photos is loaded.');
      }
    }
  });

  // Also scrape top frame (in case photos aren't in iframe)
  async function scrapeTop() {
    await scrapeCurrentDoc();
    photoUrls = Array.from(collectedUrls);
  }

  // ===== Shuffle =====
  function buildShuffleOrder() {
    shuffledOrder = photoUrls.map((_, i) => i);
    for (let i = shuffledOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffledOrder[i]; shuffledOrder[i] = shuffledOrder[j]; shuffledOrder[j] = tmp;
    }
    shuffleIndex = 0;
  }

  function getNextIndex() {
    if (photoUrls.length === 0) return -1;
    if (settings.shuffle) {
      if (shuffleIndex >= shuffledOrder.length) buildShuffleOrder();
      return shuffledOrder[shuffleIndex++];
    }
    return (currentIndex + 1) % photoUrls.length;
  }

  function getPrevIndex() {
    if (photoUrls.length === 0) return -1;
    return currentIndex <= 0 ? photoUrls.length - 1 : currentIndex - 1;
  }

  // ===== Ken Burns =====
  const KB_CLASSES = ['ff-kb-1', 'ff-kb-2', 'ff-kb-3', 'ff-kb-4'];
  function applyKenBurns(layer) {
    KB_CLASSES.forEach(c => layer.classList.remove(c));
    layer.classList.remove('ff-kenburns');
    if (settings.kenBurns) {
      layer.classList.add('ff-kenburns', KB_CLASSES[Math.floor(Math.random() * KB_CLASSES.length)]);
    }
  }

  // ===== Slideshow Engine =====
  function getInactiveLayer() { return document.getElementById(activeLayer === 'a' ? 'ff-layer-b' : 'ff-layer-a'); }
  function getActiveLayerEl() { return document.getElementById(activeLayer === 'a' ? 'ff-layer-a' : 'ff-layer-b'); }

  function clearLayer(layer) {
    if (!layer) return;
    KB_CLASSES.forEach(c => layer.classList.remove(c));
    layer.classList.remove('ff-kenburns', 'slide-enter', 'slide-exit', 'no-transition', 'ff-fill-cover');
    layer.innerHTML = '';
  }

  function swapLayers() {
    const incoming = getInactiveLayer(), outgoing = getActiveLayerEl();
    if (!incoming || !outgoing) return;
    if (settings.transition === 'fade') {
      incoming.classList.add('active'); outgoing.classList.remove('active');
    } else if (settings.transition === 'slide') {
      incoming.classList.remove('slide-enter', 'slide-exit');
      outgoing.classList.remove('slide-enter', 'slide-exit');
      void incoming.offsetWidth;
      incoming.classList.add('slide-enter'); void incoming.offsetWidth;
      incoming.classList.add('active');
      outgoing.classList.add('slide-exit'); outgoing.classList.remove('active');
    } else {
      incoming.classList.add('no-transition', 'active'); outgoing.classList.remove('active');
      setTimeout(() => incoming.classList.remove('no-transition'), 50);
    }
    activeLayer = activeLayer === 'a' ? 'b' : 'a';
  }

  let errorCount = 0;
  function loadSlide(index) {
    if (index < 0 || index >= photoUrls.length) return;
    if (errorCount >= 10) { showStatus('Many photos failed to load.'); errorCount = 0; return; }
    const url = photoUrls[index];
    if (brokenUrls.has(url)) { errorCount++; setTimeout(showNext, 50); return; }

    const layer = getInactiveLayer();
    if (!layer) return;
    clearLayer(layer);
    currentIndex = index;
    if (settings.fill === 'cover') layer.classList.add('ff-fill-cover');

    const img = document.createElement('img');
    img.onload = () => { errorCount = 0; applyKenBurns(layer); swapLayers(); scheduleNext(); };
    img.onerror = () => { brokenUrls.add(url); errorCount++; setTimeout(showNext, 200); };
    img.src = url;
    layer.appendChild(img);
  }

  function showNext() { clearTimeout(slideTimer); const idx = getNextIndex(); if (idx >= 0) loadSlide(idx); }
  function showPrev() { clearTimeout(slideTimer); const idx = getPrevIndex(); if (idx >= 0) loadSlide(idx); }
  function scheduleNext() { clearTimeout(slideTimer); if (!isPaused && photoUrls.length > 0) slideTimer = setTimeout(showNext, settings.duration * 1000); }

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
    const btn = document.getElementById('ff-playpause');
    if (btn) { btn.innerHTML = isPaused ? '&#9654;' : '&#10074;&#10074;'; }
    if (isPaused) clearTimeout(slideTimer); else scheduleNext();
  }

  function showStatus(text) {
    const el = document.getElementById('frameflow-status');
    if (!el) return;
    el.textContent = text; el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 3000);
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

    const overlay = document.createElement('div');
    overlay.id = 'frameflow-overlay';
    overlay.innerHTML = '<div id="ff-layer-a" class="ff-layer active"></div><div id="ff-layer-b" class="ff-layer"></div>';

    const controls = document.createElement('div');
    controls.id = 'frameflow-controls';
    controls.innerHTML = `
      <button id="ff-prev" title="Previous">&#9664;</button>
      <button id="ff-playpause" title="Pause">&#10074;&#10074;</button>
      <button id="ff-next" title="Next">&#9654;</button>
      <button id="ff-settings-btn" title="Settings">&#9881;</button>
      <button id="ff-exit" title="Exit">&#10005;</button>
    `;

    const settingsPanel = document.createElement('div');
    settingsPanel.id = 'ff-settings-panel';
    settingsPanel.innerHTML = `
      <div class="ff-settings-title">Settings</div>
      <div class="ff-setting"><span>Photo Fill</span>
        <select id="ff-set-fill">
          <option value="contain" ${settings.fill === 'contain' ? 'selected' : ''}>Fit (show full photo)</option>
          <option value="cover" ${settings.fill === 'cover' ? 'selected' : ''}>Fill (crop to fill)</option>
        </select>
      </div>
      <div class="ff-setting"><span>Shuffle</span>
        <input type="checkbox" id="ff-set-shuffle" ${settings.shuffle ? 'checked' : ''}>
      </div>
      <div class="ff-setting"><span>Transition</span>
        <select id="ff-set-transition">
          <option value="fade" ${settings.transition === 'fade' ? 'selected' : ''}>Fade</option>
          <option value="slide" ${settings.transition === 'slide' ? 'selected' : ''}>Slide</option>
          <option value="none" ${settings.transition === 'none' ? 'selected' : ''}>None</option>
        </select>
      </div>
      <div class="ff-setting"><span>Ken Burns</span>
        <input type="checkbox" id="ff-set-kenburns" ${settings.kenBurns ? 'checked' : ''}>
      </div>
      <div class="ff-setting"><span>Duration</span>
        <div class="ff-range-wrap">
          <input type="range" id="ff-set-duration" min="3" max="30" value="${settings.duration}">
          <span id="ff-duration-val">${settings.duration}s</span>
        </div>
      </div>
    `;

    const status = document.createElement('div');
    status.id = 'frameflow-status';

    const loader = document.createElement('div');
    loader.id = 'frameflow-loader';
    loader.innerHTML = '<div class="ff-count" id="ff-photo-count">0</div><div class="ff-label">photos found — scrolling to load more...</div>';

    document.body.appendChild(overlay);
    document.body.appendChild(controls);
    document.body.appendChild(settingsPanel);
    document.body.appendChild(status);
    document.body.appendChild(loader);

    overlay.addEventListener('click', (e) => {
      const sp = document.getElementById('ff-settings-panel');
      if (sp && sp.classList.contains('visible')) { sp.classList.remove('visible'); return; }
      toggleControls();
    });
    document.getElementById('ff-prev').addEventListener('click', (e) => { e.stopPropagation(); showPrev(); });
    document.getElementById('ff-next').addEventListener('click', (e) => { e.stopPropagation(); showNext(); });
    document.getElementById('ff-playpause').addEventListener('click', (e) => { e.stopPropagation(); togglePause(); });
    document.getElementById('ff-exit').addEventListener('click', (e) => { e.stopPropagation(); stopSlideshow(); });
    document.getElementById('ff-settings-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('ff-settings-panel').classList.toggle('visible');
    });

    settingsPanel.addEventListener('click', (e) => { e.stopPropagation(); });
    settingsPanel.addEventListener('mousedown', (e) => { e.stopPropagation(); });

    // Settings handlers
    document.getElementById('ff-set-fill').addEventListener('change', (e) => {
      settings.fill = e.target.value;
      const active = getActiveLayerEl();
      if (active) { if (settings.fill === 'cover') active.classList.add('ff-fill-cover'); else active.classList.remove('ff-fill-cover'); }
      saveExtSettings();
    });
    document.getElementById('ff-set-shuffle').addEventListener('change', (e) => { settings.shuffle = e.target.checked; if (settings.shuffle) buildShuffleOrder(); saveExtSettings(); });
    document.getElementById('ff-set-transition').addEventListener('change', (e) => { settings.transition = e.target.value; saveExtSettings(); });
    document.getElementById('ff-set-kenburns').addEventListener('change', (e) => { settings.kenBurns = e.target.checked; saveExtSettings(); });
    document.getElementById('ff-set-duration').addEventListener('input', (e) => {
      settings.duration = parseInt(e.target.value, 10);
      document.getElementById('ff-duration-val').textContent = settings.duration + 's';
    });
    document.getElementById('ff-set-duration').addEventListener('change', (e) => {
      settings.duration = parseInt(e.target.value, 10); saveExtSettings();
    });

    document.addEventListener('keydown', handleKeydown);
  }

  function removeOverlay() {
    ['frameflow-overlay', 'frameflow-controls', 'ff-settings-panel', 'frameflow-status', 'frameflow-loader'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    document.removeEventListener('keydown', handleKeydown);
  }

  // ===== Start / Stop =====
  function startSlideshow(opts) {
    if (opts) {
      if (!opts.fill) opts.fill = 'contain';
      Object.assign(settings, opts);
    }

    isRunning = true;
    isPaused = false;
    currentIndex = -1;
    activeLayer = 'a';
    photoUrls = Array.from(collectedUrls);

    createOverlay();
    document.getElementById('frameflow-overlay').classList.add('active');

    const countEl = document.getElementById('ff-photo-count');
    if (countEl) countEl.textContent = photoUrls.length;

    if (photoUrls.length > 0) {
      buildShuffleOrder();
      setTimeout(() => {
        const loader = document.getElementById('frameflow-loader');
        if (loader) loader.style.display = 'none';
        showNext();
      }, 1000);
    }

    // Tell iframe to start scrolling
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach(iframe => {
      try {
        iframe.contentWindow.postMessage({
          type: 'FRAMEFLOW_SCROLL',
          targetCount: settings.targetPhotos || 500
        }, '*');
      } catch (e) {}
    });

    return photoUrls.length;
  }

  function stopSlideshow() {
    isRunning = false;
    isPaused = false;
    clearTimeout(slideTimer);
    removeOverlay();
    currentIndex = -1;

    // Tell iframe to stop scrolling
    document.querySelectorAll('iframe').forEach(iframe => {
      try { iframe.contentWindow.postMessage({ type: 'FRAMEFLOW_STOP_SCROLL' }, '*'); } catch (e) {}
    });
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

  // Also scrape top frame
  scrapeCurrentDoc().then(() => {
    console.log('[FrameFlow/top] Initial scrape:', collectedUrls.size, 'photos');
  });

})();
