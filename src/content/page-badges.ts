import browser from 'webextension-polyfill';
import { artistName, jsonLdOfType, metaTag, trackTitles } from '../shared/dom.js';
import { normName } from '../shared/api.js';

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
export type PageProvider = 'spotify' | 'bandcamp' | 'soundcloud' | 'deezer' | 'tidal';

function pageProvider(): PageProvider | undefined {
  const h = location.hostname;
  if (h === 'open.spotify.com') return 'spotify';
  if (h.includes('bandcamp')) return 'bandcamp';
  if (h.includes('soundcloud')) return 'soundcloud';
  if (h.includes('deezer')) return 'deezer';
  if (h.includes('tidal')) return 'tidal';
  return undefined;
}

interface Candidate {
  kind: 'artist' | 'album';
  name: string;
  artist?: string;
  tracks?: string[];
  anchor: Element;
  pageUrl: string;
  /** Page-subject badge (artist/album page title) vs. a link badge in a list. */
  primary?: boolean;
  /** Provider the candidate was extracted from (hostname-verified). */
  provider?: PageProvider;
}

type PillState = 'loading' | 'in' | 'out' | 'unknown' | 'acted';

interface BadgeRec {
  pill: HTMLButtonElement;
  candidate: Candidate;
  state: PillState;
  pop: HTMLDivElement | null;
  /** Body-level layer hosting the popover's shadow root (null when closed). */
  popLayer: HTMLElement | null;
}

const HOST_ATTR = 'data-ssb';
const MAX_PER_SCAN = 30;
/** candidates the user already acted on this page load (watch/wishlist) */
const actedKeys = new Set<string>();
const badges = new Map<HTMLElement, BadgeRec>();

function badgeKeyFor(c: Pick<Candidate, 'kind' | 'name' | 'artist'>): string {
  // Must match api.ts badgeKey exactly: kind + normalized "artist name".
  return `${c.kind}:${normName(c.artist ? `${c.artist} ${c.name}` : c.name)}`;
}

/* ── extractors ── */

