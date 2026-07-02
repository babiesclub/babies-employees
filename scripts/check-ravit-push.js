const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();
(async () => {
  const snap = await db.collection('users').where('role','==','instructor').get();
  let r = null; snap.forEach(d=>{const u=d.data();if((u.name||'').includes('רווית'))r={uid:d.id,...u}});
  if (!r) { console.log('לא נמצאה'); process.exit(0); }
  console.log('=== '+r.name+' ===');
  console.log('UID:',r.uid);
  console.log('Username:',r.username);
  console.log('Email:',r.email);
  console.log('Phone:',r.phone);
  console.log('');
  console.log('=== OneSignal sync status ===');
  const ids = r.oneSignalSubscriptionIds || [];
  console.log('Subscription IDs count:',ids.length);
  ids.forEach((id,i)=>console.log('  ['+i+']',id));
  if (r.oneSignalSubscriptionId) console.log('Legacy single ID:',r.oneSignalSubscriptionId);
  if (r.lastPushSyncedAt) console.log('Last sync time:',r.lastPushSyncedAt);
  if (r.lastSignedInAt) console.log('Last sign-in:',r.lastSignedInAt);

  console.log('\n=== הודעות שנשלחו אליה (10 אחרונות) ===');
  const notifs = await db.collection('notifications').where('recipientUid','==',r.uid).get();
  const arr=[]; notifs.forEach(d=>arr.push({_id:d.id,...d.data()}));
  arr.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  arr.slice(0,10).forEach(n=>{
    console.log(' ',n.createdAt,'·',n.title,'·',n.pushSent?'✓ פוש נשלח':'✗ פוש לא נשלח','·',n.pushFailReason||'');
  });
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
