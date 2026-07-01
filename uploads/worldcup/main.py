from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta
from jose import JWTError, jwt
from passlib.context import CryptContext
import sqlite3, os, re, json, urllib.request, urllib.parse, threading, time

SECRET_KEY = "worldcup2026-secret-key-change-in-production"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 24

app = FastAPI(title="World Cup Prediction")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

DB_PATH = os.path.join(os.environ.get("DATA_DIR", "."), "worldcup.db")

STAGES = ["Group Stage", "Round of 32", "Round of 16", "Quarter-finals",
          "Semi-finals", "Third-Place Play-off", "The Final"]

# Admin-configurable: which stat boxes show on the home hero, and which tabs
# show on the leaderboard. Stored as one JSON row in `settings` so it survives
# restarts without a schema change.
HOME_STAT_KEYS = ["knockout", "overall", "wins"]
LB_TAB_KEYS = ["overall", "group", "knockout"]
DEFAULT_DISPLAY_SETTINGS = {"home_stats": list(HOME_STAT_KEYS), "lb_tabs": list(LB_TAB_KEYS)}

# Bumped every deploy IN LOCKSTEP with the ?v= asset query in index.html and the
# BUILD constant in app.js. The client compares this to its own build and force-
# reloads once when they differ, so a stale cached bundle self-heals.
APP_BUILD = "11"

# Pre-defined teams (name -> flag image URL via flagcdn). Admin can edit/add later.
TEAM_SEED = [
    ("Argentina", "ar"), ("Brazil", "br"), ("France", "fr"), ("England", "gb-eng"),
    ("Spain", "es"), ("Germany", "de"), ("Portugal", "pt"), ("Netherlands", "nl"),
    ("Italy", "it"), ("Belgium", "be"), ("Croatia", "hr"), ("Uruguay", "uy"),
    ("Mexico", "mx"), ("USA", "us"), ("Canada", "ca"), ("Japan", "jp"),
    ("South Korea", "kr"), ("Australia", "au"), ("Morocco", "ma"), ("Senegal", "sn"),
    ("Ghana", "gh"), ("Nigeria", "ng"), ("Cameroon", "cm"), ("Ivory Coast", "ci"),
    ("Saudi Arabia", "sa"), ("Iran", "ir"), ("Qatar", "qa"), ("Switzerland", "ch"),
    ("Denmark", "dk"), ("Poland", "pl"), ("Serbia", "rs"), ("Wales", "gb-wls"),
    ("Scotland", "gb-sct"), ("Ecuador", "ec"), ("Colombia", "co"), ("Peru", "pe"),
    ("Chile", "cl"), ("Paraguay", "py"), ("Venezuela", "ve"), ("Costa Rica", "cr"),
    ("Panama", "pa"), ("Jamaica", "jm"), ("Honduras", "hn"), ("Austria", "at"),
    ("Sweden", "se"), ("Norway", "no"), ("Turkey", "tr"), ("Ukraine", "ua"),
    ("Czech Republic", "cz"), ("Hungary", "hu"), ("Greece", "gr"), ("Egypt", "eg"),
    ("Algeria", "dz"), ("Tunisia", "tn"), ("South Africa", "za"), ("Mali", "ml"),
    ("New Zealand", "nz"), ("Uzbekistan", "uz"), ("Iraq", "iq"), ("UAE", "ae"),
    ("Jordan", "jo"), ("Thailand", "th"), ("Vietnam", "vn"),
]
def flag_url(iso): return f"https://flagcdn.com/w80/{iso}.png"

