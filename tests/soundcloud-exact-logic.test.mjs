/* Exact SoundCloud uploads (real src/shared/soundcloud.ts + api.ts; fetch
 * stubbed per case). An exact upload is wishlisted by its SoundCloud link —
 * the server resolves it and downloads only that upload — so these pin the
 * URL rules, the request shape, the state/error text, and the
 * unsupported-server rule (404/405 = an older server, never a plain error). */
import {
  buildExactRequest,
  exactDraftFor,
  exactErrorMessage,
  exactStateLabel,
  isUnsupportedStatus,
  parseSoundcloudUrl,
  scIdFromAppUrl,
  splitScTitle,
  UNSUPPORTED_SERVER_MESSAGE,
} from "../src/shared/soundcloud.ts";
import {
  addExactSoundcloudTrack,
  addToWishlist,
  connectionHint,
  getExactSoundcloudPlaylists,
  getExactSoundcloudStatus,
  soundcloudExactSupport,
  UnsupportedServerError,
} from "../src/shared/api.ts";

let fails = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!ok) fails++;
}
function ok(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) fails++;
}

const cfg = { url: "http://soulsync.lan:8008", apiKey: "sk_x" };

/** Stub fetch with one scripted answer; records every request. */
const calls = [];
function answer(status, body) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  };
}
async function rejects(p) {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

/* ── parseSoundcloudUrl ── */
eq("public track", parseSoundcloudUrl("https://soundcloud.com/artist-x/some-flip"), {
  kind: "track", url: "https://soundcloud.com/artist-x/some-flip", user: "artist-x", slug: "some-flip",
});
eq("private /s- link keeps the token", parseSoundcloudUrl("https://soundcloud.com/u/t/s-AbC123?si=xyz"), {
  kind: "track", url: "https://soundcloud.com/u/t/s-AbC123", user: "u", slug: "t", secret: "s-AbC123",
});
eq("m. host normalized, query/fragment dropped",
  parseSoundcloudUrl("https://m.soundcloud.com/u/t/?in=u/sets/x#c"),
  { kind: "track", url: "https://soundcloud.com/u/t", user: "u", slug: "t" });
eq("www. host normalized", parseSoundcloudUrl("http://www.soundcloud.com/u/t").kind, "track");
eq("set", parseSoundcloudUrl("https://soundcloud.com/u/sets/my-set").kind, "set");
eq("private set", parseSoundcloudUrl("https://soundcloud.com/u/sets/my-set/s-tok").kind, "set");
eq("likes", parseSoundcloudUrl("https://soundcloud.com/u/likes").kind, "profile");
eq("profile", parseSoundcloudUrl("https://soundcloud.com/u").kind, "profile");
eq("profile tracks tab", parseSoundcloudUrl("https://soundcloud.com/u/tracks").kind, "profile");
eq("discover", parseSoundcloudUrl("https://soundcloud.com/discover").kind, "other");
eq("discover subpage", parseSoundcloudUrl("https://soundcloud.com/discover/sets/new").kind, "other");
eq("search", parseSoundcloudUrl("https://soundcloud.com/search?q=x").kind, "other");
eq("track comments page", parseSoundcloudUrl("https://soundcloud.com/u/t/comments").kind, "other");
eq("short link", parseSoundcloudUrl("https://on.soundcloud.com/AbCdE"), {
  kind: "short", url: "https://on.soundcloud.com/AbCdE",
});
eq("non-SoundCloud", parseSoundcloudUrl("https://open.spotify.com/track/abc").kind, "other");
eq("look-alike host", parseSoundcloudUrl("https://soundcloud.com.evil.example/u/t").kind, "other");
eq("garbage", parseSoundcloudUrl("not a url at all").kind, "other");
eq("empty", parseSoundcloudUrl("").kind, "other");

/* ── scIdFromAppUrl ── */
eq("app url id", scIdFromAppUrl("soundcloud://sounds:123456789"), "123456789");
eq("app url with whitespace", scIdFromAppUrl("  soundcloud://sounds:42 "), "42");
eq("user app url is not a track", scIdFromAppUrl("soundcloud://users:42"), null);
eq("non-digit id", scIdFromAppUrl("soundcloud://sounds:abc"), null);
eq("missing", scIdFromAppUrl(null), null);

/* ── splitScTitle: same cases as the server's _split_artist_from_title ── */
eq("A - B splits", splitScTitle("Artist Name - Track Title", "uploader"), { artist: "Artist Name", title: "Track Title" });
eq("first dash wins", splitScTitle("A1 - B - C", "up"), { artist: "A1", title: "B - C" });
eq("short artist part → uploader", splitScTitle("X - Track", "up"), { artist: "up", title: "X - Track" });
eq("no dash → uploader", splitScTitle("Just A Title", "up"), { artist: "up", title: "Just A Title" });
eq("dash with no title → uploader", splitScTitle("Artist - ", "up"), { artist: "up", title: "Artist - " });
eq("empty title", splitScTitle("", "up"), { artist: "up", title: "" });

/* ── buildExactRequest ── */
eq("trims, dedupes, omits empty playlist",
  buildExactRequest(
    { url: " https://soundcloud.com/u/t " },
    { title: "  Flip  Title ", artists: "A,  a , B,,", remixers: [" R ", "b", "r"] },
    null,
  ),
  { url: "https://soundcloud.com/u/t", title: "Flip Title", artists: ["A", "B"], remixers: ["R"] });
eq("empty fields omitted entirely",
  buildExactRequest({ url: "https://soundcloud.com/u/t" }, { title: " ", artists: "", remixers: "" }, 0),
  { url: "https://soundcloud.com/u/t" });
eq("playlist and quality profile carried",
  buildExactRequest({ url: "https://soundcloud.com/u/t" }, { artists: ["A"] }, 12, 3),
  { url: "https://soundcloud.com/u/t", artists: ["A"], playlist_id: 12, quality_profile_id: 3 });
eq("non-integer playlist omitted",
  buildExactRequest({ url: "https://soundcloud.com/u/t" }, {}, Number.NaN),
  { url: "https://soundcloud.com/u/t" });
eq("artists capped at the server's 10",
  buildExactRequest({ url: "u" }, { artists: Array.from({ length: 12 }, (_, i) => `A${i}`) }).artists.length,
  10);

/* ── exactDraftFor: the playing track's tags only travel with its own link ── */
{
  const npA = { title: "Track A", artist: "uploader-a", album: "", artwork: "https://i1.sndcdn.com/a.jpg",
    sourceUrl: "https://soundcloud.com/uploader-a/track-a?in=x/sets/y", durationMs: 1000 };
  const tabB = "https://soundcloud.com/uploader-b/track-b";
  eq("player-bar link → that track's url + tags",
    exactDraftFor(npA, tabB),
    { url: "https://soundcloud.com/uploader-a/track-a", title: "Track A", uploader: "uploader-a",
      artwork: "https://i1.sndcdn.com/a.jpg", durationMs: 1000 });
  const noSource = { ...npA, sourceUrl: undefined };
  const fromTab = exactDraftFor(noSource, tabB);
  eq("no player-bar link → tab url with NO playing-track tags",
    fromTab, { url: "https://soundcloud.com/uploader-b/track-b", title: "", uploader: "", artwork: "", durationMs: 0 });
  const prefill = splitScTitle(fromTab.title, fromTab.uploader);
  eq("tab draft prefills empty fields", prefill, { artist: "", title: "" });
  eq("tab draft request carries only the url (server defaults apply)",
    buildExactRequest(fromTab, { title: prefill.title, artists: prefill.artist, remixers: "" }, null),
    { url: "https://soundcloud.com/uploader-b/track-b" });
  eq("player-bar link that isn't a track → tab url, still no tags",
    exactDraftFor({ ...npA, sourceUrl: "https://soundcloud.com/u/sets/s" }, tabB)?.title, "");
  eq("neither is a track → null", exactDraftFor(noSource, "https://soundcloud.com/discover"), null);
  eq("nothing playing → null", exactDraftFor(null, tabB), null);
}

/* ── exactStateLabel ── */
eq("queued", exactStateLabel("queued").tag, "QUEUED");
eq("downloading", exactStateLabel("downloading").tag, "DOWNLOADING");
eq("failed with reason", exactStateLabel("failed", "Go+ preview only"), {
  tag: "FAILED", line: "Last try failed: Go+ preview only", cls: "tag-fail",
});
ok("failed without reason still explains", /retried/.test(exactStateLabel("failed", null).line));
eq("acquired", exactStateLabel("acquired"), {
  tag: "IN LIBRARY", line: "Already in your library (this exact upload).", cls: "tag-lib",
});
eq("none", exactStateLabel("none"), { tag: "", line: "", cls: "" });
eq("unknown state", exactStateLabel("weird"), { tag: "", line: "", cls: "" });

/* ── exactErrorMessage: every §3 code has its own text ── */
{
  const codes = ["BAD_REQUEST", "NOT_SOUNDCLOUD_TRACK", "BAD_PLAYLIST", "PLAYLIST_NOT_EDITABLE",
    "UPLOAD_UNAVAILABLE", "SOURCE_DISABLED", "SOURCE_UNAVAILABLE", "BLOCKLISTED", "REJECTED", "WISHLIST_ERROR"];
  const texts = codes.map((c) => exactErrorMessage(c, ""));
  eq("every code maps to distinct text", new Set(texts).size, codes.length);
  ok("no code falls through to the generic text", texts.every((t) => t !== "Adding the exact upload failed."));
  ok("UPLOAD_UNAVAILABLE names the cause", /deleted, private or region-locked/.test(exactErrorMessage("UPLOAD_UNAVAILABLE")));
  ok("SOURCE_DISABLED names settings", /settings/i.test(exactErrorMessage("SOURCE_DISABLED")));
  ok("SOURCE_UNAVAILABLE names yt-dlp", /yt-dlp/.test(exactErrorMessage("SOURCE_UNAVAILABLE")));
  ok("REJECTED carries the server's reason", exactErrorMessage("REJECTED", "quota reached").includes("quota reached"));
  ok("BAD_REQUEST carries the server's reason",
    exactErrorMessage("BAD_REQUEST", "Unknown quality_profile_id.").includes("Unknown quality_profile_id."));
  eq("unknown code → server message", exactErrorMessage("SOMETHING_NEW", "Server said no"), "Server said no");
  eq("unknown code, no message", exactErrorMessage(undefined, ""), "Adding the exact upload failed.");
}

/* ── isUnsupportedStatus ── */
eq("404/405 unsupported, others not", [404, 405, 400, 500, 200].map(isUnsupportedStatus), [true, true, false, false, false]);

/* ── soundcloudExactSupport ── */
{
  calls.length = 0;
  answer(200, { success: true, data: { supported: true, enabled: true, reason: null, state: "none" } });
  eq("200 → supported + enabled", await soundcloudExactSupport(cfg), { supported: true, enabled: true, reason: null });
  eq("probe is a bare GET", [calls[0].method, calls[0].url], ["GET", "http://soulsync.lan:8008/api/v1/soundcloud/exact"]);

  answer(200, { success: true, data: { supported: true, enabled: false, reason: "source_disabled" } });
  eq("200 disabled → reason", await soundcloudExactSupport(cfg), { supported: true, enabled: false, reason: "source_disabled" });

  answer(404, "<!doctype html><title>404 Not Found</title>");
  eq("404 (SPA catch-all, no envelope) → unsupported", await soundcloudExactSupport(cfg), { supported: false });
  answer(405, { success: false, error: { code: "X", message: "y" } });
  eq("405 → unsupported whatever the body", await soundcloudExactSupport(cfg), { supported: false });

  answer(500, { success: false, error: { code: "WISHLIST_ERROR", message: "db locked" } });
  const err = await rejects(soundcloudExactSupport(cfg));
  ok("500 → throws (a normal error, not unsupported)", err instanceof Error && !(err instanceof UnsupportedServerError));
  eq("500 carries the server message", err?.message, "db locked");

  answer(200, "<html>proxy page</html>");
  eq("200 without an envelope → unsupported (unchanged)", await soundcloudExactSupport(cfg), { supported: false });

  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const net = await rejects(soundcloudExactSupport(cfg));
  ok("probe network failure → raw TypeError", net instanceof TypeError);
  const hinted = connectionHint(cfg, net);
  ok("probe network failure gets the connection hint",
    /Could not reach your server at http:\/\/soulsync\.lan:8008/.test(hinted.message) && hinted.message.includes("Failed to fetch"));
  eq("server-answered errors pass through the hint untouched", connectionHint(cfg, err).message, "db locked");
}

/* ── getExactSoundcloudStatus ── */
{
  calls.length = 0;
  answer(200, {
    success: true,
    data: { supported: true, enabled: true, reason: null, state: "failed", matched: true,
      track_id: "soundcloud_exact_123", failure_reason: "preview only", retry_count: 3, last_attempted: "2026-11-20" },
  });
  eq("status mapped", await getExactSoundcloudStatus(cfg, { url: "https://soundcloud.com/u/t/s-tok" }), {
    enabled: true, reason: null, state: "failed", matched: true, trackId: "soundcloud_exact_123",
    failureReason: "preview only", retryCount: 3, lastAttempted: "2026-11-20",
  });
  eq("status query carries the url",
    new URL(calls[0].url).searchParams.get("url"), "https://soundcloud.com/u/t/s-tok");
  answer(200, { success: true, data: { supported: true, state: "none" } });
  await getExactSoundcloudStatus(cfg, { scId: "77" });
  eq("status query carries sc_id", new URL(calls[1].url).searchParams.get("sc_id"), "77");
  answer(404, "");
  ok("status 404 → UnsupportedServerError", (await rejects(getExactSoundcloudStatus(cfg, { url: "x" }))) instanceof UnsupportedServerError);
  answer(200, {});
  ok("status 200 without an envelope → UnsupportedServerError (unchanged)",
    (await rejects(getExactSoundcloudStatus(cfg, { url: "x" }))) instanceof UnsupportedServerError);
}

/* ── addExactSoundcloudTrack ── */
{
  const upload = { sc_id: "123", permalink_url: "https://soundcloud.com/u/t", title: "Orig Title",
    uploader: "u", duration_ms: 201000, artwork_url: "https://i1.sndcdn.com/a.jpg", official_download: false };
  const req = buildExactRequest(
    { url: "https://soundcloud.com/u/t" },
    { title: "Flip", artists: "A, B", remixers: "R" },
    12,
  );

  calls.length = 0;
  answer(201, { success: true, data: { created: true, state: "queued", track_id: "soundcloud_exact_123", upload,
    track: { track_id: "soundcloud_exact_123" },
    playlist: { id: 12, name: "Flips", added: true, already_present: false } } });
  const r = await addExactSoundcloudTrack(cfg, req);
  eq("201 → created", [r.created, r.state, r.trackId], [true, "queued", "soundcloud_exact_123"]);
  eq("upload mapped", r.upload, { scId: "123", permalinkUrl: "https://soundcloud.com/u/t", title: "Orig Title",
    uploader: "u", durationMs: 201000, artworkUrl: "https://i1.sndcdn.com/a.jpg", officialDownload: false });
  eq("playlist mapped", r.playlist, { id: 12, name: "Flips", added: true, alreadyPresent: false, error: null });
  eq("POSTs /api/v1/soundcloud/exact", [calls[0].method, calls[0].url],
    ["POST", "http://soulsync.lan:8008/api/v1/soundcloud/exact"]);
  eq("request body has exactly the expected fields", JSON.parse(calls[0].body), {
    url: "https://soundcloud.com/u/t", title: "Flip", artists: ["A", "B"], remixers: ["R"], playlist_id: 12,
  });

  answer(200, { success: true, data: { created: false, state: "queued", track_id: "soundcloud_exact_123", upload,
    track: null, playlist: null } });
  const again = await addExactSoundcloudTrack(cfg, { url: "https://soundcloud.com/u/t/s-tok" });
  eq("200 → created false, no playlist", [again.created, again.playlist], [false, null]);

  answer(200, { success: true, data: { created: false, state: "acquired", track_id: "soundcloud_exact_123",
    upload, track: null, playlist: null } });
  eq("200 acquired", (await addExactSoundcloudTrack(cfg, { url: "https://soundcloud.com/u/t" })).state, "acquired");

  answer(201, { success: true, data: { created: true, state: "queued", track_id: "soundcloud_exact_123", upload,
    playlist: { id: 12, added: false, error: "playlist write failed" } } });
  eq("playlist failure reported, add still succeeds",
    (await addExactSoundcloudTrack(cfg, req)).playlist,
    { id: 12, name: "", added: false, alreadyPresent: false, error: "playlist write failed" });

  answer(405, "<html>Method Not Allowed</html>");
  const old = await rejects(addExactSoundcloudTrack(cfg, req));
  ok("405 → UnsupportedServerError", old instanceof UnsupportedServerError);
  eq("unsupported message", old?.message, UNSUPPORTED_SERVER_MESSAGE);
  answer(404, "");
  ok("404 → UnsupportedServerError", (await rejects(addExactSoundcloudTrack(cfg, req))) instanceof UnsupportedServerError);

  answer(422, { success: false, error: { code: "UPLOAD_UNAVAILABLE", message: "SoundCloud returned nothing." } });
  const gone = await rejects(addExactSoundcloudTrack(cfg, req));
  ok("422 is not 'unsupported'", gone instanceof Error && !(gone instanceof UnsupportedServerError));
  eq("422 UPLOAD_UNAVAILABLE → mapped message", gone?.message, exactErrorMessage("UPLOAD_UNAVAILABLE"));

  answer(200, {});
  const phantom = await rejects(addExactSoundcloudTrack(cfg, req));
  ok("200 with no success flag → throws, never a result", phantom instanceof Error && !(phantom instanceof UnsupportedServerError));
  answer(201, { data: { created: false, state: "queued", track_id: "soundcloud_exact_123" } });
  ok("201 envelope missing success:true → throws", (await rejects(addExactSoundcloudTrack(cfg, req))) instanceof Error);

  answer(409, { success: false, error: { code: "BLOCKLISTED", message: "That uploader is on your blocklist." } });
  eq("409 BLOCKLISTED → mapped message", (await rejects(addExactSoundcloudTrack(cfg, req)))?.message,
    exactErrorMessage("BLOCKLISTED"));
}

/* ── getExactSoundcloudPlaylists ── */
{
  calls.length = 0;
  answer(200, { success: true, data: { playlists: [
    { id: 12, name: "Flips", track_count: 40, liked: false },
    { id: 3, name: "Liked", track_count: 2, liked: true },
    { id: "bad", name: "No id" },
  ] } });
  eq("playlists mapped (rows without an id dropped)", await getExactSoundcloudPlaylists(cfg), [
    { id: 12, name: "Flips", trackCount: 40, liked: false },
    { id: 3, name: "Liked", trackCount: 2, liked: true },
  ]);
  eq("GETs /soundcloud/exact/playlists", calls[0].url, "http://soulsync.lan:8008/api/v1/soundcloud/exact/playlists");
  answer(404, "");
  ok("playlists 404 → UnsupportedServerError", (await rejects(getExactSoundcloudPlaylists(cfg))) instanceof UnsupportedServerError);
  answer(200, "<html>proxy page</html>");
  ok("playlists 200 without an envelope → throws (picker shows the failure)",
    (await rejects(getExactSoundcloudPlaylists(cfg))) instanceof Error);
}

/* ── regression: the catalogue Wishlist path is untouched ── */
{
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
    const body = String(url).endsWith("/api/v1/search/tracks")
      ? { success: true, data: { source: "spotify", tracks: [{ id: "sp1", name: "Song", artists: [{ name: "Artist" }], album: "LP" }] } }
      : { success: true, data: { created: true } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const r = await addToWishlist(cfg, { artist: "Artist", title: "Song" });
  eq("catalogue add searches first", [calls[0].method, new URL(calls[0].url).pathname], ["POST", "/api/v1/search/tracks"]);
  eq("then wishlists the hit", [calls[1].method, new URL(calls[1].url).pathname], ["POST", "/api/v1/wishlist"]);
  eq("catalogue add never touches the exact route", calls.some((c) => c.url.includes("/soundcloud/exact")), false);
  eq("catalogue result", [r.trackId, r.created], ["sp1", true]);
}

if (fails) {
  console.error(`${fails} soundcloud-exact test(s) FAILED`);
  process.exit(1);
}
console.log("soundcloud-exact-logic: all passed");
