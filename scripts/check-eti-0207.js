const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
(async () => {
  const snap = await db.collection('camp_sessions')
    .where('date', '==', '2026-07-02')
    .where('instructorName', '==', 'אתי יבנה')
    .get();
  console.log(`📅 2026-07-02 · אתי יבנה: ${snap.size} סשנים`);
  const arr = [];
  snap.forEach(d => arr.push(d.data()));
  arr.sort((a, b) => (a.startTime||'').localeCompare(b.startTime||''));
  arr.forEach((s, i) => {
    console.log(`  ${i+1}. ${s.startTime}-${s.endTime} · ${s.location}`);
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
