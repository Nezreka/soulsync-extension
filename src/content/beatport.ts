import browser from 'webextension-polyfill';
import type { ReleaseInfo } from '../shared/types.js';
import { artistName, jsonLdOfType, metaTag, trackTitles } from '../shared/dom.js';

/**
 * Beatport extractor. Beatport's markup drifts often, so this leans on
 * JSON-LD / og: tags and keeps DOM selectors as the last fallback.
 * Verify selectors against a live release page before release.
 */
function extract(): ReleaseInfo | null {
  try {
    const ld = jsonLdOfType(/MusicAlbum|MusicRelease/);
    const title = (ld?.name as string) || metaTag('og:title');
    if (!title) return null;
    const artist = artistName(ld?.byArtist) || metaTag('og:audio:artist') || '';
    return {
      source: 'beatport',
      artist,
      title,
      label: (ld?.recordLabel as string) || '',
      pageUrl: location.href,
      tracks: trackTitles([
        '[data-testid="track-title"]',
        '.track-title',
        // last resort: any element whose class mentions track title
        '[class*="trackTitle"]',
      ]),
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
