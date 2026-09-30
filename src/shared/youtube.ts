/**
 * YouTube badge helpers: parse artist/track from YouTube page metadata.
 *
 * Pure string parsing — no DOM access here, so it's unit-testable. The
 * content script (page-badges.ts) supplies the DOM values (og:title,
 * video title, channel name) and calls these to decide what to badge.
 *
 * Design rules:
 * - Channel pages: artist from og:title ("Drake"; Topic channels are
 *   "Drake - Topic").
 * - Watch pages: "Artist - Track" split on " - ". Topic channels with a
 *   bare track title use the channel name for the artist.
 * - Shorts, search, feeds, and music.youtube.com have no reliable artist
 *   signal and are intentionally skipped.
 */

/** Channel pages: artist from og:title ("Drake"; Topic channels are "Drake - Topic"). */
export function channelArtistFromOgTitle(ogTitle: string): string {
  const t = ogTitle.trim();
  if (!t) return '';
  const m = t.match(/^(.*?)\s+-\s+topic$/i);
  return (m ? m[1] : t).trim();
}

/** Watch pages: artist is the part before " - " in the video title. */
export function artistFromVideoTitle(videoTitle: string): string {
  const t = videoTitle.trim();
  const idx = t.indexOf(' - ');
  if (idx <= 0) return ''; // no separator, or leading separator — no badge
  return t.slice(0, idx).trim();
}

/**
 * Split a multi-artist string into individual artist names.
 * "Post Malone, Swae Lee" -> ["Post Malone", "Swae Lee"].
 * Handles comma, "&", "and", "x", "feat."/"featuring"/"ft.", "with"
 * separators. The watchlist API must never receive the combined string as
 * a single name — callers split first, then check/add each artist alone.
 */
export function splitArtists(artistStr: string): string[] {
  const t = artistStr.trim();
  if (!t) return [];
  const parts = t
    .split(/\s*,\s*/)
    .flatMap((p) => p.split(/\s+(?:&|and|x|feat\.?|featuring|ft\.?|with)\s+/i))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // Dedupe, preserving order ("Post Malone, Post Malone" -> one).
  return [...new Set(parts)];
}

/** Which YouTube paths get badges: channels only. */
export function isYoutubeChannelPath(path: string): boolean {
  return (
    path.startsWith('/@') ||
    path.startsWith('/channel/') ||
    path.startsWith('/c/') ||
    path.startsWith('/user/')
  );
}

/** Which YouTube hosts get badges: youtube.com variants, NOT music.youtube.com. */
export function isBadgedYoutubeHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'music.youtube.com' || h.endsWith('.music.youtube.com')) return false;
  return h === 'youtube.com' || h.endsWith('.youtube.com');
}

/** Suffixes stripped from video titles when extracting the track name. */
const TITLE_SUFFIXES = [
  /\(official\s+(music\s+)?video\)\s*$/i,
  /\(official\s+audio\)\s*$/i,
  /\(lyrics?\)\s*$/i,
  /\[official\s+(music\s+)?video\]\s*$/i,
  /\[official\s+audio\]\s*$/i,
  // Dash-separated forms: "Song - Official Video", "Song - Official Music Video",
  // "Song - Official Audio", "Song - Lyric Video". The leading " - " is part
  // of the suffix so "I Won't Let You Down - Official Video" -> "I Won't Let You Down".
  /\s+-\s*official\s+(music\s+)?video\s*$/i,
  /\s+-\s*official\s+audio\s*$/i,
  /\s+-\s*lyrics?\s*(video)?\s*$/i,
  /\s+-\s*music\s+video\s*$/i,
];

function stripTitleSuffix(title: string): string {
  let t = title.trim();
  // Loop until stable: titles can stack suffixes ("Song - Official Video (Official Audio)").
  for (let i = 0; i < 4; i++) {
    let next = t;
    for (const re of TITLE_SUFFIXES) {
      next = next.replace(re, '').trim();
    }
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Parse a YouTube watch-page video title into { artist, title }.
 * - "Artist - Track" titles split on " - " (even on Topic channels).
 * - Topic channels ("Artist - Topic") with a bare track title use the
 *   channel name for the artist.
 * Returns null when no reliable artist/track can be extracted — no badge.
 */
export function trackFromVideoTitle(
  videoTitle: string,
  channelName: string,
): { artist: string; title: string } | null {
  const raw = videoTitle.trim();
  if (!raw) return null;

  const idx = raw.indexOf(' - ');
  if (idx > 0) {
    const artist = raw.slice(0, idx).trim();
    const title = stripTitleSuffix(raw.slice(idx + 3));
    if (!artist || !title) return null;
    return { artist, title };
  }

  const topicMatch = channelName.trim().match(/^(.*?)\s+-\s+topic$/i);
  if (topicMatch) {
    const artist = topicMatch[1].trim();
    const title = stripTitleSuffix(raw);
    if (!artist || !title) return null;
    return { artist, title };
  }

  return null;
}
