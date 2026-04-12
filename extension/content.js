// FrameFlow Content Script for icloud.com/photos
// Runs in ALL frames via manifest all_frames:true.
// - Iframe instances: find photo positions, report to top frame
// - Top frame instance: overlay, slideshow, hi-res capture via debugger

(function() {
  'use strict';

  const isTop = (window === window.top);
  console.log('[FrameFlow]', isTop ? 'TOP' : 'IFRAME', window.location.href.substring(0, 60));

  // ================================================================
  // IFRAME INSTANCE — capture photos directly (same-origin as blobs)
  // ================================================================
  if (!isTop) {
    const iframeCanvas = document.createElement('canvas');
    const iframeCtx = iframeCanvas.getContext('2d');
    let lastCapturedSrc = '';

    function reportPhotoPositions() {
      const photos = [];
      document.querySelectorAll('img').forEach(img => {
        if (img.naturalWidth < 30 || img.naturalHeight < 30) return;
        if (!img.complete) return;
        const rect = img.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return;
        photos.push({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          w: img.naturalWidth,
          h: img.naturalHeight,
          rectW: Math.round(rect.width),
          rectH: Math.round(rect.height)
        });
      });

      if (photos.length > 0) {
        window.top.postMessage({
          type: 'FRAMEFLOW_PHOTO_POSITIONS',
          photos
        }, '*');
      }
    }

    // Try to capture the largest image and send it as a data URL to top frame
    function capturelargestImage() {
      let best = null, bestSize = 0;
      document.querySelectorAll('img').forEach(img => {
        if (!img.complete) return;
        const size = img.naturalWidth * img.naturalHeight;
        if (size > bestSize) { bestSize = size; best = img; }
      });

      if (!best || best.naturalWidth < 100 || best.naturalHeight < 100) return;

      const src = best.src || '';
      // Only capture if this is a new/different image
      const key = src + '_' + best.naturalWidth + 'x' + best.naturalHeight;
      if (key === lastCapturedSrc) return;

      try {
        const maxDim = 4096;
        let w = best.naturalWidth, h = best.naturalHeight;
        if (w > maxDim || h > maxDim) {
          const s = maxDim / Math.max(w, h);
          w = Math.round(w * s); h = Math.round(h * s);
        }
        iframeCanvas.width = w;
        iframeCanvas.height = h;
        iframeCtx.drawImage(best, 0, 0, w, h);

        // Convert to data URL — this works because we're same-origin with the blob
        const dataUrl = iframeCanvas.toDataURL('image/jpeg', 0.95);
        if (dataUrl && dataUrl.length > 1000) {
          lastCapturedSrc = key;
          window.top.postMessage({
            type: 'FRAMEFLOW_PHOTO_DATA',
            dataUrl,
            width: best.naturalWidth,
            height: best.naturalHeight
          }, '*');
          console.log('[FrameFlow/iframe] Captured', best.naturalWidth + 'x' + best.naturalHeight, 'image');
        }
      } catch (e) {
        // Still tainted? Log but don't spam
        if (!capturelargestImage._logged) {
          console.log('[FrameFlow/iframe] Canvas capture failed:', e.message);
          capturelargestImage._logged = true;
        }
      }
    }

    // ===== Video detection and recording =====
    let isRecording = false;

    function detectMedia() {
      // Check if the current detail view shows a video
      const videos = document.querySelectorAll('video');
      let bestVideo = null;
      for (const v of videos) {
        if (v.videoWidth > 100 && v.videoHeight > 100) {
          bestVideo = v;
          break;
        }
      }

      if (bestVideo) {
        window.top.postMessage({
          type: 'FRAMEFLOW_MEDIA_TYPE',
          mediaType: 'video',
          duration: bestVideo.duration || 0,
          width: bestVideo.videoWidth,
          height: bestVideo.videoHeight
        }, '*');
      } else {
        window.top.postMessage({ type: 'FRAMEFLOW_MEDIA_TYPE', mediaType: 'photo' }, '*');
      }
    }

    async function recordVideo() {
      if (isRecording) return;

      const videos = document.querySelectorAll('video');
      let video = null;
      for (const v of videos) {
        if (v.videoWidth > 100 && v.videoHeight > 100) { video = v; break; }
      }

      if (!video) {
        window.top.postMessage({ type: 'FRAMEFLOW_VIDEO_DATA', data: null, error: 'No video found' }, '*');
        return;
      }

      isRecording = true;
      console.log('[FrameFlow/iframe] Recording video', video.videoWidth + 'x' + video.videoHeight, 'duration:', video.duration);

      try {
        // Ensure video is playing from the start
        video.currentTime = 0;
        video.play().catch(() => {});

        // Get stream from video element
        const stream = video.captureStream();

        // Pick best supported codec
        const codecs = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
        let mimeType = 'video/webm';
        for (const c of codecs) {
          if (MediaRecorder.isTypeSupported(c)) { mimeType = c; break; }
        }

        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks = [];

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = async () => {
          isRecording = false;
          const blob = new Blob(chunks, { type: mimeType });
          console.log('[FrameFlow/iframe] Video recorded:', (blob.size / 1024 / 1024).toFixed(1) + 'MB');

          // Convert to ArrayBuffer and send to top frame
          const buffer = await blob.arrayBuffer();
          window.top.postMessage({
            type: 'FRAMEFLOW_VIDEO_DATA',
            data: buffer,
            mimeType,
            duration: video.duration,
            width: video.videoWidth,
            height: video.videoHeight
          }, '*', [buffer]); // transfer, don't copy
        };

        recorder.onerror = () => {
          isRecording = false;
          window.top.postMessage({ type: 'FRAMEFLOW_VIDEO_DATA', data: null, error: 'Recording failed' }, '*');
        };

        recorder.start();

        // Stop when video ends or after max duration
        const maxDuration = Math.min((video.duration || 60) + 2, 120) * 1000;

        const stopRecording = () => {
          if (recorder.state === 'recording') {
            recorder.stop();
          }
        };

        video.addEventListener('ended', stopRecording, { once: true });
        setTimeout(() => {
          video.removeEventListener('ended', stopRecording);
          stopRecording();
        }, maxDuration);

      } catch (e) {
        isRecording = false;
        console.warn('[FrameFlow/iframe] Video capture failed:', e.message);
        window.top.postMessage({ type: 'FRAMEFLOW_VIDEO_DATA', data: null, error: e.message }, '*');
      }
    }

    // Listen for capture requests from top frame
    window.addEventListener('message', (e) => {
      if (!e.data) return;
      if (e.data.type === 'FRAMEFLOW_REQUEST_CAPTURE') {
        capturelargestImage();
      }
      if (e.data.type === 'FRAMEFLOW_DETECT_MEDIA') {
        detectMedia();
      }
      if (e.data.type === 'FRAMEFLOW_REQUEST_VIDEO_CAPTURE') {
        recordVideo();
      }
    });

    // Report positions and try to capture periodically
    reportPhotoPositions();
    setInterval(reportPhotoPositions, 3000);
    setInterval(capturelargestImage, 1000);

    // Report on DOM changes
    const obs = new MutationObserver(() => {
      clearTimeout(obs._t);
      obs._t = setTimeout(() => {
        reportPhotoPositions();
        capturelargestImage();
      }, 500);
    });
    if (document.body) {
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }

    return;
  }

  // ================================================================
  // TOP FRAME INSTANCE — everything else
  // ================================================================

  // Media items: array of { type: 'photo'|'video', url: string }
  const collectedMedia = [];
  const collectedUrlSet = new Set(); // dedup
  const hiddenUrls = new Set();
  const brokenUrls = new Set();
  let mediaItems = []; // filtered (non-hidden) items for slideshow
  // Backward compat alias
  let photoUrls = [];

  function addMedia(type, url) {
    if (collectedUrlSet.has(url)) return false;
    collectedUrlSet.add(url);
    collectedMedia.push({ type, url });
    return true;
  }

  function rebuildPhotoUrls() {
    mediaItems = collectedMedia.filter(m => !hiddenUrls.has(m.url));
    photoUrls = mediaItems.map(m => m.url);
    return photoUrls;
  }

  let isMuted = false;
  let isRunning = false, isPaused = false;
  let settings = {
    shuffle: true, transition: 'fade', fill: 'contain',
    kenBurns: true, duration: 8, targetPhotos: 500, hiRes: false
  };
  let slideTimer = null, controlsTimer = null, scrollTimer = null;
  let currentIndex = -1, shuffledOrder = [], shuffleIndex = 0;
  let activeLayer = 'a';
  let viewHistory = [], historyPos = -1;

  // Photo positions and data reported by iframe instances
  let iframePhotoPositions = [];
  let iframeElement = null;
  let iframeSource = null; // the iframe's contentWindow for sending messages back
  let pendingPhotoResolve = null;
  let pendingMediaTypeResolve = null;
  let pendingVideoResolve = null;
  let iframeCanCapture = false; // whether the iframe can capture (same-origin)

  window.addEventListener('message', (e) => {
    if (!e.data) return;

    if (e.data.type === 'FRAMEFLOW_PHOTO_POSITIONS') {
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentWindow === e.source) { iframeElement = f; iframeSource = e.source; } } catch (err) {}
      });

      const iframeRect = iframeElement ? iframeElement.getBoundingClientRect() : { left: 0, top: 0 };
      iframePhotoPositions = e.data.photos.map(p => ({
        x: p.x + iframeRect.left, y: p.y + iframeRect.top,
        w: p.w, h: p.h, rectW: p.rectW, rectH: p.rectH
      }));
      console.log('[FrameFlow] Received', iframePhotoPositions.length, 'photo positions from iframe');
    }

    if (e.data.type === 'FRAMEFLOW_PHOTO_DATA') {
      iframeCanCapture = true;
      console.log('[FrameFlow] Received photo data from iframe:', e.data.width + 'x' + e.data.height);

      if (pendingPhotoResolve) {
        pendingPhotoResolve(e.data.dataUrl);
        pendingPhotoResolve = null;
      } else {
        addMedia('photo', e.data.dataUrl);
        photoUrls = rebuildPhotoUrls();
      }
    }

    // Media type detection response
    if (e.data.type === 'FRAMEFLOW_MEDIA_TYPE') {
      if (pendingMediaTypeResolve) {
        pendingMediaTypeResolve(e.data);
        pendingMediaTypeResolve = null;
      }
    }

    // Video recording result
    if (e.data.type === 'FRAMEFLOW_VIDEO_DATA') {
      if (e.data.data) {
        const blob = new Blob([e.data.data], { type: e.data.mimeType || 'video/webm' });
        const url = URL.createObjectURL(blob);
        addMedia('video', url);
        photoUrls = rebuildPhotoUrls();
        console.log('[FrameFlow] Received video:', (blob.size / 1024 / 1024).toFixed(1) + 'MB');
      } else {
        console.warn('[FrameFlow] Video capture failed:', e.data.error);
      }
      if (pendingVideoResolve) {
        pendingVideoResolve(e.data.data ? true : false);
        pendingVideoResolve = null;
      }
    }
  });

  // Request a photo capture from the iframe (returns a promise)
  function requestIframeCapture(timeoutMs) {
    return new Promise(resolve => {
      if (!iframeSource) { resolve(null); return; }
      iframeSource.postMessage({ type: 'FRAMEFLOW_REQUEST_CAPTURE' }, '*');
      pendingPhotoResolve = resolve;
      setTimeout(() => {
        if (pendingPhotoResolve === resolve) {
          pendingPhotoResolve = null;
          resolve(null);
        }
      }, timeoutMs || 3000);
    });
  }

  // Ask iframe what media type the detail view is showing
  function requestMediaType(timeoutMs) {
    return new Promise(resolve => {
      if (!iframeSource) { resolve({ mediaType: 'photo' }); return; }
      iframeSource.postMessage({ type: 'FRAMEFLOW_DETECT_MEDIA' }, '*');
      pendingMediaTypeResolve = resolve;
      setTimeout(() => {
        if (pendingMediaTypeResolve === resolve) { pendingMediaTypeResolve = null; resolve({ mediaType: 'photo' }); }
      }, timeoutMs || 2000);
    });
  }

  // Ask iframe to record the current video
  function requestVideoCapture(timeoutMs) {
    return new Promise(resolve => {
      if (!iframeSource) { resolve(false); return; }
      iframeSource.postMessage({ type: 'FRAMEFLOW_REQUEST_VIDEO_CAPTURE' }, '*');
      pendingVideoResolve = resolve;
      setTimeout(() => {
        if (pendingVideoResolve === resolve) { pendingVideoResolve = null; resolve(false); }
      }, timeoutMs || 120000); // up to 2 min for long videos
    });
  }

  function updateHiddenCount() {
    const btn = document.getElementById('ff-btn-unhide-all');
    if (btn) btn.textContent = 'Unhide All (' + hiddenUrls.size + ' hidden)';
  }

  function saveExtSettings() {
    chrome.storage.local.set({ frameflow_settings: settings });
  }

  // ===== Chrome debugger helpers =====
  function sendMessage(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, response => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    });
  }

  // Crop canvas for extracting the photo from a full-page screenshot
  const cropCanvas = document.createElement('canvas');
  const cropCtx = cropCanvas.getContext('2d');

  async function captureScreenshot() {
    const resp = await sendMessage({ type: 'CAPTURE_TAB' });
    if (!resp || !resp.dataUrl) return null;

    // Crop the screenshot to remove iCloud UI (top bar, bottom carousel)
    // iCloud detail view layout:
    //   - Top ~44-60px: navigation/close button bar
    //   - Bottom ~80-120px: thumbnail carousel strip
    //   - Left/Right: arrow buttons (small, ok to include)
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;

        // Crop percentages (these work for iCloud's detail view layout)
        const topCrop = Math.round(h * 0.06);    // ~6% from top (nav bar)
        const bottomCrop = Math.round(h * 0.12);  // ~12% from bottom (carousel)
        const sideCrop = Math.round(w * 0.02);    // ~2% from sides (minimal)

        const cw = w - sideCrop * 2;
        const ch = h - topCrop - bottomCrop;

        cropCanvas.width = cw;
        cropCanvas.height = ch;
        cropCtx.drawImage(img, sideCrop, topCrop, cw, ch, 0, 0, cw, ch);

        cropCanvas.toBlob(blob => {
          resolve(blob ? URL.createObjectURL(blob) : resp.dataUrl);
        }, 'image/jpeg', 0.95);
      };
      img.onerror = () => resolve(resp.dataUrl); // fallback to uncropped
      img.src = resp.dataUrl;
    });
  }

  async function sendRealKey(key) {
    return sendMessage({ type: 'SEND_KEY', key });
  }

  async function sendRealClick(x, y) {
    return sendMessage({ type: 'CLICK_AT', x, y });
  }

  // ===== Hi-Res Mode =====
  // User manually opens a photo first (one click), then we capture + auto-advance.
  async function loadHiResPhotos(target, onProgress, onDone) {
    const maxTarget = target || 10;
    const overlay = document.getElementById('frameflow-overlay');

    // Check if we already have enough cached photos
    if (collectedMedia.length >= maxTarget) {
      console.log('[FrameFlow] Using', collectedMedia.length, 'cached photos');
      onDone();
      return;
    }

    // Hide overlay and show instructions
    if (overlay) overlay.style.display = 'none';
    const ld = document.getElementById('frameflow-loader');
    if (ld) ld.style.display = 'none';

    const instrDiv = document.createElement('div');
    instrDiv.id = 'ff-hires-instructions';
    instrDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:999998;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;color:#fff;text-align:center;pointer-events:none;';
    instrDiv.innerHTML = '<div style="max-width:400px;padding:40px;background:rgba(0,0,0,0.85);border-radius:16px;backdrop-filter:blur(20px);pointer-events:auto">' +
      '<div style="font-size:22px;font-weight:700;margin-bottom:12px">Click any photo</div>' +
      '<div style="font-size:15px;color:rgba(255,255,255,0.6);margin-bottom:20px">Click a photo in iCloud to open it full-size.<br>FrameFlow will then auto-capture ' + maxTarget + ' photos.</div>' +
      '<div style="font-size:13px;color:rgba(255,255,255,0.4)">Waiting for you to open a photo...</div>' +
      '</div>';
    document.body.appendChild(instrDiv);

    // Wait for user to click a photo (detect by watching for a large image to appear)
    let waitTimeout;
    let checkCount = 0;

    function checkForDetailView() {
      checkCount++;
      // Look across all docs for a large image (detail view)
      let found = false;
      const docs = [document];
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {}
      });

      for (const doc of docs) {
        for (const img of doc.querySelectorAll('img')) {
          // Detail view images are much larger than grid thumbnails
          if (img.complete && img.naturalWidth > 500 && img.naturalHeight > 500) {
            found = true;
            break;
          }
        }
        if (found) break;
      }

      // Also check if the page layout changed significantly (detail view has different structure)
      if (!found) {
        // Check for common detail view indicators
        const fullscreenEls = document.querySelectorAll('[class*="detail"], [class*="viewer"], [class*="fullscreen"], [class*="preview"]');
        if (fullscreenEls.length > 0) found = true;
      }

      if (found || checkCount > 300) { // 5 min timeout
        instrDiv.remove();
        if (found) {
          console.log('[FrameFlow] Detail view detected! Starting capture.');
          startCapture();
        } else {
          console.log('[FrameFlow] Timed out waiting for detail view');
          if (overlay) overlay.style.display = '';
          onDone();
        }
        return;
      }

      waitTimeout = setTimeout(checkForDetailView, 1000);
    }

    checkForDetailView();

    // The actual capture loop (runs after user opens a photo)
    async function startCapture() {
      await new Promise(r => setTimeout(r, 1500));

      let captured = 0;
      let lastDataUrl = null;
      let staleCount = 0;

      const progressDiv = document.createElement('div');
      progressDiv.id = 'ff-hires-progress';
      progressDiv.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(0,0,0,0.85);backdrop-filter:blur(10px);padding:12px 24px;border-radius:10px;font-family:-apple-system,sans-serif;color:#fff;font-size:14px;pointer-events:none;';
      progressDiv.textContent = 'Capturing 0 / ' + maxTarget;
      document.body.appendChild(progressDiv);

      async function step() {
        if (!isRunning || captured >= maxTarget) { finish(); return; }

        // Detect if this is a video or photo
        const mediaInfo = await requestMediaType(1500);

        if (mediaInfo.mediaType === 'video') {
          // Record the video
          progressDiv.textContent = 'Recording video ' + (captured + 1) + ' / ' + maxTarget + '...';
          console.log('[FrameFlow] Video detected, recording... duration:', mediaInfo.duration);

          const success = await requestVideoCapture((mediaInfo.duration || 60) * 1000 + 5000);
          if (success) {
            captured++;
            staleCount = 0;
            progressDiv.textContent = 'Captured ' + captured + ' / ' + maxTarget;
            onProgress(captured);
            photoUrls = rebuildPhotoUrls();
            console.log('[FrameFlow] #' + captured + ' video recorded');
          } else {
            // Video recording failed — capture a screenshot instead
            console.log('[FrameFlow] Video recording failed, capturing screenshot');
            let dataUrl = await requestIframeCapture(2000);
            if (!dataUrl) {
              progressDiv.style.display = 'none';
              await new Promise(r => setTimeout(r, 150));
              dataUrl = await captureScreenshot();
              progressDiv.style.display = '';
            }
            if (dataUrl) {
              addMedia('photo', dataUrl);
              captured++;
              photoUrls = rebuildPhotoUrls();
            }
            staleCount++;
          }
        } else {
          // Photo — existing capture logic
          let dataUrl = await requestIframeCapture(2000);
          if (!dataUrl) {
            progressDiv.style.display = 'none';
            await new Promise(r => setTimeout(r, 150));
            dataUrl = await captureScreenshot();
            progressDiv.style.display = '';
          }

          if (dataUrl && dataUrl !== lastDataUrl) {
            lastDataUrl = dataUrl;
            addMedia('photo', dataUrl);
            captured++;
            staleCount = 0;
            progressDiv.textContent = 'Capturing ' + captured + ' / ' + maxTarget;
            onProgress(captured);
            photoUrls = rebuildPhotoUrls();
            console.log('[FrameFlow] #' + captured + ' photo captured');
          } else {
            staleCount++;
          }
        }

        if (staleCount > 8) { finish(); return; }

        // Advance to next photo via debugger
        await sendRealKey('ArrowRight');
        await new Promise(r => setTimeout(r, 2000));
        scrollTimer = setTimeout(step, 100);
      }

      async function finish() {
        progressDiv.remove();
        // Close detail view
        await sendRealKey('Escape');
        await new Promise(r => setTimeout(r, 800));

        photoUrls = rebuildPhotoUrls();
        console.log('[FrameFlow] Captured', captured, 'photos');

        // Show overlay and start slideshow
        if (overlay) {
          overlay.style.display = '';
          overlay.classList.add('active');
        }
        const ld2 = document.getElementById('frameflow-loader');
        if (ld2) ld2.style.display = 'none';

        if (photoUrls.length > 0) {
          buildShuffleOrder();
          showNext();
        }
        onDone();
      }

      step();
    }
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
    // Stop any playing video
    const vid = l.querySelector('video');
    if (vid) { vid.pause(); vid.src = ''; }
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
    if (idx < 0 || idx >= mediaItems.length) return;
    if (errCount >= 10) { showStatus('Many items failed to load.'); errCount = 0; return; }
    const item = mediaItems[idx];
    if (brokenUrls.has(item.url)) { errCount++; setTimeout(showNext, 50); return; }
    const layer = getInactive();
    if (!layer) return;
    clearLayer(layer);
    currentIndex = idx;
    if (settings.fill === 'cover') layer.classList.add('ff-fill-cover');

    if (item.type === 'video') {
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = isMuted;
      video.onloadeddata = () => { errCount = 0; swapLayers(); /* no scheduleNext — wait for ended */ };
      video.onended = () => { showNext(); };
      video.onerror = () => { brokenUrls.add(item.url); errCount++; setTimeout(showNext, 200); };
      video.src = item.url;
      layer.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.onload = () => { errCount = 0; applyKenBurns(layer); swapLayers(); scheduleNext(); };
      img.onerror = () => { brokenUrls.add(item.url); errCount++; setTimeout(showNext, 200); };
      img.src = item.url;
      layer.appendChild(img);
    }
  }

  function showNext() {
    clearTimeout(slideTimer);
    if (historyPos >= 0 && historyPos < viewHistory.length - 1) { historyPos++; loadSlide(viewHistory[historyPos]); return; }
    const i = getNextIndex();
    if (i >= 0) {
      viewHistory.push(i); historyPos = viewHistory.length - 1;
      if (viewHistory.length > 500) { viewHistory.shift(); historyPos--; }
      loadSlide(i);
    }
  }
  function showPrev() {
    clearTimeout(slideTimer);
    if (!viewHistory.length || historyPos <= 0) return;
    historyPos--; loadSlide(viewHistory[historyPos]);
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
    if (!el) return; el.textContent = t; el.classList.add('visible');
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
    ctrl.innerHTML = '<button id="ff-prev" title="Previous">&#9664;</button><button id="ff-playpause" title="Pause">&#10074;&#10074;</button><button id="ff-next" title="Next">&#9654;</button><button id="ff-mute" title="Mute/Unmute">&#128264;</button><button id="ff-hide-current" title="Hide this photo">&#128683;</button><button id="ff-settings-btn" title="Settings">&#9881;</button><button id="ff-exit" title="Exit">&#10005;</button>';
    const sp = document.createElement('div');
    sp.id = 'ff-settings-panel';
    sp.innerHTML = `
      <div class="ff-settings-title">Settings</div>
      <div class="ff-setting"><span>Photo Fill</span>
        <select id="ff-set-fill"><option value="contain"${settings.fill==='contain'?' selected':''}>Fit</option><option value="cover"${settings.fill==='cover'?' selected':''}>Fill (crop)</option></select></div>
      <div class="ff-setting"><span>Hi-Res</span><input type="checkbox" id="ff-set-hires"${settings.hiRes?' checked':''}></div>
      <div class="ff-setting"><span>Shuffle</span><input type="checkbox" id="ff-set-shuffle"${settings.shuffle?' checked':''}></div>
      <div class="ff-setting"><span>Transition</span>
        <select id="ff-set-transition"><option value="fade"${settings.transition==='fade'?' selected':''}>Fade</option><option value="slide"${settings.transition==='slide'?' selected':''}>Slide</option><option value="none"${settings.transition==='none'?' selected':''}>None</option></select></div>
      <div class="ff-setting"><span>Ken Burns</span><input type="checkbox" id="ff-set-kenburns"${settings.kenBurns?' checked':''}></div>
      <div class="ff-setting"><span>Duration</span><div class="ff-range-wrap"><input type="range" id="ff-set-duration" min="3" max="30" value="${settings.duration}"><span id="ff-duration-val">${settings.duration}s</span></div></div>
      <div class="ff-setting" style="margin-top:8px"><button id="ff-btn-unhide-all" style="width:100%;padding:8px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:6px;color:#fff;font-size:13px;cursor:pointer">Unhide All (0 hidden)</button></div>`;
    const st = document.createElement('div'); st.id = 'frameflow-status';
    const ld = document.createElement('div'); ld.id = 'frameflow-loader';
    ld.innerHTML = '<div class="ff-count" id="ff-photo-count">0</div><div class="ff-label" id="ff-loader-label">loading...</div>';

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

    // Mute/unmute
    document.getElementById('ff-mute').addEventListener('click', e => {
      e.stopPropagation();
      isMuted = !isMuted;
      const btn = document.getElementById('ff-mute');
      btn.innerHTML = isMuted ? '&#128263;' : '&#128264;';
      btn.title = isMuted ? 'Unmute' : 'Mute';
      // Update any currently playing video
      const activeLayer = getActive();
      if (activeLayer) {
        const vid = activeLayer.querySelector('video');
        if (vid) vid.muted = isMuted;
      }
    });

    // Hide current photo
    document.getElementById('ff-hide-current').addEventListener('click', e => {
      e.stopPropagation();
      if (currentIndex >= 0 && currentIndex < photoUrls.length) {
        const url = photoUrls[currentIndex];
        hiddenUrls.add(url);
        rebuildPhotoUrls();
        buildShuffleOrder();
        updateHiddenCount();
        showStatus('Photo hidden (' + hiddenUrls.size + ' hidden)');
        showNext();
      }
    });

    document.getElementById('ff-settings-btn').addEventListener('click', e => {
      e.stopPropagation(); document.getElementById('ff-settings-panel').classList.toggle('visible');
    });
    sp.addEventListener('click', e => e.stopPropagation());
    sp.addEventListener('mousedown', e => e.stopPropagation());

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

    // Unhide all
    document.getElementById('ff-btn-unhide-all').addEventListener('click', e => {
      e.stopPropagation();
      if (hiddenUrls.size === 0) return;
      hiddenUrls.clear();
      rebuildPhotoUrls();
      buildShuffleOrder();
      updateHiddenCount();
      showStatus('All photos unhidden');
    });

    document.addEventListener('keydown', handleKeydown);
  }

  function removeOverlay() {
    ['frameflow-overlay', 'frameflow-controls', 'ff-settings-panel', 'frameflow-status', 'frameflow-loader', 'ff-hires-progress'].forEach(id => {
      const el = document.getElementById(id); if (el) el.remove();
    });
    document.removeEventListener('keydown', handleKeydown);
  }

  // ===== Start / Stop =====
  function startSlideshow(opts) {
    if (opts) { if (!opts.fill) opts.fill = 'contain'; Object.assign(settings, opts); }

    isRunning = true; isPaused = false;
    currentIndex = -1; activeLayer = 'a';
    viewHistory = []; historyPos = -1;

    // Use cached photos if available
    photoUrls = rebuildPhotoUrls();

    createOverlay();
    document.getElementById('frameflow-overlay').classList.add('active');

    const countEl = document.getElementById('ff-photo-count');
    const labelEl = document.getElementById('ff-loader-label');

    if (settings.hiRes) {
      // Skip re-capture if we already have enough
      if (photoUrls.length >= (settings.targetPhotos || 10)) {
        console.log('[FrameFlow] Using', photoUrls.length, 'cached photos');
        if (countEl) countEl.textContent = photoUrls.length;
        buildShuffleOrder();
        const ld = document.getElementById('frameflow-loader');
        if (ld) ld.style.display = 'none';
        showNext();
        return photoUrls.length;
      }

      if (countEl) countEl.textContent = '0';
      if (labelEl) labelEl.textContent = 'click any photo in iCloud to begin...';

      loadHiResPhotos(settings.targetPhotos || 10, (count) => {
        if (countEl) countEl.textContent = count + ' / ' + (settings.targetPhotos || 10);
        photoUrls = rebuildPhotoUrls();
      }, () => {
        photoUrls = rebuildPhotoUrls();
        showStatus(photoUrls.length + ' photos captured');
        const ld = document.getElementById('frameflow-loader');
        if (ld) ld.style.display = 'none';
        if (currentIndex < 0 && photoUrls.length > 0) {
          buildShuffleOrder(); showNext();
        }
      });
    } else {
      if (countEl) countEl.textContent = photoUrls.length || '0';
      if (labelEl) labelEl.textContent = 'no thumbnail scraping available (iCloud uses blob URLs)';
      if (photoUrls.length > 0) {
        buildShuffleOrder();
        const ld = document.getElementById('frameflow-loader');
        if (ld) ld.style.display = 'none';
        showNext();
      } else {
        showStatus('Enable Hi-Res mode to capture photos from iCloud');
      }
    }

    return photoUrls.length;
  }

  function stopSlideshow() {
    isRunning = false; isPaused = false;
    clearTimeout(slideTimer); clearTimeout(scrollTimer);
    removeOverlay();
    currentIndex = -1;
    // Don't clear collectedUrls — cache persists
  }

  // ===== Message Handler =====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      // Report iframe photo count if we haven't captured yet, otherwise captured count
      const count = collectedMedia.length > 0 ? collectedMedia.length : iframePhotoPositions.length;
      sendResponse({ ok: true, running: isRunning, photoCount: count });
    } else if (msg.type === 'START_SLIDESHOW') {
      const count = startSlideshow(msg.settings);
      sendResponse({ ok: true, photoCount: count });
    } else if (msg.type === 'STOP_SLIDESHOW') {
      stopSlideshow();
      sendResponse({ ok: true });
    }
    return true;
  });

  console.log('[FrameFlow] Top frame ready. Waiting for iframe photo positions...');

})();
