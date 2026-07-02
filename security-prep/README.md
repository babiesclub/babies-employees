# Firestore Security Rules — Test Suite (PREP ONLY)

This is a **self-contained** unit-test project that verifies the **proposed hardened**
Firestore security rules at [`../firestore.rules.proposed`](../firestore.rules.proposed)
behave correctly, **before** we deploy them to the live `babiez-app` project during a
maintenance window.

It runs **only** against the local Firestore emulator. It does **not** touch production,
does **not** deploy, and does **not** modify any existing file.

> Note: the repo's `firebase.json` points `firestore.rules` at the OLD permissive
> `firestore.rules`. This suite deliberately ignores that and loads the ruleset
> **directly** from `../firestore.rules.proposed` via
> `initializeTestEnvironment({ firestore: { rules: readFileSync('../firestore.rules.proposed') } })`,
> so no config change is required to test the proposed file.

---

## Prerequisites

1. **Node.js 18+** and npm (check: `node --version`, `npm --version`).
2. **Java JDK 11+** — the Firestore emulator is a Java process (check: `java -version`).
   - Windows: install Temurin/Adoptium JDK, or `winget install EclipseAdoptium.Temurin.17.JDK`.
3. **firebase-tools** (the Firebase CLI, provides the emulator). Either:
   - global: `npm install -g firebase-tools`, **or**
   - one-off: use `npx firebase-tools ...` in the commands below.

No Firebase login is needed for the emulator; no production credentials are used.

---

## Install

From this folder (`security-prep/`):

```bash
npm install
```

This installs the dev dependencies locally (nothing global, nothing outside this folder):

- `@firebase/rules-unit-testing` ^3
- `firebase` ^10 (the client SDK the tests drive)
- `mocha` (test runner)

---

## Run

### Option A — one command (recommended)

Let the Firebase CLI start the emulator, run the tests, then shut it down:

```bash
# with a global firebase CLI:
firebase emulators:exec --project babiez-app --only firestore "npm test"

# or without a global install:
npx firebase-tools emulators:exec --project babiez-app --only firestore "npm test"
```

There is also an npm alias for the global-CLI form:

```bash
npm run emu
```

### Option B — emulator already running

In one terminal:

```bash
firebase emulators:start --project babiez-app --only firestore
```

In another terminal (from `security-prep/`):

```bash
npm test
```

The tests connect to the Firestore emulator on the default `localhost:8080`.
If your emulator uses a different host/port, set:

```bash
export FIRESTORE_EMULATOR_HOST=localhost:8080   # bash / git-bash
$env:FIRESTORE_EMULATOR_HOST = "localhost:8080" # PowerShell
```

---

## What the suite asserts

`firestore.rules.test.mjs` implements the full access-control matrix (roles:
**unauthenticated**, **instructor**, **admin**). Highlights:

- **Owner-keyed** (`instructorUid`): `records`, `contracts`, `personalDocs`, `receipts` —
  instructor CRUD only on own docs; admin any; unauth denied.
- **`chatMessages`** — same, keyed on `threadUid`.
- **`users/{uid}`** — read=any signed-in; create/delete=admin only; self-update allowed
  only if `role`/`gardens`/`gardenPayHistory`/`travelMonthly` unchanged (privilege-escalation
  guard). Explicit test that an instructor **cannot** set their own `role` to `admin`.
- **`notifications`** — read/update/delete = recipient or admin; create = any signed-in.
- **Admin-only** collections (15) — read+write admin only.
- **Shared-read / admin-write** collections (9) — any signed-in reads, admin writes.
- **Default deny** — a made-up `someUnlistedCollection` denies read+write for **everyone**,
  including admin.

Admin/instructor role docs (`users/{uid}.role`) are seeded via
`withSecurityRulesDisabled()` so `isAdmin()`/`isSignedIn()` resolve correctly in-test.

---

## Safety notes

- The suite writes only to the **emulator** (in-memory), and calls `clearFirestore()`
  between tests. Nothing hits the real `babiez-app` datastore.
- `--project babiez-app` is only used to name the local emulator instance; the emulator
  never connects to the cloud project.
- Do **not** run `firebase deploy` from here. Deploying the proposed rules is a separate,
  deliberate maintenance-window step performed only after this suite is green.