# ─── Database ────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            flag TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_home TEXT NOT NULL,
            team_away TEXT NOT NULL,
            team_home_flag TEXT DEFAULT '',
            team_away_flag TEXT DEFAULT '',
            stage TEXT DEFAULT 'Group Stage',
            handicap_team TEXT NOT NULL,
            handicap_value REAL NOT NULL,
            kickoff_time TEXT NOT NULL,
            score_home INTEGER,
            score_away INTEGER,
            status TEXT DEFAULT 'upcoming',
            locked INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            match_id INTEGER NOT NULL,
            predicted_winner TEXT NOT NULL,
            points REAL,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(user_id, match_id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(match_id) REFERENCES matches(id)
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    """)
    # seed admin
    if not c.execute("SELECT id FROM users WHERE username='admin'").fetchone():
        c.execute("INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?,?,?,1)",
                  ("admin", "น้องปอนด์ (Admin)", pwd_context.hash("admin1234")))
    # migrate: add columns to existing databases if missing
    cols = {r["name"] for r in c.execute("PRAGMA table_info(matches)").fetchall()}
    for col, ddl in [("team_home_flag", "TEXT DEFAULT ''"), ("team_away_flag", "TEXT DEFAULT ''"),
                     ("stage", "TEXT DEFAULT 'Group Stage'"), ("locked", "INTEGER DEFAULT 0"),
                     ("apifootball_fixture_id", "INTEGER")]:
        if col not in cols:
            c.execute(f"ALTER TABLE matches ADD COLUMN {col} {ddl}")
    user_cols = {r["name"] for r in c.execute("PRAGMA table_info(users)").fetchall()}
    if "knockout_eligible" not in user_cols:
        # existing players keep playing knockout by default; admin opts specific
        # users out (left the group) or in (joined fresh) per round from here.
        c.execute("ALTER TABLE users ADD COLUMN knockout_eligible INTEGER DEFAULT 1")
    # seed teams registry
    if not c.execute("SELECT id FROM teams LIMIT 1").fetchone():
        for name, iso in TEAM_SEED:
            c.execute("INSERT OR IGNORE INTO teams (name, flag) VALUES (?,?)", (name, flag_url(iso)))
    # seed display settings (which home stat boxes / leaderboard tabs admin shows)
    if not c.execute("SELECT key FROM settings WHERE key='display'").fetchone():
        c.execute("INSERT INTO settings (key, value) VALUES ('display', ?)",
                  (json.dumps(DEFAULT_DISPLAY_SETTINGS),))
    conn.commit()
    conn.close()

init_db()

# ─── Auth ────────────────────────────────────────────────────
def verify_password(plain, hashed): return pwd_context.verify(plain, hashed)
def hash_password(password): return pwd_context.hash(password)

def create_token(data: dict):
    exp = datetime.utcnow() + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    return jwt.encode({**data, "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str = Depends(oauth2_scheme)):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username: raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    conn.close()
    if not user: raise HTTPException(status_code=401, detail="User not found")
    return dict(user)

def require_admin(user=Depends(get_current_user)):
    if not user["is_admin"]: raise HTTPException(status_code=403, detail="Admin only")
    return user

# ─── Models ──────────────────────────────────────────────────
class UserIn(BaseModel):
    username: str
    display_name: str
    password: str
    knockout_eligible: bool = True

class ProfileIn(BaseModel):
    display_name: Optional[str] = None
    password: Optional[str] = None

class UserEditIn(BaseModel):
    display_name: Optional[str] = None
    password: Optional[str] = None
    knockout_eligible: Optional[bool] = None

class CellIn(BaseModel):
    table: str
    id: int
    column: str
    value: Optional[str] = None

class TeamIn(BaseModel):
    name: str
    flag: str = ""

class MatchIn(BaseModel):
    team_home: str
    team_away: str
    team_home_flag: str = ""
    team_away_flag: str = ""
    stage: str = "Group Stage"
    handicap_team: str
    handicap_value: float
    kickoff_time: str

class MatchEditIn(BaseModel):
    handicap_team: Optional[str] = None
    handicap_value: Optional[float] = None
    kickoff_time: Optional[str] = None
    stage: Optional[str] = None

class PredictionIn(BaseModel):
    match_id: int
    predicted_winner: str

class ResultIn(BaseModel):
    match_id: int
    score_home: int
    score_away: int

class ScoreItem(BaseModel):
    match_id: int
    score_home: int
    score_away: int
    final: bool = False          # True = match over (finalize); False = live/in-progress

class BatchResultIn(BaseModel):
    results: List[ScoreItem]

class LockIn(BaseModel):
    match_id: int
    locked: int

class QueryIn(BaseModel):
    sql: str

class MapIn(BaseModel):
    match_id: int
    fixture_id: Optional[int] = None   # None / null = clear the mapping

class DisplaySettingsIn(BaseModel):
    home_stats: List[str]
    lb_tabs: List[str]

# ─── Scoring logic (Asian Handicap) ──────────────────────────
def calc_points(match: dict, predicted_winner: str) -> float:
    h, a = match["score_home"], match["score_away"]
    hv = match["handicap_value"]
    ht = match["handicap_team"]

    if ht == match["team_home"]:
        raw_diff = float(h - a)
    else:
        raw_diff = float(a - h)

    def score_single_line(raw, line):
        d = round(raw - line, 4)
        if line % 1 == 0.0:
            if d > 0:  return 2.0
            if d == 0: return 1.0
            return 0.0
        else:
            return 2.0 if d > 0 else 0.0

    frac = round(hv % 1, 2)
    if frac in (0.25, 0.75):
        s = (score_single_line(raw_diff, hv - 0.25) + score_single_line(raw_diff, hv + 0.25)) / 2
    else:
        s = score_single_line(raw_diff, hv)

    return s if predicted_winner == ht else 2.0 - s

def default_pick(match: dict) -> str:
    """System default team for a match — mirrors the frontend rule:
    the handicap team when there's a line, otherwise the home (left) team."""
    return match["handicap_team"] if (match.get("handicap_value") or 0) > 0 else match["team_home"]

def ensure_default_predictions(conn, match: dict) -> int:
    """Persist the system default pick for every non-admin user who hasn't
    submitted a prediction for this match. This is the safety net that keeps
    the displayed default in sync with real backend data (and scoring).
    Knockout matches (anything past Group Stage) only get a default for users
    flagged knockout_eligible, since the roster can shrink/grow between rounds.
    Returns the number of default rows created."""
    team = default_pick(match)
    eligibility = "" if match.get("stage") == "Group Stage" else "AND knockout_eligible=1 "
    missing = conn.execute(
        f"SELECT id FROM users WHERE is_admin=0 {eligibility}"
        "AND id NOT IN (SELECT user_id FROM predictions WHERE match_id=?)",
        (match["id"],)).fetchall()
    for u in missing:
        conn.execute(
            "INSERT OR IGNORE INTO predictions (user_id, match_id, predicted_winner) VALUES (?,?,?)",
            (u["id"], match["id"], team))
    return len(missing)

def apply_result(conn, match: dict, score_home: int, score_away: int, final: bool) -> int:
    """Set a match's score and recompute every prediction's points immediately.
    final=True finalizes the match (status 'finished'); final=False marks it
    'live' so the score can still be updated again (e.g. half-time then
    full-time). Betting is always closed once a score is entered. Recomputes
    from scratch each call, so it is safe to run repeatedly. Returns the number
    of predictions scored."""
    status = "finished" if final else "live"
    conn.execute("UPDATE matches SET score_home=?, score_away=?, status=?, locked=1 WHERE id=?",
                 (score_home, score_away, status, match["id"]))
    ensure_default_predictions(conn, match)  # make sure everyone has a row before scoring
    scored = {**match, "score_home": score_home, "score_away": score_away}
    preds = conn.execute("SELECT * FROM predictions WHERE match_id=?", (match["id"],)).fetchall()
    for p in preds:
        conn.execute("UPDATE predictions SET points=? WHERE id=?",
                     (calc_points(scored, p["predicted_winner"]), p["id"]))
    return len(preds)

# ─── Endpoints ───────────────────────────────────────────────
@app.post("/token")
def login(form: OAuth2PasswordRequestForm = Depends()):
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username=?", (form.username,)).fetchone()
    conn.close()
    if not user or not verify_password(form.password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง")
    token = create_token({"sub": user["username"]})
    return {"access_token": token, "token_type": "bearer",
            "display_name": user["display_name"], "is_admin": user["is_admin"]}

@app.get("/me")
def me(user=Depends(get_current_user)):
    return {"id": user["id"], "username": user["username"],
            "display_name": user["display_name"], "is_admin": user["is_admin"],
            "knockout_eligible": bool(user["knockout_eligible"])}

@app.post("/me/update")
def update_me(body: ProfileIn, user=Depends(get_current_user)):
    conn = get_db()
    if body.display_name is not None and body.display_name.strip():
        conn.execute("UPDATE users SET display_name=? WHERE id=?", (body.display_name.strip(), user["id"]))
    if body.password:
        conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(body.password), user["id"]))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.get("/stages")
