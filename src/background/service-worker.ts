/// <reference types="chrome" />
import browser from 'webextension-polyfill';
import { startAudioHost } from '../player/host.js';
import { libraryAudioUrl } from '../shared/player-api.js';
import type { BadgeCandidate, VideoSearchHit } from '../shared/api.js';
import type { ServerConfig } from '../shared/types.js';
import { deezerAlbumTracks } from '../shared/provider_ids.js';
import type { ReleaseSource } from '../shared/types.js';
import {
  addToWishlist,
  checkWatchlist,
  deezerPlaylistTrackToMirror,
  getConfig,
  getDeezerPlaylistTracks,
  getSpotifyPlaylistTracks,
  lookupBadgeStatuses,
  searchVideo,
  videoInLibrary,
  episodeInLibrary,
  videoOnWishlist,
  showOnWatchlist,
  addVideoToWishlist,
  addShowToWatchlist,
  removeShowFromWatchlist,
  searchPerson,
  personOnWatchlist,
  addPersonToWatchlist,
  removePersonFromWatchlist,
  mirrorPlaylist,
  normName,
  pickBestArtist,
  preparePlaylistDiscovery,
  resolveLibraryLink,
  resolveMirroredPlaylist,
  searchArtists,
  serverOrigin,
  spotifyPlaylistTrackToMirror,
  unwatchArtist,
  watchArtist,
  wishlistRelease,
} from '../shared/api.js';
import type { DeezerPlaylistTrack, SpotifyPlaylistTrack } from '../shared/api.js';

const MENU_ID = 'soulsync-send-selection';
const PENDING_KEY = 'pendingSelection';

browser.runtime.onInstalled.addListener(async () => {
  await browser.contextMenus.removeAll().catch(() => undefined);
  browser.contextMenus.create({
    id: MENU_ID,
    title: 'Send to SoulSync',
    contexts: ['selection'],
  });
});

browser.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || typeof info.selectionText !== 'string') return;
  // Stash the raw selection; the popup's text-import view picks it up.
  await browser.storage.session.set({ [PENDING_KEY]: info.selectionText });
  // Best effort: pop the popup so the user can review the parse immediately.
  // openPopup() needs a user gesture and can fail (e.g. no focusable window);
  // the pending text survives until the next popup open regardless.
  try {
    await browser.action.openPopup();
  } catch {
    /* picked up on next open */
  }
});

/* ── page badges ── */

export type BadgeAction =
  | { type: 'SOULSYNC_BADGE_ACTION'; action: 'resolve-artist'; name: string }
  | { type: 'SOULSYNC_BADGE_ACTION'; action: 'search-artists'; query: string }
  | {
      type: 'SOULSYNC_BADGE_ACTION';
      action: 'watch-artist';
      id: string;
      name: string;
      source?: string;
    }
  | {
      type: 'SOULSYNC_BADGE_ACTION';
      action: 'unwatch-artist';
      id: string;
      name: string;
    }
  | { type: 'SOULSYNC_BADGE_ACTION'; action: 'check-watchlist'; id: string }
  | {
      type: 'SOULSYNC_BADGE_ACTION';
      action: 'wishlist-album';
      artist: string;
      title: string;
      tracks: string[];
      pageUrl: string;
      provider?: string;
    }
  | {
      type: 'SOULSYNC_BADGE_ACTION';
      action: 'wishlist-track';
      artist: string;
      title: string;
    }
  | {
      type: 'SOULSYNC_BADGE_ACTION';
      action: 'library-link';
      kind: 'artist' | 'album' | 'track';
      name: string;
      artist?: string;
    }
  | {
      type: 'SOULSYNC_BADGE_ACTION';
      action: 'save-playlist';
      source: 'spotify' | 'deezer';
      playlistId: string;
      name: string;
    }
  | {
      type: 'SOULSYNC_BADGE_ACTION';
      action: 'check-saved-playlist';
      source: 'spotify' | 'deezer';
      playlistId: string;
    };

