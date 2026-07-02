# Security maintenance-window RUNBOOK (DRAFT)

**Status:** DRAFT for review. This is the ordered checklist to apply all the fixes in
`security-prep/fixes/`. Nothing here has been executed. Do the whole thing in a single planned window.

Assumes: you run all commands from the **repo root**
`C:\Users\David\Documents\בייביז קלאב\babies-employees` in **PowerShell**, unless a step says "from scripts/".
`firebase-tools` is installed and you are logged in (`firebase login`) to project **babiez-app**.

---

## PRE-FLIGHT — confirm BEFORE you start (blockers)
- [ ] **Meta App Secret in hand.** Needed for Step 2. Get it from Meta App dashboard → Settings → Basic →
      App Secret. Without it, Step 2 will 403 all inbound WhatsApp. (See `webhook-signature.md`.)
- [ ] **Emulator rules tests are GREEN.** The other agent owns `security-prep/` (rules tests). Do not start
      until they confirm `firestore.rules.proposed` passes. (See `security-prep/TEST-RESULTS.md`.)
- [ ] **List of usernames to rotate confirmed.** Cross-check `scripts/credentials-current.txt` /
      `scripts/welcome-messages.txt` (~33 instructors + drivers). YOU must confirm the exact list.
- [ ] **Backup taken.** Run the app's export/backup (exportbackupjson) or trigger the daily backup so you have a
      restore point before touching rules/functions/Firestore.
- [ ] **Working tree is clean** (`git status`) so each step is an isolated, revertable commit.

> The DRAFTs in `security-prep/fixes/` are NOT applied to live code. Part of this runbook is copying each draft
> into place (functions/index.js, scripts, firestore.rules) after review. Do that per-step below.

---

## STEP 1 — Deploy Firestore rules
Rules are the outermost guardrail; deploy them first so tightened access is in place before anything else.

1. Copy the reviewed proposed rules over the live rules:
   ```powershell
   Copy-Item firestore.rules.proposed firestore.rules -Force
   ```
2. Deploy:
   ```powershell
   firebase deploy --only firestore:rules
   ```
**Verify:** In the Firebase console → Firestore → Rules, confirm the new ruleset is live (timestamp = now).
Smoke-test the app as a normal instructor: they can still read/write their own reports; they CANNOT read other
users' docs.
**Rollback:** `git checkout -- firestore.rules; firebase deploy --only firestore:rules`
(re-deploys the previous committed rules).

---

## STEP 2 — Set secret + deploy the webhook signature fix
Do the secret FIRST, then deploy. If you deploy before setting the secret, inbound WhatsApp will 403.

1. Set the Meta App Secret:
   ```powershell
   firebase functions:secrets:set WHATSAPP_APP_SECRET
   ```
