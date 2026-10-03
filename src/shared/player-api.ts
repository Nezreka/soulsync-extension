import type { ServerConfig } from './types.js';

/**
 * Player server API — library listing and stream URL builders for the
 * in-extension player (docs/player-spec.md §3).
 *
 * Verified server contracts (SoulSync dev, Oct 2026) — DO NOT redesign:
 * - GET /api/v1/library/tracks?title=&artist=&limit=&fields=&api_key= →
 *   {success, data: {tracks: [serialize_track]}} (require_api_key).
 * - GET /api/v1/library/albums/<album_id>/tracks?api_key= → {tracks: [...]}.
 * - GET /stream/library-audio?path=<file_path>&api_key= → 206 partial
 *   content with Accept-Ranges; optional &track_id= engages the
 *   Navidrome/Subsonic proxy fallback. NOT /stream/audio or
 *   /api/stream/start (Flask-session keyed — the extension has no session).
 * - GET /api/video/watch/playable?kd=m|t&id=<tmdb_id>[&s=&e=]&api_key= →
 *   {playable, verdict: "yes"|"maybe"|"no", reasons[]} — bare JSON, no v1
 *   envelope. Call before every video playback and honor it.
 * - GET /api/video/watch/stream?kd=&id=[&s=&e=]&api_key= → 206, local file
 *   or proxied media server with Range forwarded both ways.
 * - ?api_key= bypasses the login and launch-PIN gates and stamps admin
 *   request context (api/auth.py). Media elements can't set headers, so
 *   every stream URL carries the key as a query param.
 *
 * Auth for JSON calls follows src/shared/api.ts: Authorization: Bearer <key>
 * with the {success, data} envelope unwrapped (envelope's message on error).
 */

/* ── local fetch helpers (api.ts's are module-private; mirror them here) ── */

const V1 = '/api/v1';

function baseUrl(cfg: ServerConfig): string {
  return cfg.url.replace(/\/+$/, '');
}

interface Envelope {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string } | string;
}

/** Fetch a v1 route and unwrap the {success, data} envelope; throw on error. */
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

/* ── types ── */

/** One music-library track as the player sees it. */
export interface LibraryTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  /** Library artist id (for artist radio from search results). */
  artistId: number | null;
  /** Library album id (for album play from search results). */
  albumId: number | null;
  /** Server-side path used as the stream's ?path= param. */
  filePath: string;
  /** Track length in seconds (server stores ms); null when unknown. */
  durationSec: number | null;
  /** Null: serialize_track carries no artwork field — don't guess a URL. */
  artworkUrl: string | null;
}

/**
 * The server's direct-play verdict for a video copy.
 * Never trust a codec table in the extension — the server owns the truth
 * (core/video/direct_play.py); always call checkVideoPlayable first.
 */
export interface PlayableVerdict {
  playable: boolean;
  verdict: 'yes' | 'maybe' | 'no';
  reasons: string[];
}

/** Media-query entry for a video copy: 'm' = movie, 't' = TV episode. */
export interface VideoEntry {
  videoKd: 'm' | 't';
  /** TMDB id. */
  videoId: number;
  /** Season/episode — required when videoKd is 't'. */
  season?: number;
  episode?: number;
}

/**
 * Minimal structural stand-in for the player-core QueueEntry
 * (src/player/types.ts, owned by the player-core workstream). Structural
 * typing means the player can consume these without any import coupling.
 */
export interface PlayerQueueEntry {
  kind: 'audio' | 'video';
  title: string;
  subtitle: string;
  artworkUrl?: string;
  audioPath?: string;
  trackId?: number;
  videoKd?: 'm' | 't';
  videoId?: number;
  season?: number;
  episode?: number;
  durationSec?: number;
}

/* ── library listing ── */

