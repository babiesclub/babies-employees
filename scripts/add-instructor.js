// Create a new instructor: Firebase Auth account + Firestore user doc.
// Generates an 8-char easy-to-read password (lowercase + digits, no ambiguous chars).
// Pre-unlocks current month so the new instructor can immediately fill retro reports.
//
// Usage:
//   node add-instructor.js --name "אלכסנדרה" --username alexandra
//   node add-instructor.js --name "..." --username "..." --specialty animals
//   node add-instructor.js --name "..." --username "..." --phone 050-1234567

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const serviceAccount = require('./service-account.json');
const { MSG_TEMPLATE } = require('./welcome-template');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const auth = admin.auth();

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const NAME = arg('--name');
const USERNAME = arg('--username');
const SPECIALTY = arg('--specialty') || 'animals';
const PHONE = arg('--phone') || null;
const REGION = arg('--region') || null;
const VALID_REGIONS = ['צפון רחוק','צפון','שרון','מרכז','ירושלים','דרום'];

if (!NAME || !USERNAME) {
  console.error('Usage: node add-instructor.js --name "<Hebrew name>" --username <english_username>');
  console.error('Optional: --specialty animals|develop|dog|training  --phone 050-...  --region <צפון רחוק|צפון|שרון|מרכז|ירושלים|דרום>');
  process.exit(1);
}
if (REGION && !VALID_REGIONS.includes(REGION)) {
  console.error(`✗ אזור לא תקין: "${REGION}". תקין: ${VALID_REGIONS.join(' / ')}`);
  process.exit(1);
}

function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 8; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

const usernameToEmail = (u) => u + '@babiez.local';

(async () => {
  // Username uniqueness check
  const taken = await db.collection('users').where('username', '==', USERNAME).get();
  if (!taken.empty) {
    console.error(`✗ שם משתמש "${USERNAME}" כבר תפוס. בחר אחר.`);
    process.exit(1);
  }

  const password = generatePassword();
  const email = usernameToEmail(USERNAME);

  let uid;
  try {
    const u = await auth.createUser({ email, password, displayName: NAME });
    uid = u.uid;
    console.log(`✓ Auth user created: ${uid}`);
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      const existing = await auth.getUserByEmail(email);
      uid = existing.uid;
      await auth.updateUser(uid, { password, displayName: NAME });
      console.log(`✓ Auth user exists (${uid}), password reset`);
    } else {
      console.error('✗ Auth error:', e.message);
      process.exit(1);
    }
  }

  const nowIsrael = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const curMonth = `${nowIsrael.getFullYear()}-${String(nowIsrael.getMonth() + 1).padStart(2, '0')}`;

  const userDoc = {
    id: Date.now(),
    uid,
    name: NAME,
    username: USERNAME,
    email,
    password,
    role: 'instructor',
    gardens: [],
    specialty: SPECIALTY,
    phone: PHONE,
    region: REGION,
    vatStatus: 'patur',
    travelMonthly: 0,
    gardenPayHistory: {},
    unlockedMonths: [curMonth],
    createdAt: new Date().toISOString(),
  };

  await db.collection('users').doc(uid).set(userDoc);
  console.log(`✓ Firestore doc created`);

  // Build the welcome message and append to welcome-messages.txt
  const welcome = MSG_TEMPLATE(NAME, USERNAME, password);
  const block = `\n${'='.repeat(50)}\n${NAME}  (@${USERNAME})\nסיסמא: ${password}\n${'='.repeat(50)}\n${welcome}\n`;
  const outPath = path.join(__dirname, 'welcome-messages.txt');
  fs.appendFileSync(outPath, block, 'utf8');
  console.log(`✓ הודעת ברוכה הבאה צורפה ל-${path.basename(outPath)}`);

  console.log('\n' + '='.repeat(50));
  console.log('✅ מדריכה נוצרה בהצלחה!');
  console.log('='.repeat(50));
  console.log(`שם:        ${NAME}`);
  console.log(`שם משתמש:  ${USERNAME}`);
  console.log(`סיסמא:     ${password}`);
  console.log(`התמחות:    ${SPECIALTY}`);
  console.log(`אזור:      ${REGION || '(לא הוגדר)'}`);
  console.log(`UID:       ${uid}`);
  console.log(`חודש פתוח: ${curMonth} (לדיווח רטרו)`);
  console.log('='.repeat(50));
  console.log('\n📝 הודעת ברוכה הבאה (להעתקה ל-WhatsApp):\n');
  console.log(welcome);
  console.log('\n' + '='.repeat(50));
  console.log('💡 הצעדים הבאים:');
  console.log('   1. שייכי לה גנים דרך אדמין → מדריכים → עריכה');
  console.log('   2. ההודעה למעלה — או מהקובץ welcome-messages.txt');
  console.log('');
  process.exit(0);
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
