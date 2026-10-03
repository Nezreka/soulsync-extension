/* SoulSync Companion — fill cover art into audio queue entries.
 *
 * Playback never waits for artwork: the UI sends playNow/queueLast
 * immediately, then calls enrichQueueArtwork() which resolves the Deezer
 * cover in the background and pushes it into the host's queue via
 * `player:setArtwork`. The host then repaints every remote (popup, mini
 * player) and refreshes the MediaSession artwork.
 */
import { lookupCoverArt } from '../shared/artwork.js';
import { sendToPlayer } from './messaging.js';
import type { QueueEntry } from './types.js';

/** trackIds with a lookup already running — never double-fetch. */
const inFlight = new Set<number>();

export function enrichQueueArtwork(entry: QueueEntry): void {
  if (entry.kind !== 'audio' || entry.artworkUrl) return;
  const trackId = entry.trackId;
  if (trackId === undefined || inFlight.has(trackId)) return;
  const artist = (entry.subtitle ?? '').trim();
  const title = entry.title.trim();
  if (!artist || !title) return;
  inFlight.add(trackId);
  lookupCoverArt(artist, title)
    .then((url) => {
      if (url) {
        // The host matches by trackId, so queue shuffles can't misroute it.
        return sendToPlayer({ type: 'player:setArtwork', trackId, artworkUrl: url }).then(
          () => undefined,
          () => undefined,
        );
      }
      return undefined;
    })
    .catch(() => undefined)
    .finally(() => {
      inFlight.delete(trackId);
    });
}
