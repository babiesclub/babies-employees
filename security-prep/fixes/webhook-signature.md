# DRAFT: Add X-Hub-Signature-256 verification to `receivewhatsapp`

**Status:** DRAFT for review. NOT applied to `functions/index.js`.

## Problem
`exports.receivewhatsapp` (an `onRequest` handler, starts around **functions/index.js line 1250**) validates
`hub.verify_token` on the GET verification handshake, but on **POST** it processes the body without verifying
Meta's `X-Hub-Signature-256` HMAC. Anyone who knows the public function URL can POST a forged Meta webhook
payload and it will be written to Firestore and pushed to admins as if it were a real inbound WhatsApp message.

## Fix summary
On **POST only**, compute `HMAC-SHA256(rawBody, WHATSAPP_APP_SECRET)` and compare it (timing-safe) to the
`x-hub-signature-256` request header (after stripping the `sha256=` prefix). Reject with **403** on mismatch,
before any Firestore writes. GET (verification) is unchanged.

> Meta signs the **raw request bytes**. Firebase Functions v2 (`onRequest`) exposes them as `req.rawBody`
> (a Buffer). Use `req.rawBody` directly — do NOT `JSON.stringify(req.body)`, because re-serializing changes
> bytes/whitespace/key order and the HMAC will never match.

---

## Step 1 — Create the new secret (the Meta **App Secret**)

The App Secret is found in the Meta App dashboard: **App settings → Basic → App Secret** (click "Show").
It is NOT the access token and NOT the webhook verify token — it is a separate value.

From the repo root:

```powershell
firebase functions:secrets:set WHATSAPP_APP_SECRET
# Paste the Meta App Secret when prompted (input is hidden).
```

## Step 2 — Declare the secret param (top of functions/index.js, near the other WhatsApp secrets ~line 47)

**Add** this line next to the existing WhatsApp secret declarations:

```js
// Meta App Secret — used to verify the X-Hub-Signature-256 HMAC on inbound webhooks.
const whatsappAppSecret = defineSecret("WHATSAPP_APP_SECRET");
```

## Step 3 — Add the secret to the function's options `secrets:[...]`

### BEFORE (functions/index.js ~line 1250)
```js
exports.receivewhatsapp = onRequest(
  {
    secrets: [whatsappWebhookVerifyToken],
    region: "us-central1",
    timeoutSeconds: 30,
    cors: false,
  },
  async (req, res) => {
    try {
```

### AFTER
```js
exports.receivewhatsapp = onRequest(
  {
    secrets: [whatsappWebhookVerifyToken, whatsappAppSecret],
    region: "us-central1",
    timeoutSeconds: 30,
    cors: false,
  },
  async (req, res) => {
    try {
```

## Step 4 — Add the signature check at the start of the POST branch

The POST branch currently begins like this (functions/index.js ~line 1276):

### BEFORE
```js
      // ============ POST = Incoming event ============
      if (req.method !== "POST") {
        res.status(405).send("Method not allowed");
        return;
      }

      const body = req.body || {};
      logger.info("receivewhatsapp: event received", { object: body.object, hasEntry: !!body.entry });
```

### AFTER
```js
      // ============ POST = Incoming event ============
      if (req.method !== "POST") {
        res.status(405).send("Method not allowed");
        return;
      }

      // ---- Verify Meta's X-Hub-Signature-256 HMAC over the raw body ----
      // Meta signs the raw request bytes with the App Secret. We must compare
      // against req.rawBody (NOT a re-serialized body) using a timing-safe compare.
      {
        const appSecret = String(whatsappAppSecret.value() || "");
        const headerSig = String(req.get("x-hub-signature-256") || "");
        const raw = req.rawBody; // Buffer of the exact bytes Meta sent

        if (!appSecret || !headerSig.startsWith("sha256=") || !raw) {
          logger.warn("receivewhatsapp: missing signature or secret — rejecting", {
            hasSecret: !!appSecret, hasHeader: !!headerSig, hasRawBody: !!raw,
          });
          res.status(403).send("Signature verification failed");
          return;
        }

        const expectedHex = crypto
          .createHmac("sha256", appSecret)
          .update(raw)
          .digest("hex");
        const receivedHex = headerSig.slice("sha256=".length);

        // Timing-safe compare. Both must be equal-length Buffers or timingSafeEqual throws,
        // so guard on length first (a length mismatch is already a failed signature).
        const a = Buffer.from(expectedHex, "hex");
        const b = Buffer.from(receivedHex, "hex");
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          logger.warn("receivewhatsapp: signature mismatch — rejecting POST");
          res.status(403).send("Signature verification failed");
          return;
        }
      }

      const body = req.body || {};
      logger.info("receivewhatsapp: event received", { object: body.object, hasEntry: !!body.entry });
```

## Step 5 — Add the `crypto` require (if not already present)

`functions/index.js` does **not** currently require `crypto` (verified — no `require("crypto")` in the file).
Node's `crypto` is a built-in (no npm install needed). Add near the other requires at the top (~line 18):

```js
const crypto = require("crypto");
```

---

## Deploy & verify

```powershell
firebase deploy --only functions:receivewhatsapp
```

Verify:
- **Real traffic still works:** send yourself a WhatsApp message to the business number and confirm it still
  appears in the app (it should — Meta signs every POST with the App Secret).
- **Forged traffic is blocked:** a manual `POST` to the function URL without a valid `x-hub-signature-256`
  header now returns **403** and writes nothing to Firestore.
- **Verification handshake unaffected:** re-subscribing the webhook in Meta (GET with `hub.verify_token`)
  still returns the challenge (the signature check is inside the POST branch only).

## Notes / risks the operator must confirm
- **You must have the Meta App Secret** before this can be deployed. Without `WHATSAPP_APP_SECRET` set, the
  function will reject ALL inbound POSTs (403) and you will stop receiving WhatsApp messages. Set the secret
  FIRST, deploy SECOND.
- If Meta ever rotates the App Secret, re-run `firebase functions:secrets:set WHATSAPP_APP_SECRET` and redeploy.
- `req.rawBody` is available on Firebase `onRequest` handlers. If a future refactor swaps to raw Express with a
  custom body parser, ensure the raw body is still captured, or the HMAC will fail.
