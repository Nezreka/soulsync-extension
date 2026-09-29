export interface ServerConfig {
  /** e.g. "http://192.168.1.10:8080" — no trailing slash */
  url: string;
  /** SoulSync API key, generated on the server's Settings page */
  apiKey: string;
}

export interface NowPlaying {
  title: string;
  artist: string;
  album: string;
  /** best artwork URL the page exposed; may be "" */
  artwork: string;
}

export interface ParsedTrack {
  artist: string;
  title: string;
  /** original line, kept so failures can be shown instead of dropped */
  raw: string;
  ok: boolean;
}

export type ReleaseSource = 'bandcamp' | 'beatport' | 'spotify' | 'soundcloud' | 'deezer' | 'tidal';

export interface ReleaseInfo {
  source: ReleaseSource;
  artist: string;
  title: string;
  label: string;
  pageUrl: string;
  tracks: string[];
}

/** Messages the popup sends to content scripts. */
export type ContentRequest = { type: 'SOULSYNC_GET_NOW_PLAYING' } | { type: 'SOULSYNC_GET_RELEASE' };

/**
 * Cleans media-session metadata, which on YouTube-style pages is channel
 * garbage: artist = "KendrickLamarVEVO", title = "Kendrick Lamar - Not Like Us".
 * When the title already holds an "Artist - Title" split AND the reported
 * artist looks like a channel name (VEVO/Topic/Official/… suffix) or a
 * spaceless squish of the title's artist part, the title split wins.
 * Genuine titles with " - " (e.g. "Rabbit Run - From '8 Mile' Soundtrack")
 * are left alone unless the artist smells like a channel.
 */
/** Strip video-page cruft like "(Official Video)" from a title. Only strips
 *  when the marker is parenthesized/bracketed (or a trailing " - …") at the
 *  very end — meaningful tags like (feat. X) or (Remix) are left alone. */
export function stripVideoCruft(title: string): string {
  return title
    .replace(/\s*[[(]\s*official\s+(music\s+)?video\s*[\])]\s*$/i, '')
    .replace(/\s*[[(]\s*(music|lyric)\s+video\s*[\])]\s*$/i, '')
    .replace(/\s*[[(]\s*official\s+(lyric\s+)?audio\s*[\])]\s*$/i, '')
    .replace(/\s*[[(]\s*visualizer\s*[\])]\s*$/i, '')
    .replace(/\s+-\s*official\s+(music\s+)?video\s*$/i, '')
    .trim();
}

export function cleanNowPlaying(np: NowPlaying): NowPlaying {
  const title = stripVideoCruft(np.title);
  const cleaned = { ...np, title };
  const dash = cleaned.title.indexOf(' - ');
  if (dash <= 0) return cleaned;
  const tArtist = cleaned.title.slice(0, dash).trim();
  const tTitle = stripVideoCruft(cleaned.title.slice(dash + 3).trim());
  if (!tArtist || !tTitle) return cleaned;

  const squish = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const channelish = /(vevo|topic|official|records|music|tv|channel)$|vevo|topic/i.test(np.artist);
  const squishedMatch = squish(np.artist).replace(/(vevo|topic|official|music|records|tv|channel)$/, '').length > 0 &&
    (squish(np.artist).includes(squish(tArtist)) || squish(tArtist).includes(squish(np.artist).replace(/(vevo|topic|official|music|records|tv|channel)$/, '')));

  if (channelish || squishedMatch) {
    return { ...np, artist: tArtist, title: tTitle };
  }
  return cleaned;
}
