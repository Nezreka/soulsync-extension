/* The batched badge checks (newer servers): POST /api/v1/library/check for
 * artists, their albums and watch state, POST /api/v1/video/check for
 * movies/shows by TMDB id. Real src code, fetch stubbed per case. */
import {
  baseAlbumTitle,
  checkArtist,
  checkVideo,
  clearBadgeCache,
  getVideoStats,
  lookupBadgeStatuses,
  pickLibraryAlbum,
  rememberedWatchId,
  resetBatchSupport,
  resolveLibraryLink,
  watchStateFromCheck,
} from "../src/shared/api.ts";
import { currentV1Budget, resetServerFetchState, serverFetch } from "../src/shared/http.ts";

let fails = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!ok) fails++;
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const env = (data) => json(200, { success: true, data, error: null });

/* ── album titles: the same album on another edition ── */
eq("base: remastered", baseAlbumTitle("Abbey Road (Remastered)"), "abbey road");
eq("base: dash deluxe", baseAlbumTitle("Rumours - Super Deluxe Edition"), "rumours");
eq("base: stacked qualifiers", baseAlbumTitle("Nevermind (Deluxe Edition) [Remastered 2011]"), "nevermind");
eq("base: taylor's version is its own record", baseAlbumTitle("Fearless (Taylor's Version)"), "fearless taylor s version");
eq("base: live stays", baseAlbumTitle("Alive (Live)"), "alive live");
eq("base: plain title", baseAlbumTitle("OK Computer"), "ok computer");
{
  const albums = [
    { id: "1", title: "Abbey Road" },
    { id: "2", title: "Let It Be (Remastered)" },
    { id: "3", title: "Help!" },
    { id: "4", title: "Help! (Deluxe Edition)" },
  ];
  eq("pick: exact", pickLibraryAlbum(albums, "Abbey Road"), "1");
  eq("pick: page remaster -> library plain", pickLibraryAlbum(albums, "Abbey Road (2019 Mix)"), null);
  eq("pick: page plain -> library remaster", pickLibraryAlbum(albums, "Let It Be"), "2");
  eq("pick: page deluxe -> library plain", pickLibraryAlbum(albums, "Abbey Road - Super Deluxe Edition"), "1");
  eq("pick: exact beats the edition match", pickLibraryAlbum(albums, "Help! (Deluxe Edition)"), "4");
  eq("pick: absent", pickLibraryAlbum(albums, "Revolver"), null);
}

/* ── one request for a whole page of artists, albums and watch states ── */
{
  resetBatchSupport();
  clearBadgeCache();
  const cfg = { url: "http://new", apiKey: "k" };
  const posts = [];
  const LIB = {
    low: { artist_id: "1", library_name: "Low", watching: true, watch_id: "sp_low",
      albums: [{ id: "100", title: "Things We Lost in the Fire" }, { id: "101", title: "Secret Name (Remastered)" }] },
    drake: { artist_id: "42", library_name: "Drake", watching: false, watch_id: null, albums: [] },
  };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/library/check") {
      const body = JSON.parse(init.body);
      posts.push(body);
      const artists = body.artists.map((a) => {
        const hit = LIB[a.name.toLowerCase()];
        const row = { name: a.name, in_library: !!hit, artist_id: hit?.artist_id ?? null,
          library_name: hit?.library_name ?? null,
          watching: hit ? hit.watching : a.provider_id === "dz_watched",
          watch_id: hit ? hit.watch_id : (a.provider_id === "dz_watched" ? "dz_watched" : null) };
        if (a.albums) row.albums = hit ? hit.albums : [];
        return row;
      });
      return env({ artists });
    }
    throw new Error("unexpected " + u.pathname);
  };
  const [r, w1, w2, w3] = await Promise.all([
    lookupBadgeStatuses(cfg, [
      { kind: "artist", name: "Low" },
      { kind: "artist", name: "Nobody" },
      { kind: "album", name: "Things We Lost in the Fire", artist: "Low" },
      { kind: "album", name: "Secret Name", artist: "Low" },
      { kind: "album", name: "Views", artist: "Drake" },
      { kind: "album", name: "Views", artist: "Nobody" },
    ]),
    watchStateFromCheck(cfg, "Low"),
    watchStateFromCheck(cfg, "Drake", "sp_drake"),
    watchStateFromCheck(cfg, "Someone", "dz_watched"),
  ]);
  eq("batch: one request for the page", posts.length, 1);
  eq("batch: each name asked once", posts[0].artists.map((a) => a.name).sort(), ["Drake", "Low", "Nobody", "Someone"]);
  eq("batch: albums asked only for album artists",
    posts[0].artists.filter((a) => a.albums).map((a) => a.name).sort(), ["Drake", "Low", "Nobody"]);
  eq("batch: provider ids go along", posts[0].artists.find((a) => a.name === "Someone").provider_id, "dz_watched");
  eq("artist in library", r["artist:low"], true);
  eq("artist absent", r["artist:nobody"], false);
  eq("album exact", r["album:low things we lost in the fire"], true);
  eq("album on another edition", r["album:low secret name"], true);
  eq("album absent under artist", r["album:drake views"], false);
  eq("album of absent artist", r["album:nobody views"], false);
  eq("watching by name", w1, true);
  eq("not watching", w2, false);
  eq("watching by the page's id", w3, true);
  eq("watch row id remembered for unwatch", await rememberedWatchId(cfg, "Low"), "sp_low");

  // remembered: a rescan asks nothing
  await lookupBadgeStatuses(cfg, [{ kind: "artist", name: "Low" }, { kind: "album", name: "Secret Name", artist: "Low" }]);
  eq("batch: rescan answered from memory", posts.length, 1);

  // the deep link pins the album from the same answer
  const link = await resolveLibraryLink(cfg, "album", "Secret Name", "Low");
  eq("library link pins the album", [link.url, link.exact], ["http://new/artist-detail/library/1?album=101", true]);
  eq("library link costs no request", posts.length, 1);
}

