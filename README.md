# 🏆 World Cup 2026 Prediction Game

A **playful, friendly prediction game** for friends to bet on World Cup matches using Asian handicap scoring.

## 🎯 What Is This?

A **full-stack web app** where:
- 👥 **Friends create accounts** and predict match outcomes
- 🎲 **Admin sets matches** with handicap lines and stages
- 📊 **System calculates points** automatically (Asian handicap scoring)
- 🏅 **Leaderboard** shows rankings by total points
- 🎨 **Mobile-first**, Navy + Gold theme, Thai + English bilingual

**Perfect for**: Office pools, friend groups, casual game nights.

---

## 📁 Project Structure

```
.
├── README.md                              # This file
├── QUICK_START.md                         # 5-minute deploy guide ⭐ START HERE
├── DEPLOYMENT_GUIDE_RENDER.md             # Detailed Render.com steps
├── IMPLEMENTATION_SUMMARY.md              # Full feature list & tech stack
├── uploads/worldcup/                      # Main app (all you need to deploy)
│   ├── main.py                            # FastAPI backend
│   ├── requirements.txt                   # Python dependencies
│   ├── Procfile                           # Heroku/Render start command
│   ├── static/
│   │   ├── index.html                    # Login + app shell
│   │   ├── app.js                        # Main app logic
│   │   ├── demo.js                       # Demo fallback (works offline)
│   │   ├── flags.js                      # Flag rendering
│   │   ├── styles.css                    # Styling (Navy + Gold theme)
│   │   └── tweaks.js                     # Settings panel
│   ├── DATABASE_GUIDE.md                 # Database schema & backup
│   ├── ADMIN_GETTING_STARTED.md          # Setup & operations guide ⭐
│   └── README.md                         # Deployment instructions
└── render.yaml                            # Optional Render config
```

---

## 🚀 Deploy in 5 Minutes

### Option A: Free on Render.com (Recommended)

**See**: [`QUICK_START.md`](QUICK_START.md) or [`DEPLOYMENT_GUIDE_RENDER.md`](DEPLOYMENT_GUIDE_RENDER.md)

```bash
# 1. Push to GitHub
git push origin main

# 2. On render.com:
#    - Sign in with GitHub
#    - New Web Service → select repo
#    - Build: cd uploads/worldcup && pip install -r requirements.txt
#    - Start: cd uploads/worldcup && uvicorn main:app --host 0.0.0.0 --port $PORT
#    - Plan: Free
#    - Create

# 3. Done! Your app URL: https://worldcup-prediction-xxxx.onrender.com
```

**Login:**
- Username: `admin`
- Password: `admin1234`

### Option B: Run Locally (Test)

```bash
cd uploads/worldcup
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Then open: `http://localhost:8000`

---

## 📋 Features

### For Players
- ✓ Sign in (no public registration — admin creates accounts)
- ✓ **Predict matches** before kickoff
- ✓ **Auto-defaults** (system picks the favorite, user can change)
- ✓ **Leaderboard** with podium (gold/silver/bronze)
- ✓ **History** of your predictions with points
- ✓ **Profile**: Change password & nickname
- ✓ **Tweaks**: Adjust accent color, density, fonts

### For Admin
- ✓ **Create/edit/delete users** (usernames + passwords)
- ✓ **Add matches** (teams, handicap line 0–5.0, stage, kickoff time)
- ✓ **Set match results** → Auto-calculate points (Asian handicap)
- ✓ **Lock/unlock** matches (prevent late bets)
- ✓ **Team registry** (manage flag images)
- ✓ **SQL console** (query database, edit cells inline)
- ✓ **Results tab** (finished matches grouped by stage)

### Tech
- ✓ **FastAPI backend** (Python, SQLite, JWT auth)
- ✓ **Vanilla JS frontend** (no frameworks, ~17 KB total)
- ✓ **Demo fallback** (fully functional offline)
- ✓ **Mobile-first** responsive design
- ✓ **Bilingual** (Thai + English)
- ✓ **Asian handicap scoring** (faithful port from Python)

---

## 🎯 Quick Admin Setup

**After deploying:**

1. **Change admin password**
   - Login as `admin` / `admin1234`
   - Click avatar → Change password

2. **Create accounts for friends**
   - Admin → Create user
   - Add username, password, display name

3. **Add your first match**
   - Admin → New fixture
   - Pick teams, handicap line, stage, kickoff time

