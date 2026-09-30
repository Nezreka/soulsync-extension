import browser from 'webextension-polyfill';
import { artistName, jsonLdOfType, metaTag, trackTitles } from '../shared/dom.js';
import { providerIdFromPath, deezerAlbumIdFromPath, deezerArtistIdFromPath } from '../shared/provider_ids.js';
import {
  artistFromVideoTitle,
  channelArtistFromOgTitle,
  isBadgedYoutubeHost,
  isYoutubeChannelPath,
  splitArtists,
  trackFromVideoTitle,
} from '../shared/youtube.js';
import { BADGES_ENABLED_KEY, badgesEnabledFromStored, normName } from '../shared/api.js';

/**
 * Page badges: tiny library-status pills next to artist/album names.
 *
 * Design rules (best-in-class means restraint):
 * - Site-specific extractors only. No generic text scanning — that path
 *   leads to false positives on words like "Home" or "Greatest Hits".
 * - Badges never throw: a missing anchor skips the candidate, never breaks
 *   the page.
 * - All server traffic goes through the background worker (one place for
 *   auth, caching, and rate sanity).
 * - Badge chrome lives in shadow DOM with an external stylesheet, so neither
 *   page CSS nor page CSP (no inline <style>) can touch it.
 */

/** Music provider the page belongs to, derived from the hostname. */
export type PageProvider = 'spotify' | 'bandcamp' | 'soundcloud' | 'deezer' | 'tidal' | 'youtube';

function pageProvider(): PageProvider | undefined {
  const h = location.hostname;
  if (h === 'open.spotify.com') return 'spotify';
  if (h.includes('bandcamp')) return 'bandcamp';
  if (h.includes('soundcloud')) return 'soundcloud';
  if (h.includes('deezer')) return 'deezer';
  if (h.includes('tidal')) return 'tidal';
  if (isBadgedYoutubeHost(h)) return 'youtube';
  return undefined;
}

interface Candidate {
  kind: 'artist' | 'album' | 'track' | 'playlist';
  /** Playlist's native provider ID (Spotify base62 / Deezer numeric). */
  playlistId?: string;
  /** Which provider the playlist lives on — the save flow's API source. */
  playlistSource?: 'spotify' | 'deezer';
  name: string;
  artist?: string;
  /** Individual artist names when the source named several ("Post Malone,
   *  Swae Lee"). `name`/`artist` keep the primary (first) for the pill;
   *  watchlist checks and buttons use each name separately — the combined
   *  string is never sent to the watchlist API as a single name. */
  artists?: string[];
  /** Provider-native ID of the artist (e.g. Spotify artist ID from a card
   *  subtitle link). Used for exact watchlist checks where available. */
  artistProviderId?: string;
  tracks?: string[];
  anchor: Element;
  pageUrl: string;
  /** Page-subject badge (artist/album page title) vs. a link badge in a list. */
  primary?: boolean;
  /** Provider the candidate was extracted from (hostname-verified). */
  provider?: PageProvider;
  /** Provider-native ID of the page subject, parsed from the URL (e.g. the
   * Deezer album ID). Used for exact API resolution where available. */
  providerId?: string;
  /** Compact rendering for tight spaces (now-playing bar, dense track rows):
   *  eye-only 👁️ button for artists, small pill for tracks/albums. */
  compact?: boolean;
  /** The artist couldn't be determined automatically (YouTube title with no
   *  "Artist - Track" shape): the pill is a 🔍 that opens manual search
   *  instead of a guessed watchlist add. Never offer watchlist for this. */
  manualSearch?: boolean;
}

type PillState = 'loading' | 'in' | 'out' | 'unknown' | 'acted';
/**
 * What the pill visually shows. Artist pills are watchlist-driven
 * ("Watching" / "Add to Watchlist"); album/track pills are library-driven
 * ("Album in library" / "In library" / "+ Album" / "+ Track").
 */
type PillVisual =
  | 'loading'
  | 'watching'
  | 'not-watching'
  | 'in'
  | 'out'
  | 'unknown'
  | 'acted'
  | 'manual-search'
  | 'save'
  | 'saved'
  | 'save-failed';

interface BadgeRec {
  pill: HTMLButtonElement;
  candidate: Candidate;
  /** What the pill currently shows. */
  visual: PillVisual;
  /** Library tri-state, for popover text and deep links. */
  libState: 'in' | 'out' | 'unknown' | 'loading';
  /** Watchlist tri-state for artists, for the popover button. null = unknown. */
  watchState: boolean | null;
  /** Per-artist watch states keyed by normalized name — for multi-artist
   *  candidates each artist gets an independent check and button. */
  watchStates: Record<string, boolean | null>;
  /** The anchor's text when the badge was mounted — used to spot SPA text
   *  swaps (YouTube reuses the h1 and rewrites its textContent in place). */
  anchorText: string;
  /** Watchlist tri-state for the artist named by a track/album candidate —
   *  the card's artist row renders this. null = unknown. */
  artistWatchState: boolean | null;
  pop: HTMLDivElement | null;
  /** Body-level layer hosting the popover's shadow root (null when closed). */
  popLayer: HTMLElement | null;
  /** Honest save-failure message for the playlist pill's title (retry). */
  saveError?: string;
}

const HOST_ATTR = 'data-ssb';
const MAX_PER_SCAN = 30;
/** Page badges master switch (popup toggle, persisted in storage). Default ON. */
let badgesEnabled = true;
/** Read the switch once at boot — storage.onChanged keeps it live after. */
async function loadBadgesEnabled(): Promise<void> {
  try {
    badgesEnabled = badgesEnabledFromStored(await browser.storage.local.get(BADGES_ENABLED_KEY));
  } catch {
    badgesEnabled = true;
  }
}
/** candidates the user already acted on this page load (watch/wishlist) */
const actedKeys = new Set<string>();
/** playlists saved this page load — the resolve check agrees, but the
 *  memory short-circuits rescans so a just-saved pill never flickers. */
const savedPlaylistKeys = new Set<string>();
const badges = new Map<HTMLElement, BadgeRec>();

function badgeKeyFor(
  c: Pick<Candidate, 'kind' | 'name' | 'artist' | 'playlistSource' | 'playlistId'>,
): string {
  // Playlists key on the native provider ID — two playlists can share a name.
  if (c.kind === 'playlist') return `playlist:${c.playlistSource ?? ''}:${c.playlistId ?? ''}`;
  // Must match api.ts badgeKey exactly: kind + normalized "artist name".
  return `${c.kind}:${normName(c.artist ? `${c.artist} ${c.name}` : c.name)}`;
}

/* ── extractors ── */

function trackRows(): { title: string; artist: string }[] {
  const rows: { title: string; artist: string }[] = [];
  // DOM-based, not textContent parsing: the row's textContent starts with
  // the track number ("1\nStarboy\n..."), which the old line-splitting
  // mistook for the title. The title link and artist link are stable.
  document.querySelectorAll('[data-testid="tracklist-row"]').forEach((row) => {
    const link =
      row.querySelector<HTMLAnchorElement>('a[data-testid="internal-track-link"]') ??
      row.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
    const title = link?.textContent?.trim() ?? '';
    const artist = row.querySelector('a[href*="/artist/"]')?.textContent?.trim() ?? '';
    if (title && artist) rows.push({ title, artist });
  });
  return rows;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    const n = normName(v);
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  counts.forEach((n, k) => {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  });
  return values.find((v) => normName(v) === best) ?? '';
}

/** Only bare /artist/<id> links — subpage links like
 *  /artist/<id>/discography ("Discography" tab) are not artists. */
function isBareArtistHref(href: string): boolean {
  return /\/artist\/[A-Za-z0-9]+$/.test(href);
}

/** Bare /album/<id> / /track/<id> hrefs (query strings tolerated) — the
 *  subject link of a search-result row or card. */
