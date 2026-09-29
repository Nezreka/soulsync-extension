import browser from 'webextension-polyfill';
import type { ReleaseInfo, ServerConfig } from './types.js';

/**
 * SoulSync server client.
 *
 * Verified against SoulSync dev (Sep 28, 2026) — full contract in
 * SERVER_ENDPOINTS.md:
 * - Public REST API at <url>/api/v1 (api/__init__.py create_api_blueprint).
 * - Auth is `Authorization: Bearer <key>` (api/auth.py require_api_key);
 *   keys look like `sk_…`, generated on the server's Settings page. Under
 *   API-key auth the request runs as the admin profile (g.profile_id = 1).
 * - Envelope: {success: true, data: {...}} / {success: false, error: {code, message}}.
 * - POST /api/v1/search/tracks  {query, source: "spotify"|"itunes"|"auto", limit}
 *   -> {tracks: [{id, name, artists[], album, …}]} (api/search.py::_serialize_track)
 * - POST /api/v1/search/albums  (same shape)
 * - POST /api/v1/wishlist       {track_data, source_type?, failure_reason?} -> 200/201
 *   (the wishlist pipeline IS the download pipeline — no separate download call)
 * - POST /api/v1/playlists/<id>/sync  {playlist_name, tracks: [{name, artists[], album}], sync_mode?}
 * - GET  /api/v1/playlists      list only (used as the cheap auth check)
 */

const V1 = '/api/v1';
const CONFIG_KEY = 'serverConfig';

interface Envelope {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string } | string;
}

function baseUrl(cfg: ServerConfig): string {
  return cfg.url.replace(/\/+$/, '');
}

/** Fetch and unwrap the v1 envelope; throw on transport or API errors. */
async function apiFetch(cfg: ServerConfig, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(baseUrl(cfg) + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(init.headers || {}),
    },
  });
  const envelope = (await res.json().catch(() => ({}))) as Envelope;
  if (!res.ok || envelope.success === false) {
    const err = envelope.error;
    const msg = typeof err === 'string' ? err : err?.message || `Server returned ${res.status}`;
    throw new Error(msg);
  }
  return envelope.data ?? {};
}

export async function getConfig(): Promise<ServerConfig | null> {
  const stored = (await browser.storage.local.get(CONFIG_KEY)) as {
    serverConfig?: ServerConfig;
  };
  const cfg = stored.serverConfig;
  if (!cfg?.url || !cfg?.apiKey) return null;
  return { url: cfg.url.replace(/\/+$/, ''), apiKey: cfg.apiKey };
}

export async function saveConfig(cfg: ServerConfig): Promise<void> {
  await browser.storage.local.set({
    [CONFIG_KEY]: { url: cfg.url.replace(/\/+$/, ''), apiKey: cfg.apiKey },
  });
}

/**
 * Ask for host permission (needed for fetch to bypass CORS), then hit a cheap
 * authenticated GET. Anything 2xx means URL + key work.
 */
export async function testConnection(cfg: ServerConfig): Promise<string> {
  const origin = new URL(cfg.url).origin + '/*';
  // Call request() with no await in front of it: it must run synchronously
  // inside the click's task or Firefox rejects it with "may only be called
  // from a user input handler". request() resolves true without prompting
  // when the origin is already granted, so no contains() check is needed.
  const granted = await browser.permissions.request({ origins: [origin] });
  if (!granted) throw new Error('Permission to reach your server was not granted.');
  await apiFetch(cfg, `${V1}/playlists`, { method: 'GET' });
  return 'Connected — the server answered with your API key.';
}

export interface TrackHit {
  id: string;
  title: string;
  artist: string;
  album: string;
  /** artwork from the search provider, when it has any */
  image: string;
  /** raw server object (has the id the wishlist pipeline needs) */
  raw: unknown;
}

function artistNames(a: unknown): string {
  if (Array.isArray(a)) {
    return a.map((x) => (typeof x === 'string' ? x : (x as { name?: string }).name ?? '')).filter(Boolean).join(', ');
  }
  return typeof a === 'string' ? a : '';
}

function albumName(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object') return (a as { name?: string }).name ?? '';
  return '';
}

export interface SearchResult {
  tracks: TrackHit[];
  /** metadata source the hits came from: spotify | itunes | deezer | hydrabase | … */
  source: string;
}

