import browser from 'webextension-polyfill';
import { BADGES_ENABLED_KEY, badgesEnabledFromStored } from '../shared/api.js';
import type { OpenVideoResponse, PendingVideoEntry } from '../player/types.js';
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
 */

export type VideoProvider = 'imdb' | 'tmdb' | 'trakt' | 'letterboxd';

function videoProvider(): VideoProvider | undefined {
  const h = location.hostname;
  if (h.includes('imdb.com')) return 'imdb';
  if (h.includes('themoviedb.org')) return 'tmdb';
  if (h.includes('trakt.tv')) return 'trakt';
  if (h.includes('letterboxd.com')) return 'letterboxd';
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
      const res = (await browser.runtime.sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION',
        action: 'wishlist-video',
        title: candidate.title,
        year: candidate.year,
        kind: candidate.kind,
        tmdbId: candidate.tmdbId,
        provider: candidate.provider,
      })) as { ok?: boolean; error?: string };
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
    const render = (watching: boolean): void => {
      armed = false;
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
      eye.disabled = true;
      const res = (await browser.runtime.sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION',
        action: watching ? 'unwatch-show' : 'watch-show',
        title: candidate.title,
        year: candidate.year,
        tmdbId: candidate.tmdbId,
      })) as { ok?: boolean };
      if (res?.ok) render(!watching);
      else if (armed) render(true); // failed: restore watching state
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

async function run(): Promise<void> {
  if (!(await badgesEnabled())) return;
  const provider = videoProvider();
  if (!provider) return;

  // Person pages get a watchlist eye; cast lists get compact eyes per actor.
  const person = extractPerson(provider);
  if (person) {
    const host = personEye(person);
    const anchor = person.anchor;
    if (anchor === document.body) {
      host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
      document.body.appendChild(host);
    } else {
      anchor.appendChild(host);
    }
    return;
  }

  const candidate = extractCandidate(provider);
  if (candidate) {
    // Insert a loading pill immediately; resolve status in the background.
    const host = pillFor(candidate, 'loading', null);
    const anchor = candidate.anchor;
    if (anchor === document.body) {
      host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
      document.body.appendChild(host);
    } else {
      anchor.appendChild(host);
    }

    try {
      const res = (await browser.runtime.sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION',
        action: 'check-video',
        title: candidate.title,
        year: candidate.year,
        kind: candidate.kind,
        tmdbId: candidate.tmdbId,
        provider: candidate.provider,
      })) as {
        state?: VideoPillState;
        onWatchlist?: boolean | null;
        error?: string;
      };
      const state = res?.state ?? 'unknown';
      const fresh = pillFor(candidate, state, res?.onWatchlist ?? null);
      host.replaceWith(fresh);
    } catch {
      host.replaceWith(pillFor(candidate, 'unknown', null));
    }
  }

  // Cast lists + recommendations on title pages.
  mountCastEyes(provider);
  mountRecBadges(provider);
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
  const render = (watching: boolean | null): void => {
    armed = false;
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
    eye.disabled = true;
    const res = (await browser.runtime.sendMessage({
      type: 'SOULSYNC_VIDEO_BADGE_ACTION',
      action: watching ? 'unwatch-person' : 'watch-person',
      name: candidate.name,
      tmdbId: candidate.tmdbId,
    })) as { ok?: boolean };
    if (res?.ok) render(!watching);
    else if (armed) render(true);
    eye.disabled = false;
  });

  // Resolve status in the background.
  browser.runtime.sendMessage({
    type: 'SOULSYNC_VIDEO_BADGE_ACTION',
    action: 'check-person',
    name: candidate.name,
    tmdbId: candidate.tmdbId,
  }).then((res: unknown) => {
    const r = res as { onWatchlist?: boolean | null };
    render(r?.onWatchlist ?? null);
  }).catch(() => render(null));

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
    if (anchor.querySelector('.ss-video-badge-host')) continue;
    const name = (anchor.textContent || '').trim();
    if (!name) continue;
    let tmdbId: number | undefined;
    const href = anchor.getAttribute('href') || '';
    const tm = href.match(/\/person\/(\d+)/);
    if (tm) tmdbId = parseInt(tm[1], 10);
    const eye = personEye({ name, tmdbId, anchor });
    eye.style.marginLeft = '6px';
    anchor.appendChild(eye);
  }
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
    if (card.querySelector('.ss-video-badge-host')) continue;

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
        if (name && !card.querySelector('.ss-video-badge-host')) {
          const host = personCardEye(name);
          // Celebrity cards use .ipc-avatar, poster cards use .ipc-poster.
          const poster = (card.querySelector('.ipc-poster, .ipc-avatar') as HTMLElement | null);
          const target = poster || card;
          if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
          target.appendChild(host);
          // Viewport-gated like title cards.
          pendingCardChecks.set(card, { host, candidate: { title: name, year: null, kind: 'show', anchor: nameLink, provider, isPerson: true } as VideoCandidate });
          cardObserver.observe(card);
        }
        continue;
      }
      // Title link: .ipc-poster-card__title (may wrap a [data-testid="title"] span).
      anchor = card.querySelector('a.ipc-poster-card__title');
      if (!anchor) continue;
      const titleSpan = anchor.querySelector('[data-testid="title"]');
      title = (titleSpan?.textContent || anchor.textContent || '').trim();
      if (!title) continue;
      // TV hint: the "returning to TV" rail or TV-series metadata.
      const cardHtml = card.innerHTML;
      if (cardHtml.includes('rttv-') || /TV Series/i.test(cardHtml)) kind = 'show';
      // Episode cards (S1.E10): wishlist-able like movies. Detect via
      // the episode number link.
      const epLink = card.querySelector('[data-testid="rttv-episode-num"]');
      if (epLink) {
        const epText = (epLink.textContent || '').trim();
        const epMatch = epText.match(/S(\d+)\.E(\d+)/i);
        if (epMatch) {
          kind = 'movie'; // wishlist badge, not watchlist eye
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
    const host = cardOverlayFor(candidate);
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
    cardObserver.observe(card);
  }
}

