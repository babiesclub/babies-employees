const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
(async () => {
  const usersSnap = await db.collection('users').where('role','==','instructor').get();
  let ravit = null;
  usersSnap.forEach(d => { const u = d.data(); if ((u.name||'').includes('רווית')) ravit = {uid:d.id,...u}; });
  console.log('=== רווית UID:',ravit.uid,'===\n');

  // 1. כל הדיווחים בכל המערכת ל-24.6 שמכילים "מתנ"
  const all24 = await db.collection('records').where('date','==','2026-06-24').get();
  console.log('1. דיווחים מכל המדריכות ל-2026-06-24:',all24.size);
  let foundMatnas = false;
  all24.forEach(d=>{const r=d.data();if((r.garden||'').includes('מתנ')||(r.notes||'').includes('מתנ')){foundMatnas=true;console.log('  🔍 מצא:',r.instructorName,'·',r.garden,'·',r.notes||'')}});
  if(!foundMatnas)console.log('  ✗ אף אחת לא דיווחה על מתנ"ס ב-24.6\n');

  // 2. כל הדיווחים של רווית בלי סינון תאריך, שמכילים "מתנ" ב-notes או garden
  console.log('\n2. כל הדיווחים של רווית עם "מתנ" באיזשהו שדה:');
  const allHers = await db.collection('records').where('instructorUid','==',ravit.uid).get();
  let mentionMatnas = 0;
  allHers.forEach(d=>{const r=d.data();const text=JSON.stringify(r);if(text.includes('מתנ')){mentionMatnas++;console.log('  '+r.date+' · '+r.garden+(r.notes?' · הערות: '+r.notes:''))}});
  console.log('סה"כ:',mentionMatnas);

  // 3. בדיקת timestamps של הדיווחים שלה ב-24.6 — מתי הוגשו (id=unix ms)
  console.log('\n3. timestamps של הגשות ב-24.6:');
  const her24 = [];
  allHers.forEach(d=>{const r=d.data();if((r.date||'')==='2026-06-24')her24.push({_id:d.id,...r})});
  her24.sort((a,b)=>a._id.localeCompare(b._id));
  her24.forEach(r=>{
    const id=parseInt(r._id);
    const submittedAt=new Date(id).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'});
    console.log('  הוגש: '+submittedAt+' · גן: '+r.garden+' · שעה דיווח: '+(r.timeIn||'??'));
  });

  // 4. הצצה ל-3 הדיווחים האחרונים שלה לראות אם יש "draft" או משהו
  console.log('\n4. 5 הדיווחים האחרונים שלה (לפי id):');
  const sorted=[];allHers.forEach(d=>sorted.push({_id:d.id,...d.data()}));
  sorted.sort((a,b)=>b._id.localeCompare(a._id));
  sorted.slice(0,5).forEach(r=>{
    const submittedAt=new Date(parseInt(r._id)).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'});
    console.log('  הוגש: '+submittedAt+' · '+r.date+' · '+r.garden);
  });

  // 5. בדיקת notifications שלה — אולי הייתה בקשת חידוש דיווח
  console.log('\n5. הודעות אחרונות אליה:');
  const notifs = await db.collection('notifications').where('recipientUid','==',ravit.uid).get();
  const notifArr=[];notifs.forEach(d=>notifArr.push(d.data()));
  notifArr.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  notifArr.slice(0,5).forEach(n=>console.log('  '+n.createdAt+' · '+n.title+' — '+(n.body||'').slice(0,80)));

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
