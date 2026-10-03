/// <reference types="chrome" />
/* SoulSync Companion — mini player.
 *
 * Runs as a docked browser panel (Chrome side panel / Firefox sidebar),
 * opened from the ⧉ button, with a real OS popup window as the fallback.
 * It is a thin remote over the background audio host — the same protocol
 * the popup's player tab speaks — and repaints from the host's snapshots
 * on a 1s poll.
 */
import browser from 'webextension-polyfill';
import { getConfig, getRecentlyAdded, getRecentlyPlayed, getPlaylists, getPlaylistTracks, normName } from '../shared/api.js';
import type { RecentAlbum, RecentTrack, Playlist } from '../shared/api.js';
import { lookupCoverArt } from '../shared/artwork.js';
import type { ServerConfig } from '../shared/types.js';
import {
  checkVideoPlayable,
  getAlbumTracks,
  getArtistAlbums,
  isUnplayableAudio,
  searchLibraryAlbums,
  searchLibraryArtists,
  searchLibraryTracks,
  toQueueEntry,
  videoStreamUrl,
  type LibraryAlbum,
  type LibraryArtist,
  type LibraryTrack,
  type VideoEntry,
} from '../shared/player-api.js';
import { enrichQueueArtwork } from '../player/artwork-enrich.js';
import { sendToPlayer } from '../player/messaging.js';
import { clearMiniPlayerWindow } from '../player/mini-window.js';
import type { PlayerMessage, PlayerSnapshot, QueueEntry } from '../player/types.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let scrubbing = false;
let volumeScrubbing = false;
let pollTimer: number | undefined;
let lastArtSrc = '';
let serverCfg: ServerConfig | null = null;
let lastQueueKey = '';
/** Key of the track last recorded to Recently Played (avoids re-saving on every poll). */
let lastPlayedKey = '';
const RECENTLY_PLAYED_KEY = 'recentlyPlayed';
const RECENTLY_PLAYED_MAX = 24;

// ── Video surface ─────────────────────────────────────────────
// A video queue entry renders here instead of the audio UI: the audio
// host parks on video entries (it can't play them), and this surface
// owns the <video> element — verdict check, stream, PiP, teardown.

/** Identity of the video currently loaded in the stage ('' = none). */
let videoKey = '';
let videoEl: HTMLVideoElement | null = null;

function videoIdentity(cur: { videoKd?: string; videoId?: number; season?: number; episode?: number }): string {
  return `${cur.videoKd ?? ''}:${cur.videoId ?? ''}:${cur.season ?? ''}:${cur.episode ?? ''}`;
}

function showVideoWarning(reasons: string[]): void {
  const warn = $('m-video-warn');
  warn.innerHTML = '';
  warn.append('Some copies may not play in this browser:');
  const ul = document.createElement('ul');
  for (const r of reasons) {
    const li = document.createElement('li');
    li.textContent = r;
    ul.appendChild(li);
  }
  warn.appendChild(ul);
  warn.hidden = false;
}

function showVideoError(heading: string, message: string, reasons: string[] = []): void {
  const box = $('m-video-error');
  box.innerHTML = '';
  const h = document.createElement('h4');
  h.textContent = heading;
  const p = document.createElement('p');
  p.textContent = message;
  box.append(h, p);
  if (reasons.length > 0) {
    const ul = document.createElement('ul');
    for (const r of reasons) {
      const li = document.createElement('li');
      li.textContent = r;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  box.hidden = false;
}

function describeVideoError(video: HTMLVideoElement): string {
  const err = video.error;
  switch (err?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "Playback was interrupted before it could load.";
    case MediaError.MEDIA_ERR_NETWORK:
      return 'The connection to your server was lost.';
    case MediaError.MEDIA_ERR_DECODE:
      return "This browser couldn't decode it.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "This format isn't supported here.";
    default:
      return "The server didn't send a playable stream.";
  }
}

function setupVideoMediaSession(video: HTMLVideoElement, cur: QueueEntry): void {
  if (!('mediaSession' in navigator)) return;
  const artwork = cur.artworkUrl ? [{ src: cur.artworkUrl }] : [];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cur.title,
      artist: cur.subtitle ?? 'SoulSync',
      album: 'SoulSync',
      artwork,
    });
  } catch {
    /* playback continues without it */
  }
  try {
    navigator.mediaSession.setActionHandler('play', () => void video.play());
    navigator.mediaSession.setActionHandler('pause', () => video.pause());
  } catch {
    /* unsupported — playback continues without it */
  }
}

function wireVideoPip(): void {
  const btn = $('m-pip') as HTMLButtonElement;
  if (!document.pictureInPictureEnabled || !videoEl) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
}

