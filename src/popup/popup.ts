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
  getRecentlyAddedVideos,
  getVideoStats,
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
  type RecentVideo,
  type VideoStats,
  type ServerStats,
  type TrackHit,
} from '../shared/api.js';

import { sendToPlayer } from '../player/messaging.js';
import { enrichQueueArtwork } from '../player/artwork-enrich.js';
import { lookupCoverArt } from '../shared/artwork.js';
import { openMiniPlayerPanel, openMiniPlayerWindow } from '../player/mini-window.js';
import {
  emptySnapshot,
  type PlayerMessage,
  type PlayerSnapshot,
  type QueueEntry,
} from '../player/types.js';
import {
  getAlbumTracks,
  getArtistAlbums,
  isUnplayableAudio,
  searchLibraryAlbums,
  searchLibraryArtists,
  searchLibraryTracks as searchPlayerLibrary,
  toQueueEntry,
  type LibraryAlbum,
  type LibraryArtist,
  type LibraryTrack,
} from '../shared/player-api.js';

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
  // Cached images may never fire onload — paint immediately when the
  // pixels are already there (same fix as the mini player's artwork).
  if (img.complete && img.naturalWidth > 0) img.classList.add('loaded');
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

function renderStats(stats: ServerStats, wishlistCount: number, video: VideoStats | null): void {
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
  const musicLabel = document.createElement('div');
  musicLabel.className = 'section-label stats-group-label';
  musicLabel.textContent = 'Music';
  el.appendChild(musicLabel);
  grid.append(
    cell(fmtNum(stats.tracks), 'tracks'),
    cell(fmtNum(stats.artists), 'artists'),
    cell(fmtNum(stats.albums), 'albums'),
    cell(fmtNum(wishlistCount), 'wishlist'),
  );
  el.appendChild(grid);

  if (video && (video.movies > 0 || video.shows > 0)) {
    const videoLabel = document.createElement('div');
    videoLabel.className = 'section-label stats-group-label';
    videoLabel.textContent = 'Video';
    el.appendChild(videoLabel);
    const vgrid = document.createElement('div');
    vgrid.className = 'stats-grid stats-video';
    const vCells: HTMLElement[] = [
      cell(fmtNum(video.movies), 'movies'),
      cell(fmtNum(video.shows), 'tv shows'),
      cell(fmtNum(video.episodes), 'episodes'),
      cell(fmtNum(video.wishlist), 'wishlist'),
    ];
    // Episodes hides when the server predates the total_episodes field.
    if (video.episodes === 0) vCells[2].style.display = 'none';
    vgrid.append(...vCells);
    el.appendChild(vgrid);
  }

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

function renderVideoRail(cfg: ServerConfig, videos: RecentVideo[]): void {
  const rail = $('recent-video-rail');
  rail.innerHTML = '';
  if (videos.length === 0) {
    const d = document.createElement('div');
    d.className = 'muted tiny';
    d.textContent = 'Nothing added yet.';
    rail.appendChild(d);
    return;
  }
  for (const v of videos) {
    const item = document.createElement('div');
    item.className = 'rail-item';
    // TMDB CDN URLs are public — load directly. Anything else goes through
    // the server artwork pipeline (proxy + API key).
    const thumb = v.thumb.trim();
    const isTmdbCdn = /^https?:\/\/image\.tmdb\.org\//i.test(thumb);
    const art = isTmdbCdn ? thumb : serverArtwork(cfg, thumb);
    item.appendChild(
      art
        ? artImg('rail-art', 'rail-art rail-art-ph', art, isTmdbCdn ? thumb : directArtwork(cfg, thumb))
        : (() => { const ph = document.createElement('div'); ph.className = 'rail-art rail-art-ph'; ph.title = 'no artwork url from server'; return ph; })(),
    );
    const t = document.createElement('div');
    t.className = 'rail-title';
    t.textContent = v.title;
    t.title = v.title;
    const sub = document.createElement('div');
    sub.className = 'rail-sub muted';
    const at = v.addedAt ? new Date(v.addedAt).getTime() : NaN;
    sub.textContent = [v.kind === 'show' ? 'TV' : 'Movie', v.year ? String(v.year) : '', Number.isFinite(at) ? relativeTime(at) : '']
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
  const vrail = $('recent-video-rail');
  vrail.innerHTML = '<div class="skel-rail"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
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
    const [stats, albums, videos, wishlistCount, videoStats] = await Promise.all([
      getServerStats(cfg),
      getRecentlyAdded(cfg, 12),
      getRecentlyAddedVideos(cfg, 12),
      getWishlistCount(cfg),
      getVideoStats(cfg),
    ]);
    renderStats(stats, wishlistCount, videoStats);
    renderRail(cfg, albums);
    renderVideoRail(cfg, videos);
  } catch {
    $('server-card').hidden = true;
  }
}

/* ── tabs ── */

const LAST_TAB_KEY = 'soulsync_last_tab';
type TabName = 'nowplaying' | 'search' | 'media' | 'activity' | 'chat';

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
  // Widen the popup for chat. Set via class (CSS) and force a reflow so
  // Chrome's popup resize detection picks up the new width reliably.
  document.body.classList.toggle('tab-chat-active', name === 'chat');
  void document.body.offsetWidth;
  if (name === 'media') {
    void refreshPlayer();
    mediaBoot();
  }
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

/* ── player remote (Live tab) ──
 *
 * UI is a remote only: every control sends a message to the background
 * player host via sendToPlayer() and re-renders from the returned
 * snapshot. The host is the source of truth; the popup never touches
 * a media element. */

/** Key the player-tab workstream reads for "open in player tab". Contract — do not rename. */
const PENDING_VIDEO_ENTRY_KEY = 'pendingVideoEntry';

let playerPollTimer: number | undefined;
let playerScrubbing = false;
/** While the volume thumb is being dragged the 1s poll must not yank it. */
let playerVolumeScrubbing = false;
/** Signature of the queue portion of the last full render, so the 1s poll
 *  can skip rebuilding queue rows while the user is about to click one. */
let playerQueueSig = '';

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Send a player message and re-render from the snapshot, quietly on failure. */
async function playerAction(message: PlayerMessage): Promise<void> {
  await guard(async () => {
    renderPlayer(await sendToPlayer(message));
  });
}

function currentEntryOf(snap: PlayerSnapshot): QueueEntry | null {
  return snap.index >= 0 && snap.index < snap.queue.length ? snap.queue[snap.index] : null;
}

/** Cheap parts of the render: artwork, transport, seek, volume, error. */
function paintPlayerTransport(snap: PlayerSnapshot): void {
  const cur = currentEntryOf(snap);
  // Self-healing artwork: if the click-time lookup never resolved (popup
  // reloaded, transient failure), retry here until the host reports a URL.
  if (cur) enrichQueueArtwork(cur);
  // The Media tab button shows a playing dot so the user can see at a
  // glance that something is playing there.
  const mediaTab = document.querySelector('[data-tab="media"]');
  if (mediaTab) mediaTab.classList.toggle('tab-playing', snap.status === 'playing');
  const art = $('pr-art') as HTMLImageElement;
  const url = cur?.artworkUrl;
  if (url) {
    if (art.getAttribute('src') !== url) {
      // New artwork fades in over the quiet tile; a failed load leaves the
      // tile (the img stays at opacity 0). The src is kept so the 1s poll
      // doesn't retry a dead URL — a new track still triggers a fresh try.
      art.classList.remove('loaded');
      art.onload = () => art.classList.add('loaded');
      art.onerror = () => art.classList.remove('loaded');
      art.setAttribute('src', url);
      // Cached images may never fire onload — paint immediately when the
      // pixels are already there.
      if (art.complete && art.naturalWidth > 0) art.classList.add('loaded');
    }
  } else if (art.getAttribute('src')) {
    art.classList.remove('loaded');
    art.removeAttribute('src');
  }
  $('pr-title').textContent = cur?.title ?? 'Nothing queued';
  $('pr-sub').textContent = cur?.subtitle ?? '';
  const stateText =
    snap.status === 'loading' ? 'Loading…' :
    snap.status === 'playing' ? 'Playing' :
    snap.status === 'paused' ? 'Paused' : '';
  $('pr-state').textContent = stateText;

  const toggle = $('pr-toggle') as HTMLButtonElement;
  toggle.innerHTML = snap.status === 'playing' ? '&#10074;&#10074;' : '&#9654;';
  toggle.title = snap.status === 'playing' ? 'Pause' : 'Play';

  const seek = $('pr-seek') as HTMLInputElement;
  const dur = Math.max(0, Math.floor(snap.durationSec || 0));
  const pos = Math.max(0, Math.floor(snap.positionSec));
  seek.max = String(Math.max(dur, 1));
  if (!playerScrubbing) seek.value = String(pos);
  const shownPos = playerScrubbing ? Number(seek.value) : pos;
  $('pr-pos').textContent = fmtTime(shownPos);
  $('pr-dur').textContent = fmtTime(dur);
  seek.style.setProperty('--fill', `${dur > 0 ? Math.min(100, (shownPos / dur) * 100) : 0}%`);

  const vol = $('pr-vol') as HTMLInputElement;
  const volPct = Math.round((snap.volume ?? 1) * 100);
  if (!playerVolumeScrubbing) {
    vol.value = String(volPct);
    vol.style.setProperty('--fill', `${volPct}%`);
  }

  const errEl = $('pr-error');
  if (snap.status === 'error') {
    errEl.textContent = snap.error || 'Playback failed.';
    errEl.hidden = false;
  } else {
    errEl.hidden = true;
  }
}

function playerQueueRow(entry: QueueEntry, index: number, isCurrent: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'pr-row' + (isCurrent ? ' pr-row-current' : '');
  const mid = document.createElement('div');
  mid.className = 'pr-row-mid';
  mid.title = entry.kind === 'video' ? 'Play in player tab' : 'Play this';
  // Keyboard users get the same action: the row is a focusable button.
  mid.tabIndex = 0;
  mid.setAttribute('role', 'button');
  mid.setAttribute('aria-label', mid.title);
  const activate = () => {
    // Same gesture rule as the media play button: open the panel
    // synchronously with the click that starts playback.
    if (entry.kind === 'audio') {
      const panelError = (msg: string): void =>
        setStatus(`Mini panel didn't open: ${msg}`, true);
      if (!openMiniPlayerPanel(panelError)) void guard(() => openMiniPlayerWindow());
    }
    void playerAction({ type: 'player:setIndex', index });
  };
  mid.addEventListener('click', activate);
  mid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  });
  const t = document.createElement('div');
  t.className = 'pr-row-title';
  t.textContent = entry.title;
  mid.appendChild(t);
  if (entry.subtitle) {
    const s = document.createElement('div');
    s.className = 'pr-row-sub muted';
    s.textContent = entry.subtitle;
    mid.appendChild(s);
  }
  li.appendChild(mid);
  if (entry.kind === 'video') {
    const open = document.createElement('button');
    open.className = 'ghost pr-mini';
    open.textContent = 'Open in player tab';
    open.title = 'Open this video in the player tab';
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      void guard(async () => {
        await browser.storage.session.set({ [PENDING_VIDEO_ENTRY_KEY]: entry });
        await browser.tabs.create({ url: browser.runtime.getURL('player-tab/player.html') });
      });
    });
    li.appendChild(open);
  }
  const del = document.createElement('button');
  del.className = 'ghost pr-mini';
  del.textContent = '✕';
  del.title = 'Remove from queue';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    void playerAction({ type: 'player:removeAt', index });
  });
  li.appendChild(del);
  return li;
}

