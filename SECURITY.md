# 🔐 בייביז קלאב — מדריך הגנה והתאוששות מאסון

המסמך הזה הוא **בטיחות נפש**. אם תהיה בעיה — תעקבי לפי הצ'קליסטים כאן.

---

## 🛡 שכבות ההגנה הקיימות

| שכבה | מה היא עושה | תדירות | היכן הקבצים? |
|------|-------------|---------|--------------|
| 1️⃣ גיבוי יומי | `backupfirestoredaily` Cloud Function | כל לילה 02:00 | `gs://babiez-app.firebasestorage.app/backups/firestore/YYYY-MM-DD/` |
| 2️⃣ גיבוי שבועי במייל | `weeklybackupemail` Cloud Function | כל יום ו' 14:00 | האימייל שלך + `gs://.../backups/weekly/` |
| 3️⃣ הורדה ידנית | כפתור באדמין → `exportbackupjson` | בלחיצה | הורדה מיידית למחשב |
| 4️⃣ Git | קוד, rules, functions | כל commit | GitHub `babiesclub/babies-employees` |

---

## ✅ צ'קליסט הגנה חד-פעמית — **תעשי אחת ולתמיד**

### 🔵 חשבון Google (שבו יושב Firebase)

- [ ] **הפעלת 2FA**
  - לכי ל-https://myaccount.google.com/security
  - "אימות דו-שלבי" → הפעלי
  - מומלץ: Google Authenticator app (לא SMS)
- [ ] **הורדת Recovery Codes**
  - באותו מסך → "Backup codes"
  - **תדפיסי ותשמרי במקום פיזי בטוח** (לא רק במחשב!)
- [ ] **App Password לגיבוי במייל**
  - באותו מסך → "App passwords"
  - שם: "Babiez Backup"
  - העתיקי את הסיסמא שמקבלת (16 תווים)

### 🟣 חשבון GitHub (`babiesclub`)

- [ ] **הפעלת 2FA**
  - לכי ל-https://github.com/settings/security
  - "Two-factor authentication" → Enable
- [ ] **שמרי Recovery Codes** באותו מקום פיזי כמו של Google
- [ ] **שקלי לעשות "fork" אישי של הריפו** לחשבון GitHub נוסף שלך (גיבוי קוד)

### 🟢 service-account.json (המפתח לאדמין SDK)

הקובץ יושב ב-`scripts/service-account.json` ו-**אסור לעלות ל-Git** (יש .gitignore).

- [ ] **העתק אחד**: שמרי במנהל סיסמאות (1Password / Bitwarden) כ-Secure Note
- [ ] **עותק שני**: מודפס + ב-USB Drive נעול בכספת
- [ ] **אל תשלחי בווטסאפ או אימייל בשום מקרה**

### 🧰 מנהל סיסמאות (חד פעמי, מקצועי)

ההמלצה החזקה ביותר:
- [ ] **1Password** ($3/חודש) או **Bitwarden** (חינם)
- [ ] שמרי שם את כל הסיסמאות, recovery codes, service-account.json
- [ ] הפעילי 2FA גם על מנהל הסיסמאות עצמו

---

## ✅ צ'קליסט הגדרת גיבוי במייל (חד-פעמי)

יש לכך 2 חלקים:

### חלק 1 — להזין את הסודות ב-Firebase (פעם אחת)

פתחי PowerShell בתיקיית הפרויקט והרצי:

```powershell
firebase functions:secrets:set GMAIL_USER
# כשתישאלי — הזיני: shir@gmail.com (האימייל ששולח)

firebase functions:secrets:set GMAIL_APP_PASSWORD
# כשתישאלי — הזיני את ה-16 תווים של App Password מ-Google

firebase deploy --only functions:weeklybackupemail
```

### חלק 2 — להגדיר מי מקבל את הגיבוי (באפליקציה)

- לכי ל-**אדמין → 🔐 גיבוי → ⚙ הגדרות מייל**
- הכניסי את האימייל שיקבל את הגיבוי
- וודאי ש"גיבוי שבועי במייל פעיל" מסומן
- שמרי

