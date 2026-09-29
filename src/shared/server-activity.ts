import type { ServerConfig } from './types.js';

/**
 * SoulSync live server-activity client (the Tautulli-style view).
 *
 * These are session-cookie web routes (`/api/server-activity*`), NOT the
 * `/api/v1` API — so they don't speak the v1 envelope and they don't take a
 * Bearer header from `<img>` tags. Auth rides the query string instead:
 * `?api_key=<key>`, which the login/launch-PIN gates honor (server PR #1375).
 * Responses are `{ok: true, …}` / `{ok: false, reason, message}`.
 */

export interface SactStream {
  method?: string;
  video?: string;
  audio?: string;
  resolution?: string;
  throttled?: boolean;
  hw?: boolean;
}

export interface SactSession {
  session_key?: string;
  user?: string;
  title?: string;
  subtitle?: string;
  state?: string;
  media_type?: string;
  art?: string;
  thumb?: string;
  stream?: SactStream;
  bandwidth_kbps?: number;
  location?: string;
  progress_pct?: number;
  duration_ms?: number;
  offset_ms?: number;
  player?: { product?: string; device?: string };
  link?: { kind: string; id: string | number; source?: string };
}

export interface SactSummary {
  streams?: number;
  transcodes?: number;
  total_bandwidth_kbps?: number;
  wan?: number;
}

export interface SactPayload {
  ok?: boolean;
  reason?: string;
  message?: string;
  server?: { name?: string; version?: string };
  summary?: SactSummary;
  sessions?: SactSession[];
}

export interface SactHistoryRow {
  title?: string;
  subtitle?: string;
  user?: string;
  device?: string;
  media_type?: string;
  thumb?: string;
  viewed_epoch?: number;
}

export interface SactStats extends SactPayload {
  total_plays?: number;
  unique_users?: number;
  days?: number;
  series?: Array<{ date: string; plays: number }>;
  top_content?: Array<{ title?: string; media_type?: string; thumb?: string; plays: number }>;
  top_users?: Array<{ user: string; plays: number }>;
  top_devices?: Array<{ device: string; plays: number }>;
}

function baseUrl(cfg: ServerConfig): string {
  return cfg.url.replace(/\/+$/, '');
}

function withKey(cfg: ServerConfig, path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${baseUrl(cfg)}${path}${sep}api_key=${encodeURIComponent(cfg.apiKey)}`;
}

async function sactFetch<T>(cfg: ServerConfig, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(withKey(cfg, path), {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers || {}) },
  });
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok) {
    throw new Error(data?.error || `Server returned ${res.status}`);
  }
  return data;
}

/** Live sessions — every active Plex/Jellyfin stream. Never throws for */
/** "no server"; the payload carries ok:false + reason instead. */
export function fetchServerActivity(cfg: ServerConfig): Promise<SactPayload> {
  return sactFetch<SactPayload>(cfg, '/api/server-activity');
}

export async function fetchServerActivityHistory(
  cfg: ServerConfig,
  limit = 30,
): Promise<SactPayload & { history?: SactHistoryRow[] }> {
  return sactFetch(cfg, `/api/server-activity/history?limit=${limit}`);
}

export function fetchServerActivityStats(cfg: ServerConfig): Promise<SactStats> {
  return sactFetch<SactStats>(cfg, '/api/server-activity/stats');
}

/**
 * Stop a stream. Needs an admin session on the server — a pure API-key
 * request currently answers 403 "Admin only" (the key bypasses the login
 * gate but doesn't set g.is_admin). Callers should surface that honestly.
 */
export async function stopServerStream(
  cfg: ServerConfig,
  sessionKey: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  return sactFetch(cfg, '/api/server-activity/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_key: sessionKey, message }),
  });
}

/** Proxied Plex/Jellyfin artwork for `<img>` tags (token never hits the browser). */
export function serverActivityImage(cfg: ServerConfig, path: string | undefined): string {
  if (!path) return '';
  return withKey(cfg, `/api/server-activity/image?path=${encodeURIComponent(path)}`);
}
