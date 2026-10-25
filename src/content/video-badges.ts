import browser from 'webextension-polyfill';
import { BADGES_ENABLED_KEY, badgesEnabledFromStored, normName } from '../shared/api.js';
import type { OpenVideoResponse, PendingVideoEntry } from '../player/types.js';
import {
  channelArtistFromOgTitle,
  isBadgedYoutubeHost,
  isMusicChannelName,
  isTrailerTitle,
  isYoutubeChannelPath,
  parseTrailerTitle,
  trackFromVideoTitle,
} from '../shared/youtube.js';
import badgeCssText from './page-badges.css';

/**
 * Video page badges: library/wishlist pills for movies & TV shows.
 *
 * Restrained by design (per Broque: "don't want to be annoying"):
 * - Page subject ONLY. We badge the movie/show the page is about, never
 *   every poster in a grid or list.
 * - Site-specific extractors from JSON-LD / OpenGraph — never generic text
 *   scanning. A missing anchor skips the candidate silently.
 * - All server traffic goes through the background worker.
 * - Badge chrome lives in shadow DOM so page CSS/CSP can't touch it.
 *
 * YouTube: trailer-shaped watch pages ("Official Trailer", "Redband", …)
 * get the movie/show pill on the title (the server re-resolves the real
 * kind); non-music, non-trailer watch pages and non-music channel pages get
 * a channel-follow pill. Music (Topic/VEVO channels, "Artist - Track"
 * titles) stays with page-badges — the shared classifiers in
 * shared/youtube.ts keep the two scripts in agreement.
 */

export type VideoProvider = 'imdb' | 'tmdb' | 'trakt' | 'letterboxd' | 'youtube';

function videoProvider(): VideoProvider | undefined {
  const h = location.hostname;
  if (h.includes('imdb.com')) return 'imdb';
  if (h.includes('themoviedb.org')) return 'tmdb';
  if (h.includes('trakt.tv')) return 'trakt';
  if (h.includes('letterboxd.com')) return 'letterboxd';
  if (isBadgedYoutubeHost(h)) return 'youtube';
  return undefined;
}

interface VideoCandidate {
  title: string;
  year: number | null;
  kind: 'movie' | 'show';
  /** TMDB id when the URL carries it (themoviedb.org pages). */
  tmdbId?: number;
  anchor: Element;
  provider: VideoProvider;
  /** For episode cards (S1.E10): the specific season/episode. */
  episode?: { season: number; episode: number };
  /** For person cards: check person watchlist instead of video. */
  isPerson?: boolean;
}

function jsonLdVideo(): { title?: string; year?: number | null; kind?: 'movie' | 'show' } {
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(el.textContent || '');
      const items = Array.isArray(data) ? data : [data];
      for (const it of items) {
        const t = (it?.['@type'] as string) || '';
        if (t === 'Movie' || t === 'TVSeries') {
          const name = typeof it.name === 'string' ? it.name : '';
          let year: number | null = null;
          const dr = typeof it.datePublished === 'string' ? it.datePublished : '';
          const m = dr.match(/^(\d{4})/);
          if (m) year = parseInt(m[1], 10);
          if (!name) continue;
          return { title: name, year, kind: t === 'Movie' ? 'movie' : 'show' };
        }
      }
    } catch {
      /* malformed JSON-LD — try the next block */
    }
  }
  return {};
}

function ogTitle(): string {
  const el = document.querySelector('meta[property="og:title"]');
  const c = el?.getAttribute('content') || '';
  // "Dune: Part Two (2024) - IMDb" -> "Dune: Part Two"
  return c.replace(/\s*\(\d{4}\).*$/, '').replace(/\s*[-–|].*$/, '').trim();
}

/** Extract the page-subject movie/show. Returns undefined when the page isn't a title page. */
function extractCandidate(provider: VideoProvider): VideoCandidate | undefined {
  const path = location.pathname;

  if (provider === 'tmdb') {
    // /movie/123-title or /tv/456-title — TMDB id straight from the URL.
    const m = path.match(/^\/(movie|tv)\/(\d+)/);
    if (!m) return undefined;
    const kind = m[1] === 'movie' ? 'movie' : 'show';
    const tmdbId = parseInt(m[2], 10);
    const ld = jsonLdVideo();
    const title = ld.title || ogTitle();
    if (!title) return undefined;
    const anchor = document.querySelector('h1, h2.title, .title h1') || document.body;
    return { title, year: ld.year ?? null, kind, tmdbId, anchor, provider };
  }

  if (provider === 'imdb') {
    // /title/tt1234567/ — title pages only.
    if (!/^\/title\/tt\d+/.test(path)) return undefined;
    const ld = jsonLdVideo();
    const title = ld.title || ogTitle();
    if (!title) return undefined;
    const anchor = document.querySelector('[data-testid="hero__pageTitle"], h1') || document.body;
    return { title, year: ld.year ?? null, kind: ld.kind ?? 'movie', anchor, provider };
  }

  if (provider === 'trakt') {
    // /movies/slug or /shows/slug
    const m = path.match(/^\/(movies|shows)\/([^/]+)/);
    if (!m) return undefined;
    const kind = m[1] === 'movies' ? 'movie' : 'show';
    const ld = jsonLdVideo();
    const title = ld.title || ogTitle() || m[2].replace(/-/g, ' ');
    const anchor = document.querySelector('h1') || document.body;
    return { title, year: ld.year ?? null, kind, anchor, provider };
  }

  if (provider === 'letterboxd') {
    // /film/slug/ — movies only on Letterboxd.
    const m = path.match(/^\/film\/([^/]+)/);
    if (!m) return undefined;
    const ld = jsonLdVideo();
    const title = ld.title || ogTitle() || m[1].replace(/-/g, ' ');
    const anchor = document.querySelector('h1.headline-1, h1') || document.body;
    return { title, year: ld.year ?? null, kind: 'movie', anchor, provider };
  }

  return undefined;
}

/* ── YouTube ── */

interface YoutubeWatchMeta {
  rawTitle: string;
  /** Inner title span (where the pill mounts, like the music track pill). */
  titleAnchor: Element;
  channelName: string;
  channelAnchor: Element | null;
  channelUrl: string;
}

/** Watch-page title + channel, using the same selectors as page-badges. */
function youtubeWatchMeta(): YoutubeWatchMeta | null {
  const h1 = document.querySelector('h1.ytd-watch-metadata') ?? document.querySelector('h1');
  const inner = h1?.querySelector('yt-formatted-string') ?? undefined;
  const rawTitle = (inner ?? h1)?.textContent?.trim() ?? '';
  if (!rawTitle) return null;
  const channelAnchor =
    document.querySelector('#owner #channel-name') ??
    document.querySelector('ytd-video-owner-renderer #channel-name') ??
    document.querySelector('#channel-name');
  const channelName = channelAnchor?.textContent?.trim() ?? '';
  // The channel link wrapping the name gives the canonical channel URL —
  // the watch URL itself is useless for follow/resolve.
  const ownerLink =
    (channelAnchor?.closest('a[href]') as HTMLAnchorElement | null) ??
    (document.querySelector(
      '#owner a[href^="/@"], #owner a[href^="/channel/"], #owner a[href^="/c/"], #owner a[href^="/user/"]',
    ) as HTMLAnchorElement | null);
  const href = ownerLink?.getAttribute('href') ?? '';
  const channelUrl = href ? new URL(href, location.origin).href : '';
  return {
    rawTitle,
    titleAnchor: inner ?? h1 ?? document.body,
    channelName,
    channelAnchor,
    channelUrl,
  };
}

/** Trailer-shaped watch pages: the movie/show the trailer is for. */
function extractYoutubeTrailer(): VideoCandidate | undefined {
  if (location.pathname !== '/watch') return undefined;
  const meta = youtubeWatchMeta();
  if (!meta) return undefined;
  const info = parseTrailerTitle(meta.rawTitle, meta.channelName);
  if (!info) return undefined;
  return {
    title: info.title,
    year: info.year,
    kind: info.kindHint,
    anchor: meta.titleAnchor,
    provider: 'youtube',
  };
}

interface YoutubeChannelCandidate {
  name: string;
  /** Channel URL (page URL on channel pages, owner link on watch pages). */
  url: string;
  anchor: Element;
}

/**
 * The "normal YouTube channel" pill: channel pages that aren't unambiguously
 * music (Topic/VEVO — page-badges owns those), and watch pages that are
 * neither trailers nor music. Anything else belongs to another pill.
 */
