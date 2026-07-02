// PREVIEW only — does NOT send anything.
const admin=require('firebase-admin');
const sa=require('./service-account.json');
admin.initializeApp({credential:admin.credential.cert(sa)});
const db=admin.firestore();

(async()=>{
  const sessSnap=await db.collection('camp_sessions').get();
  const uidsWithSessions=new Set();
  sessSnap.forEach(d=>{const u=d.data().instructorUid;if(u)uidsWithSessions.add(String(u))});

  console.log('=== מדריכות עם שיבוצי קייטנות ===\n');
  console.log('סה"כ הפעלות במערכת:',sessSnap.size);
  console.log('מדריכות ייחודיות עם שיבוץ:',uidsWithSessions.size,'\n');

  const users=[];
  for(const uid of uidsWithSessions){
    const u=await db.collection('users').doc(uid).get();
    if(!u.exists){console.log('  ⚠ uid לא נמצא:',uid);continue}
    const d=u.data();
    const subs=(d.oneSignalSubscriptionIds||[]).length;
    const sessCount=sessSnap.docs.filter(s=>String(s.data().instructorUid)===uid).length;
    users.push({uid,name:d.name||'(ללא שם)',sessCount,campsEnabled:!!d.campsEnabled,pushSubs:subs});
  }
  users.sort((a,b)=>b.sessCount-a.sessCount);
  console.log('פירוט פר מדריכה (ממוין לפי כמות שיבוצים):\n');
  users.forEach((u,i)=>{
    const enabled=u.campsEnabled?'✓ ':'⚠ לא ';
    const push=u.pushSubs>0?'🔔 '+u.pushSubs+' מכשירים':'❌ אין פוש';
    console.log((i+1)+'. '+u.name+' — '+u.sessCount+' הפעלות · '+enabled+'campsEnabled · '+push);
  });

  const needEnable=users.filter(u=>!u.campsEnabled).length;
  const noPush=users.filter(u=>u.pushSubs===0).length;
  console.log('\n=== סיכום פעולות ===');
  console.log('• מדריכות שצריך להפעיל להן campsEnabled:',needEnable);
  console.log('• מדריכות בלי פוש (לא יקבלו התראה):',noPush);
  console.log('• מדריכות שיקבלו פוש:',users.length-noPush);

  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
