/**
 * Page-metadata helpers shared by the release extractors.
 * Strategy everywhere: JSON-LD first (stable), OpenGraph second (stable),
 * DOM selectors last (they drift — keep them as the final fallback).
 */

export function metaTag(property: string): string {
  return document.querySelector(`meta[property="${property}"]`)?.getAttribute('content')?.trim() ?? '';
}

/** First JSON-LD block whose @type matches, or null. */
export function jsonLdOfType(pattern: RegExp): Record<string, unknown> | null {
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const json: unknown = JSON.parse(el.textContent || '');
      const items = Array.isArray(json) ? json : [json];
      const hit = items.find(
        (j): j is Record<string, unknown> =>
          !!j && typeof j === 'object' && typeof (j as Record<string, unknown>)['@type'] === 'string' &&
          pattern.test((j as Record<string, unknown>)['@type'] as string),
      );
      if (hit) return hit;
    } catch {
      /* ignore malformed blocks */
    }
  }
  return null;
}

/** Track titles from the first selector that matches anything. */
export function trackTitles(selectors: string[]): string[] {
  for (const sel of selectors) {
    const found = [...document.querySelectorAll(sel)]
      .map((el) => el.textContent?.trim() ?? '')
      .filter((t) => t.length > 0);
    if (found.length > 0) return found;
  }
  return [];
}

/** byArtist may be a string or {name}. */
export function artistName(byArtist: unknown, fallback = ''): string {
  if (typeof byArtist === 'string') return byArtist.trim();
  if (byArtist && typeof byArtist === 'object' && typeof (byArtist as Record<string, unknown>).name === 'string') {
    return ((byArtist as Record<string, unknown>).name as string).trim();
  }
  return fallback;
}
