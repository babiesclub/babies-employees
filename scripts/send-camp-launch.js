// Send "Camps ready" notification to all instructors with camp_sessions.
// Creates one doc in `notifications` collection per instructor — Cloud Function
// fires automatically and pushes via OneSignal to those with subscriptions.
// For instructors without push subs, generates a WhatsApp copy-paste file.
//
// Usage:
//   node send-camp-launch.js          (dry-run)
//   node send-camp-launch.js --send   (actually create notifications + WA file)

const admin=require('firebase-admin');
const fs=require('fs');
const sa=require('./service-account.json');
admin.initializeApp({credential:admin.credential.cert(sa)});
const db=admin.firestore();
const SEND=process.argv.includes('--send');

const TITLE='🏕 הקייטנות שלך מוכנות!';
const BODY='שובצת לקייטנות הקיץ. היכנסי לאפליקציה ולחצי על "הקייטנות שלי" לראות את הלוז המלא. בהצלחה!';

const WA_MSG=`שלום! 🏕
${BODY}

נכנסים לאפליקציה ב:
https://babiesclub.github.io/babies-employees/

בהצלחה לכולנו! 💚`;

(async()=>{
  console.log(SEND?'🚀 SEND mode — יוצרת notifications + קובץ WA':'👁 DRY RUN — לא נשלח שום פוש\n');

  const sessSnap=await db.collection('camp_sessions').get();
  const uidsWithSessions=new Set();
  sessSnap.forEach(d=>{const u=d.data().instructorUid;if(u)uidsWithSessions.add(String(u))});

  const targets=[];
  for(const uid of uidsWithSessions){
    const u=await db.collection('users').doc(uid).get();
    if(!u.exists)continue;
    const d=u.data();
    targets.push({
      uid,
      name:d.name||'?',
      phone:d.phone||'',
      subs:(d.oneSignalSubscriptionIds||[]).length,
    });
  }
  targets.sort((a,b)=>(a.name||'').localeCompare(b.name||'','he'));

  const withPush=targets.filter(t=>t.subs>0);
  const noPush=targets.filter(t=>t.subs===0);

  console.log('📤 פוש דרך OneSignal — '+withPush.length+' מדריכות:');
  withPush.forEach(t=>console.log('  ✓ '+t.name+' ('+t.subs+' מכשירים)'));
  console.log('\n💬 קובץ וואטסאפ — '+noPush.length+' מדריכות:');
  noPush.forEach(t=>console.log('  • '+t.name+(t.phone?' · '+t.phone:' · ⚠ אין טלפון')));

  if(!SEND){
    console.log('\n🚀 הרץ שוב עם --send כדי לבצע');
    process.exit(0);
  }

  // 1) Create notification docs (triggers Cloud Function → OneSignal push for those with subs)
  console.log('\n⏳ יוצרת '+targets.length+' notifications ב-Firestore...');
  let ok=0,fail=0;
  for(const t of targets){
    try{
      await db.collection('notifications').add({
        recipientUid:t.uid,
        title:TITLE,
        body:BODY,
        type:'camps_launch',
        link:'#camps',
        createdAt:new Date().toISOString(),
        createdBy:'admin-script',
        readAt:null,
      });
      ok++;
    }catch(e){
      console.error('  ⚠',t.name,e.message);
      fail++;
    }
  }
  console.log('✓ נוצרו '+ok+' notifications'+(fail?' ('+fail+' נכשלו)':''));
  console.log('   Cloud Function תפעיל פוש OneSignal לאלה עם מכשירים רשומים תוך שניות.');

  // 2) WhatsApp file for those without push
  if(noPush.length){
    const lines=[];
    lines.push('=== וואטסאפ למדריכות ללא פוש (העתק-הדבק) ===');
    lines.push('');
    lines.push('הודעה לשלוח:');
    lines.push('-----');
    lines.push(WA_MSG);
    lines.push('-----');
    lines.push('');
    lines.push('יעדים ('+noPush.length+'):');
    lines.push('');
    noPush.forEach(t=>{
      const clean=t.phone.replace(/\D/g,'').replace(/^0/,'972');
      const wa=clean?'https://wa.me/'+clean:'(אין טלפון)';
      lines.push(t.name+' · '+(t.phone||'אין טלפון')+' · '+wa);
    });
    const outPath=__dirname+'/camp-launch-wa.txt';
    fs.writeFileSync(outPath,lines.join('\n'),'utf8');
    console.log('\n💾 קובץ וואטסאפ נשמר ב:');
    console.log('   '+outPath);
  }

  console.log('\n✅ DONE');
  process.exit(0);
})().catch(e=>{console.error('Fatal:',e);process.exit(1)});
