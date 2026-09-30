/* Focused unit tests for badge matching logic (real code, no DOM).
 * Bundled by scripts/run-logic-tests.mjs from src/shared/api.ts with
 * webextension-polyfill aliased to tests/polyfill-stub.mjs; fetch is
 * stubbed per case below.
 */
import {
  BADGES_ENABLED_KEY,
  badgesEnabledFromStored,
  baseTitleForMatch,
  checkWatchlist,
  getWishlistCount,
  lookupBadgeStatuses,
  lookupLibraryTrackSmart,
  normName,
  pickBest,
  pickBestArtist,
  primaryArtistForMatch,
  resolveLibraryLink,
} from "../src/shared/api.ts";
import {
  artistFromVideoTitle,
  channelArtistFromOgTitle,
  isBadgedYoutubeHost,
  isYoutubeChannelPath,
  splitArtists,
  trackFromVideoTitle,
} from "../src/shared/youtube.ts";
import {
  deezerPlaylistTrackToMirror,
  getDeezerPlaylistTracks,
  getSpotifyPlaylistTracks,
  mirrorPlaylist,
  preparePlaylistDiscovery,
  resolveMirroredPlaylist,
  spotifyPlaylistTrackToMirror,
} from "../src/shared/api.ts";
import {
  deezerAlbumIdFromPath,
  deezerAlbumTracks,
  deezerArtistIdFromPath,
  providerIdFromPath,
} from "../src/shared/provider_ids.ts";

let fails = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!ok) fails++;
}

/* ── normName: unicode-aware, no CJK collapse ── */
eq("diacritics", normName("Beyoncé"), "beyonce");
eq("punctuation", normName("AC/DC"), "ac dc");
eq("cjk preserved (nfc-equal)", normName("방탄소년단").normalize("NFC"), "방탄소년단");
eq("cjk distinct", normName("방탄소년단") === normName("블랙핑크"), false);
eq("whitespace", normName("  Hello   World  "), "hello world");
eq("empty", normName(""), "");
eq("dots", normName("R.E.M."), "r e m");

/* ── pickBestArtist: exact normalized match wins, else top hit ── */
const ah = (id, name) => ({ id, name, image: "", source: "spotify" });
eq("exact beats top hit",
  pickBestArtist([ah("2", "Drakeo"), ah("1", "Drake")], "Drake")?.id, "1");
eq("diacritic-insensitive", pickBestArtist([ah("1", "Beyonce")], "Beyoncé")?.id, "1");
eq("fallback top hit", pickBestArtist([ah("2", "Drakeo")], "Drake")?.id, "2");
eq("no hits", pickBestArtist([], "Drake"), null);

/* ── pickBest: title+artist, then title-only, then top hit ── */
const th = (id, title, artist) => ({ id, title, artist, album: "", image: "", raw: null });
const hits = [th("1", "One Dance", "Drake"), th("2", "One Dance", "Drakeo")];
eq("title+artist", pickBest(hits, { artist: "Drake", title: "One Dance" })?.id, "1");
eq("title-only", pickBest(hits, { artist: "", title: "One Dance" })?.id, "1");
eq("top-hit fallback", pickBest(hits, { artist: "X", title: "Nope" })?.id, "1");
eq("no hits null", pickBest([], { artist: "X", title: "Y" }), null);