function extractYoutubeChannel(): YoutubeChannelCandidate | undefined {
  const path = location.pathname;
  if (isYoutubeChannelPath(path)) {
    const rawOg =
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '';
    if (isMusicChannelName(rawOg)) return undefined;
    const name =
      channelArtistFromOgTitle(rawOg).trim() ||
      document.title.replace(/\s*[-–|]\s*YouTube\s*$/, '').trim();
    if (!name) return undefined;
    const anchor = document.querySelector('#channel-name') ?? document.body;
    return { name, url: location.href, anchor };
  }
  if (path === '/watch') {
    const meta = youtubeWatchMeta();
    if (!meta) return undefined;
    if (isTrailerTitle(meta.rawTitle)) return undefined;
    if (trackFromVideoTitle(meta.rawTitle, meta.channelName)) return undefined;
    if (!meta.channelName || !meta.channelAnchor || !meta.channelUrl) return undefined;
    return { name: meta.channelName, url: meta.channelUrl, anchor: meta.channelAnchor };
  }
  return undefined;
}

/**
 * Channel-follow pill: 👁 Follow / 👁 Following, two-click unfollow verify
 * (parity with the show/person eyes). Follow wishes the channel's recent
 * uploads; unfollow leaves wished videos in place (server behavior).
 */
function channelPillFor(c: YoutubeChannelCandidate): HTMLElement {
  const host = document.createElement('span');
  host.className = 'ssb-host ss-video-badge-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = badgeCssText;
  shadow.appendChild(style);

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'ssb-pill ssb-loading';
  pill.innerHTML = '<span class="ssb-dot"></span>';
  pill.title = 'Checking your SoulSync watchlist…';
  pill.setAttribute('aria-label', `${c.name}: checking your SoulSync watchlist`);
  shadow.appendChild(pill);

  let youtubeId = '';
  let resolvedChannel: { youtube_id: string; title: string; avatar_url: string } | null = null;
  let armed = false;
  let armTimer: number | undefined;
  const clearArmTimer = (): void => {
    if (armTimer !== undefined) {
      window.clearTimeout(armTimer);
      armTimer = undefined;
    }
  };
  const render = (following: boolean | null): void => {
    armed = false;
    clearArmTimer();
    pill.disabled = false;
    if (following === null) {
      pill.className = 'ssb-pill ssb-unknown';
      pill.textContent = '?';
      pill.title = "Couldn't check your SoulSync watchlist";
      pill.setAttribute('aria-label', `${c.name}: couldn't check your SoulSync watchlist.`);
      return;
    }
    if (following) {
      pill.className = 'ssb-pill ssb-vwatching';
      pill.innerHTML = '<span aria-hidden="true">👁</span><span>Following</span>';
      pill.title = `${c.name} — you're following this channel. Click to unfollow.`;
      pill.setAttribute('aria-label', `${c.name}: following. Click to unfollow.`);
    } else {
      pill.className = 'ssb-pill ssb-vnotwatching';
      pill.innerHTML = '<span aria-hidden="true">👁</span><span>Follow</span>';
      pill.title = `Follow ${c.name} — new uploads are wishlisted to your SoulSync.`;
      pill.setAttribute('aria-label', `${c.name}: not following. Click to follow.`);
    }
  };
  const renderArmed = (): void => {
    armed = true;
    clearArmTimer();
    // The armed verify expires like the music badges' does (5s): a stray
    // first click must not leave a one-click unfollow live indefinitely.
    armTimer = window.setTimeout(() => {
      armTimer = undefined;
      if (armed && host.isConnected) render(true);
    }, 5000);
    pill.className = 'ssb-pill ssb-vunwatch-armed';
    pill.innerHTML = '<span aria-hidden="true">👁</span><span>Click to unfollow</span>';
    pill.title = `${c.name} — click again to confirm unfollow.`;
    pill.setAttribute('aria-label', `${c.name}: click again to confirm unfollow.`);
  };

  /** Does a server answer plausibly belong to THIS channel? The name and
   *  the channel URL are read from different elements that YouTube updates
   *  at different times, so a mismatched answer can belong to another
   *  channel entirely. Compared space-free with containment either way:
   *  resolvers may echo the @handle ("somechannel") for a display name
   *  ("Some Channel"), and the name element's text can carry a hidden
   *  tooltip repeating the name ("Name Name"). This gates DISPLAY only —
   *  sister channels ("MrBeast" vs "MrBeast Gaming") can pass it, so the
   *  follow/unfollow WRITES are gated separately, on a live re-read of
   *  the page at click time (see liveChannelAgrees). */
  const identityOk = (serverTitle: string | undefined): boolean => {
    if (!serverTitle) return true; // nothing to cross-check against
    const squish = (s: string): string => normName(s).replace(/ /g, '');
    const name = squish(c.name);
    const title = squish(serverTitle);
    if (!name || !title) return true;
    return name.includes(title) || title.includes(name);
  };

  /** At write time the page must STILL show this pill's channel: name and
   *  URL re-read in one pass (the same extraction that built the pill),
   *  and both must match what this pill was built from. A mid-swap pill
   *  whose page has moved on never writes. */
  const liveChannelAgrees = (): boolean => {
    const fresh = extractYoutubeChannel();
    return !!fresh && fresh.url === c.url && fresh.name === c.name;
  };

  let resolveGen = 0;
  /** (Re-)resolve the follow state for the channel this pill was built
   *  for. The pill is disabled while a resolve is in flight: a second
   *  click must not fall through to the follow path (a write) before the
   *  check lands, and overlapping resolves apply only their latest
   *  answer. A rejected identity shows "unknown", never a follow state
   *  for the wrong channel. */
  const resolve = (): void => {
    const gen = ++resolveGen;
    pill.disabled = true;
    pill.className = 'ssb-pill ssb-loading';
    pill.innerHTML = '<span class="ssb-dot"></span>';
    browser.runtime
      .sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION',
        action: 'check-channel',
        url: c.url,
      })
      .then((res: unknown) => {
        if (!host.isConnected || gen !== resolveGen) return; // stale pill/answer
        const r = res as { following?: boolean | null; youtube_id?: string; title?: string; avatar_url?: string };
        if (!identityOk(r?.title)) {
          youtubeId = '';
          resolvedChannel = null;
          render(null);
          return;
        }
        if (typeof r?.youtube_id === 'string') {
          youtubeId = r.youtube_id;
          resolvedChannel = {
            youtube_id: r.youtube_id,
            title: typeof r?.title === 'string' && r.title ? r.title : c.name,
            avatar_url: typeof r?.avatar_url === 'string' ? r.avatar_url : '',
          };
        }
        render(r?.following ?? null);
      })
      .catch(() => {
        if (host.isConnected && gen === resolveGen) render(null);
      });
  };

  pill.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    // A check is in flight — clicks do nothing until it lands.
    if (pill.classList.contains('ssb-loading')) return;
    // Unknown state ("?") means the check never landed — clicking re-runs
    // the check, never a follow (a write from an unverified state).
    if (pill.classList.contains('ssb-unknown')) {
      resolve();
      return;
    }
    const following = pill.classList.contains('ssb-vwatching') || armed;
    if (following && !armed) {
      renderArmed();
      return;
    }
    // Write gate: the page must still show this exact channel (see
    // liveChannelAgrees). If it has moved on, re-resolve instead of
    // following/unfollowing whatever the pill was built from.
    if (!liveChannelAgrees()) {
      resolve();
      return;
    }
    clearArmTimer();
    pill.disabled = true;
    if (following) {
      const res = (await browser.runtime
        .sendMessage({
          type: 'SOULSYNC_VIDEO_BADGE_ACTION',
          action: 'unfollow-channel',
          youtube_id: youtubeId,
        })
        .catch(() => null)) as { ok?: boolean } | null;
      if (res?.ok) render(false);
      else {
        // Failed: restore the armed state so the intent is clear.
        if (armed) render(true);
        pill.title = `${c.name} — couldn't unfollow.`;
      }
    } else {
      pill.className = 'ssb-pill ssb-loading';
      pill.innerHTML = '<span class="ssb-dot"></span>';
      // Follow with the already-resolved channel object — the same payload
      // the SoulSync web UI sends when following in-app ({channel:
      // {youtube_id, title, avatar_url}}), so no second yt-dlp resolve and
      // identical server behavior.
      if (!resolvedChannel) {
        const chk = (await browser.runtime
          .sendMessage({
            type: 'SOULSYNC_VIDEO_BADGE_ACTION',
            action: 'check-channel',
            url: c.url,
          })
          .catch(() => null)) as {
          following?: boolean | null;
          youtube_id?: string;
          title?: string;
          avatar_url?: string;
        } | null;
        if (chk?.youtube_id && identityOk(chk.title)) {
          youtubeId = chk.youtube_id;
          resolvedChannel = {
            youtube_id: chk.youtube_id,
            title: typeof chk.title === 'string' && chk.title ? chk.title : c.name,
            avatar_url: typeof chk.avatar_url === 'string' ? chk.avatar_url : '',
          };
        } else if (chk?.youtube_id) {
          // The check resolved a different channel than the one displayed
          // (name/URL captured mid-swap) — never follow it.
          render(null);
          pill.disabled = false;
          return;
        }
      }
      const res = resolvedChannel
        ? ((await browser.runtime
            .sendMessage({
              type: 'SOULSYNC_VIDEO_BADGE_ACTION',
              action: 'follow-channel',
              channel: resolvedChannel,
            })
            .catch(() => null)) as { ok?: boolean; youtube_id?: string } | null)
        : null;
      if (res?.ok) {
        if (res.youtube_id) youtubeId = res.youtube_id;
        render(true);
      } else {
        render(false);
        pill.title = `${c.name} — couldn't follow that channel.`;
      }
    }
    pill.disabled = false;
  });

  // Resolve follow state in the background.
  resolve();

  return host;
}

