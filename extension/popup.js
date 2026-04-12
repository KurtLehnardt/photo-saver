// Popup script — communicates with content script on icloud.com/photos

const statusEl = document.getElementById('status');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');

let currentTabId = null;

// Load saved settings
chrome.storage.local.get(['frameflow_settings'], (result) => {
  const s = result.frameflow_settings || {};
  if (s.shuffle !== undefined) document.getElementById('set-shuffle').checked = s.shuffle;
  if (s.transition) document.getElementById('set-transition').value = s.transition;
  if (s.fill) document.getElementById('set-fill').value = s.fill;
  if (s.targetPhotos !== undefined) document.getElementById('set-photo-count').value = s.targetPhotos;
  if (s.hiRes !== undefined) {
    document.getElementById('set-hires').checked = s.hiRes;
    document.getElementById('hires-note').style.display = s.hiRes ? 'block' : 'none';
  }
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
    targetPhotos: parseInt(document.getElementById('set-photo-count').value, 10),
    hiRes: document.getElementById('set-hires').checked
  };
}

function saveSettings() {
  chrome.storage.local.set({ frameflow_settings: getSettings() });
}

// Save on change
document.querySelectorAll('input, select').forEach(el => {
  el.addEventListener('change', saveSettings);
});

document.getElementById('set-hires').addEventListener('change', (e) => {
  document.getElementById('hires-note').style.display = e.target.checked ? 'block' : 'none';
  saveSettings();
});

document.getElementById('set-duration').addEventListener('input', (e) => {
  document.getElementById('duration-val').textContent = e.target.value + 's';
});

// Check if we're on the right page
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  currentTabId = tab.id;

  if (!tab.url || !tab.url.includes('icloud.com/photos')) {
    statusEl.textContent = 'Navigate to icloud.com/photos first';
    statusEl.className = 'status error';
    btnStart.disabled = true;
    return;
  }

  // Ping content script to check status
  chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = 'Reload the iCloud Photos page, then try again';
      statusEl.className = 'status error';
      btnStart.disabled = true;
      return;
    }

    if (response && response.running) {
      statusEl.textContent = 'Slideshow running (' + response.photoCount + ' photos)';
      statusEl.className = 'status ok';
      btnStart.style.display = 'none';
      btnStop.style.display = 'block';
    } else {
      const count = response.photoCount || 0;
      if (count > 0) {
        statusEl.textContent = 'Ready — ' + count + ' photos detected';
      } else {
        statusEl.textContent = 'Ready — photos will be captured on start';
      }
      statusEl.className = 'status ok';
      btnStart.disabled = false;
    }
  });
});

// Start slideshow
btnStart.addEventListener('click', () => {
  if (!currentTabId) return;

  const settings = getSettings();
  saveSettings();

  chrome.tabs.sendMessage(currentTabId, {
    type: 'START_SLIDESHOW',
    settings: settings
  }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = 'Error: ' + chrome.runtime.lastError.message;
      statusEl.className = 'status error';
      return;
    }
    if (response && response.ok) {
      statusEl.textContent = 'Slideshow started! (' + response.photoCount + ' photos)';
      statusEl.className = 'status ok';
      btnStart.style.display = 'none';
      btnStop.style.display = 'block';
    }
  });
});

// Stop slideshow
btnStop.addEventListener('click', () => {
  if (!currentTabId) return;

  chrome.tabs.sendMessage(currentTabId, { type: 'STOP_SLIDESHOW' }, (response) => {
    if (response && response.ok) {
      statusEl.textContent = 'Slideshow stopped';
      statusEl.className = 'status';
      btnStart.style.display = 'block';
      btnStop.style.display = 'none';
    }
  });
});
