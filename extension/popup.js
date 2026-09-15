// Popup script — communicates with content script on icloud.com/photos

const statusEl = document.getElementById('status');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');

let currentTabId = null;

// Load saved settings
chrome.storage.local.get(['frameflow_settings'], (result) => {
  const s = (result && result.frameflow_settings) || {};
  if (s.shuffle !== undefined) document.getElementById('set-shuffle').checked = s.shuffle;
  if (s.transition) document.getElementById('set-transition').value = s.transition;
  if (s.fill) document.getElementById('set-fill').value = s.fill;
  if (s.targetPhotos !== undefined) document.getElementById('set-photo-count').value = String(s.targetPhotos);
  if (s.kenBurns !== undefined) document.getElementById('set-kenburns').checked = s.kenBurns;
  if (s.duration) {
    document.getElementById('set-duration').value = s.duration;
    document.getElementById('duration-val').textContent = s.duration + 's';
  }
});

function getSettings() {
  return {
    shuffle: document.getElementById('set-shuffle').checked,
    transition: document.getElementById('set-transition').value,
    fill: document.getElementById('set-fill').value,
    kenBurns: document.getElementById('set-kenburns').checked,
    duration: parseInt(document.getElementById('set-duration').value, 10),
    // 0 means "All" — the content script treats any non-positive value as unlimited
    targetPhotos: parseInt(document.getElementById('set-photo-count').value, 10)
  };
}

function saveSettings() {
  chrome.storage.local.set({ frameflow_settings: getSettings() });
}

// Save on change
document.querySelectorAll('input, select').forEach(el => {
  el.addEventListener('change', saveSettings);
});

document.getElementById('set-duration').addEventListener('input', (e) => {
  document.getElementById('duration-val').textContent = e.target.value + 's';
});

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

function showRunning() {
  btnStart.style.display = 'none';
  btnStop.style.display = 'block';
}

function showStopped() {
  btnStart.style.display = 'block';
  btnStop.style.display = 'none';
}

// Check if we're on the right page
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab) {
    setStatus('No active tab', 'error');
    btnStart.disabled = true;
    return;
  }
  currentTabId = tab.id;

  if (!tab.url || !tab.url.includes('icloud.com/photos')) {
    setStatus('Navigate to icloud.com/photos first', 'error');
    btnStart.disabled = true;
    return;
  }

  // Ping content script to check status
  chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setStatus('Reload the iCloud Photos page, then try again', 'error');
      btnStart.disabled = true;
      return;
    }

    if (response.running) {
      setStatus('Slideshow running (' + (response.photoCount || 0) + ' photos)', 'ok');
      showRunning();
      return;
    }

    const count = response.photoCount || 0;
    setStatus(count > 0
      ? 'Ready — ' + count + ' photos detected'
      : 'Ready — photos will be captured on start', 'ok');
    btnStart.disabled = false;
  });
});

// Start slideshow
btnStart.addEventListener('click', () => {
  if (!currentTabId) return;

  saveSettings();

  chrome.tabs.sendMessage(currentTabId, {
    type: 'START_SLIDESHOW',
    settings: getSettings()
  }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (response && response.ok) {
      setStatus('Slideshow started! (' + (response.photoCount || 0) + ' photos)', 'ok');
      showRunning();
    }
  });
});

// Stop slideshow
btnStop.addEventListener('click', () => {
  if (!currentTabId) return;

  chrome.tabs.sendMessage(currentTabId, { type: 'STOP_SLIDESHOW' }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (response && response.ok) {
      setStatus('Slideshow stopped');
      showStopped();
    }
  });
});