function playerQueueSignature(snap: PlayerSnapshot): string {
  return `${snap.status}|${snap.index}|${snap.queue.length}|${snap.queue.map((e) => e.title).join('\n')}`;
}

/** Full render: transport + queue list + empty state. */
function renderPlayer(snap: PlayerSnapshot): void {
  paintPlayerTransport(snap);
  playerQueueSig = playerQueueSignature(snap);
  $('pr-empty').hidden = snap.queue.length > 0;
  const ul = $('pr-queue');
  ul.innerHTML = '';
  snap.queue.forEach((entry, i) => {
    ul.appendChild(playerQueueRow(entry, i, i === snap.index));
  });
  ($('pr-clear') as HTMLButtonElement).disabled = snap.queue.length === 0;
  ($('pr-shuffle') as HTMLButtonElement).disabled = snap.queue.length < 2;
}

/** 1s-poll path: full re-render only when the queue changed; otherwise the
 *  cheap transport repaint so a user about to click a queue row never has
 *  the row rebuilt under them. */
function renderPlayerPoll(snap: PlayerSnapshot): void {
  if (playerQueueSignature(snap) !== playerQueueSig) {
    renderPlayer(snap);
  } else {
    paintPlayerTransport(snap);
  }
}

function setPlayerControlsEnabled(on: boolean): void {
  for (const id of ['pr-prev', 'pr-toggle', 'pr-next', 'pr-clear', 'pr-shuffle']) {
    (document.getElementById(id) as HTMLButtonElement).disabled = !on;
  }
  for (const id of ['pr-seek', 'pr-vol']) {
    (document.getElementById(id) as HTMLInputElement).disabled = !on;
  }
}

