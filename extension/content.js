// FrameFlow Content Script for icloud.com/photos
// Scrapes photo URLs from the page and overlays a slideshow
// Key insight: iCloud uses a VIRTUALIZED grid — photos are removed from the DOM
// as you scroll past them. We must capture URLs continuously and accumulate them.

(function() {
  'use strict';

  // ===== Persistent URL collector =====
  // This Set accumulates ALL photo URLs ever seen, even after DOM elements are removed
  const collectedUrls = new Set();
  const brokenUrls = new Set(); // URLs that failed to load
  let photoUrls = []; // Array version for slideshow indexing

  let isRunning = false;
  let isScrolling = false;
  let settings = {
    shuffle: true,
    transition: 'fade',
    kenBurns: true,
    duration: 8
  };

  let slideTimer = null;
  let controlsTimer = null;
  let scrollInterval = null;
  let currentIndex = -1;
  let shuffledOrder = [];
  let shuffleIndex = 0;
  let activeLayer = 'a';
  let isPaused = false;

  // Exclude patterns — UI elements, icons, etc.
  const EXCLUDE_PATTERNS = [
    /\.svg(\?|$)/i,
    /sprite/i,
    /favicon/i,
    /apple-touch-icon/i,
    /emoji/i,
    /\/ui\//i,
    /\/assets\//i,
    /base64/i
  ];

  const MIN_PHOTO_SIZE = 50;

  // ===== Photo Scraping =====
  function isExcluded(url) {
    if (!url) return true;
    if (url.startsWith('data:') || url.startsWith('blob:')) return true;
    if (url === '' || url === 'about:blank') return true;
    if (url.length < 30) return true; // too short to be a photo URL
    for (const pattern of EXCLUDE_PATTERNS) {
      if (pattern.test(url)) return true;
    }
    return false;
  }

  function extractBgUrl(str) {
    if (!str || str === 'none') return null;
    const match = str.match(/url\(["']?([^"')]+)["']?\)/);
    return match ? match[1] : null;
  }

  // Scrape currently visible photos and ADD them to the persistent set
  function scrapeAndCollect() {
    const before = collectedUrls.size;

    // Collect from all accessible documents (main + iframes)
    const docs = [document];
    try {
      document.querySelectorAll('iframe').forEach(iframe => {
        try {
          if (iframe.contentDocument) docs.push(iframe.contentDocument);
        } catch (e) {}
      });
    } catch (e) {}

    for (const doc of docs) {
      // All <img> elements
      doc.querySelectorAll('img').forEach(img => {
        const src = img.src || '';
        if (isExcluded(src)) return;
        // Size check — skip if we know it's tiny
        if (img.naturalWidth > 0 && img.naturalWidth < MIN_PHOTO_SIZE) return;
        if (img.naturalHeight > 0 && img.naturalHeight < MIN_PHOTO_SIZE) return;
        collectedUrls.add(src);
      });

      // Background images (inline style)
      doc.querySelectorAll('[style*="background"]').forEach(el => {
        const url = extractBgUrl(el.getAttribute('style') || '');
        if (url && !isExcluded(url)) {
          const rect = el.getBoundingClientRect();
          if (rect.width >= MIN_PHOTO_SIZE && rect.height >= MIN_PHOTO_SIZE) {
            collectedUrls.add(url);
          }
        }
      });

      // Computed background images on photo-like elements
      doc.querySelectorAll('div, figure, li, a, span').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width < MIN_PHOTO_SIZE || rect.height < MIN_PHOTO_SIZE) return;
        if (rect.width > 5000) return;
        try {
          const url = extractBgUrl(window.getComputedStyle(el).backgroundImage);
          if (url && !isExcluded(url)) {
            collectedUrls.add(url);
          }
        } catch (e) {}
      });
    }

    const added = collectedUrls.size - before;
    if (added > 0) {
      // Rebuild the array
      photoUrls = Array.from(collectedUrls);
      console.log('[FrameFlow] +' + added + ' new photos (total: ' + photoUrls.length + ')');
    }

    return added;
  }

  // ===== MutationObserver — continuously capture photos as iCloud renders them =====
  let scrapeTimeout = null;

  function startObserving() {
    // Debounced scrape on DOM changes
    const observer = new MutationObserver(() => {
      clearTimeout(scrapeTimeout);
      scrapeTimeout = setTimeout(scrapeAndCollect, 300);
    });

    // Observe main document
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });

    // Also observe iframes
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        if (iframe.contentDocument && iframe.contentDocument.body) {
          observer.observe(iframe.contentDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
        }
      } catch (e) {}
    });

    // Also poll periodically as a fallback (some changes don't trigger mutations)
    setInterval(scrapeAndCollect, 2000);

    return observer;
  }

  // ===== Auto-scroll =====
  function findScrollContainer() {
    // Find the largest scrollable container
    let best = null;
    let bestScore = 0;

    // Check all elements
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const style = window.getComputedStyle(el);
      if (style.overflowY === 'scroll' || style.overflowY === 'auto') {
        if (el.scrollHeight > el.clientHeight + 100) {
          const score = el.scrollHeight - el.clientHeight;
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
      }
    }

    // Also check iframes
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        if (!iframe.contentDocument) return;
        const iframeAll = iframe.contentDocument.querySelectorAll('*');
        for (const el of iframeAll) {
          const style = iframe.contentWindow.getComputedStyle(el);
          if (style.overflowY === 'scroll' || style.overflowY === 'auto') {
            if (el.scrollHeight > el.clientHeight + 100) {
              const score = el.scrollHeight - el.clientHeight;
              if (score > bestScore) {
                bestScore = score;
                best = el;
              }
            }
          }
        }
      } catch (e) {}
    });

    console.log('[FrameFlow] Scroll container:', best ? best.tagName + '.' + best.className.substring(0, 50) : 'document');
    return best || document.documentElement;
  }

  function autoScroll(onProgress, onComplete) {
    const container = findScrollContainer();
    let staleRounds = 0;
    const maxStaleRounds = 15;
    let lastCount = collectedUrls.size;

    isScrolling = true;

    scrollInterval = setInterval(() => {
      if (!isScrolling) {
        clearInterval(scrollInterval);
        onComplete();
        return;
      }

      // Scroll down
      container.scrollTop += container.clientHeight * 0.8;
      window.scrollBy(0, window.innerHeight * 0.8);

      // Scrape
      scrapeAndCollect();

      const currentCount = collectedUrls.size;
      if (currentCount > lastCount) {
        staleRounds = 0;
        onProgress(currentCount);
      } else {
        staleRounds++;
      }
      lastCount = currentCount;

      // Done?
      if (staleRounds >= maxStaleRounds) {
        isScrolling = false;
        clearInterval(scrollInterval);
        onComplete();
      }
    }, 1000);
  }

  function stopScrolling() {
    isScrolling = false;
    if (scrollInterval) {
      clearInterval(scrollInterval);
      scrollInterval = null;
    }
  }

  // ===== DOM Setup =====
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
      <button id="ff-exit" title="Exit">&#10005;</button>
    `;

    const status = document.createElement('div');
    status.id = 'frameflow-status';

    const loader = document.createElement('div');
    loader.id = 'frameflow-loader';
    loader.innerHTML = '<div class="ff-count" id="ff-photo-count">0</div><div class="ff-label">photos found — loading more...</div>';

    document.body.appendChild(overlay);
    document.body.appendChild(controls);
    document.body.appendChild(status);
    document.body.appendChild(loader);

    overlay.addEventListener('click', toggleControls);
    document.getElementById('ff-prev').addEventListener('click', (e) => { e.stopPropagation(); showPrev(); });
    document.getElementById('ff-next').addEventListener('click', (e) => { e.stopPropagation(); showNext(); });
    document.getElementById('ff-playpause').addEventListener('click', (e) => { e.stopPropagation(); togglePause(); });
    document.getElementById('ff-exit').addEventListener('click', (e) => { e.stopPropagation(); stopSlideshow(); });

    document.addEventListener('keydown', handleKeydown);
  }

  function removeOverlay() {
    ['frameflow-overlay', 'frameflow-controls', 'frameflow-status', 'frameflow-loader'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    document.removeEventListener('keydown', handleKeydown);
  }

  function handleKeydown(e) {
    if (!isRunning) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      stopSlideshow();
    } else if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      showNext();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      showPrev();
    }
  }

  // ===== Controls =====
  function toggleControls() {
    const controls = document.getElementById('frameflow-controls');
    if (!controls) return;
    controls.classList.toggle('visible');
    clearTimeout(controlsTimer);
    if (controls.classList.contains('visible')) {
      controlsTimer = setTimeout(() => controls.classList.remove('visible'), 5000);
    }
  }

  function togglePause() {
    isPaused = !isPaused;
    const btn = document.getElementById('ff-playpause');
    if (btn) {
      btn.innerHTML = isPaused ? '&#9654;' : '&#10074;&#10074;';
      btn.title = isPaused ? 'Play' : 'Pause';
    }
    if (isPaused) {
      clearTimeout(slideTimer);
    } else {
      scheduleNext();
    }
  }

  function showStatus(text) {
    const el = document.getElementById('frameflow-status');
    if (!el) return;
    el.textContent = text;
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 3000);
  }

  // ===== Shuffle =====
  function buildShuffleOrder() {
    shuffledOrder = photoUrls.map((_, i) => i);
    for (let i = shuffledOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffledOrder[i];
      shuffledOrder[i] = shuffledOrder[j];
      shuffledOrder[j] = tmp;
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
  function getInactiveLayer() {
    return document.getElementById(activeLayer === 'a' ? 'ff-layer-b' : 'ff-layer-a');
  }
  function getActiveLayerEl() {
    return document.getElementById(activeLayer === 'a' ? 'ff-layer-a' : 'ff-layer-b');
  }

  function clearLayer(layer) {
    if (!layer) return;
    KB_CLASSES.forEach(c => layer.classList.remove(c));
    layer.classList.remove('ff-kenburns', 'slide-enter', 'slide-exit', 'no-transition');
    layer.innerHTML = '';
  }

  function swapLayers() {
    const incoming = getInactiveLayer();
    const outgoing = getActiveLayerEl();
    if (!incoming || !outgoing) return;

    if (settings.transition === 'fade') {
      incoming.classList.add('active');
      outgoing.classList.remove('active');
    } else if (settings.transition === 'slide') {
      incoming.classList.remove('slide-enter', 'slide-exit');
      outgoing.classList.remove('slide-enter', 'slide-exit');
      void incoming.offsetWidth;
      incoming.classList.add('slide-enter');
      void incoming.offsetWidth;
      incoming.classList.add('active');
      outgoing.classList.add('slide-exit');
      outgoing.classList.remove('active');
    } else {
      incoming.classList.add('no-transition', 'active');
      outgoing.classList.remove('active');
      setTimeout(() => incoming.classList.remove('no-transition'), 50);
    }
    activeLayer = activeLayer === 'a' ? 'b' : 'a';
  }

  let errorCount = 0; // consecutive errors
  const MAX_CONSECUTIVE_ERRORS = 10;

  function loadSlide(index) {
    if (index < 0 || index >= photoUrls.length) return;

    // Too many consecutive errors — stop trying
    if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
      showStatus('Most photos failed to load. Try scrolling iCloud Photos first.');
      errorCount = 0;
      return;
    }

    const url = photoUrls[index];

    // Skip known broken URLs
    if (brokenUrls.has(url)) {
      errorCount++;
      setTimeout(showNext, 50);
      return;
    }

    const layer = getInactiveLayer();
    if (!layer) return;

    clearLayer(layer);
    currentIndex = index;

    const img = document.createElement('img');
    img.onload = () => {
      errorCount = 0; // reset on success
      applyKenBurns(layer);
      swapLayers();
      scheduleNext();
    };
    img.onerror = () => {
      brokenUrls.add(url);
      errorCount++;
      console.warn('[FrameFlow] Failed to load:', url.substring(0, 80) + '...');
      setTimeout(showNext, 200);
    };
    img.src = url;
    layer.appendChild(img);
  }

  function showNext() {
    clearTimeout(slideTimer);
    const idx = getNextIndex();
    if (idx >= 0) loadSlide(idx);
  }

  function showPrev() {
    clearTimeout(slideTimer);
    const idx = getPrevIndex();
    if (idx >= 0) loadSlide(idx);
  }

  function scheduleNext() {
    clearTimeout(slideTimer);
    if (!isPaused && photoUrls.length > 0) {
      slideTimer = setTimeout(showNext, settings.duration * 1000);
    }
  }

  // ===== Start / Stop =====
  function startSlideshow(opts) {
    if (opts) Object.assign(settings, opts);

    isRunning = true;
    isPaused = false;
    currentIndex = -1;
    activeLayer = 'a';

    // Use whatever we've accumulated so far
    photoUrls = Array.from(collectedUrls);

    createOverlay();
    const overlay = document.getElementById('frameflow-overlay');
    const loader = document.getElementById('frameflow-loader');
    const countEl = document.getElementById('ff-photo-count');

    overlay.classList.add('active');

    if (photoUrls.length > 0) {
      if (countEl) countEl.textContent = photoUrls.length;
      buildShuffleOrder();
      setTimeout(() => {
        if (loader) loader.style.display = 'none';
        showNext();
      }, 1000);
    } else {
      if (countEl) countEl.textContent = '0';
    }

    // Auto-scroll to load more
    autoScroll(
      (count) => {
        photoUrls = Array.from(collectedUrls);
        if (countEl) countEl.textContent = count;

        if (currentIndex < 0 && count > 0) {
          buildShuffleOrder();
          setTimeout(() => {
            if (loader) loader.style.display = 'none';
            showNext();
          }, 500);
        }

        // Extend shuffle with new photos
        if (settings.shuffle) {
          for (let i = shuffledOrder.length; i < photoUrls.length; i++) {
            shuffledOrder.splice(Math.floor(Math.random() * (shuffledOrder.length + 1)), 0, i);
          }
        }
      },
      () => {
        photoUrls = Array.from(collectedUrls);
        showStatus(photoUrls.length + ' photos loaded');
        if (loader) loader.style.display = 'none';
        if (photoUrls.length === 0) {
          showStatus('No photos found. Try scrolling the page manually first, then retry.');
        }
      }
    );

    return photoUrls.length;
  }

  function stopSlideshow() {
    isRunning = false;
    isPaused = false;
    clearTimeout(slideTimer);
    stopScrolling();
    removeOverlay();
    currentIndex = -1;
    // Don't clear collectedUrls — keep them for next time
  }

  // ===== Message Handler =====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({
        ok: true,
        running: isRunning,
        photoCount: collectedUrls.size // always use accumulated count
      });
    } else if (msg.type === 'START_SLIDESHOW') {
      const count = startSlideshow(msg.settings);
      sendResponse({ ok: true, photoCount: count });
    } else if (msg.type === 'STOP_SLIDESHOW') {
      stopSlideshow();
      sendResponse({ ok: true });
    }
    return true;
  });

  // ===== Initialize =====
  // Start observing and collecting immediately
  console.log('[FrameFlow] Content script loaded on', window.location.href);
  scrapeAndCollect();
  startObserving();

})();