function isBareAlbumHref(href: string): boolean {
  return /\/album\/[A-Za-z0-9]+([?#]|$)/.test(href);
}

function isBareTrackHref(href: string): boolean {
  return /\/track\/[A-Za-z0-9]+([?#]|$)/.test(href);
}

/** Spotify-native ID from an /album/, /artist/ or /track/ href. */
function spotifyIdFromHref(href: string): string | null {
  const m = href.match(/\/(?:intl-[a-z-]+\/)?(?:album|artist|track)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/** Hero fallback (logged-in UI drops the entityTitle testid): the h1 whose
 *  text matches og:title, else the first visible h1, else the first h1.
 *  The left sidebar's "Your Library" h1 is never the page subject — it is
 *  always excluded, so a page with no real hero yields null (no pill)
 *  instead of a bogus badge on the sidebar. */
function spotifyHeroFallback(): Element | null {
  const og = metaTag('og:title')?.trim();
  const h1s = [...document.querySelectorAll('h1')].filter((h) => {
    const t = h.textContent?.trim() ?? '';
    if (t.length < 2 || t.toLowerCase() === 'your library') return false;
    return true;
  });
  if (og) {
    const exact = h1s.find((h) => h.textContent?.trim() === og);
    if (exact) return exact;
  }
  return (
    h1s.find((h) => {
      const r = h.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) ??
    h1s[0] ??
    null
  );
}

/** Now-playing fallback (logged-in UI drops the widget testid): the footer,
 *  but only when it actually holds a track link. */
function spotifyNowPlayingFallback(): Element | null {
  const footer =
    document.querySelector('footer') ?? document.querySelector('[role="contentinfo"]');
  if (!footer) return null;
  return footer.querySelector('a[href*="track/"]') ? footer : null;
}

/** Spotify: verified Sep 2026 — [data-testid="entityTitle"] holds the page subject. */
function spotifyCandidates(): Candidate[] {
  const out: Candidate[] = [];
  // Dedupe by ANCHOR, not by item key: the same artist/track legitimately
  // appears in multiple places (hero + now-playing + tracklist row), and
  // each occurrence needs its own badge. Key-based dedupe dropped the hero
  // artist when now-playing showed the same artist, and the tracklist row
  // when now-playing played the same track.
  const seenAnchors = new Set<Element>();
  const push = (c: Omit<Candidate, 'pageUrl' | 'provider'>): void => {
    const name = c.name.trim();
    if (name.length < 2 || name.length > 80 || name.includes('\n')) return;
    if (seenAnchors.has(c.anchor) || out.length >= MAX_PER_SCAN) return;
    seenAnchors.add(c.anchor);
    out.push({ ...c, name, pageUrl: location.href, provider: 'spotify' });
  };
  const path = location.pathname;
  // The page subject's provider ID — primary candidates only. Link
  // candidates below extract from their own href, so we don't fire a
  // redundant watchlist check per link with the wrong ID.
  const pageId = providerIdFromPath('spotify', path) ?? undefined;

  // Hero: the entityTitle testid first (verified on the logged-out UI);
  // logged-in Chrome drops it — there the hero title is
  // span[data-testid="adaptiveEntityTitle"] (Broque's DOM, Sep 29 2026);
  // last resort is the og:title-matched h1, then the first visible h1.
  const entityTitleEl = document.querySelector('[data-testid="entityTitle"]');
  const adaptiveTitleEl = entityTitleEl
    ? null
    : document.querySelector('span[data-testid="adaptiveEntityTitle"]');
  const titleEl = entityTitleEl ?? adaptiveTitleEl ?? spotifyHeroFallback();
  // The adaptive title is a draggable inline span — the pill goes after it
  // as a sibling, never inside.
  const heroAfter = adaptiveTitleEl !== null;
  const title = titleEl?.textContent?.trim() ?? '';
  const isArtistPage = path.includes('/artist/');
  const pageArtist = isArtistPage ? title : '';
  if (titleEl && title) {
    if (isArtistPage) {
      push({ kind: 'artist', name: title, anchor: titleEl, primary: !heroAfter, providerId: pageId });
    } else if (path.includes('/album/')) {
      // Album artist without guessing header selectors: most common artist
      // across the track rows (verified structure above).
      const rows = trackRows();
      push({
        kind: 'album',
        name: title,
        artist: mostCommon(rows.map((r) => r.artist)),
        tracks: rows.map((r) => r.title),
        anchor: titleEl,
        providerId: pageId,
      });
    } else if (path.includes('/track/')) {
      // Track page: the track pill anchors to the title (primary), the
      // artist pill anchors to the artist link below — each labeled clearly
      // so "Artist" never appears to describe the track name.
      const artistLink = [
        ...document.querySelectorAll<HTMLAnchorElement>('a[href*="/artist/"]'),
      ].find(
        (a) =>
          isBareArtistHref(a.getAttribute('href') ?? '') && (a.textContent?.trim() ?? '').length >= 2,
      );
      const trackArtist = artistLink?.textContent?.trim() ?? '';
      if (trackArtist) {
        push({ kind: 'track', name: title, artist: trackArtist, anchor: titleEl, primary: !heroAfter, providerId: pageId });
        // The artist pill anchors to the artist link below the title — its
        // own ID from its own href, so the watch state is exact.
        if (artistLink) {
          const artistHref = artistLink.getAttribute('href') ?? '';
          push({
            kind: 'artist',
            name: trackArtist,
            anchor: artistLink,
            providerId: providerIdFromPath('spotify', new URL(artistHref, location.origin).pathname) ?? undefined,
          });
        }
      }
    }
  }

  // Search-result rows (autocomplete dropdown, search page): rows whose
  // subject link is /album/<id> or /track/<id> and whose subtitle carries
  // "Album • Artist" / "Song • Artist" get their own library pill — the
  // row's subject wins over the inner artist-name link, which otherwise
  // reads as "watching the album". Standalone artist rows keep their pill
  // (the artist sweep below). Row roots are recorded so the sweep can skip
  // the artist link inside a badged row.
  const searchRowRoots = new Set<Element>();
  {
    const scope = document.getElementById('search-dropdown') ?? document;
    const seenSubjects = new Set<string>();
    scope.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      const isAlbum = isBareAlbumHref(href);
      const isTrack = isBareTrackHref(href);
      if (!isAlbum && !isTrack) return;
      if (a.closest('[data-testid="tracklist-row"]')) return; // row code owns these
      if (a.closest('[data-testid="now-playing-widget"]')) return;
      const subjId = spotifyIdFromHref(href);
      const subjKey = `${isAlbum ? 'album' : 'track'}:${subjId ?? href}`;
      if (seenSubjects.has(subjKey)) return;
      // Row root: walk up from the subject link until an ancestor's text
      // carries the "Album • Artist" / "Song • Artist" subtitle.
      let root: Element | null = a;
      let subtitle: RegExpMatchArray | null = null;
      for (let i = 0; i < 7 && root && !subtitle; i++) {
        subtitle = (root.textContent ?? '').match(
          /(Album|Single|EP|Song)\s*[•·]\s*([^\n]+)/,
        );
        if (!subtitle) root = root.parentElement;
      }
      if (!root || !subtitle) return;
      const rowArtistLink = root.querySelector<HTMLAnchorElement>('a[href*="/artist/"]');
      // The row's own artist link is verified; the subtitle text is a
      // fallback (strip trailing year/duration junk like "• 2024 45:16").
      const subtitleArtist = subtitle[2]
        .split('•')[0]
        .replace(/\b(19|20)\d{2}\b.*$/, '')
        .replace(/\s*\d+:\d+\s*$/, '')
        .trim();
      const artist = rowArtistLink?.textContent?.trim() || subtitleArtist;
      if (!artist || artist.length < 2) return;
      // Title: the subject link's own text, else aria-labelledby, else the
      // row's first text line that is neither subtitle nor artist.
      let title = a.textContent?.trim() ?? '';
      if (!title) {
        const labelledBy = a.getAttribute('aria-labelledby') ?? root.getAttribute('aria-labelledby');
        if (labelledBy) {
          title =
            document.getElementById(labelledBy.split(' ')[0])?.textContent?.trim() ?? '';
        }
      }
      if (!title) {
        const lines = (root.textContent ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 1);
        title =
          lines.find(
            (l) => !/(Album|Single|EP|Song)\s*[•·]/.test(l) && l !== artist,
          ) ?? '';
      }
      if (!title || title.length < 2) return;
      seenSubjects.add(subjKey);
      searchRowRoots.add(root);
      push({
        kind: isAlbum ? 'album' : 'track',
        name: title,
        artist,
        anchor: a,
        providerId: subjId ?? undefined,
      });
    });
  }

  // Now-playing widget: the track gets the full library/wishlist pill next
  // to the track data. No artist watchlist pill here — Broque: the media
  // player should show only "in library / add to wishlist", never watchlist.
  // The widget persists across SPA nav and Spotify text-swaps it in place —
  // the scan's stale-sweep keeps the badge fresh.
  // Console data from Broque's logged-in Chrome: the widget testid exists,
  // but the inner a[href*="/track/"] doesn't — fall back to a footer scope,
  // then to any non-artist link in the widget.
  const np = document.querySelector('[data-testid="now-playing-widget"]') ?? spotifyNowPlayingFallback();
  // One track pill per widget, period — the widget is not a tracklist-row,
  // so the row-based dedupe doesn't apply. Rescans must never double-badge.
  if (np && !np.querySelector('.ssb-host')) {
    const npArtistLink = np.querySelector<HTMLAnchorElement>('a[href*="/artist/"]');
    const npArtistName = npArtistLink?.textContent?.trim() ?? '';
    const npTrackLink =
      np.querySelector<HTMLAnchorElement>('a[href*="/track/"]') ??
      [...np.querySelectorAll<HTMLAnchorElement>('a[href]')].find((a) =>
        /track\/[A-Za-z0-9]+/.test(a.getAttribute('href') ?? ''),
      ) ??
      // Last resort: any non-artist link. Exclude by href pattern, not by
      // element identity — npArtistLink may be null (artist link without
      // /artist/ in href), in which case the old `a !== npArtistLink` check
      // excluded nothing and the artist link was misidentified as the track.
      // A track pill anchored to the artist is never correct — Broque.
      [...np.querySelectorAll<HTMLAnchorElement>('a[href]')].find((a) => {
        const href = a.getAttribute('href') ?? '';
        if (/\/artist\//.test(href)) return false;
        return (a.textContent?.trim() ?? '').length >= 2;
      }) ??
      null;
    const npTrackTitle = npTrackLink?.textContent?.trim() ?? '';
    // The track link must be a distinct element from the artist link —
    // never badge the artist in the media player (Broque: track pill only).
    if (npTrackLink && npTrackLink !== npArtistLink && npTrackTitle && npArtistName) {
      push({
        kind: 'track',
        name: npTrackTitle,
        artist: npArtistName,
        anchor: npTrackLink,
        providerId: spotifyIdFromHref(npTrackLink.getAttribute('href') ?? '') ?? undefined,
      });
    }
  }

  // Tracklist rows (Popular, playlists, albums, Liked Songs): a compact
  // track pill per row, anchored in the row's right action cell (Broque:
  // the pill sits on the right, not under the title). Title/artist for the
  // lookup still come from the row's links — only the anchor moved. Artist
  // context: the row's own artist link when shown; the page artist on
  // /artist/* pages (Popular rows don't repeat it); otherwise the row is
  // skipped — never guessed. Exactly one pill per row: rescans never
  // double-badge, even if the anchor changed between scans.
  document.querySelectorAll('[data-testid="tracklist-row"]').forEach((row) => {
    // One pill per row, period — rescans must never double-badge a row even
    // if the anchor changed between scans (e.g. the + button appearing late).
    if (row.querySelector('.ssb-host')) return;
    // Broque's console: the rows exist but internal-track-link doesn't —
    // fall back to any /track/ link in the row.
    const link =
      row.querySelector<HTMLAnchorElement>('a[data-testid="internal-track-link"]') ??
      row.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
    const trackTitle = link?.textContent?.trim() ?? '';
    if (!link || !trackTitle) return;
    const rowArtist = row.querySelector('a[href*="/artist/"]')?.textContent?.trim() ?? '';
    const artist = rowArtist || (isArtistPage ? pageArtist : '');
    if (!artist) return;
    // Right-side anchor: the "Add to Liked Songs" + button when present
    // (album/playlist pages); on Liked Songs the tracks are already liked,
    // so fall back to the row's "More options" (...) button — still the
    // right action cell, never the title.
    const anchor =
      row.querySelector('button[aria-label="Add to Liked Songs"]') ??
      row.querySelector('button[aria-label^="More options for"]') ??
      row.querySelector('button[aria-label="More options"]') ??
      link;
    push({ kind: 'track', name: trackTitle, artist, anchor, compact: true });
  });

  // Right-sidebar context panel (artist pages): the "context" track gets a
  // track library pill only — never artist watchlist pills (Broque's
  // album-page rule). Track name from the context-item link, artists from
  // the context-item-info-artist links, track ID from the context-link's
  // spotify:track URI.
  document.querySelectorAll('div[data-testid="context-item-info-title"]').forEach((titleDiv) => {
    // The now-playing BAR reuses the context-item testids — its track pill
    // belongs to the now-playing block above; never double-badge it here
    // (Broque: two "In library" pills in the media player).
    if (titleDiv.closest('[data-testid="now-playing-widget"]')) return;
    const trackLink = titleDiv.querySelector<HTMLAnchorElement>('a[data-testid="context-item-link"]');
    const trackName = trackLink?.textContent?.trim() ?? '';
    if (!trackLink || trackName.length < 2) return;
    // Scope to the panel: walk up until the subtitles div is inside.
    let panel: Element | null = titleDiv;
    for (
      let i = 0;
      i < 6 && panel && !panel.querySelector('div[data-testid="context-item-info-subtitles"]');
      i++
    ) {
      panel = panel.parentElement;
    }
    if (!panel) return;
    const artists = [
      ...panel.querySelectorAll<HTMLAnchorElement>('a[data-testid="context-item-info-artist"]'),
    ]
      .map((a) => a.textContent?.trim() ?? '')
      .filter((s) => s.length >= 2);
    if (artists.length === 0) return;
    // Track ID from a context-link in the panel (or its ancestors).
    let trackId: string | undefined;
    let scope: Element | null = panel;
    for (let i = 0; i < 8 && scope && !trackId; i++) {
      const cl = scope.querySelector<HTMLAnchorElement>(
        'a[data-testid="context-link"][data-context-item-type="track"]',
      );
      if (cl) {
        const m = /spotify%3Atrack%3A([A-Za-z0-9]+)/i.exec(cl.getAttribute('href') ?? '');
        if (m) trackId = m[1];
      }
      scope = scope.parentElement;
    }
    push({
      kind: 'track',
      name: trackName,
      artist: artists[0],
      anchor: titleDiv,
      compact: true,
      providerId: trackId,
    });
  });

  // Album cards: every album card gets an album library pill. Only
  // spotify:album: cards (aria-labelledby) — playlists, "This Is" and radio
  // cards are skipped. Artist: the page artist on artist pages; elsewhere
  // the subtitle's /artist/ link (e.g. homepage "Romance" card). A card
  // with no artist link in the subtitle is skipped — an album lookup
  // without an artist is unreliable, and we never guess.
  document.querySelectorAll('div[data-encore-id="card"]').forEach((card) => {
    const labelledBy = card.getAttribute('aria-labelledby') ?? '';
    if (!labelledBy.includes('spotify:album:')) return;
    const titleLink = card.querySelector<HTMLAnchorElement>('a[href*="/album/"]');
    const href = titleLink?.getAttribute('href') ?? '';
    if (!isBareAlbumHref(href)) return;
    const cardTitle = card.querySelector('[data-encore-id="cardTitle"]');
    const albumName =
      cardTitle?.textContent?.trim() || titleLink?.getAttribute('title')?.trim() || '';
    if (albumName.length < 2) return;
    let artist = isArtistPage ? pageArtist : '';
    let artistProviderId: string | undefined;
    if (!artist) {
      const artistLink = card.querySelector<HTMLAnchorElement>(
        '[data-encore-id="cardSubtitle"] a[href*="/artist/"]',
      );
      const artistHref = artistLink?.getAttribute('href') ?? '';
      if (artistLink && isBareArtistHref(artistHref)) {
        artist = artistLink.textContent?.trim() ?? '';
        artistProviderId =
          providerIdFromPath('spotify', new URL(artistHref, location.origin).pathname) ?? undefined;
      }
    }
    if (artist.length < 2) return;
    const albumId =
      providerIdFromPath('spotify', new URL(href, location.origin).pathname) ?? undefined;
    push({
      kind: 'album',
      name: albumName,
      artist,
      artistProviderId,
      anchor: titleLink ?? card,
      compact: true,
      providerId: albumId,
    });
  });

  // Artist cards ("Fans also like", related artists, etc.): every artist
  // card gets a watchlist pill. Only spotify:artist: cards — the card
  // carries its own name and ID, so this works on any page type. The
  // artist-link sweep below skips card title links (they're handled here).
  document.querySelectorAll('div[data-encore-id="card"]').forEach((card) => {
    const labelledBy = card.getAttribute('aria-labelledby') ?? '';
    if (!labelledBy.includes('spotify:artist:')) return;
    const titleLink = card.querySelector<HTMLAnchorElement>('a[href*="/artist/"]');
    const href = titleLink?.getAttribute('href') ?? '';
    if (!isBareArtistHref(href)) return;
    const cardTitle = card.querySelector('[data-encore-id="cardTitle"]');
    const artistName =
      cardTitle?.textContent?.trim() ||
      titleLink?.getAttribute('title')?.trim() ||
      titleLink?.textContent?.trim() ||
      '';
    if (artistName.length < 2) return;
    const artistId =
      providerIdFromPath('spotify', new URL(href, location.origin).pathname) ?? undefined;
    push({
      kind: 'artist',
      name: artistName,
      anchor: titleLink ?? card,
      compact: true,
      providerId: artistId,
    });
  });

  // Artist links in lists: search results, playlists, "fans also like".
  // URL-shaped selector (not class names) — stable across redesigns.
  // Each link extracts its own artist ID from its href — not the page's.
  // The language-picker modal's links are skipped: they carry the page's own
  // artist ID under an /intl-<locale>/ prefix, so they'd all read as the
  // page artist (a wall of bogus "Watching" pills).
  document.querySelectorAll<HTMLAnchorElement>('a[href*="/artist/"]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (!isBareArtistHref(href)) return;
    if (a.closest('[data-testid="language-selection-modal"]')) return;
    // The now-playing widget gets a track pill only — never an artist
    // watchlist pill (Broque). Excluded here so the sweep doesn't re-add
    // what the widget block deliberately skips.
    if (np && np.contains(a)) return;
    // The sidebar context panel gets a track pill only — never artist
    // watchlist pills (Broque's album-page rule). Its artist links carry
    // data-testid="context-item-info-artist".
    if (a.getAttribute('data-testid') === 'context-item-info-artist') return;
    // Card title links ("Fans also like", discography, etc.) are handled by
    // the explicit card scans above — the sweep would double-badge them.
    if (a.closest('div[data-encore-id="card"]')) return;
    // Track rows get library pills only ("✓ In library" / "＋ Wishlist
    // track") — never artist watchlist pills on the row's artist credits,
    // on ANY page (album, playlist, Liked Songs, ...). The hero artist link
    // is not in a track row, so it keeps its pill, as do "fans also like"
    // links elsewhere.
    if (a.closest('[data-testid="tracklist-row"]')) return;
    // A search-result row with its own album/track badge owns its artist
    // link — the row's subject wins, so the pill never reads as "watching
    // the album". Standalone artist rows have no row root and keep theirs.
    for (const root of searchRowRoots) {
      if (root !== a && root.contains(a)) return;
    }
    push({
      kind: 'artist',
      name: a.textContent ?? '',
      anchor: a,
      providerId: providerIdFromPath('spotify', new URL(href, location.origin).pathname) ?? undefined,
    });
  });
  // Album links in lists are deliberately NOT badged: a bare /album/<id> link
  // carries no trustworthy artist context, so the library check could never
  // resolve past "unknown" — a permanent row of ? badges is noise, not
  // signal. The album page itself (primary badge above, artist derived from
  // its track rows) still badges.
  // Save-playlist pills (cards and playlist pages) — appended last so the
  // lab's collectCandidates/pageProvider patches keep working untouched.
  out.push(...playlistCandidates());
  return out;
}

/**
 * Bandcamp album-page track list. `.trackTitle` matches the album title
 * element AND every track row (verified Sep 2026), so the album title
 * itself is filtered out. Returns undefined when nothing usable remains —
 * no tracks means no wishlist-album action.
 */
function bandcampTracks(albumName: string): string[] | undefined {
  const want = normName(albumName);
  const tracks = trackTitles(['.track_list .trackTitle', '.trackTitle']).filter(
    (t) => normName(t) !== want,
  );
  return tracks.length > 0 ? tracks : undefined;
}

/**
 * Generic extractor for JSON-LD/OG-tagged pages (Bandcamp, SoundCloud,
 * Deezer, Tidal…): the page's primary album/artist only. Anchors are
 * defensive — no anchor, no badge.
 */
function genericCandidates(): Candidate[] {
  const out: Candidate[] = [];
  const isBandcamp = location.hostname.includes('bandcamp');
  const albumAnchor =
    (isBandcamp ? document.querySelector('.trackTitle') : null) ?? document.querySelector('h1');
  const artistAnchor =
    (isBandcamp ? document.querySelector('#band-name-location .title') : null) ??
    document.querySelector('h1');

  const albumLd = jsonLdOfType(/MusicAlbum/);
  if (albumLd && typeof albumLd.name === 'string' && albumAnchor) {
    const artist = artistName((albumLd as Record<string, unknown>).byArtist);
    const albumName = (albumLd.name as string).trim();
    out.push({
      kind: 'album',
      name: albumName,
      artist: artist || undefined,
      // Bandcamp: .trackTitle covers the album title + every track row
      // (verified Sep 2026) — drop the album title itself.
      tracks: isBandcamp ? bandcampTracks(albumName) : undefined,
      anchor: albumAnchor,
      pageUrl: location.href,
      primary: true,
      provider: pageProvider(),
      // Native provider ID from the URL (e.g. Deezer /us/album/674017741) —
      // lets the background resolve the exact tracklist via the provider API.
      providerId: providerIdFromPath(pageProvider(), location.pathname) ?? undefined,
    });
  }
  const groupLd = jsonLdOfType(/MusicGroup/);
  if (groupLd && typeof groupLd.name === 'string' && artistAnchor) {
    out.push({
      kind: 'artist',
      name: (groupLd.name as string).trim(),
      anchor: artistAnchor,
      pageUrl: location.href,
      primary: true,
      provider: pageProvider(),
    });
  }
  // Bandcamp's og:title is "Album Name, by Artist" (verified Sep 2026).
  if (out.length === 0) {
    const og = metaTag('og:title');
    const m = og.match(/^(.*),\s+by\s+(.+)$/i);
    if (m && albumAnchor) {
      const albumName = m[1].trim();
      out.push({
        kind: 'album',
        name: albumName,
        artist: m[2].trim(),
        tracks: isBandcamp ? bandcampTracks(albumName) : undefined,
        anchor: albumAnchor,
        pageUrl: location.href,
        primary: true,
        provider: pageProvider(),
        providerId: providerIdFromPath(pageProvider(), location.pathname) ?? undefined,
      });
    }
  }
  // Dedupe album-vs-og doubles etc.
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = badgeKeyFor(c);
    if (!c.name || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * YouTube artist badges.
 *
 * Channel pages: artist from the og:title meta tag ("Drake"; Topic channels
 * are "Drake - Topic"), anchored to the channel name. Watch pages: artist is
 * the part of the video title before " - " ("Drake - One Dance (Lyrics)" ->
 * "Drake"), anchored to the channel name below the title (watchlist is about
 * the artist/channel, not the video); the track pill parses the full
 * "Artist - Track" form and stays on the title. When the title doesn't name
 * an artist, a 🔍 pill by the channel opens manual search. They anchor to
 * different elements (the channel name vs. the inner title span) because
 * mountBadge dedupes on the anchor element.
 * Shorts, search, feeds, and music.youtube.com have no reliable artist
 * signal and are intentionally skipped.
 */
function youtubeCandidates(): Candidate[] {
  const out: Candidate[] = [];
  const path = location.pathname;
  if (isYoutubeChannelPath(path)) {
    const name = channelArtistFromOgTitle(metaTag('og:title'));
    const anchor = document.querySelector('#channel-name');
    if (name && anchor) {
      out.push({
        kind: 'artist',
        name,
        anchor,
        pageUrl: location.href,
        primary: true,
        provider: pageProvider(),
      });
    }
  } else if (path === '/watch') {
    const h1 = document.querySelector('h1.ytd-watch-metadata') ?? document.querySelector('h1');
    const inner = h1?.querySelector('yt-formatted-string') ?? undefined;
    const rawTitle = (inner ?? h1)?.textContent?.trim() ?? '';
    // The artist pill lives by the CHANNEL name below the title — watchlist
    // is about the artist/channel, not the video. The artist is still
    // resolved from the title context; only the placement changes.
    const channelAnchor =
      document.querySelector('#owner #channel-name') ??
      document.querySelector('ytd-video-owner-renderer #channel-name') ??
      document.querySelector('#channel-name');
    const channelName = channelAnchor?.textContent?.trim() ?? '';
    const artist = artistFromVideoTitle(rawTitle);
    if (artist && channelAnchor) {
      // Multi-artist titles ("Post Malone, Swae Lee - Sunflower") split
      // into individuals: the pill names the primary (first) artist, and
      // the popover lists each artist with their own watchlist button.
      const artists = splitArtists(artist);
      out.push({
        kind: 'artist',
        name: artists[0] ?? artist,
        artists: artists.length > 0 ? artists : undefined,
        anchor: channelAnchor,
        pageUrl: location.href,
        primary: true,
        provider: pageProvider(),
      });
    } else if (channelName && channelAnchor) {
      // The title doesn't name the artist — offer manual search by the
      // channel instead of a guessed watchlist add.
      out.push({
        kind: 'artist',
        name: channelName,
        anchor: channelAnchor,
        pageUrl: location.href,
        primary: true,
        provider: pageProvider(),
        manualSearch: true,
      });
    }
    const track = trackFromVideoTitle(rawTitle, channelName);
    const trackAnchor = inner && inner !== h1 ? inner : h1?.parentElement;
    if (track && trackAnchor && trackAnchor !== h1) {
      out.push({
        kind: 'track',
        name: track.title,
        artist: track.artist,
        // Split for the popover's per-artist watchlist buttons; `artist`
        // stays the full credit for wishlist-track matching.
        artists: splitArtists(track.artist),
        anchor: trackAnchor,
        pageUrl: location.href,
        primary: true,
        provider: pageProvider(),
      });
    }
  }
  // Save-playlist pills (cards and playlist pages) — appended last so the
  // lab's collectCandidates/pageProvider patches keep working untouched.
  out.push(...playlistCandidates());
  return out;
}

/**
 * The artist-name heading on a live Deezer artist page.
 *
 * The rendered page is a Chakra SPA (verified Sep 2026 against the live DOM
 * of deezer.com/us/artist/246791): no h1 and no #naboo_artist_name — the name
 * is an h2.chakra-heading inside the header section. The header h2 is the one
 * whose text matches og:title; the fallback is the h2 in the section holding
 * the "N fans" count. (The pill itself lives in a shadow root, so it never
 * pollutes the heading's textContent on rescans.)
 */
function deezerArtistHeader(): HTMLElement | null {
  const og = metaTag('og:title')?.trim();
  const heads = [...document.querySelectorAll('h2.chakra-heading')];
  if (og) {
    const exact = heads.find((h) => h.textContent?.trim() === og);
    if (exact) return exact as HTMLElement;
  }
  const fans = [...document.querySelectorAll('body *')].find(
    (e) => e.childElementCount === 0 && /\bfans\b/i.test(e.textContent ?? ''),
  );
  const sec = fans?.closest('section');
  const h2 = sec?.querySelector('h2');
  return (h2 as HTMLElement | null) ?? null;
}
/**
 * Deezer album + artist badges.
 *
 * Album pages: the live album DOM (verified Sep 2026 against
 * deezer.com/us/album/674017741) carries no JSON-LD and no <h1>: the header
 * is an <h2> (album title) sharing a parent with the artist link
 * (a[href*="/artist/"]), plus a <ul> with track count/meta. The native album
 * ID comes from the URL; the exact tracklist is resolved from Deezer's
 * public API by the background (see SOULSYNC_DEEZER_TRACKS).
 *
 * Artist pages: /{locale}/artist/<id> — name heading found by
 * deezerArtistHeader() (live SPA DOM, verified Sep 2026). The native artist
 * ID from the URL goes straight to watchlist/add (direct path).
 */
function deezerCandidates(): Candidate[] {
  const out: Candidate[] = [];
  const push = (c: Candidate) => {
    out.push(c);
  };

  // ── Track rows (all pages): "in library" badges for every track row.
  // Broque: "we need in library badges for all track rows on anything."
  // Structure (verified Sep 2026):
  //   div[role="row"] > div[data-testid="title"] > span "1. Sundress"
  //   Artist from the play button: aria-label="Play Sundress by A$AP Rocky"
  //   Right actions: [aria-label="Add to Favorite tracks"] (heart),
  //   [aria-label="View menu"] (...). The pill goes after these buttons —
  //   Broque: "next the microphone, heart, and '...'" — never on the title.
  document.querySelectorAll('div[role="row"]').forEach((row) => {
    // One pill per row, period.
    if (row.querySelector('.ssb-host')) return;
    const titleEl = row.querySelector('[data-testid="title"]');
    const rawTitle = titleEl?.textContent?.trim() ?? '';
    if (rawTitle.length < 2) return;
    // Strip leading track number: "1. Sundress" -> "Sundress".
    const trackTitle = rawTitle.replace(/^\d+\.\s*/, '').trim();
    if (trackTitle.length < 2) return;
    // Artist from the play button's aria-label: "Play <title> by <artist>".
    const playBtn = row.querySelector('button[aria-label^="Play "]');
    const playLabel = playBtn?.getAttribute('aria-label') ?? '';
    const artistMatch = /\bby\s+(.+?)\s*$/.exec(playLabel);
    const artist = artistMatch?.[1]?.trim() ?? '';
    if (artist.length < 2) return;
    // Right-side anchor: after the last action button (heart, ..., lyrics).
    const actionBtns = [
      ...row.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Add to Favorite tracks"], button[aria-label="View menu"], button[aria-label="Lyrics"]',
      ),
    ];
    const anchor = actionBtns.length > 0 ? actionBtns[actionBtns.length - 1] : titleEl;
    push({
      kind: 'track',
      name: trackTitle,
      artist,
      anchor: anchor ?? row,
      compact: true,
      provider: 'deezer',
      pageUrl: location.href,
    });
  });

  // ── Album thumbnails: "any album that is shown needs an in library badge."
  //   div[data-testid="album_thumbnail"]
  //   a[data-testid="thumbnail-title"][href="/us/album/<id>"] "Don't Be Dumb"
  //   a[href="/us/artist/<id>"] "A$AP Rocky" (the artist link)
  document.querySelectorAll('div[data-testid="album_thumbnail"]').forEach((thumb) => {
    if (thumb.querySelector('.ssb-host')) return;
    const titleLink = thumb.querySelector<HTMLAnchorElement>(
      'a[data-testid="thumbnail-title"][href*="/album/"]',
    );
    const albumName = titleLink?.textContent?.trim() ?? '';
    if (!titleLink || albumName.length < 2) return;
    const href = titleLink.getAttribute('href') ?? '';
    const albumId = deezerAlbumIdFromPath(new URL(href, location.origin).pathname);
    // Artist: the /artist/ link in the thumbnail (not the title link).
    const artistLink = [...thumb.querySelectorAll<HTMLAnchorElement>('a[href*="/artist/"]')].find(
      (a) => a !== titleLink && (a.textContent?.trim() ?? '').length >= 2,
    );
    const artist = artistLink?.textContent?.trim() ?? '';
    if (artist.length < 2) return;
    const artistId = artistLink
      ? (deezerArtistIdFromPath(new URL(artistLink.getAttribute('href') ?? '', location.origin).pathname) ?? undefined)
      : undefined;
    push({
      kind: 'album',
      name: albumName,
      artist,
      artistProviderId: artistId,
      anchor: titleLink,
      compact: true,
      provider: 'deezer',
      providerId: albumId ?? undefined,
      pageUrl: location.href,
    });
  });

  // ── Artist thumbnails: "artist cards need watchlist badge."
  //   div[data-testid="artist_thumbnail"]
  //   a[data-testid="thumbnail-title"][href="/us/artist/<id>"] "Shikimo"
  document.querySelectorAll('div[data-testid="artist_thumbnail"]').forEach((thumb) => {
    if (thumb.querySelector('.ssb-host')) return;
    const titleLink = thumb.querySelector<HTMLAnchorElement>(
      'a[data-testid="thumbnail-title"][href*="/artist/"]',
    );
    const artistName = titleLink?.textContent?.trim() ?? '';
    if (!titleLink || artistName.length < 2) return;
    const href = titleLink.getAttribute('href') ?? '';
    const artistId = deezerArtistIdFromPath(new URL(href, location.origin).pathname);
    push({
      kind: 'artist',
      name: artistName,
      anchor: titleLink,
      compact: true,
      provider: 'deezer',
      providerId: artistId ?? undefined,
      pageUrl: location.href,
    });
  });

  const artistId = deezerArtistIdFromPath(location.pathname);
  if (artistId) {
    const nameEl = deezerArtistHeader();
    const name = nameEl?.textContent?.trim() || metaTag('og:title');
    if (name && nameEl) {
      out.push({
        kind: 'artist',
        name,
        anchor: nameEl,
        pageUrl: location.href,
        primary: true,
        provider: 'deezer',
        providerId: artistId,
      });
    }
    out.push(...playlistCandidates());
    return out;
  }
  const albumId = deezerAlbumIdFromPath(location.pathname);
  if (!albumId) {
    out.push(...playlistCandidates());
    return out;
  }
  // First artist link that sits under an album header (h2 title sibling).
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/artist/"]')];
  let anchor: Element | null = null;
  let artist = '';
  let albumArtistId: string | undefined;
  for (const link of links) {
    const linkText = link.textContent.trim();
    if (!linkText) continue; // e.g. the artist-cover link wrapping an <img>
    let el: Element | null = link;
    for (let i = 0; i < 5 && el; i++) {
      el = el.parentElement;
      const h2 = el?.querySelector(':scope > h2');
      if (h2 && h2.textContent.trim()) {
        anchor = h2;
        artist = linkText;
        // The artist's Deezer ID enables the direct watchlist path (no
        // name-resolve search) for the popover's watchlist button.
        albumArtistId =
          deezerArtistIdFromPath(new URL(link.getAttribute('href') ?? '', location.origin).pathname) ??
          undefined;
        break;
      }
    }
    if (anchor) break;
  }
  const title = anchor?.textContent.trim() || metaTag('og:title');
  if (!anchor || !title || !artist) {
    out.push(...playlistCandidates());
    return out;
  }
  out.push({
    kind: 'album',
    name: title,
    artist,
    artistProviderId: albumArtistId,
    anchor,
    pageUrl: location.href,
    primary: true,
    provider: 'deezer',
    providerId: albumId,
  });
  out.push(...playlistCandidates());
  return out;
}

/**
 * Save-playlist candidates (Spotify + Deezer, cards and pages).
 *
 * Spotify card: div[data-encore-id="card"] whose aria-labelledby contains
 * "spotify:playlist:" — playlists only, never albums/artists. Title from
 * [data-encore-id="cardTitle"] (or the link's title); the playlist ID is the
 * last segment of a[href^="/playlist/"]. The pill mounts after the title
 * link, inside the card.
 * Spotify page: /playlist/<id> — the pill mounts by the header title.
 * Deezer card: a[data-testid="thumbnail-title"][href*="/playlist/"] — the
 * numeric last segment is the ID. /smarttracklist/ URLs are skipped: the
 * server's parse_playlist_url only handles /playlist/<id>.
 * Deezer page: /playlist/<id> (numeric) — the pill mounts by the header.
 */
function playlistCandidates(): Candidate[] {
  const out: Candidate[] = [];
  const provider = pageProvider();
  if (provider === 'spotify') {
    document.querySelectorAll('div[data-encore-id="card"]').forEach((card) => {
      const labelledBy = card.getAttribute('aria-labelledby') ?? '';
      if (!labelledBy.includes('spotify:playlist:')) return;
      const titleLink = card.querySelector<HTMLAnchorElement>('a[href^="/playlist/"]');
      const href = (titleLink?.getAttribute('href') ?? '').split(/[?#]/)[0];
      const id = href.split('/').filter(Boolean).pop() ?? '';
      if (!id) return;
      const cardTitle = card.querySelector('[data-encore-id="cardTitle"]');
      const name =
        cardTitle?.textContent?.trim() ||
        titleLink?.getAttribute('title')?.trim() ||
        titleLink?.textContent?.trim() ||
        '';
      if (name.length < 2) return;
      out.push({
        kind: 'playlist',
        name,
        anchor: titleLink ?? card,
        compact: true,
        provider: 'spotify',
        playlistId: id,
        playlistSource: 'spotify',
        pageUrl: location.href,
      });
    });
    // Playlist page: /playlist/<id> (never /album/ or /track/).
    const pm = location.pathname.match(/\/playlist\/([A-Za-z0-9]+)/);
    if (pm) {
      const titleEl =
        document.querySelector('[data-testid="entityTitle"]') ??
        document.querySelector('span[data-testid="adaptiveEntityTitle"]') ??
        spotifyHeroFallback();
      const name = titleEl?.textContent?.trim() ?? '';
      if (titleEl && name.length >= 2) {
        out.push({
          kind: 'playlist',
          name,
          anchor: titleEl,
          primary: true,
          provider: 'spotify',
          playlistId: pm[1],
          playlistSource: 'spotify',
          pageUrl: location.href,
        });
      }
    }
  } else if (provider === 'deezer') {
    document
      .querySelectorAll<HTMLAnchorElement>('a[data-testid="thumbnail-title"][href*="/playlist/"]')
      .forEach((a) => {
        const href = a.getAttribute('href') ?? '';
        // smarttracklists aren't real playlists — the server can't resolve
        // them, so no pill (a fake "Save" would always fail).
        if (href.includes('/smarttracklist/')) return;
        const m = href.match(/\/playlist\/(\d+)/);
        if (!m) return;
        const name = a.textContent?.trim() ?? '';
        if (name.length < 2) return;
        out.push({
          kind: 'playlist',
          name,
          anchor: a,
          compact: true,
          provider: 'deezer',
          playlistId: m[1],
          playlistSource: 'deezer',
          pageUrl: location.href,
        });
      });
    const dm = location.pathname.match(/(?:^|\/)(?:[a-z]{2}\/)?playlist\/(\d+)/i);
    if (dm && !location.pathname.includes('/smarttracklist/')) {
      const anchor = document.querySelector('h1') ?? deezerArtistHeader();
      const name = anchor?.textContent?.trim() || metaTag('og:title') || '';
      if (anchor && name.length >= 2) {
        out.push({
          kind: 'playlist',
          name,
          anchor,
          primary: true,
          provider: 'deezer',
          playlistId: dm[1],
          playlistSource: 'deezer',
          pageUrl: location.href,
        });
      }
    }
  }
  return out;
}

function collectCandidates(): Candidate[] {
  if (location.hostname === 'open.spotify.com') return spotifyCandidates();
  if (location.hostname.includes('deezer')) return deezerCandidates();
  if (isBadgedYoutubeHost(location.hostname)) return youtubeCandidates();
  return genericCandidates();
}

/* ── badge chrome (shadow DOM) ── */

// The stylesheet is bundled into this script as a string at build time
// (esbuild text loader) and inlined as a <style> element in each badge's
// shadow root. No <link> and no runtime fetch: Chrome blocks <link> to
// chrome-extension:// URLs injected into pages, and fetch(getURL(...)) is
// refused on some pages ("Unsafe attempt to load URL ... Domains, protocols
// and ports must match.") even with web_accessible_resources. Bundling
// sidesteps all of it — the CSS is available synchronously at startup.
import badgeCssText from './page-badges.css';
function cssStyle(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = badgeCssText;
  return style;
}

function mountBadge(c: Candidate): HTMLElement {
  c.anchor.setAttribute(HOST_ATTR, '1');
  const host = document.createElement('span');
  host.className = 'ssb-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const css = cssStyle();
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'ssb-pill ssb-loading';
  pill.setAttribute('aria-label', 'Checking your SoulSync library');
  pill.title = 'Checking your SoulSync library…';
  pill.innerHTML = '<span class="ssb-dot"></span>';
  shadow.append(css, pill);
  // Primary subject: badge lives INSIDE the heading so it sits on the same
  // line as the name. The title element is often a block wrapper (Spotify's
  // [data-testid="entityTitle"] is a flow-root span around an h1), so target
  // the inner heading when there is one. Link badges go after the link
  // (never inside — that would make the badge part of the link target).
  if (c.primary) (c.anchor.querySelector('h1') ?? c.anchor).appendChild(host);
  else c.anchor.after(host);
  // Track-row pills sit inline beside the track title with a clear gap —
  // never drifting down to the artist line (Broque).
  if (c.kind === 'track' && c.compact) {
    host.style.display = 'inline-flex';
    host.style.marginLeft = '8px';
    host.style.verticalAlign = 'middle';
  }
  // Playlist-card pills: Spotify stretches the card's title link over the
  // whole card (::after overlay), which paints above the pill and swallows
  // its clicks — only a sliver stayed clickable. Lift the badge above that
  // overlay and give it breathing room above (Broque).
  if (c.kind === 'playlist' && !c.primary) {
    host.style.zIndex = '3';
    host.style.marginTop = '8px';
  }
  badges.set(host, {
    pill,
    candidate: c,
    visual: 'loading',
    libState: 'loading',
    watchState: null,
    watchStates: {},
    anchorText: c.anchor.textContent ?? '',
    artistWatchState: null,
    pop: null,
    popLayer: null,
  });
  pill.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // Playlist pill: the save flow runs directly off the pill — no popover.
    // "Save playlist"/"Save failed" click through to the save; "?" re-runs
    // the saved check (the badge is dropped so the next scan remounts it
    // fresh); "✓ Saved" is terminal and not clickable.
    if (c.kind === 'playlist') {
      const r = badges.get(host);
      if (!r) return;
      if (r.visual === 'save' || r.visual === 'save-failed') {
        quiet(onSavePlaylistPillClick(host));
      } else if (r.visual === 'unknown') {
        dropBadge(host, r);
      }
      return;
    }
    // Mini watchlist eye: one click adds (no modal, no popover); once
    // watching it opens the card.
    if (c.compact && c.kind === 'artist') {
      quiet(onMiniWatchClick(host));
      return;
    }
    // Full artist pill on the watchlist: two-click inline remove verify,
    // never a modal. The card no longer opens from a watching pill; the
    // artist link itself remains clickable.
    const r = badges.get(host);
    if (r && r.candidate.kind === 'artist' && !r.candidate.manualSearch && r.watchState === true) {
      quiet(onWatchingPillClick(host));
      return;
    }
    // Wishlist pill ("+ Wishlist track/album"): ONE CLICK adds directly —
    // no popover, no modal. Once wishlisted ("✓ Wishlisted") the pill is
    // not clickable: no re-add, no remove (Broque: no wishlist removal in
    // the extension).
    if (r && (r.candidate.kind === 'track' || r.candidate.kind === 'album')) {
      if (r.visual === 'acted') return; // wishlisted — not clickable
      if (r.visual === 'out' && r.libState === 'out') {
        quiet(onWishlistPillClick(host));
        return;
      }
    }
    togglePopover(host);
  });
  return host;
}

/** Direct wishlist add from the pill: one click, no popover. On success the
 *  pill becomes "✓ Wishlisted" (not clickable). On error the pill reverts
 *  and the popover opens to show what went wrong. */
async function onWishlistPillClick(host: HTMLElement): Promise<void> {
  const rec = badges.get(host);
  if (!rec) return;
  const c = rec.candidate;
  const { pill } = rec;
  // Album cards don't carry a tracklist — never pretend to wishlist zero
  // tracks. Open the popover to explain.
  if (c.kind === 'album' && (!c.tracks || c.tracks.length === 0)) {
    togglePopover(host);
    if (rec.pop)
      showError(rec, "Couldn't load this album's tracklist from here — open the album page to wishlist it.");
    return;
  }
  // Busy state: not clickable while the add is in flight.
  const prevVisual = rec.visual === 'loading' ? 'out' : rec.visual;
  pill.classList.add('ssb-busy');
  pill.title = 'Adding to your wishlist…';
  pill.setAttribute('aria-label', `${c.name}: adding to wishlist…`);
  const done = await badgeAction(rec, {
    action: c.kind === 'album' ? 'wishlist-album' : 'wishlist-track',
    artist: c.artist ?? '',
    title: c.name,
    ...(c.kind === 'album'
      ? { tracks: c.tracks ?? [], pageUrl: c.pageUrl, provider: c.provider }
      : {}),
  });
  pill.classList.remove('ssb-busy');
  if (done.error) {
    // Revert and show the error in the popover.
    setPillState(host, prevVisual);
    togglePopover(host);
    if (rec.pop) showError(rec, String(done.error));
    return;
  }
  actedKeys.add(badgeKeyFor(c));
  setPillState(host, 'acted');
}

/** Save-playlist pill click: one click runs the full flow in the
 *  background (fetch tracks → mirror → prepare-discovery). Busy state while
 *  in flight; "✓ Saved" (not clickable) on success. Errors are honest — the
 *  pill shows "⚠ Save failed" with the server's message as its title, and
 *  clicking retries. Never a fake success. */
async function onSavePlaylistPillClick(host: HTMLElement): Promise<void> {
  const rec = badges.get(host);
  if (!rec || rec.candidate.kind !== 'playlist') return;
  const c = rec.candidate;
  if (rec.visual !== 'save' && rec.visual !== 'save-failed') return;
  if (!c.playlistSource || !c.playlistId) return;
  const { pill } = rec;
  rec.saveError = undefined;
  pill.classList.add('ssb-busy');
  pill.title = `Saving ${c.name} to your SoulSync library…`;
  pill.setAttribute('aria-label', `${c.name}: saving playlist…`);
  pill.innerHTML = '<span aria-hidden="true">…</span><span>Saving…</span>';
  const done = await badgeAction(rec, {
    action: 'save-playlist',
    source: c.playlistSource,
    playlistId: c.playlistId,
    name: c.name,
  });
  pill.classList.remove('ssb-busy');
  if (!badges.get(host)) return; // dropped while in flight
  if (done.error) {
    rec.saveError = String(done.error);
    setPillState(host, 'save-failed');
    return;
  }
  savedPlaylistKeys.add(badgeKeyFor(c));
  setPillState(host, 'saved');
}

/** Mini 👁️ click: one-click watchlist add when not watching — no modal, no
 *  popover. Unknown state does nothing (strict tri-state); watching opens
 *  the card. */
async function onMiniWatchClick(host: HTMLElement): Promise<void> {
  const rec = badges.get(host);
  if (!rec) return;
  const c = rec.candidate;
  if (rec.watchState === true) {
    togglePopover(host);
    return;
  }
  if (rec.watchState !== false) return;
  const directSource =
    c.provider && WATCHLIST_DIRECT_SOURCES.has(c.provider) ? c.provider : undefined;
  if (c.providerId && directSource) {
    await onWatchArtistDirect(rec, rec.pill, c.providerId, c.name, directSource);
  } else {
    await onWatchArtist(rec, rec.pill, c.name);
  }
  // The watch add leaves its button disabled (the terminal "Watching..."
  // state for popover buttons). The mini eye must stay clickable — a second
  // click opens the card.
  if (badges.get(host) === rec) rec.pill.disabled = false;
}

function kindLabel(kind: Candidate['kind']): string {
  if (kind === 'playlist') return 'Playlist';
  return kind === 'artist' ? 'Artist' : kind === 'track' ? 'Track' : 'Album';
}

/** Armed-for-removal state per host for full "Watching" pills: first click
 *  arms the inline verify, second click removes. Never a modal. */
const unwatchArmed = new Map<HTMLElement, number>();

function clearUnwatchArm(host: HTMLElement): void {
  const t = unwatchArmed.get(host);
  if (t !== undefined) {
    window.clearTimeout(t);
    unwatchArmed.delete(host);
  }
}

/** First click on a watching pill: arm the inline verify ("✕ Remove?").
 *  A 5s timeout disarms silently back to "Watching". */
function armUnwatchPill(host: HTMLElement): void {
  const rec = badges.get(host);
  if (!rec || rec.watchState !== true) return;
  const pill = rec.pill;
  pill.className = 'ssb-pill ssb-unwatch-armed';
  pill.title = `${rec.candidate.name} — click again to remove from your watchlist.`;
  pill.setAttribute(
    'aria-label',
    `${rec.candidate.name}: click again to confirm removal from watchlist.`,
  );
  pill.innerHTML = '<span aria-hidden="true">✕</span><span>Remove?</span>';
  clearUnwatchArm(host);
  unwatchArmed.set(
    host,
    window.setTimeout(() => {
      unwatchArmed.delete(host);
      const r2 = badges.get(host);
      if (r2 && r2.watchState === true) setPillState(host, 'watching');
    }, 5000),
  );
}

/** Pill busy state while the remove call is in flight. */
function setPillRemoving(host: HTMLElement): void {
  const rec = badges.get(host);
  if (!rec) return;
  const pill = rec.pill;
  pill.className = 'ssb-pill ssb-unwatch-busy';
  pill.title = `Removing ${rec.candidate.name} from your watchlist…`;
  pill.setAttribute('aria-label', `${rec.candidate.name}: removing from watchlist…`);
  pill.innerHTML = '<span aria-hidden="true">…</span><span>Removing…</span>';
}

/** Full "Watching" pill click: two-click inline remove verify, never a
 *  modal. First click arms "✕ Remove?" (5s to confirm); the second click
 *  removes. The card no longer opens from a watching pill — the artist
 *  link itself stays clickable. */
async function onWatchingPillClick(host: HTMLElement): Promise<void> {
  const rec = badges.get(host);
  if (!rec || rec.candidate.kind !== 'artist' || rec.watchState !== true) return;
  if (unwatchArmed.has(host)) {
    clearUnwatchArm(host);
    setPillRemoving(host);
    const err = await onUnwatchArtist(rec, rec.candidate.name);
    const r2 = badges.get(host);
    if (!r2) return;
    if (err) {
      // Removal failed: restore the pill and surface the error in the card.
      setPillState(host, 'watching');
      if (!r2.pop) togglePopover(host);
      showError(r2, err);
    }
    // On success the live sync already restyled the pill to not-watching.
    return;
  }
  armUnwatchPill(host);
}

function setPillState(host: HTMLElement, visual: Exclude<PillVisual, 'loading'>): void {
  const rec = badges.get(host);
  if (!rec) return;
  rec.visual = visual;
  const { pill, candidate } = rec;
  const name = candidate.name;
  const mini = candidate.compact === true;
  // Compact artists are eye-only: 👁️ is SoulSync's standard watchlist icon
  // (artist-hero.tsx). Compact tracks/albums keep their labels at small size.
  const miniCls = mini ? ' ssb-mini' : '';
  if (visual === 'watching') {
    if (mini && candidate.kind === 'artist') {
      pill.className = `ssb-pill ssb-mini ssb-watching`;
      pill.title = `${name} — on your SoulSync watchlist. Click for details.`;
      pill.setAttribute('aria-label', `${name}: on your watchlist. Show details.`);
      pill.innerHTML = '<span aria-hidden="true">👁️</span>';
    } else {
      pill.className = `ssb-pill ssb-watching${miniCls}`;
      pill.title = `${name} — on your SoulSync watchlist. Click for details.`;
      pill.setAttribute('aria-label', `${name}: on your watchlist. Show details.`);
      pill.innerHTML = '<span aria-hidden="true">👁</span><span>Watching</span>';
    }
  } else if (visual === 'not-watching') {
    if (mini && candidate.kind === 'artist') {
      pill.className = `ssb-pill ssb-mini ssb-notwatching`;
      pill.title = `${name} — click to add to your SoulSync watchlist.`;
      pill.setAttribute('aria-label', `${name}: not on your watchlist. Add to watchlist.`);
      pill.innerHTML = '<span aria-hidden="true">👁️</span>';
    } else {
      pill.className = `ssb-pill ssb-notwatching${miniCls}`;
      pill.title = `${name} — click to add to your SoulSync watchlist.`;
      pill.setAttribute('aria-label', `${name}: not on your watchlist. Show actions.`);
      pill.innerHTML = '<span aria-hidden="true">👁</span><span>Add to Watchlist</span>';
    }
  } else if (visual === 'in') {
    // Album pills name their subject ("Album in library"); track pills are
    // terse ("In library") — the popover title already names the track.
    const label = candidate.kind === 'album' ? 'Album in library' : 'In library';
    pill.className = `ssb-pill ssb-in${miniCls}`;
    pill.title = `${name} — in your SoulSync library. Click for details.`;
    pill.setAttribute('aria-label', `${name}: in your SoulSync library. Show details.`);
    pill.innerHTML = `<span aria-hidden="true">✓</span><span>${label}</span>`;
  } else if (visual === 'acted') {
    if (candidate.kind === 'artist') {
      setPillState(host, 'watching');
      return;
    }
    // Wishlisted: not clickable — no re-add, no remove (Broque: the
    // extension never removes from the wishlist).
    pill.className = `ssb-pill ssb-acted${miniCls}`;
    pill.title = `${name} — on your SoulSync wishlist.`;
    pill.setAttribute('aria-label', `${name}: on your SoulSync wishlist.`);
    pill.innerHTML = '<span aria-hidden="true">✓</span><span>Wishlisted</span>';
  } else if (visual === 'manual-search') {
    // Couldn't determine the artist automatically — a quiet 🔍 that opens
    // manual search. Never a guessed watchlist add.
    pill.className = 'ssb-pill ssb-manual-search';
    pill.title = `${name} — couldn't determine the artist automatically. Click to search manually.`;
    pill.setAttribute('aria-label', `${name}: artist unknown. Search manually.`);
    pill.innerHTML = '<span aria-hidden="true">🔍</span>';
  } else if (visual === 'save') {
    // Save-playlist action pill — SoulSync green invite, mirrors the
    // watchlist add. One click runs the whole save flow.
    pill.className = `ssb-pill ssb-save${miniCls}`;
    pill.title = `${name} — save this playlist to your SoulSync library.`;
    pill.setAttribute('aria-label', `${name}: save playlist to SoulSync.`);
    pill.innerHTML = '<span aria-hidden="true">💾</span><span>Save playlist</span>';
  } else if (visual === 'saved') {
    // Already mirrored — quiet green, terminal, not clickable.
    pill.className = `ssb-pill ssb-saved${miniCls}`;
    pill.title = `${name} — already saved to your SoulSync library.`;
    pill.setAttribute('aria-label', `${name}: saved to SoulSync.`);
    pill.innerHTML = '<span aria-hidden="true">✓</span><span>Saved</span>';
  } else if (visual === 'save-failed') {
    // Honest failure — the server's message rides as the title, the label
    // stays short, and clicking retries.
    pill.className = `ssb-pill ssb-save-failed${miniCls}`;
    pill.title = rec.saveError ?? `${name} — save failed. Click to retry.`;
    pill.setAttribute('aria-label', `${name}: save failed. Click to retry.`);
    pill.innerHTML = '<span aria-hidden="true">⚠</span><span>Save failed</span>';
  } else if (visual === 'unknown') {
    pill.className = `ssb-pill ssb-unknown${miniCls}`;
    pill.title = "Couldn't check your SoulSync library";
    pill.setAttribute('aria-label', `${name}: status unknown. Show details.`);
    pill.textContent = '?';
  } else {
    // 'out': not in library yet — the pill IS the wishlist action: one
    // click adds directly, no popover. The "+" icon is already in the
    // markup, so the label must not repeat it ("++ Track").
    const label = candidate.kind === 'album' ? 'Wishlist album' : 'Wishlist track';
    pill.className = `ssb-pill ssb-out${miniCls}`;
    pill.title = `${name} — not in your library. Click to add to your wishlist.`;
    pill.setAttribute('aria-label', `${name}: not in your library. Add to wishlist.`);
    pill.innerHTML = `<span aria-hidden="true">+</span><span>${label}</span>`;
  }
}

function closePopover(rec: BadgeRec): void {
  (rec as { _popCleanup?: () => void })._popCleanup?.();
  (rec as { _popCleanup?: () => void })._popCleanup = undefined;
  rec.popLayer?.remove();
  rec.popLayer = null;
  rec.pop = null;
}

function showError(rec: BadgeRec, msg: string): void {
  if (!rec.pop) return;
  const err = rec.pop.querySelector('.ssb-err');
  if (err) {
    err.textContent = msg;
    err.removeAttribute('hidden');
  }
  const btn = rec.pop.querySelector<HTMLButtonElement>('.ssb-btn[disabled]');
  if (btn) {
    btn.disabled = false;
    btn.textContent = btn.dataset.label ?? 'Try again';
  }
}

async function badgeAction(
  rec: BadgeRec,
  msg: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return (await browser.runtime.sendMessage({
      type: 'SOULSYNC_BADGE_ACTION',
      ...msg,
    })) as Record<string, unknown>;
  } catch {
    return { error: 'Could not reach the extension background.' };
  }
}

/**
 * Scrape artwork for the card header from the page.
 * - Spotify: album art from the header, artist image from artist pages
 * - YouTube: video thumbnail or channel avatar
 * Returns empty string when nothing reliable is found.
 */
function cardArtwork(c: Candidate): string {
  try {
    const host = location.hostname;
    if (host === 'open.spotify.com') {
      // Spotify header images: the entity header has a large image
      const titleEl =
        document.querySelector('[data-testid="entityTitle"]') ?? spotifyHeroFallback();
      const img = titleEl
        ?.closest('[data-testid="entityHeader"]')
        ?.querySelector('img') as HTMLImageElement | null;
      if (img?.src) return img.src;
      // Fallback: any large image near the title
      const anyImg = document.querySelector('img[src*="i.scdn.co"]') as HTMLImageElement | null;
      if (anyImg?.src) return anyImg.src;
    } else if (host.includes('youtube.com')) {
      if (c.kind === 'artist') {
        // Channel avatar
        const avatar = document.querySelector('#channel-name')?.closest('ytd-channel-renderer, ytd-c4-tabbed-header-renderer')
          ?.querySelector('#avatar img, yt-img-shadow img') as HTMLImageElement | null;
        if (avatar?.src) return avatar.src;
      } else {
        // Video thumbnail
        const thumb = document.querySelector('ytd-watch-metadata #avatar img, #channel-name img') as HTMLImageElement | null;
        if (thumb?.src) return thumb.src;
      }
    }
    // Generic: Open Graph image
    const og = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
    if (og) return og;
  } catch {
    /* no artwork — placeholder */
  }
  return '';
}

function popShell(rec: BadgeRec, serverUrl: string): HTMLDivElement {
  const pop = document.createElement('div');
  const c = rec.candidate;
  pop.className = 'ssb-pop ssb-card';

  // Header: artwork + title + artist + kind tag. One structure for every
  // card kind — artist, track, album, manual-search.
  const header = document.createElement('div');
  header.className = 'ssb-card-header';
  const art = document.createElement('div');
  art.className = 'ssb-card-art';
  const artUrl = cardArtwork(c);
  const placeholder = c.kind === 'album' ? '💿' : c.kind === 'artist' ? '👤' : '🎵';
  if (artUrl) {
    const img = document.createElement('img');
    img.src = artUrl;
    img.alt = '';
    // If the artwork fails to load (broken URL, CSP, etc.), fall back to
    // the placeholder emoji instead of an empty box.
    img.addEventListener('error', () => {
      art.textContent = placeholder;
      art.classList.add('ssb-card-art-placeholder');
    });
    art.appendChild(img);
  } else {
    art.textContent = placeholder;
    art.classList.add('ssb-card-art-placeholder');
  }
  const titles = document.createElement('div');
  titles.className = 'ssb-card-titles';
  const title = document.createElement('div');
  title.className = 'ssb-card-title';
  // Multi-artist candidates ("Post Malone, Swae Lee") show the full credit
  // in the title — display only, never sent to the watchlist API as one name.
  title.textContent =
    c.artists && c.artists.length > 1 ? c.artists.join(', ') : c.name;
  titles.appendChild(title);
  if (c.kind !== 'artist' && c.artist) {
    const artist = document.createElement('div');
    artist.className = 'ssb-card-artist';
    artist.textContent = c.artist;
    titles.appendChild(artist);
  }
  const kind = document.createElement('span');
  kind.className = 'ssb-card-kind';
  // Manual-search cards name a video whose artist couldn't be determined —
  // "Artist" would be a lie; the card is about the video.
  kind.textContent =
    c.manualSearch ? 'Video' : c.kind === 'album' ? 'Album' : c.kind === 'artist' ? 'Artist' : 'Track';
  titles.appendChild(kind);
  header.append(art, titles);

  // Status strip: what we verified, in one calm line.
  const status = document.createElement('div');
  status.className = 'ssb-card-status';

  // Actions: the wishlist (item) and watchlist (artist) buttons stack here,
  // full-width, in SoulSync's standard button treatment.
  const actions = document.createElement('div');
  actions.className = 'ssb-card-actions';

  const err = document.createElement('div');
  err.className = 'ssb-err';
  err.hidden = true;

  const footer = document.createElement('div');
  footer.className = 'ssb-card-footer';
  const open = document.createElement('a');
  open.className = 'ssb-link';
  open.href = `${serverUrl.replace(/\/+$/, '')}/dashboard`;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open in SoulSync';
  footer.appendChild(open);

  pop.append(header, status, actions, err, footer);
  return pop;
}

/**
 * Keep the whole popover inside the viewport, anchored to the pill.
 * Prefers below the pill; flips above when there isn't room; clamps all
 * four edges. Called on open, on content changes (ResizeObserver), and on
 * window resize/scroll while open — so no matter where a badge is clicked,
 * the entire popover stays visible.
 */
function positionPop(rec: BadgeRec): void {
  const pop = rec.pop;
  if (!pop) return;
  const pillRect = rec.pill.getBoundingClientRect();
  // The pill may have been removed by an SPA re-render — bail instead of
  // parking the popover at a stale spot.
  if (pillRect.width === 0 && pillRect.height === 0 && !rec.pill.isConnected) return;
  const pw = pop.offsetWidth || 248;
  const ph = pop.offsetHeight || 160;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const GAP = 8;
  const MARGIN = 8;

  // Vertical: below the pill if it fits, else above, else the side with
  // more room (clamped).
  const below = pillRect.bottom + GAP;
  const above = pillRect.top - GAP - ph;
  let top: number;
  if (below + ph <= vh - MARGIN) {
    top = below;
  } else if (above >= MARGIN) {
    top = above;
  } else {
    // Neither fits fully — take the roomier side and clamp.
    const roomBelow = vh - MARGIN - below;
    const roomAbove = above - MARGIN;
    top = roomBelow >= roomAbove ? below : Math.max(MARGIN, vh - MARGIN - ph);
  }
  top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN));

  // Horizontal: align to the pill's left edge, clamp to the viewport.
  // Near the right edge, right-align to the pill instead of overflowing.
  let left = pillRect.left;
  if (left + pw > vw - MARGIN) {
    left = Math.max(MARGIN, pillRect.right - pw);
  }
  left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN));

  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;
}

function insertPop(rec: BadgeRec, pop: HTMLDivElement): void {
  // The popover lives in its own shadow root on a layer appended directly
  // to document.body. Kept inside the pill's shadow tree (nested deep in the
  // page DOM), the popover's fixed position did not land by the pill on the
  // test pages; at body level its coordinates are measured against the
  // viewport and it lands where the pill is. Verified on Spotify-shaped
  // fixtures in the lab, including viewport clamping.
  const layer = document.createElement('div');
  layer.className = 'ssb-pop-layer';
  const shadow = layer.attachShadow({ mode: 'open' });
  shadow.appendChild(cssStyle());
  shadow.appendChild(pop);
  document.body.appendChild(layer);
  rec.pop = pop;
  rec.popLayer = layer;
  positionPop(rec);
  // Re-position when async content (buttons, errors, deep links) changes
  // the popover's size, and while the page moves under it.
  const ro = new ResizeObserver(() => positionPop(rec));
  ro.observe(pop);
  const onViewChange = (): void => positionPop(rec);
  window.addEventListener('resize', onViewChange);
  window.addEventListener('scroll', onViewChange, true);
  (rec as { _popCleanup?: () => void })._popCleanup = () => {
    ro.disconnect();
    window.removeEventListener('resize', onViewChange);
    window.removeEventListener('scroll', onViewChange, true);
  };
}

/* ── Add to Watchlist (SoulSync-styled) ────────────────────────────────
 * Mirrors SoulSync's own artist-page watchlist button: 👁️ icon + bold label
 * on an accent-tinted gradient, flipping to amber "Watching..." when the
 * artist is on the watchlist.
 *
 * Two paths:
 * - direct: the page URL carries a native provider ID that the server's
 *   watchlist/add accepts as `source` (spotify/deezer) — one click adds, no
 *   name search. Membership is checked when the popover opens.
 * - name: resolve the page's artist name through the server first and
 *   confirm the match before adding. Used where the URL has no usable ID
 *   (Bandcamp, SoundCloud) or the server rejects the source
 *   (tidal — not a watchlist source). Membership is checked after resolve.
 */

/** watchlist/add `source` values the server accepts (core/watchlist_sources.py). */
const WATCHLIST_DIRECT_SOURCES: ReadonlySet<string> = new Set(['spotify', 'deezer']);

function watchlistButton(artistName?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ssb-watchlist-btn';
  // Identity for live sync: syncArtistWatchState() finds every button for an
  // artist across pills and popovers (they live in shadow roots, so a plain
  // document query can't reach them — the sync walks badge records instead).
  if (artistName) btn.dataset.artist = artistName;
  const icon = document.createElement('span');
  icon.className = 'watchlist-icon';
  icon.textContent = '👁️';
  const label = document.createElement('span');
  label.className = 'watchlist-text';
  label.textContent = artistName ? `Add ${artistName} to Watchlist` : 'Add to Watchlist';
  btn.append(icon, label);
  return btn;
}

type WatchlistBtnState = 'idle' | 'busy' | 'watching' | 'confirm-remove';

function setWatchlistBtn(
  btn: HTMLButtonElement,
  state: WatchlistBtnState,
  busyLabel = 'Working…',
  artistName?: string,
): void {
  const label = btn.querySelector('.watchlist-text');
  btn.classList.toggle('watching', state === 'watching');
  btn.classList.toggle('confirm-remove', state === 'confirm-remove');
  // Removal is a two-click inline verify, never a modal: 'watching' arms on
  // first click, 'confirm-remove' removes on second. Only 'busy' disables.
  if (state !== 'confirm-remove') delete btn.dataset.armed;
  btn.disabled = state === 'busy';
  const addLabel = artistName ? `Add ${artistName} to Watchlist` : 'Add to Watchlist';
  if (label) {
    label.textContent =
      state === 'watching'
        ? '✓ Watching'
        : state === 'confirm-remove'
          ? '✕ Confirm remove?'
          : state === 'busy'
            ? busyLabel
            : addLabel;
  }
}

function markActedAndClose(rec: BadgeRec): void {
  actedKeys.add(badgeKeyFor(rec.candidate));
  closePopover(rec);
  const host = [...badges.entries()].find(([, r]) => r === rec)?.[0];
  if (host) setPillState(host, 'acted');
}

/** Flip an artist's watchlist state live across the whole page: every open
 *  popover button for the artist, the artist's own page pill, and the
 *  remembered state on track/album cards naming the artist. The popover stays
 *  open so the user sees the button change. */
function syncArtistWatchState(artistName: string, watching: boolean): void {
  const norm = normName(artistName);
  badges.forEach((rec, host) => {
    const c = rec.candidate;
    // Manual-search pills name a channel, not a verified artist — never
    // restyle them as a watch state.
    if (c.manualSearch) return;
    // A state flip invalidates any armed inline-remove on this host.
    clearUnwatchArm(host);
    if (c.kind === 'artist' && normName(c.name) === norm) {
      rec.watchState = watching;
      setPillState(host, watching ? 'watching' : 'not-watching');
    }
    if (c.artist && normName(c.artist) === norm) {
      rec.artistWatchState = watching;
    }
    rec.pop?.querySelectorAll<HTMLButtonElement>('.ssb-watchlist-btn').forEach((b) => {
      if (normName(b.dataset.artist ?? '') !== norm) return;
      setWatchlistBtn(b, watching ? 'watching' : 'idle', 'Working…', b.dataset.artist);
    });
    // Keep an open artist card's status strip honest too — it names the
    // watch state, so it must flip with the button.
    if (c.kind === 'artist' && normName(c.name) === norm && !c.manualSearch) {
      const status = rec.pop?.querySelector('.ssb-card-status');
      if (status) {
        status.classList.remove('ssb-in', 'ssb-out', 'ssb-unknown');
        if (watching) {
          status.textContent = '✓ On your watchlist';
          status.classList.add('ssb-in');
        } else {
          status.textContent = 'Not on your watchlist';
          status.classList.add('ssb-out');
        }
      }
    }
  });
}

/** Direct path: native provider ID from the URL, no search step. One click
 *  adds — no confirm modal. The button already names the artist, and the
 *  state syncs live everywhere. */
async function onWatchArtistDirect(
  rec: BadgeRec,
  btn: HTMLButtonElement,
  artistId: string,
  artistName: string,
  source: string,
): Promise<void> {
  setWatchlistBtn(btn, 'busy', 'Adding…');
  const done = await badgeAction(rec, {
    action: 'watch-artist',
    id: artistId,
    name: artistName,
    source,
  });
  if (done.error) {
    showError(rec, String(done.error));
    setWatchlistBtn(btn, 'idle', 'Working…', artistName);
    return;
  }
  syncArtistWatchState(artistName, true);
}

/** Name path: resolve the name, then add directly — no confirm modal. The
 *  button already names the artist ("Add X to Watchlist"), so the user knows
 *  exactly who they're adding before they click. */
async function onWatchArtist(rec: BadgeRec, btn: HTMLButtonElement, artistName: string): Promise<void> {
  setWatchlistBtn(btn, 'busy', 'Matching…');
  const resolved = await badgeAction(rec, { action: 'resolve-artist', name: artistName });
  if (resolved.error || !resolved.id) {
    showError(rec, String(resolved.error ?? 'No match found.'));
    setWatchlistBtn(btn, 'idle', 'Working…', artistName);
    return;
  }
  const resolvedId = String(resolved.id);
  const resolvedName = String(resolved.name);
  const resolvedSource = typeof resolved.source === 'string' ? resolved.source : undefined;
  setWatchlistBtn(btn, 'busy', 'Adding…');
  const done = await badgeAction(rec, {
    action: 'watch-artist',
    id: resolvedId,
    name: resolvedName,
    source: resolvedSource,
  });
  if (done.error) {
    showError(rec, String(done.error));
    setWatchlistBtn(btn, 'idle', 'Working…', artistName);
    return;
  }
  syncArtistWatchState(resolvedName, true);
}

/** Remove an artist from the watchlist. Resolves the artist ID — direct
 *  providerId when WATCHLIST_DIRECT_SOURCES has the provider, else the
 *  resolve-artist badge action — then removes. Removal is always the
 *  confirmed second click; the caller arms the inline verify first, never
 *  a modal. On success the live sync flips pills/cards both ways; on error
 *  the message shows via showError and the caller restores its UI.
 *  Returns null on success, the error message on failure. */
async function onUnwatchArtist(rec: BadgeRec, artistName: string): Promise<string | null> {
  const c = rec.candidate;
  const directSource =
    c.kind === 'artist' && c.provider && WATCHLIST_DIRECT_SOURCES.has(c.provider)
      ? c.provider
      : undefined;
  let artistId: string;
  let resolvedName = artistName;
  if (c.providerId && directSource) {
    artistId = c.providerId;
  } else {
    const resolved = await badgeAction(rec, { action: 'resolve-artist', name: artistName });
    if (resolved.error || !resolved.id) {
      const msg = String(resolved.error ?? 'No match found.');
      showError(rec, msg);
      return msg;
    }
    artistId = String(resolved.id);
    resolvedName = String(resolved.name ?? artistName);
  }
  const done = await badgeAction(rec, { action: 'unwatch-artist', id: artistId, name: resolvedName });
  if (done.error) {
    const msg = String(done.error);
    showError(rec, msg);
    return msg;
  }
  syncArtistWatchState(resolvedName, false);
  return null;
}

/** Card watchlist button click: one-click add when not watching (no modal,
 *  no change); two-click inline remove verify when watching — first click
 *  arms "✕ Confirm remove?", second click removes. Never a modal. */
async function onCardWatchlistClick(
  rec: BadgeRec,
  btn: HTMLButtonElement,
  artistName: string,
  direct?: { id: string; source: string },
): Promise<void> {
  if (btn.dataset.armed === '1') {
    // Second click: confirmed removal.
    delete btn.dataset.armed;
    setWatchlistBtn(btn, 'busy', 'Removing…', artistName);
    const err = await onUnwatchArtist(rec, artistName);
    if (err) {
      // Back to the watching state; the error is already shown in the card.
      setWatchlistBtn(btn, 'watching', 'Working…', artistName);
    }
    // On success the live sync restyled the button to idle ("Add …").
    return;
  }
  if (btn.classList.contains('watching')) {
    // First click on a watching button: arm the inline verify.
    btn.dataset.armed = '1';
    setWatchlistBtn(btn, 'confirm-remove', 'Working…', artistName);
    return;
  }
  // Not watching: add directly — one click, no modal.
  if (direct) await onWatchArtistDirect(rec, btn, direct.id, artistName, direct.source);
  else await onWatchArtist(rec, btn, artistName);
}

async function onWishlistTrack(rec: BadgeRec, btn: HTMLButtonElement): Promise<void> {
  btn.dataset.label = btn.textContent ?? '';
  btn.disabled = true;
  btn.textContent = 'Adding…';
  const c = rec.candidate;
  const done = await badgeAction(rec, {
    action: 'wishlist-track',
    artist: c.artist ?? '',
    title: c.name,
  });
  if (done.error) {
    showError(rec, String(done.error));
    btn.disabled = false;
    btn.textContent = btn.dataset.label || '＋ Wishlist track';
    return;
  }
  actedKeys.add(badgeKeyFor(c));
  closePopover(rec);
  const host = [...badges.entries()].find(([, r]) => r === rec)?.[0];
  if (host) setPillState(host, 'acted');
}

async function onWishlistAlbum(rec: BadgeRec, btn: HTMLButtonElement): Promise<void> {
  btn.dataset.label = btn.textContent ?? '';
  const c = rec.candidate;
  // Album cards don't carry a tracklist — never pretend to wishlist zero
  // tracks. Say plainly what the user can do instead.
  if (!c.tracks || c.tracks.length === 0) {
    showError(rec, "Couldn't load this album's tracklist from here — open the album page to wishlist it.");
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Adding…';
  const done = await badgeAction(rec, {
    action: 'wishlist-album',
    artist: c.artist ?? '',
    title: c.name,
    tracks: c.tracks ?? [],
    pageUrl: c.pageUrl,
    provider: c.provider,
  });
  if (done.error) {
    showError(rec, String(done.error));
    return;
  }
  actedKeys.add(badgeKeyFor(c));
  closePopover(rec);
  const host = [...badges.entries()].find(([, r]) => r === rec)?.[0];
  if (host) setPillState(host, 'acted');
}

/** Manual artist search for popovers where the artist couldn't be
 *  determined (YouTube 🔍) or verified (artist popover with unknown watch
 *  state). Type a name → debounced server search → results each with a
 *  one-click "Add to Watchlist". Never guesses: the user picks the artist
 *  explicitly. Shared by both popovers — autofocus only for the 🔍 flow. */
function insertManualArtistSearch(rec: BadgeRec, pop: HTMLDivElement, autofocus = true): void {
  const wrap = document.createElement('div');
  wrap.className = 'ssb-artist-search';

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'ssb-artist-search-input';
  input.placeholder = 'Search for the artist…';
  input.setAttribute('aria-label', 'Search for the artist to watch');
  input.autocomplete = 'off';
  input.spellcheck = false;

  const results = document.createElement('div');
  results.className = 'ssb-artist-search-results';

  const hint = document.createElement('div');
  hint.className = 'ssb-artist-search-hint';
  hint.textContent = 'Type at least 2 characters to search your server.';
  results.appendChild(hint);

  wrap.append(input, results);
  const actions = pop.querySelector('.ssb-card-actions');
  if (actions) actions.appendChild(wrap);
  else pop.insertBefore(wrap, pop.querySelector('.ssb-err'));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  async function runSearch(q: string): Promise<void> {
    const mySeq = ++seq;
    results.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'ssb-artist-search-hint';
    loading.textContent = 'Searching…';
    results.appendChild(loading);

    const res = await badgeAction(rec, { action: 'search-artists', query: q });
    if (mySeq !== seq || !rec.pop) return; // stale or closed
    results.textContent = '';

    if (res.error) {
      const e = document.createElement('div');
      e.className = 'ssb-artist-search-hint';
      e.textContent = String(res.error);
      results.appendChild(e);
      return;
    }
    const artists = Array.isArray(res.artists) ? res.artists : [];
    if (artists.length === 0) {
      const e = document.createElement('div');
      e.className = 'ssb-artist-search-hint';
      e.textContent = `No artists found for "${q}".`;
      results.appendChild(e);
      return;
    }
    for (const a of artists) {
      const o = a as { id?: unknown; name?: unknown; image?: unknown; source?: unknown };
      const id = String(o.id ?? '');
      const name = String(o.name ?? '');
      const image = String(o.image ?? '');
      const source = String(o.source ?? '');
      if (!id || !name) continue;

      const row = document.createElement('div');
      row.className = 'ssb-artist-search-row';

      if (image) {
        const img = document.createElement('img');
        img.className = 'ssb-artist-search-thumb';
        img.src = image;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => img.remove());
        row.appendChild(img);
      }
      const label = document.createElement('span');
      label.className = 'ssb-artist-search-name';
      label.textContent = name;
      row.appendChild(label);

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ssb-btn ssb-artist-search-add';
      add.textContent = '＋ Watch';
      add.setAttribute('aria-label', `Add ${name} to watchlist`);
      add.addEventListener('click', () => {
        void (async () => {
          add.disabled = true;
          add.textContent = 'Adding…';
          const done = await badgeAction(rec, {
            action: 'watch-artist',
            id,
            name,
            source: source || undefined,
          });
          if (done.error) {
            showError(rec, String(done.error));
            add.disabled = false;
            add.textContent = '＋ Watch';
            return;
          }
          add.textContent = '✓ Watching';
          syncArtistWatchState(name, true);
        })();
      });
      row.appendChild(add);
      results.appendChild(row);
    }
  }

  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      seq++; // cancel in-flight
      results.textContent = '';
      const h = document.createElement('div');
      h.className = 'ssb-artist-search-hint';
      h.textContent = 'Type at least 2 characters to search your server.';
      results.appendChild(h);
      return;
    }
    timer = setTimeout(() => void runSearch(q), 350);
  });

  // Don't let YouTube's keyboard shortcuts swallow typing.
  input.addEventListener('keydown', (e) => e.stopPropagation());
  input.addEventListener('keypress', (e) => e.stopPropagation());
  // Focus the input when the popover opens — the user clicked 🔍 to search.
  // The artist-popover fallback leaves focus alone (the user is reading).
  if (autofocus) setTimeout(() => input.focus(), 50);
}

