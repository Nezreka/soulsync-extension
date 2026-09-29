import type { ServerConfig } from '../shared/types.js';
import {
  fetchServerActivity,
  fetchServerActivityHistory,
  fetchServerActivityStats,
  serverActivityImage,
  stopServerStream,
  type SactHistoryRow,
  type SactPayload,
  type SactSession,
  type SactStats,
} from '../shared/server-activity.js';

/**
 * The web UI's Server Activity drawer, ported into the popup's Now Playing
 * tab: live Plex/Jellyfin sessions (Activity), recent plays (History), and
 * play stats (Stats) — same data, same visual design.
 *
 * Differences from the drawer, all deliberate:
 * - No floating launcher / badge (the popup is the launcher).
 * - No card click-through: the detail page is an in-app event, not a URL, so
 *   there's nothing to deep-link to from the extension.
 * - Stop-stream is wired, but the server currently answers 403 "Admin only"
 *   to pure API-key requests (the key bypasses the login gate without setting
 *   g.is_admin). The failure is surfaced honestly instead of hidden.
 */

type SubTab = 'activity' | 'history' | 'stats';

interface Deps {
  getCfg: () => ServerConfig | null;
  setStatus: (msg: string, isError?: boolean) => void;
}

/* ── tiny DOM helpers ── */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

/* ── formatting (mirrors server-activity.ts) ── */

function mbps(kbps: number | undefined): string {
  return kbps ? (kbps / 1000).toFixed(1) + ' Mbps' : '';
}

function fmtTime(ms: number | undefined): string {
  const t = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = (h && m < 10 ? '0' : '') + m;
  const ss = (s < 10 ? '0' : '') + s;
  return (h ? h + ':' : '') + mm + ':' + ss;
}

function initials(name: string | undefined): string {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

const TYPE_IC: Record<string, string> = { movie: '🎬', episode: '📺', track: '🎵', clip: '🎞️' };

function ago(epoch: number | undefined): string {
  if (!epoch) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - epoch));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return Math.floor(s / 604800) + 'w ago';
}

function actKey(s: SactSession): string {
  return s.session_key || `${s.user}|${s.title}`;
}

function stateIcon(state: string | undefined): string {
  return state === 'paused' ? '❚❚' : state === 'buffering' ? '◌' : '▶';
}

/* ── controller ── */

