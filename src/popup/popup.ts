import browser from 'webextension-polyfill';
import type { NowPlaying, ParsedTrack, ReleaseInfo, ServerConfig } from '../shared/types.js';
import { cleanNowPlaying } from '../shared/types.js';
import { parseSelection } from '../shared/parse.js';
import {
  addToWishlist,
  BADGES_ENABLED_KEY,
  badgesEnabledFromStored,
  directArtwork,
  getConfig,
  getRecentlyAdded,
  getServerStats,
  getWishlistCount,
  importToPlaylist,
  lookupLibraryTrackSmart,
  pickBest,
  removeFromWishlist,
  searchTracks,
  serverArtwork,
  wishlistRelease,
  wishlistTrack,
  type RecentAlbum,
  type ServerStats,
  type TrackHit,
} from '../shared/api.js';

import { initServerActivity } from './activity.js';
import { ChatTab } from './chat.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const HISTORY_KEY = 'soulsync_history';
const WISHLIST_IDS_KEY = 'soulsync_wishlist_ids';
const HISTORY_MAX = 20;

interface HistoryEntry {
  kind: 'wishlist' | 'unwishlist' | 'playlist' | 'release';
  title: string;
  artist: string;
  artwork: string;
  detail: string;
  at: number;
}

let cfg: ServerConfig | null = null;
let currentNp: NowPlaying | null = null;
let currentRelease: ReleaseInfo | null = null;
let parsed: ParsedTrack[] = [];

interface NpServerState {
  hit: TrackHit;
  inLibrary: boolean | null;
  onWishlist: boolean;
}
let npState: NpServerState | null = null;

let statusTimer: number | undefined;