def stages(user=Depends(get_current_user)):
    return STAGES

def get_display_settings(conn) -> dict:
    row = conn.execute("SELECT value FROM settings WHERE key='display'").fetchone()
    if not row:
        return dict(DEFAULT_DISPLAY_SETTINGS)
    try:
        cfg = json.loads(row["value"])
    except (TypeError, ValueError):
        return dict(DEFAULT_DISPLAY_SETTINGS)
    # keep only known keys, in their configured order; fall back to defaults if empty
    home_stats = [k for k in cfg.get("home_stats", []) if k in HOME_STAT_KEYS] or list(DEFAULT_DISPLAY_SETTINGS["home_stats"])
    lb_tabs = [k for k in cfg.get("lb_tabs", []) if k in LB_TAB_KEYS] or list(DEFAULT_DISPLAY_SETTINGS["lb_tabs"])
    return {"home_stats": home_stats, "lb_tabs": lb_tabs}

@app.get("/settings")
def settings(user=Depends(get_current_user)):
    """Display config (home stat boxes / leaderboard tabs) — visible to everyone
    so the UI knows what the admin chose to show. Also reports the current build
    so a stale client can detect a new deploy and reload itself."""
    conn = get_db()
    cfg = get_display_settings(conn)
    conn.close()
    return {**cfg, "build": APP_BUILD}

@app.put("/admin/settings")
def update_settings(body: DisplaySettingsIn, user=Depends(require_admin)):
    home_stats = [k for k in body.home_stats if k in HOME_STAT_KEYS]
    lb_tabs = [k for k in body.lb_tabs if k in LB_TAB_KEYS]
    if not lb_tabs:
        raise HTTPException(status_code=400, detail="ต้องเปิดอย่างน้อย 1 แท็บตารางคะแนน")
    cfg = {"home_stats": home_stats, "lb_tabs": lb_tabs}
    conn = get_db()
    conn.execute("INSERT INTO settings (key, value) VALUES ('display', ?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(cfg),))
    conn.commit()
    conn.close()
    return {"ok": True, **cfg}

# ─── Admin: user management (self-registration disabled) ─────
@app.get("/admin/users")
def list_users(user=Depends(require_admin)):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, username, display_name, is_admin, knockout_eligible FROM users ORDER BY is_admin DESC, id"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/admin/users")
def create_user(body: UserIn, user=Depends(require_admin)):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (username, display_name, password_hash, knockout_eligible) VALUES (?,?,?,?)",
            (body.username.strip(), body.display_name.strip(), hash_password(body.password),
             1 if body.knockout_eligible else 0))
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="ชื่อผู้ใช้นี้มีอยู่แล้ว")
    finally:
        conn.close()
    return {"ok": True}

