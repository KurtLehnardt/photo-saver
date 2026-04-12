const express = require('express');
const path = require('path');
const os = require('os');
const { router: apiRouter, loadMedia } = require('./routes/api');
const media = require('./lib/media');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';

const LIBRARY_PATH = process.env.PHOTOS_LIBRARY ||
  path.join(os.homedir(), 'Pictures', 'Photos Library.photoslibrary', 'originals');

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', apiRouter);

// Start server
async function start() {
  console.log('');
  console.log('  FrameFlow - Photo Slideshow Server');
  console.log('  ===================================');
  console.log(`  Photos library: ${LIBRARY_PATH}`);
  console.log('');

  // Initial scan
  const items = loadMedia(LIBRARY_PATH);
  console.log(`  Found ${items.length} media files`);
  console.log('');

  // Start listening
  app.listen(PORT, HOST, () => {
    // Get LAN IP
    const interfaces = os.networkInterfaces();
    let lanIP = 'localhost';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          lanIP = iface.address;
          break;
        }
      }
    }

    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://${lanIP}:${PORT}`);
    console.log('');
    console.log('  Open the Network URL on your iPad');
    console.log('  Add to Home Screen for fullscreen mode');
    console.log('');

    // Pre-convert images in background
    media.preconvertAll(items).catch(err => {
      console.error('[startup] Pre-conversion error:', err.message);
    });
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
