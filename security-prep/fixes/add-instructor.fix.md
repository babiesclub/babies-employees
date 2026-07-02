# DRAFT: Stop persisting the plaintext password in `scripts/add-instructor.js`

**Status:** DRAFT for review. NOT applied to `scripts/add-instructor.js`.

## Problem
`scripts/add-instructor.js` generates a password, creates the Firebase Auth user (correct — Auth stores only a
secure hash), **but then also writes the plaintext `password` into the Firestore `users/{uid}` document**
(line 87, inside the `userDoc` object). Firestore is not the right place for a recoverable plaintext password:
it is readable by anything with read access to the users doc and it is included in backups/exports. The password
is already printed to the console and appended to the welcome message, so persisting it in Firestore adds risk
with no benefit.

## The fix
Remove the single `password,` field from the `userDoc` object. **Keep everything else** — still generate the
password, still print it to the console, still append it to the welcome message (`welcome-messages.txt` is
handled separately in `cleanup-sensitive-files.md`).

### BEFORE (scripts/add-instructor.js, lines 81–98)
```js
  const userDoc = {
    id: Date.now(),
    uid,
    name: NAME,
    username: USERNAME,
    email,
    password,
    role: 'instructor',
    gardens: [],
    specialty: SPECIALTY,
    phone: PHONE,
    region: REGION,
    vatStatus: 'patur',
    travelMonthly: 0,
    gardenPayHistory: {},
    unlockedMonths: [curMonth],
    createdAt: new Date().toISOString(),
  };
```

### AFTER (delete the `password,` line — line 87)
```js
  const userDoc = {
    id: Date.now(),
    uid,
    name: NAME,
    username: USERNAME,
    email,
    role: 'instructor',
    gardens: [],
    specialty: SPECIALTY,
    phone: PHONE,
    region: REGION,
    vatStatus: 'patur',
    travelMonthly: 0,
    gardenPayHistory: {},
    unlockedMonths: [curMonth],
    createdAt: new Date().toISOString(),
  };
```

**Precise change:** delete line 87 (`    password,`). That is the ONLY change to this file.

## Not changed (intentionally kept)
- `const password = generatePassword();` — still generated.
- `console.log(\`סיסמא:     ${password}\`)` and the welcome-message block — still printed so the admin can send
  the password to the new instructor.
- Auth user creation with `{ email, password, displayName }` — Auth stores only a hash; this is correct.

## Verify after applying
- Create a throwaway test instructor, then open its `users/{uid}` doc in the Firestore console and confirm there
  is **no `password` field**.
- Confirm the console still prints the password and the welcome message so onboarding is unaffected.
