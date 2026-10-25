/* SoulSync Companion — audio host (player transport).
 *
 * Runs in whichever document owns playback: Chrome's offscreen document
 * (reason audio_playback) or Firefox's real background page. It creates and
 * owns one HTMLAudioElement from the ambient document — no assumptions about
 * which document that is.
 *
 * Dependency-injected (`resolveAudioUrl`, `getConfig`) so this stays
 * decoupled from shared/player-api.ts; a sibling workstream implements those.
 * Video entries are NOT played here: they belong to the player tab. The host
 * skips them honestly (same path as undecodable WMA) instead of failing
 * silently.
 */
import browser from 'webextension-polyfill';
import type { ServerConfig } from '../shared/types.js';
import {
  advance,
  clear,
  createQueueState,
  currentEntry,
  playNow,
  queueLast,
  queueNext,
  removeAt,
  restoreQueueState,
  setIndex,
  shuffle,
  type PlayerQueueState,
} from './queue.js';
import {
  emptySnapshot,
  type PlayerMessage,
  type PlayerSnapshot,
  type PlayerStatus,
  type QueueEntry,
} from './types.js';
import { lookupCoverArt } from '../shared/artwork.js';

export interface AudioHostOpts {
  resolveAudioUrl: (cfg: ServerConfig, entry: QueueEntry) => string;
  getConfig: () => Promise<ServerConfig | null>;
  /**
   * Chrome only: the audio host runs in the offscreen document, and the
   * service worker relays every player request to it (marked relayed:true).
   * When true, non-relayed requests are ignored so a message delivered both
   * directly and via the relay can never double-execute. The idempotent
   * `player:ping` / `player:ensureHost` probes are still answered either way.
   */
  acceptRelayedOnly?: boolean;
  /**
   * Where snapshots live. Defaults to storage.session in this context. The
   * Chrome offscreen document has no chrome.storage, so it passes
   * service-worker-backed versions — without them nothing was ever saved
   * there, and the queue died with the document.
   */
  saveSnapshot?: (snap: PlayerSnapshot) => Promise<void>;
  loadSnapshot?: () => Promise<unknown>;
}

export interface AudioHostHandle {
  getSnapshot: () => PlayerSnapshot;
  stop: () => void;
}

const SNAPSHOT_KEY = 'playerSnapshot';
/** Position-only saves (timeupdate) are throttled to this; state changes save at once. */
const POSITION_PERSIST_MS = 5000;
const WMA_SKIP_MESSAGE = "WMA audio can't be decoded by browsers — skipping";
const VIDEO_SKIP_MESSAGE = 'Video entries play in the mini player — skipping';

function isWma(entry: QueueEntry): boolean {
  return /\.wma$/i.test((entry.audioPath ?? '').trim());
}

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