/**
 * Map one serialize_track row to a LibraryTrack, defensively.
 *
 * Field grounding (api/serializers.py::serialize_track, verified Oct 2 2026):
 * - `id`            → LibraryTrack.id (number)
 * - `title`         → LibraryTrack.title
 * - `file_path`     → LibraryTrack.filePath
 * - `duration`      → LibraryTrack.durationSec, /1000 — the tracks table
 *                     stores duration INTEGER in **milliseconds**
 *                     (database/music_database.py), so the seconds value is
 *                     derived, not copied.
 * - `artist_name`   → LibraryTrack.artist (extra key preserved by
 *                     serialize_track only when the query joins the artist
 *                     table — this endpoint's search does; falls back to a
 *                     nested `artist` object/string if present).
 * - `album_title`   → LibraryTrack.album (same join caveat, same fallbacks).
 * - artwork: serialize_track has NO artwork field (no thumb_url, no image
 *   key) → artworkUrl is always null here. Do not guess a URL.
 */
export function mapLibraryTrack(raw: unknown): LibraryTrack {
  const o = (raw ?? {}) as Record<string, unknown>;

  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  // artist: prefer the join extra, then nested object, then bare string.
  let artist = str(o.artist_name);
  if (!artist) {
    const a = o.artist;
    artist = typeof a === 'object' && a !== null ? str((a as Record<string, unknown>).name) : str(a);
  }
  let album = str(o.album_title);
  if (!album) {
    const a = o.album;
    album = typeof a === 'object' && a !== null ? str((a as Record<string, unknown>).name) : str(a);
  }

  const durationMs = num(o.duration);
  return {
    id: num(o.id) ?? 0,
    title: str(o.title),
    artist,
    album,
    artistId: num(o.artist_id),
    albumId: num(o.album_id),
    filePath: str(o.file_path),
    durationSec:
      durationMs !== null && durationMs >= 0 ? Math.round(durationMs / 1000) : null,
    artworkUrl: null,
  };
}

export interface LibraryTrackSearch {
  title: string;
  artist: string;
  limit?: number;
}

/**
 * Search the music library by title/artist.
 *
 * Contract: GET /api/v1/library/tracks?title=&artist=&limit=&fields=
 * (api/library.py::library_search_tracks, require_api_key). Bearer header
 * per api.ts convention; envelope unwrapped; fields= asks for exactly the
 * columns the player needs so the payload stays small.
 */
export async function searchLibraryTracks(
  cfg: ServerConfig,
  { title, artist, limit = 50 }: LibraryTrackSearch,
): Promise<LibraryTrack[]> {
  const params = new URLSearchParams({
    title: title.slice(0, 200),
    artist: artist.slice(0, 200),
    limit: String(Math.min(200, Math.max(1, limit))),
    fields: 'id,title,artist_name,artist_id,album_title,album_id,file_path,duration',
  });
  const data = await apiFetch(cfg, `${V1}/library/tracks?${params}`, { method: 'GET' });
  const tracks = data.tracks;
  if (!Array.isArray(tracks)) return [];
  return tracks.map(mapLibraryTrack);
}

/**
 * List the tracks of a library album.
 *
 * Contract: GET /api/v1/library/albums/<album_id>/tracks
 * (api/library.py::get_album_tracks, require_api_key) → {tracks: [...]}.
 */
export async function getAlbumTracks(cfg: ServerConfig, albumId: number): Promise<LibraryTrack[]> {
  const data = await apiFetch(
    cfg,
    `${V1}/library/albums/${encodeURIComponent(String(albumId))}/tracks`,
    { method: 'GET' },
  );
  const tracks = data.tracks;
  if (!Array.isArray(tracks)) return [];
  return tracks.map(mapLibraryTrack);
}

export interface LibraryAlbum {
  id: number;
  title: string;
  artist?: string;
  year?: number | null;
  thumbUrl?: string | null;
}

/**
 * Search library albums by title/artist.
 *
 * Contract: GET /api/v1/library/albums?search=<q>
 * (api/library.py::list_library_albums, require_api_key) → {albums: [...]}.
 */
export async function searchLibraryAlbums(
  cfg: ServerConfig,
  query: string,
  limit = 10,
): Promise<LibraryAlbum[]> {
  const params = new URLSearchParams({
    search: query.slice(0, 200),
    limit: String(Math.min(50, Math.max(1, limit))),
    fields: 'id,title,artist_name,year,thumb_url',
  });
  const data = await apiFetch(cfg, `${V1}/library/albums?${params}`, { method: 'GET' });
  const albums = data.albums;
  if (!Array.isArray(albums)) return [];
  return albums.map((raw: unknown) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    return {
      id: num(o.id) ?? 0,
      title: str(o.title),
      artist: str(o.artist_name),
      year: num(o.year),
      thumbUrl: str(o.thumb_url) || null,
    };
  });
}