// Viewport-gated checks: IntersectionObserver fires when cards scroll into view.
const pendingCardChecks = new Map<Element, { host: HTMLElement; candidate: VideoCandidate }>();
const checkedCards = new WeakSet<Element>();
const cardObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      const card = entry.target;
      cardObserver.unobserve(card);
      queueCardCheck(card);
    }
  }
}, { rootMargin: '200px' }); // pre-load slightly before visible

function queueCardCheck(card: Element): void {
  if (checkedCards.has(card)) return;
  const pending = pendingCardChecks.get(card);
  if (!pending) return;
  // Only fire if the card is actually visible (or the observer triggered us).
  // Check both axes: horizontal rails have cards off-screen to the sides.
  const rect = card.getBoundingClientRect();
  const inViewport = rect.top < window.innerHeight + 200 && rect.bottom > -200
    && rect.left < window.innerWidth + 200 && rect.right > -200;
  if (!inViewport) return; // observer will trigger when scrolled into view
  checkedCards.add(card);
  pendingCardChecks.delete(card);
  const { host, candidate } = pending;
  void (async () => {
    try {
      if (candidate.isPerson) {
        // Person card: check person watchlist.
        const res = await browser.runtime.sendMessage({
          type: 'SOULSYNC_VIDEO_BADGE_ACTION',
          action: 'check-person',
          name: candidate.title,
        }) as { onWatchlist?: boolean | null };
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
        if (res?.hitKind) candidate.kind = res.hitKind;
        updateCardOverlay(host, candidate, res?.state ?? 'unknown', res?.onWatchlist ?? null);
      }
    } catch {
      if (candidate.isPerson) updatePersonCardEye(host, candidate.title, null);
      else updateCardOverlay(host, candidate, 'unknown', null);
    }
  })();
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
    eye.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!armed) { armed = true; eye.textContent = '✕'; eye.title = 'Click again to confirm unfollow'; return; }
      eye.disabled = true;
      const res = await browser.runtime.sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION', action: 'unwatch-person', name,
      }) as { ok?: boolean };
      if (res?.ok) {
        eye.className = 'ss-card-badge ss-card-notwatching';
        eye.textContent = '👁';
        eye.title = `Add ${name} to your watchlist`;
        armed = false;
        eye.onclick = personWatchHandler(eye, name);
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
    const res = await browser.runtime.sendMessage({
      type: 'SOULSYNC_VIDEO_BADGE_ACTION', action: 'watch-person', name,
    }) as { ok?: boolean };
    if (res?.ok) updatePersonCardEye((eye.getRootNode() as ShadowRoot).host as HTMLElement, name, true);
    eye.disabled = false;
  };
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

  // Shows + people: watchlist eye only. Movies: library/wishlist only.
  if (candidate.kind === 'show') {
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'ss-card-badge ss-card-unknown';
    eye.textContent = '⋯';
    eye.title = 'Checking watchlist…';
    wrap.appendChild(eye);
  } else {
    const lib = document.createElement('button');
    lib.type = 'button';
    lib.className = 'ss-card-badge ss-card-unknown';
    lib.textContent = '⋯';
    lib.title = 'Checking…';
    wrap.appendChild(lib);
  }
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
  let badges = Array.from(root.querySelectorAll('.ss-card-badge')) as HTMLButtonElement[];

  // If the server's kind differs from our guess, rebuild the overlay.
  // Shows get 1 badge (eye), movies get 1 badge (lib).
  const wantEye = candidate.kind === 'show';
  const hasEye = badges.length > 0 && wrap?.dataset.kind === 'show';
  if (wrap && hasEye !== wantEye) {
    wrap.dataset.kind = candidate.kind;
    wrap.innerHTML = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ss-card-badge ss-card-unknown';
    btn.textContent = '⋯';
    wrap.appendChild(btn);
    badges = [btn];
  }

  const lib = candidate.kind === 'show' ? null : badges[0];
  const eye = candidate.kind === 'show' ? badges[0] : null;

  // Library / wishlist badge (movies only).
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
      const res = await browser.runtime.sendMessage({
        type: 'SOULSYNC_VIDEO_BADGE_ACTION',
        action: 'wishlist-video',
        title: candidate.title, year: candidate.year,
        kind: candidate.kind, tmdbId: candidate.tmdbId,
        episode: candidate.episode,
      }) as { ok?: boolean };
      if (res?.ok) {
        lib.className = 'ss-card-badge ss-card-wishlisted';
        lib.textContent = '✓';
        lib.title = `${candidate.title} — on your wishlist`;
        lib.onclick = null;
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
      eye.className = 'ss-card-badge ss-card-watching';
      eye.textContent = '👁';
      eye.title = `${candidate.title} — on your watchlist. Click to unfollow.`;
      let armed = false;
      eye.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!armed) {
          armed = true;
          eye.textContent = '✕';
          eye.title = 'Click again to confirm unfollow';
          return;
        }
        eye.disabled = true;
        const res = await browser.runtime.sendMessage({
          type: 'SOULSYNC_VIDEO_BADGE_ACTION',
          action: 'unwatch-show',
          title: candidate.title, year: candidate.year, tmdbId: candidate.tmdbId,
        }) as { ok?: boolean };
        if (res?.ok) {
          eye.className = 'ss-card-badge ss-card-notwatching';
          eye.textContent = '👁';
          eye.title = `Add ${candidate.title} to your watchlist`;
          armed = false;
          eye.onclick = watchEyeHandler(eye, candidate);
        }
        eye.disabled = false;
      };
    } else if (onWatchlist === false) {
      eye.className = 'ss-card-badge ss-card-notwatching';
      eye.textContent = '👁';
      eye.title = `Add ${candidate.title} to your watchlist`;
      eye.onclick = watchEyeHandler(eye, candidate);
    } else {
      eye.className = 'ss-card-badge ss-card-unknown';
      eye.textContent = '?';
      eye.title = "Couldn't check watchlist";
    }
  }
}

