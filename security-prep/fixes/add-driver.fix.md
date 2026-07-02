# DRAFT: Stop persisting the plaintext password in `scripts/add-driver.js`

**Status:** DRAFT for review. NOT applied to `scripts/add-driver.js`.

## Problem
Same bug as `add-instructor.js`. `scripts/add-driver.js` generates a password, creates the Firebase Auth user,
**and then writes the plaintext `password` into the Firestore `users/{uid}` document** (line 55, inside the
`userDoc` object). The password is already printed to the console and appended to the welcome message, so storing
it in Firestore adds risk with no benefit.

## The fix
Remove the `password` field from the `userDoc` object literal. In this file the fields are on one line, so the
edit is removing `password,` from that line. **Keep everything else.**

### BEFORE (scripts/add-driver.js, lines 54–58)
```js
  const userDoc = {
    id: Date.now(), uid, name: NAME, username: USERNAME, email, password,
    role: 'driver', region: REGION, phone: PHONE,
    createdAt: new Date().toISOString(),
  };
```

### AFTER (remove `password,` from line 55)
```js
  const userDoc = {
    id: Date.now(), uid, name: NAME, username: USERNAME, email,
    role: 'driver', region: REGION, phone: PHONE,
    createdAt: new Date().toISOString(),
  };
```

**Precise change:** on line 55, change `..., email, password,` to `..., email,` (delete the `password,` token
and the space before it). That is the ONLY change to this file.

## Not changed (intentionally kept)
- `const password = generatePassword();` — still generated.
- `console.log(\`סיסמא:     ${password}\`)` and the welcome-message block appended to `welcome-messages.txt` —
  still printed so the admin can send the password to the new driver.
- Auth user creation with `{ email, password, displayName }` — Auth stores only a hash; this is correct.

## Verify after applying
- Create a throwaway test driver, then open its `users/{uid}` doc in the Firestore console and confirm there is
  **no `password` field**.
- Confirm the console still prints the password and the welcome message so onboarding is unaffected.
