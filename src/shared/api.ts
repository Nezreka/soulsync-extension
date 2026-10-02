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
  pagination?: { total?: number; page?: number; limit?: number };
}

function baseUrl(cfg: ServerConfig): string {
  return cfg.url.replace(/\/+$/, '');
}

/** Fetch the v1 envelope without unwrapping it; throw on transport or API errors. */
async function apiFetchEnvelope(cfg: ServerConfig, path: string, init: RequestInit = {}): Promise<Envelope> {
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
  return envelope;
}

/** Fetch and unwrap the v1 envelope; throw on transport or API errors. */
async function apiFetch(cfg: ServerConfig, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const envelope = await apiFetchEnvelope(cfg, path, init);
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

/** Wishlist every track of a page-aware release. Each track is resolved via
 *  the server's automatic metadata source (source:'auto'); release.source is
 *  provenance only and never steers the lookup. */
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
    const rec = await lookupLibraryTrackRecord(cfg, provider, id);
    return rec ? true : false;
  } catch {
    return null;
  }
}

/**
 * Well-known release qualifiers stripped for "same song, different release"
 * matching. Conservative: only these exact words/phrases count, so
 * "Song - Live" matches "Song" but "Star" never matches "Starburster".
 */
const VERSION_QUALIFIERS = [
  'remaster', 'remastered', 'remastered version', 'remaster version',
  'single version', 'album version', 'radio edit', 'radio version',
  'extended version', 'extended mix', 'deluxe', 'deluxe edition',
  'deluxe version', 'anniversary edition', 'anniversary', 'reissue',
  'reissued', 'mono', 'stereo', 'live', 'acoustic', 'acoustic version',
  'demo', 'demo version', 'instrumental', 'instrumental version',
  'sped up', 'slowed', 'slowed down', 'nightcore',
];

/**
 * Reduce a track title to its base form for cross-release matching:
 * strips a trailing " - qualifier", " (qualifier)" or " [qualifier]" when the
 * qualifier is a recognized version word. Returns the normalized base title.
 * If nothing strips, returns the normalized title unchanged.
 *
 * Matching happens on the RAW title first: normName strips the
 * parens/brackets/dashes the qualifiers live in, so a normalized-only
 * match can never see them.
 */
function isVersionQualifier(rawQualifier: string): boolean {
  const q = normName(rawQualifier);
  if (VERSION_QUALIFIERS.includes(q)) return true;
  // "2024 remaster", "2011 remastered version" — year + qualifier
  const yearQ = q.match(/^(\d{4})\s+(.+)$/);
  return !!yearQ && VERSION_QUALIFIERS.includes(yearQ[2]);
}

export function baseTitleForMatch(title: string): string {
  let t = title;
  // Spotify soundtrack/compilation attribution: 'Song - From "Album"' /
  // 'Song - From Album'. The library holds "Song" — strip before matching.
  const from = t.match(/^(.*)\s+[-–—]\s+From\s+.+$/i);
  if (from) t = from[1].trim();
  // Featured-artist parentheticals are credits, not the song title:
  // "luther (with sza)" matches library "Luther". Case-insensitive.
  const feat = t.match(/^(.*?)\s*\((?:with|feat\.?|ft\.?|featuring)\s+[^)]+\)$/i);
  if (feat) t = feat[1].trim();
  // trailing " - qualifier" on the raw title
  const dash = t.match(/^(.*)[-–—]\s*([^-–—()\[\]]+)$/);
  if (dash && isVersionQualifier(dash[2])) return normName(dash[1]);
  // trailing "(qualifier)" or "[qualifier]" on the raw title
  const paren = t.match(/^(.*)[\(\[]\s*([^\)\]]+?)\s*[\)\]]$/);
  if (paren && isVersionQualifier(paren[2])) return normName(paren[1]);
  return normName(t);
}

/** Primary artist for matching: strips "feat./ft./featuring/with" credits. */
export function primaryArtistForMatch(artist: string): string {
  return normName(artist)
    .replace(/\s+(feat\.?|ft\.?|featuring|with)\s+.*$/, '')
    .trim();
}

