# SoulSync Companion — In-Extension Player · Spec v1

**Status:** approved for overnight build Oct 2, 2026. Broque tests in the morning.
**Repo:** `~/workspace/soulsync-companion` · branch: `feature/extension-player` (commit locally; **never push** — standing rule)

## 1. Goal

Play music and video from the user's SoulSync server inside the Companion
extension, with the browser's standard media integration: MediaSession →
toolbar media controller, OS media HUD, hardware media keys. The popup becomes
a remote; playback itself lives in the background and survives popup close.

## 2. Non-goals (v1)

- **No Download button anywhere.** The wishlist-only rule stands — streaming is
  not downloading and must never touch the download blocklist.
- **No server changes.** Anything needing a SoulSync PR is listed in §9 and
  built later. This entire feature works against the current server.
- No offline/caching. No scrobbling or play-count reporting (don't double-count
  against the web player's own accounting — call no play-count endpoints).
- No Web Audio visualizers (needs server CORS change — §9).

## 3. Verified server contracts

Verified Oct 2, 2026 against `~/workspace/soulsync-main` (commit `91ee89d`).
Do not re-derive; build to these.

### Audio

- `GET /api/v1/library/tracks?title=&artist=&limit=&api_key=` →
  `{tracks: [{id, title, file_path, duration, …}]}` (`require_api_key`; key as
  query param is fine).
- `GET /api/v1/library/albums/<album_id>/tracks?api_key=` → album tracklists
  with `file_path`.
- `GET /stream/library-audio?path=<file_path>&api_key=` → **206 partial
  content**, `Accept-Ranges: bytes`, `Content-Range` on seeks. Stateless — no
  cookie session needed. Optional `&track_id=` engages the Navidrome/Subsonic
  proxy fallback (Range forwarded upstream).
- **Do NOT use `/stream/audio` or `/api/stream/start`** — they are keyed to
  the Flask session cookie, which the extension doesn't have.
- Served audio MIME types: mp3, flac, ogg, opus, aac, m4a, wav, webm, wma.
  **Browsers cannot decode WMA** — filter WMA tracks out of queues or warn
  before attempting.

### Video

- `GET /api/video/watch/playable?kd=m|t&id=<tmdb_id>[&s=<season>&e=<episode>]&api_key=`
  → `{playable, verdict: "yes"|"maybe"|"no", reasons[]}`. **Call before every
  playback** and honor it: `verdict === "no"` must surface the reason honestly
  (e.g. "HEVC + AC3 — no browser can play this copy"), never a silent black
  rectangle.
- `GET /api/video/watch/stream?kd=m|t&id=<tmdb_id>[&s=&e=]&api_key=` → 206
  ranges; serves the local file or proxies the media server (Plex/etc.) with
  Range forwarded both ways and the upstream token never exposed to the browser.
- Codec truth lives server-side in `core/video/direct_play.py`. The extension
  must **not** hardcode its own codec table — trust `/watch/playable`.
  (Shape of the truth, for UX copy only: h264/vp9/AV1 + AAC/MP3/Opus = yes;
  HEVC/Matroska = maybe; AC3/DTS/Dolby audio, DivX-era codecs = no.)
- Video library listing endpoints: discover under `api/video/` in soulsync-main
  (the web UI's video flows use them); key rides as `?api_key=`.

### Auth

- `?api_key=` (or `Authorization: Bearer`) bypasses the login gate and the
  launch-PIN gate and stamps admin request context (`api/auth.py`,
  `request_has_valid_api_key`). Every stream URL carries `?api_key=`.
- The key only ever travels to the user's own server (same as the extension's
  existing fetches). Media-element loads don't create history entries.

## 4. Architecture

**Background owns playback. The popup never holds a media element.**

- **Chrome:** new offscreen document `src/offscreen/player.html`
  (reason `audio_playback`) hosting one `<audio>` element. Add to manifest;
  create lazily on first play with a `chrome.offscreen.hasDocument()` guard.
  Branch on `typeof chrome.offscreen !== "undefined"`.
- **Firefox:** the packaged build rewrites `background.background` to
  `{scripts: [...]}` (see `scripts/package.mjs`) — a real background page that
  can host the `<audio>` element directly.
- **Player core** (`src/player/`): queue model, transport
  (play/pause/next/prev/seek/volume), now-playing state, MediaSession metadata
  + action handlers (`play`, `pause`, `previoustrack`, `nexttrack`, `seekto`).
  Background is the source of truth; popup and player tab talk to it via
  `runtime.sendMessage`; snapshots in `storage.session` (survive worker
  restarts; do not persist across browser restarts in v1).
- **Popup remote:** the existing "Now Playing" tab becomes the player remote —
  artwork, title/artist, transport buttons, seek bar, queue list with
  remove/clear. On open it reattaches to background state; every control sends
  a message to background. Keep the tab's existing non-player content working.
- **Video:** extension tab `src/player-tab/player.html` with
  `<video controls playsinline>`, a Picture-in-Picture button, and MediaSession
  wiring. Opened via `tabs.create`. A tab is the honest primitive — video needs
  a visible surface, and this keeps the extension from pretending otherwise.
- **Badge click-to-play** (added scope Oct 2, 2026): every badge surface that
  renders an "In library" state becomes a play button. Music badges
  (`src/content/page-badges.ts` — Spotify/Bandcamp/SoundCloud/Deezer/Tidal/
  YouTube) resolve the badge's track identity to a library track (`file_path`
  via `/api/v1/library/tracks` search, or the badge's existing lookup record
  when it already carries the path) and send `player:playNow`. Video badges
  (`src/content/video-badges.ts`) use the badge's tmdb identity to set
  `pendingVideoEntry` and open the player tab, which honors `/watch/playable`
  itself. Existing badge behaviors (watchlist eye two-click remove, wishlist
  pills, tri-state unknown handling) are untouched.
