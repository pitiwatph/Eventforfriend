/* app.js — Event For Friend, credit-betting front-end controller.
   Talks to the FastAPI backend; on a network failure it transparently
   falls back to the in-memory DemoServer so the page still works. */
(function () {
  'use strict';

  // ── state ────────────────────────────────────────────────────────
  const S = {
    token: null,
    me: null,            // {id, username, display_name, is_admin, credits, …}
    demo: false,
    matches: [],
    days: [],            // [{play_date, status, matches, finished, first_kickoff}]
    myBets: [],
    betsByMatch: {},     // match_id -> [bet, …] (mine)
    ledger: [],
    leaderboard: [],
    teams: [],
    stages: [],
    users: [],
    view: 'matches',
    day: null,           // selected matchday on the betting screen
    cdTimer: null,
    hdcpTeam: null,      // admin: handicap side selection
    pick: {},            // match_id -> side the user has tapped (pre-submit)
    apiFixtures: [],
    cutoffMin: 10,
  };
  const LS = 'wc26_token';
  // Must match the ?v= query on this file in index.html and APP_BUILD on the
  // server. If the server reports a newer build, the client reloads once.
  const BUILD = '16';

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
        enterDemo();
        res = null;
      }
      if (res) {
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

  // money: 2dp only when needed, thousands separated
  function money(n) {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    return v.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  const signed = (n) => (Number(n) > 0 ? '+' : '') + money(n);

  // Decimal odds -> Thai "water". 1.90 => 0.90 (win 90 on a 100 stake).
  const water = (odds) => (Number(odds) - 1).toFixed(2);

  // backend stores kickoff as naive Bangkok local time.
  const koDate = (s) => new Date((s || '').replace(' ', 'T'));
  function fmtKO(s) {
    const d = koDate(s);
    if (isNaN(d)) return s || '';
    return d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDay(iso) {
    const d = new Date(iso + 'T00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const cutoffMs = () => S.cutoffMin * 60 * 1000;
  const msToCutoff = (m) => koDate(m.kickoff_time).getTime() - cutoffMs() - Date.now();

  function hdcpLabel(m) {
    const v = Number(m.handicap_value) || 0;
    if (!v) return 'เสมอ · ราคาเรียบ';
    return `${esc(m.handicap_team)} ต่อ ${v}`;
  }

  // outcome (-1 … 1) -> reuse the existing pts-* badge palette
  function outcomeBadge(b) {
    if (b.status === 'void') return '<span class="pts pts-pending">ยกเลิก</span>';
    if (b.status !== 'settled' || b.outcome == null) return '<span class="pts pts-pending">รอผล</span>';
    const o = Number(b.outcome), net = Number(b.payout) - Number(b.stake);
    const cls = o > 0.6 ? 'pts-2' : o > 0 ? 'pts-15' : o === 0 ? 'pts-1' : o > -0.6 ? 'pts-05' : 'pts-0';
    const lbl = o > 0.6 ? 'ชนะ' : o > 0 ? 'ชนะครึ่ง' : o === 0 ? 'คืนเงิน' : o > -0.6 ? 'เสียครึ่ง' : 'เสีย';
    return `<span class="pts ${cls}">${lbl} ${signed(net)}</span>`;
  }

  function authError(msg) {
    const e = $('authErr');
    e.textContent = msg || '';
    e.className = msg ? 'auth-err show' : 'auth-err';
  }

  // ── auth ─────────────────────────────────────────────────────────
  async function doLogin(ev) {
    ev.preventDefault();
    authError('');
    try {
      const d = await api('POST', '/token', { form: { username: $('loginUser').value.trim(), password: $('loginPass').value } });
      S.token = d.access_token;
      localStorage.setItem(LS, S.token);
      await boot();
    } catch (e) {
      authError(e.detail || 'เข้าสู่ระบบไม่สำเร็จ');
    }
  }

  function logout() {
    localStorage.removeItem(LS);
    S.token = null; S.me = null;
    clearInterval(S.cdTimer);
    $('appShell').style.display = 'none';
    $('authScreen').style.display = 'flex';
    $('loginPass').value = '';
  }

  async function boot() {
    try {
      S.me = await api('GET', '/me');
    } catch (e) {
      logout(); return;
    }
    $('authScreen').style.display = 'none';
    $('appShell').style.display = 'block';
    $('adminTab').style.display = S.me.is_admin ? '' : 'none';
    $('topAvatar').textContent = initials(S.me.display_name);
    await reloadAll();
    clearInterval(S.cdTimer);
    S.cdTimer = setInterval(tick, 1000);
  }

  async function reloadAll() {
    try {
      const [settings, matches, days, bets, lb, teams, stages] = await Promise.all([
        api('GET', '/settings'), api('GET', '/matches'), api('GET', '/bet_days'),
        api('GET', '/bets/mine'), api('GET', '/leaderboard'),
        api('GET', '/teams'), api('GET', '/stages'),
      ]);
      if (settings && settings.build && settings.build !== BUILD && !S.demo) {
        // a newer bundle is deployed — pull it once
        location.reload(); return;
      }
      if (settings && settings.cutoff_min) S.cutoffMin = settings.cutoff_min;
      S.matches = matches; S.days = days; S.myBets = bets;
      S.leaderboard = lb; S.teams = teams; S.stages = stages;
      S.me = await api('GET', '/me');

      S.betsByMatch = {};
      bets.forEach((b) => {
        if (b.status === 'void') return;
        (S.betsByMatch[b.match_id] = S.betsByMatch[b.match_id] || []).push(b);
      });

      // default the day selector to the first day that is open, else the next
      // day with unfinished fixtures, else the last day
      if (!S.day || !S.days.some((d) => d.play_date === S.day)) {
        const open = S.days.find((d) => d.status === 'open');
        const next = S.days.find((d) => d.finished < d.matches);
        S.day = (open || next || S.days[S.days.length - 1] || {}).play_date || null;
      }
      if (S.me.is_admin) {
        S.users = await api('GET', '/admin/users').catch(() => []);
        S.ledger = await api('GET', '/admin/ledger').catch(() => []);
      } else {
        S.ledger = await api('GET', '/ledger/mine').catch(() => []);
      }
      renderAll();
    } catch (e) {
      if (e && e.status === 401) { logout(); return; }
      toast(e.detail || 'โหลดข้อมูลไม่สำเร็จ', true);
    }
  }

  function renderAll() {
    renderMe();
    renderDayTabs();
    renderMatches();
    renderLeaderboard();
    renderHistory();
    renderResults();
    if (S.me && S.me.is_admin) renderAdmin();
    populateTeamDatalist();
  }

  // ── home hero ────────────────────────────────────────────────────
  function renderMe() {
    const m = S.me || {};
    const rank = S.leaderboard.findIndex((r) => r.username === m.username);
    $('meHero').innerHTML = `
      <div class="mecard">
        ${rank >= 0 ? `<div class="rankpill"><span class="hash">#${rank + 1}</span><span class="lbl">Rank</span></div>` : ''}
        <div class="hello">ยินดีต้อนรับ · Welcome</div>
        <div class="name">${esc(m.display_name)}</div>
        <div class="me-stats">
          <div class="stat stat-hot">
            <div class="v">${money(m.credits)}</div>
            <div class="k">เครดิตคงเหลือ</div>
          </div>
          <div class="stat">
            <div class="v">${signed(m.net)}</div>
            <div class="k">กำไร/ขาดทุน</div>
          </div>
          <div class="stat">
            <div class="v">${money(m.staked)}</div>
            <div class="k">แทงไปแล้ว</div>
          </div>
        </div>
      </div>`;
  }

  // ── matchday tabs ────────────────────────────────────────────────
  const DAY_CHIP = { open: 'chip-open', closed: 'chip-done', draft: 'chip-soon' };
  const DAY_WORD = { open: 'เปิดรับ', closed: 'ปิดแล้ว', draft: 'ยังไม่เปิด' };

  function renderDayTabs() {
    const el = $('dayTabs');
    if (!el) return;
    if (!S.days.length) { el.innerHTML = ''; return; }
    el.innerHTML = S.days.map((d) => `
      <button class="lb-phase-tab ${d.play_date === S.day ? 'active' : ''}"
              onclick="App.setDay('${d.play_date}')">
        ${esc(fmtDay(d.play_date))}
        <span class="chip ${DAY_CHIP[d.status] || 'chip-soon'}" style="margin-left:6px">${DAY_WORD[d.status] || ''}</span>
      </button>`).join('');
  }

  function setDay(d) { S.day = d; renderDayTabs(); renderMatches(); }

  // ── match cards ──────────────────────────────────────────────────
  function betChip(m) {
    if (m.status === 'finished') return '<span class="chip chip-done">จบแล้ว</span>';
    if (m.status === 'live') return '<span class="chip chip-live">● กำลังแข่ง</span>';
    if (m.can_bet) return '<span class="chip chip-open">เปิดรับ</span>';
    return '<span class="chip chip-soon">🔒 ปิดรับ</span>';
  }

  function sideBtn(m, side, odds) {
    const mine = (S.betsByMatch[m.id] || []).filter((b) => b.side === side);
    const staked = mine.reduce((s, b) => s + Number(b.stake), 0);
    const picked = S.pick[m.id] === side;
    const cls = ['pbtn', picked ? 'sel' : '', staked ? 'has-bet' : ''].filter(Boolean).join(' ');
    const dis = m.can_bet ? '' : 'disabled';
    return `<button class="${cls}" ${dis} onclick="App.pick(${m.id}, ${JSON.stringify(side).replace(/"/g, '&quot;')})">
        <span class="f">${flag(side)}</span>
        <span class="pb-name">${esc(side)}</span>
        <span class="pb-odds">${water(odds)}</span>
        ${staked ? `<span class="pb-mine">แทงแล้ว ${money(staked)}</span>` : ''}
      </button>`;
  }

  function stakeRow(m) {
    if (!m.can_bet) return '';
    const side = S.pick[m.id];
    if (!side) return `<div class="stake-hint">แตะทีมที่จะแทงด้านบน</div>`;
    const odds = side === m.team_home ? m.odds_home : m.odds_away;
    return `
      <div class="stake-row">
        <div class="stake-quick">
          ${[50, 100, 200, 500].map((v) => `<button type="button" onclick="App.setStake(${m.id},${v})">${v}</button>`).join('')}
          <button type="button" onclick="App.setStake(${m.id},${Math.floor(S.me.credits)})">ทั้งหมด</button>
        </div>
        <div class="stake-go">
          <input class="in in-mini" id="stake-${m.id}" type="number" min="1" step="1"
                 placeholder="จำนวนเครดิต" oninput="App.previewStake(${m.id})">
          <button class="btn btn-gold btn-sm" onclick="App.placeBet(${m.id})">แทง ${esc(side)}</button>
        </div>
        <div class="stake-prev" id="prev-${m.id}">ราคา ${water(odds)} · ชนะได้ —</div>
      </div>`;
  }

  function myBetsOn(m) {
    const mine = (S.betsByMatch[m.id] || []);
    if (!mine.length) return '';
    return `<div class="mybets">${mine.map((b) => `
      <div class="mybet">
        <span class="mb-side">${flag(b.side)} ${esc(b.side)}</span>
        <span class="mb-terms">${esc(b.hdcp_team_taken)} ${b.line_taken} · น้ำ ${water(b.odds_taken)}</span>
        <span class="mb-stake">${money(b.stake)}</span>
        ${b.status === 'open' && m.can_bet
          ? `<button class="lnk-edit" onclick="App.cancelBet(${b.id})">ยกเลิก</button>`
          : outcomeBadge(b)}
      </div>`).join('')}</div>`;
  }

  function matchCard(m) {
    const mid = (m.score_home != null)
      ? `<div class="score">${m.score_home}<i>–</i>${m.score_away}</div>`
      : '<div class="vstxt">VS</div>';
    const closed = !m.can_bet && m.status === 'upcoming'
      ? `<div class="locked-note">🔒 ${esc(m.closed_reason || 'ปิดรับ')}</div>` : '';
    return `
      <div class="match ${m.status === 'finished' ? 'is-finished' : ''}">
        <div class="match-top">
          ${betChip(m)}
          <span class="ko">${esc(fmtKO(m.kickoff_time))}</span>
        </div>
        <div class="fixture">
          <div class="fx-flag fx-h"><span class="flag">${flag(m.team_home, m.team_home_flag)}</span></div>
          <div class="mid">${mid}</div>
          <div class="fx-flag fx-a"><span class="flag">${flag(m.team_away, m.team_away_flag)}</span></div>
          <div class="fx-name fx-h">${esc(m.team_home)}</div>
          <div class="fx-name fx-a">${esc(m.team_away)}</div>
          <div class="fx-hint fx-h">${m.handicap_team === m.team_home ? 'ต่อ' : ''}</div>
          <div class="fx-hint fx-a">${m.handicap_team === m.team_away ? 'ต่อ' : ''}</div>
        </div>
        <div class="hdcp"><b>${hdcpLabel(m)}</b>
          ${m.pool_bets ? `<span class="pool-chip">${m.pool_bets} บิล · ${money(m.pool_total)}</span>` : ''}
        </div>
        <div class="predict">
          ${sideBtn(m, m.team_home, m.odds_home)}
          ${sideBtn(m, m.team_away, m.odds_away)}
        </div>
        ${m.can_bet ? `<div class="cd-cut" data-cut="${m.id}"></div>` : ''}
        ${stakeRow(m)}
        ${closed}
        ${myBetsOn(m)}
      </div>`;
  }

  function renderMatches() {
    const list = S.matches.filter((m) => m.play_date === S.day);
    const el = $('matchList');
    if (!S.days.length) {
      el.innerHTML = '<div class="empty">ยังไม่มีนัด — รอแอดมินเพิ่มโปรแกรม</div>';
      return;
    }
    const day = S.days.find((d) => d.play_date === S.day);
    const banner = day && day.status !== 'open'
      ? `<div class="day-banner">${day.status === 'closed' ? '🔒 วันนี้ปิดรับพนันแล้ว' : '⏳ แอดมินยังไม่เปิดรับพนันของวันนี้'}</div>` : '';
    el.innerHTML = banner + (list.length
      ? list.map(matchCard).join('')
      : '<div class="empty">ไม่มีนัดในวันนี้</div>');
    tick();   // fill the cutoff countdowns now instead of waiting a second
  }

  // per-second countdown to each match's betting cutoff
  function tick() {
    document.querySelectorAll('[data-cut]').forEach((el) => {
      const m = S.matches.find((x) => String(x.id) === el.dataset.cut);
      if (!m) return;
      const left = msToCutoff(m);
      if (left <= 0) { el.innerHTML = '<span class="cd-live">ปิดรับแล้ว</span>'; return; }
      const s = Math.floor(left / 1000), h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
      el.innerHTML = `<span class="cut-lbl">ปิดรับใน</span> <b>${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}</b>`;
    });
  }

  // ── betting actions ──────────────────────────────────────────────
  function pick(matchId, side) {
    S.pick[matchId] = S.pick[matchId] === side ? null : side;
    renderMatches();
  }

  function setStake(matchId, v) {
    const el = $('stake-' + matchId);
    if (el) { el.value = v; previewStake(matchId); }
  }

  function previewStake(matchId) {
    const m = S.matches.find((x) => x.id === matchId);
    const el = $('prev-' + matchId), inp = $('stake-' + matchId);
    if (!m || !el || !inp) return;
    const side = S.pick[matchId];
    const odds = side === m.team_home ? m.odds_home : m.odds_away;
    const stake = Number(inp.value) || 0;
    const win = stake * (Number(odds) - 1);
    el.innerHTML = `ราคา ${water(odds)} · ชนะได้ <b>${stake ? '+' + money(win) : '—'}</b>`
      + (stake > S.me.credits ? ' <span class="over">เครดิตไม่พอ</span>' : '');
  }

  async function placeBet(matchId) {
    const side = S.pick[matchId];
    const inp = $('stake-' + matchId);
    const stake = Number(inp && inp.value) || 0;
    if (!side) return toast('เลือกทีมก่อน', true);
    if (stake <= 0) return toast('ใส่จำนวนเครดิต', true);
    try {
      const r = await api('POST', '/bets', { body: { match_id: matchId, side, stake } });
      S.pick[matchId] = null;
      toast(`แทงสำเร็จ · ล็อกราคา ${water(r.odds_taken)} ที่เส้น ${r.line_taken}`);
      await reloadAll();
    } catch (e) {
      toast(e.detail || 'แทงไม่สำเร็จ', true);
    }
  }

  async function cancelBet(betId) {
    if (!confirm('ยกเลิกบิลนี้และคืนเครดิต?')) return;
    try {
      await api('DELETE', '/bets/' + betId);
      toast('ยกเลิกแล้ว · คืนเครดิต');
      await reloadAll();
    } catch (e) {
      toast(e.detail || 'ยกเลิกไม่สำเร็จ', true);
    }
  }

  // ── leaderboard ──────────────────────────────────────────────────
  function renderLeaderboard() {
    const rows = S.leaderboard;
    const pod = $('podium'), list = $('lbList');
    if (!rows.length) { pod.innerHTML = ''; list.innerHTML = '<div class="empty">ยังไม่มีผู้เล่น</div>'; return; }
    const MEDAL = ['🥇', '🥈', '🥉'];
    const top = rows.slice(0, 3);
    // visual order puts the winner in the middle
    pod.innerHTML = `<div class="podium">${[1, 0, 2].filter((i) => top[i]).map((i) => `
      <div class="pod pod-${i + 1}">
        <div class="medal">${MEDAL[i]}</div>
        <div class="pod-av">${initials(top[i].display_name)}</div>
        <div class="pod-nm">${esc(top[i].display_name)}</div>
        <div class="pod-pts">${money(top[i].credits)}<small> เครดิต</small></div>
      </div>`).join('')}</div>`;
    list.innerHTML = rows.map((r, i) => `
      <div class="lb-row ${r.username === S.me.username ? 'me' : ''}">
        <div class="rk">${i + 1}</div>
        <div class="lb-av">${initials(r.display_name)}</div>
        <div class="lb-info">
          <div class="lb-nm">${esc(r.display_name)}${r.username === S.me.username ? '<span class="you-tag">คุณ</span>' : ''}</div>
          <div class="lb-meta">
            ${r.bets} บิล · ชนะ ${r.wins} · แพ้ ${r.losses}
            ${r.at_risk > 0 ? ` · ค้าง ${money(r.at_risk)}` : ''}
          </div>
        </div>
        <div class="lb-pts">${money(r.credits)}<small><br>${signed(r.net)}</small></div>
      </div>`).join('');
  }

  // ── history: my bets + credit ledger ─────────────────────────────
  function renderHistory() {
    const bets = S.myBets;
    const settled = bets.filter((b) => b.status === 'settled');
    const net = settled.reduce((s, b) => s + (Number(b.payout) - Number(b.stake)), 0);
    $('histSummary').innerHTML = `
      <div class="me-stats" style="margin-bottom:14px">
        <div class="stat"><div class="v">${bets.filter((b) => b.status !== 'void').length}</div><div class="k">บิลทั้งหมด</div></div>
        <div class="stat"><div class="v">${settled.filter((b) => b.outcome > 0).length}</div><div class="k">ชนะ</div></div>
        <div class="stat stat-hot"><div class="v">${signed(net)}</div><div class="k">กำไร/ขาดทุน</div></div>
      </div>`;
    $('histList').innerHTML = bets.length ? bets.map((b) => `
      <div class="hrow">
        <div class="h-fixt">
          <div class="h-teams">
            ${flag(b.team_home, b.team_home_flag)} ${esc(b.team_home)}
            <span class="sc">${b.score_home != null ? `${b.score_home}–${b.score_away}` : 'v'}</span>
            ${flag(b.team_away, b.team_away_flag)} ${esc(b.team_away)}
          </div>
          <div class="h-pick">
            แทง <b>${esc(b.side)}</b> ${money(b.stake)} ·
            ${esc(b.hdcp_team_taken)} ${b.line_taken} · น้ำ ${water(b.odds_taken)}
            · ${esc(fmtKO(b.kickoff_time))}
          </div>
        </div>
        ${outcomeBadge(b)}
      </div>`).join('') : '<div class="empty">ยังไม่มีบิล</div>';

    const led = $('ledgerList');
    if (led) {
      const REASON = { topup: '💰 แอดมินเติม', adjust: '⚙ ปรับยอด', bet: '🎯 แทง', payout: '🏆 รับเงิน', refund: '↩ คืนเงิน' };
      led.innerHTML = S.ledger.length ? S.ledger.map((l) => `
        <div class="hrow">
          <div class="h-fixt">
            <div class="h-teams">${REASON[l.reason] || esc(l.reason)}</div>
            <div class="h-pick">${esc(l.note || '')} · ${esc(l.created_at || '')}</div>
          </div>
          <div class="led-amt">
            <b class="${Number(l.delta) >= 0 ? 'up' : 'down'}">${signed(l.delta)}</b>
            <span>คงเหลือ ${money(l.balance_after)}</span>
          </div>
        </div>`).join('') : '<div class="empty">ยังไม่มีรายการ</div>';
    }
  }

  // ── results ──────────────────────────────────────────────────────
  function renderResults() {
    const done = S.matches.filter((m) => m.status === 'finished');
    $('resultsSummary').innerHTML = `
      <div class="res-summary">
        <div><b>${done.length}</b><span>นัดที่จบ</span></div>
        <div><b>${S.matches.length}</b><span>นัดทั้งหมด</span></div>
        <div><b>${S.days.length}</b><span>วันแข่ง</span></div>
      </div>`;
    // group finished fixtures by matchday, newest first
    const byDay = {};
    done.forEach((m) => (byDay[m.play_date] = byDay[m.play_date] || []).push(m));
    const dayKeys = Object.keys(byDay).sort().reverse();
    $('resultsList').innerHTML = dayKeys.length ? dayKeys.map((d) => `
      <div class="res-group">
        <div class="res-stage-head">📅 ${esc(fmtDay(d))}<i>${byDay[d].length} นัด</i></div>
        ${byDay[d].map((m) => {
          const mine = (S.betsByMatch[m.id] || []);
          return `<div class="rrow">
            <div class="r-fixt">
              <div class="r-team r-h"><span class="flag">${flag(m.team_home, m.team_home_flag)}</span><b>${esc(m.team_home)}</b></div>
              <div class="r-score">${m.score_home}<i>–</i>${m.score_away}</div>
              <div class="r-team r-a"><b>${esc(m.team_away)}</b><span class="flag">${flag(m.team_away, m.team_away_flag)}</span></div>
            </div>
            <div class="r-you">
              ${mine.length
                ? mine.map((b) => `${outcomeBadge(b)}<div class="r-pick">${esc(b.side)} ${money(b.stake)}</div>`).join('')
                : '<div class="r-pick">ไม่ได้แทง</div>'}
            </div>
          </div>`;
        }).join('')}
      </div>`).join('') : '<div class="empty">ยังไม่มีนัดที่จบ</div>';
  }

  // ── admin ────────────────────────────────────────────────────────
  function populateTeamDatalist() {
    const dl = $('teamNames');
    if (dl) dl.innerHTML = S.teams.map((t) => `<option value="${esc(t.name)}">`).join('');
  }

  function refreshHdcpSel() {
    const h = $('amHome').value.trim(), a = $('amAway').value.trim();
    const el = $('amHdcpSel');
    if (!el) return;
    const opts = [h, a].filter(Boolean);
    if (!opts.length) { el.innerHTML = '<span class="faint" style="font-size:11px">ใส่ชื่อทีมก่อน</span>'; return; }
    if (!opts.includes(S.hdcpTeam)) S.hdcpTeam = opts[0];
    el.innerHTML = opts.map((t) => `<button type="button" class="${S.hdcpTeam === t ? 'on' : ''}" onclick="App.setHdcp(${JSON.stringify(t).replace(/"/g, '&quot;')})">${flag(t)} ${esc(t)}</button>`).join('');
  }
  function setHdcp(t) { S.hdcpTeam = t; refreshHdcpSel(); }
  function onTeamInput() { refreshHdcpSel(); updateFlagPrev(); }

  function flagPrevHTML(name, url) { return url ? `<img class="flag-img" src="${esc(url)}" alt="">` : flag(name); }
  function updateFlagPrev() {
    const hp = $('amHomeFlagPrev'), ap = $('amAwayFlagPrev');
    if (hp) hp.innerHTML = flagPrevHTML($('amHome').value.trim(), $('amHomeFlag').value.trim());
    if (ap) ap.innerHTML = flagPrevHTML($('amAway').value.trim(), $('amAwayFlag').value.trim());
  }
  function onFlagInput() { updateFlagPrev(); }
  function updateTeamPrev() {
    const p = $('tmPrev');
    if (p) p.innerHTML = flagPrevHTML($('tmName').value.trim(), $('tmFlag').value.trim());
  }

  async function addMatch(ev) {
    ev.preventDefault();
    const body = {
      team_home: $('amHome').value.trim(), team_away: $('amAway').value.trim(),
      team_home_flag: $('amHomeFlag').value.trim(), team_away_flag: $('amAwayFlag').value.trim(),
      stage: $('amStage').value, handicap_team: S.hdcpTeam,
      handicap_value: parseFloat($('amHdcpVal').value),
      odds_home: parseFloat($('amOddsHome').value) || 1.90,
      odds_away: parseFloat($('amOddsAway').value) || 1.90,
      kickoff_time: $('amKickoff').value,
    };
    if (!body.handicap_team) return toast('เลือกทีมต่อก่อน', true);
    try {
      await api('POST', '/matches', { body });
      toast('เพิ่มนัดแล้ว');
      $('addMatchForm').reset(); S.hdcpTeam = null;
      await reloadAll();
    } catch (e) { toast(e.detail || 'เพิ่มนัดไม่สำเร็จ', true); }
  }

  function renderAdmin() {
    renderAdminDays();
    renderAdminMatches();
    renderAdminUsers();
    renderAdminTeams();
    renderAdminLive();
    const st = $('amStage');
    if (st && !st.options.length) st.innerHTML = S.stages.map((s) => `<option>${esc(s)}</option>`).join('');
  }

  function renderAdminDays() {
    const el = $('adminDays');
    if (!el) return;
    el.innerHTML = S.days.length ? S.days.map((d) => `
      <div class="urow">
        <div class="lb-info">
          <div class="lb-nm">${esc(fmtDay(d.play_date))}
            <span class="chip ${DAY_CHIP[d.status]}">${DAY_WORD[d.status]}</span></div>
          <div class="lb-meta">${d.matches} นัด · จบแล้ว ${d.finished}</div>
        </div>
        <div class="urow-act">
          ${d.status !== 'open' ? `<button class="btn btn-gold btn-sm" onclick="App.setDayStatus('${d.play_date}','open')">เปิดรับ</button>` : ''}
          ${d.status === 'open' ? `<button class="btn btn-danger btn-sm" onclick="App.setDayStatus('${d.play_date}','closed')">ปิดรับ</button>` : ''}
        </div>
      </div>`).join('') : '<div class="empty">ยังไม่มีวันแข่ง</div>';
  }

  async function setDayStatus(day, status) {
    try {
      await api('PUT', '/admin/bet_days', { body: { play_date: day, status } });
      toast(status === 'open' ? `เปิดรับพนัน ${fmtDay(day)}` : `ปิดรับ ${fmtDay(day)}`);
      await reloadAll();
    } catch (e) { toast(e.detail || 'ทำรายการไม่สำเร็จ', true); }
  }

  function renderAdminMatches() {
    const el = $('adminMatches');
    if (!el) return;
    el.innerHTML = S.matches.length ? S.matches.map((m) => `
      <div class="admin-match">
        <div class="am-fixt">
          <b>${flag(m.team_home, m.team_home_flag)} ${esc(m.team_home)} v ${flag(m.team_away, m.team_away_flag)} ${esc(m.team_away)}</b>
          <div class="faint" style="font-size:10.5px">
            ${esc(fmtKO(m.kickoff_time))} · ${hdcpLabel(m)} ·
            น้ำ ${water(m.odds_home)} / ${water(m.odds_away)} ·
            ${m.pool_bets} บิล ${money(m.pool_total)}
            ${m.can_bet ? '<span class="chip chip-open">เปิด</span>' : `<span class="chip chip-soon">${esc(m.closed_reason || 'ปิด')}</span>`}
          </div>
        </div>
        ${m.can_bet ? `
          <div class="am-line">
            <span class="am-lbl">ราคา</span>
            <label class="am-fld"><i>เส้น</i><input class="in in-mini" id="hv-${m.id}" type="number" step="0.25" value="${m.handicap_value}"></label>
            <label class="am-fld"><i>${esc(m.team_home).slice(0, 6)}</i><input class="in in-mini" id="oh-${m.id}" type="number" step="0.01" value="${m.odds_home}"></label>
            <label class="am-fld"><i>${esc(m.team_away).slice(0, 6)}</i><input class="in in-mini" id="oa-${m.id}" type="number" step="0.01" value="${m.odds_away}"></label>
            <button class="btn btn-ghost btn-sm" onclick="App.saveOdds(${m.id})">💾 บันทึกราคา</button>
          </div>` : ''}
        <div class="am-line">
          <span class="am-lbl">ผล</span>
          <label class="am-fld"><i>เหย้า</i><input class="in in-mini" id="sh-${m.id}" type="number" value="${m.score_home ?? ''}"></label>
          <label class="am-fld"><i>เยือน</i><input class="in in-mini" id="sa-${m.id}" type="number" value="${m.score_away ?? ''}"></label>
          <button class="btn btn-gold btn-sm" onclick="App.setResult(${m.id})">บันทึกผล</button>
          <button class="btn btn-ghost btn-sm" onclick="App.toggleLock(${m.id}, ${m.locked ? 0 : 1})">${m.locked ? '🔓 เปิด' : '🔒 ปิด'}</button>
          <button class="btn btn-danger btn-sm" onclick="App.delMatch(${m.id})">ลบ</button>
        </div>
      </div>`).join('') : '<div class="empty">ยังไม่มีนัด</div>';
  }

  async function saveOdds(id) {
    const body = {
      odds_home: parseFloat($('oh-' + id).value),
      odds_away: parseFloat($('oa-' + id).value),
      handicap_value: parseFloat($('hv-' + id).value),
    };
    try {
      await api('PUT', `/matches/${id}/odds`, { body });
      toast('อัปเดตราคาแล้ว · บิลเดิมยังใช้ราคาเก่า');
      await reloadAll();
    } catch (e) { toast(e.detail || 'อัปเดตราคาไม่สำเร็จ', true); }
  }

  async function setResult(id) {
    const sh = parseInt($('sh-' + id).value, 10), sa = parseInt($('sa-' + id).value, 10);
    if (isNaN(sh) || isNaN(sa)) return toast('ใส่สกอร์ให้ครบ', true);
    if (!confirm('บันทึกผลและจ่ายเครดิตทุกบิลของนัดนี้?')) return;
    try {
      const r = await api('POST', '/admin/result', { body: { match_id: id, score_home: sh, score_away: sa } });
      toast(`บันทึกผลแล้ว · คิดเงิน ${r.settled} บิล`);
      await reloadAll();
    } catch (e) { toast(e.detail || 'บันทึกผลไม่สำเร็จ', true); }
  }

  async function toggleLock(id, locked) {
    try { await api('POST', '/admin/lock', { body: { match_id: id, locked } }); await reloadAll(); }
    catch (e) { toast(e.detail || 'ทำรายการไม่สำเร็จ', true); }
  }

  async function delMatch(id) {
    if (!confirm('ลบนัดนี้? บิลที่ยังไม่คิดผลจะถูกคืนเครดิต')) return;
    try {
      const r = await api('DELETE', '/matches/' + id);
      toast(`ลบแล้ว · คืนเครดิต ${r.refunded} บิล`);
      await reloadAll();
    } catch (e) { toast(e.detail || 'ลบไม่สำเร็จ', true); }
  }

  function renderAdminUsers() {
    const el = $('adminUsers');
    if (!el) return;
    el.innerHTML = S.users.map((u) => `
      <div class="urow">
        <div class="lb-av">${initials(u.display_name)}</div>
        <div class="lb-info">
          <div class="lb-nm">${esc(u.display_name)}${u.is_admin ? ' <span class="chip chip-open">แอดมิน</span>' : ''}</div>
          <div class="lb-meta">@${esc(u.username)} · เครดิต <b>${money(u.credits)}</b>${u.open_bets ? ` · ค้าง ${u.open_bets} บิล` : ''}</div>
        </div>
        <div class="urow-act">
          <input class="in in-mini" id="cr-${u.id}" type="number" placeholder="+/-" style="width:70px">
          <button class="btn btn-gold btn-sm" onclick="App.giveCredits(${u.id})">เติม</button>
          <button class="lnk-edit" onclick="App.editUser(${u.id})">แก้</button>
          ${u.is_admin ? '' : `<button class="btn btn-danger btn-sm" onclick="App.delUser(${u.id})">ลบ</button>`}
        </div>
      </div>`).join('');
  }

  async function giveCredits(userId) {
    const el = $('cr-' + userId);
    const amount = Number(el && el.value);
    if (!amount) return toast('ใส่จำนวน (ติดลบ = ดึงคืน)', true);
    try {
      const r = await api('POST', '/admin/credits', { body: { user_id: userId, amount } });
      toast(`ปรับเครดิตแล้ว · คงเหลือ ${money(r.credits)}`);
      await reloadAll();
    } catch (e) { toast(e.detail || 'เติมเครดิตไม่สำเร็จ', true); }
  }

  async function createUser(ev) {
    ev.preventDefault();
    try {
      await api('POST', '/admin/users', {
        body: {
          username: $('cuUser').value.trim(), display_name: $('cuName').value.trim(),
          password: $('cuPass').value, credits: parseFloat($('cuCredits').value) || 0,
        },
      });
      toast('สร้างผู้ใช้แล้ว');
      $('createUserForm').reset();
      await reloadAll();
    } catch (e) { toast(e.detail || 'สร้างผู้ใช้ไม่สำเร็จ', true); }
  }

  async function delUser(id) {
    if (!confirm('ลบผู้ใช้นี้และบิลทั้งหมด?')) return;
    try { await api('DELETE', '/admin/users/' + id); toast('ลบแล้ว'); await reloadAll(); }
    catch (e) { toast(e.detail || 'ลบไม่สำเร็จ', true); }
  }

  // profile / edit-user modal
  let editingUser = null;
  function openProfile() {
    editingUser = null;
    $('modalTitle').textContent = 'โปรไฟล์ของฉัน';
    $('pfName').value = S.me.display_name;
    $('pfUserRow').style.display = 'none';
    $('pfPass').value = '';
    $('modal').classList.add('show');
  }
  function editUser(id) {
    const u = S.users.find((x) => x.id === id);
    if (!u) return;
    editingUser = id;
    $('modalTitle').textContent = 'แก้ไขผู้ใช้';
    $('pfName').value = u.display_name;
    $('pfUser').value = u.username;
    $('pfUserRow').style.display = '';
    $('pfPass').value = '';
    $('modal').classList.add('show');
  }
  function closeModal() { $('modal').classList.remove('show'); }
  function modalBg(ev) { if (ev.target.id === 'modal') closeModal(); }

  async function saveProfile(ev) {
    ev.preventDefault();
    const body = { display_name: $('pfName').value.trim() };
    if ($('pfPass').value) body.password = $('pfPass').value;
    try {
      if (editingUser) await api('PUT', '/admin/users/' + editingUser, { body });
      else await api('POST', '/me/update', { body });
      toast('บันทึกแล้ว');
      closeModal();
      await reloadAll();
    } catch (e) { toast(e.detail || 'บันทึกไม่สำเร็จ', true); }
  }

  function renderAdminTeams() {
    const el = $('adminTeams');
    if (!el) return;
    el.innerHTML = S.teams.map((t) => `
      <div class="trow">
        <span class="t-prev">${flagPrevHTML(t.name, t.flag)}</span>
        <span class="t-name">${esc(t.name)}</span>
        <button class="lnk-edit" onclick="App.editTeam(${t.id})">แก้</button>
        <button class="btn btn-danger btn-sm" onclick="App.delTeam(${t.id})">ลบ</button>
      </div>`).join('');
  }
  function editTeam(id) {
    const t = S.teams.find((x) => x.id === id);
    if (!t) return;
    $('tmName').value = t.name; $('tmFlag').value = t.flag || ''; updateTeamPrev();
  }
  async function saveTeam(ev) {
    ev.preventDefault();
    try {
      await api('POST', '/teams', { body: { name: $('tmName').value.trim(), flag: $('tmFlag').value.trim() } });
      toast('บันทึกทีมแล้ว'); $('teamForm').reset(); updateTeamPrev(); await reloadAll();
    } catch (e) { toast(e.detail || 'บันทึกไม่สำเร็จ', true); }
  }
  async function delTeam(id) {
    if (!confirm('ลบทีมนี้?')) return;
    try { await api('DELETE', '/teams/' + id); await reloadAll(); }
    catch (e) { toast(e.detail || 'ลบไม่สำเร็จ', true); }
  }

  // live scores / provider mapping
  function liveMatches() { return S.matches.filter((m) => m.status !== 'finished'); }
  function renderAdminLive() {
    const el = $('liveScores');
    if (!el) return;
    const ms = liveMatches();
    el.innerHTML = ms.length ? ms.map((m) => `
      <div class="urow">
        <div class="lb-info">
          <div class="lb-nm">${esc(m.team_home)} v ${esc(m.team_away)}</div>
          <div class="lb-meta">${esc(fmtKO(m.kickoff_time))}
            ${m.apifootball_fixture_id ? ` · ผูก event #${m.apifootball_fixture_id}` : ' · ยังไม่ผูก event'}</div>
        </div>
        <div class="urow-act">${apiMapHtml(m)}</div>
      </div>`).join('') : '<div class="empty">ไม่มีนัดที่รอผล</div>';
  }
  function apiMapHtml(m) {
    if (!S.apiFixtures.length) return '';
    return `<select class="in in-mini" onchange="App.mapFixture(${m.id}, this.value)">
        <option value="">— เลือก event —</option>
        ${S.apiFixtures.map((f) => `<option value="${f.fixture_id}" ${f.fixture_id === m.apifootball_fixture_id ? 'selected' : ''}>
          ${esc(f.date)} ${esc(f.home)} v ${esc(f.away)}</option>`).join('')}
      </select>`;
  }
  async function loadApiFixtures() {
    try {
      const r = await api('GET', '/admin/apifootball/fixtures');
      S.apiFixtures = r.fixtures || [];
      toast(r.note || `พบ ${r.count} นัด`);
      renderAdminLive();
    } catch (e) { toast(e.detail || 'โหลดไม่สำเร็จ', true); }
  }
  async function mapFixture(matchId, fixtureId) {
    try {
      await api('POST', '/admin/apifootball/map', { body: { match_id: matchId, fixture_id: fixtureId ? Number(fixtureId) : null } });
      toast('ผูก event แล้ว'); await reloadAll();
    } catch (e) { toast(e.detail || 'ผูกไม่สำเร็จ', true); }
  }
  async function fetchScores() {
    try {
      const r = await api('GET', '/admin/fetch_scores');
      if (!r.matched || !r.matched.length) return toast(r.note || 'ยังไม่มีสกอร์ใหม่');
      if (!confirm(`พบสกอร์ ${r.matched.length} นัด — บันทึกและคิดเงิน?`)) return;
      const res = await api('POST', '/admin/results_batch', { body: { results: r.matched } });
      toast(`อัปเดต ${res.matches} นัด`);
      await reloadAll();
    } catch (e) { toast(e.detail || 'ดึงสกอร์ไม่สำเร็จ', true); }
  }

  // SQL console
  function sqlSample(s) { $('sqlBox').value = s; }
  async function runQuery() {
    const out = $('sqlOut');
    try {
      const r = await api('POST', '/admin/query', { body: { sql: $('sqlBox').value } });
      if (!r.rows.length) { out.innerHTML = '<div class="sql-empty">ไม่มีข้อมูล</div>'; return; }
      out.innerHTML = `<div class="sql-meta">${r.row_count} แถว</div>
        <div class="sql-scroll"><table class="sql-table">
          <thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${r.rows.map((row) => `<tr>${row.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>`;
    } catch (e) {
      out.innerHTML = `<div class="sql-err">${esc(e.detail || 'error')}</div>`;
    }
  }

  // ── nav ──────────────────────────────────────────────────────────
  function go(view) {
    S.view = view;
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $('scroll').scrollTop = 0;
  }

  async function init() {
    S.token = localStorage.getItem(LS);
    if (S.token) await boot();
    else {
      // probe the backend so demo mode is detected before the first login
      try { await api('GET', '/settings'); } catch (e) { /* 401 = real backend */ }
      $('authScreen').style.display = 'flex';
    }
  }

  window.App = {
    doLogin, logout, go, openProfile, closeModal, modalBg, saveProfile, editUser,
    setDay, pick, setStake, previewStake, placeBet, cancelBet,
    addMatch, saveOdds, setResult, toggleLock, delMatch, setDayStatus,
    createUser, delUser, giveCredits,
    saveTeam, editTeam, delTeam, updateTeamPrev, onTeamInput, onFlagInput, setHdcp,
    loadApiFixtures, mapFixture, fetchScores, sqlSample, runQuery,
    reloadAll,
  };

  document.addEventListener('DOMContentLoaded', init);
})();
