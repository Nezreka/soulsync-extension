/* SoulSync Companion — UI-side sender for the player:* protocol.
 *
 * Used by UI contexts (popup, player tab). First sends `player:ensureHost`
 * and awaits it — in Chrome the background worker creates the offscreen
 * audio document behind that message — then sends the real message, with a
 * retry loop (up to ~2s) in case the host isn't listening yet (e.g. the
 * offscreen document is still spinning up).
 */
import browser from 'webextension-polyfill';
import type { PlayerMessage, PlayerSnapshot } from './types.js';

const HOST_RETRY_MS = 2000;
const HOST_RETRY_DELAY_MS = 100;

export async function sendToPlayer(message: PlayerMessage): Promise<PlayerSnapshot> {
  // Verified handshake: the background only reports {ok:true} once the audio
  // host has actually answered a ping, so by the time we send the real
  // message someone is guaranteed to be listening. Retry the handshake;
  // surface the background's own error instead of timing out vaguely.
  const hostDeadline = Date.now() + 12000;
  for (;;) {
    let res: unknown;
    try {
      res = await browser.runtime.sendMessage({ type: 'player:ensureHost' });
    } catch (e) {
      res = undefined;
      if (Date.now() >= hostDeadline) {
        throw e instanceof Error ? e : new Error(String(e));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    const ok = (res as { ok?: unknown } | null | undefined)?.ok;
    if (ok === true) break;
    if (ok === false) {
      throw new Error(
        `player host failed: ${(res as { error?: unknown }).error ?? 'unknown error'}`,
      );
    }
    // undefined: the background didn't answer at all — keep retrying briefly,
    // then say so plainly instead of blaming the audio host.
    if (Date.now() >= hostDeadline) {
      throw new Error('extension background not answering — try reloading the extension');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const deadline = Date.now() + HOST_RETRY_MS;
  let lastError: unknown = null;
  for (;;) {
    try {
      const response = await browser.runtime.sendMessage(message);
      if (response !== undefined && response !== null) {
        return response as PlayerSnapshot;
      }
      // Chrome resolves undefined (no rejection) when no listener has
      // responded yet — e.g. the offscreen document exists but its scripts
      // haven't registered the host listener. Treat like a missed connection
      // and keep retrying instead of rendering an undefined snapshot.
      lastError = new Error('player host did not respond yet');
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) throw lastError;
    await new Promise((resolve) => setTimeout(resolve, HOST_RETRY_DELAY_MS));
  }
}