/** Watchlist button for an artist candidate: direct provider-ID path when the
 *  URL carries one the server accepts (spotify/deezer), name-resolve path
 *  otherwise. The scan already fetched the watch state, so the button renders
 *  in its final state immediately — no membership check on open. Always
 *  visible and named; the artist is the popover's subject. */
function insertArtistWatchlist(rec: BadgeRec, pop: HTMLDivElement, c: Candidate): void {
  const directSource =
    c.provider && WATCHLIST_DIRECT_SOURCES.has(c.provider) ? c.provider : undefined;
  const watch = watchlistButton(c.name);
  const direct =
    c.providerId && directSource ? { id: c.providerId, source: directSource } : undefined;
  setWatchlistBtn(watch, rec.watchState === true ? 'watching' : 'idle', 'Working…', c.name);
  watch.addEventListener('click', () => quiet(onCardWatchlistClick(rec, watch, c.name, direct)));
  const actions = pop.querySelector('.ssb-card-actions');
  if (actions) actions.appendChild(watch);
  else pop.insertBefore(watch, pop.querySelector('.ssb-err'));
}

/** One watchlist button per artist for multi-artist candidates ("Post
 *  Malone, Swae Lee"). Each button checks/adds its own artist independently
 *  — the combined string is never sent to the watchlist API. Split names
 *  carry no provider ID (YouTube has none), so every button uses the name-
 *  resolve path. */