/* ── server error: unknown, never absent, and not remembered ── */
{
  resetBatchSupport();
  clearBadgeCache();
  const cfg = { url: "http://err", apiKey: "k" };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json(500, { success: false, error: { code: "LIBRARY_ERROR", message: "x" } }); };
  const r = await lookupBadgeStatuses(cfg, [{ kind: "artist", name: "Low" }, { kind: "album", name: "X", artist: "Low" }]);
  eq("500 -> artist unknown", r["artist:low"], null);
  eq("500 -> album unknown", r["album:low x"], null);
  eq("500 -> watch unknown", await watchStateFromCheck(cfg, "Low"), null);
  const before = calls;
  await lookupBadgeStatuses(cfg, [{ kind: "artist", name: "Low" }]);
  eq("500 not remembered: asks again", calls > before, true);
}

/* ── older server: detected once, then the old calls ── */
{
  resetBatchSupport();
  clearBadgeCache();
  const cfg = { url: "http://old", apiKey: "k" };
  let checkPosts = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/library/check") { checkPosts++; return json(405, null); }
    if (u.pathname === "/api/v1/library/artists") {
      return env({ artists: u.searchParams.get("search") === "Low" ? [{ id: 1, name: "Low" }] : [] });
    }
    throw new Error("unexpected " + u.pathname);
  };
  const r = await lookupBadgeStatuses(cfg, [{ kind: "artist", name: "Low" }]);
  eq("old server: artist via the old search", r["artist:low"], true);
  eq("old server: watch state says use the old path", await watchStateFromCheck(cfg, "Other"), undefined);
  eq("old server: asked the batch route once", checkPosts, 1);
  eq("old server: checkArtist short-circuits", await checkArtist(cfg, "Third"), "unsupported");
  eq("old server: still once", checkPosts, 1);
}

/* ── multi-artist track: owned under one of the credits, no search ── */
{
  resetBatchSupport();
  clearBadgeCache();
  const cfg = { url: "http://tracks", apiKey: "k" };
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/api/library/check-tracks") {
      const body = JSON.parse(init.body);
      asked.push(body.artist_name);
      const owned = body.artist_name === "Post Malone";
      const owned_tracks = {};
      for (const t of body.tracks) owned_tracks[t.name] = { owned };
      return json(200, { success: true, owned_tracks });
    }
    throw new Error("unexpected " + u.pathname);
  };
  const r = await lookupBadgeStatuses(cfg, [{ kind: "track", name: "Sunflower", artist: "Post Malone, Swae Lee" }]);
  eq("multi-artist: owned under the first artist", r["track:post malone swae lee sunflower"], true);
  eq("multi-artist: credit and each artist asked", asked.sort(), ["Post Malone", "Post Malone, Swae Lee", "Swae Lee"]);
}

