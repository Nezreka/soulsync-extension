# SoulSync Companion — server endpoint spec

## Headline

Both endpoints the extension needs **already exist** in SoulSync's public v1
API (`api/` blueprint, mounted at `/api/v1`). **No server changes are required
for the MVP.** The skeleton's TODOs claiming otherwise were written before
checking and have been corrected.

## Auth (applies to everything below)

- `Authorization: Bearer <key>` header (or `?api_key=` query param) —
  `api/auth.py` `require_api_key`.
- Keys look like `sk_…`, are shown exactly once at creation, and are stored as
  SHA-256 hashes. Generate one on the server's Settings page
  (`/api/v1/api-keys-internal`).
- Under API-key auth the request runs as the admin profile: `require_api_key`
  sets `g.profile_id = 1`, which is what `get_current_profile_id()` returns.
  On multi-profile installs the extension always acts as profile 1 — worth one
  line in the options UI.
- Envelope: success → `{success: true, data: {...}}` (HTTP 200, or 202 where
  noted); failure → `{success: false, error: {code, message}}` with the HTTP
  status. (`api/helpers.py`)

---

## Endpoint 1 — Download: `POST /api/v1/request`

> **Not used by the extension** (cut Sep 28, 2026 — see the wiring map note).
> Documented here because the server contract was verified and the endpoint
> has a known blocklist hole (below).

The extension's former **Download** button. Already built for exactly this shape of
caller (async API clients without callbacks). (`api/request.py`)

### Request

```json
{
  "query": "Kendrick Lamar - HUMBLE.",
  "title": "HUMBLE.",
  "artist": "Kendrick Lamar",
  "duration_ms": 177000,
  "metadata": {
    "source": "companion",
    "album": "DAMN.",
    "artwork": "https://…",
    "page_url": "https://…"
  }
}
```

- `query` (required): `"Artist - Title"` works; the server splits it when
  `title`/`artist` are absent (`expected_track_for`).
- `title` / `artist` / `duration_ms` (optional but send what you have): what the
  result must match. This is what stops a karaoke or live version of
  "Artist - Track" from winning — explicit metadata beats the top hit.
- `metadata` (optional): passthrough, included in automation events. The
  extension stamps `source: 'companion'` plus album/artwork/page URL for
  provenance.
- `notify_url` (optional): the extension does **not** use this — it has no
  publicly reachable URL. Poll instead.

### Response

`202 Accepted` → `{success: true, data: {request_id, status: "queued", query}}`.

The download runs on a background thread via
`download_orchestrator.search_and_download_best(query, expected_track)`:
hybrid source-priority search, matching-engine scoring against the expected
track, best match dispatched through the normal download pipeline. It also
emits a `webhook_received` automation event tagged
`download_started_by: 'api_request'` so an automation with a
"webhook → search and download" trigger doesn't queue the same track twice.

### Status polling: `GET /api/v1/request/<request_id>`

```
queued → searching → downloading → completed | not_found | failed
```

Response data: `{request_id, query, status, download_id, error, completed_at,
timed_out}`.

- `not_found`: nothing on any source matched — tell the user plainly.
- `failed`: `error` carries the reason.
- `timed_out: true`: the shared watcher stopped looking, but the transfer may
  still be running. The extension must say "still working — check Downloads",
  never "failed".
- Requests expire after an hour (`_cleanup_old_requests`); a poll after that
  is `404 NOT_FOUND` ("Request not found or expired").
- The module notes a ~60/minute rate limit; the extension polls every few
  seconds for ~30s max, well under it.

---

## Endpoint 2 — Playlist import: `POST /api/v1/playlists/<playlist_id>/sync`

The extension's **import as playlist** flow. (`api/playlists.py` →
`api/source_playlists.py::start_playlist_sync_from_payload`)

### Request

`playlist_id` is a path segment the extension mints per import:
`companion-<uuid>`. It's the sync-state/history key — uniqueness is its only
requirement.

```json
{
  "playlist_name": "My import",
  "tracks": [
    {"name": "HUMBLE.", "artists": ["Kendrick Lamar"], "album": ""}
  ],
  "sync_mode": "append"
}
```

- `tracks` are Spotify-shaped dicts; missing fields get defaults
  (`core/discovery/sync.py::run_sync_task` builds `SpotifyTrack` objects with
  `t.get('name', '')` etc.). The extension sends `{name, artists: [artist],
  album}` — nothing else is needed.
