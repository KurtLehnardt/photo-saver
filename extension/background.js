// Background service worker for FrameFlow
// - Tab screenshots via chrome.tabs.captureVisibleTab
// - Keyboard simulation via chrome.debugger, using ONE attachment per capture run
//   (attaching per keystroke raises/drops the debugger infobar, which resizes the
//   viewport between frames and misaligns the screenshot crop)

const attached = new Set(); // tabIds this worker currently holds a debugger session on

function attachDebugger(tabId) {
  return new Promise(resolve => {
    if (attached.has(tabId)) { resolve(true); return; }
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) {
        // A stale attachment from a terminated service worker reports the same
        // error as DevTools holding the tab. Assume it is ours and let any
        // sendCommand failure surface instead.
        if (/already attached/i.test(err.message || '')) {
          attached.add(tabId);
          resolve(true);
          return;
        }
        console.warn('[FrameFlow bg] Debugger attach failed:', err.message);
        resolve(false);
        return;
      }
      attached.add(tabId);
      resolve(true);
    });
  });
}

function detachDebugger(tabId) {
  return new Promise(resolve => {
    if (!attached.has(tabId)) { resolve(true); return; }
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError; // detach of a dead tab is not an error we care about
      attached.delete(tabId);
      resolve(true);
    });
  });
}

function sendCommand(tabId, method, params) {
  return new Promise(resolve => {
    chrome.debugger.sendCommand({ tabId }, method, params, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn('[FrameFlow bg] ' + method + ' failed:', err.message);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

const KEY_MAP = {
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
};

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId !== undefined) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

// Re-fetch a photo the page already loaded. iCloud serves photos from
// *.icloud-content.com, which taints a canvas in the page and makes toDataURL()
// throw — but a service-worker fetch carries the extension's host permissions
// and is not subject to page CORS, so this yields the real full-resolution
// image instead of a cropped screenshot of the viewport.
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

async function fetchImageAsDataUrl(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('too large: ' + blob.size);
  if (blob.type && !blob.type.startsWith('image/')) throw new Error('not an image: ' + blob.type);

  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // btoa in 32KB chunks — String.fromCharCode blows the stack on a whole photo
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + (blob.type || 'image/jpeg') + ';base64,' + btoa(binary);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;

  if (msg.type === 'FETCH_IMAGE') {
    let url;
    try { url = new URL(msg.url); } catch (e) { sendResponse({ dataUrl: null, error: 'bad url' }); return; }
    if (url.protocol !== 'https:') { sendResponse({ dataUrl: null, error: 'not https' }); return; }
    fetchImageAsDataUrl(url.href)
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(e => sendResponse({ dataUrl: null, error: e.message }));
    return true; // async
  }

  if (msg.type === 'CAPTURE_TAB') {
    // Capture the window the sender actually lives in — captureVisibleTab(null)
    // targets the current window, which may be a different one entirely.
    const windowId = sender.tab && sender.tab.windowId;
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 95 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.warn('[FrameFlow bg] Capture failed:', chrome.runtime.lastError.message);
        sendResponse({ dataUrl: null });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // async
  }

  if (msg.type === 'DEBUGGER_ATTACH') {
    if (tabId === undefined) { sendResponse({ ok: false }); return; }
    attachDebugger(tabId).then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'DEBUGGER_DETACH') {
    if (tabId === undefined) { sendResponse({ ok: false }); return; }
    detachDebugger(tabId).then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'SEND_KEY') {
    if (tabId === undefined) { sendResponse({ ok: false }); return; }
    const keyInfo = KEY_MAP[msg.key] || { key: msg.key, code: msg.key, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };

    (async () => {
      const ok = await attachDebugger(tabId);
      if (!ok) { sendResponse({ ok: false }); return; }
      const down = await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...keyInfo });
      const up = await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...keyInfo });
      sendResponse({ ok: down && up });
    })();
    return true;
  }
});