/** Does a library track row represent the same song as the query? */
function libraryRowMatchesSong(
  queryTitle: string, queryArtist: string, row: { title?: string; artist_name?: string },
): boolean {
  const rowTitle = normName(row.title ?? '');
  const rowArtist = primaryArtistForMatch(row.artist_name ?? '');
  const qArtist = primaryArtistForMatch(queryArtist);
  if (!rowTitle || !rowArtist || !qArtist) return false;
  if (rowArtist !== qArtist) return false;
  const qTitle = normName(queryTitle);
  if (rowTitle === qTitle) return true;
  // Same song on a different release: "Song (Remastered)" vs "Song".
  return baseTitleForMatch(row.title ?? '') === baseTitleForMatch(queryTitle)
    && baseTitleForMatch(queryTitle) !== '';
}

/**
 * Smart "is this song in the library" check. A provider-ID-only lookup misses
 * the same song filed under a different release (single vs album version), so:
 *   1. Try the exact provider-ID lookup first (strongest signal).
 *   2. Fall back to the server's library track search by title+artist, then
 *      verify each hit client-side with strict normalized matching to rule
 *      out the server's fuzzy false positives.
 * Tri-state: true = verified in library, false = verified absent after both
 * checks, null = couldn't verify (transport/server/parse failure).
 */
