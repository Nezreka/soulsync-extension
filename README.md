# SoulSync Companion

Browser extension for [SoulSync](https://github.com/Nezreka/SoulSync) — the
self-hosted music automation platform. While you're browsing music anywhere,
one click gets it onto your server: wishlist what's playing, import text
lists, send whole releases, and keep an eye on server activity.

![Now Playing tab](docs/images/popup-now-playing.png)

## What it does

**Now Playing tab** — Shows what the active tab is playing (read from the
page's media session: title, artist, album, artwork). The Wishlist button is
state-aware:

- track not in your library → **Wishlist**
- track already in your library → **In your library ✓** (disabled)
- track already wishlisted → **Remove from wishlist**

If the auto-match finds nothing, **Help match** opens a manual search with
artwork to pick the right track. If a match looks wrong, **Not the right
one?** opens the same picker. Below that, the **Your server** card shows
library stats (tracks / artists / albums / on-wishlist), an active-downloads
pill, the library's last-update time, a **Recently added** albums rail, and a
**Scan** button that opens your server's dashboard (the API has no scan
trigger, so it deep-links).

**Search tab** — Manual track-only search across your metadata sources, with
wishlist buttons on results. Below it, **Text import**: paste (or right-click
→ Send to SoulSync) lines of `Artist - Title`, parse them with checkboxes,
and send to the Wishlist or import into a Playlist. Lines that don't parse are
flagged, never silently dropped.

**Activity tab** — Server activity at the top (live sessions, play history,
and stats — the same data as the web UI's Server Activity drawer, minus the
card click-through since there's nothing to deep-link to), plus the
extension's own **Recent activity** feed: every wishlist, unwishlist,
playlist import, and release send is recorded locally and survives popup
closes.

**Right-click** — "Send to SoulSync" on any text selection drops the text
into the popup's text-import view for review.

**Page-aware releases** — On a Bandcamp release/track page or a Beatport
release page, the popup offers "Send this release to SoulSync", extracting
artist, title, label, and tracklist from page metadata (JSON-LD first,
OpenGraph second, DOM selectors last) and sending the whole release as one
job.

**Page badges** — On Spotify, Bandcamp, SoundCloud, Deezer, and Tidal
artist/album pages, small pills next to names show whether the artist or
album is already in your SoulSync library. Missing artists can be added to
the watchlist and missing albums wishlisted, right from the page. New in
this branch; not yet in a packaged release.

## Requirements

- A SoulSync server reachable from your browser.
- An API key, generated on the server's Settings page. The key acts with the
  admin profile's rights — treat it like a password.
- The server must send CORS headers for browser extensions (SoulSync
  [PR #1377](https://github.com/Nezreka/SoulSync/pull/1377), merged Sep 29,
  2026). With an older server, Test connection fails with a network error
  even when the URL and key are correct.

## Install

```bash
npm install
npm run build      # -> dist/
```

- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → `dist/`
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary
  Add-on → `dist/manifest.json` (temporary add-ons are removed when Firefox
  restarts)

Then open the popup, click the gear icon, enter your server URL and API key,
and hit **Test connection**. Testing also asks the browser for permission to
reach your server's host — grant it, or no server calls will work.

Prebuilt zips: `npm run package` produces
`soulsync-extension-<version>-chrome.zip` and `-firefox.zip` at the repo
root (gitignored).

## How it works

```
src/
  manifest.json          MV3, one codebase for Chrome 109+ / Firefox 121+
  background/
    service-worker.ts    context menu, message hub — all server calls go through it
  content/
    media-session.ts     reads navigator.mediaSession.metadata on music sites
    bandcamp.ts          release extractor (JSON-LD → og: tags → DOM)
    beatport.ts          release extractor (same strategy)
    page-badges.ts       library-status pills
  popup/
    popup.ts/html/css    Now Playing · Search · Activity tabs
    activity.ts          server activity view (sessions / history / stats)
  options/               server URL + API key + test connection
  shared/
    api.ts               typed SoulSync v1 client
    server-activity.ts   typed client for /api/server-activity
    parse.ts             "Artist - Title" line parser
    dom.ts               JSON-LD / meta-tag helpers for extractors
  icons/
```

- The popup calls the SoulSync API directly from the extension context
  (`shared/api.ts`, `shared/server-activity.ts`). That's why the server has
  to send CORS headers for extensions (PR #1377) — without them the browser
  blocks the popup's requests.
- The background worker owns the "Send to SoulSync" context menu and relays
  badge actions from content scripts (artist resolve, watch-artist,
  wishlist-album), so page scripts never touch the API key or the network.
- Content scripts only report page state: media-session metadata, release
  metadata, badge candidates.
- Auth is `Authorization: Bearer <key>` on `/api/v1/*` routes. A few non-v1
  routes (watchlist add, image URLs) carry the key as `?api_key=` instead,
  because `<img>` requests carry no headers.
- Artwork is routed through the server (`/api/image-cache/…` or
  `/api/image-proxy?url=…`), mirroring the web UI — the extension never
  fetches remote images directly. Anything that still fails degrades to a
  gradient placeholder; broken-image icons are never shown.
- The server URL, API key, and recent-activity feed live in
  `chrome.storage.local` only. They never leave the machine except in
  requests to the server you configured.

## Permissions — why each one

- `storage` — server URL, API key, and the recent-activity feed.
- `contextMenus` — the "Send to SoulSync" item on text selections.
- `activeTab` — lets the popup ask the active tab for its media-session
  metadata when it opens.
- `scripting` — declared in the manifest; currently unused by any code path.
- `optional_host_permissions` (`http://*/*`, `https://*/*`) — granted at
  setup via Test connection so the extension can reach your server. No
  `<all_urls>` content-script access: content scripts run only on the
  explicit music-site list (YouTube, Spotify, SoundCloud, Deezer, Tidal,
  Bandcamp, Beatport).
- The Firefox build declares `data_collection_permissions: ["none"]`.

## Privacy

No telemetry, no analytics, no remote code, no audio capture. The extension
talks to exactly one server — yours.

## Wishlist-only, by design

The extension never triggers downloads directly. Wishlist adds are the
download path: SoulSync's wishlist pipeline downloads and imports them
automatically. A direct Download button was deliberately cut (it bypassed the
server's download blocklist).

## Development

```bash
npm install
npm run typecheck  # tsc --noEmit
npm run build      # esbuild bundles -> dist/, manifest version synced from package.json
npm run package    # build + zips for Chrome / Firefox
```

TypeScript + esbuild, no framework. `webextension-polyfill` for the
`browser.*` namespace on both browsers. The background service worker stays
a real ES module (MV3 requirement); content scripts and UI scripts are
self-contained IIFE bundles.

More detail: [docs/SPEC.md](docs/SPEC.md) (behavior spec),
[docs/SERVER_ENDPOINTS.md](docs/SERVER_ENDPOINTS.md) (verified server API
contract), [docs/TESTING.md](docs/TESTING.md) (manual test checklist).

## Troubleshooting

- **Test connection fails with a network error:** check the URL (scheme +
  port, e.g. `http://192.168.1.10:8080`), the API key, and that the server
  is reachable from this machine. In Firefox, a `NetworkError` with correct
  credentials usually means the server predates the extension CORS support
  (PR #1377) — the server sends no CORS headers, so the browser blocks the
  request before auth is even checked.
- **"This page isn't reporting anything via its media session":** the page
  exposes no media metadata (common on non-player pages). The extension
  says so plainly instead of guessing from the tab title.
- **Stop stream fails with 403 "Admin only":** known server-side gap — pure
  API-key requests aren't flagged admin yet, so the server refuses. The
  error is surfaced as-is rather than hidden.
- **Firefox forgot the extension after restart:** expected — temporary
  add-ons don't survive restarts. Reinstall from `dist/` or use the packaged
  zip.