type VideoPillState = 'loading' | 'in-library' | 'on-wishlist' | 'addable' | 'unknown';

/**
 * Click-to-play for "In library" video badges: queue the entry for the
 * player tab, then open it. The tab itself calls /watch/playable and shows
 * the honest verdict — this only hands it the tmdb identity the badge
 * already holds. Routed through the background (player:openVideo) because
 * content scripts have no browser.storage.session or browser.tabs API on
 * Firefox. Brief busy affordance ("⋯"); on failure the badge restores and
 * names the problem in its title. Callers only wire this up when
 * candidate.tmdbId is known — never fakes an identity.
 */
async function playVideoEntry(
  button: HTMLButtonElement,
  candidate: VideoCandidate,
): Promise<void> {
  const tmdbId = candidate.tmdbId;
  if (tmdbId === undefined || tmdbId <= 0 || button.disabled) return;
  button.disabled = true;
  const prevText = button.textContent;
  const prevTitle = button.title;
  button.textContent = '⋯';
  button.title = `Opening ${candidate.title} in the player…`;
  try {
    const entry: PendingVideoEntry = {
      videoKd: candidate.episode || candidate.kind === 'show' ? 't' : 'm',
      videoId: tmdbId,
      title: candidate.title,
    };
    if (candidate.episode) {
      entry.season = candidate.episode.season;
      entry.episode = candidate.episode.episode;
    }
    // {ok: false} surfaces through the honest-failure path below (the
    // background validates the entry and opens the tab).
    const res = (await browser.runtime.sendMessage({
      type: 'player:openVideo',
      entry,
    })) as OpenVideoResponse | undefined;
    if (!res?.ok) throw new Error(res?.error || 'could not queue the video');
  } catch {
    // Honest failure: restore the badge and say what went wrong.
    button.textContent = prevText;
    button.title = `${candidate.title} — couldn't open the player.`;
    button.disabled = false;
    return;
  }
  button.textContent = prevText;
  button.title = prevTitle;
  button.disabled = false;
}

function pillFor(
  candidate: VideoCandidate,
  state: VideoPillState,
  onWatchlist: boolean | null,
): HTMLElement {
  const host = document.createElement('span');
  host.className = 'ssb-host ss-video-badge-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = badgeCssText;
  shadow.appendChild(style);

  const pill = document.createElement('button');
  pill.type = 'button';

  // Visual parity with music badges: same classes, same labels, same icons.
  if (state === 'loading') {
    pill.className = 'ssb-pill ssb-loading';
    pill.title = 'Checking your SoulSync library…';
    pill.setAttribute('aria-label', `${candidate.title}: checking your SoulSync library`);
    pill.innerHTML = '<span class="ssb-dot"></span>';
  } else if (state === 'in-library') {
    pill.className = 'ssb-pill ssb-in';
    // Only TMDB pages carry a tmdbId — without it there's no identity to
    // play, so the pill stays unclickable (never fake one).
    const canPlay = typeof candidate.tmdbId === 'number' && candidate.tmdbId > 0;
    pill.title = canPlay
      ? `${candidate.title} — in your SoulSync library. Click to play.`
      : `${candidate.title} — in your SoulSync library.`;
    pill.setAttribute(
      'aria-label',
      `${candidate.title}: in your SoulSync library.${canPlay ? ' Click to play.' : ''}`,
    );
    pill.innerHTML = '<span aria-hidden="true">✓</span><span>In library</span>';
    if (canPlay) {
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void playVideoEntry(pill, candidate);
      });
    }
  } else if (state === 'on-wishlist') {
    pill.className = 'ssb-pill ssb-acted';
    pill.title = `${candidate.title} — on your SoulSync wishlist.`;
    pill.setAttribute('aria-label', `${candidate.title}: on your SoulSync wishlist.`);
    pill.innerHTML = '<span aria-hidden="true">✓</span><span>Wishlisted</span>';
  } else if (state === 'unknown') {
    pill.className = 'ssb-pill ssb-unknown';
    pill.title = "Couldn't check your SoulSync library";
    pill.setAttribute('aria-label', `${candidate.title}: status unknown.`);
    pill.textContent = '?';
  } else {
    // 'addable': not in library — the pill IS the wishlist action.
    const label = candidate.kind === 'show' ? 'Wishlist show' : 'Wishlist movie';
    pill.className = 'ssb-pill ssb-out';
    pill.title = `${candidate.title} — not in your library. Click to add to your wishlist.`;
    pill.setAttribute('aria-label', `${candidate.title}: not in your library. Add to wishlist.`);
    pill.innerHTML = `<span aria-hidden="true">+</span><span>${label}</span>`;
  }

  if (state === 'addable') {
    pill.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      pill.className = 'ssb-pill ssb-loading';
      pill.innerHTML = '<span class="ssb-dot"></span>';
      pill.disabled = true;
      const res = (await browser.runtime
        .sendMessage({
          type: 'SOULSYNC_VIDEO_BADGE_ACTION',
          action: 'wishlist-video',
          title: candidate.title,
          year: candidate.year,
          kind: candidate.kind,
          tmdbId: candidate.tmdbId,
          provider: candidate.provider,
        })
        .catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res?.ok) {
        // Wishlisted: terminal, not clickable (parity with music badges).
        pill.className = 'ssb-pill ssb-acted';
        pill.title = `${candidate.title} — on your SoulSync wishlist.`;
        pill.setAttribute('aria-label', `${candidate.title}: on your SoulSync wishlist.`);
        pill.innerHTML = '<span aria-hidden="true">✓</span><span>Wishlisted</span>';
      } else {
        const label = candidate.kind === 'show' ? 'Wishlist show' : 'Wishlist movie';
        pill.className = 'ssb-pill ssb-out';
        pill.innerHTML = `<span aria-hidden="true">+</span><span>${label}</span>`;
        pill.disabled = false;
      }
    });
  }
  const wrap = document.createElement('span');
  wrap.style.cssText = 'display:inline-flex;gap:6px;align-items:center;';
  wrap.appendChild(pill);
  shadow.appendChild(wrap);

  // TV shows get a watchlist eye next to the pill (parity with artist pills).
  if (candidate.kind === 'show' && onWatchlist !== null) {
    const eye = document.createElement('button');
    eye.className = 'ssb-pill';
    eye.type = 'button';
    let armed = false;
    let armTimer: number | undefined;
    const clearArmTimer = (): void => {
      if (armTimer !== undefined) {
        window.clearTimeout(armTimer);
        armTimer = undefined;
      }
    };
    const render = (watching: boolean): void => {
      armed = false;
      clearArmTimer();
      if (watching) {
        eye.className = 'ssb-pill ssb-vwatching';
        eye.innerHTML = '<span aria-hidden="true">👁</span><span>Watching</span>';
        eye.title = `${candidate.title} — on your watchlist. Click to unfollow.`;
        eye.setAttribute('aria-label', `${candidate.title}: on your watchlist. Unfollow.`);
      } else {
        eye.className = 'ssb-pill ssb-vnotwatching';
        eye.innerHTML = '<span aria-hidden="true">👁</span><span>Watchlist</span>';
        eye.title = `${candidate.title} — click to add to your SoulSync watchlist.`;
        eye.setAttribute('aria-label', `${candidate.title}: not on your watchlist. Add to watchlist.`);
      }
    };
    const renderArmed = (): void => {
      armed = true;
      clearArmTimer();
      armTimer = window.setTimeout(() => {
        armTimer = undefined;
        if (armed) render(true);
      }, 5000);
      eye.className = 'ssb-pill ssb-vunwatch-armed';
      eye.innerHTML = '<span aria-hidden="true">👁</span><span>Click to unfollow</span>';
      eye.title = `${candidate.title} — click again to confirm unfollow.`;
    };
    render(onWatchlist);
    eye.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const watching = eye.classList.contains('ssb-vwatching') || armed;
      if (watching && !armed) {
        // First click arms the remove verify (parity with music badges).
        renderArmed();
        return;
      }
      clearArmTimer();
      eye.disabled = true;
      const res = (await browser.runtime
        .sendMessage({
          type: 'SOULSYNC_VIDEO_BADGE_ACTION',
          action: watching ? 'unwatch-show' : 'watch-show',
          title: candidate.title,
          year: candidate.year,
          tmdbId: candidate.tmdbId,
        })
        .catch(() => null)) as { ok?: boolean } | null;
      if (res?.ok) render(!watching);
      else if (armed) render(true); // failed: restore watching state
      armed = false;
      eye.disabled = false;
    });
    wrap.appendChild(eye);
  }

  return host;
}