function insertMultiArtistWatchlist(
  rec: BadgeRec,
  pop: HTMLDivElement,
  _c: Candidate,
  names: string[],
): void {
  const actions = pop.querySelector('.ssb-card-actions');
  for (const n of names) {
    const watch = watchlistButton(n);
    setWatchlistBtn(
      watch,
      (rec.watchStates[normName(n)] ?? null) === true ? 'watching' : 'idle',
      'Working…',
      n,
    );
    watch.addEventListener('click', () => quiet(onCardWatchlistClick(rec, watch, n, undefined)));
    if (actions) actions.appendChild(watch);
    else pop.insertBefore(watch, pop.querySelector('.ssb-err'));
  }
}

/** Watchlist button for a bare artist name (album/track popovers). Renders
 *  the artist's real watch state from the scan — never a guessed "add".
 *  When the page gave us the artist's provider ID (e.g. Deezer ID from an
 *  album page's artist link), the click uses the direct path — no
 *  name-resolve search. */
function insertWatchArtistByName(
  rec: BadgeRec,
  pop: HTMLDivElement,
  artistName: string,
  direct?: { id: string; source: string },
): void {
  const watch = watchlistButton(artistName);
  // Multi-artist candidates carry a per-name state; fall back to the
  // candidate-level state for single artists.
  const st = rec.watchStates[normName(artistName)] ?? rec.artistWatchState;
  setWatchlistBtn(watch, st === true ? 'watching' : 'idle', 'Working…', artistName);
  watch.addEventListener('click', () => quiet(onCardWatchlistClick(rec, watch, artistName, direct)));
  // The watchlist button lives in the card's action stack — full-width,
  // SoulSync-standard, next to the wishlist action when there is one.
  const actions = pop.querySelector('.ssb-card-actions');
  if (actions) actions.appendChild(watch);
  else pop.insertBefore(watch, pop.querySelector('.ssb-err'));
}

