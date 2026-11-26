import browser from 'webextension-polyfill';
import type { NowPlaying } from '../shared/types.js';
import { parseSoundcloudUrl } from '../shared/soundcloud.js';

/**
 * Reads the page's Media Session metadata on demand. No audio capture, no
 * polling: the popup asks for fresh metadata every time it opens (Media
 * Session exposes no change events).
 */
function readNowPlaying(): NowPlaying | null {
  const md = navigator.mediaSession?.metadata;
  if (!md?.title) return null;
  const art = md.artwork && md.artwork.length > 0 ? md.artwork[md.artwork.length - 1].src : '';
  const np: NowPlaying = {
    title: md.title ?? '',
    artist: md.artist ?? '',
    album: md.album ?? '',
    artwork: art ?? '',
  };
  const sourceUrl = soundcloudPlayingUrl();
  if (sourceUrl) np.sourceUrl = sourceUrl;
  return np;
}

/** SoundCloud: the PLAYING track's page, from the player bar's title link
 *  (the tab may be showing a different page). Kept only when it is a track
 *  link — never a set or profile. */
function soundcloudPlayingUrl(): string | undefined {
  if (!/(^|\.)soundcloud\.com$/i.test(location.hostname)) return undefined;
  const link = document.querySelector<HTMLAnchorElement>('a.playbackSoundBadge__titleLink');
  const parsed = parseSoundcloudUrl(link?.href ?? '');
  return parsed.kind === 'track' ? parsed.url : undefined;
}

browser.runtime.onMessage.addListener((message: unknown) => {
  if ((message as { type?: string })?.type === 'SOULSYNC_GET_NOW_PLAYING') {
    return Promise.resolve({ nowPlaying: readNowPlaying() });
  }
  return false;
});
