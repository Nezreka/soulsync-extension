/* SoulSync Companion — offscreen audio host (Chrome path).
 *
 * This document is created lazily by the service worker behind the
 * `player:ensureHost` message (chrome.offscreen.createDocument, reason
 * AUDIO_PLAYBACK) and immediately starts the audio host, which owns the
 * single <audio> element and all player:* messages. Firefox never loads
 * this file: its background page hosts audio directly from the
 * service-worker bundle instead.
 *
 * NOTE: offscreen documents only get `chrome.runtime` — `chrome.storage`
 * is undefined here. Server config is fetched from the service worker
 * (which has storage) via `player:getConfig`.
 */
import browser from 'webextension-polyfill';
import { startAudioHost } from '../player/host.js';
import { libraryAudioUrl } from '../shared/player-api.js';
import type { ServerConfig } from '../shared/types.js';
import type { PlayerSnapshot } from '../player/types.js';

async function getConfigViaSw(): Promise<ServerConfig | null> {
  try {
    const res = (await browser.runtime.sendMessage({ type: 'player:getConfig' })) as
      | ServerConfig
      | null
      | undefined;
    return res ?? null;
  } catch {
    return null;
  }
}

/** Snapshot storage through the worker — this document can't reach chrome.storage. */
async function saveSnapshotViaSw(snapshot: PlayerSnapshot): Promise<void> {
  await browser.runtime.sendMessage({ type: 'player:saveSnapshot', snapshot });
}

async function loadSnapshotViaSw(): Promise<unknown> {
  try {
    return (await browser.runtime.sendMessage({ type: 'player:loadSnapshot' })) ?? null;
  } catch {
    return null;
  }
}

console.debug('[soulsync-player] offscreen document loaded — starting audio host');
startAudioHost({
  resolveAudioUrl: libraryAudioUrl,
  getConfig: getConfigViaSw,
  acceptRelayedOnly: true,
  saveSnapshot: saveSnapshotViaSw,
  loadSnapshot: loadSnapshotViaSw,
});
console.debug('[soulsync-player] audio host started');
