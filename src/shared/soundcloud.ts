/**
 * Exact SoundCloud uploads — pure helpers (no DOM, no polyfill).
 *
 * "Add exact SoundCloud upload" wishlists ONE specific upload: the server
 * resolves the link, keys the row by SoundCloud's numeric track id
 * (`soundcloud_exact_<digits>`) and downloads only that upload — it never
 * searches the catalogue and never falls back to another recording. These
 * helpers decide which pages offer the action, prefill the tag form, shape
 * the request, and turn server states/errors into user text. The URL rules
 * mirror the server's core/wishlist/soundcloud_exact.py::normalize_track_url.
 */
import type { ExactUploadDraft, NowPlaying } from './types.js';

/** soundcloud.com/<first>/… pages that are not a user's track. */
const RESERVED_FIRST = new Set([
  'discover', 'stream', 'search', 'you', 'upload', 'charts', 'feed', 'messages',
  'notifications', 'settings', 'pages', 'terms-of-use', 'people', 'jobs',
]);
/** soundcloud.com/<user>/<second> pages that are not a track. */
const RESERVED_SECOND = new Set([
  'sets', 'likes', 'tracks', 'albums', 'reposts', 'popular-tracks', 'followers',
  'following', 'comments', 'spotlight', 'toptracks',
]);
const TRACK_HOSTS = new Set(['soundcloud.com', 'm.soundcloud.com', 'www.soundcloud.com']);
const SHORT_HOST = 'on.soundcloud.com';

export type SoundcloudUrl =
  | { kind: 'track'; url: string; user: string; slug: string; secret?: string }
  | { kind: 'short'; url: string }
  | { kind: 'set' | 'profile' | 'other' };

/**
 * Classify a SoundCloud link. Only `track` (a public permalink or a
 * `/s-<token>` private share link) and `short` (on.soundcloud.com, which only
 * the server can resolve) can be added as an exact upload; `url` is the
 * normalized https://soundcloud.com/<user>/<slug>[/s-<token>] form, with the
 * query (`?in=…` playlist context) and fragment dropped.
 */
export function parseSoundcloudUrl(href: string): SoundcloudUrl {
  const raw = (href ?? '').trim();
  if (!raw) return { kind: 'other' };
  let u: URL;
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return { kind: 'other' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'other' };
  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split('/').filter(Boolean);
  if (host === SHORT_HOST) {
    return segments.length === 1 ? { kind: 'short', url: `https://${SHORT_HOST}/${segments[0]}` } : { kind: 'other' };
  }
  if (!TRACK_HOSTS.has(host)) return { kind: 'other' };
  if (segments.length === 0 || RESERVED_FIRST.has(segments[0].toLowerCase())) return { kind: 'other' };
  if (segments.length === 1) return { kind: 'profile' };
  const second = segments[1].toLowerCase();
  if (second === 'sets') return { kind: 'set' };
  if (RESERVED_SECOND.has(second)) return { kind: 'profile' };
  if (segments.length > 3) return { kind: 'other' };
  if (segments.length === 3 && !segments[2].startsWith('s-')) return { kind: 'other' };
  const [user, slug, secret] = segments;
  return {
    kind: 'track',
    url: `https://soundcloud.com/${segments.join('/')}`,
    user,
    slug,
    ...(secret ? { secret } : {}),
  };
}

/**
 * The upload the popup offers to add: the playing track's own link first
 * (the player bar), else the tab URL when the tab itself is a SoundCloud
 * track page. The playing track's tags only ever travel with ITS link: the
 * user can be browsing track B's page while track A plays, so a draft built
 * from the tab URL carries no title/uploader/artwork and the server falls
 * back to the upload's own.
 */
export function exactDraftFor(np: NowPlaying | null, tabUrl: string | undefined): ExactUploadDraft | null {
  if (!np) return null;
  const playing = parseSoundcloudUrl(np.sourceUrl ?? '');
  if (playing.kind === 'track') {
    return {
      url: playing.url,
      title: np.title,
      uploader: np.artist,
      artwork: np.artwork,
      durationMs: np.durationMs ?? 0,
    };
  }
  const tab = parseSoundcloudUrl(tabUrl ?? '');
  if (tab.kind === 'track') return { url: tab.url, title: '', uploader: '', artwork: '', durationMs: 0 };
  return null;
}

/** SoundCloud's numeric track id from an app deep link
 *  (`al:ios:url` / `twitter:app:url:iphone`: "soundcloud://sounds:123"). */
export function scIdFromAppUrl(content: string | null | undefined): string | null {
  const m = /^soundcloud:\/\/sounds:(\d+)$/.exec((content ?? '').trim());
  return m ? m[1] : null;
}

/**
 * Best-effort "Artist - Title" split of an upload title, mirroring the
 * server's SoundcloudClient._split_artist_from_title: the FIRST " - " splits
 * when the artist part has at least 2 characters and a title follows;
 * otherwise the uploader is the artist and the whole title stays.
 */
export function splitScTitle(title: string, uploader: string): { artist: string; title: string } {
  if (!title) return { artist: uploader, title: '' };
  const dash = title.indexOf(' - ');
  if (dash >= 0) {
    const artistPart = title.slice(0, dash).trim();
    const titlePart = title.slice(dash + 3).trim();
    // Python's len() counts code points, not UTF-16 units.
    if ([...artistPart].length >= 2 && titlePart) return { artist: artistPart, title: titlePart };
  }
  return { artist: uploader, title };
}