/* ── tri-state library checks ── */
const ARTISTS = { drake: { name: "Drake", id: 42 } };
const ALBUMS = { "42:views": { title: "Views", id: 7 } };
const TRACKS = {
  "spotify:onedance": { id: 9, album_id: 7, artist_id: 42, title: "One Dance" },
};
globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  const fail = () => ({ ok: false, status: 500, json: async () => ({}) });
  if (u.pathname === "/api/v1/library/artists") {
    const q = u.searchParams.get("search") || "";
    if (q.toLowerCase().includes("boom")) return fail();
    const w = normName(q);
    const found = Object.entries(ARTISTS)
      .filter(([k]) => w && (w.includes(k) || k.includes(w))).map(([, v]) => v);
    return { ok: true, status: 200, json: async () => ({ success: true, data: { artists: found } }) };
  }
  if (u.pathname === "/api/v1/library/albums") {
    const q = u.searchParams.get("search") || "";
    const aid = u.searchParams.get("artist_id");
    if (q.toLowerCase().includes("boom")) return fail();
    const hit = ALBUMS[`${aid}:${normName(q)}`];
    return { ok: true, status: 200, json: async () => ({ success: true, data: { albums: hit ? [hit] : [] } }) };
  }
  if (u.pathname === "/api/v1/search/tracks") {
    const body = JSON.parse(String((init && init.body) || "{}"));
    if (String(body.query || "").toLowerCase().includes("boom")) return fail();
    const hit = {
      id: "onedance",
      name: "One Dance",
      artists: [{ name: "Drake" }],
      album: { name: "Views" },
      image_url: "",
    };
    return {
      ok: true, status: 200,
      json: async () => ({ success: true, data: { tracks: [hit], source: "spotify" } }),
    };
  }
  if (u.pathname === "/api/v1/library/lookup") {
    if (u.searchParams.get("id") === "boom") return fail();
    const rec = TRACKS[`${u.searchParams.get("provider")}:${u.searchParams.get("id")}`];
    if (!rec) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: { track: rec } }) };
  }
  throw new Error("unexpected " + u.pathname);
};
const cfg = { url: "http://x", apiKey: "k" };

/* ── checkWatchlist reads the top-level is_watching field ── */
/* The real /api/watchlist/check returns {"success": true, "is_watching": bool}
 * (top-level — NOT the v1 envelope). This is the shape SoulSync's own
 * watchlist button reads. */
{
  const prev = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String((init && init.body) || "{}"));
    const id = body.artist_id;
    if (id === "boom") return { ok: false, status: 500, json: async () => ({}) };
    if (id === "denied")
      return { ok: true, status: 200, json: async () => ({ success: false, error: { code: "nope", message: "no" } }) };
    const watching = id === "watching";
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, is_watching: watching }),
    };
  };
  try {
    eq("watchlist check reads top-level is_watching=true", await checkWatchlist(cfg, "watching"), true);
    eq("watchlist check reads top-level is_watching=false", await checkWatchlist(cfg, "other"), false);
    eq("watchlist check http error -> null", await checkWatchlist(cfg, "boom"), null);
    eq("watchlist check api error -> null", await checkWatchlist(cfg, "denied"), null);
  } finally {
    globalThis.fetch = prev;
  }
}

// transport failure -> null (never false)
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("down"); };
eq("artist transport error -> null",
  (await lookupBadgeStatuses(cfg, [{ kind: "artist", name: "DownTest" }]))["artist:downtest"], null);
globalThis.fetch = realFetch;

const r = await lookupBadgeStatuses(cfg, [
  { kind: "artist", name: "Drake" },
  { kind: "artist", name: "Nobody Here" },
  { kind: "artist", name: "Boom Artist" },
  { kind: "album", name: "Views", artist: "Drake" },
  { kind: "album", name: "Nope", artist: "Drake" },
  { kind: "album", name: "Views", artist: "Nobody Here" },
  { kind: "album", name: "Boom", artist: "Drake" },
  { kind: "album", name: "Views" },  // no artist -> unverifiable
]);
eq("artist in library -> true", r["artist:drake"], true);
eq("artist absent -> false", r["artist:nobody here"], false);
eq("artist server 500 -> null", r["artist:boom artist"], null);
eq("album exact under artist id -> true", r["album:drake views"], true);
eq("album title absent under artist -> false", r["album:drake nope"], false);
eq("album, artist absent -> false", r["album:nobody here views"], false);
eq("album server 500 -> null", r["album:drake boom"], null);
eq("album w/o artist -> null", r["album:views"], null);

