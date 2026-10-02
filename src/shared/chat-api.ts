/**
 * Typed client for SoulSync's /api/chat/* endpoints (Soulseek rooms + PMs,
 * proxied through slskd). These are web-UI routes, not the key-authed v1
 * API — the server's login gate + profile context exempt valid API keys
 * globally, so the extension rides the same ?api_key= convention as its
 * other non-v1 calls. See api.ts nonV1Fetch.
 */
import { nonV1Fetch } from './api';
import type { ServerConfig } from './types';
import type { ProtocolPayload } from './chat-protocol';

async function chatFetch(
  cfg: ServerConfig,
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const base = cfg.url.replace(/\/+$/, '');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${base}${path}${sep}api_key=${encodeURIComponent(cfg.apiKey)}`;
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  // FormData (file upload) must NOT get a JSON content type — the browser
  // sets the multipart boundary itself.
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  if (!isForm && init.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = data.error;
    throw new Error(typeof err === 'string' && err ? err : `Server returned ${res.status}`);
  }
  const err = data.error;
  if (typeof err === 'string' && err) throw new Error(err);
  if (data.success === false) throw new Error(typeof err === 'string' && err ? err : 'Request failed');
  return data;
}

const q = (s: string) => encodeURIComponent(s);

// ── shapes ──────────────────────────────────────────────────────────────

export interface ChatStatus {
  connected: boolean;
  configured: boolean;
  room: string;
  can_send: boolean;
  is_admin: boolean;
  username: string;
  error?: string;
}

export interface ChatRoomRef {
  name: string;
  home: boolean;
}

export interface ChatReaction {
  e: string;
  n: number;
  users: string[];
}

export interface ChatFileCard {
  n: string;
  m: string;
  url: string;
  size?: number;
}

export interface ChatMessage {
  username: string;
  timestamp: string | number;
  message: string;
  rich?: boolean;
  chan?: string;
  th?: string;
  tn?: string;
  av?: number;
  badge?: string;
  reply?: { u: string; x: string; ts?: string | number };
  ed?: string;
  file?: ChatFileCard;
  np?: { t: string; a: string; al?: string; img?: string };
  want?: Record<string, unknown>;
  overlay?: { n: string; layers: number; assets?: string[]; d?: unknown };
  reactions?: ChatReaction[];
}

export interface ChatProtocolEvent {
  username: string;
  timestamp: string | number;
  p: ProtocolPayload;
}

export interface ChatRoomData {
  room: string;
  joined: boolean;
  messages: ChatMessage[];
  users: string[];
  can_send: boolean;
  protocol: ChatProtocolEvent[];
}

export interface ChatConvo {
  username: string;
  unread?: boolean;
  messages?: ChatMessage[];
}

export interface ChatSettings {
  room: string;
  member_send: boolean;
  auto_join: boolean;
  auto_prove: boolean;
  giphy_key_set: boolean;
  filepost_key_set: boolean;
  filepost_expiry: string;
  avatar: number;
  badge: string;
  history_retention_days: number;
}

// ── calls ───────────────────────────────────────────────────────────────

export async function chatStatus(cfg: ServerConfig): Promise<ChatStatus> {
  const d = await chatFetch(cfg, '/api/chat/status');
  return {
    connected: d.connected !== false,
    configured: d.configured === true,
    room: typeof d.room === 'string' ? d.room : '',
    can_send: d.can_send === true,
    is_admin: d.is_admin === true,
    username: typeof d.username === 'string' ? d.username : '',
    error: typeof d.error === 'string' ? d.error : undefined,
  };
}

export async function chatRooms(cfg: ServerConfig): Promise<{ home: string; rooms: ChatRoomRef[]; can_manage: boolean }> {
  const d = await chatFetch(cfg, '/api/chat/rooms');
  const rooms = Array.isArray(d.rooms) ? d.rooms as ChatRoomRef[] : [];
  return {
    home: typeof d.home === 'string' ? d.home : '',
    rooms,
    can_manage: d.can_manage === true,
  };
}

export async function chatAvailableRooms(cfg: ServerConfig): Promise<{ rooms: Array<{ name: string; users: number; private: boolean }>; joined: string[]; can_manage: boolean }> {
  const d = await chatFetch(cfg, '/api/chat/rooms/available');
  return {
    rooms: Array.isArray(d.rooms) ? (d.rooms as Array<{ name: string; users: number; private: boolean }>) : [],
    joined: Array.isArray(d.joined) ? (d.joined as string[]) : [],
    can_manage: d.can_manage === true,
  };
}

export async function chatJoinRoom(cfg: ServerConfig, room: string): Promise<void> {
  await chatFetch(cfg, '/api/chat/rooms/join', { method: 'POST', body: JSON.stringify({ room }) });
}

export async function chatLeaveRoom(cfg: ServerConfig, room: string): Promise<void> {
  await chatFetch(cfg, '/api/chat/rooms/leave', { method: 'POST', body: JSON.stringify({ room }) });
}

export async function chatRoom(cfg: ServerConfig, room: string): Promise<ChatRoomData> {
  const d = await chatFetch(cfg, `/api/chat/room?room=${q(room)}`);
  return {
    room: typeof d.room === 'string' ? d.room : room,
    joined: d.joined === true,
    messages: Array.isArray(d.messages) ? (d.messages as ChatMessage[]) : [],
    users: Array.isArray(d.users) ? (d.users as string[]) : [],
    can_send: d.can_send === true,
    protocol: Array.isArray(d.protocol) ? (d.protocol as ChatProtocolEvent[]) : [],
  };
}

export async function chatRoomHistory(cfg: ServerConfig, room: string, before: string): Promise<ChatMessage[]> {
  const d = await chatFetch(cfg, `/api/chat/room/history?room=${q(room)}&before=${q(before)}`);
  return Array.isArray(d.messages) ? (d.messages as ChatMessage[]) : [];
}

export async function chatRoomSearch(cfg: ServerConfig, room: string, query: string): Promise<ChatMessage[]> {
  const d = await chatFetch(cfg, `/api/chat/room/search?room=${q(room)}&q=${q(query)}`);
  return Array.isArray(d.messages) ? (d.messages as ChatMessage[]) : [];
}

export interface RoomSendOptions {
  message: string;
  plain?: boolean;
  avatar?: number;
  badge?: string;
  chan?: string;
  thread?: string;
  thread_name?: string;
  reply?: { u: string; x: string };
  edit?: string;
  file?: ChatFileCard;
  np?: { t: string; a: string; al?: string; img?: string };
  want?: Record<string, unknown>;
}

export async function chatSendRoom(cfg: ServerConfig, room: string, opts: RoomSendOptions): Promise<void> {
  await chatFetch(cfg, '/api/chat/room/message', {
    method: 'POST',
    body: JSON.stringify({ room, ...opts }),
  });
}

export async function chatSendProtocol(cfg: ServerConfig, room: string, p: Record<string, unknown>): Promise<void> {
  await chatFetch(cfg, '/api/chat/room/protocol', {
    method: 'POST',
    body: JSON.stringify({ room, p }),
  });
}

export async function chatReact(cfg: ServerConfig, room: string, targetUser: string, targetText: string, emoji: string): Promise<void> {
  await chatFetch(cfg, '/api/chat/room/react', {
    method: 'POST',
    body: JSON.stringify({ room, target_user: targetUser, target_text: targetText, e: emoji }),
  });
}

export async function chatConversations(cfg: ServerConfig): Promise<{ conversations: ChatConvo[]; can_send: boolean }> {
  const d = await chatFetch(cfg, '/api/chat/conversations');
  return {
    conversations: Array.isArray(d.conversations) ? (d.conversations as ChatConvo[]) : [],
    can_send: d.can_send === true,
  };
}

export async function chatConversation(cfg: ServerConfig, username: string): Promise<{ username: string; messages: ChatMessage[]; can_send: boolean }> {
  const d = await chatFetch(cfg, `/api/chat/conversations/${q(username)}`);
  return {
    username: typeof d.username === 'string' ? d.username : username,
    messages: Array.isArray(d.messages) ? (d.messages as ChatMessage[]) : [],
    can_send: d.can_send === true,
  };
}

export async function chatSendPm(cfg: ServerConfig, username: string, message: string): Promise<void> {
  await chatFetch(cfg, `/api/chat/conversations/${q(username)}`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

export async function chatGetSettings(cfg: ServerConfig): Promise<ChatSettings> {
  const d = await chatFetch(cfg, '/api/chat/settings');
  return {
    room: typeof d.room === 'string' ? d.room : 'SoulSync',
    member_send: d.member_send === true,
    auto_join: d.auto_join !== false,
    auto_prove: d.auto_prove !== false,
    giphy_key_set: d.giphy_key_set === true,
    filepost_key_set: d.filepost_key_set === true,
    filepost_expiry: typeof d.filepost_expiry === 'string' ? d.filepost_expiry : '',
    avatar: typeof d.avatar === 'number' ? d.avatar : 0,
    badge: typeof d.badge === 'string' ? d.badge : '',
    history_retention_days: typeof d.history_retention_days === 'number' ? d.history_retention_days : 30,
  };
}

export async function chatSaveSettings(cfg: ServerConfig, settings: Partial<ChatSettings> & { giphy_key?: string; filepost_key?: string }): Promise<void> {
  await chatFetch(cfg, '/api/chat/settings', { method: 'POST', body: JSON.stringify(settings) });
}

export async function chatGifs(cfg: ServerConfig, query: string): Promise<Array<{ url: string; preview: string }>> {
  const d = await chatFetch(cfg, `/api/chat/gifs?q=${q(query)}`);
  return Array.isArray(d.gifs) ? (d.gifs as Array<{ url: string; preview: string }>) : [];
}

export async function chatUploadFile(cfg: ServerConfig, file: File): Promise<ChatFileCard> {
  const form = new FormData();
  form.append('file', file, file.name);
  const d = await chatFetch(cfg, '/api/chat/files/upload', { method: 'POST', body: form });
  return {
    n: typeof d.name === 'string' ? d.name : file.name,
    m: typeof d.mime === 'string' ? d.mime : file.type,
    url: typeof d.url === 'string' ? d.url : '',
    size: typeof d.size === 'number' ? d.size : file.size,
  };
}

export async function chatLibrarySearch(cfg: ServerConfig, query: string): Promise<Array<{ track_id: string; title: string; artist: string }>> {
  const d = await chatFetch(cfg, `/api/chat/files/library-search?q=${q(query)}`);
  return Array.isArray(d.tracks) ? (d.tracks as Array<{ track_id: string; title: string; artist: string }>) : [];
}

export async function chatImportFile(cfg: ServerConfig, url: string, name: string): Promise<void> {
  await chatFetch(cfg, '/api/chat/files/import', {
    method: 'POST',
    body: JSON.stringify({ url, name }),
  });
}

export async function chatUserCard(cfg: ServerConfig, username: string): Promise<Record<string, unknown>> {
  return chatFetch(cfg, `/api/chat/user/${q(username)}`);
}

export async function chatUserNote(cfg: ServerConfig, username: string, note: string): Promise<void> {
  await chatFetch(cfg, `/api/chat/user/${q(username)}/note`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

export async function chatUserShares(cfg: ServerConfig, username: string): Promise<Record<string, unknown>> {
  return chatFetch(cfg, `/api/chat/user/${q(username)}/shares`);
}

export async function chatUserSharesFiles(cfg: ServerConfig, username: string, dir: string): Promise<Record<string, unknown>> {
  return chatFetch(cfg, `/api/chat/user/${q(username)}/shares/files?dir=${q(dir)}`);
}

export async function chatUserDownload(cfg: ServerConfig, username: string, file: string): Promise<void> {
  await chatFetch(cfg, `/api/chat/user/${q(username)}/download`, {
    method: 'POST',
    body: JSON.stringify({ file }),
  });
}

export async function chatLinkPreview(cfg: ServerConfig, url: string): Promise<Record<string, unknown> | null> {
  try {
    return await chatFetch(cfg, `/api/chat/link-preview?url=${q(url)}`);
  } catch {
    return null;
  }
}

export async function chatResolveWantedShare(cfg: ServerConfig, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return chatFetch(cfg, '/api/chat/wanted/resolve-share', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// Re-exported so chat modules get the same non-v1 helper the rest of the
// extension uses (kept importable from one place).
export { nonV1Fetch };