/**
 * Deep-link the popover's "Open in SoulSync" anchor at the exact library
 * entity (artist page, album focused when we can pin it). Starts at the
 * dashboard and upgrades when the resolve lands — never blocks the popover.
 */
function wireLibraryLink(rec: BadgeRec, pop: HTMLDivElement): void {
  const link = pop.querySelector<HTMLAnchorElement>('.ssb-link');
  if (!link) return;
  const c = rec.candidate;
  void (async () => {
    const res = await badgeAction(rec, {
      action: 'library-link',
      kind: c.kind,
      name: c.name,
      artist: c.artist,
    });
    if (!link.isConnected) return;
    if (typeof res.url === 'string' && res.url) link.href = res.url;
  })();
}

function togglePopover(host: HTMLElement): void {
  const rec = badges.get(host);
  if (!rec) return;
  if (rec.pop) {
    closePopover(rec);
    return;
  }
  const serverUrl = recServerUrl.get(host) ?? '';
  const pop = popShell(rec, serverUrl);
  const c = rec.candidate;

  // Status strip — always honest about what we verified. Artists show
  // watch state (in-library is not the same as watched); tracks/albums
  // show library state.
  const status = pop.querySelector('.ssb-card-status');
  const actions = pop.querySelector('.ssb-card-actions');
  if (c.kind === 'artist' && !c.manualSearch) {
    const names = c.artists && c.artists.length > 0 ? c.artists : [c.name];
    const states = names.map((n) => rec.watchStates[normName(n)] ?? null);
    if (names.length > 1) {
      // Multi-artist: honest aggregate — all watched, all not, some of
      // each, or unknown.
      const known = states.filter((s) => s !== null);
      if (states.every((s) => s === true)) {
        if (status) {
          status.textContent = '✓ On your watchlist';
          status.classList.add('ssb-in');
        }
      } else if (states.every((s) => s === false)) {
        if (status) {
          status.textContent = 'Not on your watchlist';
          status.classList.add('ssb-out');
        }
      } else if (known.some((s) => s === true)) {
        if (status) {
          status.textContent = 'Partially on your watchlist';
          status.classList.add('ssb-unknown');
        }
      } else if (status) {
        status.textContent = "Couldn't verify watchlist status";
        status.classList.add('ssb-unknown');
      }
    } else if (rec.watchState === true) {
      if (status) {
        status.textContent = '✓ On your watchlist';
        status.classList.add('ssb-in');
      }
    } else if (rec.watchState === false) {
      if (status) {
        status.textContent = 'Not on your watchlist';
        status.classList.add('ssb-out');
      }
    } else if (status) {
      status.textContent = "Couldn't verify watchlist status";
      status.classList.add('ssb-unknown');
    }
  } else if (rec.libState === 'in') {
    if (status) {
      status.textContent =
        c.kind === 'album' ? '✓ Album in your library' : '✓ In your SoulSync library';
      status.classList.add('ssb-in');
    }
    wireLibraryLink(rec, pop);
  } else if (rec.libState === 'out') {
    if (status) {
      status.textContent = 'Not in your SoulSync library';
      status.classList.add('ssb-out');
    }
  } else if (rec.libState === 'unknown' && status) {
    status.textContent = "Couldn't reach your library to check this one";
    status.classList.add('ssb-unknown');
  }

  if (c.kind === 'artist') {
    if (c.manualSearch) {
      // The title didn't name the artist — no guessed watchlist add. The
      // card offers an in-popover artist search: type a name, pick a
      // result, add it to the watchlist directly.
      if (status) {
        status.textContent = "Couldn't determine the artist from this video";
        status.classList.add('ssb-unknown');
      }
      insertManualArtistSearch(rec, pop);
    } else {
      // The artist's primary action is the watchlist — always visible, named,
      // in its known state. In-library is not the same as watched.
      const names = c.artists && c.artists.length > 0 ? c.artists : [c.name];
      if (names.length > 1) insertMultiArtistWatchlist(rec, pop, c, names);
      else insertArtistWatchlist(rec, pop, c);
      // Auto-match failed for at least one artist ("Couldn't verify
      // watchlist status") — offer the manual artist search right here so
      // the user doesn't have to hunt for the 🔍 pill.
      const states = names.map((n) => rec.watchStates[normName(n)] ?? null);
      if (states.some((s) => s === null)) insertManualArtistSearch(rec, pop, false);
    }
  } else if (rec.libState === 'out') {
    // Not in the library: the wishlist action is the "add to library" path
    // for tracks/albums; the watchlist belongs to the artist.
    if (c.kind === 'track') {
      const wl = document.createElement('button');
      wl.type = 'button';
      wl.className = 'ssb-btn ssb-primary';
      wl.textContent = '＋ Wishlist track';
      wl.addEventListener('click', () => void onWishlistTrack(rec, wl));
      if (actions) actions.appendChild(wl);
      else pop.insertBefore(wl, pop.querySelector('.ssb-err'));
    } else if (c.kind === 'album' && c.artist) {
      // Album cards don't carry a tracklist (only album pages do) — the
      // button still shows; onWishlistAlbum explains when it can't resolve.
      const wl = document.createElement('button');
      wl.type = 'button';
      wl.className = 'ssb-btn ssb-primary';
      const n = c.tracks?.length ?? 0;
      wl.textContent = n > 0 ? `＋ Wishlist album (${n} tracks)` : '＋ Wishlist album';
      wl.addEventListener('click', () => void onWishlistAlbum(rec, wl));
      if (actions) actions.appendChild(wl);
      else pop.insertBefore(wl, pop.querySelector('.ssb-err'));
    }
    // Multi-artist credits ("Post Malone, Swae Lee") get one watchlist
    // button per artist — the combined string is never sent to the
    // watchlist API. The direct provider-ID path only applies to a single
    // artist (split names carry no provider ID).
    const artistNames =
      c.artists && c.artists.length > 0 ? c.artists : c.artist ? [c.artist] : [];
    if (c.artist) {
      // Direct path when the page gave us the artist's provider ID (e.g.
      // Deezer ID from an album page's artist link) — no name-resolve.
      const direct =
        artistNames.length === 1 &&
        c.artistProviderId &&
        c.provider &&
        WATCHLIST_DIRECT_SOURCES.has(c.provider)
          ? { id: c.artistProviderId, source: c.provider }
          : undefined;
      for (const n of artistNames) insertWatchArtistByName(rec, pop, n, direct);
    }
  } else if (rec.libState === 'in' && c.artist) {
    // In the library: deep link above, watchlist still reachable.
    const artistNames =
      c.artists && c.artists.length > 0 ? c.artists : [c.artist];
    const direct =
      artistNames.length === 1 &&
      c.artistProviderId &&
      c.provider &&
      WATCHLIST_DIRECT_SOURCES.has(c.provider)
        ? { id: c.artistProviderId, source: c.provider }
        : undefined;
    for (const n of artistNames) insertWatchArtistByName(rec, pop, n, direct);
  }
  // libState 'unknown': the status strip explains; no actions on an
  // unverified guess. (The watchlist add is safe to offer even then, but the
  // resolve it needs is itself a verification step — keep the popover honest
  // and quiet.)
  insertPop(rec, pop);
}

