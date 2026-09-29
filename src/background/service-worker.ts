import browser from 'webextension-polyfill';
import type { BadgeCandidate } from '../shared/api.js';
import type { ReleaseSource } from '../shared/types.js';
import {
  getConfig,
  lookupBadgeStatuses,
  pickBestArtist,
  searchArtists,
  serverOrigin,
  watchArtist,
  wishlistRelease,
} from '../shared/api.js';

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
  | {
      type: 'SOULSYNC_BADGE_ACTION';
      action: 'watch-artist';
      id: string;
      name: string;
      source?: string;
    }
  | {
      type: 'SOULSYNC_BADGE_ACTION';
      action: 'wishlist-album';
      artist: string;
      title: string;
      tracks: string[];
      pageUrl: string;
      provider?: string;
    };

const RELEASE_SOURCES: ReadonlySet<string> = new Set([
  'bandcamp',
  'beatport',
  'spotify',
  'soundcloud',
  'deezer',
  'tidal',
]);

/** Badge provider → ReleaseInfo source. Falls back to 'bandcamp' only when
 *  the content script sent no provider (defensive; matched hosts always set
 *  it from the verified hostname). */
function toReleaseSource(provider: string | undefined): ReleaseSource {
  return (provider && RELEASE_SOURCES.has(provider) ? provider : 'bandcamp') as ReleaseSource;
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
    if (m.action === 'watch-artist') {
      await watchArtist(cfg, m.id, m.name, m.source);
      return { ok: true };
    }
    if (m.action === 'wishlist-album') {
      const n = await wishlistRelease(cfg, {
        source: toReleaseSource(m.provider),
        artist: m.artist,
        title: m.title,
        label: '',
        pageUrl: m.pageUrl,
        tracks: m.tracks,
      });
      return { ok: true, tracks: n };
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
  if (m?.type === 'SOULSYNC_BADGE_ACTION') {
    return handleBadgeAction(m as BadgeAction);
  }
  return false;
});
