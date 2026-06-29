/* app.js — World Cup Prediction front-end controller.
   Talks to the FastAPI backend; on a network failure it transparently
   falls back to the in-memory DemoServer so the page still works. */
(function () {
  'use strict';

  // ── state ────────────────────────────────────────────────────────
  const S = {
    token: null,
    me: null,            // {id, username, display_name, is_admin}
    demo: false,         // running against DemoServer?
    matches: [],
    mine: [],            // my predictions (joined w/ match)
    myById: {},          // match_id -> predicted_winner
    leaderboard: [],     // alias of lb.overall, kept for myStats()/rank
    lb: { overall: [], group: [], knockout: [] },
    lbPhase: 'knockout',
    teams: [],           // registry [{id,name,flag}]
    stages: [],
    users: [],           // admin: user list
    view: 'matches',
    cdTimer: null,
    hdcpTeam: null,      // admin handicap selection
    resultsDirty: true,  // lazy-render the (potentially large) results view
    defaulted: {},       // match_id -> true when pick came from the system default
    apiFixtures: [],     // admin: API-Football WC2026 fixtures, for manual mapping
    settings: { home_stats: ['knockout', 'overall', 'wins'], lb_tabs: ['overall', 'group', 'knockout'] },
  };
  const HOME_STAT_LABELS = { knockout: '🔥 น็อคเอาท์ · Knockout', overall: '🏆 รวมทั้งหมด · Overall', wins: 'ชนะเต็ม · Wins' };
  const LB_TAB_LABELS = { overall: '🏆 รวมทั้งหมด', group: '🏟️ รอบแบ่งกลุ่ม', knockout: '🔥 น็อคเอาท์' };
  const HOME_STAT_KEYS_ORDER = ['knockout', 'overall', 'wins'];
  const LB_TAB_KEYS_ORDER = ['overall', 'group', 'knockout'];
  const LS = 'wc26_token';
  const LS_SETTINGS = 'wc26_settings';
  // Must match the ?v= query on this file in index.html and APP_BUILD on the
  // server. If the server reports a newer build, the client reloads once to
  // pull the fresh entry point (see reloadAll).
  const BUILD = '8';

  // Hydrate display settings from the last server-confirmed value so a returning
  // user renders the admin's real config immediately (no 3-tab flash) and stays
  // correct even if the /settings request later fails transiently.
  try {
    const cached = JSON.parse(localStorage.getItem(LS_SETTINGS));
    if (cached && Array.isArray(cached.lb_tabs) && cached.lb_tabs.length) S.settings = cached;
  } catch (_) {}

  // ── api: try network, fall back to demo ──────────────────────────
  function enterDemo() {
    if (S.demo) return;
    S.demo = true;
    const f = document.getElementById('demoFlag'); if (f) f.classList.add('show');
    const h = document.getElementById('demoHint'); if (h) h.style.display = 'block';
  }

  async function api(method, path, { body, form } = {}) {
    if (!S.demo) {
      let res;
      try {
        const opts = { method, headers: {} };
        if (S.token) opts.headers['Authorization'] = 'Bearer ' + S.token;
        if (form) {
          opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
          opts.body = new URLSearchParams(form).toString();
        } else if (body) {
          opts.headers['Content-Type'] = 'application/json';
          opts.body = JSON.stringify(body);
        }
        res = await fetch(path, opts);
      } catch (e) {
        enterDemo();                              // network/connection failure → demo
        res = null;
      }
      if (res) {
        // A real FastAPI backend always answers our endpoints with JSON.
        // A bare static host (or no server) returns HTML/404 → treat as no backend.
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('application/json')) {
          enterDemo();
        } else {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw { handled: true, status: res.status, detail: data.detail || 'เกิดข้อผิดพลาด' };
          return data;
        }
      }
    }
    // demo path
    const r = window.DemoServer.handle(method, path, { body, form, token: S.token });
    if (r.status >= 400) throw { handled: true, status: r.status, detail: r.data.detail };
    return r.data;
  }

  // ── helpers ──────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const flag = (name, override) => window.flagHTML(name, override);
  const initials = (n) => (n || '?').trim().slice(0, 1).toUpperCase();

  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.className = ''), 2400);
  }

  // backend stores kickoff as naive Bangkok local time (UTC+7 logic in api).
  // We parse as local for display/countdown — consistent within demo & deploy.
  const koDate = (s) => new Date((s || '').replace(' ', 'T'));
  function fmtKO(s) {
    const d = koDate(s);
    if (isNaN(d)) return s || '';
    return d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  const CUTOFF_MS = 30 * 60 * 1000;
  function matchState(m) {
    if (m.status === 'finished') return 'finished';
    const ko = koDate(m.kickoff_time).getTime();
    const now = Date.now();
    if (m.status === 'live') return 'live';         // backend marked in-progress
    if (now >= ko) return 'live';                   // kicked off
    if (m.locked) return 'closed';                  // admin manually closed betting
    if (now >= ko - CUTOFF_MS) return 'locked';    // within 30-min cutoff
    return 'open';
  }
  // minutes elapsed since kickoff (negative before kickoff); for live phases
  function elapsedMin(m) { return Math.floor((Date.now() - koDate(m.kickoff_time).getTime()) / 60000); }
  function livePhase(m) {
    const e = elapsedMin(m);
    if (e < 55) return { label: '🟢 ครึ่งแรก', e };
    if (e < 135) return { label: '🟡 ครึ่งหลัง', e };
    return { label: '🔴 จบเกม', e };
  }
  const canBet = (st) => st === 'open';

  // system default pick: handicap team if there's a line, else the home (left) team
  function defaultPick(m) {
    return (m.handicap_value && m.handicap_value > 0) ? m.handicap_team : m.team_home;
  }
  const STAGE_ABBR = {
    'Group Stage': 'GROUP', 'Round of 32': 'R32', 'Round of 16': 'R16',
    'Quarter-finals': 'QF', 'Semi-finals': 'SF', 'Third-Place Play-off': '3RD', 'The Final': 'FINAL',
  };
  function stageBadge(stage) {
    if (!stage) return '';
    const ab = STAGE_ABBR[stage] || stage;
    const cls = stage === 'The Final' ? 'stage-final' : (stage === 'Group Stage' ? 'stage-group' : 'stage-ko');
    return `<span class="stage-badge ${cls}">${esc(ab)}</span>`;
  }

  // points → badge
  function ptsBadge(p) {
    if (p == null) return `<span class="pts pts-pending">รอผล</span>`;
    const cls = p >= 2 ? 'pts-2' : p >= 1.5 ? 'pts-15' : p >= 1 ? 'pts-1' : p > 0 ? 'pts-05' : 'pts-0';
    const label = p >= 2 ? 'ชนะเต็ม' : p === 1 ? 'คืนเงิน' : p === 0 ? 'เสียเต็ม' : 'บางส่วน';
    return `<span class="pts ${cls}">+${(+p).toLocaleString(undefined, { maximumFractionDigits: 2 })} · ${label}</span>`;
  }
  function hdcpLabel(m) {
    const v = m.handicap_value;
    const sign = v === 0 ? '' : '−' + v;
    return `${esc(m.handicap_team)} ต่อ <b>${v === 0 ? 'เสมอ' : v}</b>`;
  }

  // ════════════════════════════════════════════════════════════════
  //  AUTH  (self-registration disabled — Admin creates users)
  // ════════════════════════════════════════════════════════════════
  function authError(msg) {
    const e = $('authErr'); e.textContent = msg; e.classList.add('show');
  }

  async function doLogin(ev) {
    ev.preventDefault();
    try {
      const data = await api('POST', '/token', { form: { username: $('loginUser').value.trim(), password: $('loginPass').value } });
      S.token = data.access_token;
      localStorage.setItem(LS, S.token);
      await boot();
    } catch (e) { authError(e.detail || 'เข้าสู่ระบบไม่สำเร็จ'); }
  }
  function logout() {
    localStorage.removeItem(LS);
    S.token = null; S.me = null;
    if (S.cdTimer) clearInterval(S.cdTimer);
    $('appShell').style.display = 'none';
    $('authScreen').style.display = 'flex';
    $('authErr').classList.remove('show');
  }

  // ════════════════════════════════════════════════════════════════
  //  BOOT / DATA
  // ════════════════════════════════════════════════════════════════
  async function boot() {
    try {
      S.me = await api('GET', '/me');
    } catch (e) { logout(); return; }

    S.defaulted = {};
    $('authScreen').style.display = 'none';
    $('appShell').style.display = 'flex';
    $('topAvatar').textContent = initials(S.me.display_name);
    $('adminTab').style.display = S.me.is_admin ? '' : 'none';
    await reloadAll();
    if (!S.me.is_admin) await applyDefaults();   // admins aren't players
    go('matches');
  }

  // auto-select the system default on any open match the user hasn't picked,
  // and persist it immediately (no confirmation needed) until they change it.
  async function applyDefaults() {
    const todo = S.matches.filter((m) => canBet(matchState(m)) && !S.myById[m.id]);
    if (!todo.length) return;
    for (const m of todo) {
      const team = defaultPick(m);
      try {
        await api('POST', '/predictions', { body: { match_id: m.id, predicted_winner: team } });
        S.myById[m.id] = team;
        S.defaulted[m.id] = true;
      } catch (e) { /* locked/cutoff — skip */ }
    }
    try {
      const mine = await api('GET', '/predictions/mine');
      S.mine = mine; S.myById = {};
      mine.forEach((p) => (S.myById[p.match_id] = p.predicted_winner));
    } catch (e) {}
    renderAll();
  }

  async function reloadAll() {
    const [matches, mine, lbOverall, lbGroup, lbKnockout, teams, stages, settings] = await Promise.all([
      api('GET', '/matches'),
      api('GET', '/predictions/mine'),
      api('GET', '/leaderboard?phase=overall'),
      api('GET', '/leaderboard?phase=group'),
      api('GET', '/leaderboard?phase=knockout'),
      api('GET', '/teams').catch(() => []),
      api('GET', '/stages').catch(() => ['Group Stage', 'Round of 32', 'Round of 16', 'Quarter-finals', 'Semi-finals', 'Third-Place Play-off', 'The Final']),
      api('GET', '/settings').catch(() => null),
    ]);
    S.matches = matches;
    S.mine = mine;
    S.lb = { overall: lbOverall, group: lbGroup, knockout: lbKnockout };
    S.leaderboard = lbOverall;
    S.teams = teams || [];
    S.stages = stages || [];
    if (settings) {
      // A new deploy is live but this tab is running an old bundle — reload once
      // (guarded per target build so a client that genuinely can't fetch the new
      // bundle never loops) to pull the fresh, no-store entry point.
      if (settings.build && BUILD && settings.build !== BUILD) {
        const k = 'wc26_reloaded_' + settings.build;
        let already = true;   // fail safe: if storage is unusable, do NOT reload
        try { already = !!sessionStorage.getItem(k); if (!already) sessionStorage.setItem(k, '1'); }
        catch (_) { already = true; }
        if (!already) { location.reload(); return; }
      }
      S.settings = { home_stats: settings.home_stats || S.settings.home_stats,
                     lb_tabs: settings.lb_tabs || S.settings.lb_tabs };
      try { localStorage.setItem(LS_SETTINGS, JSON.stringify(S.settings)); } catch (_) {}
    }
    if (!S.settings.lb_tabs.length) S.settings.lb_tabs = ['overall'];
    if (!S.settings.lb_tabs.includes(S.lbPhase)) S.lbPhase = S.settings.lb_tabs[0];
    if (window.setTeamFlags) window.setTeamFlags(S.teams);
    S.myById = {};
    mine.forEach((p) => (S.myById[p.match_id] = p.predicted_winner));
    S.resultsDirty = true;
    renderAll();
  }

  function renderAll() {
    renderMe();
    renderNext();
    renderMatches();
    renderLeaderboard();
    renderHistory();
    renderResults();
    if (S.me && S.me.is_admin) renderAdmin();
  }

  // ════════════════════════════════════════════════════════════════
  //  VIEW: PREDICT
  // ════════════════════════════════════════════════════════════════
  function statsFor(board) {
    const list = board || [];
    const row = list.find((r) => r.display_name === S.me.display_name);
    const rank = list.findIndex((r) => r.display_name === S.me.display_name) + 1;
    return { rank: rank || '–', pts: row ? row.total_points : 0, wins: row ? row.wins : 0 };
  }
  function myStats() {
    const overall = statsFor(S.lb.overall);
    const knockout = statsFor(S.lb.knockout);
    // streak: consecutive most-recent finished predictions scoring >= 1.5
    const finished = S.mine.filter((p) => p.status === 'finished' && p.points != null)
      .sort((a, b) => (b.kickoff_time || '').localeCompare(a.kickoff_time || ''));
    let streak = 0;
    for (const p of finished) { if (p.points >= 1.5) streak++; else break; }
    // spread overall for any legacy callers expecting flat {rank,pts,wins}
    return { ...overall, overall, knockout, streak, total: S.mine.length };
  }

  function homeStatBox(key, s, fmt) {
    if (key === 'knockout') return `<div class="stat stat-hot"><div class="v">${fmt(s.knockout.pts)}<small> pt</small></div><div class="k">${HOME_STAT_LABELS.knockout}</div></div>`;
    if (key === 'overall') return `<div class="stat"><div class="v">${fmt(s.overall.pts)}<small> pt</small></div><div class="k">${HOME_STAT_LABELS.overall}</div></div>`;
    if (key === 'wins') return `<div class="stat"><div class="v">${s.knockout.wins}</div><div class="k">${HOME_STAT_LABELS.wins}</div></div>`;
    return '';
  }
  function renderMe() {
    const s = myStats();
    const fmt = (n) => (+n).toLocaleString(undefined, { maximumFractionDigits: 1 });
    const keys = S.settings.home_stats.length ? S.settings.home_stats : ['knockout'];
    const boxes = keys.map((k) => homeStatBox(k, s, fmt)).join('');
    $('meHero').innerHTML = `
      <div class="mecard">
        <div class="rankpill"><span class="hash">#${s.knockout.rank}</span><span class="lbl">Rank · น็อคเอาท์</span></div>
        <div class="hello">สวัสดี · welcome back</div>
        <div class="name">${esc(S.me.display_name)} 👋</div>
        <div class="me-stats" style="grid-template-columns:repeat(${keys.length},1fr)">${boxes}</div>
      </div>`;
  }

  function nextMatch() {
    return S.matches
      .filter((m) => ['open', 'locked', 'closed', 'live'].includes(matchState(m)))
      .sort((a, b) => koDate(a.kickoff_time) - koDate(b.kickoff_time))[0];
  }

  function renderNext() {
    if (S.cdTimer) { clearInterval(S.cdTimer); S.cdTimer = null; }
    const m = nextMatch();
    const host = $('nextHero');
    if (!m) { host.innerHTML = ''; return; }
    host.innerHTML = `
      <div class="next-wrap">
        <div class="nextcard">
          <span class="ribbon">⚡ นัดถัดไป · Next kickoff</span>
          <div class="vs-row">
            <div class="tm">${flag(m.team_home, m.team_home_flag)}<div class="nm">${esc(m.team_home)}</div></div>
            <div class="vs-mid"><span class="vs">VS</span></div>
            <div class="tm">${flag(m.team_away, m.team_away_flag)}<div class="nm">${esc(m.team_away)}</div></div>
          </div>
          <div class="countdown" id="cd"></div>
          <div class="cd-live" id="cdLive" style="display:none"></div>
        </div>
      </div>`;
    const ko = koDate(m.kickoff_time).getTime();
    function tick() {
      const diff = ko - Date.now();
      const cd = $('cd'), live = $('cdLive');
      if (!cd) return;
      if (diff <= 0) {
        cd.style.display = 'none'; live.style.display = '';
        live.innerHTML = matchState(m) === 'live' ? '🔴 กำลังแข่ง · Live now' : '⏱ เริ่มแล้ว · Kicked off';
        return;
      }
      const d = Math.floor(diff / 864e5), h = Math.floor(diff % 864e5 / 36e5),
            mn = Math.floor(diff % 36e5 / 6e4), sc = Math.floor(diff % 6e4 / 1e3);
      const unit = (v, l) => `<div class="cd-unit"><b>${String(v).padStart(2, '0')}</b><span>${l}</span></div>`;
      cd.innerHTML = (d > 0 ? unit(d, 'วัน') : '') + unit(h, 'ชม.') + `<span class="cd-sep">:</span>` + unit(mn, 'นาที') + `<span class="cd-sep">:</span>` + unit(sc, 'วิ');
    }
    tick();
    S.cdTimer = setInterval(tick, 1000);
  }

  function predictBtns(m, st) {
    const picked = S.myById[m.id];
    const open = canBet(st);
    function btn(team) {
      let cls = 'pbtn';
      if (st === 'finished') {
        if (picked === team) {
          const p = (S.mine.find((x) => x.match_id === m.id) || {}).points;
          cls += p != null && p >= 1.5 ? ' correct' : ' wrong';
        } else cls += ' locked';
      } else {
        if (picked === team) cls += S.defaulted[m.id] ? ' sel def' : ' sel';
        if (!open) cls += ' locked';
      }
      const dis = (!open || st === 'finished') ? 'disabled' : '';
      const fl = team === m.team_home ? m.team_home_flag : m.team_away_flag;
      const tag = (open && S.defaulted[m.id] && picked === team) ? `<span class="def-tag">ค่าเริ่มต้น</span>` : '';
      return `<button class="${cls}" ${dis} onclick="App.predict(${m.id}, ${JSON.stringify(team).replace(/"/g, '&quot;')})">
        ${flag(team, fl)}<span>${esc(team)}</span>${tag}</button>`;
    }
    return `<div class="predict">${btn(m.team_home)}${btn(m.team_away)}</div>`;
  }

  function chip(st) {
    if (st === 'live') return `<span class="chip chip-live">🔴 LIVE</span>`;
    if (st === 'finished') return `<span class="chip chip-done">จบแล้ว · FT</span>`;
    if (st === 'closed') return `<span class="chip chip-closed">🔒 ปิดรับ · Closed</span>`;
    if (st === 'locked') return `<span class="chip chip-soon">⏳ ใกล้เตะ · Locked</span>`;
    return `<span class="chip chip-open">✏️ เปิดทาย · Open</span>`;
  }

  function isKnockout(m) { return m.stage !== 'Group Stage'; }

  function matchCard(m) {
    const st = matchState(m);
    const picked = S.myById[m.id];
    const finished = st === 'finished';
    const blocked = !finished && isKnockout(m) && S.me && !S.me.is_admin && S.me.knockout_eligible === false;
    const hasScore = m.score_home != null && m.score_away != null;
    let mid;
    if (finished || (st === 'live' && hasScore)) {
      mid = `<div class="mid"><div class="score">${m.score_home}–${m.score_away}</div>${st === 'live' ? '<div class="live-tag">🔴 LIVE</div>' : ''}</div>`;
    } else {
      mid = `<div class="mid"><div class="vstxt">VS</div></div>`;
    }
    let foot = '';
    if (finished) {
      const mp = S.mine.find((x) => x.match_id === m.id);
      foot = `<div class="result-strip">
        ${mp ? `<span class="predicted-tag">ทายไว้: <b>${flag(mp.predicted_winner, mp.predicted_winner === m.team_home ? m.team_home_flag : m.team_away_flag)} ${esc(mp.predicted_winner)}</b></span>` : `<span class="faint" style="font-size:12px">ไม่ได้ทายนัดนี้</span>`}
        ${mp ? ptsBadge(mp.points) : ''}
      </div>`;
    } else if (blocked) {
      foot = `<div class="locked-note">🚫 คุณไม่ได้รับสิทธิ์ทายผลรอบน็อคเอาท์นี้ · not eligible for the knockout round</div>`;
    } else if (st === 'locked' || st === 'live' || st === 'closed') {
      const note = st === 'closed' ? '🔒 แอดมินปิดรับการทายแล้ว · closed by admin' : '🔒 ปิดรับการทายแล้ว · predictions closed';
      foot = predictBtns(m, st) + `<div class="locked-note">${note}${picked ? ` (คุณทาย ${esc(picked)})` : ''}</div>`;
    } else {
      const isDef = S.defaulted[m.id];
      const eff = picked || defaultPick(m);
      foot = predictBtns(m, st) + `<div class="predicted-tag${isDef ? ' faint' : ''}">${isDef
        ? `⭐ ระบบเลือก <b>${esc(eff)}</b> ให้เป็นค่าเริ่มต้น — แตะเพื่อเปลี่ยน · default, tap to change`
        : `✓ คุณเลือก <b>${esc(eff)}</b> — แตะเพื่อเปลี่ยน · tap to change`}</div>`;
    }
    const hintH = m.handicap_team === m.team_home && m.handicap_value > 0 ? `ต่อ ${m.handicap_value}` : '';
    const hintA = m.handicap_team === m.team_away && m.handicap_value > 0 ? `ต่อ ${m.handicap_value}` : '';
    return `
      <div class="match ${finished ? 'is-finished' : ''}">
        <div class="match-top">
          <span class="ko">${stageBadge(m.stage)} 🗓 ${fmtKO(m.kickoff_time)}</span>
          ${chip(st)}
        </div>
        <div class="fixture">
          <div class="fx-flag fx-h">${flag(m.team_home, m.team_home_flag)}</div>
          <div class="fx-flag fx-a">${flag(m.team_away, m.team_away_flag)}</div>
          <div class="fx-name fx-h">${esc(m.team_home)}</div>
          <div class="fx-name fx-a">${esc(m.team_away)}</div>
          <div class="fx-hint fx-h">${hintH}</div>
          <div class="fx-hint fx-a">${hintA}</div>
          ${mid}
        </div>
        <div class="hdcp">⚖️ ${hdcpLabel(m)} <span class="qmark" title="ทีมต่อต้องชนะมากกว่าค่าแฮนดิแคป จึงจะนับว่าทายถูก">?</span></div>
        ${foot}
      </div>`;
  }

  function renderMatches() {
    const open = S.matches.filter((m) => matchState(m) !== 'finished')
      .sort((a, b) => koDate(a.kickoff_time) - koDate(b.kickoff_time));
    $('matchList').innerHTML = open.length
      ? open.map(matchCard).join('')
      : `<div class="empty"><div class="ico">📭</div><div class="msg">ยังไม่มีนัดที่เปิดให้ทาย<br>No open fixtures — ดูผลที่เมนู “ผลการแข่งขัน”</div></div>`;
  }

  async function predict(matchId, team) {
    try {
      await api('POST', '/predictions', { body: { match_id: matchId, predicted_winner: team } });
      S.myById[matchId] = team;
      delete S.defaulted[matchId];   // user actively chose — no longer a default
      toast('บันทึกการทายแล้ว ✓');
      const mine = await api('GET', '/predictions/mine');
      S.mine = mine; S.myById = {}; mine.forEach((p) => (S.myById[p.match_id] = p.predicted_winner));
      renderMatches(); renderHistory();
    } catch (e) { toast(e.detail || 'ทายไม่สำเร็จ', true); }
  }

  // ════════════════════════════════════════════════════════════════
  //  VIEW: LEADERBOARD
  // ════════════════════════════════════════════════════════════════
  function setLbPhase(phase) {
    S.lbPhase = phase;
    renderLbTabs();
    renderLeaderboard();
  }

  function renderLbTabs() {
    const host = $('lbPhaseTabs');
    if (!host) return;
    const tabs = S.settings.lb_tabs.length ? S.settings.lb_tabs : ['overall'];
    if (!tabs.includes(S.lbPhase)) S.lbPhase = tabs[0];
    host.innerHTML = tabs.map((t) =>
      `<button class="lb-phase-tab ${t === S.lbPhase ? 'active' : ''}" data-phase="${t}" onclick="App.setLbPhase('${t}')">${LB_TAB_LABELS[t] || t}</button>`
    ).join('');
  }

  function renderLeaderboard() {
    renderLbTabs();
    const lb = S.lb[S.lbPhase] || [];
    const podium = $('podium'), list = $('lbList');
    if (!lb.length) {
      podium.innerHTML = '';
      const msg = S.lbPhase === 'knockout' ? 'รอบน็อคเอาท์ยังไม่เริ่ม · Knockout hasn\'t started'
        : S.lbPhase === 'group' ? 'รอบแบ่งกลุ่มยังไม่มีคะแนน · No group scores yet'
        : 'ยังไม่มีคะแนน · No scores yet';
      list.innerHTML = `<div class="empty"><div class="ico">🏟️</div><div class="msg">${msg}</div></div>`;
      return;
    }

    const top3 = lb.slice(0, 3);
    const order = [top3[1], top3[0], top3[2]]; // 2nd, 1st, 3rd
    const medals = { 0: '🥇', 1: '🥈', 2: '🥉' };
    podium.innerHTML = `<div class="podium">` + order.map((r, idx) => {
      if (!r) return `<div></div>`;
      const realRank = lb.indexOf(r);
      const cls = realRank === 0 ? 'pod-1' : realRank === 1 ? 'pod-2' : 'pod-3';
      return `<div class="pod ${cls}">
        <div class="medal">${medals[realRank]}</div>
        <div class="pod-av">${initials(r.display_name)}</div>
        <div class="pod-nm">${esc(r.display_name)}</div>
        <div class="pod-pts">${(+r.total_points).toLocaleString(undefined, { maximumFractionDigits: 1 })}<small> pt</small></div>
      </div>`;
    }).join('') + `</div>`;

    list.innerHTML = lb.map((r, i) => {
      const me = S.me && r.display_name === S.me.display_name;
      const acc = r.finished ? Math.round((r.wins / r.finished) * 100) : 0;
      return `<div class="lb-row ${me ? 'me' : ''}">
        <div class="rk">${i + 1}</div>
        <div class="lb-av">${initials(r.display_name)}</div>
        <div class="lb-info">
          <div class="lb-nm">${esc(r.display_name)}${me ? '<span class="you-tag">คุณ</span>' : ''}</div>
          <div class="lb-meta">ทาย ${r.total_predictions} · ชนะเต็ม ${r.wins}${r.finished ? ` · ${acc}%` : ''}</div>
        </div>
        <div class="lb-pts">${(+r.total_points).toLocaleString(undefined, { maximumFractionDigits: 1 })}<small> pt</small></div>
      </div>`;
    }).join('');
  }

  // ════════════════════════════════════════════════════════════════
  //  VIEW: HISTORY
  // ════════════════════════════════════════════════════════════════
  function renderHistory() {
    const rows = [...S.mine].sort((a, b) => koDate(b.kickoff_time) - koDate(a.kickoff_time));
    const fin = rows.filter((p) => p.status === 'finished' && p.points != null);
    const total = fin.reduce((s, p) => s + p.points, 0);
    const wins = fin.filter((p) => p.points >= 2).length;
    $('histSummary').innerHTML = rows.length ? `
      <div class="mecard" style="margin-bottom:16px">
        <div class="me-stats" style="margin-top:0">
          <div class="stat"><div class="v">${rows.length}</div><div class="k">ทายทั้งหมด · Total</div></div>
          <div class="stat"><div class="v">${(+total).toLocaleString(undefined, { maximumFractionDigits: 1 })}<small> pt</small></div><div class="k">แต้มรวม · Points</div></div>
          <div class="stat"><div class="v">${wins}</div><div class="k">ชนะเต็ม · Wins</div></div>
        </div>
      </div>` : '';

    $('histList').innerHTML = rows.length ? rows.map((p) => {
      const st = matchState(p);
      const hasScore = p.score_home != null && p.score_away != null;
      const sc = hasScore ? `<span class="sc">${p.score_home}–${p.score_away}</span>` : `<span class="faint">vs</span>`;
      return `<div class="hrow">
        <div class="h-fixt">
          <div class="h-teams">${flag(p.team_home, p.team_home_flag)} ${esc(p.team_home)} ${sc} ${esc(p.team_away)} ${flag(p.team_away, p.team_away_flag)}</div>
          <div class="h-pick">ทาย: <b>${esc(p.predicted_winner)}</b> · ${fmtKO(p.kickoff_time)}</div>
        </div>
        ${p.points != null ? ptsBadge(p.points) : chip(st)}
      </div>`;
    }).join('') : `<div class="empty"><div class="ico">📜</div><div class="msg">ยังไม่มีประวัติการทาย<br>You haven't predicted yet</div></div>`;
  }

  // ════════════════════════════════════════════════════════════════
  //  VIEW: RESULTS  (finished matches — built for ~104 fixtures)
  // ════════════════════════════════════════════════════════════════
  function ptsMini(p) {
    if (p == null) return '';
    const cls = p >= 2 ? 'pts-2' : p >= 1.5 ? 'pts-15' : p >= 1 ? 'pts-1' : p > 0 ? 'pts-05' : 'pts-0';
    return `<span class="pts ${cls}">+${(+p).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>`;
  }

  function resultRow(m) {
    const mp = S.mine.find((x) => x.match_id === m.id);
    const you = mp
      ? `<span class="r-you">${ptsMini(mp.points)}<span class="r-pick">ทาย ${esc(mp.predicted_winner)}</span></span>`
      : `<span class="r-you faint">—</span>`;
    return `<div class="rrow">
      <div class="r-fixt">
        <span class="r-team r-h">${flag(m.team_home, m.team_home_flag)}<b>${esc(m.team_home)}</b></span>
        <span class="r-score">${m.score_home}<i>–</i>${m.score_away}</span>
        <span class="r-team r-a"><b>${esc(m.team_away)}</b>${flag(m.team_away, m.team_away_flag)}</span>
      </div>
      ${you}
    </div>`;
  }

  function renderResults() {
    const host = $('resultsList');
    if (!host) return;
    const done = S.matches.filter((m) => m.status === 'finished');
    // summary
    const mineFin = S.mine.filter((p) => p.status === 'finished' && p.points != null);
    const total = mineFin.reduce((s, p) => s + p.points, 0);
    $('resultsSummary').innerHTML = `
      <div class="res-summary">
        <div><b>${done.length}</b><span>นัดจบแล้ว · Played</span></div>
        <div><b>${mineFin.length}</b><span>คุณทาย · Your bets</span></div>
        <div><b>${(+total).toLocaleString(undefined, { maximumFractionDigits: 1 })}</b><span>แต้มจากผล · Points</span></div>
      </div>`;

    if (!done.length) { host.innerHTML = `<div class="empty"><div class="ico">📊</div><div class="msg">ยังไม่มีผลการแข่งขัน<br>No results yet</div></div>`; S.resultsDirty = false; return; }

    // group by stage (canonical order), newest first within a stage
    const order = S.stages && S.stages.length ? S.stages : Object.keys(STAGE_ABBR);
    const byStage = {};
    done.forEach((m) => { (byStage[m.stage || 'Group Stage'] ||= []).push(m); });
    const stageKeys = Object.keys(byStage).sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    // single innerHTML write keeps 100+ rows fast
    const html = stageKeys.map((sk) => {
      const rows = byStage[sk].sort((a, b) => koDate(b.kickoff_time) - koDate(a.kickoff_time));
      return `<div class="res-group">
        <div class="res-stage-head">${stageBadge(sk)}<span>${esc(sk)}</span><i>${rows.length}</i></div>
        ${rows.map(resultRow).join('')}
      </div>`;
    }).join('');
    host.innerHTML = html;
    S.resultsDirty = false;
  }

  // ════════════════════════════════════════════════════════════════
  //  VIEW: ADMIN
  // ════════════════════════════════════════════════════════════════
  // ── flag picker (registry-driven; emoji disabled) ─────────────────
  function flagPrevHTML(val, name) {
    val = (val || '').trim();
    if (!window.isFlagUrl(val)) val = window.suggestFlag(name || '') || val;
    if (window.isFlagUrl(val)) return `<img src="${val.replace(/"/g, '&quot;')}" alt="">`;
    return `<span class="mono-prev">${window.teamMonogram(name || '?')}</span>`;
  }
  function updateFlagPrev(side) {
    const input = $(side === 'home' ? 'amHomeFlag' : 'amAwayFlag');
    const prev = $(side === 'home' ? 'amHomeFlagPrev' : 'amAwayFlagPrev');
    const name = $(side === 'home' ? 'amHome' : 'amAway').value;
    if (prev) prev.innerHTML = flagPrevHTML(input.value, name);
  }
  function onTeamInput(side) {
    refreshHdcpSel();
    const input = $(side === 'home' ? 'amHomeFlag' : 'amAwayFlag');
    const name = $(side === 'home' ? 'amHome' : 'amAway').value;
    if (input && !input.dataset.touched) input.value = window.suggestFlag(name) || '';
    updateFlagPrev(side);
  }
  function onFlagInput(side) {
    const input = $(side === 'home' ? 'amHomeFlag' : 'amAwayFlag');
    if (input) input.dataset.touched = '1';
    updateFlagPrev(side);
  }
  function populateTeamDatalist() {
    const dl = $('teamNames');
    if (dl) dl.innerHTML = (S.teams || []).map((t) => `<option value="${esc(t.name)}"></option>`).join('');
    const sl = $('amStage');
    if (sl && !sl.dataset.filled) {
      sl.innerHTML = (S.stages || []).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
      sl.dataset.filled = '1';
    }
  }

  function refreshHdcpSel() {
    const home = $('amHome').value.trim(), away = $('amAway').value.trim();
    const sel = $('amHdcpSel');
    const opts = [home, away].filter(Boolean);
    if (S.hdcpTeam && !opts.includes(S.hdcpTeam)) S.hdcpTeam = null;
    if (!S.hdcpTeam && opts.length) S.hdcpTeam = opts[0];
    const flags = { home: $('amHomeFlag') ? $('amHomeFlag').value : '', away: $('amAwayFlag') ? $('amAwayFlag').value : '' };
    sel.innerHTML = ['__h', '__a'].map((slot, i) => {
      const team = i === 0 ? home : away;
      const fl = i === 0 ? flags.home : flags.away;
      const on = team && team === S.hdcpTeam;
      return `<button type="button" ${team ? '' : 'disabled'} class="${on ? 'on' : ''}" onclick="App.setHdcp(${JSON.stringify(team).replace(/"/g, '&quot;')})">
        ${team ? flag(team, fl) + ' ' + esc(team) : (i === 0 ? 'เจ้าบ้าน' : 'ทีมเยือน')}</button>`;
    }).join('');
  }
  function setHdcp(team) { if (team) { S.hdcpTeam = team; refreshHdcpSel(); } }

  async function addMatch(ev) {
    ev.preventDefault();
    const home = $('amHome').value.trim(), away = $('amAway').value.trim();
    if (!S.hdcpTeam) S.hdcpTeam = home;
    const homeFlag = ($('amHomeFlag').value || '').trim() || window.suggestFlag(home);
    const awayFlag = ($('amAwayFlag').value || '').trim() || window.suggestFlag(away);
    const ko = $('amKickoff').value;
    try {
      await api('POST', '/matches', { body: {
        team_home: home, team_away: away,
        team_home_flag: homeFlag, team_away_flag: awayFlag,
        stage: $('amStage').value || 'Group Stage',
        handicap_team: S.hdcpTeam,
        handicap_value: parseFloat($('amHdcpVal').value),
        kickoff_time: ko.length === 16 ? ko + ':00' : ko,
      }});
      toast('เพิ่มนัดแล้ว ✓');
      if (ev.target && typeof ev.target.reset === 'function') ev.target.reset();
      S.hdcpTeam = null;
      ['amHomeFlag', 'amAwayFlag'].forEach((id) => { const el = $(id); if (el) delete el.dataset.touched; });
      $('amStage').dataset.filled = '';
      updateFlagPrev('home'); updateFlagPrev('away'); refreshHdcpSel();
      await reloadAll();
    } catch (e) { toast(e.detail || 'เพิ่มนัดไม่สำเร็จ', true); }
  }

  // ── admin: display settings (home stat boxes / leaderboard tabs) ──
  function renderAdminDisplaySettings() {
    const host = $('displaySettings');
    if (!host) return;
    const chk = (group, key, label, checked) =>
      `<label class="fin-chk" style="margin:4px 10px 4px 0">
        <input type="checkbox" data-grp="${group}" value="${key}" ${checked ? 'checked' : ''}> ${label}
      </label>`;
    host.innerHTML = `
      <div style="margin-bottom:10px">
        <div class="faint" style="font-size:11.5px;margin-bottom:5px">กล่องคะแนนหน้าทายผล · Home stat boxes</div>
        ${HOME_STAT_KEYS_ORDER.map((k) => chk('home_stats', k, HOME_STAT_LABELS[k], S.settings.home_stats.includes(k))).join('')}
      </div>
      <div style="margin-bottom:10px">
        <div class="faint" style="font-size:11.5px;margin-bottom:5px">แท็บตารางคะแนน · Leaderboard tabs</div>
        ${LB_TAB_KEYS_ORDER.map((k) => chk('lb_tabs', k, LB_TAB_LABELS[k], S.settings.lb_tabs.includes(k))).join('')}
      </div>
      <button class="btn btn-gold btn-sm" onclick="App.saveDisplaySettings()">💾 บันทึก</button>`;
  }
  async function saveDisplaySettings() {
    const host = $('displaySettings');
    const val = (grp) => Array.from(host.querySelectorAll(`input[data-grp="${grp}"]:checked`)).map((i) => i.value);
    const lb_tabs = val('lb_tabs');
    if (!lb_tabs.length) { toast('ต้องเลือกอย่างน้อย 1 แท็บตารางคะแนน', true); return; }
    try {
      const r = await api('PUT', '/admin/settings', { body: { home_stats: val('home_stats'), lb_tabs } });
      S.settings = { home_stats: r.home_stats, lb_tabs: r.lb_tabs };
      toast('บันทึกการแสดงผลแล้ว ✓');
      renderMe(); renderLbTabs(); renderLeaderboard();
    } catch (e) { toast(e.detail || 'บันทึกไม่สำเร็จ', true); }
  }

  function renderAdmin() {
    populateTeamDatalist();
    refreshHdcpSel();
    renderAdminDisplaySettings();
    renderAdminUsers();
    renderAdminTeams();
    renderAdminLive();
    const host = $('adminMatches');
    const sorted = [...S.matches].sort((a, b) => {
      const fa = a.status === 'finished', fb = b.status === 'finished';
      if (fa !== fb) return fa ? 1 : -1;                          // upcoming first
      return fa ? koDate(b.kickoff_time) - koDate(a.kickoff_time)  // finished: newest first
               : koDate(a.kickoff_time) - koDate(b.kickoff_time);  // upcoming: soonest first
    });
    if (!sorted.length) { host.innerHTML = `<div class="empty"><div class="ico">⚽</div><div class="msg">ยังไม่มีนัด · No fixtures</div></div>`; return; }
    host.innerHTML = sorted.map((m) => {
      const st = matchState(m);
      const fin = m.status === 'finished';
      const lockBtn = fin ? '' :
        `<button class="btn btn-sm ${m.locked ? 'btn-gold' : 'btn-ghost'}" onclick="App.toggleLock(${m.id}, ${m.locked ? 0 : 1})" title="${m.locked ? 'เปิดรับทายอีกครั้ง' : 'ปิดรับทายทันที'}">${m.locked ? '🔓 เปิดรับ' : '🔒 ปิดรับ'}</button>`;
      return `<div class="admin-match">
        <div class="am-top">
          <span class="am-fixt">${stageBadge(m.stage)} ${flag(m.team_home, m.team_home_flag)} ${esc(m.team_home)} <span class="faint">vs</span> ${esc(m.team_away)} ${flag(m.team_away, m.team_away_flag)}</span>
          ${chip(st)}
        </div>
        <div class="faint" style="font-size:11px;margin-bottom:9px">🗓 ${fmtKO(m.kickoff_time)} · <span id="hdcp${m.id}">⚖️ ${esc(m.handicap_team)} ${m.handicap_value} <button class="lnk-edit" onclick="App.editHandicap(${m.id})" title="แก้ราคา handicap">✏️ แก้ราคา</button></span></div>
        ${fin ? '' : `<div class="faint" style="font-size:11px;margin:-4px 0 9px">${apiMapHtml(m)}</div>`}
        <div class="am-form">
          <input class="in" id="rh${m.id}" type="number" min="0" placeholder="0" value="${fin ? m.score_home : ''}">
          <span class="dash">–</span>
          <input class="in" id="ra${m.id}" type="number" min="0" placeholder="0" value="${fin ? m.score_away : ''}">
          <button class="btn btn-gold btn-sm" onclick="App.setResult(${m.id})">${fin ? 'แก้ผล' : 'บันทึกผล'}</button>
          ${lockBtn}
          <button class="btn btn-danger btn-sm" onclick="App.delMatch(${m.id})" title="ลบนัด">🗑</button>
        </div>
      </div>`;
    }).join('');
  }

  // ── admin: users ──────────────────────────────────────────────────
  function renderAdminUsers() {
    const host = $('adminUsers');
    if (!host) return;
    api('GET', '/admin/users').then((list) => {
      S.users = list;
      host.innerHTML = list.map((u) => `
        <div class="urow">
          <div class="lb-av">${initials(u.display_name)}</div>
          <div class="lb-info">
            <div class="lb-nm">${esc(u.display_name)}${u.is_admin ? '<span class="you-tag" style="background:var(--gold)">ADMIN</span>' : ''}${!u.is_admin && !u.knockout_eligible ? '<span class="you-tag" style="background:var(--loss-bg);color:var(--loss)">ไม่ร่วมน็อคเอาท์</span>' : ''}</div>
            <div class="lb-meta">@${esc(u.username)}</div>
          </div>
          <button class="btn btn-ghost btn-sm u-edit" onclick="App.editUser(${u.id}, ${JSON.stringify(u.display_name).replace(/"/g, '&quot;')}, ${JSON.stringify(u.username).replace(/"/g, '&quot;')}, ${u.knockout_eligible ? 1 : 0})">แก้</button>
          ${u.is_admin ? '' : `<button class="btn btn-danger btn-sm" onclick="App.delUser(${u.id}, ${JSON.stringify(u.display_name).replace(/"/g, '&quot;')})" title="ลบผู้ใช้">🗑</button>`}
        </div>`).join('');
    }).catch(() => {});
  }
  async function createUser(ev) {
    ev.preventDefault();
    try {
      await api('POST', '/admin/users', { body: {
        username: $('cuUser').value.trim(), display_name: $('cuName').value.trim(), password: $('cuPass').value,
      }});
      toast('สร้างผู้ใช้แล้ว ✓');
      if (ev.target && ev.target.reset) ev.target.reset();
      renderAdminUsers();
      await reloadAll();
    } catch (e) { toast(e.detail || 'สร้างไม่สำเร็จ', true); }
  }
  async function delUser(id, name) {
    if (!confirm(`ลบผู้ใช้ "${name}" และการทายทั้งหมด?`)) return;
    try { await api('DELETE', '/admin/users/' + id); toast('ลบผู้ใช้แล้ว'); renderAdminUsers(); await reloadAll(); }
    catch (e) { toast(e.detail || 'ลบไม่สำเร็จ', true); }
  }

  // ── profile / edit-user modal ─────────────────────────────────────
  function openProfile() {
    S.editTarget = { self: true };
    $('modalTitle').textContent = 'โปรไฟล์ของฉัน · My profile';
    $('pfName').value = S.me.display_name;
    $('pfUserRow').style.display = '';
    $('pfUser').value = S.me.username;
    $('pfPass').value = '';
    $('pfKoRow').style.display = 'none';
    $('modal').classList.add('open');
    setTimeout(() => $('pfName').focus(), 60);
  }
  function editUser(id, name, username, koEligible) {
    S.editTarget = { id };
    $('modalTitle').textContent = 'แก้ไขผู้ใช้ · Edit user';
    $('pfName').value = name;
    $('pfUserRow').style.display = '';
    $('pfUser').value = username || '';
    $('pfPass').value = '';
    $('pfKoRow').style.display = '';
    setPfKo(!!koEligible);
    $('modal').classList.add('open');
    setTimeout(() => $('pfName').focus(), 60);
  }
  function setPfKo(on) {
    S.pfKo = on;
    $('pfKoSw').classList.toggle('on', on);
    $('pfKoLabel').textContent = on ? 'อนุญาตให้ทาย' : 'ไม่อนุญาต';
  }
  function togglePfKnockout() { setPfKo(!S.pfKo); }
  function closeModal() { $('modal').classList.remove('open'); }
  function modalBg(ev) { if (ev.target.id === 'modal') closeModal(); }

  async function saveProfile(ev) {
    ev.preventDefault();
    const body = { display_name: $('pfName').value.trim() };
    const pass = $('pfPass').value;
    if (pass) body.password = pass;
    try {
      if (S.editTarget && S.editTarget.self) {
        await api('POST', '/me/update', { body });
        S.me.display_name = body.display_name;
        $('topAvatar').textContent = initials(S.me.display_name);
      } else {
        body.knockout_eligible = !!S.pfKo;
        await api('PUT', '/admin/users/' + S.editTarget.id, { body });
      }
      toast('บันทึกแล้ว ✓');
      closeModal();
      renderAdminUsers();
      await reloadAll();
    } catch (e) { toast(e.detail || 'บันทึกไม่สำเร็จ', true); }
  }

  // ── admin: teams registry ─────────────────────────────────────────
  function renderAdminTeams() {
    const host = $('adminTeams');
    if (!host) return;
    host.innerHTML = (S.teams || []).map((t) => `
      <div class="trow">
        <span class="t-prev">${window.flagHTML(t.name, t.flag)}</span>
        <span class="t-name">${esc(t.name)}</span>
        <button class="btn btn-ghost btn-sm" onclick="App.editTeam(${JSON.stringify(t.name).replace(/"/g, '&quot;')}, ${JSON.stringify(t.flag || '').replace(/"/g, '&quot;')})">แก้</button>
        <button class="btn btn-danger btn-sm" onclick="App.delTeam(${t.id})">🗑</button>
      </div>`).join('');
  }
  function editTeam(name, flagUrl) {
    $('tmName').value = name; $('tmFlag').value = flagUrl;
    $('tmName').focus();
    updateTeamPrev();
  }
  function updateTeamPrev() {
    const prev = $('tmPrev');
    if (prev) prev.innerHTML = flagPrevHTML($('tmFlag').value, $('tmName').value);
  }
  async function saveTeam(ev) {
    ev.preventDefault();
    const name = $('tmName').value.trim();
    if (!name) { toast('ใส่ชื่อทีม', true); return; }
    try {
      await api('POST', '/teams', { body: { name, flag: $('tmFlag').value.trim() } });
      toast('บันทึกทีมแล้ว ✓');
      if (ev.target && ev.target.reset) ev.target.reset();
      updateTeamPrev();
      await reloadAll();
    } catch (e) { toast(e.detail || 'บันทึกไม่สำเร็จ', true); }
  }
  async function delTeam(id) {
    if (!confirm('ลบทีมนี้จากทะเบียน?')) return;
    try { await api('DELETE', '/teams/' + id); toast('ลบทีมแล้ว'); await reloadAll(); }
    catch (e) { toast(e.detail || 'ลบไม่สำเร็จ', true); }
  }

  // ── admin: SQL console (editable results) ─────────────────────────
  const EDITABLE_COLS = {
    users: ['display_name', 'username', 'is_admin'],
    teams: ['name', 'flag'],
    matches: ['team_home', 'team_away', 'team_home_flag', 'team_away_flag', 'stage', 'handicap_team', 'handicap_value', 'kickoff_time', 'score_home', 'score_away', 'status', 'locked'],
    predictions: ['predicted_winner', 'points'],
  };
  async function runQuery() {
    const sql = $('sqlBox').value.trim();
    const out = $('sqlOut');
    if (!sql) { out.innerHTML = ''; return; }
    try {
      const r = await api('POST', '/admin/query', { body: { sql } });
      if (!r.columns || !r.columns.length) { out.innerHTML = `<div class="sql-empty">— ไม่มีผลลัพธ์ —</div>`; return; }
      // editable only when the query targets one whitelisted table and returns its id
      const fm = sql.toLowerCase().match(/from\s+([a-z_]+)/);
      const table = fm && EDITABLE_COLS[fm[1]] ? fm[1] : null;
      const idIdx = r.columns.indexOf('id');
      const editable = table && idIdx >= 0;
      const head = r.columns.map((c) => `<th>${esc(c)}</th>`).join('');
      const body = r.rows.map((row) => {
        const id = row[idIdx];
        return `<tr>${row.map((v, ci) => {
          const col = r.columns[ci];
          const canEdit = editable && col !== 'id' && EDITABLE_COLS[table].includes(col);
          const val = v == null ? '' : v;
          if (canEdit) return `<td class="ed" contenteditable="true" data-t="${table}" data-id="${id}" data-c="${esc(col)}" data-orig="${esc(val)}" onblur="App.saveCell(this)">${esc(val)}</td>`;
          return `<td>${esc(v == null ? '∅' : v)}</td>`;
        }).join('')}</tr>`;
      }).join('');
      const note = editable ? `<div class="sql-meta">${r.row_count} แถว · แก้ไขช่องที่ไฮไลต์ได้ (แตะแล้วพิมพ์)</div>` : `<div class="sql-meta">${r.row_count} แถว · rows</div>`;
      out.innerHTML = note + `<div class="sql-scroll"><table class="sql-table ${editable ? 'editable' : ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    } catch (e) { out.innerHTML = `<div class="sql-err">⚠ ${esc(e.detail || 'query error')}</div>`; }
  }
  async function saveCell(td) {
    const orig = td.dataset.orig;
    const val = td.textContent.trim();
    if (val === orig) return;
    try {
      await api('POST', '/admin/update_cell', { body: { table: td.dataset.t, id: parseInt(td.dataset.id, 10), column: td.dataset.c, value: val } });
      td.dataset.orig = val;
      td.classList.add('saved');
      setTimeout(() => td.classList.remove('saved'), 900);
      toast('บันทึกแล้ว ✓');
      // refresh app state so edits reflect elsewhere (sql output stays as-is)
      reloadAll();
    } catch (e) { toast(e.detail || 'แก้ไขไม่สำเร็จ', true); td.textContent = orig; }
  }
  function sqlSample(q) { $('sqlBox').value = q; runQuery(); }

  async function toggleLock(id, locked) {
    try { await api('POST', '/admin/lock', { body: { match_id: id, locked } }); toast(locked ? 'ปิดรับการทายแล้ว 🔒' : 'เปิดรับการทายอีกครั้ง 🔓'); await reloadAll(); }
    catch (e) { toast(e.detail || 'ทำรายการไม่สำเร็จ', true); }
  }

  // ── admin: live in-progress scores (one batch call) ───────────────
  function liveMatches() {
    const now = Date.now();
    return S.matches
      .filter((m) => m.status !== 'finished' && now >= koDate(m.kickoff_time).getTime())
      .sort((a, b) => koDate(a.kickoff_time) - koDate(b.kickoff_time));
  }
  function renderAdminLive() {
    const host = $('liveScores');
    if (!host) return;
    const live = liveMatches();
    if (!live.length) {
      host.innerHTML = `<div class="faint" style="font-size:12px">ยังไม่มีแมตช์ที่กำลังแข่งขัน · no match in play</div>`;
      return;
    }
    host.innerHTML = live.map((m) => {
      const ph = livePhase(m);
      const sh = m.score_home == null ? '' : m.score_home;
      const sa = m.score_away == null ? '' : m.score_away;
      return `<div class="admin-match">
        <div class="am-top">
          <span class="am-fixt">${flag(m.team_home, m.team_home_flag)} ${esc(m.team_home)} <span class="faint">vs</span> ${esc(m.team_away)} ${flag(m.team_away, m.team_away_flag)}</span>
          <span class="chip chip-live">${ph.label} · ${ph.e}'</span>
        </div>
        <div class="am-form">
          <input class="in" id="lh${m.id}" type="number" min="0" placeholder="0" value="${sh}">
          <span class="dash">–</span>
          <input class="in" id="la${m.id}" type="number" min="0" placeholder="0" value="${sa}">
          <label class="fin-chk"><input type="checkbox" id="lf${m.id}" ${ph.e >= 135 ? 'checked' : ''}> จบเกม</label>
        </div>
      </div>`;
    }).join('') +
      `<button class="btn btn-gold btn-block" onclick="App.saveLiveScores()" style="margin-top:6px">💾 บันทึกสกอร์สดทั้งหมด · update all (1 call)</button>`;
  }
  // ── admin: manual mapping to API-Football fixtures (WC2026) ───────
  function apiMapHtml(m) {
    const mapped = m.apifootball_fixture_id;
    if (!S.apiFixtures.length) {
      return mapped
        ? `🔗 ผูกกับ API แล้ว (fixture #${mapped}) · <button class="lnk-edit" onclick="App.loadApiFixtures()">โหลดรายชื่อเพื่อเปลี่ยน</button>`
        : `🔗 <button class="lnk-edit" onclick="App.loadApiFixtures()">โหลดรายชื่อนัดจาก API-Football เพื่อผูก</button>`;
    }
    const opt = (v, label, sel) => `<option value="${v}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
    const opts = [opt('', '— ยังไม่ผูก —', !mapped)].concat(
      S.apiFixtures.map((f) => opt(f.fixture_id, `${f.date} · ${f.home} vs ${f.away}`, f.fixture_id === mapped)));
    return `🔗 ผูก API: <select class="in in-mini" style="max-width:240px" onchange="App.mapFixture(${m.id}, this.value)">${opts.join('')}</select>`;
  }
  async function loadApiFixtures() {
    try {
      const r = await api('GET', '/admin/apifootball/fixtures');
      S.apiFixtures = r.fixtures || [];
      if (!S.apiFixtures.length) toast(r.note || `ยังไม่พบรายการนัด (${r.provider || 'provider'})`, true);
      else toast(`โหลด ${S.apiFixtures.length} นัดจาก ${r.provider || 'API'} แล้ว — เลือกผูกแต่ละนัดได้เลย ✓`);
      renderAdmin();
    } catch (e) { toast(e.detail || 'โหลดรายชื่อจาก API ไม่สำเร็จ', true); }
  }
  async function mapFixture(matchId, val) {
    const fid = val === '' ? null : parseInt(val, 10);
    try {
      await api('POST', '/admin/apifootball/map', { body: { match_id: matchId, fixture_id: fid } });
      const m = S.matches.find((x) => x.id === matchId);
      if (m) m.apifootball_fixture_id = fid;
      toast(fid ? 'ผูก fixture แล้ว ✓ ระบบจะดึงสกอร์อัตโนมัติเมื่อเริ่มแข่ง' : 'ยกเลิกการผูกแล้ว');
    } catch (e) { toast(e.detail || 'ผูก fixture ไม่สำเร็จ', true); renderAdmin(); }
  }

  async function fetchScores() {
    try {
      const r = await api('GET', '/admin/fetch_scores');
      let filled = 0;
      (r.matched || []).forEach((x) => {
        const lh = $('lh' + x.match_id), la = $('la' + x.match_id), lf = $('lf' + x.match_id);
        if (lh && la) { lh.value = x.score_home; la.value = x.score_away; if (lf) lf.checked = !!x.final; filled++; }
      });
      if (filled) toast(`ดึงสกอร์แล้ว · เติม ${filled} แมตช์ — ตรวจแล้วกดบันทึก ✓`);
      else if (r.note) toast(r.note, true);
      else toast(`ดึงข้อมูลแล้ว แต่ยังไม่มีนัดที่ผูกไว้กำลังแข่งอยู่`, true);
    } catch (e) { toast(e.detail || 'ดึงสกอร์ไม่สำเร็จ', true); }
  }

  async function saveLiveScores() {
    const results = [];
    for (const m of liveMatches()) {
      const h = $('lh' + m.id).value, a = $('la' + m.id).value;
      if (h === '' || a === '') continue;
      results.push({ match_id: m.id, score_home: parseInt(h, 10), score_away: parseInt(a, 10), final: $('lf' + m.id).checked });
    }
    if (!results.length) { toast('ยังไม่มีสกอร์ให้บันทึก', true); return; }
    try {
      const r = await api('POST', '/admin/results_batch', { body: { results } });
      toast(`อัปเดต ${r.matches || 0} แมตช์ · คิดคะแนนแล้ว ✓`);
      await reloadAll();
    } catch (e) { toast(e.detail || 'บันทึกสกอร์ไม่สำเร็จ', true); }
  }

  // ── admin: edit handicap line anytime ─────────────────────────────
  function editHandicap(id) {
    const m = S.matches.find((x) => x.id === id);
    if (!m) return;
    const box = $('hdcp' + id);
    if (!box) return;
    const opt = (t) => `<option value="${esc(t)}" ${m.handicap_team === t ? 'selected' : ''}>${esc(t)}</option>`;
    box.innerHTML = `⚖️
      <select class="in in-mini" id="eht${id}">${opt(m.team_home)}${opt(m.team_away)}</select>
      <input class="in in-mini" id="ehv${id}" type="number" step="0.25" min="0" value="${m.handicap_value}" style="width:62px">
      <button class="btn btn-gold btn-sm" onclick="App.saveHandicap(${id})">✓</button>
      <button class="btn btn-ghost btn-sm" onclick="App.renderAdmin()">✕</button>`;
  }
  async function saveHandicap(id) {
    const ht = $('eht' + id).value;
    const hv = parseFloat($('ehv' + id).value);
    if (isNaN(hv)) { toast('กรอกราคาให้ถูกต้อง', true); return; }
    try {
      const r = await api('PUT', '/matches/' + id, { body: { handicap_team: ht, handicap_value: hv } });
      toast(r.recomputed ? `อัปเดตราคา · คิดคะแนนใหม่ ${r.recomputed} รายการ ✓` : 'อัปเดตราคาแล้ว ✓');
      await reloadAll();
    } catch (e) { toast(e.detail || 'อัปเดตราคาไม่สำเร็จ', true); }
  }

  async function setResult(id) {
    const h = $('rh' + id).value, a = $('ra' + id).value;
    if (h === '' || a === '') { toast('กรอกสกอร์ให้ครบ', true); return; }
    try {
      const r = await api('POST', '/admin/result', { body: { match_id: id, score_home: parseInt(h, 10), score_away: parseInt(a, 10) } });
      toast(`บันทึกผลแล้ว · คำนวณ ${r.updated || 0} รายการ ✓`);
      await reloadAll();
    } catch (e) { toast(e.detail || 'บันทึกผลไม่สำเร็จ', true); }
  }
  async function delMatch(id) {
    if (!confirm('ลบนัดนี้และการทายทั้งหมด?')) return;
    try { await api('DELETE', '/matches/' + id); toast('ลบนัดแล้ว'); await reloadAll(); }
    catch (e) { toast(e.detail || 'ลบไม่สำเร็จ', true); }
  }

  // ════════════════════════════════════════════════════════════════
  //  NAV
  // ════════════════════════════════════════════════════════════════
  function go(view) {
    S.view = view;
    if (view === 'results' && S.resultsDirty) renderResults();
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $('scroll').scrollTop = 0;
  }

  // ── init ─────────────────────────────────────────────────────────
  async function init() {
    const saved = localStorage.getItem(LS);
    if (saved) { S.token = saved; try { await boot(); return; } catch (e) {} }
    // probe: a JSON response from /me means a real backend is up
    try {
      const res = await fetch('/me');
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) enterDemo();
    } catch (e) { enterDemo(); }
  }

  window.App = {
    doLogin, logout,
    go, predict, addMatch, setResult, delMatch, setHdcp, refreshHdcpSel,
    onTeamInput, onFlagInput, toggleLock,
    saveLiveScores, fetchScores, loadApiFixtures, mapFixture, editHandicap, saveHandicap, renderAdmin,
    saveDisplaySettings,
    createUser, delUser, editUser, saveTeam, delTeam, editTeam, updateTeamPrev,
    openProfile, closeModal, modalBg, saveProfile, togglePfKnockout,
    runQuery, sqlSample, saveCell,
    setLbPhase,
    _state: S,
  };
  document.addEventListener('DOMContentLoaded', init);
})();
