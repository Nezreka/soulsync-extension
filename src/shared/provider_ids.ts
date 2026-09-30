/**
 * Provider-native IDs parsed from page URLs. Every badged provider puts the
 * ID of the thing the page is about in the URL path — scraping DOM text when
 * a clean ID is sitting in location.pathname is doing it the hard way.
 *
 * Shapes (verified Sep 2026):
 * - Deezer:  /us/album/674017741, /us/artist/123  (locale prefix optional)
 * - Spotify: /album/1oD8P4... , /artist/5K4W6...
 * - Tidal:   /browse/album/12345678, /browse/artist/12345678
 *
 * Deezer also gets a public, unauthenticated JSON API
 * (https://api.deezer.com/album/{id}) that returns the exact tracklist —
 * the background fetches it (the response has no CORS headers, so the
 * content script cannot). Spotify/Tidal/SoundCloud have no public
 * equivalent; their IDs are captured for future exact matching.
 */

/** Numeric Deezer album ID from a deezer.com pathname, or null. */
export function deezerAlbumIdFromPath(pathname: string): string | null {
  const m = pathname.match(/(?:^|\/)(?:[a-z]{2}\/)?album\/(\d+)/i);
  return m ? m[1] : null;
}

/** Numeric Deezer artist ID from a deezer.com pathname, or null. */
export function deezerArtistIdFromPath(pathname: string): string | null {
  const m = pathname.match(/(?:^|\/)(?:[a-z]{2}\/)?artist\/(\d+)/i);
  return m ? m[1] : null;
}

/**
 * The provider-native ID of the page's subject, from the URL pathname.
 * Returns null when the URL carries no usable ID (never invent one).
 */
export function providerIdFromPath(
  provider: string | undefined,
  pathname: string,
): string | null {
  if (provider === 'deezer') {
    return deezerAlbumIdFromPath(pathname) ?? deezerArtistIdFromPath(pathname);
  }
  if (provider === 'spotify') {
    const m = pathname.match(/\/(?:intl-[a-z-]+\/)?(album|artist|track)\/([A-Za-z0-9]+)/);
    return m ? m[2] : null;
  }
  if (provider === 'tidal') {
    const m = pathname.match(/\/browse\/(album|artist)\/(\d+)/);
    return m ? m[2] : null;
  }
  return null;
}

/** Exact track titles from a Deezer /album/{id} API response. */
export function deezerAlbumTracks(data: unknown): string[] {
  const tracks = (data as { tracks?: { data?: Array<{ title?: unknown }> } } | null)?.tracks?.data;
  if (!Array.isArray(tracks)) return [];
  return tracks
    .map((t) => (typeof t?.title === 'string' ? t.title.trim() : ''))
    .filter((t) => t.length > 0);
}

/** api.deezer.com origin the background needs to fetch album tracklists. */
export const DEEZER_API_ORIGIN = 'https://api.deezer.com/*';
