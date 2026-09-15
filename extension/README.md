# FrameFlow for iCloud Photos (Chrome Extension)

Turns `icloud.com/photos` into a full-screen slideshow — Ken Burns pan/zoom,
crossfade/slide transitions, shuffle, video playback, and per-photo hiding.

This is a separate product from the FrameFlow server in the repo root. It needs
no server and no Apple Photos library — it reads the photos already rendered in
your browser.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` directory

## Use

1. Go to `https://www.icloud.com/photos/` and sign in
2. Click the FrameFlow toolbar icon
3. Pick how many photos to load, then **Start Slideshow**
4. **Click any photo** to open it full-size — FrameFlow takes over from there and
   auto-advances through your library, capturing as it goes
5. When capture finishes the slideshow starts automatically

Click the screen during playback for controls (prev/next, pause, mute, hide,
settings, exit). `Esc` exits, arrow keys step, space advances.

## How capture works

iCloud renders its app inside a nested frame at
`https://www.icloud.com/applications/photos3/...`, and serves the photos
themselves from `*.icloud-content.com`. FrameFlow runs a content script in every
frame (`all_frames: true`) and captures the open photo in this order:

1. **Service-worker refetch (primary).** The frame reads the open `<img>`'s
   `currentSrc` and asks the background worker to fetch it. The worker carries the
   extension's host permissions and is not subject to page CORS, so this returns
   the **original full-resolution photo**.
2. **Canvas encode.** Used when the source is already same-origin (`blob:` /
   `data:`). Cross-origin sources taint the canvas and make `toDataURL()` throw,
   which is why this cannot be the primary path on iCloud.
3. **Cropped screenshot.** Last resort — `chrome.tabs.captureVisibleTab` plus a
   fixed crop. Lower quality, and only produces a real image when the window is
   actually on screen.

Photo data is handed to the top frame with `postMessage` targeted at
`https://www.icloud.com`, so iCloud's own page scripts can't read it.

Videos are recorded with `MediaRecorder` off a `captureStream()` of the `<video>`.
iCloud is advanced with a real `ArrowRight` via `chrome.debugger`.

### Why the host permissions

`*.icloud-content.com` and `*.cdn-apple.com` are where Apple serves the actual
image bytes. Without permission for those origins the worker cannot refetch a
photo, and capture falls back to screenshots of the viewport.

### Why the `debugger` permission

Synthetic `KeyboardEvent`s are untrusted and iCloud ignores them, so advancing
the library needs `chrome.debugger` → `Input.dispatchKeyEvent`. Chrome shows a
"FrameFlow started debugging this browser" bar while a capture run is active.
FrameFlow attaches **once per capture run** and detaches when it finishes; if the
permission is unavailable (e.g. DevTools already owns the tab) it falls back to
synthetic events, which usually will not advance iCloud.

## Notes and limits

- Captured media is held in memory and reused if you restart the slideshow.
  **Reload the page to force a fresh capture.** At most 2000 items are retained;
  older ones are dropped and their blob URLs released.
- If the console warns `Screenshot is blank` or `Overlay is not the topmost
  element`, capture or display is being blocked — those two cases used to fail
  silently as a black screen.
- "All (slow)" captures until iCloud stops producing new photos (8 consecutive
  empty rounds).
- Capture runs at roughly one item every 2s — 100 photos takes ~3.5 minutes.
- Hiding a photo affects this session only; nothing is written to iCloud and
  nothing is deleted.
- Keep the tab focused and in the foreground during capture. Screenshot fallback
  captures whatever is visible.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker — tab capture, debugger session, key dispatch |
| `content.js` | Both roles: per-frame capture, and top-frame overlay/slideshow |
| `overlay.css` | Slideshow overlay, controls, settings panel, Ken Burns keyframes |
| `popup.html` / `popup.js` | Toolbar popup and settings |