export function startAudioHost(opts: AudioHostOpts): AudioHostHandle {
  let q: PlayerQueueState = createQueueState();
  const saveSnapshot =
    opts.saveSnapshot ??
    (async (snap: PlayerSnapshot) => {
      await browser.storage.session.set({ [SNAPSHOT_KEY]: snap });
    });
  const loadSnapshot =
    opts.loadSnapshot ??
    (async () => (await browser.storage.session.get(SNAPSHOT_KEY))[SNAPSHOT_KEY]);
  const audio = document.createElement('audio');
  audio.preload = 'auto';

  let status: PlayerStatus = 'idle';
  let positionSec = 0;
  let durationSec = 0;
  let volume = 1;
  let error: string | null = null;
  /** Guards against stale async loads (user hit next while a track was resolving). */
  let loadSeq = 0;
  let lastPersistAt = 0;
  /** Where a restored track resumes on its next play (seconds). */
  let resumeAt = 0;

  audio.volume = volume;

  function snapshot(): PlayerSnapshot {
    return {
      status,
      queue: q.entries.map((e) => ({ ...e })),
      index: q.index,
      positionSec,
      durationSec,
      volume,
      error,
      updatedAt: Date.now(),
    };
  }

  async function persist(force = false): Promise<void> {
    if (!restored) return; // never overwrite the saved queue with the empty boot state
    const now = Date.now();
    if (!force && now - lastPersistAt < POSITION_PERSIST_MS) return;
    lastPersistAt = now;
    try {
      await saveSnapshot(snapshot());
    } catch {
      /* storage may be unavailable in some contexts — playback continues */
    }
  }

  /**
   * Pick up the queue a previous host left behind (Chrome closes an idle
   * offscreen document; Firefox suspends the background page). It comes
   * back paused at the saved position — never auto-playing on its own.
   */
  let restored = false;
  const ready: Promise<void> = (async () => {
    try {
      const saved = await loadSnapshot();
      const rq = restoreQueueState(saved);
      if (rq.entries.length > 0) {
        q = rq;
        const o = saved as Partial<PlayerSnapshot>;
        volume = clampVolume(typeof o.volume === 'number' ? o.volume : 1);
        audio.volume = volume;
        positionSec = typeof o.positionSec === 'number' && o.positionSec > 0 ? o.positionSec : 0;
        durationSec = typeof o.durationSec === 'number' && o.durationSec > 0 ? o.durationSec : 0;
        resumeAt = positionSec;
        status = 'paused';
        const cur = currentEntry(q);
        if (cur && cur.kind === 'audio') setMediaSession(cur);
      }
    } catch {
      /* nothing saved, or storage unavailable — start empty */
    }
    restored = true;
  })();

  function broadcast(): void {
    try {
      // Fire-and-forget: no listeners may exist (popup closed).
      const p = browser.runtime.sendMessage({ type: 'player:stateChanged', snapshot: snapshot() });
      Promise.resolve(p).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  function setStatus(s: PlayerStatus): void {
    if (status === s) return;
    status = s;
    void persist(true);
    broadcast();
    updatePlayingBadge();
    setMediaPosition();
  }

  /**
   * Green ♪ on the toolbar button while audio is playing, so the user
   * can see at a glance that something's going. Cleared on any other
   * status.
   */
  function updatePlayingBadge(): void {
    try {
      if (status === 'playing') {
        void browser.action.setBadgeBackgroundColor({ color: '#22c55e' });
        void browser.action.setBadgeText({ text: '♪' });
      } else {
        void browser.action.setBadgeText({ text: '' });
      }
    } catch {
      /* badge API unavailable — playback continues without it */
    }
  }

  function setError(msg: string | null): void {
    if (error === msg) return;
    error = msg;
    void persist(true);
    broadcast();
  }

  function clearMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = null;
    } catch {
      /* ignore */
    }
  }

  function setMediaSession(entry: QueueEntry): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: entry.title,
        artist: entry.subtitle ?? '',
        album: 'SoulSync',
        artwork: entry.artworkUrl ? [{ src: entry.artworkUrl }] : undefined,
      });
    } catch {
      /* MediaSession metadata is best-effort */
    }
  }

  /** Feed the OS media HUD its scrubber; best-effort, throws on bad values. */
  function setMediaPosition(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState =
        status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none';
      if (durationSec > 0 && positionSec <= durationSec) {
        navigator.mediaSession.setPositionState({
          duration: durationSec,
          position: Math.max(0, positionSec),
          playbackRate: 1,
        });
      }
    } catch {
      /* setPositionState unsupported or rejected */
    }
  }

  function wireMediaSessionActions(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: Array<[MediaSessionAction, () => void]> = [
      ['play', () => void doPlay()],
      ['pause', () => doPause()],
      ['previoustrack', () => step('prev')],
      ['nexttrack', () => step('next')],
    ];
    handlers.push(
      ['seekbackward', () => doSeek(Math.max(0, (audio.currentTime || 0) - 10))],
      ['seekforward', () => doSeek((audio.currentTime || 0) + 10)],
    );
    for (const [action, fn] of handlers) {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* ignore unsupported actions */
      }
    }
    try {
      ms.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') doSeek(details.seekTime);
      });
    } catch {
      /* ignore */
    }
  }

  /** Skip the current entry with `reason`, then play the next playable audio entry. */
  function skipCurrent(reason: string): void {
    setError(reason);
    const from = q.index;
    for (let i = from + 1; i < q.entries.length; i++) {
      if (isPlayableAudio(q.entries[i])) {
        q.index = i;
        void loadCurrentAndPlay();
        return;
      }
    }
    // Nothing playable left ahead: stop on the error, keep the queue intact.
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
    setStatus('idle');
  }

  function isPlayableAudio(entry: QueueEntry): boolean {
    return entry.kind === 'audio' && !isWma(entry) && !!(entry.audioPath ?? '').trim();
  }

  function skipReasonFor(entry: QueueEntry): string {
    if (entry.kind === 'video') return VIDEO_SKIP_MESSAGE;
    if (isWma(entry)) return WMA_SKIP_MESSAGE;
    return `No audio stream available for "${entry.title}" — skipping`;
  }

  // Cover-art lookups in flight, keyed by track id so a track that starts
  // playing twice never double-fetches.
  const artInFlight = new Set<string>();

  // Resolve cover art for the entry now loading, whichever UI started
  // playback (popup, badge click, queue advance — none of them have to
  // remember to enrich). Applies directly: this IS the host.
  function enrichCurrentArtwork(entry: QueueEntry): void {
    if (entry.kind !== 'audio' || entry.artworkUrl) return;
    const trackId = entry.trackId;
    if (trackId === undefined || artInFlight.has(trackId)) return;
    const artist = (entry.subtitle ?? '').trim();
    const title = entry.title.trim();
    if (!artist || !title) return;
    artInFlight.add(trackId);
    lookupCoverArt(artist, title)
      .then((url) => {
        if (!url) return;
        const idx = q.entries.findIndex(
          (e) => e.kind === 'audio' && e.trackId === trackId,
        );
        if (idx >= 0 && !q.entries[idx].artworkUrl) {
          q.entries[idx] = { ...q.entries[idx], artworkUrl: url };
          if (idx === q.index) setMediaSession(q.entries[idx]);
          void persist(true);
          broadcast();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        artInFlight.delete(trackId);
      });
  }

  async function loadCurrentAndPlay(): Promise<void> {
    const entry = currentEntry(q);
    if (!entry) {
      setStatus('idle');
      return;
    }
    if (entry.kind === 'video') {
      // Video renders in a UI surface (the mini panel), not the audio
      // element. Park the audio host here: stop any audio, keep the index
      // on the video, no error, and never advance past it looking for
      // audio — the panel owns playback from here.
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
      setError(null);
      setStatus('idle');
      return;
    }
    if (!isPlayableAudio(entry)) {
      skipCurrent(skipReasonFor(entry));
      return;
    }
    const token = ++loadSeq;
    setStatus('loading');
    setError(null);
    setMediaSession(entry);
    enrichCurrentArtwork(entry);

    let cfg: ServerConfig | null;
    try {
      cfg = await opts.getConfig();
    } catch (e) {
      if (token !== loadSeq) return;
      setError(e instanceof Error ? e.message : 'Could not read the server configuration.');
      setStatus('error');
      return;
    }
    if (token !== loadSeq) return;
    if (!cfg) {
      setError('No SoulSync server configured — open the extension options first.');
      setStatus('error');
      return;
    }

    let url: string;
    try {
      url = opts.resolveAudioUrl(cfg, entry);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the audio stream URL.');
      setStatus('error');
      return;
    }
    if (token !== loadSeq) return;

    // A restored queue resumes where it stopped; any fresh load starts at 0.
    const startAt = resumeAt;
    resumeAt = 0;
    positionSec = startAt;
    durationSec = entry.durationSec ?? 0;
    audio.src = url;
    if (startAt > 0) {
      audio.addEventListener(
        'loadedmetadata',
        () => {
          if (token === loadSeq) {
            try {
              audio.currentTime = startAt;
            } catch {
              /* not seekable — start from the top */
            }
          }
        },
        { once: true },
      );
    }
    try {
      await audio.play();
    } catch (e) {
      if (token !== loadSeq) return;
      const msg = e instanceof Error && e.message ? e.message : 'Playback failed.';
      // Autoplay/policy rejections surface here; keep them honest, don't skip.
      setError(msg);
      setStatus('error');
    }
    void persist(true);
  }

  function stopPlayback(): void {
    loadSeq++;
    resumeAt = 0;
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
    audio.removeAttribute('src');
    try {
      audio.load();
    } catch {
      /* ignore */
    }
    positionSec = 0;
    durationSec = 0;
    clearMediaSession();
    setError(null);
    setStatus('idle');
  }

  async function doPlay(): Promise<void> {
    const entry = currentEntry(q);
    if (!entry) return;
    // Resume a paused element that already has this track loaded.
    if (status === 'paused' && audio.src) {
      try {
        await audio.play();
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : 'Playback failed.');
        setStatus('error');
      }
      return;
    }
    if (status === 'playing') return;
    await loadCurrentAndPlay();
  }

  function doPause(): void {
    if (status !== 'playing' && status !== 'loading') return;
    loadSeq++;
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
    // The 'pause' event also syncs status; set it here for immediacy.
    setStatus('paused');
  }

  function step(dir: 'next' | 'prev'): void {
    resumeAt = 0;
    // No repeat mode: advancing past the last entry stops instead of
    // wrapping. A finished song plays once — it must not loop forever.
    if (dir === 'next' && q.index >= q.entries.length - 1) {
      stopPlayback();
      void persist(true);
      broadcast();
      return;
    }
    const idx = advance(q, dir);
    if (idx < 0) {
      stopPlayback();
      return;
    }
    void persist(true);
    broadcast();
    void loadCurrentAndPlay();
  }

  function doSeek(sec: number): void {
    const target = Number.isFinite(sec) ? Math.max(0, sec) : 0;
    const clamped =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? Math.min(target, audio.duration)
        : target;
    try {
      if (audio.src) audio.currentTime = clamped;
    } catch {
      /* element not ready — still update the snapshot position */
    }
    positionSec = clamped;
    void persist(true);
    broadcast();
  }

  function doSetVolume(v: number): void {
    volume = clampVolume(v);
    try {
      audio.volume = volume;
    } catch {
      /* ignore */
    }
    void persist(true);
    broadcast();
  }

  /* ── element events ── */

  audio.addEventListener('play', () => {
    setError(null);
    setStatus('playing');
  });
  audio.addEventListener('pause', () => {
    // 'ended' handles its own transition; the pause event may precede it.
    if (!audio.ended && status === 'playing') setStatus('paused');
  });
  audio.addEventListener('ended', () => step('next'));
  audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      durationSec = audio.duration;
    } else {
      const entry = currentEntry(q);
      durationSec = entry?.durationSec ?? 0;
    }
    void persist(true);
  });
  audio.addEventListener('timeupdate', () => {
    positionSec = audio.currentTime;
    void persist(false); // throttled
    setMediaPosition();
  });
  audio.addEventListener('error', () => {
    const entry = currentEntry(q);
    const what = entry ? `"${entry.title}"` : 'audio';
    skipCurrent(`The server couldn't stream ${what} — skipping`);
  });

  /* ── message protocol ── */

  function isPlayerMessage(message: unknown): message is PlayerMessage {
    if (!message || typeof message !== 'object') return false;
    const t = (message as { type?: unknown }).type;
    return typeof t === 'string' && t.startsWith('player:');
  }

  const onMessage = (message: unknown): Promise<PlayerSnapshot | { ok: true }> | undefined => {
    if (!isPlayerMessage(message)) return undefined; // not ours — other listeners handle it
    // The worker's own storage traffic for this host — never ours to answer.
    if (message.type === 'player:saveSnapshot' || message.type === 'player:loadSnapshot') return undefined;
    if (
      opts.acceptRelayedOnly === true &&
      (message as { relayed?: unknown }).relayed !== true &&
      message.type !== 'player:ping' &&
      message.type !== 'player:ensureHost'
    ) {
      return undefined; // Chrome: all player traffic routes via the service worker relay
    }
    // Every answer waits for the restore, so a popup reattaching to a
    // freshly recreated host sees the saved queue, not a blank one.
    if (!restored) return ready.then(() => onMessage(message) ?? snapshot());
    switch (message.type) {
      case 'player:ensureHost':
        return Promise.resolve({ ok: true });
      case 'player:ping':
        return Promise.resolve({ ok: true });
      case 'player:getState':
        return Promise.resolve(snapshot());
      case 'player:playNow': {
        resumeAt = 0;
        playNow(q, message.entry);
        void persist(true);
        broadcast();
        return loadCurrentAndPlay().then(() => snapshot());
      }
      case 'player:queueNext':
        queueNext(q, message.entry);
        void persist(true);
        broadcast();
        return Promise.resolve(snapshot());
      case 'player:queueLast':
        queueLast(q, message.entry);
        void persist(true);
        broadcast();
        return Promise.resolve(snapshot());
      case 'player:play':
        return doPlay().then(() => snapshot());
      case 'player:pause':
        doPause();
        return Promise.resolve(snapshot());
      case 'player:toggle':
        return (status === 'playing' ? Promise.resolve(doPause()) : doPlay()).then(() =>
          snapshot(),
        );
      case 'player:next':
        step('next');
        return Promise.resolve(snapshot());
      case 'player:prev':
        step('prev');
        return Promise.resolve(snapshot());
      case 'player:seek':
        doSeek(message.sec);
        return Promise.resolve(snapshot());
      case 'player:setVolume':
        doSetVolume(message.volume);
        return Promise.resolve(snapshot());
      case 'player:removeAt': {
        const removedCurrent = message.index === q.index;
        removeAt(q, message.index);
        void persist(true);
        broadcast();
        if (q.entries.length === 0) {
          stopPlayback();
        } else if (removedCurrent) {
          // Index now points at whatever slid into the removed entry's place.
          void loadCurrentAndPlay();
        }
        return Promise.resolve(snapshot());
      }
      case 'player:clear':
        clear(q);
        stopPlayback();
        void persist(true);
        broadcast();
        return Promise.resolve(snapshot());
      case 'player:shuffle':
        shuffle(q);
        void persist(true);
        broadcast();
        return Promise.resolve(snapshot());
      case 'player:setIndex': {
        if (!setIndex(q, message.index)) return Promise.resolve(snapshot());
        resumeAt = 0;
        void persist(true);
        broadcast();
        return loadCurrentAndPlay().then(() => snapshot());
      }
      case 'player:setArtwork': {
        const idx = q.entries.findIndex(
          (e) => e.kind === 'audio' && e.trackId === message.trackId,
        );
        if (idx >= 0 && q.entries[idx].artworkUrl !== message.artworkUrl) {
          q.entries[idx] = { ...q.entries[idx], artworkUrl: message.artworkUrl };
          // The OS media HUD / lock screen picks this up on the next paint.
          if (idx === q.index) setMediaSession(q.entries[idx]);
          void persist(true);
          broadcast();
        }
        return Promise.resolve(snapshot());
      }
    }
  };
  browser.runtime.onMessage.addListener(onMessage);

  wireMediaSessionActions();

  return {
    getSnapshot: snapshot,
    stop: () => {
      browser.runtime.onMessage.removeListener(onMessage);
      stopPlayback();
    },
  };
}
