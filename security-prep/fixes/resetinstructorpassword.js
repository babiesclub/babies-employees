/**
 * resetinstructorpassword — DRAFT admin-only callable Cloud Function.
 * =====================================================================
 * STATUS: DRAFT for review. NOT yet wired into functions/index.js.
 *
 * WHAT IT DOES
 *   Admin-only (v2 onCall). Takes { uid } OR { username }, generates a new
 *   safe 8-char password (same alphabet/logic as scripts/add-instructor.js),
 *   calls admin.auth().updateUser(uid, { password }), sets passwordUpdatedAt
 *   on the users/{uid} doc, and RETURNS the new password ONCE so the admin can
 *   resend it. It deliberately does NOT persist the password to Firestore.
 *
 * WHY WE NEED IT
 *   Old passwords leaked (they were stored in Firestore users docs and printed
 *   into git-tracked scripts/welcome-messages.txt on the public repo). After the
 *   leak is cleaned up, every currently-valid leaked password must be ROTATED.
 *   This function is the safe, admin-driven way to do that from the app UI.
 *
 * ---------------------------------------------------------------------
 * HOW TO INTEGRATE (paste into functions/index.js)
 * ---------------------------------------------------------------------
 *   1. Copy the exports.resetinstructorpassword = onCall(...) block below
 *      and paste it into functions/index.js, anywhere AFTER the shared
 *      `requireAdmin(auth)` helper is defined (it is defined around line 2578).
 *      A good spot is right after exports.getinstructorspushstatus.
 *   2. Do NOT copy this header comment or the local `generateSafePassword`
 *      helper if you'd rather reuse an existing one — but functions/index.js
 *      currently has no shared password generator, so pasting the helper as-is
 *      (renamed to avoid collisions) is fine.
 *   3. onCall, HttpsError, admin and logger are already imported at the top of
 *      functions/index.js — no new requires are needed.
 *
 * ---------------------------------------------------------------------
 * HOW TO DEPLOY (from the repo root, after review)
 * ---------------------------------------------------------------------
 *   firebase deploy --only functions:resetinstructorpassword
 *
 *   Verify:
 *     - In the app (admin), call the function for a test instructor and confirm
 *       it returns { ok: true, username, password: "<8 chars>" }.
 *     - Confirm the instructor can log in with the new password.
 *     - Confirm the users/{uid} doc did NOT gain a `password` field and DID gain
 *       `passwordUpdatedAt`.
 *
 * ---------------------------------------------------------------------
 * CLIENT CALL EXAMPLE (app side, for reference only — not part of this file)
 * ---------------------------------------------------------------------
 *   const fn = httpsCallable(functions, 'resetinstructorpassword');
 *   const { data } = await fn({ username: 'avigail' });   // or { uid: '...' }
 *   // data.password is the NEW password — show it once, let admin copy/send it.
 * =====================================================================
 */

// --- Safe password generator (mirrors scripts/add-instructor.js exactly) ---
// Excludes ambiguous chars (no i/l/o, no 0/1). 8 chars, lowercase + digits.
function generateSafePassword() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let pw = "";
  for (let i = 0; i < 8; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

exports.resetinstructorpassword = onCall(
  { region: "us-central1", timeoutSeconds: 60 },
  async (req) => {
    // Admin gate — same helper the newer functions use.
    await requireAdmin(req.auth);

    const db = admin.firestore();
    const data = req.data || {};
    let uid = data.uid ? String(data.uid).trim() : "";
    const username = data.username ? String(data.username).trim() : "";

    if (!uid && !username) {
      throw new HttpsError("invalid-argument", "צריך לספק uid או username");
    }

    // Resolve username -> uid via the users collection (source of truth for username).
    if (!uid) {
      const snap = await db.collection("users").where("username", "==", username).limit(1).get();
      if (snap.empty) {
        throw new HttpsError("not-found", "לא נמצא משתמש עם שם המשתמש: " + username);
      }
      uid = snap.docs[0].id;
    }

    // Confirm the target user exists in Firestore (avoids resetting a stray Auth account).
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "לא נמצא מסמך משתמש עבור uid: " + uid);
    }
    const target = userSnap.data();

    // Generate + apply the new password in Firebase Auth.
    const password = generateSafePassword();
    try {
      await admin.auth().updateUser(uid, { password });
    } catch (e) {
      logger.error("resetinstructorpassword: updateUser failed", { uid, error: e.message });
      throw new HttpsError("internal", "עדכון הסיסמא ב-Auth נכשל: " + (e.message || String(e)));
    }

    // Record WHEN the password was last rotated. Do NOT store the password itself.
    await userRef.set(
      { passwordUpdatedAt: new Date().toISOString() },
      { merge: true }
    );

    logger.info("resetinstructorpassword: password rotated", {
      by: req.auth.uid,
      targetUid: uid,
      username: target.username || username || null,
    });

    // Return the new password ONCE so the admin can resend it to the instructor.
    // This is the only place the plaintext leaves the function — it is never persisted.
    return {
      ok: true,
      uid,
      username: target.username || username || null,
      name: target.name || null,
      password,
    };
  }
);