export interface LibraryArtist {
  id: number;
  name: string;
}

/**
 * Find library artists by name.
 *
 * Contract: GET /api/v1/library/artists?search=<q>&limit=<n>
 * (api/library.py::list_artists, require_api_key) → {artists: [{id, name, …}]}.
 */
export async function searchLibraryArtists(
  cfg: ServerConfig,
  name: string,
  limit = 5,
): Promise<LibraryArtist[]> {
  const params = new URLSearchParams({
    search: name.slice(0, 200),
    limit: String(Math.min(50, Math.max(1, limit))),
  });
  const data = await apiFetch(cfg, `${V1}/library/artists?${params}`, { method: 'GET' });
  const artists = data.artists;
  if (!Array.isArray(artists)) return [];
  const out: LibraryArtist[] = [];
  for (const a of artists) {
    const o = (a ?? {}) as Record<string, unknown>;
    const idNum = typeof o.id === 'number' ? o.id : typeof o.id === 'string' ? parseInt(o.id, 10) : NaN;
    if (!Number.isFinite(idNum) || typeof o.name !== 'string') continue;
    out.push({ id: idNum, name: o.name });
  }
  return out;
}

export interface LibraryAlbum {
  id: number;
  title: string;
}

/**
 * Albums for a library artist.
 *
 * Contract: GET /api/v1/library/artists/<artist_id>/albums
 * (api/library.py::get_artist_albums, require_api_key) → {albums: [{id, title, …}]}.
 */
export async function getArtistAlbums(cfg: ServerConfig, artistId: number): Promise<LibraryAlbum[]> {
  const data = await apiFetch(
    cfg,
    `${V1}/library/artists/${encodeURIComponent(String(artistId))}/albums`,
    { method: 'GET' },
  );
  const albums = data.albums;
  if (!Array.isArray(albums)) return [];
  const out: LibraryAlbum[] = [];
  for (const a of albums) {
    const o = (a ?? {}) as Record<string, unknown>;
    const idNum = typeof o.id === 'number' ? o.id : typeof o.id === 'string' ? parseInt(o.id, 10) : NaN;
    if (!Number.isFinite(idNum) || typeof o.title !== 'string') continue;
    out.push({ id: idNum, title: o.title });
  }
  return out;
}

/* ── stream URL builders ── */

/** The key as a query param for media elements (they can't set headers). */
function keyParam(cfg: ServerConfig): string {
  return `api_key=${encodeURIComponent(cfg.apiKey)}`;
}

export interface AudioStreamEntry {
  audioPath?: string;
  /** Server library track id — engages the Navidrome/Subsonic proxy fallback. */
  trackId?: number;
}

/**
 * Build the <audio> source URL for a library track.
 *
 * Contract: GET /stream/library-audio?path=<file_path>&api_key=
 * (web_server.py::stream_library_audio) → 206 partial content,
 * Accept-Ranges: bytes. Optional &track_id= engages the Navidrome/Subsonic
 * proxy fallback (Range forwarded upstream) when the file isn't on disk.
 * Throws when there is no path to stream — a track with no file_path
 * cannot produce a URL.
 */
export function libraryAudioUrl(cfg: ServerConfig, entry: AudioStreamEntry): string {
  if (!entry.audioPath) {
    throw new Error('Cannot stream audio: the track has no file path.');
  }
  const base = `${baseUrl(cfg)}/stream/library-audio?path=${encodeURIComponent(entry.audioPath)}&${keyParam(cfg)}`;
  return entry.trackId !== undefined ? `${base}&track_id=${encodeURIComponent(String(entry.trackId))}` : base;
}