function setStatus(msg: string, isError = false): void {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.toggle('ok', !isError && msg.length > 0);
  el.classList.add('show');
  window.clearTimeout(statusTimer);
  // Success toasts fade away; errors stay until the next message.
  if (msg && !isError) statusTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

function setNpStateLine(msg: string): void {
  $('np-state').textContent = msg;
}

async function activeTab(): Promise<browser.Tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Ask the tab's content script for something; null when there's no receiver. */
async function askTab<T>(tabId: number | undefined, type: string): Promise<T | null> {
  if (tabId === undefined) return null;
  try {
    return (await browser.tabs.sendMessage(tabId, { type })) as T;
  } catch {
    return null;
  }
}

/* ── history & memory (survives the popup closing) ── */

async function loadHistory(): Promise<HistoryEntry[]> {
  const s = (await browser.storage.local.get(HISTORY_KEY)) as Record<string, unknown>;
  const h = s[HISTORY_KEY];
  return Array.isArray(h) ? (h as HistoryEntry[]) : [];
}

async function pushHistory(entry: HistoryEntry): Promise<void> {
  const h = await loadHistory();
  h.unshift(entry);
  const trimmed = h.slice(0, HISTORY_MAX);
  await browser.storage.local.set({ [HISTORY_KEY]: trimmed });
  renderHistory(trimmed);
}

function relativeTime(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * An <img> with a fallback chain: if the primary (proxied) URL fails, retry
 * once with the direct URL before degrading to the gradient placeholder.
 * A broken-image icon is never shown. The placeholder carries the failed URL
 * in its title for diagnosis.
 */
function artImg(imgClass: string, phClass: string, primary: string, fallback: string): HTMLElement {
  const img = document.createElement('img');
  img.className = imgClass;
  img.alt = '';
  img.loading = 'lazy';
  let fellBack = false;
  img.onload = () => img.classList.add('loaded');
  img.onerror = () => {
    if (!fellBack && fallback && fallback !== primary) {
      fellBack = true;
      img.src = fallback;
      return;
    }
    const ph = document.createElement('div');
    ph.className = phClass;
    ph.title = `artwork unavailable: ${primary}`;
    img.replaceWith(ph);
  };
  img.src = primary;
  return img;
}

/** In its own tab the activity feed is always visible — no toggle needed. */
function renderHistory(h: HistoryEntry[]): void {
  $('history-count').textContent = h.length > 0 ? `· ${h.length}` : '';
  const list = $('history-list');
  list.innerHTML = '';
  if (h.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted tiny';
    li.textContent = 'Nothing yet — wishlist something and it will show up here.';
    list.appendChild(li);
    return;
  }
  for (const e of h) {
    const li = document.createElement('li');
    li.className = 'hist-row';
    if (e.artwork) {
      const img = document.createElement('img');
      img.className = 'hist-art';
      img.src = e.artwork;
      img.alt = '';
      img.onerror = () => img.remove();
      li.appendChild(img);
    }
    const mid = document.createElement('div');
    mid.className = 'hist-mid';
    const t = document.createElement('div');
    t.className = 'hist-title';
    t.textContent = e.title;
    const sub = document.createElement('div');
    sub.className = 'hist-sub muted';
    sub.textContent = `${e.artist} · ${e.detail}`;
    mid.append(t, sub);
    const when = document.createElement('div');
    when.className = 'hist-when muted';
    when.textContent = relativeTime(e.at);
    li.append(mid, when);
    list.appendChild(li);
  }
}

/** Track ids the companion itself wishlisted — the "on wishlist" memory. */
async function wishlistIds(): Promise<string[]> {
  const s = (await browser.storage.local.get(WISHLIST_IDS_KEY)) as Record<string, unknown>;
  const ids = s[WISHLIST_IDS_KEY];
  return Array.isArray(ids) ? (ids as string[]) : [];
}

async function rememberWishlisted(id: string): Promise<void> {
  const ids = await wishlistIds();
  if (!ids.includes(id)) {
    ids.push(id);
    await browser.storage.local.set({ [WISHLIST_IDS_KEY]: ids });
  }
}

async function forgetWishlisted(id: string): Promise<void> {
  const ids = (await wishlistIds()).filter((x) => x !== id);
  await browser.storage.local.set({ [WISHLIST_IDS_KEY]: ids });
}

/* ── now playing + server state ── */

async function loadNowPlaying(): Promise<void> {
  const tab = await activeTab();
  const res = await askTab<{ nowPlaying: NowPlaying | null }>(tab?.id, 'SOULSYNC_GET_NOW_PLAYING');
  currentNp = res?.nowPlaying ? cleanNowPlaying(res.nowPlaying) : null;
  $('np-empty').hidden = currentNp !== null;
  $('np-card').hidden = currentNp === null;
  if (!currentNp) return;
  $('np-title').textContent = currentNp.title;
  const artistEl = $('np-artist');
  artistEl.innerHTML = '';
  artistEl.append(document.createTextNode(currentNp.artist));
  if (currentNp.album) {
    const a = document.createElement('span');
    a.className = 'muted';
    a.textContent = ` — ${currentNp.album}`;
    artistEl.appendChild(a);
  }
  const art = $('np-art') as HTMLImageElement;
  const bg = $('np-bg');
  art.classList.remove('loaded');
  if (currentNp.artwork) {
    art.onload = () => art.classList.add('loaded');
    art.src = currentNp.artwork;
    art.hidden = false;
    bg.style.backgroundImage = `url("${currentNp.artwork.replace(/"/g, '%22')}")`;
    art.onerror = () => {
      art.hidden = true;
      bg.style.backgroundImage = '';
    };
  } else {
    art.hidden = true;
    bg.style.backgroundImage = '';
  }
}

/** Resolve the now-playing track against the server: library? wishlisted? */
async function resolveNpServerState(): Promise<void> {
  npState = null;
  if (!cfg || !currentNp) return;
  setNpStateLine('Checking your server…');
  try {
    const { tracks, source } = await searchTracks(cfg, `${currentNp.artist} - ${currentNp.title}`, 5);
    const hit = pickBest(tracks, currentNp);
    if (!hit || !hit.id) {
      setNpStateLine('No match on your server.');
      renderNpState();
      return;
    }
    const [inLibrary, ids] = await Promise.all([
      lookupLibraryTrackSmart(cfg, source, hit.id, hit.title, hit.artist),
      wishlistIds(),
    ]);
    npState = { hit, inLibrary, onWishlist: ids.includes(hit.id) };
  } catch {
    setNpStateLine('Could not reach your server.');
  }
  renderNpState();
}

function makeTag(text: string, cls: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `tag ${cls}`;
  el.textContent = text;
  return el;
}

function renderNpState(): void {
  const tags = $('np-tags');
  tags.innerHTML = '';
  const btn = $('np-action') as HTMLButtonElement;
  btn.onclick = null;
  $('np-help-match').hidden = true;
  $('np-wrong-match').hidden = true;
  if (!npState) {
    btn.disabled = true;
    btn.className = 'secondary block slim';
    btn.textContent = 'Wishlist';
    $('np-help-match').hidden = false;
    return;
  }
  if (npState.inLibrary === true) tags.appendChild(makeTag('IN LIBRARY', 'tag-lib'));
  else if (npState.onWishlist) tags.appendChild(makeTag('ON WISHLIST', 'tag-wl'));

  if (npState.inLibrary === true) {
    btn.disabled = true;
    btn.className = 'secondary block slim';
    btn.textContent = 'In your library ✓';
    setNpStateLine('');
  } else if (npState.onWishlist) {
    btn.disabled = false;
    btn.className = 'secondary block slim';
    btn.textContent = 'Remove from wishlist';
    btn.onclick = () => void guard(unwishlistCurrent);
    setNpStateLine('');
    $('np-wrong-match').hidden = false;
  } else {
    btn.disabled = false;
    btn.className = 'primary block slim';
    btn.textContent = 'Wishlist';
    btn.onclick = () => void guard(wishlistCurrent);
    if (npState.inLibrary === null) setNpStateLine('Library check unavailable.');
    else setNpStateLine('');
    $('np-wrong-match').hidden = false;
  }
}

/* ── help match: let the user pick the right track ── */

let matchSource = '';

function toggleMatchPanel(show?: boolean): void {
  const panel = $('np-match-panel');
  panel.hidden = show === undefined ? !panel.hidden : !show;
  if (!panel.hidden) {
    const q = $('np-match-q') as HTMLInputElement;
    if (currentNp && !q.value) q.value = `${currentNp.artist} - ${currentNp.title}`;
    q.focus();
    q.select();
  }
}

async function runMatchSearch(): Promise<void> {
  if (!cfg) return;
  const q = ($('np-match-q') as HTMLInputElement).value.trim();
  if (!q) return;
  const list = $('np-match-results');
  list.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'muted tiny';
  li.textContent = 'Searching…';
  list.appendChild(li);
  try {
    const { tracks, source } = await searchTracks(cfg, q, 10);
    matchSource = source;
    renderMatchResults(cfg, tracks);
  } catch (e) {
    list.innerHTML = '';
    const err = document.createElement('li');
    err.className = 'tiny error';
    err.textContent = e instanceof Error ? e.message : String(e);
    list.appendChild(err);
  }
}

function renderMatchResults(cfg: ServerConfig, hits: TrackHit[]): void {
  const list = $('np-match-results');
  list.innerHTML = '';
  if (hits.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted tiny';
    li.textContent = 'No results — try fewer words.';
    list.appendChild(li);
    return;
  }
  for (const hit of hits) {
    const li = document.createElement('li');
    li.className = 'match-row';
    const art = serverArtwork(cfg, hit.image);
    if (art) li.appendChild(artImg('match-art', 'match-art match-art-ph', art, directArtwork(cfg, hit.image)));
    const mid = document.createElement('div');
    mid.className = 'match-mid';
    const t = document.createElement('div');
    t.className = 'match-title';
    t.textContent = hit.title;
    const sub = document.createElement('div');
    sub.className = 'match-sub muted';
    sub.textContent = [hit.artist, hit.album].filter(Boolean).join(' · ');
    mid.append(t, sub);
    li.appendChild(mid);
    li.addEventListener('click', () => void guard(() => pickManualHit(hit)));
    list.appendChild(li);
  }
}

/** The user picked a result: adopt it as the now-playing server state. */
async function pickManualHit(hit: TrackHit): Promise<void> {
  if (!cfg) return;
  toggleMatchPanel(false);
  setNpStateLine('Checking your pick…');
  const [inLibrary, ids] = await Promise.all([
    lookupLibraryTrackSmart(cfg, matchSource, hit.id, hit.title, hit.artist),
    wishlistIds(),
  ]);
  npState = { hit, inLibrary, onWishlist: ids.includes(hit.id) };
  renderNpState();
  setStatus(`Matched "${hit.title}" — wishlist it or pick another.`);
}

async function wishlistCurrent(): Promise<void> {
  if (!cfg || !currentNp) return;
  // Prefer the resolved/manually-picked hit — no second search.
  const r =
    npState && !npState.inLibrary
      ? await wishlistTrack(cfg, npState.hit)
      : await addToWishlist(cfg, {
          artist: currentNp.artist,
          title: currentNp.title,
          album: currentNp.album,
          artwork: currentNp.artwork,
        });
  await rememberWishlisted(r.trackId);
  if (npState) {
    npState = { ...npState, onWishlist: true };
    renderNpState();
  }
  await pushHistory({
    kind: 'wishlist',
    title: r.title,
    artist: r.artist,
    artwork: currentNp.artwork,
    detail: r.created ? 'Wishlisted' : 'Already wishlisted — updated',
    at: Date.now(),
  });
  setStatus(
    r.created ? `Wishlisted "${r.title}".` : `"${r.title}" was already on your wishlist — entry updated.`,
  );
}

async function unwishlistCurrent(): Promise<void> {
  if (!cfg || !npState) return;
  const { hit } = npState;
  await removeFromWishlist(cfg, hit.id);
  await forgetWishlisted(hit.id);
  npState = { ...npState, onWishlist: false };
  renderNpState();
  await pushHistory({
    kind: 'unwishlist',
    title: hit.title,
    artist: hit.artist,
    artwork: currentNp?.artwork ?? '',
    detail: 'Removed from wishlist',
    at: Date.now(),
  });
  setStatus(`Removed "${hit.title}" from your wishlist.`);
}

/* ── release pages ── */

function isReleasePage(url: string | undefined): boolean {
  return !!url && /(^|\.)bandcamp\.com|(^|\.)beatport\.com/.test(url);
}

async function loadRelease(): Promise<void> {
  const tab = await activeTab();
  if (!isReleasePage(tab?.url)) return;
  const res = await askTab<{ release: ReleaseInfo | null }>(tab?.id, 'SOULSYNC_GET_RELEASE');
  currentRelease = res?.release ?? null;
  if (!currentRelease) return;
  $('release-card').hidden = false;
  $('rel-title').textContent = `${currentRelease.artist} — ${currentRelease.title}`;
  $('rel-sub').textContent = [currentRelease.source, currentRelease.label, `${currentRelease.tracks.length} tracks`]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' · ');
}

/* ── server dashboard extras: stats, scans, recently added ── */

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function renderStats(stats: ServerStats, wishlistCount: number): void {
  const el = $('server-stats');
  el.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  const cell = (value: string, label: string): HTMLDivElement => {
    const c = document.createElement('div');
    c.className = 'stat-cell';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = value;
    const l = document.createElement('div');
    l.className = 'l';
    l.textContent = label;
    c.append(n, l);
    return c;
  };
  grid.append(
    cell(fmtNum(stats.tracks), 'tracks'),
    cell(fmtNum(stats.artists), 'artists'),
    cell(fmtNum(stats.albums), 'albums'),
    cell(fmtNum(wishlistCount), 'on wishlist'),
  );
  el.appendChild(grid);

  const pill = $('dl-pill');
  pill.hidden = false;
  if (stats.activeDownloads > 0) {
    pill.classList.add('dl-active');
    pill.textContent = `↓ ${stats.activeDownloads} downloading`;
  } else {
    pill.classList.remove('dl-active');
    pill.textContent = 'idle';
  }
  const lu = $('server-last-update');
  if (stats.lastUpdate) {
    const at = new Date(stats.lastUpdate).getTime();
    lu.textContent = Number.isFinite(at) ? `updated ${relativeTime(at)}` : '';
  } else {
    lu.textContent = '';
  }
}

function renderRail(cfg: ServerConfig, albums: RecentAlbum[]): void {
  const rail = $('recent-rail');
  rail.innerHTML = '';
  if (albums.length === 0) {
    const d = document.createElement('div');
    d.className = 'muted tiny';
    d.textContent = 'Nothing added yet.';
    rail.appendChild(d);
    return;
  }
  for (const a of albums) {
    const item = document.createElement('div');
    item.className = 'rail-item';
    const art = serverArtwork(cfg, a.thumb);
    item.appendChild(
      art
        ? artImg('rail-art', 'rail-art rail-art-ph', art, directArtwork(cfg, a.thumb))
        : (() => { const ph = document.createElement('div'); ph.className = 'rail-art rail-art-ph'; ph.title = 'no artwork url from server'; return ph; })(),
    );
    const t = document.createElement('div');
    t.className = 'rail-title';
    t.textContent = a.title;
    t.title = a.title;
    const sub = document.createElement('div');
    sub.className = 'rail-sub muted';
    const at = a.addedAt ? new Date(a.addedAt).getTime() : NaN;
    sub.textContent = [a.year ? String(a.year) : '', Number.isFinite(at) ? relativeTime(at) : '']
      .filter(Boolean)
      .join(' · ');
    item.append(t, sub);
    rail.appendChild(item);
  }
}

/** Shimmer placeholders shown in the server card while it loads. */
function renderServerSkeleton(): void {
  const stats = $('server-stats');
  stats.innerHTML = '<div class="skel-stats"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
  const rail = $('recent-rail');
  rail.innerHTML = '<div class="skel-rail"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
}

/**
 * Load the server card. The card appears immediately with a skeleton shimmer
 * and fills in when the data lands; on failure it hides again.
 */
async function loadServerExtras(): Promise<void> {
  if (!cfg) return;
  $('server-card').hidden = false;
  renderServerSkeleton();
  try {
    const [stats, albums, wishlistCount] = await Promise.all([
      getServerStats(cfg),
      getRecentlyAdded(cfg, 12),
      getWishlistCount(cfg),
    ]);
    renderStats(stats, wishlistCount);
    renderRail(cfg, albums);
  } catch {
    $('server-card').hidden = true;
  }
}

/* ── tabs ── */

const LAST_TAB_KEY = 'soulsync_last_tab';
type TabName = 'nowplaying' | 'search' | 'activity' | 'chat';

let serverActivity: { setActive: (active: boolean) => void } | null = null;
let chatTab: ChatTab | null = null;

function selectTab(name: TabName): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#tabs .tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('.tab-panel')) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
  void browser.storage.local.set({ [LAST_TAB_KEY]: name });
  serverActivity?.setActive(name === 'activity');
  chatTab?.setActive(name === 'chat');
  document.body.classList.toggle('tab-chat-active', name === 'chat');
  if (name === 'search') {
    const q = $('manual-q') as HTMLInputElement;
    // Focus without scrolling the popup under the user's fingers.
    q.focus({ preventScroll: true });
  }
}