/* ── youtube parsers ── */
eq("channel og:title", channelArtistFromOgTitle("Drake"), "Drake");
eq("topic channel strips suffix", channelArtistFromOgTitle("Drake - Topic"), "Drake");
eq("topic case-insensitive", channelArtistFromOgTitle("Drake - topic"), "Drake");
eq("empty og:title", channelArtistFromOgTitle(""), "");
eq("watch title artist", artistFromVideoTitle("Drake - One Dance (Lyrics) ft. Wizkid & Kyla"), "Drake");
eq("watch title no separator -> no badge", artistFromVideoTitle("One Dance (Official Video)"), "");
eq("watch title leading separator -> no badge", artistFromVideoTitle(" - One Dance"), "");
eq("channel paths", ["/@DrakeOfficial", "/channel/UCabc", "/c/drake", "/user/drake"].map(isYoutubeChannelPath), [true, true, true, true]);
eq("non-channel paths", ["/watch", "/shorts/abc", "/feed/trending", "/results"].map(isYoutubeChannelPath), [false, false, false, false]);
eq("badged hosts", ["www.youtube.com", "youtube.com", "m.youtube.com"].map(isBadgedYoutubeHost), [true, true, true]);
eq("music.youtube.com excluded", isBadgedYoutubeHost("music.youtube.com"), false);

/* ── youtube multi-artist splitting ── */
eq("comma pair", splitArtists("Post Malone, Swae Lee"), ["Post Malone", "Swae Lee"]);
eq("single artist", splitArtists("Drake"), ["Drake"]);
eq("ampersand", splitArtists("Wizkid & Kyla"), ["Wizkid", "Kyla"]);
eq("and separator", splitArtists("Peter, Paul and Mary"), ["Peter", "Paul", "Mary"]);
eq("x separator", splitArtists("Post Malone x Swae Lee"), ["Post Malone", "Swae Lee"]);
eq("feat separator", splitArtists("Drake feat. Wizkid"), ["Drake", "Wizkid"]);
eq("featuring separator", splitArtists("Drake featuring Rihanna"), ["Drake", "Rihanna"]);
eq("with separator", splitArtists("Luther with SZA"), ["Luther", "SZA"]);
eq("empty -> []", splitArtists("  "), []);
eq("no false split on X Ambassadors", splitArtists("X Ambassadors"), ["X Ambassadors"]);
eq("dedupe", splitArtists("Drake, Drake"), ["Drake"]);

/* ── youtube track parsing (upload + Topic formats) ── */
eq("upload artist - track", trackFromVideoTitle("Drake - One Dance (Official Video)", ""), { artist: "Drake", title: "One Dance" });
eq("upload strips lyrics suffix", trackFromVideoTitle("Drake - One Dance (Lyrics)", ""), { artist: "Drake", title: "One Dance" });
eq("upload strips bracket suffix", trackFromVideoTitle("Drake - One Dance [Official Music Video]", ""), { artist: "Drake", title: "One Dance" });
eq("upload keeps feat paren", trackFromVideoTitle("Drake - One Dance (feat. Wizkid)", ""), { artist: "Drake", title: "One Dance (feat. Wizkid)" });
eq("topic title is the track", trackFromVideoTitle("Not Like Us", "Kendrick Lamar - Topic"), { artist: "Kendrick Lamar", title: "Not Like Us" });
eq("topic strips audio suffix", trackFromVideoTitle("Not Like Us (Official Audio)", "Kendrick Lamar - Topic"), { artist: "Kendrick Lamar", title: "Not Like Us" });
eq("topic with separator falls back to split", trackFromVideoTitle("A - B", "Someone - Topic"), { artist: "A", title: "B" });
eq("no separator non-topic -> null", trackFromVideoTitle("One Dance (Official Video)", "drakevideos"), null);
eq("empty title -> null", trackFromVideoTitle("  ", ""), null);
eq("missing track -> null", trackFromVideoTitle("Drake - ", ""), null);
eq("upload strips dash official video", trackFromVideoTitle("OK Go - I Won't Let You Down - Official Video", ""), { artist: "OK Go", title: "I Won't Let You Down" });
eq("upload strips dash official music video", trackFromVideoTitle("Drake - One Dance - Official Music Video", ""), { artist: "Drake", title: "One Dance" });
eq("upload strips dash official audio", trackFromVideoTitle("Drake - One Dance - Official Audio", ""), { artist: "Drake", title: "One Dance" });
eq("upload strips dash lyric video", trackFromVideoTitle("Drake - One Dance - Lyric Video", ""), { artist: "Drake", title: "One Dance" });
eq("upload strips dash music video", trackFromVideoTitle("Drake - One Dance - Music Video", ""), { artist: "Drake", title: "One Dance" });
eq("upload keeps dash live", trackFromVideoTitle("Drake - One Dance - Live", ""), { artist: "Drake", title: "One Dance - Live" });
eq("upload strips stacked suffixes", trackFromVideoTitle("Drake - One Dance - Official Video (Official Audio)", ""), { artist: "Drake", title: "One Dance" });

