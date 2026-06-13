const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const store = require('../lib/store');
const scanner = require('../lib/scanner');
const media = require('../lib/media');
const google = require('../lib/google');

// ---------------------------------------------------------------------------
// In-memory media state (independent of /api router)
// ---------------------------------------------------------------------------
let mediaItems = [];
let lastScanTime = null;

function loadMedia(libraryPath) {
  mediaItems = scanner.scan(libraryPath);
  lastScanTime = Date.now();
  return mediaItems;
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------
function ok(res, data, status) {
  res.status(status || 200).json({ data, error: null });
}

function err(res, status, message, code) {
  res.status(status).json({ data: null, error: { message, code } });
}

// ---------------------------------------------------------------------------
// Google OAuth helpers (mirrors routes/google.js patterns)
// ---------------------------------------------------------------------------
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

function getRedirectUri(req) {
  if (req.headers['x-forwarded-host']) {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'];
    return `${protocol}://${host}/v1/google/callback`;
  }
  const port = req.socket.localPort || 3000;
  return `http://localhost:${port}/v1/google/callback`;
}

async function ensureAuth(req, res, next) {
  const storeData = store.load();
  const tokens = storeData.googleTokens;

  if (!tokens || !tokens.refreshToken) {
    return err(res, 401, 'Not authenticated with Google', 'NOT_AUTHENTICATED');
  }

  if (Date.now() >= tokens.expiresAt) {
    try {
      const refreshed = await google.refreshAccessToken(tokens.refreshToken, CLIENT_ID, CLIENT_SECRET);
      tokens.accessToken = refreshed.accessToken;
      tokens.expiresAt = refreshed.expiresAt;
      storeData.googleTokens = tokens;
      store.save(storeData);
    } catch (e) {
      console.error('[v1/google] Token refresh failed:', e.message);
      return err(res, 401, 'Token refresh failed. Please re-authenticate.', 'NOT_AUTHENTICATED');
    }
  }

  req.accessToken = tokens.accessToken;
  next();
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

// GET /v1/slides — list visible slides
router.get('/slides', (req, res) => {
  const hiddenIds = store.getHiddenIds();
  const visible = mediaItems.filter(item => !hiddenIds.includes(item.id));

  const slides = visible.map(item => ({
    id: item.id,
    type: item.type,
    src: `/v1/media/${item.id}`,
    filename: item.filename
  }));

  ok(res, {
    slides,
    total: mediaItems.length,
    visible: slides.length,
    hidden: hiddenIds.length
  });
});

// GET /v1/slides/hidden — list hidden slides
router.get('/slides/hidden', (req, res) => {
  const hiddenIds = store.getHiddenIds();
  const hiddenItems = mediaItems
    .filter(item => hiddenIds.includes(item.id))
    .map(item => ({
      id: item.id,
      type: item.type,
      src: `/v1/media/${item.id}`,
      filename: item.filename
    }));

  ok(res, {
    slides: hiddenItems,
    total: mediaItems.length,
    visible: mediaItems.length - hiddenItems.length,
    hidden: hiddenItems.length
  });
});

// ---------------------------------------------------------------------------
// Media (binary — no envelope)
// ---------------------------------------------------------------------------

// GET /v1/media/:id — serve media file
router.get('/media/:id', async (req, res) => {
  const id = req.params.id;
  const item = mediaItems.find(m => m.id === id);

  if (!item) {
    return res.status(404).json({ data: null, error: { message: 'Media not found', code: 'NOT_FOUND' } });
  }

  try {
    if (item.type === 'image') {
      const cachePath = await media.convertAndResize(item.absolutePath, item.id);
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(cachePath).pipe(res);
    } else {
      const stat = fs.statSync(item.absolutePath);
      const mimeType = media.getMimeType(item.ext);
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=86400'
        });
        fs.createReadStream(item.absolutePath, { start, end }).pipe(res);
      } else {
        res.set('Content-Type', mimeType);
        res.set('Content-Length', stat.size);
        res.set('Accept-Ranges', 'bytes');
        res.set('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(item.absolutePath).pipe(res);
      }
    }
  } catch (e) {
    console.error(`[v1] Error serving media ${id}:`, e.message);
    res.status(500).json({ data: null, error: { message: 'Failed to serve media', code: 'INTERNAL_ERROR' } });
  }
});

