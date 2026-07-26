from fastapi import FastAPI, HTTPException, Depends
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

app = FastAPI(title="Event For Friend · Credit Betting")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

DB_PATH = os.path.join(os.environ.get("DATA_DIR", "."), "worldcup.db")

STAGES = ["Group Stage", "Semi-finals", "The Final"]

# Bumped every deploy IN LOCKSTEP with the ?v= asset query in index.html and the
# BUILD constant in app.js. The client compares this to its own build and force-
# reloads once when they differ, so a stale cached bundle self-heals.
APP_BUILD = "16"

# Betting closes this many minutes before kickoff. Odds may keep moving right up
# to the same moment — after it, the match is frozen for everyone.
BET_CUTOFF_MIN = int(os.environ.get("BET_CUTOFF_MIN", "10"))

# Schema generation marker. Bumping this wipes the *event* data (matches, bets,
# ledger, credits) exactly once on the next boot, so the app can be re-pointed at
# a new tournament without hand-editing the database. User accounts and the team
# registry are deliberately preserved — delete those from the admin screen.
SCHEMA_VERSION = "v2-credits"

# ASEAN Championship 2026 (ASEAN Hyundai Cup) — the 10 participating nations.
TEAM_SEED = [
    ("Thailand", "th"), ("Vietnam", "vn"), ("Indonesia", "id"), ("Malaysia", "my"),
    ("Singapore", "sg"), ("Philippines", "ph"), ("Myanmar", "mm"), ("Cambodia", "kh"),
    ("Laos", "la"), ("Timor-Leste", "tl"), ("Brunei", "bn"),
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
            credits REAL NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            flag TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- One row per calendar day (Bangkok). The admin opens/closes a whole
        -- matchday at a time; individual matches still close on their own
        -- BET_CUTOFF_MIN before kickoff.
        CREATE TABLE IF NOT EXISTS bet_days (
            play_date TEXT PRIMARY KEY,          -- 'YYYY-MM-DD' Bangkok
            status    TEXT NOT NULL DEFAULT 'draft',   -- draft | open | closed
            opened_at TEXT,
            closed_at TEXT,
            opened_by INTEGER
        );

        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_home TEXT NOT NULL,
            team_away TEXT NOT NULL,
            team_home_flag TEXT DEFAULT '',
            team_away_flag TEXT DEFAULT '',
            stage TEXT DEFAULT 'Group Stage',
            handicap_team TEXT NOT NULL,         -- the team giving the goals
            handicap_value REAL NOT NULL,        -- the line, e.g. 0.5 / 0.25
            odds_home REAL NOT NULL DEFAULT 1.90,-- decimal odds (payout multiplier)
            odds_away REAL NOT NULL DEFAULT 1.90,
            kickoff_time TEXT NOT NULL,          -- 'YYYY-MM-DDTHH:MM' Bangkok
            play_date TEXT,                      -- derived from kickoff_time
            score_home INTEGER,
            score_away INTEGER,
            status TEXT DEFAULT 'upcoming',      -- upcoming | live | finished
            locked INTEGER DEFAULT 0,
            force_open INTEGER DEFAULT 0,
            apifootball_fixture_id INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
        );

        -- Every stake ever placed. line_taken / odds_taken are frozen copies of
        -- the match terms AT THE MOMENT OF THE BET — settlement reads only these,
        -- never the live match row, so later odds moves cannot rewrite history.
        CREATE TABLE IF NOT EXISTS bets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id  INTEGER NOT NULL,
            match_id INTEGER NOT NULL,
            side TEXT NOT NULL,                  -- team name the user backed
            stake REAL NOT NULL,
            hdcp_team_taken TEXT NOT NULL,
            line_taken REAL NOT NULL,
            odds_taken REAL NOT NULL,
            placed_at TEXT DEFAULT (datetime('now')),
            status TEXT NOT NULL DEFAULT 'open', -- open | settled | void
            outcome REAL,                        -- -1 / -0.5 / 0 / 0.5 / 1
            payout REAL,                         -- credits returned (0 = lost all)
            settled_at TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(match_id) REFERENCES matches(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bets_user  ON bets(user_id);
        CREATE INDEX IF NOT EXISTS idx_bets_match ON bets(match_id);

        -- Append-only audit of every credit movement.
        CREATE TABLE IF NOT EXISTS credit_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            delta REAL NOT NULL,
            balance_after REAL NOT NULL,
            reason TEXT NOT NULL,                -- topup | adjust | bet | payout | refund
            note TEXT DEFAULT '',
            bet_id INTEGER,
            admin_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id);

        -- Every odds move, so the admin can see how a price drifted.
        CREATE TABLE IF NOT EXISTS odds_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id INTEGER NOT NULL,
            handicap_team TEXT NOT NULL,
            handicap_value REAL NOT NULL,
            odds_home REAL NOT NULL,
            odds_away REAL NOT NULL,
            source TEXT DEFAULT 'admin',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_odds_match ON odds_history(match_id);
    """)

    # seed admin
    if not c.execute("SELECT id FROM users WHERE username='admin'").fetchone():
        c.execute("INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?,?,?,1)",
                  ("admin", "น้องปอนด์ (Admin)", pwd_context.hash("admin1234")))

    # migrate older databases forward (columns added since the points era)
    ucols = {r["name"] for r in c.execute("PRAGMA table_info(users)").fetchall()}
    if "credits" not in ucols:
        c.execute("ALTER TABLE users ADD COLUMN credits REAL NOT NULL DEFAULT 0")
    mcols = {r["name"] for r in c.execute("PRAGMA table_info(matches)").fetchall()}
    for col, ddl in [("odds_home", "REAL NOT NULL DEFAULT 1.90"),
                     ("odds_away", "REAL NOT NULL DEFAULT 1.90"),
                     ("play_date", "TEXT"),
                     ("apifootball_fixture_id", "INTEGER"),
                     ("force_open", "INTEGER DEFAULT 0")]:
        if col not in mcols:
            c.execute(f"ALTER TABLE matches ADD COLUMN {col} {ddl}")

    # one-time wipe of the previous tournament's event data
    row = c.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone()
    if not row or row["value"] != SCHEMA_VERSION:
        for stmt in ("DROP TABLE IF EXISTS predictions",
                     "DROP TABLE IF EXISTS champion_picks",
                     "DELETE FROM bets", "DELETE FROM credit_ledger",
                     "DELETE FROM odds_history", "DELETE FROM matches",
                     "DELETE FROM bet_days", "UPDATE users SET credits=0",
                     "DELETE FROM settings WHERE key IN ('display','champion')"):
            try:
                c.execute(stmt)
            except sqlite3.Error:
                pass
        c.execute("INSERT INTO settings (key, value) VALUES ('schema_version', ?) "
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (SCHEMA_VERSION,))
        print(f"[init] event data reset for {SCHEMA_VERSION} (users & teams kept)", flush=True)

    # seed the team registry
    if not c.execute("SELECT id FROM teams LIMIT 1").fetchone():
        for name, iso in TEAM_SEED:
            c.execute("INSERT OR IGNORE INTO teams (name, flag) VALUES (?,?)", (name, flag_url(iso)))

    # backfill play_date for any match that predates the column
    for m in c.execute("SELECT id, kickoff_time FROM matches WHERE play_date IS NULL").fetchall():
        c.execute("UPDATE matches SET play_date=? WHERE id=?",
                  (_play_date_of(m["kickoff_time"]), m["id"]))

    conn.commit()
    conn.close()

# ─── Time helpers (all stored times are Bangkok-local, naive) ────────────────
def _now_bkk() -> datetime:
    return datetime.utcnow() + timedelta(hours=7)

def _ko_bkk(s: str):
    """Parse a stored kickoff_time as a Bangkok-local naive datetime."""
    s = (s or "").replace(" ", "T")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None

def _play_date_of(kickoff: str) -> Optional[str]:
    ko = _ko_bkk(kickoff)
    return ko.strftime("%Y-%m-%d") if ko else None

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
    credits: float = 0

class ProfileIn(BaseModel):
    display_name: Optional[str] = None
    password: Optional[str] = None

class UserEditIn(BaseModel):
    display_name: Optional[str] = None
    password: Optional[str] = None

class CreditIn(BaseModel):
    user_id: int
    amount: float                 # positive = top-up, negative = take back
    note: str = ""

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
    odds_home: float = 1.90
    odds_away: float = 1.90
    kickoff_time: str

class MatchEditIn(BaseModel):
    handicap_team: Optional[str] = None
    handicap_value: Optional[float] = None
    kickoff_time: Optional[str] = None
    stage: Optional[str] = None

class OddsIn(BaseModel):
    handicap_team: Optional[str] = None
    handicap_value: Optional[float] = None
    odds_home: Optional[float] = None
    odds_away: Optional[float] = None

class BetIn(BaseModel):
    match_id: int
    side: str                     # team name being backed
    stake: float

class ResultIn(BaseModel):
    match_id: int
    score_home: int
    score_away: int

class ScoreItem(BaseModel):
    match_id: int
    score_home: int
    score_away: int
    final: bool = False

class BatchResultIn(BaseModel):
    results: List[ScoreItem]

class LockIn(BaseModel):
    match_id: int
    locked: int

class DayIn(BaseModel):
    play_date: str
    status: str                   # draft | open | closed

class QueryIn(BaseModel):
    sql: str

class MapIn(BaseModel):
    match_id: int
    fixture_id: Optional[int] = None

# ─── Asian-handicap settlement ───────────────────────────────
MIN_ODDS, MAX_ODDS = 1.01, 20.0

def norm_odds(v, fallback=1.90) -> float:
    """Decimal odds: 1.90 means a winning 100 stake returns 190 (profit 90)."""
    try:
        v = float(v)
    except (TypeError, ValueError):
        return fallback
    if v < MIN_ODDS or v > MAX_ODDS:
        return fallback
    return round(v, 3)

def ah_outcome(match_terms: dict, side: str, score_home: int, score_away: int) -> float:
    """Settle one Asian-handicap bet.

    Returns the standard AH result factor for the backed side:
       1.0 = win      0.5 = half win    0.0 = push (stake back)
      -0.5 = half loss  -1.0 = loss

    `match_terms` carries the FROZEN terms of the bet (team_home/team_away plus
    hdcp_team/line), never the live match row.
    """
    ht = match_terms["hdcp_team"]
    line = float(match_terms["line"])
    # goal difference from the point of view of the team giving the handicap
    if ht == match_terms["team_home"]:
        raw = float(score_home - score_away)
    else:
        raw = float(score_away - score_home)

    def one_line(raw_diff, ln):
        d = round(raw_diff - ln, 4)
        if ln % 1 == 0.0:                 # whole line: a push is possible
            return 1.0 if d > 0 else (0.0 if d == 0 else -1.0)
        return 1.0 if d > 0 else -1.0     # half line: no push

    frac = round(line % 1, 2)
    if frac in (0.25, 0.75):              # quarter line = split across two lines
        res = (one_line(raw, line - 0.25) + one_line(raw, line + 0.25)) / 2
    else:
        res = one_line(raw, line)

    # res is from the handicap team's perspective; flip it for the other side
    return res if side == ht else -res

def payout_for(stake: float, odds: float, outcome: float) -> float:
    """Credits returned to the punter (0 = lost everything, stake = push)."""
    profit = stake * (odds - 1.0)
    if outcome == 1.0:   return stake + profit
    if outcome == 0.5:   return stake + profit / 2
    if outcome == 0.0:   return stake
    if outcome == -0.5:  return stake / 2
    return 0.0

# ─── Credits ─────────────────────────────────────────────────
def move_credits(conn, user_id: int, delta: float, reason: str,
                 note: str = "", bet_id: int = None, admin_id: int = None) -> float:
    """Apply a credit movement and append it to the ledger. Returns the new
    balance. Callers are responsible for committing."""
    row = conn.execute("SELECT credits FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="ไม่พบผู้ใช้")
    new_balance = round(float(row["credits"]) + float(delta), 2)
    conn.execute("UPDATE users SET credits=? WHERE id=?", (new_balance, user_id))
    conn.execute("""INSERT INTO credit_ledger (user_id, delta, balance_after, reason, note, bet_id, admin_id)
                    VALUES (?,?,?,?,?,?,?)""",
                 (user_id, round(float(delta), 2), new_balance, reason, note, bet_id, admin_id))
    return new_balance

# ─── Betting windows ─────────────────────────────────────────
def day_status(conn, play_date: str) -> str:
    row = conn.execute("SELECT status FROM bet_days WHERE play_date=?", (play_date,)).fetchone()
    return row["status"] if row else "draft"

def bet_gate(conn, match: dict):
    """Why this match can't be bet on right now — or None when it's open.

    Two gates must both pass: the admin has opened the match's DAY, and the
    match itself is still more than BET_CUTOFF_MIN from kickoff. `force_open`
    is the admin's override for both.
    """
    if match["status"] == "finished":
        return "นัดนี้จบไปแล้ว"
    if match.get("force_open"):
        return None
    if match.get("locked"):
        return "แอดมินปิดรับพนันนัดนี้แล้ว"
    if match["status"] != "upcoming":
        return "นัดนี้เริ่มไปแล้ว"
    if day_status(conn, match.get("play_date") or "") != "open":
        return "ยังไม่เปิดรับพนันของวันนี้"
    ko = _ko_bkk(match["kickoff_time"])
    if ko is None:
        return "เวลาเตะไม่ถูกต้อง"
    if _now_bkk() >= ko - timedelta(minutes=BET_CUTOFF_MIN):
        return f"ปิดรับแล้ว (ต้องแทงก่อนเตะ {BET_CUTOFF_MIN} นาที)"
    return None

def odds_frozen(conn, match: dict) -> bool:
    """Odds stop moving at exactly the same moment betting closes."""
    return bet_gate(conn, match) is not None

# ─── Settlement ──────────────────────────────────────────────
def settle_match(conn, match: dict, score_home: int, score_away: int, final: bool) -> dict:
    """Write a score and settle (or re-settle) every bet on the match.

    Re-entrant: an already-settled bet is first reversed in the ledger, then
    re-paid at the corrected figure, so fixing a wrong score always converges.
    """
    status = "finished" if final else "live"
    conn.execute("UPDATE matches SET score_home=?, score_away=?, status=?, locked=1 WHERE id=?",
                 (score_home, score_away, status, match["id"]))

    bets = [dict(b) for b in conn.execute(
        "SELECT * FROM bets WHERE match_id=? AND status != 'void'", (match["id"],)).fetchall()]
    if not final:
        return {"settled": 0, "bets": len(bets)}   # only pay out once the game is over

    settled = 0
    for b in bets:
        if b["status"] == "settled" and b["payout"] is not None:
            move_credits(conn, b["user_id"], -float(b["payout"]), "refund",
                         note=f"แก้ผลนัด #{match['id']} (คืนยอดเดิม)", bet_id=b["id"])
        terms = {"team_home": match["team_home"], "team_away": match["team_away"],
                 "hdcp_team": b["hdcp_team_taken"], "line": b["line_taken"]}
        outcome = ah_outcome(terms, b["side"], score_home, score_away)
        payout = round(payout_for(float(b["stake"]), float(b["odds_taken"]), outcome), 2)
        conn.execute("""UPDATE bets SET status='settled', outcome=?, payout=?, settled_at=datetime('now')
                        WHERE id=?""", (outcome, payout, b["id"]))
        if payout:
            move_credits(conn, b["user_id"], payout, "payout",
                         note=f"ผลนัด #{match['id']}", bet_id=b["id"])
        settled += 1
    return {"settled": settled, "bets": len(bets)}

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
    conn = get_db()
    row = conn.execute("""
        SELECT COALESCE(SUM(stake),0) AS staked,
               COUNT(*) AS bets,
               COUNT(CASE WHEN status='open' THEN 1 END) AS open_bets,
               COALESCE(SUM(CASE WHEN status='settled' THEN payout - stake END),0) AS net
        FROM bets WHERE user_id=? AND status != 'void'""", (user["id"],)).fetchone()
    conn.close()
    return {"id": user["id"], "username": user["username"],
            "display_name": user["display_name"], "is_admin": user["is_admin"],
            "credits": round(float(user["credits"]), 2),
            "staked": round(float(row["staked"]), 2), "bets": row["bets"],
            "open_bets": row["open_bets"], "net": round(float(row["net"]), 2)}

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

@app.get("/settings")
def settings(user=Depends(get_current_user)):
    return {"build": APP_BUILD, "cutoff_min": BET_CUTOFF_MIN}

@app.get("/ledger/mine")
def my_ledger(user=Depends(get_current_user)):
    conn = get_db()
    rows = conn.execute("""SELECT delta, balance_after, reason, note, created_at
                           FROM credit_ledger WHERE user_id=?
                           ORDER BY id DESC LIMIT 100""", (user["id"],)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ─── Admin: user management ──────────────────────────────────
@app.get("/admin/users")
def list_users(user=Depends(require_admin)):
    conn = get_db()
    rows = conn.execute("""
        SELECT u.id, u.username, u.display_name, u.is_admin, u.credits,
               COALESCE(SUM(CASE WHEN b.status != 'void' THEN b.stake END),0) AS staked,
               COUNT(CASE WHEN b.status='open' THEN 1 END) AS open_bets
        FROM users u LEFT JOIN bets b ON b.user_id=u.id
        GROUP BY u.id ORDER BY u.is_admin DESC, u.id""").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/admin/users")
def create_user(body: UserIn, user=Depends(require_admin)):
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO users (username, display_name, password_hash) VALUES (?,?,?)",
            (body.username.strip(), body.display_name.strip(), hash_password(body.password)))
        if body.credits:
            move_credits(conn, cur.lastrowid, float(body.credits), "topup",
                         note="เครดิตเริ่มต้น", admin_id=user["id"])
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
    conn.execute("DELETE FROM bets WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM credit_ledger WHERE user_id=?", (user_id,))
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

@app.post("/admin/credits")
def add_credits(body: CreditIn, user=Depends(require_admin)):
    """The only way credits enter the system — an admin hands them out."""
    if not body.amount:
        raise HTTPException(status_code=400, detail="จำนวนเครดิตต้องไม่เป็นศูนย์")
    conn = get_db()
    target = conn.execute("SELECT id, display_name, credits FROM users WHERE id=?", (body.user_id,)).fetchone()
    if not target:
        conn.close()
        raise HTTPException(status_code=404, detail="ไม่พบผู้ใช้")
    if body.amount < 0 and float(target["credits"]) + body.amount < 0:
        conn.close()
        raise HTTPException(status_code=400, detail="ดึงเครดิตคืนเกินยอดคงเหลือไม่ได้")
    reason = "topup" if body.amount > 0 else "adjust"
    balance = move_credits(conn, body.user_id, float(body.amount), reason,
                           note=body.note or "", admin_id=user["id"])
    conn.commit()
    conn.close()
    return {"ok": True, "credits": balance}

@app.get("/admin/ledger")
def admin_ledger(limit: int = 200, user=Depends(require_admin)):
    conn = get_db()
    rows = conn.execute("""SELECT l.*, u.display_name, u.username
                           FROM credit_ledger l JOIN users u ON u.id=l.user_id
                           ORDER BY l.id DESC LIMIT ?""", (max(1, min(limit, 1000)),)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ─── Teams registry ─────────────────────────────────────────
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

# ─── Betting days ───────────────────────────────────────────
@app.get("/bet_days")
def bet_days(user=Depends(get_current_user)):
    """Every matchday with its open/closed state and a fixture count."""
    conn = get_db()
    rows = conn.execute("""
        SELECT m.play_date,
               COUNT(*) AS matches,
               COUNT(CASE WHEN m.status='finished' THEN 1 END) AS finished,
               MIN(m.kickoff_time) AS first_kickoff,
               COALESCE(d.status,'draft') AS status
        FROM matches m LEFT JOIN bet_days d ON d.play_date=m.play_date
        WHERE m.play_date IS NOT NULL
        GROUP BY m.play_date ORDER BY m.play_date""").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.put("/admin/bet_days")
def set_bet_day(body: DayIn, user=Depends(require_admin)):
    if body.status not in ("draft", "open", "closed"):
        raise HTTPException(status_code=400, detail="สถานะไม่ถูกต้อง")
    conn = get_db()
    exists = conn.execute("SELECT 1 FROM matches WHERE play_date=? LIMIT 1", (body.play_date,)).fetchone()
    if not exists:
        conn.close()
        raise HTTPException(status_code=404, detail="ไม่มีนัดในวันนี้")
    stamp = "opened_at" if body.status == "open" else "closed_at"
    conn.execute(f"""INSERT INTO bet_days (play_date, status, {stamp}, opened_by)
                     VALUES (?,?,datetime('now'),?)
                     ON CONFLICT(play_date) DO UPDATE
                     SET status=excluded.status, {stamp}=datetime('now'), opened_by=excluded.opened_by""",
                 (body.play_date, body.status, user["id"]))
    conn.commit()
    conn.close()
    return {"ok": True, "play_date": body.play_date, "status": body.status}

# ─── Matches ────────────────────────────────────────────────
def _decorate(conn, rows) -> list:
    """Attach the live betting gate + pooled stake to each match."""
    out = []
    pools = {r["match_id"]: r for r in conn.execute("""
        SELECT match_id, COUNT(*) AS n, COALESCE(SUM(stake),0) AS total
        FROM bets WHERE status != 'void' GROUP BY match_id""").fetchall()}
    for r in rows:
        m = dict(r)
        reason = bet_gate(conn, m)
        pool = pools.get(m["id"])
        m["can_bet"] = reason is None
        m["closed_reason"] = reason
        m["day_status"] = day_status(conn, m.get("play_date") or "")
        m["pool_bets"] = pool["n"] if pool else 0
        m["pool_total"] = round(float(pool["total"]), 2) if pool else 0.0
        out.append(m)
    return out

@app.get("/matches")
def list_matches(user=Depends(get_current_user)):
    conn = get_db()
    rows = conn.execute("SELECT * FROM matches ORDER BY kickoff_time").fetchall()
    out = _decorate(conn, rows)
    conn.close()
    return out

@app.post("/matches")
def add_match(body: MatchIn, user=Depends(require_admin)):
    conn = get_db()
    def reg_flag(name, given):
        if given: return given
        row = conn.execute("SELECT flag FROM teams WHERE name=?", (name,)).fetchone()
        return row["flag"] if row else ""
    hf = reg_flag(body.team_home, body.team_home_flag)
    af = reg_flag(body.team_away, body.team_away_flag)
    oh, oa = norm_odds(body.odds_home), norm_odds(body.odds_away)
    cur = conn.execute("""INSERT INTO matches
        (team_home,team_away,team_home_flag,team_away_flag,stage,handicap_team,handicap_value,
         odds_home,odds_away,kickoff_time,play_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (body.team_home, body.team_away, hf, af, body.stage, body.handicap_team,
         body.handicap_value, oh, oa, body.kickoff_time, _play_date_of(body.kickoff_time)))
    conn.execute("""INSERT INTO odds_history (match_id, handicap_team, handicap_value, odds_home, odds_away, source)
                    VALUES (?,?,?,?,?,'admin')""",
                 (cur.lastrowid, body.handicap_team, body.handicap_value, oh, oa))
    conn.commit()
    conn.close()
    return {"ok": True, "id": cur.lastrowid}

