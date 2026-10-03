/* SoulSync Companion — in-extension player core: shared types.
 *
 * The background (audio host) is the source of truth; popup and player tab
 * talk to it via runtime.sendMessage using the PlayerMessage protocol below.
 * Snapshots are persisted to browser.storage.session under "playerSnapshot".
 */

export interface QueueEntry {
  kind: 'audio' | 'video';
  title: string;
  subtitle?: string;
  /** Artwork URL (already includes ?api_key= when proxied through the server). */
  artworkUrl?: string;
  /** Server-relative file path for audio streams (GET /stream/library-audio?path=...). */
  audioPath?: string;
  trackId?: number;
  videoKd?: 'm' | 't';
  videoId?: number;
  season?: number;
  episode?: number;
  durationSec?: number;
}

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface PlayerSnapshot {
  status: PlayerStatus;
  queue: QueueEntry[];
  /** Index of the current entry; -1 when the queue is empty. */
  index: number;
  positionSec: number;
  durationSec: number;
  /** 0..1 */
  volume: number;
  error: string | null;
  updatedAt: number;
}

export function emptySnapshot(): PlayerSnapshot {
  return {
    status: 'idle',
    queue: [],
    index: -1,
    positionSec: 0,
    durationSec: 0,
    volume: 1,
    error: null,
    updatedAt: Date.now(),
  };
}

/**
 * The queued-video shape written to `browser.storage.session` under the key
 * `pendingVideoEntry` (the cross-workstream contract — do not rename), then
 * read by the player tab. Centralized here so video-badge senders, the
 * background, and the player tab all type the same object.
 */
export interface PendingVideoEntry {
  videoKd: 'm' | 't';
  videoId: number;
  season?: number;
  episode?: number;
  title: string;
  subtitle?: string;
  artworkUrl?: string;
}

/**
 * Response for `player:openVideo` — `{ok: true}` on success, `{ok: false,
 * error}` when the entry is invalid or the tab couldn't be opened. Unlike
 * every other message in the protocol, it never returns a PlayerSnapshot.
 */
export interface OpenVideoResponse {
  ok: boolean;
  error?: string;
}

/**
 * Background <-> UI messaging protocol. Fixed contract — popup, player tab,
 * offscreen-doc wiring, and the audio host all code to these exact type
 * strings. Every handler responds with a PlayerSnapshot, except
 * `player:ensureHost` which responds `{ok: true}` (or `{ok: false, error}`
 * when the offscreen document can't be raised) and `player:openVideo`
 * which responds with an OpenVideoResponse.
 */
export type PlayerMessage =
  | { type: 'player:ensureHost' }
  | { type: 'player:ping' }
  | { type: 'player:openVideo'; entry: PendingVideoEntry }
  | { type: 'player:getState' }
  | { type: 'player:playNow'; entry: QueueEntry }
  | { type: 'player:queueNext'; entry: QueueEntry }
  | { type: 'player:queueLast'; entry: QueueEntry }
  | { type: 'player:play' }
  | { type: 'player:pause' }
  | { type: 'player:toggle' }
  | { type: 'player:next' }
  | { type: 'player:prev' }
  | { type: 'player:seek'; sec: number }
  | { type: 'player:setVolume'; volume: number }
  | { type: 'player:removeAt'; index: number }
  | { type: 'player:clear' }
  | { type: 'player:shuffle' }
  | { type: 'player:setIndex'; index: number }
  /**
   * Fill cover art into an already-queued audio entry, matched by trackId
   * (stable across shuffles/removals). Sent by UI remotes after a
   * best-effort Deezer lookup; the host repaints and refreshes MediaSession.
   */
  | { type: 'player:setArtwork'; trackId: number; artworkUrl: string };