export type VideoBadgeAction =
  | {
      type: 'SOULSYNC_VIDEO_BADGE_ACTION';
      action: 'check-video';
      title: string;
      year: number | null;
      kind: 'movie' | 'show';
      tmdbId?: number;
      provider?: string;
      episode?: { season: number; episode: number };
    }
  | {
      type: 'SOULSYNC_VIDEO_BADGE_ACTION';
      action: 'wishlist-video';
      title: string;
      year: number | null;
      kind: 'movie' | 'show';
      tmdbId?: number;
      provider?: string;
      episode?: { season: number; episode: number };
    }
  | {
      type: 'SOULSYNC_VIDEO_BADGE_ACTION';
      action: 'watch-show';
      title: string;
      year: number | null;
      tmdbId?: number;
    }
  | {
      type: 'SOULSYNC_VIDEO_BADGE_ACTION';
      action: 'unwatch-show';
      title: string;
      year: number | null;
      tmdbId?: number;
    }
  | {
      type: 'SOULSYNC_VIDEO_BADGE_ACTION';
      action: 'check-person';
      name: string;
      tmdbId?: number;
    }
  | {
      type: 'SOULSYNC_VIDEO_BADGE_ACTION';
      action: 'watch-person';
      name: string;
      tmdbId?: number;
    }
  | {
      type: 'SOULSYNC_VIDEO_BADGE_ACTION';
      action: 'unwatch-person';
      name: string;
      tmdbId?: number;
    };

const RELEASE_SOURCES: ReadonlySet<string> = new Set([
  'bandcamp',
  'beatport',
  'spotify',
  'soundcloud',
  'deezer',
  'tidal',
  'youtube',
]);

/**
 * Validate a badge page provider. Returns it when it is a known source,
 * otherwise undefined — we never invent a provider. (Provenance only; the
 * wishlist pipeline uses the server's automatic source.)
 */
function asReleaseSource(provider: string | undefined): ReleaseSource | undefined {
  return provider && RELEASE_SOURCES.has(provider) ? (provider as ReleaseSource) : undefined;
}

// Throttle badge checks: SoulSync rate-limits aggressive bursts from
// card grids (music album/artist cards, video rec rails).
const badgeCheckQueue: Array<() => void> = [];
let badgeCheckRunning = false;
async function throttledBadgeCheck<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    badgeCheckQueue.push(async () => {
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      }
    });
    void drainBadgeCheckQueue();
  });
}
let badgeCheckDelayMs = 150; // adaptive: backs off on 429
async function drainBadgeCheckQueue(): Promise<void> {
  if (badgeCheckRunning) return;
  badgeCheckRunning = true;
  while (badgeCheckQueue.length > 0) {
    const fn = badgeCheckQueue.shift()!;
    try {
      await fn();
      // Success: ease back toward the fast rate.
      badgeCheckDelayMs = Math.max(150, Math.floor(badgeCheckDelayMs * 0.9));
    } catch (e) {
      // 429 or error: back off.
      const msg = String(e);
      if (msg.includes('429') || msg.includes('Too many requests')) {
        badgeCheckDelayMs = Math.min(2000, badgeCheckDelayMs * 2);
      }
      throw e;
    }
    await new Promise((r) => setTimeout(r, badgeCheckDelayMs));
  }
  badgeCheckRunning = false;
}
// Back-compat alias.
const throttledVideoCheck = throttledBadgeCheck;

