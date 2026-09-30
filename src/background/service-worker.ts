import browser from 'webextension-polyfill';
import type { BadgeCandidate } from '../shared/api.js';
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

async function handleBadgeAction(m: BadgeAction): Promise<Record<string, unknown>> {
  const cfg = await getConfig();
  if (!cfg) return { error: 'No server configured — open the extension options first.' };
  try {    if (m.action === 'resolve-artist') {
      const hits = await searchArtists(cfg, m.name, 5);
      const best = pickBestArtist(hits, m.name);
      if (!best) return { error: `Couldn't match "${m.name}" on your server.` };
      return { id: best.id, name: best.name, image: best.image, source: best.source };
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
      const watching = await checkWatchlist(cfg, m.id);
      return { watching };
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
      const link = await resolveLibraryLink(cfg, m.kind, m.name, m.artist);
      return { url: link.url, exact: link.exact };
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
  return false;
});
