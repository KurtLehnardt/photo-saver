# FrameFlow API Reference

FrameFlow is a self-hosted photo and video slideshow server. It reads media from an Apple Photos library on disk (or from Google Photos via OAuth) and exposes an HTTP API for controlling the slideshow, managing hidden items, and configuring settings. This document is intended for developers integrating with or extending FrameFlow.

---

## Base URL

All v1 endpoints are prefixed with `/v1`.

```
http://<your-server>:<port>/v1
```

Interactive Swagger UI is available at:

```
http://<your-server>:<port>/docs
```

---

## Quick Start

Fetch the list of visible slides, then download one image:

```bash
# 1. Get slide list
curl http://localhost:3000/v1/slides

# 2. Copy an `id` from the response, then fetch the image bytes
curl -o photo.jpg http://localhost:3000/v1/media/a3f9c1b2e5d74082
```

---

## Response Envelope

All JSON endpoints (except binary media) wrap their payload in a consistent envelope:

**Success:**
```json
{ "data": { ... }, "error": null }
```

**Error:**
```json
{ "data": null, "error": { "message": "Human-readable description", "code": "SNAKE_CASE_CODE" } }
```

---

## Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `NOT_FOUND` | 404 | The requested media item does not exist |
| `INVALID_INPUT` | 400 | A required parameter is missing or has the wrong type |
| `NOT_AUTHENTICATED` | 401 | No valid Google OAuth tokens; re-authenticate via `/v1/google/auth` |
| `NOT_CONFIGURED` | 500 | `GOOGLE_CLIENT_ID` env var is not set on the server |
| `INTERNAL_ERROR` | 500 | Unexpected server error (check server logs) |
| `NO_PICKER_SESSION` | 400 | Attempted to poll `/picker/done` without creating a session first |

---

## Local Library API

These endpoints operate on media files scanned from the local `PHOTOS_LIBRARY` directory.

---

### GET /v1/slides

List all visible (non-hidden) slides.

**Response:**
```json
{
  "data": {
    "slides": [
      { "id": "a3f9c1b2e5d74082", "type": "image", "src": "/v1/media/a3f9c1b2e5d74082", "filename": "IMG_4291.HEIC" },
      { "id": "b7e2d0f1c4a83591", "type": "video", "src": "/v1/media/b7e2d0f1c4a83591", "filename": "clip_0012.mov" }
    ],
    "total": 142,
    "visible": 139,
    "hidden": 3
  },
  "error": null
}
```

---

### GET /v1/slides/hidden

List all hidden slides.

**Response:** Same shape as `/v1/slides` but only hidden items are in `slides`.

---

### GET /v1/media/:id

Serve the raw bytes of a media item.

- Images are converted to JPEG and resized for display.
- Videos are streamed directly with `Accept-Ranges: bytes` support.
- **No response envelope** — the body is the binary content.

**Path parameter:** `id` — opaque media item ID from the slide list.

**Headers (optional):**
- `Range: bytes=<start>-<end>` — request a byte range (for video seeking).

**Response codes:**
- `200` — full content
- `206` — partial content (range request)
- `404` — item not found

**Note:** Video endpoints support HTTP Range requests, enabling seek-without-full-download in browsers and media players.

---

### POST /v1/media/:id/hide

Hide a media item so it no longer appears in slides.

**Path parameter:** `id` — media item ID.

**Response:**
```json
{ "data": { "hiddenCount": 4 }, "error": null }
```

---

### POST /v1/media/:id/unhide

Unhide a previously hidden item.

**Path parameter:** `id` — media item ID.

**Response:**
```json
{ "data": { "hiddenCount": 3 }, "error": null }
```

---

### POST /v1/library/rescan

Trigger a full re-scan of the photos library directory.

**Response:**
```json
{
  "data": {
    "previous": 140,
    "current": 142,
    "added": 2,
    "lastScan": 1718200000000
  },
  "error": null
}
```

---

### GET /v1/settings

Get current slideshow settings.

**Response:**
```json
{
  "data": {
    "shuffle": false,
    "transition": "fade",
    "fill": "contain",
    "kenBurns": true,
    "muted": false,
    "duration": 8,
    "paused": false
  },
  "error": null
}
```

---

### PATCH /v1/settings

Update slideshow settings (partial update — only provided fields are changed).

**Request body (all fields optional):**
```json
{
  "shuffle": true,
  "duration": 12,
  "muted": true
}
```

**Response:** Full settings object after update (same shape as `GET /v1/settings`).

---

### GET /v1/health

Health check — returns server status and basic library stats.

**Response:**
```json
{
  "data": {
    "ok": true,
    "slides": 142,
    "hidden": 3,
    "lastScan": 1718200000000
  },
  "error": null
}
```

---

## Google Photos API

These endpoints require the server to be configured with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables.

### OAuth Flow (3 steps)

1. **Send the user to `/v1/google/auth`** — the browser is redirected to Google's OAuth consent screen.
2. **Google redirects to `/v1/google/callback`** — the server exchanges the code for tokens and saves them, then redirects the browser to `/?source=google`.
3. **Create a picker session and wait** — call `POST /v1/google/picker` to get a picker URL, open it in the browser, then poll `POST /v1/google/picker/done` until `ready: true`.

---

### GET /v1/google/auth

Start the Google OAuth flow. Redirects the browser to Google's consent screen.

**Response:** HTTP 302 redirect.

---

### GET /v1/google/callback

OAuth callback. Handles the authorization code from Google. Redirects to `/?source=google` on success or `/?error=<message>` on failure. Not called directly by API consumers.

---

### GET /v1/google/status

Check authentication and picker state.

**Response:**
```json
{
  "data": {
    "authenticated": true,
    "configured": true,
    "hasPickedPhotos": false
  },
  "error": null
}
```

---

### POST /v1/google/logout

Clear stored Google tokens and picked photos.

**Response:**
```json
{ "data": { "ok": true }, "error": null }
```

---

### POST /v1/google/picker

Create a new Google Photos Picker session. The user must open `pickerUri` in their browser to select photos.

**Response:**
```json
{
  "data": {
    "sessionId": "Ab1cDeFgHiJk...",
    "pickerUri": "https://photos.google.com/picker?...",
    "expireTime": "2024-06-15T18:00:00Z"
  },
  "error": null
}
```

---

### POST /v1/google/picker/done

Poll whether the user has finished picking photos. Call after the user has interacted with the picker UI.

**Response (not ready):**
```json
{
  "data": { "ready": false, "message": "User has not finished picking photos yet" },
  "error": null
}
```

**Response (ready):**
```json
{
  "data": { "ready": true, "count": 24 },
  "error": null
}
```

---

### GET /v1/google/slides

Get slides from the user's picked Google Photos, excluding hidden items.

**Response:** Same shape as `GET /v1/slides`. Slide `src` values are Google Photos base URLs (not `/v1/media/` paths — they are served directly from Google's CDN).

```json
{
  "data": {
    "slides": [
      { "id": "AGcz...", "type": "image", "src": "https://lh3.googleusercontent.com/...=w2048-h2048", "filename": "photo.jpg" }
    ],
    "total": 24,
    "visible": 22,
    "hidden": 2
  },
  "error": null
}
```
