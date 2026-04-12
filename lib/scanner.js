const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGE_EXTS = new Set(['.heic', '.jpg', '.jpeg', '.png', '.gif', '.tiff', '.bmp', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi']);
const ALL_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);

function generateId(filePath) {
  return crypto.createHash('sha256').update(filePath).digest('hex').substring(0, 16);
}

function getMediaType(ext) {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

function scanDirectory(dirPath) {
  const results = [];

  if (!fs.existsSync(dirPath)) {
    console.warn(`[scanner] Directory not found: ${dirPath}`);
    return results;
  }

  function walk(currentPath) {
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (err) {
      console.warn(`[scanner] Cannot read directory: ${currentPath} - ${err.message}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        // Skip hidden directories
        if (!entry.name.startsWith('.')) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ALL_EXTS.has(ext)) {
          const type = getMediaType(ext);
          const relativePath = path.relative(dirPath, fullPath);
          let stat;
          try {
            stat = fs.statSync(fullPath);
          } catch (e) {
            continue;
          }
          results.push({
            id: generateId(relativePath),
            absolutePath: fullPath,
            relativePath,
            filename: entry.name,
            ext,
            type,
            size: stat.size,
            mtime: stat.mtimeMs
          });
        }
      }
    }
  }

  walk(dirPath);
  return results;
}

function scan(libraryPath) {
  console.log(`[scanner] Scanning: ${libraryPath}`);
  const startTime = Date.now();
  const items = scanDirectory(libraryPath);
  const elapsed = Date.now() - startTime;
  console.log(`[scanner] Found ${items.length} media files in ${elapsed}ms`);
  return items;
}

module.exports = { scan, generateId, getMediaType, IMAGE_EXTS, VIDEO_EXTS };