async function showVideo(cur: QueueEntry): Promise<void> {
  const key = videoIdentity(cur);
  if (key === videoKey) return;
  teardownVideo();
  videoKey = key;

  $('m-video-title').textContent = cur.title;
  $('m-video-sub').textContent = cur.subtitle ?? '';
  $('m-video-error').hidden = true;
  $('m-video-warn').hidden = true;
  const stage = $('m-video-stage');
  stage.innerHTML = '<div class="disco-loading"><span></span><span></span><span></span></div>';

  if (!serverCfg) {
    showVideoError('Not connected', 'Connect your SoulSync server in the extension options.');
    return;
  }
  if (cur.videoKd !== 'm' && cur.videoKd !== 't') {
    showVideoError("Couldn't play this video", 'The queue entry is missing its video id.');
    return;
  }
  const entry: VideoEntry = { videoKd: cur.videoKd, videoId: cur.videoId ?? 0 };
  if (cur.season !== undefined) entry.season = cur.season;
  if (cur.episode !== undefined) entry.episode = cur.episode;

  // Honest states: the server's verdict decides before any <video> src is
  // set — a refused copy never becomes a silent black rectangle.
  let verdict: Awaited<ReturnType<typeof checkVideoPlayable>>;
  try {
    verdict = await checkVideoPlayable(serverCfg, entry);
  } catch (err) {
    if (key !== videoKey) return;
    showVideoError(
      "Couldn't check this video",
      err instanceof Error ? err.message : 'The playable check failed unexpectedly.',
    );
    return;
  }
  if (key !== videoKey) return;
  if (verdict.verdict === 'no') {
    showVideoError(
      `Can't play "${cur.title}"`,
      'Your server says no browser can play this copy.',
      verdict.reasons,
    );
    return;
  }
  if (verdict.verdict === 'maybe' && verdict.reasons.length > 0) {
    showVideoWarning(verdict.reasons);
  }

  const video = document.createElement('video');
  video.className = 'mini-video-el';
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = videoStreamUrl(serverCfg, entry);
  video.addEventListener('error', () => {
    if (key !== videoKey) return;
    showVideoError("Couldn't play this video", describeVideoError(video));
  });
  video.addEventListener('play', () => setVideoBadge(true));
  video.addEventListener('pause', () => setVideoBadge(false));
  video.addEventListener('ended', () => {
    setVideoBadge(false);
    // When the video finishes, move the queue along like audio does.
    void action({ type: 'player:next' });
  });
  stage.replaceChildren(video);
  videoEl = video;
  setupVideoMediaSession(video, cur);
  wireVideoPip();
  // Best effort: the panel opened on the popup's click, so transient
  // activation may still be live. If the browser blocks it, the user
  // just presses play.
  video.play().catch(() => undefined);
}

/** Toolbar badge for video playback (the audio host owns the audio one). */
function setVideoBadge(on: boolean): void {
  try {
    if (on) {
      void browser.action.setBadgeBackgroundColor({ color: '#22c55e' });
      void browser.action.setBadgeText({ text: '♪' });
    } else {
      void browser.action.setBadgeText({ text: '' });
    }
  } catch {
    /* badge API unavailable */
  }
}

function teardownVideo(): void {
  videoKey = '';
  setVideoBadge(false);  if (videoEl) {
    try {
      videoEl.pause();
    } catch {
      /* ignore */
    }
    videoEl.removeAttribute('src');
    videoEl.load();
    videoEl.remove();
    videoEl = null;
  }
  const stage = document.getElementById('m-video-stage');
  if (stage) stage.innerHTML = '';
  const warn = document.getElementById('m-video-warn');
  if (warn) warn.hidden = true;
  const err = document.getElementById('m-video-error');
  if (err) err.hidden = true;
}

// ── Discovery shelf ─────────────────────────────────────────────
// Rebuilt whenever the playing track changes (render() polls every second,
// so this is keyed, not re-fetched per tick). Stale in-flight refreshes are
// dropped via discoToken.
let discoKey = '';
let discoToken = 0;

interface SimilarArtist {
  name: string;
  imageUrl?: string;
}

const simArtistCache = new Map<string, SimilarArtist[]>();

function discoNote(msg: string): void {
  const note = $('m-disco-note');
  if (!msg) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  note.hidden = false;
  note.textContent = msg;
}

/**
 * Artist photo out of a MusicMap payload. The payload is normalized with an
 * `image_url` field — usually a server-relative /api/image-cache/… path
 * (that endpoint is public, CORS *, no key needed), sometimes a raw
 * third-party URL. Raw provider shapes are the fallback.
 */
