# SoulSync Companion

Browser companion for SoulSync — send what's playing, selected text, or release
pages straight to your self-hosted server. See [docs/SPEC.md](docs/SPEC.md) for
the scope.

## Quickstart

```bash
npm install
npm run build     # -> dist/
npm run typecheck # tsc --noEmit
npm run package   # -> soulsync-companion-<version>.zip (zips dist/)
```

Load unpacked:
- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → `dist/`
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
  `dist/manifest.json`

Then open the extension's settings, enter your SoulSync URL + API key (generate
one on the server's Settings page), and hit **Test connection**. Testing also
grants the extension permission to reach your server's host.

## Layout

```
src/
  manifest.json          MV3 manifest (version synced from package.json at build)
  background/
    service-worker.ts    context menu ("Send to SoulSync" on selections)
  content/
    media-session.ts     reads navigator.mediaSession.metadata on music sites
    bandcamp.ts          release extractor (JSON-LD → og: tags → DOM)
    beatport.ts          release extractor (same strategy)
  popup/
    popup.ts/html/css    Now Playing · Search · Activity tabs
    activity.ts          server activity view (sessions / history / stats)
  options/               server URL + API key + test connection
  shared/
    api.ts               SoulSync v1 client (all routes verified)
    server-activity.ts   typed client for /api/server-activity
    parse.ts             "Artist - Title" line parser (never silently drops)
    dom.ts               JSON-LD / meta-tag helpers for extractors
  icons/                 extension + logo artwork
scripts/
  build.mjs              esbuild bundles + static copy + manifest version sync
  package.mjs            zips dist/ for sideloading / sharing
docs/
  SPEC.md                scope
  SERVER_ENDPOINTS.md    verified server API contract
  TESTING.md             manual test checklist
```

## Notes

- Wishlist-only: the extension never triggers downloads, only wishlist adds.
- Server API details in `src/shared/api.ts` were verified against SoulSync's
  `api/` blueprint (`/api/v1`, `Authorization: Bearer`). The full endpoint
  contract is in [docs/SERVER_ENDPOINTS.md](docs/SERVER_ENDPOINTS.md).
- Content-script matches are an explicit music-site list, not `<all_urls>`.
- The Activity tab's server-activity view (live Plex/Jellyfin sessions, history,
  stats) mirrors the SoulSync web UI's Server Activity drawer; artwork goes
  through the server's image proxy with `?api_key=`.
- No analytics, no remote code, no audio capture.
