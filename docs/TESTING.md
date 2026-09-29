# SoulSync Companion — live test checklist

For Broque: load the unpacked build in your browser, pointed at your own
SoulSync. Everything below uses your server and your API key.

## Setup

1. `npm run build` (or `npm run package` for the zip).
2. Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.
   Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `dist/manifest.json`.
3. Open the extension's Settings (gear icon in the popup), enter server URL +
   API key, **Test connection**. The browser will ask for permission to reach
   your server's host — grant it.

## Tests

- [ ] **Now playing (YouTube):** play any video with music metadata → open popup →
      title/artist shown with artwork.
- [ ] **Wishlist from now playing:** Wishlist button → status confirms →
      track appears on the server's wishlist, then downloads via the wishlist
      pipeline (there is no separate Download button by design — see SPEC.md).
- [ ] **In-library tag:** play a track you own → popup shows an IN LIBRARY tag
      and the button reads "In your library ✓" (disabled).
- [ ] **On-wishlist tag:** wishlist a track you don't own → reopen popup →
      ON WISHLIST tag, button offers "Remove from wishlist" → removes it.
- [ ] **History survives:** do a few actions → close popup → reopen →
      Recent activity still lists them with relative times.
- [ ] **No-metadata page:** open popup on a plain page → "isn't reporting anything".
- [ ] **Text import:** select 5 lines of `Artist - Title` text on any page →
      right-click → Send to SoulSync → popup opens with 5 parsed, checkboxes work.
- [ ] **Bad lines flagged:** include a line like `asdf` → flagged with ⚠, not dropped,
      Send skips it unless checked.
- [ ] **Playlist import:** same selection → destination Playlist… → name it →
      Send → sync starts → playlist appears on your media server.
- [ ] **Bandcamp:** open an album page → popup shows release card with tracklist →
      Send release → all tracks land on the wishlist.
- [ ] **Bandcamp track page:** single track extracted as a one-track release.
- [ ] **Beatport:** open a release page → release card → Send → wishlist.
- [ ] **Bad key:** wrong API key in settings → Test connection fails with the
      server's message, not a hang.

## Known issues (don't file these)

- `POST /api/v1/request` bypasses the server's download blocklist — confirmed,
  fix deferred to a server PR (see SERVER_ENDPOINTS.md).
- Beatport DOM selectors are fallbacks; JSON-LD is the primary path.
- Under API-key auth the extension acts as the admin profile.