/* ── video: one request for a rail, by TMDB id ── */
{
  resetBatchSupport();
  const cfg = { url: "http://video", apiKey: "k" };
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/api/v1/video/check") {
      const body = JSON.parse(init.body);
      posts.push(body);
      return env({
        items: body.items.map((it) => ({
          kind: it.kind, tmdb_id: it.tmdb_id,
          in_library: it.tmdb_id === 603, on_wishlist: it.tmdb_id === 27205,
          following: it.kind === "show" ? it.tmdb_id === 1399 : null,
          ...(it.season !== undefined ? { episode_in_library: it.episode === 1, episode_on_wishlist: it.episode === 2 } : {}),
        })),
      });
    }
    throw new Error("unexpected " + u.pathname);
  };
  const [a, b, c, d, e, dup] = await Promise.all([
    checkVideo(cfg, { kind: "movie", tmdbId: 603 }),
    checkVideo(cfg, { kind: "movie", tmdbId: 27205 }),
    checkVideo(cfg, { kind: "show", tmdbId: 1399 }),
    checkVideo(cfg, { kind: "show", tmdbId: 1399, episode: { season: 1, episode: 1 } }),
    checkVideo(cfg, { kind: "show", tmdbId: 1399, episode: { season: 1, episode: 2 } }),
    checkVideo(cfg, { kind: "movie", tmdbId: 603 }),
  ]);
  eq("video: one request", posts.length, 1);
  eq("video: duplicates asked once", posts[0].items.length, 5);
  eq("video: in library", [a.inLibrary, a.onWishlist, a.following], [true, false, null]);
  eq("video: wishlisted", [b.inLibrary, b.onWishlist], [false, true]);
  eq("video: followed show", c.following, true);
  eq("video: episode in library", [d.episodeInLibrary, d.episodeOnWishlist], [true, false]);
  eq("video: episode wishlisted", [e.episodeInLibrary, e.episodeOnWishlist], [false, true]);
  eq("video: duplicate shares the answer", dup.inLibrary, true);
  eq("video: no tmdb id -> unknown", await checkVideo(cfg, { kind: "movie", tmdbId: 0 }), null);

  globalThis.fetch = async () => json(404, null);
  resetBatchSupport();
  eq("video: older server -> unsupported", await checkVideo(cfg, { kind: "movie", tmdbId: 1 }), "unsupported");
  globalThis.fetch = async () => json(503, { success: false, error: { code: "NOT_AVAILABLE", message: "off" } });
  resetBatchSupport();
  eq("video: video side off -> unknown", await checkVideo(cfg, { kind: "movie", tmdbId: 1 }), null);
}

/* ── popup video counts: one call, older servers three ── */
{
  const cfg = { url: "http://stats", apiKey: "k" };
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const u = new URL(url);
    if (u.pathname === "/api/v1/video/stats") {
      return env({ library: { movies: 10, shows: 4, episodes: 120 }, wishlist: { total: 7 } });
    }
    throw new Error("unexpected " + u.pathname);
  };
  eq("video stats in one call", [await getVideoStats(cfg), calls], [{ movies: 10, shows: 4, episodes: 120, wishlist: 7 }, 1]);
  calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    const u = new URL(url);
    if (u.pathname === "/api/v1/video/stats") return json(404, null);
    if (u.pathname === "/api/v1/video/library") {
      const kind = u.searchParams.get("kind");
      return env({ pagination: { total_count: kind === "movies" ? 3 : 2 }, ...(kind === "shows" ? { total_episodes: 9 } : {}) });
    }
    if (u.pathname === "/api/v1/video/wishlist/counts") return env({ total: 1 });
    throw new Error("unexpected " + u.pathname);
  };
  eq("older server: the list totals", await getVideoStats(cfg), { movies: 3, shows: 2, episodes: 9, wishlist: 1 });
}

/* ── pacer: the keyed bucket is fast, a 429 means an older server ── */
{
  resetServerFetchState({ backoffMs: [5, 5, 5] });
  eq("pacer starts on the keyed budget", currentV1Budget(), 250);
  let n = 0;
  globalThis.fetch = async () => (++n === 1 ? json(429, {}) : json(200, {}));
  await serverFetch("http://s/api/v1/library/artists");
  eq("a 429 drops to the per-address budget", currentV1Budget(), 45);
  resetServerFetchState();
  globalThis.fetch = async () => json(429, {});
  resetServerFetchState({ backoffMs: [1] });
  await serverFetch("http://s/api/library/check-tracks");
  eq("a non-v1 429 leaves the v1 budget alone", currentV1Budget(), 250);
}

if (fails) { console.error(`${fails} FAILURES`); process.exit(1); }
console.log("ALL BATCH CHECK TESTS PASSED");
