// One-off: upload opening + closing songs to Firebase Storage and save URLs
// to the meta/sharedAudio Firestore doc. The app's renderMyWeeklyMaterial
// reads this doc and prepends/appends the songs around per-material audio.
//
// Usage: node upload-shared-audio.js

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'babiez-app.firebasestorage.app',
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

const SHARED = 'C:\\Users\\David\\שיר דיין\\Shared - Documents\\מערכי שיעור +שירים + מי בא לבקר';
const FILES = [
  { local: path.join(SHARED, 'שיר פתיחה - קיפוד על הזקן מקוצר.mp3.mpeg'), kind: 'opening', displayName: 'שיר פתיחה — קיפוד על הזקן', destExt: 'mp3' },
  { local: path.join(SHARED, 'שלום ולהתראות.mp3.mpeg'),                    kind: 'closing', displayName: 'שלום ולהתראות',                  destExt: 'mp3' },
];

(async () => {
  if (!FILES.every(f => fs.existsSync(f.local))) {
    console.error('✗ קובץ חסר:');
    FILES.forEach(f => { if (!fs.existsSync(f.local)) console.error('  -', f.local); });
    process.exit(1);
  }

  const result = {};
  for (const f of FILES) {
    const dest = `materials/_shared/${f.kind}.${f.destExt}`;
    console.log(`📤 מעלה ${path.basename(f.local)} → ${dest}`);
    const [uploaded] = await bucket.upload(f.local, {
      destination: dest,
      metadata: { contentType: 'audio/mpeg', cacheControl: 'public, max-age=2592000' },
    });
    await uploaded.makePublic();
    const url = `https://storage.googleapis.com/${bucket.name}/${dest}`;
    console.log(`   ✓ ${url}`);
    result[f.kind] = { name: f.displayName, url, updatedAt: Date.now() };
  }

  await db.collection('meta').doc('sharedAudio').set(result, { merge: true });
  console.log('\n✓ meta/sharedAudio עודכן ב-Firestore');
  console.log('\n📋 סיכום:');
  Object.entries(result).forEach(([k, v]) => console.log(`  ${k === 'opening' ? '🎵 פתיחה' : '🎵 סיום'}: ${v.name}`));
  process.exit(0);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