@app.delete("/admin/users/{user_id}")
def delete_user(user_id: int, user=Depends(require_admin)):
    conn = get_db()
    target = conn.execute("SELECT is_admin FROM users WHERE id=?", (user_id,)).fetchone()
    if target and target["is_admin"]:
        conn.close()
        raise HTTPException(status_code=400, detail="ลบผู้ดูแลระบบไม่ได้")
    conn.execute("DELETE FROM predictions WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM users WHERE id=?", (user_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.put("/admin/users/{user_id}")
def edit_user(user_id: int, body: UserEditIn, user=Depends(require_admin)):
    conn = get_db()
    if body.display_name is not None and body.display_name.strip():
        conn.execute("UPDATE users SET display_name=? WHERE id=?", (body.display_name.strip(), user_id))
    if body.password:
        conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(body.password), user_id))
    if body.knockout_eligible is not None:
        conn.execute("UPDATE users SET knockout_eligible=? WHERE id=?",
                     (1 if body.knockout_eligible else 0, user_id))
    conn.commit()
    conn.close()
    return {"ok": True}

# ─── Teams registry (pre-defined flags) ─────────────────────
@app.get("/teams")
def list_teams(user=Depends(get_current_user)):
    conn = get_db()
    rows = conn.execute("SELECT * FROM teams ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/teams")
def upsert_team(body: TeamIn, user=Depends(require_admin)):
    conn = get_db()
    conn.execute("INSERT INTO teams (name, flag) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET flag=excluded.flag",
                 (body.name.strip(), body.flag.strip()))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/teams/{team_id}")
