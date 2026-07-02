const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
(async () => {
  const usersSnap = await db.collection('users').where('role','==','instructor').get();
  const ravit = [];
  usersSnap.forEach(d => { const u = d.data(); if ((u.name||'').includes('רווית')) ravit.push({uid:d.id,...u}); });
  if (!ravit.length) { console.log('לא נמצאה מדריכה בשם רווית'); process.exit(0); }
  console.log('מדריכות שנמצאו:');
  ravit.forEach(r => console.log('  •',r.name,'(uid='+r.uid+')'));

  for (const r of ravit) {
    const recsSnap = await db.collection('records').where('instructorUid','==',r.uid).get();
    const all = []; recsSnap.forEach(d => all.push(d.data()));
    const june = all.filter(rec => (rec.date||'').startsWith('2026-06'));
    june.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    const totalGroups = june.reduce((s,rec)=>s+(parseInt(rec.groups)||0),0);
    console.log('\n=== '+r.name+' — יוני 2026 ===');
    console.log('דיווחים:',june.length,'· סה"כ קבוצות:',totalGroups);
    june.forEach(rec=>console.log('  '+rec.date+' · '+rec.garden+' · '+(rec.groups||0)+' קבוצות · '+(rec.duration||'?')+'דק׳'+(rec.animal?' · '+rec.animal:'')));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
