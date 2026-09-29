# SoulSync Companion — MVP Spec

**Status:** building — greenlit Sep 28, 2026.

**Goal:** while you're browsing music anywhere, one click gets it onto your
SoulSync server. No audio capture, no accounts, no cloud — just your server URL
+ API key, the same pattern as the *arr companion apps.

## In scope

### 1. Now Playing via Media Session
- A content script reads `navigator.mediaSession.metadata` on the active tab
  (title, artist, album, artwork). No audio capture, so it works on DRM players.
- The popup shows what's playing with artwork and a **Wishlist** button. The
  wishlist pipeline IS the download pipeline — wishlisted items are downloaded
  and imported by SoulSync automatically. (A direct Download button was cut Sep
  28, 2026: the `/api/v1/request` side-door reported "completed" without the
  file ever landing, and it bypasses the server's download blocklist.)
- The now-playing card is state-aware: it resolves the track through
  `/api/v1/search/tracks`, then checks `GET /api/v1/library/lookup` — an
  **IN LIBRARY** tag disables the button ("In your library ✓"), an
  **ON WISHLIST** tag (from the companion's own memory) turns the button into
  "Remove from wishlist" (`DELETE /api/v1/wishlist/<id>`).
- **Help match**: when the auto-match finds nothing, a "Help match" button
  opens a manual search — premier results with artwork to pick from; a picked
  result becomes the now-playing state (library-checked, wishlist-aware) and
  the Wishlist button uses it directly with no second search. A "Not the right
  one?" link offers the same picker when a match exists but looks wrong.
- Video-page title cruft — `(Official Video)`, `[Official Music Video]`,
  `(Lyric Video)`, `(Official Audio)`, `(Visualizer)`, trailing
  `- Official Video` — is stripped before searching (meaningful tags like
  `(feat. X)` and `(Remix)` are kept); if a search still returns nothing, one
  fallback retry runs with all bracketed segments stripped.
- **Your server** card: live stats strip (tracks / artists / albums / wishlist
  counts from `GET /api/v1/system/stats` + `GET /api/v1/wishlist?limit=1`),
  a pulsing active-downloads pill in the header when downloads are running,
  library last-update time, a **Recently added** albums rail (artwork, year,
  relative added time), and a Scan button that deep-links to the dashboard
  where the library scan controls live (the v1 API has no scan trigger).
- The popup has memory: every action (wishlist, unwishlist, playlist import,
  release send) is recorded to `chrome.storage.local` and shown as a
  **Recent activity** feed, so closing and reopening the popup loses nothing.
- The extension sends metadata to SoulSync; the **server** does the matching
  against its sources. The extension never guesses.
- If a page exposes no media metadata, the popup says so plainly instead of
  guessing from the tab title.
- Media Session has no change events, so the popup asks the tab for fresh
  metadata every time it opens.

### 2. Right-click selected text
- Context menu item "Send to SoulSync" on any text selection.
- Parses each line as "Artist - Title" (hyphen, en dash, em dash; leading
  "1. "/"1) " numbering stripped).
- Confirmation UI lists parsed tracks with checkboxes. Lines that don't parse
  are flagged, never silently dropped.
- Destination: Wishlist, or Playlist (name field).

### 3. Page-aware: Bandcamp + Beatport
- On a Bandcamp release/track page or Beatport release page, the popup offers
  "Send this release to SoulSync".
- Extracts artist, title, label, tracklist from page metadata (JSON-LD first,
  OpenGraph second, DOM selectors last — selectors drift, the first two don't).
- Whole release goes as one job.
- Only these two in MVP: SoulSync already has full Beatport integration, and
  Bandcamp pages carry good metadata.

### 4. Setup / auth
- Options page: SoulSync URL + API key, "Test connection" button, status line.
- Stored in `chrome.storage.local` only. Never leaves the machine except to
  talk to your server.
- The server host is granted via `optional_host_permissions` at setup time —
  no `<all_urls>`, no broad content-script matches beyond the music-site list.
- Popup shows a disconnected state with a link to settings when unconfigured.

## Out of scope for MVP
- AcoustID fingerprinting (needs raw audio capture; fragile, breaks on DRM —
  post-MVP opt-in fallback for garbage-titled uploads).
- Page-aware extractors beyond Bandcamp/Beatport.
- Scrobbling / play-history sync.
- Safari.

## Server API (verified against SoulSync dev, Sep 28 2026)
- Public REST API at `<url>/api/v1` (`api/__init__.py`), auth via
  `Authorization: Bearer <key>` (`api/auth.py` `require_api_key`). Keys are
  generated on the server's Settings page (`/api/v1/api-keys-internal`).
- `POST /api/v1/search/tracks` `{query, source: "spotify"|"itunes"|"auto", limit}`
- `POST /api/v1/search/albums` (same shape)
- `POST /api/v1/wishlist` `{track_data, source_type?, failure_reason?}` → 200/201
- `GET  /api/v1/playlists` (list only)
  (`POST /api/v1/request` exists on the server but the extension deliberately
  does not use it — see the note under "Now Playing" above.)
- `POST /api/v1/playlists/<playlist_id>/sync` `{playlist_name, tracks:
  [{name, artists[], album}], sync_mode?}` — playlist import. The extension
  mints `playlist_id: "companion-<uuid>"`; server downloads missing tracks and
  syncs the media-server playlist. `sync_mode: 'append'` recommended.
- Both run as the admin profile (profile 1) under API-key auth
  (`require_api_key` sets `g.profile_id = 1`). Full contract:
  `SERVER_ENDPOINTS.md`.

## Acceptance
- On YouTube / Spotify web / SoundCloud, the popup shows the correct
  now-playing and both buttons behave (wishlist lands on the server).
- Selecting 10 "Artist - Title" lines imports 10, with nothing silently dropped.
- Bandcamp + Beatport release pages send the full release tracklist.
- Fresh install → settings → test connection → working in under a minute.

## Tech
- Manifest V3, one codebase for Chrome (109+) and Firefox (121+).
- TypeScript + esbuild (no framework). `webextension-polyfill` for the
  `browser.*` namespace across both.
- Background service worker (ES module) + content scripts + popup + options.
- Permissions: `storage`, `contextMenus`, `activeTab`, `scripting`.

## 2026-09-29 — artwork routing, readable stats, no-scroll layout
- Artwork: `serverArtwork()` mirrors the web UI's own rail behavior — relative
  `/api/image-cache/<key>` served straight off the server (`?v=rail`), every
  other remote URL routed through the server's unauthenticated
  `/api/image-proxy?url=…&v=rail` (server fetches + caches, killing hotlink /
  CORS / localhost-URL failures). Any image that still fails swaps to the
  gradient placeholder — broken-image icons are never shown.
- Stats: two plain lines, white bold numbers (the gradient numerals were hard
  to read), always showing download state (`↓ N downloading` in green, else
  `idle`).
- Layout: now-playing is one horizontal row (52px art, meta, compact action
  button; album folded into the artist line); rail thumbs 56px; stats are two
  lines; text-import textarea 2 rows; Recent activity is collapsed by default
  (count badge, click to expand) so the full popup fits without scrolling.
