// Calls OneSignal API to check status of Ravit's 2 subscription IDs.
// Needs ONESIGNAL_REST_API_KEY env var (or paste below).
//
// Usage: ONESIGNAL_REST_API_KEY=... node check-ravit-onesignal.js
//   or:  node check-ravit-onesignal.js (will read from Firebase Secrets via gcloud)

const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({credential: admin.credential.cert(sa)});
const db = admin.firestore();

const APP_ID = '8e16a61e-f6b1-4fb2-8fe4-b35741271d00';
const SUB_IDS = ['405f8e91-d14f-4506-a225-313cf0b31f57', '46557ac6-1529-4d34-acb4-37be6a4dea95'];

(async () => {
  let key = process.env.ONESIGNAL_REST_API_KEY;
  if (!key) {
    const { execSync } = require('child_process');
    try {
      key = execSync('gcloud secrets versions access latest --secret=ONESIGNAL_REST_API_KEY --project=babiez-app', { encoding: 'utf8' }).trim();
    } catch (e) {
      console.error('Cannot fetch ONESIGNAL_REST_API_KEY. Set env var or run gcloud auth.');
      process.exit(1);
    }
  }
  console.log('API key length:', key.length);

  for (const id of SUB_IDS) {
    console.log('\n=== Subscription ID:', id, '===');
    try {
      const res = await fetch(`https://api.onesignal.com/apps/${APP_ID}/subscriptions/${id}`, {
        headers: { Authorization: `Key ${key}` }
      });
      const data = await res.json();
      console.log('  status:', res.status);
      if (data.subscription) {
        const s = data.subscription;
        console.log('  type:', s.type);
        console.log('  enabled:', s.enabled);
        console.log('  notification_types:', s.notification_types, '(>0 = subscribed, -2 = unsubscribed, 0 = device not registered)');
        console.log('  test_type:', s.test_type);
        console.log('  device_model:', s.device_model);
        console.log('  device_os:', s.device_os);
        console.log('  last_active:', new Date(s.last_active * 1000).toISOString());
        console.log('  created_at:', new Date(s.created_at * 1000).toISOString());
        console.log('  app_version:', s.app_version);
      } else {
        console.log('  RAW:', JSON.stringify(data).slice(0, 300));
      }
    } catch (e) {
      console.error('  fetch failed:', e.message);
    }
  }
  process.exit(0);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
