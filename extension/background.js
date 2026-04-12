// Background service worker for FrameFlow
// Handles tab screenshots and keyboard simulation via chrome.debugger

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_TAB') {
    chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 95 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.warn('[FrameFlow bg] Capture failed:', chrome.runtime.lastError.message);
        sendResponse({ dataUrl: null });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // async
  }

  if (msg.type === 'SEND_KEY') {
    const tabId = sender.tab.id;
    const key = msg.key;

    // Use chrome.debugger to send real keyboard events
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        console.warn('[FrameFlow bg] Debugger attach failed:', chrome.runtime.lastError.message);
        // Fallback: try without debugger
        sendResponse({ ok: false });
        return;
      }

      const keyMap = {
        'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
        'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
        'Escape': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
      };

      const keyInfo = keyMap[key] || { key, code: key, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };

      // Send keydown then keyup
      chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...keyInfo
      }, () => {
        chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...keyInfo
        }, () => {
          // Detach debugger
          chrome.debugger.detach({ tabId }, () => {
            sendResponse({ ok: true });
          });
        });
      });
    });
    return true; // async
  }

  if (msg.type === 'CLICK_AT') {
    const tabId = sender.tab.id;
    const x = msg.x;
    const y = msg.y;

    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false });
        return;
      }

      // Send mousePressed then mouseReleased
      chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x, y,
        button: 'left',
        clickCount: 1
      }, () => {
        chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x, y,
          button: 'left',
          clickCount: 1
        }, () => {
          chrome.debugger.detach({ tabId }, () => {
            sendResponse({ ok: true });
          });
        });
      });
    });
    return true;
  }
});
