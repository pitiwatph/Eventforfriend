# ▶️ START HERE — Deploy Your World Cup App in 5 Minutes

Welcome! Your World Cup Prediction app is **100% ready to deploy**.

---

## 🎯 The Goal
Deploy your app **free online** so your friends can start predicting matches immediately.

---

## ⏱️ 5-Minute Deploy (Render.com)

### Step 1: Push to GitHub (1 min)

```bash
# Open terminal in your repo
cd /home/claude/repo

# Connect to GitHub (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/worldcup-prediction.git
git branch -M main
git push -u origin main
```

**Result:** Your code is on GitHub

---

### Step 2: Deploy on Render.com (4 min)

1. Go to https://render.com
2. Click **Sign up** (sign in with GitHub)
3. Click **Dashboard** → **New +** → **Web Service**
4. Select your `worldcup-prediction` repository
5. Click **Connect**

**Fill in this form:**

```
Name:           worldcup-prediction
Environment:    Python 3
Region:         Singapore (or your region)
Branch:         main
Build Command:  cd uploads/worldcup && pip install -r requirements.txt
Start Command:  cd uploads/worldcup && uvicorn main:app --host 0.0.0.0 --port $PORT
Plan:           Free
```

6. Click **Create Web Service**
7. Wait 2-3 minutes for deploy to finish
8. Click the URL (looks like `https://worldcup-prediction-xxxx.onrender.com`)

**Done! Your app is live!** 🎉

---

## 🔐 First Time Setup (2 min)

### 1. Login
- **Username:** `admin`
- **Password:** `admin1234`

### 2. Change Your Admin Password
1. Click your avatar (top-right)
2. Click **แก้ / Edit**
3. Enter new password
4. Click **บันทึก / Save**

### 3. Invite Friends
1. Go to **Admin** tab
2. Scroll to **Create user**
3. For each friend:
   - Display name: `James` (their nickname)
   - Username: `james` (login name)
   - Password: `temppass123` (they can change later)
   - Click **+ สร้างผู้ใช้ / Create**

### 4. Add a Test Match
1. Go to **Admin** tab
2. Scroll to **Add fixture**
3. Fill in:
   - Home: `Spain`
   - Away: `Germany`
   - Handicap team: Click `Spain`
   - Line: Pick `1.0`
   - Stage: `Group Stage`
   - Kickoff: Pick tomorrow, 4 PM
4. Click **+ เพิ่มนัด / Add fixture**

**Done!** Your friends can now predict.

---

## 📖 Next: Read These Docs

| File | Read When |
|------|-----------|
| [`QUICK_START.md`](QUICK_START.md) | If you need more detail on deploy |
| [`DEPLOYMENT_GUIDE_RENDER.md`](DEPLOYMENT_GUIDE_RENDER.md) | If deploy fails or you need troubleshooting |
| [`uploads/worldcup/ADMIN_GETTING_STARTED.md`](uploads/worldcup/ADMIN_GETTING_STARTED.md) | **After first deploy** — complete admin guide |
| [`uploads/worldcup/DATABASE_GUIDE.md`](uploads/worldcup/DATABASE_GUIDE.md) | If you need to backup/manage data |

---

## ✅ Deploy Checklist

- [ ] Pushed code to GitHub
- [ ] Created account on render.com
- [ ] Deployed via Render (build + start commands correct)
- [ ] App loads at the URL Render gives you
- [ ] Logged in as admin successfully
- [ ] Changed admin password
- [ ] Created 2-3 test user accounts
- [ ] Added a test match
- [ ] Match appears in Predict tab
- [ ] Ready to invite friends!

---

## 🎮 How It Works (Quick Overview)

**Players:**
1. Login with username/password
2. See upcoming matches in "Predict" tab
3. Tap a team to predict (auto-filled with default pick)
4. Check leaderboard, history, results

**Admin (you):**
1. Create accounts for friends
2. Add matches with handicap odds
3. After match, enter score
4. System auto-calculates points
5. Leaderboard updates instantly

---

## 💰 Cost?

**FREE!**

- Render.com: Free tier (750 free compute hours/month)
- Domain: Free subdomain (worldcup-prediction-xxxx.onrender.com)
- Database: Included (SQLite on Render disk)

**Limitations (normal for free tier):**
- Sleeps after 15 min of no traffic
- First request takes 20-30 sec (then fast)
- 1 GB storage (plenty)

**Upgrade anytime** if you outgrow it.

---

## 🤔 Questions?

**Q: Where's my database?**
A: SQLite creates automatically on first run. No setup needed.

**Q: Can I backup my data?**
A: Yes! Copy `worldcup.db` file. See `DATABASE_GUIDE.md`.

**Q: Can I edit the app after deploying?**
A: Yes! Edit code → `git push` → Render auto-redeploys.

**Q: My deploy failed!**
A: Check the Logs in Render dashboard. See `DEPLOYMENT_GUIDE_RENDER.md`.

**Q: How many friends can use it?**
A: Free tier handles 20-100 easily. Scales to 1000+ if you upgrade.

---

## 🚀 Go Live!

**You're 5 minutes away from having your app live.**

1. **Right now:** Follow steps 1-2 above (push to GitHub, deploy on Render)
2. **After deploy:** Login and follow setup (change password, add friends)
3. **Then:** Read `uploads/worldcup/ADMIN_GETTING_STARTED.md` for full admin guide

---

## 📞 Need Help?

1. **Deploy issues?** → See `DEPLOYMENT_GUIDE_RENDER.md`
2. **Admin questions?** → See `uploads/worldcup/ADMIN_GETTING_STARTED.md`
3. **Database questions?** → See `uploads/worldcup/DATABASE_GUIDE.md`
4. **General overview?** → See `README.md`

---

**Let's go! Deploy your app now.** ⚽

👉 **Next step:** Follow the 5-minute deploy above, then ping me if you hit any issues.

🏆 Good luck with your tournament!