/** Fetch state from the host and render; with no server configured show the
 *  quiet hint, disable controls, and never throw. */
async function refreshPlayer(): Promise<void> {
  const on = !!cfg;
  $('pr-hint').hidden = on;
  setPlayerControlsEnabled(on);
  if (!on) {
    renderPlayer(emptySnapshot());
    return;
  }
  await guard(async () => {
    renderPlayer(await sendToPlayer({ type: 'player:getState' }));
  });
}

function startPlayerPoll(): void {
  stopPlayerPoll();
  let inFlight = false;
  playerPollTimer = window.setInterval(() => {
    if (!cfg || inFlight) return;
    inFlight = true;
    sendToPlayer({ type: 'player:getState' })
      .then(renderPlayerPoll)
      .catch(() => {
        /* stay on the last known state — never toast from the poll loop */
      })
      .finally(() => {
        inFlight = false;
      });
  }, 1000);
}

function stopPlayerPoll(): void {
  if (playerPollTimer !== undefined) {
    window.clearInterval(playerPollTimer);
    playerPollTimer = undefined;
  }
}

/* ── media tab: library search + playback only ──
 *
 * Distinct from the Search tab (metadata sources for wishlisting): this is
 * the user's OWN library, playback only. No wishlist buttons, no download
 * buttons, no status pills. Video opens in the player tab, which checks
 * /watch/playable itself before playback. */