const recServerUrl = new Map<HTMLElement, string>();

/* ── scan lifecycle ── */

/** Remove a badge: close its popover, detach the host, forget the record,
 *  and free the anchor for remounting. */
function dropBadge(host: HTMLElement, rec: BadgeRec): void {
  if (rec.pop) closePopover(rec);
  host.remove();
  badges.delete(host);
  rec.candidate.anchor.removeAttribute(HOST_ATTR);
}

/** Individual artist names a candidate wants watch-checked. */
function watchNamesFor(c: Candidate): string[] {
  if (c.artists && c.artists.length > 0) return c.artists;
  if (c.kind === 'artist') return [c.name];
  return c.artist ? [c.artist] : [];
}

/** Deezer album tracklist via the background (api.deezer.com sends no CORS
 *  headers, so the content script cannot fetch it). Fire-and-forget: it
 *  mutates c.tracks, which the wishlist action reads at click time — the
 *  pill never waits for it. A failure just leaves the album trackless (no
 *  Wishlist button), exactly today's behavior. */
async function fetchDeezerTracks(c: Candidate): Promise<void> {
  try {
    const r = (await browser.runtime.sendMessage({
      type: 'SOULSYNC_DEEZER_TRACKS',
      id: c.providerId,
    })) as { tracks?: unknown };
    if (Array.isArray(r?.tracks)) {
      const titles = (r.tracks as unknown[]).filter(
        (t): t is string => typeof t === 'string' && t.length > 0,
      );
      if (titles.length > 0) c.tracks = titles;
    }
  } catch {
    /* trackless — no Wishlist button, as before */
  }
}

