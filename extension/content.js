// FrameFlow Content Script for icloud.com/photos
// Single-script approach: scrape all visible images, scroll to load more.

(function() {
  'use strict';

  console.log('[FrameFlow] Content script loaded on', window.location.href);

  // Only run in the top frame
  if (window !== window.top) {
    console.log('[FrameFlow] Skipping iframe instance');
    return;
  }

  // ===== State =====
  const collectedUrls = new Set();
  const seenBlobUrls = new Set();
  const brokenUrls = new Set();
  let photoUrls = [];
  let isRunning = false;
  let isPaused = false;
  let isScrolling = false;
  let settings = {
    shuffle: true, transition: 'fade', fill: 'contain',
    kenBurns: true, duration: 8, targetPhotos: 500
  };
  let slideTimer = null, controlsTimer = null, scrollTimer = null;
  let currentIndex = -1, shuffledOrder = [], shuffleIndex = 0;
  let activeLayer = 'a';
  let history = []; // indices of previously shown slides
  let historyPos = -1; // current position in history (-1 = at the end)

  function saveExtSettings() {
    chrome.storage.local.set({ frameflow_settings: settings });
  }

  // ===== Canvas capture for blob URLs =====
  const captureCanvas = document.createElement('canvas');
  const captureCtx = captureCanvas.getContext('2d');

  function captureImage(img) {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (w < 50 || h < 50) return null;
      const maxDim = 2048;
      let dw = w, dh = h;
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        dw = Math.round(w * scale); dh = Math.round(h * scale);
      }
      captureCanvas.width = dw;
      captureCanvas.height = dh;
      captureCtx.drawImage(img, 0, 0, dw, dh);
      return new Promise(resolve => {
        captureCanvas.toBlob(blob => resolve(blob ? URL.createObjectURL(blob) : null), 'image/jpeg', 0.95);
      });
    } catch (e) { return null; }
  }

  // ===== Scraping =====
  const EXCLUDE = [/\.svg/i, /sprite/i, /favicon/i, /emoji/i, /apple-touch-icon/i];

  function isExcluded(url) {
    if (!url || url.length < 20 || url.startsWith('data:')) return true;
    for (const p of EXCLUDE) { if (p.test(url)) return true; }
    return false;
  }

  async function scrapeAll() {
    const before = collectedUrls.size;

    // Scrape ALL img elements in ALL accessible documents
    const docs = [document];
    document.querySelectorAll('iframe').forEach(iframe => {
      try { if (iframe.contentDocument) docs.push(iframe.contentDocument); } catch (e) {}
    });

    for (const doc of docs) {
      const imgs = doc.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.src || '';

        // Blob URL — capture via canvas
        if (src.startsWith('blob:')) {
          if (seenBlobUrls.has(src)) continue;
          if (!img.complete || img.naturalWidth < 50 || img.naturalHeight < 50) continue;
          seenBlobUrls.add(src);
          try {
            const captured = await captureImage(img);
            if (captured) collectedUrls.add(captured);
          } catch (e) {}
          continue;
        }

        // Regular URL
        if (isExcluded(src)) continue;
        if (img.naturalWidth > 0 && img.naturalWidth < 50) continue;
        collectedUrls.add(src);
      }

      // Background images
      doc.querySelectorAll('[style*="url"]').forEach(el => {
        const match = (el.getAttribute('style') || '').match(/url\(["']?([^"')]+)["']?\)/);
        if (match && match[1] && !isExcluded(match[1]) && !match[1].startsWith('blob:')) {
          const r = el.getBoundingClientRect();
          if (r.width >= 50 && r.height >= 50) collectedUrls.add(match[1]);
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

  // ===== Auto-scroll =====
  function findScrollContainer() {
    let best = null, bestScore = 0;

    // Check top document
    document.querySelectorAll('*').forEach(el => {
      try {
        const s = window.getComputedStyle(el);
        if (s.overflowY === 'scroll' || s.overflowY === 'auto') {
          const score = el.scrollHeight - el.clientHeight;
          if (score > bestScore) { bestScore = score; best = el; }
        }
      } catch (e) {}
    });

    // Check iframes
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        if (!iframe.contentDocument) return;
        iframe.contentDocument.querySelectorAll('*').forEach(el => {
          try {
            const s = iframe.contentWindow.getComputedStyle(el);
            if (s.overflowY === 'scroll' || s.overflowY === 'auto') {
              const score = el.scrollHeight - el.clientHeight;
              if (score > bestScore) { bestScore = score; best = el; }
            }
          } catch (e) {}
        });
      } catch (e) {}
    });

    console.log('[FrameFlow] Scroll container:', best
      ? best.tagName + ' class=' + (best.className || '').substring(0, 40) + ' scrollH=' + best.scrollHeight
      : 'document.documentElement');
    return best || document.documentElement;
  }

  async function autoScroll(target, onProgress, onDone) {
    const container = findScrollContainer();
    let staleRounds = 0, lastCount = collectedUrls.size;
    isScrolling = true;

    console.log('[FrameFlow] Scrolling to load ~' + target + ' photos');

    async function tick() {
      if (!isScrolling || !isRunning) { onDone(); return; }
      if (target > 0 && collectedUrls.size >= target) {
        console.log('[FrameFlow] Target reached:', collectedUrls.size);
        isScrolling = false; onDone(); return;
      }

      // Scroll down
      const before = container.scrollTop;
      container.scrollTop += container.clientHeight;
      // Also scroll window and body
      window.scrollBy(0, window.innerHeight);
      document.body.scrollTop += window.innerHeight;

      await new Promise(r => setTimeout(r, 1000));
      await scrapeAll();

      if (collectedUrls.size > lastCount) {
        staleRounds = 0;
        onProgress(collectedUrls.size);
      } else {
        staleRounds++;
        // If scroll didn't move, we're at the end
        if (container.scrollTop === before) staleRounds += 10;
      }
      lastCount = collectedUrls.size;

      if (staleRounds >= 20) {
        console.log('[FrameFlow] Scroll done. Total:', collectedUrls.size);
        isScrolling = false; onDone(); return;
      }

      scrollTimer = setTimeout(tick, 500);
    }

    tick();
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
  function getPrevIndex() {
    if (!photoUrls.length) return -1;
    return currentIndex <= 0 ? photoUrls.length - 1 : currentIndex - 1;
  }

  // ===== Ken Burns =====
  const KB = ['ff-kb-1', 'ff-kb-2', 'ff-kb-3', 'ff-kb-4'];
  function applyKenBurns(layer) {
    KB.forEach(c => layer.classList.remove(c));
    layer.classList.remove('ff-kenburns');
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
    if (settings.transition === 'fade') {
      inc.classList.add('active'); out.classList.remove('active');
    } else if (settings.transition === 'slide') {
      inc.classList.remove('slide-enter', 'slide-exit');
      out.classList.remove('slide-enter', 'slide-exit');
      void inc.offsetWidth;
      inc.classList.add('slide-enter'); void inc.offsetWidth;
      inc.classList.add('active');
      out.classList.add('slide-exit'); out.classList.remove('active');
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
    const url = photoUrls[idx];
    if (brokenUrls.has(url)) { errCount++; setTimeout(showNext, 50); return; }

    const layer = getInactive();
    if (!layer) return;
    clearLayer(layer);
    currentIndex = idx;
    if (settings.fill === 'cover') layer.classList.add('ff-fill-cover');

    const img = document.createElement('img');
    img.onload = () => { errCount = 0; applyKenBurns(layer); swapLayers(); scheduleNext(); };
    img.onerror = () => { brokenUrls.add(url); errCount++; setTimeout(showNext, 200); };
    img.src = url;
    layer.appendChild(img);
  }

  function showNext() {
    clearTimeout(slideTimer);
    // If we're browsing back through history, move forward in history first
    if (historyPos >= 0 && historyPos < history.length - 1) {
      historyPos++;
      loadSlide(history[historyPos], true);
      return;
    }
    // Otherwise get next slide and add to history
    const i = getNextIndex();
    if (i >= 0) {
      history.push(i);
      historyPos = history.length - 1;
      // Cap history at 500 entries
      if (history.length > 500) { history.shift(); historyPos--; }
      loadSlide(i, true);
    }
  }

  function showPrev() {
    clearTimeout(slideTimer);
    if (history.length === 0 || historyPos <= 0) return; // nothing to go back to
    historyPos--;
    loadSlide(history[historyPos], true);
  }
  function scheduleNext() { clearTimeout(slideTimer); if (!isPaused && photoUrls.length) slideTimer = setTimeout(showNext, settings.duration * 1000); }

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
      <div class="ff-setting"><span>Shuffle</span><input type="checkbox" id="ff-set-shuffle"${settings.shuffle?' checked':''}></div>
      <div class="ff-setting"><span>Transition</span>
        <select id="ff-set-transition"><option value="fade"${settings.transition==='fade'?' selected':''}>Fade</option><option value="slide"${settings.transition==='slide'?' selected':''}>Slide</option><option value="none"${settings.transition==='none'?' selected':''}>None</option></select>
      </div>
      <div class="ff-setting"><span>Ken Burns</span><input type="checkbox" id="ff-set-kenburns"${settings.kenBurns?' checked':''}></div>
      <div class="ff-setting"><span>Duration</span><div class="ff-range-wrap"><input type="range" id="ff-set-duration" min="3" max="30" value="${settings.duration}"><span id="ff-duration-val">${settings.duration}s</span></div></div>
    `;

    const st = document.createElement('div'); st.id = 'frameflow-status';
    const ld = document.createElement('div'); ld.id = 'frameflow-loader';
    ld.innerHTML = '<div class="ff-count" id="ff-photo-count">0</div><div class="ff-label">photos found — scrolling to load more...</div>';

    document.body.appendChild(ov);
    document.body.appendChild(ctrl);
    document.body.appendChild(sp);
    document.body.appendChild(st);
    document.body.appendChild(ld);

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

    // Stop clicks inside settings panel from propagating
    sp.addEventListener('click', e => e.stopPropagation());
    sp.addEventListener('mousedown', e => e.stopPropagation());

    // Settings handlers
    document.getElementById('ff-set-fill').addEventListener('change', e => {
      settings.fill = e.target.value;
      const a = getActive(); if (a) { a.classList.toggle('ff-fill-cover', settings.fill === 'cover'); }
      saveExtSettings();
    });
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
    history = []; historyPos = -1;
    photoUrls = Array.from(collectedUrls);

    createOverlay();
    document.getElementById('frameflow-overlay').classList.add('active');

    const countEl = document.getElementById('ff-photo-count');
    if (countEl) countEl.textContent = photoUrls.length;

    if (photoUrls.length > 0) {
      buildShuffleOrder();
      setTimeout(() => {
        const ld = document.getElementById('frameflow-loader');
        if (ld) ld.style.display = 'none';
        showNext();
      }, 1000);
    }

    // Start scrolling to load more
    autoScroll(settings.targetPhotos || 500,
      (count) => {
        photoUrls = Array.from(collectedUrls);
        const c = document.getElementById('ff-photo-count');
        if (c) c.textContent = count;
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
  // Continuously scrape as user browses
  let scrapeTimer = null, isCollecting = false;
  async function bgScrape() {
    if (isCollecting) return;
    isCollecting = true;
    await scrapeAll();
    isCollecting = false;
  }

  const observer = new MutationObserver(() => {
    clearTimeout(scrapeTimer);
    scrapeTimer = setTimeout(bgScrape, 500);
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
  }
  setInterval(bgScrape, 3000);

  // Initial scrape
  scrapeAll().then(() => console.log('[FrameFlow] Initial:', collectedUrls.size, 'photos'));

})();
