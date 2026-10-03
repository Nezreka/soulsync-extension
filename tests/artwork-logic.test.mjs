/* Unit tests for the cover-art helpers (real code, no DOM, no network).
 * Bundled by scripts/run-logic-tests.mjs with webextension-polyfill stubbed;
 * only the pure helpers are exercised — lookupCoverArt itself needs fetch.
 */
import {
  artworkCacheKey,
  cleanQueryTitle,
  normKey,
  pickCover,
} from '../src/shared/artwork.ts';

let fails = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!ok) fails++;
}

/* ── normKey ── */
eq('normKey folds case', normKey('HUMBLE.'), 'humble');
eq('normKey strips accents', normKey('Beyoncé'), 'beyonce');
eq('normKey folds punctuation to spaces', normKey('bag TF up'), 'bag tf up');
eq('normKey trims', normKey('  hi! '), 'hi');

/* ── artworkCacheKey ── */
eq('cache key', artworkCacheKey('bbno$', 'bag TF up'), 'bbno|bag tf up');

/* ── cleanQueryTitle ── */
eq('strips (feat. …)', cleanQueryTitle('Song (feat. Someone)'), 'Song');
eq('strips [feat …]', cleanQueryTitle('Song [Feat. Someone]'), 'Song');
eq('strips official video suffix', cleanQueryTitle('Song - Official Video'), 'Song');
eq('leaves plain titles', cleanQueryTitle('HUMBLE.'), 'HUMBLE.');

/* ── pickCover ── */
const rows = [
  { title: 'Other Song', artist: { name: 'Someone' }, album: { cover_big: 'https://img/c1.jpg' } },
  { title: 'HUMBLE.', artist: { name: 'Kendrick Lamar' }, album: { cover_big: 'https://img/c2.jpg' } },
  { title: 'HUMBLE.', artist: { name: 'Cover Band' }, album: { cover_big: 'https://img/c3.jpg' } },
  { title: 'Third', artist: { name: 'Kendrick Lamar' }, album: {} },
];
eq('exact title+artist wins', pickCover(rows, 'humble', 'kendrick lamar'), 'https://img/c2.jpg');
eq('artist breaks title ties', pickCover(rows, 'HUMBLE.', 'Cover Band'), 'https://img/c3.jpg');
eq('falls back to first cover', pickCover(rows, 'zzz', 'zzz'), 'https://img/c1.jpg');
eq('null when no covers', pickCover([{ title: 'x', album: {} }], 'x', 'y'), null);
eq('prefers cover_big over smaller', pickCover(
  [{ title: 't', artist: { name: 'a' }, album: { cover_small: 'https://img/s.jpg', cover_big: 'https://img/b.jpg' } }],
  't', 'a',
), 'https://img/b.jpg');
eq('empty results', pickCover([], 't', 'a'), null);

if (fails) {
  console.error(`${fails} assertion(s) FAILED`);
  process.exit(1);
}
console.log('artwork-logic: all assertions passed');