/* ── manual search ── */

let manualReqId = 0;
let manualHits: TrackHit[] = [];
let manualSource = '';
let manualSel = -1;
let manualDebounce: number | undefined;

interface ManualRow {
  hit: TrackHit;
  inLibrary: boolean | null;
  onWishlist: boolean;
  li: HTMLLIElement;
  btn: HTMLButtonElement;
}

function paintManualRow(row: ManualRow): void {
  const { btn } = row;
  if (row.inLibrary === true) {
    btn.disabled = true;
    btn.className = 'secondary manual-btn';
    btn.textContent = 'In library ✓';
    btn.onclick = null;
  } else if (row.onWishlist) {
    btn.disabled = false;
    btn.className = 'secondary manual-btn';
    btn.textContent = 'Remove';
    btn.onclick = () => void guard(() => manualUnwishlist(row));
  } else {
    btn.disabled = false;
    btn.className = 'primary manual-btn';
    btn.textContent = 'Wishlist';
    btn.onclick = () => void guard(() => manualWishlist(row));
  }
}

async function manualWishlist(row: ManualRow): Promise<void> {
  if (!cfg) return;
  const r = await wishlistTrack(cfg, row.hit);
  await rememberWishlisted(r.trackId);
  row.onWishlist = true;
  paintManualRow(row);
  await pushHistory({
    kind: 'wishlist',
    title: r.title,
    artist: r.artist,
    artwork: row.hit.image,
    detail: r.created ? 'Wishlisted' : 'Already wishlisted — updated',
    at: Date.now(),
  });
  setStatus(`Wishlisted "${r.title}".`);
}

