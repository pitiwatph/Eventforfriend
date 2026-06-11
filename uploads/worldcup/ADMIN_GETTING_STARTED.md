# Admin Getting Started Guide

## First Time Setup (After Deployment)

### 1️⃣ Login as Admin

**Default credentials:**
- **URL**: `https://yourapp.onrender.com` (or `http://localhost:8000`)
- **Username**: `admin`
- **Password**: `admin1234`

⚠️ **First step: Change your admin password!**

---

### 2️⃣ Change Admin Password

1. Click your avatar (top-right, shows "A" or initial)
2. Click **แก้ไข / Edit**
3. Enter new password in "รหัสผ่านใหม่ / New password" field
4. Click **บันทึก / Save**
5. Log back in with new password

---

### 3️⃣ Invite Your Friends (Create Users)

Go to **Admin** tab → **Create user** section

For each friend:
1. **ชื่อเล่น / Display name**: Their nickname (e.g., "James", "เจมส์")
2. **Username**: Login name (no spaces, e.g., `james`, `p_james`)
3. **Password**: Temporary password (they can change later)
4. Click **+ สร้างผู้ใช้ / Create**

**Share with them:**
- Username
- Temporary password
- App URL

They can change their password after logging in.

---

### 4️⃣ Add Your First Matches

Go to **Admin** tab → **Add fixture** section

**Example: Spain vs Germany**

1. **เจ้าบ้าน / Home**: Type `Spain` (autocomplete shows it)
2. **ทีมเยือน / Away**: Type `Germany`
   - ✓ Flags auto-fill from registry
3. **ทีมต่อ / Handicap team**: Choose the stronger team
   - Click button to select (e.g., `Spain`)
4. **ค่าแฮนดิแคป / Line**: Pick from dropdown
   - **0** = Draw allowed
   - **0.25** = Spain must win by 0.25+ goals
   - **0.5** = Spain must win by 0.5+ goals
   - **1.0** = Spain must win by 1+ goals
   - Go up to **5.0** for really lopsided matches
5. **รอบ / Stage**: Pick tournament stage
   - "Group Stage", "Round of 16", "Quarter-finals", etc.
6. **เวลาเตะ / Kickoff**: Pick date & time (Bangkok timezone)
7. Click **+ เพิ่มนัด / Add fixture**

**Your friends see the match in the Predict tab 15 min after this time ✓**

---

### 5️⃣ After the Match: Enter Result

1. Go to **Admin** tab → **นัด · ผล · ปิดรับทาย**
2. Find your match in the list
3. Enter the scores:
   - **First box**: Home team goals
   - **Second box**: Away team goals
   - Example: Spain 2 – 1 Germany
4. Click **บันทึกผล / Save result**

✓ The system automatically:
- Calculates points for every player
- Updates the leaderboard
- Shows results in the Results tab

---

## Daily Admin Tasks

### 📊 Monitor Predictions
- **Predict tab**: See how many players predicted each team
- **Admin SQL console**: Query `SELECT COUNT(*) FROM predictions`

### 🏅 Check Leaderboard
- **Leaderboard tab**: See current standings
- **Admin SQL**: `SELECT * FROM leaderboard`

### 🔒 Lock Late Bets
If a match is about to start:
1. Find it in **Admin** → **นัด · ผล · ปิดรับทาย**
2. Click **🔒 ปิดรับ** (Lock)
3. Players can no longer change their prediction

### 📝 Edit User Names / Passwords
If a player forgets their password or wants name change:
1. Go to **Create user** section → user list at bottom
2. Click **แก้** (Edit) next to their name
3. Change nickname or password
4. Click **บันทึก / Save**

---

## Common Tasks

### Q: Player forgot password
**A**: 
1. Go to Admin → Create user section
2. Find them in the user list
3. Click **แก้** (Edit)
4. Enter a new password
5. Click **บันทึก / Save**
6. Tell them the new password