def delete_team(team_id: int, user=Depends(require_admin)):
    conn = get_db()
    conn.execute("DELETE FROM teams WHERE id=?", (team_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

# ─── Matches ────────────────────────────────────────────────
@app.get("/matches")
def list_matches(user=Depends(get_current_user)):
    conn = get_db()
    rows = conn.execute("SELECT * FROM matches ORDER BY kickoff_time").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/matches")
def add_match(body: MatchIn, user=Depends(require_admin)):
    conn = get_db()
    # auto-fill flags from the team registry when not provided
    def reg_flag(name, given):
        if given: return given
        row = conn.execute("SELECT flag FROM teams WHERE name=?", (name,)).fetchone()
        return row["flag"] if row else ""
    hf = reg_flag(body.team_home, body.team_home_flag)
    af = reg_flag(body.team_away, body.team_away_flag)
    conn.execute("""INSERT INTO matches
        (team_home,team_away,team_home_flag,team_away_flag,stage,handicap_team,handicap_value,kickoff_time)
        VALUES (?,?,?,?,?,?,?,?)""",
        (body.team_home, body.team_away, hf, af, body.stage, body.handicap_team, body.handicap_value, body.kickoff_time))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/matches/{match_id}")
def delete_match(match_id: int, user=Depends(require_admin)):
    conn = get_db()
    conn.execute("DELETE FROM matches WHERE id=?", (match_id,))
    conn.execute("DELETE FROM predictions WHERE match_id=?", (match_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.put("/matches/{match_id}")
def edit_match(match_id: int, body: MatchEditIn, user=Depends(require_admin)):
    """Edit a match after creation — primarily the handicap line. If the match
    already has a score, points are recomputed so the standings stay correct."""
    conn = get_db()
    match = conn.execute("SELECT * FROM matches WHERE id=?", (match_id,)).fetchone()
    if not match:
        conn.close()
        raise HTTPException(status_code=404, detail="ไม่พบนัด")
    match = dict(match)
    fields = {c: getattr(body, c) for c in ("handicap_team", "handicap_value", "kickoff_time", "stage")
              if getattr(body, c) is not None}
    if fields:
        sets = ", ".join(f"{c}=?" for c in fields)
        conn.execute(f"UPDATE matches SET {sets} WHERE id=?", (*fields.values(), match_id))
    # recompute points when the handicap changed on an already-scored match
    recomputed = 0
    new_match = {**match, **fields}
    if new_match["score_home"] is not None and new_match["score_away"] is not None:
        preds = conn.execute("SELECT * FROM predictions WHERE match_id=?", (match_id,)).fetchall()
        for p in preds:
            conn.execute("UPDATE predictions SET points=? WHERE id=?",
                         (calc_points(new_match, p["predicted_winner"]), p["id"]))
        recomputed = len(preds)
    conn.commit()
    conn.close()
    return {"ok": True, "recomputed": recomputed}

# ─── Predictions ────────────────────────────────────────────
@app.get("/predictions/mine")
def my_predictions(user=Depends(get_current_user)):
    conn = get_db()
    rows = conn.execute("""
        SELECT p.*, m.team_home, m.team_away, m.team_home_flag, m.team_away_flag, m.stage,
               m.handicap_team, m.handicap_value, m.kickoff_time, m.score_home, m.score_away,
               m.status, m.locked
        FROM predictions p JOIN matches m ON p.match_id=m.id
        WHERE p.user_id=? ORDER BY m.kickoff_time
    """, (user["id"],)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/predictions")
def submit_prediction(body: PredictionIn, user=Depends(get_current_user)):
    conn = get_db()
    match = conn.execute("SELECT * FROM matches WHERE id=?", (body.match_id,)).fetchone()
    if not match:
        conn.close()
        raise HTTPException(status_code=404, detail="ไม่พบนัดนี้")
    match = dict(match)
    if match.get("stage") != "Group Stage" and not user["knockout_eligible"]:
        conn.close()
        raise HTTPException(status_code=403, detail="คุณไม่ได้รับสิทธิ์ทายผลรอบน็อคเอาท์นี้")
    if match.get("locked"):
        conn.close()
        raise HTTPException(status_code=400, detail="แอดมินปิดรับการทายนัดนี้แล้ว")
    if match["status"] != "upcoming":
        conn.close()
        raise HTTPException(status_code=400, detail="นัดนี้เริ่มไปแล้ว")
    kickoff = datetime.fromisoformat(match["kickoff_time"])
    if datetime.utcnow() + timedelta(hours=7) >= kickoff - timedelta(minutes=30):
        conn.close()
        raise HTTPException(status_code=400, detail="หมดเวลาทาย (ต้องส่งก่อน Kickoff 30 นาที)")
    try:
        conn.execute("INSERT OR REPLACE INTO predictions (user_id, match_id, predicted_winner) VALUES (?,?,?)",
                     (user["id"], body.match_id, body.predicted_winner))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}

# ─── Admin: results, lock, query ────────────────────────────
@app.post("/admin/result")
def set_result(body: ResultIn, user=Depends(require_admin)):
    conn = get_db()
    match = conn.execute("SELECT * FROM matches WHERE id=?", (body.match_id,)).fetchone()
    if not match: raise HTTPException(status_code=404, detail="ไม่พบนัด")
    n = apply_result(conn, dict(match), body.score_home, body.score_away, final=True)
    conn.commit()
    conn.close()
    return {"ok": True, "updated": n}

@app.post("/admin/results_batch")
def set_results_batch(body: BatchResultIn, user=Depends(require_admin)):
    """Update the score of several in-progress matches in a single request and
    recompute points immediately. Built for live updates (half-time / full-time)
    while keeping API calls to a minimum. Pass final=True per match when it ends."""
    conn = get_db()
    detail = []
    for item in body.results:
        match = conn.execute("SELECT * FROM matches WHERE id=?", (item.match_id,)).fetchone()
        if not match:
            continue
        n = apply_result(conn, dict(match), item.score_home, item.score_away, item.final)
        detail.append({"match_id": item.match_id, "scored": n, "final": item.final})
    conn.commit()
    conn.close()
    return {"ok": True, "matches": len(detail), "detail": detail}

# ─── Live scores: World Cup 2026 (free provider, default = ESPN) ─────────────
# The admin maps each of our matches to a specific provider event id (no name
# guessing). A background poller then auto-fetches the score every POLL_INTERVAL
# while a match is in play, and finalizes it when the provider says the game is
# over. Default provider is ESPN's public scoreboard — free, no API key, and it
# carries the FIFA World Cup. Set SCORE_PROVIDER=apifootball to use API-Football
# instead (needs a paid plan for season 2026 + APIFOOTBALL_KEY).
SCORE_PROVIDER = os.environ.get("SCORE_PROVIDER", "espn").lower()

# ESPN (default, no key) — public site API. fifa.world = the World Cup finals.
ESPN_BASE   = os.environ.get("ESPN_BASE", "https://site.api.espn.com/apis/site/v2/sports/soccer")
ESPN_LEAGUE = os.environ.get("ESPN_LEAGUE", "fifa.world")

# API-Football (optional alternative) — needs a paid plan for the 2026 season.
APIFOOTBALL_KEY    = os.environ.get("APIFOOTBALL_KEY", "")
APIFOOTBALL_BASE   = os.environ.get("APIFOOTBALL_BASE", "https://v3.football.api-sports.io")
APIFOOTBALL_LEAGUE = os.environ.get("APIFOOTBALL_LEAGUE", "1")      # 1 = FIFA World Cup
APIFOOTBALL_SEASON = os.environ.get("APIFOOTBALL_SEASON", "2026")   # World Cup 2026 only

POLL_INTERVAL_SEC = int(os.environ.get("POLL_INTERVAL_SEC", "900"))  # 15 min
POLL_WINDOW_MIN   = int(os.environ.get("POLL_WINDOW_MIN", "150"))    # poll for 150 min after kickoff

_LIVE_STATUS  = {"1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"}   # API-Football
_FINAL_STATUS = {"FT", "AET", "PEN"}                                          # API-Football
# Used only to keep home/away orientation correct once the admin has chosen the
# event — NOT to pick which event goes with which match (that is manual).
_TEAM_ALIAS_GROUPS = [
    {"southkorea", "korearepublic"},
    {"usa", "unitedstates", "unitedstatesofamerica", "usmnt"},
    {"uae", "unitedarabemirates"},
    {"czechrepublic", "czechia"},
    {"turkey", "turkiye", "trkiye"},
    {"ivorycoast", "cotedivoire"},
]

def _norm_team(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

def _team_eq(a: str, b: str) -> bool:
    na, nb = _norm_team(a), _norm_team(b)
    if na == nb:
        return True
    return any(na in g and nb in g for g in _TEAM_ALIAS_GROUPS)

# A normalized fixture dict has: id, date, home, away, score_home, score_away,
# live (bool), final (bool). Both providers parse into this shape.

def _espn_get(date_yyyymmdd=None) -> dict:
    url = f"{ESPN_BASE}/{ESPN_LEAGUE}/scoreboard"
    if date_yyyymmdd:
        url += "?dates=" + date_yyyymmdd
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (worldcup-app)"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))

def _espn_parse(payload: dict) -> list:
    out = []
    for e in payload.get("events", []):
        try:
            comp = (e.get("competitions") or [])[0]
            cs = comp.get("competitors") or []
            home = next(c for c in cs if c.get("homeAway") == "home")
            away = next(c for c in cs if c.get("homeAway") == "away")
            stype = (e.get("status") or {}).get("type") or {}
            state = (stype.get("state") or "").lower()        # pre | in | post
            def _sc(c):
                v = str(c.get("score", "")).strip()
                return int(v) if v.lstrip("-").isdigit() else None
            def _nm(c):
                t = c.get("team") or {}
                return t.get("displayName") or t.get("name") or t.get("shortDisplayName") or ""
            out.append({
                "id": int(e["id"]),
                "date": (e.get("date") or "")[:16].replace("T", " "),
                "home": _nm(home), "away": _nm(away),
                "score_home": _sc(home), "score_away": _sc(away),
                "live": state == "in",
                "final": bool(stype.get("completed")) or state == "post",
            })
        except (KeyError, StopIteration, TypeError, ValueError):
            continue
    return out

def _apifootball_get(params: dict) -> dict:
    qs = urllib.parse.urlencode(params)
    headers = {"x-apisports-key": APIFOOTBALL_KEY}
    if "rapidapi" in APIFOOTBALL_BASE:   # also support the RapidAPI proxy
        headers = {"x-rapidapi-key": APIFOOTBALL_KEY,
                   "x-rapidapi-host": APIFOOTBALL_BASE.split("//")[-1].split("/")[0]}
    req = urllib.request.Request(f"{APIFOOTBALL_BASE}/fixtures?{qs}", headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("errors"):
        raise RuntimeError(str(payload["errors"]))
    return payload

def _apifootball_parse(payload: dict) -> list:
    out = []
    for f in payload.get("response", []):
        try:
            short = (f["fixture"]["status"]["short"] or "").upper()
            out.append({
                "id": f["fixture"]["id"],
                "date": (f["fixture"].get("date") or "")[:16].replace("T", " "),
                "home": f["teams"]["home"]["name"], "away": f["teams"]["away"]["name"],
                "score_home": f["goals"]["home"], "score_away": f["goals"]["away"],
                "live": short in _LIVE_STATUS, "final": short in _FINAL_STATUS,
            })
        except (KeyError, TypeError):
            continue
    return out

def _provider_ready() -> bool:
    if SCORE_PROVIDER == "apifootball":
        return bool(APIFOOTBALL_KEY)
    return True   # ESPN needs no key

def _fixtures_for_dates(dates) -> list:
    """Fetch normalized fixtures for a set of UTC dates (YYYYMMDD), deduped by id."""
    out, seen = [], set()
    for d in sorted({x for x in dates if x}):
        if SCORE_PROVIDER == "apifootball":
            iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
            fxs = _apifootball_parse(_apifootball_get(
                {"league": APIFOOTBALL_LEAGUE, "season": APIFOOTBALL_SEASON, "date": iso}))
        else:
            fxs = _espn_parse(_espn_get(d))
        for fx in fxs:
            if fx["id"] not in seen:
                seen.add(fx["id"]); out.append(fx)
    return out

def _oriented_scores(m: dict, fx: dict):
    """Return (home, away) goals aligned to OUR match's team order. The admin
    chose the event; here we only flip orientation if the provider lists the
    teams the other way round. Unknown goals count as 0."""
    sh = 0 if fx["score_home"] is None else fx["score_home"]
    sa = 0 if fx["score_away"] is None else fx["score_away"]
    if _team_eq(m["team_away"], fx["home"]) and _team_eq(m["team_home"], fx["away"]):
        return sa, sh
    return sh, sa

def _ko_bkk(s: str):
    """Parse a stored kickoff_time as Bangkok-local naive datetime."""
    s = (s or "").replace(" ", "T")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None

def _match_utc_date(m: dict):
    """UTC calendar date (YYYYMMDD) of a match's kickoff — what providers key on."""
    ko = _ko_bkk(m["kickoff_time"])
    if ko is None:
        return None
    return (ko - timedelta(hours=7)).strftime("%Y%m%d")

def _in_poll_window(m: dict) -> bool:
    """True from kickoff until POLL_WINDOW_MIN minutes after (Bangkok time)."""
    ko = _ko_bkk(m["kickoff_time"])
    if ko is None:
        return False
    now = datetime.utcnow() + timedelta(hours=7)
    return ko <= now <= ko + timedelta(minutes=POLL_WINDOW_MIN)

@app.get("/admin/apifootball/fixtures")
def apifootball_fixtures(user=Depends(require_admin)):
    """List World Cup fixtures from the score provider (exact team names + event
    ids) so the admin can manually map each of our matches to one. Looks up the
    dates of our unfinished matches, plus today."""
    if not _provider_ready():
        raise HTTPException(status_code=400, detail="provider=apifootball แต่ยังไม่ได้ตั้ง APIFOOTBALL_KEY")
    conn = get_db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM matches WHERE status != 'finished'").fetchall()]
    conn.close()
    dates = {_match_utc_date(m) for m in rows}
    dates.add(datetime.utcnow().strftime("%Y%m%d"))
    try:
        fx = _fixtures_for_dates(dates)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"เรียกข้อมูลสกอร์ไม่สำเร็จ: {e}")
    fx.sort(key=lambda x: (x["date"], x["id"]))
    fixtures = [{"fixture_id": f["id"], "date": f["date"], "home": f["home"], "away": f["away"],
                 "score_home": f["score_home"], "score_away": f["score_away"],
                 "live": f["live"], "final": f["final"]} for f in fx]
    note = "" if fixtures else f"ยังไม่พบนัดในวันที่ {sorted(d for d in dates if d)} (provider={SCORE_PROVIDER})"
    return {"ok": True, "provider": SCORE_PROVIDER, "count": len(fixtures),
            "dates": sorted(d for d in dates if d), "fixtures": fixtures, "note": note}

@app.post("/admin/apifootball/map")
def apifootball_map(body: MapIn, user=Depends(require_admin)):
    """Bind (or clear) the provider event id for one of our matches."""
    conn = get_db()
    cur = conn.execute("UPDATE matches SET apifootball_fixture_id=? WHERE id=?",
                       (body.fixture_id, body.match_id))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="ไม่พบนัดนี้")
    return {"ok": True, "match_id": body.match_id, "fixture_id": body.fixture_id}

@app.get("/admin/fetch_scores")
def fetch_scores(user=Depends(require_admin)):
    """Manual 'fetch now' — pull scores for every mapped, unfinished match and
    return suggestions for the admin to review. Does NOT write anything."""
    if not _provider_ready():
        raise HTTPException(status_code=400, detail="provider=apifootball แต่ยังไม่ได้ตั้ง APIFOOTBALL_KEY")
    conn = get_db()
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM matches WHERE status != 'finished' AND apifootball_fixture_id IS NOT NULL"
    ).fetchall()]
    conn.close()
    if not rows:
        return {"ok": True, "fetched": 0, "matched": [],
                "note": "ยังไม่มีนัดที่ผูกกับ event — กดผูกก่อน"}
    dates = {_match_utc_date(m) for m in rows} or {datetime.utcnow().strftime("%Y%m%d")}
    try:
        found = {fx["id"]: fx for fx in _fixtures_for_dates(dates)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"เรียกข้อมูลสกอร์ไม่สำเร็จ: {e}")
    matched = []
    for m in rows:
        fx = found.get(m["apifootball_fixture_id"])
        if not fx or not (fx["live"] or fx["final"]):
            continue
        sh, sa = _oriented_scores(m, fx)
        matched.append({"match_id": m["id"], "score_home": sh, "score_away": sa, "final": fx["final"]})
    return {"ok": True, "fetched": len(found), "matched": matched}

# ─── Background poller: auto-fetch + auto-finalize while matches are live ────
def _poll_once() -> int:
    """One auto cycle: for every mapped, unfinished match inside its poll
    window, pull the live score and write it (finalizing when the game is over).
    Returns the number of matches updated."""
    if not _provider_ready():
        return 0
    conn = get_db()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM matches WHERE status != 'finished' AND apifootball_fixture_id IS NOT NULL"
        ).fetchall()]
        active = [m for m in rows if _in_poll_window(m)]
        if not active:
            return 0
        found = {fx["id"]: fx for fx in _fixtures_for_dates({_match_utc_date(m) for m in active})}
        updated = 0
        for m in active:
            fx = found.get(m["apifootball_fixture_id"])
            if not fx or not (fx["live"] or fx["final"]):
                continue
            sh, sa = _oriented_scores(m, fx)
            apply_result(conn, m, sh, sa, fx["final"])
            updated += 1
        conn.commit()
        return updated
    finally:
        conn.close()