/** Raw search, no fallback. */
async function doSearch(cfg: ServerConfig, query: string, limit: number): Promise<SearchResult> {
  const data = await apiFetch(cfg, `${V1}/search/tracks`, {
    method: 'POST',
    body: JSON.stringify({ query, source: 'auto', limit }),
  });
  const tracks = data.tracks;
  const hits = !Array.isArray(tracks)
    ? []
    : tracks.map((t: unknown) => {
        const o = t as Record<string, unknown>;
        return {
          id: (o.id as string) ?? '',
          title: (o.name as string) ?? '',
          artist: artistNames(o.artists),
          album: albumName(o.album),
          image: typeof o.image_url === 'string' ? o.image_url : '',
          raw: t,
        };
      });
  return { tracks: hits, source: (data.source as string) ?? '' };
}

/**
 * Serialized shape is api/search.py::_serialize_track: {id, name, artists[], album, …}.
 * The server forwards the query verbatim to the metadata provider, so video-page
 * cruft the cleaner didn't anticipate can still zero out results — in that case
 * retry once with all bracketed segments stripped.
 */
export async function searchTracks(cfg: ServerConfig, query: string, limit = 5): Promise<SearchResult> {
  const first = await doSearch(cfg, query, limit);
  if (first.tracks.length > 0) return first;
  const stripped = query
    .replace(/\s*[[(].*?[\])]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped || stripped === query) return first;
  return doSearch(cfg, stripped, limit);
}

