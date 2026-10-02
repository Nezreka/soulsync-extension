/**
 * SoulSync chat protocol — the pure logic under the room's hidden message bus.
 *
 * Faithful TypeScript port of the deterministic core in SoulSync's
 * webui/static/chat-protocol.js: user classification, protocol parsing
 * (hostile input!), vote tallying, and the pure folds over protocol events
 * (pins, polls, trivia, topic, hidden messages, avatar beacons, now-playing).
 *
 * Excluded on purpose: jukebox (jbx.*), movie night (watch.*), arcade (gm.*),
 * coordinator election — the extension's mini chat does not ship those.
 *
 * Zero DOM, zero fetch — unit-tested in isolation.
 */

export type SoulsyncClass = 'assumed' | 'soulsync' | 'vanilla';

/** The FLIP (Boulder): assume everyone is a SoulSync user until they
 *  demonstrate otherwise. An envelope message proves SoulSync — forever. */
export function classifyUser(current: SoulsyncClass, messageIsRich: boolean): SoulsyncClass {
  if (messageIsRich) return 'soulsync';
  return current === 'soulsync' ? 'soulsync' : 'vanilla';
}

// ── Protocol payload parsing (REMOTE data — trust nothing) ──────────────
// {k: kind, ...} — caps MUST match core/chat_codec.protocol_of:
// kind ≤ 24 chars, ≤ 16 fields, strings ≤ 512 chars, numbers finite < 1e15,
// one level of nesting for plain-object/array values with the same caps.

const KIND_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$/;
const MAX_ABS = 1e15;

function saneScalar(v: unknown): boolean {
  if (typeof v === 'string') return v.length <= 512;
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) < MAX_ABS;
  return typeof v === 'boolean' || v === null;
}

function sanePayload(obj: unknown, depth: number): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  const keys = Object.keys(obj as Record<string, unknown>);
  if (keys.length > 16) return false;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (saneScalar(v)) continue;
    if (depth > 0 && Array.isArray(v)) {
      if (v.length > 32 || !v.every(saneScalar)) return false;
    } else if (depth > 0 && typeof v === 'object' && v !== null) {
      if (!sanePayload(v, depth - 1)) return false;
    } else {
      return false;
    }
  }
  return true;
}

export interface ProtocolPayload {
  k: string;
  [field: string]: unknown;
}

export function parseProtocol(envelope: unknown): ProtocolPayload | null {
  try {
    if (!envelope || typeof envelope !== 'object') return null;
    const p = (envelope as { p?: unknown }).p;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const rec = p as Record<string, unknown>;
    if (typeof rec.k !== 'string' || rec.k.length > 24 || !KIND_RE.test(rec.k)) return null;
    if (!sanePayload(rec, 1)) return null;
    return rec as ProtocolPayload;
  } catch {
    return null;
  }
}

export interface ProtocolEvent {
  username: string;
  timestamp: unknown;
  p: ProtocolPayload;
}

// ── Deterministic vote tally ────────────────────────────────────────────
// Latest vote per user wins (stream order); most votes wins; ties broken by
// lexicographically-smallest option id (stable, no randomness).

export interface VoteTally {
  counts: Record<string, number>;
  winner: string | null;
  total: number;
  voters?: Record<string, string[]>;
}

export function tallyVotes(votes: Array<{ username: unknown; option: unknown }> | null | undefined): VoteTally {
  const byUser: Record<string, string> = {};
  for (const v of votes || []) {
    if (!v || typeof v.username !== 'string' || typeof v.option !== 'string') continue;
    if (!v.username || !v.option || v.option.length > 128) continue;
    byUser[v.username] = v.option;
  }
  const counts: Record<string, number> = {};
  for (const u of Object.keys(byUser)) {
    counts[byUser[u]] = (counts[byUser[u]] || 0) + 1;
  }
  let winner: string | null = null;
  let best = -1;
  for (const opt of Object.keys(counts).sort()) {
    if (counts[opt] > best) {
      best = counts[opt];
      winner = opt;
    }
  }
  return { counts, winner, total: Object.keys(byUser).length };
}

// ── Moderators ──────────────────────────────────────────────────────────
// The slskd sender name on a room message cannot be forged, so every client
// can verify a moderator event locally. Single source both the folds and
// the UI gating read.