/* ── provider URL IDs (verified URL shapes, Sep 2026) ── */
eq("deezer album id w/ locale", deezerAlbumIdFromPath("/us/album/674017741"), "674017741");
eq("deezer album id no locale", deezerAlbumIdFromPath("/album/674017741"), "674017741");
eq("deezer album id ignores artist path", deezerAlbumIdFromPath("/us/artist/123"), null);
eq("deezer artist id", deezerArtistIdFromPath("/us/artist/246791"), "246791");
eq("deezer track path -> no album id", deezerAlbumIdFromPath("/us/track/123"), null);
eq("provider deezer album", providerIdFromPath("deezer", "/us/album/674017741"), "674017741");
eq("provider deezer artist", providerIdFromPath("deezer", "/fr/artist/246791"), "246791");
eq("provider spotify album", providerIdFromPath("spotify", "/album/4aawyAB9vmqN3uQ7FjRGT"), "4aawyAB9vmqN3uQ7FjRGT");
eq("provider spotify artist", providerIdFromPath("spotify", "/artist/5K4W6rqBKReW9sQjFPr9F"), "5K4W6rqBKReW9sQjFPr9F");
eq("provider spotify intl prefix", providerIdFromPath("spotify", "/intl-de/album/4aawyAB9vmqN3uQ7FjRGT"), "4aawyAB9vmqN3uQ7FjRGT");
eq("provider spotify track", providerIdFromPath("spotify", "/track/6AI3ezQ4o3HUoP6Dhudph3"), "6AI3ezQ4o3HUoP6Dhudph3");
eq("provider spotify intl track", providerIdFromPath("spotify", "/intl-fr/track/6AI3ezQ4o3HUoP6Dhudph3"), "6AI3ezQ4o3HUoP6Dhudph3");
eq("provider tidal album", providerIdFromPath("tidal", "/browse/album/12345678"), "12345678");
eq("provider tidal artist", providerIdFromPath("tidal", "/browse/artist/87654321"), "87654321");
eq("provider bandcamp -> null", providerIdFromPath("bandcamp", "/album/gnx"), null);
eq("provider youtube -> null", providerIdFromPath("youtube", "/watch"), null);
eq("provider unknown -> null", providerIdFromPath("bandcamp", "/whatever"), null);

/* ── deezer album tracklist shaping (real api.deezer.com/album/674017741 shape) ── */
eq("deezer tracks exact titles", deezerAlbumTracks({
  tracks: { data: [{ title: "wacced out murals" }, { title: "squabble up" }, { title: " " }, { title: 42 }] },
}), ["wacced out murals", "squabble up"]);
eq("deezer tracks missing", deezerAlbumTracks({}), []);
eq("deezer tracks error envelope", deezerAlbumTracks({ error: { code: 800 } }), []);
eq("deezer tracks null", deezerAlbumTracks(null), []);