- **Popup "Media" tab** (added scope Oct 2, 2026): `#tab-media` — library-only
  search and playback. Music via `/api/v1/library/tracks` (title/artist);
  movies and episodes via the `api/video` library listing endpoints. Results
  show artwork + title with play controls. Distinct from the Search tab
  (metadata sources for wishlisting): Media never wishlists, never downloads.
- **Queue entries:** `{kind: "audio"|"video", title, subtitle, artworkUrl?,
  audioPath?, trackId?, videoKd?, videoId?, season?, episode?, duration?}`.
  v1 ops: play now, add next, add last, remove, clear, shuffle.

## 5. MediaSession (the "mini player")

- Set `navigator.mediaSession.metadata = new MediaMetadata({title, artist,
  album, artwork})` **in the document that owns the element** (offscreen doc /
  background page / player tab) — metadata set in the service worker alone
  does nothing.
- Artwork: build URLs the way badges already do (see `shared/api.ts`
  image-proxy usage) with `?api_key=`.
- This is what lights up Chrome's toolbar controller, the OS HUD, and media
  keys. If it's not visible during playback, the feature is broken.

## 6. UX rules

- Match the existing popup aesthetic (dark gradient, pill tags). No new visual
  language — premier and quiet.
- Honest states only: loading indicator → playing; every failure shows the
  server's reason. A `playable: no` verdict explains codecs in plain words.
- Track status pills reuse the settled badge language (✓ In library, etc.)
  wherever status appears.
- Respect `prefers-reduced-motion` for any animation.

## 7. Testing (overnight bar)

- `npm run typecheck`, `npm run build`, `npm run test` green.
- `npm run package` produces loadable chrome + firefox zips.
- Lab (Firefox + Marionette, precedent: chat-tab verification): the stub server
  **MUST send CORS headers** (`Access-Control-Allow-Origin` etc.) — the host
  grant does not bypass CORS in lab Firefox. Assert: queue add → play →
  MediaSession metadata set → pause/next/seek → popup reattach shows correct
  state → video `playable` verdict honored → player tab opens → PiP button
  present.
- Added scope asserts (Oct 2, 2026): badge click (music) → playback starts with
  correct MediaSession metadata; badge click (video) → player tab opens with
  the verdict honored; Media tab music search → play works; Media tab video
  search → play works; existing badge behaviors intact (tri-state unknown,
  two-click watchlist remove, wishlist pills).
- Lab hygiene: `pgrep` for stray stub/probe processes before each run
  (leaked `badge_stub.py`-style processes poison counts); clear stub logs
  immediately before the measured action.
- Commit locally on `feature/extension-player`. **Never push.**

## 8. Suggested work breakdown (coordinator fans out)

1. `src/player/` core: types, queue, transport, background↔UI messaging protocol.
2. Offscreen document (Chrome) + Firefox background-page audio host.
3. MediaSession wiring in the owning documents.
4. `shared/api.ts` additions: library track/album listing, `libraryAudioUrl()`,
   `videoPlayableUrl()`, `videoStreamUrl()` builders.
5. Popup Now Playing tab → remote UI (controls, seek bar, queue list).
6. Video player tab + PiP.
7. Lab harness + stub endpoints + Marionette asserts.
8. Package, commit.
9. (Added scope Oct 2, 2026) Badge click-to-play: music + video badge surfaces.
10. (Added scope Oct 2, 2026) Popup "Media" tab: library-only search + playback.

## 9. Server-PR-later list (do NOT build now)

- CORS `Access-Control-Allow-Origin` on `/stream/*` → unlocks Web Audio
  analyser/visualizers in the extension (currently only `/api/*` is stamped).
- Possible first-party `GET /api/v1/library/stream?track_id=` that returns the
  stream URL, cleaner than `path=` in the query string.
- Whatever the morning test surfaces.