let mediaReqId = 0;

/** No-config → the quiet hint and disabled controls; configured → hide it. */
function mediaBoot(): void {
  $('media-no-config').hidden = !!cfg;
  const on = !!cfg;
  ($('media-q') as HTMLInputElement).disabled = !on;
  ($('media-go') as HTMLButtonElement).disabled = !on;
}

/** Artwork for a media row, or a gradient placeholder when the server has none. */
function mediaArt(artworkUrl: string | undefined): HTMLElement {
  if (artworkUrl) return artImg('media-art', 'media-art media-art-ph', artworkUrl, artworkUrl);
  const ph = document.createElement('div');
  ph.className = 'media-art media-art-ph';
  ph.title = 'no artwork from server';
  return ph;
}

function mediaRowBase(
  title: string,
  subtitle: string,
  art: HTMLElement,
): { li: HTMLLIElement; actions: HTMLElement } {
  const li = document.createElement('li');
  li.className = 'media-row';
  li.appendChild(art);
  const mid = document.createElement('div');
  mid.className = 'media-mid';
  const t = document.createElement('div');
  t.className = 'media-title';
  t.textContent = title;
  t.title = title;
  mid.appendChild(t);
  if (subtitle) {
    const s = document.createElement('div');
    s.className = 'media-sub';
    s.textContent = subtitle;
    s.title = subtitle;
    mid.appendChild(s);
  }
  li.appendChild(mid);
  const actions = document.createElement('div');
  actions.className = 'media-actions';
  li.appendChild(actions);
  return { li, actions };
}

function mediaMiniButton(text: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'ghost pr-mini';
  b.textContent = text;
  b.title = title;
  return b;
}