async function manualUnwishlist(row: ManualRow): Promise<void> {
  if (!cfg) return;
  await removeFromWishlist(cfg, row.hit.id);
  await forgetWishlisted(row.hit.id);
  row.onWishlist = false;
  paintManualRow(row);
  await pushHistory({
    kind: 'unwishlist',
    title: row.hit.title,
    artist: row.hit.artist,
    artwork: row.hit.image,
    detail: 'Removed from wishlist',
    at: Date.now(),
  });
  setStatus(`Removed "${row.hit.title}" from your wishlist.`);
}

function setManualSel(idx: number): void {
  const rows = [...document.querySelectorAll<HTMLLIElement>('#manual-results .manual-row')];
  manualSel = idx;
  rows.forEach((li, i) => li.classList.toggle('kb-focus', i === idx));
  rows[idx]?.scrollIntoView({ block: 'nearest' });
}

async function renderManualResults(tracks: TrackHit[]): Promise<void> {
  if (!cfg) return;
  const reqId = manualReqId;
  const list = $('manual-results');
  list.innerHTML = '';
  const wlIds = await wishlistIds();
  if (reqId !== manualReqId) return;
  for (const hit of tracks) {
    const li = document.createElement('li');
    li.className = 'manual-row match-row';
    const art = serverArtwork(cfg, hit.image);
    if (art) li.appendChild(artImg('match-art', 'match-art match-art-ph', art, directArtwork(cfg, hit.image)));
    const mid = document.createElement('div');
    mid.className = 'manual-mid match-mid';
    const t = document.createElement('div');
    t.className = 'match-title';
    t.textContent = hit.title;
    t.title = hit.title;
    const sub = document.createElement('div');
    sub.className = 'match-sub muted';
    sub.textContent = [hit.artist, hit.album].filter(Boolean).join(' · ');
    sub.title = sub.textContent;
    mid.append(t, sub);
    li.appendChild(mid);
    const btn = document.createElement('button');
    li.appendChild(btn);
    const row: ManualRow = { hit, inLibrary: null, onWishlist: wlIds.includes(hit.id), li, btn };
    paintManualRow(row);
    list.appendChild(li);
    // Library state resolves progressively — the row is usable immediately.
    // Smart check: the same song on a different release (single vs album)
    // still counts as in-library, so we never offer to wishlist a duplicate.
    void (async () => {
      try {
        row.inLibrary = await lookupLibraryTrackSmart(cfg!, manualSource, hit.id, hit.title, hit.artist);
      } catch {
        row.inLibrary = null;
      }
      if (reqId === manualReqId && li.isConnected) paintManualRow(row);
    })();
  }
}

