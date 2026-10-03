/* SoulSync Companion — cover-art lookup for library tracks.
 *
 * The server's serialize_track rows carry no artwork field
 * (src/shared/player-api.ts::mapLibraryTrack — artworkUrl is always null),
 * so the player fills covers in from the public Deezer search API instead.
 * Deezer needs no auth and the manifest already grants
 * https://api.deezer.com/* host permission, which lets extension pages
 * (popup, mini player) fetch it directly — no CORS problem there.
 *
 * Lookups are best-effort and never block playback: callers play first,
 * then call lookupCoverArt() and push the result into the queue via the
 * `player:setArtwork` message. Hits AND misses are cached (30 days) so an
 * obscure track costs one HTTP request ever.
 */
import browser from 'webextension-polyfill';

const CACHE_KEY = 'artworkCache.v1';
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const CACHE_MAX = 500;

interface CacheRow {
  url: string | null;
  at: number;
}

const mem = new Map<string, CacheRow>();
let memLoaded = false;

/** Folded key form: lowercase, accents stripped, punctuation → spaces. */
export function normKey(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Cache key for an artist/title pair. */
export function artworkCacheKey(artist: string, title: string): string {
  return `${normKey(artist)}|${normKey(title)}`;
}

/**
 * Clean a title for the Deezer query: drop "(feat. …)" parentheticals and
 * "- Official Video"-style suffixes that never match the catalog title.
 */
export function cleanQueryTitle(title: string): string {
  return title
    .replace(/\s*[([].*?\bfeat\.?.*?[)\]]\s*/gi, ' ')
    .replace(/\s*-\s*(official video|official audio|lyric video|music video|visualizer)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface DeezerAlbum {
  cover?: unknown;
  cover_small?: unknown;
  cover_medium?: unknown;
  cover_big?: unknown;
  cover_xl?: unknown;
}

interface DeezerTrack {
  title?: unknown;
  artist?: { name?: unknown };
  album?: DeezerAlbum;
}

function coverOf(r: DeezerTrack): string | null {
  const a = r.album ?? {};
  // Prefer the 500px cover; fall back down the size ladder.
  for (const k of ['cover_big', 'cover_medium', 'cover', 'cover_small', 'cover_xl'] as const) {
    const v = a[k];
    if (typeof v === 'string' && v.startsWith('http')) return v;
  }
  return null;
}

/**
 * Score a Deezer result against the wanted artist/title. Exact folded
 * matches outrank partial ones; artist agreement breaks title ties (so a
 * cover version doesn't steal the artwork).
 */
function scoreResult(r: DeezerTrack, wantTitle: string, wantArtist: string): number {
  const t = normKey(String(r.title ?? ''));
  const a = normKey(String(r.artist?.name ?? ''));
  let s = 0;
  if (t === wantTitle) s += 4;
  else if (t && (t.includes(wantTitle) || wantTitle.includes(t))) s += 2;
  if (a === wantArtist) s += 3;
  else if (a && wantArtist && (a.includes(wantArtist) || wantArtist.includes(a))) s += 1;
  return s;
}

/**
 * Pick the best cover from Deezer search results: highest artist/title
 * score wins, falling back to the first result that has any cover.
 */
export function pickCover(
  results: DeezerTrack[],
  wantTitle: string,
  wantArtist = '',
): string | null {
  const wt = normKey(wantTitle);
  const wa = normKey(wantArtist);
  let best: string | null = null;
  let bestScore = -1;
  let fallback: string | null = null;
  for (const r of results) {
    const cover = coverOf(r);
    if (!cover) continue;
    if (fallback === null) fallback = cover;
    const s = scoreResult(r, wt, wa);
    if (s > bestScore) {
      bestScore = s;
      best = cover;
    }
  }
  // Only trust a scored winner when it actually matched something;
  // otherwise the top hit is usually still the right track.
  return bestScore > 0 ? best : fallback;
}

async function loadMem(): Promise<void> {
  if (memLoaded) return;
  memLoaded = true;
  try {
    const s = (await browser.storage.local.get(CACHE_KEY)) as Record<string, unknown>;
    const raw = s[CACHE_KEY];
    if (raw && typeof raw === 'object') {
      const now = Date.now();
      for (const [k, v] of Object.entries(raw as Record<string, CacheRow>)) {
        if (v && typeof v.at === 'number' && now - v.at < CACHE_TTL_MS) mem.set(k, v);
      }
    }
  } catch {
    /* cache is best-effort — a dead cache never breaks artwork */
  }
}

async function readCache(key: string): Promise<string | null | undefined> {
  await loadMem();
  const row = mem.get(key);
  if (!row) return undefined;
  if (Date.now() - row.at >= CACHE_TTL_MS) {
    mem.delete(key);
    return undefined;
  }
  return row.url;
}

async function writeCache(key: string, url: string | null): Promise<void> {
  await loadMem();
  mem.set(key, { url, at: Date.now() });
  // Cap the cache: evict the oldest rows first.
  if (mem.size > CACHE_MAX) {
    const entries = [...mem.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of entries.slice(0, mem.size - CACHE_MAX)) mem.delete(k);
  }
  try {
    await browser.storage.local.set({ [CACHE_KEY]: Object.fromEntries(mem) });
  } catch {
    /* ignore */
  }
}

/**
 * Resolve cover art for an artist/title pair via the public Deezer search
 * API. Returns the cover URL or null. Never throws — artwork is cosmetic.
 */
export async function lookupCoverArt(artist: string, title: string): Promise<string | null> {
  const key = artworkCacheKey(artist, title);
  const hit = await readCache(key);
  if (hit !== undefined) return hit;

  let url: string | null = null;
  try {
    // Plain combined query: Deezer's field-qualified syntax
    // (artist:"x" track:"y") currently returns zero results, so match the
    // best hit in code instead.
    const q = `${cleanQueryTitle(artist)} ${cleanQueryTitle(title)}`.trim();
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=8`);
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
      const data = body?.data;
      if (Array.isArray(data)) url = pickCover(data as DeezerTrack[], title, artist);
    }
  } catch {
    /* best-effort */
  }
  await writeCache(key, url);
  return url;
}
