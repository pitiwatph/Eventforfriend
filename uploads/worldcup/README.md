# 🏆 ทายผลฟุตบอลโลก 2026

## วิธีติดตั้งและรัน

### 1. ติดตั้ง Dependencies
```bash
pip install -r requirements.txt
```

### 2. รัน Server
```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 3. เปิด Browser
```
http://localhost:8000
```

---

## บัญชี Admin เริ่มต้น
- **Username:** `admin`
- **Password:** `admin1234`
- **⚠️ เปลี่ยนรหัสผ่านก่อน Deploy จริง**

---

## ฟีเจอร์

### ผู้เล่นทั่วไป
- สมัครสมาชิก / เข้าสู่ระบบ
- ดูนัดแข่งขันและทายผลได้ก่อน Kickoff 30 นาที
- ดูตารางคะแนนรวมของทุกคน
- ดูประวัติการทายของตัวเอง

### Admin (น้องปอนด์)
- เพิ่ม / ลบนัดแข่งขัน
- กำหนดทีมต่อ (Handicap) และราคา
- กรอกผลการแข่งขัน → ระบบคำนวณคะแนนอัตโนมัติ

---

## ระบบคะแนน
| ผล | คะแนน |
|---|---|
| ชนะตามราคา Handicap | 2 |
| ชนะครึ่งราคา | 1.5 |
| เสมอ | 1 |
| แพ้ครึ่งราคา | 0.5 |
| แพ้ตามราคา | 0 |

---

## Deploy บน Server จริง

### ใช้ Nginx + Uvicorn
```bash
uvicorn main:app --host 127.0.0.1 --port 8000
```

### ใช้ systemd service
```ini
[Service]
WorkingDirectory=/path/to/worldcup
ExecStart=uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
```

### เปลี่ยน SECRET_KEY ใน main.py ก่อน Deploy จริง!
