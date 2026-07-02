# TEST-RESULTS

**Ruleset under test:** `../firestore.rules.proposed` (hardened version)
**Suite:** `firestore.rules.test.mjs` (mocha + `@firebase/rules-unit-testing` v3 + Firestore emulator)
**Date executed:** 2026-07-01

---

## ✅ Run status: PASSED — 260 passing (17s)

The full suite was executed against the local Firestore emulator and **all 260
assertions passed**. This validates the hardened `firestore.rules.proposed` for
every access-control case in the matrix (owner-keyed collections, the users
privilege-escalation guard, admin-only collections, shared-read/admin-write, and
default-deny for unlisted collections).

> Note: `PERMISSION_DENIED` lines in the emulator log are EXPECTED — they are the
> `assertFails` cases correctly being denied by the rules.

### Environment used
- Node v24
- **JDK 21** (portable Temurin JRE, `%LOCALAPPDATA%\portable-jdk21`) — required
  because firebase-tools 15+ needs Java 21+. JDK 17 is rejected.
- firebase-tools 15.18.0

### One fix applied to the test harness (not the rules)
The first run failed all tests with *"Firestore has already been started and its
settings can no longer be changed."* Cause: the helper called
`context.firestore()` fresh on every assertion. Fixed by caching each context's
Firestore handle once (in the `before()` hook). This was a test-code bug only —
the ruleset was never at fault.

### To re-run (e.g. at the maintenance window, before deploying)
```powershell
$env:PATH = "$env:LOCALAPPDATA\portable-jdk21\jdk-21.0.11+10-jre\bin;$env:PATH"
cd "<repo>\security-prep"
npm install          # first time only
npm run emu          # firebase emulators:exec --only firestore "npm test"
```
Expected: `260 passing`. If anything is RED, do NOT promote `firestore.rules.proposed`
to `firestore.rules` — fix the rule first.