async function badgesEnabled(): Promise<boolean> {
  try {
    const stored = await browser.storage.local.get(BADGES_ENABLED_KEY);
    return badgesEnabledFromStored(stored[BADGES_ENABLED_KEY]);
  } catch {
    return true;
  }
}

/* ── Page-subject reconciliation ──
 *
 * SPA sites (YouTube above all) change the URL BEFORE they swap the page's
 * title/channel DOM, and they reuse the same DOM nodes when they do. A
 * one-shot read at URL-change time therefore extracts the PREVIOUS video —
 * and with no later re-check, its badge stayed for good (the reported
 * "still thinks it's the previous video" bug). The subject is instead
 * reconciled continuously: every DOM mutation schedules a debounced
 * reconcile that re-extracts the subject, compares its identity signature
 * (URL + title + kind / channel name + channel URL) with what's mounted,
 * and remounts only when the identity actually changed. Async check
 * answers carry the navigation generation + signature they were issued
 * under and are dropped when either has moved on.
 */
let navGen = 0;
let mountedSubject: { sig: string; hosts: HTMLElement[] } | null = null;

function clearSubjectHosts(): void {
  mountedSubject?.hosts.forEach((h) => h.remove());
  mountedSubject = null;
}

function swapSubjectHost(oldHost: HTMLElement, newHost: HTMLElement): void {
  newHost.dataset.ssSubject = oldHost.dataset.ssSubject ?? '';
  if (!mountedSubject) return;
  const i = mountedSubject.hosts.indexOf(oldHost);
  if (i >= 0) mountedSubject.hosts[i] = newHost;
}

function mountSubjectHost(host: HTMLElement, anchor: Element, sig: string): HTMLElement {
  host.dataset.ssSubject = sig;
  if (anchor === document.body) {
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
    document.body.appendChild(host);
  } else {
    anchor.appendChild(host);
  }
  return host;
}

interface SubjectMount {
  sig: string;
  /** Person subject: cast eyes stay title-page-only (rec cards still run). */
  person?: boolean;
  mount: () => HTMLElement[];
}

/** Extract the current page subject and its identity signature, without
 *  mounting anything. Returns null when the page has no badgeable subject. */
function extractSubject(provider: VideoProvider): SubjectMount | null {
  if (provider === 'youtube') {
    // Trailer-shaped watch pages get the movie/show pill on the title;
    // non-music channel pages and non-music, non-trailer watch pages get
    // the channel-follow pill. Music stays with page-badges.
    const trailer = extractYoutubeTrailer();
    if (trailer) {
      const sig = `yt-trailer|${location.href}|${trailer.title}|${trailer.year ?? ''}|${trailer.kind}`;
      return { sig, mount: () => [mountVideoPill(trailer, sig)] };
    }
    const channel = extractYoutubeChannel();
    if (channel) {
      const sig = `yt-channel|${location.href}|${channel.name}|${channel.url}`;
      return {
        sig,
        mount: () => [mountSubjectHost(channelPillFor(channel), channel.anchor, sig)],
      };
    }
    return null;
  }

  // Person pages get a watchlist eye — and nothing else on the page.
  const person = extractPerson(provider);
  if (person) {
    const sig = `person|${location.href}|${person.name}|${person.tmdbId ?? ''}`;
    return {
      sig,
      person: true,
      mount: () => [mountSubjectHost(personEye(person), person.anchor, sig)],
    };
  }

  const candidate = extractCandidate(provider);
  if (candidate) {
    const sig = `video|${location.href}|${candidate.title}|${candidate.year ?? ''}|${candidate.kind}|${candidate.tmdbId ?? ''}`;
    return { sig, mount: () => [mountVideoPill(candidate, sig)] };
  }
  return null;
}

let reconciling = false;
let reconcileQueued = false;

/** Bring the mounted page-subject badge in line with what the page
 *  currently shows. Cheap when nothing changed: extraction is DOM reads,
 *  and an unchanged signature with live hosts mounts nothing. */
async function reconcile(): Promise<void> {
  if (reconciling) {
    reconcileQueued = true;
    return;
  }
  reconciling = true;
  try {
    if (!(await badgesEnabled())) {
      clearSubjectHosts();
      return;
    }
    const provider = videoProvider();
    if (!provider) return;
    const subj = extractSubject(provider);
    const sig = subj?.sig ?? `none|${provider}|${location.href}`;
    const alive =
      mountedSubject !== null &&
      mountedSubject.hosts.length > 0 &&
      mountedSubject.hosts.every((h) => h.isConnected);
    if (!mountedSubject || mountedSubject.sig !== sig || !alive) {
      clearSubjectHosts();
      const hosts = subj ? subj.mount() : [];
      mountedSubject = { sig, hosts };
    }
    // Cast lists and recommendation rails render late and recycle nodes —
    // they are re-scanned on every reconcile (both self-dedupe by the
    // identity of what they badge). Person pages keep their rec cards
    // (IMDb "Recently viewed" rails badged there before this reconcile
    // existed) but never cast eyes — those were always title-page only.
    if (provider !== 'youtube') {
      if (!subj?.person) mountCastEyes(provider);
      mountRecBadges(provider);
    }
  } finally {
    reconciling = false;
    if (reconcileQueued) {
      reconcileQueued = false;
      void reconcile();
    }
  }
}

/** Mount a page-subject video pill and resolve its library/wishlist state.
 *  The answer is applied only if the pill is still the live subject: a
 *  navigation (or an identity change under the same URL) in the meantime
 *  means the answer belongs to a previous item and is dropped. */
function mountVideoPill(candidate: VideoCandidate, sig: string): HTMLElement {
  const gen = navGen;
  // Insert a loading pill immediately; resolve status in the background.
  const host = pillFor(candidate, 'loading', null);
  mountSubjectHost(host, candidate.anchor, sig);

  void (async () => {
    let res: {
      state?: VideoPillState;
      onWatchlist?: boolean | null;
      hitKind?: 'movie' | 'show' | null;
      error?: string;
    } | null;
    try {
      res = (await browser.runtime.sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION',
        action: 'check-video',
        title: candidate.title,
        year: candidate.year,
        kind: candidate.kind,
        tmdbId: candidate.tmdbId,
        provider: candidate.provider,
      })) as typeof res;
    } catch {
      res = null;
    }
    if (gen !== navGen || !host.isConnected || mountedSubject?.sig !== sig) return;
    if (res === null) {
      const fresh = pillFor(candidate, 'unknown', null);
      swapSubjectHost(host, fresh);
      host.replaceWith(fresh);
      return;
    }
    const state = res?.state ?? 'unknown';
    // The server's resolved kind wins over the page-side guess (IMDb pages
    // with partial JSON-LD default to 'movie'): a corrected show gets its
    // "Wishlist show" label and its watchlist eye. Rec cards already
    // honoured hitKind; the page subject now does too.
    const effective =
      res?.hitKind && res.hitKind !== candidate.kind
        ? { ...candidate, kind: res.hitKind }
        : candidate;
    const fresh = pillFor(effective, state, res?.onWatchlist ?? null);
    swapSubjectHost(host, fresh);
    host.replaceWith(fresh);
  })();
  return host;
}

interface PersonCandidate {
  name: string;
  /** TMDB person id when the URL carries it. */
  tmdbId?: number;
  anchor: Element;
}