/** Per-playlist saved check: renders this candidate's pill the moment its own
 *  result arrives instead of waiting for a batch. Tri-state: saved →
 *  "✓ Saved" (terminal, not clickable), not saved → "💾 Save playlist",
 *  unverifiable → "?" (clicking re-runs the check via a remount). */
async function resolvePlaylistSaved(c: Candidate, host: HTMLElement): Promise<void> {
  const key = badgeKeyFor(c);
  const early = badges.get(host);
  if (!early || early.candidate !== c) return; // dropped or replaced since
  if (savedPlaylistKeys.has(key)) {
    setPillState(host, 'saved');
    return;
  }
  let saved: boolean | null = null;
  try {
    const r = (await browser.runtime.sendMessage({
      type: 'SOULSYNC_BADGE_ACTION',
      action: 'check-saved-playlist',
      source: c.playlistSource,
      playlistId: c.playlistId,
    })) as { saved?: boolean | null };
    saved = typeof r?.saved === 'boolean' ? r.saved : null;
  } catch {
    saved = null;
  }
  const rec = badges.get(host);
  if (!rec || rec.candidate !== c) return; // dropped or replaced since
  rec.libState = 'unknown';
  rec.watchState = null;
  if (savedPlaylistKeys.has(key)) setPillState(host, 'saved');
  else setPillState(host, saved === true ? 'saved' : saved === false ? 'save' : 'unknown');
}

