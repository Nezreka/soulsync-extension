/* Focused unit tests for the mini-chat protocol folds and rich-text
 * renderer (real code, no DOM). Bundled by scripts/run-logic-tests.mjs
 * from src/shared/chat-protocol.ts and src/popup/chat.ts.
 */
import { createHash } from 'node:crypto';
import {
  classifyUser,
  parseProtocol,
  tallyVotes,
  isModerator,
  reduceHidden,
  reducePins,
  reducePoll,
  reduceTrivia,
  reduceTopic,
  reduceAvatars,
  normalizeTriviaAnswer,
  extractFileFromText,
} from '../src/shared/chat-protocol.ts';
import { renderRichText, renderPlainText } from '../src/popup/chat.ts';

let fails = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    console.log('PASS', name);
  } else {
    fails++;
    console.error(`FAIL ${name}\n  got:  ${a}\n  want: ${b}`);
  }
}
function ok(name, cond) {
  if (cond) console.log('PASS', name);
  else {
    fails++;
    console.error('FAIL', name);
  }
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const ev = (username, p, timestamp = '2026-10-01T12:00:00') => ({ username, timestamp, p });

/* ── user classification: the FLIP ── */
eq('assumed + bare text -> vanilla', classifyUser('assumed', false), 'vanilla');
eq('envelope proves soulsync', classifyUser('assumed', true), 'soulsync');
eq('soulsync is forever', classifyUser('soulsync', false), 'soulsync');

/* ── protocol parsing: hostile input ── */
eq('valid payload', parseProtocol({ p: { k: 'poll.vote', o: '2' } }), { k: 'poll.vote', o: '2' });
eq('missing p -> null', parseProtocol({}), null);
eq('bad kind chars -> null', parseProtocol({ p: { k: 'EVIL..x' } }), null);
eq('kind too long -> null', parseProtocol({ p: { k: 'a'.repeat(25) } }), null);
eq('>16 fields -> null', parseProtocol({ p: Object.fromEntries([['k', 'x'], ...Array.from({ length: 16 }, (_, i) => ['f' + i, 1])]) }), null);
eq('string >512 -> null', parseProtocol({ p: { k: 'x', s: 'y'.repeat(513) } }), null);
eq('huge number -> null', parseProtocol({ p: { k: 'x', n: 1e16 } }), null);

/* ── vote tally ── */
eq('latest vote per user wins', tallyVotes([
  { username: 'a', option: '1' }, { username: 'b', option: '2' }, { username: 'a', option: '2' },
]).winner, '2');
eq('lexicographic tiebreak', tallyVotes([
  { username: 'a', option: '2' }, { username: 'b', option: '1' },
]).winner, '1');

/* ── moderators ── */
ok('boulderbadgedad is moderator', isModerator('BoulderBadgeDad'));
ok('random user is not', !isModerator('somefan'));

/* ── hidden messages: moderator-only ── */
eq('non-mod hide ignored', reduceHidden([ev('somefan', { k: 'mod.hide', u: 'x', ts: 't' })]), {});
eq('mod hide applies', reduceHidden([ev('boulderbadgedad', { k: 'mod.hide', u: 'x', ts: 't' })]), { 'x|t': true });
eq('mod unhide clears', reduceHidden([
  ev('boulderbadgedad', { k: 'mod.hide', u: 'x', ts: 't' }),
  ev('boulderbadgedad', { k: 'mod.unhide', u: 'x', ts: 't' }),
]), {});

/* ── pins: moderator-only, cap 8 ── */
{
  const events = [];
  for (let i = 0; i < 10; i++) events.push(ev('boulderbadgedad', { k: 'pin.add', u: 'u', ts: 't' + i, x: 'x' + i }));
  events.push(ev('somefan', { k: 'pin.add', u: 'u', ts: 'tz', x: 'nope' }));
  const pins = reducePins(events);
  eq('pin cap 8, non-mod ignored', pins.length, 8);
  eq('oldest falls off', pins[0].ts, 't2');
  const afterDel = reducePins([...events, ev('boulderbadgedad', { k: 'pin.del', u: 'u', ts: 't9' })]);
  eq('pin.del removes', afterDel.length, 7);
}

/* ── polls ── */
{
  const events = [
    ev('alice', { k: 'poll.start', q: 'best daw?', o1: 'ableton', o2: 'fl', o3: 'reaper' }),
    ev('bob', { k: 'poll.vote', o: '1' }),
    ev('cara', { k: 'poll.vote', o: '2' }),
    ev('bob', { k: 'poll.vote', o: '2' }),
  ];
  const poll = reducePoll(events);
  eq('poll question', poll.q, 'best daw?');
  eq('latest vote wins', poll.tally.counts, { 2: 2 });
  eq('poll winner', poll.tally.winner, '2');
  eq('non-starter cannot end', reducePoll([...events, ev('mallory', { k: 'poll.end' })]).closed, false);
  eq('starter can end', reducePoll([...events, ev('alice', { k: 'poll.end' })]).closed, true);
  eq('mod can end', reducePoll([...events, ev('boulderbadgedad', { k: 'poll.end' })]).closed, true);
  const sv = reducePoll([ev('alice', { k: 'poll.start', q: 'q', o1: 'a', o2: 'b', sv: true }), ev('bob', { k: 'poll.vote', o: '1' })]);
  eq('show-voters attribution', sv.tally.voters, { 1: ['bob'] });
  eq('second start resets', reducePoll([...events, ev('alice', { k: 'poll.start', q: 'q2', o1: 'x', o2: 'y' })]).tally.total, 0);
}

/* ── trivia ── */
{
  const answer = 'Bohemian Rhapsody';
  const h = sha256(normalizeTriviaAnswer(answer));
  const id = 'abc123';
  const t1 = reduceTrivia([ev('alice', { k: 'trv.ask', id, q: 'name the song', h, pot: 50 })]);
  eq('trivia opens', t1.q, 'name the song');
  eq('trivia pot capped', t1.pot, 50);
  const t2 = reduceTrivia([
    ev('alice', { k: 'trv.ask', id, q: 'name the song', h }),
    ev('bob', { k: 'trv.guess', id, a: 'bohemian rhapsody!!' }),
  ], sha256);
  eq('normalized guess wins', t2.winner, 'bob');
  eq('win closes', t2.closed, true);
  const t3 = reduceTrivia([
    ev('alice', { k: 'trv.ask', id, q: 'name the song', h }),
    ev('alice', { k: 'trv.guess', id, a: answer }),
  ], sha256);
  eq('asker cannot win own pot', t3.winner, '');
}

/* ── topic ── */
eq('latest topic wins', reduceTopic([
  ev('a', { k: 'topic.set', t: 'one' }),
  ev('b', { k: 'topic.set', t: 'two' }),
]).t, 'two');
eq('empty clears topic', reduceTopic([ev('a', { k: 'topic.set', t: 'one' }), ev('b', { k: 'topic.set', t: '' })]), null);

/* ── avatars ── */
eq('avatar beacon bounds', reduceAvatars([
  ev('a', { k: 'hello', av: 5 }),
  ev('b', { k: 'hello', av: 999 }),
  ev('c', { k: 'hello', av: 0 }),
], 244), { a: 5 });

/* ── file extraction ── */
{
  const f = extractFileFromText('check this out: https://filepost.dev/abc123 track.flac');
  ok('filepost url extracted', !!f && f.url.includes('filepost.dev'));
  const g = extractFileFromText('https://cdn.example.com/mix.mp3');
  eq('mp3 name + mime', [g.n, g.m], ['mix.mp3', 'audio/mpeg']);
  eq('no url -> null', extractFileFromText('just chatting'), null);
}

/* ── rich text renderer ── */
{
  const r = (t) => renderRichText(t, 'me');
  ok('bold', r('**hi**').includes('<strong>hi</strong>'));
  ok('italic', r('*hi*').includes('<em>hi</em>'));
  ok('code span', r('`x`').includes('<code class="chat-code">x</code>'));
  ok('code block', r('```\nx\n```').includes('chat-codeblock'));
  ok('spoiler', r('||x||').includes('chat-spoiler'));
  ok('shortcode', r(':fire:') === '🔥');
  ok('animated shortcode', r(':a_fire:').includes('chat-anim-emoji'));
  ok('mention self highlighted', r('hey @me').includes('chat-mention--self'));
  ok('mention other', r('hey @bob').includes('chat-mention') && !r('hey @bob').includes('chat-mention--self'));
  ok('xss escaped', !r('<script>alert(1)</script>').includes('<script>'));
  ok('link clickable', r('see https://example.com/a').includes('<a class="chat-link'));
  ok('masked link discloses domain', r('[click](https://evil.example/x)').includes('(evil.example)'));
  ok('ss artist chip', r('ss://artist/spotify/abc123').includes('chat-ss-chip'));
  const rBase = (t) => renderRichText(t, 'me', 'http://127.0.0.1:8099/');
  const chipHtml = rBase('ss://artist/spotify/abc123');
  ok('ss chip uses absolute server url', chipHtml.includes('href="http://127.0.0.1:8099/artist-detail/'));
  ok('ss chip opens new tab', chipHtml.includes('target="_blank"'));
  ok('quote', r('> quoted').includes('chat-quote'));
  ok('jumboji', r('🔥').includes('chat-unicode-jumbo'));
  const p = renderPlainText('<b>hi</b> https://example.com', 'me');
  ok('plain escapes html', !p.includes('<b>'));
  ok('plain keeps links', p.includes('<a class="chat-link'));
}

if (fails) {
  console.error(`${fails} FAILURES`);
  process.exit(1);
}
console.log('ALL CHAT LOGIC TESTS PASSED');
