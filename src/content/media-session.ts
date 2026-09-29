import browser from 'webextension-polyfill';
import type { NowPlaying } from '../shared/types.js';

/**
 * Reads the page's Media Session metadata on demand. No audio capture, no
 * polling: the popup asks for fresh metadata every time it opens (Media
 * Session exposes no change events).
 */
function readNowPlaying(): NowPlaying | null {
  const md = navigator.mediaSession?.metadata;
  if (!md?.title) return null;
  const art = md.artwork && md.artwork.length > 0 ? md.artwork[md.artwork.length - 1].src : '';
  return {
    title: md.title ?? '',
    artist: md.artist ?? '',
    album: md.album ?? '',
    artwork: art ?? '',
  };
}

browser.runtime.onMessage.addListener((message: unknown) => {
  if ((message as { type?: string })?.type === 'SOULSYNC_GET_NOW_PLAYING') {
    return Promise.resolve({ nowPlaying: readNowPlaying() });
  }
  return false;
});
