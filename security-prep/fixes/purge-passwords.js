/**
 * =====================================================================================
 * purge-passwords.js  —  DRAFT one-time maintenance script.
 *
 *   ██  DO NOT RUN until the maintenance window.  ██
 *   ██  Run it from the scripts/ folder (it needs ./service-account.json). ██
 *
 * WHAT IT DOES
 *   Scans every doc in the Firestore `users` collection and removes the leaked
 *   plaintext `password` field using admin.firestore.FieldValue.delete().
 *
 * SAFETY
 *   - DEFAULTS TO DRY-RUN. Without --commit it only COUNTS and LISTS the docs that
 *     still have a `password` field. It writes NOTHING.
 *   - Only with the explicit --commit flag does it actually delete the fields.
 *   - It deletes ONLY the `password` field; all other user data is untouched.
 *
 * PRE-REQUISITES (do these BEFORE running with --commit)
 *   1. Rotate every currently-valid leaked password first (resetinstructorpassword),
 *      or accept that removing the field does NOT invalidate the leaked passwords —
 *      Firebase Auth still accepts them until they are rotated. This script only
 *      removes the copy stored in Firestore.
 *   2. Deploy the fixed add-instructor.js / add-driver.js so NEW users never get a
 *      `password` field again (otherwise this script would have to be re-run).
 *
 * HOW TO RUN (only during the window, from the scripts/ folder)
 *   Dry-run (safe, default):   node purge-passwords.js
 *   Commit (destructive):      node purge-passwords.js --commit
 *
 * NOTE ON LOCATION
 *   This DRAFT lives in security-prep/fixes/. To run it, an operator should COPY it
 *   into the scripts/ folder (where ./service-account.json and node_modules live).
 *   It is intentionally NOT placed in scripts/ so it cannot be run by accident.
 * =====================================================================================
 */

const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json'); // present in scripts/ (gitignored)

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const COMMIT = process.argv.includes('--commit');

(async () => {
  console.log('='.repeat(60));
  console.log(COMMIT
    ? '⚠  COMMIT MODE — will DELETE the password field from users docs'
    : '🔎 DRY-RUN — no writes. Pass --commit to actually delete.');
  console.log('='.repeat(60));

  const snap = await db.collection('users').get();
  const withPassword = [];
  snap.forEach((doc) => {
    const data = doc.data();
    if (Object.prototype.hasOwnProperty.call(data, 'password')) {
      withPassword.push({ uid: doc.id, username: data.username || '(no username)', name: data.name || '' });
    }
  });

  console.log(`Total users docs:            ${snap.size}`);
  console.log(`Docs with a password field:  ${withPassword.length}`);
  withPassword.forEach((u, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. ${u.username}  (${u.name})  uid=${u.uid}`);
  });

  if (!COMMIT) {
    console.log('\nDRY-RUN complete. No changes made. Re-run with --commit to delete.');
    process.exit(0);
  }

  if (withPassword.length === 0) {
    console.log('\nNothing to delete. Done.');
    process.exit(0);
  }

  console.log(`\nDeleting the password field from ${withPassword.length} docs...`);
  // Batched writes (Firestore limit is 500 ops per batch).
  let processed = 0;
  for (let i = 0; i < withPassword.length; i += 400) {
    const chunk = withPassword.slice(i, i + 400);
    const batch = db.batch();
    chunk.forEach((u) => {
      batch.update(db.collection('users').doc(u.uid), {
        password: admin.firestore.FieldValue.delete(),
      });
    });
    await batch.commit();
    processed += chunk.length;
    console.log(`  committed ${processed}/${withPassword.length}`);
  }

  console.log(`\n✅ Done. Removed the password field from ${processed} docs.`);
  process.exit(0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