2. Apply the code change from `webhook-signature.md` to `functions/index.js` (add the `crypto` require, the
   `whatsappAppSecret` param, add it to `receivewhatsapp`'s `secrets:[...]`, and the POST signature check).
3. Deploy just this function:
   ```powershell
   firebase deploy --only functions:receivewhatsapp
   ```
**Verify:** Send a real WhatsApp to the business number → it still appears in the app. A manual POST to the
function URL with no valid signature → returns 403 (see `webhook-signature.md`).
**Rollback:** `git checkout -- functions/index.js; firebase deploy --only functions:receivewhatsapp`
(redeploys the pre-change function). Leaving `WHATSAPP_APP_SECRET` set is harmless.

---

## STEP 3 — Deploy the new password-reset function
Needed before rotation (Step 6) because it is the tool that rotates passwords.

1. Paste `resetinstructorpassword.js` into `functions/index.js` (after the `requireAdmin` helper — see the file's
   header for exact placement).
2. Deploy just this function:
   ```powershell
   firebase deploy --only functions:resetinstructorpassword
   ```
**Verify:** As admin, call it for one test instructor → it returns `{ ok: true, password: "<8 chars>" }`, the
instructor can log in with the new password, and the users doc gained `passwordUpdatedAt` and did NOT gain a
`password` field.
**Rollback:** `git checkout -- functions/index.js; firebase deploy --only functions:resetinstructorpassword`
(or `firebase functions:delete resetinstructorpassword` to remove it entirely).

---

## STEP 4 — Fix the onboarding scripts (stop writing new plaintext)
So no NEWLY created user re-introduces a `password` field after we purge.

1. Apply `add-instructor.fix.md` (delete the `password,` line in `scripts/add-instructor.js`).
2. Apply `add-driver.fix.md` (remove `password,` from the `userDoc` line in `scripts/add-driver.js`).
3. Commit:
   ```powershell
   git add scripts/add-instructor.js scripts/add-driver.js
   git commit -m "security: stop persisting plaintext password in Firestore user docs"
   git push
   ```
**Verify:** Create a throwaway test user with each script → its `users/{uid}` doc has NO `password` field, and
the console still prints the password + welcome message. Delete the test user afterward.
**Rollback:** `git revert HEAD` (or `git checkout <prev-sha> -- scripts/add-instructor.js scripts/add-driver.js`).
No deploy needed — these are local scripts, not deployed functions.

---

## STEP 5 — Purge the leaked `password` field from existing Firestore docs
1. Copy the purge script into the scripts/ folder (it needs `./service-account.json`):
   ```powershell
   Copy-Item security-prep\fixes\purge-passwords.js scripts\purge-passwords.js
   ```
2. DRY-RUN first (from the scripts/ folder), read the count/list:
   ```powershell
   cd scripts
   node purge-passwords.js
   ```
3. If the list looks right, COMMIT the deletion:
   ```powershell
   node purge-passwords.js --commit
   cd ..
   ```
**Verify:** Re-run `node purge-passwords.js` (dry-run) → "Docs with a password field: 0". Spot-check a few
`users/{uid}` docs in the console → no `password` field, all other data intact.
**Rollback:** If something looks wrong, restore `users` from the Step-0 backup. (There is no per-field undo;
this is why the DRY-RUN and the pre-flight backup exist.) Removing the field does NOT log anyone out.

---

## STEP 6 — Rotate every leaked password (MANDATORY)
The passwords are public in git history — deleting the Firestore field does not invalidate them. Rotate them.

1. For each username on your confirmed list, call `resetinstructorpassword` (from the app UI, or a small admin
   loop) with `{ username }`.
2. Collect the returned new passwords and resend each to the right person (WhatsApp).
**Verify:** A rotated user logs in with the NEW password; the OLD (leaked) password no longer works.
**Rollback:** None needed — rotation is strictly protective. If you rotate the wrong person, just rotate them
again and resend.

---

## STEP 7 — Remove the leaked files from the repo
Follow `cleanup-sensitive-files.md`:
```powershell
git rm --cached scripts/welcome-messages.txt
# then append welcome-messages.txt and credentials-current.txt to scripts/.gitignore
git add scripts/.gitignore
git commit -m "security: stop tracking welcome-messages.txt; ignore credential files"
git push
```
**Verify:** `git ls-files scripts/welcome-messages.txt` returns nothing; the local file still exists on disk.
**Rollback:** `git revert HEAD` re-tracks the file (but you would not want to — it is the leak). Prefer to leave
it removed.

**Optional (after rotation):** purge git history with `git filter-repo` or BFG and force-push — see
`cleanup-sensitive-files.md` for the two options and their tradeoffs. This breaks existing clones; coordinate.

---

## POST-WINDOW checklist
- [ ] All 7 steps verified green.
- [ ] `security-prep/fixes/purge-passwords.js` copy REMOVED from `scripts/` (it was a one-time tool):
      `Remove-Item scripts\purge-passwords.js`
- [ ] Every leaked password rotated and resent.
- [ ] Firebase console: no function errors in logs for `receivewhatsapp` / `resetinstructorpassword`.
- [ ] (If done) git history purge force-pushed and existing clones re-cloned.
- [ ] Note the window date + which passwords were rotated for the record.
```