async function runManualSearch(): Promise<void> {
  if (!cfg) return;
  const q = ($('manual-q') as HTMLInputElement).value.trim();
  const list = $('manual-results');
  const state = $('manual-state');
  if (q.length < 2) {
    manualReqId++;
    manualHits = [];
    setManualSel(-1);
    list.innerHTML = '';
    state.textContent = q.length === 0 ? 'Search across your metadata sources.' : 'Keep typing…';
    return;
  }
  const reqId = ++manualReqId;
  state.textContent = 'Searching…';
  try {
    const { tracks, source } = await searchTracks(cfg, q, 10);
    if (reqId !== manualReqId) return;
    manualSource = source;
    manualHits = tracks;
    setManualSel(-1);
    if (tracks.length === 0) {
      list.innerHTML = '';
      state.textContent = 'No results — try fewer words.';
      return;
    }
    await renderManualResults(tracks);
    if (reqId !== manualReqId) return;
    state.textContent = `${tracks.length} result${tracks.length === 1 ? '' : 's'}${source ? ` via ${source}` : ''} — ↑↓ to move, Enter to wishlist.`;
  } catch (e) {
    if (reqId !== manualReqId) return;
    list.innerHTML = '';
    state.textContent = '';
    const li = document.createElement('li');
    li.className = 'tiny error';
    li.textContent = e instanceof Error ? e.message : String(e);
    list.appendChild(li);
  }
}

