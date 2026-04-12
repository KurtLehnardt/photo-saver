// Simple .env loader (no dependency needed)
const envPath = require('path').join(__dirname, '.env');
try {
  const envFile = require('fs').readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    line = line.trim();
    if (line && !line.startsWith('#')) {
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0) {
        const key = line.substring(0, eqIndex).trim();
        const value = line.substring(eqIndex + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  });
} catch (e) { /* no .env file, that's fine */ }

const express = require('express');
const path = require('path');
const os = require('os');
const { router: apiRouter, loadMedia } = require('./routes/api');
const media = require('./lib/media');
const googleRoutes = require('./routes/google');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';

const LIBRARY_PATH = process.env.PHOTOS_LIBRARY ||
  path.join(os.homedir(), 'Pictures', 'Photos Library.photoslibrary', 'originals');

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', apiRouter);
app.use('/api/google', googleRoutes);

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

// Export for Vercel serverless
module.exports = app;