function trackRows(): { title: string; artist: string }[] {
  const rows: { title: string; artist: string }[] = [];
  // Verified Sep 2026 against real Spotify DOM: row text is
  // "Title\nE\nArtist\n4:10" (E = explicit marker, then duration).
  document.querySelectorAll('[data-testid="tracklist-row"]').forEach((row) => {
    const lines = (row.textContent ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== 'E' && !/^\d+:\d+$/.test(s));
    if (lines.length >= 2) rows.push({ title: lines[0], artist: lines[1] });
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

/** Spotify: verified Sep 2026 — [data-testid="entityTitle"] holds the page subject. */
function spotifyCandidates(): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (c: Omit<Candidate, 'pageUrl' | 'provider'>): void => {
    const name = c.name.trim();
    if (name.length < 2 || name.length > 80 || name.includes('\n')) return;
    const key = badgeKeyFor(c);
    if (seen.has(key) || out.length >= MAX_PER_SCAN) return;
    seen.add(key);
    out.push({ ...c, name, pageUrl: location.href, provider: 'spotify' });
  };
  const path = location.pathname;

  const titleEl = document.querySelector('[data-testid="entityTitle"]');
  const title = titleEl?.textContent?.trim() ?? '';
  if (titleEl && title) {
    if (path.includes('/artist/')) {
      push({ kind: 'artist', name: title, anchor: titleEl, primary: true });
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
      });
    }
  }

  // Artist links in lists: search results, playlists, "fans also like".
  // URL-shaped selector (not class names) — stable across redesigns.
  document.querySelectorAll<HTMLAnchorElement>('a[href*="/artist/"]').forEach((a) => {
    if (!isBareArtistHref(a.getAttribute('href') ?? '')) return;
    push({ kind: 'artist', name: a.textContent ?? '', anchor: a });
  });
  // Album links in lists are deliberately NOT badged: a bare /album/<id> link
  // carries no trustworthy artist context, so the library check could never
  // resolve past "unknown" — a permanent row of ? badges is noise, not
  // signal. The album page itself (primary badge above, artist derived from
  // its track rows) still badges.
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

function collectCandidates(): Candidate[] {
  if (location.hostname === 'open.spotify.com') return spotifyCandidates();
  return genericCandidates();
}

/* ── badge chrome (shadow DOM) ── */

function cssLink(): HTMLLinkElement {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = browser.runtime.getURL('content/page-badges.css');
  return css;
}

function mountBadge(c: Candidate): HTMLElement {
  c.anchor.setAttribute(HOST_ATTR, '1');
  const host = document.createElement('span');
  host.className = 'ssb-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const css = cssLink();
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
  badges.set(host, { pill, candidate: c, state: 'loading', pop: null, popLayer: null });
  pill.addEventListener('click', (ev) => {
    ev.stopPropagation();
    togglePopover(host);
  });
  return host;
}

function setPillState(host: HTMLElement, state: Exclude<PillState, 'loading'>): void {
  const rec = badges.get(host);
  if (!rec) return;
  rec.state = state;
  const { pill, candidate } = rec;
  if (state === 'in') {
    pill.className = 'ssb-pill ssb-in';
    pill.title = 'In your SoulSync library';
    pill.setAttribute('aria-label', `${candidate.name} is in your SoulSync library`);
    pill.innerHTML = '<span aria-hidden="true">✓</span><span>Library</span>';
  } else if (state === 'acted') {
    pill.className = 'ssb-pill ssb-acted';
    pill.title = 'Done';
    pill.setAttribute('aria-label', `${candidate.name}: done`);
    pill.innerHTML = '<span aria-hidden="true">✓</span>';
  } else if (state === 'unknown') {
    pill.className = 'ssb-pill ssb-unknown';
    pill.title = "Couldn't check your SoulSync library";
    pill.setAttribute('aria-label', `${candidate.name}: library status unknown. Show details.`);
    pill.textContent = '?';
  } else {
    pill.className = 'ssb-pill ssb-out';
    pill.title = 'Not in your library — add it';
    pill.setAttribute('aria-label', `${candidate.name} is not in your library. Show actions.`);
    pill.textContent = '+';
  }
}

function closePopover(rec: BadgeRec): void {
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

function popShell(rec: BadgeRec, serverUrl: string): HTMLDivElement {
  const pop = document.createElement('div');
  pop.className = 'ssb-pop';
  const c = rec.candidate;
  const name = document.createElement('div');
  name.className = 'ssb-pop-name';
  name.textContent = c.kind === 'album' && c.artist ? `${c.artist} — ${c.name}` : c.name;
  const sub = document.createElement('div');
  sub.className = 'ssb-pop-sub';
  sub.textContent = 'Not in your SoulSync library';
  const err = document.createElement('div');
  err.className = 'ssb-err';
  err.hidden = true;
  const open = document.createElement('a');
  open.className = 'ssb-link';
  open.href = `${serverUrl.replace(/\/+$/, '')}/dashboard`;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open in SoulSync';
  pop.append(name, sub, err, open);
  return pop;
}

function insertPop(rec: BadgeRec, pop: HTMLDivElement): void {
  // The popover lives in its own shadow root on a layer appended directly
  // to document.body. position:fixed inside the pill's shadow tree is
  // unreliable on sites like Spotify, where a filter/will-change/contain
  // ancestor between the anchor and <body> becomes the containing block and
  // shifts the popover away from its CSS coordinates. At body level the
  // viewport is the containing block again.
  const layer = document.createElement('div');
  layer.className = 'ssb-pop-layer';
  const shadow = layer.attachShadow({ mode: 'open' });
  shadow.appendChild(cssLink());
  shadow.appendChild(pop);
  document.body.appendChild(layer);
  rec.pop = pop;
  rec.popLayer = layer;
  // Measure after append so the whole popover stays inside the viewport.
  const r = rec.pill.getBoundingClientRect();
  const h = pop.offsetHeight || 160;
  pop.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 12))}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 248))}px`;
}

async function onWatchArtist(rec: BadgeRec, btn: HTMLButtonElement, artistName: string): Promise<void> {
  btn.dataset.label = btn.textContent ?? '';
  btn.disabled = true;
  btn.textContent = 'Matching…';
  const c = rec.candidate;
  const resolved = await badgeAction(rec, { action: 'resolve-artist', name: artistName });
  if (resolved.error || !resolved.id) {
    showError(rec, String(resolved.error ?? 'No match found.'));
    return;
  }
  // Confirm step: the resolved name may differ from the page text — the
  // user sees exactly what will be watched. Never auto-add on a fuzzy match.
  const pop = rec.pop;
  if (!pop) return;
  pop.querySelectorAll('.ssb-btn').forEach((b) => b.remove());
  const q = document.createElement('div');
  q.className = 'ssb-pop-sub';
  q.textContent = `Watch "${String(resolved.name)}"?`;
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'ssb-btn ssb-primary';
  confirm.textContent = 'Watch artist';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ssb-btn';
  cancel.textContent = 'Cancel';
  pop.insertBefore(q, pop.querySelector('.ssb-err'));
  pop.insertBefore(confirm, pop.querySelector('.ssb-err'));
  pop.insertBefore(cancel, pop.querySelector('.ssb-err'));
  cancel.addEventListener('click', () => closePopover(rec));
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    confirm.textContent = 'Watching…';
    const done = await badgeAction(rec, {
      action: 'watch-artist',
      id: String(resolved.id),
      name: String(resolved.name),
      source: typeof resolved.source === 'string' ? resolved.source : undefined,
    });
    if (done.error) {
      showError(rec, String(done.error));
      confirm.disabled = false;
      confirm.textContent = 'Watch artist';
      return;
    }
    actedKeys.add(badgeKeyFor(c));
    closePopover(rec);
    const host = [...badges.entries()].find(([, r]) => r === rec)?.[0];
    if (host) setPillState(host, 'acted');
  });
}

async function onWishlistAlbum(rec: BadgeRec, btn: HTMLButtonElement): Promise<void> {
  btn.dataset.label = btn.textContent ?? '';
  btn.disabled = true;
  btn.textContent = 'Adding…';
  const c = rec.candidate;
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

function togglePopover(host: HTMLElement): void {
  const rec = badges.get(host);
  if (!rec || (rec.state !== 'out' && rec.state !== 'unknown')) return;
  if (rec.pop) {
    closePopover(rec);
    return;
  }
  const serverUrl = recServerUrl.get(host) ?? '';
  const pop = popShell(rec, serverUrl);
  const c = rec.candidate;

  if (rec.state === 'unknown') {
    // Couldn't verify against the library — explain, offer no actions that
    // would act on an unverified guess.
    const note = pop.querySelector('.ssb-pop-sub');
    if (note) note.textContent = "Couldn't reach your library to check this one.";
  } else if (c.kind === 'artist') {
    const watch = document.createElement('button');
    watch.type = 'button';
    watch.className = 'ssb-btn ssb-primary';
    watch.textContent = '👁 Watch artist';
    watch.addEventListener('click', () => void onWatchArtist(rec, watch, c.name));
    pop.insertBefore(watch, pop.querySelector('.ssb-err'));
  } else {
    if (c.artist && c.tracks && c.tracks.length > 0) {
      const wl = document.createElement('button');
      wl.type = 'button';
      wl.className = 'ssb-btn ssb-primary';
      wl.textContent = `＋ Wishlist album (${c.tracks.length} tracks)`;
      wl.addEventListener('click', () => void onWishlistAlbum(rec, wl));
      pop.insertBefore(wl, pop.querySelector('.ssb-err'));
    }
    if (c.artist) {
      const watch = document.createElement('button');
      watch.type = 'button';
      watch.className = 'ssb-btn';
      watch.textContent = `👁 Watch ${c.artist}`;
      // Explicit artist target — never mutates rec.candidate, so cancelling
      // and reopening can't leave this badge acting like an artist badge.
      const artistName = c.artist;
      watch.addEventListener('click', () => void onWatchArtist(rec, watch, artistName));
      pop.insertBefore(watch, pop.querySelector('.ssb-err'));
    }
  }
  insertPop(rec, pop);
}

const recServerUrl = new Map<HTMLElement, string>();

/* ── scan lifecycle ── */

async function scan(): Promise<void> {
  const fresh = collectCandidates().filter((c) => !c.anchor.hasAttribute(HOST_ATTR));
  if (fresh.length === 0) return;
  const hosts = fresh.map(mountBadge);
  let resp: { configured?: boolean; results?: Record<string, boolean | null>; serverUrl?: string };
  try {
    resp = (await browser.runtime.sendMessage({
      type: 'SOULSYNC_BADGE_LOOKUP',
      items: fresh.map((c) => ({ kind: c.kind, name: c.name, artist: c.artist })),
    })) as typeof resp;
  } catch {
    resp = {};
  }
  if (!resp.configured) {
    // No server configured — take the loading pills back down silently.
    hosts.forEach((h) => {
      badges.delete(h);
      h.remove();
    });
    // …and unmark anchors so a later configure retries them.
    fresh.forEach((c) => c.anchor.removeAttribute(HOST_ATTR));
    return;
  }
  fresh.forEach((c, i) => {
    const host = hosts[i];
    recServerUrl.set(host, resp.serverUrl ?? '');
    if (actedKeys.has(badgeKeyFor(c))) {
      setPillState(host, 'acted');
      return;
    }
    // Tri-state: true = in library, false = verified absent, anything else
    // (null / missing key) = couldn't verify — never show "not in library".
    const v = resp.results?.[badgeKeyFor(c)];
    setPillState(host, v === true ? 'in' : v === false ? 'out' : 'unknown');
  });
}

function clearBadges(): void {
  badges.forEach((rec, host) => {
    closePopover(rec);
    host.remove();
  });
  badges.clear();
  recServerUrl.clear();
  document.querySelectorAll(`[${HOST_ATTR}]`).forEach((el) => el.removeAttribute(HOST_ATTR));
}

let lastUrl = location.href;
let timer: number | null = null;

function scheduleScan(): void {
  if (timer !== null) return;
  timer = window.setTimeout(() => {
    timer = null;
    void scan().catch(() => undefined);
  }, 800);
}

function boot(): void {
  scheduleScan();
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      clearBadges();
    }
    // Anchors removed by SPA re-renders take their badge with them.
    badges.forEach((rec, host) => {
      if (!rec.candidate.anchor.isConnected) {
        if (rec.pop) closePopover(rec);
        host.remove();
        badges.delete(host);
      }
    });
    scheduleScan();
  }).observe(document.documentElement, { childList: true, subtree: true });

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
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