async function handleBadgeAction(m: BadgeAction): Promise<Record<string, unknown>> {
  const cfg = await getConfig();
  if (!cfg) return { error: 'No server configured — open the extension options first.' };
  try {    if (m.action === 'resolve-artist') {
      return throttledBadgeCheck(async () => {
        const hits = await searchArtists(cfg, m.name, 5);
        const best = pickBestArtist(hits, m.name);
        if (!best) return { error: `Couldn't match "${m.name}" on your server.` };
        return { id: best.id, name: best.name, image: best.image, source: best.source };
      });
    }
    if (m.action === 'search-artists') {
      const hits = await searchArtists(cfg, m.query, 8);
      return {
        artists: hits.map((h) => ({ id: h.id, name: h.name, image: h.image, source: h.source })),
      };
    }
    if (m.action === 'watch-artist') {
      await watchArtist(cfg, m.id, m.name, m.source);
      return { ok: true };
    }
    if (m.action === 'unwatch-artist') {
      await unwatchArtist(cfg, m.id);
      return { ok: true };
    }
    if (m.action === 'check-watchlist') {
      return throttledBadgeCheck(async () => {
        const watching = await checkWatchlist(cfg, m.id);
        return { watching };
      });
    }
    if (m.action === 'wishlist-album') {
      const n = await wishlistRelease(cfg, {
        source: asReleaseSource(m.provider),
        artist: m.artist,
        title: m.title,
        label: '',
        pageUrl: m.pageUrl,
        tracks: m.tracks,
      });
      return { ok: true, tracks: n };
    }
    if (m.action === 'wishlist-track') {
      const r = await addToWishlist(cfg, { artist: m.artist, title: m.title });
      return { ok: true, title: r.title, created: r.created };
    }
    if (m.action === 'library-link') {
      return throttledBadgeCheck(async () => {
        const link = await resolveLibraryLink(cfg, m.kind, m.name, m.artist);
        return { url: link.url, exact: link.exact };
      });
    }
    if (m.action === 'check-saved-playlist') {
      // Tri-state: {saved: true/false}, or {saved: null} when the check
      // itself failed — the pill shows "unknown", never a false "not saved".
      try {
        const r = await resolveMirroredPlaylist(cfg, m.source, m.playlistId);
        return { saved: r.found };
      } catch {
        return { saved: null as boolean | null };
      }
    }
    if (m.action === 'save-playlist') {
      try {
        if (!m.playlistId) return { error: 'No playlist id to save.' };
        // 1. Fetch the full tracklist from the provider via the server.
        const pl =
          m.source === 'spotify'
            ? await getSpotifyPlaylistTracks(cfg, m.playlistId)
            : await getDeezerPlaylistTracks(cfg, m.playlistId);
        const tracks =
          m.source === 'spotify'
            ? (pl.tracks as SpotifyPlaylistTrack[]).map(spotifyPlaylistTrackToMirror)
            : (pl.tracks as DeezerPlaylistTrack[]).map(deezerPlaylistTrackToMirror);
        // 2. Mirror it on the server.
        const mirroredId = await mirrorPlaylist(cfg, {
          source: m.source,
          source_playlist_id: m.playlistId,
          name: pl.name || m.name,
          description: pl.description,
          owner: pl.owner,
          image_url: pl.image_url,
          tracks,
        });
        // 3. Kick off discovery.
        await preparePlaylistDiscovery(cfg, mirroredId);
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Save playlist failed.';
        // The server 401s playlist fetches when its own Spotify isn't
        // linked — say so plainly instead of surfacing a raw 401.
        if (/spotify not authenticated/i.test(msg)) {
          return { error: 'Connect Spotify on your SoulSync server first' };
        }
        return { error: msg };
      }
    }
    return { error: 'Unknown badge action.' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Badge action failed.' };
  }
}

browser.runtime.onMessage.addListener((message: unknown) => {
async function resolveVideoHit(
  cfg: ServerConfig,
  title: string,
  year: number | null,
  kind: 'movie' | 'show',
  tmdbId?: number,
): Promise<VideoSearchHit | null> {
  // TMDB id from the URL is exact — still resolve through search for the
  // canonical title/year/poster the wishlist API wants.
  const hits = await searchVideo(cfg, tmdbId ? String(tmdbId) : title);
  if (tmdbId) {
    const exact = hits.find((h) => h.tmdbId === tmdbId);
    if (exact) return exact;
  }
  // Best text match: prefer same kind, then year proximity. Don't hard-filter
  // by kind — IMDb cards guess the kind and a wrong guess must not nuke results.
  const norm = title.toLowerCase().trim();
  const scored = hits
    .map((h) => {
      let score = 0;
      if (h.title.toLowerCase() === norm) score += 10;
      else if (h.title.toLowerCase().includes(norm) || norm.includes(h.title.toLowerCase())) score += 5;
      if (h.kind === kind) score += 3;
      if (year && h.year === year) score += 5;
      return { h, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.length > 0 && scored[0].score > 0 ? scored[0].h : null;
}

async function handleVideoBadgeAction(m: VideoBadgeAction): Promise<Record<string, unknown>> {
  const cfg = await getConfig();
  if (!cfg) return { error: 'No server configured — open the extension options first.' };
  try {
    if (m.action === 'check-video') {
      return throttledVideoCheck(async () => {
        // Episodes resolve as their show, then check the specific episode.
        const kind = m.episode ? 'show' : m.kind;
        const hit = await resolveVideoHit(cfg, m.title, m.year, kind, m.tmdbId);
        if (!hit) return { state: 'unknown', onWatchlist: null, hitKind: null };
        // For episodes, report 'movie' kind so the overlay renders the wishlist
        // badge (not the watchlist eye).
        const hitKind = m.episode ? 'movie' : hit.kind;
        if (m.episode) {
          const epInLib = await episodeInLibrary(cfg, hit.tmdbId, m.episode.season, m.episode.episode);
          const base = { onWatchlist: null, hitKind };
          if (epInLib === true) return { state: 'in-library', ...base };
          if (epInLib === null) return { state: 'unknown', ...base };
          // Episode not in library: check if it's wishlisted, else addable.
          const onWl = await videoOnWishlist(cfg, hit.tmdbId, 'show', hit.title);
          if (onWl === true) return { state: 'on-wishlist', ...base };
          return { state: 'addable', ...base };
        }
        const [inLib, onWl] = await Promise.all([
          videoInLibrary(cfg, hit.tmdbId, hit.kind, hit.title, hit.year),
          videoOnWishlist(cfg, hit.tmdbId, hit.kind, hit.title),
        ]);
        const onWatchlist = hit.kind === 'show' ? await showOnWatchlist(cfg, hit.tmdbId, hit.title) : null;
        const base = { onWatchlist, hitKind };
        if (inLib === true) return { state: 'in-library', ...base };
        if (onWl === true) return { state: 'on-wishlist', ...base };
        if (inLib === null && onWl === null) return { state: 'unknown', ...base };
        return { state: 'addable', ...base };
      });
    }
    if (m.action === 'wishlist-video') {
      // Episodes resolve as shows (the card title is the show title).
      const kind = m.episode ? 'show' : m.kind;
      const hit = await resolveVideoHit(cfg, m.title, m.year, kind, m.tmdbId);
      if (!hit) return { error: `Couldn't match "${m.title}" on your server.` };
      const ok = await addVideoToWishlist(cfg, hit, m.episode);
      return ok ? { ok: true } : { error: 'Wishlist add failed.' };
    }
    if (m.action === 'watch-show') {
      const hit = await resolveVideoHit(cfg, m.title, m.year, 'show', m.tmdbId);
      if (!hit) return { error: `Couldn't match "${m.title}" on your server.` };
      const ok = await addShowToWatchlist(cfg, hit);
      return ok ? { ok: true } : { error: 'Watchlist add failed.' };
    }
    if (m.action === 'unwatch-show') {
      const hit = await resolveVideoHit(cfg, m.title, m.year, 'show', m.tmdbId);
      if (!hit) return { error: `Couldn't match "${m.title}" on your server.` };
      const ok = await removeShowFromWatchlist(cfg, hit.tmdbId);
      return ok ? { ok: true } : { error: 'Watchlist remove failed.' };
    }
    if (m.action === 'check-person') {
      return throttledVideoCheck(async () => {
        let tmdbId = m.tmdbId ?? 0;
        let name = m.name;
        if (!tmdbId) {
          const hits = await searchPerson(cfg, name);
          const norm = name.toLowerCase().trim();
          const best = hits.find((h) => h.name.toLowerCase() === norm)
            ?? hits.find((h) => h.name.toLowerCase().includes(norm) || norm.includes(h.name.toLowerCase()))
            ?? hits[0];
          if (!best) return { onWatchlist: null };
          tmdbId = best.tmdbId;
          name = best.name;
        }
        const on = await personOnWatchlist(cfg, tmdbId, name);
        return { onWatchlist: on };
      });
    }
    if (m.action === 'watch-person' || m.action === 'unwatch-person') {
      let tmdbId = m.tmdbId ?? 0;
      let name = m.name;
      let posterUrl = '';
      if (!tmdbId) {
        const hits = await searchPerson(cfg, name);
        const norm = name.toLowerCase().trim();
        // Exact match first, then any person result (the search is already
        // name-biased; a top hit is better than a '?').
        const best = hits.find((h) => h.name.toLowerCase() === norm)
          ?? hits.find((h) => h.name.toLowerCase().includes(norm) || norm.includes(h.name.toLowerCase()))
          ?? hits[0];
        if (!best) return { onWatchlist: null };
        tmdbId = best.tmdbId;
        name = best.name;
        posterUrl = best.posterUrl;
      }
      // Re-resolve to get the poster for the watchlist add (the check-person
      // hit isn't cached across messages).
      if (!posterUrl) {
        const hits = await searchPerson(cfg, name);
        const best = hits.find((h) => h.tmdbId === tmdbId) ?? hits[0];
        if (best) {
          posterUrl = best.posterUrl;
          name = best.name;
        }
      }
      const hit = { tmdbId, name, posterUrl };
      if (!hit.tmdbId) return { error: `Couldn't match "${m.name}" on your server.` };
      const ok = m.action === 'watch-person'
        ? await addPersonToWatchlist(cfg, hit)
        : await removePersonFromWatchlist(cfg, hit.tmdbId);
      return ok ? { ok: true } : { error: 'Watchlist update failed.' };
    }
    return { error: 'Unknown video badge action.' };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Video badge action failed.' };
  }
}

  const m = message as { type?: string; items?: BadgeCandidate[] } | null;
  if (m?.type === 'SOULSYNC_BADGE_LOOKUP') {
    return (async () => {
      const cfg = await getConfig();
      if (!cfg) return { configured: false as const, results: {} };
      const results = await lookupBadgeStatuses(cfg, m.items ?? []);
      return { configured: true as const, results, serverUrl: serverOrigin(cfg) };
    })();
  }
  if (m?.type === 'SOULSYNC_WATCH_STATES') {
    // Artist pills show watchlist state ("Watching" / "Add to Watchlist"), so
    // the content script asks for it up front. Items carry a provider artist
    // ID when the page URL gave us one (direct check); otherwise we resolve
    // the name to an ID first. Tri-state per item: true/false/null.
    return (async () => {
      const cfg = await getConfig();
      if (!cfg) return { configured: false as const, results: {} };
      const items = (m as { items?: { name: string; providerId?: string }[] }).items ?? [];
      const entries = await Promise.all(
        items.map(async (it) => {
          try {
            let id = it.providerId ?? '';
            if (!id && it.name) {
              const hits = await searchArtists(cfg, it.name, 5);
              const best = pickBestArtist(hits, it.name);
              id = best?.id ?? '';
            }
            if (!id) return { watching: null as boolean | null };
            return { watching: await checkWatchlist(cfg, id) };
          } catch {
            return { watching: null as boolean | null };
          }
        }),
      );
      const results: Record<string, { watching: boolean | null }> = {};
      items.forEach((it, i) => {
        results[`artist:${normName(it.name)}`] = entries[i];
      });
      return { configured: true as const, results };
    })();
  }
  if (m?.type === 'SOULSYNC_DEEZER_TRACKS') {
    return (async () => {
      const id = (m as { id?: unknown }).id;
      if (typeof id !== 'string' || !/^\d{1,12}$/.test(id)) return { tracks: [] as string[] };
      // Deezer's public album API: exact tracklist for the album ID in the
      // page URL. No auth needed. api.deezer.com sends no CORS headers, so
      // this must run here (host permission), not in the content script.
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 10000);
        try {
          const res = await fetch(`https://api.deezer.com/album/${id}`, { signal: ctl.signal });
          if (!res.ok) return { tracks: [] as string[] };
          return { tracks: deezerAlbumTracks(await res.json().catch(() => null)) };
        } finally {
          clearTimeout(t);
        }
      } catch {
        return { tracks: [] as string[] };
      }
    })();
  }
  if (m?.type === 'SOULSYNC_BADGE_ACTION') {
    return handleBadgeAction(m as BadgeAction);
  }
  if (m?.type === 'SOULSYNC_VIDEO_BADGE_ACTION') {
    return handleVideoBadgeAction(m as VideoBadgeAction);
  }
  return false;
});

/* ── In-extension player: audio host wiring (docs/player-spec.md §4) ── */

// The runtime `chrome` global is untyped by the tsconfig ("types": []), so
// read it off globalThis with the @types/chrome namespace for its type.
// (Kept off the bare `chrome` name to avoid clashing with the
// webextension-polyfill `browser` import above.)
const extChrome: typeof chrome | undefined =
  (globalThis as unknown as { chrome?: typeof chrome }).chrome;

// Chrome exposes chrome.offscreen; Firefox does not. The packaged firefox
// build runs this same bundle as a real background page with a DOM, so it
// hosts the <audio> element directly instead of using an offscreen document.
const HAS_OFFSCREEN: boolean =
  typeof extChrome !== 'undefined' && typeof extChrome.offscreen !== 'undefined';

if (!HAS_OFFSCREEN) {
  // Firefox background page: start the audio host in this context. Defer
  // until the DOM is ready if it isn't yet (document.createElement needs it).
  const startHost = (): void => {
    startAudioHost({ resolveAudioUrl: libraryAudioUrl, getConfig });
  };
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startHost, { once: true });
  } else if (typeof document !== 'undefined') {
    startHost();
  }
}

