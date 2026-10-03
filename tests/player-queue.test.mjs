/* Focused unit tests for the player queue ops (real code, no DOM).
 * Bundled by scripts/run-logic-tests.mjs; queue.ts imports nothing
 * browser-side so it runs under node untouched.
 *
 * NOTE: the brief asked for "../../src/player/queue.js" — that path escapes
 * the repo from tests/ (two levels up). The working equivalent, matching the
 * existing test convention ("../src/shared/api.ts"), is below.
 */
import {
  advance,
  clear,
  createQueueState,
  currentEntry,
  playNow,
  queueLast,
  queueNext,
  removeAt,
  setIndex,
  shuffle,
} from '../src/player/queue.ts';

let fails = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!ok) fails++;
}

const a = { kind: 'audio', title: 'A' };
const b = { kind: 'audio', title: 'B' };
const c = { kind: 'audio', title: 'C' };
const d = { kind: 'audio', title: 'D' };
const titles = (s) => s.entries.map((e) => e.title);

/* ── playNow ── */
{
  const s = createQueueState();
  playNow(s, a);
  eq("playNow empty: entries", titles(s), ['A']);
  eq("playNow empty: index", s.index, 0);
  playNow(s, b);
  eq("playNow inserts after current", titles(s), ['A', 'B']);
  eq("playNow moves index to new entry", s.index, 1);
  playNow(s, c);
  eq("playNow again inserts after new current", titles(s), ['A', 'B', 'C']);
  eq("playNow index follows", s.index, 2);
  eq("playNow current entry", currentEntry(s)?.title, 'C');
}

/* ── queueNext / queueLast ── */
{
  const s = createQueueState();
  queueNext(s, a);
  eq("queueNext empty: becomes current", s.index, 0);
  eq("queueNext empty: entries", titles(s), ['A']);
  queueLast(s, b);
  queueLast(s, c);
  eq("queueLast appends", titles(s), ['A', 'B', 'C']);
  eq("queueLast leaves index", s.index, 0);
  queueNext(s, d);
  eq("queueNext inserts after current", titles(s), ['A', 'D', 'B', 'C']);
  eq("queueNext keeps current index", s.index, 0);
  eq("queueNext keeps current entry", currentEntry(s)?.title, 'A');
}

/* ── removeAt ── */
{
  const s = createQueueState();
  for (const e of [a, b, c, d]) queueLast(s, e);
  s.index = 2; // current = C
  removeAt(s, 0); // remove A (before current)
  eq("removeAt before current shifts index", s.index, 1);
  eq("removeAt before current keeps entry", currentEntry(s)?.title, 'C');
  removeAt(s, 1); // remove C (the current)
  eq("removeAt current: index points at next", s.index, 1);
  eq("removeAt current: next entry slides in", currentEntry(s)?.title, 'D');
  eq("removeAt current: queue", titles(s), ['B', 'D']);
  removeAt(s, 1); // remove D (current tail)
  eq("removeAt current tail clamps index", s.index, 0);
  eq("removeAt current tail keeps entry", currentEntry(s)?.title, 'B');
  removeAt(s, 0);
  eq("removeAt last entry empties", titles(s), []);
  eq("removeAt last entry index -1", s.index, -1);
  eq("removeAt last entry current null", currentEntry(s), null);
}
{
  const s = createQueueState();
  queueLast(s, a);
  removeAt(s, 5); // out of range: no-op
  removeAt(s, -1);
  eq("removeAt out of range no-op", titles(s), ['A']);
  eq("removeAt out of range keeps index", s.index, 0);
}

/* ── clear ── */
{
  const s = createQueueState();
  for (const e of [a, b]) queueLast(s, e);
  clear(s);
  eq("clear empties", titles(s), []);
  eq("clear resets index", s.index, -1);
  clear(s); // double clear is safe
  eq("clear idempotent", s.index, -1);
}

/* ── shuffle ── */
{
  const s = createQueueState();
  const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'audio', title: `T${i}` }));
  for (const e of many) queueLast(s, e);
  s.index = 5; // current = T5
  shuffle(s);
  eq("shuffle keeps current first", currentEntry(s)?.title, 'T5');
  eq("shuffle current index 0", s.index, 0);
  eq(
    "shuffle preserves all entries",
    [...titles(s)].sort(),
    many.map((e) => e.title).sort(),
  );
}
{
  const s = createQueueState();
  shuffle(s); // empty shuffle is safe
  eq("shuffle empty no-op", s.index, -1);
  queueLast(s, a);
  queueLast(s, b);
  s.index = -1; // idle with a non-empty queue (entries added without a current)
  shuffle(s); // no current (index -1)
  eq("shuffle without current keeps index -1", s.index, -1);
  eq("shuffle without current preserves entries", [...titles(s)].sort(), ['A', 'B']);
}

/* ── setIndex ── */
{
  const s = createQueueState();
  for (const e of [a, b, c]) queueLast(s, e);
  eq("setIndex valid returns true", setIndex(s, 2), true);
  eq("setIndex valid applies", s.index, 2);
  eq("setIndex invalid returns false", setIndex(s, 7), false);
  eq("setIndex invalid keeps index", s.index, 2);
  eq("setIndex negative returns false", setIndex(s, -1), false);
  eq("setIndex non-integer returns false", setIndex(s, 1.5), false);
}

/* ── advance: next/prev with wrap ── */
{
  const s = createQueueState();
  eq("advance next on empty -> -1", advance(s, 'next'), -1);
  eq("advance prev on empty -> -1", advance(s, 'prev'), -1);
  eq("advance empty keeps -1", s.index, -1);
  for (const e of [a, b, c]) queueLast(s, e);
  s.index = -1; // idle with non-empty queue
  eq("advance next from idle -> 0", advance(s, 'next'), 0);
  s.index = -1;
  eq("advance prev from idle -> last", advance(s, 'prev'), 2);
  s.index = 2;
  eq("advance next wraps to 0", advance(s, 'next'), 0);
  s.index = 0;
  eq("advance prev wraps to last", advance(s, 'prev'), 2);
  s.index = 1;
  eq("advance next mid-queue", advance(s, 'next'), 2);
  eq("advance prev mid-queue", advance(s, 'prev'), 1);
}

/* ── currentEntry edge cases ── */
{
  const s = createQueueState();
  eq("currentEntry empty -> null", currentEntry(s), null);
  s.entries = [a];
  s.index = 99;
  eq("currentEntry out of range -> null", currentEntry(s), null);
}

if (fails) { console.error(`${fails} FAILURES`); process.exit(1); }
console.log("ALL PLAYER QUEUE TESTS PASSED");