/** Extract the person if this is an actor/director page. */
function extractPerson(provider: VideoProvider): PersonCandidate | undefined {
  const path = location.pathname;
  if (provider === 'imdb') {
    const m = path.match(/^\/name\/(nm\d+)/);
    if (!m) return undefined;
    // IMDb name pages: try JSON-LD Person first, then og:title, then h1.
    let name = '';
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(el.textContent || '');
        const items = Array.isArray(data) ? data : [data];
        for (const it of items) {
          if ((it?.['@type'] as string) === 'Person' && typeof it.name === 'string') {
            name = it.name;
            break;
          }
        }
        if (name) break;
      } catch { /* next block */ }
    }
    if (!name) {
      const og = document.querySelector('meta[property="og:title"]');
      name = (og?.getAttribute('content') || '').replace(/\s*[-–|].*$/, '').trim();
    }
    const anchor = document.querySelector('[data-testid="hero__pageTitle"], h1') || document.body;
    if (!name) {
      name = (anchor.textContent || '').trim().split('\n')[0];
    }
    if (!name) {
      // Last resort: document.title is "Matthew McConaughey - IMDb".
      name = document.title.replace(/\s*[-–|]\s*IMDb.*$/, '').trim();
    }
    if (!name) return undefined;
    return { name, anchor };
  }
  if (provider === 'tmdb') {
    const m = path.match(/^\/person\/(\d+)/);
    if (!m) return undefined;
    const anchor = document.querySelector('h1, h2.title') || document.body;
    const ld = jsonLdVideo();
    const name = ld.title || (anchor.textContent || '').trim().split('\n')[0];
    if (!name) return undefined;
    return { name, tmdbId: parseInt(m[1], 10), anchor };
  }
  if (provider === 'trakt') {
    const m = path.match(/^\/people\/([^/]+)/);
    if (!m) return undefined;
    const anchor = document.querySelector('h1') || document.body;
    const name = (anchor.textContent || '').trim().split('\n')[0] || m[1].replace(/-/g, ' ');
    return { name, anchor };
  }
  return undefined;
}

/** Compact watchlist eye for a person (actor page or cast list). */
function personEye(candidate: PersonCandidate): HTMLElement {
  const host = document.createElement('span');
  host.className = 'ssb-host ss-video-badge-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = badgeCssText;
  shadow.appendChild(style);

  const wrap = document.createElement('span');
  wrap.style.cssText = 'display:inline-flex;gap:6px;align-items:center;';
  shadow.appendChild(wrap);

  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'ssb-pill ssb-loading';
  eye.innerHTML = '<span class="ssb-dot"></span>';
  eye.title = 'Checking watchlist…';
  wrap.appendChild(eye);

  let armed = false;
  let armTimer: number | undefined;
  const clearArmTimer = (): void => {
    if (armTimer !== undefined) {
      window.clearTimeout(armTimer);
      armTimer = undefined;
    }
  };
  const render = (watching: boolean | null): void => {
    armed = false;
    clearArmTimer();
    if (watching === null) {
      eye.className = 'ssb-pill ssb-unknown';
      eye.textContent = '?';
      eye.title = "Couldn't check your SoulSync watchlist";
      return;
    }
    if (watching) {
      eye.className = 'ssb-pill ssb-vwatching';
      eye.innerHTML = '<span aria-hidden="true">👁</span><span>Watching</span>';
      eye.title = `${candidate.name} — on your watchlist. Click to unfollow.`;
    } else {
      eye.className = 'ssb-pill ssb-vnotwatching';
      eye.innerHTML = '<span aria-hidden="true">👁</span><span>Watchlist</span>';
      eye.title = `${candidate.name} — click to add to your SoulSync watchlist.`;
    }
  };
  const renderArmed = (): void => {
    armed = true;
    clearArmTimer();
    armTimer = window.setTimeout(() => {
      armTimer = undefined;
      if (armed) render(true);
    }, 5000);
    eye.className = 'ssb-pill ssb-vunwatch-armed';
    eye.innerHTML = '<span aria-hidden="true">👁</span><span>Click to unfollow</span>';
    eye.title = `${candidate.name} — click again to confirm unfollow.`;
  };

  eye.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const watching = eye.classList.contains('ssb-vwatching') || armed;
    if (watching && !armed) {
      renderArmed();
      return;
    }
    clearArmTimer();
    eye.disabled = true;
    const res = (await browser.runtime
      .sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION',
        action: watching ? 'unwatch-person' : 'watch-person',
        name: candidate.name,
        tmdbId: candidate.tmdbId,
      })
      .catch(() => null)) as { ok?: boolean } | null;
    if (res?.ok) render(!watching);
    else if (armed) render(true);
    armed = false;
    eye.disabled = false;
  });

  // Resolve status in the background. A detached eye (its anchor was
  // recycled or the subject moved on) never applies the answer.
  browser.runtime.sendMessage({
    type: 'SOULSYNC_VIDEO_BADGE_ACTION',
    action: 'check-person',
    name: candidate.name,
    tmdbId: candidate.tmdbId,
  }).then((res: unknown) => {
    if (!host.isConnected) return;
    const r = res as { onWatchlist?: boolean | null };
    render(r?.onWatchlist ?? null);
  }).catch(() => {
    if (host.isConnected) render(null);
  });

  return host;
}

/** Cast list eyes: compact watchlist buttons beside actor names. */
function mountCastEyes(provider: VideoProvider): void {
  let selector = '';
  if (provider === 'imdb') {
    // IMDb title page cast: [data-testid="title-cast-item"] with actor links.
    selector = '[data-testid="title-cast-item"] a[data-testid="title-cast-item__actor"]';
  } else if (provider === 'tmdb') {
    // TMDB cast scroller: .card .character + person links.
    selector = '.cast_scroller .card a[href^="/person/"]';
  } else if (provider === 'trakt') {
    selector = '.cast-members .cast-member a[href^="/people/"]';
  } else {
    return;
  }
  for (const anchor of document.querySelectorAll(selector)) {
    const name = (anchor.textContent || '').trim();
    if (!name) continue;
    let tmdbId: number | undefined;
    const href = anchor.getAttribute('href') || '';
    const tm = href.match(/\/person\/(\d+)/);
    if (tm) tmdbId = parseInt(tm[1], 10);
    // Recycled anchors (virtualised cast lists) keep their eye host: it is
    // only valid while it still names the same person.
    const want = `${name}|${tmdbId ?? ''}`;
    const existing = anchor.querySelector('.ss-video-badge-host') as HTMLElement | null;
    if (existing) {
      if (existing.dataset.ssCast === want) continue;
      existing.remove();
    }
    const eye = personEye({ name, tmdbId, anchor });
    eye.dataset.ssCast = want;
    eye.style.marginLeft = '6px';
    anchor.appendChild(eye);
  }
}

/** Identity of what a card badge stands for. Rails recycle card nodes for
 *  different titles, so "this element already has a badge" is meaningless
 *  without it: a badge is only valid while its key still matches the
 *  card's current content. */
function cardKeyFor(candidate: VideoCandidate): string {
  // Deliberately excludes `kind`: the page-side kind is a guess the server
  // corrects via hitKind (updateCardOverlay rebuilds on the correction) —
  // keying on it would remount-and-recheck the card on every scan. The
  // anchor href IS included: it carries the item's own id (IMDb tt/nm,
  // Trakt slug, TMDB path), so same-title different items (remakes, a
  // movie and a show both called "Fargo") never share a badge or an
  // answer.
  const href =
    candidate.anchor instanceof HTMLAnchorElement
      ? (candidate.anchor.getAttribute('href') ?? '')
      : '';
  return `${candidate.isPerson ? 'person' : 'video'}|${candidate.title}|${candidate.tmdbId ?? ''}|${candidate.episode ? `${candidate.episode.season}x${candidate.episode.episode}` : ''}|${href}`;
}

/** "More like this" / Recommendations: badges on each title card.
 *  Same standard as the page-subject pill (library/wishlist + watchlist eye
 *  for shows), compact for the card layout. */
