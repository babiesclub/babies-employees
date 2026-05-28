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
  const response = await fetch(`${MORNING_API_BASE}/account/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: apiKeyId, secret: apiSecret }),
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
    if (!garden.morningClientId) {
      throw new HttpsError("failed-precondition", "Garden has no Morning Client ID: " + gardenName);
    }

    const recordsSnap = await admin.firestore().collection("records").where("garden", "==", gardenName).get();
    const records = [];
    recordsSnap.forEach((d) => {
      const r = d.data();
      if (r.date && r.date.startsWith(month)) records.push(r);
    });
    if (!records.length) {
      throw new HttpsError("not-found", "No records for " + gardenName + " in " + month);
    }

    let total = 0;
    let nullCount = 0;
    records.forEach((r) => {
      const b = calcChargeBaseServer(r, garden);
      if (b != null) total += b;
      else nullCount++;
    });
    if (total <= 0) {
      const billingMode = garden.billingMode || "time";
      const hasHistory = Array.isArray(garden.chargeRatesHistory) && garden.chargeRatesHistory.length > 0;
      const hasOldRates = garden.chargeRates && Object.keys(garden.chargeRates).length > 0;
      let reason = "סכום החיוב הוא 0. ";
      if (!hasHistory && !hasOldRates) {
        reason += "אין תעריפי חיוב מוגדרים לגן '" + gardenName + "'. ערכי את הגן והגדירי תעריפים.";
      } else if (billingMode === "per_child") {
        const month2 = month;
        const count = (garden.monthlyChildCounts || {})[month2];
        if (!count) reason += "מודל חיוב 'פר ילד' - לא הוגדר מספר ילדים לחודש " + month2 + " בגן '" + gardenName + "'.";
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
      throw new HttpsError("already-exists", "Invoice already exists for " + gardenName + " in " + month);
    }

    const monthParts = month.split("-");
    const monthName = HE_MONTHS_M[parseInt(monthParts[1]) - 1];
    const description = buildInvoiceDescription(records, garden);

    const token = await morningAuth(morningApiKeyId.value(), morningApiSecret.value());
    const docType = parseInt(docTypeOverride || garden.morningDocType || "305");

    const payload = {
      type: docType,
      date: new Date().toISOString().slice(0, 10),
      lang: "he",
      currency: "ILS",
      vatType: 1,
      client: { id: String(garden.morningClientId) },
      income: [
        {
          description: "חוגי בייביז לחודש " + monthName + " " + monthParts[0] + "\n" + description,
          quantity: 1,
          price: total,
          currency: "ILS",
          vatType: 1,
        },
      ],
      remarks: "הופק אוטומטית ע\"י אפליקציית בייביז · " + monthName + " " + monthParts[0],
    };

    const docResponse = await fetch(`${MORNING_API_BASE}/documents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const docResult = await docResponse.json();
    if (!docResponse.ok || docResult.errorCode) {
      logger.error("Morning create doc failed", { status: docResponse.status, result: docResult });
      throw new HttpsError("internal", "Morning API error: " + (docResult.errorMessage || docResponse.status));
    }

    const invoiceId = Date.now() + Math.floor(Math.random() * 1000);
    const invoiceData = {
      id: invoiceId,
      gardenName,
      month,
      docType,
      morningDocId: docResult.id || null,
      morningDocNumber: docResult.number || null,
      morningDocUrl: docResult.url ? (docResult.url.he || docResult.url.origin || null) : null,
      totalAmount: total,
      vatAmount: +(total * VAT_RATE).toFixed(2),
      recordCount: records.length,
      createdAt: new Date().toISOString(),
      createdBy: callerUid,
      status: "created",
    };
    await admin.firestore().collection("invoices").doc(String(invoiceId)).set(invoiceData);
    logger.info("Morning invoice created", { gardenName, month, morningDocNumber: invoiceData.morningDocNumber });

    return { success: true, invoice: invoiceData };
  }
);
