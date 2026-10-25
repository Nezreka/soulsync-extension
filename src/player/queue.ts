/* SoulSync Companion — pure queue operations.
 *
 * No DOM, no browser APIs: operates on a plain state object so it runs under
 * node for logic tests. The audio host (host.ts) owns transport (play/pause/
 * element wiring); these functions only mutate the queue and the index.
 */
import type { QueueEntry } from './types.js';

export interface PlayerQueueState {
  entries: QueueEntry[];
  /** Index of the current entry; -1 when the queue is empty. */
  index: number;
}

export function createQueueState(): PlayerQueueState {
  return { entries: [], index: -1 };
}

export function currentEntry(state: PlayerQueueState): QueueEntry | null {
  if (state.index < 0 || state.index >= state.entries.length) return null;
  return state.entries[state.index];
}

/**
 * Insert the entry right after the current position and make it current.
 * On an empty/idle queue it becomes the only entry (index 0).
 */
export function playNow(state: PlayerQueueState, entry: QueueEntry): void {
  if (state.index < 0 || state.entries.length === 0) {
    state.entries = [entry];
    state.index = 0;
    return;
  }
  state.entries.splice(state.index + 1, 0, entry);
  state.index += 1;
}

/** Insert the entry right after the current position (current keeps playing). */
export function queueNext(state: PlayerQueueState, entry: QueueEntry): void {
  if (state.index < 0 || state.entries.length === 0) {
    state.entries = [entry];
    state.index = 0;
    return;
  }
  state.entries.splice(state.index + 1, 0, entry);
}

/** Append the entry to the end of the queue. */
export function queueLast(state: PlayerQueueState, entry: QueueEntry): void {
  const wasEmpty = state.entries.length === 0;
  state.entries.push(entry);
  if (wasEmpty) state.index = 0;
}

/**
 * Remove the entry at `index`. The current index follows the current entry:
 * removing before it shifts it down; removing it leaves the index pointing
 * at whatever slid into its place (the next entry). Removing the tail while
 * current clamps the index back into range. Empty queue -> index -1.
 */
export function removeAt(state: PlayerQueueState, index: number): void {
  if (index < 0 || index >= state.entries.length) return;
  state.entries.splice(index, 1);
  if (state.entries.length === 0) {
    state.index = -1;
    return;
  }
  if (index < state.index) {
    state.index -= 1;
  } else if (state.index >= state.entries.length) {
    state.index = state.entries.length - 1;
  }
}

export function clear(state: PlayerQueueState): void {
  state.entries = [];
  state.index = -1;
}

/**
 * Shuffle the queue, keeping the current entry first so playback continues
 * uninterrupted (its index becomes 0). With no current entry the whole queue
 * shuffles and the index stays -1.
 */
export function shuffle(state: PlayerQueueState): void {
  const current = currentEntry(state);
  const rest = state.entries.filter((_, i) => i !== state.index);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  if (current) {
    state.entries = [current, ...rest];
    state.index = 0;
  } else {
    state.entries = rest;
    state.index = state.entries.length === 0 ? -1 : -1;
  }
}

/** Returns true when the index was valid and applied. */
export function setIndex(state: PlayerQueueState, index: number): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= state.entries.length) return false;
  state.index = index;
  return true;
}

/**
 * Move to the next ('next') or previous ('prev') entry, wrapping around.
 * Empty queue -> index -1. From idle (-1) with a non-empty queue,
 * 'next' lands on 0 and 'prev' on the last entry. Returns the new index.
 */
export function advance(state: PlayerQueueState, dir: 'next' | 'prev'): number {
  if (state.entries.length === 0) {
    state.index = -1;
    return -1;
  }
  if (state.index < 0) {
    state.index = dir === 'next' ? 0 : state.entries.length - 1;
    return state.index;
  }
  const n = state.entries.length;
  state.index = dir === 'next' ? (state.index + 1) % n : (state.index - 1 + n) % n;
  return state.index;
}

/**
 * Rebuild queue state from a persisted snapshot, defensively: Chrome closes
 * the offscreen audio document ~30s after playback stops, so the host that
 * comes back must pick the queue up from storage instead of starting empty.
 * Malformed entries are dropped; a numeric trackId from an older build is
 * normalized to the string form the server's TEXT ids use.
 */
export function restoreQueueState(saved: unknown): PlayerQueueState {
  const state = createQueueState();
  if (!saved || typeof saved !== 'object') return state;
  const o = saved as { queue?: unknown; index?: unknown };
  if (!Array.isArray(o.queue)) return state;
  const keep: boolean[] = [];
  for (const raw of o.queue) {
    const e = raw as Partial<QueueEntry> | null;
    const ok =
      !!e &&
      (e.kind === 'audio' || e.kind === 'video') &&
      typeof e.title === 'string' &&
      e.title.length > 0;
    keep.push(ok);
    if (!ok) continue;
    const entry = { ...(e as QueueEntry) };
    const tid = (e as { trackId?: unknown }).trackId;
    if (typeof tid === 'number' && Number.isFinite(tid)) entry.trackId = String(tid);
    else if (typeof tid !== 'string' || !tid) delete entry.trackId;
    state.entries.push(entry);
  }
  if (state.entries.length === 0) return state;
  // Map the saved index past any dropped entries.
  const savedIndex = typeof o.index === 'number' && Number.isInteger(o.index) ? o.index : 0;
  let idx = -1;
  for (let i = 0, kept = 0; i < keep.length; i++) {
    if (!keep[i]) continue;
    if (i <= savedIndex) idx = kept;
    kept++;
  }
  state.index = Math.max(0, Math.min(idx, state.entries.length - 1));
  return state;
}
