/**
 * =====================================================================================
 * audit-auth-coverage.js  —  READ-ONLY audit. Writes NOTHING, changes NOTHING.
 *
 * WHY
 *   Before we remove the plaintext `password` field and the legacy client-side login
 *   (index.html ~line 1487, which matches username+password against localStorage),
 *   we must be certain EVERY active user can log in via Firebase Auth. Anyone who
 *   currently relies on the legacy fallback (i.e. has NO Firebase Auth account) would
 *   be locked out the moment we remove passwords. This script finds those people.
 *
 * WHAT IT REPORTS
 *   1. Users WITH a Firebase Auth account (safe).
 *   2. Users WITHOUT one -> they rely on legacy login and MUST be provisioned in Auth
 *      (via resetinstructorpassword / add-instructor) BEFORE the legacy path is removed.
 *   3. How many docs still carry a plaintext `password` field.
 *   4. Whether the hardcoded default admin (admin@babiez.local) is a LIVE Auth account
 *      (the public repo hardcodes username:'admin'/password:'admin123' at index.html ~1405).
 *
 * HOW TO RUN (safe — read-only; run from the scripts/ folder, needs ./service-account.json)
 *   Copy this file into scripts/ and run:  node audit-auth-coverage.js
 * =====================================================================================
 */

const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const auth = admin.auth();

// Mirrors index.html's usernameToEmail().
const usernameToEmail = (u) =>
  `${String(u || '').toLowerCase().trim().replace(/[^a-z0-9._-]/g, '')}@babiez.local`;

(async () => {
  const snap = await db.collection('users').get();
  const noAuth = [];
  const withPwField = [];
  let hasAuth = 0;

  for (const doc of snap.docs) {
    const u = doc.data();
    // Login ALWAYS uses the synthetic username@babiez.local (see index.html fbAuthSignIn),
    // so THAT is the address that must have an Auth account — not doc.email.
    const loginEmail = usernameToEmail(u.username);
    let authUser = null;
    try { authUser = await auth.getUserByEmail(loginEmail); } catch (e) { /* not found */ }
    if (authUser) hasAuth++;
    else noAuth.push({ uid: doc.id, username: u.username || '(none)', name: u.name || '', email: loginEmail, docEmail: u.email || '' });
    if (Object.prototype.hasOwnProperty.call(u, 'password')) {
      withPwField.push({ uid: doc.id, username: u.username || '(none)' });
    }
  }

  console.log('='.repeat(64));
  console.log(`Total users docs:                 ${snap.size}`);
  console.log(`WITH a Firebase Auth account:     ${hasAuth}`);
  console.log(`WITHOUT (rely on legacy login):   ${noAuth.length}`);
  console.log('='.repeat(64));
  if (noAuth.length) {
    console.log('\n⚠ These users have NO Firebase Auth account. Provision them (reset/add) BEFORE');
    console.log('  removing the legacy login, or they will be locked out:');
    noAuth.forEach((x, i) =>
      console.log(`  ${String(i + 1).padStart(3)}. ${x.username}  (${x.name})  login:${x.email}  docEmail:${x.docEmail || '-'}  uid=${x.uid}`));
  } else {
    console.log('\n✓ Every users doc maps to a Firebase Auth account — legacy login can be safely removed.');
  }

  console.log(`\nDocs still carrying a plaintext 'password' field: ${withPwField.length}`);

  // Hardcoded default-admin check.
  try {
    const a = await auth.getUserByEmail('admin@babiez.local');
    console.log(`\n🔴 Auth account admin@babiez.local EXISTS (uid=${a.uid}).`);
    console.log("   Confirm its password is NOT 'admin123' (hardcoded in the public repo) and rotate it now.");
  } catch (e) {
    console.log("\n✓ No Auth account 'admin@babiez.local' — the hardcoded admin123 default is not a live login.");
  }

  process.exit(0);
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
