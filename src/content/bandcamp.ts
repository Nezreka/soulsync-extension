import browser from 'webextension-polyfill';
import type { ReleaseInfo } from '../shared/types.js';
import { artistName, jsonLdOfType, metaTag, trackTitles } from '../shared/dom.js';

/** Bandcamp's og:title is "Album Name, by Artist" (same on track pages). */
function splitOgTitle(og: string): { title: string; artist: string } | null {
  const m = og.match(/^(.*),\s+by\s+(.+)$/i);
  if (!m) return null;
  return { title: m[1].trim(), artist: m[2].trim() };
}

function extract(): ReleaseInfo | null {
  try {
    const ld = jsonLdOfType(/MusicAlbum|MusicRelease/);
    const ogTitle = metaTag('og:title');
    const split = ogTitle ? splitOgTitle(ogTitle) : null;
    const title = (ld?.name as string) || split?.title || ogTitle;
    if (!title) return null;
    const artist =
      artistName(ld?.byArtist) ||
      split?.artist ||
      document.querySelector('#band-name-location .title')?.textContent?.trim() ||
      '';
    let tracks = trackTitles(['.track_list .track-title', 'tr.track_row .track-title']);
    if (tracks.length === 0) tracks = [title]; // track page, not an album page
    return {
      source: 'bandcamp',
      artist,
      title,
      label: '',
      pageUrl: location.href,
      tracks,
    };
  } catch {
    return null;
  }
}

browser.runtime.onMessage.addListener((message: unknown) => {
  if ((message as { type?: string })?.type === 'SOULSYNC_GET_RELEASE') {
    return Promise.resolve({ release: extract() });
  }
  return false;
});