function watchEyeHandler(eye: HTMLButtonElement, candidate: VideoCandidate): (e: MouseEvent) => void {
  return async (e) => {
    e.preventDefault(); e.stopPropagation();
    eye.disabled = true;
    const res = await browser.runtime.sendMessage({
      type: 'SOULSYNC_VIDEO_BADGE_ACTION',
      action: 'watch-show',
      title: candidate.title, year: candidate.year, tmdbId: candidate.tmdbId,
    }) as { ok?: boolean };
    if (res?.ok) {
      eye.className = 'ss-card-badge ss-card-watching';
      eye.title = `${candidate.title} — on your watchlist. Click to unfollow.`;
      // Re-arm the two-click remove.
      const hostEl = (eye.getRootNode() as ShadowRoot).host as HTMLElement;
      updateCardOverlay(hostEl, candidate, 'in-library', true);
    }
    eye.disabled = false;
  };
}

// SPA navigations (TMDB/Trakt) — re-run when the URL changes.
// Also re-scan for new cards: IMDb loads rails dynamically after page load.
let lastUrl = location.href;
let recScanPending = false;
function scheduleRecScan(provider: VideoProvider): void {
  if (recScanPending) return;
  recScanPending = true;
  setTimeout(() => {
    recScanPending = false;
    mountRecBadges(provider);
  }, 800);
}
const domObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    document.querySelectorAll('.ss-video-badge-host').forEach((el) => el.remove());
    void run();
    return;
  }
  const provider = videoProvider();
  if (provider) scheduleRecScan(provider);
});
domObserver.observe(document.documentElement, { childList: true, subtree: true });

void run();
