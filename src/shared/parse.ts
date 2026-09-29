import type { ParsedTrack } from './types.js';

/**
 * Parse "Artist - Title" lines. Handles hyphen, en dash, em dash, and strips
 * leading "1. " / "1) " / "1] " numbering.
 *
 * Lines that don't parse are returned with ok:false so the UI can flag them —
 * nothing is ever silently dropped.
 */
export function parseSelection(text: string): ParsedTrack[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((raw) => {
      const cleaned = raw.replace(/^\d{1,3}[.)\]]\s+/, '');
      const m = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      if (!m) return { artist: '', title: cleaned, raw, ok: false };
      const artist = m[1].trim();
      const title = m[2].trim();
      return { artist, title, raw, ok: artist.length > 0 && title.length > 0 };
    });
}