/** Shared query builder for the two /api/video/watch/* endpoints. */
function videoWatchQuery(entry: VideoEntry, cfg: ServerConfig): string {
  const params = new URLSearchParams({
    kd: entry.videoKd,
    id: String(entry.videoId),
    api_key: cfg.apiKey,
  });
  // Episodes ride as ?s=&e= (season/episode) — movies omit them.
  if (entry.videoKd === 't') {
    if (entry.season !== undefined) params.set('s', String(entry.season));
    if (entry.episode !== undefined) params.set('e', String(entry.episode));
  }
  return params.toString();
}

/**
 * Build the playable-verdict URL for a video copy.
 *
 * Contract: GET /api/video/watch/playable?kd=m|t&id=<tmdb_id>[&s=&e=]&api_key=
 * (api/video/watch.py::video_watch_playable) → {playable, verdict, reasons}.
 * Always call before playback and honor the verdict.
 */
export function videoPlayableUrl(cfg: ServerConfig, entry: VideoEntry): string {
  return `${baseUrl(cfg)}/api/video/watch/playable?${videoWatchQuery(entry, cfg)}`;
}

/**
 * Build the <video> source URL for a video copy.
 *
 * Contract: GET /api/video/watch/stream?kd=m|t&id=<tmdb_id>[&s=&e=]&api_key=
 * (api/video/watch.py::video_watch_stream) → 206 ranges; serves the local
 * file or proxies the media server with Range forwarded both ways and the
 * upstream token never exposed.
 */
export function videoStreamUrl(cfg: ServerConfig, entry: VideoEntry): string {
  return `${baseUrl(cfg)}/api/video/watch/stream?${videoWatchQuery(entry, cfg)}`;
}

/* ── playable verdict ── */

const VERDICTS = new Set(['yes', 'maybe', 'no']);
const NO_VERDICT: PlayableVerdict = {
  playable: false,
  verdict: 'no',
  reasons: ['The server gave no verdict'],
};

/**
 * Ask the server whether a video copy is browser-playable and parse the
 * verdict defensively.
 *
 * Contract: /api/video/watch/playable returns BARE JSON
 * {playable, verdict, reasons} (watch.py jsonify — NOT the v1 envelope).
 * Missing/unparseable fields degrade to {playable: false, verdict: 'no',
 * reasons: ['The server gave no verdict']} — never claim playable on a
 * malformed response. Verdicts outside yes|maybe|no are treated as 'no'.
 * Call before every playback (spec §6: verdict === 'no' must surface the
 * reason honestly, never a silent black rectangle).
 */
export async function checkVideoPlayable(cfg: ServerConfig, entry: VideoEntry): Promise<PlayableVerdict> {
  let body: unknown;
  try {
    const res = await fetch(videoPlayableUrl(cfg, entry));
    body = await res.json().catch(() => null);
    if (!res.ok && (body === null || typeof body !== 'object')) {
      return { ...NO_VERDICT, reasons: [`The server refused the playable check (${res.status})`] };
    }
  } catch {
    return { ...NO_VERDICT, reasons: ['The playable check could not reach the server'] };
  }
  if (body === null || typeof body !== 'object') return { ...NO_VERDICT };
  const o = body as Record<string, unknown>;
  const verdict = typeof o.verdict === 'string' && VERDICTS.has(o.verdict)
    ? (o.verdict as 'yes' | 'maybe' | 'no')
    : 'no';
  const reasons = Array.isArray(o.reasons) && o.reasons.every((r) => typeof r === 'string')
    ? (o.reasons as string[])
    : verdict === 'no'
      ? NO_VERDICT.reasons
      : [];
  return {
    playable: o.playable === true && verdict !== 'no',
    verdict,
    reasons,
  };
}

/* ── helpers ── */

/**
 * True for formats the browser cannot decode. Spec §3: the server serves
 * wma, but no browser decodes it — filter WMA out of queues or warn first.
 * Case-insensitive match on the file extension.
 */
export function isUnplayableAudio(path: string): boolean {
  return /\.wma$/i.test((path || '').trim());
}

/**
 * Convert a LibraryTrack to the player-core QueueEntry shape (structural —
 * no import from src/player/, keeping the dependency one-way).
 * Spec §4 queue entry: {kind, title, subtitle, artworkUrl?, audioPath?,
 * trackId?, …, duration?}.
 */
