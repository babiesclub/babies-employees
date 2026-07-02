# sendafterschoolreportemail — שליחת דוח אפטר סקול במייל עם צרופה

פונקציית ענן (`onCall`) ששולחת קובץ Excel של דוח אפטר סקול כצרופה אמיתית במייל,
במקום זרימת `mailto:` שדרשה מהמשתמשת לצרף את הקובץ ידנית.

מיקום: `functions/index.js` (בסוף הקובץ).
Region: `us-central1`. Auth: **admin בלבד** (דרך `requireAdmin`).

---

## פרמטרים (`request.data`)

| שם | טיפוס | חובה | תיאור |
|----|-------|------|-------|
| `recipientEmail` | string | ✅ | כתובת מייל יעד אחת. מאומתת בצד השרת. |
| `subject` | string | ✅ | נושא ההודעה. |
| `body` | string | ➖ | גוף ההודעה בעברית (טקסט רגיל). ריק = מותר. |
| `base64File` | string | ✅ | קובץ ה-Excel מקודד Base64 (ללא prefix של `data:`). |
| `fileName` | string | ✅ | שם הצרופה, למשל `אפטר_סקול_צהרון_2026-07.xlsx`. |
| `reportType` | string | ➖ | `tzaharon` / `talan` / `nivkharot` — ללוג בלבד. ערך לא מוכר נרשם כ-`unknown`. |

הצרופה נשלחת עם contentType של xlsx:
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

## ערך מוחזר

הצלחה:
```json
{
  "success": true,
  "recipient": "network@example.com",
  "reportType": "tzaharon",
  "fileName": "אפטר_סקול_צהרון_2026-07.xlsx",
  "sizeBytes": 20481,
  "message": "הדוח נשלח בהצלחה אל network@example.com"
}
```

כישלון: נזרק `HttpsError` עם הודעה בעברית (למשל `שליחת המייל נכשלה: ...` או
`כתובת אימייל לא תקינה: ...`). כל ריצה (הצלחה/כישלון) נרשמת ל-collection `backupLog`
עם `type: "afterschool-report-email"`.

---

## דוגמת קריאה מצד הלקוח (JS)

```js
import { getFunctions, httpsCallable } from "firebase/functions";

// ממירים Blob של xlsx ל-Base64 נקי (ללא prefix של data:)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function sendAfterSchoolReport(xlsxBlob) {
  const base64File = await blobToBase64(xlsxBlob);

  const functions = getFunctions(undefined, "us-central1");
  const sendReport = httpsCallable(functions, "sendafterschoolreportemail");

  const res = await sendReport({
    recipientEmail: "network@example.com",
    subject: "דוח אפטר סקול — צהרון — יולי 2026",
    body: "שלום,\n\nמצורף דוח הצהרון לחודש יולי 2026.\n\nבברכה,\nבייביז קלאב 🐾",
    base64File,
    fileName: "אפטר_סקול_צהרון_2026-07.xlsx",
    reportType: "tzaharon",
  });

  console.log(res.data.message); // "הדוח נשלח בהצלחה אל network@example.com"
}
```

> אם ה-xlsx נבנה עם SheetJS (`XLSX.write(wb, { type: "base64" })`) אפשר להעביר את
> המחרוזת ישירות כ-`base64File` בלי להמיר דרך Blob.

---

## הגדרת הסוד `GMAIL_APP_PASSWORD` ב-Firebase

הפונקציה משתמשת בשני סודות שכבר מוגדרים בפרויקט: `GMAIL_USER` ו-`GMAIL_APP_PASSWORD`
(אותם סודות של פונקציות הגיבוי/רו"ח הקיימות). אם הם כבר קיימים — **אין צורך לעשות כלום**.

להגדרה/עדכון של הסיסמה (מריצים בטרמינל מתוך תיקיית הפרויקט):

```bash
# הסיסמה של Gmail App Password (16 תווים, בלי רווחים)
firebase functions:secrets:set GMAIL_APP_PASSWORD

# כתובת ה-Gmail השולחת (אם עוד לא הוגדרה)
firebase functions:secrets:set GMAIL_USER
```

ה-CLI יבקש להדביק את הערך (הקלט מוסתר). אחרי הגדרה, צריך **deploy** כדי שהפונקציה
תקבל את הגרסה החדשה של הסוד:

```bash
firebase deploy --only functions:sendafterschoolreportemail
```

לבדיקה אילו סודות קיימים:
```bash
firebase functions:secrets:access GMAIL_USER
```

---

## אילו הרשאות צריך ל-Gmail App Password (מינימום = בטוח יותר)

**App Password** (סיסמת אפליקציה) הוא מנגנון של Google שנותן סיסמה ייעודית של 16 תווים
לגישת SMTP בלבד — הוא **לא** נותן גישה לתוכן התיבה, ל-Contacts או ל-Drive. זה בדיוק
המינימום הנדרש: שליחת מייל יוצא דרך `smtp.gmail.com:465`.

הצעדים ליצירה:
1. חשבון ה-Gmail השולח חייב **אימות דו-שלבי (2FA) מופעל** — App Password לא זמין בלעדיו.
2. נכנסים ל-<https://myaccount.google.com/apppasswords>.
3. יוצרים App Password חדש (שם חופשי, למשל "Babiez Functions") ומעתיקים את 16 התווים.
4. מדביקים אותם ב-`firebase functions:secrets:set GMAIL_APP_PASSWORD` (בלי הרווחים).

עקרונות בטיחות (least privilege):
- **לא** משתמשים בסיסמת החשבון הרגילה — רק App Password ייעודי.
- App Password אחד לכל שירות — אם נדלף, מבטלים רק אותו בלי לגעת בשאר.
- מומלץ להשתמש בכתובת Gmail ייעודית לשליחות מערכת (לא התיבה האישית).
- אם צריך לבטל: אותו עמוד App Passwords → מחיקה. נדרש deploy מחדש עם ערך חדש.

> הערה: Google לא מאפשר לבחור "scope" צר יותר מ-App Password ל-SMTP — עצם השימוש
> ב-App Password (במקום סיסמת החשבון או OAuth מלא) **הוא** האפשרות המצומצמת ביותר.
