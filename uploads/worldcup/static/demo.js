/* demo.js — in-memory mock of the FastAPI backend so the page previews
   without a server. app.js tries the network first and falls back here on a
   connection failure. State is in-memory (resets on reload). */
(function () {
  const r4 = (n) => Math.round(n * 1e4) / 1e4;
  const MIN = 60000, HR = 60 * MIN, DAY = 24 * HR;
  const now = Date.now();

  const STAGES = ['Group Stage', 'Round of 32', 'Round of 16', 'Quarter-finals',
    'Semi-finals', 'Third-Place Play-off', 'The Final'];

  // ── faithful port of main.py calc_points (Asian handicap) ──────────
  function calcPoints(m, predictedWinner) {
    const h = m.score_home, a = m.score_away, hv = m.handicap_value, ht = m.handicap_team;
    const rawDiff = (ht === m.team_home) ? (h - a) : (a - h);
    function scoreLine(raw, line) {
      const d = r4(raw - line);
      if (line % 1 === 0) { if (d > 0) return 2; if (d === 0) return 1; return 0; }
      return d > 0 ? 2 : 0;
    }
    const frac = r4(((hv % 1) + 1) % 1);
    let s;
    if (frac === 0.25 || frac === 0.75) s = (scoreLine(rawDiff, hv - 0.25) + scoreLine(rawDiff, hv + 0.25)) / 2;
    else s = scoreLine(rawDiff, hv);
    return predictedWinner === ht ? s : 2 - s;
  }

  // ── team registry (pre-defined flags) ──────────────────────────────
  const TEAM_SEED = [
    ['Argentina','ar'],['Brazil','br'],['France','fr'],['England','gb-eng'],['Spain','es'],
    ['Germany','de'],['Portugal','pt'],['Netherlands','nl'],['Italy','it'],['Belgium','be'],
    ['Croatia','hr'],['Uruguay','uy'],['Mexico','mx'],['USA','us'],['Canada','ca'],
    ['Japan','jp'],['South Korea','kr'],['Australia','au'],['Morocco','ma'],['Senegal','sn'],
    ['Ghana','gh'],['Nigeria','ng'],['Cameroon','cm'],['Ivory Coast','ci'],['Saudi Arabia','sa'],
    ['Iran','ir'],['Qatar','qa'],['Switzerland','ch'],['Denmark','dk'],['Poland','pl'],
    ['Serbia','rs'],['Wales','gb-wls'],['Scotland','gb-sct'],['Ecuador','ec'],['Colombia','co'],
    ['Peru','pe'],['Chile','cl'],['Paraguay','py'],['Venezuela','ve'],['Costa Rica','cr'],
    ['Panama','pa'],['Jamaica','jm'],['Honduras','hn'],['Austria','at'],['Sweden','se'],
    ['Norway','no'],['Turkey','tr'],['Ukraine','ua'],['Czech Republic','cz'],['Hungary','hu'],
    ['Greece','gr'],['Egypt','eg'],['Algeria','dz'],['Tunisia','tn'],['South Africa','za'],
    ['Mali','ml'],['New Zealand','nz'],['Uzbekistan','uz'],['Iraq','iq'],['UAE','ae'],
    ['Jordan','jo'],['Thailand','th'],['Vietnam','vn'],
  ];
  const flagUrl = (iso) => (window.__resources && window.__resources['flag_' + iso]) || `https://flagcdn.com/w80/${iso}.png`;
  let tid = 1;
  const teams = TEAM_SEED.map(([name, iso]) => ({ id: tid++, name, flag: flagUrl(iso) }));
  const regFlag = (name) => { const t = teams.find((x) => x.name === name); return t ? t.flag : ''; };

  // ── seed users / matches / predictions ─────────────────────────────
  let uid = 1, mid = 1, pid = 1;
  const users = [], matches = [], predictions = [];
  let displaySettings = { home_stats: ['knockout', 'overall', 'wins'], lb_tabs: ['overall', 'group', 'knockout'] };

  function addUser(username, display, isAdmin) {
    users.push({ id: uid++, username, display_name: display, password: username === 'admin' ? 'admin1234' : '1234', is_admin: isAdmin ? 1 : 0, knockout_eligible: 1 });
  }
  addUser('admin', 'น้องปอนด์ (Admin)', true);
  addUser('guest', 'คุณเอ๋ (You)', false);
  ['เจมส์', 'บีม', 'ป๊อก', 'หนิง', 'ตูน', 'มาร์ค', 'ฟ้า'].forEach((n, i) => addUser('p' + i, n, false));

  function at(off) {
    const d = new Date(now + off), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
  }
  function addMatch(o) {
    const m = { id: mid++, status: 'upcoming', locked: 0, score_home: null, score_away: null,
      team_home_flag: '', team_away_flag: '', stage: 'Group Stage', ...o };
    if (!m.team_home_flag) m.team_home_flag = regFlag(m.team_home);
    if (!m.team_away_flag) m.team_away_flag = regFlag(m.team_away);
    matches.push(m);
    return m;
  }

  // finished (history + leaderboard) — generate a realistic Group Stage backlog
  const finishedSeed = [
    ['Brazil','Serbia','Brazil',1.0,2,0],['France','Denmark','France',0.5,1,1],
    ['Argentina','Mexico','Argentina',0.25,2,0],['Spain','Costa Rica','Spain',2.0,3,0],
    ['Portugal','Ghana','Portugal',1.0,3,2],['Netherlands','Ecuador','Netherlands',0.75,1,1],
    ['England','Wales','England',1.25,3,0],['Belgium','Canada','Belgium',0.75,1,0],
    ['Croatia','Morocco','Croatia',0.25,0,0],['Uruguay','South Korea','Uruguay',0.5,0,0],
  ];
  let dayBack = finishedSeed.length;
  const fmatches = finishedSeed.map((s) => {
    const m = addMatch({ team_home: s[0], team_away: s[1], handicap_team: s[2], handicap_value: s[3],
      kickoff_time: at(-(dayBack--) * (DAY / 2)), score_home: s[4], score_away: s[5], status: 'finished', locked: 1, stage: 'Group Stage' });
    return m;
  });

  // upcoming
  const u1 = addMatch({ team_home: 'Spain', team_away: 'Germany', handicap_team: 'Spain', handicap_value: 0.25, kickoff_time: at(2 * HR + 40 * MIN), stage: 'Round of 16' });
  const u2 = addMatch({ team_home: 'England', team_away: 'Netherlands', handicap_team: 'England', handicap_value: 0.5, kickoff_time: at(1 * DAY + 2 * HR), stage: 'Round of 16' });
  const u3 = addMatch({ team_home: 'Portugal', team_away: 'Morocco', handicap_team: 'Portugal', handicap_value: 0.75, kickoff_time: at(2 * DAY + 3 * HR), stage: 'Quarter-finals' });
  const lk = addMatch({ team_home: 'Japan', team_away: 'Croatia', handicap_team: 'Croatia', handicap_value: 0.25, kickoff_time: at(18 * MIN), stage: 'Round of 16' }); // cutoff passed

  function pred(userId, m, winner) {
    const p = { id: pid++, user_id: userId, match_id: m.id, predicted_winner: winner, points: null };
    if (m.status === 'finished') p.points = calcPoints(m, winner);
    predictions.push(p);
  }
  const U = (uname) => users.find((u) => u.username === uname).id;
  // spread predictions across finished matches to build standings
  const picks = {
    guest: ['Brazil','France','Argentina','Spain','Portugal','Ecuador','England','Belgium','Croatia','Uruguay'],
    p0: ['Brazil','France','Argentina','Spain','Ghana','Netherlands','England','Canada','Croatia','South Korea'],
    p1: ['Brazil','Denmark','Argentina','Spain','Portugal','Netherlands','Wales','Belgium','Morocco','Uruguay'],
    p2: ['Serbia','France','Mexico','Spain','Portugal','Ecuador','England','Belgium','Croatia','Uruguay'],
    p3: ['Brazil','France','Argentina','Costa Rica','Portugal','Netherlands','England','Canada','Croatia'],
    p4: ['Serbia','Denmark','Mexico','Spain','Ghana','Netherlands','Wales','Belgium','Morocco','South Korea'],
    p5: ['Brazil','France','Argentina','Spain','Portugal','Netherlands','England'],
    p6: ['France','Argentina','Spain','Portugal','Netherlands','England','Belgium','Croatia','Uruguay'],
  };
  Object.entries(picks).forEach(([uname, arr]) => arr.forEach((w, i) => { if (fmatches[i]) pred(U(uname), fmatches[i], w); }));
  // some upcoming picks already in
  pred(U('guest'), u1, 'Spain'); pred(U('guest'), u2, 'England');

  // ── token helpers ──────────────────────────────────────────────────
  const tokenFor = (u) => 'demo.' + u.username;
  const userFromToken = (t) => users.find((u) => tokenFor(u) === t);
  const ok = (data) => ({ status: 200, data });
  const err = (status, detail) => ({ status, data: { detail } });

  function publicMatch(m) { return { ...m }; }
  function joinMine(me) {
    return predictions.filter((p) => p.user_id === me.id).map((p) => {
      const m = matches.find((x) => x.id === p.match_id) || {};
      return { ...p, team_home: m.team_home, team_away: m.team_away, team_home_flag: m.team_home_flag,
        team_away_flag: m.team_away_flag, stage: m.stage, handicap_team: m.handicap_team,
        handicap_value: m.handicap_value, kickoff_time: m.kickoff_time, score_home: m.score_home,
        score_away: m.score_away, status: m.status, locked: m.locked };
    }).sort((a, b) => (a.kickoff_time || '').localeCompare(b.kickoff_time || ''));
  }

  function leaderboardRows(phase) {
    const inPhase = (m) => {
      if (!m) return false;
      if (phase === 'group') return m.stage === 'Group Stage';
      if (phase === 'knockout') return m.stage !== 'Group Stage';
      return true; // overall
    };
    return users.filter((u) => !u.is_admin && (phase !== 'knockout' || u.knockout_eligible)).map((u) => {
      const mine = predictions.filter((p) => p.user_id === u.id && inPhase(matches.find((x) => x.id === p.match_id)));
      let total = 0, wins = 0, finished = 0;
      mine.forEach((p) => {
        const m = matches.find((x) => x.id === p.match_id);
        if (p.points != null) total += p.points;
        if (p.points === 2) wins++;
        if (m && m.status === 'finished') finished++;
      });
      return { display_name: u.display_name, username: u.username, total_points: r4(total), total_predictions: mine.length, wins, finished };
    }).sort((a, b) => (b.total_points - a.total_points) || (b.wins - a.wins));
  }

  // ── tiny read-only SQL for the admin console (demo only) ────────────
  function runQuery(sql) {
    const raw = (sql || '').trim().replace(/;+\s*$/, '');
    const low = raw.toLowerCase();
    if (!low.startsWith('select') && !low.startsWith('with')) return err(400, 'อนุญาตเฉพาะคำสั่ง SELECT เท่านั้น');
    if (/\b(insert|update|delete|drop|alter|create|replace|pragma)\b/.test(low)) return err(400, 'พบคำสั่งที่ไม่อนุญาต (read-only)');
    const tables = {
      users: () => users.map((u) => ({ id: u.id, username: u.username, display_name: u.display_name, is_admin: u.is_admin, knockout_eligible: u.knockout_eligible })),
      teams: () => teams.map((t) => ({ id: t.id, name: t.name, flag: t.flag })),
      matches: () => matches.map((m) => ({ id: m.id, team_home: m.team_home, team_away: m.team_away, stage: m.stage, handicap_team: m.handicap_team, handicap_value: m.handicap_value, kickoff_time: m.kickoff_time, score_home: m.score_home, score_away: m.score_away, status: m.status, locked: m.locked })),
      predictions: () => predictions.map((p) => ({ id: p.id, user_id: p.user_id, match_id: p.match_id, predicted_winner: p.predicted_winner, points: p.points })),
      leaderboard: () => leaderboardRows(),
    };
    const fm = low.match(/from\s+([a-z_]+)/);
    if (!fm || !tables[fm[1]]) return err(400, 'เดโมรองรับ FROM: users, teams, matches, predictions, leaderboard');
    let data = tables[fm[1]]();
    const countMatch = low.match(/select\s+count\(/);
    if (countMatch) {
      return ok({ columns: ['count'], rows: [[data.length]], row_count: 1 });
    }
    const lim = low.match(/limit\s+(\d+)/);
    if (lim) data = data.slice(0, parseInt(lim[1], 10));
    const cols = data.length ? Object.keys(data[0]) : [];
    return ok({ columns: cols, rows: data.map((r) => cols.map((c) => r[c])), row_count: data.length });
  }

  // ── router ──────────────────────────────────────────────────────────
  function handle(method, path, opts) {
    opts = opts || {};
    const body = opts.body || {};
    const me = opts.token ? userFromToken(opts.token) : null;
    const [routePath, qs] = path.split('?');
    const query = new URLSearchParams(qs || '');
    path = routePath;

    if (method === 'POST' && path === '/token') {
      const u = users.find((x) => x.username === (opts.form && opts.form.username));
      if (!u || opts.form.password !== u.password) return err(400, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      return ok({ access_token: tokenFor(u), token_type: 'bearer', display_name: u.display_name, is_admin: u.is_admin });
    }
    if (!me) return err(401, 'Invalid token');

    if (method === 'GET' && path === '/me')
      return ok({ id: me.id, username: me.username, display_name: me.display_name, is_admin: me.is_admin, knockout_eligible: !!me.knockout_eligible });
    if (method === 'POST' && path === '/me/update') {
      if (body.display_name != null && body.display_name.trim()) me.display_name = body.display_name.trim();
      if (body.password) me.password = body.password;
      return ok({ ok: true });
    }
    if (method === 'GET' && path === '/stages') return ok(STAGES);
    if (method === 'GET' && path === '/settings') return ok(displaySettings);
    if (method === 'GET' && path === '/teams') return ok([...teams].sort((a, b) => a.name.localeCompare(b.name)));
    if (method === 'GET' && path === '/matches') return ok([...matches].sort((a, b) => a.kickoff_time.localeCompare(b.kickoff_time)).map(publicMatch));
    if (method === 'GET' && path === '/predictions/mine') return ok(joinMine(me));
    if (method === 'GET' && path === '/leaderboard') return ok(leaderboardRows(query.get('phase') || 'overall'));

    if (method === 'POST' && path === '/predictions') {
      const m = matches.find((x) => x.id === body.match_id);
      if (!m) return err(404, 'ไม่พบนัดนี้');
      if (m.stage !== 'Group Stage' && !me.knockout_eligible) return err(403, 'คุณไม่ได้รับสิทธิ์ทายผลรอบน็อคเอาท์นี้');
      if (m.locked) return err(400, 'แอดมินปิดรับการทายนัดนี้แล้ว');
      if (m.status !== 'upcoming') return err(400, 'นัดนี้เริ่มไปแล้ว');
      if (Date.now() >= new Date(m.kickoff_time).getTime() - 30 * MIN) return err(400, 'หมดเวลาทาย (ต้องส่งก่อน Kickoff 30 นาที)');
      const ex = predictions.find((p) => p.user_id === me.id && p.match_id === body.match_id);
      if (ex) ex.predicted_winner = body.predicted_winner;
      else predictions.push({ id: pid++, user_id: me.id, match_id: body.match_id, predicted_winner: body.predicted_winner, points: null });
      return ok({ ok: true });
    }

    // ── admin only below ──
    if (!me.is_admin) return err(403, 'Admin only');

    if (method === 'PUT' && path === '/admin/settings') {
      const HOME_KEYS = ['knockout', 'overall', 'wins'], LB_KEYS = ['overall', 'group', 'knockout'];
      const home_stats = (body.home_stats || []).filter((k) => HOME_KEYS.includes(k));
      const lb_tabs = (body.lb_tabs || []).filter((k) => LB_KEYS.includes(k));
      if (!lb_tabs.length) return err(400, 'ต้องเปิดอย่างน้อย 1 แท็บตารางคะแนน');
      displaySettings = { home_stats, lb_tabs };
      return ok({ ok: true, ...displaySettings });
    }

    if (method === 'GET' && path === '/admin/users')
      return ok(users.map((u) => ({ id: u.id, username: u.username, display_name: u.display_name, is_admin: u.is_admin, knockout_eligible: !!u.knockout_eligible })).sort((a, b) => b.is_admin - a.is_admin || a.id - b.id));
    if (method === 'POST' && path === '/admin/users') {
      if (users.some((x) => x.username === (body.username || '').trim())) return err(400, 'ชื่อผู้ใช้นี้มีอยู่แล้ว');
      users.push({ id: uid++, username: (body.username || '').trim(), display_name: (body.display_name || '').trim(), password: body.password, is_admin: 0, knockout_eligible: body.knockout_eligible === false ? 0 : 1 });
      return ok({ ok: true });
    }
    if (method === 'DELETE' && path.startsWith('/admin/users/')) {
      const id = parseInt(path.split('/')[3], 10);
      const u = users.find((x) => x.id === id);
      if (u && u.is_admin) return err(400, 'ลบผู้ดูแลระบบไม่ได้');
      const i = users.findIndex((x) => x.id === id);
      if (i >= 0) users.splice(i, 1);
      for (let k = predictions.length - 1; k >= 0; k--) if (predictions[k].user_id === id) predictions.splice(k, 1);
      return ok({ ok: true });
    }
    if (method === 'PUT' && path.startsWith('/admin/users/')) {
      const id = parseInt(path.split('/')[3], 10);
      const u = users.find((x) => x.id === id);
      if (!u) return err(404, 'ไม่พบผู้ใช้');
      if (body.display_name != null && body.display_name.trim()) u.display_name = body.display_name.trim();
      if (body.password) u.password = body.password;
      if (body.knockout_eligible != null) u.knockout_eligible = body.knockout_eligible ? 1 : 0;
      return ok({ ok: true });
    }

    if (method === 'POST' && path === '/teams') {
      const name = (body.name || '').trim();
      const ex = teams.find((t) => t.name === name);
      if (ex) ex.flag = (body.flag || '').trim();
      else teams.push({ id: tid++, name, flag: (body.flag || '').trim() });
      return ok({ ok: true });
    }
    if (method === 'DELETE' && path.startsWith('/teams/')) {
      const id = parseInt(path.split('/')[2], 10);
      const i = teams.findIndex((t) => t.id === id);
      if (i >= 0) teams.splice(i, 1);
      return ok({ ok: true });
    }

    if (method === 'POST' && path === '/matches') {
      addMatch({ team_home: body.team_home, team_away: body.team_away,
        team_home_flag: body.team_home_flag || regFlag(body.team_home),
        team_away_flag: body.team_away_flag || regFlag(body.team_away),
        stage: body.stage || 'Group Stage', handicap_team: body.handicap_team,
        handicap_value: body.handicap_value, kickoff_time: body.kickoff_time });
      return ok({ ok: true });
    }
    if (method === 'DELETE' && path.startsWith('/matches/')) {
      const id = parseInt(path.split('/')[2], 10);
      const i = matches.findIndex((m) => m.id === id);
      if (i >= 0) matches.splice(i, 1);
      for (let k = predictions.length - 1; k >= 0; k--) if (predictions[k].match_id === id) predictions.splice(k, 1);
      return ok({ ok: true });
    }
    if (method === 'POST' && path === '/admin/result') {
      const m = matches.find((x) => x.id === body.match_id);
      if (!m) return err(404, 'ไม่พบนัด');
      m.score_home = body.score_home; m.score_away = body.score_away; m.status = 'finished'; m.locked = 1;
      const ps = predictions.filter((p) => p.match_id === m.id);
      ps.forEach((p) => { p.points = calcPoints(m, p.predicted_winner); });
      return ok({ ok: true, updated: ps.length });
    }
    if (method === 'POST' && path === '/admin/lock') {
      const m = matches.find((x) => x.id === body.match_id);
      if (m) m.locked = body.locked ? 1 : 0;
      return ok({ ok: true });
    }
    if (method === 'GET' && path === '/admin/fetch_scores') {
      // demo has no external API — return an empty match set
      return ok({ ok: true, date: new Date().toISOString().slice(0, 10), fetched: 0, matched: [] });
    }
    if (method === 'POST' && path === '/admin/results_batch') {
      let count = 0;
      (body.results || []).forEach((it) => {
        const m = matches.find((x) => x.id === it.match_id);
        if (!m) return;
        m.score_home = it.score_home; m.score_away = it.score_away;
        m.status = it.final ? 'finished' : 'live'; m.locked = 1;
        predictions.filter((p) => p.match_id === m.id).forEach((p) => { p.points = calcPoints(m, p.predicted_winner); });
        count++;
      });
      return ok({ ok: true, matches: count, detail: [] });
    }
    if (method === 'PUT' && path.startsWith('/matches/')) {
      const id = parseInt(path.split('/')[2], 10);
      const m = matches.find((x) => x.id === id);
      if (!m) return err(404, 'ไม่พบนัด');
      ['handicap_team', 'handicap_value', 'kickoff_time', 'stage'].forEach((c) => {
        if (body[c] != null) m[c] = c === 'handicap_value' ? Number(body[c]) : body[c];
      });
      let recomputed = 0;
      if (m.score_home != null && m.score_away != null)
        predictions.filter((p) => p.match_id === m.id).forEach((p) => { p.points = calcPoints(m, p.predicted_winner); recomputed++; });
      return ok({ ok: true, recomputed });
    }
    if (method === 'POST' && path === '/admin/query') return runQuery(body.sql);
    if (method === 'POST' && path === '/admin/update_cell') {
      const EDIT = {
        users: ['display_name', 'username', 'is_admin', 'knockout_eligible'],
        teams: ['name', 'flag'],
        matches: ['team_home', 'team_away', 'team_home_flag', 'team_away_flag', 'stage', 'handicap_team', 'handicap_value', 'kickoff_time', 'score_home', 'score_away', 'status', 'locked'],
        predictions: ['predicted_winner', 'points'],
      };
      const arrs = { users, teams, matches, predictions };
      const cols = EDIT[body.table];
      if (!cols || !cols.includes(body.column) || !arrs[body.table]) return err(400, 'แก้ไขคอลัมน์นี้ไม่ได้');
      const row = arrs[body.table].find((x) => x.id === body.id);
      if (!row) return err(404, 'ไม่พบแถว');
      let v = body.value;
      if (['handicap_value', 'score_home', 'score_away', 'points', 'locked', 'is_admin', 'knockout_eligible'].includes(body.column))
        v = v === '' || v == null ? null : Number(v);
      row[body.column] = v;
      return ok({ ok: true });
    }

    return err(404, 'Not found');
  }

  window.DemoServer = { handle, calcPoints };
})();
