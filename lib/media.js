const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 85;
const HEIC_EXTS = new Set(['.heic', '.heif']);

// In-flight conversion map to prevent duplicate work
const inflight = new Map();

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCachePath(id) {
  return path.join(CACHE_DIR, `${id}.jpg`);
}

function isCached(id) {
  return fs.existsSync(getCachePath(id));
}

async function convertAndResize(sourcePath, id) {
  const cachePath = getCachePath(id);

  // Check cache first
  if (fs.existsSync(cachePath)) {
    return cachePath;
  }

  // Check if conversion is already in flight
  if (inflight.has(id)) {
    return inflight.get(id);
  }

  const conversionPromise = (async () => {
    try {
      ensureCacheDir();
      const tmpPath = cachePath + '.tmp';
      const ext = path.extname(sourcePath).toLowerCase();

      if (HEIC_EXTS.has(ext)) {
        // Use macOS sips for HEIC→JPEG (sharp lacks HEIC plugin on most systems)
        // sips converts and resizes in one pass
        execFileSync('sips', [
          '-s', 'format', 'jpeg',
          '-s', 'formatOptions', String(JPEG_QUALITY),
          '-Z', String(MAX_DIMENSION),
          sourcePath,
          '--out', tmpPath
        ], { stdio: 'pipe' });
      } else {
        // Use sharp for other formats (JPG, PNG, etc.)
        await sharp(sourcePath)
          .rotate() // Auto-orient based on EXIF
          .resize({
            width: MAX_DIMENSION,
            height: MAX_DIMENSION,
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({ quality: JPEG_QUALITY })
          .toFile(tmpPath);
      }

      // Atomic rename
      fs.renameSync(tmpPath, cachePath);
      console.log(`[media] Converted: ${path.basename(sourcePath)} → ${id}.jpg`);
      return cachePath;
    } catch (err) {
      // Clean up temp file on error
      const tmpPath = cachePath + '.tmp';
      try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
      console.error(`[media] Conversion failed for ${sourcePath}: ${err.message}`);
      throw err;
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, conversionPromise);
  return conversionPromise;
}

// Pre-convert all images in background with concurrency limit
async function preconvertAll(mediaItems, concurrency = 4) {
  const images = mediaItems.filter(item => item.type === 'image');
  const uncached = images.filter(item => !isCached(item.id));

  if (uncached.length === 0) {
    console.log('[media] All images already cached');
    return;
  }

  console.log(`[media] Pre-converting ${uncached.length} images (concurrency: ${concurrency})...`);

  let completed = 0;
  const startTime = Date.now();

  // Process in batches for concurrency control
  for (let i = 0; i < uncached.length; i += concurrency) {
    const batch = uncached.slice(i, i + concurrency);
    const promises = batch.map(async (item) => {
      try {
        await convertAndResize(item.absolutePath, item.id);
        completed++;
        if (completed % 10 === 0 || completed === uncached.length) {
          console.log(`[media] Progress: ${completed}/${uncached.length}`);
        }
      } catch (err) {
        completed++;
        console.warn(`[media] Skipping ${item.filename}: ${err.message}`);
      }
    });
    await Promise.all(promises);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[media] Pre-conversion complete in ${elapsed}s`);
}

function getMimeType(ext) {
  const types = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/jpeg', // served as converted JPEG
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo'
  };
  return types[ext] || 'application/octet-stream';
}

module.exports = { convertAndResize, preconvertAll, getCachePath, isCached, getMimeType, ensureCacheDir };
