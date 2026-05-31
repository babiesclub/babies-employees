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
const { onCall, HttpsError } = require("firebase-functions/v2/https");
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

function buildInvoiceDescription(records, garden) {
  const billingMode = garden.billingMode || "time";
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
      });
      if (!garden.morningClientId) {
        throw new HttpsError("failed-precondition", "Garden has no Morning Client ID: " + gardenName);
      }

      const recordsSnap = await admin.firestore().collection("records").where("garden", "==", gardenName).get();
      const records = [];
      recordsSnap.forEach((d) => {
        const r = d.data();
        if (r.date && r.date.startsWith(month)) records.push(r);
      });
      logger.info("createmorninginvoice: records loaded", { count: records.length, month });
      if (!records.length) {
        throw new HttpsError("not-found", "אין דיווחים לגן '" + gardenName + "' לחודש " + month);
      }

      let total = 0;
      let nullCount = 0;
      records.forEach((r) => {
        const b = calcChargeBaseServer(r, garden);
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
      const description = buildInvoiceDescription(records, garden);

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
