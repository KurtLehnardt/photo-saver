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

iCloud serves photos as same-origin `blob:` URLs inside a nested frame, so there
is no image URL to collect. FrameFlow instead:

- runs a content script in every frame (`all_frames: true`)
- has the **frame** instance draw the open photo to a canvas and hand the encoded
  JPEG to the top frame (`postMessage`, targeted at `https://www.icloud.com` so
  the page's own scripts can't read it)
- falls back to `chrome.tabs.captureVisibleTab` + a fixed crop when the canvas
  route fails
- records videos with `MediaRecorder` off a `captureStream()` of the `<video>`
- advances iCloud with a real `ArrowRight` via `chrome.debugger`

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