/* ── resolveLibraryLink: deep links into the user's SoulSync ── */
eq("link artist exact", await resolveLibraryLink(cfg, "artist", "Drake"),
  { url: "http://x/artist-detail/library/42", exact: true });
eq("link artist absent -> filtered grid", await resolveLibraryLink(cfg, "artist", "Nobody Here"),
  { url: "http://x/library?q=Nobody%20Here", exact: false });
eq("link artist error -> filtered grid", await resolveLibraryLink(cfg, "artist", "Boom Artist"),
  { url: "http://x/library?q=Boom%20Artist", exact: false });
eq("link album exact pins album", await resolveLibraryLink(cfg, "album", "Views", "Drake"),
  { url: "http://x/artist-detail/library/42?album=7", exact: true });
eq("link album title absent -> artist page", await resolveLibraryLink(cfg, "album", "Nope", "Drake"),
  { url: "http://x/artist-detail/library/42", exact: false });
eq("link album artist absent -> filtered grid", await resolveLibraryLink(cfg, "album", "Views", "Nobody Here"),
  { url: "http://x/library?view=albums&q=Views", exact: false });
eq("link track exact pins album", await resolveLibraryLink(cfg, "track", "One Dance", "Drake"),
  { url: "http://x/artist-detail/library/42?album=7", exact: true });
eq("link empty name -> empty", await resolveLibraryLink(cfg, "artist", "  "),
  { url: "", exact: false });

/* ── baseTitleForMatch: version qualifiers strip, core titles don't ── */
eq("base strips remaster paren", baseTitleForMatch("Song (Remastered)"), "song");
eq("base strips dash qualifier", baseTitleForMatch("Song - Single Version"), "song");
eq("base strips bracket qualifier", baseTitleForMatch("Song [2024 Remaster]"), "song");
eq("base keeps unknown qualifier", baseTitleForMatch("Song (Blue)"), "song blue");
eq("base keeps non-qualifier dash", baseTitleForMatch("Star - Burster"), "star burster");
eq("base no false positive", baseTitleForMatch("Starburster"), "starburster");
/* ── baseTitleForMatch: Spotify attributions + feat. credits strip ── */
eq("base strips Spotify From-suffix", baseTitleForMatch('All The Stars (with SZA) - From "Black Panther: The Album"'), "all the stars");
eq("base strips Spotify From-suffix unquoted", baseTitleForMatch("Song - From the Motion Picture"), "song");
eq("base strips with-parenthetical", baseTitleForMatch("luther (with sza)"), "luther");
eq("base strips feat-parenthetical", baseTitleForMatch("Song (feat. Artist)"), "song");
eq("base strips ft-parenthetical", baseTitleForMatch("Song (FT. Artist)"), "song");
eq("base strips featuring-parenthetical", baseTitleForMatch("Song (Featuring Artist)"), "song");
eq("base different songs stay different", baseTitleForMatch("All The Stars") !== baseTitleForMatch("HUMBLE."), true);
eq("base keeps non-feat paren", baseTitleForMatch("Song (Blue)"), "song blue");

/* ── primaryArtistForMatch: feat. credits strip ── */
eq("primary strips feat", primaryArtistForMatch("Kendrick Lamar feat. SZA"), "kendrick lamar");
eq("primary strips ft", primaryArtistForMatch("Drake ft. Rihanna"), "drake");
eq("primary plain", primaryArtistForMatch("Fontaines D.C."), "fontaines d c");

