/**
 * Mini chat tab for the SoulSync companion popup — the same live chat as the
 * web chat page (rooms, PMs, channels, threads, replies, edits, reactions,
 * typing, mentions, pins, polls, trivia, files, GIFs, cards), minus the
 * jukebox and movie-night surfaces.
 *
 * Transport mirrors the page: 4s poll while this tab is visible, same
 * /api/chat/* endpoints, same envelope field names on send. The deterministic
 * protocol folds (pins/polls/trivia/topic/hidden/avatars) are shared with
 * ../shared/chat-protocol.ts — every client folds the same stream the same way.
 */
import browser from 'webextension-polyfill';
import { getConfig } from '../shared/api';
import type { ServerConfig } from '../shared/types';
import {
  chatStatus, chatRooms, chatAvailableRooms, chatJoinRoom, chatLeaveRoom,
  chatRoom, chatRoomHistory, chatRoomSearch, chatSendRoom, chatSendProtocol,
  chatReact, chatConversations, chatConversation, chatSendPm,
  chatGetSettings, chatSaveSettings, chatGifs, chatUploadFile,
  chatLibrarySearch, chatImportFile, chatUserCard, chatUserNote,
  chatUserShares, chatUserSharesFiles, chatUserDownload, chatLinkPreview,
  chatResolveWantedShare,
  type ChatStatus, type ChatMessage, type ChatRoomData, type ChatConvo,
  type ChatSettings, type ChatFileCard, type RoomSendOptions,
} from '../shared/chat-api';
import {
  classifyUser, parseProtocol, tallyVotes, isModerator,
  reduceHidden, reducePins, reducePoll, reduceTrivia, reduceTopic,
  reduceAvatars, reduceNowPlaying, normalizeTriviaAnswer,
  type ProtocolEvent, type Pin, type Poll, type Trivia, type Topic,
  type SoulsyncClass,
} from '../shared/chat-protocol';
import { EMOJI, EMOJI_CATS, ANIMATED_EMOJI, animEmojiUrl } from '../shared/chat-emoji';

const POLL_MS = 4000;
const LS = {
  tab: 'sschat_last_view',      // "room:<name>" | "pm:<user>"
  chan: 'sschat_chan',          // last channel per room
  chanSeen: 'sschat_chanseen',  // {room: {chan: ts}}
  hiddenDm: 'sschat_hidden_dm', // [usernames]
  recentEmoji: 'sschat_recent_emoji',
  pollDismiss: 'sschat_poll_dismiss',
};

const CHAT_CHANNELS = [
  { cat: 'Community', items: [{ slug: 'general', name: 'general' }, { slug: 'off-topic', name: 'off-topic' }] },
  { cat: 'Support', items: [{ slug: 'help', name: 'help' }, { slug: 'bugs', name: 'bugs' }, { slug: 'ideas', name: 'ideas' }] },
];
const DEFAULT_CHANNEL = 'general';

// ── small helpers ────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hue(name: string): number {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function msgKey(m: ChatMessage): string {
  return (m.username || '') + '|' + (m.timestamp || '') + '|' + (m.message || '');
}

function parseTs(ts: unknown): Date | null {
  const d = new Date(String(ts || '').replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function fmtTime(ts: unknown): string {
  const d = parseTs(ts);
  return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

function dayLabel(ts: unknown): string {
  const d = parseTs(ts);
  return d ? d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : '';
}

function chanKnown(slug: string): boolean {
  return CHAT_CHANNELS.some((c) => c.items.some((i) => i.slug === slug));
}

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, val: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch { /* private mode */ }
}

// ── rich text (markdown subset — port of the chat page's renderRich) ─────
// EVERYTHING here is remote input: escape FIRST, then format the escaped
// text. Code spans and URLs are pulled into \u0000 placeholders first.

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const IMG_RE = /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i;
const GIF_CDN_RE = /^https?:\/\/((media|c)\.tenor\.com|media\d*\.giphy\.com)\//i;
const MENTION_RE = /@([A-Za-z0-9_.-]{2,32})\b/g;
const SS_PATH_RE = /\/(artist-detail\/[a-z0-9_-]{1,32}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}|video-detail\/tmdb\/(?:movie|show)\/\d{1,10})(?:$|[?#])/;

function trimUrl(u: string): string {
  const m = u.match(/[.,;:!?)\]]+$/);
  return m ? u.slice(0, -m[0].length) : u;
}

function classifyUrl(u: string): { cls: string; brand: string } {
  const raw = u.replace(/&amp;/g, '&').toLowerCase();
  if (raw.includes('youtube.com') || raw.includes('youtu.be')) return { cls: 'chat-link--yt', brand: 'YouTube' };
  if (raw.includes('spotify.com')) return { cls: 'chat-link--spotify', brand: 'Spotify' };
  if (raw.includes('soundcloud.com')) return { cls: 'chat-link--sc', brand: 'SoundCloud' };
  if (raw.includes('bandcamp.com')) return { cls: 'chat-link--bc', brand: 'BandCamp' };
  if (raw.includes('deezer.com')) return { cls: 'chat-link--dz', brand: 'Deezer' };
  if (raw.includes('music.apple.com')) return { cls: 'chat-link--apple', brand: 'Apple Music' };
  if (raw.includes('github.com')) return { cls: 'chat-link--github', brand: 'GitHub' };
  if (raw.includes('wikipedia.org')) return { cls: 'chat-link--wiki', brand: 'Wikipedia' };
  if (raw.includes('reddit.com')) return { cls: 'chat-link--reddit', brand: 'Reddit' };
  return { cls: 'chat-link--web', brand: '' };
}

function linkHtml(u: string): string {
  const info = classifyUrl(u);
  return `<a class="chat-link ${info.cls}" href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`;
}

function ytId(u: string): string | null {
  const raw = u.replace(/&amp;/g, '&');
  const m =
    raw.match(/youtube\.com\/watch\?(?:[^\s&]*&)*v=([A-Za-z0-9_-]{6,20})/) ||
    raw.match(/youtu\.be\/([A-Za-z0-9_-]{6,20})/) ||
    raw.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,20})/);
  return m ? m[1] : null;
}

function ssChip(path: string, label: string, base: string): string {
  const href = (base || '') + path;
  return ` <a class="chat-embed-chip chat-ss-chip" href="${href}" target="_blank" rel="noopener noreferrer" title="Open in SoulSync">↪ ${label}</a>`;
}

function linkWithEmbeds(u: string, base: string): string {
  if (GIF_CDN_RE.test(u)) {
    return `<img class="chat-embed-img chat-gif" loading="lazy" referrerpolicy="no-referrer" src="${u}" alt="GIF">`;
  }
  let html = linkHtml(u);
  const yt = ytId(u);
  if (yt) {
    return (
      html +
      ` <button type="button" class="chat-embed-chip chat-embed-chip--yt" data-yt="${yt}" title="Play YouTube video inline">▶ play</button>`
    );
  }
  if (IMG_RE.test(u)) {
    return (
      html +
      ` <button type="button" class="chat-embed-chip" data-img="${u}" title="Load this image (reveals your IP to its host)">🖼 show</button>`
    );
  }
  const m = u.replace(/&amp;/g, '&').match(SS_PATH_RE);
  if (m) {
    const path = '/' + m[1];
    const label = path.startsWith('/artist-detail/')
      ? '🎵 open artist'
      : path.includes('/movie/') ? '🎬 open movie' : '📺 open show';
    html += ssChip(path, label, base);
  }
  return html;
}

function extractInto(s: string, re: RegExp, hold: string[], fn: (m: string, g1: string) => string): string {
  return s.replace(re, (m: string, g1: string) => {
    hold.push(fn(m, g1));
    return '\u0000' + (hold.length - 1) + '\u0000';
  });
}

function restore(s: string, hold: string[]): string {
  return s.replace(/\u0000(\d+)\u0000/g, (_: string, i: string) => hold[Number(i)]);
}

function isJumboji(text: string): boolean {
  const t = String(text || '').trim().replace(/:[a-z0-9_+-]+:/g, '').trim();
  if (!t) return false;
  try {
    const stripped = t.replace(/(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\u200d|[\uFE0E\uFE0F]|\s)/gu, '');
    return stripped.length === 0 && t.length <= 30;
  } catch {
    return false;
  }
}

function shortcodeHtml(name: string, jumbo: boolean): string | null {
  if (ANIMATED_EMOJI[name]) {
    const cls = 'chat-anim-emoji' + (jumbo ? ' chat-anim-emoji--jumbo' : '');
    return `<img class="${cls}" src="${animEmojiUrl(name)}" alt=":${name}:" loading="lazy">`;
  }
  if (EMOJI[name]) {
    return jumbo ? `<span class="chat-unicode-jumbo">${EMOJI[name]}</span>` : EMOJI[name];
  }
  return null;
}

function mentionify(s: string, selfName: string): string {
  const selfLower = selfName.toLowerCase();
  return s.replace(MENTION_RE, (_m: string, name: string) => {
    const me = !!selfLower && name.toLowerCase() === selfLower;
    return `<span class="chat-mention${me ? ' chat-mention--self' : ''}" data-user="${esc(name)}">@${esc(name)}</span>`;
  });
}

function applyShortcodes(s: string, jumbo: boolean): string {
  return s.replace(/:([a-z0-9_+-]+):/g, (m: string, name: string) => shortcodeHtml(name, jumbo) ?? m);
}

function jumboWrap(s: string): string {
  try {
    return s.replace(/(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\u200d|[\uFE0E\uFE0F])+/gu, (m: string) => {
      return `<span class="chat-unicode-jumbo">${m}</span>`;
    });
  } catch {
    return s;
  }
}

export function renderPlainText(text: string, selfName: string, serverBase = ''): string {
  const hold: string[] = [];
  const base = serverBase.replace(/\/+$/, '');
  let s = extractInto(esc(String(text ?? '').replace(/\u0000/g, '')), URL_RE, hold, (m) => {
    const u = trimUrl(m);
    return linkWithEmbeds(u, base) + m.slice(u.length);
  });
  s = mentionify(s, selfName);
  const jumbo = isJumboji(text);
  s = applyShortcodes(s, jumbo);
  if (jumbo) s = jumboWrap(s);
  return restore(s, hold).replace(/\n/g, '<br>');
}