def _poller_loop():
    while True:
        try:
            n = _poll_once()
            if n:
                print(f"[poller] auto-updated {n} match(es)", flush=True)
        except Exception as e:
            print(f"[poller] error: {e}", flush=True)
        time.sleep(POLL_INTERVAL_SEC)

_poller_started = False

@app.on_event("startup")
def _start_poller():
    global _poller_started
    if _poller_started or os.environ.get("DISABLE_POLLER"):
        return
    _poller_started = True
    threading.Thread(target=_poller_loop, daemon=True).start()
    print(f"[poller] started · provider={SCORE_PROVIDER} · every {POLL_INTERVAL_SEC}s · window {POLL_WINDOW_MIN}min", flush=True)

@app.post("/admin/lock")
def lock_match(body: LockIn, user=Depends(require_admin)):
    conn = get_db()
    conn.execute("UPDATE matches SET locked=? WHERE id=?", (1 if body.locked else 0, body.match_id))
    created = 0
    if body.locked:  # betting closed — lock in the default pick for anyone who hasn't bet
        match = conn.execute("SELECT * FROM matches WHERE id=?", (body.match_id,)).fetchone()
        if match:
            created = ensure_default_predictions(conn, dict(match))
    conn.commit()
    conn.close()
    return {"ok": True, "defaults_added": created}

