const express = require('express');
const router = express.Router();
const google = require('../lib/google');
const store = require('../lib/store');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

function getRedirectUri(req) {
  // For Vercel/production, use the real host
  if (req.headers['x-forwarded-host']) {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'];
    return `${protocol}://${host}/api/google/callback`;
  }
  // For local dev, always use localhost (Google OAuth blocks private IPs)
  const port = req.socket.localPort || 3000;
  return `http://localhost:${port}/api/google/callback`;
}

// Middleware to ensure valid access token
async function ensureAuth(req, res, next) {
  const storeData = store.load();
  const tokens = storeData.googleTokens;

  if (!tokens || !tokens.refreshToken) {
    return res.status(401).json({ error: 'Not authenticated with Google' });
  }

  // Refresh if expired
  if (Date.now() >= tokens.expiresAt) {
    try {
      const refreshed = await google.refreshAccessToken(tokens.refreshToken, CLIENT_ID, CLIENT_SECRET);
      tokens.accessToken = refreshed.accessToken;
      tokens.expiresAt = refreshed.expiresAt;
      storeData.googleTokens = tokens;
      store.save(storeData);
    } catch (err) {
      console.error('[google] Token refresh failed:', err.message);
      return res.status(401).json({ error: 'Token refresh failed. Please re-authenticate.' });
    }
  }

  req.accessToken = tokens.accessToken;
  next();
}

// GET /api/google/auth - Start OAuth flow
router.get('/auth', (req, res) => {
  if (!CLIENT_ID) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not configured' });
  }
  const redirectUri = getRedirectUri(req);
  const authUrl = google.getAuthUrl(CLIENT_ID, redirectUri);
  res.redirect(authUrl);
});

// GET /api/google/callback - OAuth callback
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/?error=' + encodeURIComponent(error));
  }

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    const redirectUri = getRedirectUri(req);
    const tokens = await google.exchangeCode(code, CLIENT_ID, CLIENT_SECRET, redirectUri);

    // Save tokens to store
    const storeData = store.load();
    storeData.googleTokens = tokens;
    store.save(storeData);

    console.log('[google] OAuth successful, tokens saved');
    res.redirect('/?source=google');
  } catch (err) {
    console.error('[google] OAuth error:', err.message);
    res.redirect('/?error=' + encodeURIComponent(err.message));
  }
});

// GET /api/google/status - Check if authenticated
router.get('/status', (req, res) => {
  const storeData = store.load();
  const tokens = storeData.googleTokens;
  const hasTokens = !!(tokens && tokens.refreshToken);
  const configured = !!CLIENT_ID;
  res.json({ authenticated: hasTokens, configured });
});

// POST /api/google/logout - Clear tokens
router.post('/logout', (req, res) => {
  const storeData = store.load();
  delete storeData.googleTokens;
  delete storeData.selectedAlbums;
  store.save(storeData);
  res.json({ ok: true });
});

// GET /api/google/albums - List user's albums
router.get('/albums', ensureAuth, async (req, res) => {
  try {
    const albums = [];
    let pageToken = null;

    do {
      const result = await google.listAlbums(req.accessToken, pageToken);
      if (result.albums) {
        albums.push(...result.albums.map(a => ({
          id: a.id,
          title: a.title,
          mediaItemsCount: parseInt(a.mediaItemsCount || '0', 10),
          coverPhotoBaseUrl: a.coverPhotoBaseUrl
        })));
      }
      pageToken = result.nextPageToken || null;
    } while (pageToken);

    // Include which albums are currently selected
    const storeData = store.load();
    const selectedIds = storeData.selectedAlbums || [];

    res.json({
      albums: albums.map(a => ({
        ...a,
        selected: selectedIds.includes(a.id)
      }))
    });
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('[google] List albums error:', err.message);
    res.status(500).json({ error: 'Failed to list albums' });
  }
});

// POST /api/google/select-albums - Save selected album IDs
router.post('/select-albums', express.json(), (req, res) => {
  const { albumIds } = req.body;
  if (!Array.isArray(albumIds)) {
    return res.status(400).json({ error: 'albumIds must be an array' });
  }

  const storeData = store.load();
  storeData.selectedAlbums = albumIds;
  store.save(storeData);

  res.json({ ok: true, selected: albumIds.length });
});

// GET /api/google/slides - Get slides from selected albums
router.get('/slides', ensureAuth, async (req, res) => {
  try {
    const storeData = store.load();
    const albumIds = storeData.selectedAlbums || [];
    const hiddenIds = storeData.hiddenIds || [];

    if (albumIds.length === 0) {
      return res.json({ slides: [], total: 0, visible: 0, hidden: 0 });
    }

    const mediaItems = await google.getAllMediaFromAlbums(req.accessToken, albumIds);

    // Filter to photos and videos, exclude hidden
    const slides = mediaItems
      .filter(item => !hiddenIds.includes(item.id))
      .map(item => {
        const isVideo = item.mediaMetadata && item.mediaMetadata.video;
        // Google Photos baseUrl requires size parameters to be appended
        // For images: =w{width}-h{height}
        // For videos: =dv (download video)
        let src;
        if (isVideo) {
          src = item.baseUrl + '=dv';
        } else {
          src = item.baseUrl + '=w2048-h2048';
        }

        return {
          id: item.id,
          type: isVideo ? 'video' : 'image',
          src,
          filename: item.filename,
          width: item.mediaMetadata ? parseInt(item.mediaMetadata.width, 10) : null,
          height: item.mediaMetadata ? parseInt(item.mediaMetadata.height, 10) : null
        };
      });

    res.json({
      slides,
      total: mediaItems.length,
      visible: slides.length,
      hidden: mediaItems.length - slides.length
    });
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('[google] Slides error:', err.message);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

module.exports = router;