@app.delete("/matches/{match_id}")
def delete_match(match_id: int, user=Depends(require_admin)):
    """Deleting a fixture refunds every open stake on it."""
    conn = get_db()
    open_bets = conn.execute("SELECT * FROM bets WHERE match_id=? AND status='open'", (match_id,)).fetchall()
    for b in open_bets:
        move_credits(conn, b["user_id"], float(b["stake"]), "refund",
                     note=f"ยกเลิกนัด #{match_id}", bet_id=b["id"])
    conn.execute("UPDATE bets SET status='void' WHERE match_id=?", (match_id,))
    conn.execute("DELETE FROM matches WHERE id=?", (match_id,))
    conn.commit()
    conn.close()
    return {"ok": True, "refunded": len(open_bets)}

@app.put("/matches/{match_id}")
def edit_match(match_id: int, body: MatchEditIn, user=Depends(require_admin)):
    conn = get_db()
    match = conn.execute("SELECT * FROM matches WHERE id=?", (match_id,)).fetchone()
    if not match:
        conn.close()
        raise HTTPException(status_code=404, detail="ไม่พบนัด")
    fields = {c: getattr(body, c) for c in ("handicap_team", "handicap_value", "kickoff_time", "stage")
              if getattr(body, c) is not None}
    if "kickoff_time" in fields:
        fields["play_date"] = _play_date_of(fields["kickoff_time"])
    if fields:
        sets = ", ".join(f"{c}=?" for c in fields)
        conn.execute(f"UPDATE matches SET {sets} WHERE id=?", (*fields.values(), match_id))
    conn.commit()
    conn.close()
    # NOTE: already-placed bets keep their own line_taken — editing the fixture
    # never rewrites them. Re-enter the score to re-settle if the result changes.
    return {"ok": True}