_FORBIDDEN = re.compile(r"\b(insert|update|delete|drop|alter|attach|detach|create|replace|pragma|vacuum|reindex)\b", re.I)

@app.post("/admin/query")
def admin_query(body: QueryIn, user=Depends(require_admin)):
    sql = (body.sql or "").strip().rstrip(";").strip()
    low = sql.lower()
    if not (low.startswith("select") or low.startswith("with")):
        raise HTTPException(status_code=400, detail="อนุญาตเฉพาะคำสั่ง SELECT เท่านั้น")
    if ";" in sql:
        raise HTTPException(status_code=400, detail="รันได้ครั้งละ 1 คำสั่ง")
    if _FORBIDDEN.search(low):
        raise HTTPException(status_code=400, detail="พบคำสั่งที่ไม่อนุญาต (read-only เท่านั้น)")
    conn = get_db()
    try:
        conn.execute("PRAGMA query_only=ON")
        cur = conn.execute(sql)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = [list(r) for r in cur.fetchmany(1000)]
    except sqlite3.Error as e:
        conn.close()
        raise HTTPException(status_code=400, detail=f"SQL error: {e}")
    conn.close()
    return {"columns": cols, "rows": rows, "row_count": len(rows)}

# editable result cells — whitelisted tables/columns only, by row id
_EDITABLE = {
    "users": {"display_name", "username", "is_admin", "knockout_eligible"},
    "teams": {"name", "flag"},
    "matches": {"team_home", "team_away", "team_home_flag", "team_away_flag", "stage",
                "handicap_team", "handicap_value", "kickoff_time", "score_home", "score_away", "status", "locked"},
    "predictions": {"predicted_winner", "points"},
}

