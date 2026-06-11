# 🚀 Quick Start — Deploy in 5 Minutes

## Option 1: Deploy Online (Free on Render.com)

### Step A: Push to GitHub
```bash
# If you haven't already:
git remote add origin https://github.com/YOUR_USERNAME/worldcup-prediction.git
git push -u origin main
```

### Step B: Deploy on Render
1. Go to https://render.com (sign in with GitHub)
2. Click **New** → **Web Service**
3. Select your `worldcup-prediction` repo
4. Fill in:
   - **Build Command**: `cd uploads/worldcup && pip install -r requirements.txt`
   - **Start Command**: `cd uploads/worldcup && uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Plan**: Free
5. Click **Create Web Service**
6. Wait 2-3 minutes, then click your app's URL

**Done! Login with:**
- Username: `admin`
- Password: `admin1234`

👉 **Full guide**: See `DEPLOYMENT_GUIDE_RENDER.md`

---

## Option 2: Run Locally First (Test Before Deploy)

### A. Install & run
```bash
cd uploads/worldcup
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

### B. Open browser
```
http://localhost:8000
```

### C. Login
- Username: `admin`
- Password: `admin1234`

---

## Demo Mode (No Server Needed)
Just open `static/index.html` in any browser:
- No setup required
- Full app works offline
- Demo data for testing

---

## First Things to Do After Deploy

1. **Change admin password**
   - Login as admin
   - Click avatar (top right) → Change password

2. **Create users for your friends**
   - Go to Admin panel → Create user
   - Give them username & password

3. **Add your first match**
   - Admin panel → New fixture
   - Pick teams, set handicap, time, and stage

4. **Have fun! 🎉**

---

## Any Issues?

- **Can't deploy?** → See `DEPLOYMENT_GUIDE_RENDER.md`
- **Database help?** → See `IMPLEMENTATION_SUMMARY.md`
- **Feature questions?** → See `README.md` in `uploads/worldcup/`
