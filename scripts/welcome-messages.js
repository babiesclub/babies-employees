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
const { APP_URL, MSG_TEMPLATE: SHARED_TEMPLATE } = require('./welcome-template');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const auth = admin.auth();

const APPLY = process.argv.includes('--apply');

const MSG_TEMPLATE = SHARED_TEMPLATE;

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
