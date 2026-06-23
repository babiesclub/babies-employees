// Create a driver user (role='driver') tied to a single region.
// Drivers see ONLY their region's route + weekly delivery plan.
//
// Usage:
//   node add-driver.js --name "Driver Name" --username driver.dar --phone "050-..." --region "דרום"

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const serviceAccount = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const auth = admin.auth();

function arg(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
const NAME = arg('--name');
const USERNAME = arg('--username');
const PHONE = arg('--phone') || null;
const REGION = arg('--region');
const VALID_REGIONS = ['צפון רחוק','צפון','שרון','מרכז','ירושלים','דרום'];

if (!NAME || !USERNAME || !REGION) {
  console.error('Usage: node add-driver.js --name "<Hebrew>" --username <english> --region <region>');
  console.error('Optional: --phone 050-...');
  console.error('Valid regions: ' + VALID_REGIONS.join(' / '));
  process.exit(1);
}
if (!VALID_REGIONS.includes(REGION)) { console.error('✗ אזור לא תקין'); process.exit(1); }

function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let pw = ''; for (let i = 0; i < 8; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}
const email = USERNAME + '@babiez.local';

(async () => {
  const taken = await db.collection('users').where('username', '==', USERNAME).get();
  if (!taken.empty) { console.error(`✗ שם משתמש "${USERNAME}" תפוס`); process.exit(1); }

  const password = generatePassword();
  let uid;
  try {
    const u = await auth.createUser({ email, password, displayName: NAME });
    uid = u.uid;
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      const existing = await auth.getUserByEmail(email);
      uid = existing.uid;
      await auth.updateUser(uid, { password, displayName: NAME });
    } else { console.error('Auth:', e.message); process.exit(1); }
  }

  const userDoc = {
    id: Date.now(), uid, name: NAME, username: USERNAME, email, password,
    role: 'driver', region: REGION, phone: PHONE,
    createdAt: new Date().toISOString(),
  };
  await db.collection('users').doc(uid).set(userDoc);

  const welcome = `שלום ${NAME} 👋
אתה הנהג של אזור ${REGION} בבייביז קלאב.
האפליקציה: https://babiesclub.github.io/babies-employees/
👤 משתמש: ${USERNAME}
🔐 סיסמא: ${password}

באפליקציה תראה את מסלול האזור שלך, מה להעביר מאיפה לאיפה בכל שבוע, וכפתור "ביצעתי השבוע" לסימון השלמה.
`;
  const outPath = path.join(__dirname, 'welcome-messages.txt');
  fs.appendFileSync(outPath, `\n${'='.repeat(50)}\n${NAME} (נהג ${REGION}) (@${USERNAME})\nסיסמא: ${password}\n${'='.repeat(50)}\n${welcome}\n`, 'utf8');

  console.log('\n' + '='.repeat(50));
  console.log('✅ נהג נוצר בהצלחה!');
  console.log('='.repeat(50));
  console.log(`שם:        ${NAME}`);
  console.log(`שם משתמש:  ${USERNAME}`);
  console.log(`סיסמא:     ${password}`);
  console.log(`אזור:      ${REGION}`);
  console.log(`טלפון:     ${PHONE || '(לא הוגדר)'}`);
  console.log(`UID:       ${uid}`);
  console.log('='.repeat(50));
  console.log('\n📝 הודעת ברוכים הבאים (להעתקה ל-WhatsApp):\n');
  console.log(welcome);
  process.exit(0);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