export const CHAT_MODERATORS = ['boulderbadgedad'];

export function isModerator(username: unknown): boolean {
  return CHAT_MODERATORS.indexOf(String(username || '').trim().toLowerCase()) !== -1;
}

function streamTs(ev: ProtocolEvent): number | null {
  const t = ev.timestamp;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  const ms = Date.parse(String(t));
  return Number.isFinite(ms) ? ms : null;
}

// mod.hide {u, ts} / mod.unhide {u, ts} → set of 'u|ts' keys every SoulSync
// client renders collapsed. Moderator-only by fold rule.
export function reduceHidden(events: ProtocolEvent[] | null | undefined): Record<string, true> {
  const hidden: Record<string, true> = {};
  for (const ev of events || []) {
    if (!ev || !ev.p || typeof ev.username !== 'string') continue;
    const p = ev.p;
    if (p.k !== 'mod.hide' && p.k !== 'mod.unhide') continue;
    if (!isModerator(ev.username)) continue;
    const u = String(p.u || '');
    const ts = String(p.ts || '');
    if (!u || !ts || u.length > 64 || ts.length > 64) continue;
    if (p.k === 'mod.hide') hidden[u + '|' + ts] = true;
    else delete hidden[u + '|' + ts];
  }
  return hidden;
}

// pin.add {u, ts, x} / pin.del {u, ts} → rolling board of pinned messages
// (dedupe by author|timestamp, cap 8 — oldest falls off). Owner-only pins.
export interface Pin {
  key: string;
  u: string;
  ts: string;
  x: string;
  by: string;
}

export function reducePins(events: ProtocolEvent[] | null | undefined): Pin[] {
  let pins: Pin[] = [];
  for (const ev of events || []) {
    if (!ev || !ev.p || typeof ev.username !== 'string') continue;
    const p = ev.p;
    if (p.k !== 'pin.add' && p.k !== 'pin.del') continue;
    if (!isModerator(ev.username)) continue;
    const u = String(p.u || '');
    const ts = String(p.ts || '');
    if (!u || !ts || u.length > 64 || ts.length > 64) continue;
    const key = u + '|' + ts;
    pins = pins.filter((e) => e.key !== key);
    if (p.k === 'pin.add') {
      pins.push({ key, u, ts, x: String(p.x || '').slice(0, 140), by: ev.username });
      if (pins.length > 8) pins.shift();
    }
  }
  return pins;
}

// poll.start {q, o1..o8, dur, sv} / poll.vote {o} / poll.end {} → ONE active
// poll per room, latest start wins and resets votes; the starter OR a
// moderator can close it.
export interface Poll {
  q: string;
  options: string[];
  by: string;
  at: unknown;
  closed: boolean;
  dur: number;
  endsAt: number;
  sv: boolean;
  tally: VoteTally;
}

export function reducePoll(events: ProtocolEvent[] | null | undefined): Poll | null {
  let poll: Poll | null = null;
  let votes: Array<{ username: string; option: string; timestamp: unknown }> = [];
  for (const ev of events || []) {
    if (!ev || !ev.p || typeof ev.username !== 'string') continue;
    const p = ev.p;
    if (p.k === 'poll.start') {
      const opts: string[] = [];
      for (let i = 1; i <= 8; i++) {
        const o = p['o' + i];
        if (typeof o === 'string' && o.trim()) opts.push(o.trim().slice(0, 80));
      }
      const qq = String(p.q || '').trim().slice(0, 200);
      if (!qq || opts.length < 2) continue;
      const dur =
        typeof p.dur === 'number' && Number.isFinite(p.dur) && p.dur > 0
          ? Math.min(Math.floor(p.dur), 86400)
          : 0;
      const startTs = streamTs(ev);
      poll = {
        q: qq,
        options: opts,
        by: ev.username,
        at: ev.timestamp,
        closed: false,
        dur,
        endsAt: dur && startTs ? startTs + dur * 1000 : 0,
        sv: !!p.sv,
        tally: { counts: {}, winner: null, total: 0 },
      };
      votes = [];
    } else if (p.k === 'poll.vote' && poll && !poll.closed) {
      const idx = String(p.o || '');
      if (/^[1-8]$/.test(idx) && parseInt(idx, 10) <= poll.options.length) {
        votes.push({ username: ev.username, option: idx, timestamp: ev.timestamp });
      }
    } else if (
      p.k === 'poll.end' &&
      poll &&
      (ev.username === poll.by || isModerator(ev.username))
    ) {
      poll.closed = true;
    }
  }
  if (!poll) return null;
  if (poll.endsAt && !poll.closed && Date.now() >= poll.endsAt) poll.closed = true;
  poll.tally = tallyVotes(votes);
  const byUser: Record<string, string> = {};
  for (const v of votes) {
    if (v && v.username && v.option) byUser[v.username] = v.option;
  }
  const voters: Record<string, string[]> = {};
  for (const u of Object.keys(byUser)) {
    const opt = byUser[u];
    if (!voters[opt]) voters[opt] = [];
    voters[opt].push(u);
  }
  poll.tally.voters = voters;
  return poll;
}