### Q: How do I prevent late bets on a match starting soon?
**A**:
1. Admin → **นัด · ผล · ปิดรับทาย**
2. Find the match
3. Click **🔒 ปิดรับ** (Lock button turns gold)
4. Now locked. Click again to unlock if needed.

### Q: Can I delete a user?
**A**: Yes, but it also deletes all their predictions.
1. Admin → Create user → User list
2. Click **🗑** (trash icon) next to their name
3. Confirm deletion
4. They're gone.

### Q: Can I delete/edit a match?
**A**: Yes.
1. Admin → **นัด · ผล · ปิดรับทาย**
2. **Edit**: No edit button (recreate it)
3. **Delete**: Click **🗑** at far right
4. **Lock/unlock**: Click 🔒/🔓

### Q: What if I enter the wrong score?
**A**: 
1. Re-enter the correct score in the same match
2. Click **แก้ผล** (Edit result button)
3. Points recalculate automatically

---

## Admin Features (Deep Dive)

### Team Registry Management
**Admin** → **ทะเบียนทีม + ธง / Teams & flags**

- **View**: All 63 teams with their flags
- **Edit**: Click **แก้** to change flag or name
- **Add new**: Enter team name + flag URL, click **บันทึกทีม / Save team**

**Where to get flag images:**
- `https://flagcdn.com/w80/{COUNTRY_CODE}.png`
  - Examples: `es` (Spain), `de` (Germany), `th` (Thailand)
- Or upload your own image, get URL, paste it

### SQL Console (Data Query)
**Admin** → **คอนโซลข้อมูล / Data query (SQL)**

**What you can do:**
- Read any data from the database
- Tap result cells to edit them directly
- Changes save immediately

**Safe queries (examples):**
```sql
SELECT * FROM leaderboard
SELECT * FROM users
SELECT COUNT(*) FROM predictions
SELECT team_home, team_away, score_home, score_away FROM matches WHERE status='finished'
SELECT * FROM matches WHERE stage='Group Stage'
```

**Cannot do (blocked):** INSERT, UPDATE, DELETE, DROP (read-only)

---

## Tips & Best Practices

### 🎯 Scoring Tips
- **Handicap = 0** means "draw is possible"
- **Handicap > 0** means "handicap team MUST win by at least that many"
- **Half-lines (0.25, 0.75)** split the points
  - Spain -0.25 vs Germany: Germany +0.25 win by <0.25 = half-loss (0.5 pts)

### 📅 Match Scheduling
- Add matches several days in advance
- Players can predict after midnight (Bangkok time) on match day
- 30-minute lockout before kickoff (can't change picks)

### 👥 User Management
- Create all users as admin (public registration disabled)
- Users can change their own password after login
- Delete users carefully (removes their data permanently)

### 🗂️ Data Backup
Before doing anything risky:
1. **Admin** → **SQL Console**
2. Run: `SELECT * FROM users` / `matches` / `predictions`
3. Copy-paste to a text file
4. Or: Copy `worldcup.db` file to backup location

---

## Troubleshooting

### "Add fixture" form won't submit
- Make sure you selected a **Handicap team** (one of the two buttons must be highlighted)
- Check that **Kickoff time** is set (required)

### Players see "ปิดรับ / Closed" for new match
- Check the kickoff time — if it's in the past, the match is locked
- Set future time: e.g., today 4 PM (16:00)

### Points didn't calculate after entering result
- Reload the page (hard refresh, Ctrl+F5)
- Check **Leaderboard** to see if points updated

### "Admin only" error on an admin-only page
- You might not be logged in as admin
- Check avatar shows you're logged in
- Try logging out and back in

---

## Support

- **Need to modify the app?** → Contact the developer
- **Database issues?** → See `DATABASE_GUIDE.md`
- **Deployment issues?** → See `DEPLOYMENT_GUIDE_RENDER.md`
- **App features?** → See `IMPLEMENTATION_SUMMARY.md`

---

**Questions? You're all set to run the tournament!** 🏆