function mediaMusicRow(t: LibraryTrack): HTMLLIElement {
  const { li, actions } = mediaRowBase(
    t.title,
    [t.artist, t.album].filter(Boolean).join(' · '),
    mediaArt(t.artworkUrl ?? undefined),
  );
  if (isUnplayableAudio(t.filePath)) {
    const note = document.createElement('span');
    note.className = 'muted tiny';
    note.textContent = 'WMA — browsers can’t play';
    actions.appendChild(note);
  } else {
    const play = mediaMiniButton('▶', 'Play now');
    play.addEventListener('click', () => {
      // Bring up the mini player panel with the same click: the browser
      // only opens panels on a direct user gesture, so this must run
      // synchronously here — a background auto-open is rejected.
      // A rejected open reports its reason in the status line so a
      // silent failure can actually be diagnosed.
      const panelError = (msg: string): void =>
        setStatus(`Mini panel didn't open: ${msg}`, true);
      if (!openMiniPlayerPanel(panelError)) void guard(() => openMiniPlayerWindow());
      const entry = toQueueEntry(t);
      // Playback starts immediately; the cover fills in behind it.
      enrichQueueArtwork(entry);
      void playerAction({ type: 'player:playNow', entry });
    });
    actions.appendChild(play);
  }
  const add = mediaMiniButton('＋', 'Add to queue');
  add.addEventListener('click', () => {
    const entry = toQueueEntry(t);
    enrichQueueArtwork(entry);
    void playerAction({ type: 'player:queueLast', entry });
  });
  actions.appendChild(add);
  // The server never serializes track artwork — fill the row's cover in
  // from Deezer behind it (the same fix the Live tab's transport got).
  // Cached for 30 days, so a repeat search costs nothing.
  if (!t.artworkUrl) {
    const slot = li.querySelector(':scope > .media-art-ph');
    if (slot) {
      void lookupCoverArt(t.artist, t.title).then((url) => {
        if (!url || !slot.isConnected) return;
        slot.replaceWith(artImg('media-art', 'media-art media-art-ph', url, url));
      });
    }
  }
  return li;
}

/**
 * Artist row: plays artist radio (shuffle the artist's library tracks).
 * Uses the artistId from the track search — the name-based artist lookup
 * is unreliable, so we resolve via the track's artist_id.
 */
function mediaArtistRow(name: string, artistId: number | null, trackCount: number): HTMLLIElement {
  const { li, actions } = mediaRowBase(
    name,
    `${trackCount} track${trackCount === 1 ? '' : 's'} in library`,
    mediaArt(undefined),
  );
  const play = mediaMiniButton('▶', 'Play artist radio');
  play.addEventListener('click', () => {
    if (!openMiniPlayerPanel()) void guard(() => openMiniPlayerWindow());
    void playArtistRadioById(name, artistId);
  });
  actions.appendChild(play);
  return li;
}

/** Album row: plays the album (first track now, rest queued). */
function mediaAlbumRow(album: LibraryAlbum): HTMLLIElement {
  const { li, actions } = mediaRowBase(
    album.title,
    [album.artist ?? '', album.year ? String(album.year) : ''].filter(Boolean).join(' · '),
    mediaArt(album.thumbUrl ?? undefined),
  );
  const play = mediaMiniButton('▶', 'Play album');
  play.addEventListener('click', () => {
    if (!openMiniPlayerPanel()) void guard(() => openMiniPlayerWindow());
    void playAlbumById(album.id);
  });
  actions.appendChild(play);
  // If the server has no thumb, fill it in from Deezer behind the row.
  if (!album.thumbUrl) {
    const slot = li.querySelector(':scope > .media-art-ph');
    if (slot) {
      void lookupCoverArt(album.artist || '', album.title).then((url) => {
        if (!url || !slot.isConnected) return;
        slot.replaceWith(artImg('media-art', 'media-art media-art-ph', url, url));
      });
    }
  }
  return li;
}

/** Play artist radio by ID: shuffle the artist's library tracks. */
async function playArtistRadioById(name: string, artistId: number | null): Promise<void> {
  if (!cfg || !artistId) return;
  try {
    const albums = await getArtistAlbums(cfg, artistId);
    const allTracks: LibraryTrack[] = [];
    for (const album of albums.slice(0, 20)) {
      try {
        const tracks = await getAlbumTracks(cfg, album.id);
        allTracks.push(...tracks.filter((t) => !isUnplayableAudio(t.filePath)));
      } catch {
        /* skip albums that fail */
      }
      if (allTracks.length >= 100) break;
    }
    if (!allTracks.length) return;
    // Shuffle.
    for (let i = allTracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allTracks[i], allTracks[j]] = [allTracks[i], allTracks[j]];
    }
    const first = toQueueEntry(allTracks[0]);
    enrichQueueArtwork(first);
    await playerAction({ type: 'player:playNow', entry: first });
    for (const t of allTracks.slice(1, 50)) {
      const e = toQueueEntry(t);
      enrichQueueArtwork(e);
      await playerAction({ type: 'player:queueLast', entry: e }).catch(() => undefined);
    }
  } catch {
    /* silent — the row stays honest */
  }
}

