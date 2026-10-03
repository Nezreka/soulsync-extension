/// <reference types="chrome" />
// Mini player surfaces. The primary surface is the docked browser panel
// (Chrome side panel / Firefox sidebar), opened from the ⧉ button. A real
// OS popup window remains as the fallback for browsers without panel
// support. At most one window exists: opening focuses the existing one,
// and a closed window is forgotten so the next open starts fresh.
import browser from 'webextension-polyfill';

const MINI_URL = 'mini-player/mini.html';
const MINI_WINDOW_ID_KEY = 'miniPlayerWindowId';

let openInFlight = false;

/**
 * Open the mini player as a docked browser panel. MUST be called
 * synchronously inside a user gesture (e.g. directly in a click handler):
 * the browser rejects panel opens otherwise, and the gesture is gone after
 * any await. Returns true when a panel open was kicked off.
 *
 * A rejected open is reported through `onError` (instead of vanishing
 * into a swallowed promise) so a silent failure can be diagnosed.
 */
export function openMiniPlayerPanel(onError?: (msg: string) => void): boolean {
  try {
    if (chrome.sidePanel?.open) {
      // Fire and forget — awaiting would already be outside the gesture.
      void chrome.sidePanel
        .open({ windowId: chrome.windows.WINDOW_ID_CURRENT })
        .catch((e: unknown) => {
          onError?.(e instanceof Error ? e.message : String(e));
        });
      return true;
    }
  } catch {
    /* fall through to the sidebar / window fallbacks */
  }
  try {
    const sidebar = (
      browser as unknown as { sidebarAction?: { open(): Promise<void> } }
    ).sidebarAction;
    if (sidebar?.open) {
      void sidebar.open().catch(() => undefined);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** Fallback: open the mini player as its own OS window (deduplicated). */
export async function openMiniPlayerWindow(): Promise<void> {
  if (openInFlight) return;
  openInFlight = true;
  try {
    const stored = (await browser.storage.session
      .get(MINI_WINDOW_ID_KEY)
      .catch(() => ({}))) as Record<string, unknown>;
    const id = stored[MINI_WINDOW_ID_KEY];
    if (typeof id === 'number') {
      try {
        await browser.windows.get(id);
        await browser.windows.update(id, { focused: true });
        return;
      } catch {
        // Window was closed — fall through and open a new one.
        await browser.storage.session.remove(MINI_WINDOW_ID_KEY).catch(() => undefined);
      }
    }
    const win = await browser.windows.create({
      url: browser.runtime.getURL(MINI_URL),
      type: 'popup',
      width: 300,
      height: 560,
    });
    if (win?.id !== undefined) {
      await browser.storage.session
        .set({ [MINI_WINDOW_ID_KEY]: win.id })
        .catch(() => undefined);
    }
  } catch {
    // Best effort — playback never depends on the window.
  } finally {
    openInFlight = false;
  }
}

/** Forget the tracked mini window (called by the mini window on unload). */
export async function clearMiniPlayerWindow(): Promise<void> {
  await browser.storage.session.remove(MINI_WINDOW_ID_KEY).catch(() => undefined);
}
