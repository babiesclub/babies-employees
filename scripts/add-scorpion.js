const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
(async () => {
  const ref = db.collection('meta').doc('animals');
  const d = await ref.get();
  const cur = d.exists ? (d.data().items || []) : [];
  if (cur.includes('עקרב')) { console.log('כבר קיים'); process.exit(0); }
  cur.push('עקרב');
  await ref.set({items: cur}, {merge: true});
  console.log('✓ עקרב נוסף. רשימה כעת:', cur.length, 'פריטים');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