/** Play an album by ID: first track now, rest queued. */
async function playAlbumById(albumId: number): Promise<void> {
  if (!cfg) return;
  const state = $('media-state');
  try {
    const tracks = await getAlbumTracks(cfg, albumId);
    if (!tracks.length) {
      if (state) state.textContent = 'Album is empty on the server.';
      return;
    }
    const playable = tracks.filter((t) => t.filePath && !isUnplayableAudio(t.filePath));
    if (!playable.length) {
      if (state) state.textContent = `No playable tracks (${tracks.length} tracks, none with audio files).`;
      return;
    }
    const first = toQueueEntry(playable[0]);
    enrichQueueArtwork(first);
    await playerAction({ type: 'player:playNow', entry: first });
    for (const t of playable.slice(1)) {
      const e = toQueueEntry(t);
      enrichQueueArtwork(e);
      await playerAction({ type: 'player:queueLast', entry: e }).catch(() => undefined);
    }
    if (state) state.textContent = '';
  } catch (e) {
    if (state) state.textContent = `Couldn't load album: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function mediaSearch(): Promise<void> {
  if (!cfg) return;
  const q = (($('media-q') as HTMLInputElement).value || '').trim();
  const list = $('media-results');
  const state = $('media-state');
  const reqId = ++mediaReqId;
  list.innerHTML = '';
  if (q.length < 2) {
    state.textContent = 'Search your library to play.';
    return;
  }
  state.textContent = 'Searching…';
  try {
    // Unified search: tracks (by title AND by artist), albums, and artists
    // (direct endpoint + derived from tracks) in parallel.
    const [tracksByTitle, tracksByArtist, albums, directArtists] = await Promise.all([
      searchPlayerLibrary(cfg, { title: q, artist: '', limit: 15 }),
      searchPlayerLibrary(cfg, { title: '', artist: q, limit: 15 }).catch(() => [] as LibraryTrack[]),
      searchLibraryAlbums(cfg, q, 8).catch(() => [] as LibraryAlbum[]),
      searchLibraryArtists(cfg, q, 8).catch(() => [] as LibraryArtist[]),
    ]);
    if (reqId !== mediaReqId) return;

    // Merge track results, deduped by ID.
    const seenIds = new Set<number>();
    const tracks: LibraryTrack[] = [];
    for (const t of [...tracksByTitle, ...tracksByArtist]) {
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        tracks.push(t);
      }
    }

    // Derive unique artists from track results AND direct artist search.
    const artistMap = new Map<string, { name: string; artistId: number | null; count: number }>();
    for (const t of tracks) {
      if (!t.artist) continue;
      const key = t.artist.toLowerCase();
      const existing = artistMap.get(key);
      if (existing) {
        existing.count++;
        if (existing.artistId === null && t.artistId !== null) {
          existing.artistId = t.artistId;
        }
      } else {
        artistMap.set(key, { name: t.artist, artistId: t.artistId, count: 1 });
      }
    }
    // Add direct artist search results.
    for (const a of directArtists) {
      const key = a.name.toLowerCase();
      if (!artistMap.has(key)) {
        artistMap.set(key, { name: a.name, artistId: a.id, count: 0 });
      }
    }
    // Fallback: derive artists from album results (albums carry artist_name).
    for (const al of albums) {
      if (!al.artist) continue;
      const key = al.artist.toLowerCase();
      if (!artistMap.has(key)) {
        artistMap.set(key, { name: al.artist, artistId: null, count: 0 });
      }
    }
    // Only show artists whose name actually matches the query (not just
    // because one of their tracks matched).
    const qLower = q.toLowerCase();
    const artists = [...artistMap.values()]
      .filter((a) => a.name.toLowerCase().includes(qLower))
      .slice(0, 5);

    const rows: HTMLLIElement[] = [];
    // Artists first, then albums, then tracks — each in its own section.
    const artistRows = artists.map((a) => mediaArtistRow(a.name, a.artistId, a.count));
    const albumRows = albums.slice(0, 6).map(mediaAlbumRow);
    const trackRows = tracks.slice(0, 10).map(mediaMusicRow);

    if (artistRows.length > 0) {
      list.appendChild(mediaSectionHeader('Artists'));
      for (const r of artistRows) list.appendChild(r);
    }
    if (albumRows.length > 0) {
      list.appendChild(mediaSectionHeader('Albums'));
      for (const r of albumRows) list.appendChild(r);
    }
    if (trackRows.length > 0) {
      list.appendChild(mediaSectionHeader('Tracks'));
      for (const r of trackRows) list.appendChild(r);
    }

    const totalRows = artistRows.length + albumRows.length + trackRows.length;
    state.textContent = totalRows === 0 ? 'Nothing in your library matched.' : '';
  } catch (e) {
    if (reqId !== mediaReqId) return;
    state.textContent = `Couldn’t reach your server — ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Section header for unified search results (Artists/Albums/Tracks). */
function mediaSectionHeader(title: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'media-section-header';
  li.textContent = title;
  return li;
}

function initMediaTab(): void {
  $('media-go').addEventListener('click', () => void mediaSearch());
  ($('media-q') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void mediaSearch();
    }
  });
}