// ---------------------------------------------------------------------------
// Hide / Unhide
// ---------------------------------------------------------------------------

// POST /v1/media/:id/hide
router.post('/media/:id/hide', express.json(), (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== 'string') {
    return err(res, 400, 'id is required', 'INVALID_INPUT');
  }
  const result = store.hideMedia(id);
  ok(res, { hiddenCount: result.hiddenIds.length });
});

// POST /v1/media/:id/unhide
router.post('/media/:id/unhide', express.json(), (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== 'string') {
    return err(res, 400, 'id is required', 'INVALID_INPUT');
  }
  const result = store.unhideMedia(id);
  ok(res, { hiddenCount: result.hiddenIds.length });
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

// POST /v1/library/rescan
router.post('/library/rescan', async (req, res) => {
  const libraryPath = process.env.PHOTOS_LIBRARY ||
    path.join(process.env.HOME, 'Pictures', 'Photos Library.photoslibrary', 'originals');

  const oldCount = mediaItems.length;
  loadMedia(libraryPath);
  const newCount = mediaItems.length;

  media.preconvertAll(mediaItems).catch(e => {
    console.error('[v1] Background preconversion error:', e.message);
  });

  ok(res, {
    previous: oldCount,
    current: newCount,
    added: Math.max(0, newCount - oldCount),
    lastScan: lastScanTime
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// GET /v1/settings
router.get('/settings', (req, res) => {
  ok(res, store.getSettings());
});

// PATCH /v1/settings
router.patch('/settings', express.json(), (req, res) => {
  const allowed = ['shuffle', 'transition', 'fill', 'kenBurns', 'muted', 'duration', 'paused'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }
  const settings = store.updateSettings(updates);
  ok(res, settings);
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

// GET /v1/health
router.get('/health', (req, res) => {
  ok(res, {
    ok: true,
    slides: mediaItems.length,
    hidden: store.getHiddenIds().length,
    lastScan: lastScanTime
  });
});

// ---------------------------------------------------------------------------
// Google OAuth + Photos
// ---------------------------------------------------------------------------

// GET /v1/google/auth — start OAuth flow (redirect, no envelope)
router.get('/google/auth', (req, res) => {
  if (!CLIENT_ID) {
    return err(res, 500, 'GOOGLE_CLIENT_ID not configured', 'NOT_CONFIGURED');
  }
  const redirectUri = getRedirectUri(req);
  const authUrl = google.getAuthUrl(CLIENT_ID, redirectUri);
  res.redirect(authUrl);
});

// GET /v1/google/callback — OAuth callback (redirect, no envelope)
router.get('/google/callback', async (req, res) => {
  const { code, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect('/?error=' + encodeURIComponent(oauthError));
  }
  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    const redirectUri = getRedirectUri(req);
    const tokens = await google.exchangeCode(code, CLIENT_ID, CLIENT_SECRET, redirectUri);
    const storeData = store.load();
    storeData.googleTokens = tokens;
    store.save(storeData);
    console.log('[v1/google] OAuth successful, tokens saved');
    res.redirect('/?source=google');
  } catch (e) {
    console.error('[v1/google] OAuth error:', e.message);
    res.redirect('/?error=' + encodeURIComponent(e.message));
  }
});

// GET /v1/google/status
router.get('/google/status', (req, res) => {
  const storeData = store.load();
  const tokens = storeData.googleTokens;
  const authenticated = !!(tokens && tokens.refreshToken);
  const configured = !!CLIENT_ID;
  const hasPickedPhotos = !!(storeData.pickedPhotos && storeData.pickedPhotos.length > 0);
  ok(res, { authenticated, configured, hasPickedPhotos });
});

// POST /v1/google/logout
router.post('/google/logout', (req, res) => {
  const storeData = store.load();
  delete storeData.googleTokens;
  delete storeData.pickedPhotos;
  delete storeData.pickerSessionId;
  store.save(storeData);
  ok(res, { ok: true });
});

// POST /v1/google/picker
router.post('/google/picker', ensureAuth, async (req, res) => {
  try {
    const session = await google.createSession(req.accessToken);
    console.log('[v1/google] Picker session created:', session.id);

    const storeData = store.load();
    storeData.pickerSessionId = session.id;
    store.save(storeData);

    ok(res, {
      sessionId: session.id,
      pickerUri: session.pickerUri,
      expireTime: session.expireTime
    });
  } catch (e) {
    if (e.message === 'UNAUTHORIZED') {
      return err(res, 401, 'Token expired', 'NOT_AUTHENTICATED');
    }
    console.error('[v1/google] Create picker session error:', e.message);
    err(res, 500, 'Failed to create picker session', 'INTERNAL_ERROR');
  }
});

// POST /v1/google/picker/done
router.post('/google/picker/done', ensureAuth, async (req, res) => {
  try {
    const storeData = store.load();
    const sessionId = storeData.pickerSessionId;

    if (!sessionId) {
      return err(res, 400, 'No active picker session', 'NO_PICKER_SESSION');
    }

    const session = await google.getSession(req.accessToken, sessionId);
    console.log('[v1/google] Session status:', session.mediaItemsSet);

    if (!session.mediaItemsSet) {
      return ok(res, { ready: false, message: 'User has not finished picking photos yet' });
    }

    const items = await google.getAllPickedItems(req.accessToken, sessionId);
    console.log('[v1/google] Picked', items.length, 'media items');

    const pickedPhotos = items.map(item => ({
      id: item.id,
      type: item.type || 'PHOTO',
      baseUrl: item.mediaFile ? item.mediaFile.baseUrl : null,
      mimeType: item.mediaFile ? item.mediaFile.mimeType : null,
      filename: item.mediaFile ? item.mediaFile.filename : null
    }));

    storeData.pickedPhotos = pickedPhotos;
    store.save(storeData);

    ok(res, { ready: true, count: pickedPhotos.length });
  } catch (e) {
    if (e.message === 'UNAUTHORIZED') {
      return err(res, 401, 'Token expired', 'NOT_AUTHENTICATED');
    }
    console.error('[v1/google] Picker done error:', e.message);
    err(res, 500, 'Failed to fetch picked photos', 'INTERNAL_ERROR');
  }
});

// GET /v1/google/slides
router.get('/google/slides', ensureAuth, async (req, res) => {
  try {
    const storeData = store.load();
    const pickedPhotos = storeData.pickedPhotos || [];
    const hiddenIds = storeData.hiddenIds || [];

    if (pickedPhotos.length === 0) {
      return ok(res, { slides: [], total: 0, visible: 0, hidden: 0 });
    }

    const slides = pickedPhotos
      .filter(item => item.baseUrl && !hiddenIds.includes(item.id))
      .map(item => {
        const isVideo = item.type === 'VIDEO' ||
          (item.mimeType && item.mimeType.startsWith('video/'));
        const src = isVideo ? item.baseUrl + '=dv' : item.baseUrl + '=w2048-h2048';
        return {
          id: item.id,
          type: isVideo ? 'video' : 'image',
          src,
          filename: item.filename
        };
      });

    ok(res, {
      slides,
      total: pickedPhotos.length,
      visible: slides.length,
      hidden: pickedPhotos.length - slides.length
    });
  } catch (e) {
    if (e.message === 'UNAUTHORIZED') {
      return err(res, 401, 'Token expired', 'NOT_AUTHENTICATED');
    }
    console.error('[v1/google] Slides error:', e.message);
    err(res, 500, 'Failed to fetch photos', 'INTERNAL_ERROR');
  }
});

module.exports = { router, loadMedia };
