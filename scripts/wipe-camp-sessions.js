// Wipe ALL camp_sessions from Firestore.
// Camp clients (camp_clients) and instructor settings (campsEnabled / campPayPerGroup /
// campClients / campCity) are NOT touched.
//
// Usage:
//   node wipe-camp-sessions.js              → preview
//   node wipe-camp-sessions.js --apply      → actually delete

const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const APPLY = process.argv.includes('--apply');

(async () => {
  const snap = await db.collection('camp_sessions').get();
  console.log(`📥 נמצאו ${snap.size} סשני קייטנה במסד`);

  if (snap.empty) { console.log('✓ אין מה למחוק'); process.exit(0); }

  const byInst = {};
  snap.forEach(d => {
    const data = d.data();
    const k = data.instructorName || '(לא ידוע)';
    byInst[k] = (byInst[k] || 0) + 1;
  });
  console.log('\n📊 פירוט פר מדריכה:');
  Object.keys(byInst).sort().forEach(k => console.log(`  ${k.padEnd(20)} ${byInst[k]} סשנים`));

  if (!APPLY) {
    console.log(`\n💡 זה היה מצב תצוגה. למחיקה בפועל:\n   node wipe-camp-sessions.js --apply`);
    process.exit(0);
  }

  console.log('\n🗑 מוחק...');
  let ok = 0, failed = 0;
  const batchSize = 100;
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = db.batch();
    docs.slice(i, i + batchSize).forEach(d => batch.delete(d.ref));
    try { await batch.commit(); ok += Math.min(batchSize, docs.length - i); process.stdout.write('.'); }
    catch (e) { failed++; console.error('\n  ✗ batch failed:', e.message); }
  }
  console.log(`\n\n✅ ${ok} סשנים נמחקו${failed ? `, ${failed} שגיאות` : ''}`);
  process.exit(0);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
