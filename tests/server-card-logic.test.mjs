/* Server-card snapshot shape guard (real src/shared/api.ts). Storage
 * survives extension updates, so a snapshot written by another version —
 * or anything malformed — must be rejected before the popup paints from
 * it: the renderers trust the shape, and a crash mid-paint would repeat
 * on every open with no way for fresh data to overwrite the bad entry. */
import { isServerCardSnapshot, mergeServerCardSnapshot } from "../src/shared/api.ts";

let fails = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!ok) fails++;
}

const good = {
  url: "http://192.168.4.35:8008",
  savedAt: 1762000000000,
  statsSavedAt: 1762000000000,
  stats: { tracks: 307000, artists: 30000, albums: 71000, activeDownloads: 2, lastUpdate: "2026-11-01T00:00:00", dbSizeMb: 512 },
  wishlistCount: 12,
  videoStats: { movies: 400, shows: 60, episodes: 3000, wishlist: 3 },
  albums: [{ id: "al1", title: "Album", year: 2026, thumb: "/art/1", addedAt: "2026-10-31T00:00:00" }],
  videos: [{ id: 7, title: "Movie", kind: "movie", year: null, thumb: "", addedAt: "2026-10-31T00:00:00" }],
};
const clone = (patch) => ({ ...JSON.parse(JSON.stringify(good)), ...patch });

eq("well-formed snapshot accepted", isServerCardSnapshot(good), true);
eq("empty rails accepted", isServerCardSnapshot(clone({ albums: [], videos: [] })), true);
eq("null videoStats accepted", isServerCardSnapshot(clone({ videoStats: null })), true);
eq("numeric album id accepted", isServerCardSnapshot(clone({
  albums: [{ id: 42, title: "A", year: null, thumb: "", addedAt: "" }],
})), true);

eq("non-object rejected", isServerCardSnapshot("nope"), false);
eq("null rejected", isServerCardSnapshot(null), false);
eq("missing savedAt rejected (pre-timestamp shape)", isServerCardSnapshot(clone({ savedAt: undefined })), false);
eq("missing stats field rejected", isServerCardSnapshot(clone({
  stats: { artists: 1, albums: 1, activeDownloads: 0, lastUpdate: "" },
})), false);
eq("string track count rejected", isServerCardSnapshot(clone({
  stats: { ...good.stats, tracks: "307000" },
})), false);
eq("non-array rail rejected", isServerCardSnapshot(clone({ albums: {} })), false);
eq("album without thumb rejected", isServerCardSnapshot(clone({
  albums: [{ id: "a", title: "A", year: 2020, addedAt: "" }],
})), false);
eq("video with bad kind rejected", isServerCardSnapshot(clone({
  videos: [{ id: 1, title: "V", kind: "episode", year: 2020, thumb: "", addedAt: "" }],
})), false);
eq("video with string id rejected", isServerCardSnapshot(clone({
  videos: [{ id: "1", title: "V", kind: "movie", year: 2020, thumb: "", addedAt: "" }],
})), false);
eq("partial videoStats rejected", isServerCardSnapshot(clone({
  videoStats: { movies: 1, shows: 2 },
})), false);
eq("null rails accepted (never landed)", isServerCardSnapshot(clone({ albums: null, videos: null })), true);
eq("missing statsSavedAt rejected (first shape)", isServerCardSnapshot(clone({ statsSavedAt: undefined })), false);
eq("album with null id rejected", isServerCardSnapshot(clone({
  albums: [{ id: null, title: "A", year: 2020, thumb: "", addedAt: "" }],
})), false);
eq("album with string year rejected", isServerCardSnapshot(clone({
  albums: [{ id: "a", title: "A", year: "2020", thumb: "", addedAt: "" }],
})), false);
eq("NaN track count rejected", isServerCardSnapshot(clone({
  stats: { ...good.stats, tracks: NaN },
})), false);
eq("array videoStats rejected", isServerCardSnapshot(clone({ videoStats: [] })), false);

/* ── merge rules ── */
const URL = good.url;
const statsA = good.stats;
const statsB = { ...good.stats, tracks: 307001 };

eq("nothing anywhere -> no snapshot", mergeServerCardSnapshot(null, {}, URL, 100), null);
eq("rails alone cannot form a snapshot", mergeServerCardSnapshot(null, { albums: [] }, URL, 100), null);
eq("stats without wishlist (no snap) -> no snapshot",
  mergeServerCardSnapshot(null, { stats: statsA }, URL, 100), null);

{
  const m = mergeServerCardSnapshot(null,
    { stats: statsA, wishlistCount: 5, videoStats: null, albums: [], videos: [] }, URL, 100);
  eq("complete first load saves", [m?.stats.tracks, m?.wishlistCount, m?.videoStats, m?.savedAt, m?.statsSavedAt],
    [307000, 5, null, 100, 100]);
}
{
  // a rail that fails on every open (old server, 404 video routes) must
  // not block the save; the rail stays null, never a fabricated []
  const m = mergeServerCardSnapshot(null,
    { stats: statsA, wishlistCount: 5, videoStats: null, albums: [] }, URL, 100);
  eq("missing video rail does not block the save", [m?.albums?.length, m?.videos], [0, null]);
}
{
  const snap = { ...good };
  const m = mergeServerCardSnapshot(snap, { albums: [] }, URL, 200);
  eq("rail-only refresh keeps stats and their original stamp",
    [m?.stats.tracks, m?.statsSavedAt, m?.savedAt, m?.albums?.length], [307000, good.statsSavedAt, 200, 0]);
  const m2 = mergeServerCardSnapshot(snap, { stats: statsB, wishlistCount: 9 }, URL, 300);
  eq("fresh stats re-stamp statsSavedAt", [m2?.stats.tracks, m2?.statsSavedAt, m2?.wishlistCount],
    [307001, 300, 9]);
  eq("empty fresh object over a snap saves nothing", mergeServerCardSnapshot(snap, {}, URL, 400), null);
}

if (fails) {
  console.error(`${fails} server-card-logic test(s) FAILED`);
  process.exit(1);
}
console.log("server-card-logic: all passed");