@app.put("/matches/{match_id}/odds")
def update_odds(match_id: int, body: OddsIn, user=Depends(require_admin)):
    """Move the price. Allowed right up to the betting cutoff, never after."""
    conn = get_db()
    row = conn.execute("SELECT * FROM matches WHERE id=?", (match_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="ไม่พบนัด")
    m = dict(row)
    if odds_frozen(conn, m):
        conn.close()
        raise HTTPException(status_code=400, detail="ปิดรับพนันแล้ว — แก้ราคาไม่ได้")
    ht = body.handicap_team or m["handicap_team"]
    hv = m["handicap_value"] if body.handicap_value is None else float(body.handicap_value)
    oh = norm_odds(body.odds_home, m["odds_home"]) if body.odds_home is not None else m["odds_home"]
    oa = norm_odds(body.odds_away, m["odds_away"]) if body.odds_away is not None else m["odds_away"]
    conn.execute("UPDATE matches SET handicap_team=?, handicap_value=?, odds_home=?, odds_away=? WHERE id=?",
                 (ht, hv, oh, oa, match_id))
    conn.execute("""INSERT INTO odds_history (match_id, handicap_team, handicap_value, odds_home, odds_away, source)
                    VALUES (?,?,?,?,?,'admin')""", (match_id, ht, hv, oh, oa))
    conn.commit()
    conn.close()
    return {"ok": True, "handicap_team": ht, "handicap_value": hv, "odds_home": oh, "odds_away": oa}

@app.get("/matches/{match_id}/odds_history")
def odds_history(match_id: int, user=Depends(get_current_user)):
    conn = get_db()
    rows = conn.execute("""SELECT handicap_team, handicap_value, odds_home, odds_away, source, created_at
                           FROM odds_history WHERE match_id=? ORDER BY id DESC LIMIT 50""",
                        (match_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ─── Bets ───────────────────────────────────────────────────
@app.get("/bets/mine")
def my_bets(user=Depends(get_current_user)):
    conn = get_db()
    rows = conn.execute("""
        SELECT b.*, m.team_home, m.team_away, m.team_home_flag, m.team_away_flag, m.stage,
               m.kickoff_time, m.play_date, m.score_home, m.score_away, m.status AS match_status
        FROM bets b JOIN matches m ON b.match_id=m.id
        WHERE b.user_id=? ORDER BY m.kickoff_time DESC, b.id DESC""", (user["id"],)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/bets")
def place_bet(body: BetIn, user=Depends(get_current_user)):
    """Place a stake. The line and price are frozen onto the bet right here —
    this is the only moment they are read from the match."""
    stake = round(float(body.stake), 2)
    if stake <= 0:
        raise HTTPException(status_code=400, detail="จำนวนเงินต้องมากกว่า 0")
    conn = get_db()
    row = conn.execute("SELECT * FROM matches WHERE id=?", (body.match_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="ไม่พบนัดนี้")
    m = dict(row)
    if body.side not in (m["team_home"], m["team_away"]):
        conn.close()
        raise HTTPException(status_code=400, detail="เลือกได้เฉพาะทีมในนัดนี้")
    reason = bet_gate(conn, m)
    if reason:
        conn.close()
        raise HTTPException(status_code=400, detail=reason)

    fresh = conn.execute("SELECT credits FROM users WHERE id=?", (user["id"],)).fetchone()
    if float(fresh["credits"]) < stake:
        conn.close()
        raise HTTPException(status_code=400,
                            detail=f"เครดิตไม่พอ (คงเหลือ {round(float(fresh['credits']),2)})")

    odds = m["odds_home"] if body.side == m["team_home"] else m["odds_away"]
    cur = conn.execute("""INSERT INTO bets
        (user_id, match_id, side, stake, hdcp_team_taken, line_taken, odds_taken)
        VALUES (?,?,?,?,?,?,?)""",
        (user["id"], body.match_id, body.side, stake,
         m["handicap_team"], m["handicap_value"], odds))
    bet_id = cur.lastrowid
    balance = move_credits(conn, user["id"], -stake, "bet",
                           note=f"{m['team_home']} v {m['team_away']} · {body.side}", bet_id=bet_id)
    conn.commit()
    conn.close()
    return {"ok": True, "bet_id": bet_id, "credits": balance,
            "line_taken": m["handicap_value"], "odds_taken": odds}

@app.delete("/bets/{bet_id}")
def cancel_bet(bet_id: int, user=Depends(get_current_user)):
    """Pull a stake back while the match is still open for betting."""
    conn = get_db()
    b = conn.execute("SELECT * FROM bets WHERE id=?", (bet_id,)).fetchone()
    if not b or (b["user_id"] != user["id"] and not user["is_admin"]):
        conn.close()
        raise HTTPException(status_code=404, detail="ไม่พบบิลนี้")
    if b["status"] != "open":
        conn.close()
        raise HTTPException(status_code=400, detail="บิลนี้ปิดไปแล้ว")
    m = conn.execute("SELECT * FROM matches WHERE id=?", (b["match_id"],)).fetchone()
    if m and bet_gate(conn, dict(m)):
        conn.close()
        raise HTTPException(status_code=400, detail="ปิดรับพนันแล้ว — ยกเลิกไม่ได้")
    conn.execute("UPDATE bets SET status='void', settled_at=datetime('now') WHERE id=?", (bet_id,))
    balance = move_credits(conn, b["user_id"], float(b["stake"]), "refund",
                           note="ยกเลิกบิล", bet_id=bet_id)
    conn.commit()
    conn.close()
    return {"ok": True, "credits": balance}

@app.get("/matches/{match_id}/bets")
def match_bets(match_id: int, user=Depends(get_current_user)):
    """Who backed what — only revealed once betting on the match has closed."""
    conn = get_db()
    row = conn.execute("SELECT * FROM matches WHERE id=?", (match_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="ไม่พบนัด")
    if bet_gate(conn, dict(row)) is None and not user["is_admin"]:
        conn.close()
        return {"revealed": False, "bets": []}
    rows = conn.execute("""SELECT u.display_name, b.side, b.stake, b.line_taken, b.odds_taken,
                                  b.status, b.outcome, b.payout
                           FROM bets b JOIN users u ON u.id=b.user_id
                           WHERE b.match_id=? AND b.status != 'void'
                           ORDER BY b.stake DESC""", (match_id,)).fetchall()
    conn.close()
    return {"revealed": True, "bets": [dict(r) for r in rows]}

# ─── Admin: results ─────────────────────────────────────────
@app.post("/admin/result")
def set_result(body: ResultIn, user=Depends(require_admin)):
    conn = get_db()
    match = conn.execute("SELECT * FROM matches WHERE id=?", (body.match_id,)).fetchone()
    if not match:
        conn.close()
        raise HTTPException(status_code=404, detail="ไม่พบนัด")
    info = settle_match(conn, dict(match), body.score_home, body.score_away, final=True)
    conn.commit()
    conn.close()
    return {"ok": True, **info}

@app.post("/admin/results_batch")
def set_results_batch(body: BatchResultIn, user=Depends(require_admin)):
    conn = get_db()
    detail = []
    for item in body.results:
        match = conn.execute("SELECT * FROM matches WHERE id=?", (item.match_id,)).fetchone()
        if not match:
            continue
        info = settle_match(conn, dict(match), item.score_home, item.score_away, item.final)
        detail.append({"match_id": item.match_id, "final": item.final, **info})
    conn.commit()
    conn.close()
    return {"ok": True, "matches": len(detail), "detail": detail}

@app.post("/admin/lock")
def lock_match(body: LockIn, user=Depends(require_admin)):
    conn = get_db()
    if body.locked:
        conn.execute("UPDATE matches SET locked=1, force_open=0 WHERE id=?", (body.match_id,))
    else:
        conn.execute("UPDATE matches SET locked=0, force_open=1 WHERE id=?", (body.match_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

# ─── Live scores (free provider, default = ESPN) ─────────────
# The admin maps each of our matches to a provider event id (no name guessing).
# A background poller then auto-fetches the score while a match is in play and
# finalizes it when the provider says the game is over.
SCORE_PROVIDER = os.environ.get("SCORE_PROVIDER", "espn").lower()

# ESPN (default, no key) — aff.championship is the ASEAN Championship.
ESPN_BASE   = os.environ.get("ESPN_BASE", "https://site.api.espn.com/apis/site/v2/sports/soccer")
ESPN_LEAGUE = os.environ.get("ESPN_LEAGUE", "aff.championship")

# API-Football (optional alternative) — needs a paid plan for the current season.
APIFOOTBALL_KEY    = os.environ.get("APIFOOTBALL_KEY", "")
APIFOOTBALL_BASE   = os.environ.get("APIFOOTBALL_BASE", "https://v3.football.api-sports.io")
APIFOOTBALL_LEAGUE = os.environ.get("APIFOOTBALL_LEAGUE", "27")
APIFOOTBALL_SEASON = os.environ.get("APIFOOTBALL_SEASON", "2026")

POLL_INTERVAL_SEC = int(os.environ.get("POLL_INTERVAL_SEC", "900"))
POLL_WINDOW_MIN   = int(os.environ.get("POLL_WINDOW_MIN", "150"))

_LIVE_STATUS  = {"1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"}
_FINAL_STATUS = {"FT", "AET", "PEN"}

_TEAM_ALIAS_GROUPS = [
    {"timorleste", "easttimor"},
    {"myanmar", "burma"},
    {"laos", "laopdr"},
    {"brunei", "bruneidarussalam"},
    {"vietnam", "vietnamnational"},
]

def _norm_team(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

def _team_eq(a: str, b: str) -> bool:
    na, nb = _norm_team(a), _norm_team(b)
    if na == nb:
        return True
    return any(na in g and nb in g for g in _TEAM_ALIAS_GROUPS)

def _espn_get(date_yyyymmdd=None) -> dict:
    url = f"{ESPN_BASE}/{ESPN_LEAGUE}/scoreboard"
    if date_yyyymmdd:
        url += "?dates=" + date_yyyymmdd
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (eventforfriend)"})
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
            state = (stype.get("state") or "").lower()
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
    if "rapidapi" in APIFOOTBALL_BASE:
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
    return True

def _fixtures_for_dates(dates) -> list:
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
    sh = 0 if fx["score_home"] is None else fx["score_home"]
    sa = 0 if fx["score_away"] is None else fx["score_away"]
    if _team_eq(m["team_away"], fx["home"]) and _team_eq(m["team_home"], fx["away"]):
        return sa, sh
    return sh, sa

def _match_utc_date(m: dict):
    ko = _ko_bkk(m["kickoff_time"])
    if ko is None:
        return None
    return (ko - timedelta(hours=7)).strftime("%Y%m%d")

def _in_poll_window(m: dict) -> bool:
    ko = _ko_bkk(m["kickoff_time"])
    if ko is None:
        return False
    now = _now_bkk()
    return ko <= now <= ko + timedelta(minutes=POLL_WINDOW_MIN)

@app.get("/admin/apifootball/fixtures")
def apifootball_fixtures(user=Depends(require_admin)):
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
    if not _provider_ready():
        raise HTTPException(status_code=400, detail="provider=apifootball แต่ยังไม่ได้ตั้ง APIFOOTBALL_KEY")
    conn = get_db()
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM matches WHERE status != 'finished' AND apifootball_fixture_id IS NOT NULL"
    ).fetchall()]
    conn.close()
    if not rows:
        return {"ok": True, "fetched": 0, "matched": [], "note": "ยังไม่มีนัดที่ผูกกับ event — กดผูกก่อน"}
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

# ─── Background poller ──────────────────────────────────────
def _poll_once() -> int:
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
            settle_match(conn, m, sh, sa, fx["final"])
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
    print(f"[poller] started · provider={SCORE_PROVIDER} · league={ESPN_LEAGUE} · "
          f"every {POLL_INTERVAL_SEC}s · window {POLL_WINDOW_MIN}min", flush=True)

# ─── SQL console (read-only) ────────────────────────────────
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

_EDITABLE = {
    "users": {"display_name", "username", "is_admin"},
    "teams": {"name", "flag"},
    "matches": {"team_home", "team_away", "team_home_flag", "team_away_flag", "stage",
                "handicap_team", "handicap_value", "odds_home", "odds_away",
                "kickoff_time", "play_date", "score_home", "score_away", "status",
                "locked", "force_open"},
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
    """Ranked by credits on hand. `net` is realised profit/loss; `at_risk` is
    what is still sitting in unsettled bets."""
    conn = get_db()
    rows = conn.execute("""
        SELECT u.display_name, u.username, u.credits,
               COALESCE(SUM(CASE WHEN b.status != 'void' THEN b.stake END),0) AS staked,
               COALESCE(SUM(CASE WHEN b.status='open' THEN b.stake END),0) AS at_risk,
               COALESCE(SUM(CASE WHEN b.status='settled' THEN b.payout - b.stake END),0) AS net,
               COUNT(CASE WHEN b.status != 'void' THEN 1 END) AS bets,
               COUNT(CASE WHEN b.status='settled' AND b.outcome > 0 THEN 1 END) AS wins,
               COUNT(CASE WHEN b.status='settled' AND b.outcome < 0 THEN 1 END) AS losses
        FROM users u LEFT JOIN bets b ON b.user_id=u.id
        WHERE u.is_admin=0
        GROUP BY u.id
        ORDER BY (u.credits + COALESCE(SUM(CASE WHEN b.status='open' THEN b.stake END),0)) DESC,
                 net DESC""").fetchall()
    conn.close()
    return [dict(r) for r in rows]

class NoCacheStaticFiles(StaticFiles):
    """Serve static assets with revalidation so deploys show up immediately."""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        ctype = resp.headers.get("content-type", "")
        if path in ("", "/", "index.html") or ctype.startswith("text/html"):
            resp.headers["Cache-Control"] = "no-store"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
        else:
            resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp

app.mount("/", NoCacheStaticFiles(directory="static", html=True), name="static")
