/* demo.js — in-memory mock of the FastAPI backend so the page previews
   without a server. app.js tries the network first and falls back here on a
   connection failure. State is in-memory (resets on reload). */
(function () {
  const r4 = (n) => Math.round(n * 1e4) / 1e4;
  const r2 = (n) => Math.round(n * 100) / 100;
  const MIN = 60000, HR = 60 * MIN, DAY = 24 * HR;
  const now = Date.now();

  const STAGES = ['Group Stage', 'Semi-finals', 'The Final'];
  const CUTOFF_MIN = 10;
  const BUILD = '16';

  // ── faithful port of main.py ah_outcome / payout_for ───────────────
  function ahOutcome(terms, side, sh, sa) {
    const ht = terms.hdcp_team, line = Number(terms.line);
    const raw = (ht === terms.team_home) ? (sh - sa) : (sa - sh);
    function oneLine(rawDiff, ln) {
      const d = r4(rawDiff - ln);
      if (ln % 1 === 0) return d > 0 ? 1 : (d === 0 ? 0 : -1);
      return d > 0 ? 1 : -1;
    }
    const frac = r4(((line % 1) + 1) % 1);
    const res = (frac === 0.25 || frac === 0.75)
      ? (oneLine(raw, line - 0.25) + oneLine(raw, line + 0.25)) / 2
      : oneLine(raw, line);
    return side === ht ? res : -res;
  }

  function payoutFor(stake, odds, outcome) {
    const profit = stake * (odds - 1);
    if (outcome === 1) return stake + profit;
    if (outcome === 0.5) return stake + profit / 2;
    if (outcome === 0) return stake;
    if (outcome === -0.5) return stake / 2;
    return 0;
  }

  // ── team registry (ASEAN Championship) ─────────────────────────────
  const TEAM_SEED = [
    ['Thailand', 'th'], ['Vietnam', 'vn'], ['Indonesia', 'id'], ['Malaysia', 'my'],
    ['Singapore', 'sg'], ['Philippines', 'ph'], ['Myanmar', 'mm'], ['Cambodia', 'kh'],
    ['Laos', 'la'], ['Timor-Leste', 'tl'], ['Brunei', 'bn'],
  ];
  const flagUrl = (iso) => (window.__resources && window.__resources['flag_' + iso]) || `https://flagcdn.com/w80/${iso}.png`;
  let tid = 1;
  const teams = TEAM_SEED.map(([name, iso]) => ({ id: tid++, name, flag: flagUrl(iso) }));
  const regFlag = (name) => { const t = teams.find((x) => x.name === name); return t ? t.flag : ''; };

  // ── state ──────────────────────────────────────────────────────────
  let uid = 1, mid = 1, bid = 1, lid = 1;
  const users = [], matches = [], bets = [], ledger = [], betDays = {};

  const pad = (n) => String(n).padStart(2, '0');
  // store kickoffs the way the backend does: naive Bangkok 'YYYY-MM-DDTHH:MM'
  function isoLocal(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const playDateOf = (kick) => (kick || '').slice(0, 10);

  function addUser(username, display_name, password, is_admin, credits) {
    const u = { id: uid++, username, display_name, password, is_admin: is_admin ? 1 : 0, credits: 0 };
    users.push(u);
    if (credits) move(u, credits, 'topup', 'เครดิตเริ่มต้น');
    return u;
  }

  function move(user, delta, reason, note, bet_id) {
    user.credits = r2(user.credits + delta);
    ledger.unshift({
      id: lid++, user_id: user.id, delta: r2(delta), balance_after: user.credits,
      reason, note: note || '', bet_id: bet_id || null,
      display_name: user.display_name, username: user.username,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    return user.credits;
  }

  function addMatch(home, away, ht, line, oh, oa, kickTs, stage) {
    const kickoff_time = isoLocal(kickTs);
    const m = {
      id: mid++, team_home: home, team_away: away,
      team_home_flag: regFlag(home), team_away_flag: regFlag(away),
      stage: stage || 'Group Stage', handicap_team: ht, handicap_value: line,
      odds_home: oh, odds_away: oa, kickoff_time, play_date: playDateOf(kickoff_time),
      score_home: null, score_away: null, status: 'upcoming',
      locked: 0, force_open: 0, apifootball_fixture_id: null,
    };
    matches.push(m);
    return m;
  }

  const admin = addUser('admin', 'น้องปอนด์ (Admin)', 'admin1234', 1, 0);
  const guest = addUser('guest', 'ผู้เยี่ยมชม', '1234', 0, 1000);
  const rivals = [
    addUser('ake', 'เอก', 'x', 0, 1000), addUser('bee', 'บี', 'x', 0, 1000),
    addUser('cha', 'ช้าง', 'x', 0, 1000), addUser('dao', 'ดาว', 'x', 0, 1000),
  ];

  // yesterday (settled), today (open), tomorrow (not yet opened)
  const mYest1 = addMatch('Thailand', 'Cambodia', 'Thailand', 1.5, 1.90, 1.90, now - DAY, 'Group Stage');
  const mYest2 = addMatch('Vietnam', 'Laos', 'Vietnam', 1.25, 1.85, 1.95, now - DAY + HR, 'Group Stage');
  const mToday1 = addMatch('Malaysia', 'Singapore', 'Malaysia', 0.25, 1.88, 1.92, now + 3 * HR, 'Group Stage');
  const mToday2 = addMatch('Indonesia', 'Philippines', 'Indonesia', 0.75, 1.95, 1.85, now + 5 * HR, 'Group Stage');
  const mTomo = addMatch('Thailand', 'Vietnam', 'Thailand', 0.5, 1.90, 1.90, now + DAY, 'Group Stage');

  betDays[mYest1.play_date] = 'closed';
  betDays[mToday1.play_date] = 'open';
  betDays[mTomo.play_date] = 'draft';

  function placeDemoBet(user, m, side, stake) {
    const odds = side === m.team_home ? m.odds_home : m.odds_away;
    const b = {
      id: bid++, user_id: user.id, match_id: m.id, side, stake,
      hdcp_team_taken: m.handicap_team, line_taken: m.handicap_value, odds_taken: odds,
      status: 'open', outcome: null, payout: null,
      placed_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    };
    bets.push(b);
    move(user, -stake, 'bet', `${m.team_home} v ${m.team_away} · ${side}`, b.id);
    return b;
  }

  // seed some history so the demo boards aren't empty
  [guest, ...rivals].forEach((u, i) => {
    placeDemoBet(u, mYest1, i % 2 ? mYest1.team_away : mYest1.team_home, 100 + i * 20);
    placeDemoBet(u, mYest2, i % 3 ? mYest2.team_home : mYest2.team_away, 80 + i * 15);
  });
  placeDemoBet(guest, mToday1, mToday1.team_home, 150);

  function settle(m, sh, sa, final) {
    m.score_home = sh; m.score_away = sa;
    m.status = final ? 'finished' : 'live';
    m.locked = 1;
    if (!final) return 0;
    let n = 0;
    bets.filter((b) => b.match_id === m.id && b.status !== 'void').forEach((b) => {
      const u = users.find((x) => x.id === b.user_id);
      if (b.status === 'settled' && b.payout != null) move(u, -b.payout, 'refund', 'แก้ผล', b.id);
      const terms = { team_home: m.team_home, team_away: m.team_away, hdcp_team: b.hdcp_team_taken, line: b.line_taken };
      b.outcome = ahOutcome(terms, b.side, sh, sa);
      b.payout = r2(payoutFor(b.stake, b.odds_taken, b.outcome));
      b.status = 'settled';
      if (b.payout) move(u, b.payout, 'payout', `ผลนัด #${m.id}`, b.id);
      n++;
    });
    return n;
  }
  settle(mYest1, 2, 0, true);
  settle(mYest2, 1, 1, true);

  // ── betting gate (mirrors main.py bet_gate) ────────────────────────
  const dayStatus = (d) => betDays[d] || 'draft';
  function betGate(m) {
    if (m.status === 'finished') return 'นัดนี้จบไปแล้ว';
    if (m.force_open) return null;
    if (m.locked) return 'แอดมินปิดรับพนันนัดนี้แล้ว';
    if (m.status !== 'upcoming') return 'นัดนี้เริ่มไปแล้ว';
    if (dayStatus(m.play_date) !== 'open') return 'ยังไม่เปิดรับพนันของวันนี้';
    const ko = new Date(m.kickoff_time).getTime();
    if (Date.now() >= ko - CUTOFF_MIN * MIN) return `ปิดรับแล้ว (ต้องแทงก่อนเตะ ${CUTOFF_MIN} นาที)`;
    return null;
  }

  function decorate(m) {
    const pool = bets.filter((b) => b.match_id === m.id && b.status !== 'void');
    const reason = betGate(m);
    return {
      ...m, can_bet: reason === null, closed_reason: reason,
      day_status: dayStatus(m.play_date),
      pool_bets: pool.length, pool_total: r2(pool.reduce((s, b) => s + b.stake, 0)),
    };
  }

  // ── router ─────────────────────────────────────────────────────────
  const ok = (data) => ({ status: 200, data });
  const err = (status, detail) => ({ status, data: { detail } });
  const tokenOf = (u) => 'demo.' + u.username;
  const userFromToken = (t) => users.find((u) => tokenOf(u) === t) || null;

  function handle(method, path, { body, form, token } = {}) {
    const me = userFromToken(token);
    const needAuth = () => (me ? null : err(401, 'Invalid token'));
    const needAdmin = () => (me && me.is_admin ? null : err(403, 'Admin only'));

    if (method === 'POST' && path === '/token') {
      const u = users.find((x) => x.username === (form.username || '').trim());
      if (!u || u.password !== form.password) return err(400, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      return ok({ access_token: tokenOf(u), token_type: 'bearer', display_name: u.display_name, is_admin: u.is_admin });
    }

    if (path === '/settings') return ok({ build: BUILD, cutoff_min: CUTOFF_MIN });

    let g = needAuth(); if (g) return g;

    if (method === 'GET' && path === '/me') {
      const mine = bets.filter((b) => b.user_id === me.id && b.status !== 'void');
      const settled = mine.filter((b) => b.status === 'settled');
      return ok({
        id: me.id, username: me.username, display_name: me.display_name, is_admin: me.is_admin,
        credits: r2(me.credits), staked: r2(mine.reduce((s, b) => s + b.stake, 0)),
        bets: mine.length, open_bets: mine.filter((b) => b.status === 'open').length,
        net: r2(settled.reduce((s, b) => s + (b.payout - b.stake), 0)),
      });
    }
    if (method === 'POST' && path === '/me/update') {
      if (body.display_name) me.display_name = body.display_name;
      if (body.password) me.password = body.password;
      return ok({ ok: true });
    }
    if (path === '/stages') return ok(STAGES);
    if (path === '/teams' && method === 'GET') return ok(teams.slice().sort((a, b) => a.name.localeCompare(b.name)));
    if (path === '/matches' && method === 'GET') {
      return ok(matches.slice().sort((a, b) => a.kickoff_time.localeCompare(b.kickoff_time)).map(decorate));
    }
    if (path === '/bet_days' && method === 'GET') {
      const days = {};
      matches.forEach((m) => {
        const d = (days[m.play_date] = days[m.play_date] || { play_date: m.play_date, matches: 0, finished: 0, first_kickoff: m.kickoff_time });
        d.matches++;
        if (m.status === 'finished') d.finished++;
        if (m.kickoff_time < d.first_kickoff) d.first_kickoff = m.kickoff_time;
      });
      return ok(Object.values(days).sort((a, b) => a.play_date.localeCompare(b.play_date))
        .map((d) => ({ ...d, status: dayStatus(d.play_date) })));
    }
    if (path === '/bets/mine' && method === 'GET') {
      return ok(bets.filter((b) => b.user_id === me.id).map((b) => {
        const m = matches.find((x) => x.id === b.match_id) || {};
        return { ...b, team_home: m.team_home, team_away: m.team_away,
          team_home_flag: m.team_home_flag, team_away_flag: m.team_away_flag,
          stage: m.stage, kickoff_time: m.kickoff_time, play_date: m.play_date,
          score_home: m.score_home, score_away: m.score_away, match_status: m.status };
      }).sort((a, b) => (b.kickoff_time || '').localeCompare(a.kickoff_time || '') || b.id - a.id));
    }
    if (path === '/ledger/mine' && method === 'GET') {
      return ok(ledger.filter((l) => l.user_id === me.id).slice(0, 100));
    }
    if (path === '/leaderboard' && method === 'GET') {
      return ok(users.filter((u) => !u.is_admin).map((u) => {
        const mine = bets.filter((b) => b.user_id === u.id && b.status !== 'void');
        const settled = mine.filter((b) => b.status === 'settled');
        const open = mine.filter((b) => b.status === 'open');
        return {
          display_name: u.display_name, username: u.username, credits: r2(u.credits),
          staked: r2(mine.reduce((s, b) => s + b.stake, 0)),
          at_risk: r2(open.reduce((s, b) => s + b.stake, 0)),
          net: r2(settled.reduce((s, b) => s + (b.payout - b.stake), 0)),
          bets: mine.length,
          wins: settled.filter((b) => b.outcome > 0).length,
          losses: settled.filter((b) => b.outcome < 0).length,
        };
      }).sort((a, b) => (b.credits + b.at_risk) - (a.credits + a.at_risk) || b.net - a.net));
    }

    if (method === 'POST' && path === '/bets') {
      const m = matches.find((x) => x.id === body.match_id);
      if (!m) return err(404, 'ไม่พบนัดนี้');
      if (![m.team_home, m.team_away].includes(body.side)) return err(400, 'เลือกได้เฉพาะทีมในนัดนี้');
      const stake = r2(Number(body.stake));
      if (!(stake > 0)) return err(400, 'จำนวนเงินต้องมากกว่า 0');
      const reason = betGate(m);
      if (reason) return err(400, reason);
      if (me.credits < stake) return err(400, `เครดิตไม่พอ (คงเหลือ ${r2(me.credits)})`);
      const b = placeDemoBet(me, m, body.side, stake);
      return ok({ ok: true, bet_id: b.id, credits: me.credits, line_taken: b.line_taken, odds_taken: b.odds_taken });
    }
    if (method === 'DELETE' && path.startsWith('/bets/')) {
      const b = bets.find((x) => x.id === +path.split('/')[2]);
      if (!b || (b.user_id !== me.id && !me.is_admin)) return err(404, 'ไม่พบบิลนี้');
      if (b.status !== 'open') return err(400, 'บิลนี้ปิดไปแล้ว');
      const m = matches.find((x) => x.id === b.match_id);
      if (m && betGate(m)) return err(400, 'ปิดรับพนันแล้ว — ยกเลิกไม่ได้');
      b.status = 'void';
      const u = users.find((x) => x.id === b.user_id);
      return ok({ ok: true, credits: move(u, b.stake, 'refund', 'ยกเลิกบิล', b.id) });
    }
    if (method === 'GET' && /^\/matches\/\d+\/odds_history$/.test(path)) return ok([]);
    if (method === 'GET' && /^\/matches\/\d+\/bets$/.test(path)) {
      const m = matches.find((x) => x.id === +path.split('/')[2]);
      if (!m) return err(404, 'ไม่พบนัด');
      if (betGate(m) === null && !me.is_admin) return ok({ revealed: false, bets: [] });
      return ok({ revealed: true, bets: bets.filter((b) => b.match_id === m.id && b.status !== 'void').map((b) => ({
        display_name: (users.find((u) => u.id === b.user_id) || {}).display_name,
        side: b.side, stake: b.stake, line_taken: b.line_taken, odds_taken: b.odds_taken,
        status: b.status, outcome: b.outcome, payout: b.payout })) });
    }

    // ── admin ────────────────────────────────────────────────────────
    g = needAdmin(); if (g) return g;

    if (path === '/admin/users' && method === 'GET') {
      return ok(users.map((u) => ({
        id: u.id, username: u.username, display_name: u.display_name, is_admin: u.is_admin,
        credits: r2(u.credits),
        staked: r2(bets.filter((b) => b.user_id === u.id && b.status !== 'void').reduce((s, b) => s + b.stake, 0)),
        open_bets: bets.filter((b) => b.user_id === u.id && b.status === 'open').length,
      })));
    }
    if (path === '/admin/users' && method === 'POST') {
      if (users.some((u) => u.username === body.username.trim())) return err(400, 'ชื่อผู้ใช้นี้มีอยู่แล้ว');
      addUser(body.username.trim(), body.display_name.trim(), body.password, 0, Number(body.credits) || 0);
      return ok({ ok: true });
    }
    if (path.startsWith('/admin/users/') && method === 'DELETE') {
      const id = +path.split('/')[3];
      const t = users.find((u) => u.id === id);
      if (t && t.is_admin) return err(400, 'ลบผู้ดูแลระบบไม่ได้');
      const i = users.findIndex((u) => u.id === id);
      if (i >= 0) users.splice(i, 1);
      return ok({ ok: true });
    }
    if (path.startsWith('/admin/users/') && method === 'PUT') {
      const t = users.find((u) => u.id === +path.split('/')[3]);
      if (!t) return err(404, 'ไม่พบผู้ใช้');
      if (body.display_name) t.display_name = body.display_name;
      if (body.password) t.password = body.password;
      return ok({ ok: true });
    }
    if (path === '/admin/credits' && method === 'POST') {
      const t = users.find((u) => u.id === body.user_id);
      if (!t) return err(404, 'ไม่พบผู้ใช้');
      const amt = Number(body.amount);
      if (!amt) return err(400, 'จำนวนเครดิตต้องไม่เป็นศูนย์');
      if (amt < 0 && t.credits + amt < 0) return err(400, 'ดึงเครดิตคืนเกินยอดคงเหลือไม่ได้');
      return ok({ ok: true, credits: move(t, amt, amt > 0 ? 'topup' : 'adjust', body.note || '') });
    }
    if (path === '/admin/ledger' && method === 'GET') return ok(ledger.slice(0, 200));

    if (path === '/admin/bet_days' && method === 'PUT') {
      if (!matches.some((m) => m.play_date === body.play_date)) return err(404, 'ไม่มีนัดในวันนี้');
      betDays[body.play_date] = body.status;
      return ok({ ok: true, play_date: body.play_date, status: body.status });
    }

    if (path === '/matches' && method === 'POST') {
      const m = addMatch(body.team_home, body.team_away, body.handicap_team, body.handicap_value,
        Number(body.odds_home) || 1.9, Number(body.odds_away) || 1.9,
        new Date(body.kickoff_time).getTime(), body.stage);
      return ok({ ok: true, id: m.id });
    }
    if (path.startsWith('/matches/') && path.endsWith('/odds') && method === 'PUT') {
      const m = matches.find((x) => x.id === +path.split('/')[2]);
      if (!m) return err(404, 'ไม่พบนัด');
      if (betGate(m)) return err(400, 'ปิดรับพนันแล้ว — แก้ราคาไม่ได้');
      if (body.handicap_team) m.handicap_team = body.handicap_team;
      if (body.handicap_value != null) m.handicap_value = Number(body.handicap_value);
      if (body.odds_home != null) m.odds_home = Number(body.odds_home);
      if (body.odds_away != null) m.odds_away = Number(body.odds_away);
      return ok({ ok: true, ...m });
    }
    if (path.startsWith('/matches/') && method === 'DELETE') {
      const id = +path.split('/')[2];
      let refunded = 0;
      bets.filter((b) => b.match_id === id && b.status === 'open').forEach((b) => {
        move(users.find((u) => u.id === b.user_id), b.stake, 'refund', `ยกเลิกนัด #${id}`, b.id);
        b.status = 'void'; refunded++;
      });
      const i = matches.findIndex((m) => m.id === id);
      if (i >= 0) matches.splice(i, 1);
      return ok({ ok: true, refunded });
    }
    if (path.startsWith('/matches/') && method === 'PUT') {
      const m = matches.find((x) => x.id === +path.split('/')[2]);
      if (!m) return err(404, 'ไม่พบนัด');
      ['handicap_team', 'handicap_value', 'stage'].forEach((k) => { if (body[k] != null) m[k] = body[k]; });
      if (body.kickoff_time) { m.kickoff_time = body.kickoff_time; m.play_date = playDateOf(body.kickoff_time); }
      return ok({ ok: true });
    }
    if (path === '/admin/result' && method === 'POST') {
      const m = matches.find((x) => x.id === body.match_id);
      if (!m) return err(404, 'ไม่พบนัด');
      return ok({ ok: true, settled: settle(m, body.score_home, body.score_away, true) });
    }
    if (path === '/admin/results_batch' && method === 'POST') {
      let n = 0;
      (body.results || []).forEach((it) => {
        const m = matches.find((x) => x.id === it.match_id);
        if (m) { settle(m, it.score_home, it.score_away, it.final); n++; }
      });
      return ok({ ok: true, matches: n, detail: [] });
    }
    if (path === '/admin/lock' && method === 'POST') {
      const m = matches.find((x) => x.id === body.match_id);
      if (m) { m.locked = body.locked ? 1 : 0; m.force_open = body.locked ? 0 : 1; }
      return ok({ ok: true });
    }
    if (path === '/teams' && method === 'POST') {
      const t = teams.find((x) => x.name === body.name.trim());
      if (t) t.flag = body.flag.trim();
      else teams.push({ id: tid++, name: body.name.trim(), flag: body.flag.trim() });
      return ok({ ok: true });
    }
    if (path.startsWith('/teams/') && method === 'DELETE') {
      const i = teams.findIndex((x) => x.id === +path.split('/')[2]);
      if (i >= 0) teams.splice(i, 1);
      return ok({ ok: true });
    }
    if (path === '/admin/apifootball/fixtures') {
      return ok({ ok: true, provider: 'demo', count: 0, dates: [], fixtures: [], note: 'โหมดเดโม — ไม่มีข้อมูลจริง' });
    }
    if (path === '/admin/apifootball/map') return ok({ ok: true });
    if (path === '/admin/fetch_scores') return ok({ ok: true, fetched: 0, matched: [], note: 'โหมดเดโม' });
    if (path === '/admin/query' && method === 'POST') {
      const sql = (body.sql || '').trim().toLowerCase();
      if (!sql.startsWith('select') && !sql.startsWith('with')) return err(400, 'อนุญาตเฉพาะคำสั่ง SELECT เท่านั้น');
      if (sql.includes('users')) {
        return ok({ columns: ['display_name', 'credits'],
          rows: users.map((u) => [u.display_name, u.credits]), row_count: users.length });
      }
      if (sql.includes('bets')) {
        return ok({ columns: ['id', 'side', 'stake', 'odds_taken', 'status'],
          rows: bets.map((b) => [b.id, b.side, b.stake, b.odds_taken, b.status]), row_count: bets.length });
      }
      return ok({ columns: ['note'], rows: [['โหมดเดโม — คิวรีจำลอง']], row_count: 1 });
    }

    return err(404, 'ไม่พบ endpoint นี้ (โหมดเดโม)');
  }

  window.DemoServer = { handle };
})();