// ── Trivia ──────────────────────────────────────────────────────────────
// trv.ask {id, q, h, pot} / trv.guess {id, a} / trv.end {id, ans}.
// Guesses are checked against the SHA-256 commitment hash h via hashFn.

const TRIV_ID_RE = /^[a-z0-9]{4,16}$/;

export function normalizeTriviaAnswer(s: unknown): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[''".,!?;:()\[\]\-–—_/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

export interface TriviaGuess {
  u: string;
  a: string;
  ok: boolean;
}

export interface Trivia {
  id: string;
  q: string;
  h: string;
  pot: number;
  by: string;
  at: number | null;
  guesses: TriviaGuess[];
  winner: string;
  winAnswer: string;
  closed: boolean;
  answer: string;
  verified: boolean;
}

export function reduceTrivia(
  events: ProtocolEvent[] | null | undefined,
  hashFn?: (s: string) => string,
): Trivia | null {
  let t: Trivia | null = null;
  for (const ev of events || []) {
    if (!ev || !ev.p || typeof ev.username !== 'string') continue;
    const p = ev.p;
    if (p.k === 'trv.ask') {
      const id = String(p.id || '');
      if (!TRIV_ID_RE.test(id)) continue;
      const q = String(p.q || '').trim().slice(0, 200);
      const h = String(p.h || '');
      if (!q || !/^[0-9a-f]{16,64}$/.test(h)) continue;
      let pot = 0;
      if (typeof p.pot === 'number' && Number.isFinite(p.pot)) {
        pot = Math.max(0, Math.min(500, Math.floor(p.pot)));
      }
      t = {
        id, q, h, pot, by: ev.username, at: streamTs(ev),
        guesses: [], winner: '', winAnswer: '', closed: false,
        answer: '', verified: false,
      };
    } else if (p.k === 'trv.guess' && t && !t.closed) {
      if (String(p.id || '') !== t.id) continue;
      if (ev.username === t.by) continue; // no winning your own pot
      const a = String(p.a || '').slice(0, 120);
      if (!a.trim()) continue;
      const ok = typeof hashFn === 'function' && hashFn(normalizeTriviaAnswer(a)) === t.h;
      t.guesses.push({ u: ev.username, a, ok });
      if (t.guesses.length > 200) t.guesses.shift();
      if (ok) {
        t.winner = ev.username;
        t.winAnswer = a;
        t.closed = true;
      }
    } else if (p.k === 'trv.end' && t && !t.closed) {
      if (String(p.id || '') !== t.id) continue;
      if (ev.username !== t.by && !isModerator(ev.username)) continue;
      t.closed = true;
      t.answer = String(p.ans || '').slice(0, 120);
      t.verified =
        typeof hashFn === 'function' && hashFn(normalizeTriviaAnswer(t.answer)) === t.h;
    }
  }
  return t;
}

// topic.set {t} → latest wins; empty clears.
export interface Topic {
  t: string;
  by: string;
}

export function reduceTopic(events: ProtocolEvent[] | null | undefined): Topic | null {
  let topic: Topic | null = null;
  for (const ev of events || []) {
    if (!ev || !ev.p || typeof ev.username !== 'string') continue;
    if (ev.p.k !== 'topic.set') continue;
    const t = String(ev.p.t || '').trim().slice(0, 160);
    topic = t ? { t, by: ev.username } : null;
  }
  return topic;
}

// np.set {t, a} → what each user is playing in SoulSync's OWN player
// (latest per user; an empty title means they stopped). This is the
// presence fold only — NOT the jukebox.
export function reduceNowPlaying(
  events: ProtocolEvent[] | null | undefined,
): Record<string, { t: string; a: string }> {
  const np: Record<string, { t: string; a: string }> = {};
  for (const ev of events || []) {
    if (!ev || !ev.p || typeof ev.username !== 'string') continue;
    if (ev.p.k !== 'np.set') continue;
    const t = String(ev.p.t || '').slice(0, 120);
    if (!t) {
      delete np[ev.username];
      continue;
    }
    np[ev.username] = { t, a: String(ev.p.a || '').slice(0, 80) };
  }
  return np;
}

// Preset avatar ids announced by the 'hello' beacon ({k:'hello', av:N}).
// Bounded to the known set: the id INDEXES a fixed list, never a path.
export function reduceAvatars(
  events: ProtocolEvent[] | null | undefined,
  maxId = 99,
): Record<string, number> {
  const out: Record<string, number> = {};
  const cap = typeof maxId === 'number' && maxId > 0 ? maxId : 99;
  for (const ev of events || []) {
    if (!ev || !ev.p || typeof ev.username !== 'string') continue;
    const n = parseInt(String(ev.p.av ?? ''), 10);
    if (n >= 1 && n <= cap) out[ev.username] = n;
  }
  return out;
}

// ── Plain text file extraction (for non-SoulSync chats and DMs) ────────

const AUDIO_EXT = /\.(flac|mp3|m4a|ogg|opus|wav|aiff?)$/i;
const VIDEO_EXT = /\.(mp4|mkv|webm|mov)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;

export interface ExtractedFile {
  n: string;
  m: string;
  url: string;
  textLead: string;
}

export function extractFileFromText(text: unknown): ExtractedFile | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  let m = trimmed.match(/https?:\/\/(?:[a-z0-9-]+\.)?filepost\.dev\/[^\s]+/i);
  if (!m) {
    m = trimmed.match(
      /https?:\/\/[^\s]+?\.(?:flac|mp3|m4a|ogg|opus|wav|aiff?|mp4|mkv|webm|mov)(?:\?[^\s]*)?/i,
    );
  }
  if (!m) return null;
  const url = m[0];
  let textLead = '';
  let name = '';
  const colonMatch = trimmed.match(/^([^:\n]+):\s*(https?:\/\/[^\s]+)$/);
  if (colonMatch) {
    const lead = colonMatch[1].trim();
    if (/\.(flac|mp3|m4a|ogg|opus|wav|aiff?|mp4|mkv|webm|mov|jpe?g|png|gif|webp|zip|tar|gz|pdf|txt)$/i.test(lead)) {
      name = lead;
    } else {
      textLead = lead;
    }
  } else if (trimmed !== url) {
    textLead = trimmed.replace(url, '').replace(/^[:\s-]+|[:\s-]+$/g, '').trim();
  }
  if (!name) {
    const cleanUrl = url.split('?')[0].split('#')[0];
    const parts = cleanUrl.split('/');
    const last = parts[parts.length - 1];
    if (last && last.indexOf('.') !== -1) {
      try {
        name = decodeURIComponent(last);
      } catch {
        name = last;
      }
    } else {
      name = 'shared-file';
    }
  }
  let mime = '';
  if (AUDIO_EXT.test(name)) {
    const ext = name.split('.').pop()!.toLowerCase();
    mime = 'audio/' + (ext === 'mp3' ? 'mpeg' : ext);
  } else if (VIDEO_EXT.test(name)) {
    mime = 'video/' + name.split('.').pop()!.toLowerCase();
  } else if (IMAGE_EXT.test(name)) {
    const iext = name.split('.').pop()!.toLowerCase();
    mime = 'image/' + (iext === 'jpg' ? 'jpeg' : iext);
  }
  return { n: name, m: mime, url, textLead };
}