export function initServerActivity(deps: Deps): { setActive: (active: boolean) => void } {
  const body = document.getElementById('sact-body')!;
  const tabBtns = [...document.querySelectorAll<HTMLButtonElement>('#sact-tabs .sact-tab')];

  let active = false; // the Now Playing tab is visible
  let subTab: SubTab = 'activity';
  let poll: number | undefined;
  let tick: number | undefined;
  let actData: SactPayload | null = null;
  let polledAt = 0;
  let actKeys = '';
  let seq = 0; // guards against out-of-order fetches

  /* ── summary chips ── */

  function summaryBar(d: SactPayload): HTMLElement {
    const sm = d.summary || {};
    const wrap = el('div', 'sact-summary');
    const streams = el('span', 'sact-chip sact-chip--hero');
    const n = sm.streams || 0;
    const strong = el('strong', '', String(n));
    streams.append(strong, document.createTextNode(n === 1 ? ' stream' : ' streams'));
    wrap.append(streams);
    if (sm.transcodes) {
      const c = el('span', 'sact-chip sact-chip--tc');
      c.append(el('strong', '', String(sm.transcodes)), document.createTextNode(' transcoding'));
      wrap.append(c);
    }
    if (sm.total_bandwidth_kbps) {
      const c = el('span', 'sact-chip');
      c.append(el('strong', '', mbps(sm.total_bandwidth_kbps)));
      wrap.append(c);
    }
    if (sm.wan) {
      const c = el('span', 'sact-chip', `${sm.wan} remote`);
      wrap.append(c);
    }
    return wrap;
  }

  /* ── session cards ── */

  function buildCard(cfg: ServerConfig, s: SactSession): HTMLElement {
    const st = s.stream || {};
    const method = st.method || 'Direct Play';
    const mCls = method === 'Transcode' ? 'tc' : method === 'Direct Stream' ? 'ds' : 'ok';

    const card = el('div', `sact-card sact-st-${s.state || 'playing'}`);
    card.dataset.key = actKey(s);

    const artUrl = serverActivityImage(cfg, s.art || s.thumb);
    if (artUrl) {
      const art = el('div', 'sact-art');
      art.style.backgroundImage = `url("${artUrl}")`;
      card.append(art);
    }
    card.append(el('div', 'sact-scrim'));

    if (s.session_key) {
      const stop = el('button', 'sact-stop') as HTMLButtonElement;
      stop.type = 'button';
      stop.title = 'Stop this stream';
      stop.dataset.sessionKey = s.session_key;
      stop.dataset.title = s.title || '';
      stop.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';
      stop.addEventListener('click', (e) => {
        e.stopPropagation();
        void openStopModal(stop.dataset.sessionKey!, stop.dataset.title || '');
      });
      card.append(stop);
    }

    const row = el('div', 'sact-row');

    const poster = el('div', 'sact-poster');
    const thumbUrl = serverActivityImage(cfg, s.thumb);
    if (thumbUrl) {
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        img.style.display = 'none';
      };
      poster.append(img);
    } else {
      poster.classList.add('sact-poster--none');
      poster.textContent = TYPE_IC[s.media_type || ''] || '🎬';
    }
    if (s.media_type === 'track') {
      const eq = el('span', 'sact-eq');
      eq.setAttribute('aria-hidden', 'true');
      eq.append(el('i'), el('i'), el('i'), el('i'));
      poster.append(eq);
    }
    row.append(poster);

    const info = el('div', 'sact-info');
    const title = el('div', 'sact-title', s.title || 'Unknown');
    title.title = s.title || '';
    info.append(title);
    if (s.subtitle) info.append(el('div', 'sact-sub', s.subtitle));

    const meta = el('div', 'sact-meta');
    meta.append(el('span', 'sact-ava', initials(s.user)));
    meta.append(el('span', 'sact-uname', s.user || '?'));
    if (s.player && (s.player.product || s.player.device)) {
      meta.append(el('span', 'sact-dot', '·'));
      meta.append(el('span', 'sact-dev', s.player.product || s.player.device || ''));
    }
    info.append(meta);

    const badges = el('div', 'sact-badges');
    badges.append(el('span', `sact-badge sact-badge--${mCls}`, method));
    if (st.resolution) badges.append(el('span', 'sact-tag', st.resolution));
    if (s.bandwidth_kbps) badges.append(el('span', 'sact-tag', mbps(s.bandwidth_kbps)));
    if (s.location) badges.append(el('span', `sact-tag sact-tag--${s.location}`, s.location.toUpperCase()));
    info.append(badges);

    if (method !== 'Direct Play') {
      const bits: string[] = [];
      if (st.video) bits.push('Video ' + st.video);
      if (st.audio && /→/.test(st.audio)) bits.push('Audio ' + st.audio);
      if (st.throttled) bits.push('throttled');
      if (st.hw) bits.push('HW');
      if (bits.length) info.append(el('div', 'sact-xline', bits.join(' · ')));
    }
    row.append(info);
    card.append(row);

    const prog = el('div', 'sact-prog');
    const fill = el('div', 'sact-prog-fill');
    fill.dataset.fill = '1';
    fill.style.width = `${s.progress_pct || 0}%`;
    fill.append(el('span', 'sact-head-dot'));
    prog.append(fill);
    card.append(prog);

    const time = el('div', 'sact-time');
    const elapsed = el('span', 'sact-elapsed', `${stateIcon(s.state)} ${fmtTime(s.offset_ms)}`);
    elapsed.dataset.elapsed = '1';
    const remain = el('span', 'sact-remain', s.duration_ms ? '-' + fmtTime(Math.max(0, s.duration_ms - (s.offset_ms || 0))) : '');
    remain.dataset.remain = '1';
    time.append(elapsed, remain);
    card.append(time);

    return card;
  }

  /* ── activity render (key-stable, no flicker) ── */

  function cardMap(): Map<string, HTMLElement> {
    const m = new Map<string, HTMLElement>();
    body.querySelectorAll<HTMLElement>('.sact-card').forEach((c) => {
      const k = c.dataset.key;
      if (k) m.set(k, c);
    });
    return m;
  }

  function renderActivity(cfg: ServerConfig, d: SactPayload | null): void {
    const srvEl = document.getElementById('sact-server');
    if (srvEl) {
      srvEl.textContent =
        d?.server?.name != null && d.server.name !== ''
          ? d.server.name + (d.server.version ? ' · ' + d.server.version : '')
          : '';
    }
    if (!d || d.ok === false) {
      body.innerHTML = '';
      body.append(emptyState('🔌', d?.message || 'Server unavailable', 'Set your Plex or Jellyfin server in SoulSync Settings to see live activity.'));
      actData = null;
      actKeys = '';
      return;
    }
    const sessions = d.sessions || [];
    const keys = sessions.map(actKey).join('§');
    // Same streams as last poll -> DON'T rebuild the DOM (no art re-decode /
    // flicker); just refresh the summary + per-card state, and let the ticker
    // glide the bars.
    if (keys === actKeys && actKeys !== '' && body.querySelector('[data-sact-list]')) {
      actData = d;
      polledAt = Date.now();
      const sm = body.querySelector('[data-sact-summary]');
      if (sm) {
        sm.innerHTML = '';
        sm.append(summaryBar(d));
      }
      const map = cardMap();
      for (const s of sessions) {
        const c = map.get(actKey(s));
        if (!c) continue;
        c.className = `sact-card sact-st-${s.state || 'playing'}`;
        const badge = c.querySelector('.sact-badge');
        if (badge) {
          const m = (s.stream || {}).method || 'Direct Play';
          badge.className = `sact-badge sact-badge--${m === 'Transcode' ? 'tc' : m === 'Direct Stream' ? 'ds' : 'ok'}`;
          badge.textContent = m;
        }
      }
      liveTick();
      return;
    }
    body.innerHTML = '';
    actData = d;
    polledAt = Date.now();
    if (sessions.length === 0) {
      actKeys = '';
      body.append(summaryBar(d));
      body.append(emptyState('🌙', 'Nothing playing right now', 'Active streams show up here the moment someone hits play.'));
      return;
    }
    actKeys = keys;
    const smWrap = el('div');
    smWrap.dataset.sactSummary = '1';
    smWrap.append(summaryBar(d));
    const list = el('div', 'sact-list sact-enter');
    list.dataset.sactList = '1';
    for (const s of sessions) list.append(buildCard(cfg, s));
    body.append(smWrap, list);
    liveTick();
  }

  /** Glide progress bars + clocks between the 3s polls (playing only). */
  function liveTick(): void {
    if (!active || subTab !== 'activity' || !actData) return;
    const now = Date.now();
    const map = cardMap();
    for (const s of actData.sessions || []) {
      const c = map.get(actKey(s));
      if (!c || !s.duration_ms) continue;
      let live = (s.offset_ms || 0) + (s.state === 'playing' ? now - polledAt : 0);
      if (live > s.duration_ms) live = s.duration_ms;
      const pct = (100 * live) / s.duration_ms;
      const fill = c.querySelector<HTMLElement>('[data-fill]');
      if (fill) fill.style.width = pct.toFixed(2) + '%';
      const ee = c.querySelector('[data-elapsed]');
      if (ee) ee.textContent = `${stateIcon(s.state)} ${fmtTime(live)}`;
      const rr = c.querySelector('[data-remain]');
      if (rr) rr.textContent = '-' + fmtTime(Math.max(0, s.duration_ms - live));
    }
  }

  /* ── history tab ── */

  function renderHistory(cfg: ServerConfig, rows: SactHistoryRow[]): void {
    body.innerHTML = '';
    if (rows.length === 0) {
      body.append(emptyState('🕓', 'No history yet', 'Finished streams show up here.'));
      return;
    }
    const list = el('div', 'sact-hlist');
    for (const h of rows) {
      const row = el('div', 'sact-hrow');
      const th = el('div', 'sact-hthumb');
      const url = serverActivityImage(cfg, h.thumb);
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => {
          img.style.display = 'none';
        };
        th.append(img);
      } else {
        th.classList.add('sact-hthumb--none');
        th.textContent = TYPE_IC[h.media_type || ''] || '🎬';
      }
      const info = el('div', 'sact-hinfo');
      const t = el('div', 'sact-htitle', h.title || 'Unknown');
      t.title = h.title || '';
      info.append(t);
      if (h.subtitle) info.append(el('div', 'sact-hsub', h.subtitle));
      const meta = el('div', 'sact-hmeta');
      meta.append(el('span', 'sact-ava', initials(h.user)));
      meta.append(el('span', 'sact-uname', h.user || '?'));
      if (h.device) {
        meta.append(el('span', 'sact-dot', '·'));
        meta.append(el('span', 'sact-dev', h.device));
      }
      info.append(meta);
      row.append(th, info, el('div', 'sact-hwhen', ago(h.viewed_epoch)));
      list.append(row);
    }
    body.append(list);
  }

  /* ── stats tab ── */

  function renderStats(cfg: ServerConfig, d: SactStats): void {
    body.innerHTML = '';
    if (!d || d.ok === false) {
      body.append(emptyState('🔌', d?.message || 'Server unavailable', 'Set your Plex or Jellyfin server in SoulSync Settings to see live activity.'));
      return;
    }
    if (!d.total_plays) {
      body.append(emptyState('📊', `No plays in the last ${d.days || 30} days`, ''));
      return;
    }
    const top = el('div', 'sact-summary');
    const plays = el('span', 'sact-chip sact-chip--hero');
    plays.append(el('strong', '', String(d.total_plays || 0)), document.createTextNode(' plays'));
    const users = el('span', 'sact-chip');
    users.append(el('strong', '', String(d.unique_users || 0)), document.createTextNode(' users'));
    top.append(plays, users, el('span', 'sact-chip', `last ${d.days || 30} days`));
    body.append(top);

    body.append(section('Plays over time', graph(d.series || [])));

    if ((d.top_content || []).length) {
      const list = el('div', 'sact-cwlist');
      for (const c of d.top_content!) {
        const row = el('div', 'sact-cw');
        const th = el('div', 'sact-cw-th');
        const url = serverActivityImage(cfg, c.thumb);
        if (url) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          img.loading = 'lazy';
          img.onerror = () => {
            img.style.display = 'none';
          };
          th.append(img);
        } else {
          th.classList.add('sact-cw-th--none');
          th.textContent = TYPE_IC[c.media_type || ''] || '🎬';
        }
        const t = el('div', 'sact-cw-t', c.title || 'Unknown');
        t.title = c.title || '';
        row.append(th, t, el('div', 'sact-cw-n', String(c.plays)));
        list.append(row);
      }
      body.append(section('Most watched', list));
    }
    if ((d.top_users || []).length) body.append(section('Most active users', rankList(d.top_users!, 'user', true)));
    if ((d.top_devices || []).length) body.append(section('Top devices', rankList(d.top_devices!, 'device', false)));
  }

  function section(title: string, inner: HTMLElement): HTMLElement {
    const s = el('div', 'sact-sec');
    s.append(el('div', 'sact-sec-h', title), inner);
    return s;
  }

  function graph(series: Array<{ date: string; plays: number }>): HTMLElement {
    const wrap = el('div');
    const max = Math.max(...series.map((p) => p.plays), 1);
    const W = 416;
    const H = 82;
    const n = series.length || 1;
    const gap = 4;
    const bw = (W - (n - 1) * gap) / n;
    const bars = series
      .map((p, i) => {
        const h = Math.max(p.plays ? 4 : 2, Math.round((p.plays / max) * (H - 10)));
        const x = i * (bw + gap);
        const y = H - h;
        const day = p.date.slice(5).replace(/[<>&"]/g, '');
        const cls = p.plays === max && p.plays > 0 ? 'sact-bar sact-bar--peak' : p.plays ? 'sact-bar' : 'sact-bar sact-bar--empty';
        return `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${h}" rx="2.5" class="${cls}"><title>${day}: ${p.plays} plays</title></rect>`;
      })
      .join('');
    const first = (series[0] && series[0].date.slice(5)) || '';
    const last = (series[n - 1] && series[n - 1].date.slice(5)) || '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sact-graph');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = `<defs><linearGradient id="sactBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#22c55e" stop-opacity="0.45"/></linearGradient></defs>${bars}`;
    wrap.append(svg);
    const x = el('div', 'sact-graph-x');
    x.append(el('span', '', first), el('span', '', `peak ${max}`), el('span', '', last));
    wrap.append(x);
    return wrap;
  }

  function rankList(
    items: Array<{ plays: number } & Record<string, unknown>>,
    nameKey: string,
    withAvatar: boolean,
  ): HTMLElement {
    const max = Math.max(...items.map((i) => i.plays), 1);
    const wrap = el('div', 'sact-rank');
    for (const it of items) {
      const row = el('div', 'sact-rank-row');
      if (withAvatar) row.append(el('span', 'sact-ava', initials(String(it[nameKey]))));
      const name = el('span', 'sact-rank-name', String(it[nameKey]));
      name.title = String(it[nameKey]);
      const bar = el('span', 'sact-rank-bar');
      const fill = el('span');
      fill.style.width = `${Math.round((100 * it.plays) / max)}%`;
      bar.append(fill);
      row.append(name, bar, el('span', 'sact-rank-n', String(it.plays)));
      wrap.append(row);
    }
    return wrap;
  }

  function emptyState(icon: string, title: string, sub: string): HTMLElement {
    const w = el('div', 'sact-empty');
    w.append(el('div', 'sact-empty-ic', icon));
    w.append(el('div', 'sact-empty-t', title));
    if (sub) w.append(el('div', 'sact-empty-s', sub));
    return w;
  }

  /* ── stop-stream modal ── */

  function openStopModal(sessionKey: string, title: string): void {
    const cfg = deps.getCfg();
    if (!cfg) return;
    const ov = el('div', 'sact-stop-ov');
    const modal = el('div', 'sact-stop-modal');
    modal.append(el('div', 'sact-stop-h', 'Stop stream'));
    modal.append(el('div', 'sact-stop-sub', title || 'this stream'));
    const lbl = el('label', 'sact-stop-lbl', 'Message shown to the viewer');
    const ta = document.createElement('textarea');
    ta.className = 'sact-stop-msg';
    ta.rows = 2;
    ta.value = 'The server administrator ended this stream.';
    const foot = el('div', 'sact-stop-foot');
    const cancel = el('button', 'sact-stop-btn', 'Cancel') as HTMLButtonElement;
    cancel.type = 'button';
    const go = el('button', 'sact-stop-btn sact-stop-btn--go', 'Stop stream') as HTMLButtonElement;
    go.type = 'button';
    foot.append(cancel, go);
    modal.append(lbl, ta, foot);
    ov.append(modal);
    document.body.append(ov);
    const shut = () => ov.remove();
    cancel.addEventListener('click', shut);
    ov.addEventListener('click', (e) => {
      if (e.target === ov) shut();
    });
    go.addEventListener('click', () => {
      go.disabled = true;
      go.textContent = 'Stopping…';
      stopServerStream(cfg, sessionKey, ta.value)
        .then((r) => {
          shut();
          if (r.ok) {
            deps.setStatus('Stream stopped.');
            void refreshNow();
          } else {
            deps.setStatus(r.error || 'Could not stop the stream.', true);
          }
        })
        .catch((e: unknown) => {
          shut();
          deps.setStatus(e instanceof Error ? e.message : 'Could not stop the stream.', true);
        });
    });
  }

  /* ── data loading ── */

  function loadingRow(): void {
    body.innerHTML = '';
    body.append(emptyState('…', 'Loading…', ''));
  }

  async function refreshNow(): Promise<void> {
    const cfg = deps.getCfg();
    if (!cfg || !active || subTab !== 'activity') return;
    const my = ++seq;
    try {
      const d = await fetchServerActivity(cfg);
      if (my !== seq || !active || subTab !== 'activity') return;
      renderActivity(cfg, d);
    } catch (e) {
      if (my !== seq) return;
      body.innerHTML = '';
      body.append(
        emptyState('🔌', 'Could not reach the server', e instanceof Error ? e.message : String(e)),
      );
      actData = null;
      actKeys = '';
    }
  }

  async function loadSubTab(): Promise<void> {
    const cfg = deps.getCfg();
    if (!cfg || !active) return;
    loadingRow();
    const my = ++seq;
    try {
      if (subTab === 'history') {
        const d = await fetchServerActivityHistory(cfg);
        if (my !== seq || !active || subTab !== 'history') return;
        renderHistory(cfg, d.history || []);
      } else if (subTab === 'stats') {
        const d = await fetchServerActivityStats(cfg);
        if (my !== seq || !active || subTab !== 'stats') return;
        renderStats(cfg, d);
      } else {
        await refreshNow();
      }
    } catch (e) {
      if (my !== seq) return;
      body.innerHTML = '';
      body.append(
        emptyState('🔌', 'Could not reach the server', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  function setSubTab(t: SubTab): void {
    subTab = t;
    for (const b of tabBtns) b.classList.toggle('sact-tab--on', b.dataset.sact === t);
    window.clearInterval(poll);
    poll = undefined;
    if (t === 'activity') {
      void refreshNow();
      poll = window.setInterval(() => void refreshNow(), 3000);
    } else {
      void loadSubTab();
    }
  }

  for (const b of tabBtns) {
    b.addEventListener('click', () => setSubTab(b.dataset.sact as SubTab));
  }

  return {
    setActive(on: boolean) {
      active = on;
      if (on) {
        // Re-arm: the popup may have sat on another tab for a while.
        if (subTab === 'activity') {
          void refreshNow();
          window.clearInterval(poll);
          poll = window.setInterval(() => void refreshNow(), 3000);
        } else {
          void loadSubTab();
        }
        window.clearInterval(tick);
        tick = window.setInterval(liveTick, 500);
      } else {
        window.clearInterval(poll);
        window.clearInterval(tick);
        poll = undefined;
        tick = undefined;
        seq++; // drop any in-flight fetch
      }
    },
  };
}
