# Database Guide

## Overview

The World Cup Prediction app uses **SQLite** — a simple, file-based database that requires no server setup.

- **File**: `worldcup.db` (created automatically on first run)
- **Location**: In the `uploads/worldcup/` directory
- **Size**: ~100 KB (tiny — plenty of room for thousands of users)
- **No setup needed**: Database tables are created automatically with proper structure

---

## Database Structure

### Tables

#### `users`
Stores player/admin accounts.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Auto-increment primary key |
| `username` | TEXT | Unique, login name |
| `display_name` | TEXT | Show-name (Thai-friendly) |
| `password_hash` | TEXT | Bcrypt-hashed, never plaintext |
| `is_admin` | INTEGER | 0 = player, 1 = admin |
| `created_at` | TEXT | ISO timestamp |

**Admin user seeded on first run:**
- Username: `admin`
- Password: `admin1234`
- **⚠️ Change this immediately after deploying!**

---

#### `teams`
Team registry (names + flag URLs).

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Auto-increment |
| `name` | TEXT | Unique team name (e.g., "Spain") |
| `flag` | TEXT | Flag image URL (e.g., `https://flagcdn.com/w80/es.png`) |

**63 teams pre-seeded** on first run (all World Cup nations + some extras).

---

#### `matches`
Fixtures (games to predict).

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Auto-increment |
| `team_home` | TEXT | Home team name |
| `team_away` | TEXT | Away team name |
| `team_home_flag` | TEXT | Home flag URL (can override registry) |
| `team_away_flag` | TEXT | Away flag URL |
| `stage` | TEXT | "Group Stage", "Round of 16", etc. |
| `handicap_team` | TEXT | Which team gets the line |
| `handicap_value` | REAL | 0, 0.25, 0.5, ..., 5.0 |
| `kickoff_time` | TEXT | ISO datetime (Bangkok timezone) |
| `score_home` | INTEGER | NULL until result entered |
| `score_away` | INTEGER | NULL until result entered |
| `status` | TEXT | "upcoming", "finished", "live" |
| `locked` | INTEGER | 1 = admin manually closed betting |
| `created_at` | TEXT | When match was added |

**Admin actions:**
- Add matches (all fields except score, status)
- Set result (enter score_home + score_away)
- Manual lock (block late bets)
- Delete match (+ all predictions)

---

#### `predictions`
User bets (one per user per match).

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Auto-increment |
| `user_id` | INTEGER | FK → users.id |
| `match_id` | INTEGER | FK → matches.id |
| `predicted_winner` | TEXT | Team name user picked |
| `points` | REAL | NULL until match finished, then 0.0-2.0 |
| `created_at` | TEXT | When prediction was made |
| **UNIQUE** | `(user_id, match_id)` | One bet per user per match |

**Scoring (Asian handicap):**
- Full win (correct side by >line): 2.0 pts
- Half win (hit the line exactly): 1.0 pt
- Half loss (wrong by ≤line): 0.5 pts
- Full loss: 0.0 pts

[See main.py `calc_points()` for exact formula]

---

## Automatic Features

### Schema Auto-Initialization
`main.py` runs `init_db()` on startup:
1. Creates tables if they don't exist (CREATE TABLE IF NOT EXISTS)
2. Seeds the admin user (INSERT OR IGNORE)
3. Migrates old databases (adds missing columns like `stage`, `locked`, etc.)
4. Seeds 63 teams in the registry

**Result**: No manual database setup needed. Just run the app.

### Data Integrity
- **Foreign keys enforced**: Deleting a user removes their predictions
- **Unique constraints**: One prediction per user per match
- **Transactions**: Scoring calculations are atomic (all-or-nothing)

---

## Backup & Recovery

### Backup Your Database

**Option A: Manual backup (easy)**
```bash
# Copy the file
cp uploads/worldcup/worldcup.db uploads/worldcup/worldcup.db.backup
```

**Option B: Export via SQL console (admin panel)**
1. Login as admin
2. Go to Admin → Data query (SQL)
3. Click **users** / **matches** / **predictions** to export each table
4. Copy-paste results into a spreadsheet or file

**Option C: Full database dump (SQL format)**
```bash
sqlite3 worldcup.db ".dump" > worldcup.sql
```

---

### Restore from Backup

**Option A: Replace file**
```bash
cp uploads/worldcup/worldcup.db.backup uploads/worldcup/worldcup.db
```

**Option B: Restore SQL dump**
```bash
sqlite3 worldcup.db < worldcup.sql
```

---

## Troubleshooting

### "Database is locked"
- Only one app process should write at a time
- On Render: Auto-resolved (single instance)
- Locally: Stop the app, restart, and try again

### "Column X not found"
- Your DB is missing a column (old version)
- Solution: Delete `worldcup.db`, restart app
- New database will be created with all columns

### "User not found" after adding them
- New user created but app still in memory?
- Restart the FastAPI app to reload from DB

### Database size growing fast
- Predictions table grows with matches & players
- 1000 matches × 50 users = 50K predictions = ~1-2 MB

---

## Data Life Cycle

1. **Admin adds match** → `matches` table (status: "upcoming")
2. **Player predicts** → `predictions` table (points: NULL)
3. **Admin enters result** → `matches.score_*` + `status: "finished"`
4. **System calculates points** → `predictions.points` (0.0-2.0)
5. **Leaderboard updates** → SUM of points per user
6. **Results tab shows finished** → Grouped by stage

---

## Performance Notes

- **SQLite is fast enough for**: 10-1000 active users, 50-500 matches
- **Database file**: Simple copy to backup/restore (unlike PostgreSQL)
- **No server admin**: No separate DB server to maintain
- **Cold starts**: App auto-creates/verifies DB on startup (~100ms)

---

## Security

- **Passwords**: Bcrypt-hashed, never plaintext
- **Admin panel**: JWT-gated, admin-only endpoints
- **SQL console**: Read-only, whitelisted tables, no write keywords
- **SQLite file**: Should be protected from public access on your server
  - On Render: Stored on disk, not exposed publicly
  - Locally: Manage file permissions as needed

---

## Need More Help?

- **How to run locally?** → See `README.md`
- **How to deploy?** → See `DEPLOYMENT_GUIDE_RENDER.md`
- **How do queries work?** → See main.py endpoints
- **Database schema details?** → See `init_db()` in main.py
