# FrameFlow

Two ways to put your photos on a screen:

- **[Server](#setup)** — self-hosted slideshow for turning an old iPad into a
  digital photo frame, reading directly from your macOS Apple Photos library.
- **[Chrome extension](extension/README.md)** — turns `icloud.com/photos` into a
  full-screen slideshow in the browser. No server, no Photos library.

The two are independent; the rest of this file covers the server.

## Features

- Full-screen slideshow with crossfade, slide, and dissolve transitions
- Ken Burns effect (slow pan/zoom on photos)
- Video autoplay with mute toggle
- Shuffle or sequential playback
- Configurable slide duration (3-30 seconds)
- Hide photos from slideshow without deleting them
- Wake-lock to prevent iPad from sleeping
- HEIC-to-JPEG conversion with resizing (2048px max)
- Works on Safari 12+ (iPad Air 1 and newer)

## Setup

```bash
cd frameflow
npm install
npm start
```

The server starts on port 3000. You'll see output like:

```
  FrameFlow - Photo Slideshow Server
  ===================================
  Photos library: /Users/you/Pictures/Photos Library.photoslibrary/originals

  Local:   http://localhost:3000
  Network: http://192.168.1.100:3000
```

Open the **Network URL** on your iPad.

## iPad Setup

1. Open Safari on your iPad
2. Navigate to the Network URL shown in the terminal
3. Tap the Share button → **Add to Home Screen**
4. Open the app from your Home Screen (runs in fullscreen)
5. Optional: Go to Settings → Display & Brightness → Auto-Lock → **Never**
6. Optional: Enable Guided Access (Settings → Accessibility → Guided Access) to prevent accidental exits

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `PHOTOS_LIBRARY` | `~/Pictures/Photos Library.photoslibrary/originals` | Path to media directory |

You can point `PHOTOS_LIBRARY` at any folder containing photos and videos:

```bash
PHOTOS_LIBRARY=/path/to/my/photos npm start
```

## Controls

- **Tap the screen** to show the hide button and playback controls
- **Gear icon** opens the settings panel
- Controls auto-hide after 5 seconds

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/slides` | GET | List visible slides |
| `/api/media/:id` | GET | Serve a media file |
| `/api/hide` | POST | Hide a slide `{ "id": "..." }` |
| `/api/unhide` | POST | Unhide a slide `{ "id": "..." }` |
| `/api/hidden` | GET | List hidden slides |
| `/api/settings` | GET/POST | Read/update settings |
| `/api/rescan` | POST | Rescan the photos library |
| `/api/health` | GET | Health check |

## Permissions

macOS may ask for permission to access your Photos library. Grant **Full Disk Access** to your Terminal app in System Preferences → Privacy & Security → Full Disk Access.

## Deploy to Vercel

> **Note:** Vercel runs this as a serverless function, which means:
> - No local filesystem access, so the Apple Photos library source is unavailable
>   — only the Google Photos source works.
> - `data/store.json` and `data/cache/` live on an ephemeral filesystem, so
>   hidden-photo state and converted images do **not** persist between
>   invocations. Hiding a photo will not stick.
>
> For a real photo frame, self-host it.

1. Install Vercel CLI: `npm i -g vercel`
2. Set environment variables:
   ```bash
   vercel env add GOOGLE_CLIENT_ID
   vercel env add GOOGLE_CLIENT_SECRET
   ```
3. Add your Vercel deployment URL as an authorized redirect URI in Google Cloud Console:
   `https://your-app.vercel.app/api/google/callback`
4. Deploy:
   ```bash
   vercel --prod
   ```

## License

MIT
