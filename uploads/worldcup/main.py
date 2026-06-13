from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta
from jose import JWTError, jwt
from passlib.context import CryptContext
import sqlite3, os, re

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
    """)
    # seed admin
    if not c.execute("SELECT id FROM users WHERE username='admin'").fetchone():
        c.execute("INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?,?,?,1)",
                  ("admin", "น้องปอนด์ (Admin)", pwd_context.hash("admin1234")))
    # migrate: add columns to existing databases if missing
    cols = {r["name"] for r in c.execute("PRAGMA table_info(matches)").fetchall()}
    for col, ddl in [("team_home_flag", "TEXT DEFAULT ''"), ("team_away_flag", "TEXT DEFAULT ''"),
                     ("stage", "TEXT DEFAULT 'Group Stage'"), ("locked", "INTEGER DEFAULT 0")]:
        if col not in cols:
            c.execute(f"ALTER TABLE matches ADD COLUMN {col} {ddl}")
    # seed teams registry
    if not c.execute("SELECT id FROM teams LIMIT 1").fetchone():
        for name, iso in TEAM_SEED:
            c.execute("INSERT OR IGNORE INTO teams (name, flag) VALUES (?,?)", (name, flag_url(iso)))
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

class ProfileIn(BaseModel):
    display_name: Optional[str] = None
    password: Optional[str] = None

class UserEditIn(BaseModel):
    display_name: Optional[str] = None
    password: Optional[str] = None

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
    Returns the number of default rows created."""
    team = default_pick(match)
    missing = conn.execute(
        "SELECT id FROM users WHERE is_admin=0 "
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
            "display_name": user["display_name"], "is_admin": user["is_admin"]}

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

# ─── Admin: user management (self-registration disabled) ─────
@app.get("/admin/users")
def list_users(user=Depends(require_admin)):
    conn = get_db()
    rows = conn.execute("SELECT id, username, display_name, is_admin FROM users ORDER BY is_admin DESC, id").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/admin/users")
def create_user(body: UserIn, user=Depends(require_admin)):
    conn = get_db()
    try:
        conn.execute("INSERT INTO users (username, display_name, password_hash) VALUES (?,?,?)",
                     (body.username.strip(), body.display_name.strip(), hash_password(body.password)))
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
    "users": {"display_name", "username", "is_admin"},
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
@app.get("/leaderboard")
def leaderboard(user=Depends(get_current_user)):
    conn = get_db()
    rows = conn.execute("""
        SELECT u.display_name, u.username,
               COALESCE(SUM(p.points),0) as total_points,
               COUNT(p.id) as total_predictions,
               COUNT(CASE WHEN p.points=2 THEN 1 END) as wins,
               COUNT(CASE WHEN m.status='finished' THEN 1 END) as finished
        FROM users u
        LEFT JOIN predictions p ON u.id=p.user_id
        LEFT JOIN matches m ON p.match_id=m.id
        WHERE u.is_admin=0
        GROUP BY u.id ORDER BY total_points DESC, wins DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]

app.mount("/", StaticFiles(directory="static", html=True), name="static")