- `sync_mode: 'append'`: only adds tracks not already on the server playlist.
  The default `'replace'` deletes and recreates the server playlist; append is
  the safer default for imports. (Per-request mode wins over the server's
  configured default.)
- `image_url` optional; skip it in MVP.

### Response

- `200` → `{success: true, data: {message: "Playlist sync started.",
  playlist_id}}`. Fire-and-forget: the sync downloads missing tracks and
  creates/updates the media-server playlist (Plex/Jellyfin/Navidrome) in the
  background.
- `409` → a sync with that playlist_id is already running. Can't happen with
  a fresh uuid per import, but handle it anyway.

### What the extension does NOT use

- `GET /api/sync/status/<playlist_id>`: exists, but it's a non-v1 route on the
  session-authenticated blueprint — the extension's API key can't call it.
  MVP shows "sync started" and stops there.

---

## Endpoint 3 — Exact SoundCloud uploads: `/api/v1/soundcloud/exact`

> Newer servers only (SoulSync with the exact-upload routes). The extension
> detects support per call and degrades cleanly on older servers.

Wishlists ONE specific SoundCloud upload. The server resolves the link,
keys the wishlist row `soundcloud_exact_<numeric SoundCloud track id>`, and
its download worker fetches only that upload — it never searches the
catalogue and never falls back to a different recording. Any form of the
link (public permalink, `/s-<token>` private share link, `m.`/`www.` hosts,
`on.soundcloud.com` short link) lands on the same row. All three routes use
the v1 auth, take the profile from `X-Profile-Id`/`?profile_id` (default 1),
and answer with the standard envelope.

### `GET /api/v1/soundcloud/exact` — capability probe + status

Query (optional): `sc_id=<digits>` or `url=<soundcloud url>`; no network
call on the server. 200:

```json
{"supported": true, "enabled": true, "reason": null,
 "state": "none|queued|failed|downloading|acquired", "matched": true,
 "track_id": "soundcloud_exact_123", "failure_reason": null,
 "retry_count": 0, "last_attempted": null}
```

`enabled: false` comes with `reason` `"source_disabled"` (SoundCloud is not
an enabled download source) or `"source_unavailable"` (yt-dlp missing).
`failed` = the row is still on the wishlist with `retry_count > 0` (retried
under backoff); the popup offers Remove (`DELETE /api/v1/wishlist/<track_id>`).

### `GET /api/v1/soundcloud/exact/playlists`

`{"playlists": [{"id": 12, "name": "Flips", "track_count": 40, "liked": false}]}`
— the profile's own SoulSync playlists, the only ones an exact upload can
join (upstream mirrors are rewritten on refresh).

### `POST /api/v1/soundcloud/exact`

```json
{"url": "https://soundcloud.com/u/t", "title": "Tag title", "artists": ["A"],
 "remixers": ["R"], "playlist_id": 12, "quality_profile_id": 3}
```

Only `url` is required; empty fields are omitted so the server's defaults
apply (title split from the upload title, artist = split artist else the
uploader). Remixers become extra artist credits. 201 (new row) / 200
(existing row refreshed, or `state: "acquired"`):
`{created, state, track_id, upload: {sc_id, permalink_url, title, uploader,
duration_ms, artwork_url, official_download}, track, playlist: {id, name,
added, already_present} | {id, added: false, error} | null}`.

