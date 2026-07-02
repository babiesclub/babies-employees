// One-off: notify every instructor that the current month is unlocked
// for retroactive reporting. Writes a doc to `notifications` per user —
// that automatically triggers OneSignal push via sendpushonnotification.
//
// Usage:
//   node push-unlock-notice.js               → preview
//   node push-unlock-notice.js --apply       → actually send

const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const APPLY = process.argv.includes('--apply');

const nowIsrael = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
const MONTH = `${nowIsrael.getFullYear()}-${String(nowIsrael.getMonth() + 1).padStart(2, '0')}`;
const HE_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const HE_MONTH = HE_MONTHS[nowIsrael.getMonth()];

const TITLE = `📅 נפתח דיווח רטרואקטיבי ל${HE_MONTH}`;
const BODY = `שלום! חודש ${HE_MONTH} פתוח כעת לדיווח רטרואקטיבי — תוכלי לדווח על ביקורים שטרם דיווחת מתחילת החודש. כנסי לאפליקציה ודווחי בהקדם 💚`;

(async () => {
  const snap = await db.collection('users').where('role', '==', 'instructor').get();
  const docs = [];
  snap.forEach(d => docs.push({ docId: d.id, ...d.data() }));
  docs.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));

  console.log(`\n🔔 ${docs.length} מדריכות יקבלו פוש על פתיחת חודש ${MONTH}\n`);

  if (!APPLY) {
    docs.forEach(u => console.log(`  · ${u.name || u.username || u.docId}`));
    console.log(`\n💡 להפעיל בפועל: node push-unlock-notice.js --apply\n`);
    process.exit(0);
  }

  let ok = 0, failed = 0;
  for (const u of docs) {
    const id = Date.now() + Math.floor(Math.random() * 10000);
    const notif = {
      id,
      recipientUid: u.docId,
      type: 'retro_unlock_grant',
      icon: '📅',
      title: TITLE,
      body: BODY,
      link: { screen: 'att' },
      createdAt: new Date().toISOString(),
      createdBy: 'system',
      createdByName: 'בייביז קלאב',
      read: false,
      readAt: null,
    };
    try {
      await db.collection('notifications').doc(String(id)).set(notif);
      ok++;
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 80));
    } catch (e) {
      failed++;
      console.error(`\n  ✗ ${u.name}: ${e.message}`);
    }
  }
  console.log(`\n\n✅ ${ok} פוש נשלחו, ${failed} נכשלו.`);
  process.exit(0);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
