/**
 * Babiez Cloud Functions
 *
 * sendPushOnNotification - listens to Firestore /notifications/{id} onCreate,
 * sends a push via OneSignal REST API to the document's recipientUid (matched
 * by OneSignal external_id, which we set on login as the user's Firebase UID).
 *
 * Works for all platforms OneSignal supports: iOS Safari PWA, Android Chrome,
 * Web (desktop). The function is the trigger; OneSignal handles delivery.
 */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

const morningApiKeyId = defineSecret("MORNING_API_KEY_ID");
const morningApiSecret = defineSecret("MORNING_API_SECRET");
const MORNING_API_BASE = "https://api.greeninvoice.co.il/api/v1";
const VAT_RATE = 0.18;

const ONESIGNAL_APP_ID = "8e16a61e-f6b1-4fb2-8fe4-b35741271d00";
const APP_URL = "https://babiesclub.github.io/babies-employees/";
const ICON_URL = APP_URL + "icon-192.png";

// Secret set via CLI:
//   firebase functions:secrets:set ONESIGNAL_REST_API_KEY
const onesignalApiKey = defineSecret("ONESIGNAL_REST_API_KEY");

// WhatsApp Cloud API secrets
const whatsappAccessToken = defineSecret("WHATSAPP_ACCESS_TOKEN");
const whatsappPhoneNumberId = defineSecret("WHATSAPP_PHONE_NUMBER_ID");
const whatsappBusinessAccountId = defineSecret("WHATSAPP_BUSINESS_ACCOUNT_ID");
// Webhook verify token - we choose this string, must match what we configure in Meta
const whatsappWebhookVerifyToken = defineSecret("WHATSAPP_WEBHOOK_VERIFY_TOKEN");
const WHATSAPP_API_BASE = "https://graph.facebook.com/v21.0";
// Cost per utility template message in Israel (USD)
const WA_COST_PER_MSG_USD = 0.018;
// Default monthly budget (USD) - admin can override via Firestore meta/whatsapp_config
const WA_DEFAULT_MONTHLY_BUDGET_USD = 50;

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

