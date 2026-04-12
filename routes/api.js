const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const store = require('../lib/store');
const scanner = require('../lib/scanner');
const media = require('../lib/media');

// In-memory media list
let mediaItems = [];
let lastScanTime = null;

function loadMedia(libraryPath) {
  mediaItems = scanner.scan(libraryPath);
  lastScanTime = Date.now();
  return mediaItems;
}

// GET /api/slides - Return non-hidden media for slideshow
router.get('/slides', (req, res) => {
  const hiddenIds = store.getHiddenIds();
  const visible = mediaItems.filter(item => !hiddenIds.includes(item.id));

  const slides = visible.map(item => ({
    id: item.id,
    type: item.type,
    src: `/api/media/${item.id}`,
    filename: item.filename
  }));

  res.json({
    slides,
    total: mediaItems.length,
    visible: slides.length,
    hidden: hiddenIds.length
  });
});

// GET /api/media/:id - Serve a media file (converted/resized for images)
router.get('/media/:id', async (req, res) => {
  const id = req.params.id;

  // Find the media item - use opaque ID lookup only (no path traversal)
  const item = mediaItems.find(m => m.id === id);
  if (!item) {
    return res.status(404).json({ error: 'Media not found' });
  }

  try {
    if (item.type === 'image') {
      // Serve converted/resized JPEG
      const cachePath = await media.convertAndResize(item.absolutePath, item.id);
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(cachePath).pipe(res);
    } else {
      // Serve video directly
      const stat = fs.statSync(item.absolutePath);
      const mimeType = media.getMimeType(item.ext);

      // Support range requests for video seeking
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
  } catch (err) {
    console.error(`[api] Error serving media ${id}: ${err.message}`);
    res.status(500).json({ error: 'Failed to serve media' });
  }
});

// POST /api/hide - Hide a media item
router.post('/hide', express.json(), (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }
  const result = store.hideMedia(id);
  res.json({ ok: true, hiddenCount: result.hiddenIds.length });
});

// POST /api/unhide - Unhide a media item
router.post('/unhide', express.json(), (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }
  const result = store.unhideMedia(id);
  res.json({ ok: true, hiddenCount: result.hiddenIds.length });
});

// GET /api/hidden - List hidden items
router.get('/hidden', (req, res) => {
  const hiddenIds = store.getHiddenIds();
  const hiddenItems = mediaItems
    .filter(item => hiddenIds.includes(item.id))
    .map(item => ({
      id: item.id,
      type: item.type,
      src: `/api/media/${item.id}`,
      filename: item.filename
    }));
  res.json({ hidden: hiddenItems });
});

// GET /api/settings - Get current settings
router.get('/settings', (req, res) => {
  res.json(store.getSettings());
});

// POST /api/settings - Update settings
router.post('/settings', express.json(), (req, res) => {
  const allowed = ['shuffle', 'transition', 'fill', 'kenBurns', 'muted', 'duration', 'paused'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }
  const settings = store.updateSettings(updates);
  res.json(settings);
});

// POST /api/rescan - Trigger a media library rescan
router.post('/rescan', async (req, res) => {
  const libraryPath = process.env.PHOTOS_LIBRARY ||
    path.join(process.env.HOME, 'Pictures', 'Photos Library.photoslibrary', 'originals');

  const oldCount = mediaItems.length;
  loadMedia(libraryPath);
  const newCount = mediaItems.length;

  // Pre-convert new images in background
  media.preconvertAll(mediaItems).catch(err => {
    console.error('[api] Background preconversion error:', err.message);
  });

  res.json({
    ok: true,
    previous: oldCount,
    current: newCount,
    added: Math.max(0, newCount - oldCount),
    lastScan: lastScanTime
  });
});

// GET /api/health - Health check
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    slides: mediaItems.length,
    hidden: store.getHiddenIds().length,
    lastScan: lastScanTime
  });
});

module.exports = { router, loadMedia };