/* ── lookupLibraryTrackSmart: ID first, then title+artist metadata ── */
{
  const prev = globalThis.fetch;
  // Library has "Starburster" by "Fontaines D.C." under an ALBUM provider ID,
  // while the query carries the SINGLE's provider ID — the exact case from
  // the bug report (same song, different release).
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/library/lookup") {
      const id = u.searchParams.get("id");
      if (id === "album-version-id")
        return { ok: true, status: 200, json: async () => ({ success: true, data: { track: { id: 9 } } }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.pathname === "/api/v1/library/tracks") {
      const t = u.searchParams.get("title") || "";
      const a = u.searchParams.get("artist") || "";
      if (t === "boom") return { ok: false, status: 500, json: async () => ({}) };
      const rows = [];
      const baseT = baseTitleForMatch(t);
      // Same song, album version — different provider ID, same normalized title.
      if ((normName(t) === "starburster" || baseT === "starburster") && normName(a) === "fontaines d c")
        rows.push({ title: "Starburster", artist_name: "Fontaines D.C." });
      // Fuzzy trap: server returns "Star" for "Starburster" — must not match.
      if (normName(t) === "starburster")
        rows.push({ title: "Star", artist_name: "Fontaines D.C." });
      return { ok: true, status: 200, json: async () => ({ success: true, data: { tracks: rows } }) };
    }
    throw new Error("unexpected " + u.pathname);
  };
  try {
    eq("smart: exact ID hit -> true",
      await lookupLibraryTrackSmart(cfg, "spotify", "album-version-id", "Starburster", "Fontaines D.C."), true);
    eq("smart: same song different release -> true (not false)",
      await lookupLibraryTrackSmart(cfg, "spotify", "single-version-id", "Starburster", "Fontaines D.C."), true);
    eq("smart: fuzzy trap 'Star' does not match 'Starburster'",
      await lookupLibraryTrackSmart(cfg, "spotify", "other-id", "Starburster", "Other Band"), false);
    eq("smart: verified absent -> false",
      await lookupLibraryTrackSmart(cfg, "spotify", "nope-id", "Nope", "Nobody"), false);
    eq("smart: server error -> null (never false)",
      await lookupLibraryTrackSmart(cfg, "spotify", "nope-id", "boom", "Fontaines D.C."), null);
    eq("smart: remaster qualifier matches base",
      await lookupLibraryTrackSmart(cfg, "spotify", "x", "Starburster (Remastered)", "Fontaines D.C."), true);
  } finally {
    globalThis.fetch = prev;
  }
}

/* ── checkWatchlist: malformed JSON is unknown, never "not watching" ── */
{
  const prev = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error("bad json"); },
  });
  try {
    eq("watchlist malformed json -> null", await checkWatchlist(cfg, "any"), null);
  } finally {
    globalThis.fetch = prev;
  }
}

/* ── save-playlist: track mappers ── */
eq("spotify mapper full", spotifyPlaylistTrackToMirror({
  id: "t1", name: "One Dance",
  artists: [{ name: "Drake" }, { name: "Wizkid" }],
  album: { name: "Views", images: [{ url: "http://img/1" }, { url: "http://img/2" }] },
  duration_ms: 173000, spotify_track_id: "sp_t1",
}), {
  track_name: "One Dance", artist_name: "Drake", album_name: "Views",
  duration_ms: 173000, image_url: "http://img/1",
  source_track_id: "sp_t1", extra_data: null,
});
eq("spotify mapper sparse (falls back to id, nulls)", spotifyPlaylistTrackToMirror({
  id: "t2", name: "X",
}), {
  track_name: "X", artist_name: "", album_name: "",
  duration_ms: 0, image_url: null,
  source_track_id: "t2", extra_data: null,
});
eq("deezer mapper full", deezerPlaylistTrackToMirror({
  id: 123, name: "Sundress", artists: ["A$AP Rocky"],
  album: "Don't Be Dumb", album_cover_url: "http://img/dz", duration_ms: 200000,
}), {
  track_name: "Sundress", artist_name: "A$AP Rocky", album_name: "Don't Be Dumb",
  duration_ms: 200000, image_url: "http://img/dz",
  source_track_id: "123", extra_data: null,
});
eq("deezer mapper sparse", deezerPlaylistTrackToMirror({ id: 7, name: "Y" }), {
  track_name: "Y", artist_name: "", album_name: "",
  duration_ms: 0, image_url: null,
  source_track_id: "7", extra_data: null,
});

