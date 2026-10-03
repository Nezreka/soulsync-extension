import browser from 'webextension-polyfill';
import { getConfig } from '../shared/api.js';
import {
  checkVideoPlayable,
  videoStreamUrl,
  type VideoEntry,
} from '../shared/player-api.js';

/**
 * Video player tab (docs/player-spec.md §4–§6).
 *
 * The popup's player workstream writes the queued video to
 * `browser.storage.session` under the key `pendingVideoEntry`, then opens
 * this tab. That key name is the cross-workstream contract — do not rename.
 *
 * Honest states only (§6): the server's /watch/playable verdict is checked
 * before any <video> src is set. verdict 'no' → error panel with the
 * server's reasons, never a silent black rectangle. 'maybe' → dismissible
 * warning strip, then load anyway.
 */

/** The queued-video shape the popup workstream writes (task contract). */
interface PendingVideoEntry {
  videoKd: 'm' | 't';
  videoId: number;
  season?: number;
  episode?: number;
  title: string;
  subtitle?: string;
  artworkUrl?: string;
}

const PENDING_KEY = 'pendingVideoEntry';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ── states ── */

function showState(kind: 'loading' | 'empty' | 'info' | 'error', html: HTMLElement): void {
  const state = $('state');
  state.replaceChildren();
  const card = el('div', kind === 'error' ? 'state-card error' : 'state-card');
  card.appendChild(html);
  state.appendChild(card);
  state.hidden = false;
}

function loadingState(message: string): void {
  const wrap = el('div', '');
  wrap.appendChild(el('div', 'spinner'));
  wrap.appendChild(el('p', 'muted', message));
  showState('loading', wrap);
}

function emptyState(): void {
  const wrap = el('div', '');
  wrap.appendChild(el('h2', '', 'No video queued'));
  wrap.appendChild(
    el('p', 'muted', 'No video queued — pick one from the popup player.'),
  );
  showState('empty', wrap);
}

function connectState(): void {
  const wrap = el('div', '');
  wrap.appendChild(el('h2', '', 'Not connected'));
  wrap.appendChild(el('p', 'muted', 'Connect your SoulSync server in Options to play.'));
  showState('info', wrap);
}

/** Honest error panel: human words plus the server's own reasons. */
function errorState(heading: string, message: string, reasons: string[] = []): void {
  const wrap = el('div', '');
  wrap.appendChild(el('h2', '', heading));
  wrap.appendChild(el('p', '', message));
  if (reasons.length > 0) {
    const ul = el('ul', 'reasons');
    for (const reason of reasons) ul.appendChild(el('li', '', reason));
    wrap.appendChild(ul);
  }
  showState('error', wrap);
}

/** Dismissible warning strip for verdict 'maybe'. */
function showWarning(reasons: string[]): void {
  const warn = $('warn');
  const list = $('warn-reasons');
  list.replaceChildren();
  for (const reason of reasons) list.appendChild(el('li', '', reason));
  warn.hidden = false;
}

/* ── entry validation ── */

function asPendingEntry(raw: unknown): PendingVideoEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const { videoKd, videoId, title } = o;
  if (videoKd !== 'm' && videoKd !== 't') return null;
  if (typeof videoId !== 'number' || !Number.isFinite(videoId)) return null;
  if (typeof title !== 'string' || title.trim() === '') return null;
  const entry: PendingVideoEntry = { videoKd, videoId, title };
  if (typeof o.season === 'number') entry.season = o.season;
  if (typeof o.episode === 'number') entry.episode = o.episode;
  if (typeof o.subtitle === 'string' && o.subtitle) entry.subtitle = o.subtitle;
  if (typeof o.artworkUrl === 'string' && o.artworkUrl) entry.artworkUrl = o.artworkUrl;
  return entry;
}

/* ── media-session (spec §5: set in the document owning the element) ── */

function setupMediaSession(video: HTMLVideoElement, entry: PendingVideoEntry): void {
  if (!('mediaSession' in navigator)) return;
  const artwork = entry.artworkUrl ? [{ src: entry.artworkUrl }] : [];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: entry.title,
      artist: entry.subtitle ?? 'SoulSync',
      album: 'SoulSync',
      artwork,
    });
  } catch {
    /* MediaMetadata construction failed — playback continues without it. */
  }
  try {
    navigator.mediaSession.setActionHandler('play', () => void video.play());
    navigator.mediaSession.setActionHandler('pause', () => video.pause());
  } catch {
    /* Action handlers unsupported — playback continues without them. */
  }
}