function mountRecBadges(provider: VideoProvider): void {
  let selector = '';
  if (provider === 'imdb') {
    // IMDb poster cards: "More like this", Top picks, Popular TV, TenUp
    // trending — all use .ipc-poster-card with a /title/tt link.
    // Plus trending people: .popular-celebrities-item-card with /name/nm links.
    selector = '.ipc-poster-card, .popular-celebrities-item-card';
  } else if (provider === 'tmdb') {
    // TMDB Recommendations scroller.
    selector = '.recommendations_scroller .card a[href^="/movie/"], .recommendations_scroller .card a[href^="/tv/"]';
  } else if (provider === 'trakt') {
    selector = '.related-shows .grid-item a[href^="/shows/"], .related-movies .grid-item a[href^="/movies/"]';
  } else {
    return;
  }
  for (const el of document.querySelectorAll(selector)) {
    const card = el as HTMLElement;

    let anchor: HTMLAnchorElement | null = null;
    let title = '';
    let kind: 'movie' | 'show' = 'movie';
    let tmdbId: number | undefined;
    let episode: { season: number; episode: number } | undefined;

    if (provider === 'imdb') {
      // Person cards (e.g. Recently viewed, Trending people): link to /name/nm...
      const nameLink = card.querySelector('a[href^="/name/nm"]') as HTMLAnchorElement | null;
      if (nameLink) {
        // Name may be in the link text or a separate name element.
        const nameEl = card.querySelector('[data-testid="popular-celebrity-name-text"]');
        const name = ((nameEl?.textContent || nameLink.textContent) || '').trim();
        if (name) {
          const candidate = { title: name, year: null, kind: 'show', anchor: nameLink, provider, isPerson: true } as VideoCandidate;
          const sig = cardKeyFor(candidate);
          const existing = card.querySelector('.ss-video-badge-host') as HTMLElement | null;
          if (existing && existing.dataset.ssKey === sig) {
            // Same person, badge already mounted — just make sure its
            // viewport check is queued if it never completed.
            if (!pendingCardChecks.has(card) && cardKeyChecked.get(card) !== sig) {
              pendingCardChecks.set(card, { host: existing, candidate });
              observeCard(card);
            }
            continue;
          }
          if (existing) {
            // Recycled card: the old badge names another person.
            existing.remove();
            pendingCardChecks.delete(card);
          }
          // Fresh mount: any earlier "checked" mark for this element
          // belongs to a host the page already removed — the new host
          // must run its check (the answer cache makes the repaint
          // cheap when the identity is unchanged).
          cardKeyChecked.delete(card);
          const host = personCardEye(name);
          host.dataset.ssKey = sig;
          // Celebrity cards use .ipc-avatar, poster cards use .ipc-poster.
          const poster = (card.querySelector('.ipc-poster, .ipc-avatar') as HTMLElement | null);
          const target = poster || card;
          if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
          target.appendChild(host);
          // Viewport-gated like title cards.
          pendingCardChecks.set(card, { host, candidate });
          observeCard(card);
        }
        continue;
      }
      // Title link: .ipc-poster-card__title (may wrap a [data-testid="title"] span).
      anchor = card.querySelector('a.ipc-poster-card__title');
      if (!anchor) continue;
      const titleSpan = anchor.querySelector('[data-testid="title"]');
      title = (titleSpan?.textContent || anchor.textContent || '').trim();
      if (!title) continue;
      // Episode cards (S1.E10): wishlist-able like movies. Detect via
      // the episode number link. (Cheap reads only up to here: the badge
      // key needs title + episode + href — the innerHTML kind guess below
      // runs solely for cards that actually need a (re)mount, so settled
      // rails don't re-serialise every card on every reconcile.)
      const epLink = card.querySelector('[data-testid="rttv-episode-num"]');
      if (epLink) {
        const epText = (epLink.textContent || '').trim();
        const epMatch = epText.match(/S(\d+)\.E(\d+)/i);
        if (epMatch) {
          episode = { season: parseInt(epMatch[1], 10), episode: parseInt(epMatch[2], 10) };
        }
      }
    } else {
      anchor = el as HTMLAnchorElement;
      const href = anchor.getAttribute('href') || '';
      if (provider === 'tmdb') {
        const m = href.match(/^\/(movie|tv)\/(\d+)/);
        if (!m) continue;
        kind = m[1] === 'movie' ? 'movie' : 'show';
        tmdbId = parseInt(m[2], 10);
      } else if (provider === 'trakt') {
        kind = href.startsWith('/shows/') ? 'show' : 'movie';
      }
      const titleEl = anchor.querySelector('img');
      title = (titleEl?.getAttribute('alt') || anchor.textContent || '').trim().split('\n')[0];
      if (!title) continue;
    }

    const candidate: VideoCandidate = { title, year: null, kind, tmdbId, anchor, provider, episode };
    const sig = cardKeyFor(candidate);
    const existing = card.querySelector('.ss-video-badge-host') as HTMLElement | null;
    if (existing && existing.dataset.ssKey === sig) {
      // Same title, badge already mounted — re-queue its check only if it
      // never completed for this identity.
      if (!pendingCardChecks.has(card) && cardKeyChecked.get(card) !== sig) {
        pendingCardChecks.set(card, { host: existing, candidate });
        observeCard(card);
      }
      continue;
    }
    if (existing) {
      // Recycled card node: the mounted badge belongs to the previous
      // title — its display AND its click closures name that title.
      existing.remove();
      pendingCardChecks.delete(card);
    }
    // Fresh mount: clear any earlier "checked" mark for this element (see
    // the person branch) so the new host always runs its check.
    cardKeyChecked.delete(card);
    if (provider === 'imdb' && !episode) {
      // TV hint for the fresh mount: the "returning to TV" rail or
      // TV-series metadata somewhere in the card's markup.
      const cardHtml = card.innerHTML;
      if (cardHtml.includes('rttv-') || /TV Series/i.test(cardHtml)) candidate.kind = 'show';
    }
    const host = cardOverlayFor(candidate);
    host.dataset.ssKey = sig;
    // Pin to the poster's top-right corner.
    const poster = card.querySelector('.ipc-poster') as HTMLElement | null;
    if (poster) {
      if (getComputedStyle(poster).position === 'static') poster.style.position = 'relative';
      poster.appendChild(host);
    } else {
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      card.appendChild(host);
    }

    // Only check cards in (or near) the viewport — no point burning API
    // quota on 30-card rails when 5 are visible. The observer fires
    // immediately for cards already in view.
    pendingCardChecks.set(card, { host, candidate });
    observeCard(card);
  }
}

// Viewport-gated checks: IntersectionObserver fires when cards scroll into view.
// Checks are keyed by the card's identity signature, not just the element:
// a recycled element must be re-checked for its new title, and a check
// issued for a previous title must never land on the new one.
const pendingCardChecks = new Map<Element, { host: HTMLElement; candidate: VideoCandidate }>();
const cardKeyChecked = new Map<Element, string>();
/** Answers by card identity key, for this page only: a recycling rail
 *  that brings a title back (or a carousel that rotates it back into
 *  view) re-paints from here instead of re-asking the server — a
 *  check-video round trip is 3–4 server calls. Cleared on navigation. */
interface CardAnswer {
  state?: VideoPillState;
  onWatchlist: boolean | null;
  hitKind?: 'movie' | 'show' | null;
}
const cardAnswerCache = new Map<string, CardAnswer>();
/** Keep a card's cached answer in step with actions taken on the card
 *  itself: without this, a rail that recycles the node away and back
 *  repaints the pre-action state ("+" on a just-wishlisted title, an
 *  unfollow offer on a just-unfollowed show). */
function updateCachedAnswer(host: HTMLElement, patch: Partial<CardAnswer>): void {
  const key = host.dataset.ssKey;
  if (!key) return;
  const prev = cardAnswerCache.get(key);
  if (prev) cardAnswerCache.set(key, { ...prev, ...patch });
}
const cardObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    // Unobserve only once the check has actually been consumed — if the
    // geometry re-test declines, the card stays observed for its real
    // scroll into view instead of being stranded at "⋯" forever.
    if (entry.isIntersecting && queueCardCheck(entry.target)) {
      cardObserver.unobserve(entry.target);
    }
  }
}, { rootMargin: '200px' }); // pre-load slightly before visible

/** (Re-)observe a card so its callback fires even when the card never
 *  left the viewport: observe() on an already-observed element is a
 *  no-op with no fresh callback, which stranded remounted cards at "⋯"
 *  after navigation clears or recycles reset their pending checks. */
function observeCard(card: Element): void {
  cardObserver.unobserve(card);
  cardObserver.observe(card);
}

/** Fire the pending check for a card. Returns true when the check was
 *  consumed (already done for this identity, or now in flight). */
