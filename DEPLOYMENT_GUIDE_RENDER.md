# Deploy to Render.com (Free) — Step by Step

## Overview
This guide walks you through deploying the World Cup Prediction app to **Render.com**, which offers a free tier perfect for getting started.

---

## Prerequisites

1. **GitHub account** (free): https://github.com/signup
2. **Render account** (free): https://render.com
3. Your code committed and pushed to GitHub

---

## Step 1: Push Code to GitHub

### 1a. Create a new repository on GitHub
- Go to https://github.com/new
- Name: `worldcup-prediction` (or your choice)
- Description: "World Cup 2026 Prediction Game"
- Make it **Public** (required for free Render)
- Click **Create repository**

### 1b. Push your code
```bash
cd /home/claude/repo
git remote add origin https://github.com/YOUR_USERNAME/worldcup-prediction.git
git branch -M main
git push -u origin main
```

**Or if you already have a remote:**
```bash
cd /home/claude/repo
git push origin main
```

Verify at: https://github.com/YOUR_USERNAME/worldcup-prediction

---

## Step 2: Deploy on Render.com

### 2a. Sign up & connect GitHub
1. Go to https://render.com
2. Click **Sign up**
3. Sign in with GitHub (recommended)
4. Authorize Render to access your repositories

### 2b. Create a new Web Service
1. Click **Dashboard** (top right)
2. Click **New +** → **Web Service**
3. Under "Connect a repository", select `worldcup-prediction`
4. Click **Connect**

### 2c. Configure the service

**Fill in the form:**

| Field | Value |
|-------|-------|
| **Name** | `worldcup-prediction` |
| **Environment** | `Python 3` |
| **Region** | `Singapore` (closest to Thailand, or pick your region) |
| **Branch** | `main` |
| **Build Command** | `cd uploads/worldcup && pip install -r requirements.txt` |
| **Start Command** | `cd uploads/worldcup && uvicorn main:app --host 0.0.0.0 --port $PORT` |
| **Plan** | `Free` |

**Advanced settings (optional but recommended):**
- Scroll down to **Auto-Deploy**
  - Set to **Yes** — redeploys whenever you push to GitHub

### 2d. Add environment variable
- Scroll to **Environment**
- Click **Add Environment Variable**
  - Key: `PYTHONUNBUFFERED`
  - Value: `1`
  - This makes logs appear in real-time

### 2e. Deploy
- Click **Create Web Service** at the bottom
- Render will now:
  1. Clone your repo
  2. Install dependencies
  3. Start the app
  4. Assign a public URL (look like `https://worldcup-prediction-xxxx.onrender.com`)

**This takes ~2-3 minutes.** Watch the logs in the **Logs** tab.

---

## Step 3: Verify Deployment

Once the deployment finishes (you'll see "✓ Your web service is live"):

1. Click the generated URL (e.g., `https://worldcup-prediction-xxxx.onrender.com`)
2. You should see the login page
3. **Test login:**
   - Username: `admin`
   - Password: `admin1234`

---

## How It Works

- **Database**: SQLite database file (`worldcup.db`) is created automatically on first run
- **Static files**: Served from `uploads/worldcup/static/`
- **Free tier limits**:
  - Spins down after 15 min of inactivity (first request wakes it up, ~30 sec cold start)
  - 750 free compute hours/month (enough for continuous use)
  - 1 GB storage (more than enough for SQLite)

---

## Troubleshooting

### Deployment fails
- Check the **Logs** tab — look for error messages
- Common issues:
  - Wrong **Build Command** or **Start Command** (missing `cd uploads/worldcup`)
  - Typo in `requirements.txt`

### App is slow to load
- Free tier spins down after inactivity. First request takes 20-30 sec. This is normal.
- To keep it warm, you can use a monitoring service like UptimeRobot (free tier).

### Database not persisting
- SQLite persists to disk automatically in `/worldcup.db`
- If you redeploy, the DB data stays (Render keeps the disk)
- **⚠️ WARNING**: If you delete the service, the database is lost. Back it up if critical.

### Can't access certain features
- Check that you're logged in as **admin** to access the admin panel
- Render logs any errors — check the **Logs** tab

---

## Next Steps

### Keep the app running (avoid cold starts)
Use a free uptime monitor like:
- **UptimeRobot** (https://uptimerobot.com) — free tier, pings your app every 5 min
- Set up a monitor to hit `https://yoururl.onrender.com/` every 5-10 minutes

### Backup your database
The database is stored on Render's disk. To back it up:
1. SSH into the web service (Render doesn't expose this easily for free tier)
2. **Easier option**: Export data via the SQL console in the admin panel, then download

### Update the code
Any time you `git push` to `main` and auto-deploy is enabled, Render redeploys automatically.

---

## Custom Domain (Optional)

Render allows custom domains on free tier:
1. Go to your **Web Service** → **Settings**
2. Scroll to **Custom Domain**
3. Add your domain (requires DNS changes — see Render docs)

---

## Support

- **Render Docs**: https://render.com/docs
- **FastAPI Docs**: https://fastapi.tiangolo.com/
- **Issues**: Check Render logs first (`Logs` tab on your service)

---

**Your app is now live! 🎉**

Share the URL with your friends and start playing!