export async function searchAlbums(cfg: ServerConfig, query: string, limit = 5): Promise<TrackHit[]> {
  const data = await apiFetch(cfg, `${V1}/search/albums`, {
    method: 'POST',
    body: JSON.stringify({ query, source: 'auto', limit }),
  });
  const albums = data.albums;
  if (!Array.isArray(albums)) return [];
  return albums.map((a: unknown) => {
    const o = a as Record<string, unknown>;
    return {
      id: (o.id as string) ?? '',
      title: (o.name as string) ?? '',
      artist: artistNames(o.artists),
      album: (o.name as string) ?? '',
      image: typeof o.image_url === 'string' ? o.image_url : '',
      raw: a,
    };
  });
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Pick the hit that best matches what the user saw; fall back to the top hit. */
export function pickBest(hits: TrackHit[], want: { artist: string; title: string }): TrackHit | null {
  if (hits.length === 0) return null;
  const wt = norm(want.title);
  const wa = norm(want.artist);
  return (
    hits.find((h) => norm(h.title) === wt && wa !== '' && norm(h.artist).includes(wa)) ??
    hits.find((h) => norm(h.title) === wt) ??
    hits[0]
  );
}

export interface WishlistResult {
  title: string;
  artist: string;
  /** false when the track was already there (entry updated instead) */
  created: boolean;
  /** provider id of the resolved hit, for local wishlist memory */
  trackId: string;
}

/**
 * Reshape a search hit into the Spotify track shape the wishlist pipeline
 * and UI were built for: `album: {name, images: [{url}]}` and
 * `artists: [{name}]`. The search endpoint's `_serialize_track` flattens the
 * album to a bare string and parks the art at top-level `image_url`, which
 * the wishlist UI cannot see (it reads `album.images[0].url`).
 */
function toSpotifyShape(hit: TrackHit): Record<string, unknown> {
  const o = (hit.raw ?? {}) as Record<string, unknown>;
  const imageUrl = typeof o.image_url === 'string' ? o.image_url : '';
  return {
    id: hit.id,
    name: hit.title,
    artists: [{ name: hit.artist }],
    album: {
      name: hit.album,
      images: imageUrl ? [{ url: imageUrl }] : [],
    },
    duration_ms: o.duration_ms ?? 0,
    popularity: o.popularity ?? 0,
    preview_url: o.preview_url ?? null,
    release_date: o.release_date ?? '',
    source: 'companion',
  };
}

/**
 * Wishlist one specific search hit — no re-search, no guessing. Used by the
 * manual "help match" picker and by addToWishlist after it picks a hit.
 */
export async function wishlistTrack(cfg: ServerConfig, hit: TrackHit): Promise<WishlistResult> {
  if (!hit.id) throw new Error('That result has no track id.');
  const data = await apiFetch(cfg, `${V1}/wishlist`, {
    method: 'POST',
    body: JSON.stringify({
      track_data: toSpotifyShape(hit),
      source_type: 'companion',
      failure_reason: 'Added via SoulSync Companion',
    }),
  });
  return { title: hit.title, artist: hit.artist, created: data.created !== false, trackId: hit.id };
}

/**
 * Wishlist a track from bare metadata. The wishlist pipeline needs a real
 * track id (`database/music_database.py::add_to_wishlist_detailed` rejects
 * id-less rows with "missing track id"), so we resolve the metadata through
 * the server's own search first and wishlist the chosen hit — the server does
 * the matching, the extension never guesses. The wishlist's download pipeline
 * then takes it from there.
 */
export async function addToWishlist(
  cfg: ServerConfig,
  track: { artist: string; title: string; album?: string; artwork?: string },
): Promise<WishlistResult> {
  const { tracks: hits } = await searchTracks(cfg, `${track.artist} - ${track.title}`, 5);
  const best = pickBest(hits, track);
  if (!best || !best.id) {
    throw new Error(`No match found for "${track.artist} - ${track.title}".`);
  }
  return wishlistTrack(cfg, best);
}

/** Wishlist every track of a page-aware release. */
export async function wishlistRelease(cfg: ServerConfig, release: ReleaseInfo): Promise<number> {
  let n = 0;
  for (const title of release.tracks) {
    await addToWishlist(cfg, { artist: release.artist, title, album: release.title });
    n++;
  }
  return n;
}

/** Providers the library lookup endpoint accepts (api/library.py). */
const LOOKUP_PROVIDERS = new Set([
  'spotify',
  'musicbrainz',
  'itunes',
  'deezer',
  'audiodb',
  'tidal',
  'qobuz',
  'genius',
]);

/**
 * Is this provider track id already in the library? true = yes, false = no,
 * null = couldn't check (unknown provider or request failed). Uses its own
 * fetch so a 404 ("not in library") isn't an exception.
 */
export async function lookupLibraryTrack(
  cfg: ServerConfig,
  provider: string,
  id: string,
): Promise<boolean | null> {
  if (!LOOKUP_PROVIDERS.has(provider) || !id) return null;
  try {
    const url =
      `${cfg.url.replace(/\/+$/, '')}${V1}/library/lookup?type=track` +
      `&provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(id)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    if (res.status === 404) return false;
    if (!res.ok) return null;
    const envelope = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { track?: unknown };
    };
    return envelope.success === true && !!envelope.data?.track;
  } catch {
    return null;
  }
}

/** Remove a track from the wishlist by its provider id. 404 = already gone. */
export async function removeFromWishlist(cfg: ServerConfig, trackId: string): Promise<void> {
  const url = `${cfg.url.replace(/\/+$/, '')}${V1}/wishlist/${encodeURIComponent(trackId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (res.status === 404) return;
  const envelope = (await res.json().catch(() => ({}))) as { success?: boolean };
  if (!res.ok || envelope.success === false) throw new Error(`Server returned ${res.status}`);
}

/**
 * Import tracks as a server playlist. The playlist_id is minted per import
 * (it's the sync-state key — uniqueness is its only requirement); the server
 * downloads missing tracks and creates/updates the media-server playlist.
 * sync_mode 'append' only adds tracks not already on the server playlist.
 * (api/playlists.py → start_playlist_sync_from_payload)
 */
export async function importToPlaylist(
  cfg: ServerConfig,
  playlistName: string,
  tracks: { artist: string; title: string }[],
): Promise<void> {
  const playlistId = `companion-${crypto.randomUUID()}`;
  await apiFetch(cfg, `${V1}/playlists/${encodeURIComponent(playlistId)}/sync`, {
    method: 'POST',
    body: JSON.stringify({
      playlist_name: playlistName,
      tracks: tracks.map((t) => ({ name: t.title, artists: [t.artist], album: '' })),
      sync_mode: 'append',
    }),
  });
}

/* ── server dashboard extras ── */

export interface ServerStats {
  tracks: number;
  artists: number;
  albums: number;
  activeDownloads: number;
  lastUpdate: string;
  dbSizeMb: number | null;
}

/** GET /api/v1/system/stats — combined library + download stats. */
export async function getServerStats(cfg: ServerConfig): Promise<ServerStats> {
  const data = await apiFetch(cfg, `${V1}/system/stats`, { method: 'GET' });
  const lib = (data.library ?? {}) as Record<string, unknown>;
  const dl = (data.downloads ?? {}) as Record<string, unknown>;
  const db = (data.database ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    tracks: num(lib.tracks),
    artists: num(lib.artists),
    albums: num(lib.albums),
    activeDownloads: num(dl.active),
    lastUpdate: typeof db.last_update === 'string' ? db.last_update : '',
    dbSizeMb: typeof db.size_mb === 'number' ? db.size_mb : null,
  };
}

export interface RecentAlbum {
  id: number;
  title: string;
  year: number | null;
  thumb: string;
  addedAt: string;
}

/** GET /api/v1/library/recently-added?type=albums — artwork via thumb_url. */
export async function getRecentlyAdded(cfg: ServerConfig, limit = 12): Promise<RecentAlbum[]> {
  const data = await apiFetch(
    cfg,
    `${V1}/library/recently-added?type=albums&limit=${Math.min(50, Math.max(1, limit))}`,
    { method: 'GET' },
  );
  const items = data.items;
  if (!Array.isArray(items)) return [];
  return items.map((it: unknown) => {
    const o = it as Record<string, unknown>;
    return {
      id: typeof o.id === 'number' ? o.id : 0,
      title: typeof o.title === 'string' ? o.title : 'Untitled',
      year: typeof o.year === 'number' ? o.year : null,
      thumb: typeof o.thumb_url === 'string' ? o.thumb_url : '',
      addedAt: typeof o.created_at === 'string' ? o.created_at : '',
    };
  });
}

/** Wishlist size, via the list endpoint's pagination total (limit=1 = cheap). */
export async function getWishlistCount(cfg: ServerConfig): Promise<number> {
  const data = await apiFetch(cfg, `${V1}/wishlist?limit=1`, { method: 'GET' });
  return typeof data.total === 'number' ? data.total : 0;
}

/**
 * Resolve an artwork URL into something an <img> tag in the extension can
 * actually load. Mirrors what the web UI does (platform/artwork-thumb.ts):
 * - `/api/image-cache/<key>` → served straight off the server (unauthenticated,
 *   CORS *), with `?v=rail` for the bounded thumbnail variant.
 * - `/api/image-proxy?url=…` (already normalized) → straight off the server.
 * - Any other `http(s)` URL → routed through the server's image proxy
 *   (`/api/image-proxy?url=…&v=rail`, unauthenticated, CORS *). The server
 *   fetches and caches it, so hotlink protection, dead CDNs, and localhost
 *   media-server URLs never touch the browser.
 * - Other relative paths → prefixed with the server origin (best effort).
 * Callers must still handle onerror → placeholder: a 404 from the cache
 * degrades to the placeholder, never a broken-image icon.
 */
export function serverArtwork(cfg: ServerConfig, url: string): string {
  const u = (url || '').trim();
  if (!u) return '';
  const base = cfg.url.replace(/\/+$/, '');
  // The session gates (login / launch PIN) 401 <img> requests, which carry
  // no cookie. Attach the API key so key-authed image URLs pass the gate.
  const key = `api_key=${encodeURIComponent(cfg.apiKey)}`;
  const withKey = (imgUrl: string) =>
    imgUrl + (imgUrl.includes('?') ? '&' : '?') + key;
  if (u.startsWith('/api/image-cache/')) {
    return withKey(base + u + (u.includes('?') ? '' : '?v=rail'));
  }
  if (u.startsWith('/api/image-proxy')) {
    return withKey(base + u);
  }
  if (/^https?:\/\//i.test(u)) {
    return withKey(`${base}/api/image-proxy?url=${encodeURIComponent(u)}&v=rail`);
  }
  if (u.startsWith('//')) {
    const absolute = `https:${u}`;
    return withKey(`${base}/api/image-proxy?url=${encodeURIComponent(absolute)}&v=rail`);
  }
  // Relative paths (e.g. /library/metadata/.../thumb/...) also go through the
  // proxy: a bare same-origin <img> carries no API key and the session gates
  // 401 it, exactly like the absolute case.
  const absolute = base + (u.startsWith('/') ? u : `/${u}`);
  return withKey(`${base}/api/image-proxy?url=${encodeURIComponent(absolute)}&v=rail`);
}

/**
 * Plain artwork resolution without the image proxy: absolute URLs pass
 * through untouched, relative paths are prefixed with the server origin.
 * Used as the fallback when the proxied URL fails (e.g. older server).
 */
export function directArtwork(cfg: ServerConfig, url: string): string {
  const u = (url || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  const base = cfg.url.replace(/\/+$/, '');
  return base + (u.startsWith('/') ? u : `/${u}`);
}