/**
 * Defensively validate a pending-video entry: needs videoKd 'm'|'t', a
 * finite videoId, and a non-empty title. Returns an error string, or null
 * when the entry is usable.
 */
function validateVideoEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return 'missing video entry';
  const e = entry as Record<string, unknown>;
  if (e.videoKd !== 'm' && e.videoKd !== 't') return 'invalid videoKd';
  if (typeof e.videoId !== 'number' || !Number.isFinite(e.videoId)) return 'invalid videoId';
  if (typeof e.title !== 'string' || !e.title.trim()) return 'missing title';
  return null;
}

// ── In-extension player: the service worker owns the protocol ──
//
// Chrome does not reliably deliver runtime messages from extension views
// (popup, player tab) straight to the offscreen document, so the service
// worker — reachable from every context — verifies the audio host is up
// (handshake) and relays player:* requests to it. On Firefox the host runs
// in this same context, so the relay is skipped and the host's own listener
// answers directly. `player:openVideo` is handled here (needs tabs/storage).
//
// Playing indicator: the host broadcasts `player:stateChanged` on every
// status transition. The badge lives here (not in the host) because the
// Chrome offscreen document can't reliably touch browser.action.
function updateToolbarPlayingBadge(playing: boolean): void {
  try {
    if (playing) {
      void browser.action.setBadgeBackgroundColor({ color: '#22c55e' });
      void browser.action.setBadgeText({ text: '♪' });
    } else {
      void browser.action.setBadgeText({ text: '' });
    }
  } catch {
    /* badge API unavailable */
  }
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const m = message as { type?: string; relayed?: boolean; entry?: unknown } | null;
  if (m?.type === 'player:stateChanged') {
    const snap = (m as { snapshot?: { status?: string } }).snapshot;
    updateToolbarPlayingBadge(snap?.status === 'playing');
    return false;
  }
  if (m?.type === 'player:openVideo') {
    return (async () => {
      const err = validateVideoEntry(m.entry);
      if (err) return { ok: false, error: err };
      await browser.storage.session.set({ pendingVideoEntry: m.entry });
      await browser.tabs.create({ url: browser.runtime.getURL('player-tab/player.html') });
      return { ok: true };
    })();
  }
  if (m?.type === 'player:ensureHost') {
    return ensureAudioHost();
  }
  // Config lookup for the offscreen host: offscreen documents only get
  // chrome.runtime (no chrome.storage), so the worker — which has storage —
  // answers on its behalf. Handled before the relay branch below.
  if (m?.type === 'player:getConfig') {
    return (async () => {
      try {
        return (await getConfig()) ?? null;
      } catch {
        return null;
      }
    })();
  }
  // Relay player requests to the audio host. `relayed` marks our own
  // forwards so a context that hears its own message can't loop; the
  // broadcast `player:stateChanged` is fire-and-forget and never relayed.
  if (
    typeof m?.type === 'string' &&
    m.type.startsWith('player:') &&
    m.type !== 'player:stateChanged' &&
    !m.relayed
  ) {
    // Firefox: the host lives in this context — its own listener answers.
    if (!HAS_OFFSCREEN || !extChrome) return false;
    return (async () => {
      const ready = await ensureAudioHost();
      if (!ready.ok) throw new Error(ready.error);
      try {
        return await browser.runtime.sendMessage({
          ...(message as Record<string, unknown>),
          relayed: true,
        });
      } catch {
        // The host may have died since verification — drop the cached
        // verdict so the next call re-verifies (and recreates) instead of
        // failing quietly for the rest of the TTL. The popup's retry loop
        // re-runs the handshake.
        hostVerifiedUntil = 0;
        return undefined;
      }
    })();
  }
  return false;
});

