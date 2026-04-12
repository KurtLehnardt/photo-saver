const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

const DEFAULT_STORE = {
  hiddenIds: [],
  settings: {
    shuffle: true,
    transition: 'fade',
    fill: 'contain',
    kenBurns: true,
    muted: true,
    duration: 8,
    paused: false
  }
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load() {
  ensureDataDir();
  try {
    const data = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Try .tmp fallback in case of crash during write
      const tmpPath = STORE_PATH + '.tmp';
      try {
        const data = fs.readFileSync(tmpPath, 'utf8');
        const parsed = JSON.parse(data);
        // Promote tmp to main
        fs.renameSync(tmpPath, STORE_PATH);
        return parsed;
      } catch (e) {
        // No store exists yet, return defaults
        return JSON.parse(JSON.stringify(DEFAULT_STORE));
      }
    }
    // Corrupt file, return defaults
    return JSON.parse(JSON.stringify(DEFAULT_STORE));
  }
}

function save(data) {
  ensureDataDir();
  const tmpPath = STORE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, STORE_PATH);
}

function hideMedia(id) {
  const store = load();
  if (!store.hiddenIds.includes(id)) {
    store.hiddenIds.push(id);
    save(store);
  }
  return store;
}

function unhideMedia(id) {
  const store = load();
  store.hiddenIds = store.hiddenIds.filter(x => x !== id);
  save(store);
  return store;
}

function getSettings() {
  const store = load();
  return store.settings || DEFAULT_STORE.settings;
}

function updateSettings(partial) {
  const store = load();
  store.settings = { ...store.settings, ...partial };
  save(store);
  return store.settings;
}

function getHiddenIds() {
  const store = load();
  return store.hiddenIds || [];
}

module.exports = { load, save, hideMedia, unhideMedia, getSettings, updateSettings, getHiddenIds, DEFAULT_STORE };
