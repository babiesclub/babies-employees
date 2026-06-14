// List all materials with their current state.
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

(async () => {
  const snap = await db.collection('materials').get();
  const mats = [];
  snap.forEach(d => mats.push({ id: d.id, ...d.data() }));
  mats.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));

  console.log(`\n📦 סה"כ ${mats.length} מערכים\n`);
  console.log('שם'.padEnd(35) + 'animalName'.padEnd(25) + 'category'.padEnd(12) + 'summary');
  console.log('─'.repeat(120));
  mats.forEach(m => {
    const hasSum = m.summary && m.summary.trim() ? '✓' : '✗';
    const sumPreview = m.summary ? m.summary.slice(0, 50) + (m.summary.length > 50 ? '...' : '') : '(ריק)';
    console.log(
      (m.name || '?').padEnd(35) +
      (m.animalName || '').padEnd(25) +
      (m.category || '').padEnd(12) +
      `${hasSum} ${sumPreview}`
    );
  });

  const withSum = mats.filter(m => m.summary && m.summary.trim()).length;
  console.log(`\n📊 ${withSum}/${mats.length} עם תמצית, ${mats.length - withSum} חסרים\n`);

  process.exit(0);
})().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