type AudioHostReady = { ok: true } | { ok: false; error: string };

// A successful verification stays trusted for a while: the popup polls
// player state every second, and re-running the full handshake (plus its
// logging) on every tick is pure noise. The relay clears this the moment a
// forward actually fails, so a dead host is re-verified on the next call.
let hostVerifiedUntil = 0;
const HOST_VERIFY_TTL_MS = 30_000;

// Serialized: concurrent ensureHost callers share one handshake instead of
// racing createDocument/closeDocument against each other.
let audioHandshake: Promise<AudioHostReady> | null = null;

function ensureAudioHost(): Promise<AudioHostReady> {
  if (Date.now() < hostVerifiedUntil) return Promise.resolve({ ok: true });
  if (!audioHandshake) {
    audioHandshake = runAudioHandshake()
      .then((res) => {
        if (res.ok) hostVerifiedUntil = Date.now() + HOST_VERIFY_TTL_MS;
        return res;
      })
      .finally(() => {
        audioHandshake = null;
      });
  }
  return audioHandshake;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function runAudioHandshake(): Promise<AudioHostReady> {
  const tag = '[soulsync-player]';
  // No offscreen API (Firefox, or a Chromium without it): the host runs in
  // the background page — but only if this context has a DOM. A service
  // worker without chrome.offscreen cannot host audio at all: say so
  // plainly instead of reporting ready with no host behind it.
  if (!HAS_OFFSCREEN || !extChrome) {
    console.debug(
      tag,
      `ensureHost: no offscreen API (chrome=${typeof extChrome}, offscreen=${
        typeof extChrome?.offscreen
      }, document=${typeof document})`
    );
    if (typeof document !== 'undefined') return { ok: true }; // Firefox background page: host runs here
    return {
      ok: false,
      error: 'audio unavailable: this browser does not provide chrome.offscreen',
    };
  }
  const chromeApi = extChrome;
  // Absolute URL on purpose: a relative 'offscreen/player.html' risks
  // resolving against the service worker's own directory instead of the
  // extension root, which creates a document whose page never loads — and
  // hasDocument() still returns true for it, so every later call silently
  // talks to a host that will never answer.
  const docUrl = chromeApi.runtime.getURL('offscreen/player.html');
  let hadDocument = false;
  try {
    hadDocument = await chromeApi.offscreen.hasDocument();
    if (!hadDocument) {
      console.debug(tag, 'ensureHost: creating offscreen document');
      await chromeApi.offscreen.createDocument({
        url: docUrl,
        // The Reason enum is types-only (no runtime value) — cast the literal.
        reasons: ['AUDIO_PLAYBACK' as chrome.offscreen.Reason],
        justification: 'Play SoulSync audio in the background',
      });
      console.debug(tag, 'ensureHost: offscreen document created');
    }
    // (No "already exists" / "answered ping" logging on the happy path —
    // the popup polls every second and this would flood the console.)
  } catch (e) {
    console.error(tag, 'ensureHost: createDocument failed', e);
    return { ok: false, error: `offscreen document failed: ${errMsg(e)}` };
  }
  // Verified handshake: don't report ready until the audio host actually
  // answers a ping.
  if (await pingPlayerHost(6000)) {
    return { ok: true };
  }
  // A document we just created may still have been loading — never destroy
  // it; only a pre-existing silent document gets closed and recreated once,
  // so a bad document left behind by an earlier build heals itself.
  if (!hadDocument) {
    console.error(tag, 'ensureHost: fresh document silent after 6s');
    return { ok: false, error: 'audio host failed to start (offscreen document unresponsive)' };
  }
  console.warn(tag, 'ensureHost: stale document silent — closing and recreating');
  try {
    await chromeApi.offscreen.closeDocument();
  } catch {
    /* already gone */
  }
  // Give Chrome a beat to tear the document down before recreating.
  await new Promise((r) => setTimeout(r, 500));
  try {
    await chromeApi.offscreen.createDocument({
      url: docUrl,
      reasons: ['AUDIO_PLAYBACK' as chrome.offscreen.Reason],
      justification: 'Play SoulSync audio in the background',
    });
  } catch (e) {
    console.error(tag, 'ensureHost: recreate failed', e);
    return { ok: false, error: `offscreen recreate failed: ${errMsg(e)}` };
  }
  if (await pingPlayerHost(8000)) {
    console.debug(tag, 'ensureHost: recreated host answered ping');
    return { ok: true };
  }
  console.error(tag, 'ensureHost: audio host silent after recreate');
  return { ok: false, error: 'audio host silent after offscreen recreate' };
}

/**
 * True once the audio host answers `player:ping`. Marked relayed so this
 * context's own relay branch can't catch it and loop.
 */
async function pingPlayerHost(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = (await browser.runtime.sendMessage({ type: 'player:ping', relayed: true })) as
        | { ok?: unknown }
        | undefined;
      if (res && res.ok === true) return true;
    } catch {
      /* host not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

