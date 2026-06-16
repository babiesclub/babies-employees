// Generate per-instructor welcome message with login credentials.
//
// Strategy:
//   - If user doc has `password` field (legacy) → reuse it.
//   - If migrated (uid present, no password) → generate easy password
//     (lowercase + digits, 8 chars), update Firebase Auth password,
//     and write it back to the user doc for record keeping.
//
// Usage:
//   node welcome-messages.js             → preview (no password changes)
//   node welcome-messages.js --apply     → actually reset Auth passwords + write file
//
// Output: scripts/welcome-messages.txt (one block per instructor, separated by ===)

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const serviceAccount = require('./service-account.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const auth = admin.auth();

const APPLY = process.argv.includes('--apply');

const APP_URL = 'https://babiesclub.github.io/babies-employees/';

const MSG_TEMPLATE = (name, username, password) => `שלום ${name} 🌟

ברוכה הבאה לאפליקציה החדשה של בייביז קלאב! מהיום כל הניהול - דיווחי נוכחות, מערך שבועי, חשבוניות וצ'אט איתי - הכל במקום אחד.

📱 קישור לאפליקציה:
${APP_URL}

👤 שם משתמש: ${username}
🔐 סיסמא: ${password}

━━━━━━━━━━━━━━━━━━━━━━━
📲 שלב 1 — להוסיף למסך הבית
━━━━━━━━━━━━━━━━━━━━━━━
לגישה מהירה כמו אפליקציה רגילה:
• Android (Chrome): תפריט 3 נקודות → "הוסף למסך הבית"
• iPhone (Safari): כפתור שיתוף ↗ → "הוסף למסך הבית"

━━━━━━━━━━━━━━━━━━━━━━━
🔔 שלב 2 — להפעיל התראות (חשוב!)
━━━━━━━━━━━━━━━━━━━━━━━
בלי זה לא תקבלי הודעה על מערכים שבועיים חדשים, שיוך גנים, או הודעות ממני.

1. בכניסה הראשונה הדפדפן ישאל אם לאשר התראות → לאשר ✓
2. אם דחית בטעות:
   • Android: הגדרות → אפליקציות → בייביז → התראות → הפעל
   • iPhone: הגדרות → התראות → בייביז → הפעל
3. עוד פעם תפתחי את האפליקציה — אמור לצוץ "קבלי התראות פוש" בראש המסך → להפעיל

━━━━━━━━━━━━━━━━━━━━━━━
⏱ דיווחי נוכחות — חוקים חשובים!
━━━━━━━━━━━━━━━━━━━━━━━

🟢 בכניסה הראשונה שלך:
ניתן לדווח רטרואקטיבית מתחילת החודש הנוכחי. מומלץ למלא את כל הביקורים מהחודש הזה כדי שהמערכת תהיה שלמה.

🟡 בהמשך:
• דיווח חייב להיות בכל ימות השבוע (ראשון-שישי)
• ביום שישי בשעה 16:00 — השבוע שהיה **ננעל לצמיתות**
• לא ניתן לדווח אחורה אחרי הנעילה (אלא אם תבקשו פתיחה זמנית)

🔴 שכחת לדווח?
פתחי איתי צ'אט פנימי באפליקציה ואני אעזור (פרופיל → 💬 שלחי הודעה לאדמין).

━━━━━━━━━━━━━━━━━━━━━━━
⚠ חשוב — בחודש יוני בלבד!
━━━━━━━━━━━━━━━━━━━━━━━
במהלך חודש יוני יש לדווח **גם במערכת החדשה וגם במערכת הישנה** במקביל. זהו חודש המעבר — מיולי נעבוד רק עם המערכת החדשה.

━━━━━━━━━━━━━━━━━━━━━━━
🌿 חסר גן ברשימה שלך?
━━━━━━━━━━━━━━━━━━━━━━━
אם את עובדת בגן שלא מופיע ברשימה שלך:
1. פותחת איתי צ'אט פנימי באפליקציה
2. שולחת את שם הגן + פרטים
3. אטפל תוך 24 שעות
4. ברגע ששייכתי לך גן חדש → תקבלי **פוש מיידי** לאפליקציה 📲

━━━━━━━━━━━━━━━━━━━━━━━
🎯 מה תוכלי לעשות
━━━━━━━━━━━━━━━━━━━━━━━
✓ דיווח על ביקור בגן ישר אחרי השיעור
✓ צפייה במערך השבועי שלך עם PDF + שמע
✓ העלאת חשבוניות מצילום (יש סורק מובנה!)
✓ צ'אט פנימי איתי לכל שאלה/בקשה/הצעת ייעול
✓ קבלת התראות על מערכים חדשים בכל יום שישי

━━━━━━━━━━━━━━━━━━━━━━━

📞 כל שאלה — צ'אט פנימי באפליקציה. אני זמינה.

ברכה והצלחה! 💚🐾
שיר`;

// Generate easy-to-read password: lowercase + digits, 8 chars, no ambiguous chars
function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // excludes i,l,o,0,1
  let pw = '';
  for (let i = 0; i < 8; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

// Firestore doc IDs are Firebase Auth UIDs for migrated users (28 chars alphanumeric)
function looksLikeAuthUid(s) {
  return typeof s === 'string' && s.length >= 20 && /^[A-Za-z0-9]+$/.test(s);
}

(async () => {
  const snap = await db.collection('users').get();
  const all = [];
  snap.forEach(d => all.push({ docId: d.id, ...d.data() }));
  const instructors = all
    .filter(u => u.role === 'instructor')
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));

  console.log(`\n📋 ${instructors.length} מדריכות נמצאו\n`);

  const messages = [];
  let withExistingPw = 0, willGenerate = 0, noAuth = 0;

  for (const u of instructors) {
    // The Firebase Auth UID is either u.uid (legacy) OR the doc id (modern migrated)
    const authUid = u.uid || (looksLikeAuthUid(u.docId) ? u.docId : null);
    const hasPwInDoc = !!u.password;
    let password = u.password;
    let action = '';

    if (hasPwInDoc) {
      withExistingPw++;
      action = '✓ סיסמא ב-doc: ' + u.password;
    } else if (authUid) {
      willGenerate++;
      password = generatePassword();
      action = APPLY ? `🔄 סיסמא חדשה: ${password}` : `🔄 (תיווצר) ${password}`;
    } else {
      noAuth++;
      action = '⚠ אין Auth UID - דורש מיגרציה';
      password = '(אין סיסמא)';
    }

    console.log(`  ${u.name.padEnd(20)} @${(u.username || '?').padEnd(18)} ${action}`);

    if (APPLY && authUid && !hasPwInDoc) {
      try {
        await auth.updateUser(authUid, { password });
        await db.collection('users').doc(u.docId).set({ password }, { merge: true });
      } catch (e) {
        console.error(`    ✗ שגיאה לעדכן סיסמא ל-${u.name}: ${e.message}`);
        password = '(שגיאה בייצור סיסמא: ' + e.message + ')';
      }
    }

    if (password && authUid) {
      messages.push({
        name: u.name,
        username: u.username || '',
        password,
        message: MSG_TEMPLATE(u.name, u.username, password),
      });
    }
  }

  console.log(`\n📊 סיכום:`);
  console.log(`   • ${withExistingPw} עם סיסמא קיימת ב-doc`);
  console.log(`   • ${willGenerate} מדריכות ${APPLY ? 'קיבלו' : 'יקבלו'} סיסמא חדשה`);
  if (noAuth) console.log(`   • ${noAuth} ללא Auth (דורש מיגרציה) ← דורש בדיקה ידנית`);

  if (!APPLY && willGenerate > 0) {
    console.log(`\n💡 זה היה מצב תצוגה. להפעיל בפועל: node welcome-messages.js --apply`);
    console.log(`   (זה יאפס סיסמאות לכל ${willGenerate} המדריכות ללא סיסמא ב-doc)`);
    process.exit(0);
  }

  const out = messages.map(m =>
    `\n${'='.repeat(50)}\n${m.name}  (@${m.username})\nסיסמא: ${m.password}\n${'='.repeat(50)}\n${m.message}\n`
  ).join('\n');
  const outPath = path.join(__dirname, 'welcome-messages.txt');
  fs.writeFileSync(outPath, out, 'utf8');
  console.log(`\n✅ נכתב: ${outPath}`);
  console.log(`   ${messages.length} הודעות מוכנות להפצה.`);
  console.log(`\n💡 פתחי את הקובץ, העתיקי כל בלוק בנפרד ושלחי לכל מדריכה ב-WhatsApp.`);

  process.exit(0);
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