export function renderRichText(text: string, selfName: string, serverBase = ''): string {
  const hold: string[] = [];
  const base = serverBase.replace(/\/+$/, '');
  let s = esc(String(text ?? '').replace(/\u0000/g, ''));
  s = extractInto(s, /```\n?([\s\S]+?)\n?```/g, hold, (_m, c) => `<pre class="chat-codeblock">${c}</pre>`);
  s = extractInto(s, /`([^`\n]+)`/g, hold, (_m, c) => `<code class="chat-code">${c}</code>`);
  s = extractInto(s, /\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g, hold, (m) => {
    const mm = m.match(/^\[([^\]]+)\]\((.+)\)$/);
    if (!mm) return m;
    const info = classifyUrl(mm[2]);
    const host = (mm[2].match(/^https?:\/\/([^/?#\s]+)/i) || [])[1] || '';
    return `<a class="chat-link ${info.cls}" href="${mm[2]}" target="_blank" rel="noopener noreferrer">${mm[1]}</a><span class="chat-link-domain">(${esc(host)})</span>`;
  });
  s = extractInto(s, URL_RE, hold, (m) => {
    const u = trimUrl(m);
    return linkWithEmbeds(u, base) + m.slice(u.length);
  });
  s = extractInto(
    s,
    /ss:\/\/(artist\/[a-z0-9_-]{1,32}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}|(?:movie|show)\/\d{1,10})\b/g,
    hold,
    (_m, g1) => {
      if (g1.startsWith('artist/')) return ssChip('/artist-detail/' + g1.slice(7), '🎵 open artist', base);
      const kind = g1.split('/')[0];
      return ssChip('/video-detail/tmdb/' + g1, kind === 'movie' ? '🎬 open movie' : '📺 open show', base);
    },
  );
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  s = s.replace(/\*([^*\\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '<span class="chat-spoiler" title="Spoiler — click to reveal">$1</span>');
  const jumbo = isJumboji(text);
  s = applyShortcodes(s, jumbo);
  if (jumbo) s = jumboWrap(s);
  s = mentionify(s, selfName);
  s = s.split('\n').map((line) => {
    if (line.startsWith('### ')) return `<span class="chat-h3">${line.slice(4)}</span>`;
    if (line.startsWith('## ')) return `<span class="chat-h2">${line.slice(3)}</span>`;
    if (line.startsWith('# ')) return `<span class="chat-h1">${line.slice(2)}</span>`;
    if (line.startsWith('&gt; ')) return `<span class="chat-quote">${line.slice(5)}</span>`;
    if (line.startsWith('- ')) return `<span class="chat-li">•&nbsp;${line.slice(2)}</span>`;
    return line;
  }).join('\n');
  return restore(s.replace(/\n/g, '<br>'), hold);
}

function mentionsMe(text: string, selfName: string): boolean {
  if (!selfName) return false;
  const re = new RegExp('@' + selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_.-])', 'i');
  return re.test(String(text || ''));
}

// ── ChatTab ─────────────────────────────────────────────────────────────

interface ChatState {
  view: 'room' | 'pm';
  room: string;
  pmUser: string;
  homeRoom: string;
  rooms: Array<{ name: string; home: boolean }>;
  canManage: boolean;
  canSend: boolean;
  isAdmin: boolean;
  selfName: string;
  configured: boolean;
  connectionError: string | null;
  users: string[];
  convos: ChatConvo[];
  hiddenDms: Set<string>;
  msgs: ChatMessage[];
  pmMsgs: ChatMessage[];
  protocol: ProtocolEvent[];
  loadingOlder: boolean;
  historyDone: boolean;
  stickBottom: boolean;
  channel: string;
  chanSeen: Record<string, Record<string, string>>;
  thread: { id: string; name: string } | null;
  replyTo: { u: string; x: string } | null;
  editing: { key: string; text: string } | null;
  pinsOpen: boolean;
  searchOpen: boolean;
  searchQuery: string;
  searchResults: ChatMessage[];
  typing: Record<string, number>;
  lastTypSentAt: number;
  pendingPm: Array<{ user: string; text: string; at: number }>;
  failStreak: number;
  beaconed: Record<string, boolean>;
  lastTs: string | null; // newest message ts rendered (mention ping gate)
  newMarker: string | null;
  renderedCount: number;
}

function defaultState(): ChatState {
  return {
    view: 'room', room: '', pmUser: '', homeRoom: '',
    rooms: [], canManage: false, canSend: false, isAdmin: false,
    selfName: '', configured: false, connectionError: null,
    users: [], convos: [], hiddenDms: new Set(readLS<string[]>(LS.hiddenDm, [])),
    msgs: [], pmMsgs: [], protocol: [],
    loadingOlder: false, historyDone: false, stickBottom: true,
    channel: DEFAULT_CHANNEL, chanSeen: readLS(LS.chanSeen, {}),
    thread: null, replyTo: null, editing: null,
    pinsOpen: false, searchOpen: false, searchQuery: '', searchResults: [],
    typing: {}, lastTypSentAt: 0, pendingPm: [], failStreak: 0,
    beaconed: {}, lastTs: null, newMarker: null, renderedCount: 0,
  };
}

export class ChatTab {
  private cfg: ServerConfig | null = null;
  private els: Record<string, HTMLElement> = {};
  private s: ChatState = defaultState();
  private active = false;
  private timer: number | null = null;
  private booted = false;
  private typingTimer: number | null = null;
  private avatarMap: Record<string, number> = {};
  private pollDismissed = new Set<string>();
  private settings: ChatSettings | null = null;

  mount(host: HTMLElement): void {
    host.innerHTML = `
      <div class="chat-wrap">
        <div class="chat-rail" id="chat-rail"></div>
        <div class="chat-main">
          <div class="chat-head">
            <div class="chat-head-top">
              <div class="chat-title" id="chat-title">#general</div>
              <div class="chat-head-actions">
                <button class="chat-icon-btn" id="chat-pins-btn" title="Pinned messages">📌</button>
                <button class="chat-icon-btn" id="chat-search-btn" title="Search messages">🔍</button>
                <button class="chat-icon-btn" id="chat-settings-btn" title="Chat settings" hidden>⚙️</button>
              </div>
            </div>
            <div class="chat-channels" id="chat-channels" hidden></div>
            <div class="chat-topic" id="chat-topic" hidden></div>
          </div>
          <div class="chat-pins" id="chat-pins" hidden></div>
          <div class="chat-threadbar" id="chat-threadbar" hidden></div>
          <div class="chat-active" id="chat-active" hidden></div>
          <div class="chat-searchbar" id="chat-searchbar" hidden>
            <input id="chat-search-input" type="text" placeholder="Search this room…" />
            <button class="chat-icon-btn" id="chat-search-close" title="Close search">✕</button>
          </div>
          <div class="chat-messages" id="chat-messages"></div>
          <div class="chat-typing" id="chat-typing"></div>
          <div class="chat-composer">
            <div class="chat-replybar" id="chat-replybar" hidden></div>
            <div class="chat-editbar" id="chat-editbar" hidden></div>
            <div class="chat-mentionpop" id="chat-mentionpop" hidden></div>
            <div class="chat-inputrow">
              <textarea id="chat-input" rows="1" placeholder="Message…"></textarea>
              <button class="chat-icon-btn" id="chat-emoji-btn" title="Emoji">😀</button>
              <button class="chat-icon-btn" id="chat-gif-btn" title="GIF">GIF</button>
              <button class="chat-icon-btn" id="chat-attach-btn" title="Attach">📎</button>
              <button class="chat-icon-btn" id="chat-poll-btn" title="Start a poll">📊</button>
              <button class="chat-send" id="chat-send" title="Send">➤</button>
            </div>
            <div class="chat-statusline" id="chat-statusline" hidden></div>
          </div>
        </div>
      </div>
      <div class="chat-pop" id="chat-pop" hidden></div>
      <div class="chat-modal" id="chat-modal" hidden></div>`;
    const q = <T extends HTMLElement>(id: string): T => {
      const el = host.querySelector<T>('#' + id);
      if (!el) throw new Error('chat: missing #' + id);
      return el;
    };
    for (const id of ['chat-rail', 'chat-title', 'chat-channels', 'chat-topic', 'chat-pins',
      'chat-threadbar', 'chat-active', 'chat-searchbar', 'chat-search-input', 'chat-search-close',
      'chat-messages', 'chat-typing', 'chat-replybar', 'chat-editbar', 'chat-mentionpop',
      'chat-input', 'chat-emoji-btn', 'chat-gif-btn', 'chat-attach-btn', 'chat-poll-btn',
      'chat-send', 'chat-statusline', 'chat-pins-btn', 'chat-search-btn', 'chat-settings-btn',
      'chat-pop', 'chat-modal']) {
      this.els[id] = q(id);
    }
    this.bind(host);
    this.renderShell();
  }

  /** Called by popup.ts when the Chat tab becomes visible/hidden. */
  setActive(on: boolean): void {
    this.active = on;
    if (on) {
      if (!this.booted) void this.boot();
      this.armPoller();
    } else {
      this.disarmPoller();
    }
  }

  private armPoller(): void {
    this.disarmPoller();
    if (!this.active) return;
    this.timer = window.setInterval(() => void this.tick(), POLL_MS);
    // Typing indicators expire on a slower cadence than the poll.
    this.typingTimer = window.setInterval(() => this.renderTyping(), 5000);
    void this.tick();
  }

  private disarmPoller(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.typingTimer !== null) {
      window.clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  // ── boot ────────────────────────────────────────────────────────────

  private async boot(): Promise<void> {
    this.booted = true;
    this.cfg = await getConfig();
    if (!this.cfg) {
      this.els['chat-messages'].innerHTML =
        `<div class="chat-empty">Point the extension at your SoulSync server first (Settings → Server).</div>`;
      return;
    }
    try {
      const st = await chatStatus(this.cfg);
      this.applyStatus(st);
      // Avatar + flair badge ride our sends — load them for admins (the
      // settings endpoint is admin-only).
      if (st.is_admin) {
        this.settings = await chatGetSettings(this.cfg).catch(() => null);
      }
      await this.loadRail();
      // Restore last view.
      const last = readLS<string | null>(LS.tab, null);
      if (last && last.startsWith('pm:')) {
        const user = last.slice(3);
        this.openPm(user, true);
      } else {
        const room = (last && last.startsWith('room:') ? last.slice(5) : '') || st.room || this.s.homeRoom;
        this.openRoom(room || 'SoulSync', true);
      }
      this.armPoller();
    } catch (e) {
      this.s.connectionError = e instanceof Error ? e.message : String(e);
      this.renderStatusLine();
    }
  }

  private applyStatus(st: ChatStatus): void {
    const s = this.s;
    s.configured = st.configured;
    s.canSend = st.can_send;
    s.isAdmin = st.is_admin;
    s.selfName = st.username || '';
    s.connectionError = st.connected ? null : (st.error || 'Soulseek is not connected');
    if (!s.room && st.room) s.room = st.room;
    (this.els['chat-settings-btn'] as HTMLButtonElement).hidden = !st.is_admin;
    this.renderStatusLine();
  }

  private renderStatusLine(): void {
    const el = this.els['chat-statusline'];
    const err = this.s.connectionError;
    if (!this.cfg) {
      el.hidden = true;
      return;
    }
    if (!this.s.configured) {
      el.hidden = false;
      el.textContent = 'Soulseek chat is not configured on this server.';
      return;
    }
    if (err) {
      el.hidden = false;
      el.textContent = '⚠ ' + err;
      return;
    }
    el.hidden = true;
  }

  private async loadRail(): Promise<void> {
    if (!this.cfg) return;
    try {
      const [rooms, convos] = await Promise.all([
        chatRooms(this.cfg).catch(() => ({ home: '', rooms: [], can_manage: false })),
        chatConversations(this.cfg).catch(() => ({ conversations: [], can_send: false })),
      ]);
      this.s.homeRoom = rooms.home;
      this.s.rooms = rooms.rooms;
      this.s.canManage = rooms.can_manage;
      this.s.convos = convos.conversations;
      if (!this.s.room && rooms.home) this.s.room = rooms.home;
      this.renderRail();
    } catch { /* rail refreshes on the next tick */ }
  }

  // ── polling ─────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.active || !this.cfg || !this.booted) return;
    const cfg = this.cfg;
    try {
      if (this.s.view === 'room' && this.s.room) {
        const d: ChatRoomData = await chatRoom(cfg, this.s.room);
        this.ingestRoom(d);
      } else if (this.s.view === 'pm' && this.s.pmUser) {
        const d = await chatConversation(cfg, this.s.pmUser);
        this.ingestPm(d.messages);
      }
      // Rail dots every tick, like the page.
      const convos = await chatConversations(cfg).catch(() => null);
      if (convos) {
        this.s.convos = convos.conversations;
        this.renderRail();
      }
      this.s.failStreak = 0;
    } catch (e) {
      this.s.failStreak++;
      if (this.s.failStreak >= 3 && !this.s.connectionError) {
        this.s.connectionError = e instanceof Error ? e.message : 'Poll failed';
        this.renderStatusLine();
      }
    }
  }

  private ingestRoom(d: ChatRoomData): void {
    const s = this.s;
    if (d.room !== s.room) return;
    s.canSend = d.can_send;
    s.users = d.users || [];
    if (!d.joined) {
      s.msgs = [];
      s.protocol = [];
      this.renderAll();
      return;
    }
    // Merge archive + live tail, newest last, deduped by key.
    const seen = new Map<string, ChatMessage>();
    for (const m of [...s.msgs, ...d.messages]) seen.set(msgKey(m), m);
    const merged = [...seen.values()].sort((a, b) => String(a.timestamp || '') < String(b.timestamp || '') ? -1 : 1);
    const prevLast = s.lastTs;
    s.msgs = merged.slice(-300);
    s.protocol = d.protocol || [];
    this.avatarMap = reduceAvatars(s.protocol, 244);
    const newest = s.msgs[s.msgs.length - 1];
    const newLast = newest ? String(newest.timestamp || '') : null;
    // Mention ping: only for messages newer than what we've rendered.
    if (newLast && prevLast && newLast !== prevLast) {
      for (const m of s.msgs) {
        if (String(m.timestamp || '') > prevLast && m.username !== s.selfName && mentionsMe(m.message, s.selfName)) {
          this.ping();
          break;
        }
      }
    }
    if (newLast) {
      s.lastTs = newLast;
      // We're looking at this room: advance the stored seen marker (drives
      // the NEW divider next time the room opens).
      try {
        localStorage.setItem('sschat_seen_' + s.room, JSON.stringify(newLast));
      } catch { /* private mode */ }
    }
    // Typing indicators ride the protocol feed as {k:'typ'} carriers.
    // Only fresh carriers arm the indicator: the timestamp comes from the
    // event itself, never Date.now(), so a stale carrier that lingers in
    // the protocol array expires instead of refreshing forever.
    let typingChanged = false;
    for (const ev of s.protocol) {
      if (ev && ev.p && ev.p.k === 'typ' && typeof ev.username === 'string' && ev.username !== s.selfName) {
        const at = parseTs(ev.timestamp)?.getTime() || 0;
        if (at && (!s.typing[ev.username] || at > s.typing[ev.username])) {
          s.typing[ev.username] = at;
          typingChanged = true;
        }
      }
    }
    if (typingChanged) this.renderTyping();
    this.renderAll();
  }

  private ingestPm(messages: ChatMessage[]): void {
    const s = this.s;
    // Drop pending echoes the server has now echoed back.
    const texts = new Set(messages.map((m) => (m.username || '') + '|' + (m.message || '')));
    s.pendingPm = s.pendingPm.filter((p) => !texts.has(s.selfName + '|' + p.text) && Date.now() - p.at < 45000);
    s.pmMsgs = messages;
    this.renderAll();
  }

  // ── view switching ──────────────────────────────────────────────────

  openRoom(name: string, silent = false): void {
    const s = this.s;
    s.view = 'room';
    s.room = name;
    s.pmUser = '';
    s.msgs = [];
    s.protocol = [];
    s.thread = null;
    s.replyTo = null;
    s.editing = null;
    s.historyDone = false;
    s.stickBottom = true;
    s.lastTs = null;
    // Freeze the NEW divider at what we'd seen before opening.
    try {
      const raw = localStorage.getItem('sschat_seen_' + name);
      s.newMarker = raw ? (JSON.parse(raw) as string) : null;
    } catch {
      s.newMarker = null;
    }
    const chans = readLS<Record<string, string>>(LS.chan, {});
    s.channel = chans[name] || DEFAULT_CHANNEL;
    writeLS(LS.tab, 'room:' + name);
    if (!silent) void this.tick();
    this.renderAll();
    this.sendHelloBeacon();
  }

  openPm(user: string, silent = false): void {
    const s = this.s;
    s.view = 'pm';
    s.pmUser = user;
    s.room = '';
    s.pmMsgs = [];
    s.replyTo = null;
    s.editing = null;
    s.stickBottom = true;
    s.lastTs = null;
    writeLS(LS.tab, 'pm:' + user);
    if (!silent) void this.tick();
    this.renderAll();
  }

  private async sendHelloBeacon(): Promise<void> {
    // Announce presence once per room per session (powers the SoulSync-user
    // classification + avatar beacons for silent joiners).
    const s = this.s;
    if (!this.cfg || !s.canSend || !s.room || s.beaconed[s.room] || !this.settings) return;
    const av = this.settings.avatar || 0;
    if (!av) return;
    s.beaconed[s.room] = true;
    try {
      await chatSendProtocol(this.cfg, s.room, { k: 'hello', av });
    } catch {
      s.beaconed[s.room] = false;
    }
  }

  // ── rail ────────────────────────────────────────────────────────────

  private renderRail(): void {
    const s = this.s;
    const rail = this.els['chat-rail'];
    const rooms = s.rooms.length ? s.rooms : [{ name: s.homeRoom || s.room || 'SoulSync', home: true }];
    let html = '<div class="chat-rail-label">Rooms</div>';
    html += rooms.map((r) => {
      const on = s.view === 'room' && s.room === r.name;
      const initials = r.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '#';
      return `<button class="chat-guild${on ? ' chat-guild--on' : ''}" type="button" data-open-room="${esc(r.name)}" title="${esc(r.name)}">${r.home ? '🎵' : esc(initials)}</button>`;
    }).join('');
    if (s.canManage) {
      html += `<button class="chat-guild chat-guild--add" type="button" data-room-browser title="Browse / join rooms">＋</button>`;
    }
    html += '<div class="chat-rail-label">DMs</div>';
    const visible = s.convos.filter((c) => !s.hiddenDms.has(c.username));
    html += visible.map((c) => {
      const on = s.view === 'pm' && s.pmUser === c.username;
      const dot = c.unread ? '<span class="chat-dot"></span>' : '';
      return `<button class="chat-guild chat-guild--dm${on ? ' chat-guild--on' : ''}" type="button" data-open-pm="${esc(c.username)}" title="${esc(c.username)}">${dot}${esc(c.username.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?')}</button>`;
    }).join('');
    rail.innerHTML = html;
  }

  private chanRoom(): boolean {
    const s = this.s;
    return s.view === 'room' && (!s.homeRoom || s.room === s.homeRoom);
  }

  private msgChannel(m: ChatMessage): string {
    const c = typeof m.chan === 'string' ? m.chan : '';
    return chanKnown(c) ? c : DEFAULT_CHANNEL;
  }

  private chanUnread(): Record<string, number> {
    const s = this.s;
    const counts: Record<string, number> = {};
    const seen = s.chanSeen[s.room] || {};
    for (const m of s.msgs) {
      if (!m || m.username === s.selfName) continue;
      const c = this.msgChannel(m);
      if (c === s.channel) continue;
      const ts = String(m.timestamp || '');
      if (seen[c] && ts <= seen[c]) continue;
      counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }

  // ── shell / events ────────────────────────────────────────────────

  private renderShell(): void {
    this.renderRail();
    this.renderHead();
    this.renderThreadbar();
    this.renderActive();
    this.renderReplybar();
    this.renderMessages();
  }

  private renderAll(): void {
    if (!this.active) return;
    this.renderRail();
    this.renderHead();
    this.renderThreadbar();
    this.renderActive();
    this.renderReplybar();
    this.renderMessages();
    this.renderTyping();
  }

  private bind(host: HTMLElement): void {
    const s = this.s;
    const on = (id: string, evt: string, fn: (e: Event) => void) => {
      this.els[id].addEventListener(evt, fn);
    };

    host.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (t) {
        this.handleAction(t.dataset.act || '', t.dataset, t, e);
        return;
      }
      const roomBtn = (e.target as HTMLElement).closest('[data-open-room]') as HTMLElement | null;
      if (roomBtn) {
        this.openRoom(roomBtn.dataset.openRoom || '');
        return;
      }
      const pmBtn = (e.target as HTMLElement).closest('[data-open-pm]') as HTMLElement | null;
      if (pmBtn) {
        this.openPm(pmBtn.dataset.openPm || '');
        return;
      }
      if ((e.target as HTMLElement).closest('[data-room-browser]')) {
        void this.openRoomBrowser();
        return;
      }
      const userEl = (e.target as HTMLElement).closest('[data-user]') as HTMLElement | null;
      if (userEl && !((e.target as HTMLElement).closest('a'))) {
        this.openUserCard(userEl.dataset.user || '');
        return;
      }
      // Clicking a message selects it for the hover actions (popup-friendly:
      // no hover on touch, so tap = select).
      const msgEl = (e.target as HTMLElement).closest('[data-msg]') as HTMLElement | null;
      if (msgEl) {
        const prev = host.querySelector('.chat-msg--sel');
        if (prev) prev.classList.remove('chat-msg--sel');
        if (prev !== msgEl) msgEl.classList.add('chat-msg--sel');
      }
      // Spoiler reveal.
      const sp = (e.target as HTMLElement).closest('.chat-spoiler') as HTMLElement | null;
      if (sp) sp.classList.toggle('chat-spoiler--open');
      // Click-to-load embeds.
      const yt = (e.target as HTMLElement).closest('[data-yt]') as HTMLElement | null;
      if (yt) {
        const id = yt.dataset.yt || '';
        yt.outerHTML = `<span class="chat-yt"><iframe width="100%" height="180" src="https://www.youtube.com/embed/${esc(id)}" frameborder="0" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></span>`;
        return;
      }
      const img = (e.target as HTMLElement).closest('[data-img]') as HTMLElement | null;
      if (img) {
        const u = img.dataset.img || '';
        img.outerHTML = `<img class="chat-embed-img" loading="lazy" referrerpolicy="no-referrer" src="${esc(u)}" alt="">`;
      }
    });

    // Autoscroll pinning.
    const msgs = this.els['chat-messages'] as HTMLElement;
    msgs.addEventListener('scroll', () => {
      const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
      s.stickBottom = nearBottom;
      this.renderJumpPill();
      // Scrollback: near the top → load older.
      if (msgs.scrollTop < 80) this.loadOlder();
    });

    // Composer.
    const input = this.els['chat-input'] as HTMLTextAreaElement;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      } else if (e.key === 'Escape') {
        if (s.editing) this.cancelEdit();
        else if (s.replyTo) this.cancelReply();
        else this.closePop();
      } else {
        this.maybeSendTyping();
        // Debounced mention autocomplete + shortcode hint.
        window.setTimeout(() => this.updateMentionPop(), 0);
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 96) + 'px';
    });
    on('chat-send', 'click', () => void this.send());
    on('chat-emoji-btn', 'click', () => this.toggleEmojiPicker());
    on('chat-gif-btn', 'click', () => this.toggleGifPicker());
    on('chat-attach-btn', 'click', () => this.toggleAttachMenu());
    on('chat-poll-btn', 'click', () => this.openPollCreator());
    on('chat-pins-btn', 'click', () => {
      s.pinsOpen = !s.pinsOpen;
      this.renderActive();
    });
    on('chat-search-btn', 'click', () => this.toggleSearch());
    on('chat-search-close', 'click', () => this.toggleSearch(false));
    on('chat-settings-btn', 'click', () => void this.openSettings());
    const searchInput = this.els['chat-search-input'] as HTMLInputElement;
    let searchTimer: number | null = null;
    searchInput.addEventListener('input', () => {
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => void this.runSearch(searchInput.value), 350);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toggleSearch(false);
    });
  }

  /** Delegated data-act handler for message action buttons. */
  private handleAction(act: string, ds: DOMStringMap, el: HTMLElement, e: Event): void {
    const s = this.s;
    switch (act) {
      case 'chan': {
        const slug = ds.slug || DEFAULT_CHANNEL;
        s.channel = slug;
        s.thread = null;
        const chans = readLS<Record<string, string>>(LS.chan, {});
        chans[s.room] = slug;
        writeLS(LS.chan, chans);
        this.markChanSeen(slug);
        this.renderAll();
        break;
      }
      case 'thread-open': {
        s.thread = { id: ds.th || '', name: ds.tn || 'Thread' };
        this.renderAll();
        break;
      }
      case 'thread-close':
        s.thread = null;
        this.renderAll();
        break;
      case 'reply': {
        const m = this.findMsg(ds.key || '');
        if (m) {
          s.replyTo = { u: m.username, x: this.displayText(m) };
          s.editing = null;
          this.renderReplybar();
          (this.els['chat-input'] as HTMLTextAreaElement).focus();
        }
        break;
      }
      case 'reply-cancel':
        this.cancelReply();
        break;
      case 'reply-jump': {
        const target = (this.els['chat-messages'] as HTMLElement).querySelector(`[data-key="${CSS.escape(ds.key || '')}"]`);
        if (target) target.scrollIntoView({ block: 'center' });
        break;
      }
      case 'edit': {
        const m = this.findMsg(ds.key || '');
        if (m && m.username === s.selfName) {
          s.editing = { key: msgKey(m), text: m.message };
          s.replyTo = null;
          (this.els['chat-input'] as HTMLTextAreaElement).value = m.message;
          this.renderReplybar();
          (this.els['chat-input'] as HTMLTextAreaElement).focus();
        }
        break;
      }
      case 'edit-cancel':
        this.cancelEdit();
        break;
      case 'react': {
        const m = this.findMsg(ds.key || '');
        if (m) this.toggleReactPicker(m);
        break;
      }
      case 'react-pick': {
        const m = this.findMsg(ds.key || '');
        if (m) void this.sendReaction(m, ds.emoji || '❤️');
        this.closePop();
        break;
      }
      case 'pin': {
        const m = this.findMsg(ds.key || '');
        if (m && this.cfg && isModerator(s.selfName)) {
          void chatSendProtocol(this.cfg, s.room, {
            k: 'pin.add', u: m.username, ts: String(m.timestamp || ''), x: m.message.slice(0, 140),
          }).then(() => void this.tick());
        }
        break;
      }
      case 'unpin':
        if (this.cfg && isModerator(s.selfName)) {
          void chatSendProtocol(this.cfg, s.room, { k: 'pin.del', u: ds.u || '', ts: ds.ts || '' })
            .then(() => void this.tick());
        }
        break;
      case 'pin-jump': {
        const target = (this.els['chat-messages'] as HTMLElement).querySelector(`[data-key="${CSS.escape(ds.key || '')}"]`);
        if (target) target.scrollIntoView({ block: 'center' });
        break;
      }
      case 'poll-vote':
        if (this.cfg && s.view === 'room') {
          void chatSendProtocol(this.cfg, s.room, { k: 'poll.vote', o: ds.o || '' }).then(() => void this.tick());
        }
        break;
      case 'poll-end':
        if (this.cfg && s.view === 'room') {
          void chatSendProtocol(this.cfg, s.room, { k: 'poll.end' }).then(() => void this.tick());
        }
        break;
      case 'poll-dismiss':
        this.pollDismissed.add('poll');
        this.renderActive();
        break;
      case 'trivia-guess': {
        const inp = document.getElementById('chat-trivia-input') as HTMLInputElement | null;
        const guess = (inp?.value || '').trim();
        if (guess && this.cfg && s.view === 'room') {
          const tr = reduceTrivia(s.protocol);
          void chatSendProtocol(this.cfg, s.room, { k: 'trv.guess', id: tr?.id || '', a: guess })
            .then(() => void this.tick());
        }
        break;
      }
      case 'hide-msg':
        if (this.cfg && isModerator(s.selfName)) {
          void chatSendProtocol(this.cfg, s.room, { k: 'mod.hide', u: ds.u || '', ts: ds.ts || '' })
            .then(() => void this.tick());
        }
        break;
      case 'unhide-msg':
        if (this.cfg && isModerator(s.selfName)) {
          void chatSendProtocol(this.cfg, s.room, { k: 'mod.unhide', u: ds.u || '', ts: ds.ts || '' })
            .then(() => void this.tick());
        }
        break;
      case 'topic-edit':
        this.openTopicEditor();
        break;
      case 'jump-bottom': {
        const box = this.els['chat-messages'] as HTMLElement;
        box.scrollTop = box.scrollHeight;
        s.stickBottom = true;
        this.renderJumpPill();
        break;
      }
      case 'file-import':
        if (this.cfg) {
          const url = ds.url || '';
          const name = ds.name || 'file';
          void chatImportFile(this.cfg, url, name).then(
            () => this.toast('Sent to library import'),
            (err) => this.toast(err instanceof Error ? err.message : 'Import failed'),
          );
        }
        break;
      case 'np-share':
        void this.shareNowPlayingCard();
        break;
      case 'wanted-have': {
        const m = this.findMsg(ds.key || '');
        if (m && m.want) void this.offerWanted(m);
        break;
      }
      case 'wanted-add': {
        const m = this.findMsg(ds.key || '');
        if (m && m.want) void this.addWantedToWishlist(m);
        break;
      }
      case 'dm':
        if (ds.user) this.openPm(ds.user);
        break;
      case 'browse':
        if (ds.user) void this.openSharesBrowser(ds.user, '');
        break;
      case 'leave-room':
        if (this.cfg && ds.room) {
          void chatLeaveRoom(this.cfg, ds.room).then(() => this.loadRail().then(() => {
            if (this.s.room === ds.room) this.openRoom(this.s.homeRoom || 'SoulSync');
          }));
        }
        break;
      case 'modal-close':
        this.closeModal();
        break;
      case 'pop-close':
        this.closePop();
        break;
      default:
        break;
    }
    e.stopPropagation();
  }

  private findMsg(key: string): ChatMessage | null {
    const all = this.s.view === 'pm' ? this.s.pmMsgs : this.s.msgs;
    return all.find((m) => msgKey(m) === key) || null;
  }

  // ── edit fold (mirrors the page's _applyEdits exactly) ───────────────
  // An edit is a normal message whose 'ed' names one of the SENDER's own
  // earlier messages (key 'user|timestamp|text', truncated to 160 chars).
  // The carrier's text is the replacement; latest wins, max 2 per target
  // (EDIT_MAX). Invalid carriers (wrong author, over cap, target scrolled
  // out) render as their own message.

  private editMap: Map<string, string[]> = new Map();
  private editHidden: Set<string> = new Set();

  private foldEdits(msgs: ChatMessage[]): void {
    const EDIT_MAX = 2;
    const present = new Set<string>();
    for (const m of msgs) {
      if (!m.ed) present.add(msgKey(m).slice(0, 160));
    }
    this.editMap = new Map();
    this.editHidden = new Set();
    for (const m of msgs) {
      const target = typeof m.ed === 'string' && m.ed ? m.ed : null;
      if (!target) continue;
      const isAuthor = target.indexOf((m.username || '') + '|') === 0;
      const slot = isAuthor ? (this.editMap.get(target) || []) : null;
      const applies = !!slot && slot.length < EDIT_MAX;
      if (applies) {
        slot.push(String(m.message || ''));
        this.editMap.set(target, slot);
        this.editHidden.add(msgKey(m));
      }
    }
  }

  private visibleMsgs(): ChatMessage[] {
    this.foldEdits(this.s.view === 'pm' ? this.s.pmMsgs : this.s.msgs);
    const all = this.s.view === 'pm' ? this.s.pmMsgs : this.s.msgs;
    return all.filter((m) => !this.editHidden.has(msgKey(m)));
  }

  private displayText(m: ChatMessage): string {
    const versions = this.editMap.get(msgKey(m).slice(0, 160));
    if (versions && versions.length) return versions[versions.length - 1];
    return m.message;
  }

  private isEdited(m: ChatMessage): boolean {
    const versions = this.editMap.get(msgKey(m).slice(0, 160));
    return !!versions && versions.length > 0;
  }

  // ── header / channels / topic ───────────────────────────────────────

  private renderHead(): void {
    const s = this.s;
    const title = this.els['chat-title'];
    const chanBox = this.els['chat-channels'];
    const topicBox = this.els['chat-topic'];
    if (s.view === 'pm') {
      title.textContent = s.pmUser || 'DMs';
      chanBox.hidden = true;
      topicBox.hidden = true;
      return;
    }
    const chanName = CHAT_CHANNELS.flatMap((c) => c.items).find((i) => i.slug === s.channel)?.name || s.channel;
    title.textContent = (this.chanRoom() ? '#' + chanName : s.room) || s.room;
    if (this.chanRoom()) {
      chanBox.hidden = false;
      const unread = this.chanUnread();
      chanBox.innerHTML = CHAT_CHANNELS.map((cat) =>
        `<span class="chat-chancat">${esc(cat.cat)}</span>` +
        cat.items.map((i) => {
          const n = unread[i.slug] || 0;
          return `<button class="chat-chan${s.channel === i.slug ? ' chat-chan--on' : ''}" data-act="chan" data-slug="${esc(i.slug)}" type="button">#${esc(i.name)}${n ? `<span class="chat-chan-n">${n}</span>` : ''}</button>`;
        }).join(''),
      ).join('');
    } else {
      chanBox.hidden = true;
    }
    const topic = reduceTopic(s.protocol);
    if (topic) {
      topicBox.hidden = false;
      topicBox.innerHTML = `<span class="chat-topic-label">📌</span> <span>${esc(topic.t)}</span> <span class="chat-topic-by">— ${esc(topic.by)}</span>` +
        (isModerator(s.selfName) ? ` <button class="chat-linkbtn" data-act="topic-edit" type="button">edit</button>` : '');
    } else {
      topicBox.hidden = true;
      if (isModerator(s.selfName)) {
        topicBox.hidden = false;
        topicBox.innerHTML = `<button class="chat-linkbtn" data-act="topic-edit" type="button">+ set topic</button>`;
      }
    }
  }

  private renderThreadbar(): void {
    const bar = this.els['chat-threadbar'];
    const s = this.s;
    if (!s.thread) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.innerHTML = `<span>🧵 <strong>${esc(s.thread.name)}</strong></span><button class="chat-linkbtn" data-act="thread-close" type="button">close</button>`;
  }

  private markChanSeen(chan: string): void {
    const s = this.s;
    if (s.view !== 'room' || !s.room) return;
    const newest = [...s.msgs].reverse().find((m) => this.msgChannel(m) === chan);
    const seen = this.s.chanSeen;
    if (!seen[s.room]) seen[s.room] = {};
    if (newest) seen[s.room][chan] = String(newest.timestamp || '');
    writeLS(LS.chanSeen, seen);
  }

  // ── pins / poll / trivia ────────────────────────────────────────────

  private renderActive(): void {
    const s = this.s;
    const box = this.els['chat-active'];
    const pins = s.view === 'room' ? reducePins(s.protocol) : [];
    const poll = s.view === 'room' ? reducePoll(s.protocol) : null;
    const trivia = s.view === 'room' ? reduceTrivia(s.protocol) : null;
    let html = '';
    if (pins.length && s.pinsOpen) {
      html += `<div class="chat-pins-open">${pins.map((p) =>
        `<div class="chat-pinrow"><span class="chat-pin-x">${esc(p.x || '(message)')}</span>` +
        `<span class="chat-pin-by">${esc(p.u)}</span>` +
        `<button class="chat-linkbtn" data-act="pin-jump" data-key="${esc(p.key)}" type="button">jump</button>` +
        (isModerator(s.selfName) ? `<button class="chat-linkbtn" data-act="unpin" data-u="${esc(p.u)}" data-ts="${esc(p.ts)}" type="button">unpin</button>` : '') +
        `</div>`).join('')}</div>`;
    }
    if (poll && !this.pollDismissed.has('poll')) {
      const t = poll.tally;
      const total = t.total || 0;
      html += `<div class="chat-poll"><div class="chat-poll-q">📊 ${esc(poll.q)} <span class="chat-poll-by">— ${esc(poll.by)}</span></div>`;
      html += poll.options.map((o, i) => {
        const idx = String(i + 1);
        const n = t.counts[idx] || 0;
        const pct = total ? Math.round((n / total) * 100) : 0;
        const voters = poll.sv && t.voters && t.voters[idx] ? ` <span class="chat-poll-voters">${t.voters[idx].map(esc).join(', ')}</span>` : '';
        return `<button class="chat-poll-opt" data-act="poll-vote" data-o="${idx}" type="button" ${poll.closed ? 'disabled' : ''}>` +
          `<span class="chat-poll-bar" style="width:${pct}%"></span>` +
          `<span class="chat-poll-opt-t">${esc(o)}</span><span class="chat-poll-n">${n}</span>${voters}</button>`;
      }).join('');
      html += `<div class="chat-poll-foot"><span>${total} vote${total === 1 ? '' : 's'}${poll.closed ? ' · closed' : ''}</span>` +
        (!poll.closed && (poll.by === s.selfName || isModerator(s.selfName))
          ? `<button class="chat-linkbtn" data-act="poll-end" type="button">end poll</button>` : '') +
        `<button class="chat-linkbtn" data-act="poll-dismiss" type="button">dismiss</button></div></div>`;
    }
    if (trivia && !trivia.closed) {
      html += `<div class="chat-trivia"><div class="chat-trivia-q">❓ ${esc(trivia.q)}</div>` +
        (trivia.pot ? `<div class="chat-trivia-pot">🪙 ${trivia.pot} pot — ${esc(trivia.by)}</div>` : '') +
        `<div class="chat-trivia-row"><input id="chat-trivia-input" type="text" placeholder="Your guess…" />` +
        `<button class="chat-send" data-act="trivia-guess" type="button">➤</button></div></div>`;
    } else if (trivia && trivia.closed && trivia.winner) {
      html += `<div class="chat-trivia chat-trivia--done">🏆 ${esc(trivia.winner)} got it: “${esc(trivia.winAnswer)}”</div>`;
    }
    box.hidden = !html;
    box.innerHTML = html;
    // Pins toggle button badge.
    (this.els['chat-pins-btn'] as HTMLButtonElement).textContent = pins.length ? `📌${pins.length}` : '📌';
  }

  // ── message column ──────────────────────────────────────────────────

  private currentList(): ChatMessage[] {
    let list = this.visibleMsgs();
    const s = this.s;
    // Ignored users vanish (their messages never render).
    const ignored = new Set(this.socialGet('ignored').map((u) => u.toLowerCase()));
    if (ignored.size) list = list.filter((m) => !ignored.has((m.username || '').toLowerCase()));
    // SoulSync-only mode: filter to envelope (rich) messages + our own.
    if (s.view === 'room' && this.ssOnly()) {
      list = list.filter((m) => m.rich || m.username === s.selfName);
    }
    if (s.view === 'room') {
      if (this.chanRoom()) {
        list = list.filter((m) => this.msgChannel(m) === s.channel);
      }
      if (s.thread) {
        const tid = s.thread.id;
        list = list.filter((m) => m.th === tid || msgKey(m).startsWith(tid + '|') || msgKey(m) === tid);
      }
    }
    return list;
  }

  private async loadOlder(): Promise<void> {
    const s = this.s;
    if (s.view !== 'room' || s.loadingOlder || s.historyDone || !this.cfg || !s.room) return;
    const oldest = s.msgs[0];
    if (!oldest) return;
    s.loadingOlder = true;
    try {
      const older = await chatRoomHistory(this.cfg, s.room, String(oldest.timestamp || ''));
      if (!older.length) {
        s.historyDone = true;
      } else {
        const seen = new Set(s.msgs.map(msgKey));
        const fresh = older.filter((m) => !seen.has(msgKey(m)));
        const box = this.els['chat-messages'] as HTMLElement;
        const prevH = box.scrollHeight;
        s.msgs = [...fresh.sort((a, b) => String(a.timestamp || '') < String(b.timestamp || '') ? -1 : 1), ...s.msgs];
        this.renderMessages();
        box.scrollTop = box.scrollHeight - prevH;
      }
    } catch { /* next scroll tries again */ }
    s.loadingOlder = false;
  }

  private renderMessages(): void {
    const s = this.s;
    const box = this.els['chat-messages'] as HTMLElement;
    const list = this.currentList();
    const hidden = reduceHidden(s.protocol);
    let html = '';
    let lastDay = '';
    let prevUser = '';
    let prevTs = 0;
    let newDividerShown = false;
    for (const m of list) {
      const key = msgKey(m);
      if (hidden[key]) {
        html += `<div class="chat-msg chat-msg--hidden" data-msg data-key="${esc(key)}">` +
          `<span>🚫 message hidden by a moderator</span>` +
          (isModerator(s.selfName)
            ? ` <button class="chat-linkbtn" data-act="unhide-msg" data-u="${esc(m.username)}" data-ts="${esc(String(m.timestamp || ''))}" type="button">unhide</button>`
            : '') +
          `</div>`;
        continue;
      }
      const day = dayLabel(m.timestamp);
      if (day && day !== lastDay) {
        html += `<div class="chat-day">${esc(day)}</div>`;
        lastDay = day;
      }
      if (s.newMarker && !newDividerShown && String(m.timestamp || '') > s.newMarker) {
        html += `<div class="chat-newdiv"><span>NEW</span></div>`;
        newDividerShown = true;
      }
      const ts = parseTs(m.timestamp)?.getTime() || 0;
      const grouped = m.username === prevUser && ts - prevTs < 5 * 60 * 1000;
      html += this.messageHtml(m, grouped);
      prevUser = m.username;
      prevTs = ts;
    }
    if (!list.length) {
      html = `<div class="chat-empty">${s.view === 'pm' ? 'No messages yet — say hi.' : 'No messages in this ' + (this.chanRoom() ? 'channel' : 'room') + ' yet.'}</div>`;
    }
    const wasPinned = s.stickBottom;
    box.innerHTML = html;
    if (wasPinned) box.scrollTop = box.scrollHeight;
    this.renderJumpPill();
    // Mark the active channel seen on every render while looking at it.
    if (s.view === 'room' && this.chanRoom()) this.markChanSeen(s.channel);
  }

  private renderJumpPill(): void {
    const box = this.els['chat-messages'] as HTMLElement;
    let pill: HTMLButtonElement | null = box.querySelector<HTMLButtonElement>('.chat-jump');
    const need = !this.s.stickBottom;
    if (need && !pill) {
      pill = document.createElement('button');
      pill.className = 'chat-jump';
      pill.type = 'button';
      pill.dataset.act = 'jump-bottom';
      pill.textContent = '↓ jump to bottom';
      box.appendChild(pill);
    } else if (!need && pill) {
      pill.remove();
    }
  }

  private avatarFor(name: string): string {
    const serverUrl = (this.cfg?.url || '').replace(/\/+$/, '');
    const avId = this.avatarMap[name];
    const initials = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
    if (avId && serverUrl) {
      return `<span class="chat-av chat-av--img"><img src="${serverUrl}/static/avatar/${avId}.png" alt="" loading="lazy" onerror="this.parentElement.classList.remove('chat-av--img');this.parentElement.textContent='${esc(initials)}';"></span>`;
    }
    return `<span class="chat-av" style="background:hsl(${hue(name)},52%,40%)">${esc(initials)}</span>`;
  }

  private nameBadge(m: ChatMessage): string {
    let out = '';
    if (m.username.toLowerCase() === 'boulderbadgedad') {
      out += '<span class="chat-badge chat-badge--lead">LEAD DEV</span>';
    }
    if (m.badge) out += `<span class="chat-badge">${esc(m.badge)}</span>`;
    return out;
  }

  private messageHtml(m: ChatMessage, grouped: boolean): string {
    const s = this.s;
    const key = msgKey(m);
    const text = this.displayText(m);
    const body = m.rich ? renderRichText(text, s.selfName, this.cfg?.url || '') : renderPlainText(text, s.selfName, this.cfg?.url || '');
    const edited = this.isEdited(m) ? ' <span class="chat-edited">(edited)</span>' : '';
    const mine = m.username === s.selfName;
    let html = `<div class="chat-msg${grouped ? ' chat-msg--grp' : ''}${mine ? ' chat-msg--mine' : ''}" data-msg data-key="${esc(key)}">`;
    if (!grouped) {
      html += `${this.avatarFor(m.username)}<div class="chat-msg-body">` +
        `<div class="chat-msg-head"><span class="chat-name" data-user="${esc(m.username)}" style="color:hsl(${hue(m.username)},65%,62%)">${esc(m.username)}</span>` +
        `${this.nameBadge(m)}<span class="chat-time" title="${esc(String(m.timestamp || ''))}">${esc(fmtTime(m.timestamp))}</span></div>`;
    } else {
      html += `<div class="chat-msg-body chat-msg-body--grp">`;
    }
    if (m.reply) {
      html += `<button class="chat-replyquote" data-act="reply-jump" data-key="${esc(m.reply.u + '|' + (m.reply.ts || ''))}" type="button">` +
        `<span class="chat-replyquote-u">${esc(m.reply.u)}</span> ${esc(m.reply.x)}</button>`;
    }
    html += `<div class="chat-text">${body}${edited}</div>`;
    html += this.cardHtml(m);
    if (m.reactions && m.reactions.length) {
      html += `<div class="chat-reactions">` + m.reactions.map((r) =>
        `<button class="chat-reaction${r.users.includes(s.selfName) ? ' chat-reaction--mine' : ''}" data-act="react-pick" data-key="${esc(key)}" data-emoji="${esc(r.e)}" type="button" title="${esc(r.users.slice(0, 5).join(', '))}">${esc(r.e)} ${r.n}</button>`
      ).join('') + `</div>`;
    }
    // Tap-to-select action row (popup-friendly: no hover on touch).
    const canMod = isModerator(s.selfName);
    html += `<div class="chat-actions">` +
      (s.canSend ? `<button class="chat-linkbtn" data-act="reply" data-key="${esc(key)}" type="button">reply</button>` : '') +
      (s.canSend ? `<button class="chat-linkbtn" data-act="react" data-key="${esc(key)}" type="button">react</button>` : '') +
      (mine && s.canSend ? `<button class="chat-linkbtn" data-act="edit" data-key="${esc(key)}" type="button">edit</button>` : '') +
      (canMod && s.view === 'room' ? `<button class="chat-linkbtn" data-act="pin" data-key="${esc(key)}" type="button">pin</button>` : '') +
      (canMod && s.view === 'room' ? `<button class="chat-linkbtn" data-act="hide-msg" data-u="${esc(m.username)}" data-ts="${esc(String(m.timestamp || ''))}" type="button">hide</button>` : '') +
      (s.view === 'room' ? `<button class="chat-linkbtn" data-act="thread-open" data-th="${esc(key.slice(0, 160))}" data-tn="${esc(text.slice(0, 60))}" type="button">thread</button>` : '') +
      `</div>`;
    html += `</div></div>`;
    return html;
  }

  private cardHtml(m: ChatMessage): string {
    let html = '';
    if (m.file) {
      const f = m.file;
      html += `<div class="chat-card chat-file"><div class="chat-card-icon">📄</div><div class="chat-card-body">` +
        `<div class="chat-card-title">${esc(f.n)}</div>` +
        (f.size ? `<div class="chat-card-sub">${(f.size / 1048576).toFixed(1)} MB</div>` : '') +
        `<div class="chat-card-row"><a class="chat-linkbtn" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">download</a>` +
        `<button class="chat-linkbtn" data-act="file-import" data-url="${esc(f.url)}" data-name="${esc(f.n)}" type="button">save to library</button></div>` +
        `</div></div>`;
    }
    if (m.np) {
      const np = m.np;
      html += `<div class="chat-card chat-np"><div class="chat-card-icon">🎵</div><div class="chat-card-body">` +
        `<div class="chat-card-title">${esc(np.t)}</div>` +
        `<div class="chat-card-sub">${esc(np.a)}${np.al ? ' — ' + esc(np.al) : ''}</div>` +
        `</div>${np.img ? `<img class="chat-card-art" src="${esc(np.img)}" alt="" loading="lazy">` : ''}</div>`;
    }
    if (m.want) {
      const w = m.want as Record<string, string>;
      const key = msgKey(m);
      html += `<div class="chat-card chat-want"><div class="chat-card-icon">🔍</div><div class="chat-card-body">` +
        `<div class="chat-card-title">${esc(w.t || '')}</div>` +
        `<div class="chat-card-sub">${esc(w.a || '')}${w.ty ? ' · ' + esc(w.ty) : ''}${w.y ? ' · ' + esc(w.y) : ''}</div>` +
        `<div class="chat-card-row">` +
        (this.s.canSend ? `<button class="chat-linkbtn" data-act="wanted-have" data-key="${esc(key)}" type="button">I have this</button>` : '') +
        `<button class="chat-linkbtn" data-act="wanted-add" data-key="${esc(key)}" type="button">+ wishlist</button></div>` +
        `</div></div>`;
    }
    if (m.overlay) {
      html += `<div class="chat-card chat-overlay"><div class="chat-card-icon">🖼️</div><div class="chat-card-body">` +
        `<div class="chat-card-title">${esc(m.overlay.n)}</div>` +
        `<div class="chat-card-sub">${m.overlay.layers} layers</div>` +
        `</div></div>`;
    }
    return html;
  }

  // ── composer ────────────────────────────────────────────────────────

  private inputEl(): HTMLTextAreaElement {
    return this.els['chat-input'] as HTMLTextAreaElement;
  }

  private renderReplybar(): void {
    const s = this.s;
    const rb = this.els['chat-replybar'];
    const eb = this.els['chat-editbar'];
    if (s.replyTo) {
      rb.hidden = false;
      rb.innerHTML = `<span>↩ replying to <strong>${esc(s.replyTo.u)}</strong>: ${esc(s.replyTo.x.slice(0, 80))}</span>` +
        `<button class="chat-linkbtn" data-act="reply-cancel" type="button">✕</button>`;
    } else {
      rb.hidden = true;
      rb.innerHTML = '';
    }
    if (s.editing) {
      eb.hidden = false;
      eb.innerHTML = `<span>✏️ editing message</span><button class="chat-linkbtn" data-act="edit-cancel" type="button">✕</button>`;
    } else {
      eb.hidden = true;
      eb.innerHTML = '';
    }
  }

  private cancelReply(): void {
    this.s.replyTo = null;
    this.renderReplybar();
  }

  private cancelEdit(): void {
    this.s.editing = null;
    this.inputEl().value = '';
    this.renderReplybar();
  }

  private plainOn(): boolean {
    const s = this.s;
    if (s.view !== 'room' || this.ssOnly()) return false;
    if (this.chanRoom() && (s.thread || s.channel !== DEFAULT_CHANNEL)) return false;
    return true;
  }

  private ssOnly(): boolean {
    return readLS<boolean>('sschat_ss_only', false);
  }

  private myAvatar(): number {
    return this.settings?.avatar || 0;
  }

  private myBadge(): string {
    return this.settings?.badge || '';
  }

  private async send(): Promise<void> {
    const s = this.s;
    const input = this.inputEl();
    if (!this.cfg || !s.canSend) return;
    let text = (input.value || '').trim();
    if (!text) return;
    // Slash commands (room view only).
    if (s.view === 'room' && text.startsWith('/')) {
      const slash = this.runSlash(text);
      if (slash === true) {
        input.value = '';
        input.style.height = 'auto';
        this.closePop();
        return;
      }
      if (typeof slash === 'string') text = slash;
    }
    input.value = '';
    input.style.height = 'auto';
    s.lastTypSentAt = 0;
    try {
      if (s.view === 'room') {
        const opts: RoomSendOptions = { message: text };
        if (this.plainOn()) {
          opts.plain = true;
        } else {
          if (this.myAvatar()) opts.avatar = this.myAvatar();
          if (this.myBadge()) opts.badge = this.myBadge();
          if (this.chanRoom()) {
            opts.chan = s.channel || DEFAULT_CHANNEL;
            if (s.thread) {
              opts.thread = s.thread.id;
              opts.thread_name = s.thread.name || '';
            }
          }
        }
        if (s.replyTo && !this.plainOn()) opts.reply = s.replyTo;
        if (s.editing && !this.plainOn()) opts.edit = s.editing.key;
        await chatSendRoom(this.cfg, s.room, opts);
        if (!s.editing) this.pushOptimistic(s.room, text, s.replyTo);
      } else if (s.pmUser) {
        await chatSendPm(this.cfg, s.pmUser, text);
        s.pendingPm.push({ user: s.pmUser, text, at: Date.now() });
        s.pmMsgs.push({ username: s.selfName || 'you', message: text, timestamp: new Date().toISOString() });
        this.renderMessages();
      }
      s.stickBottom = true;
      this.cancelReply();
      this.cancelEdit();
      this.closePop();
      window.setTimeout(() => void this.tick(), 700);
    } catch (e) {
      input.value = text; // failed send restores the draft
      this.toast(e instanceof Error ? e.message : 'Message not sent');
    }
  }

  private pushOptimistic(room: string, text: string, reply: { u: string; x: string } | null): void {
    const s = this.s;
    if (room !== s.room) return;
    s.msgs.push({
      username: s.selfName || 'you',
      message: text,
      timestamp: new Date().toISOString(),
      rich: !this.plainOn(),
      chan: s.channel || DEFAULT_CHANNEL,
      reply: reply || undefined,
      _opt: true,
    } as ChatMessage);
    // Reconcile: drop the optimistic copy once the server echoes it (same
    // author + text within 90s), or after 60s regardless.
    window.setTimeout(() => {
      const now = Date.now();
      s.msgs = s.msgs.filter((m) => {
        const mm = m as ChatMessage & { _opt?: boolean };
        if (!mm._opt) return true;
        const age = now - (parseTs(m.timestamp)?.getTime() || now);
        if (age > 60000) return false;
        const echoed = s.msgs.some((o) => {
          const oo = o as ChatMessage & { _opt?: boolean };
          return !oo._opt && o.username === m.username && o.message === m.message &&
            Math.abs((parseTs(o.timestamp)?.getTime() || 0) - (parseTs(m.timestamp)?.getTime() || 0)) < 90000;
        });
        return !echoed;
      });
      if (this.active) this.renderMessages();
    }, 4500);
    this.renderMessages();
  }

  // ── slash commands ────────────────────────────────────────────────

  /** true = handled (clear input); string = rewritten text to send. */
  private runSlash(text: string): boolean | string {
    const s = this.s;
    const parts = text.slice(1).split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    const rest = text.slice(1 + parts[0].length).trim();
    switch (cmd) {
      case 'shrug':
        return rest + ' ¯\\_(ツ)_/¯';
      case 'me':
        return '*' + (rest || '') + '*';
      case 'topic':
        if (rest && this.cfg && isModerator(s.selfName)) {
          void chatSendProtocol(this.cfg, s.room, { k: 'topic.set', t: rest }).then(() => void this.tick());
          return true;
        }
        this.toast(isModerator(s.selfName) ? 'Usage: /topic <text>' : 'Only moderators can set the topic');
        return true;
      case 'poll':
        this.openPollCreator(rest);
        return true;
      case 'pin': {
        const m = [...s.msgs].reverse().find((x) => x.username === s.selfName);
        if (m && this.cfg && isModerator(s.selfName)) {
          void chatSendProtocol(this.cfg, s.room, { k: 'pin.add', u: m.username, ts: String(m.timestamp || ''), x: m.message.slice(0, 140) }).then(() => void this.tick());
        } else {
          this.toast('Only moderators can pin');
        }
        return true;
      }
      case 'gif':
        this.toggleGifPicker(rest);
        return true;
      case 'upload':
        this.toggleAttachMenu();
        return true;
      case 'np':
        void this.shareNowPlayingCard();
        return true;
      case 'want':
      case 'iso':
        void this.openWantedModal(rest);
        return true;
      case 'trivia':
        this.openTriviaCreator(rest);
        return true;
      case 'friends':
      case 'blocklist':
      case 'bookmarks':
        void this.openSocialModal(cmd);
        return true;
      case 'browse':
        if (rest) void this.openSharesBrowser(rest, '');
        else this.toast('Usage: /browse <username>');
        return true;
      case 'dm':
        if (rest) this.openPm(rest);
        return true;
      case 'help':
        this.toast('/shrug /me /topic /poll /pin /gif /upload /np /want /iso /trivia /dm /browse /friends /blocklist /bookmarks');
        return true;
      default:
        return false;
    }
  }

  // ── typing indicators ─────────────────────────────────────────────

  private maybeSendTyping(): void {
    const s = this.s;
    if (!this.cfg || s.view !== 'room' || !s.canSend || this.plainOn()) return;
    const now = Date.now();
    if (now - s.lastTypSentAt < 20000) return; // at most one refresh per 20s
    s.lastTypSentAt = now;
    void chatSendProtocol(this.cfg, s.room, { k: 'typ' }).catch(() => { /* fun-grade */ });
  }

  private renderTyping(): void {
    const s = this.s;
    const now = Date.now();
    const names = Object.keys(s.typing).filter((u) => u !== s.selfName && now - s.typing[u] < 25000);
    const el = this.els['chat-typing'];
    el.textContent = names.length ? (names.length === 1 ? `${names[0]} is typing…` : `${names.slice(0, 3).join(', ')} are typing…`) : '';
  }

  // ── @mention autocomplete ─────────────────────────────────────────

  private updateMentionPop(): void {
    const s = this.s;
    const pop = this.els['chat-mentionpop'];
    const input = this.inputEl();
    const upto = input.value.slice(0, input.selectionStart || 0);
    const m = upto.match(/@([A-Za-z0-9_.-]{1,32})$/);
    if (!m || s.view !== 'room') {
      pop.hidden = true;
      return;
    }
    const q = m[1].toLowerCase();
    const names = [...new Set([...s.users, ...s.msgs.map((x) => x.username)])]
      .filter((u) => u && u.toLowerCase().startsWith(q) && u !== s.selfName)
      .slice(0, 6);
    if (!names.length) {
      pop.hidden = true;
      return;
    }
    pop.hidden = false;
    pop.innerHTML = names.map((u) =>
      `<button type="button" data-mention="${esc(u)}">${this.avatarFor(u)}<span>${esc(u)}</span></button>`,
    ).join('');
    pop.querySelectorAll('[data-mention]').forEach((b) => {
      b.addEventListener('click', () => {
        const name = (b as HTMLElement).dataset.mention || '';
        const pos = input.selectionStart || 0;
        const before = input.value.slice(0, pos).replace(/@[A-Za-z0-9_.-]{1,32}$/, '@' + name + ' ');
        input.value = before + input.value.slice(pos);
        input.focus();
        pop.hidden = true;
      });
    });
  }

  // ── emoji picker ──────────────────────────────────────────────────

  private toggleEmojiPicker(): void {
    const pop = this.els['chat-pop'];
    if (!pop.hidden && pop.dataset.kind === 'emoji') {
      this.closePop();
      return;
    }
    pop.dataset.kind = 'emoji';
    pop.hidden = false;
    pop.innerHTML = `<div class="chat-picker">
      <input class="chat-picker-search" id="chat-emoji-search" type="text" placeholder="Search emoji…" />
      <div class="chat-picker-cats">${EMOJI_CATS.map((c, i) =>
        `<button type="button" data-ecat="${i}" class="${i === 0 ? 'on' : ''}">${c.icon}</button>`).join('')}</div>
      <div class="chat-picker-grid" id="chat-emoji-grid"></div>
    </div>`;
    const grid = pop.querySelector('#chat-emoji-grid') as HTMLElement;
    const renderCat = (idx: number, filter: string) => {
      const cat = EMOJI_CATS[idx];
      const names = (filter
        ? Object.keys(EMOJI).filter((n) => n.includes(filter))
        : cat.names
      ).slice(0, 120);
      grid.innerHTML = names.map((n) =>
        `<button type="button" data-emoji-name="${esc(n)}" title=":${esc(n)}:">${EMOJI[n]}</button>`).join('');
      grid.querySelectorAll('[data-emoji-name]').forEach((b) => {
        b.addEventListener('click', () => this.insertEmoji(':' + (b as HTMLElement).dataset.emojiName + ':'));
      });
    };
    renderCat(0, '');
    pop.querySelectorAll('[data-ecat]').forEach((b) => {
      b.addEventListener('click', () => {
        pop.querySelectorAll('[data-ecat]').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        renderCat(Number((b as HTMLElement).dataset.ecat || 0), (pop.querySelector('#chat-emoji-search') as HTMLInputElement).value.trim().toLowerCase());
      });
    });
    (pop.querySelector('#chat-emoji-search') as HTMLInputElement).addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value.trim().toLowerCase();
      const on = pop.querySelector('[data-ecat].on') as HTMLElement | null;
      renderCat(Number(on?.dataset.ecat || 0), v);
    });
  }

  private insertEmoji(code: string): void {
    const input = this.inputEl();
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + code + ' ' + input.value.slice(input.selectionEnd ?? pos);
    input.focus();
    const name = code.replace(/:/g, '');
    const recent = readLS<string[]>(LS.recentEmoji, []).filter((r) => r !== name);
    recent.unshift(name);
    writeLS(LS.recentEmoji, recent.slice(0, 24));
    this.closePop();
  }

  private toggleReactPicker(m: ChatMessage): void {
    const pop = this.els['chat-pop'];
    const key = msgKey(m);
    if (!pop.hidden && pop.dataset.kind === 'react' && pop.dataset.key === key) {
      this.closePop();
      return;
    }
    pop.dataset.kind = 'react';
    pop.dataset.key = key;
    pop.hidden = false;
    const quick = ['❤️', '👍', '😂', '🎉', '😮', '😢', '🔥', '👏'];
    pop.innerHTML = `<div class="chat-picker chat-picker--react">
      <div class="chat-react-row">${quick.map((e) =>
        `<button type="button" data-act="react-pick" data-key="${esc(key)}" data-emoji="${esc(e)}">${e}</button>`).join('')}
      </div>
      <div class="chat-picker-grid">${Object.keys(EMOJI).slice(0, 80).map((n) =>
        `<button type="button" data-act="react-pick" data-key="${esc(key)}" data-emoji="${esc(EMOJI[n])}" title=":${esc(n)}:">${EMOJI[n]}</button>`).join('')}
      </div>
    </div>`;
  }

  private async sendReaction(m: ChatMessage, emoji: string): Promise<void> {
    if (!this.cfg) return;
    try {
      await chatReact(this.cfg, this.s.room, m.username, this.displayText(m), emoji);
      window.setTimeout(() => void this.tick(), 700);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'Reaction failed');
    }
  }

  // ── GIF picker ────────────────────────────────────────────────────

  private toggleGifPicker(initial = ''): void {
    const pop = this.els['chat-pop'];
    if (!pop.hidden && pop.dataset.kind === 'gif') {
      this.closePop();
      return;
    }
    pop.dataset.kind = 'gif';
    pop.hidden = false;
    pop.innerHTML = `<div class="chat-picker">
      <input class="chat-picker-search" id="chat-gif-search" type="text" placeholder="Search GIFs…" value="${esc(initial)}" />
      <div class="chat-picker-grid chat-gif-grid" id="chat-gif-grid"><div class="chat-empty">Type to search.</div></div>
    </div>`;
    const grid = pop.querySelector('#chat-gif-grid') as HTMLElement;
    const searchInput = pop.querySelector('#chat-gif-search') as HTMLInputElement;
    let timer: number | null = null;
    const run = async () => {
      const qv = searchInput.value.trim();
      if (!qv || !this.cfg) return;
      grid.innerHTML = '<div class="chat-empty">Searching…</div>';
      try {
        const gifs = await chatGifs(this.cfg, qv);
        grid.innerHTML = gifs.length
          ? gifs.map((g) => `<button type="button" data-gif="${esc(g.url)}"><img src="${esc(g.preview)}" alt="" loading="lazy"></button>`).join('')
          : '<div class="chat-empty">No GIFs found.</div>';
        grid.querySelectorAll('[data-gif]').forEach((b) => {
          b.addEventListener('click', () => {
            const url = (b as HTMLElement).dataset.gif || '';
            this.inputEl().value = url;
            this.closePop();
            void this.send();
          });
        });
      } catch (e) {
        grid.innerHTML = `<div class="chat-empty">${esc(e instanceof Error ? e.message : 'GIF search failed')}</div>`;
      }
    };
    searchInput.addEventListener('input', () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), 400);
    });
    searchInput.focus();
    if (initial) void run();
  }

  // ── attach menu (file upload + library track) ─────────────────────

  private toggleAttachMenu(): void {
    const pop = this.els['chat-pop'];
    if (!pop.hidden && pop.dataset.kind === 'attach') {
      this.closePop();
      return;
    }
    pop.dataset.kind = 'attach';
    pop.hidden = false;
    pop.innerHTML = `<div class="chat-picker chat-attach">
      <button type="button" id="chat-attach-file">📁 Upload a file…</button>
      <input type="file" id="chat-attach-input" hidden />
      <input class="chat-picker-search" id="chat-attach-search" type="text" placeholder="Or attach a library track…" />
      <div id="chat-attach-results"></div>
      <div class="chat-attach-status" id="chat-attach-status"></div>
    </div>`;
    const fileInput = pop.querySelector('#chat-attach-input') as HTMLInputElement;
    (pop.querySelector('#chat-attach-file') as HTMLButtonElement).addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) void this.uploadAndSend(f);
    });
    const search = pop.querySelector('#chat-attach-search') as HTMLInputElement;
    const results = pop.querySelector('#chat-attach-results') as HTMLElement;
    let timer: number | null = null;
    search.addEventListener('input', () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const qv = search.value.trim();
        if (qv.length < 2 || !this.cfg) {
          results.innerHTML = '';
          return;
        }
        try {
          const tracks = await chatLibrarySearch(this.cfg, qv);
          results.innerHTML = tracks.map((t) =>
            `<button type="button" data-track="${esc(t.track_id)}" data-title="${esc(t.title)}" data-artist="${esc(t.artist)}">🎵 ${esc(t.artist)} — ${esc(t.title)}</button>`).join('') ||
            '<div class="chat-empty">No library tracks found.</div>';
          results.querySelectorAll('[data-track]').forEach((b) => {
            b.addEventListener('click', () => {
              const el = b as HTMLElement;
              void this.uploadLibraryTrack(el.dataset.track || '', el.dataset.title || '', el.dataset.artist || '');
            });
          });
        } catch {
          results.innerHTML = '<div class="chat-empty">Search failed.</div>';
        }
      }, 350);
    });
  }

  private async uploadAndSend(file: File): Promise<void> {
    if (!this.cfg) return;
    const status = document.getElementById('chat-attach-status');
    if (status) status.textContent = 'Uploading…';
    try {
      const meta = await chatUploadFile(this.cfg, file);
      this.closePop();
      await this.sendFileCard(meta.url, { n: meta.n, m: meta.m, url: meta.url, size: meta.size });
      window.setTimeout(() => void this.tick(), 700);
    } catch (e) {
      if (status) status.textContent = e instanceof Error ? e.message : 'Upload failed';
    }
  }

  private async sendFileCard(url: string, file: ChatFileCard): Promise<void> {
    if (!this.cfg) return;
    if (this.s.view === 'room' && !this.plainOn()) {
      await chatSendRoom(this.cfg, this.s.room, {
        message: url,
        file,
        chan: this.chanRoom() ? this.s.channel : undefined,
      });
      this.pushOptimistic(this.s.room, url, null);
    } else if (this.s.view === 'pm' && this.s.pmUser) {
      await chatSendPm(this.cfg, this.s.pmUser, url);
    } else {
      await chatSendRoom(this.cfg, this.s.room, { message: url, plain: true });
    }
  }

  private async uploadLibraryTrack(trackId: string, title: string, artist: string): Promise<void> {
    if (!this.cfg) return;
    const status = document.getElementById('chat-attach-status');
    if (status) status.textContent = 'Uploading…';
    try {
      // Library tracks resolve server-side via JSON {track_id} — not the
      // multipart path chatUploadFile uses.
      const base = this.cfg.url.replace(/\/+$/, '');
      const url = `${base}/api/chat/files/upload?api_key=${encodeURIComponent(this.cfg.apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_id: trackId }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) throw new Error(typeof data.error === 'string' ? data.error : 'Upload failed');
      const fileUrl = String(data.url || '');
      this.closePop();
      await this.sendFileCard(
        `${artist} — ${title}: ${fileUrl}`,
        { n: String(data.name || title), m: String(data.mime || ''), url: fileUrl },
      );
      window.setTimeout(() => void this.tick(), 700);
    } catch (e) {
      if (status) status.textContent = e instanceof Error ? e.message : 'Upload failed';
    }
  }

  // ── poll creator ──────────────────────────────────────────────────

  private openPollCreator(prefill = ''): void {
    const modal = this.els['chat-modal'];
    modal.hidden = false;
    modal.innerHTML = `<div class="chat-modal-card">
      <div class="chat-modal-head"><strong>📊 New poll</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
      <input id="chat-poll-q" type="text" placeholder="Question…" value="${esc(prefill)}" />
      <div id="chat-poll-opts">
        <input type="text" placeholder="Option 1" /><input type="text" placeholder="Option 2" />
        <input type="text" placeholder="Option 3" /><input type="text" placeholder="Option 4" />
      </div>
      <label class="chat-check"><input type="checkbox" id="chat-poll-sv" /> Show who voted for what</label>
      <button class="chat-primary" id="chat-poll-start" type="button">Start poll</button>
    </div>`;
    (modal.querySelector('#chat-poll-start') as HTMLButtonElement).addEventListener('click', () => {
      const qv = (modal.querySelector('#chat-poll-q') as HTMLInputElement).value.trim();
      const opts = [...modal.querySelectorAll('#chat-poll-opts input')]
        .map((i) => (i as HTMLInputElement).value.trim()).filter(Boolean).slice(0, 8);
      if (!qv || opts.length < 2) {
        this.toast('A poll needs a question and at least 2 options');
        return;
      }
      if (!this.cfg) return;
      const p: Record<string, unknown> = { k: 'poll.start', q: qv, sv: (modal.querySelector('#chat-poll-sv') as HTMLInputElement).checked };
      opts.forEach((o, i) => { p['o' + (i + 1)] = o; });
      void chatSendProtocol(this.cfg, this.s.room, p).then(() => {
        this.pollDismissed.delete('poll');
        this.closeModal();
        void this.tick();
      }, (e) => this.toast(e instanceof Error ? e.message : 'Could not start poll'));
    });
  }

  // ── trivia creator ────────────────────────────────────────────────

  private openTriviaCreator(prefill = ''): void {
    const modal = this.els['chat-modal'];
    modal.hidden = false;
    modal.innerHTML = `<div class="chat-modal-card">
      <div class="chat-modal-head"><strong>❓ New trivia</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
      <input id="chat-trivia-q" type="text" placeholder="Question… (put the rest after a | )" value="${esc(prefill)}" />
      <input id="chat-trivia-a" type="text" placeholder="Answer (hashed — nobody can peek)" />
      <input id="chat-trivia-pot" type="number" placeholder="Pot (optional)" min="0" max="500" />
      <div class="chat-hint">Format: <code>/trivia question | answer</code> — the answer is SHA-256 hashed before it leaves your machine.</div>
      <button class="chat-primary" id="chat-trivia-start" type="button">Ask the room</button>
    </div>`;
    // Prefill split on |.
    const bar = prefill.indexOf('|');
    if (bar > -1) {
      (modal.querySelector('#chat-trivia-q') as HTMLInputElement).value = prefill.slice(0, bar).trim();
      (modal.querySelector('#chat-trivia-a') as HTMLInputElement).value = prefill.slice(bar + 1).trim();
    }
    (modal.querySelector('#chat-trivia-start') as HTMLButtonElement).addEventListener('click', async () => {
      const qv = (modal.querySelector('#chat-trivia-q') as HTMLInputElement).value.trim();
      const av = (modal.querySelector('#chat-trivia-a') as HTMLInputElement).value.trim();
      const pot = Math.max(0, Math.min(500, Number((modal.querySelector('#chat-trivia-pot') as HTMLInputElement).value) || 0));
      if (!qv || !av) {
        this.toast('Trivia needs a question and an answer');
        return;
      }
      if (!this.cfg) return;
      const id = Math.random().toString(36).slice(2, 10);
      const h = await this.sha256(normalizeTriviaAnswer(av));
      void chatSendProtocol(this.cfg, this.s.room, { k: 'trv.ask', id, q: qv, h, pot }).then(() => {
        this.closeModal();
        void this.tick();
      }, (e) => this.toast(e instanceof Error ? e.message : 'Could not start trivia'));
    });
  }

  private async sha256(s: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ── pop / modal / toast / ping ────────────────────────────────────

  private closePop(): void {
    const pop = this.els['chat-pop'];
    pop.hidden = true;
    pop.innerHTML = '';
    delete pop.dataset.kind;
  }

  private closeModal(): void {
    const modal = this.els['chat-modal'];
    modal.hidden = true;
    modal.innerHTML = '';
  }

  private toast(msg: string): void {
    const box = this.els['chat-messages'] as HTMLElement;
    const t = document.createElement('div');
    t.className = 'chat-toast';
    t.textContent = msg;
    box.appendChild(t);
    window.setTimeout(() => t.remove(), 3200);
  }

  private ping(): void {
    // WebAudio oscillator ping — the page deliberately avoids the
    // Notification API; the mini does the same.
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.start();
      o.stop(ctx.currentTime + 0.4);
    } catch { /* audio unavailable */ }
  }

  // ── social lists (localStorage, like the page) ──────────────────────

  private socialGet(key: string): string[] {
    return readLS<string[]>('sschat_' + key, []);
  }

  private socialHas(key: string, name: string): boolean {
    return this.socialGet(key).some((x) => x.toLowerCase() === name.toLowerCase());
  }

  private socialToggle(key: string, name: string): boolean {
    const list = this.socialGet(key);
    const idx = list.findIndex((x) => x.toLowerCase() === name.toLowerCase());
    const nowOn = idx === -1;
    if (nowOn) list.push(name);
    else list.splice(idx, 1);
    writeLS('sschat_' + key, list);
    return nowOn;
  }

  // ── user card ───────────────────────────────────────────────────────

  async openUserCard(username: string): Promise<void> {
    if (!username || !this.cfg) return;
    const modal = this.els['chat-modal'];
    modal.hidden = false;
    modal.innerHTML = `<div class="chat-modal-card"><div class="chat-empty">Loading…</div></div>`;
    try {
      const d = await chatUserCard(this.cfg, username);
      const isFriend = this.socialHas('friends', username);
      const isBlocked = this.socialHas('blocked', username);
      const isIgnored = this.socialHas('ignored', username);
      const note = typeof d.note === 'string' ? d.note : '';
      modal.innerHTML = `<div class="chat-modal-card">
        <div class="chat-modal-head"><strong>${this.avatarFor(username)} ${esc(username)}</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
        <div class="chat-usercard-row">
          <button class="chat-primary" data-uccard="dm" type="button">💬 Message</button>
          <button class="chat-ghost" data-uccard="browse" type="button">📁 Browse shares</button>
        </div>
        <div class="chat-usercard-row">
          <button class="chat-ghost${isFriend ? ' on' : ''}" data-uccard="friend" type="button">${isFriend ? '★' : '☆'} Friend</button>
          <button class="chat-ghost${isBlocked ? ' on' : ''}" data-uccard="block" type="button">🚫 Block</button>
          <button class="chat-ghost${isIgnored ? ' on' : ''}" data-uccard="ignore" type="button">🙈 Ignore</button>
        </div>
        <label class="chat-field">Note<textarea id="chat-user-note" rows="2" placeholder="Private note about ${esc(username)}…">${esc(note)}</textarea></label>
        <button class="chat-primary" data-uccard="savenote" type="button">Save note</button>
      </div>`;
      modal.querySelectorAll('[data-uccard]').forEach((b) => {
        b.addEventListener('click', () => {
          const k = (b as HTMLElement).dataset.uccard;
          if (k === 'dm') {
            this.closeModal();
            this.openPm(username);
          } else if (k === 'browse') {
            void this.openSharesBrowser(username, '');
          } else if (k === 'friend') {
            this.socialToggle('friends', username);
            void this.openUserCard(username);
          } else if (k === 'block') {
            this.socialToggle('blocked', username);
            void this.openUserCard(username);
          } else if (k === 'ignore') {
            this.socialToggle('ignored', username);
            void this.openUserCard(username);
            this.renderMessages();
          } else if (k === 'savenote' && this.cfg) {
            const v = (modal.querySelector('#chat-user-note') as HTMLTextAreaElement).value;
            void chatUserNote(this.cfg, username, v).then(
              () => this.toast('Note saved'),
              (e) => this.toast(e instanceof Error ? e.message : 'Could not save note'),
            );
          }
        });
      });
    } catch (e) {
      modal.innerHTML = `<div class="chat-modal-card"><div class="chat-empty">${esc(e instanceof Error ? e.message : 'Could not load user')}</div>
        <button class="chat-linkbtn" data-act="modal-close" type="button">Close</button></div>`;
    }
  }

  // ── shares browser ──────────────────────────────────────────────────

  async openSharesBrowser(username: string, dir: string): Promise<void> {
    if (!this.cfg) return;
    const modal = this.els['chat-modal'];
    modal.hidden = false;
    modal.innerHTML = `<div class="chat-modal-card chat-modal--wide">
      <div class="chat-modal-head"><strong>📁 ${esc(username)}${dir ? ' / ' + esc(dir) : ''}</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
      <div class="chat-empty">Loading…</div></div>`;
    try {
      const d = dir ? await chatUserSharesFiles(this.cfg, username, dir) : await chatUserShares(this.cfg, username);
      const dirs = Array.isArray(d.directories) ? d.directories as Array<{ name: string; path?: string }> : [];
      const files = Array.isArray(d.files) ? d.files as Array<{ name: string; path?: string; size?: number }> : [];
      const back = dir ? `<button class="chat-ghost" data-shares-back type="button">← up</button>` : '';
      modal.innerHTML = `<div class="chat-modal-card chat-modal--wide">
        <div class="chat-modal-head"><strong>📁 ${esc(username)}${dir ? ' / ' + esc(dir) : ''}</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
        ${back}
        <div class="chat-shares">${dirs.map((x) =>
          `<button type="button" data-shares-dir="${esc(x.path || x.name)}">📁 ${esc(x.name)}</button>`).join('')}
        ${files.map((x) =>
          `<div class="chat-sharefile"><span>🎵 ${esc(x.name)}</span>${x.size ? `<span class="muted">${(x.size / 1048576).toFixed(1)} MB</span>` : ''}<button type="button" data-shares-file="${esc(x.path || x.name)}">download</button></div>`).join('') ||
          (dirs.length ? '' : '<div class="chat-empty">Nothing shared here.</div>')}</div></div>`;
      modal.querySelectorAll('[data-shares-dir]').forEach((b) => {
        b.addEventListener('click', () => void this.openSharesBrowser(username, (b as HTMLElement).dataset.sharesDir || ''));
      });
      const backBtn = modal.querySelector('[data-shares-back]');
      backBtn?.addEventListener('click', () => {
        const parts = dir.split(/[\\/]/).filter(Boolean);
        parts.pop();
        void this.openSharesBrowser(username, parts.join('/'));
      });
      modal.querySelectorAll('[data-shares-file]').forEach((b) => {
        b.addEventListener('click', () => {
          if (!this.cfg) return;
          void chatUserDownload(this.cfg, username, (b as HTMLElement).dataset.sharesFile || '').then(
            () => this.toast('Download queued on the server'),
            (e) => this.toast(e instanceof Error ? e.message : 'Download failed'),
          );
        });
      });
    } catch (e) {
      modal.innerHTML = `<div class="chat-modal-card"><div class="chat-empty">${esc(e instanceof Error ? e.message : 'Could not browse shares')}</div>
        <button class="chat-linkbtn" data-act="modal-close" type="button">Close</button></div>`;
    }
  }

  // ── social modal ────────────────────────────────────────────────────

  async openSocialModal(kind: string): Promise<void> {
    const modal = this.els['chat-modal'];
    modal.hidden = false;
    const key = kind === 'friends' ? 'friends' : kind === 'blocklist' ? 'blocked' : 'bookmarks';
    const title = kind === 'friends' ? '★ Friends' : kind === 'blocklist' ? '🚫 Blocked' : '🔖 Bookmarks';
    const render = () => {
      const list = this.socialGet(key);
      modal.innerHTML = `<div class="chat-modal-card">
        <div class="chat-modal-head"><strong>${title}</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
        <div class="chat-social-row"><input id="chat-social-add" type="text" placeholder="Add username…" />
        <button class="chat-primary" id="chat-social-addbtn" type="button">Add</button></div>
        <div class="chat-shares">${list.map((u) =>
          `<div class="chat-sharefile"><button type="button" data-social-dm="${esc(u)}">${esc(u)}</button><button type="button" data-social-rm="${esc(u)}">✕</button></div>`).join('') ||
          '<div class="chat-empty">Empty.</div>'}</div></div>`;
      (modal.querySelector('#chat-social-addbtn') as HTMLButtonElement).addEventListener('click', () => {
        const v = (modal.querySelector('#chat-social-add') as HTMLInputElement).value.trim();
        if (v && !this.socialHas(key, v)) {
          const l = this.socialGet(key);
          l.push(v);
          writeLS('sschat_' + key, l);
        }
        render();
      });
      modal.querySelectorAll('[data-social-dm]').forEach((b) => {
        b.addEventListener('click', () => {
          this.closeModal();
          this.openPm((b as HTMLElement).dataset.socialDm || '');
        });
      });
      modal.querySelectorAll('[data-social-rm]').forEach((b) => {
        b.addEventListener('click', () => {
          this.socialToggle(key, (b as HTMLElement).dataset.socialRm || '');
          render();
        });
      });
    };
    render();
  }

  // ── room browser ────────────────────────────────────────────────────

  async openRoomBrowser(): Promise<void> {
    if (!this.cfg) return;
    const modal = this.els['chat-modal'];
    modal.hidden = false;
    modal.innerHTML = `<div class="chat-modal-card chat-modal--wide">
      <div class="chat-modal-head"><strong>Browse rooms</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
      <input class="chat-picker-search" id="chat-room-filter" type="text" placeholder="Filter…" />
      <div class="chat-shares" id="chat-room-list"><div class="chat-empty">Loading…</div></div></div>`;
    try {
      const d = await chatAvailableRooms(this.cfg);
      const joined = new Set(d.joined);
      const list = modal.querySelector('#chat-room-list') as HTMLElement;
      const filter = modal.querySelector('#chat-room-filter') as HTMLInputElement;
      const render = () => {
        const q = filter.value.trim().toLowerCase();
        const rooms = d.rooms.filter((r) => !q || r.name.toLowerCase().includes(q)).slice(0, 100);
        list.innerHTML = rooms.map((r) =>
          `<div class="chat-sharefile"><span>${r.private ? '🔒 ' : ''}${esc(r.name)} <span class="muted">${r.users}</span></span>` +
          (joined.has(r.name)
            ? `<button type="button" data-room-open="${esc(r.name)}">open</button>`
            : this.s.canManage ? `<button type="button" data-room-join="${esc(r.name)}">join</button>` : '') +
          `</div>`).join('') || '<div class="chat-empty">No rooms match.</div>';
        list.querySelectorAll('[data-room-join]').forEach((b) => {
          b.addEventListener('click', async () => {
            if (!this.cfg) return;
            try {
              await chatJoinRoom(this.cfg, (b as HTMLElement).dataset.roomJoin || '');
              await this.loadRail();
              this.closeModal();
              this.openRoom((b as HTMLElement).dataset.roomJoin || '');
            } catch (e) {
              this.toast(e instanceof Error ? e.message : 'Could not join');
            }
          });
        });
        list.querySelectorAll('[data-room-open]').forEach((b) => {
          b.addEventListener('click', () => {
            this.closeModal();
            this.openRoom((b as HTMLElement).dataset.roomOpen || '');
          });
        });
      };
      filter.addEventListener('input', render);
      render();
    } catch (e) {
      (modal.querySelector('#chat-room-list') as HTMLElement).innerHTML =
        `<div class="chat-empty">${esc(e instanceof Error ? e.message : 'Could not load rooms')}</div>`;
    }
  }

  // ── settings ────────────────────────────────────────────────────────

  async openSettings(): Promise<void> {
    if (!this.cfg) return;
    const modal = this.els['chat-modal'];
    modal.hidden = false;
    modal.innerHTML = `<div class="chat-modal-card"><div class="chat-empty">Loading…</div></div>`;
    try {
      const st = await chatGetSettings(this.cfg);
      this.settings = st;
      modal.innerHTML = `<div class="chat-modal-card chat-modal--wide">
        <div class="chat-modal-head"><strong>⚙️ Chat settings</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
        <div class="chat-settabs"><button type="button" data-settab="profile" class="on">Profile</button><button type="button" data-settab="room">Room</button></div>
        <div id="chat-set-profile">
          <label class="chat-field">Flair badge <span class="muted">(shows next to your name, max 24 chars)</span>
            <input id="chat-set-badge" type="text" maxlength="24" value="${esc(st.badge)}" placeholder="e.g. LEAD DEV" /></label>
          <label class="chat-field">Avatar</label>
          <div class="chat-avgrid" id="chat-set-avgrid"></div>
          <label class="chat-field">GIPHY API key ${st.giphy_key_set ? '<span class="muted">(set)</span>' : ''}
            <input id="chat-set-giphy" type="password" placeholder="${st.giphy_key_set ? '•••••••• (set — leave blank to keep)' : 'Free at developers.giphy.com'}" /></label>
          <label class="chat-field">filepost.dev API key ${st.filepost_key_set ? '<span class="muted">(set)</span>' : ''}
            <input id="chat-set-filepost" type="password" placeholder="${st.filepost_key_set ? '•••••••• (set — leave blank to keep)' : 'For file uploads'}" /></label>
        </div>
        <div id="chat-set-room" hidden>
          <label class="chat-field">Home room<input id="chat-set-roomname" type="text" value="${esc(st.room)}" /></label>
          <label class="chat-field">History retention (days, 0 = keep all)<input id="chat-set-retention" type="number" min="0" max="3650" value="${st.history_retention_days}" /></label>
          <label class="chat-check"><input type="checkbox" id="chat-set-autojoin" ${st.auto_join ? 'checked' : ''} /> Auto-join home room</label>
          <label class="chat-check"><input type="checkbox" id="chat-set-membersend" ${st.member_send ? 'checked' : ''} /> Let room members send (non-admin)</label>
          <label class="chat-check"><input type="checkbox" id="chat-set-autoprove" ${st.auto_prove ? 'checked' : ''} /> Auto-prove SoulSync clients</label>
        </div>
        <button class="chat-primary" id="chat-set-save" type="button">Save</button>
      </div>`;
      // Avatar grid: preset ids 1..244 (100 reserved for boulderbadgedad).
      const grid = modal.querySelector('#chat-set-avgrid') as HTMLElement;
      const serverUrl = this.cfg.url.replace(/\/+$/, '');
      let picked = st.avatar || 0;
      const paintGrid = () => {
        grid.innerHTML = `<button type="button" data-av="0" class="${picked === 0 ? 'on' : ''}">✕</button>` +
          Array.from({ length: 24 }, (_, i) => i + 1).map((n) =>
            `<button type="button" data-av="${n}" class="${picked === n ? 'on' : ''}"><img src="${serverUrl}/static/avatar/${n}.png" alt="${n}" loading="lazy"></button>`).join('') +
          `<span class="muted">…${244} total on the full page</span>`;
        grid.querySelectorAll('[data-av]').forEach((b) => {
          b.addEventListener('click', () => {
            picked = Number((b as HTMLElement).dataset.av || 0);
            paintGrid();
          });
        });
      };
      paintGrid();
      modal.querySelectorAll('[data-settab]').forEach((b) => {
        b.addEventListener('click', () => {
          modal.querySelectorAll('[data-settab]').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          const t = (b as HTMLElement).dataset.settab;
          (modal.querySelector('#chat-set-profile') as HTMLElement).hidden = t !== 'profile';
          (modal.querySelector('#chat-set-room') as HTMLElement).hidden = t !== 'room';
        });
      });
      (modal.querySelector('#chat-set-save') as HTMLButtonElement).addEventListener('click', async () => {
        if (!this.cfg) return;
        const payload: Record<string, unknown> = {
          badge: (modal.querySelector('#chat-set-badge') as HTMLInputElement).value.trim().slice(0, 24),
          avatar: picked,
          room: (modal.querySelector('#chat-set-roomname') as HTMLInputElement).value.trim(),
          history_retention_days: Number((modal.querySelector('#chat-set-retention') as HTMLInputElement).value) || 0,
          auto_join: (modal.querySelector('#chat-set-autojoin') as HTMLInputElement).checked,
          member_send: (modal.querySelector('#chat-set-membersend') as HTMLInputElement).checked,
          auto_prove: (modal.querySelector('#chat-set-autoprove') as HTMLInputElement).checked,
        };
        const gk = (modal.querySelector('#chat-set-giphy') as HTMLInputElement).value.trim();
        const fk = (modal.querySelector('#chat-set-filepost') as HTMLInputElement).value.trim();
        if (gk) payload.giphy_key = gk;
        if (fk) payload.filepost_key = fk;
        try {
          await chatSaveSettings(this.cfg, payload);
          this.settings = await chatGetSettings(this.cfg);
          this.toast('Chat settings saved');
          this.closeModal();
          this.sendHelloBeacon();
          void this.tick();
        } catch (e) {
          this.toast(e instanceof Error ? e.message : 'Could not save settings');
        }
      });
    } catch (e) {
      modal.innerHTML = `<div class="chat-modal-card"><div class="chat-empty">${esc(e instanceof Error ? e.message : 'Could not load settings')}</div>
        <button class="chat-linkbtn" data-act="modal-close" type="button">Close</button></div>`;
    }
  }

  // ── topic editor ────────────────────────────────────────────────────

  private openTopicEditor(): void {
    const topic = reduceTopic(this.s.protocol);
    const modal = this.els['chat-modal'];
    modal.hidden = false;
    modal.innerHTML = `<div class="chat-modal-card">
      <div class="chat-modal-head"><strong>📌 Room topic</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
      <input id="chat-topic-input" type="text" maxlength="160" value="${esc(topic?.t || '')}" placeholder="What's this room about?" />
      <div class="chat-modal-row"><button class="chat-primary" id="chat-topic-save" type="button">Set topic</button>
      ${topic ? '<button class="chat-ghost" id="chat-topic-clear" type="button">Clear</button>' : ''}</div>
    </div>`;
    const save = (t: string) => {
      if (!this.cfg) return;
      void chatSendProtocol(this.cfg, this.s.room, { k: 'topic.set', t }).then(() => {
        this.closeModal();
        void this.tick();
      }, (e) => this.toast(e instanceof Error ? e.message : 'Could not set topic'));
    };
    (modal.querySelector('#chat-topic-save') as HTMLButtonElement).addEventListener('click', () => {
      save((modal.querySelector('#chat-topic-input') as HTMLInputElement).value.trim());
    });
    modal.querySelector('#chat-topic-clear')?.addEventListener('click', () => save(''));
  }

  // ── search ──────────────────────────────────────────────────────────

  private toggleSearch(force?: boolean): void {
    const s = this.s;
    const bar = this.els['chat-searchbar'];
    const show = force !== undefined ? force : bar.hidden;
    bar.hidden = !show;
    if (!show) {
      s.searchOpen = false;
      s.searchResults = [];
      this.renderMessages();
    } else {
      s.searchOpen = true;
      (this.els['chat-search-input'] as HTMLInputElement).focus();
    }
  }

  private async runSearch(query: string): Promise<void> {
    const s = this.s;
    s.searchQuery = query.trim();
    if (s.searchQuery.length < 2 || !this.cfg || s.view !== 'room') {
      s.searchResults = [];
      this.renderMessages();
      return;
    }
    try {
      s.searchResults = await chatRoomSearch(this.cfg, s.room, s.searchQuery);
    } catch {
      s.searchResults = [];
    }
    // Render results in place of the message column.
    const box = this.els['chat-messages'] as HTMLElement;
    const q = s.searchQuery.toLowerCase();
    box.innerHTML = s.searchResults.length
      ? `<div class="chat-day">${s.searchResults.length} result${s.searchResults.length === 1 ? '' : 's'}</div>` +
        s.searchResults.map((m) => this.messageHtml(m, false).replace(
          new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'),
          '<mark>$1</mark>',
        )).join('')
      : `<div class="chat-empty">No matches for “${esc(s.searchQuery)}”.</div>`;
  }

  // ── now-playing card ────────────────────────────────────────────────

  private async shareNowPlayingCard(): Promise<void> {
    if (!this.cfg || !this.s.canSend) return;
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      interface NpInfo { title: string; artist: string; album: string; artwork: string }
      let np: NpInfo | null = null;
      if (tab?.id !== undefined) {
        try {
          const res = (await browser.tabs.sendMessage(tab.id, { type: 'SOULSYNC_GET_NOW_PLAYING' })) as { nowPlaying?: NpInfo | null };
          np = res?.nowPlaying || null;
        } catch { /* no content script */ }
      }
      if (!np || !np.title) {
        this.toast('Nothing is playing in the current tab');
        return;
      }
      const fallback = `🎵 Now Playing: ${np.artist} - ${np.title}${np.album ? ' (' + np.album + ')' : ''}`;
      if (this.s.view === 'room' && !this.plainOn()) {
        await chatSendRoom(this.cfg, this.s.room, {
          message: fallback,
          np: { t: np.title, a: np.artist, al: np.album, img: np.artwork },
          chan: this.chanRoom() ? this.s.channel : undefined,
        });
        this.pushOptimistic(this.s.room, fallback, null);
      } else if (this.s.view === 'pm' && this.s.pmUser) {
        await chatSendPm(this.cfg, this.s.pmUser, fallback);
      } else {
        await chatSendRoom(this.cfg, this.s.room, { message: fallback, plain: true });
      }
      this.toast('🎵 Shared Now Playing to chat');
      window.setTimeout(() => void this.tick(), 700);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'Could not share');
    }
  }

  // ── wanted / ISO cards ──────────────────────────────────────────────

  private async openWantedModal(prefill = ''): Promise<void> {
    const modal = this.els['chat-modal'];
    modal.hidden = false;
    modal.innerHTML = `<div class="chat-modal-card">
      <div class="chat-modal-head"><strong>🔍 Post a Wanted card</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
      <label class="chat-field">Artist<input id="chat-want-a" type="text" value="${esc(prefill)}" /></label>
      <label class="chat-field">Title<input id="chat-want-t" type="text" /></label>
      <label class="chat-field">Type<select id="chat-want-ty"><option value="album">album</option><option value="track">track</option><option value="ep">ep</option><option value="single">single</option></select></label>
      <label class="chat-field">Year (optional)<input id="chat-want-y" type="text" maxlength="4" /></label>
      <button class="chat-primary" id="chat-want-post" type="button">Post card</button>
    </div>`;
    (modal.querySelector('#chat-want-post') as HTMLButtonElement).addEventListener('click', async () => {
      const a = (modal.querySelector('#chat-want-a') as HTMLInputElement).value.trim();
      const t = (modal.querySelector('#chat-want-t') as HTMLInputElement).value.trim();
      const ty = (modal.querySelector('#chat-want-ty') as HTMLSelectElement).value;
      const y = (modal.querySelector('#chat-want-y') as HTMLInputElement).value.trim();
      if (!a || !t || !this.cfg) {
        this.toast('Wanted cards need an artist and a title');
        return;
      }
      const fallback = `🔍 ISO: ${a} - ${t} (${ty})`;
      try {
        await chatSendRoom(this.cfg, this.s.room, {
          message: fallback,
          want: { t, a, ty, ...(y ? { y } : {}) },
          chan: this.chanRoom() ? this.s.channel : undefined,
        });
        this.closeModal();
        this.pushOptimistic(this.s.room, fallback, null);
        window.setTimeout(() => void this.tick(), 700);
      } catch (e) {
        this.toast(e instanceof Error ? e.message : 'Could not post');
      }
    });
  }

  private async offerWanted(m: ChatMessage): Promise<void> {
    if (!this.cfg || !m.want) return;
    const w = m.want as Record<string, string>;
    const modal = this.els['chat-modal'];
    modal.hidden = false;
    modal.innerHTML = `<div class="chat-modal-card">
      <div class="chat-modal-head"><strong>Share “${esc(w.t || '')}”</strong><button class="chat-linkbtn" data-act="modal-close" type="button">✕</button></div>
      <div class="chat-hint">SoulSync looks through your library for matching files and offers them to <strong>${esc(m.username)}</strong> over Soulseek.</div>
      <button class="chat-primary" id="chat-want-offer" type="button">Find my matching files</button>
      <div id="chat-want-offer-res"></div>
    </div>`;
    (modal.querySelector('#chat-want-offer') as HTMLButtonElement).addEventListener('click', async () => {
      const res = modal.querySelector('#chat-want-offer-res') as HTMLElement;
      res.innerHTML = '<div class="chat-empty">Searching your library…</div>';
      try {
        const d = await chatResolveWantedShare(this.cfg!, {
          title: w.t || '', artist: w.a || '', album: w.al || '', type: w.ty || 'album',
        });
        const files = Array.isArray(d.files) ? d.files as string[] : [];
        if (!files.length) {
          res.innerHTML = '<div class="chat-empty">No matching files in your library.</div>';
          return;
        }
        res.innerHTML = `<div class="chat-shares">${files.slice(0, 20).map((f) =>
          `<div class="chat-sharefile"><span>🎵 ${esc(f)}</span></div>`).join('')}</div>
          <div class="chat-hint">${files.length} match${files.length === 1 ? '' : 'es'} — reply to <strong>${esc(m.username)}</strong> to arrange the share.</div>`;
      } catch (e) {
        res.innerHTML = `<div class="chat-empty">${esc(e instanceof Error ? e.message : 'Lookup failed')}</div>`;
      }
    });
  }

  private async addWantedToWishlist(m: ChatMessage): Promise<void> {
    if (!this.cfg || !m.want) return;
    const w = m.want as Record<string, string>;
    try {
      const { searchTracks, pickBest, wishlistTrack } = await import('../shared/api');
      const { tracks, source } = await searchTracks(this.cfg, `${w.a} - ${w.t}`, 5);
      const hit = pickBest(tracks, { artist: w.a || '', title: w.t || '' });
      if (!hit || !hit.id) {
        this.toast('No match on your server');
        return;
      }
      const r = await wishlistTrack(this.cfg, hit);
      this.toast(r && typeof r === 'object' && 'message' in r ? String((r as { message: unknown }).message) : 'Added to wishlist ✓');
      void source;
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'Wishlist failed');
    }
  }
}