export function toQueueEntry(track: LibraryTrack): PlayerQueueEntry {
  const entry: PlayerQueueEntry = {
    kind: 'audio',
    title: track.title,
    subtitle: track.artist,
    audioPath: track.filePath,
    trackId: track.id,
  };
  if (track.artworkUrl !== null) entry.artworkUrl = track.artworkUrl;
  if (track.durationSec !== null) entry.durationSec = track.durationSec;
  return entry;
}

/* ── video library listing ── */

/**
 * One Movies/Episodes row for the Media tab's library search.
 *
 * `tmdbId` is the id every /api/video/watch/* endpoint understands
 * (bare TMDB id of the movie, or of the SHOW for episodes — episodes ride
 * as ?s=&e= alongside the show's id). A row without a TMDB id cannot be
 * streamed or playable-checked, so the listing functions drop those.
 */
export interface VideoLibraryEntry {
  tmdbId: number;
  kind: 'm' | 't';
  title: string;
  /** Movie: release year. Episode: "Show title · S01E02". */
  subtitle: string;
  /** Required when kind === 't'. */
  season?: number;
  episode?: number;
  /** Same-origin poster/still proxy URL (already carries ?api_key=). */
  artworkUrl?: string;
}

/**
 * GET on a bare-JSON /api/video/* route.
 *
 * Unlike /api/v1, the video blueprint returns BARE JSON — e.g.
 * GET /api/video/library → {items, pagination} (api/video/library.py) —
 * so this does NOT unwrap the {success, data} envelope. Bearer auth per
 * the api.ts convention; throws on non-ok like apiFetch.
 */
async function videoApiFetch(cfg: ServerConfig, path: string): Promise<unknown> {
  const res = await fetch(baseUrl(cfg) + path, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err =
      body !== null &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as { error?: unknown }).error === 'string'
        ? ((body as { error: string }).error as string)
        : `Server returned ${res.status}`;
    throw new Error(err);
  }
  return body;
}

/**
 * Build the same-origin artwork URL for a library movie, show, or episode.
 *
 * Contract: GET /api/video/poster/<kind>/<library_id>?w=&api_key=
 * (api/video/poster.py::video_poster → _stream_art) → the cached poster
 * (TMDB branch / Plex / Jellyfin branch), proxied through the server so no
 * media-server token ever reaches the browser. kind is 'movie' | 'show' |
 * 'episode' (the proxy's get_art_ref kinds) — 'episode' serves the episode
 * still, 'movie'/'show' serve posters. The key rides as a query param
 * because <img> elements can't set headers (same convention as the stream
 * URLs — spec §3).
 */
export function videoPosterUrl(
  cfg: ServerConfig,
  kind: 'movie' | 'show' | 'episode',
  libraryId: number,
  width = 185,
): string {
  return `${baseUrl(cfg)}/api/video/poster/${kind}/${libraryId}?w=${width}&${keyParam(cfg)}`;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Search the movie library (owned copies only — playback-only UI).
 *
 * Contract: GET /api/video/library?kind=movies&status=owned&search=&page=&limit=
 * (api/video/library.py::video_library → VideoDatabase.query_library in
 * database/video_database.py) → {items, pagination}. The library page's own
 * endpoint, reused rather than re-derived: status=owned keeps it to titles
 * that have a file on disk. Each row's poster comes from the
 * /api/video/poster/movie/<library_id> proxy (has_poster-gated).
 */
export async function listLibraryMovies(
  cfg: ServerConfig,
  query = '',
  limit = 12,
): Promise<VideoLibraryEntry[]> {
  const params = new URLSearchParams({
    kind: 'movies',
    status: 'owned',
    sort: 'title',
    page: '1',
    limit: String(Math.min(500, Math.max(1, limit))),
  });
  const q = query.trim().slice(0, 200);
  if (q) params.set('search', q);
  const body = await videoApiFetch(cfg, `/api/video/library?${params.toString()}`);
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: VideoLibraryEntry[] = [];
  for (const raw of items) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const tmdbId = numOrNull(o.tmdb_id);
    if (tmdbId === null) continue; // no TMDB id → neither stream nor playable-check can address it
    const libraryId = numOrNull(o.id);
    const entry: VideoLibraryEntry = {
      tmdbId,
      kind: 'm',
      title: strOrEmpty(o.title),
      subtitle: numOrNull(o.year) !== null ? String(o.year) : '',
    };
    if (o.has_poster === true && libraryId !== null) {
      entry.artworkUrl = videoPosterUrl(cfg, 'movie', libraryId);
    }
    out.push(entry);
  }
  return out;
}