/** Body of POST /api/v1/soundcloud/exact (snake_case, as the server reads it). */
export interface ExactAddRequest {
  url: string;
  title?: string;
  artists?: string[];
  remixers?: string[];
  playlist_id?: number;
  quality_profile_id?: number;
}

/** What the user typed into the tag form. A string list field is split on
 *  commas ("A, B" → two credits). */
export interface ExactEdits {
  title?: string;
  artists?: string | string[];
  remixers?: string | string[];
}

/** The server caps artists at 10 and rejects more. */
const MAX_ARTISTS = 10;

function cleanName(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function nameList(v: string | string[] | undefined, skip: Set<string> = new Set()): string[] {
  const parts = Array.isArray(v) ? v : (v ?? '').split(',');
  const out: string[] = [];
  for (const p of parts) {
    const name = cleanName(String(p ?? ''));
    const key = name.toLowerCase();
    if (!name || skip.has(key)) continue;
    skip.add(key);
    out.push(name);
  }
  return out;
}

function positiveInt(v: number | null | undefined): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Shape the add request: trimmed, deduped (case-insensitive), and every
 *  empty field omitted so the server's own defaults apply. */
export function buildExactRequest(
  draft: Pick<ExactUploadDraft, 'url'>,
  edits: ExactEdits,
  playlistId?: number | null,
  qualityProfileId?: number | null,
): ExactAddRequest {
  const req: ExactAddRequest = { url: draft.url.trim() };
  const title = cleanName(edits.title ?? '');
  if (title) req.title = title;
  const seen = new Set<string>();
  const artists = nameList(edits.artists, seen).slice(0, MAX_ARTISTS);
  if (artists.length > 0) req.artists = artists;
  const remixers = nameList(edits.remixers, seen).slice(0, MAX_ARTISTS);
  if (remixers.length > 0) req.remixers = remixers;
  const pl = positiveInt(playlistId);
  if (pl !== undefined) req.playlist_id = pl;
  const qp = positiveInt(qualityProfileId);
  if (qp !== undefined) req.quality_profile_id = qp;
  return req;
}

export type ExactState = 'none' | 'queued' | 'failed' | 'downloading' | 'acquired';

/** Tag + one-line explanation for an exact upload's server state. `tag` is
 *  empty for `none` (nothing to show). */
export function exactStateLabel(
  state: string | null | undefined,
  failureReason?: string | null,
): { tag: string; line: string; cls: string } {
  switch (state) {
    case 'queued':
      return { tag: 'QUEUED', line: 'This exact upload is on your wishlist — it downloads on the next run.', cls: 'tag-wl' };
    case 'downloading':
      return { tag: 'DOWNLOADING', line: 'Downloading this exact upload now.', cls: 'tag-dl' };
    case 'failed':
      return {
        tag: 'FAILED',
        line: failureReason
          ? `Last try failed: ${failureReason}`
          : 'Last try failed — it will be retried.',
        cls: 'tag-fail',
      };
    case 'acquired':
      return { tag: 'IN LIBRARY', line: 'Already in your library (this exact upload).', cls: 'tag-lib' };
    default:
      return { tag: '', line: '', cls: '' };
  }
}

export const UNSUPPORTED_SERVER_MESSAGE =
  "Your SoulSync server doesn't support adding exact SoundCloud uploads yet. Update SoulSync to use this.";

/** Disabled playlist-picker entry when the playlist list didn't load. */
export const EXACT_PLAYLISTS_FAILED = "Couldn't load your playlists";

/** User text for each POST /api/v1/soundcloud/exact error code. */
export function exactErrorMessage(code: string | null | undefined, message?: string | null): string {
  const detail = (message ?? '').trim();
  switch (code) {
    case 'BAD_REQUEST':
      return detail ? `The server rejected the request: ${detail}` : 'The server rejected the request.';
    case 'NOT_SOUNDCLOUD_TRACK':
      return "That link isn't a single SoundCloud track — open the track's own page and try again.";
    case 'BAD_PLAYLIST':
      return "That playlist wasn't found on your server.";
    case 'PLAYLIST_NOT_EDITABLE':
      return 'Exact uploads can only be added to your own SoulSync playlists.';
    case 'UPLOAD_UNAVAILABLE':
      return "SoundCloud wouldn't serve that upload (deleted, private or region-locked).";
    case 'SOURCE_DISABLED':
      return 'SoundCloud is turned off as a download source in your SoulSync settings.';
    case 'SOURCE_UNAVAILABLE':
      return 'SoundCloud downloads need yt-dlp on your SoulSync server.';
    case 'BLOCKLISTED':
      return 'That artist, uploader or track is on your SoulSync blocklist.';
    case 'REJECTED':
      return detail ? `Your server refused the add: ${detail}` : 'Your server refused the add.';
    case 'WISHLIST_ERROR':
      return detail ? `Your server hit an error adding the upload: ${detail}` : 'Your server hit an error adding the upload.';
    default:
      return detail || 'Adding the exact upload failed.';
  }
}

/** Why the server's probe says it can't take exact uploads right now. */
export function exactDisabledMessage(reason: string | null | undefined): string {
  if (reason === 'source_unavailable') return exactErrorMessage('SOURCE_UNAVAILABLE');
  return exactErrorMessage('SOURCE_DISABLED');
}

/** An older server answers the unknown route with 404 (GET) or 405 (POST). */
export function isUnsupportedStatus(status: number): boolean {
  return status === 404 || status === 405;
}