function scheduleManualSearch(): void {
  window.clearTimeout(manualDebounce);
  manualDebounce = window.setTimeout(() => void guard(runManualSearch), 350);
}

/* ── text import ── */

/** Text stashed by the context-menu click in the service worker. */
async function loadPendingSelection(): Promise<void> {
  const stored = (await browser.storage.session.get('pendingSelection')) as {
    pendingSelection?: string;
  };
  if (typeof stored.pendingSelection === 'string' && stored.pendingSelection.length > 0) {
    ($('import-text') as HTMLTextAreaElement).value = stored.pendingSelection;
    await browser.storage.session.remove('pendingSelection');
    runParse();
    // The text came from the context menu — take the user straight to it.
    selectTab('search');
  }
}

function runParse(): void {
  const text = ($('import-text') as HTMLTextAreaElement).value;
  parsed = parseSelection(text);
  const list = $('import-list');
  list.innerHTML = '';
  parsed.forEach((t, i) => {
    const li = document.createElement('li');
    if (!t.ok) li.className = 'bad';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.ok;
    cb.dataset.index = String(i);
    const label = document.createElement('span');
    label.textContent = t.ok ? `${t.artist} — ${t.title}` : `⚠ ${t.raw}`;
    li.append(cb, label);
    list.appendChild(li);
  });
  $('import-send').hidden = parsed.length === 0;
  const bad = parsed.filter((t) => !t.ok).length;
  if (bad > 0) setStatus(`${bad} line${bad === 1 ? '' : 's'} didn't parse — uncheck or fix them.`, true);
  else if (parsed.length > 0) setStatus(`${parsed.length} track${parsed.length === 1 ? '' : 's'} ready.`);
}

