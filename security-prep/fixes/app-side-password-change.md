# DRAFT spec: app-side password de-risking (index.html)

**Status:** DESIGN spec for review. No code applied. The exact before/after edits will be
produced at the window by reading the current (dense) lines fresh — this doc defines WHAT
changes, in WHAT order, and the PREREQUISITE that makes it safe.

## Why this is the delicate piece
The plaintext `password` field in Firestore `users` docs is woven into 5 flows in index.html:

| # | Flow | Location (approx) | Fate |
|---|------|-------------------|------|
| 1 | **Legacy client-side login** — matches `username+password` against localStorage users | ~1487 | **remove** (insecure; depends on stored password) |
| 2 | **Bulk import → Auth** — creates Auth users from spreadsheet passwords, also sets `newUser.password` | ~1397 | keep Auth-create, **drop** `.password` persistence |
| 3 | **Legacy→Auth migration / re-auth** — uses stored `u.password` / `cu.password` to sign in | ~2043 | obsolete once coverage confirmed; **remove** reliance on stored pw |
| 4 | **Admin create/edit user** — sets `users[i].password = p` | ~2044, ~2048 | **drop** password persistence; use reset function instead |
| 5 | **Display password** in admin view | ~1902-1907 | **replace** with "reset password" button → `resetinstructorpassword` |

Plus a hardcoded default-cred seed at **~1405**: `{username:'admin', password:'admin123', role:'admin'}`
and `{username:'noa', password:'1234', ...}` — must be neutralized and verified against live Auth.

## The safety PREREQUISITE (do this first)
Login today is: try Firebase Auth → on failure, fall back to legacy password match. If we remove
passwords/legacy while any active user lacks an Auth account, **that user is locked out.**

➡ **Run `audit-auth-coverage.js` first.** It lists every users doc with no Firebase Auth account.
   Provision each (via `resetinstructorpassword` or `add-instructor`) until the audit reports
   "Every users doc maps to a Firebase Auth account." Only then is it safe to remove legacy login.

   ✅ **RAN 2026-07-01 — 41/41 users have a Firebase Auth account (by synthetic username@babiez.local).**
   Legacy login removal is SAFE; NO provisioning needed. 40/41 docs still carry a plaintext `password`
   field (→ purge at window). **`admin@babiez.local` is a LIVE Auth account (uid ZkOeyr8...) — verify it
   is not using the public `admin123` and reset/delete it (do this soon, independent of the window).**

## Ordered change plan (at the maintenance window)
1. **Audit** Auth coverage (`audit-auth-coverage.js`); provision any stragglers. Also confirm/rotate
   or delete any live `admin@babiez.local` (admin123) and `noa` (1234) accounts.
2. **Deploy `resetinstructorpassword`** function (already drafted) so the UI has something to call.
3. **index.html edits** (read exact lines fresh, then):
   - Remove the legacy login branch (#1) — login becomes Firebase-Auth-only.
   - Remove `.password` persistence in bulk import (#2), admin edit (#4), and migration/re-auth (#3).
   - Replace the "show password" UI (#5) with a "reset password" button that calls
     `resetinstructorpassword({uid})` and shows the returned password once.
   - Remove/neutralize the hardcoded default-cred seed (#1405) — or gate it so it can never create
     a usable admin login.
4. **Purge** the Firestore `password` field (`purge-passwords.js --commit`) and rotate leaked passwords.
5. **Deploy the app** (push index.html) and verify: real instructor logs in via Auth; admin can reset
   a password and the instructor logs in with the new one; no "show password" remains; legacy login gone.

## Rollback
index.html is one file in git — `git checkout HEAD -- index.html` + redeploy restores the old app in
under a minute. Do the index.html change LAST in the window, after rules/functions are confirmed stable.