/** Per-item library lookup: renders this candidate's pill the moment its
 *  own result arrives instead of waiting for the batch. Artist pills wait
 *  for their watch lookup (renderArtistPill) instead. */
async function resolveLibrary(c: Candidate, host: HTMLElement): Promise<void> {
  let resp: { configured?: boolean; results?: Record<string, boolean | null>; serverUrl?: string };
  try {
    resp = (await browser.runtime.sendMessage({
      type: 'SOULSYNC_BADGE_LOOKUP',
      items: [{ kind: c.kind, name: c.name, artist: c.artist }],
    })) as typeof resp;
  } catch {
    resp = {};
  }
  const rec = badges.get(host);
  if (!rec || rec.candidate !== c) return; // dropped or replaced since
  if (!resp.configured) {
    // No server configured — take this loading pill back down silently and
    // unmark the anchor so a later configure retries it.
    badges.delete(host);
    host.remove();
    c.anchor.removeAttribute(HOST_ATTR);
    return;
  }
  recServerUrl.set(host, resp.serverUrl ?? '');
  if (c.manualSearch) {
    // Channel name, not a verified artist: no library/watch claims, just
    // the 🔍 that opens manual search.
    rec.libState = 'unknown';
    rec.watchState = null;
    setPillState(host, 'manual-search');
    return;
  }
  // Tri-state: true = in library, false = verified absent, anything else
  // (null / missing key) = couldn't verify — never show "not in library".
  const v = resp.results?.[badgeKeyFor(c)];
  rec.libState = v === true ? 'in' : v === false ? 'out' : 'unknown';
  if (actedKeys.has(badgeKeyFor(c))) {
    setPillState(host, 'acted');
    return;
  }
  if (c.kind === 'artist') return; // pill renders from the watch lookup
  setPillState(host, rec.libState);
}

/** Per-artist watch lookup: updates every live badge naming this artist and
 *  renders artist pills whose primary artist just resolved. Late arrivals
 *  never clobber a pill the user already acted on (visual !== 'loading'). */
async function resolveWatch(item: { name: string; providerId?: string }): Promise<void> {
  let resp: { configured?: boolean; results?: Record<string, { watching: boolean | null }> };
  try {
    resp = (await browser.runtime.sendMessage({
      type: 'SOULSYNC_WATCH_STATES',
      items: [item],
    })) as typeof resp;
  } catch {
    resp = {};
  }
  const key = `artist:${normName(item.name)}`;
  // Unknown unless the server positively answered. (A dead server means the
  // library pass already took the pills down, so there is nothing to update.)
  const watching = resp.configured === false ? null : (resp.results?.[key]?.watching ?? null);
  for (const [host, rec] of badges) {
    const c = rec.candidate;
    if (c.manualSearch) continue;
    if (!watchNamesFor(c).some((n) => `artist:${normName(n)}` === key)) continue;
    rec.watchStates[normName(item.name)] = watching;
    if (c.kind === 'artist') renderArtistPill(host, rec);
    else {
      // The card's artist row needs the artist's true watch state. For
      // multi-artist candidates each name is checked separately; the row
      // follows the primary artist.
      const artistNames =
        c.artists && c.artists.length > 0 ? c.artists : c.artist ? [c.artist] : [];
      rec.artistWatchState = artistNames.length
        ? (rec.watchStates[normName(artistNames[0])] ?? null)
        : null;
    }
  }
}

/** Render an artist pill once its primary artist's watch state has arrived.
 *  Only transitions out of 'loading' — a later resolution never overrides
 *  a pill the user already acted on. The pill follows the first/primary
 *  artist; the popover lists them all. */
function renderArtistPill(host: HTMLElement, rec: BadgeRec): void {
  if (rec.visual !== 'loading') return;
  const c = rec.candidate;
  const primaryKey = normName(c.name);
  if (!(primaryKey in rec.watchStates)) return; // primary still in flight
  const w = rec.watchStates[primaryKey] ?? null;
  rec.watchState = w;
  if (c.compact && w !== true && w !== false) {
    // Strict tri-state: an unknown watch state renders nothing on a mini
    // button — never a guessed eye. The anchor is unmarked so a later
    // scan retries (the lookup may have been transient).
    dropBadge(host, rec);
    return;
  }
  setPillState(host, w === true ? 'watching' : w === false ? 'not-watching' : 'unknown');
}

async function scan(): Promise<void> {
  const collected = collectCandidates();
  const byAnchor = new Map<Element, string>();
  for (const c of collected) {
    if (!byAnchor.has(c.anchor)) byAnchor.set(c.anchor, badgeKeyFor(c));
  }
  // Stale sweep: SPA navigations can reuse anchor elements (YouTube swaps the
  // h1's textContent in place instead of replacing the node). A badge whose
  // anchor now yields a different item — or yields nothing while its text
  // changed — was mounted from the old page's DOM. Drop it; the fresh
  // candidate remounts below with correct data and fresh lookups.
  badges.forEach((rec, host) => {
    const anchor = rec.candidate.anchor;
    const nowKey = byAnchor.get(anchor);
    if (nowKey === badgeKeyFor(rec.candidate)) return; // still valid
    if (nowKey !== undefined || (anchor.textContent ?? '') !== rec.anchorText) {
      dropBadge(host, rec);
    }
    // Anchor yields nothing but its text is unchanged: probably a loading
    // shimmer — keep the badge to avoid thrash.
  });

  const fresh = collected.filter((c) => !c.anchor.hasAttribute(HOST_ATTR));
  if (fresh.length === 0) return;
  const hosts = fresh.map(mountBadge);
  // Deezer album pages: the URL carries the native album ID, so resolve the
  // exact tracklist from Deezer's public API. Fire-and-forget — fetchDeezerTracks
  // mutates c.tracks and the wishlist action reads it at click time, so the
  // pill never waits for it.
  for (const c of fresh) {
    if (c.kind === 'album' && c.provider === 'deezer' && c.providerId && !(c.tracks?.length)) {
      quiet(fetchDeezerTracks(c));
    }
  }
  // Watch states: artist candidates plus every distinct artist named by
  // track/album candidates, so cards render the artist's true state.
  // Deduplicated by normalized name — one lookup per artist per scan.
  // Multi-artist candidates ("Post Malone, Swae Lee") contribute each
  // individual name — the combined string is never checked as one artist.
  // A direct provider ID beats a name resolve: if an album/track row named
  // the artist first, a later artist candidate carrying the href's ID still
  // upgrades the entry so the watch check is exact, not resolved.
  const watchItems = new Map<string, { name: string; providerId?: string }>();
  for (const c of fresh) {
    // Manual-search candidates name a channel, not a verified artist —
    // never resolve or watchlist-guess them.
    if (c.manualSearch) continue;
    // The artist's own provider ID (e.g. Deezer ID from an album page's
    // artist link) beats a name resolve — the watch check is exact.
    const pid = c.kind === 'artist' ? c.providerId : c.artistProviderId;
    for (const n of watchNamesFor(c)) {
      const k = `artist:${normName(n)}`;
      const prev = watchItems.get(k);
      if (!prev || (!prev.providerId && pid)) {
        watchItems.set(k, { name: n, providerId: pid });
      }
    }
  }
  // Progressive placement: every lookup renders its own badge the moment
  // its result arrives — nothing waits for the batch. Loading pills are
  // already mounted, so badges pop in as they resolve. Playlist candidates
  // resolve through the mirror check, not the library lookup.
  fresh.forEach((c, i) =>
    quiet(c.kind === 'playlist' ? resolvePlaylistSaved(c, hosts[i]) : resolveLibrary(c, hosts[i])),
  );
  watchItems.forEach((item) => quiet(resolveWatch(item)));
}

function clearBadges(): void {
  badges.forEach((rec, host) => {
    clearUnwatchArm(host);
    closePopover(rec);
    host.remove();
  });
  badges.clear();
  recServerUrl.clear();
  document.querySelectorAll(`[${HOST_ATTR}]`).forEach((el) => el.removeAttribute(HOST_ATTR));
}

let lastUrl = location.href;
let timer: number | null = null;

/** True while this content script's extension context is alive. When the
 *  extension is reloaded/updated, old content scripts keep running in open
 *  tabs but every browser.runtime call throws "Extension context
 *  invalidated". Detect that once and shut down quietly instead of spamming
 *  the console with uncaught errors. */
let contextAlive = true;
function checkContext(): boolean {
  if (!contextAlive) return false;
  try {
    // Accessing runtime.id throws once the context was invalidated.
    void browser.runtime?.id;
    return true;
  } catch {
    contextAlive = false;
    return false;
  }
}

/** Fire-and-forget a promise without an unhandled rejection. */
function quiet(p: Promise<unknown>): void {
  p.catch(() => undefined);
}

function scheduleScan(): void {
  if (timer !== null) return;
  if (!checkContext()) return;
  if (!badgesEnabled) return;
  timer = window.setTimeout(() => {
    timer = null;
    if (!checkContext()) return;
    if (!badgesEnabled) return;
    quiet(scan());
  }, 800);
}

async function boot(): Promise<void> {
  // The badge CSS is bundled into this script (see the import above), so no
  // preload is needed — cssStyle() is synchronous from the first badge.
  await loadBadgesEnabled();
  // Live master switch: the popup flips BADGES_ENABLED_KEY; tear badges down
  // promptly when turned off, remount when turned back on — no reload needed.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const c = (changes as Record<string, { newValue?: unknown }>)[BADGES_ENABLED_KEY];
    if (!c) return;
    const now = badgesEnabledFromStored({ [BADGES_ENABLED_KEY]: c.newValue });
    if (now === badgesEnabled) return;
    badgesEnabled = now;
    clearBadges();
    if (now) scheduleScan();
  });
  scheduleScan();
  const obs = new MutationObserver(() => {
    if (!checkContext()) {
      // Extension was reloaded — this script is orphaned. Disconnect so the
      // dead observer stops scheduling scans against a dead runtime.
      obs.disconnect();
      return;
    }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      clearBadges();
    }
    // Anchors removed by SPA re-renders take their badge with them. Hosts
    // wiped by a re-render (React replacing the h1's children, leaving the
    // anchor marked but the pill gone) are dropped too — the anchor is
    // unmarked so the next scan remounts the badge instead of skipping it.
    badges.forEach((rec, host) => {
      if (!rec.candidate.anchor.isConnected || !host.isConnected) {
        clearUnwatchArm(host);
        if (rec.pop) closePopover(rec);
        host.remove();
        badges.delete(host);
        rec.candidate.anchor.removeAttribute(HOST_ATTR);
      }
    });
    scheduleScan();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener(
    'pointerdown',
    (ev) => {
      // Clicks inside any badge shadow root or popover layer keep the popover;
      // anything else closes open popovers. composedPath pierces shadow DOM.
      const inBadge = (ev.composedPath() as EventTarget[]).some(
        (t) =>
          t instanceof HTMLElement &&
          (t.classList.contains('ssb-host') || t.classList.contains('ssb-pop-layer')),
      );
      if (!inBadge) badges.forEach((rec) => rec.pop && closePopover(rec));
    },
    true,
  );
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') badges.forEach((rec) => rec.pop && closePopover(rec));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}
