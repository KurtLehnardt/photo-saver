// FrameFlow Content Script for icloud.com/photos
// Runs in ALL frames via manifest all_frames:true.
// - Iframe instances: report photo positions, capture photos/videos on request
// - Top frame instance: overlay, slideshow, capture orchestration

(function() {
  'use strict';

  const isTop = (window === window.top);
  // The manifest only matches https://www.icloud.com/*, so every FrameFlow frame
  // — top or nested — is on this exact origin.
  const ORIGIN = 'https://www.icloud.com';

  console.log('[FrameFlow]', isTop ? 'TOP' : 'IFRAME', window.location.href.substring(0, 60));

  function isTrusted(e) {
    return e.origin === ORIGIN && e.data && typeof e.data.type === 'string' &&
      e.data.type.indexOf('FRAMEFLOW_') === 0;
  }

  // ================================================================
  // IFRAME INSTANCE — capture photos directly (same-origin as blobs)
  // ================================================================
  if (!isTop) {
    const iframeCanvas = document.createElement('canvas');
    const iframeCtx = iframeCanvas.getContext('2d');
    let lastCapturedKey = '';
    let isRecording = false;
    let captureLogged = false;

    // Photo payloads go to the top frame only — never targetOrigin '*', which
    // would hand full-resolution image data to iCloud's own page scripts.
    function postToTop(msg, transfer) {
      try {
        if (transfer) window.top.postMessage(msg, ORIGIN, transfer);
        else window.top.postMessage(msg, ORIGIN);
      } catch (e) { /* top frame gone */ }
    }

    function reportPhotoPositions() {
      if (document.hidden) return;
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

      if (photos.length > 0) postToTop({ type: 'FRAMEFLOW_PHOTO_POSITIONS', photos });
    }

    function findLargestImage() {
      let best = null, bestSize = 0;
      document.querySelectorAll('img').forEach(img => {
        if (!img.complete) return;
        const size = img.naturalWidth * img.naturalHeight;
        if (size > bestSize) { bestSize = size; best = img; }
      });
      if (!best || best.naturalWidth < 100 || best.naturalHeight < 100) return null;
      return best;
    }

    // Draw the largest image to a canvas and return a data URL. Works because the
    // iframe is same-origin with iCloud's blob-backed <img> elements.
    function encodeImage(img) {
      const maxDim = 4096;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxDim || h > maxDim) {
        const s = maxDim / Math.max(w, h);
        w = Math.round(w * s); h = Math.round(h * s);
      }
      iframeCanvas.width = w;
      iframeCanvas.height = h;
      iframeCtx.drawImage(img, 0, 0, w, h);
      return iframeCanvas.toDataURL('image/jpeg', 0.95);
    }

    // Only works for same-origin sources; iCloud's cross-origin photos taint the
    // canvas and make toDataURL() throw.
    function tryCanvas(img) {
      try {
        return encodeImage(img);
      } catch (e) {
        if (!captureLogged) {
          console.log('[FrameFlow/iframe] Canvas blocked (' + e.message.slice(0, 40) + '), using background fetch');
          captureLogged = true;
        }
        return null;
      }
    }

    // The service worker carries the extension's host permissions, so it can
    // refetch the photo cross-origin and hand back the original full-resolution
    // bytes. This is the primary path on real iCloud.
    function fetchViaBackground(url) {
      return new Promise(resolve => {
        try {
          chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url }, resp => {
            if (chrome.runtime.lastError || !resp) { resolve(null); return; }
            if (!resp.dataUrl && resp.error) console.log('[FrameFlow/iframe] Fetch failed:', resp.error);
            resolve(resp.dataUrl || null);
          });
        } catch (e) { resolve(null); }
      });
    }

    // Poll until a *new* image shows up (iCloud swaps the <img> asynchronously
    // after an arrow key), then respond. Always answers, so the top frame's
    // request never has to rely on a timeout to make progress.
    function captureLargestImage(requestId, deadlineMs) {
      const deadline = Date.now() + (deadlineMs || 1500);

      async function attempt() {
        const best = findLargestImage();
        if (best) {
          const src = best.currentSrc || best.src || '';
          const key = src + '_' + best.naturalWidth + 'x' + best.naturalHeight;
          if (src && key !== lastCapturedKey) {
            let dataUrl = null, via = '';

            if (src.startsWith('blob:') || src.startsWith('data:')) {
              dataUrl = tryCanvas(best);
              via = 'canvas';
            } else if (/^https:/.test(src)) {
              dataUrl = await fetchViaBackground(src);
              via = 'fetch';
              if (!dataUrl) { dataUrl = tryCanvas(best); via = 'canvas'; }
            }

            if (dataUrl && dataUrl.length > 1000) {
              lastCapturedKey = key;
              postToTop({
                type: 'FRAMEFLOW_PHOTO_DATA',
                requestId,
                dataUrl,
                width: best.naturalWidth,
                height: best.naturalHeight
              });
              console.log('[FrameFlow/iframe] Captured', best.naturalWidth + 'x' + best.naturalHeight,
                'via ' + via);
              return;
            }
          }
        }

        if (Date.now() < deadline) { setTimeout(attempt, 200); return; }
        postToTop({ type: 'FRAMEFLOW_PHOTO_DATA', requestId, dataUrl: null });
      }

      attempt();
    }

    function detectMedia(requestId) {
      const videos = document.querySelectorAll('video');
      let bestVideo = null;
      for (const v of videos) {
        if (v.videoWidth > 100 && v.videoHeight > 100) { bestVideo = v; break; }
      }

      if (bestVideo) {
        postToTop({
          type: 'FRAMEFLOW_MEDIA_TYPE',
          requestId,
          mediaType: 'video',
          duration: bestVideo.duration || 0,
          width: bestVideo.videoWidth,
          height: bestVideo.videoHeight
        });
      } else {
        postToTop({ type: 'FRAMEFLOW_MEDIA_TYPE', requestId, mediaType: 'photo' });
      }
    }

    async function recordVideo(requestId) {
      if (isRecording) {
        postToTop({ type: 'FRAMEFLOW_VIDEO_DATA', requestId, data: null, error: 'Already recording' });
        return;
      }

      const videos = document.querySelectorAll('video');
      let video = null;
      for (const v of videos) {
        if (v.videoWidth > 100 && v.videoHeight > 100) { video = v; break; }
      }

      if (!video) {
        postToTop({ type: 'FRAMEFLOW_VIDEO_DATA', requestId, data: null, error: 'No video found' });
        return;
      }

      isRecording = true;
      console.log('[FrameFlow/iframe] Recording video', video.videoWidth + 'x' + video.videoHeight, 'duration:', video.duration);

      let maxTimer = null;

      try {
        video.currentTime = 0;
        video.play().catch(() => {});

        const stream = video.captureStream();

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
          clearTimeout(maxTimer);
          const blob = new Blob(chunks, { type: mimeType });
          console.log('[FrameFlow/iframe] Video recorded:', (blob.size / 1024 / 1024).toFixed(1) + 'MB');

          const buffer = await blob.arrayBuffer();
          postToTop({
            type: 'FRAMEFLOW_VIDEO_DATA',
            requestId,
            data: buffer,
            mimeType,
            duration: video.duration,
            width: video.videoWidth,
            height: video.videoHeight
          }, [buffer]); // transfer, don't copy
        };

        recorder.onerror = () => {
          isRecording = false;
          clearTimeout(maxTimer);
          postToTop({ type: 'FRAMEFLOW_VIDEO_DATA', requestId, data: null, error: 'Recording failed' });
        };

        recorder.start();

        const maxDuration = Math.min((video.duration || 60) + 2, 120) * 1000;

        const stopRecording = () => {
          if (recorder.state === 'recording') recorder.stop();
        };

        video.addEventListener('ended', stopRecording, { once: true });
        maxTimer = setTimeout(() => {
          video.removeEventListener('ended', stopRecording);
          stopRecording();
        }, maxDuration);

      } catch (e) {
        isRecording = false;
        clearTimeout(maxTimer);
        console.warn('[FrameFlow/iframe] Video capture failed:', e.message);
        postToTop({ type: 'FRAMEFLOW_VIDEO_DATA', requestId, data: null, error: e.message });
      }
    }

    // Fallback when chrome.debugger is unavailable (DevTools holding the tab, or
    // the permission revoked). Untrusted events, so iCloud may ignore them.
    function synthKey(key) {
      const init = { key, code: key, bubbles: true, cancelable: true };
      const target = document.activeElement || document.body;
      if (!target) return;
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
    }

    window.addEventListener('message', (e) => {
      if (!isTrusted(e)) return;
      const d = e.data;
      if (d.type === 'FRAMEFLOW_REQUEST_CAPTURE') captureLargestImage(d.requestId, d.deadline);
      else if (d.type === 'FRAMEFLOW_DETECT_MEDIA') detectMedia(d.requestId);
      else if (d.type === 'FRAMEFLOW_REQUEST_VIDEO_CAPTURE') recordVideo(d.requestId);
      else if (d.type === 'FRAMEFLOW_RESET_CAPTURE') lastCapturedKey = '';
      else if (d.type === 'FRAMEFLOW_SYNTH_KEY') synthKey(d.key);
    });

    // Position reporting is the only always-on work: one querySelectorAll every
    // 5s, skipped while the tab is hidden. Image encoding happens on request.
    // Images are usually not decoded yet at document_idle, so re-report a few
    // times early — otherwise the popup shows "0 photos detected" for 5s.
    reportPhotoPositions();
    [400, 1200, 2500].forEach(ms => setTimeout(reportPhotoPositions, ms));
    window.addEventListener('load', reportPhotoPositions);
    setInterval(reportPhotoPositions, 5000);

    const obs = new MutationObserver(() => {
      clearTimeout(obs._t);
      obs._t = setTimeout(reportPhotoPositions, 500);
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
  const MAX_MEDIA = 2000; // hard cap so an "All" run can't grow without bound
  const collectedMedia = [];
  const collectedUrlSet = new Set();
  const hiddenUrls = new Set();
  const brokenUrls = new Set();
  let mediaItems = []; // filtered (non-hidden) items for slideshow
  let photoUrls = [];  // urls of mediaItems, same order

  function revokeIfBlob(url) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
  }

  function addMedia(type, url) {
    // Never revoke on a dedup hit: an already-collected item is using that URL.
    if (collectedUrlSet.has(url)) return false;
    collectedUrlSet.add(url);
    collectedMedia.push({ type, url });
    while (collectedMedia.length > MAX_MEDIA) {
      const dropped = collectedMedia.shift();
      collectedUrlSet.delete(dropped.url);
      hiddenUrls.delete(dropped.url);
      brokenUrls.delete(dropped.url);
      revokeIfBlob(dropped.url);
    }
    return true;
  }

  function rebuildPhotoUrls() {
    mediaItems = collectedMedia.filter(m => !hiddenUrls.has(m.url));
    photoUrls = mediaItems.map(m => m.url);
    return photoUrls;
  }

  // Indices in viewHistory/shuffledOrder point into photoUrls, so any change to
  // the visible set invalidates them.
  function resetPlaybackIndices() {
    viewHistory = [];
    historyPos = -1;
    currentIndex = -1;
    buildShuffleOrder();
  }

  function releaseAllMedia() {
    collectedMedia.forEach(m => revokeIfBlob(m.url));
    collectedMedia.length = 0;
    collectedUrlSet.clear();
    mediaItems = [];
    photoUrls = [];
  }

  window.addEventListener('pagehide', releaseAllMedia);

  let isMuted = false;
  let isRunning = false, isPaused = false, isCapturing = false;
  let settings = {
    shuffle: true, transition: 'fade', fill: 'contain',
    kenBurns: true, duration: 8, targetPhotos: 100
  };
  let slideTimer = null, controlsTimer = null, scrollTimer = null;
  let waitTimer = null, videoTimer = null;
  let currentIndex = -1, shuffledOrder = [], shuffleIndex = 0;
  let activeLayer = 'a';
  let viewHistory = [], historyPos = -1;

  // Persisted settings — the popup also sends these on start, but loading here
  // keeps the in-page settings panel correct if the slideshow is started any
  // other way.
  try {
    chrome.storage.local.get(['frameflow_settings'], (res) => {
      if (chrome.runtime.lastError || !res || !res.frameflow_settings) return;
      Object.assign(settings, res.frameflow_settings);
      delete settings.hiRes; // removed in 1.2.0 — capture is always hi-res now
    });
  } catch (e) {}

  // 0 / "All" means "keep going until the library runs out"
  function resolveTarget(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return Infinity;
    return Math.floor(v);
  }
  function targetLabel(target) {
    return target === Infinity ? 'all' : String(target);
  }

  // Photo positions reported by iframe instances (used for the popup's count)
  let iframePhotoPositions = [];
  let iframeElement = null;

  // ===== Correlated request/response with iframe instances =====
  let reqSeq = 0;
  const pending = new Map(); // requestId -> { resolve, timer }

  function awaitResponse(requestId, timeoutMs, fallback) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(fallback);
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
    });
  }

  function settle(requestId, value) {
    const p = pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    pending.delete(requestId);
    p.resolve(value);
    return true;
  }

  function settleAll(value) {
    pending.forEach(p => { clearTimeout(p.timer); p.resolve(value); });
    pending.clear();
  }

  // Broadcast to every child frame rather than tracking a single "the" iframe —
  // an iframe that never reported photo positions could otherwise never be asked
  // to capture. These messages carry no photo data, so '*' is safe here.
  function postToFrames(msg) {
    let sent = 0;
    document.querySelectorAll('iframe').forEach(f => {
      try {
        if (f.contentWindow) { f.contentWindow.postMessage(msg, '*'); sent++; }
      } catch (e) {}
    });
    return sent;
  }

  window.addEventListener('message', (e) => {
    if (!isTrusted(e)) return;
    const d = e.data;

    if (d.type === 'FRAMEFLOW_PHOTO_POSITIONS') {
      document.querySelectorAll('iframe').forEach(f => {
        try { if (f.contentWindow === e.source) iframeElement = f; } catch (err) {}
      });

      const iframeRect = iframeElement ? iframeElement.getBoundingClientRect() : { left: 0, top: 0 };
      iframePhotoPositions = d.photos.map(p => ({
        x: p.x + iframeRect.left, y: p.y + iframeRect.top,
        w: p.w, h: p.h, rectW: p.rectW, rectH: p.rectH
      }));
      return;
    }

    if (d.type === 'FRAMEFLOW_PHOTO_DATA') {
      settle(d.requestId, d.dataUrl || null);
      return;
    }

    if (d.type === 'FRAMEFLOW_MEDIA_TYPE') {
      settle(d.requestId, { mediaType: d.mediaType, duration: d.duration, width: d.width, height: d.height });
      return;
    }

    if (d.type === 'FRAMEFLOW_VIDEO_DATA') {
      if (d.data) {
        const blob = new Blob([d.data], { type: d.mimeType || 'video/webm' });
        const url = URL.createObjectURL(blob);
        addMedia('video', url);
        rebuildPhotoUrls();
        console.log('[FrameFlow] Received video:', (blob.size / 1024 / 1024).toFixed(1) + 'MB');
      } else {
        console.warn('[FrameFlow] Video capture failed:', d.error);
      }
      settle(d.requestId, !!d.data);
      return;
    }
  });

  function requestIframeCapture(timeoutMs) {
    const id = 'ff' + (++reqSeq);
    const ms = timeoutMs || 8000;
    if (!postToFrames({ type: 'FRAMEFLOW_REQUEST_CAPTURE', requestId: id, deadline: ms - 1200 })) {
      return Promise.resolve(null);
    }
    return awaitResponse(id, ms, null);
  }

  function requestMediaType(timeoutMs) {
    const id = 'ff' + (++reqSeq);
    if (!postToFrames({ type: 'FRAMEFLOW_DETECT_MEDIA', requestId: id })) {
      return Promise.resolve({ mediaType: 'photo' });
    }
    return awaitResponse(id, timeoutMs || 2000, { mediaType: 'photo' });
  }

  function requestVideoCapture(timeoutMs) {
    const id = 'ff' + (++reqSeq);
    if (!postToFrames({ type: 'FRAMEFLOW_REQUEST_VIDEO_CAPTURE', requestId: id })) {
      return Promise.resolve(false);
    }
    return awaitResponse(id, timeoutMs || 120000, false);
  }

  function updateHiddenCount() {
    const btn = document.getElementById('ff-btn-unhide-all');
    if (btn) btn.textContent = 'Unhide All (' + hiddenUrls.size + ' hidden)';
  }

  function saveExtSettings() {
    try { chrome.storage.local.set({ frameflow_settings: settings }); } catch (e) {}
  }

  // ===== Background worker helpers =====
  function sendMessage(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, response => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      } catch (e) { resolve(null); }
    });
  }

  // Crop canvas for extracting the photo from a full-page screenshot
  const cropCanvas = document.createElement('canvas');
  const cropCtx = cropCanvas.getContext('2d');

  // Hide iCloud's UI overlays before screenshot, restore after.
  // These selectors match on class substrings, which also hit container
  // elements — blanking an ancestor of the photo produced all-black captures.
  const ICLOUD_CHROME_SELECTOR = [
    '.OneUp-leadingTopBadges', '.OneUp-trailingTopBadges',
    '.OneUpBadge', '.OneUp-hdrVideoBadge',
    '.OneUp-toolbar', '.OneUp-bottomBar',
    '.FilmStrip', '.film-strip', '[class*="filmstrip"]',
    '[class*="TopBar"]', '[class*="topbar"]',
    '[class*="toolbar"]', '[class*="Toolbar"]',
    '[class*="navigation"]', '[class*="Navigation"]',
    '[class*="close-button"]', '[class*="CloseButton"]'
  ].join(',');

  // [element, previous inline visibility] for everything hidden for a shot
  let hiddenForShot = [];

  function sameOriginDocs() {
    const docs = [document];
    document.querySelectorAll('iframe').forEach(f => {
      try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {}
    });
    return docs;
  }

  // Never hide anything the photo lives inside.
  function mediaAncestors(doc) {
    const keep = new Set();
    let best = null, bestArea = 0;
    doc.querySelectorAll('img,video').forEach(el => {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    });
    for (let n = best; n; n = n.parentElement) keep.add(n);
    return keep;
  }

  function hideiCloudChrome() {
    showICloudChrome(); // never stack two hides
    sameOriginDocs().forEach(doc => {
      const keep = mediaAncestors(doc);
      let els;
      try { els = doc.querySelectorAll(ICLOUD_CHROME_SELECTOR); } catch (e) { return; }
      els.forEach(el => {
        if (keep.has(el)) return;
        if (el.closest && el.closest('#frameflow-overlay')) return;
        hiddenForShot.push([el, el.style.visibility]);
        // visibility, not display: display:none reflows the page between the
        // hide and the capture, shifting the photo out from under the crop.
        el.style.visibility = 'hidden';
      });
    });
  }

  function showICloudChrome() {
    hiddenForShot.forEach(([el, prev]) => {
      try { el.style.visibility = prev; } catch (e) {}
    });
    hiddenForShot = [];
    // Clear the stylesheet written by versions <= 1.2.0, if one is left behind
    const stale = document.getElementById('ff-hide-icloud');
    if (stale) stale.textContent = '';
  }

  // Downscale to 32x32 and average: a near-black frame means we hid something
  // we should not have, or the page repainted mid-capture.
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 32; sampleCanvas.height = 32;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  let blankWarned = false;
  function warnIfBlank(src) {
    if (blankWarned) return;
    try {
      sampleCtx.drawImage(src, 0, 0, 32, 32);
      const d = sampleCtx.getImageData(0, 0, 32, 32).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      const mean = sum / (d.length / 4);
      if (mean < 8) {
        blankWarned = true;
        console.warn('[FrameFlow] Screenshot is blank (mean brightness ' + mean.toFixed(1) +
          ') — the photo was hidden or had not painted when the frame was taken');
      }
    } catch (e) {}
  }

  async function captureScreenshot() {
    hideiCloudChrome();
    await new Promise(r => setTimeout(r, 100)); // repaint
    const resp = await sendMessage({ type: 'CAPTURE_TAB' });
    showICloudChrome();
    if (!resp || !resp.dataUrl) return null;

    // Crop the screenshot to remove iCloud UI (top bar, bottom carousel).
    // iCloud detail view layout:
    //   - Top ~44-60px: navigation/close button bar
    //   - Bottom ~80-120px: thumbnail carousel strip
    //   - Left/Right: arrow buttons (small, ok to include)
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;

        const topCrop = Math.round(h * 0.06);     // ~6% from top (nav bar)
        const bottomCrop = Math.round(h * 0.12);  // ~12% from bottom (carousel)
        const sideCrop = Math.round(w * 0.02);    // ~2% from sides (minimal)

        const cw = w - sideCrop * 2;
        const ch = h - topCrop - bottomCrop;

        cropCanvas.width = cw;
        cropCanvas.height = ch;
        cropCtx.drawImage(img, sideCrop, topCrop, cw, ch, 0, 0, cw, ch);

        warnIfBlank(cropCanvas);

        cropCanvas.toBlob(blob => {
          resolve(blob ? URL.createObjectURL(blob) : resp.dataUrl);
        }, 'image/jpeg', 0.95);
      };
      img.onerror = () => resolve(resp.dataUrl); // fallback to uncropped
      img.src = resp.dataUrl;
    });
  }

  // Input.dispatchKeyEvent is delivered to whichever frame has focus. If the user
  // clicked outside the photo frame, keys land nowhere and iCloud never advances.
  function focusCaptureFrame() {
    if (!iframeElement) return;
    try { iframeElement.focus(); } catch (e) {}
    try { if (iframeElement.contentWindow) iframeElement.contentWindow.focus(); } catch (e) {}
  }

  async function sendRealKey(key) {
    if (isCapturing) focusCaptureFrame();
    const resp = await sendMessage({ type: 'SEND_KEY', key });
    if (resp && resp.ok) return true;
    // chrome.debugger unavailable (DevTools attached, permission denied) —
    // try an untrusted synthetic event so capture can still limp along.
    postToFrames({ type: 'FRAMEFLOW_SYNTH_KEY', key });
    return false;
  }

  // ===== Capture =====
  // The user manually opens a photo first (one click), then we capture and
  // auto-advance through the library.
  function loadHiResPhotos(target, onProgress, onDone) {
    const overlay = document.getElementById('frameflow-overlay');

    // Hide overlay and show instructions
    if (overlay) overlay.style.display = 'none';
    const ld = document.getElementById('frameflow-loader');
    if (ld) ld.style.display = 'none';

    const instrDiv = document.createElement('div');
    instrDiv.id = 'ff-hires-instructions';
    instrDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:999998;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;color:#fff;text-align:center;pointer-events:none;';
    instrDiv.innerHTML = '<div style="max-width:400px;padding:40px;background:rgba(0,0,0,0.85);border-radius:16px;backdrop-filter:blur(20px);pointer-events:auto">' +
      '<div style="font-size:22px;font-weight:700;margin-bottom:12px">Click any photo</div>' +
      '<div style="font-size:15px;color:rgba(255,255,255,0.6);margin-bottom:20px">Click a photo in iCloud to open it full-size.<br>FrameFlow will then auto-capture ' + targetLabel(target) + ' photos.</div>' +
      '<div style="font-size:13px;color:rgba(255,255,255,0.4)">Waiting for you to open a photo...</div>' +
      '</div>';
    document.body.appendChild(instrDiv);

    let checkCount = 0;

    function checkForDetailView() {
      if (!isRunning) { instrDiv.remove(); onDone(); return; }
      checkCount++;

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

      if (!found) {
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

      waitTimer = setTimeout(checkForDetailView, 1000);
    }

    checkForDetailView();

    // The actual capture loop (runs after user opens a photo)
    async function startCapture() {
      isCapturing = true;
      focusCaptureFrame();
      postToFrames({ type: 'FRAMEFLOW_RESET_CAPTURE' });
      // One debugger attachment for the whole run — see background.js
      await sendMessage({ type: 'DEBUGGER_ATTACH' });
      await new Promise(r => setTimeout(r, 1500));

      let captured = 0;
      let lastDataUrl = null;
      let staleCount = 0;
      let keyFailures = 0;

      const progressDiv = document.createElement('div');
      progressDiv.id = 'ff-hires-progress';
      progressDiv.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(0,0,0,0.85);backdrop-filter:blur(10px);padding:12px 24px;border-radius:10px;font-family:-apple-system,sans-serif;color:#fff;font-size:14px;pointer-events:none;';
      progressDiv.textContent = 'Capturing 0 / ' + targetLabel(target);
      document.body.appendChild(progressDiv);

      function progress(text) {
        if (progressDiv.isConnected) progressDiv.textContent = text;
      }

      async function step() {
        if (!isRunning || captured >= target) { finish(captured); return; }

        // stopSlideshow() settles in-flight requests with null to unblock this
        // loop, so every awaited result here has to tolerate null.
        const mediaInfo = (await requestMediaType(1500)) || { mediaType: 'photo' };
        if (!isRunning) { finish(captured); return; }

        if (mediaInfo.mediaType === 'video') {
          progress('Recording video ' + (captured + 1) + ' / ' + targetLabel(target) + '...');
          console.log('[FrameFlow] Video detected, recording... duration:', mediaInfo.duration);

          const success = await requestVideoCapture((mediaInfo.duration || 60) * 1000 + 5000);
          if (success) {
            captured++;
            staleCount = 0;
            progress('Captured ' + captured + ' / ' + targetLabel(target));
            onProgress(captured);
            rebuildPhotoUrls();
            console.log('[FrameFlow] #' + captured + ' video recorded');
          } else {
            // Video recording failed — capture a screenshot instead
            console.log('[FrameFlow] Video recording failed, capturing screenshot');
            let dataUrl = await requestIframeCapture(8000);
            if (!dataUrl) {
              progressDiv.style.display = 'none';
              await new Promise(r => setTimeout(r, 150));
              dataUrl = await captureScreenshot();
              progressDiv.style.display = '';
            }
            if (dataUrl && addMedia('photo', dataUrl)) {
              captured++;
              rebuildPhotoUrls();
            }
            staleCount++;
          }
        } else {
          let dataUrl = await requestIframeCapture(8000);
          if (!dataUrl) {
            progressDiv.style.display = 'none';
            await new Promise(r => setTimeout(r, 150));
            dataUrl = await captureScreenshot();
            progressDiv.style.display = '';
          }

          if (dataUrl && dataUrl !== lastDataUrl) {
            lastDataUrl = dataUrl;
            // An item we already hold is not progress. Without this, an album
            // that wraps at the end would capture forever on an unlimited run.
            if (addMedia('photo', dataUrl)) {
              captured++;
              staleCount = 0;
              progress('Capturing ' + captured + ' / ' + targetLabel(target));
              onProgress(captured);
              rebuildPhotoUrls();
              console.log('[FrameFlow] #' + captured + ' photo captured');
            } else {
              staleCount++;
            }
          } else {
            // Same image as last round — iCloud hasn't advanced yet. Data URLs
            // dedupe by value; a blob URL we never collected has to be released.
            if (dataUrl && !collectedUrlSet.has(dataUrl)) revokeIfBlob(dataUrl);
            staleCount++;
          }
        }

        // 8 consecutive no-new-media rounds means we hit the end of the library
        if (!isRunning || staleCount > 8) { finish(captured); return; }

        const keyOk = await sendRealKey('ArrowRight');
        if (keyOk) {
          keyFailures = 0;
        } else if (++keyFailures >= 2 && staleCount > 0) {
          // Only give up if we are also failing to capture anything new. The
          // synthetic-key fallback does advance some pages, and aborting while
          // photos are still arriving would cut a working run short.
          console.warn('[FrameFlow] Cannot dispatch keys — aborting capture');
          progress('Cannot advance photos — close DevTools for this tab and retry');
          await new Promise(r => setTimeout(r, 2500));
          finish(captured);
          return;
        }
        await new Promise(r => setTimeout(r, 2000));
        scrollTimer = setTimeout(runStep, 100);
      }

      async function runStep() {
        try {
          await step();
        } catch (e) {
          console.warn('[FrameFlow] Capture aborted:', e && e.message);
          finish(captured);
        }
      }

      let finished = false;
      async function finish(count) {
        if (finished) return;
        finished = true;
        if (progressDiv.isConnected) progressDiv.remove();

        // Stay in capture mode until the closing Escape has landed — handleKeydown
        // is gated on isCapturing, and this Escape would otherwise stop the
        // slideshow we are about to start.
        await sendRealKey('Escape');
        await new Promise(r => setTimeout(r, 800));
        await sendMessage({ type: 'DEBUGGER_DETACH' });
        isCapturing = false;

        rebuildPhotoUrls();
        const kinds = {};
        collectedMedia.forEach(m => { const k = m.type + ':' + urlKind(m.url); kinds[k] = (kinds[k] || 0) + 1; });
        console.log('[FrameFlow] Captured', count, 'items —', JSON.stringify(kinds));

        // The user may have stopped the slideshow mid-capture — don't resurrect it
        if (!isRunning) { onDone(); return; }

        if (overlay) {
          overlay.style.display = '';
          overlay.classList.add('active');
        }
        const ld2 = document.getElementById('frameflow-loader');
        if (ld2) ld2.style.display = 'none';

        if (photoUrls.length > 0) {
          resetPlaybackIndices();
          showNext();
        }
        onDone();
      }

      runStep();
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
    const vid = l.querySelector('video');
    if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); }
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

  function urlKind(u) {
    if (typeof u !== 'string') return 'none';
    const i = u.indexOf(':');
    return i > 0 ? u.slice(0, i) : 'unknown';
  }

  // A slide can load perfectly and still be invisible if something paints over it
  // — iCloud's app frame, or a fullscreen element in the top layer. Report it
  // once per run rather than leaving the user with a silent black screen.
  let overlayChecked = false;
  function checkOverlayOnTop() {
    if (overlayChecked) return;
    overlayChecked = true;
    const ov = document.getElementById('frameflow-overlay');
    if (!ov) return;
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    if (el && ov.contains(el)) return;
    const what = el ? el.tagName + (el.id ? '#' + el.id : '') + ' .' + (el.className || '') : 'nothing';
    console.warn('[FrameFlow] Overlay is not the topmost element — ' + what.slice(0, 80) +
      ' is painting over the slideshow');
    showStatus('Slideshow is hidden behind the page');
  }

  let errCount = 0;
  function loadSlide(idx) {
    if (idx < 0 || idx >= photoUrls.length) return;
    if (errCount >= 10) { showStatus('Many items failed to load.'); errCount = 0; return; }

    clearTimeout(videoTimer);

    const url = photoUrls[idx];
    const item = mediaItems[idx];
    const isVideo = item && item.type === 'video';

    if (brokenUrls.has(url)) { errCount++; setTimeout(showNext, 50); return; }
    const layer = getInactive();
    if (!layer) return;
    clearLayer(layer);
    currentIndex = idx;
    if (settings.fill === 'cover') layer.classList.add('ff-fill-cover');

    if (isVideo) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('autoplay', '');
      // Start muted to satisfy autoplay policy, unmute once playback begins
      video.muted = true;
      video.setAttribute('muted', '');

      // A stalled or seekless recording fires neither 'ended' nor 'error', which
      // used to hang the slideshow forever. Always keep a wall-clock fallback.
      let armed = true;
      const advance = () => { if (armed) { armed = false; clearTimeout(videoTimer); showNext(); } };
      videoTimer = setTimeout(advance, Math.max(settings.duration, 10) * 1000);

      video.onplaying = () => { if (!isMuted) video.muted = false; };
      video.onloadedmetadata = () => {
        const secs = (isFinite(video.duration) && video.duration > 0) ? video.duration : settings.duration;
        clearTimeout(videoTimer);
        videoTimer = setTimeout(advance, secs * 1000 + 2000);
      };
      video.onloadeddata = () => {
        errCount = 0;
        swapLayers();
        video.play().catch(() => {});
      };
      video.onended = advance;
      video.onerror = () => {
        armed = false;
        clearTimeout(videoTimer);
        brokenUrls.add(url); errCount++; setTimeout(showNext, 200);
      };
      video.src = url;
      layer.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.onload = () => {
        errCount = 0;
        console.log('[FrameFlow] slide ' + idx + ' loaded ' + img.naturalWidth + 'x' + img.naturalHeight +
          ' (' + urlKind(url) + ')');
        applyKenBurns(layer);
        swapLayers();
        scheduleNext();
        checkOverlayOnTop();
      };
      img.onerror = () => {
        // Silent before: a black screen with an empty console looked identical
        // to "capture produced nothing".
        console.warn('[FrameFlow] slide ' + idx + ' FAILED to load (' + urlKind(url) + ') — ' +
          url.slice(0, 60));
        brokenUrls.add(url); errCount++; setTimeout(showNext, 200);
      };
      img.src = url;
      layer.appendChild(img);
    }
  }

  function showNext() {
    clearTimeout(slideTimer);
    clearTimeout(videoTimer);
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
    clearTimeout(videoTimer);
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
    // During capture the overlay is hidden and arrow keys belong to iCloud —
    // reacting to our own debugger-dispatched keys would advance the slideshow
    // mid-capture and preventDefault iCloud's navigation.
    if (!isRunning || isCapturing) return;
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
      const active = getActive();
      if (active) {
        const vid = active.querySelector('video');
        if (vid) vid.muted = isMuted;
      }
    });

    // Hide current photo
    document.getElementById('ff-hide-current').addEventListener('click', e => {
      e.stopPropagation();
      if (currentIndex >= 0 && currentIndex < photoUrls.length) {
        hiddenUrls.add(photoUrls[currentIndex]);
        rebuildPhotoUrls();
        resetPlaybackIndices();
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
      resetPlaybackIndices();
      updateHiddenCount();
      showStatus('All photos unhidden');
      showNext();
    });

    updateHiddenCount();
    document.addEventListener('keydown', handleKeydown);
  }

  function removeOverlay() {
    ['frameflow-overlay', 'frameflow-controls', 'ff-settings-panel', 'frameflow-status', 'frameflow-loader', 'ff-hires-progress', 'ff-hires-instructions'].forEach(id => {
      const el = document.getElementById(id); if (el) el.remove();
    });
    document.removeEventListener('keydown', handleKeydown);
  }

  // ===== Start / Stop =====
  function startSlideshow(opts) {
    if (opts) Object.assign(settings, opts);
    delete settings.hiRes; // capture is always hi-res as of 1.2.0
    if (!settings.fill) settings.fill = 'contain';

    isRunning = true; isPaused = false;
    overlayChecked = false; blankWarned = false;
    currentIndex = -1; activeLayer = 'a';
    viewHistory = []; historyPos = -1;

    rebuildPhotoUrls();

    createOverlay();
    document.getElementById('frameflow-overlay').classList.add('active');

    const countEl = document.getElementById('ff-photo-count');
    const labelEl = document.getElementById('ff-loader-label');
    const target = resolveTarget(settings.targetPhotos);

    // Reuse the cache from an earlier run rather than re-capturing. "All" reuses
    // whatever we already have; reload the page to force a fresh capture.
    const haveEnough = photoUrls.length > 0 && (target === Infinity || photoUrls.length >= target);
    if (haveEnough) {
      console.log('[FrameFlow] Using', photoUrls.length, 'cached items');
      if (countEl) countEl.textContent = photoUrls.length;
      buildShuffleOrder();
      const ld = document.getElementById('frameflow-loader');
      if (ld) ld.style.display = 'none';
      showNext();
      return photoUrls.length;
    }

    if (countEl) countEl.textContent = '0';
    if (labelEl) labelEl.textContent = 'click any photo in iCloud to begin...';

    loadHiResPhotos(target, (count) => {
      if (countEl) countEl.textContent = count + ' / ' + targetLabel(target);
      rebuildPhotoUrls();
    }, () => {
      rebuildPhotoUrls();
      if (!isRunning) return;
      showStatus(photoUrls.length + ' items captured');
      const ld = document.getElementById('frameflow-loader');
      if (ld) ld.style.display = 'none';
      if (currentIndex < 0 && photoUrls.length > 0) {
        resetPlaybackIndices();
        showNext();
      }
    });

    return photoUrls.length;
  }

  function stopSlideshow() {
    isRunning = false; isPaused = false; isCapturing = false;
    clearTimeout(slideTimer); clearTimeout(scrollTimer);
    clearTimeout(waitTimer); clearTimeout(videoTimer); clearTimeout(controlsTimer);
    waitTimer = null;
    // Unblock anything awaiting an iframe response so the capture loop can exit
    settleAll(null);
    showICloudChrome();
    sendMessage({ type: 'DEBUGGER_DETACH' });
    removeOverlay();
    currentIndex = -1;
    viewHistory = []; historyPos = -1;
    // Captured media is intentionally kept so restarting is instant
  }

  // ===== Message Handler =====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      // Report iframe photo count if we haven't captured yet, otherwise captured count
      const count = collectedMedia.length > 0 ? collectedMedia.length : iframePhotoPositions.length;
      sendResponse({ ok: true, running: isRunning, photoCount: count });
    } else if (msg.type === 'START_SLIDESHOW') {
      sendResponse({ ok: true, photoCount: startSlideshow(msg.settings) });
    } else if (msg.type === 'STOP_SLIDESHOW') {
      stopSlideshow();
      sendResponse({ ok: true });
    }
    // All responses are synchronous — returning true would leak the message port.
  });

  console.log('[FrameFlow] Top frame ready. Waiting for iframe photo positions...');

})();