Errors (no wishlist row is written; one exception: a user-initiated add
clears a stale wishlist-ignore entry before a quota or permission refusal
can land — the shared wishlist add's behaviour for every user add):
400 `BAD_REQUEST`, 400 `NOT_SOUNDCLOUD_TRACK`,
400 `BAD_PLAYLIST`, 422 `PLAYLIST_NOT_EDITABLE`, 422 `UPLOAD_UNAVAILABLE`,
409 `SOURCE_DISABLED`, 503 `SOURCE_UNAVAILABLE`, 409 `BLOCKLISTED`,
400 `REJECTED`, 500 `WISHLIST_ERROR`. `shared/soundcloud.ts::exactErrorMessage`
maps each code to user text.

### Unsupported-server rule

These routes never answer 404 or 405. An older server sends the unknown path
to the SPA catch-all, which answers **GET → 404, POST → 405** with no v1
envelope. So: **404 or 405 = "server doesn't support exact uploads"**, whatever
the body (`UnsupportedServerError`; the background caches it per server for
the worker's lifetime); anything else is a normal error. The user sees:
"Your SoulSync server doesn't support adding exact SoundCloud uploads yet.
Update SoulSync to use this."

---

## What the extension sends where (wiring map)

| Popup action              | Server call                                              |
|---------------------------|----------------------------------------------------------|
| Now playing → Wishlist    | `POST /api/v1/search/tracks` to resolve, then `POST /api/v1/wishlist` with the hit's id |
| Text import → Wishlist    | resolve each checked track, then `POST /api/v1/wishlist` per track |
| Text import → Playlist    | `POST /api/v1/playlists/companion-<uuid>/sync`           |
| Release page → Send       | `POST /api/v1/wishlist` per track (bulk; feeds the same pipeline) |
| Settings → Test           | `GET /api/v1/playlists` (cheap authenticated GET)        |
| Now playing → Add exact SoundCloud upload | `GET /api/v1/soundcloud/exact?url=` (status/probe), `GET /api/v1/soundcloud/exact/playlists`, `POST /api/v1/soundcloud/exact` — no catalogue search |
| SoundCloud track page pill | same three routes, through the background `sc-exact-*` badge actions |

> There is no Download action. The extension used to call `POST /api/v1/request`
> for one, but it was cut Sep 28, 2026: live testing showed the endpoint
> reporting `completed` with no file ever landing, and it bypasses the
> server's download blocklist (see below). The wishlist pipeline IS the
> download pipeline — wishlisted items are downloaded and imported by the
> server on its own.

---

## Server facts the client is built around (verified Oct 25, 2026)

- **Library ids are TEXT.** `artists`, `albums` and `tracks` ids went TEXT in
  `music_database.py::_migrate_id_columns_to_text`, and v1 serializers pass
  them through raw: Plex rows arrive as numeric strings (`"142795"`), Jellyfin
  as hex GUIDs, Navidrome as opaque slugs, standalone rows as
  `<hash>::soulsync`. The client keeps them as strings (`LibraryId` in
  `shared/player-api.ts`) and never parses them. Video and mirrored-playlist
  ids are still integers.
- **v1 is rate-limited to 60 requests/minute per IP** (`api/__init__.py`,
  flask-limiter fixed window, no `Retry-After`). `shared/http.ts` paces v1
  calls to 45/minute per extension context and retries a 429 after a backoff;
  every server request also has a timeout.
- **Track badges batch through `POST /api/library/check-tracks`**
  `{artist_name, tracks: [{name}]}` → `{success, owned_tracks: {name: {owned,
  track_id, file_path, …}}}`: the web UI's own ownership matcher, one request
  per artist, non-v1 so not rate-limited. A missing route (older server) falls
  back to search → `GET /api/v1/library/lookup` → `GET /api/v1/library/tracks`.
- **Album badges use `GET /api/v1/library/artists/<id>/albums`**, once per
  artist, matched locally.
- **Read-only API keys** (`scope: "read"`) pass every GET under `/api/v1/` but
  get `403 INSUFFICIENT_SCOPE` on every POST and every non-v1 route
  (`api/auth.py::enforce_read_key_scope`). Test connection probes
  `POST /api/watchlist/check` and refuses a read key with a plain message.

## Known server issue (confirmed Sep 28, 2026 — fix deferred)

**`POST /api/v1/request` bypasses the download blocklist.** The web UI's
`POST /api/download` answers `409 {blocked: true, …}` for blocklisted artists
(Phase 2b guard in `web_server.py: start_download`); the `/request` path
(`api/request.py::create_request` → `download_orchestrator.search_and_download_best`)
has no blocklist check anywhere — traced end to end, none in the orchestrator
either. A Companion "Download" for a blocklisted artist would download anyway.
Fix (server PR, needs Broque's go-ahead): mirror the Phase 2b guard in
`create_request`, returning the same 409 shape and honoring
`ignore_blocklist: true`. The extension already passes metadata cleanly, so no
extension change is needed once the server guards.

## Open verification items (real-server testing, for Broque)

1. **`timed_out` on slow transfers** — confirm the extension copy ("still
   working") matches reality.
3. **Beatport DOM selectors** against a live release page (JSON-LD is the
   primary path; selectors are the fallback).
4. **Multi-profile installs** — extension acts as profile 1; confirm that's
   acceptable or plumb `X-Profile-Id` through.