function selectedTracks(): ParsedTrack[] {
  return [...document.querySelectorAll<HTMLInputElement>('#import-list input[type="checkbox"]')]
    .filter((b) => b.checked)
    .map((b) => parsed[Number(b.dataset.index)])
    .filter((t): t is ParsedTrack => !!t);
}

/** Run an action, surfacing errors in the status line instead of throwing. */
async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  }
}

function init(): void {
  serverActivity = initServerActivity({ getCfg: () => cfg, setStatus });
  chatTab = new ChatTab();
  chatTab.mount(document.getElementById('tab-chat') as HTMLElement);
  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    void browser.runtime.openOptionsPage();
  });
  $('open-server').addEventListener('click', (e) => {
    e.preventDefault();
    if (cfg) void browser.tabs.create({ url: cfg.url });
  });
  $('go-setup').addEventListener('click', () => void browser.runtime.openOptionsPage());
  $('history-clear').addEventListener('click', () =>
    guard(async () => {
      await browser.storage.local.remove(HISTORY_KEY);
      renderHistory([]);
    }),
  );

  for (const btn of document.querySelectorAll<HTMLButtonElement>('#tabs .tab-btn')) {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab as TabName));
  }

  const mq = $('manual-q') as HTMLInputElement;
  mq.addEventListener('input', scheduleManualSearch);
  mq.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      window.clearTimeout(manualDebounce);
      if (manualSel >= 0 && manualSel < manualHits.length) {
        const btn = document.querySelectorAll<HTMLLIElement>('#manual-results .manual-row')[manualSel]
          ?.querySelector<HTMLButtonElement>('.manual-btn');
        // Don't "wishlist" a row that's already in the library.
        if (btn && !btn.disabled) btn.click();
      } else {
        void guard(runManualSearch);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (manualHits.length > 0) setManualSel(Math.min(manualSel + 1, manualHits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (manualHits.length > 0) setManualSel(Math.max(manualSel - 1, 0));
    } else if (e.key === 'Escape') {
      mq.value = '';
      void guard(runManualSearch);
      mq.blur();
    }
  });

  // The now-playing action button is state-aware; its handler is assigned by
  // renderNpState() (wishlist / remove-from-wishlist / disabled in-library).
  $('np-help-match').addEventListener('click', () => toggleMatchPanel());
  $('np-wrong-match').addEventListener('click', () => toggleMatchPanel(true));
  $('np-match-search').addEventListener('click', () => void guard(runMatchSearch));
  $('np-match-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void guard(runMatchSearch);
    }
  });
  $('scan-open').addEventListener('click', (e) => {
    // The API-key API has no scan trigger — scans live on the web UI, so this
    // deep-links to the dashboard where the library scan controls are.
    e.preventDefault();
    if (cfg) void browser.tabs.create({ url: `${cfg.url}/dashboard` });
  });
  $('rel-send').addEventListener('click', () =>
    guard(async () => {
      if (!cfg || !currentRelease) return;
      const n = await wishlistRelease(cfg, currentRelease);
      await pushHistory({
        kind: 'release',
        title: currentRelease.title,
        artist: currentRelease.artist,
        artwork: '',
        detail: `${n} track${n === 1 ? '' : 's'} → wishlist`,
        at: Date.now(),
      });
      setStatus(`Sent ${n} track${n === 1 ? '' : 's'} from "${currentRelease.title}" to your wishlist.`);
    }),
  );

  $('import-parse').addEventListener('click', runParse);
  $('import-dest').addEventListener('change', (e) => {
    $('import-playlist-name').hidden = (e.target as HTMLSelectElement).value !== 'playlist';
  });
  $('import-send').addEventListener('click', () =>
    guard(async () => {
      if (!cfg) return;
      const tracks = selectedTracks();
      if (tracks.length === 0) {
        setStatus('Nothing checked.', true);
        return;
      }
      if (($('import-dest') as HTMLSelectElement).value === 'playlist') {
        const name =
          ($('import-playlist-name') as HTMLInputElement).value.trim() || 'SoulSync Companion import';
        await importToPlaylist(cfg, name, tracks.map((t) => ({ artist: t.artist, title: t.title })));
        await pushHistory({
          kind: 'playlist',
          title: name,
          artist: `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
          artwork: '',
          detail: 'Playlist sync started',
          at: Date.now(),
        });
        setStatus(`Playlist sync started for "${name}".`);
        return;
      }
      for (const t of tracks) {
        const r = await addToWishlist(cfg, { artist: t.artist, title: t.title });
        await rememberWishlisted(r.trackId);
      }
      await pushHistory({
        kind: 'wishlist',
        title: tracks.length === 1 ? tracks[0].title : `${tracks.length} tracks`,
        artist: tracks.length === 1 ? tracks[0].artist : 'Text import',
        artwork: '',
        detail: 'Wishlisted',
        at: Date.now(),
      });
      setStatus(`Wishlisted ${tracks.length} track${tracks.length === 1 ? '' : 's'}.`);
    }),
  );
}

/** Page-badges master switch in the header. Persisted in storage.local
 *  (default ON); content scripts watch the key via storage.onChanged and
 *  tear badges down / remount them immediately — no reload needed. */
async function initBadgeToggle(): Promise<void> {
  const el = document.getElementById('badge-toggle') as HTMLInputElement | null;
  if (!el) return;
  try {
    el.checked = badgesEnabledFromStored(await browser.storage.local.get(BADGES_ENABLED_KEY));
  } catch {
    el.checked = true;
  }
  el.addEventListener('change', () => {
    void browser.storage.local.set({ [BADGES_ENABLED_KEY]: el.checked }).catch(() => undefined);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void initBadgeToggle();
  init();  void (async () => {
    renderHistory(await loadHistory());
    cfg = await getConfig();
    if (!cfg) {
      $('setup-needed').hidden = false;
      return;
    }
    $('main').hidden = false;
    $('conn-dot').classList.add('ok');
    const storedTab = (await browser.storage.local.get(LAST_TAB_KEY)) as Record<string, unknown>;
    const lastTab = storedTab[LAST_TAB_KEY];
    if (lastTab === 'search' || lastTab === 'activity' || lastTab === 'nowplaying' || lastTab === 'chat') {
      selectTab(lastTab);
    }
    // selectTab only fires when restoring a stored tab — arm the pollers
    // for whichever tab is actually visible.
    const visibleTab = document.querySelector<HTMLButtonElement>('#tabs .tab-btn.active');
    serverActivity?.setActive(visibleTab?.dataset.tab === 'activity');
    chatTab?.setActive(visibleTab?.dataset.tab === 'chat');
    document.body.classList.toggle('tab-chat-active', visibleTab?.dataset.tab === 'chat');
    // Server extras load in the background — they never block now playing.
    void loadServerExtras();
    await guard(async () => {
      await loadNowPlaying();
      await resolveNpServerState();
      await Promise.all([loadRelease(), loadPendingSelection()]);
    });
  })();
});