export async function lookupLibraryTrackSmart(
  cfg: ServerConfig,
  provider: string,
  id: string,
  title: string,
  artist: string,
): Promise<boolean | null> {
  // 1. Exact provider-ID lookup — strongest signal.
  let idResult: boolean | null = null;
  if (LOOKUP_PROVIDERS.has(provider) && id) {
    try {
      const rec = await lookupLibraryTrackRecord(cfg, provider, id);
      idResult = rec ? true : false;
    } catch {
      idResult = null;
    }
    if (idResult === true) return true;
  }
  // 2. Title+artist library search with strict client-side verification.
  //    (The server search is fuzzy by design — it finds candidates, not answers.)
  if (!title || !artist) return idResult === false ? false : null;
  try {
    const base = cfg.url.replace(/\/+$/, '');
    const params = new URLSearchParams({
      title: title.slice(0, 200),
      artist: artist.slice(0, 200),
      limit: '25',
    });
    const res = await fetch(`${base}${V1}/library/tracks?${params}`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) return null;
    const envelope = (await res.json().catch(() => null)) as {
      success?: boolean; data?: { tracks?: { title?: string; artist_name?: string }[] };
    } | null;
    if (!envelope || envelope.success === false) return null;
    const tracks = envelope.data?.tracks ?? [];
    const matched = tracks.some((t) => libraryRowMatchesSong(title, artist, t));
    return matched ? true : false;
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

/* ── page badges ── */

export interface BadgeCandidate {
  kind: 'artist' | 'album' | 'track';
  name: string;
  /** album artist, when known — tightens the library match */
  artist?: string;
}

/**
 * Normalize for name comparison: diacritics stripped, case/punctuation
 * folded. Unicode-aware (\\p{L}\\p{N}) so CJK/Korean names don't all
 * collapse to "" and false-match each other.
 */
export function normName(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Session cache: badgeKey -> in-library (true/false). Nulls (unverifiable)
 * are never cached — a transient failure may succeed on the next scan.
 */
const badgeCache = new Map<string, boolean>();

function badgeKey(kind: string, name: string, artist?: string): string {
  return `${kind}:${normName(artist ? `${artist} ${name}` : name)}`;
}

/**
 * Tri-state library checks. `true` = verified in library, `false` = verified
 * absent, `null` = couldn't verify (server error, or an album with no artist
 * to disambiguate it). Callers must surface null as "unknown", never as
 * "not in library".
 */
async function libraryHasArtist(cfg: ServerConfig, name: string): Promise<boolean | null> {
  const key = badgeKey('artist', name);
  const cached = badgeCache.get(key);
  if (cached !== undefined) return cached;
  const want = normName(name);
  if (want.length === 0) return null;
  try {
    const data = await apiFetch(cfg, `${V1}/library/artists?search=${encodeURIComponent(name)}&limit=5`, {
      method: 'GET',
    });
    const artists = data.artists;
    const found =
      Array.isArray(artists) &&
      artists.some((a: unknown) => {
        const n = (a as { name?: unknown }).name;
        return typeof n === 'string' && normName(n) === want;
      });
    badgeCache.set(key, found);
    return found;
  } catch {
    return null;
  }
}

/**
 * Resolve a library artist id for an exact normalized name match.
 * Returns the id, `false` when the artist is absent, `null` on server error.
 */
async function libraryArtistId(cfg: ServerConfig, name: string): Promise<number | false | null> {
  const want = normName(name);
  if (want.length === 0) return null;
  try {
    const data = await apiFetch(cfg, `${V1}/library/artists?search=${encodeURIComponent(name)}&limit=5`, {
      method: 'GET',
    });
    const artists = data.artists;
    if (!Array.isArray(artists)) return null;
    const hit = artists.find((a: unknown) => {
      const n = (a as { name?: unknown }).name;
      return typeof n === 'string' && normName(n) === want;
    }) as { id?: unknown } | undefined;
    const id = hit ? Number(hit.id) : NaN;
    return Number.isFinite(id) ? id : false;
  } catch {
    return null;
  }
}

/**
 * The library album id for an exact title under a library artist id.
 * null = no exact match (or unresolvable) — never throws for "absent",
 * throws on transport errors so callers keep the tri-state.
 */
async function libraryAlbumId(
  cfg: ServerConfig,
  artistId: number,
  title: string,
): Promise<number | null> {
  const wantTitle = normName(title);
  if (wantTitle.length === 0) return null;
  const data = await apiFetch(
    cfg,
    `${V1}/library/albums?search=${encodeURIComponent(title)}&artist_id=${artistId}&limit=10`,
    { method: 'GET' },
  );
  const albums = data.albums;
  if (!Array.isArray(albums)) return null;
  for (const a of albums) {
    const o = a as { title?: unknown; id?: unknown };
    if (typeof o.title === 'string' && normName(o.title) === wantTitle) {
      const id = Number(o.id);
      if (Number.isFinite(id)) return id;
    }
  }
  return null;
}

/**
 * Strict album match, associated through the artist — never title-only.
 * The artist name resolves to a library artist id, then the title must match
 * exactly among THAT artist's albums. A title match under a different artist
 * (ten bands have a "Greatest Hits") is correctly reported absent.
 */
async function libraryHasAlbum(
  cfg: ServerConfig,
  title: string,
  artist?: string,
): Promise<boolean | null> {
  const key = badgeKey('album', title, artist);
  const cached = badgeCache.get(key);
  if (cached !== undefined) return cached;
  const wantTitle = normName(title);
  if (wantTitle.length === 0 || normName(artist ?? '').length === 0) return null;
  try {
    const artistId = await libraryArtistId(cfg, artist as string);
    if (artistId === null) return null; // server error — unknown, not absent
    if (artistId === false) {
      // Artist isn't in the library, so their album can't be either.
      badgeCache.set(key, false);
      return false;
    }
    const found = (await libraryAlbumId(cfg, artistId, title)) !== null;
    badgeCache.set(key, found);
    return found;
  } catch {
    return null;
  }
}

export interface LibraryLink {
  /** Full URL. '' when nothing could be resolved. */
  url: string;
  /** True when the URL lands on the exact entity (not a filtered grid). */
  exact: boolean;
}

/**
 * Deep link into the user's SoulSync for a badge candidate: the artist-detail
 * page, with ?album=<id> when the album can be pinned (the page opens and
 * scrolls to it). Falls back to the filtered library grid; '' when the
 * inputs are empty. Never throws — callers get the fallback, not an error.
 */
export async function resolveLibraryLink(
  cfg: ServerConfig,
  kind: 'artist' | 'album' | 'track',
  name: string,
  artist?: string,
): Promise<LibraryLink> {
  const origin = serverOrigin(cfg);
  const fallback: LibraryLink =
    kind === 'artist'
      ? { url: `${origin}/library?q=${encodeURIComponent(name)}`, exact: false }
      : { url: `${origin}/library?view=albums&q=${encodeURIComponent(name)}`, exact: false };
  if (normName(name).length === 0) return { url: '', exact: false };
  try {
    if (kind === 'artist') {
      const id = await libraryArtistId(cfg, name);
      if (typeof id === 'number')
        return { url: `${origin}/artist-detail/library/${id}`, exact: true };
    } else if (kind === 'album' && artist && normName(artist).length > 0) {
      const artistId = await libraryArtistId(cfg, artist);
      if (typeof artistId === 'number') {
        const albumId = await libraryAlbumId(cfg, artistId, name);
        const base = `${origin}/artist-detail/library/${artistId}`;
        return albumId !== null
          ? { url: `${base}?album=${albumId}`, exact: true }
          : { url: base, exact: false };
      }
    } else if (kind === 'track' && artist && normName(artist).length > 0) {
      const rec = await resolveLibraryTrackRecord(cfg, artist, name);
      if (rec && typeof rec.artist_id === 'number') {
        const base = `${origin}/artist-detail/library/${rec.artist_id}`;
        return {
          url: typeof rec.album_id === 'number' ? `${base}?album=${rec.album_id}` : base,
          exact: true,
        };
      }
      const artistId = await libraryArtistId(cfg, artist);
      if (typeof artistId === 'number')
        return { url: `${origin}/artist-detail/library/${artistId}`, exact: false };
    }
  } catch {
    /* fall through to the filtered grid */
  }
  return fallback;
}

/**
 * The library track row for bare "artist - title" metadata: resolved through
 * the server's own search, then the best hit's provider id. null when
 * unresolvable. Throws on transport errors (unknown, never false "absent").
 */
async function resolveLibraryTrackRecord(
  cfg: ServerConfig,
  artist: string,
  title: string,
): Promise<LibraryTrackRecord | null> {
  const { tracks: hits, source } = await searchTracks(cfg, `${artist} - ${title}`, 5);
  const best = pickBest(hits, { artist, title });
  if (!best || !best.id) return null;
  return lookupLibraryTrackRecord(cfg, source, best.id);
}

/** Batch library check for badge candidates. Tri-state per item: true =
 *  in library, false = verified absent, null = couldn't verify. Never
 *  throws — item errors surface as null, never as a false "not in library".
 *  Track candidates are resolved through the server's own search first
 *  (YouTube gives no provider track id); an unresolvable track is null,
 *  never a false "not in library". */
export async function lookupBadgeStatuses(
  cfg: ServerConfig,
  items: BadgeCandidate[],
): Promise<Record<string, boolean | null>> {
  const out: Record<string, boolean | null> = {};
  await Promise.all(
    items.map(async (it) => {
      const key = badgeKey(it.kind, it.name, it.artist);
      out[key] =
        it.kind === 'artist'
          ? await libraryHasArtist(cfg, it.name)
          : it.kind === 'track'
            ? await libraryHasTrack(cfg, it.name, it.artist ?? '')
            : await libraryHasAlbum(cfg, it.name, it.artist);
    }),
  );
  return out;
}

/**
 * Is "artist - title" in the library? Resolves the bare metadata through
 * the server's own track search, then checks the best hit's provider id —
 * the same two calls the popup's per-row library state uses. Tri-state:
 * true = the resolved track is in the library, false = resolved but
 * absent, null = couldn't resolve or couldn't check.
 */
async function libraryHasTrack(
  cfg: ServerConfig,
  title: string,
  artist: string,
): Promise<boolean | null> {
  const key = badgeKey('track', title, artist);
  const cached = badgeCache.get(key);
  if (cached !== undefined) return cached;
  if (normName(title).length === 0 || normName(artist).length === 0) return null;
  try {
    const { tracks: hits, source } = await searchTracks(cfg, `${artist} - ${title}`, 5);
    const best = pickBest(hits, { artist, title });
    // Smart check: exact provider-ID first, then title+artist library search.
    // Catches the same song filed under a different release (single vs album).
    const inLibrary = await lookupLibraryTrackSmart(
      cfg,
      source,
      best?.id ?? '',
      title,
      artist,
    );
    if (inLibrary === null) return null;
    badgeCache.set(key, inLibrary);
    return inLibrary;
  } catch {
    return null;
  }
}

export interface ArtistHit {
  id: string;
  name: string;
  image: string;
  /** Provider the hit came from ("spotify", "deezer", …) — the search
   *  response names it; watchlist/add needs it for numeric ids. */
  source: string;
}

/** A library track row as returned by /api/v1/library/lookup (subset we use). */
export interface LibraryTrackRecord {
  id: number;
  album_id: number | null;
  artist_id: number | null;
  title: string;
}

/**
 * The library track row for a provider track id. null = not in the library
 * (404 or unparseable); THROWS on transport/server errors so callers can keep
 * the tri-state (unknown, never a false "absent").
 */
export async function lookupLibraryTrackRecord(
  cfg: ServerConfig,
  provider: string,
  id: string,
): Promise<LibraryTrackRecord | null> {
  if (!LOOKUP_PROVIDERS.has(provider) || !id) return null;
  const url =
    `${cfg.url.replace(/\/+$/, '')}${V1}/library/lookup?type=track` +
    `&provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`library lookup failed: ${res.status}`);
  const envelope = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: { track?: Record<string, unknown> };
  };
  const t = envelope.success === true ? envelope.data?.track : undefined;
  if (!t || typeof t.id !== 'number') return null;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    id: t.id,
    album_id: num(t.album_id),
    artist_id: num(t.artist_id),
    title: typeof t.title === 'string' ? t.title : '',
  };
}

/** POST /api/v1/search/artists — resolve a page artist name to a provider id. */
export async function searchArtists(cfg: ServerConfig, query: string, limit = 5): Promise<ArtistHit[]> {
  const data = await apiFetch(cfg, `${V1}/search/artists`, {
    method: 'POST',
    body: JSON.stringify({ query, source: 'auto', limit }),
  });
  const artists = data.artists;
  const source = typeof data.source === 'string' ? data.source : '';
  if (!Array.isArray(artists)) return [];
  return artists
    .map((a: unknown) => {
      const o = a as Record<string, unknown>;
      return {
        id: o.id === undefined || o.id === null ? '' : String(o.id),
        name: typeof o.name === 'string' ? o.name : '',
        image: typeof o.image_url === 'string' ? o.image_url : '',
        source,
      };
    })
    .filter((h) => h.id.length > 0 && h.name.length > 0);
}

/** Best artist hit for a page name: exact normalized match, else top hit. */
export function pickBestArtist(hits: ArtistHit[], wantName: string): ArtistHit | null {
  if (hits.length === 0) return null;
  const w = normName(wantName);
  return hits.find((h) => normName(h.name) === w) ?? hits[0];
}

/**
 * POST /api/watchlist/add — non-v1 route, so the key rides as ?api_key=
 * (honored since server PR #1380). The provider `source` is sent when known:
 * numeric Deezer/iTunes ids are ambiguous without it and the server refuses
 * to guess. Throws with the server's message on error.
 */
export async function watchArtist(
  cfg: ServerConfig,
  artistId: string,
  artistName: string,
  source?: string,
): Promise<void> {
  const base = cfg.url.replace(/\/+$/, '');
  const url = `${base}/api/watchlist/add?api_key=${encodeURIComponent(cfg.apiKey)}`;
  const body: Record<string, string> = { artist_id: artistId, artist_name: artistName };
  if (source) body.source = source;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: unknown };
  if (!res.ok || data.success === false) {
    throw new Error(typeof data.error === 'string' && data.error ? data.error : `Server returned ${res.status}`);
  }
}

/**
 * POST /api/watchlist/remove — non-v1 route, so the key rides as ?api_key=.
 * Body is {artist_id}. Throws with the server's message on error.
 */
export async function unwatchArtist(cfg: ServerConfig, artistId: string): Promise<void> {
  const base = cfg.url.replace(/\/+$/, '');
  const url = `${base}/api/watchlist/remove?api_key=${encodeURIComponent(cfg.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artist_id: artistId }),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: unknown };
  if (!res.ok || data.success === false) {
    throw new Error(typeof data.error === 'string' && data.error ? data.error : `Server returned ${res.status}`);
  }
}

/**
 * POST /api/watchlist/check — non-v1 route, so the key rides as ?api_key=.
 * Returns true when the artist is on the watchlist, false when not, and
 * null when the check itself failed — never claim "not watching" on error.
 */
export async function checkWatchlist(
  cfg: ServerConfig,
  artistId: string,
): Promise<boolean | null> {
  const base = cfg.url.replace(/\/+$/, '');
  const url = `${base}/api/watchlist/check?api_key=${encodeURIComponent(cfg.apiKey)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist_id: artistId }),
    });
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      is_watching?: unknown;
      error?: unknown;
    } | null;
    // Malformed JSON = couldn't verify. Never claim "not watching" on a
    // parse failure.
    if (data === null) return null;
    if (!res.ok || data.success === false) return null;
    // The real /api/watchlist/check returns is_watching TOP-LEVEL
    // ({"success": true, "is_watching": bool}) — this is what SoulSync's own
    // watchlist button reads (webui -artist-detail.watchlist-button.ts).
    return data.is_watching === true;
  } catch {
    return null;
  }
}

/** Server origin for the popover's "Open in SoulSync" link. */
export function serverOrigin(cfg: ServerConfig): string {
  return cfg.url.replace(/\/+$/, '');
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
  // The server's envelope puts the total in `pagination.total`, not in `data`
  // — apiFetch() unwraps only `data`, so read the full envelope here.
  const envelope = await apiFetchEnvelope(cfg, `${V1}/wishlist?limit=1`, { method: 'GET' });
  const total = envelope.pagination?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
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

/* ── mirrored playlists (save-playlist) ── */

/** Playlist sources the mirror endpoints accept. */
export type PlaylistSource = 'spotify' | 'deezer';

export interface SpotifyPlaylistTrack {
  id: string;
  name: string;
  artists?: { name?: string }[];
  album?: { name?: string; images?: { url?: string }[] };
  duration_ms?: number;
  spotify_track_id?: string;
}

export interface DeezerPlaylistTrack {
  id: string | number;
  name: string;
  /** Deezer gives bare name strings, not {name} objects. */
  artists?: string[];
  /** Deezer gives the album as a bare string. */
  album?: string;
  album_cover_url?: string;
  duration_ms?: number;
}

export interface PlaylistDetail<T = SpotifyPlaylistTrack | DeezerPlaylistTrack> {
  id: string;
  name: string;
  description: string;
  owner: string;
  track_count: number;
  image_url: string;
  tracks: T[];
}

export interface MirrorTrack {
  track_name: string;
  artist_name: string;
  album_name: string;
  duration_ms: number;
  image_url: string | null;
  source_track_id: string;
  extra_data: null;
}

export interface MirrorPlaylistPayload {
  source: PlaylistSource;
  source_playlist_id: string;
  name: string;
  description: string;
  owner: string;
  image_url: string;
  tracks: MirrorTrack[];
}

/**
 * Non-v1 routes ride the key as ?api_key= (see watchArtist — honored since
 * server PR #1380). These endpoints answer plain JSON ({error: "..."} as a
 * string on failure), not the v1 envelope. Throws the server's message.
 */
export async function nonV1Fetch(
  cfg: ServerConfig,
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const base = cfg.url.replace(/\/+$/, '');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${base}${path}${sep}api_key=${encodeURIComponent(cfg.apiKey)}`;
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = data.error;
    throw new Error(typeof err === 'string' && err ? err : `Server returned ${res.status}`);
  }
  // A 2xx can still carry an API-level failure ({success: false, error} or
  // {error}) — never treat it as success.
  const err = data.error;
  if (typeof err === 'string' && err) throw new Error(err);
  if (data.success === false) throw new Error(typeof err === 'string' && err ? err : 'Request failed');
  return data;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function ownerName(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.display_name === 'string') return o.display_name;
    if (typeof o.name === 'string') return o.name;
  }
  return '';
}

