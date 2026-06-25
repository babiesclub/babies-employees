// Removes duplicate camp_sessions: same instructorUid + date + startTime + location
// keeps the OLDEST (lowest doc id by creation), deletes the rest.
//
// Usage:
//   node dedup-camp-sessions.js           → preview
//   node dedup-camp-sessions.js --apply   → actually delete

const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
const APPLY = process.argv.includes('--apply');

(async () => {
  const snap = await db.collection('camp_sessions').get();
  const all = [];
  snap.forEach(d => all.push({_docId: d.id, ...d.data()}));
  console.log(`📥 קראתי ${all.length} סשנים`);

  const groups = new Map();
  for (const s of all) {
    const k = `${s.instructorUid||'?'}|${s.date||'?'}|${s.startTime||'?'}|${(s.location||'').trim()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  const dups = [];
  for (const [k, arr] of groups) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => (a.createdAt||'').localeCompare(b.createdAt||''));
    const keeper = arr[0];
    const remove = arr.slice(1);
    dups.push({ keeper, remove, key: k });
  }

  console.log(`\n🔍 ${dups.length} קבוצות עם כפילויות (סה"כ ${dups.reduce((s, g) => s + g.remove.length, 0)} סשנים יימחקו)\n`);

  for (const g of dups.slice(0, 30)) {
    const k = g.keeper;
    console.log(`  📅 ${k.date} ${k.startTime} · 👤 ${k.instructorName} · 📍 ${k.location||'(ללא)'} — ${g.remove.length} כפילויות`);
  }
  if (dups.length > 30) console.log(`  ... ועוד ${dups.length - 30} קבוצות`);

  if (!APPLY) {
    console.log(`\n💡 זה היה מצב תצוגה. להפעיל בפועל: node dedup-camp-sessions.js --apply`);
    process.exit(0);
  }

  console.log('\n🗑 מוחק כפילויות...');
  let ok = 0, failed = 0;
  for (const g of dups) {
    for (const r of g.remove) {
      try { await db.collection('camp_sessions').doc(r._docId).delete(); ok++; }
      catch (e) { failed++; console.error('  ✗', r._docId, e.message); }
    }
  }
  console.log(`\n✅ ${ok} כפילויות נמחקו${failed ? `, ${failed} נכשלו` : ''}`);
  process.exit(0);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