exports.sendpushonnotification = onDocumentCreated(
  {
    document: "notifications/{notifId}",
    secrets: [onesignalApiKey],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.info("No snapshot, skipping");
      return;
    }
    const data = snap.data();
    if (!data || !data.recipientUid) {
      logger.info("No recipientUid, skipping");
      return;
    }

    const apiKey = onesignalApiKey.value();
    if (!apiKey) {
      logger.error("ONESIGNAL_REST_API_KEY secret not set");
      return;
    }

    const title = data.title || "בייביז 🐾";
    const body = data.body || "";
    const link = data.link || null;

    // Lookup user's OneSignal Subscription IDs from Firestore (multi-device support)
    let recipientSubIds = [];
    let recipientUsername = null;
    try {
      const userDoc = await admin.firestore()
        .collection("users")
        .doc(String(data.recipientUid))
        .get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (Array.isArray(userData.oneSignalSubscriptionIds) && userData.oneSignalSubscriptionIds.length) {
          recipientSubIds = userData.oneSignalSubscriptionIds;
        } else if (userData.oneSignalSubscriptionId) {
          recipientSubIds = [userData.oneSignalSubscriptionId];
        }
        recipientUsername = userData.username || null;
      }
    } catch (e) {
      logger.warn("Failed to fetch user:", e.message);
    }
    logger.info("Targeting", {
      recipientUid: data.recipientUid,
      subscriptionIds: recipientSubIds,
      deviceCount: recipientSubIds.length,
      username: recipientUsername,
    });

    try {
      // Best: target by Subscription IDs directly (most reliable, bypasses user model)
      // Fallback to tag-by-username, then to external_id
      let targeting;
      if (recipientSubIds.length > 0) {
        targeting = {
          include_subscription_ids: recipientSubIds,
        };
      } else if (recipientUsername) {
        targeting = {
          filters: [
            { field: "tag", key: "username", relation: "=", value: recipientUsername },
          ],
        };
      } else {
        targeting = {
          include_aliases: {
            external_id: [String(data.recipientUid)],
          },
          target_channel: "push",
        };
      }

      const response = await fetch(
        "https://api.onesignal.com/notifications?c=push",
        {
          method: "POST",
          headers: {
            Authorization: `Key ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            app_id: ONESIGNAL_APP_ID,
            ...targeting,
            headings: { he: title, en: title },
            contents: { he: body, en: body },
            data: {
              notifId: String(data.id || ""),
              type: data.type || "",
              link: link,
            },
            chrome_web_icon: ICON_URL,
            chrome_web_badge: ICON_URL,
            firefox_icon: ICON_URL,
            web_url: APP_URL,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok || result.errors) {
        logger.error("OneSignal API error", {
          status: response.status,
          recipientUid: data.recipientUid,
          errors: result.errors,
          result,
        });
        return;
      }

      logger.info("Push sent successfully", {
        recipientUid: data.recipientUid,
        notifId: data.id,
        recipients: result.recipients !== undefined ? result.recipients : "undefined",
        oneSignalId: result.id,
        fullResult: JSON.stringify(result),
      });
    } catch (e) {
      logger.error("Push send failed", { error: e.message, stack: e.stack });
    }
  }
);

/**
 * wizoMonthlyReminder - Scheduled function that runs on the 20th of every month
 * at 09:00 Israel time. Finds all instructors assigned to gardens containing "ויצו"
 * in their name, and creates an in-app notification for each (which triggers a push
 * via the sendpushonnotification function above).
 */
exports.wizomonthlyreminder = onSchedule(
  {
    schedule: "0 9 20 * *",
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
  },
  async (event) => {
    const db = admin.firestore();
    try {
      // 1. Find all gardens with "ויצו" in name
      const metaGardens = await db.collection("meta").doc("gardens").get();
      const allGardens = metaGardens.exists ? metaGardens.data().items || [] : [];
      const wizoGardenNames = allGardens
        .map((g) => (typeof g === "string" ? g : g.name))
        .filter((n) => n && n.includes("ויצו"));

      if (!wizoGardenNames.length) {
        logger.info("No WIZO gardens found, skipping reminder");
        return;
      }
      logger.info("WIZO gardens found", { count: wizoGardenNames.length, names: wizoGardenNames });

      // 2. Find all instructors assigned to any WIZO garden
      const usersSnap = await db.collection("users").get();
      const wizoInstructors = [];
      usersSnap.forEach((doc) => {
        const u = doc.data();
        if (u.role === "admin") return;
        const gardens = u.gardens || [];
        const hasWizo = gardens.some((g) => wizoGardenNames.includes(g));
        if (hasWizo) {
          wizoInstructors.push({ uid: doc.id, name: u.name, username: u.username });
        }
      });

      if (!wizoInstructors.length) {
        logger.info("No instructors assigned to WIZO gardens");
        return;
      }
      logger.info("WIZO instructors found", { count: wizoInstructors.length });

      // 3. Get current month for the message
      const now = new Date();
      const monthNames = [
        "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
        "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
      ];
      const monthName = monthNames[now.getMonth()];

      // 4. Create a notification for each WIZO instructor
      // (This triggers sendpushonnotification automatically via Firestore onCreate)
      const promises = wizoInstructors.map(async (inst) => {
        const id = Date.now() + Math.floor(Math.random() * 1000);
        const notif = {
          id,
          recipientUid: inst.uid,
          type: "wizo_reminder",
          icon: "📋",
          title: "תזכורת: דוח ויצו לחודש " + monthName,
          body: "נא למלא את דוח ויצו עד סוף החודש - כל הדיווחים מתחילת החודש ועד סופו.",
          link: { screen: "his" },
          createdAt: new Date().toISOString(),
          createdBy: "system",
          createdByName: "מערכת בייביז",
          read: false,
          readAt: null,
        };
        return db.collection("notifications").doc(String(id)).set(notif);
      });

      await Promise.all(promises);
      logger.info("WIZO reminders sent", { count: wizoInstructors.length });
    } catch (e) {
      logger.error("WIZO reminder failed", { error: e.message, stack: e.stack });
    }
  }
);

/**
 * Morning (Green Invoice) API integration - createmorninginvoice
 * Called from client to create an invoice in Morning for a specific garden + month
 */

const HE_MONTHS_M = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];

async function morningAuth(apiKeyId, apiSecret) {
  // Trim whitespace/newlines from credentials (often added by notepad/copy-paste)
  const cleanId = String(apiKeyId || "").trim();
  const cleanSecret = String(apiSecret || "").trim();
  logger.info("morningAuth: credentials lengths", {
    idLen: cleanId.length,
    secretLen: cleanSecret.length,
    idPreview: cleanId.slice(0, 4) + "..." + cleanId.slice(-4),
  });
  if (!cleanId || !cleanSecret) {
    throw new Error("Morning credentials missing (empty after trim)");
  }
  const response = await fetch(`${MORNING_API_BASE}/account/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: cleanId, secret: cleanSecret }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Morning auth failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  return data.token;
}

function buildInvoiceDescription(records, garden, networkBranches) {
  const billingMode = garden.billingMode || "time";
  const isNetwork = Array.isArray(networkBranches) && networkBranches.length > 1;

  // For networks: group by branch name; within each branch, by date
  if (isNetwork) {
    const lines = [];
    // Group records by garden (branch)
    const byBranch = {};
    records.forEach((r) => {
      const branchKey = r.garden || "(ללא סניף)";
      if (!byBranch[branchKey]) byBranch[branchKey] = [];
      byBranch[branchKey].push(r);
    });
    const sortedBranches = Object.keys(byBranch).sort((a, b) => a.localeCompare(b, "he"));
    for (const branchName of sortedBranches) {
      const branchObj = networkBranches.find((g) => g.name === branchName);
      const displayName = (branchObj && branchObj.branchName) || branchName;
      const branchRecs = byBranch[branchName];
      lines.push("📍 סניף " + displayName + ":");
      // Group this branch's records by date
      const byDate = {};
      branchRecs.forEach((r) => {
        if (!byDate[r.date]) byDate[r.date] = [];
        byDate[r.date].push(r);
      });
      const sortedDates = Object.keys(byDate).sort();
      for (const date of sortedDates) {
        const dateRecs = byDate[date];
        const parts = date.split("-");
        const dateStr = parts[2] + "/" + parts[1] + "/" + parts[0];
        const bMode = (branchObj && branchObj.billingMode) || billingMode;
        if (bMode === "per_group") {
          const totalGroups = dateRecs.reduce((s, r) => s + (parseFloat(r.groups) || 0), 0);
          lines.push("   " + dateStr + " - " + totalGroups + " קבוצות");
        } else if (bMode === "per_child") {
          const totalReports = dateRecs.length;
          const month = date.slice(0, 7);
          const childCount = ((branchObj && branchObj.monthlyChildCounts) || {})[month] || 0;
          lines.push("   " + dateStr + " - " + totalReports + " פעילות עם " + childCount + " ילדים");
        } else {
          for (const r of dateRecs) {
            const grp = parseInt(r.groups) || 1;
            const dur = r.duration || "?";
            lines.push("   " + dateStr + " - " + grp + " פעילות בת " + dur + " דק׳");
          }
        }
      }
      lines.push("");
    }
    return lines.join("\n").trim();
  }

  // Non-network: original logic
  const byDate = {};
  records.forEach((r) => {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  });
  const lines = [];
  const sortedDates = Object.keys(byDate).sort();
  for (const date of sortedDates) {
    const dateRecs = byDate[date];
    const parts = date.split("-");
    const dateStr = parts[2] + "/" + parts[1] + "/" + parts[0];
    if (billingMode === "per_group") {
      const totalGroups = dateRecs.reduce((s, r) => s + (parseFloat(r.groups) || 0), 0);
      lines.push(dateStr + " - " + totalGroups + " קבוצות (פר קבוצה)");
    } else if (billingMode === "per_child") {
      const totalReports = dateRecs.length;
      const month = date.slice(0, 7);
      const childCount = (garden.monthlyChildCounts || {})[month] || 0;
      lines.push(dateStr + " - " + totalReports + " פעילות עם " + childCount + " ילדים");
    } else {
      for (const r of dateRecs) {
        const grp = parseInt(r.groups) || 1;
        const dur = r.duration || "?";
        lines.push(dateStr + " - " + grp + " פעילות בת " + dur + " דק׳");
      }
    }
  }
  return lines.join("\n");
}

function calcChargeBaseServer(record, garden) {
  const billingMode = (garden && garden.billingMode) || "time";
  const dur = record.duration;
  const date = record.date;
  const groups = parseInt(record.groups) || 1;
  let history = Array.isArray(garden.chargeRatesHistory) ? garden.chargeRatesHistory : [];
  if (!history.length && garden.chargeRates && Object.keys(garden.chargeRates).length > 0) {
    history = [{from: "1970-01-01", rates: garden.chargeRates}];
  }
  const eligible = history.filter((h) => h.from <= date).sort((a, b) => b.from.localeCompare(a.from));
  if (!eligible.length) return null;
  const rates = eligible[0].rates || {};

  if (billingMode === "per_child") {
    const rate = rates.perChild;
    const month = date.slice(0, 7);
    const count = (garden.monthlyChildCounts || {})[month];
    if (rate && count) return +(rate * count).toFixed(2);
    return null;
  }
  if (billingMode === "per_group") {
    const rate = rates.perGroup;
    if (rate) return +(rate * groups).toFixed(2);
    return null;
  }
  const exact = rates[String(dur)];
  if (exact != null && Number(exact) > 0) return Number(exact);
  const validKeys = Object.keys(rates)
    .filter((k) => !isNaN(Number(k)) && rates[k] && Number(rates[k]) > 0)
    .sort((a, b) => Number(a) - Number(b));
  if (!validKeys.length) return null;
  const baseRate = Number(rates[validKeys[0]]);
  const ratio = Number(dur) / Number(validKeys[0]);
  return +(baseRate * ratio).toFixed(2);
}

exports.createmorninginvoice = onCall(
  {
    secrets: [morningApiKeyId, morningApiSecret],
    region: "us-central1",
    timeoutSeconds: 60,
  },
  async (request) => {
    try {
      logger.info("createmorninginvoice: START", { data: request.data, uid: request.auth && request.auth.uid });
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "Must be logged in");
      }
      const callerUid = request.auth.uid;
      const callerDoc = await admin.firestore().collection("users").doc(callerUid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }

      const data = request.data || {};
      const gardenName = data.gardenName;
      const month = data.month;
      const docTypeOverride = data.docTypeOverride;
      if (!gardenName || !month) {
        throw new HttpsError("invalid-argument", "gardenName and month required");
      }

      const gardensDoc = await admin.firestore().collection("meta").doc("gardens").get();
      const allGardens = gardensDoc.exists ? gardensDoc.data().items || [] : [];
      const garden = allGardens.find((g) => (typeof g === "string" ? g : g.name) === gardenName);
      if (!garden || typeof garden !== "object") {
        throw new HttpsError("not-found", "Garden not found: " + gardenName);
      }
      logger.info("createmorninginvoice: garden found", {
        name: garden.name,
        billingMode: garden.billingMode,
        hasChargeRatesHistory: Array.isArray(garden.chargeRatesHistory),
        hasChargeRates: !!garden.chargeRates,
        morningClientId: garden.morningClientId,
        morningDocType: garden.morningDocType,
        networkName: garden.networkName,
      });
      if (!garden.morningClientId) {
        throw new HttpsError("failed-precondition", "Garden has no Morning Client ID: " + gardenName);
      }

      // Network handling: if this garden is part of a network, find all sibling branches
      // (same networkName), and treat them as one invoice. Use this garden as the "lead"
      // for billing settings, but aggregate records from all branches.
      const networkBranches = garden.networkName
        ? allGardens.filter((g) => typeof g === "object" && g.networkName === garden.networkName)
        : [garden];
      const allBranchNames = networkBranches.map((g) => g.name);
      const isNetwork = networkBranches.length > 1;
      logger.info("createmorninginvoice: network aggregation", {
        isNetwork,
        networkName: garden.networkName || null,
        branchCount: networkBranches.length,
        branchNames: allBranchNames,
      });

      // Fetch records for ALL branches (Firestore 'in' supports up to 30 values; use chunks if needed)
      const records = [];
      const chunkSize = 30;
      for (let i = 0; i < allBranchNames.length; i += chunkSize) {
        const chunk = allBranchNames.slice(i, i + chunkSize);
        const chunkSnap = await admin.firestore().collection("records").where("garden", "in", chunk).get();
        chunkSnap.forEach((d) => {
          const r = d.data();
          if (r.date && r.date.startsWith(month)) records.push(r);
        });
      }
      logger.info("createmorninginvoice: records loaded", { count: records.length, month });
      if (!records.length) {
        const errLabel = isNetwork ? ("רשת '" + garden.networkName + "'") : ("גן '" + gardenName + "'");
        throw new HttpsError("not-found", "אין דיווחים ל" + errLabel + " לחודש " + month);
      }

      // Calculate total - each record uses its own branch's rates
      const gardenByName = new Map();
      networkBranches.forEach((g) => gardenByName.set(g.name, g));
      let total = 0;
      let nullCount = 0;
      records.forEach((r) => {
        const recordGarden = gardenByName.get(r.garden) || garden;
        const b = calcChargeBaseServer(r, recordGarden);
        if (b != null) total += b;
        else nullCount++;
      });
      logger.info("createmorninginvoice: total calculated", { total, nullCount, records: records.length });
      if (total <= 0) {
        const billingMode = garden.billingMode || "time";
        const hasHistory = Array.isArray(garden.chargeRatesHistory) && garden.chargeRatesHistory.length > 0;
        const hasOldRates = garden.chargeRates && Object.keys(garden.chargeRates).length > 0;
        let reason = "סכום החיוב הוא 0. ";
        if (!hasHistory && !hasOldRates) {
          reason += "אין תעריפי חיוב מוגדרים לגן '" + gardenName + "'. ערכי את הגן והגדירי תעריפים.";
        } else if (billingMode === "per_child") {
          const count = (garden.monthlyChildCounts || {})[month];
          if (!count) reason += "מודל חיוב 'פר ילד' - לא הוגדר מספר ילדים לחודש " + month + " בגן '" + gardenName + "'.";
          else reason += "מודל חיוב 'פר ילד' - אין תעריף perChild מוגדר.";
        } else {
          reason += nullCount + " מתוך " + records.length + " דיווחים ללא תעריף תואם. בדקי שיש תעריף למשך הביקור במודל '" + billingMode + "'.";
        }
        throw new HttpsError("failed-precondition", reason);
      }

      const existingInvoiceSnap = await admin.firestore()
        .collection("invoices")
        .where("gardenName", "==", gardenName)
        .where("month", "==", month)
        .where("status", "==", "created")
        .limit(1)
        .get();
      if (!existingInvoiceSnap.empty) {
        const existing = existingInvoiceSnap.docs[0].data();
        logger.info("createmorninginvoice: returning existing", { id: existing.id });
        return {
          success: true,
          existed: true,
          docNumber: existing.morningDocNumber || existing.number || "",
          docUrl: existing.morningDocUrl || "",
          invoice: existing,
        };
      }

      const monthParts = month.split("-");
      const monthName = HE_MONTHS_M[parseInt(monthParts[1]) - 1];
      const description = buildInvoiceDescription(records, garden, networkBranches);

      logger.info("createmorninginvoice: calling morningAuth");
      const token = await morningAuth(morningApiKeyId.value(), morningApiSecret.value());
      logger.info("createmorninginvoice: morningAuth OK, got token len=" + (token ? token.length : 0));

      const docType = parseInt(docTypeOverride || garden.morningDocType || "300");

      // vatType in Morning API:
      //   0 = REGULAR (default - VAT 18% added on top of price)
      //   1 = EXEMPT (no VAT - פטור)
      //   2 = INCLUDED (price already includes VAT)
      // Our `total` is the base amount BEFORE VAT, so we use vatType: 0
      const payload = {
        type: docType,
        date: new Date().toISOString().slice(0, 10),
        lang: "he",
        currency: "ILS",
        vatType: 0,
        client: { id: String(garden.morningClientId) },
        income: [
          {
            description: "חוגי בייביז לחודש " + monthName + " " + monthParts[0] + "\n" + description,
            quantity: 1,
            price: total,
            currency: "ILS",
            vatType: 0,
          },
        ],
        remarks: "הופק אוטומטית ע\"י אפליקציית בייביז · " + monthName + " " + monthParts[0],
      };
      logger.info("createmorninginvoice: posting to Morning", { docType, total, clientId: garden.morningClientId });

      const docResponse = await fetch(`${MORNING_API_BASE}/documents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const docResultText = await docResponse.text();
      let docResult;
      try { docResult = JSON.parse(docResultText); } catch (e) { docResult = { raw: docResultText }; }
      logger.info("createmorninginvoice: Morning response", { status: docResponse.status, result: docResult });
      if (!docResponse.ok || docResult.errorCode) {
        const msg = docResult.errorMessage || docResult.message || ("HTTP " + docResponse.status + ": " + docResultText.slice(0, 200));
        throw new HttpsError("internal", "מורנינג החזירה שגיאה: " + msg);
      }

      const docNumber = docResult.number || docResult.documentNumber || null;
      const docUrl = docResult.url ? (docResult.url.he || docResult.url.origin || null) : null;
      const morningActualType = docResult.type != null ? Number(docResult.type) : null;

      const invoiceId = Date.now() + Math.floor(Math.random() * 1000);
      const invoiceData = {
        id: invoiceId,
        gardenName,
        month,
        docType,
        morningActualType: morningActualType,
        morningDocId: docResult.id || null,
        morningDocNumber: docNumber,
        morningDocUrl: docUrl,
        totalAmount: total,
        vatAmount: +(total * VAT_RATE).toFixed(2),
        recordCount: records.length,
        createdAt: new Date().toISOString(),
        createdBy: callerUid,
        status: "created",
        // Network metadata
        isNetwork,
        networkName: garden.networkName || null,
        branchNames: isNetwork ? allBranchNames : null,
      };
      await admin.firestore().collection("invoices").doc(String(invoiceId)).set(invoiceData);
      logger.info("createmorninginvoice: SUCCESS", { gardenName, month, docNumber });

      return {
        success: true,
        docNumber: docNumber,
        docUrl: docUrl,
        morningActualType: morningActualType,
        requestedType: docType,
        invoice: invoiceData,
      };
    } catch (err) {
      if (err instanceof HttpsError) {
        logger.warn("createmorninginvoice: HttpsError", { code: err.code, message: err.message });
        throw err;
      }
      logger.error("createmorninginvoice: UNCAUGHT", { message: err.message, stack: err.stack, name: err.name });
      throw new HttpsError("internal", "שגיאה לא צפויה: " + (err.message || String(err)));
    }
  }
);

/**
 * List invoices for a month (admin only) - returns simplified array for UI display
 */
exports.listinvoices = onCall(
  { region: "us-central1", timeoutSeconds: 30 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { month } = request.data || {};
      if (!month) throw new HttpsError("invalid-argument", "month required");
      const snap = await admin.firestore().collection("invoices").where("month", "==", month).get();
      const invoices = [];
      snap.forEach((d) => invoices.push(d.data()));
      return { invoices };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("listinvoices: UNCAUGHT", { message: err.message, stack: err.stack });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * Delete local invoice record(s) - admin only
 * Does NOT delete the document in Morning - only our local Firestore tracking record.
 * Used for testing / re-creating with different doc type.
 */
exports.deletelocalinvoice = onCall(
  { region: "us-central1", timeoutSeconds: 30 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { gardenName, month } = request.data || {};
      if (!gardenName || !month) throw new HttpsError("invalid-argument", "gardenName and month required");
      const snap = await admin.firestore().collection("invoices")
        .where("gardenName", "==", gardenName)
        .where("month", "==", month)
        .get();
      if (snap.empty) return { deleted: 0 };
      const batch = admin.firestore().batch();
      snap.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      logger.info("deletelocalinvoice: deleted", { gardenName, month, count: snap.size });
      return { deleted: snap.size };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("deletelocalinvoice: UNCAUGHT", { message: err.message, stack: err.stack });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * ============================================================================
 * WhatsApp Cloud API Integration
 * ============================================================================
 */

// Normalize phone to international format (without +)
function normalizePhoneIntl(phone) {
  if (!phone) return "";
  let p = String(phone).replace(/[^\d+]/g, "");
  if (p.startsWith("+")) return p.slice(1);
  if (p.startsWith("00")) return p.slice(2);
  if (p.startsWith("972")) return p;
  if (p.startsWith("0")) return "972" + p.slice(1);
  return p;
}

// Get current month bucket: "2026-05"
function currentMonthKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

// Get WhatsApp budget config (defaults if not set)
async function getWaConfig() {
  const doc = await admin.firestore().collection("meta").doc("whatsapp_config").get();
  const data = doc.exists ? doc.data() : {};
  return {
    monthlyBudgetUsd: Number(data.monthlyBudgetUsd || WA_DEFAULT_MONTHLY_BUDGET_USD),
    costPerMsgUsd: Number(data.costPerMsgUsd || WA_COST_PER_MSG_USD),
    enabled: data.enabled !== false,
    blockOnExceed: data.blockOnExceed !== false,
  };
}

// Increment usage counter for current month and return updated state
async function trackWaUsage(monthKey, incrementBy = 1) {
  const ref = admin.firestore().collection("whatsapp_usage").doc(monthKey);
  await ref.set(
    { count: admin.firestore.FieldValue.increment(incrementBy), lastUpdated: new Date().toISOString() },
    { merge: true }
  );
}

// Get current monthly usage
async function getWaUsage(monthKey) {
  const doc = await admin.firestore().collection("whatsapp_usage").doc(monthKey).get();
  return doc.exists ? Number(doc.data().count || 0) : 0;
}

/**
 * sendwhatsapp - Send a WhatsApp message via Cloud API
 *
 * Supports two modes:
 *   1. template - send an approved template (for first contact / outside 24h window)
 *   2. text - send plain text (only valid within 24h of customer message)
 *
 * For now, defaults to "hello_world" template (pre-approved by Meta)
 * Once we have invoice template approved, will support templateName="invoice_notification" with parameters
 */
exports.sendwhatsapp = onCall(
  {
    secrets: [whatsappAccessToken, whatsappPhoneNumberId, whatsappBusinessAccountId],
    region: "us-central1",
    timeoutSeconds: 30,
  },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }

      const { to, mode, templateName, languageCode, parameters, text, mediaUrl, mediaCaption } = request.data || {};
      if (!to) throw new HttpsError("invalid-argument", "Missing 'to' phone number");

      const phone = normalizePhoneIntl(to);
      if (!phone) throw new HttpsError("invalid-argument", "Invalid phone number: " + to);

      // Budget check
      const config = await getWaConfig();
      if (!config.enabled) {
        throw new HttpsError("failed-precondition", "שליחת WhatsApp מושבתת. ניתן להפעיל בהגדרות.");
      }
      const monthKey = currentMonthKey();
      const usage = await getWaUsage(monthKey);
      const projectedCost = (usage + 1) * config.costPerMsgUsd;
      if (config.blockOnExceed && projectedCost > config.monthlyBudgetUsd) {
        throw new HttpsError(
          "resource-exhausted",
          `חרגנו מתקציב חודשי: ${usage} הודעות נשלחו (~$${(usage * config.costPerMsgUsd).toFixed(2)}). תקציב: $${config.monthlyBudgetUsd}. ניתן להעלות בהגדרות.`
        );
      }

      // Build payload based on mode
      const sendMode = mode || "template";
      let payload;
      if (sendMode === "template") {
        const name = templateName || "hello_world";
        const lang = languageCode || (name === "hello_world" ? "en_US" : "he");
        payload = {
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: name,
            language: { code: lang },
          },
        };
        // Add header media (image/document) if provided
        if (mediaUrl) {
          payload.template.components = payload.template.components || [];
          payload.template.components.push({
            type: "header",
            parameters: [{
              type: "document",
              document: { link: mediaUrl, filename: mediaCaption || "document.pdf" },
            }],
          });
        }
        // Add body parameters if provided
        if (Array.isArray(parameters) && parameters.length) {
          payload.template.components = payload.template.components || [];
          payload.template.components.push({
            type: "body",
            parameters: parameters.map((p) => ({ type: "text", text: String(p) })),
          });
        }
      } else if (sendMode === "text") {
        if (!text) throw new HttpsError("invalid-argument", "Missing 'text' for text mode");
        payload = {
          messaging_product: "whatsapp",
          to: phone,
          type: "text",
          text: { body: String(text), preview_url: true },
        };
      } else {
        throw new HttpsError("invalid-argument", "Unknown mode: " + sendMode);
      }

      const phoneId = String(whatsappPhoneNumberId.value()).trim();
      const token = String(whatsappAccessToken.value()).trim();
      const url = `${WHATSAPP_API_BASE}/${phoneId}/messages`;
      logger.info("sendwhatsapp: posting", { mode: sendMode, to: phone, templateName: payload.template && payload.template.name });
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const respText = await response.text();
      let result;
      try { result = JSON.parse(respText); } catch (e) { result = { raw: respText }; }
      logger.info("sendwhatsapp: WhatsApp response", { status: response.status, result });
      if (!response.ok || result.error) {
        const errMsg = (result.error && (result.error.message || result.error.error_user_msg)) || ("HTTP " + response.status);
        throw new HttpsError("internal", "WhatsApp שגיאה: " + errMsg);
      }

      // Track usage
      await trackWaUsage(monthKey);
      const newUsage = usage + 1;
      const newCost = +(newUsage * config.costPerMsgUsd).toFixed(2);
      const budgetUsedPct = Math.round((newCost / config.monthlyBudgetUsd) * 100);

      logger.info("sendwhatsapp: SUCCESS", { to: phone, monthKey, count: newUsage, costUsd: newCost });
      return {
        success: true,
        messageId: result.messages && result.messages[0] && result.messages[0].id,
        usage: { month: monthKey, count: newUsage, costUsd: newCost, budgetUsd: config.monthlyBudgetUsd, budgetUsedPct },
      };
    } catch (err) {
      if (err instanceof HttpsError) {
        logger.warn("sendwhatsapp: HttpsError", { code: err.code, message: err.message });
        throw err;
      }
      logger.error("sendwhatsapp: UNCAUGHT", { message: err.message, stack: err.stack });
      throw new HttpsError("internal", "שגיאה לא צפויה: " + (err.message || String(err)));
    }
  }
);

/**
 * getwhatsappstatus - Get current WhatsApp budget status + usage (admin only)
 */
exports.getwhatsappstatus = onCall(
  { region: "us-central1", timeoutSeconds: 15 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const monthKey = currentMonthKey();
      const config = await getWaConfig();
      const usage = await getWaUsage(monthKey);
      const costUsd = +(usage * config.costPerMsgUsd).toFixed(2);
      const budgetUsedPct = Math.round((costUsd / config.monthlyBudgetUsd) * 100);
      // Get last 6 months for chart
      const history = [];
      for (let i = 0; i < 6; i++) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const mk = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        const c = await getWaUsage(mk);
        history.unshift({ month: mk, count: c, costUsd: +(c * config.costPerMsgUsd).toFixed(2) });
      }
      return {
        currentMonth: { month: monthKey, count: usage, costUsd, budgetUsd: config.monthlyBudgetUsd, budgetUsedPct },
        config,
        history,
      };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("getwhatsappstatus: UNCAUGHT", { message: err.message, stack: err.stack });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * registerwhatsapp - Register the phone number with WhatsApp Cloud API
 * One-time setup: registers the phone + sets 2FA PIN
 * Required before sendwhatsapp can work
 */
exports.registerwhatsapp = onCall(
  {
    secrets: [whatsappAccessToken, whatsappPhoneNumberId],
    region: "us-central1",
    timeoutSeconds: 30,
  },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { pin } = request.data || {};
      if (!pin || !/^\d{6}$/.test(String(pin))) {
        throw new HttpsError("invalid-argument", "PIN must be exactly 6 digits");
      }

      const phoneId = String(whatsappPhoneNumberId.value()).trim();
      const token = String(whatsappAccessToken.value()).trim();
      const url = `${WHATSAPP_API_BASE}/${phoneId}/register`;
      logger.info("registerwhatsapp: registering phone", { phoneId });

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          pin: String(pin),
        }),
      });

      const respText = await response.text();
      let result;
      try { result = JSON.parse(respText); } catch (e) { result = { raw: respText }; }
      logger.info("registerwhatsapp: response", { status: response.status, result });

      if (!response.ok || result.error) {
        const errMsg = (result.error && (result.error.message || result.error.error_user_msg)) || ("HTTP " + response.status);
        throw new HttpsError("internal", "Register failed: " + errMsg);
      }

      logger.info("registerwhatsapp: SUCCESS", { phoneId });
      return {
        success: true,
        message: "המספר נרשם בהצלחה ב-Cloud API! עכשיו אפשר לשלוח הודעות.",
        result,
      };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("registerwhatsapp: UNCAUGHT", { message: err.message, stack: err.stack });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * ===========================================================================
 * WhatsApp Inbox - receive messages + reply
 * ===========================================================================
 */

/**
 * receivewhatsapp - HTTP webhook endpoint for Meta to push incoming messages
 *
 * Handles 2 types of requests:
 *   1. GET - Webhook verification (Meta sends hub.challenge to verify URL ownership)
 *   2. POST - Incoming messages (text, button click, image, document, etc.)
 *
 * Saves messages to Firestore: collection 'whatsapp_messages' with subcollection per conversation
 */
exports.receivewhatsapp = onRequest(
  {
    secrets: [whatsappWebhookVerifyToken],
    region: "us-central1",
    timeoutSeconds: 30,
    cors: false,
  },
  async (req, res) => {
    try {
      // ============ GET = Webhook verification by Meta ============
      if (req.method === "GET") {
        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];
        const expectedToken = String(whatsappWebhookVerifyToken.value()).trim();
        logger.info("receivewhatsapp: verification request", { mode, hasToken: !!token, hasChallenge: !!challenge });
        if (mode === "subscribe" && token === expectedToken) {
          logger.info("receivewhatsapp: verification OK");
          res.status(200).send(String(challenge || ""));
          return;
        }
        logger.warn("receivewhatsapp: verification FAILED", { mode, tokenMatch: token === expectedToken });
        res.status(403).send("Verification failed");
        return;
      }

      // ============ POST = Incoming event ============
      if (req.method !== "POST") {
        res.status(405).send("Method not allowed");
        return;
      }

      const body = req.body || {};
      logger.info("receivewhatsapp: event received", { object: body.object, hasEntry: !!body.entry });

      // Standard Meta webhook structure
      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.field !== "messages") continue;
          const value = change.value || {};
          const messages = value.messages || [];
          const statuses = value.statuses || [];
          const contacts = value.contacts || [];
          const metadata = value.metadata || {};
          const businessPhoneId = metadata.phone_number_id || "";

          // Handle incoming messages
          for (const msg of messages) {
            try {
              const from = msg.from; // sender phone (international format, no +)
              const msgId = msg.id;
              const timestamp = msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now();
              const type = msg.type || "unknown";
              const contact = contacts.find((c) => c.wa_id === from);
              const senderName = (contact && contact.profile && contact.profile.name) || "";

              // Extract message content based on type
              let content = {};
              if (type === "text") {
                content = { text: msg.text && msg.text.body };
              } else if (type === "button") {
                content = { text: msg.button && msg.button.text, payload: msg.button && msg.button.payload };
              } else if (type === "interactive") {
                const i = msg.interactive || {};
                content = {
                  type: i.type,
                  buttonReply: i.button_reply ? { id: i.button_reply.id, title: i.button_reply.title } : undefined,
                  listReply: i.list_reply ? { id: i.list_reply.id, title: i.list_reply.title } : undefined,
                };
              } else if (type === "image" || type === "document" || type === "audio" || type === "video") {
                content = { mediaId: msg[type] && msg[type].id, caption: msg[type] && msg[type].caption, mimeType: msg[type] && msg[type].mime_type };
              } else {
                content = { raw: msg };
              }

              const doc = {
                id: msgId,
                direction: "incoming",
                from,
                conversationPhone: from,
                fromName: senderName,
                businessPhoneId,
                type,
                content,
                timestamp,
                read: false,
                starred: false,
                createdAt: new Date(timestamp).toISOString(),
                raw: msg,
              };

              // Save to Firestore: messages indexed by ID, conversations grouped by phone
              await admin.firestore().collection("whatsapp_messages").doc(msgId).set(doc);
              await admin.firestore().collection("whatsapp_conversations").doc(from).set(
                {
                  phone: from,
                  name: senderName || from,
                  lastMessageAt: timestamp,
                  lastMessagePreview: content.text || content.buttonReply?.title || ("[" + type + "]"),
                  lastMessageDirection: "incoming",
                  unreadCount: admin.firestore.FieldValue.increment(1),
                  updatedAt: new Date().toISOString(),
                },
                { merge: true }
              );

              // Create a notification for all admins (triggers OneSignal push automatically)
              try {
                const adminsSnap = await admin.firestore().collection("users").where("role", "==", "admin").get();
                const notifPromises = [];
                adminsSnap.forEach((adminDoc) => {
                  const adminData = adminDoc.data();
                  const notifId = Date.now() + Math.floor(Math.random() * 1000);
                  const preview = (content.text || content.buttonReply?.title || ("[" + type + "]")).slice(0, 80);
                  notifPromises.push(
                    admin.firestore().collection("notifications").doc(String(notifId)).set({
                      id: notifId,
                      recipientUid: adminDoc.id,
                      type: "whatsapp_message",
                      icon: "💬",
                      title: "הודעת WhatsApp חדשה: " + (senderName || from),
                      body: preview,
                      link: { screen: "wai" },
                      createdAt: new Date().toISOString(),
                      createdBy: "system",
                      createdByName: from,
                      read: false,
                      readAt: null,
                    })
                  );
                });
                await Promise.all(notifPromises);
              } catch (e) {
                logger.warn("receivewhatsapp: failed to create admin notification", { error: e.message });
              }

              logger.info("receivewhatsapp: message saved", { from, type, msgId });
            } catch (e) {
              logger.error("receivewhatsapp: failed to process message", { error: e.message, msg });
            }
          }

          // Handle status updates (sent/delivered/read of our outgoing messages)
          for (const status of statuses) {
            try {
              const msgId = status.id;
              const statusValue = status.status; // sent / delivered / read / failed
              const timestamp = status.timestamp ? Number(status.timestamp) * 1000 : Date.now();
              await admin.firestore().collection("whatsapp_messages").doc(msgId).set(
                {
                  [`status_${statusValue}_at`]: new Date(timestamp).toISOString(),
                  status: statusValue,
                },
                { merge: true }
              );
              logger.info("receivewhatsapp: status saved", { msgId, status: statusValue });
            } catch (e) {
              logger.error("receivewhatsapp: failed to process status", { error: e.message, status });
            }
          }
        }
      }

      res.status(200).send("OK");
    } catch (err) {
      logger.error("receivewhatsapp: UNCAUGHT", { message: err.message, stack: err.stack });
      res.status(200).send("OK"); // Always 200 to Meta to avoid retries
    }
  }
);

/**
 * listwhatsappconversations - list all conversations (admin only)
 */
exports.listwhatsappconversations = onCall(
  { region: "us-central1", timeoutSeconds: 15 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const snap = await admin.firestore()
        .collection("whatsapp_conversations")
        .limit(200)
        .get();
      const conversations = [];
      snap.forEach((d) => conversations.push(d.data()));
      // Sort in memory by lastMessageAt desc
      conversations.sort((a, b) => Number(b.lastMessageAt || 0) - Number(a.lastMessageAt || 0));
      return { conversations: conversations.slice(0, 100) };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("listwhatsappconversations: UNCAUGHT", { message: err.message });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * getwhatsappmessages - get messages of a specific conversation (admin only)
 */
exports.getwhatsappmessages = onCall(
  { region: "us-central1", timeoutSeconds: 15 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { phone, limit } = request.data || {};
      if (!phone) throw new HttpsError("invalid-argument", "Missing 'phone'");
      // Query without orderBy to avoid composite index requirement - sort in memory
      const snap = await admin.firestore()
        .collection("whatsapp_messages")
        .where("conversationPhone", "==", phone)
        .limit(Math.min(Number(limit || 200), 500))
        .get();
      const messages = [];
      snap.forEach((d) => messages.push(d.data()));
      // Fallback: messages saved before we added conversationPhone field
      if (messages.length === 0) {
        const [inSnap, outSnap] = await Promise.all([
          admin.firestore().collection("whatsapp_messages").where("from", "==", phone).limit(200).get(),
          admin.firestore().collection("whatsapp_messages").where("to", "==", phone).limit(200).get(),
        ]);
        inSnap.forEach((d) => messages.push(d.data()));
        outSnap.forEach((d) => messages.push(d.data()));
      }
      // Sort by timestamp ascending (oldest first for chat UI)
      messages.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      // Mark as read
      await admin.firestore().collection("whatsapp_conversations").doc(phone).set(
        { unreadCount: 0, lastReadAt: new Date().toISOString() },
        { merge: true }
      );
      return { messages };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("getwhatsappmessages: UNCAUGHT", { message: err.message });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * setwapinned - Pin/unpin a conversation (admin only)
 */
exports.setwapinned = onCall(
  { region: "us-central1", timeoutSeconds: 10 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { phone, pinned } = request.data || {};
      if (!phone) throw new HttpsError("invalid-argument", "Missing phone");
      await admin.firestore().collection("whatsapp_conversations").doc(phone).set(
        { pinned: !!pinned, pinnedAt: pinned ? Date.now() : null },
        { merge: true }
      );
      return { success: true };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * setwastarred - Star/unstar a message (admin only)
 */
exports.setwastarred = onCall(
  { region: "us-central1", timeoutSeconds: 10 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { messageId, starred } = request.data || {};
      if (!messageId) throw new HttpsError("invalid-argument", "Missing messageId");
      await admin.firestore().collection("whatsapp_messages").doc(messageId).set(
        { starred: !!starred },
        { merge: true }
      );
      return { success: true };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * getwamediaurl - Get a downloadable URL for a media message from WhatsApp
 * (Meta provides media via media_id - we need to fetch the URL using the access token)
 */
exports.getwamediaurl = onCall(
  {
    secrets: [whatsappAccessToken],
    region: "us-central1",
    timeoutSeconds: 20,
  },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { mediaId } = request.data || {};
      if (!mediaId) throw new HttpsError("invalid-argument", "Missing mediaId");
      const token = String(whatsappAccessToken.value()).trim();
      const r = await fetch(`${WHATSAPP_API_BASE}/${mediaId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new HttpsError("internal", "Failed to fetch media URL: " + r.status);
      const data = await r.json();
      // URL is valid for 5 minutes - client should download immediately
      return { url: data.url, mimeType: data.mime_type, sha256: data.sha256 };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("getwamediaurl: UNCAUGHT", { message: err.message });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * replywhatsapp - send a free-form text reply to a customer (within 24h window only)
 */
exports.replywhatsapp = onCall(
  {
    secrets: [whatsappAccessToken, whatsappPhoneNumberId],
    region: "us-central1",
    timeoutSeconds: 30,
  },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { phone, text } = request.data || {};
      if (!phone || !text) throw new HttpsError("invalid-argument", "Missing phone or text");
      const cleanPhone = normalizePhoneIntl(phone);

      const phoneId = String(whatsappPhoneNumberId.value()).trim();
      const token = String(whatsappAccessToken.value()).trim();
      const url = `${WHATSAPP_API_BASE}/${phoneId}/messages`;

      const payload = {
        messaging_product: "whatsapp",
        to: cleanPhone,
        type: "text",
        text: { body: String(text), preview_url: true },
      };

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const respText = await response.text();
      let result;
      try { result = JSON.parse(respText); } catch (e) { result = { raw: respText }; }

      if (!response.ok || result.error) {
        const errMsg = (result.error && result.error.message) || ("HTTP " + response.status);
        throw new HttpsError("internal", "Reply failed: " + errMsg);
      }

      const msgId = result.messages && result.messages[0] && result.messages[0].id;
      const now = Date.now();
      const outDoc = {
        id: msgId,
        direction: "outgoing",
        to: cleanPhone,
        conversationPhone: cleanPhone,
        type: "text",
        content: { text: String(text) },
        timestamp: now,
        sentBy: request.auth.uid,
        sentByName: callerDoc.data().name || "",
        createdAt: new Date(now).toISOString(),
        status: "sent",
      };
      await admin.firestore().collection("whatsapp_messages").doc(msgId).set(outDoc);
      await admin.firestore().collection("whatsapp_conversations").doc(cleanPhone).set(
        {
          phone: cleanPhone,
          lastMessageAt: now,
          lastMessagePreview: String(text).slice(0, 100),
          lastMessageDirection: "outgoing",
          updatedAt: new Date(now).toISOString(),
        },
        { merge: true }
      );
      return { success: true, messageId: msgId };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("replywhatsapp: UNCAUGHT", { message: err.message });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * markinvoicepaid - Mark invoice as paid, optionally create receipt in Morning
 * and auto-send via WhatsApp.
 *
 * Input: { invoiceId, paidDate (YYYY-MM-DD), paidAmount?, note?, createReceipt?, sendWhatsApp? }
 *
 * Flow:
 *   1. Update invoice doc with payment details
 *   2. If createReceipt → call Morning API to create חשבונית מס/קבלה (320)
 *      linked to original invoice
 *   3. If sendWhatsApp → invoke sendwhatsapp with the receipt PDF
 */
exports.markinvoicepaid = onCall(
  {
    secrets: [morningApiKeyId, morningApiSecret, whatsappAccessToken, whatsappPhoneNumberId],
    region: "us-central1",
    timeoutSeconds: 60,
  },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { invoiceId, paidDate, paidAmount, note, createReceipt, sendWhatsApp } = request.data || {};
      if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required");
      if (!paidDate) throw new HttpsError("invalid-argument", "paidDate required");

      const invoiceRef = admin.firestore().collection("invoices").doc(String(invoiceId));
      const invoiceSnap = await invoiceRef.get();
      if (!invoiceSnap.exists) throw new HttpsError("not-found", "Invoice not found");
      const invoice = invoiceSnap.data();

      const finalAmount = paidAmount != null ? Number(paidAmount) : Number(invoice.totalAmount || 0);

      // Step 1 - Update invoice as paid
      const updateData = {
        paymentStatus: "paid",
        paidDate,
        paidAmount: finalAmount,
        paymentNote: note || "",
        paymentMarkedAt: new Date().toISOString(),
        paymentMarkedBy: request.auth.uid,
      };
      await invoiceRef.set(updateData, { merge: true });
      logger.info("markinvoicepaid: marked", { invoiceId, finalAmount, paidDate });

      let receipt = null;

      // Step 2 - Create receipt in Morning if requested
      if (createReceipt) {
        if (!invoice.gardenName) throw new HttpsError("failed-precondition", "Invoice missing gardenName");
        const gardensDoc = await admin.firestore().collection("meta").doc("gardens").get();
        const allGardens = gardensDoc.exists ? gardensDoc.data().items || [] : [];
        const garden = allGardens.find((g) => (typeof g === "string" ? g : g.name) === invoice.gardenName);
        if (!garden || !garden.morningClientId) {
          throw new HttpsError("failed-precondition", "Garden missing Morning client ID");
        }

        const monthParts = String(invoice.month || "").split("-");
        const monthName = monthParts.length === 2 ? HE_MONTHS_M[parseInt(monthParts[1]) - 1] : "";
        const description = "תשלום עבור חשבונית מס׳ " + (invoice.morningDocNumber || invoice.id) +
          " - חוגי בייביז לחודש " + monthName + " " + (monthParts[0] || "");

        const token = await morningAuth(morningApiKeyId.value(), morningApiSecret.value());

        const payload = {
          type: 320, // חשבונית מס/קבלה
          date: paidDate,
          lang: "he",
          currency: "ILS",
          vatType: 0,
          client: { id: String(garden.morningClientId) },
          income: [
            {
              description,
              quantity: 1,
              price: Number(invoice.totalAmount || finalAmount),
              currency: "ILS",
              vatType: 0,
            },
          ],
          payment: [
            {
              date: paidDate,
              price: finalAmount,
              type: 4, // bank transfer
            },
          ],
          remarks: "מבוסס על חשבון עסקה מס׳ " + (invoice.morningDocNumber || "") +
            (note ? " | " + note : ""),
        };

        const response = await fetch(`${MORNING_API_BASE}/documents`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });
        const respText = await response.text();
        let result;
        try { result = JSON.parse(respText); } catch (e) { result = { raw: respText }; }

        if (!response.ok || result.errorCode) {
          const errMsg = result.errorMessage || result.message || "HTTP " + response.status;
          throw new HttpsError("internal", "Morning שגיאה ביצירת קבלה: " + errMsg);
        }

        receipt = {
          id: result.id || null,
          number: result.number || result.documentNumber || null,
          type: result.type != null ? Number(result.type) : 320,
          url: result.url ? (result.url.he || result.url.origin || null) : null,
        };

        await invoiceRef.set({
          receiptCreated: true,
          receiptId: receipt.id,
          receiptDocNumber: receipt.number,
          receiptDocType: receipt.type,
          receiptDocUrl: receipt.url,
          receiptCreatedAt: new Date().toISOString(),
        }, { merge: true });

        logger.info("markinvoicepaid: receipt created", { invoiceId, receiptNumber: receipt.number });
      }

      // Step 3 - Send via WhatsApp if requested
      let whatsappResult = null;
      if (sendWhatsApp && receipt && receipt.url) {
        try {
          const gardensDoc = await admin.firestore().collection("meta").doc("gardens").get();
          const allGardens = gardensDoc.exists ? gardensDoc.data().items || [] : [];
          const garden = allGardens.find((g) => (typeof g === "string" ? g : g.name) === invoice.gardenName);
          if (garden && garden.phone) {
            const phone = normalizePhoneIntl(garden.phone);
            const monthParts = String(invoice.month || "").split("-");
            const monthNames = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
            const monthName = monthParts.length === 2 ? monthNames[parseInt(monthParts[1]) - 1] + " " + monthParts[0] : "";

            const phoneId = String(whatsappPhoneNumberId.value()).trim();
            const token = String(whatsappAccessToken.value()).trim();
            const payload = {
              messaging_product: "whatsapp",
              to: phone,
              type: "template",
              template: {
                name: "invoice_notification",
                language: { code: "he" },
                components: [
                  {
                    type: "header",
                    parameters: [{
                      type: "document",
                      document: { link: receipt.url, filename: "קבלה_" + receipt.number + ".pdf" },
                    }],
                  },
                  {
                    type: "body",
                    parameters: [
                      { type: "text", text: invoice.gardenName },
                      { type: "text", text: "חשבונית מס/קבלה" },
                      { type: "text", text: String(receipt.number || "") },
                      { type: "text", text: monthName },
                      { type: "text", text: String(invoice.totalAmount || finalAmount) },
                    ],
                  },
                ],
              },
            };

            const waUrl = `${WHATSAPP_API_BASE}/${phoneId}/messages`;
            const waResp = await fetch(waUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify(payload),
            });
            const waText = await waResp.text();
            let waJson;
            try { waJson = JSON.parse(waText); } catch (e) { waJson = { raw: waText }; }

            if (waResp.ok && !waJson.error) {
              const msgId = waJson.messages && waJson.messages[0] && waJson.messages[0].id;
              await trackWaUsage(currentMonthKey());
              await invoiceRef.set({
                receiptWhatsappSent: true,
                receiptWhatsappSentAt: new Date().toISOString(),
                receiptWhatsappMessageId: msgId,
              }, { merge: true });
              whatsappResult = { success: true, messageId: msgId };
            } else {
              whatsappResult = { success: false, error: (waJson.error && waJson.error.message) || "Failed" };
              logger.warn("markinvoicepaid: whatsapp send failed", whatsappResult);
            }
          } else {
            whatsappResult = { success: false, error: "אין טלפון לגן" };
          }
        } catch (e) {
          logger.error("markinvoicepaid: whatsapp send error", { error: e.message });
          whatsappResult = { success: false, error: e.message };
        }
      }

      return {
        success: true,
        invoiceId,
        paid: true,
        receipt,
        whatsapp: whatsappResult,
      };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("markinvoicepaid: UNCAUGHT", { message: err.message, stack: err.stack });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * ===========================================================================
 * Tasks (Project + Per-Conversation)
 * ===========================================================================
 * Stored in 'tasks' collection. Project tasks have conversationPhone="".
 * Per-conversation tasks have conversationPhone set to the phone number.
 */

exports.listtasks = onCall(
  { region: "us-central1", timeoutSeconds: 10 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { conversationPhone } = request.data || {};
      let query = admin.firestore().collection("tasks");
      if (conversationPhone != null) {
        query = query.where("conversationPhone", "==", String(conversationPhone || ""));
      }
      const snap = await query.limit(500).get();
      const tasks = [];
      snap.forEach((d) => tasks.push(d.data()));
      // Sort: in-progress first, then pending, then completed; within each by priority then createdAt desc
      const statusOrder = { "in_progress": 0, "pending": 1, "completed": 2 };
      const priorityOrder = { "high": 0, "normal": 1, "low": 2 };
      tasks.sort((a, b) => {
        const sa = statusOrder[a.status] ?? 1;
        const sb = statusOrder[b.status] ?? 1;
        if (sa !== sb) return sa - sb;
        const pa = priorityOrder[a.priority] ?? 1;
        const pb = priorityOrder[b.priority] ?? 1;
        if (pa !== pb) return pa - pb;
        return Number(b.createdAt || 0) - Number(a.createdAt || 0);
      });
      return { tasks };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

exports.addtask = onCall(
  { region: "us-central1", timeoutSeconds: 10 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { title, description, priority, dueDate, conversationPhone } = request.data || {};
      if (!title || !String(title).trim()) throw new HttpsError("invalid-argument", "Title required");
      const id = Date.now() + "_" + Math.random().toString(36).slice(2, 9);
      const task = {
        id,
        title: String(title).trim(),
        description: description ? String(description).trim() : "",
        priority: priority || "normal",
        dueDate: dueDate || null,
        status: "pending",
        conversationPhone: String(conversationPhone || ""),
        createdAt: Date.now(),
        createdBy: request.auth.uid,
        createdByName: callerDoc.data().name || "",
        updatedAt: Date.now(),
      };
      await admin.firestore().collection("tasks").doc(id).set(task);
      return { success: true, task };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

exports.updatetask = onCall(
  { region: "us-central1", timeoutSeconds: 10 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { id, title, description, priority, dueDate, status } = request.data || {};
      if (!id) throw new HttpsError("invalid-argument", "id required");
      const update = { updatedAt: Date.now() };
      if (title != null) update.title = String(title).trim();
      if (description != null) update.description = String(description).trim();
      if (priority != null) update.priority = priority;
      if (dueDate !== undefined) update.dueDate = dueDate;
      if (status != null) {
        update.status = status;
        if (status === "completed") update.completedAt = Date.now();
      }
      await admin.firestore().collection("tasks").doc(id).update(update);
      return { success: true };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

exports.deletetask = onCall(
  { region: "us-central1", timeoutSeconds: 10 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { id } = request.data || {};
      if (!id) throw new HttpsError("invalid-argument", "id required");
      await admin.firestore().collection("tasks").doc(id).delete();
      return { success: true };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * setwhatsappconfig - Update WhatsApp budget config (admin only)
 */
exports.setwhatsappconfig = onCall(
  { region: "us-central1", timeoutSeconds: 15 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { monthlyBudgetUsd, costPerMsgUsd, enabled, blockOnExceed } = request.data || {};
      const update = {};
      if (monthlyBudgetUsd != null) update.monthlyBudgetUsd = Number(monthlyBudgetUsd);
      if (costPerMsgUsd != null) update.costPerMsgUsd = Number(costPerMsgUsd);
      if (enabled != null) update.enabled = !!enabled;
      if (blockOnExceed != null) update.blockOnExceed = !!blockOnExceed;
      update.updatedAt = new Date().toISOString();
      update.updatedBy = request.auth.uid;
      await admin.firestore().collection("meta").doc("whatsapp_config").set(update, { merge: true });
      logger.info("setwhatsappconfig: updated", update);
      return { success: true, config: await getWaConfig() };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("setwhatsappconfig: UNCAUGHT", { message: err.message, stack: err.stack });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);