function normalizeSpotifyPlaylist(data: Record<string, unknown>): PlaylistDetail<SpotifyPlaylistTrack> {
  const raw = Array.isArray(data.tracks) ? data.tracks : [];
  return {
    // Deezer IDs arrive numeric from the real API — normalize to string.
    id: data.id === undefined || data.id === null ? '' : String(data.id),
    name: str(data.name),
    description: str(data.description),
    owner: ownerName(data.owner),
    track_count: num(data.track_count),
    image_url: str(data.image_url),
    tracks: raw.map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const artists = Array.isArray(o.artists) ? o.artists : [];
      const album = (o.album ?? {}) as Record<string, unknown>;
      const images = Array.isArray(album.images) ? album.images : [];
      return {
        id: str(o.id),
        name: str(o.name),
        artists: artists.map((a) => ({
          name: str((a as { name?: unknown } | null)?.name),
        })),
        album: {
          name: str(album.name),
          images: images.map((im) => ({ url: str((im as { url?: unknown } | null)?.url) })),
        },
        duration_ms: num(o.duration_ms),
        spotify_track_id:
          typeof o.spotify_track_id === 'string' ? o.spotify_track_id : undefined,
      };
    }),
  };
}

function normalizeDeezerPlaylist(data: Record<string, unknown>): PlaylistDetail<DeezerPlaylistTrack> {
  const raw = Array.isArray(data.tracks) ? data.tracks : [];
  return {
    // Deezer IDs arrive numeric from the real API — normalize to string.
    id: data.id === undefined || data.id === null ? '' : String(data.id),
    name: str(data.name),
    description: str(data.description),
    owner: ownerName(data.owner),
    track_count: num(data.track_count),
    image_url: str(data.image_url),
    tracks: raw.map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const artists = Array.isArray(o.artists) ? o.artists : [];
      return {
        id: typeof o.id === 'string' || typeof o.id === 'number' ? o.id : '',
        name: str(o.name),
        artists: artists.map((a) =>
          typeof a === 'string' ? a : str((a as { name?: unknown } | null)?.name),
        ),
        album: str(o.album),
        album_cover_url:
          typeof o.album_cover_url === 'string' ? o.album_cover_url : undefined,
        duration_ms: num(o.duration_ms),
      };
    }),
  };
}