function initPlayerRemote(): void {  const seek = $('pr-seek') as HTMLInputElement;
  seek.addEventListener('input', () => {
    // While dragging, paint the time under the user's thumb and don't let
    // the 1s poll fight them — renderPlayer() checks playerScrubbing.
    playerScrubbing = true;
    $('pr-pos').textContent = fmtTime(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    const sec = Number(seek.value);
    playerScrubbing = false;
    void playerAction({ type: 'player:seek', sec });
  });
  ($('pr-vol') as HTMLInputElement).addEventListener('input', (e) => {
    // Same courtesy as the seek bar: don't let the poll fight the thumb.
    playerVolumeScrubbing = true;
    const vol = e.target as HTMLInputElement;
    vol.style.setProperty('--fill', `${vol.value}%`);
  });
  ($('pr-vol') as HTMLInputElement).addEventListener('change', (e) => {
    const volume = Number((e.target as HTMLInputElement).value) / 100;
    playerVolumeScrubbing = false;
    void playerAction({ type: 'player:setVolume', volume });
  });
  $('pr-prev').addEventListener('click', () => void playerAction({ type: 'player:prev' }));
  $('pr-next').addEventListener('click', () => void playerAction({ type: 'player:next' }));
  $('pr-toggle').addEventListener('click', () => void playerAction({ type: 'player:toggle' }));
  $('pr-clear').addEventListener('click', () => void playerAction({ type: 'player:clear' }));
  $('pr-shuffle').addEventListener('click', () => void playerAction({ type: 'player:shuffle' }));
  // Open the mini player as a docked browser panel (side panel / sidebar).
  // The panel open must run synchronously inside the click — the browser
  // only opens panels on a direct user gesture. Older browsers without
  // panel support fall back to the floating window.
  $('pr-popout').addEventListener('click', () => {
    if (!openMiniPlayerPanel()) {
      void guard(() => openMiniPlayerWindow());
    }
  });
  window.addEventListener('unload', stopPlayerPoll);
}

function init(): void {
  initPlayerRemote();
  initMediaTab();
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
      void refreshPlayer();
      return;
    }
    $('main').hidden = false;
    $('conn-dot').classList.add('ok');
    const storedTab = (await browser.storage.local.get(LAST_TAB_KEY)) as Record<string, unknown>;
    const lastTab = storedTab[LAST_TAB_KEY];
    if (lastTab === 'search' || lastTab === 'activity' || lastTab === 'nowplaying' || lastTab === 'media' || lastTab === 'chat') {
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
    // The player remote reattaches to the background host's state and keeps
    // the seek bar alive with a 1s poll (stopped on unload).
    await refreshPlayer();
    startPlayerPoll();
  })();
});