function queueCardCheck(card: Element): boolean {
  const pending = pendingCardChecks.get(card);
  if (!pending) return cardKeyChecked.has(card);
  const sig = cardKeyFor(pending.candidate);
  if (cardKeyChecked.get(card) === sig) {
    pendingCardChecks.delete(card);
    return true;
  }
  // Only fire if the card is actually visible (or the observer triggered us).
  // Check both axes: horizontal rails have cards off-screen to the sides.
  const rect = card.getBoundingClientRect();
  const inViewport = rect.top < window.innerHeight + 200 && rect.bottom > -200
    && rect.left < window.innerWidth + 200 && rect.right > -200;
  if (!inViewport) return false; // stay observed; fires when scrolled into view
  cardKeyChecked.set(card, sig);
  pendingCardChecks.delete(card);
  const { host, candidate } = pending;
  const cached = cardAnswerCache.get(sig);
  if (cached) {
    if (candidate.isPerson) {
      updatePersonCardEye(host, candidate.title, cached.onWatchlist);
    } else {
      if (cached.hitKind) candidate.kind = cached.hitKind;
      updateCardOverlay(host, candidate, cached.state ?? 'unknown', cached.onWatchlist);
    }
    return true;
  }
  void (async () => {
    // The card may have been recycled again while the check was in
    // flight — a stale answer must never paint onto the new title.
    const stillCurrent = (): boolean => host.isConnected && host.dataset.ssKey === sig;
    const remember = (ans: CardAnswer): void => {
      if (cardAnswerCache.size > 300) cardAnswerCache.clear();
      cardAnswerCache.set(sig, ans);
    };
    try {
      if (candidate.isPerson) {
        // Person card: check person watchlist.
        const res = await browser.runtime.sendMessage({
          type: 'SOULSYNC_VIDEO_BADGE_ACTION',
          action: 'check-person',
          name: candidate.title,
        }) as { onWatchlist?: boolean | null };
        if (!stillCurrent()) return;
        remember({ onWatchlist: res?.onWatchlist ?? null });
        updatePersonCardEye(host, candidate.title, res?.onWatchlist ?? null);
      } else {
        const res = await browser.runtime.sendMessage({
          type: 'SOULSYNC_VIDEO_BADGE_ACTION',
          action: 'check-video',
          title: candidate.title,
          year: candidate.year,
          kind: candidate.kind,
          tmdbId: candidate.tmdbId,
          provider: candidate.provider,
          episode: candidate.episode,
        }) as { state?: VideoPillState; onWatchlist?: boolean | null; hitKind?: 'movie' | 'show' | null };
        if (!stillCurrent()) return;
        remember({
          state: res?.state ?? 'unknown',
          onWatchlist: res?.onWatchlist ?? null,
          hitKind: res?.hitKind ?? null,
        });
        if (res?.hitKind) candidate.kind = res.hitKind;
        updateCardOverlay(host, candidate, res?.state ?? 'unknown', res?.onWatchlist ?? null);
      }
    } catch {
      if (!stillCurrent()) return;
      if (candidate.isPerson) updatePersonCardEye(host, candidate.title, null);
      else updateCardOverlay(host, candidate, 'unknown', null);
    }
  })();
  return true;
}

/** Compact watchlist eye for person cards (trending, recently viewed). */
function personCardEye(name: string): HTMLElement {
  const host = document.createElement('span');
  host.className = 'ss-video-badge-host';
  host.dataset.soulsyncCard = '1';
  host.style.cssText = 'position:absolute;top:6px;right:6px;z-index:2147483646;display:flex;gap:4px;pointer-events:auto;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = badgeCssText;
  shadow.appendChild(style);
  const wrap = document.createElement('span');
  wrap.className = 'ss-card-badges';
  wrap.style.cssText = 'display:flex;gap:4px;';
  wrap.dataset.kind = 'person';
  shadow.appendChild(wrap);
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'ss-card-badge ss-card-unknown';
  eye.textContent = '⋯';
  eye.title = 'Checking watchlist…';
  wrap.appendChild(eye);
  return host;
}

/** Update a person card's watchlist eye. */
function updatePersonCardEye(host: HTMLElement, name: string, onWatchlist: boolean | null): void {
  const root = host.shadowRoot ?? host;
  const eye = root.querySelector('.ss-card-badge') as HTMLButtonElement | null;
  if (!eye) return;
  if (onWatchlist === true) {
    eye.className = 'ss-card-badge ss-card-watching';
    eye.textContent = '👁';
    eye.title = `${name} — on your watchlist. Click to unfollow.`;
    let armed = false;
    let armTimer: number | undefined;
    eye.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!armed) {
        armed = true;
        eye.textContent = '✕';
        eye.title = 'Click again to confirm unfollow';
        // Armed verify expires (5s, parity with the music badges).
        if (armTimer !== undefined) window.clearTimeout(armTimer);
        armTimer = window.setTimeout(() => {
          armTimer = undefined;
          if (armed) {
            armed = false;
            eye.textContent = '👁';
            eye.title = `${name} — on your watchlist. Click to unfollow.`;
          }
        }, 5000);
        return;
      }
      if (armTimer !== undefined) {
        window.clearTimeout(armTimer);
        armTimer = undefined;
      }
      eye.disabled = true;
      const res = (await browser.runtime
        .sendMessage({
          type: 'SOULSYNC_VIDEO_BADGE_ACTION', action: 'unwatch-person', name,
        })
        .catch(() => null)) as { ok?: boolean } | null;
      if (res?.ok) {
        eye.className = 'ss-card-badge ss-card-notwatching';
        eye.textContent = '👁';
        eye.title = `Add ${name} to your watchlist`;
        armed = false;
        eye.onclick = personWatchHandler(eye, name);
        updateCachedAnswer(host, { onWatchlist: false });
      } else {
        // Failed: restore the watching eye unarmed (the arm timer was
        // already cleared — a lingering armed "✕" would remove in one
        // click next time).
        updatePersonCardEye(host, name, true);
      }
      eye.disabled = false;
    };
  } else if (onWatchlist === false) {
    eye.className = 'ss-card-badge ss-card-notwatching';
    eye.textContent = '👁';
    eye.title = `Add ${name} to your watchlist`;
    eye.onclick = personWatchHandler(eye, name);
  } else {
    eye.className = 'ss-card-badge ss-card-unknown';
    eye.textContent = '?';
    eye.title = "Couldn't check watchlist";
  }
}

function personWatchHandler(eye: HTMLButtonElement, name: string): (e: MouseEvent) => void {
  return async (e) => {
    e.preventDefault(); e.stopPropagation();
    eye.disabled = true;
    const res = (await browser.runtime
      .sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION', action: 'watch-person', name,
      })
      .catch(() => null)) as { ok?: boolean } | null;
    if (res?.ok) {
      const hostEl = (eye.getRootNode() as ShadowRoot).host as HTMLElement;
      updatePersonCardEye(hostEl, name, true);
      updateCachedAnswer(hostEl, { onWatchlist: true });
    }
    eye.disabled = false;
  };
}

function makeCardBadge(role: 'lib' | 'eye'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.role = role;
  btn.className = 'ss-card-badge ss-card-unknown';
  btn.textContent = '⋯';
  btn.title = role === 'eye' ? 'Checking watchlist…' : 'Checking…';
  return btn;
}

/** The card eye in its "watching" state, with the two-click unfollow
 *  (first click arms for 5s, second removes). Shared by the initial update
 *  and by the watch action's success path, so the lib badge's state is
 *  never repainted as a side effect. */
function setCardEyeWatching(eye: HTMLButtonElement, candidate: VideoCandidate): void {
  eye.className = 'ss-card-badge ss-card-watching';
  eye.textContent = '👁';
  eye.title = `${candidate.title} — on your watchlist. Click to unfollow.`;
  let armed = false;
  let armTimer: number | undefined;
  eye.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!armed) {
      armed = true;
      eye.textContent = '✕';
      eye.title = 'Click again to confirm unfollow';
      if (armTimer !== undefined) window.clearTimeout(armTimer);
      armTimer = window.setTimeout(() => {
        armTimer = undefined;
        if (armed) {
          armed = false;
          eye.textContent = '👁';
          eye.title = `${candidate.title} — on your watchlist. Click to unfollow.`;
        }
      }, 5000);
      return;
    }
    if (armTimer !== undefined) {
      window.clearTimeout(armTimer);
      armTimer = undefined;
    }
    eye.disabled = true;
    const res = (await browser.runtime
      .sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION',
        action: 'unwatch-show',
        title: candidate.title, year: candidate.year, tmdbId: candidate.tmdbId,
      })
      .catch(() => null)) as { ok?: boolean } | null;
    if (res?.ok) {
      setCardEyeNotWatching(eye, candidate);
      updateCachedAnswer(
        (eye.getRootNode() as ShadowRoot).host as HTMLElement,
        { onWatchlist: false },
      );
    } else {
      // Failed: restore the watching eye with a fresh (unarmed) handler —
      // never leave a cleared-timer armed "✕" that unfollows in one click.
      setCardEyeWatching(eye, candidate);
    }
    eye.disabled = false;
  };
}