/**
 * Is this provider playlist already mirrored on the server?
 * → {found: true, playlist} or {found: false, playlist: null}.
 */
export async function resolveMirroredPlaylist(
  cfg: ServerConfig,
  source: PlaylistSource,
  ref: string,
): Promise<{ found: boolean; playlist: Record<string, unknown> | null }> {
  const data = await nonV1Fetch(
    cfg,
    `/api/mirrored-playlists/resolve?ref=${encodeURIComponent(ref)}&source=${encodeURIComponent(source)}`,
  );
  return {
    found: data.found === true,
    playlist: (data.playlist as Record<string, unknown> | null) ?? null,
  };
}

/**
 * Full Spotify playlist with tracks (the server proxies its own Spotify
 * connection). 401 {"error": "Spotify not authenticated."} when the server's
 * Spotify isn't linked — the message passes through honestly; the caller
 * maps it to the "connect Spotify first" guidance.
 */
export async function getSpotifyPlaylistTracks(
  cfg: ServerConfig,
  id: string,
): Promise<PlaylistDetail<SpotifyPlaylistTrack>> {
  const data = await nonV1Fetch(cfg, `/api/spotify/playlist/${encodeURIComponent(id)}`);
  return normalizeSpotifyPlaylist(data);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Full Deezer playlist with tracks. Public Deezer data — no server auth
 * needed. Sync first; when the server 202s (large playlist), fall back to
 * the async job (?async=1 → {job_id}, poll /api/deezer/playlist-load/<job_id>).
 */
export async function getDeezerPlaylistTracks(
  cfg: ServerConfig,
  id: string,
): Promise<PlaylistDetail<DeezerPlaylistTrack>> {
  const base = cfg.url.replace(/\/+$/, '');
  const key = `api_key=${encodeURIComponent(cfg.apiKey)}`;
  const url = (extra: string) =>
    `${base}/api/deezer/playlist/${encodeURIComponent(id)}${extra}${extra.includes('?') ? '&' : '?'}${key}`;
  const readJson = async (res: Response): Promise<Record<string, unknown>> =>
    (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const throwFor = (res: Response, data: Record<string, unknown>): never => {
    const err = data.error;
    throw new Error(typeof err === 'string' && err ? err : `Server returned ${res.status}`);
  };

  const first = await fetch(url(''));
  if (first.status !== 202) {
    const data = await readJson(first);
    if (!first.ok) throwFor(first, data);
    return normalizeDeezerPlaylist(data);
  }
  // Large playlist: the sync call 202'd. Start the async job…
  let job = await readJson(first);
  let jobId = typeof job.job_id === 'string' ? job.job_id : '';
  if (!jobId) {
    const started = await fetch(url('?async=1'));
    job = await readJson(started);
    jobId = typeof job.job_id === 'string' ? job.job_id : '';
  }
  if (!jobId) throw new Error('The server accepted the playlist but gave no job to follow.');
  // …and poll until it lands.
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const pr = await fetch(`${base}/api/deezer/playlist-load/${encodeURIComponent(jobId)}?${key}`);
    if (pr.status === 202) continue;
    const pd = await readJson(pr);
    if (!pr.ok) throwFor(pr, pd);
    if (pd.status === 'error') {
      const err = pd.error;
      throw new Error(typeof err === 'string' && err ? err : 'Playlist load failed.');
    }
    const pl = (pd.playlist ?? pd) as Record<string, unknown>;
    if (pd.status === 'done' || Array.isArray(pl.tracks)) return normalizeDeezerPlaylist(pl);
  }
  throw new Error('Timed out waiting for the playlist tracks to load.');
}

/** Spotify track → the mirror endpoint's track shape. */
export function spotifyPlaylistTrackToMirror(t: SpotifyPlaylistTrack): MirrorTrack {
  return {
    track_name: t.name ?? '',
    artist_name: t.artists?.[0]?.name ?? '',
    album_name: t.album?.name ?? '',
    duration_ms: t.duration_ms ?? 0,
    image_url: t.album?.images?.[0]?.url ?? null,
    source_track_id: t.spotify_track_id || t.id,
    extra_data: null,
  };
}

/** Deezer track → the mirror endpoint's track shape. */
export function deezerPlaylistTrackToMirror(t: DeezerPlaylistTrack): MirrorTrack {
  return {
    track_name: t.name ?? '',
    artist_name: t.artists?.[0] ?? '',
    album_name: t.album ?? '',
    duration_ms: t.duration_ms ?? 0,
    image_url: t.album_cover_url ?? null,
    source_track_id: String(t.id ?? ''),
    extra_data: null,
  };
}

/**
 * POST /api/mirror-playlist — mirrors the provider playlist on the server.
 * → the server's mirrored playlist id.
 */
export async function mirrorPlaylist(
  cfg: ServerConfig,
  payload: MirrorPlaylistPayload,
): Promise<number> {
  const data = await nonV1Fetch(cfg, '/api/mirror-playlist', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const id = Number(data.playlist_id);
  if (!Number.isFinite(id)) {
    const err = data.error;
    throw new Error(typeof err === 'string' && err ? err : 'The server did not return a playlist id.');
  }
  return id;
}

/** POST /api/mirrored-playlists/<id>/prepare-discovery — kicks off discovery. */
export async function preparePlaylistDiscovery(cfg: ServerConfig, mirroredId: number): Promise<void> {
  await nonV1Fetch(cfg, `/api/mirrored-playlists/${mirroredId}/prepare-discovery`, {
    method: 'POST',
  });
}

/** Storage key for the page-badges master switch (popup toggle). */
export const BADGES_ENABLED_KEY = 'soulsync_badges_enabled';

/**
 * Resolve the badge switch from a `storage.local.get()` result.
 * Default is ON — badges are the core feature; only an explicit `false`
 * disables them. Anything else (unset, true, junk) means enabled.
 */
export function badgesEnabledFromStored(stored: unknown): boolean {
  if (stored !== null && typeof stored === 'object' && BADGES_ENABLED_KEY in stored) {
    return (stored as Record<string, unknown>)[BADGES_ENABLED_KEY] !== false;
  }
  return true;
}