function similarArtistImage(a: Record<string, unknown>): string | undefined {
  const iu = a['image_url'];
  if (typeof iu === 'string' && iu) {
    if (iu.startsWith('/')) return `${serverCfg!.url.replace(/\/+$/, '')}${iu}`;
    if (/^https?:\/\//i.test(iu)) return iu;
  }
  const images = a['images'];
  if (Array.isArray(images) && images.length > 0) {
    const u = (images[0] as { url?: unknown } | null)?.url;
    if (typeof u === 'string' && u) return u;
  }
  for (const k of ['picture_medium', 'picture_big', 'picture_xl', 'picture']) {
    const u = a[k];
    if (typeof u === 'string' && u) return u;
  }
  const it = a['artworkUrl100'];
  if (typeof it === 'string' && it) return it.replace('100x100', '600x600');
  return undefined;
}

function similarArtistName(a: Record<string, unknown>): string {
  for (const k of ['name', 'artistName', 'title']) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Similar artists for the current artist, via the server's MusicMap lookup
 * (the same source the artist pages use). Non-v1 route, so the key rides
 * as ?api_key= — the same pattern the watchlist calls use.
 */
async function fetchSimilarArtists(artist: string): Promise<SimilarArtist[]> {
  const cached = simArtistCache.get(artist);
  if (cached) return cached;
  const base = serverCfg!.url.replace(/\/+$/, '');
  const url =
    `${base}/api/artist/similar/${encodeURIComponent(artist)}` +
    `?api_key=${encodeURIComponent(serverCfg!.apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`similar artists: HTTP ${res.status}`);
  const data = (await res.json().catch(() => null)) as {
    similar_artists?: Array<Record<string, unknown> | null>;
  } | null;
  const raw = Array.isArray(data?.similar_artists) ? data.similar_artists : [];
  const out: SimilarArtist[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const n = similarArtistName(a);
    if (!n || n.toLowerCase() === artist.toLowerCase()) continue;
    if (seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    const imageUrl = similarArtistImage(a);
    out.push(imageUrl ? { name: n, imageUrl } : { name: n });
    if (out.length >= 8) break;
  }
  simArtistCache.set(artist, out);
  return out;
}

/**
 * Top tracks for a library artist, via artists → albums → tracks.
 * Deliberately avoids the tracks search endpoint's empty-title query —
 * only the search box's title-first shape is proven in production.
 * Cached per artist; the discovery shelf rebuilds on every track change.
 */
/**
 * Recently added albums. Session-cached (5 min) — the list doesn't change
 * with the playing track, so there's no reason to refetch it per song.
 * Uses type=albums (the type=tracks variant returns nothing).
 */
let recentCache: { at: number; albums: RecentAlbum[] } | null = null;

async function fetchRecentlyAdded(): Promise<RecentAlbum[]> {
  const now = Date.now();
  if (recentCache && now - recentCache.at < 5 * 60 * 1000) return recentCache.albums;
  const albums = await getRecentlyAdded(serverCfg!, 8).catch(() => [] as RecentAlbum[]);
  recentCache = { at: now, albums };
  return albums;
}

function renderRecentlyAdded(albums: RecentAlbum[]): void {
  const box = $('m-recent');
  box.innerHTML = '';
  // If the endpoint gives us nothing, hide the block instead of showing
  // an empty shelf — an empty "Recently added" is worse than none.
  const block = box.closest('.disco-block') as HTMLElement | null;
  if (block) block.hidden = albums.length === 0;
  if (!albums.length) return;
  for (const al of albums) {
    const b = document.createElement('button');
    b.className = 'disco-card';
    b.title = `Play ${al.title}`;
    if (al.thumb) {
      const img = document.createElement('img');
      img.className = 'disco-card-img';
      img.src = al.thumb;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        // Server thumb is broken — try Deezer in the background.
        void hydrateAlbumArtwork(img, al.id, al.title);
      });
      b.appendChild(img);
    } else {
      // No server artwork: letter placeholder, Deezer fills it in behind.
      const ph = document.createElement('div');
      ph.className = 'disco-card-img disco-card-ph';
      ph.textContent = al.title.charAt(0).toUpperCase();
      b.appendChild(ph);
      void hydrateAlbumArtworkDiv(ph, al.id, al.title);
    }
    const nm = document.createElement('div');
    nm.className = 'disco-card-name';
    nm.textContent = al.title;
    b.appendChild(nm);
    b.addEventListener('click', () => void playAlbum(al.id));
    box.appendChild(b);
  }
}

/** Fill in a missing album cover via the album's first track + Deezer. */
async function hydrateAlbumArtwork(
  img: HTMLImageElement,
  albumId: number,
  albumTitle: string,
): Promise<void> {
  try {
    const url = await lookupCoverArt('', albumTitle);
    if (url) img.src = url;
  } catch {
    // Leave the placeholder.
  }
}

/** Replace a letter-placeholder div with the Deezer artwork when found. */
async function hydrateAlbumArtworkDiv(
  ph: HTMLElement,
  albumId: number,
  albumTitle: string,
): Promise<void> {
  try {
    // Search Deezer for the album title directly — no need to fetch
    // tracks first for the artist name.
    const url = await lookupCoverArt('', albumTitle);
    if (url && ph.isConnected) {
      const img = document.createElement('img');
      img.className = 'disco-card-img';
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      ph.replaceWith(img);
    }
  } catch {
    // Leave the placeholder.
  }
}

/** Record a track to Recently Played (deduped, most-recent-first, capped). */
async function recordRecentlyPlayed(entry: QueueEntry): Promise<void> {
  try {
    const stored = await browser.storage.local.get(RECENTLY_PLAYED_KEY);
    const list = (stored[RECENTLY_PLAYED_KEY] as QueueEntry[] | undefined) ?? [];
    const key = (e: QueueEntry) =>
      `${e.trackId ?? ''}|${e.audioPath ?? ''}|${e.title}`;
    const filtered = list.filter((e) => key(e) !== key(entry));
    filtered.unshift(entry);
    const trimmed = filtered.slice(0, RECENTLY_PLAYED_MAX);
    await browser.storage.local.set({ [RECENTLY_PLAYED_KEY]: trimmed });
    renderRecentlyPlayed(trimmed);
  } catch {
    /* storage unavailable — shelf just stays empty */
  }
}

/** Load and render the Recently Played shelf. */
async function loadRecentlyPlayed(): Promise<void> {
  // Prefer the server's listening history; fall back to local extension
  // plays if the server is unreachable or the endpoint isn't there yet.
  if (serverCfg) {
    try {
      const tracks = await getRecentlyPlayed(serverCfg, 20);
      if (tracks.length > 0) {
        const entries: QueueEntry[] = tracks
          .filter((t) => t.id > 0 && t.filePath && !isUnplayableAudio(t.filePath))
          .map((t) => {
            const e: QueueEntry = {
              kind: 'audio',
              title: t.title,
              subtitle: [t.artist, t.album].filter(Boolean).join(' · ') || undefined,
              trackId: t.id,
              audioPath: t.filePath,
            };
            if (t.thumb) e.artworkUrl = t.thumb;
            enrichQueueArtwork(e);
            return e;
          });
        renderRecentlyPlayed(entries);
        return;
      }
    } catch {
      /* fall through to local */
    }
  }
  try {
    const stored = await browser.storage.local.get(RECENTLY_PLAYED_KEY);
    const list = (stored[RECENTLY_PLAYED_KEY] as QueueEntry[] | undefined) ?? [];
    renderRecentlyPlayed(list);
  } catch {
    renderRecentlyPlayed([]);
  }
}

function renderRecentlyPlayed(entries: QueueEntry[]): void {
  const box = $('m-recent-played');
  box.innerHTML = '';
  const block = box.closest('.disco-block') as HTMLElement | null;
  if (block) block.hidden = entries.length === 0;
  if (!entries.length) return;
  for (const e of entries) {
    const b = document.createElement('button');
    b.className = 'disco-card';
    b.title = `Play ${e.title}`;
    if (e.artworkUrl) {
      const img = document.createElement('img');
      img.className = 'disco-card-img';
      img.src = e.artworkUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.style.display = 'none';
      });
      b.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'disco-card-img disco-card-ph';
      ph.textContent = e.title.charAt(0).toUpperCase();
      b.appendChild(ph);
    }
    const nm = document.createElement('div');
    nm.className = 'disco-card-name';
    nm.textContent = e.title;
    b.appendChild(nm);
    const sub = document.createElement('div');
    sub.className = 'disco-card-sub';
    sub.textContent = e.subtitle ?? '';
    b.appendChild(sub);
    b.addEventListener('click', () => void action({ type: 'player:playNow', entry: e }));
    box.appendChild(b);
  }
}

/** Play an album: first track now, the rest queued behind it. */
async function playAlbum(albumId: number): Promise<void> {
  if (!serverCfg) return;
  try {
    const tracks = await getAlbumTracks(serverCfg, albumId);
    if (!tracks.length) {
      discoNote('Album is empty on the server.');
      return;
    }
    const playable = tracks.filter((t) => t.filePath && !isUnplayableAudio(t.filePath));
    if (!playable.length) {
      discoNote(`No playable tracks in this album (${tracks.length} tracks, none with audio files).`);
      return;
    }
    const first = toQueueEntry(playable[0]);
    enrichQueueArtwork(first);
    await action({ type: 'player:playNow', entry: first });
    for (const t of playable.slice(1)) {
      const e = toQueueEntry(t);
      enrichQueueArtwork(e);
      await sendToPlayer({ type: 'player:queueLast', entry: e }).catch(() => undefined);
    }
    discoNote('');
  } catch (e) {
    discoNote(`Couldn't load album: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Similar songs: more from the same artist first, then top tracks from
 * each of the top similar artists. Everything returned is playable —
 * clicking a row just plays it.
 */
function renderSimilarArtists(artists: SimilarArtist[]): void {
  const box = $('m-sim-artists');
  box.innerHTML = '';
  if (!artists.length) {
    box.innerHTML = '<span class="disco-empty">No similar artists found.</span>';
    return;
  }
  for (const a of artists) {
    const b = document.createElement('button');
    b.className = 'disco-card';
    b.title = `Play ${a.name} radio`;
    if (a.imageUrl) {
      const img = document.createElement('img');
      img.className = 'disco-card-img';
      img.src = a.imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      b.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'disco-card-img disco-card-ph';
      ph.textContent = a.name.charAt(0).toUpperCase();
      b.appendChild(ph);
    }
    const nm = document.createElement('div');
    nm.className = 'disco-card-name';
    nm.textContent = a.name;
    b.appendChild(nm);
    b.addEventListener('click', () => void playArtistRadio(a.name));
    box.appendChild(b);
  }
}

/** A clickable song row (used by Similar songs and Up next). */
function songRowButton(title: string, artist: string, onPlay: () => void, artworkUrl?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'disco-song';
  b.title = `Play ${title}`;
  if (artworkUrl) {
    const img = document.createElement('img');
    img.className = 'disco-song-art';
    img.src = artworkUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    b.appendChild(img);
  }
  const tt = document.createElement('span');
  tt.className = 'tt';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = title;
  const a = document.createElement('div');
  a.className = 'a';
  a.textContent = artist;
  tt.append(t, a);
  const go = document.createElement('span');
  go.className = 'go';
  go.textContent = '▶';
  b.append(tt, go);
  b.addEventListener('click', onPlay);
  return b;
}

async function refreshDiscovery(cur: QueueEntry | null): Promise<void> {
  const token = ++discoToken;
  const artist = (cur?.subtitle ?? '').trim();
  const simBlock = $('m-sim-artists-block');
  discoNote('');
  // Similar artists only show when a track is active. The other sections
  // (Playlists, Recently Added, Recently Played) are always visible and
  // load independently.
  if (!serverCfg || !cur || cur.kind !== 'audio' || !artist) {
    simBlock.hidden = true;
    return;
  }
  simBlock.hidden = false;
  const shimmer = '<div class="disco-loading"><span></span><span></span><span></span></div>';
  $('m-sim-artists').innerHTML = shimmer;
  let artists: SimilarArtist[] = [];
  try {
    artists = await fetchSimilarArtists(artist);
  } catch {
    artists = [];
  }
  if (token !== discoToken) return;
  renderSimilarArtists(artists);
}

/** Load the always-visible shelves: Playlists, Recently Added. */
async function loadStaticShelves(): Promise<void> {
  if (!serverCfg) return;
  try {
    renderRecentlyAdded(await fetchRecentlyAdded());
  } catch {
    renderRecentlyAdded([]);
  }
  try {
    const playlists = await getPlaylists(serverCfg);
    renderPlaylists(playlists);
  } catch {
    renderPlaylists([]);
  }
}

function renderPlaylists(playlists: Playlist[]): void {
  const box = $('m-playlists');
  box.innerHTML = '';
  const block = box.closest('.disco-block') as HTMLElement | null;
  if (block) block.hidden = playlists.length === 0;
  if (!playlists.length) return;
  for (const pl of playlists) {
    const b = document.createElement('button');
    b.className = 'disco-card';
    b.title = `Play ${pl.name}`;
    const ph = document.createElement('div');
    ph.className = 'disco-card-img disco-card-ph';
    ph.textContent = '♪';
    b.appendChild(ph);
    const nm = document.createElement('div');
    nm.className = 'disco-card-name';
    nm.textContent = pl.name;
    b.appendChild(nm);
    const sub = document.createElement('div');
    sub.className = 'disco-card-sub';
    sub.textContent = `${pl.trackCount} tracks`;
    b.appendChild(sub);
    b.addEventListener('click', () => void playPlaylist(pl.id));
    box.appendChild(b);
  }
}

/** Fill in playlist artwork from its first track's cover. */
async function hydratePlaylistArtwork(_ph: HTMLElement, _playlistId: number): Promise<void> {
  // Disabled: fetching tracks for every playlist on load hammers the server
  // (429s). Playlists keep the ♪ placeholder.
  return;
}

/** Play a playlist: first track now, the rest queued behind it. */
async function playPlaylist(playlistId: number): Promise<void> {
  if (!serverCfg) return;
  try {
    const tracks = await getPlaylistTracks(serverCfg, playlistId);
    if (!tracks.length) {
      discoNote('Playlist is empty on the server.');
      return;
    }
    const playable = tracks.filter((t) => t.filePath && !isUnplayableAudio(t.filePath));
    if (!playable.length) {
      discoNote(`No playable tracks in this playlist (${tracks.length} tracks, none with audio files).`);
      return;
    }
    const first = toQueueEntry(playable[0]);
    enrichQueueArtwork(first);
    await action({ type: 'player:playNow', entry: first });
    for (const t of playable.slice(1)) {
      const e = toQueueEntry(t);
      enrichQueueArtwork(e);
      await sendToPlayer({ type: 'player:queueLast', entry: e }).catch(() => undefined);
    }
    discoNote('');
  } catch (e) {
    discoNote(`Couldn't load playlist: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Artist radio, the extension way: shuffle the artist's library tracks,
 * play one at random, queue the rest — the same shape as the server's
 * own artist radio (random start + a queue of their music).
 */
async function playArtistRadio(artistName: string): Promise<void> {
  if (!serverCfg) return;
  discoNote(`Finding ${artistName} in your library…`);
  try {
    // Name-based lookup: artists → albums → tracks. Best effort — the
    // name search is unreliable on some servers.
    const artists = await searchLibraryArtists(serverCfg, artistName, 5);
    const want = normName(artistName);
    const match = artists.find((a) => normName(a.name) === want) ?? artists[0];
    const playable: LibraryTrack[] = [];
    if (match) {
      const albums = await getArtistAlbums(serverCfg, match.id).catch(() => []);
      const seen = new Set<number>();
      for (const al of albums.slice(0, 4)) {
        const tracks = await getAlbumTracks(serverCfg, al.id).catch(() => [] as LibraryTrack[]);
        for (const t of tracks) {
          if (seen.has(t.id) || isUnplayableAudio(t.filePath)) continue;
          seen.add(t.id);
          playable.push(t);
          if (playable.length >= 26) break;
        }
        if (playable.length >= 26) break;
      }
    }
    if (!playable.length) {
      discoNote(`${artistName} isn't in your library yet.`);
      return;
    }
    discoNote('');
    // Shuffle like the server's artist radio: random start, rest queued.
    const shuffled = [...playable];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const first = toQueueEntry(shuffled[0]);
    enrichQueueArtwork(first);
    await action({ type: 'player:playNow', entry: first });
    for (const t of shuffled.slice(1)) {
      const e = toQueueEntry(t);
      enrichQueueArtwork(e);
      await sendToPlayer({ type: 'player:queueLast', entry: e }).catch(() => undefined);
    }
  } catch {
    discoNote(`Couldn't reach your server.`);
  }
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function currentEntryOf(snap: PlayerSnapshot): QueueEntry | null {
  return snap.index >= 0 && snap.index < snap.queue.length ? snap.queue[snap.index] : null;
}

async function action(message: PlayerMessage): Promise<void> {
  try {
    render(await sendToPlayer(message));
  } catch {
    /* the next poll will recover — never toast from a button */
  }
}

function paintArt(cur: QueueEntry | null): void {
  const art = $('m-art') as HTMLImageElement;
  const url = cur?.artworkUrl ?? '';
  if (url !== lastArtSrc) {
    lastArtSrc = url;
    art.classList.remove('loaded');
    if (url) {
      art.onload = () => art.classList.add('loaded');
      art.onerror = () => art.classList.remove('loaded');
      art.setAttribute('src', url);
      // Cached images may never fire onload — paint immediately when the
      // pixels are already there.
      if (art.complete && art.naturalWidth > 0) art.classList.add('loaded');
    } else {
      art.removeAttribute('src');
    }
  }
}

function render(snap: PlayerSnapshot): void {
  const cur = currentEntryOf(snap);
  const isVideo = cur?.kind === 'video';

  // Video owns its own surface: the audio block (art, transport, seek,
  // volume) hides, the video stage shows. Switching back tears the
  // <video> element down so nothing keeps playing unseen.
  $('m-audio').hidden = !!isVideo;
  $('m-video').hidden = !isVideo;
  if (isVideo && cur) {
    void showVideo(cur);
  } else if (!isVideo && videoKey) {
    teardownVideo();
  }

  paintArt(cur);

  // A track that arrived without art (library rows have none) gets its
  // cover resolved in the background; the host broadcast repaints us.
  if (cur) enrichQueueArtwork(cur);

  // Track recently played: when a new audio track becomes current,
  // record it (deduped) for the Recently Played shelf.
  if (cur && cur.kind === 'audio') {
    const key = `${cur.trackId ?? ''}|${cur.audioPath ?? ''}|${cur.title}`;
    if (key !== lastPlayedKey) {
      lastPlayedKey = key;
      void recordRecentlyPlayed(cur);
    }
  }

  $('m-title').textContent = cur?.title ?? 'Nothing queued';
  $('m-sub').textContent = cur?.subtitle ?? '';
  // Taskbar/title-bar shows the playing state at a glance.
  document.title =
    snap.status === 'playing' && cur ? `♪ ${cur.title} — SoulSync`
    : snap.status === 'paused' && cur ? `${cur.title} — SoulSync`
    : 'SoulSync mini player';
  $('m-state').textContent =
    snap.status === 'loading' ? 'Loading…'
    : snap.status === 'playing' ? 'Playing'
    : snap.status === 'paused' ? 'Paused'
    : '';

  const toggle = $('m-toggle') as HTMLButtonElement;
  toggle.innerHTML = snap.status === 'playing' ? '&#10074;&#10074;' : '&#9654;';
  toggle.title = snap.status === 'playing' ? 'Pause' : 'Play';

  const seek = $('m-seek') as HTMLInputElement;
  const dur = Math.max(0, Math.floor(snap.durationSec || 0));
  const pos = Math.max(0, Math.floor(snap.positionSec));
  seek.max = String(Math.max(dur, 1));
  if (!scrubbing) seek.value = String(pos);
  const shown = scrubbing ? Number(seek.value) : pos;
  $('m-pos').textContent = fmtTime(shown);
  $('m-dur').textContent = fmtTime(dur);
  seek.style.setProperty('--fill', `${dur > 0 ? Math.min(100, (shown / dur) * 100) : 0}%`);

  const vol = $('m-vol') as HTMLInputElement;
  const pct = Math.round((snap.volume ?? 1) * 100);
  if (!volumeScrubbing) {
    vol.value = String(pct);
    vol.style.setProperty('--fill', `${pct}%`);
  }

  // Up next: the full upcoming queue as jump-to rows. Keyed so the 1s
  // poll doesn't rebuild the list (and drop hover/focus) every tick.
  const upcoming = snap.queue.slice(snap.index + 1);
  const qKey = `${snap.queue.length}:${snap.index}:${upcoming[0]?.title ?? ''}`;
  if (qKey !== lastQueueKey) {
    lastQueueKey = qKey;
    const qSec = $('m-queue');
    const qList = $('m-queue-list');
    qList.innerHTML = '';
    if (upcoming.length) {
      qSec.hidden = false;
      upcoming.slice(0, 10).forEach((q, i) => {
        qList.appendChild(
          songRowButton(q.title, q.subtitle ?? '', () =>
            void action({ type: 'player:setIndex', index: snap.index + 1 + i }),
            q.artworkUrl,
          ),
        );
      });
      if (upcoming.length > 10) {
        const more = document.createElement('div');
        more.className = 'disco-empty';
        more.textContent = `+${upcoming.length - 10} more in queue`;
        qList.appendChild(more);
      }
    } else {
      // Always show the queue section, even when empty — it's a core
      // part of the player UI.
      qSec.hidden = false;
      const empty = document.createElement('div');
      empty.className = 'disco-empty';
      empty.textContent = snap.queue.length > 0 ? 'End of queue' : 'Queue is empty';
      qList.appendChild(empty);
    }
  }

  const errEl = $('m-error');
  if (snap.status === 'error') {
    errEl.textContent = snap.error || 'Playback failed.';
    errEl.hidden = false;
  } else {
    errEl.hidden = true;
  }

  const hasQueue = snap.queue.length > 0;
  for (const id of ['m-prev', 'm-toggle', 'm-next']) {
    ($(id) as HTMLButtonElement).disabled = !hasQueue;
  }
  ($('m-seek') as HTMLInputElement).disabled = !hasQueue;

  // Discovery shelf follows the track — keyed so the 1s poll doesn't
  // re-fetch; refreshDiscovery drops stale in-flight runs itself.
  // Similar artists only show for an active track; the other shelves
  // (Playlists, Recently Added/Played) are always visible.
  const key = cur && cur.kind === 'audio' ? `${cur.subtitle ?? ''}::${cur.title}` : '';
  if (key !== discoKey) {
    discoKey = key;
    if (key && cur) void refreshDiscovery(cur);
    else {
      discoToken++;
      $('m-sim-artists-block').hidden = true;
    }
  }
}

function setEnabled(on: boolean): void {
  for (const id of ['m-prev', 'm-toggle', 'm-next']) {
    ($(id) as HTMLButtonElement).disabled = !on;
  }
  ($('m-seek') as HTMLInputElement).disabled = !on;
  ($('m-vol') as HTMLInputElement).disabled = !on;
  $('m-hint').hidden = on;
}

async function refresh(): Promise<void> {
  try {
    render(await sendToPlayer({ type: 'player:getState' }));
  } catch {
    /* poll again shortly */
  }
}

function startPoll(): void {
  stopPoll();
  let inFlight = false;
  pollTimer = window.setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    sendToPlayer({ type: 'player:getState' })
      .then(render)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, 1000);
}

function stopPoll(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function init(): Promise<void> {
  const seek = $('m-seek') as HTMLInputElement;
  seek.addEventListener('input', () => {
    scrubbing = true;
    $('m-pos').textContent = fmtTime(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    void action({ type: 'player:seek', sec: Number(seek.value) });
  });
  const vol = $('m-vol') as HTMLInputElement;
  vol.addEventListener('input', () => {
    volumeScrubbing = true;
    vol.style.setProperty('--fill', `${vol.value}%`);
  });
  vol.addEventListener('change', () => {
    volumeScrubbing = false;
    void action({ type: 'player:setVolume', volume: Number(vol.value) / 100 });
  });

  $('m-prev').addEventListener('click', () => void action({ type: 'player:prev' }));
  $('m-next').addEventListener('click', () => void action({ type: 'player:next' }));
  $('m-toggle').addEventListener('click', () => void action({ type: 'player:toggle' }));
  ($('m-pip') as HTMLButtonElement).addEventListener('click', () => {
    void (async () => {
      const video = videoEl;
      if (!video) return;
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch {
        /* PiP unavailable right now — the inline video keeps playing */
      }
    })();
  });
  window.addEventListener('unload', stopPoll);
  // Forget the tracked window id so the next play opens a fresh one.
  window.addEventListener('unload', () => void clearMiniPlayerWindow());

  const cfg = await getConfig().catch(() => null);
  serverCfg = cfg;
  setEnabled(!!cfg);
  // Recently Played is local — load it even before/without a server.
  void loadRecentlyPlayed();
  // Playlists and Recently Added are always visible — load them now.
  if (cfg) void loadStaticShelves();
  if (cfg) {
    setupPanelSearch();
    await refresh();
    startPoll();
  }
}

/** Panel search: debounced unified music search with Artists/Albums/Tracks. */
let panelSearchTimer: ReturnType<typeof setTimeout> | null = null;
let panelSearchReqId = 0;

function setupPanelSearch(): void {
  const input = $('m-search') as HTMLInputElement;
  const results = $('m-search-results');
  input.addEventListener('input', () => {
    if (panelSearchTimer) clearTimeout(panelSearchTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      results.hidden = true;
      results.innerHTML = '';
      return;
    }
    panelSearchTimer = setTimeout(() => void runPanelSearch(q), 350);
  });
}

async function runPanelSearch(q: string): Promise<void> {
  if (!serverCfg) return;
  const reqId = ++panelSearchReqId;
  const results = $('m-search-results');
  try {
    const [tracksByTitle, tracksByArtist, albums, artists] = await Promise.all([
      searchLibraryTracks(serverCfg, { title: q, artist: '', limit: 8 }),
      searchLibraryTracks(serverCfg, { title: '', artist: q, limit: 8 }).catch(() => [] as LibraryTrack[]),
      searchLibraryAlbums(serverCfg, q, 5).catch(() => [] as LibraryAlbum[]),
      searchLibraryArtists(serverCfg, q, 5).catch(() => [] as LibraryArtist[]),
    ]);
    if (reqId !== panelSearchReqId) return;

    // Merge tracks, dedupe.
    const seen = new Set<number>();
    const tracks: LibraryTrack[] = [];
    for (const t of [...tracksByTitle, ...tracksByArtist]) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        tracks.push(t);
      }
    }

    results.innerHTML = '';
    let hasAny = false;

    if (artists.length) {
      hasAny = true;
      results.appendChild(searchSecHeader('Artists'));
      for (const a of artists.slice(0, 5)) {
        results.appendChild(
          songRowButton(a.name, 'Artist', () => void playArtistRadio(a.name)),
        );
      }
    }
    if (albums.length) {
      hasAny = true;
      results.appendChild(searchSecHeader('Albums'));
      for (const al of albums.slice(0, 5)) {
        results.appendChild(
          songRowButton(al.title, 'Album', () => void playAlbum(al.id)),
        );
      }
    }
    if (tracks.length) {
      hasAny = true;
      results.appendChild(searchSecHeader('Tracks'));
      for (const t of tracks.slice(0, 8)) {
        const e = toQueueEntry(t);
        results.appendChild(
          songRowButton(t.title, t.artist, () => {
            enrichQueueArtwork(e);
            void action({ type: 'player:playNow', entry: e });
          }),
        );
      }
    }
    if (!hasAny) {
      const empty = document.createElement('div');
      empty.className = 'disco-empty';
      empty.textContent = `No results for "${q}"`;
      results.appendChild(empty);
    }
    results.hidden = false;
  } catch {
    results.hidden = true;
  }
}

function searchSecHeader(label: string): HTMLElement {
  const h = document.createElement('div');
  h.className = 'disco-search-sec';
  h.textContent = label;
  return h;
}

void init();
