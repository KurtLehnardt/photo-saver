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
  const hasPickedPhotos = !!(storeData.pickedPhotos && storeData.pickedPhotos.length > 0);
  res.json({ authenticated: hasTokens, configured, hasPickedPhotos });
});

// POST /api/google/logout - Clear tokens and picked photos
router.post('/logout', (req, res) => {
  const storeData = store.load();
  delete storeData.googleTokens;
  delete storeData.pickedPhotos;
  delete storeData.pickerSessionId;
  store.save(storeData);
  res.json({ ok: true });
});

// POST /api/google/picker - Create a new picker session
router.post('/picker', ensureAuth, async (req, res) => {
  try {
    const session = await google.createSession(req.accessToken);
    console.log('[google] Picker session created:', session.id);

    // Save session ID
    const storeData = store.load();
    storeData.pickerSessionId = session.id;
    store.save(storeData);

    res.json({
      sessionId: session.id,
      pickerUri: session.pickerUri,
      expireTime: session.expireTime
    });
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('[google] Create picker session error:', err.message);
    res.status(500).json({ error: 'Failed to create picker session' });
  }
});

// POST /api/google/picker/done - Poll session and save picked photos
router.post('/picker/done', ensureAuth, async (req, res) => {
  try {
    const storeData = store.load();
    const sessionId = storeData.pickerSessionId;

    if (!sessionId) {
      return res.status(400).json({ error: 'No active picker session' });
    }

    // Check session status
    const session = await google.getSession(req.accessToken, sessionId);
    console.log('[google] Session status:', session.mediaItemsSet);

    if (!session.mediaItemsSet) {
      return res.json({ ready: false, message: 'User has not finished picking photos yet' });
    }

    // Fetch all picked media items
    const items = await google.getAllPickedItems(req.accessToken, sessionId);
    console.log('[google] Picked', items.length, 'media items');

    // Save picked photos to store
    const pickedPhotos = items.map(item => ({
      id: item.id,
      type: item.type || 'PHOTO',
      baseUrl: item.mediaFile ? item.mediaFile.baseUrl : null,
      mimeType: item.mediaFile ? item.mediaFile.mimeType : null,
      filename: item.mediaFile ? item.mediaFile.filename : null
    }));

    storeData.pickedPhotos = pickedPhotos;
    store.save(storeData);

    res.json({ ready: true, count: pickedPhotos.length });
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('[google] Picker done error:', err.message);
    res.status(500).json({ error: 'Failed to fetch picked photos' });
  }
});

// GET /api/google/slides - Get slides from picked photos
router.get('/slides', ensureAuth, async (req, res) => {
  try {
    const storeData = store.load();
    const pickedPhotos = storeData.pickedPhotos || [];
    const hiddenIds = storeData.hiddenIds || [];

    if (pickedPhotos.length === 0) {
      return res.json({ slides: [], total: 0, visible: 0, hidden: 0 });
    }

    // Filter out hidden and build slides
    const slides = pickedPhotos
      .filter(item => item.baseUrl && !hiddenIds.includes(item.id))
      .map(item => {
        const isVideo = item.type === 'VIDEO' ||
          (item.mimeType && item.mimeType.startsWith('video/'));

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
          filename: item.filename
        };
      });

    res.json({
      slides,
      total: pickedPhotos.length,
      visible: slides.length,
      hidden: pickedPhotos.length - slides.length
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