@app.post("/admin/update_cell")
def update_cell(body: CellIn, user=Depends(require_admin)):
    cols = _EDITABLE.get(body.table)
    if not cols or body.column not in cols:
        raise HTTPException(status_code=400, detail="แก้ไขคอลัมน์นี้ไม่ได้")
    conn = get_db()
    conn.execute(f"UPDATE {body.table} SET {body.column}=? WHERE id=?", (body.value, body.id))
    conn.commit()
    conn.close()
    return {"ok": True}

# ─── Leaderboard ────────────────────────────────────────────
# Group Stage and knockout (Round of 32 → Final) are scored as separate boards
# so the knockout phase effectively "starts from zero" — plus an overall board
# summing everything. No extra table: it's just a CASE on matches.stage.
_PHASE_COND = {
    "group":    "m.stage = 'Group Stage'",
    "knockout": "m.stage != 'Group Stage'",
    "overall":  "1=1",
}

@app.get("/leaderboard")
def leaderboard(phase: str = "overall", user=Depends(get_current_user)):
    cond = _PHASE_COND.get(phase, _PHASE_COND["overall"])
    # knockout board only lists players still flagged in for this round —
    # someone who dropped out shouldn't clutter it with a static 0
    roster_filter = "AND u.knockout_eligible=1" if phase == "knockout" else ""
    conn = get_db()
    rows = conn.execute(f"""
        SELECT u.display_name, u.username,
               COALESCE(SUM(CASE WHEN {cond} THEN p.points END),0) as total_points,
               COUNT(CASE WHEN {cond} THEN p.id END) as total_predictions,
               COUNT(CASE WHEN {cond} AND p.points=2 THEN 1 END) as wins,
               COUNT(CASE WHEN {cond} AND m.status='finished' THEN 1 END) as finished
        FROM users u
        LEFT JOIN predictions p ON u.id=p.user_id
        LEFT JOIN matches m ON p.match_id=m.id
        WHERE u.is_admin=0 {roster_filter}
        GROUP BY u.id ORDER BY total_points DESC, wins DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]

class NoCacheStaticFiles(StaticFiles):
    """Serve static assets with revalidation so deploys show up immediately.

    Without this, browsers happily keep serving an old app.js/styles.css for
    hours after a deploy. `no-cache` doesn't disable caching — it forces the
    browser to revalidate against the server (cheap 304 when unchanged), so a
    freshly-deployed file is always picked up on the next load.
    """
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        ctype = resp.headers.get("content-type", "")
        if path in ("", "/", "index.html") or ctype.startswith("text/html"):
            # The HTML entry point can't be cache-busted with ?v= (nothing
            # references it with a version), so forbid storing it outright —
            # every navigation re-fetches the current index.html and thus the
            # current ?v= asset references. The doc is tiny; cost is negligible.
            resp.headers["Cache-Control"] = "no-store"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        else:
            # hashed/versioned assets: cheap 304 revalidation
            resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp

app.mount("/", NoCacheStaticFiles(directory="static", html=True), name="static")