4. **After the match: Enter result**
   - Admin → Set result
   - System calculates points instantly

👉 **Full guide**: See `uploads/worldcup/ADMIN_GETTING_STARTED.md`

---

## 🛢️ Database

**SQLite** — automatic, file-based, zero setup.

- **Tables**: users, teams, matches, predictions
- **Backup**: Copy `worldcup.db` file
- **Restore**: Paste it back

👉 **Full guide**: See `uploads/worldcup/DATABASE_GUIDE.md`

---

## 🎨 Tech Stack

| Layer | Tech |
|-------|------|
| **Backend** | FastAPI (Python 3.11+) |
| **Database** | SQLite (auto-created) |
| **Frontend** | Vanilla JS (no frameworks) |
| **Styling** | Modern CSS (mobile-first) |
| **Auth** | JWT (24-hour tokens) |
| **Demo** | In-memory server (works offline) |

---

## 📊 Scoring Rules

**Asian Handicap**:

| Result | Points |
|--------|--------|
| Win by > line | 2.0 |
| Win by exactly line (0.5-increments) | 1.0 |
| Lose by ≤ line (half-line split) | 0.5 or 1.0 |
| Loss | 0.0 |

Example:
- Match: Spain vs Germany, Spain -0.5
- Result: Spain wins 1-0
- Bet on Spain: 2.0 pts (won by 1 > 0.5)
- Bet on Germany: 0.0 pts (lost by 1)

---

## 💡 Use Cases

- **Office tournaments**: Track predictions across teams
- **Friend groups**: Friendly competition during tournaments
- **Event gamification**: Add excitement to watch parties
- **Learning**: See how Asian handicap scoring works

---

## ⚠️ Important Notes

### Default Credentials
- **Admin**: `admin` / `admin1234`
- **Change immediately** after deploying!

### Free Tier Limitations (Render)
- **Cold starts**: ~30 sec after 15 min inactivity (normal)
- **Storage**: 1 GB (plenty for SQLite)
- **Compute**: 750 hrs/month (enough for continuous use)
- **Database**: Lives on Render's disk (backup if critical)

### Demo Mode
- Open `static/index.html` without a server
- Works completely offline with demo data
- Auto-triggers when FastAPI is unreachable

---

## 📚 Documentation

| Guide | Purpose |
|-------|---------|
| [`QUICK_START.md`](QUICK_START.md) | 5-minute deploy (you are here) |
| [`DEPLOYMENT_GUIDE_RENDER.md`](DEPLOYMENT_GUIDE_RENDER.md) | Step-by-step Render.com |
| [`IMPLEMENTATION_SUMMARY.md`](IMPLEMENTATION_SUMMARY.md) | Features & architecture |
| [`uploads/worldcup/ADMIN_GETTING_STARTED.md`](uploads/worldcup/ADMIN_GETTING_STARTED.md) | Admin setup & daily ops |
| [`uploads/worldcup/DATABASE_GUIDE.md`](uploads/worldcup/DATABASE_GUIDE.md) | Database schema & backup |

---

## 🆘 Troubleshooting

### Deployment fails on Render
→ Check logs in Render dashboard → Look for Build Command / Start Command errors → See `DEPLOYMENT_GUIDE_RENDER.md`

### App is slow
→ Free tier spins down after inactivity. First request takes 20-30 sec. Use UptimeRobot to keep warm.

### Can't login as admin
→ Check username/password is exactly `admin` / `admin1234` (case-sensitive)

### Database corrupted
→ Delete `worldcup.db` → App creates new one on next run

### More help
→ See documentation files above

---

## 🤝 Contributing

This app is ready to use as-is. Want to modify it?
- Edit `uploads/worldcup/` files
- Test locally: `uvicorn main:app`
- Deploy: `git push` (auto-deploys on Render if configured)

---

## 📜 License

Built with ❤️ for your World Cup 2026 prediction tournament.

---

## 🎉 Ready to Start?

1. **Deploy**: Follow [`QUICK_START.md`](QUICK_START.md)
2. **Admin setup**: Follow [`uploads/worldcup/ADMIN_GETTING_STARTED.md`](uploads/worldcup/ADMIN_GETTING_STARTED.md)
3. **Invite friends**: Share your app URL
4. **Have fun!** 🏆

---

**Questions?** Check the documentation files or reach out!

**Let's predict! ⚽**