function setCardEyeNotWatching(eye: HTMLButtonElement, candidate: VideoCandidate): void {
  eye.className = 'ss-card-badge ss-card-notwatching';
  eye.textContent = '👁';
  eye.title = `Add ${candidate.title} to your watchlist`;
  eye.onclick = watchEyeHandler(eye, candidate);
}

/** Compact corner overlay for rec cards: library/wishlist dot + watchlist eye. */
function cardOverlayFor(candidate: VideoCandidate): HTMLElement {
  const host = document.createElement('span');
  host.className = 'ss-video-badge-host';
  host.dataset.soulsyncCard = '1';
  // Position the host itself in the corner; shadow DOM carries the styles.
  host.style.cssText = 'position:absolute;top:6px;right:6px;z-index:2147483646;display:flex;gap:4px;pointer-events:auto;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = badgeCssText;
  shadow.appendChild(style);

  const wrap = document.createElement('span');
  wrap.className = 'ss-card-badges';
  wrap.style.cssText = 'display:flex;gap:4px;';
  wrap.dataset.kind = candidate.kind;
  // Note: buttons stopPropagation in their own handlers (bubble phase).
  // Do NOT use capture-phase stopPropagation here — it kills our own buttons.
  shadow.appendChild(wrap);

  // Same standard as the page-subject pill: movies get the library/wishlist
  // dot; shows get BOTH the dot and the watchlist eye.
  wrap.appendChild(makeCardBadge('lib'));
  if (candidate.kind === 'show') wrap.appendChild(makeCardBadge('eye'));
  return host;
}

function updateCardOverlay(
  host: HTMLElement,
  candidate: VideoCandidate,
  state: VideoPillState,
  onWatchlist: boolean | null,
): void {
  const root = host.shadowRoot ?? host;
  const wrap = root.querySelector('.ss-card-badges') as HTMLElement | null;

  // If the server's kind differs from our guess, rebuild the overlay:
  // movies carry the lib dot only, shows carry lib dot + watchlist eye.
  if (wrap && wrap.dataset.kind !== candidate.kind) {
    wrap.dataset.kind = candidate.kind;
    wrap.innerHTML = '';
    wrap.appendChild(makeCardBadge('lib'));
    if (candidate.kind === 'show') wrap.appendChild(makeCardBadge('eye'));
  }

  const lib = root.querySelector('[data-role="lib"]') as HTMLButtonElement | null;
  const eye = root.querySelector('[data-role="eye"]') as HTMLButtonElement | null;

  // Library / wishlist badge.
  if (lib && state === 'in-library') {
    lib.className = 'ss-card-badge ss-card-inlib';
    lib.textContent = '✓';
    // TMDB rec cards carry a tmdbId from their href; IMDb/Trakt cards don't
    // — those stay unclickable rather than fake an identity.
    const canPlay = typeof candidate.tmdbId === 'number' && candidate.tmdbId > 0;
    lib.title = canPlay
      ? `${candidate.title} — in your library. Click to play.`
      : `${candidate.title} — in your library`;
    lib.onclick = canPlay
      ? (e) => {
          e.preventDefault();
          e.stopPropagation();
          void playVideoEntry(lib, candidate);
        }
      : null;
  } else if (lib && state === 'on-wishlist') {
    lib.className = 'ss-card-badge ss-card-wishlisted';
    lib.textContent = '✓';
    lib.title = `${candidate.title} — on your wishlist`;
  } else if (lib && state === 'addable') {
    lib.className = 'ss-card-badge ss-card-addable';
    lib.textContent = '+';
    lib.title = `Add ${candidate.title} to your wishlist`;
    lib.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      lib.disabled = true;
      const res = (await browser.runtime
        .sendMessage({
          type: 'SOULSYNC_VIDEO_BADGE_ACTION',
          action: 'wishlist-video',
          title: candidate.title, year: candidate.year,
          kind: candidate.kind, tmdbId: candidate.tmdbId,
          episode: candidate.episode,
        })
        .catch(() => null)) as { ok?: boolean } | null;
      if (res?.ok) {
        lib.className = 'ss-card-badge ss-card-wishlisted';
        lib.textContent = '✓';
        lib.title = `${candidate.title} — on your wishlist`;
        lib.onclick = null;
        updateCachedAnswer(host, { state: 'on-wishlist' });
      }
      lib.disabled = false;
    };
  } else if (lib) {
    lib.className = 'ss-card-badge ss-card-unknown';
    lib.textContent = '?';
    lib.title = "Couldn't check";
  }

  // Watchlist eye (shows only).
  if (eye && candidate.kind === 'show') {
    if (onWatchlist === true) {
      setCardEyeWatching(eye, candidate);
    } else if (onWatchlist === false) {
      setCardEyeNotWatching(eye, candidate);
    } else {
      eye.className = 'ss-card-badge ss-card-unknown';
      eye.textContent = '?';
      eye.title = "Couldn't check watchlist";
      eye.onclick = null;
    }
  }
}

function watchEyeHandler(eye: HTMLButtonElement, candidate: VideoCandidate): (e: MouseEvent) => void {
  return async (e) => {
    e.preventDefault(); e.stopPropagation();
    eye.disabled = true;
    const res = (await browser.runtime
      .sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION',
        action: 'watch-show',
        title: candidate.title, year: candidate.year, tmdbId: candidate.tmdbId,
      })
      .catch(() => null)) as { ok?: boolean } | null;
    // Flip only the eye — the lib badge keeps its own verified state.
    if (res?.ok) {
      setCardEyeWatching(eye, candidate);
      updateCachedAnswer(
        (eye.getRootNode() as ShadowRoot).host as HTMLElement,
        { onWatchlist: true },
      );
    }
    eye.disabled = false;
  };
}

// SPA navigation + dynamic content: every mutation schedules a debounced
// reconcile (trailing edge, with a max wait so constant churn can't starve
// it). The reconcile re-extracts the page subject and remounts only when
// its identity changed — so a sidebar click whose title/channel DOM swaps
// AFTER the URL still ends with the new video's badge, and late-rendered
// cast/rec content gets badged without a reload. On URL change all badge
// state resets: hosts are dropped, in-flight answers are invalidated via
// navGen, and card check bookkeeping starts fresh.
let lastUrl = location.href;
let reconcileTimer: number | null = null;
let reconcileWaitStart = 0;
function scheduleReconcile(): void {
  if (!checkContext()) return;
  const now = Date.now();
  if (reconcileTimer === null) reconcileWaitStart = now;
  else window.clearTimeout(reconcileTimer);
  const delay = now - reconcileWaitStart >= 2000 ? 0 : 350;
  reconcileTimer = window.setTimeout(() => {
    reconcileTimer = null;
    reconcileWaitStart = 0;
    void reconcile();
  }, delay);
}
function clearAllVideoBadges(): void {
  document.querySelectorAll('.ss-video-badge-host').forEach((el) => el.remove());
  mountedSubject = null;
  pendingCardChecks.clear();
  cardKeyChecked.clear();
  cardAnswerCache.clear();
}
/** True while this content script's extension context is alive (parity
 *  with page-badges): after an extension reload/update, orphaned scripts
 *  keep running in open tabs but every runtime call fails — detect it
 *  once and shut down instead of reconciling dead badges forever. */
let contextAlive = true;
function checkContext(): boolean {
  if (!contextAlive) return false;
  try {
    void browser.runtime?.id;
    return true;
  } catch {
    contextAlive = false;
    return false;
  }
}
const domObserver = new MutationObserver(() => {
  if (!checkContext()) {
    domObserver.disconnect();
    return;
  }
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    navGen++;
    clearAllVideoBadges();
  }
  scheduleReconcile();
});
// href is observed too: a sidebar swap can retarget the owner/card links
// (an attribute change) without any child-list churn, and the links carry
// the identities the signatures are built from.
domObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['href'],
});

// YouTube fires this once a sidebar navigation has fully rendered — a
// second chance to reconcile with the settled DOM (the debounced mutation
// path already covers it; this just shortens the wait on real YouTube).
document.addEventListener('yt-navigate-finish', () => scheduleReconcile());

// Live master switch (parity with page-badges): toggling badges off tears
// them down immediately instead of leaving them until the next navigation.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(BADGES_ENABLED_KEY in changes)) return;
  void (async () => {
    if (await badgesEnabled()) scheduleReconcile();
    else clearAllVideoBadges();
  })();
});

void reconcile();