/**
 * Search owned episodes: find shows, then expand each into its owned episodes.
 *
 * The web UI has NO single episode-listing route — the show page does this
 * exact two-step (library search → show detail → seasons tree), so this
 * function follows it:
 * - GET /api/video/library?kind=shows&status=owned&search=&limit=
 *   (api/video/library.py::video_library) → {items} with tmdb_id + has_poster.
 * - GET /api/video/detail/show/<show_id>
 *   (api/video/detail.py::video_show_detail → VideoDatabase.show_detail in
 *   database/video_database.py) → {title, tmdb_id, has_poster, seasons: [{
 *   season_number, episodes: [{id, episode_number, title, owned, has_still}]}]}.
 *
 * Bounded by design: the detail fetch is the expensive hop, so at most 6
 * shows are expanded and the returned episodes are capped at `limit`.
 * The season_number comes from the OUTER season object (episodes carry no
 * season field of their own). Playback needs the SHOW's tmdb_id + s/e —
 * exactly what the player tab's /watch/playable call wants (spec §3).
 */
export async function listLibraryEpisodes(
  cfg: ServerConfig,
  query = '',
  limit = 30,
): Promise<VideoLibraryEntry[]> {
  const params = new URLSearchParams({
    kind: 'shows',
    status: 'owned',
    sort: 'title',
    page: '1',
    limit: '10',
  });
  const q = query.trim().slice(0, 200);
  if (q) params.set('search', q);
  const body = await videoApiFetch(cfg, `/api/video/library?${params.toString()}`);
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];

  const out: VideoLibraryEntry[] = [];
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  // Cap the detail fetches — one per show, each its own HTTP round trip.
  for (const raw of items.slice(0, 6)) {
    if (out.length >= limit) break;
    const o = (raw ?? {}) as Record<string, unknown>;
    const libraryId = numOrNull(o.id);
    if (libraryId === null) continue;
    const tmdbId = numOrNull(o.tmdb_id);
    if (tmdbId === null) continue;
    let detail: Record<string, unknown>;
    try {
      detail = (await videoApiFetch(cfg, `/api/video/detail/show/${libraryId}`)) as Record<
        string,
        unknown
      >;
    } catch {
      // One unresolvable show shouldn't sink the whole search.
      continue;
    }
    const showTitle = strOrEmpty(detail.title);
    const showHasPoster = detail.has_poster === true;
    const seasons = detail.seasons;
    if (!Array.isArray(seasons)) continue;
    for (const sRaw of seasons) {
      if (out.length >= limit) break;
      const s = (sRaw ?? {}) as Record<string, unknown>;
      const season = numOrNull(s.season_number);
      const eps = s.episodes;
      if (season === null || !Array.isArray(eps)) continue;
      for (const eRaw of eps) {
        if (out.length >= limit) break;
        const e = (eRaw ?? {}) as Record<string, unknown>;
        // owned = has_file — only copies on disk are playable.
        if (e.owned !== true) continue;
        const epNum = numOrNull(e.episode_number);
        if (epNum === null) continue;
        const epId = numOrNull(e.id);
        const entry: VideoLibraryEntry = {
          tmdbId,
          kind: 't',
          title: strOrEmpty(e.title) || `Episode ${epNum}`,
          subtitle: `${showTitle} · S${pad2(season)}E${pad2(epNum)}`,
          season,
          episode: epNum,
        };
        if (e.has_still === true && epId !== null) {
          entry.artworkUrl = videoPosterUrl(cfg, 'episode', epId);
        } else if (showHasPoster) {
          entry.artworkUrl = videoPosterUrl(cfg, 'show', libraryId);
        }
        out.push(entry);
      }
    }
  }
  return out;
}
