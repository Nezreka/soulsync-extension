/**
 * Transport for every call to the user's SoulSync server.
 *
 * Two server facts shape this:
 * - The public v1 API is rate-limited to 60 requests/minute per client IP
 *   (api/__init__.py `limiter.limit("60 per minute")(bp)`, flask-limiter
 *   fixed window, no Retry-After header). A page full of badges easily
 *   bursts past that, and every 429 used to surface as an "unknown" pill.
 *   v1 calls therefore go through a sliding-window pacer that stays under
 *   the limit, and a 429 that still slips through (the popup and the
 *   background each pace on their own) is retried after a backoff instead
 *   of failing.
 * - A server that accepts the connection but never answers would leave
 *   pills and popup cards spinning forever, so every request gets a timeout.
 *
 * Non-v1 routes (/api/watchlist/*, /api/library/check-tracks, …) are not
 * rate-limited server-side and skip the pacer.
 */

/** Requests this context lets itself make per window. Under the server's
 *  60 so the popup and the background together rarely collide. */
let V1_BUDGET = 45;
let V1_WINDOW_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Backoff before each 429 retry. flask-limiter's fixed window resets on
 *  the minute, so the last step waits long enough to cross a boundary. */
let RETRY_BACKOFF_MS = [3_000, 10_000, 30_000];

const sent: number[] = [];
let cooldownUntil = 0;
let queue: Promise<void> = Promise.resolve();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True for paths under the rate-limited public API. */
export function isV1Path(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith('/api/v1/');
  } catch {
    return url.includes('/api/v1/');
  }
}

/**
 * Wait for a v1 slot. Callers are served in order (one shared promise
 * chain), so a burst drains steadily instead of stampeding the window.
 */
function v1Slot(): Promise<void> {
  const turn = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      if (now < cooldownUntil) {
        await sleep(cooldownUntil - now);
        continue;
      }
      while (sent.length > 0 && now - sent[0] >= V1_WINDOW_MS) sent.shift();
      if (sent.length < V1_BUDGET) {
        sent.push(now);
        return;
      }
      await sleep(V1_WINDOW_MS - (now - sent[0]) + 50);
    }
  });
  queue = turn.catch(() => undefined);
  return turn;
}

export interface ServerFetchOptions {
  /** Abort after this long. 0 disables the timeout (long uploads). */
  timeoutMs?: number;
}

/**
 * fetch() for SoulSync server URLs: paced and 429-retried on v1 paths,
 * timed out everywhere. Resolves with the final Response (a 429 after the
 * last retry is returned as-is so callers surface the server's message).
 */
export async function serverFetch(
  url: string,
  init: RequestInit = {},
  opts: ServerFetchOptions = {},
): Promise<Response> {
  const v1 = isV1Path(url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    if (v1) await v1Slot();
    const ctl = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: init.signal ?? ctl.signal });
    } catch (e) {
      if (ctl.signal.aborted) {
        throw new Error(`Your SoulSync server didn't answer within ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (res.status !== 429 || attempt >= RETRY_BACKOFF_MS.length) return res;
    // Rate-limited anyway: hold every queued v1 caller, not just this one.
    const wait = RETRY_BACKOFF_MS[attempt];
    if (v1) cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
    else await sleep(wait);
  }
}

/** Test hook: forget pacing state, optionally with tighter limits. */
export function resetServerFetchState(
  limits: { budget?: number; windowMs?: number; backoffMs?: number[] } = {},
): void {
  V1_BUDGET = limits.budget ?? 45;
  V1_WINDOW_MS = limits.windowMs ?? 60_000;
  RETRY_BACKOFF_MS = limits.backoffMs ?? [3_000, 10_000, 30_000];
  sent.length = 0;
  cooldownUntil = 0;
  queue = Promise.resolve();
}
