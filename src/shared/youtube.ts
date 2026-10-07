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

/**
 * Trailer-shaped video titles: the video is (almost certainly) a movie or TV
 * trailer/teaser, not a music video and not a vlog. Checked BEFORE the
 * "Artist - Track" music parse — "Dune - Official Trailer" must never become
 * artist="Dune", track="Official Trailer".
 *
 * Strong signals always count: "official trailer", "final trailer",
 * "official teaser", "teaser trailer", "redband"/"red band". Bare "trailer"
 * or "teaser" only count with a year in the title ("Avengers: Doomsday
 * (2026) - Trailer") and never for music promos ("Album Teaser"). "Reaction"
 * videos are never the trailer itself.
 */
const TRAILER_STRONG =
  /\b(?:official|final)\s+(?:red\s*-?\s*band\s+)?trailer\b|\bseries\s+trailer\b|\bteaser\s+trailer\b|\bofficial\s+teaser\b|\bred\s*-?\s*band\b/i;
const MUSIC_PROMO = /\b(album|song|track|single|mixtape|music\s+video)\b|\bep\b|\blp\b/i;
const REACTION_VIDEO = /\breaction\b/i;

export function isTrailerTitle(videoTitle: string): boolean {
  const t = videoTitle.trim();
  if (!t || REACTION_VIDEO.test(t)) return false;
  if (TRAILER_STRONG.test(t)) return true;
  // Bare "trailer"/"teaser": needs a year, and must not be a music promo.
  if (MUSIC_PROMO.test(t)) return false;
  return /[\(\[]?\b(?:19|20)\d{2}\b[\)\]]?/.test(t) && /\b(?:trailer|teaser)\b/i.test(t);
}

/** TV signals inside a trailer title — the server re-resolves the real kind
 *  anyway; this is only a scoring hint for the lookup. */
const TV_SIGNALS =
  /\bseason\s*\d+\b|\bs\d{1,2}\s*e\d{1,2}\b|\blimited\s+series\b|\bnew\s+series\b|\bthe\s+series\b|\bepisode\b|\bseason\s+(?:premiere|finale)\b/i;

export interface TrailerInfo {
  /** Cleaned title: trailer suffixes, year, and trailing channel tag removed. */
  title: string;
  year: number | null;
  kindHint: 'movie' | 'show';
}

/** Strip one layer of trailer/teaser/redband wording from the title edges. */
function stripTrailerBits(t: string): string {
  return t
    // Suffixes: " | Official Trailer", " - Official Redband Trailer",
    // " - Teaser Trailer", " : Series Trailer"
    .replace(/\s*[-–—:|｜]\s*(?:(?:official|final)\s+)?(?:red\s*-?\s*band\s+)?trailer(?:\s+trailer)?\b.*$/i, '')
    .replace(/\s*[-–—:|｜]\s*(?:limited\s+)?series\s+trailer\b.*$/i, '')
    .replace(/\s*[-–—:|｜]\s*(?:official\s+)?teaser(?:\s+trailer)?\b.*$/i, '')
    .replace(/\s*[-–—:|｜]\s*red\s*-?\s*band\b.*$/i, '')
    // Parenthesized/bracketed: " (Official Trailer)", " [Teaser]"
    .replace(/\s*[\(\[]\s*(?:(?:official|final)\s+)?trailer(?:\s+trailer)?\b[^\)\]]*[\)\]]\s*$/i, '')
    .replace(/\s*[\(\[]\s*(?:official\s+)?teaser(?:\s+trailer)?\b[^\)\]]*[\)\]]\s*$/i, '')
    .replace(/\s*[\(\[]\s*red\s*-?\s*band\b[^\)\]]*[\)\]]\s*$/i, '')
    // Bare trailing words: "Dune Trailer", "Dune Teaser"
    .replace(/\s*\b(?:official\s+|final\s+)?trailer\b\s*$/i, '')
    .replace(/\s*\b(?:official\s+)?teaser\b\s*$/i, '')
    // Leading: "Official Trailer: Dune"
    .replace(/^\s*(?:(?:official|final)\s+)?trailer(?:\s+trailer)?\b\s*[-–—:|｜]\s*/i, '')
    .replace(/^\s*(?:official\s+)?teaser(?:\s+trailer)?\b\s*[-–—:|｜]\s*/i, '')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a trailer-shaped title into a movie/show lookup. Returns null when
 * the title isn't trailer-shaped — call isTrailerTitle() first or rely on
 * this returning null.
 */
export function parseTrailerTitle(videoTitle: string, channelName = ''): TrailerInfo | null {
  if (!isTrailerTitle(videoTitle)) return null;
  let t = videoTitle.trim();

  // Year: parenthesized/bracketed first, then a bare trailing year.
  let year: number | null = null;
  const ym = t.match(/[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]/);
  if (ym) year = parseInt(ym[1], 10);

  // Trailing "| <channel>" tag (e.g. "... | Netflix") — strip before the
  // trailer words so they sit at the edge.
  const ch = channelName.trim();
  if (ch) {
    t = t.replace(new RegExp(`\\s*[|｜]\\s*${escapeRegExp(ch)}\\s*$`, 'i'), '').trim();
  }

  for (let i = 0; i < 4; i++) {
    const next = stripTrailerBits(t);
    if (next === t) break;
    t = next;
  }

  // Bare trailing year ("Dune Part Two 2024 | Official Trailer").
  if (year === null) {
    const by = t.match(/\b((?:19|20)\d{2})\b\s*$/);
    if (by) year = parseInt(by[1], 10);
  }

  t = t
    .replace(/\s*[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]\s*/g, ' ')
    .replace(/\s*\b(?:19|20)\d{2}\b\s*$/, '')
    .replace(/\s*[-–—:|｜]\s*$/, '')
    .trim()
    .replace(/\s{2,}/g, ' ');
  if (!t) return null;
  return { title: t, year, kindHint: TV_SIGNALS.test(videoTitle) ? 'show' : 'movie' };
}

/**
 * Unambiguous music channels: auto-generated Topic channels ("Drake - Topic")
 * and official VEVO channels ("TaylorSwiftVEVO"). Everything else is treated
 * as a normal YouTube channel and gets the channel-follow pill instead of a
 * music-artist pill.
 */
export function isTopicChannelName(name: string): boolean {
  return /^.+?\s+-\s+topic$/i.test(name.trim());
}

export function isVevoChannelName(name: string): boolean {
  // VEVO channels run the handle together ("TaylorSwiftVEVO") or spaced
  // ("Ariana Grande Vevo") — no word boundary before "vevo".
  return /vevo$/i.test(name.trim());
}

export function isMusicChannelName(name: string): boolean {
  return isTopicChannelName(name) || isVevoChannelName(name);
}

/** Which YouTube paths get badges: channel pages (/@handle, /channel/, /c/, /user/). */
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