---

## 🚨 תרחישי אסון — מה לעשות

### 🟡 תרחיש 1: מחקתי לקוח / מדריכה בטעות

**אפשרות א'** (אם זה היה היום):
1. לכי ל-`adm → 🔐 גיבוי → 🔄 רענן רשימה`
2. תראי את הגיבוי הלילי האחרון
3. שחזור כל ה-Firestore מ-GCS export (פנה לדוד)

**אפשרות ב'** (אם יש לך JSON שבועי):
1. פתחי את ה-JSON של השבוע שעבר
2. חפשי את האובייקט של מי שנמחק
3. ידנית הוסיפי אותו דרך מסך הניהול

### 🟠 תרחיש 2: Cloud Function עם באג מחק collection שלם

1. **לא לפעול בלחץ.** אל תוסיפי שום נתון חדש לקולקציה הזו עד שמשחזרים
2. הריצי **שחזור מ-GCS export** (מהלילה האחרון)
3. Cloud Shell: `gcloud firestore import gs://babiez-app.firebasestorage.app/backups/firestore/YYYY-MM-DD/`
4. הסבירי לדוד מה קרה כדי לחקור איזה באג גרם

### 🔴 תרחיש 3: לא יכולה להיכנס לחשבון Google

1. **לא לפאניק.**
2. שלפי את ה-recovery codes הפיזיים שהדפסת
3. https://accounts.google.com/signin/recovery
4. הזיני קוד recovery
5. תכנסי, תאפסי סיסמא, תפעילי שוב 2FA

### ⚫ תרחיש 4: החשבון נחסם לחלוטין / Firebase פרויקט נמחק

1. אל תיכנסי לפאניק. **יש לך הגיבוי השבועי במייל.**
2. כל ה-JSON מהשנה האחרונה אצלך באימייל
3. שלחי לדוד את ה-JSON העדכני ביותר
4. הוא בונה פרויקט Firebase חדש, מייבא את ה-JSON, ומעלה את אותו `index.html`
5. תוך 4-8 שעות את חוזרת לעבוד

**מה כן יאבד**: רק הקבצים בינאריים שב-Storage שאין לך עליהם עותק מקומי:
- ✅ 46 המערכים — יש לך אותם **על המחשב במקור**, נעלה שוב
- ⚠ קבלות, חוזים חתומים, מסמכים אישיים — אלה לא חוזרים מ-JSON (רק URLs)

---

## 📋 צ'קליסט שבועי (5 דקות)

- [ ] **יום ראשון**: בודקת שהאימייל של יום שישי הגיע
- [ ] **שמירת הקובץ**: מורידה את ה-attachment לתיקייה ב-OneDrive/Drive/Dropbox שלך
- [ ] **שם הקובץ**: `babiez-backup-YYYY-MM-DD.json`
- [ ] **תיקייה ייעודית**: `📁 Babiez Backups` (תייצרי אותה פעם אחת)

זה הצעד היחיד שדורש משהו ממך אחרי ההגדרה החד-פעמית.

---

## 🔧 פקודות שימושיות

```powershell
# רשימת כל הגיבויים ב-GCS
gcloud storage ls gs://babiez-app.firebasestorage.app/backups/

# הורדת גיבוי native ספציפי
gcloud storage cp -r gs://babiez-app.firebasestorage.app/backups/firestore/2026-06-12/ ./backup-2026-06-12/

# שחזור native לתוך Firestore
gcloud firestore import gs://babiez-app.firebasestorage.app/backups/firestore/2026-06-12/

# בדיקת לוג של הגיבויים האחרונים
firebase functions:log --only backupfirestoredaily,weeklybackupemail,exportbackupjson
```

---

## 📞 בעיות? תשלחי הודעה לדוד.

תצרפי:
1. תיאור התרחיש (מה ניסית, מה ראית)
2. צילום מסך של השגיאה
3. תאריך + שעה מדויקים (כדי לזהות איזה גיבוי לשחזר)
