const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
(async () => {
  const usersSnap = await db.collection('users').where('role','==','instructor').get();
  let ravit = null;
  usersSnap.forEach(d => { const u = d.data(); if ((u.name||'').includes('רווית')) ravit = {uid:d.id,...u}; });
  if (!ravit) { console.log('לא נמצאה'); process.exit(0); }
  console.log('מדריכה:',ravit.name,'(uid='+ravit.uid+')\n');

  const recsSnap = await db.collection('records').where('instructorUid','==',ravit.uid).get();
  const all = []; recsSnap.forEach(d => all.push({_id:d.id,...d.data()}));

  console.log('=== כל הדיווחים שלה ב-23-25/06 ===');
  const window = all.filter(r => ['2026-06-23','2026-06-24','2026-06-25'].includes(r.date||''));
  window.sort((a,b)=>(a.date||'').localeCompare(b.date||'')||(a.timeIn||'').localeCompare(b.timeIn||''));
  window.forEach(r=>console.log('  '+r.date+' '+(r.timeIn||'??:??')+' · '+r.garden+' · '+(r.duration||'?')+'דק׳ · '+(r.groups||0)+'קב\' · '+(r.animal||'')+'  [id:'+r._id+']'));

  console.log('\n=== חיפוש "מתנ" בכל דיווחיה ===');
  const mat = all.filter(r => (r.garden||'').includes('מתנ'));
  mat.forEach(r=>console.log('  '+r.date+' · '+r.garden+' · '+(r.groups||0)+'קב\' · '+(r.animal||'')));
  console.log('סה"כ:',mat.length);

  console.log('\n=== חיפוש דיווחים לאחרונה (5 ימים אחורה מ-24.6) ===');
  const recent = all.filter(r => ['2026-06-20','2026-06-21','2026-06-22','2026-06-23','2026-06-24','2026-06-25'].includes(r.date||''));
  console.log('סה"כ דיווחים בתקופה הזו:',recent.length);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