/* ── save-playlist: endpoint shapes ── */
{
  const prev = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init?.method || "GET"} ${url}`);
    const ok = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (u.pathname === "/api/mirrored-playlists/resolve") {
      const ref = u.searchParams.get("ref");
      if (ref === "boom") return ok({ error: "db down" }, 500);
      return ok(ref === "saved1"
        ? { found: true, playlist: { id: 7, name: "Old Mix" } }
        : { found: false, playlist: null });
    }
    if (u.pathname === "/api/spotify/playlist/noauth")
      return ok({ error: "Spotify not authenticated." }, 401);
    if (u.pathname === "/api/spotify/playlist/pl1")
      return ok({
        id: "pl1", name: "Chill", description: "d", owner: "me",
        track_count: 1, image_url: "http://img/pl",
        tracks: [{ id: "t1", name: "One Dance", artists: [{ name: "Drake" }],
                   album: { name: "Views", images: [{ url: "http://img/1" }] },
                   duration_ms: 173000, spotify_track_id: "sp_t1" }],
      });
    if (u.pathname === "/api/deezer/playlist/sync1")
      return ok({
        id: "sync1", name: "DZ Mix", description: "", owner: "dz",
        track_count: 1, image_url: "",
        tracks: [{ id: 9, name: "Sundress", artists: ["A$AP Rocky"],
                   album: "DBD", album_cover_url: "http://img/dz", duration_ms: 200000 }],
      });
    if (u.pathname === "/api/deezer/playlist/big1") {
      if (u.searchParams.get("async") === "1") return ok({ job_id: "job9" }, 202);
      return ok({ job_id: "job9" }, 202);
    }
    if (u.pathname === "/api/deezer/playlist-load/job9") {
      const n = calls.filter((c) => c.includes("playlist-load")).length;
      if (n < 2) return ok({ status: "pending" }, 202);
      return ok({ status: "done", playlist: {
        id: "big1", name: "Big", description: "", owner: "", track_count: 1, image_url: "",
        tracks: [{ id: 10, name: "Late Track", artists: ["Late Artist"], album: "LA" }],
      } });
    }
    if (u.pathname === "/api/mirror-playlist") {
      const body = JSON.parse(String(init.body));
      if (body.name === "Boom Mix") return ok({ error: "mirror exploded" }, 500);
      return ok({ success: true, playlist_id: 99, echoed_tracks: body.tracks.length });
    }
    if (u.pathname === "/api/mirrored-playlists/99/prepare-discovery")
      return ok({ success: true });
    if (u.pathname === "/api/mirrored-playlists/100/prepare-discovery")
      return ok({ success: false, error: "discovery exploded" });
    throw new Error("unexpected " + u.pathname);
  };
  try {
    // resolve
    const r1 = await resolveMirroredPlaylist(cfg, "spotify", "saved1");
    eq("resolve found", r1.found, true);
    eq("resolve found playlist", r1.playlist?.name, "Old Mix");
    const r2 = await resolveMirroredPlaylist(cfg, "deezer", "new1");
    eq("resolve not found", r2, { found: false, playlist: null });
    let threw = "";
    try { await resolveMirroredPlaylist(cfg, "spotify", "boom"); }
    catch (e) { threw = e.message; }
    eq("resolve 500 throws server text", threw, "db down");
    // api_key rides the query on non-v1 routes
    const resolveCall = calls.find((c) => c.includes("/mirrored-playlists/resolve"));
    eq("resolve carries ?api_key=", resolveCall?.includes("api_key=") ?? false, true);

    // spotify playlist fetch
    const sp = await getSpotifyPlaylistTracks(cfg, "pl1");
    eq("spotify playlist name", sp.name, "Chill");
    eq("spotify playlist track normalized", sp.tracks[0].artists?.[0]?.name, "Drake");
    let authErr = "";
    try { await getSpotifyPlaylistTracks(cfg, "noauth"); }
    catch (e) { authErr = e.message; }
    eq("spotify 401 surfaces server text", authErr, "Spotify not authenticated.");

    // deezer sync fetch
    const dz = await getDeezerPlaylistTracks(cfg, "sync1");
    eq("deezer sync name", dz.name, "DZ Mix");
    eq("deezer sync artist string", dz.tracks[0].artists?.[0], "A$AP Rocky");

    // deezer async fallback: 202 -> async=1 -> poll -> done
    const big = await getDeezerPlaylistTracks(cfg, "big1");
    eq("deezer async resolves tracks", big.tracks[0].name, "Late Track");
    eq("deezer async used ?async=1 then poll",
      calls.some((c) => c.includes("/api/deezer/playlist-load/job9")), true);

    // mirror + discovery
    const mid = await mirrorPlaylist(cfg, {
      source: "spotify", source_playlist_id: "pl1", name: "Chill",
      description: "d", owner: "me", image_url: "http://img/pl",
      tracks: [spotifyPlaylistTrackToMirror(sp.tracks[0])],
    });
    eq("mirror returns playlist id", mid, 99);
    let mirrorErr = "";
    try {
      await mirrorPlaylist(cfg, {
        source: "spotify", source_playlist_id: "x", name: "Boom Mix",
        description: "", owner: "", image_url: "", tracks: [],
      });
    } catch (e) { mirrorErr = e.message; }
    eq("mirror 500 throws server text", mirrorErr, "mirror exploded");
    await preparePlaylistDiscovery(cfg, 99);
    eq("discovery POSTed",
      calls.some((c) => c.startsWith("POST ") && c.includes("/api/mirrored-playlists/99/prepare-discovery")),
      true);
    let discErr = "";
    try { await preparePlaylistDiscovery(cfg, 100); }
    catch (e) { discErr = e.message; }
    eq("discovery 200 with json error throws (no fake success)", discErr, "discovery exploded");
  } finally {
    globalThis.fetch = prev;
  }
}

/* ── getWishlistCount reads pagination.total from the v1 envelope ── */
/* The real GET /api/v1/wishlist returns {"success": true, "data": {"tracks": [...]},
 * "pagination": {"total": N, ...}} — the total lives in `pagination`, NOT in
 * `data`. apiFetch() unwraps only `data`, so reading `data.total` always
 * yields 0 (the "always 0 wishlisted" bug). */
{
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const total = u.searchParams.get("limit") === "1" ? 42 : 0;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { tracks: total ? [{ id: 1 }] : [] },
        error: null,
        pagination: { page: 1, limit: 1, total, total_pages: Math.max(1, total), has_next: total > 1, has_prev: false },
      }),
    };
  };
  try {
    eq("wishlist count reads pagination.total", await getWishlistCount(cfg), 42);
  } finally {
    globalThis.fetch = prev;
  }
}

/* ── badge master switch: default ON, only explicit false disables ── */
eq("switch key", BADGES_ENABLED_KEY, "soulsync_badges_enabled");
eq("switch unset -> on", badgesEnabledFromStored({}), true);
eq("switch empty get -> on", badgesEnabledFromStored(undefined), true);
eq("switch false -> off", badgesEnabledFromStored({ [BADGES_ENABLED_KEY]: false }), false);
eq("switch true -> on", badgesEnabledFromStored({ [BADGES_ENABLED_KEY]: true }), true);
eq("switch junk -> on", badgesEnabledFromStored({ [BADGES_ENABLED_KEY]: "nope" }), true);

if (fails) { console.error(`${fails} FAILURES`); process.exit(1); }
console.log("ALL LOGIC + YOUTUBE PARSER TESTS PASSED");