/* ── video errors, in human words ── */

function describeVideoError(video: HTMLVideoElement): string {
  const err = video.error;
  switch (err?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'The video couldn\'t be loaded: playback was interrupted.';
    case MediaError.MEDIA_ERR_NETWORK:
      return 'The video couldn\'t be loaded: the connection to your server was lost.';
    case MediaError.MEDIA_ERR_DECODE:
      return 'The video couldn\'t be loaded: this browser couldn\'t decode it.';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'The video couldn\'t be loaded: this format isn\'t supported here.';
    default:
      return 'The video couldn\'t be loaded — the server didn\'t send a playable stream.';
  }
}

/* ── player construction ── */

function loadVideo(entry: PendingVideoEntry, cfgUrl: string, apiKey: string): void {
  const videoEntry: VideoEntry = {
    videoKd: entry.videoKd,
    videoId: entry.videoId,
  };
  if (entry.season !== undefined) videoEntry.season = entry.season;
  if (entry.episode !== undefined) videoEntry.episode = entry.episode;
  const src = videoStreamUrl({ url: cfgUrl, apiKey }, videoEntry);

  // Header above the video (§6 aesthetic).
  const head = $('player-head');
  $('title').textContent = entry.title;
  document.title = `${entry.title} — SoulSync`;
  if (entry.subtitle) {
    $('subtitle').textContent = entry.subtitle;
  } else {
    $('subtitle').hidden = true;
  }
  if (entry.artworkUrl) {
    const art = $('artwork') as HTMLImageElement;
    art.classList.remove('loaded');
    art.onload = () => art.classList.add('loaded');
    // A dead artwork URL hides the tile instead of showing a broken glyph.
    art.onerror = () => {
      art.classList.remove('loaded');
      art.hidden = true;
    };
    art.src = entry.artworkUrl;
    art.hidden = false;
    art.alt = '';
  }
  head.hidden = false;

  // The <video> element is created only once playback is approved — a
  // refused verdict must never produce a silent black rectangle.
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = src;
  video.addEventListener('error', () => {
    errorState('Couldn\'t play this video', describeVideoError(video));
  });

  const stage = $('stage');
  stage.replaceChildren(video);
  stage.hidden = false;
  $('state').hidden = true;

  setupMediaSession(video, entry);
  wirePictureInPicture(video);
}

/** PiP button renders only when the document supports it; errors surface quietly. */
function wirePictureInPicture(video: HTMLVideoElement): void {
  if (!document.pictureInPictureEnabled) return;
  const btn = $('pip-btn');
  const note = $('pip-note');
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (msg: string): void => {
    note.textContent = msg;
    note.hidden = false;
    if (noteTimer !== undefined) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      note.hidden = true;
    }, 4000);
  };
  btn.hidden = false;
  btn.addEventListener('click', () => {
    void (async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (err) {
        say(
          `Picture-in-picture isn't available right now${
            err instanceof Error && err.message ? `: ${err.message}` : '.'
          }`,
        );
      }
    })();
  });
}

/* ── boot ── */

async function main(): Promise<void> {
  loadingState('Finding your queued video…');

  let raw: unknown;
  try {
    const stored = (await browser.storage.session.get(PENDING_KEY)) as Record<string, unknown>;
    raw = stored?.[PENDING_KEY];
  } catch {
    raw = null;
  }
  const entry = asPendingEntry(raw);
  if (!entry) {
    emptyState();
    return;
  }

  const cfg = await getConfig().catch(() => null);
  if (!cfg) {
    connectState();
    return;
  }

  loadingState('Checking whether this copy can play in your browser…');

  let verdict: Awaited<ReturnType<typeof checkVideoPlayable>>;
  try {
    verdict = await checkVideoPlayable(cfg, entry);
  } catch (err) {
    errorState(
      'Couldn\'t check this video',
      err instanceof Error ? err.message : 'The playable check failed unexpectedly.',
    );
    return;
  }

  if (verdict.verdict === 'no') {
    errorState(
      `Can't play "${entry.title}"`,
      'Your server says no browser can play this copy.',
      verdict.reasons,
    );
    return;
  }

  if (verdict.verdict === 'maybe' && verdict.reasons.length > 0) {
    showWarning(verdict.reasons);
    $('warn-close').addEventListener('click', () => {
      $('warn').hidden = true;
    });
  }

  loadVideo(entry, cfg.url, cfg.apiKey);
}

document.addEventListener('DOMContentLoaded', () => {
  void main();
});
