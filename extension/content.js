// FrameFlow Content Script for icloud.com/photos
// Scrapes photo URLs from the page and overlays a slideshow

(function() {
  'use strict';

  // ===== State =====
  let photoUrls = [];
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
  let observer = null;
  let currentIndex = -1;
  let shuffledOrder = [];
  let shuffleIndex = 0;
  let activeLayer = 'a';

  // Exclude patterns — UI elements, icons, etc.
  const EXCLUDE_PATTERNS = [
    /\.svg(\?|$)/i,
    /sprite/i,
    /\/icon/i,
    /favicon/i,
    /apple-touch-icon/i,
    /emoji/i,
    /avatar/i
  ];

  const MIN_PHOTO_SIZE = 40; // pixels — skip images smaller than this

  // ===== Photo Scraping =====
  function isExcluded(url) {
    if (!url) return true;
    if (url.startsWith('data:') || url === '' || url === 'about:blank') return true;
    for (const pattern of EXCLUDE_PATTERNS) {
      if (pattern.test(url)) return true;
    }
    return false;
  }

  function extractUrl(str) {
    // Extract URL from background-image value like url("...")
    if (!str || str === 'none') return null;
    const match = str.match(/url\(["']?([^"')]+)["']?\)/);
    return match ? match[1] : null;
  }

  function scrapePhotos() {
    const urls = new Set();

    // Scrape ALL frames (iCloud loads content in iframes)
    const documents = [document];
    try {
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach(iframe => {
        try {
          if (iframe.contentDocument) {
            documents.push(iframe.contentDocument);
          }
        } catch (e) { /* cross-origin, skip */ }
      });
    } catch (e) {}

    for (const doc of documents) {
      // Strategy 1: All <img> elements
      doc.querySelectorAll('img').forEach(img => {
        const src = img.src || img.getAttribute('src') || '';
        if (isExcluded(src)) return;
        // Skip tiny images (UI icons)
        if (img.naturalWidth > 0 && img.naturalWidth < MIN_PHOTO_SIZE) return;
        if (img.naturalHeight > 0 && img.naturalHeight < MIN_PHOTO_SIZE) return;
        // Skip if rendered very small and has no natural size yet
        if (img.width > 0 && img.width < MIN_PHOTO_SIZE && img.height > 0 && img.height < MIN_PHOTO_SIZE) return;
        urls.add(src);
      });

      // Strategy 2: All inline background-image styles
      doc.querySelectorAll('[style*="background"]').forEach(el => {
        const style = el.getAttribute('style') || '';
        const url = extractUrl(style);
        if (url && !isExcluded(url)) {
          // Check element size — skip tiny UI elements
          const rect = el.getBoundingClientRect();
          if (rect.width >= MIN_PHOTO_SIZE && rect.height >= MIN_PHOTO_SIZE) {
            urls.add(url);
          }
        }
      });

      // Strategy 3: Computed background-image on ALL elements with substantial size
      // (expensive but thorough — iCloud may use CSS classes instead of inline styles)
      doc.querySelectorAll('div, span, figure, section, article, li, a').forEach(el => {
        const rect = el.getBoundingClientRect();
        // Only check elements that are visible and photo-sized
        if (rect.width < MIN_PHOTO_SIZE || rect.height < MIN_PHOTO_SIZE) return;
        if (rect.width > 5000) return; // skip full-page containers
        try {
          const bg = window.getComputedStyle(el).backgroundImage;
          const url = extractUrl(bg);
          if (url && !isExcluded(url)) {
            urls.add(url);
          }
        } catch (e) {}
      });

      // Strategy 4: <video> and <source> elements (iCloud may have Live Photos)
      doc.querySelectorAll('video source, video[src]').forEach(el => {
        const src = el.src || el.getAttribute('src') || '';
        if (src && !isExcluded(src)) {
          urls.add(src);
        }
      });

      // Strategy 5: Canvas elements — check if they have a data URL we can grab
      // (some photo apps render to canvas)
      doc.querySelectorAll('canvas').forEach(canvas => {
        if (canvas.width >= MIN_PHOTO_SIZE && canvas.height >= MIN_PHOTO_SIZE) {
          try {
            const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
            if (dataUrl && dataUrl.length > 1000) { // skip blank canvases
              urls.add(dataUrl);
            }
          } catch (e) { /* tainted canvas, skip */ }
        }
      });
    }

    // Log what we found for debugging
    console.log('[FrameFlow] Scraped ' + urls.size + ' photos from ' + documents.length + ' document(s)');
    if (urls.size === 0) {
      // Debug: log what IS on the page
      console.log('[FrameFlow] Debug — img elements found:', document.querySelectorAll('img').length);
      console.log('[FrameFlow] Debug — iframes found:', document.querySelectorAll('iframe').length);
      const allImgs = document.querySelectorAll('img');
      allImgs.forEach((img, i) => {
        if (i < 10) console.log('[FrameFlow] img[' + i + ']:', img.src, 'size:', img.naturalWidth + 'x' + img.naturalHeight);
      });
    }

    return Array.from(urls);
  }

  // ===== Auto-scroll to load all photos =====
  function findScrollContainer() {
    // Try to find the scrollable container in iCloud Photos
    // Look for elements with overflow scroll/auto and substantial height
    const candidates = document.querySelectorAll('*');
    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      const overflow = style.overflowY;
      if (overflow === 'scroll' || overflow === 'auto') {
        if (el.scrollHeight > el.clientHeight + 100) {
          const score = el.scrollHeight - el.clientHeight;
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
      }
    }

    return best || document.documentElement;
  }

  function autoScroll(onProgress, onComplete) {
    const container = findScrollContainer();
    let lastPhotoCount = 0;
    let staleRounds = 0;
    const maxStaleRounds = 10; // Stop after 10 rounds with no new photos

    isScrolling = true;

    // Scroll to bottom repeatedly
    scrollInterval = setInterval(() => {
      if (!isScrolling) {
        clearInterval(scrollInterval);
        onComplete();
        return;
      }

      // Scroll down
      container.scrollTop = container.scrollHeight;

      // Also try window scroll
      window.scrollTo(0, document.body.scrollHeight);

      // Scrape new photos
      const newUrls = scrapePhotos();
      const newCount = newUrls.length;

      // Merge into main list (dedup)
      const existing = new Set(photoUrls);
      let added = 0;
      for (const url of newUrls) {
        if (!existing.has(url)) {
          photoUrls.push(url);
          added++;
        }
      }

      if (added > 0) {
        staleRounds = 0;
        onProgress(photoUrls.length);
      } else {
        staleRounds++;
      }

      lastPhotoCount = photoUrls.length;

      // Check if we've reached the end
      if (staleRounds >= maxStaleRounds) {
        isScrolling = false;
        clearInterval(scrollInterval);
        onComplete();
      }
    }, 800);
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
    // Remove existing if any
    removeOverlay();

    const overlay = document.createElement('div');
    overlay.id = 'frameflow-overlay';
    overlay.innerHTML = `
      <div id="ff-layer-a" class="ff-layer active"></div>
      <div id="ff-layer-b" class="ff-layer"></div>
    `;

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
    loader.innerHTML = `
      <div class="ff-count" id="ff-photo-count">0</div>
      <div class="ff-label">photos found — loading more...</div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(controls);
    document.body.appendChild(status);
    document.body.appendChild(loader);

    // Event listeners
    overlay.addEventListener('click', toggleControls);

    document.getElementById('ff-prev').addEventListener('click', (e) => {
      e.stopPropagation();
      showPrev();
    });

    document.getElementById('ff-next').addEventListener('click', (e) => {
      e.stopPropagation();
      showNext();
    });

    document.getElementById('ff-playpause').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePause();
    });

    document.getElementById('ff-exit').addEventListener('click', (e) => {
      e.stopPropagation();
      stopSlideshow();
    });

    // ESC key to exit
    document.addEventListener('keydown', handleKeydown);
  }

  function removeOverlay() {
    const ids = ['frameflow-overlay', 'frameflow-controls', 'frameflow-status', 'frameflow-loader'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    document.removeEventListener('keydown', handleKeydown);
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      stopSlideshow();
    } else if (e.key === 'ArrowRight' || e.key === ' ') {
      showNext();
    } else if (e.key === 'ArrowLeft') {
      showPrev();
    }
  }

  // ===== Controls =====
  let isPaused = false;

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
    const status = document.getElementById('frameflow-status');
    if (!status) return;
    status.textContent = text;
    status.classList.add('visible');
    setTimeout(() => status.classList.remove('visible'), 3000);
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
      if (shuffleIndex >= shuffledOrder.length) {
        buildShuffleOrder();
      }
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
      const variant = KB_CLASSES[Math.floor(Math.random() * KB_CLASSES.length)];
      layer.classList.add('ff-kenburns', variant);
    }
  }

  // ===== Slideshow Engine =====
  function getLayerA() { return document.getElementById('ff-layer-a'); }
  function getLayerB() { return document.getElementById('ff-layer-b'); }

  function getInactiveLayer() {
    return activeLayer === 'a' ? getLayerB() : getLayerA();
  }

  function getActiveLayerEl() {
    return activeLayer === 'a' ? getLayerA() : getLayerB();
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
      incoming.classList.add('no-transition');
      incoming.classList.add('active');
      outgoing.classList.remove('active');
      setTimeout(() => incoming.classList.remove('no-transition'), 50);
    }

    activeLayer = activeLayer === 'a' ? 'b' : 'a';
  }

  function loadSlide(index) {
    if (index < 0 || index >= photoUrls.length) return;

    const url = photoUrls[index];
    const layer = getInactiveLayer();
    if (!layer) return;

    clearLayer(layer);
    currentIndex = index;

    const img = document.createElement('img');
    img.onload = () => {
      applyKenBurns(layer);
      swapLayers();
      scheduleNext();
    };
    img.onerror = () => {
      // Skip broken image
      setTimeout(showNext, 100);
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
    if (opts) {
      Object.assign(settings, opts);
    }

    isRunning = true;
    isPaused = false;
    photoUrls = [];
    currentIndex = -1;
    activeLayer = 'a';

    // Initial scrape
    photoUrls = scrapePhotos();

    createOverlay();

    const overlay = document.getElementById('frameflow-overlay');
    const loader = document.getElementById('frameflow-loader');
    const countEl = document.getElementById('ff-photo-count');

    overlay.classList.add('active');

    if (photoUrls.length > 0) {
      // Start slideshow immediately with what we have
      if (countEl) countEl.textContent = photoUrls.length;
      buildShuffleOrder();

      // Start showing slides after a brief moment
      setTimeout(() => {
        if (loader) loader.style.display = 'none';
        showNext();
      }, 1500);
    } else {
      if (countEl) countEl.textContent = '0';
    }

    // Continue scrolling to load more photos in background
    autoScroll(
      (count) => {
        // Progress callback — update counter and rebuild shuffle if needed
        if (countEl) countEl.textContent = count;

        // If slideshow hasn't started yet and we now have photos, start it
        if (currentIndex < 0 && count > 0) {
          buildShuffleOrder();
          setTimeout(() => {
            if (loader) loader.style.display = 'none';
            showNext();
          }, 500);
        }

        // Rebuild shuffle order to include new photos
        if (settings.shuffle && count > shuffledOrder.length) {
          // Extend shuffle order with new indices
          for (let i = shuffledOrder.length; i < count; i++) {
            // Insert new indices at random positions
            const pos = Math.floor(Math.random() * (shuffledOrder.length + 1));
            shuffledOrder.splice(pos, 0, i);
          }
        }
      },
      () => {
        // Complete callback
        showStatus(photoUrls.length + ' photos loaded');
        if (loader) loader.style.display = 'none';

        if (photoUrls.length === 0) {
          showStatus('No photos found — try scrolling the page first');
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
    photoUrls = [];
    currentIndex = -1;
  }

  // ===== Message Handler =====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      // Quick scrape to report photo count
      const quickScrape = scrapePhotos();
      sendResponse({
        ok: true,
        running: isRunning,
        photoCount: isRunning ? photoUrls.length : quickScrape.length
      });
    } else if (msg.type === 'START_SLIDESHOW') {
      const count = startSlideshow(msg.settings);
      sendResponse({ ok: true, photoCount: count });
    } else if (msg.type === 'STOP_SLIDESHOW') {
      stopSlideshow();
      sendResponse({ ok: true });
    }
    return true; // Keep channel open for async
  });

  // Watch for dynamically loaded images
  observer = new MutationObserver(() => {
    // Only actively scrape during scroll phase
    // The scroll handler already scrapes periodically
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

})();
