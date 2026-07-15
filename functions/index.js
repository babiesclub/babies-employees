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

const { onDocumentCreated, onDocumentWritten, onDocumentUpdated } = require("firebase-functions/v2/firestore");
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

// Gmail SMTP for backup emails (set via: firebase functions:secrets:set GMAIL_USER / GMAIL_APP_PASSWORD)
const gmailUser = defineSecret("GMAIL_USER");
const gmailAppPassword = defineSecret("GMAIL_APP_PASSWORD");

// Anthropic API key for AI Assistant
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

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
        const invalidIds = (result.errors && result.errors.invalid_player_ids) || [];
        if (invalidIds.length && data.recipientUid) {
          try {
            const userRef = admin.firestore().collection("users").doc(String(data.recipientUid));
            const userDoc = await userRef.get();
            if (userDoc.exists) {
              const ud = userDoc.data();
              const currentIds = Array.isArray(ud.oneSignalSubscriptionIds) ? ud.oneSignalSubscriptionIds : (ud.oneSignalSubscriptionId ? [ud.oneSignalSubscriptionId] : []);
              const cleaned = currentIds.filter(id => !invalidIds.includes(id));
              if (cleaned.length !== currentIds.length) {
                await userRef.update({
                  oneSignalSubscriptionIds: cleaned,
                  oneSignalSubscriptionId: cleaned[0] || null,
                  oneSignalCleanedAt: new Date().toISOString(),
                });
                logger.info("Pruned invalid subscription IDs", {
                  recipientUid: data.recipientUid,
                  removed: invalidIds.length,
                  remaining: cleaned.length,
                });
              }
            }
          } catch (e) {
            logger.warn("Failed to prune invalid IDs", { error: e.message });
          }
        }
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

// Parses an email field that may contain 1+ emails separated by comma/semicolon.
// Returns array of unique, valid emails.
function parseEmails(emailStr) {
  if (!emailStr) return [];
  const parts = String(emailStr).split(/[,;]/).map((e) => e.trim()).filter(Boolean);
  const valid = parts.filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  return Array.from(new Set(valid));
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

function getEligibleRates(garden, date) {
  let hist = Array.isArray(garden.chargeRatesHistory) ? garden.chargeRatesHistory : [];
  if (!hist.length && garden.chargeRates && Object.keys(garden.chargeRates).length > 0) {
    hist = [{from: "1970-01-01", rates: garden.chargeRates}];
  }
  if (!hist.length) return null;
  let eligible = hist.filter((h) => h.from <= date).sort((a, b) => b.from.localeCompare(a.from));
  if (!eligible.length) eligible = [...hist].sort((a, b) => a.from.localeCompare(b.from));
  return eligible[0].rates || {};
}

/**
 * Build itemized income lines for a Morning invoice.
 * Returns an array of {description, quantity, price, currency, vatType} - one per (date, garden, duration) group.
 * Rules:
 *   per_group: 1 line per date+branch, quantity = total groups, price = perGroup rate
 *   per_child: 1 line per date+branch, quantity = children count, price = perChild rate
 *   time:      1 line per date+branch+duration, quantity = visits × (duration/30), price = rate / (duration/30)
 *              (rate per half-hour unit; e.g. 60 min visit at 700 rate → qty=2, price=350)
 * Network gardens prefix the description with branch name.
 */
function buildInvoiceIncomeLines(records, garden, networkBranches, opts) {
  const isNetwork = Array.isArray(networkBranches) && networkBranches.length > 1;
  const gardenByName = new Map();
  if (isNetwork) networkBranches.forEach((g) => gardenByName.set(g.name, g));

  const grouped = {};
  records.forEach((r) => {
    const recGarden = gardenByName.get(r.garden) || garden;
    const bm = recGarden.billingMode || "time";
    let key;
    if (bm === "time") key = r.date + "|" + r.garden + "|" + (r.duration || "0");
    else key = r.date + "|" + r.garden;
    if (!grouped[key]) {
      grouped[key] = {date: r.date, garden: r.garden, gardenObj: recGarden, billingMode: bm, duration: r.duration, records: []};
    }
    grouped[key].records.push(r);
  });

  const sortedKeys = Object.keys(grouped).sort();
  const lines = [];
  for (const key of sortedKeys) {
    const g = grouped[key];
    const dParts = (g.date || "").split("-");
    const dateStr = dParts.length === 3 ? (dParts[2] + "/" + dParts[1] + "/" + dParts[0]) : g.date;
    const branchPrefix = isNetwork ? ((g.gardenObj.branchName || g.garden) + " · ") : "";
    const rates = getEligibleRates(g.gardenObj, g.date);
    if (!rates) continue;

    if (g.billingMode === "per_group") {
      const totalGroups = g.records.reduce((s, r) => s + (parseFloat(r.groups) || 0), 0);
      const rate = Number(rates.perGroup) || 0;
      if (rate <= 0 || totalGroups <= 0) continue;
      lines.push({
        description: branchPrefix + dateStr + " (פר קבוצה)",
        quantity: totalGroups,
        price: rate,
        currency: "ILS",
        vatType: 0,
      });
    } else if (g.billingMode === "per_child") {
      const month = g.date.slice(0, 7);
      const childCount = ((g.gardenObj.monthlyChildCounts || {})[month]) || 0;
      const rate = Number(rates.perChild) || 0;
      if (rate <= 0 || childCount <= 0) continue;
      // One line per record (multiple visits same day → multiple lines)
      for (const r of g.records) {
        lines.push({
          description: branchPrefix + dateStr + " · " + childCount + " ילדים",
          quantity: childCount,
          price: rate,
          currency: "ILS",
          vatType: 0,
        });
      }
    } else {
      // time mode
      const dur = Number(g.duration) || 0;
      if (dur <= 0) continue;
      const halfHours = dur / 30;
      // Get rate for this duration
      const exact = Number(rates[String(dur)]) || 0;
      let ratePerVisit;
      if (exact > 0) {
        ratePerVisit = exact;
      } else {
        // Fallback: pro-rate from smallest valid rate
        const validKeys = Object.keys(rates)
          .filter((k) => !isNaN(Number(k)) && rates[k] && Number(rates[k]) > 0)
          .sort((a, b) => Number(a) - Number(b));
        if (!validKeys.length) continue;
        const baseRate = Number(rates[validKeys[0]]);
        ratePerVisit = baseRate * (dur / Number(validKeys[0]));
      }
      const pricePerHalfHour = +(ratePerVisit / halfHours).toFixed(4);
      const totalHalfHours = +(g.records.length * halfHours).toFixed(2);
      lines.push({
        description: branchPrefix + dateStr + " · פעילות בת " + dur + " דק'",
        quantity: totalHalfHours,
        price: pricePerHalfHour,
        currency: "ILS",
        vatType: 0,
      });
    }
  }
  // For NETWORK invoices — aggregate all detailed lines into ONE clean line.
  // "Network" here means the garden belongs to a network (garden.networkName is set)
  // OR the invoice is filtered by afterSchoolType — both cases benefit from the summary
  // format regardless of how many branches remain after filtering.
  const belongsToNetwork = !!(garden && garden.networkName);
  const isAsrTyped = !!(opts && opts.afterSchoolType);
  const shouldAggregate = (isNetwork || belongsToNetwork || isAsrTyped) && lines.length > 0;
  if (shouldAggregate) {
    const totalAmount = lines.reduce((s, l) => s + (Number(l.quantity) * Number(l.price)), 0);
    // Quantity: sum of `groups` field on records (with fallback to 1 per record)
    const totalGroups = records.reduce((s, r) => s + (parseInt(r.groups) || 1), 0);
    if (totalGroups <= 0 || totalAmount <= 0) return lines; // safety fallback
    const unitPrice = +(totalAmount / totalGroups).toFixed(4);
    const asrType = opts && opts.afterSchoolType;
    const ASR_LBL = { tzaharon: "צהרונים", talan: 'תל"ן', nivkharot: "נבחרות" };
    const typeLabel = asrType && ASR_LBL[asrType] ? ASR_LBL[asrType] : "";
    const description = "חוג חיות" + (typeLabel ? " · " + typeLabel : "");
    return [{
      description,
      catalogNum: "חיות",
      quantity: totalGroups,
      price: unitPrice,
      currency: "ILS",
      vatType: 0,
    }];
  }
  return lines;
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
  let eligible = history.filter((h) => h.from <= date).sort((a, b) => b.from.localeCompare(a.from));
  if (!eligible.length) {
    // Fallback (match client): if no rate is eligible because date is BEFORE all rate
    // effective dates, use the EARLIEST rate. This prevents records made before the rate
    // was set up from being silently dropped from invoices.
    if (!history.length) return null;
    eligible = [...history].sort((a, b) => a.from.localeCompare(b.from));
  }
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
      const afterSchoolType = data.afterSchoolType || null; // 'tzaharon' | 'talan' | 'nivkharot' | null
      const ASR_TYPE_LABELS = { tzaharon: "צהרונים", talan: 'תל"ן', nivkharot: "נבחרות" };
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
      let networkBranches = garden.networkName
        ? allGardens.filter((g) => typeof g === "object" && g.networkName === garden.networkName)
        : [garden];
      if (afterSchoolType) {
        networkBranches = networkBranches.filter((g) => g && g.afterSchoolType === afterSchoolType);
        if (!networkBranches.length) {
          throw new HttpsError("not-found", "אין סניפים מסווגים כ-" + (ASR_TYPE_LABELS[afterSchoolType] || afterSchoolType) + " ברשת " + (garden.networkName || gardenName));
        }
      }
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

      let existingInvoiceQuery = admin.firestore()
        .collection("invoices")
        .where("gardenName", "==", gardenName)
        .where("month", "==", month)
        .where("status", "==", "created");
      if (afterSchoolType) {
        existingInvoiceQuery = existingInvoiceQuery.where("afterSchoolType", "==", afterSchoolType);
      }
      const existingInvoiceSnap = await existingInvoiceQuery.limit(1).get();
      // When creating without a type filter, ignore any pre-existing type-specific invoices
      const existingCandidates = existingInvoiceSnap.docs.filter((d) => {
        const inv = d.data();
        if (afterSchoolType) return inv.afterSchoolType === afterSchoolType;
        return !inv.afterSchoolType;
      });
      if (existingCandidates.length) {
        const existing = existingCandidates[0].data();
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

      logger.info("createmorninginvoice: calling morningAuth");
      const token = await morningAuth(morningApiKeyId.value(), morningApiSecret.value());
      logger.info("createmorninginvoice: morningAuth OK, got token len=" + (token ? token.length : 0));

      const docType = parseInt(docTypeOverride || garden.morningDocType || "300");

      // === Build itemized income lines (one per date / per branch / per duration) ===
      const incomeLines = buildInvoiceIncomeLines(records, garden, networkBranches, { afterSchoolType });
      const itemizedTotal = +incomeLines.reduce((s, l) => s + (Number(l.quantity) * Number(l.price)), 0).toFixed(2);
      logger.info("createmorninginvoice: itemized lines built", { count: incomeLines.length, itemizedTotal, summedTotal: total });
      if (!incomeLines.length) {
        throw new HttpsError("failed-precondition", "לא נבנו שורות חיוב — בדקי שתעריפים מוגדרים לתאריכים שדווחו.");
      }

      // vatType in Morning API:
      //   0 = REGULAR (default - VAT 18% added on top of price)
      //   1 = EXEMPT (no VAT - פטור)
      //   2 = INCLUDED (price already includes VAT)
      const gardenEmails = parseEmails(garden.email);
      const clientObj = { id: String(garden.morningClientId) };
      if (gardenEmails.length > 0) {
        clientObj.emails = gardenEmails;
      }
      const _reqDate = data.documentDate;
      const _docDate = (typeof _reqDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(_reqDate))
        ? _reqDate
        : new Date().toISOString().slice(0, 10);
      const typeSuffix = afterSchoolType ? " · " + (ASR_TYPE_LABELS[afterSchoolType] || afterSchoolType) : "";
      // Detect if the requested date is BEFORE today (any past date) — if so,
      // enable Morning's "skipDateValidation" flag so past-dated documents are
      // accepted. The threshold is deliberately generous: any date not-today.
      const _todayStr = new Date().toISOString().slice(0, 10);
      const _needsBackdate = _docDate < _todayStr;
      const _daysAgo = (new Date(_todayStr).getTime() - new Date(_docDate).getTime()) / 86400000;
      const payload = {
        type: docType,
        description: "חוגי בייביז" + typeSuffix + " · " + monthName + " " + monthParts[0],
        date: _docDate,
        lang: "he",
        currency: "ILS",
        vatType: 0,
        client: clientObj,
        income: incomeLines,
        remarks: "הופק אוטומטית ע\"י אפליקציית בייביז" + typeSuffix + " · " + monthName + " " + monthParts[0],
      };
      if (_needsBackdate) {
        // skipDateValidation = the field the Morning UI sends when the user enables
        // the toggle "הפקת מסמך לתאריך מוקדם יותר". Discovered by inspecting the
        // Network payload from the real Morning UI on 2026-07-05.
        payload.skipDateValidation = true;
        logger.info("createmorninginvoice: skipDateValidation enabled for backdated document", { daysAgo: _daysAgo, docDate: _docDate });
      }
      logger.info("createmorninginvoice: posting to Morning", { docType, total, clientId: garden.morningClientId, willEmailTo: gardenEmails });

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
      // Morning returns two URL variants under `url`. `origin` is the direct customer
      // viewer link (no login). `he` sometimes redirects into the admin panel and
      // requires login. Prefer origin so WA/email links open the doc immediately.
      const docUrl = docResult.url ? (docResult.url.origin || docResult.url.he || null) : null;
      logger.info("createmorninginvoice: docResult.url shape", { url: docResult.url, chosen: docUrl });
      const morningActualType = docResult.type != null ? Number(docResult.type) : null;
      let emailedTo = null;
      if (gardenEmails.length > 0 && docResult.id) {
        try {
          const distResponse = await fetch(`${MORNING_API_BASE}/documents/${docResult.id}/distribute`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              to: gardenEmails,
              subject: "חשבונית חוגי בייביז - " + gardenName + " - " + monthName + " " + monthParts[0],
              body: "שלום,\n\nמצורפת חשבונית עבור " + gardenName + " לחודש " + monthName + " " + monthParts[0] + ".\n\nבברכה,\nבייביז קלאב",
            }),
          });
          if (distResponse.ok) {
            emailedTo = gardenEmails.join(", ");
            logger.info("createmorninginvoice: email sent successfully to " + emailedTo);
          } else {
            const distText = await distResponse.text();
            logger.warn("createmorninginvoice: email distribution failed", { status: distResponse.status, body: distText.slice(0, 200), to: gardenEmails });
          }
        } catch (e) {
          logger.warn("createmorninginvoice: email distribution error", { error: String(e && e.message || e) });
        }
      }

      const invoiceId = Date.now() + Math.floor(Math.random() * 1000);
      const invoiceData = {
        id: invoiceId,
        gardenName,
        month,
        docType,
        documentDate: _docDate,
        morningActualType: morningActualType,
        morningDocId: docResult.id || null,
        morningDocNumber: docNumber,
        morningDocUrl: docUrl,
        totalAmount: itemizedTotal,
        vatAmount: +(itemizedTotal * VAT_RATE).toFixed(2),
        recordCount: records.length,
        lineItemCount: incomeLines.length,
        createdAt: new Date().toISOString(),
        createdBy: callerUid,
        emailedTo,
        status: "created",
        // Network metadata
        isNetwork,
        networkName: garden.networkName || null,
        branchNames: isNetwork ? allBranchNames : null,
        afterSchoolType: afterSchoolType || null,
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
 * Cancel an existing Morning document. Behaviour depends on document type:
 *
 *   - חשבון עסקה / פרופורמה (type 300) — proforma is NOT a tax document, so we
 *     must NOT issue a credit note (a credit note is legally a reversal of a tax
 *     invoice). Instead we call Morning's POST /documents/{id}/close endpoint
 *     to manually mark it as closed. No new document is created in Morning.
 *
 *   - חשבונית מס (type 305) — legally a tax document, so cancellation REQUIRES
 *     issuing a חשבונית זיכוי (type 330) linked to the original. This preserves
 *     the previous behaviour.
 *
 * In both cases we mark the local invoices/{id} record as cancelled with
 * cancelledAt / cancelledBy metadata. For 305 we also store creditNote*
 * fields; for 300 those fields stay null.
 *
 * Input: { invoiceId: string|number }
 * Notes:
 *   - Refuses if the invoice is already cancelled or missing morningDocId.
 *   - Credit note (for 305) is dated today — Israeli tax convention.
 */
exports.cancelmorninginvoice = onCall(
  {
    secrets: [morningApiKeyId, morningApiSecret],
    region: "us-central1",
    timeoutSeconds: 60,
  },
  async (request) => {
    try {
      logger.info("cancelmorninginvoice: START", { data: request.data, uid: request.auth && request.auth.uid });
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "Must be logged in");
      }
      const callerUid = request.auth.uid;
      const callerDoc = await admin.firestore().collection("users").doc(callerUid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }

      const invoiceId = (request.data && request.data.invoiceId) ? String(request.data.invoiceId) : "";
      if (!invoiceId) {
        throw new HttpsError("invalid-argument", "חסר invoiceId");
      }

      const invRef = admin.firestore().collection("invoices").doc(invoiceId);
      const invSnap = await invRef.get();
      if (!invSnap.exists) {
        throw new HttpsError("not-found", "החשבונית לא נמצאה במערכת המקומית (invoiceId=" + invoiceId + ")");
      }
      const invoice = invSnap.data();
      logger.info("cancelmorninginvoice: invoice loaded", {
        id: invoice.id,
        gardenName: invoice.gardenName,
        month: invoice.month,
        status: invoice.status,
        morningDocId: invoice.morningDocId,
        morningDocNumber: invoice.morningDocNumber,
      });

      if (!invoice.morningDocId) {
        throw new HttpsError("failed-precondition", "לחשבונית זו אין morningDocId — לא ניתן לבטל אותה במורנינג");
      }
      if (invoice.status === "cancelled") {
        throw new HttpsError("failed-precondition", "החשבונית כבר בוטלה ב-" + (invoice.cancelledAt || "תאריך לא ידוע"));
      }
      const docTypeNum = Number(invoice.morningActualType || invoice.docType || 300);
      // 300 = חשבון עסקה (proforma, NOT a tax document — close only, no credit note)
      // 305 = חשבונית מס (tax invoice — legally requires a credit note reversal)
      // Other types (320 receipt-invoice, 400 receipt) need a different flow.
      if (docTypeNum !== 305 && docTypeNum !== 300) {
        throw new HttpsError(
          "failed-precondition",
          "לא ניתן לבטל מסמך מסוג " + docTypeNum + ". רק חשבון עסקה (300) או חשבונית מס (305) נתמכים."
        );
      }

      logger.info("cancelmorninginvoice: calling morningAuth", { docTypeNum });
      const token = await morningAuth(morningApiKeyId.value(), morningApiSecret.value());
      logger.info("cancelmorninginvoice: morningAuth OK");

      const nowIso = new Date().toISOString();

      // ==========================================================================
      // BRANCH A — חשבון עסקה (300): POST /documents/{id}/close
      // No credit note is issued. Morning marks the proforma as "manually closed".
      // ==========================================================================
      if (docTypeNum === 300) {
        logger.info("cancelmorninginvoice: closing proforma via /close endpoint", {
          morningDocId: invoice.morningDocId,
        });
        const closeResp = await fetch(
          `${MORNING_API_BASE}/documents/${encodeURIComponent(invoice.morningDocId)}/close`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          }
        );
        const closeText = await closeResp.text();
        let closeResult;
        try { closeResult = JSON.parse(closeText); } catch (e) { closeResult = { raw: closeText }; }
        logger.info("cancelmorninginvoice: Morning close response", {
          status: closeResp.status,
          result: closeResult,
        });

        // Morning returns 200/204 on success. If the document is already closed
        // Morning returns errorCode ~ "document not in open status".
        if (!closeResp.ok || (closeResult && closeResult.errorCode)) {
          const msg = (closeResult && (closeResult.errorMessage || closeResult.message)) ||
                      ("HTTP " + closeResp.status + ": " + closeText.slice(0, 200));
          throw new HttpsError("internal", "מורנינג סירבה לסגור את חשבון העסקה: " + msg);
        }

        const updates = {
          status: "cancelled",
          cancelledAt: nowIso,
          cancelledBy: callerUid,
          // Explicitly null credit-note fields so downstream code (UI) knows
          // no credit note exists for this cancellation.
          creditNoteDocId: null,
          creditNoteDocNumber: null,
          creditNoteDocUrl: null,
        };
        await invRef.update(updates);
        logger.info("cancelmorninginvoice: SUCCESS (proforma closed, no credit note)", {
          invoiceId,
          morningDocId: invoice.morningDocId,
        });

        return {
          success: true,
          invoiceId,
          docType: 300,
          closedInMorning: true,
          creditNoteDocId: null,
          creditNoteDocNumber: null,
          creditNoteDocUrl: null,
          cancelledAt: nowIso,
        };
      }

      // ==========================================================================
      // BRANCH B — חשבונית מס (305): issue חשבונית זיכוי (330) linked to original.
      // This is the ORIGINAL behaviour, unchanged, since tax law requires a
      // credit-note reversal — you cannot just "close" a tax invoice.
      // ==========================================================================

      // Rebuild income lines from the original invoice. We need the original
      // client id + income breakdown. Simplest approach: fetch the original
      // doc from Morning to preserve exact line structure.
      const origResp = await fetch(`${MORNING_API_BASE}/documents/${encodeURIComponent(invoice.morningDocId)}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      const origText = await origResp.text();
      let origDoc;
      try { origDoc = JSON.parse(origText); } catch (e) { origDoc = { raw: origText }; }
      logger.info("cancelmorninginvoice: Morning GET original doc", { status: origResp.status, docType: origDoc && origDoc.type, number: origDoc && origDoc.number });
      if (!origResp.ok || origDoc.errorCode) {
        const msg = origDoc.errorMessage || origDoc.message || ("HTTP " + origResp.status + ": " + origText.slice(0, 200));
        throw new HttpsError("internal", "לא הצלחתי לטעון את המסמך המקורי ממורנינג: " + msg);
      }

      const origIncome = Array.isArray(origDoc.income) ? origDoc.income : [];
      if (!origIncome.length) {
        throw new HttpsError("internal", "המסמך המקורי במורנינג נטען אך אין בו שורות הכנסה. לא ניתן לבנות חשבונית זיכוי אוטומטית.");
      }

      // Build credit note lines: SAME positive quantity/price as original.
      // The document type 330 (חשבונית זיכוי) is itself the reversal — Morning
      // API validates quantity > 0, so negative quantities are rejected.
      const creditLines = origIncome.map((ln) => {
        const qty = Number(ln.quantity != null ? ln.quantity : 1);
        return {
          description: ln.description || "ביטול",
          quantity: Math.abs(qty),
          price: Number(ln.price != null ? ln.price : 0),
          currency: ln.currency || "ILS",
          vatType: ln.vatType != null ? ln.vatType : 0,
        };
      });

      const clientObj = (origDoc.client && origDoc.client.id)
        ? { id: String(origDoc.client.id) }
        : { id: String(invoice.morningClientId || "") };

      const todayStr = new Date().toISOString().slice(0, 10);
      const origNumber = origDoc.number || invoice.morningDocNumber || "";
      const remarksTxt = "ביטול חשבונית #" + origNumber + " (הופק אוטומטית ע\"י אפליקציית בייביז)";

      const creditPayload = {
        type: 330, // חשבונית זיכוי
        description: "ביטול חשבונית #" + origNumber,
        date: todayStr,
        lang: "he",
        currency: origDoc.currency || "ILS",
        vatType: origDoc.vatType != null ? origDoc.vatType : 0,
        client: clientObj,
        income: creditLines,
        linkedDocumentIds: [invoice.morningDocId],
        remarks: remarksTxt,
      };
      logger.info("cancelmorninginvoice: posting credit note to Morning", {
        linkedTo: invoice.morningDocId,
        origNumber,
        lineCount: creditLines.length,
      });

      const creditResp = await fetch(`${MORNING_API_BASE}/documents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(creditPayload),
      });
      const creditText = await creditResp.text();
      let creditResult;
      try { creditResult = JSON.parse(creditText); } catch (e) { creditResult = { raw: creditText }; }
      logger.info("cancelmorninginvoice: Morning credit-note response", { status: creditResp.status, result: creditResult });

      if (!creditResp.ok || creditResult.errorCode) {
        const msg = creditResult.errorMessage || creditResult.message || ("HTTP " + creditResp.status + ": " + creditText.slice(0, 200));
        // Common failure mode: original already reversed. Bubble it up in Hebrew.
        throw new HttpsError("internal", "מורנינג סירבה להפיק חשבונית זיכוי: " + msg);
      }

      const creditDocId = creditResult.id || null;
      const creditDocNumber = creditResult.number || creditResult.documentNumber || null;
      const creditDocUrl = creditResult.url ? (creditResult.url.he || creditResult.url.origin || null) : null;

      // ------------------------------------------------------------------------
      // STEP 2 — Close the ORIGINAL tax invoice.
      // linkedDocumentIds on the credit note is not enough — Morning still shows
      // the original as "פתוח" (status 0) even when amountOpened is 0. We must
      // call POST /documents/{origId}/close to flip it to "סגור" (status 2 =
      // Manually Closed). This is best-effort: if it fails, the credit note is
      // already legally issued, so we log a warning and keep going.
      // Verified against Morning API 2026-07 with invoice 50347 / credit 70061:
      // after /close the original showed status:2 and linkedDocuments intact.
      // ------------------------------------------------------------------------
      let originalClosedInMorning = false;
      let originalCloseError = null;
      try {
        const origCloseResp = await fetch(
          `${MORNING_API_BASE}/documents/${encodeURIComponent(invoice.morningDocId)}/close`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          }
        );
        const origCloseText = await origCloseResp.text();
        let origCloseResult;
        try { origCloseResult = JSON.parse(origCloseText); } catch (e) { origCloseResult = { raw: origCloseText }; }
        logger.info("cancelmorninginvoice: Morning close-original response", {
          status: origCloseResp.status,
          resultStatus: origCloseResult && origCloseResult.status,
          errorCode: origCloseResult && origCloseResult.errorCode,
        });
        if (origCloseResp.ok && !(origCloseResult && origCloseResult.errorCode)) {
          originalClosedInMorning = true;
        } else {
          originalCloseError = (origCloseResult && (origCloseResult.errorMessage || origCloseResult.message)) ||
                               ("HTTP " + origCloseResp.status + ": " + origCloseText.slice(0, 200));
          logger.warn("cancelmorninginvoice: original tax invoice close failed (credit note already issued)", {
            morningDocId: invoice.morningDocId,
            error: originalCloseError,
          });
        }
      } catch (closeErr) {
        originalCloseError = closeErr.message || String(closeErr);
        logger.warn("cancelmorninginvoice: original tax invoice close threw (credit note already issued)", {
          morningDocId: invoice.morningDocId,
          error: originalCloseError,
        });
      }

      const updates = {
        status: "cancelled",
        cancelledAt: nowIso,
        cancelledBy: callerUid,
        creditNoteDocId: creditDocId,
        creditNoteDocNumber: creditDocNumber,
        creditNoteDocUrl: creditDocUrl,
        originalClosedInMorning,
      };
      if (originalCloseError) updates.originalCloseError = originalCloseError;
      await invRef.update(updates);
      logger.info("cancelmorninginvoice: SUCCESS (tax invoice reversed via credit note)", {
        invoiceId,
        creditDocNumber,
        creditDocId,
        originalClosedInMorning,
      });

      return {
        success: true,
        invoiceId,
        docType: 305,
        creditNoteDocId: creditDocId,
        creditNoteDocNumber: creditDocNumber,
        creditNoteDocUrl: creditDocUrl,
        originalClosedInMorning,
        originalCloseError,
        cancelledAt: nowIso,
      };
    } catch (err) {
      if (err instanceof HttpsError) {
        logger.warn("cancelmorninginvoice: HttpsError", { code: err.code, message: err.message });
        throw err;
      }
      logger.error("cancelmorninginvoice: UNCAUGHT", { message: err.message, stack: err.stack, name: err.name });
      throw new HttpsError("internal", "שגיאה לא צפויה: " + (err.message || String(err)));
    }
  }
);

/**
 * Refresh morningDocUrl for ALL invoices that have morningDocId — fetches each
 * doc from Morning API and stores the current customer-facing url.origin.
 * Fixes invoices created before we switched preference away from url.he
 * (which redirected into the admin panel and required login).
 */
exports.refreshallinvoiceurls = onCall(
  {
    secrets: [morningApiKeyId, morningApiSecret],
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }

      const snap = await admin.firestore().collection("invoices").get();
      const toRefresh = [];
      snap.forEach((d) => {
        const v = d.data();
        if (v.morningDocId && v.status !== "cancelled") {
          toRefresh.push({
            id: d.id,
            morningDocId: v.morningDocId,
            currentUrl: v.morningDocUrl || null,
          });
        }
      });
      logger.info("refreshallinvoiceurls: START", { total: toRefresh.length });

      if (toRefresh.length === 0) return { total: 0, updated: 0, unchanged: 0, failed: 0, errors: [] };

      const token = await morningAuth(morningApiKeyId.value(), morningApiSecret.value());

      let updated = 0;
      let unchanged = 0;
      let failed = 0;
      const errors = [];
      let didProbe = false;

      for (const inv of toRefresh) {
        try {
          const resp = await fetch(`${MORNING_API_BASE}/documents/${inv.morningDocId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!resp.ok) {
            const errText = await resp.text();
            failed++;
            errors.push({ id: inv.id, morningDocId: inv.morningDocId, status: resp.status, body: errText.slice(0, 150) });
            continue;
          }
          const data = await resp.json();
          if (!didProbe) {
            didProbe = true;
            const urlKeys = Object.keys(data).filter((k) => /url|link|share|pdf/i.test(k));
            const urlSubKeys = data.url && typeof data.url === "object" ? Object.keys(data.url) : [];
            logger.info("refreshallinvoiceurls: PROBE first doc", {
              morningDocId: inv.morningDocId,
              urlObject: data.url,
              urlSubKeys,
              topLevelUrlishKeys: urlKeys.reduce((acc, k) => { acc[k] = data[k]; return acc; }, {}),
              status: data.status,
              type: data.type,
              number: data.number,
            });
          }
          const newUrl = data.url ? (data.url.origin || data.url.he || null) : null;
          if (!newUrl) {
            failed++;
            errors.push({ id: inv.id, morningDocId: inv.morningDocId, reason: "no-url-in-response" });
            continue;
          }
          if (newUrl === inv.currentUrl) {
            unchanged++;
            continue;
          }
          await admin.firestore().collection("invoices").doc(inv.id).update({
            morningDocUrl: newUrl,
            morningDocUrlRefreshedAt: new Date().toISOString(),
            morningDocUrlRefreshedBy: request.auth.uid,
          });
          updated++;
        } catch (e) {
          failed++;
          errors.push({ id: inv.id, morningDocId: inv.morningDocId, error: String(e && e.message || e).slice(0, 150) });
        }
      }

      logger.info("refreshallinvoiceurls: DONE", { total: toRefresh.length, updated, unchanged, failed });
      return { total: toRefresh.length, updated, unchanged, failed, errors: errors.slice(0, 20) };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("refreshallinvoiceurls failed", err);
      throw new HttpsError("internal", err.message || String(err));
    }
  }
);

/**
 * Resend a Morning invoice by email (admin only).
 * Uses Morning's /documents/{id}/distribute endpoint to trigger the email again,
 * either to the garden's saved emails or to a custom list provided by the caller.
 */
exports.resendmorninginvoiceemail = onCall(
  {
    secrets: [morningApiKeyId, morningApiSecret],
    region: "us-central1",
    timeoutSeconds: 30,
  },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerUid = request.auth.uid;
      const callerDoc = await admin.firestore().collection("users").doc(callerUid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }

      const invoiceId = (request.data && request.data.invoiceId) ? String(request.data.invoiceId) : "";
      const overrideEmails = Array.isArray(request.data && request.data.emails) ? request.data.emails : null;
      if (!invoiceId) throw new HttpsError("invalid-argument", "חסר invoiceId");

      const invRef = admin.firestore().collection("invoices").doc(invoiceId);
      const invSnap = await invRef.get();
      if (!invSnap.exists) throw new HttpsError("not-found", "החשבונית לא נמצאה במערכת המקומית");
      const invoice = invSnap.data();

      if (!invoice.morningDocId) {
        throw new HttpsError("failed-precondition", "לחשבונית זו אין morningDocId — לא ניתן לשלוח באימייל דרך Morning. אולי זו חשבונית שנקלטה ידנית?");
      }

      let emails = [];
      if (overrideEmails && overrideEmails.length > 0) {
        emails = overrideEmails
          .map((e) => String(e).trim())
          .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      } else {
        const gardensDoc = await admin.firestore().collection("meta").doc("gardens").get();
        let garden = null;
        if (gardensDoc.exists) {
          const items = gardensDoc.data().items || [];
          garden = items.find((g) => (typeof g === "string" ? g : g.name) === invoice.gardenName);
        }
        if (!garden || typeof garden === "string") {
          throw new HttpsError("failed-precondition", "לא נמצא אימייל לגן '" + invoice.gardenName + "'. הכניסי אימייל ידני.");
        }
        emails = parseEmails(garden.email);
      }
      if (emails.length === 0) {
        throw new HttpsError("failed-precondition", "אין אימייל שמור לגן. הכניסי אימייל ידני.");
      }

      const token = await morningAuth(morningApiKeyId.value(), morningApiSecret.value());

      const monthParts = String(invoice.month || "").split("-");
      const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
      const monthName = monthParts[1] ? HE_MONTHS[parseInt(monthParts[1], 10) - 1] : "";

      // Morning /documents/{id}/distribute — exact payload discovered by
      // inspecting the Morning UI's network request on 2026-07-07:
      //   { attachment: false, recipients: ["..."], remarks: "" }
      // Field is `recipients` (not `to`/`email`), array of bare strings.
      const distributePayload = {
        attachment: false,
        recipients: emails,
        remarks: "",
      };
      logger.info("resendmorninginvoiceemail: calling /distribute", { morningDocId: invoice.morningDocId, payload: distributePayload });
      const sendResp = await fetch(`${MORNING_API_BASE}/documents/${invoice.morningDocId}/distribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(distributePayload),
      });
      if (!sendResp.ok) {
        const errText = await sendResp.text();
        logger.warn("resendmorninginvoiceemail: /distribute failed", { status: sendResp.status, body: errText.slice(0, 300), payload: distributePayload });
        throw new HttpsError("internal", "מורנינג החזירה שגיאה: HTTP " + sendResp.status + " · " + errText.slice(0, 200));
      }
      const okEmails = emails;
      const emailedTo = okEmails.join(", ");
      const resentAt = new Date().toISOString();
      await invRef.update({
        emailedTo,
        emailResentAt: resentAt,
        emailResentBy: callerUid,
      });
      logger.info("resendmorninginvoiceemail: SUCCESS", { invoiceId, emailedTo });

      return { success: true, emailedTo, resentAt };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("resendmorninginvoiceemail failed", err);
      throw new HttpsError("internal", err.message || String(err));
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
      const { gardenName, month, afterSchoolType } = request.data || {};
      if (!gardenName || !month) throw new HttpsError("invalid-argument", "gardenName and month required");
      const snap = await admin.firestore().collection("invoices")
        .where("gardenName", "==", gardenName)
        .where("month", "==", month)
        .get();
      if (snap.empty) return { deleted: 0 };
      // Filter by afterSchoolType if provided (delete only that type). If null, delete all matches.
      const toDelete = afterSchoolType
        ? snap.docs.filter(d => d.data().afterSchoolType === afterSchoolType)
        : snap.docs;
      if (!toDelete.length) return { deleted: 0 };
      const batch = admin.firestore().batch();
      toDelete.forEach(d => batch.delete(d.ref));
      await batch.commit();
      logger.info("deletelocalinvoice: deleted", { gardenName, month, afterSchoolType: afterSchoolType || null, count: toDelete.length });
      return { deleted: toDelete.length };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("deletelocalinvoice: UNCAUGHT", { message: err.message, stack: err.stack });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * ============================================================================
 * CUSTOMER LEDGER (כרטסת לקוחות) — admin overview of open balances per garden.
 * ============================================================================
 *
 * getallcustomersledger — fast summary across ALL customers. Reads only from
 *   Firestore /invoices — no Morning API calls, so it's safe to run on every
 *   open of the ledger screen. Returns one row per gardenName with totalDebt,
 *   openInvoicesCount, oldestOpenDate, status.
 *
 * getcustomerledger — drill-down for a single customer. Reads Firestore
 *   /invoices for that garden, optionally fetches historical documents from
 *   Morning (past monthsBack months) so the admin sees invoices issued
 *   BEFORE the app existed. History docs are read-only; marking them paid
 *   writes to /historicalPayments (does NOT touch Morning).
 *
 * markhistoricalinvoicepaid — record a manual "paid" mark for a historical
 *   Morning invoice (one that has no local Firestore /invoices doc). Writes
 *   /historicalPayments/{morningDocId}. Does NOT change anything in Morning.
 */

// In-memory caches (per instance). Cleared when instance recycles.
const _ledgerAllCache = { data: null, at: 0 };
const _ledgerPerGardenCache = new Map(); // key: gardenName -> { data, at }
const _morningDocsPerClientCache = new Map(); // key: morningClientId -> { data, at }
const LEDGER_TTL_MS = 30 * 1000;
const MORNING_DOCS_TTL_MS = 60 * 1000;

// Days threshold for "severely overdue" status.
const SEVERE_OVERDUE_DAYS = 30;

// Compute the effective open balance & status for a Firestore invoice.
// Returns { openBalance, effectiveStatus } where effectiveStatus is one of:
//   'paid' | 'partial' | 'open' | 'cancelled'
function computeInvoiceOpenBalance(inv) {
  const status = inv.status || "created";
  if (status === "cancelled") {
    return { openBalance: 0, effectiveStatus: "cancelled" };
  }
  const paymentStatus = inv.paymentStatus || "unpaid";
  const expected =
    Number(inv.totalAmount || 0) + Number(inv.vatAmount || 0);
  const paid = Number(inv.amountPaid || inv.paidAmount || 0);
  const discount = Number(inv.discountAmount || 0);
  const remaining = Math.max(0, expected - paid - discount);
  if (paymentStatus === "paid") {
    return { openBalance: 0, effectiveStatus: "paid" };
  }
  if (paymentStatus === "partial") {
    return { openBalance: remaining, effectiveStatus: "partial" };
  }
  // Not marked paid at all — full expected is open.
  return { openBalance: expected, effectiveStatus: "open" };
}

// Days between an ISO date (YYYY-MM-DD or ISO string) and now (positive if in past).
function daysSince(isoDate) {
  if (!isoDate) return 0;
  const t = new Date(isoDate).getTime();
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86400000);
}

// Given rows of open invoices, decide the customer-level status.
function customerStatus(openRows) {
  if (!openRows.length) return "current";
  const maxAge = openRows.reduce((mx, r) => Math.max(mx, r.ageDays || 0), 0);
  if (maxAge >= SEVERE_OVERDUE_DAYS) return "overdue_severe";
  return "has_debt";
}

/**
 * Aggregate summary across ALL customers with any open invoice.
 * Response: { customers: [ { gardenName, networkName, totalDebt, openCount, oldestOpenDate, oldestOpenAgeDays, status } ], generatedAt }
 */
exports.getallcustomersledger = onCall(
  { region: "us-central1", timeoutSeconds: 60 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      // 30s cache — the client also caches 5m but a refresh button should be snappy.
      if (_ledgerAllCache.data && (Date.now() - _ledgerAllCache.at) < LEDGER_TTL_MS) {
        return _ledgerAllCache.data;
      }

      // Load all invoices in one shot (collection is bounded — one doc per garden×month).
      const invSnap = await admin.firestore().collection("invoices").get();
      // Also load gardens meta so we can join network names.
      const gardensDoc = await admin.firestore().collection("meta").doc("gardens").get();
      const allGardens = gardensDoc.exists ? (gardensDoc.data().items || []) : [];
      const gardenByName = new Map();
      allGardens.forEach((g) => {
        if (typeof g === "object" && g && g.name) gardenByName.set(g.name, g);
      });

      // Group by gardenName.
      const byGarden = new Map();
      invSnap.forEach((d) => {
        const v = d.data();
        if (!v || !v.gardenName) return;
        const list = byGarden.get(v.gardenName) || [];
        list.push(v);
        byGarden.set(v.gardenName, list);
      });

      const customers = [];
      for (const [gardenName, invoices] of byGarden.entries()) {
        const openRows = [];
        let totalDebt = 0;
        let oldestOpenDate = null;
        for (const inv of invoices) {
          const { openBalance, effectiveStatus } = computeInvoiceOpenBalance(inv);
          if (openBalance <= 0) continue;
          totalDebt += openBalance;
          const dateStr = inv.documentDate || inv.createdAt || null;
          const ageDays = daysSince(dateStr);
          openRows.push({ status: effectiveStatus, openBalance, ageDays, date: dateStr });
          if (!oldestOpenDate || (dateStr && dateStr < oldestOpenDate)) {
            oldestOpenDate = dateStr;
          }
        }
        // Skip customers with zero debt from the "customers" array — the client can
        // still see them via the "all" tab which will fetch differently, but for the
        // default overview we only return those with debt.
        // ACTUALLY: return every customer that has any invoice AT ALL, so the "all"
        // filter can show them. The client filters by tab.
        const g = gardenByName.get(gardenName);
        const networkName = (g && g.networkName) || null;
        customers.push({
          gardenName,
          networkName,
          totalDebt: +totalDebt.toFixed(2),
          openCount: openRows.length,
          invoicesCount: invoices.length,
          oldestOpenDate,
          oldestOpenAgeDays: oldestOpenDate ? daysSince(oldestOpenDate) : 0,
          status: openRows.length ? customerStatus(openRows) : "current",
        });
      }

      // Sort default: highest debt first.
      customers.sort((a, b) => b.totalDebt - a.totalDebt);

      const summary = {
        totalDebt: +customers.reduce((s, c) => s + c.totalDebt, 0).toFixed(2),
        customersWithDebt: customers.filter((c) => c.totalDebt > 0).length,
        largestDebt: customers[0] && customers[0].totalDebt > 0
          ? { gardenName: customers[0].gardenName, amount: customers[0].totalDebt }
          : null,
      };
      const result = { customers, summary, generatedAt: new Date().toISOString() };
      _ledgerAllCache.data = result;
      _ledgerAllCache.at = Date.now();
      return result;
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("getallcustomersledger: UNCAUGHT", { message: err.message, stack: err.stack });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * Drill-down: full invoice/payment history for a single customer.
 *   { gardenName, historyMode?: boolean, monthsBack?: number }
 * Returns:
 *   {
 *     gardenName, networkName, morningClientId,
 *     invoices: [ { source: 'local'|'history', ...unified fields... } ],
 *     summary: { totalOpen, totalPaid, invoiceCount, receiptsCount, creditNotesCount }
 *   }
 * If historyMode=true and the garden has a morningClientId, we ALSO hit
 * Morning /documents/search to pull historical documents up to monthsBack
 * months back (default 12). Documents that already have a matching Firestore
 * /invoices doc (by morningDocId) are merged with the local record. The rest
 * are returned with source='history' and are read-only in the UI.
 */
exports.getcustomerledger = onCall(
  {
    secrets: [morningApiKeyId, morningApiSecret],
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
      const { gardenName, historyMode, monthsBack } = request.data || {};
      if (!gardenName) throw new HttpsError("invalid-argument", "gardenName required");
      const wantHistory = !!historyMode;
      const historyMonths = Math.max(1, Math.min(60, Number(monthsBack) || 12));

      const cacheKey = gardenName + "|" + (wantHistory ? "h" + historyMonths : "n");
      const cached = _ledgerPerGardenCache.get(cacheKey);
      if (cached && (Date.now() - cached.at) < LEDGER_TTL_MS) {
        return cached.data;
      }

      // Load garden meta
      const gardensDoc = await admin.firestore().collection("meta").doc("gardens").get();
      const allGardens = gardensDoc.exists ? (gardensDoc.data().items || []) : [];
      const garden = allGardens.find((g) => (typeof g === "string" ? g : g.name) === gardenName);
      if (!garden || typeof garden !== "object") {
        throw new HttpsError("not-found", "Garden not found: " + gardenName);
      }

      // Load local Firestore invoices for this garden.
      const localSnap = await admin.firestore().collection("invoices")
        .where("gardenName", "==", gardenName).get();
      const localInvoices = [];
      const localByMorningDocId = new Map();
      localSnap.forEach((d) => {
        const v = d.data();
        localInvoices.push(v);
        if (v.morningDocId) localByMorningDocId.set(String(v.morningDocId), v);
      });

      // Optionally load historical documents from Morning.
      let historyDocs = [];
      let historyError = null;
      let historyMode_used = false;
      if (wantHistory && garden.morningClientId) {
        historyMode_used = true;
        try {
          const clientId = String(garden.morningClientId);
          const clientCacheKey = clientId + "|" + historyMonths;
          const clientCache = _morningDocsPerClientCache.get(clientCacheKey);
          let morningDocs;
          if (clientCache && (Date.now() - clientCache.at) < MORNING_DOCS_TTL_MS) {
            morningDocs = clientCache.data;
          } else {
            const token = await morningAuth(morningApiKeyId.value(), morningApiSecret.value());
            const fromDate = new Date();
            fromDate.setMonth(fromDate.getMonth() - historyMonths);
            const fromStr = fromDate.toISOString().slice(0, 10);
            // Morning /documents/search — paginate up to 5 pages of 50 to be safe.
            morningDocs = [];
            for (let page = 0; page < 5; page++) {
              const searchBody = {
                fromDate: fromStr,
                pageSize: 50,
                page,
                sort: "documentDate",
                order: "desc",
                clientId: clientId,
              };
              const searchResp = await fetch(`${MORNING_API_BASE}/documents/search`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(searchBody),
              });
              if (!searchResp.ok) {
                const txt = await searchResp.text();
                throw new Error("Morning /documents/search HTTP " + searchResp.status + ": " + txt.slice(0, 200));
              }
              const searchJson = await searchResp.json();
              const items = Array.isArray(searchJson.items) ? searchJson.items :
                (Array.isArray(searchJson) ? searchJson : []);
              if (!items.length) break;
              morningDocs.push(...items);
              if (items.length < 50) break;
            }
            _morningDocsPerClientCache.set(clientCacheKey, { data: morningDocs, at: Date.now() });
          }
          historyDocs = morningDocs;
        } catch (e) {
          historyError = String(e && e.message || e).slice(0, 200);
          logger.warn("getcustomerledger: history fetch failed", { gardenName, error: historyError });
        }
      }

      // Load historicalPayments for this garden — manual "paid" marks on docs
      // that have no local invoices/{id} record. Keyed by morningDocId.
      const hpSnap = await admin.firestore().collection("historicalPayments")
        .where("gardenName", "==", gardenName).get();
      const hpByMorningDocId = new Map();
      hpSnap.forEach((d) => {
        const v = d.data();
        if (v.morningDocId) hpByMorningDocId.set(String(v.morningDocId), v);
      });

      // === Merge: unified list ===
      // Start with local. Then for each history doc that has no matching local,
      // add a read-only 'history' row.
      const unified = [];
      for (const inv of localInvoices) {
        const { openBalance, effectiveStatus } = computeInvoiceOpenBalance(inv);
        unified.push({
          source: "local",
          id: inv.id,
          morningDocId: inv.morningDocId || null,
          morningDocNumber: inv.morningDocNumber || null,
          morningActualType: inv.morningActualType != null ? inv.morningActualType : (inv.docType || null),
          docType: inv.docType || null,
          documentDate: inv.documentDate || (inv.createdAt ? inv.createdAt.slice(0, 10) : null),
          month: inv.month || null,
          totalAmount: Number(inv.totalAmount || 0),
          vatAmount: Number(inv.vatAmount || 0),
          amountPaid: Number(inv.amountPaid || inv.paidAmount || 0),
          discountAmount: Number(inv.discountAmount || 0),
          openBalance,
          effectiveStatus,
          status: inv.status || "created",
          paymentStatus: inv.paymentStatus || "unpaid",
          morningDocUrl: inv.morningDocUrl || null,
          paymentHistory: Array.isArray(inv.paymentHistory) ? inv.paymentHistory : [],
          receiptDocNumber: inv.receiptDocNumber || null,
          receiptDocUrl: inv.receiptDocUrl || null,
          creditNoteDocNumber: inv.creditNoteDocNumber || null,
          creditNoteDocUrl: inv.creditNoteDocUrl || null,
          cancelledAt: inv.cancelledAt || null,
          isHistory: false,
        });
      }
      // Track which morning ids are already covered
      const coveredMorningIds = new Set();
      for (const inv of localInvoices) {
        if (inv.morningDocId) coveredMorningIds.add(String(inv.morningDocId));
      }
      // Add history-only docs
      for (const md of historyDocs) {
        const mdId = md.id ? String(md.id) : null;
        if (mdId && coveredMorningIds.has(mdId)) continue;
        const hp = mdId ? hpByMorningDocId.get(mdId) : null;
        // Morning doc types: 300 proforma, 305 tax invoice, 320 tax invoice/receipt,
        //   330 credit note, 400 receipt.
        const t = Number(md.type);
        const isReceiptOrCredit = (t === 320 || t === 330 || t === 400 || t === 305);
        // Morning's `status` field: 0=open, 1=closed, 2=cancelled (best-effort).
        const morningClosed = md.status === 1 || md.status === "closed" ||
          md.status === "1" || md.paid === true;
        const amount = Number(md.amount || md.paid || md.total || 0);
        const vat = Number(md.vat || 0);
        const paidByHp = hp ? Number(hp.amountPaid || amount + vat) : 0;
        let openBal = 0;
        let effective;
        if (morningClosed || isReceiptOrCredit || hp) {
          openBal = 0;
          effective = hp ? "paid" : (morningClosed ? "paid" : "info");
        } else {
          openBal = amount + vat - paidByHp;
          if (openBal < 0) openBal = 0;
          effective = "open";
        }
        unified.push({
          source: "history",
          id: null,
          morningDocId: mdId,
          morningDocNumber: md.number || md.documentNumber || null,
          morningActualType: t,
          docType: t,
          documentDate: md.documentDate || md.date || null,
          month: (md.documentDate || md.date || "").slice(0, 7) || null,
          totalAmount: amount,
          vatAmount: vat,
          amountPaid: paidByHp,
          discountAmount: 0,
          openBalance: +openBal.toFixed(2),
          effectiveStatus: effective,
          status: morningClosed ? "closed" : (md.status || "unknown"),
          paymentStatus: hp ? "paid_manual" : (morningClosed ? "closed" : "unknown"),
          morningDocUrl: md.url ? (md.url.origin || md.url.he || null) : null,
          paymentHistory: hp && hp.markedAt ? [{
            date: hp.paidDate || hp.markedAt.slice(0, 10),
            amount: paidByHp,
            mode: "history_manual",
            note: hp.note || "סומן ידנית — היסטוריה",
            at: hp.markedAt,
            by: hp.markedBy || null,
          }] : [],
          isHistory: true,
        });
      }

      // Sort newest date first
      unified.sort((a, b) => {
        const da = a.documentDate || "";
        const db = b.documentDate || "";
        return db.localeCompare(da);
      });

      // Summary
      let totalOpen = 0;
      let totalPaid = 0;
      let invoiceCount = 0;
      let receiptsCount = 0;
      let creditNotesCount = 0;
      for (const row of unified) {
        totalOpen += row.openBalance;
        totalPaid += row.amountPaid;
        const t = Number(row.morningActualType);
        if (t === 400) receiptsCount++;
        else if (t === 330) creditNotesCount++;
        else invoiceCount++;
      }

      const result = {
        gardenName,
        networkName: garden.networkName || null,
        morningClientId: garden.morningClientId || null,
        invoices: unified,
        summary: {
          totalOpen: +totalOpen.toFixed(2),
          totalPaid: +totalPaid.toFixed(2),
          invoiceCount,
          receiptsCount,
          creditNotesCount,
          historyMode: historyMode_used,
          historyError,
        },
        generatedAt: new Date().toISOString(),
      };
      _ledgerPerGardenCache.set(cacheKey, { data: result, at: Date.now() });
      return result;
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("getcustomerledger: UNCAUGHT", { message: err.message, stack: err.stack });
      throw new HttpsError("internal", "שגיאה: " + (err.message || String(err)));
    }
  }
);

/**
 * Manually mark a historical Morning invoice as paid — writes to
 * /historicalPayments/{morningDocId}. Does NOT touch Morning.
 * Input: { morningDocId, gardenName, paidDate, amountPaid, note? }
 */
exports.markhistoricalinvoicepaid = onCall(
  { region: "us-central1", timeoutSeconds: 30 },
  async (request) => {
    try {
      if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");
      const callerDoc = await admin.firestore().collection("users").doc(request.auth.uid).get();
      if (!callerDoc.exists || callerDoc.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admin only");
      }
      const { morningDocId, gardenName, paidDate, amountPaid, note } = request.data || {};
      if (!morningDocId || !gardenName) {
        throw new HttpsError("invalid-argument", "morningDocId & gardenName required");
      }
      const docId = String(morningDocId);
      const nowIso = new Date().toISOString();
      await admin.firestore().collection("historicalPayments").doc(docId).set({
        morningDocId: docId,
        gardenName,
        paidDate: paidDate || nowIso.slice(0, 10),
        amountPaid: Number(amountPaid || 0),
        note: note || "",
        markedAt: nowIso,
        markedBy: request.auth.uid,
      }, { merge: true });
      // Invalidate caches so the next fetch reflects the change.
      _ledgerAllCache.data = null;
      _ledgerPerGardenCache.clear();
      logger.info("markhistoricalinvoicepaid: OK", { morningDocId: docId, gardenName, amountPaid });
      return { success: true };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("markhistoricalinvoicepaid: UNCAUGHT", { message: err.message, stack: err.stack });
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
      const doSend = async (p) => {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(p),
        });
        const txt = await r.text();
        let parsed;
        try { parsed = JSON.parse(txt); } catch (e) { parsed = { raw: txt }; }
        return { resp: r, result: parsed, raw: txt };
      };
      let { resp: response, result, raw: respText } = await doSend(payload);
      logger.info("sendwhatsapp: WhatsApp response", { status: response.status, result });
      // Fallback: error 132001 means the template's language doesn't exist as registered.
      // Templates are sometimes approved with 'he_IL' while we send 'he' (or vice versa).
      // Auto-retry once with the alternate code.
      const errCode = result.error && result.error.code;
      if (sendMode === "template" && (errCode === 132001 || errCode === 132000) && payload.template) {
        const orig = payload.template.language.code;
        const alt = orig === "he" ? "he_IL" : (orig === "he_IL" ? "he" : (orig === "en" ? "en_US" : (orig === "en_US" ? "en" : null)));
        if (alt) {
          logger.info("sendwhatsapp: retrying with alt language", { templateName: payload.template.name, from: orig, to: alt });
          payload.template.language.code = alt;
          const retry = await doSend(payload);
          response = retry.resp;
          result = retry.result;
          respText = retry.raw;
          logger.info("sendwhatsapp: retry response", { status: response.status, result });
        }
      }
      if (!response.ok || result.error) {
        const baseMsg = (result.error && (result.error.message || result.error.error_user_msg)) || ("HTTP " + response.status);
        const hint = errCode === 132001
          ? "\n\n💡 הבעיה: שם הטמפלייט נכון אבל הוא אושר בקוד שפה אחר. בדקי ב-WhatsApp Manager → Templates → לחצי על הטמפלייט → אם הוא רשום כ-'Hebrew (he_IL)' או 'Hebrew (he)' - וודאי שזה תואם."
          : "";
        throw new HttpsError("internal", "WhatsApp שגיאה: " + baseMsg + hint);
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
 * listwatemplates - List all WhatsApp message templates registered for the business account.
 * Useful for debugging "Template name does not exist" errors (#132001).
 */
exports.listwatemplates = onCall(
  {
    secrets: [whatsappAccessToken, whatsappBusinessAccountId],
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
      const wabaId = String(whatsappBusinessAccountId.value()).trim();
      const token = String(whatsappAccessToken.value()).trim();
      const url = `${WHATSAPP_API_BASE}/${wabaId}/message_templates?limit=200&fields=name,language,status,category`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const txt = await r.text();
      let result;
      try { result = JSON.parse(txt); } catch (e) { result = { raw: txt }; }
      if (!r.ok || result.error) {
        const msg = (result.error && (result.error.message || result.error.error_user_msg)) || ("HTTP " + r.status);
        throw new HttpsError("internal", "Meta API שגיאה: " + msg);
      }
      const templates = (result.data || []).map((t) => ({
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category,
      }));
      logger.info("listwatemplates: returning " + templates.length + " templates");
      return { success: true, count: templates.length, templates };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error("listwatemplates: error", err);
      throw new HttpsError("internal", err.message || String(err));
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
/**
 * Download a WhatsApp media_id to Firebase Storage and return a permanent public URL.
 * Meta gives us media_id → GET /{media_id} returns short-lived URL (5 min) → we fetch
 * the binary → save to Storage under whatsapp-media/{conv}/{msg}.{ext} → return firebase
 * download URL that never expires.
 * Returns null on any failure (we still save the media_id so the admin can retry later).
 */
async function saveWaMediaToStorage(mediaId, convPhone, msgId, wtoken) {
  try {
    if (!mediaId) return null;
    // 1. Get short-lived Meta URL
    const metaRes = await fetch(`${WHATSAPP_API_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${wtoken}` },
    });
    if (!metaRes.ok) {
      logger.warn("saveWaMediaToStorage: meta URL fetch failed", { mediaId, status: metaRes.status });
      return null;
    }
    const metaData = await metaRes.json();
    const shortUrl = metaData.url;
    const mimeType = metaData.mime_type || "application/octet-stream";
    if (!shortUrl) return null;
    // 2. Download binary
    const binRes = await fetch(shortUrl, {
      headers: { Authorization: `Bearer ${wtoken}` },
    });
    if (!binRes.ok) {
      logger.warn("saveWaMediaToStorage: binary download failed", { mediaId, status: binRes.status });
      return null;
    }
    const arrayBuf = await binRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    // 3. Pick extension from mime
    const extMap = {
      "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
      "video/mp4": "mp4", "video/3gpp": "3gp",
      "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/amr": "amr", "audio/aac": "aac",
      "application/pdf": "pdf", "application/msword": "doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "application/vnd.ms-excel": "xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    };
    const ext = extMap[mimeType.split(";")[0].trim()] || "bin";
    const safeConv = String(convPhone || "unknown").replace(/[^0-9]/g, "");
    const safeMsg = String(msgId || Date.now()).replace(/[^A-Za-z0-9_-]/g, "");
    const fileName = `whatsapp-media/${safeConv}/${safeMsg}.${ext}`;
    // 4. Upload to Storage with a download token so we get a persistent public URL
    const uuid = require("crypto").randomUUID();
    const bucket = admin.storage().bucket(STORAGE_BUCKET);
    const file = bucket.file(fileName);
    await file.save(buffer, {
      contentType: mimeType,
      metadata: {
        contentType: mimeType,
        metadata: {
          firebaseStorageDownloadTokens: uuid,
          waMediaId: mediaId,
          waConversationPhone: safeConv,
          waMessageId: safeMsg,
        },
      },
    });
    const encodedName = encodeURIComponent(fileName);
    const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodedName}?alt=media&token=${uuid}`;
    return { url: publicUrl, mimeType, storagePath: fileName, sizeBytes: buffer.length };
  } catch (e) {
    logger.error("saveWaMediaToStorage: exception", { mediaId, msgId, error: e.message });
    return null;
  }
}

exports.receivewhatsapp = onRequest(
  {
    secrets: [whatsappWebhookVerifyToken, whatsappAccessToken],
    region: "us-central1",
    timeoutSeconds: 60,
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
                const mediaObj = msg[type] || {};
                content = {
                  mediaId: mediaObj.id,
                  caption: mediaObj.caption,
                  mimeType: mediaObj.mime_type,
                  filename: mediaObj.filename,
                };
                // Download the media binary and upload to Firebase Storage
                // (Meta's temp URL expires in 5 minutes → we need a permanent copy)
                if (mediaObj.id) {
                  try {
                    const wtoken = String(whatsappAccessToken.value()).trim();
                    const saved = await saveWaMediaToStorage(mediaObj.id, from, msgId, wtoken);
                    if (saved) {
                      content.mediaStorageUrl = saved.url;
                      content.mediaStoragePath = saved.storagePath;
                      content.mediaSizeBytes = saved.sizeBytes;
                      if (!content.mimeType) content.mimeType = saved.mimeType;
                    }
                  } catch (mediaErr) {
                    logger.warn("receivewhatsapp: media save failed (message still stored)", { error: mediaErr.message, msgId });
                  }
                }
              } else {
                content = { raw: msg };
              }

              // Meta sends msg.context.id when the customer replied to a specific
              // message we previously sent them. This is what makes "quoted reply" work.
              const repliedToMessageId = (msg.context && msg.context.id) || null;

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
              if (repliedToMessageId) doc.repliedToMessageId = repliedToMessageId;

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
              const errDetail = (status.errors && status.errors[0] && (status.errors[0].title || status.errors[0].message)) || null;
              await admin.firestore().collection("whatsapp_messages").doc(msgId).set(
                {
                  [`status_${statusValue}_at`]: new Date(timestamp).toISOString(),
                  status: statusValue,
                  ...(errDetail ? { deliveryError: errDetail } : {}),
                },
                { merge: true }
              );
              // Also update the sendLog record for this message (via index)
              try {
                const idxDoc = await admin.firestore().collection("sendLogIndex").doc(msgId).get();
                if (idxDoc.exists) {
                  const idx = idxDoc.data();
                  const sendLogRef = admin.firestore()
                    .collection("sendLog").doc("weekly")
                    .collection(idx.weekId).doc(idx.sendLogId);
                  await sendLogRef.set({
                    deliveryStatus: statusValue,
                    [`delivery_${statusValue}_at`]: timestamp,
                    ...(errDetail ? { deliveryError: errDetail } : {}),
                  }, { merge: true });
                }
              } catch (e) {
                logger.warn("receivewhatsapp: sendLog update failed", { error: e.message });
              }
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
      const { phone, limit, before } = request.data || {};
      if (!phone) throw new HttpsError("invalid-argument", "Missing 'phone'");
      // Fetch newest N first (fast), then reverse to chat order (oldest→newest).
      // `before` is a timestamp cursor for "load older" pagination.
      const pageSize = Math.min(Number(limit || 50), 200);
      let q = admin.firestore()
        .collection("whatsapp_messages")
        .where("conversationPhone", "==", phone)
        .orderBy("timestamp", "desc");
      if (before && Number(before) > 0) {
        q = q.where("timestamp", "<", Number(before));
      }
      q = q.limit(pageSize);
      let snap;
      let usedOrderBy = true;
      try {
        snap = await q.get();
      } catch (idxErr) {
        // Fallback: composite index (conversationPhone + timestamp) not yet built.
        // Return unsorted page — we still sort in memory below.
        logger.warn("getwhatsappmessages: orderBy failed, falling back", { error: idxErr.message });
        usedOrderBy = false;
        snap = await admin.firestore()
          .collection("whatsapp_messages")
          .where("conversationPhone", "==", phone)
          .limit(pageSize * 2)
          .get();
      }
      const messages = [];
      snap.forEach((d) => messages.push(d.data()));
      // Legacy fallback: messages saved before we added conversationPhone field
      if (messages.length === 0 && !before) {
        const [inSnap, outSnap] = await Promise.all([
          admin.firestore().collection("whatsapp_messages").where("from", "==", phone).limit(100).get(),
          admin.firestore().collection("whatsapp_messages").where("to", "==", phone).limit(100).get(),
        ]);
        inSnap.forEach((d) => messages.push(d.data()));
        outSnap.forEach((d) => messages.push(d.data()));
      }
      // Sort ascending for the chat UI (oldest first)
      messages.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
      const hasMore = usedOrderBy && snap.size >= pageSize;
      // Mark as read (only when opening latest page, not when loading older)
      if (!before) {
        try {
          await admin.firestore().collection("whatsapp_conversations").doc(phone).set(
            { unreadCount: 0, lastReadAt: new Date().toISOString() },
            { merge: true }
          );
        } catch (e) { /* non-fatal */ }
      }
      return { messages, hasMore, pageSize };
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
      const { invoiceId, paidDate, paidAmount, note, createReceipt, sendWhatsApp, mode: modeRaw, discountAmount: discountAmountRaw } = request.data || {};
      if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required");
      if (!paidDate) throw new HttpsError("invalid-argument", "paidDate required");
      const mode = (modeRaw === "partial" || modeRaw === "discount") ? modeRaw : "full";

      const invoiceRef = admin.firestore().collection("invoices").doc(String(invoiceId));
      const invoiceSnap = await invoiceRef.get();
      if (!invoiceSnap.exists) throw new HttpsError("not-found", "Invoice not found");
      const invoice = invoiceSnap.data();

      // finalAmount = amount received in THIS transaction
      const expectedTotal = Number(invoice.totalAmount || 0) + Number(invoice.vatAmount || 0);
      const previousPaid = Number(invoice.amountPaid || 0);
      const finalAmount = paidAmount != null ? Number(paidAmount) : Math.max(0, expectedTotal - previousPaid);
      const discountAmount = mode === "discount" ? Math.max(0, Number(discountAmountRaw || 0)) : 0;
      const cumulativePaid = previousPaid + finalAmount;

      // Decide final paymentStatus per mode
      // partial: if cumulative covers expected (±1 tolerance), auto-upgrade to paid
      let paymentStatus;
      let closesInMorning; // whether we tell Morning to close the proforma
      if (mode === "partial") {
        const covered = cumulativePaid >= expectedTotal - 1;
        paymentStatus = covered ? "paid" : "partial";
        closesInMorning = covered;
      } else if (mode === "discount") {
        paymentStatus = "paid";
        closesInMorning = true;
      } else {
        paymentStatus = "paid";
        closesInMorning = true;
      }

      // Step 1 - Update invoice with payment metadata
      const historyEntry = {
        date: paidDate,
        amount: finalAmount,
        mode,
        note: note || "",
        at: new Date().toISOString(),
        by: request.auth.uid,
      };
      if (discountAmount > 0) historyEntry.discountAmount = discountAmount;
      const updateData = {
        paymentStatus,
        paidDate,
        paidAmount: cumulativePaid, // legacy name — cumulative total
        amountPaid: cumulativePaid, // spec name — cumulative total
        paymentNote: note || "",
        paymentMarkedAt: new Date().toISOString(),
        paymentMarkedBy: request.auth.uid,
        paymentHistory: admin.firestore.FieldValue.arrayUnion(historyEntry),
      };
      if (discountAmount > 0) {
        updateData.discountAmount = Number(invoice.discountAmount || 0) + discountAmount;
        updateData.discountedAt = new Date().toISOString();
      }
      await invoiceRef.set(updateData, { merge: true });
      logger.info("markinvoicepaid: marked", { invoiceId, mode, finalAmount, cumulativePaid, expectedTotal, paymentStatus, closesInMorning, discountAmount });

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

        const receiptGardenEmails = parseEmails(garden.email);
        // WIZO detection: prefer explicit networkName, fallback to name including "ויצו".
        const isWizoGarden = (garden.networkName === "ויצו") ||
          (typeof garden.name === "string" && garden.name.includes("ויצו"));
        // WIZO billing contact — loaded from meta/networkContacts.items['ויצו'].email if set,
        // otherwise default to kerend@wizo.org.
        let wizoRecipientEmail = "kerend@wizo.org";
        if (isWizoGarden) {
          try {
            const ncDoc = await admin.firestore().collection("meta").doc("networkContacts").get();
            const items = (ncDoc.exists && ncDoc.data() && ncDoc.data().items) || {};
            const wizoContact = items["ויצו"];
            if (wizoContact && wizoContact.email) {
              const parsed = parseEmails(wizoContact.email);
              if (parsed.length > 0) wizoRecipientEmail = parsed[0];
            }
          } catch (e) {
            logger.warn("markinvoicepaid: failed to load WIZO contact from meta", { error: String(e && e.message || e) });
          }
        }
        const receiptClientObj = { id: String(garden.morningClientId) };
        // For WIZO — DON'T pass emails on the client object. This prevents Morning from
        // auto-emailing the garden's regular addresses upon document creation. We will
        // explicitly /distribute to the WIZO billing contact below.
        if (!isWizoGarden && receiptGardenEmails.length > 0) {
          receiptClientObj.emails = receiptGardenEmails;
        }
        // For WIZO — always use 320 (חשבונית מס/קבלה): a single doc that closes the
        // proforma and serves as receipt in one action. WIZO explicitly requires 320.
        // Otherwise: partial → 400 (קבלה בלבד, לא חשבונית) so revenue isn't double-counted.
        // full/discount → 320 (חשבונית מס/קבלה) as before.
        const docTypeToCreate = isWizoGarden ? 320 : (mode === "partial" ? 400 : 320);
        const remarksSuffix = mode === "partial" ? " | תשלום חלקי"
          : (mode === "discount" ? (" | תשלום עם הנחה " + discountAmount.toFixed(2) + "₪") : "");
        // finalAmount is the GROSS amount the client actually paid (with VAT if applicable).
        // The original invoice may or may not have VAT — check invoice.vatAmount to know.
        // If it had VAT: the receipt income must be BASE (finalAmount / 1.18), so Morning
        //   adds 18% VAT and reaches finalAmount, matching the payment sum.
        // If VAT-exempt: use vatType=1 (EXEMPT) so income sum stays finalAmount = payment sum.
        const _invoiceHasVat = Number(invoice.vatAmount || 0) > 0;
        const _docVatType = _invoiceHasVat ? 0 : 1; // 0=REGULAR (adds 18%), 1=EXEMPT
        const _incomePrice = _invoiceHasVat ? +(finalAmount / 1.18).toFixed(2) : finalAmount;
        const payload = {
          type: docTypeToCreate,
          date: paidDate,
          lang: "he",
          currency: "ILS",
          vatType: _docVatType,
          client: receiptClientObj,
          payment: [
            {
              date: paidDate,
              price: finalAmount,
              type: 4, // bank transfer
            },
          ],
          remarks: "מבוסס על חשבון עסקה מס׳ " + (invoice.morningDocNumber || "") +
            remarksSuffix + (note ? " | " + note : ""),
        };
        // Income lines only for 320 (חשבונית מס/קבלה). Type 400 (קבלה) shouldn't
        // create new revenue — the revenue was already recognized on the proforma.
        if (docTypeToCreate === 320) {
          payload.income = [
            {
              description,
              quantity: 1,
              price: _incomePrice,
              currency: "ILS",
              vatType: _docVatType,
            },
          ];
        }
        // Link to the original proforma. For full → Morning marks it closed.
        // For partial → Morning tracks the remaining balance on the proforma.
        // For discount → we manually /close it below (linkedDocumentIds alone
        // won't close it when amount < proforma total).
        if (invoice.morningDocId) {
          payload.linkedDocumentIds = [invoice.morningDocId];
        }

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

        let receiptEmailedTo = null;
        // For WIZO — override recipients to the WIZO billing contact ONLY (not the garden's emails).
        // For non-WIZO — Morning already auto-emailed via clientObj.emails on creation; we
        //   ALSO fire /distribute here to guarantee delivery (belt-and-suspenders, preserves prior behavior).
        // Payload format: { attachment, recipients, remarks } (see resendmorninginvoiceemail).
        const distributeRecipients = isWizoGarden ? [wizoRecipientEmail] : receiptGardenEmails;
        if (distributeRecipients.length > 0 && result.id) {
          try {
            const distributePayload = {
              attachment: false,
              recipients: distributeRecipients,
              remarks: "",
            };
            const distResponse = await fetch(`${MORNING_API_BASE}/documents/${result.id}/distribute`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify(distributePayload),
            });
            if (distResponse.ok) {
              receiptEmailedTo = distributeRecipients.join(", ");
              logger.info("markinvoicepaid: receipt email sent", { to: receiptEmailedTo, wizo: isWizoGarden });
            } else {
              const t = await distResponse.text();
              logger.warn("markinvoicepaid: receipt email failed", { status: distResponse.status, body: t.slice(0, 200), to: distributeRecipients, wizo: isWizoGarden });
            }
          } catch (e) {
            logger.warn("markinvoicepaid: receipt email error", { error: String(e && e.message || e) });
          }
        }

        receipt = {
          id: result.id || null,
          number: result.number || result.documentNumber || null,
          type: result.type != null ? Number(result.type) : docTypeToCreate,
          url: result.url ? (result.url.he || result.url.origin || null) : null,
          emailedTo: receiptEmailedTo,
        };

        const receiptSaveData = {
          receiptCreated: true,
          receiptId: receipt.id,
          receiptDocNumber: receipt.number,
          receiptDocType: receipt.type,
          receiptDocUrl: receipt.url,
          receiptCreatedAt: new Date().toISOString(),
          receiptHistory: admin.firestore.FieldValue.arrayUnion({
            id: receipt.id,
            number: receipt.number,
            type: receipt.type,
            url: receipt.url,
            amount: finalAmount,
            mode,
            date: paidDate,
            at: new Date().toISOString(),
          }),
        };
        if (isWizoGarden) {
          receiptSaveData.receiptType = 320;
          receiptSaveData.sentToWizoContact = wizoRecipientEmail;
          receiptSaveData.sentAt = new Date().toISOString();
        }
        await invoiceRef.set(receiptSaveData, { merge: true });

        logger.info("markinvoicepaid: receipt created", { invoiceId, receiptNumber: receipt.number, type: docTypeToCreate, mode });

        // For discount mode (and for partial→auto-upgrade), explicitly close the
        // original proforma in Morning. linkedDocumentIds alone won't do it when
        // the receipt amount is less than the proforma total.
        if (closesInMorning && mode === "discount" && invoice.morningDocId) {
          try {
            const closeResp = await fetch(
              `${MORNING_API_BASE}/documents/${encodeURIComponent(invoice.morningDocId)}/close`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
              }
            );
            const closeText = await closeResp.text();
            let closeResult;
            try { closeResult = JSON.parse(closeText); } catch (e) { closeResult = { raw: closeText }; }
            if (!closeResp.ok || (closeResult && closeResult.errorCode)) {
              const cMsg = (closeResult && (closeResult.errorMessage || closeResult.message)) ||
                ("HTTP " + closeResp.status);
              logger.warn("markinvoicepaid: discount close failed", { status: closeResp.status, msg: cMsg });
              // Non-fatal: firestore already marked paid; user can close manually in Morning.
              await invoiceRef.set({
                closedInMorning: false,
                morningCloseError: cMsg,
              }, { merge: true });
            } else {
              await invoiceRef.set({
                closedInMorning: true,
                closedInMorningAt: new Date().toISOString(),
              }, { merge: true });
              logger.info("markinvoicepaid: proforma closed with discount", { invoiceId, discountAmount });
            }
          } catch (closeErr) {
            logger.warn("markinvoicepaid: discount close threw", { error: String(closeErr && closeErr.message || closeErr) });
            await invoiceRef.set({ closedInMorning: false, morningCloseError: String(closeErr.message || closeErr) }, { merge: true });
          }
        } else if (closesInMorning && mode !== "partial") {
          // For 'full' mode Morning auto-closes via linkedDocumentIds — just record the fact.
          await invoiceRef.set({
            closedInMorning: true,
            closedInMorningAt: new Date().toISOString(),
          }, { merge: true });
        }
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
        paid: paymentStatus === "paid",
        paymentStatus,
        mode,
        amountPaid: cumulativePaid,
        expectedTotal,
        discountAmount: discountAmount > 0 ? discountAmount : (Number(invoice.discountAmount || 0) || 0),
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

/**
 * sendweeklytogardenscron - scheduled WhatsApp blast to all gardens with their
 * weekly visit info (animal + PDF). Runs Sundays 13:00 Asia/Jerusalem by default.
 * Skips if settings/weeklySend.enabled is false.
 */
function isoSundayOf(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

// Holiday calendar - empty until admin uploads the real garden vacation schedule.
// When ready, populate with: 'YYYY-MM-DD' (must be a Sunday): {name, fullWeek}
// Keep in sync with index.html ISRAELI_HOLIDAYS.
// Admin can override per-week via the schedule UI (holidayOverride in schedule doc).
const ISRAELI_HOLIDAYS = {};

// Returns {name, fullWeek} if week is a holiday (and full-week), else null.
// Respects per-week override stored in the schedule doc.
function getHolidayForWeek(weekId, scheduleDoc) {
  const override = scheduleDoc && scheduleDoc.holidayOverride;
  // Admin explicitly cancelled the holiday this week
  if (override === false) return null;
  // Admin set a custom holiday
  if (override && override.name) {
    return { name: override.name, fullWeek: override.fullWeek !== false };
  }
  const builtin = ISRAELI_HOLIDAYS[weekId];
  if (builtin && builtin.fullWeek) return builtin;
  return null;
}

async function sendOneTemplateMessage({ to, templateName, languageCode, parameters, mediaUrl, mediaCaption, token, phoneId }) {
  const phone = normalizePhoneIntl(to);
  if (!phone) throw new Error("Invalid phone: " + to);
  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode || "he" },
      components: [],
    },
  };
  if (mediaUrl) {
    payload.template.components.push({
      type: "header",
      parameters: [{
        type: "document",
        document: { link: mediaUrl, filename: mediaCaption || "document.pdf" },
      }],
    });
  }
  if (Array.isArray(parameters) && parameters.length) {
    payload.template.components.push({
      type: "body",
      parameters: parameters.map((p) => ({
        type: "text",
        text: String(p).replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim(),
      })),
    });
  }
  const url = `${WHATSAPP_API_BASE}/${phoneId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const respText = await response.text();
  let result;
  try { result = JSON.parse(respText); } catch (e) { result = { raw: respText }; }
  if (!response.ok || result.error) {
    const errMsg = (result.error && (result.error.message || result.error.error_user_msg)) || ("HTTP " + response.status);
    throw new Error(errMsg);
  }
  return result;
}

exports.sendweeklytogardenscron = onSchedule(
  {
    schedule: "0 13 * * 0", // Sundays 13:00 Israel
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    secrets: [whatsappAccessToken, whatsappPhoneNumberId],
    timeoutSeconds: 540, // 9 minutes
  },
  async (event) => {
    const db = admin.firestore();
    logger.info("sendweeklytogardenscron: starting");
    try {
      const settingsDoc = await db.collection("settings").doc("weeklySend").get();
      const settings = settingsDoc.exists ? settingsDoc.data() : null;
      if (!settings || !settings.enabled) {
        logger.info("sendweeklytogardenscron: disabled, skipping");
        return null;
      }
      const templateName = settings.templateName || "gan_weekly_visit";
      const languageCode = settings.templateLanguage || "he";

      // Find current Sunday in Israel time
      const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
      const sunday = new Date(nowIsrael);
      sunday.setHours(0, 0, 0, 0);
      sunday.setDate(sunday.getDate() - sunday.getDay());
      const yyyy = sunday.getFullYear();
      const mm = String(sunday.getMonth() + 1).padStart(2, "0");
      const dd = String(sunday.getDate()).padStart(2, "0");
      const weekId = `${yyyy}-${mm}-${dd}`;
      logger.info("sendweeklytogardenscron: weekId", { weekId });

      const scheduleDoc = await db.collection("weeklySchedule").doc(weekId).get();
      if (!scheduleDoc.exists) {
        logger.warn("sendweeklytogardenscron: no schedule for week, skipping", { weekId });
        await db.collection("settings").doc("weeklySend").set({
          lastRun: Date.now(),
          lastRunStats: { sent: 0, failed: 0, skipped: 0, reason: "no schedule" },
        }, { merge: true });
        return null;
      }
      const holiday = getHolidayForWeek(weekId, scheduleDoc.data());
      if (holiday) {
        logger.info("sendweeklytogardenscron: holiday week, skipping", { weekId, holiday: holiday.name });
        await db.collection("settings").doc("weeklySend").set({
          lastRun: Date.now(),
          lastRunStats: { sent: 0, failed: 0, skipped: 0, reason: "holiday: " + holiday.name, weekId },
        }, { merge: true });
        return null;
      }
      const assignments = scheduleDoc.data().assignments || {};
      const uids = Object.keys(assignments);
      logger.info("sendweeklytogardenscron: assignments", { count: uids.length });

      // Load gardens + users + materials (small enough to load in full)
      const [gardensSnap, usersSnap, materialsSnap] = await Promise.all([
        db.collection("meta").doc("gardens").get(),
        db.collection("users").get(),
        db.collection("materials").get(),
      ]);
      const allGardens = gardensSnap.exists ? (gardensSnap.data().items || []) : [];
      const gardenByName = {};
      allGardens.forEach((g) => { if (typeof g === "object" && g.name) gardenByName[g.name] = g; });
      const userById = {};
      usersSnap.forEach((d) => {
        const u = d.data();
        userById[d.id] = u;
        if (u.id) userById[String(u.id)] = u;
      });
      const matById = {};
      materialsSnap.forEach((d) => { matById[d.id] = d.data(); });

      const token = String(whatsappAccessToken.value()).trim();
      const phoneId = String(whatsappPhoneNumberId.value()).trim();

      let sent = 0, failed = 0, skipped = 0;
      const errors = [];
      const sendLogRoot = db.collection("sendLog").doc("weekly").collection(weekId);

      // Clear previous send log for this week so counter shows only this run
      try {
        const prev = await sendLogRoot.get();
        if (!prev.empty) {
          const docs = prev.docs;
          for (let i = 0; i < docs.length; i += 400) {
            const batch = db.batch();
            docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
            await batch.commit();
          }
          logger.info("sendweeklytogardenscron: cleared previous log", { count: docs.length, weekId });
        }
      } catch (e) { logger.warn("clear log failed (continuing):", e.message); }

      for (const uid of uids) {
        const matId = assignments[uid];
        const mat = matById[matId];
        const user = userById[uid];
        if (!mat || !user) { skipped++; continue; }
        const gardens = user.gardens || [];
        for (const gName of gardens) {
          const garden = gardenByName[gName];
          if (!garden || !garden.phone) { skipped++; continue; }
          try {
            const apiResult = await sendOneTemplateMessage({
              to: garden.phone,
              templateName,
              languageCode,
              parameters: [mat.animalName || mat.name, mat.summary || ""],
              mediaUrl: mat.gardenPdfUrl,
              mediaCaption: mat.gardenPdfName || "מי בא לבקר.pdf",
              token,
              phoneId,
            });
            const messageId = (apiResult && apiResult.messages && apiResult.messages[0] && apiResult.messages[0].id) || null;
            sent++;
            const sendLogRef = await sendLogRoot.add({
              type: "garden",
              instructorUid: uid,
              instructorName: user.name || "",
              gardenName: gName,
              gardenPhone: garden.phone,
              materialId: matId,
              materialName: mat.name,
              status: "sent",
              sentAt: Date.now(),
              messageId,
            });
            if (messageId) {
              await db.collection("sendLogIndex").doc(messageId).set({
                weekId, sendLogId: sendLogRef.id, sentAt: Date.now(),
              });
            }
          } catch (e) {
            failed++;
            errors.push({ garden: gName, error: e.message || String(e) });
            await sendLogRoot.add({
              type: "garden",
              instructorUid: uid,
              instructorName: user.name || "",
              gardenName: gName,
              gardenPhone: garden.phone,
              materialId: matId,
              materialName: mat.name,
              status: "failed",
              error: e.message || String(e),
              sentAt: Date.now(),
            });
            logger.warn("sendweeklytogardenscron: send failed", { garden: gName, error: e.message });
          }
          // Small delay to be gentle on the WhatsApp API
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      await db.collection("settings").doc("weeklySend").set({
        lastRun: Date.now(),
        lastRunStats: { sent, failed, skipped, weekId },
      }, { merge: true });

      logger.info("sendweeklytogardenscron: done", { sent, failed, skipped, errors: errors.length });
      return null;
    } catch (e) {
      logger.error("sendweeklytogardenscron: UNCAUGHT", { message: e.message, stack: e.stack });
      throw e;
    }
  }
);

/**
 * notifyinstructorsweeklycron - scheduled in-app push to instructors letting them know
 * their weekly material is live. Runs Fridays 16:00 Asia/Jerusalem.
 *
 * Writes a notification doc per assigned instructor; the existing
 * sendpushonnotification function then fires the OneSignal push automatically.
 * Skips silently if settings/weeklySend.notifyInstructors is false.
 */
exports.notifyinstructorsweeklycron = onSchedule(
  {
    schedule: "0 16 * * 5", // Fridays 16:00 Israel
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    timeoutSeconds: 300,
  },
  async (event) => {
    const db = admin.firestore();
    logger.info("notifyinstructorsweeklycron: starting");
    try {
      const settingsDoc = await db.collection("settings").doc("weeklySend").get();
      const settings = settingsDoc.exists ? settingsDoc.data() : {};
      // Default ON for instructor notifications (separate toggle from garden send)
      if (settings.notifyInstructors === false) {
        logger.info("notifyinstructorsweeklycron: disabled, skipping");
        return null;
      }

      // Find next Sunday in Israel time (today is Friday, so +2 days)
      const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
      const nextSunday = new Date(nowIsrael);
      nextSunday.setHours(0, 0, 0, 0);
      const daysUntilSunday = (7 - nextSunday.getDay()) % 7 || 7;
      nextSunday.setDate(nextSunday.getDate() + daysUntilSunday);
      const yyyy = nextSunday.getFullYear();
      const mm = String(nextSunday.getMonth() + 1).padStart(2, "0");
      const dd = String(nextSunday.getDate()).padStart(2, "0");
      const weekId = `${yyyy}-${mm}-${dd}`;
      logger.info("notifyinstructorsweeklycron: weekId", { weekId });

      const scheduleDoc = await db.collection("weeklySchedule").doc(weekId).get();
      if (!scheduleDoc.exists) {
        logger.warn("notifyinstructorsweeklycron: no schedule for next week, skipping", { weekId });
        await db.collection("settings").doc("weeklySend").set({
          lastInstructorRun: Date.now(),
          lastInstructorRunStats: { notified: 0, skipped: 0, reason: "no schedule" },
        }, { merge: true });
        return null;
      }
      const holiday = getHolidayForWeek(weekId, scheduleDoc.data());
      if (holiday) {
        logger.info("notifyinstructorsweeklycron: holiday week, skipping", { weekId, holiday: holiday.name });
        await db.collection("settings").doc("weeklySend").set({
          lastInstructorRun: Date.now(),
          lastInstructorRunStats: { notified: 0, skipped: 0, reason: "holiday: " + holiday.name, weekId },
        }, { merge: true });
        return null;
      }
      const assignments = scheduleDoc.data().assignments || {};
      const uids = Object.keys(assignments);
      logger.info("notifyinstructorsweeklycron: assignments", { count: uids.length });

      const [usersSnap, materialsSnap] = await Promise.all([
        db.collection("users").get(),
        db.collection("materials").get(),
      ]);
      const userById = {};
      usersSnap.forEach((d) => {
        const u = d.data();
        userById[d.id] = u;
        if (u.id) userById[String(u.id)] = u;
      });
      const matById = {};
      materialsSnap.forEach((d) => { matById[d.id] = d.data(); });

      // Hebrew date pretty-print for the notification body
      const dayNames = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
      const monthNames = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
        "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
      const weekLabel = `יום ${dayNames[nextSunday.getDay()]} ${nextSunday.getDate()} ב${monthNames[nextSunday.getMonth()]}`;

      let notified = 0, skipped = 0;
      const writes = [];

      for (const uid of uids) {
        const matId = assignments[uid];
        const mat = matById[matId];
        const user = userById[uid];
        if (!mat || !user) { skipped++; continue; }

        // recipientUid must match Firebase Auth UID (key in /users collection).
        // userById is indexed by both d.id and u.id - we need the Auth uid here.
        // Look it up: the schedule key uid IS the users doc id in our model.
        const animalName = mat.animalName || mat.name || "החיה השבועית";
        const id = Date.now() + Math.floor(Math.random() * 10000);
        const notif = {
          id,
          recipientUid: uid,
          type: "weekly_material",
          icon: "🐾",
          title: `המערך השבועי שלך עלה! ${animalName}`,
          body: `החל מ${weekLabel} – המערך החדש זמין באפליקציה עם כל הקבצים. 🎯`,
          link: { screen: "att" }, // attendance screen has the "my weekly" card
          createdAt: new Date().toISOString(),
          createdBy: "system",
          createdByName: "מערכת בייביז",
          read: false,
          readAt: null,
          materialId: matId,
          weekId,
        };
        writes.push(db.collection("notifications").doc(String(id)).set(notif));
        notified++;
      }

      await Promise.all(writes);

      await db.collection("settings").doc("weeklySend").set({
        lastInstructorRun: Date.now(),
        lastInstructorRunStats: { notified, skipped, weekId },
      }, { merge: true });

      logger.info("notifyinstructorsweeklycron: done", { notified, skipped, weekId });
      return null;
    } catch (e) {
      logger.error("notifyinstructorsweeklycron: UNCAUGHT", { message: e.message, stack: e.stack });
      throw e;
    }
  }
);

/**
 * Manual on-demand triggers for both weekly flows.
 * Admin clicks "send now" in the UI -> these onCall functions run immediately,
 * bypassing the scheduled crons. Same internals; different entry point.
 */
exports.sendwhatsapptogardennow = onCall(
  { region: "us-central1", secrets: [whatsappAccessToken, whatsappPhoneNumberId], timeoutSeconds: 60 },
  async (req) => {
    await requireAdmin(req.auth);
    const { gardenName, materialId } = req.data || {};
    if (!gardenName) throw new HttpsError("invalid-argument", "missing gardenName");
    if (!materialId) throw new HttpsError("invalid-argument", "missing materialId");
    const db = admin.firestore();
    const gardensSnap = await db.collection("meta").doc("gardens").get();
    const items = gardensSnap.exists ? (gardensSnap.data().items || []) : [];
    const garden = items.find(g => typeof g === "object" && g.name === gardenName);
    if (!garden) return { success: false, error: "הגן לא נמצא" };
    if (!garden.phone) return { success: false, error: "אין טלפון מוגדר לגן" };
    const matDoc = await db.collection("materials").doc(materialId).get();
    if (!matDoc.exists) return { success: false, error: "המערך לא נמצא" };
    const mat = matDoc.data();
    if (!mat.gardenPdfUrl) return { success: false, error: "חסר PDF למערך הזה" };
    const settingsDoc = await db.collection("settings").doc("weeklySend").get();
    const settings = settingsDoc.exists ? settingsDoc.data() : {};
    const templateName = settings.templateName || "gan_weekly_visit";
    const languageCode = settings.templateLanguage || "he";
    const token = String(whatsappAccessToken.value()).trim();
    const phoneId = String(whatsappPhoneNumberId.value()).trim();
    try {
      const apiResult = await sendOneTemplateMessage({
        to: garden.phone, templateName, languageCode,
        parameters: [mat.animalName || mat.name, mat.summary || ""],
        mediaUrl: mat.gardenPdfUrl,
        mediaCaption: mat.gardenPdfName || "מי בא לבקר.pdf",
        token, phoneId,
      });
      const messageId = (apiResult && apiResult.messages && apiResult.messages[0] && apiResult.messages[0].id) || null;
      const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
      const sunday = new Date(nowIsrael);
      sunday.setHours(0, 0, 0, 0);
      sunday.setDate(sunday.getDate() - sunday.getDay());
      const weekId = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, "0")}-${String(sunday.getDate()).padStart(2, "0")}`;
      const sendLogRef = await db.collection("sendLog").doc("weekly").collection(weekId).add({
        type: "garden", trigger: "single",
        gardenName, gardenPhone: garden.phone,
        materialId, materialName: mat.name,
        status: "sent", sentAt: Date.now(),
        messageId, triggeredBy: req.auth.uid,
      });
      if (messageId) {
        await db.collection("sendLogIndex").doc(messageId).set({
          weekId, sendLogId: sendLogRef.id, sentAt: Date.now(),
        });
      }
      return { success: true, messageId, gardenPhone: garden.phone, gardenName };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  }
);

exports.getinstructorspushstatus = onCall(
  { region: "us-central1", timeoutSeconds: 60 },
  async (req) => {
    await requireAdmin(req.auth);
    const db = admin.firestore();
    const usersSnap = await db.collection("users").get();
    const fsUsers = {};
    usersSnap.forEach(d => { const u = d.data(); if (u.role !== "admin") fsUsers[d.id] = u; });
    let pageToken = undefined;
    const authByUid = {};
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      page.users.forEach(u => { authByUid[u.uid] = u; });
      pageToken = page.pageToken;
    } while (pageToken);
    const now = Date.now();
    const rows = Object.keys(fsUsers).map(uid => {
      const fu = fsUsers[uid];
      const au = authByUid[uid];
      const lastSignIn = au && au.metadata && au.metadata.lastSignInTime ? au.metadata.lastSignInTime : null;
      const lastMs = lastSignIn ? Date.parse(lastSignIn) : null;
      const subIds = Array.isArray(fu.oneSignalSubscriptionIds) ? fu.oneSignalSubscriptionIds : (fu.oneSignalSubscriptionId ? [fu.oneSignalSubscriptionId] : []);
      return {
        uid, name: fu.name, username: fu.username, phone: fu.phone || "",
        neverSignedIn: !lastSignIn,
        lastSignIn,
        daysSinceLastSignIn: lastMs ? Math.floor((now - lastMs) / 86400000) : null,
        deviceCount: subIds.length,
        hasSubscription: subIds.length > 0,
      };
    });
    rows.sort((a, b) => {
      const aBad = !a.hasSubscription || a.neverSignedIn;
      const bBad = !b.hasSubscription || b.neverSignedIn;
      if (aBad !== bBad) return aBad ? -1 : 1;
      return (a.name || "").localeCompare(b.name || "", "he");
    });
    return { rows, total: rows.length };
  }
);

async function requireAdmin(auth) {
  if (!auth || !auth.uid) throw new HttpsError("unauthenticated", "Sign in required");
  const db = admin.firestore();
  const u = await db.collection("users").doc(auth.uid).get();
  if (!u.exists || u.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Admin only");
  }
}

exports.sendweeklytogardensnow = onCall(
  {
    region: "us-central1",
    secrets: [whatsappAccessToken, whatsappPhoneNumberId],
    timeoutSeconds: 540,
  },
  async (req) => {
    await requireAdmin(req.auth);
    const db = admin.firestore();
    const weekId = (req.data && req.data.weekId) || null;
    logger.info("sendweeklytogardensnow: starting", { weekId, by: req.auth.uid });
    try {
      const settingsDoc = await db.collection("settings").doc("weeklySend").get();
      const settings = settingsDoc.exists ? settingsDoc.data() : {};
      const templateName = settings.templateName || "gan_weekly_visit";
      const languageCode = settings.templateLanguage || "he";

      // Use the requested weekId, or fall back to "current Sunday in Israel"
      let resolvedWeekId = weekId;
      if (!resolvedWeekId) {
        const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
        const sunday = new Date(nowIsrael);
        sunday.setHours(0, 0, 0, 0);
        sunday.setDate(sunday.getDate() - sunday.getDay());
        resolvedWeekId = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, "0")}-${String(sunday.getDate()).padStart(2, "0")}`;
      }

      const scheduleDoc = await db.collection("weeklySchedule").doc(resolvedWeekId).get();
      if (!scheduleDoc.exists) {
        return { success: false, error: `אין שיבוץ לשבוע ${resolvedWeekId}` };
      }
      const holiday = getHolidayForWeek(resolvedWeekId, scheduleDoc.data());
      if (holiday) {
        return { success: false, error: `שבוע ${resolvedWeekId} מסומן כחופשה (${holiday.name}). אם רוצה לשלוח בכל זאת — בטלי את סימון החופשה בלוח השיבוצים.` };
      }
      const assignments = scheduleDoc.data().assignments || {};
      const uids = Object.keys(assignments);

      const [gardensSnap, usersSnap, materialsSnap] = await Promise.all([
        db.collection("meta").doc("gardens").get(),
        db.collection("users").get(),
        db.collection("materials").get(),
      ]);
      const allGardens = gardensSnap.exists ? (gardensSnap.data().items || []) : [];
      const gardenByName = {};
      allGardens.forEach((g) => { if (typeof g === "object" && g.name) gardenByName[g.name] = g; });
      const userById = {};
      usersSnap.forEach((d) => {
        const u = d.data();
        userById[d.id] = u;
        if (u.id) userById[String(u.id)] = u;
      });
      const matById = {};
      materialsSnap.forEach((d) => { matById[d.id] = d.data(); });

      const token = String(whatsappAccessToken.value()).trim();
      const phoneId = String(whatsappPhoneNumberId.value()).trim();

      let sent = 0, failed = 0, skipped = 0;
      const errors = [];
      const sendLogRoot = db.collection("sendLog").doc("weekly").collection(resolvedWeekId);

      // Clear previous send log for this week so the counter shows ONLY this run
      try {
        const prev = await sendLogRoot.get();
        if (!prev.empty) {
          const docs = prev.docs;
          for (let i = 0; i < docs.length; i += 400) {
            const batch = db.batch();
            docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
            await batch.commit();
          }
          logger.info("sendweeklytogardensnow: cleared previous log", { count: docs.length, weekId: resolvedWeekId });
        }
      } catch (e) { logger.warn("clear log failed (continuing):", e.message); }

      for (const uid of uids) {
        const matId = assignments[uid];
        const mat = matById[matId];
        const user = userById[uid];
        if (!mat || !user) { skipped++; continue; }
        const gardens = user.gardens || [];
        for (const gName of gardens) {
          const garden = gardenByName[gName];
          if (!garden || !garden.phone) { skipped++; continue; }
          try {
            const apiResult = await sendOneTemplateMessage({
              to: garden.phone,
              templateName,
              languageCode,
              parameters: [mat.animalName || mat.name, mat.summary || ""],
              mediaUrl: mat.gardenPdfUrl,
              mediaCaption: mat.gardenPdfName || "מי בא לבקר.pdf",
              token,
              phoneId,
            });
            const messageId = (apiResult && apiResult.messages && apiResult.messages[0] && apiResult.messages[0].id) || null;
            sent++;
            const sendLogRef = await sendLogRoot.add({
              type: "garden", trigger: "manual",
              instructorUid: uid, instructorName: user.name || "",
              gardenName: gName, gardenPhone: garden.phone,
              materialId: matId, materialName: mat.name,
              status: "sent", sentAt: Date.now(),
              messageId,
              triggeredBy: req.auth.uid,
            });
            if (messageId) {
              await db.collection("sendLogIndex").doc(messageId).set({
                weekId: resolvedWeekId, sendLogId: sendLogRef.id, sentAt: Date.now(),
              });
            }
          } catch (e) {
            failed++;
            errors.push({ garden: gName, error: e.message || String(e) });
            await sendLogRoot.add({
              type: "garden", trigger: "manual",
              instructorUid: uid, instructorName: user.name || "",
              gardenName: gName, gardenPhone: garden.phone,
              materialId: matId, materialName: mat.name,
              status: "failed", error: e.message || String(e), sentAt: Date.now(),
              triggeredBy: req.auth.uid,
            });
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      await db.collection("settings").doc("weeklySend").set({
        lastManualRun: Date.now(),
        lastManualRunStats: { sent, failed, skipped, weekId: resolvedWeekId, by: req.auth.uid },
      }, { merge: true });

      logger.info("sendweeklytogardensnow: done", { sent, failed, skipped });
      return { success: true, sent, failed, skipped, weekId: resolvedWeekId, errors: errors.slice(0, 10) };
    } catch (e) {
      logger.error("sendweeklytogardensnow: UNCAUGHT", { message: e.message, stack: e.stack });
      throw new HttpsError("internal", e.message || String(e));
    }
  }
);

exports.notifyinstructorsweeklynow = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 120,
  },
  async (req) => {
    await requireAdmin(req.auth);
    const db = admin.firestore();
    const weekId = (req.data && req.data.weekId) || null;
    logger.info("notifyinstructorsweeklynow: starting", { weekId, by: req.auth.uid });
    try {
      // Default to "next Sunday in Israel" if no weekId passed
      let resolvedWeekId = weekId;
      if (!resolvedWeekId) {
        const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
        const nextSunday = new Date(nowIsrael);
        nextSunday.setHours(0, 0, 0, 0);
        // If today is already Sunday, use today; else jump to next Sunday
        const day = nextSunday.getDay();
        if (day !== 0) nextSunday.setDate(nextSunday.getDate() + (7 - day));
        resolvedWeekId = `${nextSunday.getFullYear()}-${String(nextSunday.getMonth() + 1).padStart(2, "0")}-${String(nextSunday.getDate()).padStart(2, "0")}`;
      }

      const scheduleDoc = await db.collection("weeklySchedule").doc(resolvedWeekId).get();
      if (!scheduleDoc.exists) {
        return { success: false, error: `אין שיבוץ לשבוע ${resolvedWeekId}` };
      }
      const holiday = getHolidayForWeek(resolvedWeekId, scheduleDoc.data());
      if (holiday) {
        return { success: false, error: `שבוע ${resolvedWeekId} מסומן כחופשה (${holiday.name}). בטלי את סימון החופשה אם בכל זאת רוצה לשלוח.` };
      }
      const assignments = scheduleDoc.data().assignments || {};
      const uids = Object.keys(assignments);

      const [usersSnap, materialsSnap] = await Promise.all([
        db.collection("users").get(),
        db.collection("materials").get(),
      ]);
      const userById = {};
      usersSnap.forEach((d) => {
        const u = d.data();
        userById[d.id] = u;
        if (u.id) userById[String(u.id)] = u;
      });
      const matById = {};
      materialsSnap.forEach((d) => { matById[d.id] = d.data(); });

      const sundayDate = new Date(resolvedWeekId + "T00:00:00");
      const dayNames = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
      const monthNames = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
        "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
      const weekLabel = `יום ${dayNames[sundayDate.getDay()]} ${sundayDate.getDate()} ב${monthNames[sundayDate.getMonth()]}`;

      let notified = 0, skipped = 0;
      const writes = [];
      for (const uid of uids) {
        const matId = assignments[uid];
        const mat = matById[matId];
        const user = userById[uid];
        if (!mat || !user) { skipped++; continue; }
        const animalName = mat.animalName || mat.name || "החיה השבועית";
        const id = Date.now() + Math.floor(Math.random() * 10000);
        const notif = {
          id,
          recipientUid: uid,
          type: "weekly_material",
          icon: "🐾",
          title: `המערך השבועי שלך עלה! ${animalName}`,
          body: `החל מ${weekLabel} – המערך החדש זמין באפליקציה עם כל הקבצים. 🎯`,
          link: { screen: "att" },
          createdAt: new Date().toISOString(),
          createdBy: "system",
          createdByName: `מערכת בייביז (שליחה ידנית)`,
          read: false,
          readAt: null,
          materialId: matId,
          weekId: resolvedWeekId,
        };
        writes.push(db.collection("notifications").doc(String(id)).set(notif));
        notified++;
      }
      await Promise.all(writes);

      await db.collection("settings").doc("weeklySend").set({
        lastManualInstructorRun: Date.now(),
        lastManualInstructorRunStats: { notified, skipped, weekId: resolvedWeekId, by: req.auth.uid },
      }, { merge: true });

      logger.info("notifyinstructorsweeklynow: done", { notified, skipped, weekId: resolvedWeekId });
      return { success: true, notified, skipped, weekId: resolvedWeekId };
    } catch (e) {
      logger.error("notifyinstructorsweeklynow: UNCAUGHT", { message: e.message, stack: e.stack });
      throw new HttpsError("internal", e.message || String(e));
    }
  }
);

/* ========================================================================
   BACKUP & DISASTER RECOVERY
   ========================================================================
   - backupfirestoredaily: scheduled native Firestore export to GCS
   - exportbackupjson: on-demand JSON dump of all collections
   - listbackups: returns recent backup log entries
   - weeklybackupemail: scheduled email with JSON attachment off-platform
   ======================================================================== */

const firestoreV1 = require("@google-cloud/firestore").v1;
const firestoreAdminClient = new firestoreV1.FirestoreAdminClient();
const STORAGE_BUCKET = "babiez-app.firebasestorage.app";

// Recursively dump a Firestore collection (including subcollections, up to maxDepth)
async function dumpCollectionTree(collRef, depth, maxDepth) {
  const out = {};
  const snap = await collRef.get();
  for (const doc of snap.docs) {
    const data = doc.data();
    const entry = { _data: data };
    if (depth < maxDepth) {
      const subColls = await doc.ref.listCollections();
      if (subColls.length) {
        entry._sub = {};
        for (const sub of subColls) {
          entry._sub[sub.id] = await dumpCollectionTree(sub, depth + 1, maxDepth);
        }
      }
    }
    out[doc.id] = entry;
  }
  return out;
}

async function buildFullJsonBackup() {
  const db = admin.firestore();
  const topColls = await db.listCollections();
  const dump = {
    exportedAt: new Date().toISOString(),
    project: process.env.GCLOUD_PROJECT || "babiez-app",
    schemaVersion: 1,
    collections: {},
  };
  let docCount = 0;
  for (const coll of topColls) {
    dump.collections[coll.id] = await dumpCollectionTree(coll, 0, 4);
    const countTree = (node) => {
      let c = 0;
      for (const id of Object.keys(node)) {
        c++;
        if (node[id]._sub) {
          for (const sub of Object.keys(node[id]._sub)) {
            c += countTree(node[id]._sub[sub]);
          }
        }
      }
      return c;
    };
    docCount += countTree(dump.collections[coll.id]);
  }
  return { dump, docCount, collectionsCount: Object.keys(dump.collections).length };
}

// ========== Layer 1: Daily JSON backup to GCS ==========
// Was: native Firestore export (PERMISSION_DENIED, needed datastore.importExportAdmin role)
// Now: JSON dump via buildFullJsonBackup() - same approach as weekly email, no IAM gymnastics
exports.backupfirestoredaily = onSchedule(
  {
    schedule: "0 2 * * *", // Every day at 02:00 Israel
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    const db = admin.firestore();
    const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const datestr = `${nowIsrael.getFullYear()}-${String(nowIsrael.getMonth() + 1).padStart(2, "0")}-${String(nowIsrael.getDate()).padStart(2, "0")}`;
    const fileName = `backups/daily/backup-${datestr}.json`;
    const startedAt = Date.now();
    logger.info("backupfirestoredaily: starting", { fileName });
    try {
      const { dump, docCount, collectionsCount } = await buildFullJsonBackup();
      const json = JSON.stringify(dump);
      const bucket = admin.storage().bucket(STORAGE_BUCKET);
      await bucket.file(fileName).save(json, {
        contentType: "application/json",
        metadata: { metadata: {
          type: "daily-auto",
          docCount: String(docCount),
          collectionsCount: String(collectionsCount),
          date: datestr,
        }},
      });
      await db.collection("backupLog").add({
        type: "daily-json",
        startedAt,
        finishedAt: Date.now(),
        date: datestr,
        path: `gs://${STORAGE_BUCKET}/${fileName}`,
        docCount,
        collectionsCount,
        sizeBytes: json.length,
        status: "success",
      });
      logger.info("backupfirestoredaily: done", { docCount, sizeBytes: json.length, date: datestr });
      return null;
    } catch (e) {
      logger.error("backupfirestoredaily: FAILED", { error: e.message, stack: e.stack });
      await db.collection("backupLog").add({
        type: "daily-json",
        startedAt,
        date: datestr,
        status: "failed",
        error: e.message || String(e),
      });
      throw e;
    }
  }
);

// ========== Layer 3a: Manual JSON download (on-demand) ==========
// Returns JSON directly in the response so the browser can download it.
// Also saves a copy to Storage for archival (no signed URL needed).
exports.exportbackupjson = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req) => {
    await requireAdmin(req.auth);
    const db = admin.firestore();
    logger.info("exportbackupjson: starting", { by: req.auth.uid });
    const startedAt = Date.now();
    try {
      const { dump, docCount, collectionsCount } = await buildFullJsonBackup();
      const json = JSON.stringify(dump);

      // Archive copy to Storage (best-effort, don't fail the download if it errors)
      const fileName = `backups/manual/backup-${startedAt}.json`;
      try {
        const bucket = admin.storage().bucket(STORAGE_BUCKET);
        await bucket.file(fileName).save(json, {
          contentType: "application/json",
          metadata: { metadata: {
            createdBy: req.auth.uid, type: "manual-download",
            docCount: String(docCount), collectionsCount: String(collectionsCount),
          }},
        });
      } catch (storageErr) {
        logger.warn("exportbackupjson: storage archive failed (download still works)", { error: storageErr.message });
      }

      await db.collection("backupLog").add({
        type: "manual-json",
        startedAt,
        finishedAt: Date.now(),
        status: "success",
        path: `gs://${STORAGE_BUCKET}/${fileName}`,
        docCount,
        collectionsCount,
        sizeBytes: json.length,
        by: req.auth.uid,
      });
      logger.info("exportbackupjson: done", { docCount, sizeBytes: json.length });
      return {
        success: true,
        json,              // ← The actual JSON content for client to download
        fileName: `babiez-backup-${new Date().toISOString().slice(0,10)}.json`,
        sizeBytes: json.length,
        docCount,
        collectionsCount,
      };
    } catch (e) {
      logger.error("exportbackupjson: FAILED", { error: e.message });
      await db.collection("backupLog").add({
        type: "manual-json",
        startedAt,
        finishedAt: Date.now(),
        status: "failed",
        error: e.message || String(e),
        by: req.auth.uid,
      });
      throw new HttpsError("internal", e.message || String(e));
    }
  }
);

// ========== Manual trigger: test the weekly email NOW ==========
exports.testweeklybackupemail = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [gmailUser, gmailAppPassword],
  },
  async (req) => {
    await requireAdmin(req.auth);
    const db = admin.firestore();
    logger.info("testweeklybackupemail: starting", { by: req.auth.uid });
    try {
      const settingsDoc = await db.collection("settings").doc("backup").get();
      const settings = settingsDoc.exists ? settingsDoc.data() : {};
      const recipient = settings.recipientEmail;
      if (!recipient) {
        return { success: false, error: "לא הוגדר אימייל. לכי להגדרות מייל ושמרי כתובת." };
      }

      const startedAt = Date.now();
      const { dump, docCount, collectionsCount } = await buildFullJsonBackup();
      const json = JSON.stringify(dump);
      const datestr = new Date().toISOString().slice(0, 10);

      const nodemailer = require("nodemailer");
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailUser.value(), pass: gmailAppPassword.value() },
      });
      const prettySize = json.length > 1024 * 1024
        ? (json.length / 1024 / 1024).toFixed(1) + " MB"
        : (json.length / 1024).toFixed(1) + " KB";

      await transporter.sendMail({
        from: gmailUser.value(),
        to: recipient,
        subject: `🧪 בדיקת גיבוי בייביז קלאב — ${datestr}`,
        text: [
          "שלום שיר! 🧪",
          "",
          "זוהי הודעת בדיקה שביצעת ידנית מהאפליקציה.",
          "אם את רואה את ההודעה הזו — הגיבוי השבועי האוטומטי יעבוד בכל יום שישי 14:00.",
          "",
          `📊 ${docCount.toLocaleString("he-IL")} מסמכים · ${collectionsCount} collections · ${prettySize}`,
          "",
          "📎 קובץ JSON של כל הנתונים מצורף.",
          "",
          "🎉 ברכות — את מוגנת!",
          "מערכת בייביז 🐾",
        ].join("\n"),
        attachments: [{
          filename: `babiez-test-backup-${datestr}.json`,
          content: json,
          contentType: "application/json",
        }],
      });

      await db.collection("backupLog").add({
        type: "test-email",
        startedAt,
        finishedAt: Date.now(),
        status: "success",
        recipient,
        docCount,
        collectionsCount,
        sizeBytes: json.length,
        by: req.auth.uid,
      });

      logger.info("testweeklybackupemail: done", { recipient });
      return { success: true, recipient, docCount, collectionsCount, sizeBytes: json.length };
    } catch (e) {
      logger.error("testweeklybackupemail: FAILED", { error: e.message });
      await db.collection("backupLog").add({
        type: "test-email",
        startedAt: Date.now(),
        status: "failed",
        error: e.message || String(e),
        by: req.auth.uid,
      });
      throw new HttpsError("internal", e.message || String(e));
    }
  }
);

// ========== Layer 3b: List recent backups ==========
exports.listbackups = onCall(
  { region: "us-central1", timeoutSeconds: 30 },
  async (req) => {
    await requireAdmin(req.auth);
    const db = admin.firestore();
    const snap = await db.collection("backupLog").orderBy("startedAt", "desc").limit(60).get();
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    return { items };
  }
);

// ========== Layer 2: Weekly backup to admin email ==========
exports.weeklybackupemail = onSchedule(
  {
    schedule: "0 14 * * 5", // Fridays 14:00 Israel
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    secrets: [gmailUser, gmailAppPassword],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    const db = admin.firestore();
    logger.info("weeklybackupemail: starting");
    try {
      const settingsDoc = await db.collection("settings").doc("backup").get();
      const settings = settingsDoc.exists ? settingsDoc.data() : {};
      const recipient = settings.recipientEmail;
      if (!recipient) {
        logger.warn("weeklybackupemail: no recipientEmail in settings/backup, skipping");
        return null;
      }
      if (settings.emailEnabled === false) {
        logger.info("weeklybackupemail: emailEnabled=false, skipping");
        return null;
      }

      const startedAt = Date.now();
      const { dump, docCount, collectionsCount } = await buildFullJsonBackup();
      const json = JSON.stringify(dump);
      const datestr = new Date().toISOString().slice(0, 10);
      const fileName = `backups/weekly/backup-${datestr}.json`;

      // Archive to Storage (best-effort)
      try {
        const bucket = admin.storage().bucket(STORAGE_BUCKET);
        await bucket.file(fileName).save(json, { contentType: "application/json" });
      } catch (storageErr) {
        logger.warn("weeklybackupemail: storage archive failed (email still sends)", { error: storageErr.message });
      }

      const nodemailer = require("nodemailer");
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailUser.value(), pass: gmailAppPassword.value() },
      });
      const prettySize = json.length > 1024 * 1024
        ? (json.length / 1024 / 1024).toFixed(1) + " MB"
        : (json.length / 1024).toFixed(1) + " KB";

      // Gmail attachment limit is 25MB. If we exceed, the email will fail loudly -
      // that's a good signal that the user's data has grown and we need a different strategy.
      const mailOptions = {
        from: gmailUser.value(),
        to: recipient,
        subject: `🔐 גיבוי שבועי בייביז קלאב — ${datestr}`,
        text: [
          "שלום שיר 💜",
          "",
          "הגיבוי השבועי של בייביז קלאב מצורף.",
          "",
          `📊 סטטיסטיקה:`,
          `   • ${docCount.toLocaleString("he-IL")} מסמכים`,
          `   • ${collectionsCount} collections`,
          `   • גודל: ${prettySize}`,
          "",
          "📎 הקובץ מצורף ישירות לאימייל.",
          "",
          "💡 מומלץ לשמור את הקובץ במחשב או בענן אחר (Drive, Dropbox) כגיבוי חיצוני.",
          "",
          "בהצלחה!",
          "מערכת בייביז 🐾",
        ].join("\n"),
        attachments: [{
          filename: `babiez-backup-${datestr}.json`,
          content: json,
          contentType: "application/json",
        }],
      };
      await transporter.sendMail(mailOptions);

      await db.collection("backupLog").add({
        type: "weekly-email",
        startedAt,
        finishedAt: Date.now(),
        status: "success",
        date: datestr,
        path: `gs://${STORAGE_BUCKET}/${fileName}`,
        docCount,
        collectionsCount,
        sizeBytes: json.length,
        recipient,
        attached: true,
      });
      logger.info("weeklybackupemail: done", { recipient, sizeBytes: json.length });
      return null;
    } catch (e) {
      logger.error("weeklybackupemail: FAILED", { error: e.message, stack: e.stack });
      await db.collection("backupLog").add({
        type: "weekly-email",
        startedAt: Date.now(),
        status: "failed",
        error: e.message || String(e),
      });
      throw e;
    }
  }
);

/**
 * Send a pre-built PDF (assembled client-side from receipts + parking)
 * to the accountant via Gmail SMTP. Admin only.
 */
exports.sendreceiptstoaccountant = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [gmailUser, gmailAppPassword],
  },
  async (req) => {
    await requireAdmin(req.auth);
    const { pdfBase64, recipientEmail, subject, months, instructorName, parkingCount, regularCount } = req.data || {};
    if (!pdfBase64) throw new HttpsError("invalid-argument", "missing pdfBase64");
    if (!recipientEmail) throw new HttpsError("invalid-argument", "missing recipientEmail");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) {
      throw new HttpsError("invalid-argument", "invalid recipient email");
    }
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const sizeMB = (pdfBuffer.length / 1024 / 1024).toFixed(2);
    const monthsLabel = (months && months.length) ? months.join(", ") : "(כל החודשים)";
    const datestr = new Date().toISOString().slice(0, 10);
    const filename = `babiez-receipts-${(months || ["all"]).join("_")}.pdf`;
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser.value(), pass: gmailAppPassword.value() },
    });
    const body = [
      "שלום,",
      "",
      `מצורף קובץ PDF עם החשבוניות${parkingCount ? " וקבלות החניה" : ""} של בייביז קלאב.`,
      "",
      `📅 חודשים: ${monthsLabel}`,
      instructorName ? `👤 מדריכה: ${instructorName}` : "👥 כל המדריכות",
      `📄 ${regularCount || 0} חשבוניות${parkingCount ? `  ·  🅿 ${parkingCount} קבלות חניה` : ""}`,
      `📦 גודל הקובץ: ${sizeMB} MB`,
      "",
      "בברכה,",
      "מערכת בייביז 🐾",
    ].filter(Boolean).join("\n");
    try {
      await transporter.sendMail({
        from: gmailUser.value(),
        to: recipientEmail,
        subject: subject || `חשבוניות בייביז קלאב — ${monthsLabel}`,
        text: body,
        attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
      });
      await admin.firestore().collection("backupLog").add({
        type: "accountant-email",
        sentAt: Date.now(),
        recipient: recipientEmail,
        months: months || [],
        instructorName: instructorName || null,
        parkingCount: parkingCount || 0,
        regularCount: regularCount || 0,
        sizeBytes: pdfBuffer.length,
        by: req.auth.uid,
        date: datestr,
      });
      logger.info("sendreceiptstoaccountant: done", { recipient: recipientEmail, sizeBytes: pdfBuffer.length });
      return { success: true, sizeBytes: pdfBuffer.length, recipient: recipientEmail };
    } catch (e) {
      logger.error("sendreceiptstoaccountant: FAILED", { error: e.message });
      throw new HttpsError("internal", e.message || String(e));
    }
  }
);

/**
 * One-time deadline: removes '2026-06' from every instructor's unlockedMonths
 * at exactly 19/6/2026 16:00 Israel time. After this, the regular Friday-16:00
 * weekly lock kicks in for any June dates.
 *
 * Cron fires every June 19 at 16:00 - subsequent years are no-ops (no one
 * will have 2026-06 anymore), so it's safe to leave deployed.
 */
exports.expirejuneunlockcron = onSchedule(
  {
    schedule: "0 16 19 6 *",
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    timeoutSeconds: 300,
  },
  async (event) => {
    const db = admin.firestore();
    const MONTH_TO_EXPIRE = "2026-06";
    logger.info("expirejuneunlockcron: starting", { month: MONTH_TO_EXPIRE });
    try {
      const snap = await db.collection("users").where("role", "==", "instructor").get();
      let updated = 0, skipped = 0;
      const updates = [];
      snap.forEach(d => {
        const data = d.data();
        const cur = Array.isArray(data.unlockedMonths) ? data.unlockedMonths : [];
        if (!cur.includes(MONTH_TO_EXPIRE)) { skipped++; return; }
        const next = cur.filter(m => m !== MONTH_TO_EXPIRE);
        updates.push(d.ref.update({ unlockedMonths: next }));
        updated++;
      });
      await Promise.all(updates);
      logger.info("expirejuneunlockcron: done", { updated, skipped, month: MONTH_TO_EXPIRE });
      return null;
    } catch (e) {
      logger.error("expirejuneunlockcron: FAILED", { error: e.message, stack: e.stack });
      throw e;
    }
  }
);

/* ========================================================================
   AI ASSISTANT (Anthropic Claude)
   ======================================================================== */

function buildAssistantTools() {
  return [
    { name: "query_visits", description: "שולף דיווחי ביקור (records) לפי סינון. החזרת רשימה עם date, garden, instructorName, duration, groups, animal, classes, notes",
      input_schema: { type: "object", properties: {
        startDate: { type: "string", description: "YYYY-MM-DD - תאריך התחלה (כולל)" },
        endDate: { type: "string", description: "YYYY-MM-DD - תאריך סיום (כולל)" },
        instructorName: { type: "string", description: "שם מדריכה (חלקי - יתבצע contains)" },
        garden: { type: "string", description: "שם גן (חלקי)" },
        animal: { type: "string", description: "שם בעל חיים / מערך (חלקי)" },
        limit: { type: "number", description: "מקסימום תוצאות, default 200" }
      }}},
    { name: "query_users", description: "שולף משתמשים. החזרת רשימה עם name, username, role, gardens, specialty, phone, vatStatus",
      input_schema: { type: "object", properties: {
        role: { type: "string", enum: ["instructor", "admin"] },
        specialty: { type: "string", enum: ["animals","develop","dog","training"] },
        nameContains: { type: "string", description: "סינון לפי שם (חלקי)" }
      }}},
    { name: "query_gardens", description: "שולף גנים. החזרת רשימה עם name, address, phone, email, networkName, region, paymentTerms",
      input_schema: { type: "object", properties: {
        nameContains: { type: "string" },
        region: { type: "string" },
        networkName: { type: "string" }
      }}},
    { name: "query_receipts", description: "שולף חשבוניות וקבלות. החזרת רשימה עם month, instructorName, type, amount, storageUrl, note",
      input_schema: { type: "object", properties: {
        month: { type: "string", description: "YYYY-MM" },
        startMonth: { type: "string", description: "YYYY-MM (כולל)" },
        endMonth: { type: "string", description: "YYYY-MM (כולל)" },
        instructorName: { type: "string" },
        type: { type: "string", enum: ["regular", "parking"] }
      }}},
    { name: "query_materials", description: "שולף מערכים שבועיים. החזרת רשימה עם name, animalName, category, seasonality, summary",
      input_schema: { type: "object", properties: {
        category: { type: "string", enum: ["rodent","bird","chick","reptile","insect","generic"] },
        nameContains: { type: "string" }
      }}},
    { name: "query_auth_status", description: "שולף סטטוס כניסה (Firebase Auth) לכל המדריכות: האם ביצעו כניסה ראשונה, מתי הכניסה האחרונה, וכמה ימים עברו. שימושי לזיהוי 'מי לא נכנסה אף פעם' או 'מי לא נכנסה לאחרונה'.",
      input_schema: { type: "object", properties: {
        neverSignedIn: { type: "boolean", description: "true = החזרת רק מדריכות שלא נכנסו אף פעם" },
        inactiveDaysMin: { type: "number", description: "החזרת רק מדריכות שלא נכנסו N ימים או יותר (לפעיל=0)" },
        nameContains: { type: "string", description: "סינון לפי שם (חלקי)" }
      }}},
    { name: "export_excel", description: "מייצר קובץ אקסל מנתונים שהתקבלו. למשתמש יוצג ככפתור הורדה. יש להעביר sheets - מערך של גיליונות, כל אחד עם name + rows (מערך של אובייקטים).",
      input_schema: { type: "object", properties: {
        filename: { type: "string", description: "שם הקובץ (בלי .xlsx)" },
        sheets: { type: "array", description: "גיליונות. כל גיליון: { name: 'שם', rows: [{col1: val, col2: val}, ...] }",
          items: { type: "object", properties: { name: { type: "string" }, rows: { type: "array" } }, required: ["name", "rows"] }
        }
      }, required: ["filename", "sheets"] }
    }
  ];
}

async function execAssistantTool(toolName, toolInput, db, filesAccumulator) {
  if (toolName === "query_visits") {
    const snap = await db.collection("records").get();
    let recs = []; snap.forEach(d => recs.push(d.data()));
    if (toolInput.startDate) recs = recs.filter(r => (r.date||"") >= toolInput.startDate);
    if (toolInput.endDate) recs = recs.filter(r => (r.date||"") <= toolInput.endDate);
    if (toolInput.instructorName) { const q = toolInput.instructorName.toLowerCase(); recs = recs.filter(r => (r.instructorName||"").toLowerCase().includes(q)); }
    if (toolInput.garden) { const q = toolInput.garden.toLowerCase(); recs = recs.filter(r => (r.garden||"").toLowerCase().includes(q)); }
    if (toolInput.animal) { const q = toolInput.animal.toLowerCase(); recs = recs.filter(r => (r.animal||"").toLowerCase().includes(q)); }
    recs.sort((a,b) => (b.date||"").localeCompare(a.date||""));
    const limit = Math.min(toolInput.limit || 200, 500);
    return { totalMatching: recs.length, returned: Math.min(recs.length, limit), results: recs.slice(0, limit).map(r => ({
      date: r.date, garden: r.garden, instructorName: r.instructorName, duration: r.duration, groups: r.groups,
      animal: r.animal, classes: r.classes, notes: r.notes, timeIn: r.timeIn, signed: !!r.signature
    })) };
  }
  if (toolName === "query_users") {
    const snap = await db.collection("users").get();
    let users = []; snap.forEach(d => users.push(d.data()));
    if (toolInput.role) users = users.filter(u => u.role === toolInput.role);
    if (toolInput.specialty) users = users.filter(u => u.specialty === toolInput.specialty);
    if (toolInput.nameContains) { const q = toolInput.nameContains.toLowerCase(); users = users.filter(u => (u.name||"").toLowerCase().includes(q)); }
    return { count: users.length, results: users.map(u => ({
      name: u.name, username: u.username, role: u.role, specialty: u.specialty,
      gardens: u.gardens || [], phone: u.phone, vatStatus: u.vatStatus, region: u.region,
      gardenLimits: u.gardenLimits || {}
    })) };
  }
  if (toolName === "query_gardens") {
    const doc = await db.collection("meta").doc("gardens").get();
    let gardens = doc.exists ? (doc.data().items || []) : [];
    gardens = gardens.map(g => typeof g === "string" ? { name: g } : g);
    if (toolInput.nameContains) { const q = toolInput.nameContains.toLowerCase(); gardens = gardens.filter(g => (g.name||"").toLowerCase().includes(q)); }
    if (toolInput.region) gardens = gardens.filter(g => g.region === toolInput.region);
    if (toolInput.networkName) gardens = gardens.filter(g => g.networkName === toolInput.networkName);
    return { count: gardens.length, results: gardens };
  }
  if (toolName === "query_receipts") {
    const snap = await db.collection("receipts").get();
    let recs = []; snap.forEach(d => recs.push(d.data()));
    if (toolInput.month) recs = recs.filter(r => r.month === toolInput.month);
    if (toolInput.startMonth) recs = recs.filter(r => (r.month||"") >= toolInput.startMonth);
    if (toolInput.endMonth) recs = recs.filter(r => (r.month||"") <= toolInput.endMonth);
    if (toolInput.instructorName) { const q = toolInput.instructorName.toLowerCase(); recs = recs.filter(r => (r.instructorName||"").toLowerCase().includes(q)); }
    if (toolInput.type === "parking") recs = recs.filter(r => r.type === "parking");
    if (toolInput.type === "regular") recs = recs.filter(r => r.type !== "parking");
    return { count: recs.length, results: recs.map(r => ({
      month: r.month, instructorName: r.instructorName, type: r.type || "regular",
      amount: r.amount, uploadedAt: r.uploadedAt, note: r.note, storageUrl: r.storageUrl
    })) };
  }
  if (toolName === "query_materials") {
    const snap = await db.collection("materials").get();
    let mats = []; snap.forEach(d => mats.push(d.data()));
    if (toolInput.category) mats = mats.filter(m => m.category === toolInput.category);
    if (toolInput.nameContains) { const q = toolInput.nameContains.toLowerCase(); mats = mats.filter(m => (m.name||"").toLowerCase().includes(q)); }
    return { count: mats.length, results: mats.map(m => ({
      name: m.name, animalName: m.animalName, category: m.category, seasonality: m.seasonality,
      summary: m.summary, hasInstructorPdf: !!m.instructorPdfUrl, hasGardenPdf: !!m.gardenPdfUrl,
      audioCount: (m.audioFiles||[]).length
    })) };
  }
  if (toolName === "query_auth_status") {
    const usersSnap = await db.collection("users").get();
    const fsUsers = {};
    usersSnap.forEach(d => { const u = d.data(); if (u.role !== "admin") fsUsers[d.id] = u; });
    let pageToken = undefined;
    const authByUid = {};
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      page.users.forEach(u => { authByUid[u.uid] = u; });
      pageToken = page.pageToken;
    } while (pageToken);
    const now = Date.now();
    let rows = Object.keys(fsUsers).map(uid => {
      const fu = fsUsers[uid];
      const au = authByUid[uid];
      const lastSignIn = au && au.metadata && au.metadata.lastSignInTime ? au.metadata.lastSignInTime : null;
      const created = au && au.metadata && au.metadata.creationTime ? au.metadata.creationTime : null;
      const lastMs = lastSignIn ? Date.parse(lastSignIn) : null;
      const daysSince = lastMs ? Math.floor((now - lastMs) / 86400000) : null;
      return {
        name: fu.name, username: fu.username, phone: fu.phone || "",
        neverSignedIn: !lastSignIn, lastSignIn, daysSinceLastSignIn: daysSince,
        accountCreated: created, hasAuthAccount: !!au
      };
    });
    if (toolInput.neverSignedIn === true) rows = rows.filter(r => r.neverSignedIn);
    if (typeof toolInput.inactiveDaysMin === "number") rows = rows.filter(r => r.neverSignedIn || (r.daysSinceLastSignIn != null && r.daysSinceLastSignIn >= toolInput.inactiveDaysMin));
    if (toolInput.nameContains) { const q = toolInput.nameContains.toLowerCase(); rows = rows.filter(r => (r.name||"").toLowerCase().includes(q)); }
    rows.sort((a,b) => { if (a.neverSignedIn !== b.neverSignedIn) return a.neverSignedIn ? -1 : 1; return (b.daysSinceLastSignIn||0) - (a.daysSinceLastSignIn||0); });
    return { count: rows.length, results: rows };
  }
  if (toolName === "export_excel") {
    const XLSX = require("xlsx");
    const wb = XLSX.utils.book_new();
    (toolInput.sheets || []).forEach(sh => {
      const rows = sh.rows || [];
      const ws = rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([["(אין נתונים)"]]);
      const safeName = (sh.name || "Sheet").slice(0, 30).replace(/[\\\/\[\]\*\?:]/g, "");
      XLSX.utils.book_append_sheet(wb, ws, safeName || "Sheet");
    });
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const base64 = Buffer.from(buf).toString("base64");
    const filename = (toolInput.filename || "export") + ".xlsx";
    filesAccumulator.push({ filename, base64, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: buf.length });
    return { success: true, filename, sizeBytes: buf.length, message: "הקובץ נוצר. למשתמש יוצג כפתור הורדה." };
  }
  return { error: "unknown tool: " + toolName };
}

exports.askassistant = onCall(
  { region: "us-central1", timeoutSeconds: 180, memory: "1GiB", secrets: [anthropicApiKey] },
  async (req) => {
    await requireAdmin(req.auth);
    const { question, history } = req.data || {};
    if (!question || !String(question).trim()) throw new HttpsError("invalid-argument", "missing question");
    if (!anthropicApiKey.value()) throw new HttpsError("failed-precondition", "ANTHROPIC_API_KEY לא הוגדר");
    const db = admin.firestore();
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: anthropicApiKey.value() });
    const today = new Date().toISOString().slice(0, 10);
    const SYSTEM = `את עוזרת AI של אדמין אפליקציית בייביז קלאב — אפליקציה לניהול מדריכות חוגי חיות בגני ילדים בישראל.
מטרתך: לעזור לאדמין (שיר) לשלוף ולנתח מידע. את לא משנה נתונים — רק קוראת ומציגה.

📅 תאריך היום: ${today}
🎯 הקשר: 30+ מדריכות, 277+ גנים, 46 מערכים שבועיים, חשבוניות חודשיות + קבלות חניה.

🛠 הכלים: query_visits / query_users / query_gardens / query_receipts / query_materials / query_auth_status / export_excel

📋 הנחיות:
1. עני בעברית ברורה ומסודרת, השתמשי באמוג'י במידה.
2. כשמבקשים סטטיסטיקה — סכמי במספרים מפורשים.
3. כשמבקשים ייצוא — קראי ל-export_excel עם נתונים מסוננים.
4. אל תמציאי נתונים — הסתמכי רק על תוצאות הכלים.
5. שאלה לא ברורה → שאלי הבהרה קצרה.
6. הרבה נתונים → סכמי + הציעי לייצא אקסל.`;

    const messages = Array.isArray(history) ? history.slice(-10) : [];
    messages.push({ role: "user", content: question });

    const tools = buildAssistantTools();
    const filesAccumulator = [];
    let iterations = 0, finalText = "", totalInTokens = 0, totalOutTokens = 0, modelUsed = "";

    while (iterations < 10) {
      iterations++;
      const resp = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: SYSTEM,
        tools,
        messages,
      });
      modelUsed = resp.model;
      totalInTokens += resp.usage.input_tokens;
      totalOutTokens += resp.usage.output_tokens;
      messages.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason !== "tool_use") {
        finalText = resp.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        break;
      }
      const toolUses = resp.content.filter(b => b.type === "tool_use");
      const toolResults = [];
      for (const tu of toolUses) {
        try {
          const result = await execAssistantTool(tu.name, tu.input, db, filesAccumulator);
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 100000) });
        } catch (e) {
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "Error: " + (e.message || String(e)), is_error: true });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }

    await db.collection("aiAssistantLog").add({
      askedAt: Date.now(), by: req.auth.uid, question,
      answerPreview: (finalText || "").slice(0, 500), model: modelUsed,
      iterations, inputTokens: totalInTokens, outputTokens: totalOutTokens,
      filesCount: filesAccumulator.length,
    });

    return {
      success: true,
      answer: finalText || "(לא התקבלה תשובה)",
      files: filesAccumulator,
      usage: { input: totalInTokens, output: totalOutTokens, iterations },
      assistantHistory: messages.filter(m => m.role === "assistant" || m.role === "user").slice(-20),
    };
  }
);

/**
 * processcustomnotifications - runs every 15 minutes. Reads enabled custom
 * notifications, checks each schedule, and fires those that are due by writing
 * a notification doc per recipient (which triggers OneSignal via sendpushonnotification).
 */
exports.processcustomnotifications = onSchedule(
  { schedule: "*/15 * * * *", timeZone: "Asia/Jerusalem", region: "us-central1", timeoutSeconds: 300 },
  async () => {
    const db = admin.firestore();
    const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const nowMs = Date.now();
    logger.info("processcustomnotifications: starting", { israelTime: nowIsrael.toISOString() });
    const snap = await db.collection("customNotifications").where("enabled", "==", true).get();
    if (snap.empty) { logger.info("no enabled custom notifs"); return null; }
    const usersSnap = await db.collection("users").get();
    const users = []; usersSnap.forEach(d => users.push({ uid: d.id, ...d.data() }));
    const nonAdminUsers = users.filter(u => u.role !== "admin");
    const dueWindowMs = 16 * 60 * 1000;
    let fired = 0, skipped = 0;
    for (const docSnap of snap.docs) {
      const n = docSnap.data();
      const ref = docSnap.ref;
      const s = n.schedule || {};
      let scheduledTime = null;
      if (s.type === "daily") {
        const t = new Date(nowIsrael); t.setHours(s.hour || 0, s.minute || 0, 0, 0);
        scheduledTime = t.getTime();
      } else if (s.type === "weekly") {
        if (nowIsrael.getDay() !== (s.dayOfWeek || 0)) { skipped++; continue; }
        const t = new Date(nowIsrael); t.setHours(s.hour || 0, s.minute || 0, 0, 0);
        scheduledTime = t.getTime();
      } else if (s.type === "monthly") {
        if (nowIsrael.getDate() !== (s.dayOfMonth || 1)) { skipped++; continue; }
        const t = new Date(nowIsrael); t.setHours(s.hour || 0, s.minute || 0, 0, 0);
        scheduledTime = t.getTime();
      } else if (s.type === "once") {
        if (!s.date) { skipped++; continue; }
        scheduledTime = Date.parse(s.date);
        if (n.lastRunAt) { skipped++; continue; }
      } else { skipped++; continue; }
      const israelNowMs = nowIsrael.getTime();
      const drift = israelNowMs - scheduledTime;
      if (drift < 0 || drift > dueWindowMs) { skipped++; continue; }
      if (n.lastRunAt && (nowMs - n.lastRunAt) < dueWindowMs) { skipped++; continue; }
      const r = n.recipients || { type: "all" };
      let recipients = [];
      if (r.type === "all") recipients = nonAdminUsers;
      else if (r.type === "specialty" && r.specialty) recipients = nonAdminUsers.filter(u => u.specialty === r.specialty);
      else if (r.type === "specific" && Array.isArray(r.uids)) recipients = r.uids.map(uid => users.find(u => u.uid === uid || String(u.id) === String(uid))).filter(Boolean);
      logger.info("firing custom notif", { id: docSnap.id, title: n.title, recipients: recipients.length });
      const writes = recipients.map(u => {
        const id = Date.now() + Math.floor(Math.random() * 10000);
        return db.collection("notifications").doc(String(id)).set({
          id, recipientUid: u.uid || String(u.id),
          type: "custom_scheduled", icon: n.icon || "🔔",
          title: n.title || "התראה", body: n.body || "",
          link: null, createdAt: new Date().toISOString(),
          createdBy: n.createdBy || "system", createdByName: "מערכת התראות",
          read: false, readAt: null,
          customNotifId: docSnap.id,
        });
      });
      await Promise.all(writes);
      await ref.set({ lastRunAt: nowMs, lastRunRecipientCount: recipients.length }, { merge: true });
      fired++;
    }
    logger.info("processcustomnotifications: done", { fired, skipped });
    return null;
  }
);

// Parse camp schedule image (screenshot of WhatsApp, paper photo, Excel screenshot, etc.)
// via Claude Vision and return structured JSON of sessions.
exports.parsescheduleimage = onCall(
  { region: "us-central1", timeoutSeconds: 120, memory: "512MiB", secrets: [anthropicApiKey] },
  async (req) => {
    await requireAdmin(req.auth);
    const { imageBase64, mimeType, year, instructorName } = req.data || {};
    if (!imageBase64) throw new HttpsError("invalid-argument", "missing imageBase64");
    if (!year) throw new HttpsError("invalid-argument", "missing year");
    if (!anthropicApiKey.value()) throw new HttpsError("failed-precondition", "ANTHROPIC_API_KEY לא הוגדר");
    const mime = mimeType || "image/png";
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: anthropicApiKey.value() });
    const SYSTEM = `אתה מומחה לקריאת לוחות זמנים של מדריכות קייטנה בעברית. מקבל תמונה (צילום מסך, וואטסאפ, צילום נייר) ומחזיר JSON מובנה בלבד — בלי הסברים, בלי markdown.

הפלט חייב להיות בדיוק:
{
  "sessions": [
    {
      "date": "YYYY-MM-DD",
      "startTime": "HH:MM",
      "endTime": "HH:MM",
      "gardenName": "שם הגן/בית הספר",
      "address": "כתובת אם זוהתה (אופציונלי)",
      "groupsCount": 1
    }
  ],
  "warnings": ["אזהרות אם משהו לא ברור"]
}

כללי פירוש:
- שנת ${year} כברירת מחדל (השנה שהמשתמשת ציינה).
- תאריך בפורמט DD.MM או DD/MM → הפוך ל-YYYY-MM-DD.
- שעה בודדת (לדוגמה 09:00 ללא טווח) → endTime = startTime + 40 דק'.
- אם בתא רשום "X קבוצות" / "X קב'" → groupsCount = X. אחרת 1.
- שם הגן הוא הטקסט שלפני מקף "-" או פסיק; הכתובת אחריו.
- אם יש מספר ביקורים באותה תמונה — החזר את כולם.
- אם מספר ימים בתמונה — תאריך לכל ביקור לפי הכותרת.
${instructorName ? `- שם המדריכה שמופיעה בתמונה: ${instructorName} (לידיעה).` : ""}

החזר רק את ה-JSON, בלי שום טקסט נוסף.`;

    const resp = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: imageBase64 } },
          { type: "text", text: "פרק את הלוז שבתמונה ל-JSON לפי הסכמה. החזר רק JSON." },
        ],
      }],
    });
    const text = resp.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    let parsed;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : text);
    } catch (e) {
      logger.error("parse failed:", text);
      throw new HttpsError("internal", "תגובת Claude לא בפורמט JSON תקין: " + text.slice(0, 200));
    }
    if (!parsed.sessions || !Array.isArray(parsed.sessions)) parsed.sessions = [];
    if (!parsed.warnings) parsed.warnings = [];
    logger.info("parsescheduleimage:", { count: parsed.sessions.length, inTokens: resp.usage.input_tokens, outTokens: resp.usage.output_tokens });
    return { sessions: parsed.sessions, warnings: parsed.warnings, tokens: { input: resp.usage.input_tokens, output: resp.usage.output_tokens } };
  }
);

// Parse WEEKLY schedule image (recurring, Sun-Thu template) via Claude Vision.
// Returns entries with day-of-week + times + garden match against instructor's assigned gardens.
exports.parseweeklyscheduleimage = onCall(
  { region: "us-central1", timeoutSeconds: 120, memory: "512MiB", secrets: [anthropicApiKey] },
  async (req) => {
    await requireAdmin(req.auth);
    const { imageBase64, mimeType, gardens, instructorName } = req.data || {};
    if (!imageBase64) throw new HttpsError("invalid-argument", "missing imageBase64");
    if (!Array.isArray(gardens) || !gardens.length) throw new HttpsError("invalid-argument", "missing gardens array");
    if (!anthropicApiKey.value()) throw new HttpsError("failed-precondition", "ANTHROPIC_API_KEY לא הוגדר");
    const mime = mimeType || "image/png";
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: anthropicApiKey.value() });
    const gardenList = gardens.map((g, i) => `${i + 1}. ${g}`).join("\n");
    const SYSTEM = `אתה מומחה לקריאת לוחות שיבוץ שבועי (רקורנטי) של מדריכות חוגים בגני ילדים בישראל. אתה מקבל תמונה של טבלה שבועית ומחזיר JSON מובנה של השיבוצים.

מבנה נפוץ של הטבלה: עמודות = ימי השבוע (ראשון, שני, שלישי, רביעי, חמישי, לפעמים שישי). כל תא יכול לכלול: שעה התחלה, שעה סיום, שם גן/מסגרת, הערה על מספר קבוצות/חלוקה/כתובת.

רשימת הגנים המשוייכים למדריכה — התאם כל שיבוץ לגן הכי דומה מהרשימה. אם לא מזוהה בבטחון — סמן confidence: "low" והשאר את הטקסט המקורי ב-gardenRaw:
${gardenList}

הפלט חייב להיות JSON בלבד:
{
  "entries": [
    {
      "day": 0,
      "start": "HH:MM",
      "end": "HH:MM",
      "gardenGuess": "שם מדויק מהרשימה או null אם לא זוהה",
      "gardenConfidence": "high|medium|low",
      "gardenRaw": "הטקסט המקורי מהתמונה",
      "note": "הערות נוספות (מספר קבוצות, חלוקה, כתובת) או null"
    }
  ],
  "warnings": []
}

מיפוי ימים: ראשון=0, שני=1, שלישי=2, רביעי=3, חמישי=4, שישי=5.
- אל תמציא שיבוצים שלא בתמונה.
- אם השעה לא ברורה — "??:??".
- אם התאריך רשום (ולא שם יום) — התעלם מהתאריך והשתמש רק בשם היום.
- שמור על סדר השיבוצים בכל יום לפי השעה.
${instructorName ? `- שם המדריכה: ${instructorName} (לידיעה).` : ""}
- החזר רק JSON תקין, בלי טקסט לפני או אחרי, בלי markdown.`;

    const resp = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: imageBase64 } },
          { type: "text", text: "פרק את הלוח השבועי שבתמונה ל-JSON לפי הסכמה. החזר רק JSON." },
        ],
      }],
    });
    const text = resp.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    let parsed;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : text);
    } catch (e) {
      logger.error("parseweeklyscheduleimage parse failed:", text);
      throw new HttpsError("internal", "תגובת Claude לא בפורמט JSON תקין: " + text.slice(0, 200));
    }
    if (!parsed.entries || !Array.isArray(parsed.entries)) parsed.entries = [];
    if (!parsed.warnings) parsed.warnings = [];
    logger.info("parseweeklyscheduleimage:", { count: parsed.entries.length, inTokens: resp.usage.input_tokens, outTokens: resp.usage.output_tokens });
    return { entries: parsed.entries, warnings: parsed.warnings, tokens: { input: resp.usage.input_tokens, output: resp.usage.output_tokens } };
  }
);

// Analyze a tender / RFP / contract PDF via Claude and return structured JSON.
exports.analyzetender = onCall(
  { region: "us-central1", timeoutSeconds: 300, memory: "1GiB", secrets: [anthropicApiKey] },
  async (req) => {
    await requireAdmin(req.auth);
    const { pdfBase64, filename } = req.data || {};
    if (!pdfBase64) throw new HttpsError("invalid-argument", "missing pdfBase64");
    if (!anthropicApiKey.value()) throw new HttpsError("failed-precondition", "ANTHROPIC_API_KEY לא הוגדר");
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: anthropicApiKey.value() });
    const today = new Date().toISOString().slice(0, 10);
    const SYSTEM = `אתה עוזר מנוסה לחברה בייביז קלאב - חוגי חיות לגיל הרך בישראל (גני ילדים, צהרונים, קייטנות). את מקבלת קולות קוראים, מכרזים, חוזים, הסכמים, ומחזירה ניתוח מובנה בעברית.

תאריך היום: ${today}

הפלט חייב להיות JSON בלבד, בלי טקסט מקדים, בלי markdown. הפורמט:
{
  "title": "שם קצר ומדויק של המכרז/הקול הקורא (מקסימום 70 תווים)",
  "issuer": "מי פרסם — שם העמותה/הרשות/המשרד",
  "summary": "תקציר 2-4 משפטים: על מה המכרז, מטרתו, ולמי הוא מיועד",
  "deadline": "YYYY-MM-DD אם זוהה תאריך הגשה אחרון, אחרת null",
  "scope": {
    "areas": ["אזורים גיאוגרפיים מותרים — ערים/יישובים/מועצות"],
    "venues": ["מסגרות לפעילות — גנים, צהרונים, בתי ספר, מתנ\"סים וכו"],
    "topics": ["תחומים שמתאימים לבייביז — חיות, טבע, העשרה, אילוף, מדעים"]
  },
  "fitForBabiez": "high/medium/low — עד כמה זה מתאים לפעילות של חוגי חיות לגיל הרך, עם הסבר משפט",
  "requiredDocs": [
    {"name": "שם המסמך", "page": "עמ' X סע' Y", "mandatory": true, "category": "company/instructor/legal/insurance/professional/financial", "notes": "הערה רלוונטית או null"}
  ],
  "obligations": ["התחייבויות עיקריות של המגיש"],
  "payment": "מידע על תמחור/תשלום אם מצוין, אחרת null",
  "redFlags": ["דגלים אדומים — סיכונים, סעיפים בעייתיים, אי-התחייבות לעבודה וכו"],
  "todos": ["משימות מסודרות שעל המגיש לבצע"],
  "questions": ["נקודות לא ברורות שכדאי לוודא לפני הגשה"]
}

הנחיות:
- היה מדויק ולא להמציא. אם משהו לא ברור, ציין ב-questions.
- requiredDocs - כל המסמכים הנדרשים, עם הפניה לעמוד/סעיף בקול הקורא. הקטגוריה: company=עסק (אישור עוסק, ניהול ספרים), instructor=מדריך (ק.ח, אישור משטרה), legal=משפטי (תצהיר ניגוד עניינים), insurance=ביטוח, professional=הסמכות מקצועיות, financial=כספי.
- fitForBabiez — חוגי חיות לגיל הרך הם פעילות חינוכית בלתי-פורמלית בתחומי טבע, חיות, מדעים, העשרה. אם המכרז מבקש דברים כאלה — high. אם מתאים חלקית — medium. אם לא רלוונטי בכלל (לדוגמה משפטים, בנייה) — low.
- אם המסמך לא מכרז אלא חוזה רגיל / הודעה — אותו פורמט, מתואם לתוכן.
- היה תמציתי אבל מקיף. החזר רק JSON.`;

    let resp;
    try {
      resp = await client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
            { type: "text", text: `נתח את המסמך הזה לפי הסכמה. החזר רק JSON. שם הקובץ: ${filename || 'unknown.pdf'}` }
          ]
        }]
      });
    } catch (apiErr) {
      const msg = String((apiErr && apiErr.message) || apiErr || "");
      const errType = apiErr && apiErr.error && apiErr.error.error && apiErr.error.error.type;
      logger.error("Anthropic API failed", { status: apiErr && apiErr.status, type: errType, msg: msg.slice(0, 300) });
      if (/credit balance is too low|insufficient_quota/i.test(msg) || errType === "insufficient_quota") {
        throw new HttpsError("resource-exhausted", "חשבון ה־Anthropic API אזל מקרדיטים. יש להוסיף אשראי ב־console.anthropic.com/settings/billing ולנסות שוב.");
      }
      if (apiErr && apiErr.status === 429) {
        throw new HttpsError("resource-exhausted", "Rate limit של Anthropic. נסי שוב בעוד דקה.");
      }
      if (errType === "authentication_error" || (apiErr && apiErr.status === 401)) {
        throw new HttpsError("failed-precondition", "מפתח Anthropic API לא תקין. פני למפתח לעדכן את הסיקרט.");
      }
      throw new HttpsError("internal", "Anthropic החזירה שגיאה: " + msg.slice(0, 200));
    }
    const text = resp.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    let parsed;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : text);
    } catch (e) {
      logger.error("tender parse failed:", text.slice(0, 1000));
      throw new HttpsError("internal", "Claude החזירה תגובה לא תקינה: " + text.slice(0, 200));
    }
    logger.info("analyzetender:", {
      title: parsed.title,
      docsCount: (parsed.requiredDocs || []).length,
      fit: parsed.fitForBabiez,
      inTokens: resp.usage.input_tokens,
      outTokens: resp.usage.output_tokens
    });
    return {
      analysis: parsed,
      tokens: { input: resp.usage.input_tokens, output: resp.usage.output_tokens }
    };
  }
);

/**
 * sendafterschoolreportemail - Send an After-School report (Excel) as a real
 * email attachment via Gmail SMTP. Admin only.
 *
 * Replaces the old mailto: flow where the user had to attach the file by hand.
 * The client builds the .xlsx, encodes it Base64, and calls this function; we
 * decode to a Buffer and attach it directly to the outgoing mail.
 *
 * Params (request.data):
 *   recipientEmail (string) - destination email (single address)
 *   subject        (string) - email subject
 *   body           (string) - Hebrew message body (plain text)
 *   base64File     (string) - the .xlsx file, Base64-encoded
 *   fileName       (string) - attachment filename (e.g. אפטר_סקול_צהרון_2026-07.xlsx)
 *   reportType     (string) - report kind for logging (tzaharon/talan/nivkharot)
 *
 * Secret: GMAIL_APP_PASSWORD (+ GMAIL_USER) - set via firebase functions:secrets:set
 */
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const AFTERSCHOOL_REPORT_TYPES = ["tzaharon", "talan", "nivkharot"];

exports.sendafterschoolreportemail = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [gmailUser, gmailAppPassword],
  },
  async (req) => {
    await requireAdmin(req.auth);

    const { recipientEmail, subject, body, base64File, fileName, reportType } = req.data || {};

    // --- Validate inputs (Hebrew errors, consistent with sibling functions) ---
    if (!recipientEmail) throw new HttpsError("invalid-argument", "חסר אימייל יעד (recipientEmail).");
    // Support one or many recipients (comma/semicolon separated). Validate each.
    const _recipParts = String(recipientEmail).split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
    const _emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    const _badRecips = _recipParts.filter((e) => !_emailRe.test(e));
    if (_recipParts.length === 0 || _badRecips.length > 0) {
      throw new HttpsError("invalid-argument", "כתובת אימייל לא תקינה: " + (_badRecips.join(", ") || recipientEmail));
    }
    const _recipCombined = _recipParts.join(", ");
    if (!base64File) throw new HttpsError("invalid-argument", "חסר קובץ מצורף (base64File).");
    if (!fileName) throw new HttpsError("invalid-argument", "חסר שם קובץ (fileName).");
    if (!subject) throw new HttpsError("invalid-argument", "חסר נושא (subject).");

    // reportType is for logging only - keep it clean but don't hard-fail on an unknown value
    const safeReportType = AFTERSCHOOL_REPORT_TYPES.includes(reportType) ? reportType : (reportType || "unknown");

    // Base64 -> Buffer for the attachment
    let fileBuffer;
    try {
      fileBuffer = Buffer.from(base64File, "base64");
    } catch (e) {
      throw new HttpsError("invalid-argument", "קובץ Base64 לא תקין.");
    }
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new HttpsError("invalid-argument", "הקובץ המצורף ריק.");
    }

    const datestr = new Date().toISOString().slice(0, 10);
    const startedAt = Date.now();

    // Gmail over explicit SMTP (smtp.gmail.com:465, TLS). Auth via GMAIL_USER + GMAIL_APP_PASSWORD.
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true, // TLS
      auth: { user: gmailUser.value(), pass: gmailAppPassword.value() },
    });

    try {
      await transporter.sendMail({
        from: gmailUser.value(),
        to: _recipCombined,
        subject: subject,
        text: body || "",
        attachments: [{
          filename: fileName,
          content: fileBuffer,
          contentType: XLSX_MIME,
        }],
      });

      await admin.firestore().collection("backupLog").add({
        type: "afterschool-report-email",
        reportType: safeReportType,
        startedAt,
        finishedAt: Date.now(),
        status: "success",
        recipient: _recipCombined,
        fileName,
        sizeBytes: fileBuffer.length,
        by: req.auth.uid,
        date: datestr,
      });

      logger.info("sendafterschoolreportemail: done", {
        recipient: recipientEmail,
        reportType: safeReportType,
        fileName,
        sizeBytes: fileBuffer.length,
      });

      return {
        success: true,
        recipient: recipientEmail,
        reportType: safeReportType,
        fileName,
        sizeBytes: fileBuffer.length,
        message: "הדוח נשלח בהצלחה אל " + recipientEmail,
      };
    } catch (e) {
      logger.error("sendafterschoolreportemail: FAILED", { error: e.message, recipient: recipientEmail, reportType: safeReportType });
      await admin.firestore().collection("backupLog").add({
        type: "afterschool-report-email",
        reportType: safeReportType,
        startedAt,
        finishedAt: Date.now(),
        status: "failed",
        recipient: recipientEmail,
        fileName: fileName || null,
        error: e.message || String(e),
        by: req.auth && req.auth.uid,
        date: datestr,
      });
      throw new HttpsError("internal", "שליחת המייל נכשלה: " + (e.message || String(e)));
    }
  }
);

/**
 * sendcalendarremindings — MARKER:CAL_REMINDERS_V1
 * Runs every 5 minutes. Reads adminCalendarEvents where reminderMinutesBefore is set
 * and reminderSentAt is null. If NOW is inside the reminder window
 * (reminderTime ≤ now < eventStart + 5m), fans out an in-app notification to every
 * admin user (users with role == 'admin'). Each notification doc triggers
 * sendpushonnotification, which delivers the push via OneSignal.
 *
 * The event is marked with reminderSentAt so we don't send twice. If the admin edits
 * the reminderMinutesBefore / date / startTime, the app resets reminderSentAt to null.
 */
exports.sendcalendarremindings = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    timeoutSeconds: 120,
  },
  async () => {
    const startedAt = Date.now();
    logger.info("sendcalendarremindings: start");

    // "now" in Israel time — we compare to date+startTime stored as local strings.
    const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const WINDOW_MS = 5 * 60 * 1000; // must match the schedule cadence

    let candidates;
    try {
      candidates = await admin.firestore()
        .collection("adminCalendarEvents")
        .where("reminderMinutesBefore", ">", 0)
        .get();
    } catch (e) {
      logger.error("sendcalendarremindings: failed to query events", { error: e.message });
      return;
    }

    if (candidates.empty) {
      logger.info("sendcalendarremindings: no events with reminder");
      return;
    }

    // Load admins once, reuse across all reminders in this run.
    let adminIds = [];
    try {
      const adminsSnap = await admin.firestore().collection("users").where("role", "==", "admin").get();
      adminsSnap.forEach(d => { adminIds.push(d.id); });
    } catch (e) {
      logger.error("sendcalendarremindings: failed to load admins", { error: e.message });
      return;
    }
    if (!adminIds.length) {
      logger.warn("sendcalendarremindings: no admins found — skipping all");
      return;
    }
    logger.info("sendcalendarremindings: admins loaded", { count: adminIds.length });

    let scanned = 0, sent = 0, skipped = 0, errors = 0;

    for (const doc of candidates.docs) {
      scanned++;
      const ev = doc.data() || {};

      if (ev.reminderSentAt) { skipped++; continue; }
      if (!ev.date || !ev.startTime) { skipped++; continue; }

      const mins = Number(ev.reminderMinutesBefore);
      if (!isFinite(mins) || mins <= 0) { skipped++; continue; }

      // event start as a local Date (Israel time). Format: YYYY-MM-DD + HH:MM
      const startStr = String(ev.date) + "T" + String(ev.startTime) + ":00";
      const eventStart = new Date(startStr);
      if (isNaN(eventStart.getTime())) { skipped++; continue; }

      const reminderTime = new Date(eventStart.getTime() - mins * 60 * 1000);

      // Window: reminderTime ≤ nowIsrael < eventStart + WINDOW_MS
      // (extra WINDOW_MS after start is a safety net in case scheduler was late)
      if (nowIsrael < reminderTime) { skipped++; continue; }
      if (nowIsrael >= eventStart.getTime() + WINDOW_MS) {
        // Too late — mark as sent so we don't keep scanning stale events forever.
        try {
          await doc.ref.update({ reminderSentAt: new Date().toISOString(), reminderSentSkipped: "too_late" });
        } catch (_) { /* noop */ }
        skipped++;
        continue;
      }

      // Compute a friendly "in X minutes" text.
      const minsLeft = Math.max(0, Math.round((eventStart.getTime() - nowIsrael.getTime()) / 60000));
      let leftTxt;
      if (minsLeft <= 0) leftTxt = "עכשיו";
      else if (minsLeft < 60) leftTxt = "עוד " + minsLeft + " דקות";
      else if (minsLeft < 1440) leftTxt = "עוד " + Math.round(minsLeft / 60) + " שעות";
      else leftTxt = "עוד " + Math.round(minsLeft / 1440) + " ימים";

      const title = "🗓 " + (ev.title || "אירוע ביומן");
      const bodyParts = [leftTxt];
      if (ev.startTime) bodyParts.push("בשעה " + ev.startTime);
      if (ev.location) bodyParts.push("📍 " + ev.location);
      if (ev.contactPhone) bodyParts.push("📞 " + ev.contactPhone);
      const body = bodyParts.join(" · ");

      // Fan out to every admin.
      const now = new Date().toISOString();
      let fanoutOk = 0, fanoutFail = 0;
      for (const uid of adminIds) {
        try {
          const notifId = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
          await admin.firestore().collection("notifications").doc(notifId).set({
            id: notifId,
            recipientUid: uid,
            type: "calendar_reminder",
            icon: "🗓",
            title,
            body,
            link: { screen: "cal", eventId: doc.id },
            eventId: doc.id,
            createdAt: now,
            createdBy: "system",
            createdByName: "יומן אדמין",
            read: false,
            readAt: null,
          });
          fanoutOk++;
        } catch (e) {
          fanoutFail++;
          logger.warn("sendcalendarremindings: notification create failed", { eventId: doc.id, uid, error: e.message });
        }
      }

      try {
        await doc.ref.update({
          reminderSentAt: now,
          reminderSentToCount: fanoutOk,
        });
      } catch (e) {
        logger.warn("sendcalendarremindings: failed to mark event", { eventId: doc.id, error: e.message });
      }

      logger.info("sendcalendarremindings: reminder dispatched", {
        eventId: doc.id,
        title: ev.title || "(no title)",
        eventStart: startStr,
        reminderMinutesBefore: mins,
        minsLeft,
        admins: adminIds.length,
        fanoutOk,
        fanoutFail,
      });
      sent++;
      if (fanoutFail) errors++;
    }

    logger.info("sendcalendarremindings: done", {
      durationMs: Date.now() - startedAt,
      scanned,
      sent,
      skipped,
      errors,
      adminCount: adminIds.length,
    });
  }
);

/**
 * generatepdfreport - server-side PDF rendering via Puppeteer + @sparticuz/chromium.
 *
 * Why: client-side html2pdf.js (html2canvas + jsPDF) breaks Hebrew text
 * ("שיר דיין" -> "שירדיין") and produces blank pages on iOS Safari.
 * Chromium renders Hebrew faithfully, and the output PDF is a real file
 * the phone only needs to display, not generate.
 *
 * Input: { html, filename?, format?, orientation? }
 * Output: { pdfBase64 } - base64-encoded PDF bytes
 *
 * Admin-only. Memory 1GiB, timeout 90s (cold start of headless Chromium is
 * 10-30s). Region us-central1 to match the rest of the codebase.
 */
exports.generatepdfreport = onCall(
  { region: "us-central1", timeoutSeconds: 90, memory: "1GiB" },
  async (req) => {
    await requireAdmin(req.auth);
    const { html, format, orientation } = req.data || {};
    if (!html || typeof html !== "string") {
      throw new HttpsError("invalid-argument", "missing html");
    }
    if (html.length > 5 * 1024 * 1024) {
      throw new HttpsError("invalid-argument", "html too large (>5MB)");
    }

    const t0 = Date.now();
    logger.info("generatepdfreport start", {
      by: req.auth.uid,
      htmlBytes: html.length,
      format: format || "a4",
      orientation: orientation || "portrait",
    });

    const chromium = require("@sparticuz/chromium");
    const puppeteer = require("puppeteer-core");

    // Wrap the HTML fragment (already includes dir="rtl" on the outer div)
    // in a proper document so Chromium picks up Hebrew fonts + print styles.
    const fullHtml = `<!doctype html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  body{font-family:"Segoe UI","Arial Hebrew",Arial,sans-serif;}
  @page{size:${(format || "a4").toUpperCase()} ${orientation === "landscape" ? "landscape" : "portrait"};margin:0;}
</style>
</head>
<body>${html}</body>
</html>`;

    let browser = null;
    try {
      browser = await puppeteer.launch({
        args: [
          ...chromium.args,
          "--font-render-hinting=none",
          "--disable-lcd-text",
        ],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });

      const page = await browser.newPage();
      await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 30000 });
      await page.emulateMediaType("print");
      const pdfBuffer = await page.pdf({
        format: (format || "A4").toUpperCase(),
        landscape: orientation === "landscape",
        printBackground: true,
        preferCSSPageSize: false,
        margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      });

      const elapsed = Date.now() - t0;
      logger.info("generatepdfreport done", {
        by: req.auth.uid,
        elapsedMs: elapsed,
        pdfBytes: pdfBuffer.length,
      });
      return { pdfBase64: Buffer.from(pdfBuffer).toString("base64") };
    } catch (e) {
      logger.error("generatepdfreport failed", {
        by: req.auth ? req.auth.uid : null,
        elapsedMs: Date.now() - t0,
        error: e && e.message,
        stack: e && e.stack,
      });
      throw new HttpsError("internal", "PDF render failed: " + (e && e.message ? e.message : String(e)));
    } finally {
      if (browser) {
        try { await browser.close(); } catch (_) {}
      }
    }
  }
);

/* ================================================================
 * GMAIL INVOICE / RECEIPT IMPORT
 *
 * Two functions + one HTTP callback:
 *   - getgmailauthurl (onCall, admin)  → returns OAuth consent URL
 *   - oauthgmailcallback (onRequest)   → OAuth redirect handler, stores refresh_token
 *   - syncgmailimports (onCall, admin) → pulls new emails for one Gmail account
 *
 * Storage layout:
 *   gs://<bucket>/email-imports/<accountKey>/<msgId>/<filename>
 *
 * Firestore:
 *   emailImports/{docId}    (per-attachment doc; keyed as `${msgId}_${attachmentIdx}`)
 *   gmailTokens/{accountKey} (per-account refresh_token — admin-only via rules)
 *
 * accountKey is the sanitized email (dots kept, @ replaced with _at_) so
 * doc IDs are safe. Example: babies.offices_at_gmail.com
 * ================================================================ */

const gmailOauthClientId = defineSecret("GMAIL_OAUTH_CLIENT_ID");
const gmailOauthClientSecret = defineSecret("GMAIL_OAUTH_CLIENT_SECRET");

const GMAIL_OAUTH_REDIRECT = "https://us-central1-babiez-app.cloudfunctions.net/oauthgmailcallback";
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const RECEIPT_KEYWORDS_HE = ["חשבונית", "קבלה", "מס-קבלה", "מס קבלה"];
const RECEIPT_KEYWORDS_EN = ["invoice", "receipt", "tax invoice"];
// Senders whose emails are copies of OUTGOING invoices (Morning/GreenInvoice) —
// not expenses. Also excludes anything sent by the user herself (from:me).
const EXCLUDED_SENDER_DOMAINS = [
  "greeninvoice.co.il",
  "morning.co.il",
  "morningaction.co.il",
];
const RECEIPT_MIME_ALLOWED = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/webp",
]);

function accountKey(email) {
  return String(email || "").trim().toLowerCase().replace(/@/g, "_at_");
}

function decodeBase64Url(s) {
  if (!s) return Buffer.alloc(0);
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function extractHeaders(payload) {
  const out = { From: "", Subject: "", Date: "" };
  if (!payload || !payload.headers) return out;
  for (const h of payload.headers) {
    if (h.name === "From") out.From = h.value || "";
    else if (h.name === "Subject") out.Subject = h.value || "";
    else if (h.name === "Date") out.Date = h.value || "";
  }
  return out;
}

// Walk MIME parts recursively; yields {filename, mimeType, attachmentId}
function collectAttachments(payload) {
  const out = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename && part.body && part.body.attachmentId) {
      out.push({
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        attachmentId: part.body.attachmentId,
        sizeBytes: part.body.size || 0,
      });
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  };
  walk(payload);
  return out;
}

function parseFromHeader(from) {
  // "John <john@x.com>" → {name:"John", email:"john@x.com"}
  if (!from) return { name: "", email: "" };
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: String(from).trim().toLowerCase() };
}

async function makeOAuthClient() {
  const { google } = require("googleapis");
  return new google.auth.OAuth2(
    String(gmailOauthClientId.value() || "").trim(),
    String(gmailOauthClientSecret.value() || "").trim(),
    GMAIL_OAUTH_REDIRECT
  );
}

exports.getgmailauthurl = onCall(
  {
    region: "us-central1",
    secrets: [gmailOauthClientId, gmailOauthClientSecret],
  },
  async (req) => {
    await requireAdmin(req.auth);
    const account = String(req.data && req.data.account || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account)) {
      throw new HttpsError("invalid-argument", "invalid account email");
    }
    if (!gmailOauthClientId.value() || !gmailOauthClientSecret.value()) {
      throw new HttpsError("failed-precondition",
        "OAuth Client not configured — see setup docs");
    }
    const oauth2Client = await makeOAuthClient();
    // state = accountKey + random nonce (verify on callback)
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const state = accountKey(account) + "|" + nonce;
    // Persist state so callback can validate + know which account it belongs to
    await admin.firestore().collection("gmailOAuthState").doc(nonce).set({
      accountKey: accountKey(account),
      account,
      createdAt: Date.now(),
      createdBy: req.auth.uid,
    });
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",          // force refresh_token issuance
      scope: GMAIL_SCOPES,
      login_hint: account,
      state,
    });
    return { url };
  }
);

exports.oauthgmailcallback = onRequest(
  {
    region: "us-central1",
    secrets: [gmailOauthClientId, gmailOauthClientSecret],
    invoker: "public",
  },
  async (req, res) => {
    try {
      const code = req.query.code;
      const state = String(req.query.state || "");
      const err = req.query.error;
      if (err) {
        res.status(400).send(`<meta charset="utf-8"><h2 style="font-family:sans-serif;color:#b91c1c">שגיאת OAuth: ${err}</h2><p>סגרי חלון זה ונסי שוב.</p>`);
        return;
      }
      if (!code || !state || !state.includes("|")) {
        res.status(400).send("<meta charset='utf-8'><h2>Missing code/state.</h2>");
        return;
      }
      const [accKey, nonce] = state.split("|");
      const db = admin.firestore();
      const stateDoc = await db.collection("gmailOAuthState").doc(nonce).get();
      if (!stateDoc.exists) {
        res.status(400).send("<meta charset='utf-8'><h2>State expired or invalid.</h2>");
        return;
      }
      const stateData = stateDoc.data();
      if (stateData.accountKey !== accKey) {
        res.status(400).send("<meta charset='utf-8'><h2>State mismatch.</h2>");
        return;
      }
      const oauth2Client = await makeOAuthClient();
      const { tokens } = await oauth2Client.getToken(code);
      if (!tokens.refresh_token) {
        res.status(400).send(`<meta charset="utf-8"><h2>לא התקבל refresh_token</h2><p>לכי ל־<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, מחקי את ההרשאה של "בייביז קלאב" ונסי שוב.</p>`);
        return;
      }
      await db.collection("gmailTokens").doc(accKey).set({
        account: stateData.account,
        accountKey: accKey,
        refreshToken: tokens.refresh_token,
        scope: tokens.scope || GMAIL_SCOPES.join(" "),
        connectedAt: Date.now(),
        connectedBy: stateData.createdBy,
      }, { merge: true });
      await stateDoc.ref.delete().catch(() => {});
      const returnUrl = "https://babiesclub.github.io/babies-employees/?gmailConnected=" + encodeURIComponent(stateData.account);
      res.status(200).send(`<!doctype html><meta charset="utf-8"><title>חובר בהצלחה</title>
<div style="font-family:sans-serif;text-align:center;padding:40px;line-height:1.6">
  <h1 style="color:#16a34a">✓ חובר בהצלחה</h1>
  <p>החשבון <b>${stateData.account}</b> מחובר כעת לבייביז קלאב.</p>
  <p><a href="${returnUrl}" style="background:#16a34a;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:12px">חזרי לאפליקציה</a></p>
</div>`);
    } catch (e) {
      logger.error("oauthgmailcallback failed", { error: e && e.message, stack: e && e.stack });
      res.status(500).send(`<meta charset="utf-8"><h2 style="font-family:sans-serif;color:#b91c1c">שגיאה</h2><pre>${(e && e.message) || String(e)}</pre>`);
    }
  }
);

// Build a Gmail search query. sinceDate = older bound (after:). beforeDate = newer bound (before:).
function buildGmailQuery(sinceDate, beforeDate) {
  const kw = [...RECEIPT_KEYWORDS_HE, ...RECEIPT_KEYWORDS_EN]
    .map(k => `"${k}"`).join(" OR ");
  const attachFilter = "(has:attachment AND (filename:pdf OR filename:jpg OR filename:jpeg OR filename:png))";
  const kwFilter = `(subject:(${kw}) OR ${kw})`;
  const excludeSenders = EXCLUDED_SENDER_DOMAINS.map(d => `-from:${d}`).join(" ");
  // in:inbox — only her inbox (not Sent, not archived-to-label-only).
  // -from:me — exclude anything she sent herself.
  // -from:@greeninvoice.co.il etc — exclude Morning outgoing invoice copies.
  let q = `in:inbox -from:me ${excludeSenders} (${attachFilter}) AND (${kwFilter} OR has:attachment)`;
  const fmt = d => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
  if (sinceDate) q += ` after:${fmt(sinceDate)}`;
  if (beforeDate) q += ` before:${fmt(beforeDate)}`;
  return q;
}

exports.syncgmailimports = onCall(
  {
    region: "us-central1",
    secrets: [gmailOauthClientId, gmailOauthClientSecret],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req) => {
    await requireAdmin(req.auth);
    const account = String(req.data && req.data.account || "").trim().toLowerCase();
    const sinceDaysBack = Math.max(0, Math.min(3650, parseInt(req.data && req.data.sinceDaysBack, 10) || 30));
    const fromMonth = String((req.data && req.data.fromMonth) || "").trim();  // "YYYY-MM"
    const toMonth = String((req.data && req.data.toMonth) || "").trim();      // "YYYY-MM"
    const monthRe = /^\d{4}-\d{2}$/;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account)) {
      throw new HttpsError("invalid-argument", "invalid account");
    }
    if ((fromMonth && !monthRe.test(fromMonth)) || (toMonth && !monthRe.test(toMonth))) {
      throw new HttpsError("invalid-argument", "fromMonth/toMonth must be YYYY-MM");
    }
    const accKey = accountKey(account);
    const db = admin.firestore();
    const tokenDoc = await db.collection("gmailTokens").doc(accKey).get();
    if (!tokenDoc.exists) {
      throw new HttpsError("failed-precondition", `Gmail account ${account} לא מחובר. חברי אותו קודם.`);
    }
    const refreshToken = tokenDoc.data().refreshToken;
    if (!refreshToken) throw new HttpsError("failed-precondition", "missing refresh_token");

    const oauth2Client = await makeOAuthClient();
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { google } = require("googleapis");
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    let sinceDate = null, beforeDate = null;
    if (fromMonth && toMonth) {
      const [fy, fm] = fromMonth.split("-").map(n => parseInt(n, 10));
      const [ty, tm] = toMonth.split("-").map(n => parseInt(n, 10));
      sinceDate = new Date(fy, fm - 1, 1);            // 1st of fromMonth
      beforeDate = new Date(ty, tm, 1);               // 1st of month AFTER toMonth (exclusive)
    } else if (sinceDaysBack > 0) {
      sinceDate = new Date(Date.now() - sinceDaysBack * 86400000);
    }
    const q = buildGmailQuery(sinceDate, beforeDate);
    logger.info("syncgmailimports: starting", { account, sinceDaysBack, fromMonth, toMonth, q });

    // Page through the results (Gmail returns up to 500 per page)
    let pageToken = null;
    let scanned = 0, imported = 0, skipped = 0, errors = 0;
    const bucket = admin.storage().bucket();
    const startedAt = Date.now();
    const MAX_MS = 480_000;  // leave 60s buffer below CF 540s timeout

    do {
      if (Date.now() - startedAt > MAX_MS) {
        logger.warn("syncgmailimports: hitting time budget, stopping paging", { scanned, imported });
        break;
      }
      const listResp = await gmail.users.messages.list({
        userId: "me",
        q,
        pageToken: pageToken || undefined,
        maxResults: 100,
      });
      const msgs = (listResp.data && listResp.data.messages) || [];
      pageToken = listResp.data && listResp.data.nextPageToken;

      for (const m of msgs) {
        if (Date.now() - startedAt > MAX_MS) break;
        scanned++;
        try {
          // Cheap dedup: if any doc with this msgId already exists → skip full fetch
          const dupQ = await db.collection("emailImports")
            .where("msgId", "==", m.id)
            .where("accountKey", "==", accKey)
            .limit(1).get();
          if (!dupQ.empty) { skipped++; continue; }

          const full = await gmail.users.messages.get({
            userId: "me",
            id: m.id,
            format: "full",
          });
          const payload = full.data.payload;
          const headers = extractHeaders(payload);
          const { name: fromName, email: fromEmail } = parseFromHeader(headers.From);
          const emailDate = headers.Date ? new Date(headers.Date).toISOString() : new Date().toISOString();
          // Belt-and-suspenders: even if the Gmail query missed it, skip senders on the exclude list.
          const fromLower = String(fromEmail || "").toLowerCase();
          const excluded = fromLower && EXCLUDED_SENDER_DOMAINS.some(d => fromLower.includes(d));
          if (excluded) { skipped++; continue; }
          const atts = collectAttachments(payload)
            .filter(a => RECEIPT_MIME_ALLOWED.has((a.mimeType || "").toLowerCase()));
          if (!atts.length) { skipped++; continue; }

          let attIdx = 0;
          for (const att of atts) {
            attIdx++;
            const docId = `${m.id}_${attIdx}`;
            const attResp = await gmail.users.messages.attachments.get({
              userId: "me",
              messageId: m.id,
              id: att.attachmentId,
            });
            const data = decodeBase64Url(attResp.data.data);
            const safeName = att.filename.replace(/[^\w.\-א-ת ]+/g, "_").slice(0, 120);
            const storagePath = `email-imports/${accKey}/${m.id}/${safeName}`;
            const file = bucket.file(storagePath);
            const downloadToken = require("crypto").randomBytes(16).toString("hex");
            await file.save(data, {
              contentType: att.mimeType,
              metadata: {
                metadata: {
                  firebaseStorageDownloadTokens: downloadToken,
                  emailFrom: fromEmail, emailSubject: headers.Subject.slice(0, 200),
                  msgId: m.id, account,
                },
              },
              resumable: false,
            });
            const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;
            await db.collection("emailImports").doc(docId).set({
              id: docId,
              account,
              accountKey: accKey,
              emailFrom: fromEmail,
              emailFromName: fromName,
              emailSubject: headers.Subject || "",
              emailDate,
              attachmentFilename: att.filename,
              attachmentMimeType: att.mimeType,
              storagePath,
              storageUrl: downloadUrl,
              storageUrlExpiresAt: null,
              extractedAmount: null,
              extractedDate: null,
              ocrText: null,        // filled lazily by client OCR
              status: "pending",
              importedAt: new Date().toISOString(),
              msgId: m.id,
              attachmentIndex: attIdx,
            });
            imported++;
          }
        } catch (e) {
          errors++;
          logger.warn("syncgmailimports: msg failed", { msgId: m.id, error: e && e.message });
        }
      }
    } while (pageToken);

    logger.info("syncgmailimports: done", { account, scanned, imported, skipped, errors });
    return { success: true, account, scanned, imported, skipped, errors };
  }
);

// Refresh the storage signed URL for an imported email (client calls this
// when a URL has expired). Admin only.
exports.refreshemailimporturl = onCall(
  { region: "us-central1" },
  async (req) => {
    await requireAdmin(req.auth);
    const docId = String(req.data && req.data.docId || "");
    if (!docId) throw new HttpsError("invalid-argument", "docId required");
    const db = admin.firestore();
    const ref = db.collection("emailImports").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "doc not found");
    const path = snap.data().storagePath;
    if (!path) throw new HttpsError("failed-precondition", "no storagePath");
    const bucket = admin.storage().bucket();
    const file = bucket.file(path);
    const [meta] = await file.getMetadata();
    let token = meta.metadata && meta.metadata.firebaseStorageDownloadTokens;
    if (!token) {
      token = require("crypto").randomBytes(16).toString("hex");
      await file.setMetadata({ metadata: { ...(meta.metadata || {}), firebaseStorageDownloadTokens: token } });
    }
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    await ref.update({ storageUrl: url, storageUrlExpiresAt: null });
    return { url };
  }
);

// Delete all emailImports whose sender matches the excluded domains
// (Morning/GreenInvoice — these are OUTGOING invoice copies, not expenses).
// Also removes their Storage files. Admin only.
exports.cleanexcludedimports = onCall(
  { region: "us-central1", timeoutSeconds: 300 },
  async (req) => {
    await requireAdmin(req.auth);
    const db = admin.firestore();
    const bucket = admin.storage().bucket();
    const snap = await db.collection("emailImports").get();
    let deleted = 0, kept = 0, storageDeleted = 0, storageErrors = 0;
    const batch = db.batch();
    let batchCount = 0;
    for (const doc of snap.docs) {
      const d = doc.data();
      const from = String(d.emailFrom || "").toLowerCase();
      const match = from && EXCLUDED_SENDER_DOMAINS.some(x => from.includes(x));
      if (!match) { kept++; continue; }
      if (d.storagePath) {
        try { await bucket.file(d.storagePath).delete(); storageDeleted++; }
        catch (e) { storageErrors++; }
      }
      batch.delete(doc.ref);
      deleted++;
      batchCount++;
      if (batchCount >= 400) { await batch.commit(); batchCount = 0; }
    }
    if (batchCount > 0) await batch.commit();
    logger.info("cleanexcludedimports: done", { deleted, kept, storageDeleted, storageErrors });
    return { deleted, kept, storageDeleted, storageErrors };
  }
);

/* =========================================================================
 * SALARY MONTHLY FLOW — 6 Cloud Functions
 *
 * 1. remindfillfuture — 22 of month 12:00 → push all instructors to fill
 *    future attendance up to end of month.
 * 2. watchfutureeditsalert — Firestore trigger on records/*. When date is
 *    23..end-of-month and record is edited (not new), push admins with the
 *    exact old→new diff.
 * 3. sendmonthlyendreport — last day of month 12:00 → create per-instructor
 *    monthlyReports/{uid_month} doc + push "אשרי דוח סופי עד 20:00".
 * 4. enforcemonthlyapprovaldeadline — hourly → auto-approve monthlyReports
 *    still 'pending_approval' after 20:00 on the deadline date.
 * 5. remindpaymentreceipt — trigger on salaryPayments/*.paid false→true →
 *    schedule a task to push the instructor 24h later to upload receipt.
 * 6. runscheduledtasks — hourly → run due entries in scheduledTasks/*.
 * ========================================================================= */

// Helper: last day of a YYYY-MM month (returns day-of-month as number 28..31)
function _lastDayOfMonth(year, monthIdx0) {
  return new Date(year, monthIdx0 + 1, 0).getDate();
}

// Helper: format YYYY-MM-DD in Asia/Jerusalem
function _israelYMD(d) {
  const s = d.toLocaleString("en-US", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = s.split("/"); // MM/DD/YYYY
  return parts[2] + "-" + parts[0] + "-" + parts[1];
}

// Helper: create a notification doc (fires sendpushonnotification)
async function _createNotif(db, recipientUid, type, icon, title, body, link) {
  const id = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const now = new Date().toISOString();
  await db.collection("notifications").doc(id).set({
    id,
    recipientUid,
    type,
    icon: icon || "🔔",
    title,
    body,
    link: link || null,
    createdAt: now,
    createdBy: "system",
    createdByName: "מערכת בייביז",
    read: false,
    readAt: null,
  });
}

/**
 * 1. remindfillfuture
 * Runs on 22nd of every month at 12:00 Israel time.
 * Pushes all non-admin, non-offboarded instructors to fill future attendance.
 */
exports.remindfillfuture = onSchedule(
  {
    schedule: "0 12 22 * *",
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    timeoutSeconds: 300,
  },
  async () => {
    const db = admin.firestore();
    const startedAt = Date.now();
    logger.info("remindfillfuture: start");
    let sent = 0, failed = 0;

    // Compute current month label
    const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const monthNamesHe = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
    const monthLabel = monthNamesHe[nowIsrael.getMonth()];
    const monthKey = nowIsrael.getFullYear() + "-" + String(nowIsrael.getMonth() + 1).padStart(2, "0");

    try {
      const usersSnap = await db.collection("users").get();
      for (const doc of usersSnap.docs) {
        const u = doc.data() || {};
        if (u.role === "admin") continue;
        if (u.offboardedAt) continue;
        try {
          await _createNotif(
            db,
            doc.id,
            "fill_future_reminder",
            "📅",
            "זמן למלא נוכחות עתידית",
            `שלום ${u.name || ""}! נשארו לנו כמה ימים בחודש ${monthLabel}. אנא מלאי את הנוכחות עד סוף החודש. את יכולה לתקן דיווחים עד סוף החודש.`,
            { screen: "att" }
          );
          sent++;
        } catch (e) {
          failed++;
          logger.warn("remindfillfuture: notify failed", { uid: doc.id, error: e.message });
        }
      }
    } catch (e) {
      logger.error("remindfillfuture: fatal", { error: e.message });
      throw e;
    }

    logger.info("remindfillfuture", { sent, failed, month: monthKey, durationMs: Date.now() - startedAt });
  }
);

/**
 * 2. watchfutureeditsalert
 * Firestore trigger on records/{recordId}. When the record's date is between
 * the 23rd and end of the current month, and it's an update (not create), and
 * any of {date, duration, groups, garden} changed — push all admins with the
 * exact old→new diff.
 */
exports.watchfutureeditsalert = onDocumentWritten(
  { document: "records/{recordId}", region: "us-central1" },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;

    // Only care about updates: skip creates and deletes
    if (!before || !after) {
      logger.info("watchfutureeditsalert: skip (not an update)");
      return;
    }

    // Only monitored fields
    const changedFields = [];
    if (String(before.date || "") !== String(after.date || "")) changedFields.push("date");
    if (String(before.duration || "") !== String(after.duration || "")) changedFields.push("duration");
    if (String(before.groups || "") !== String(after.groups || "")) changedFields.push("groups");
    if (String(before.garden || "") !== String(after.garden || "")) changedFields.push("garden");
    if (!changedFields.length) {
      logger.info("watchfutureeditsalert: skip (no monitored field change)");
      return;
    }

    // Determine "today" in Israel, and last day of current month
    const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const dayOfMonth = nowIsrael.getDate();
    if (dayOfMonth < 23) {
      logger.info("watchfutureeditsalert: skip (outside 23..end-of-month window)", { dayOfMonth });
      return;
    }

    // The record's date should be within the future edit window: from today onwards
    // (or same current month) — we're monitoring edits to future reports
    const recDateStr = String(after.date || before.date || "");
    if (!recDateStr) {
      logger.info("watchfutureeditsalert: skip (no date)");
      return;
    }
    const todayStr = _israelYMD(nowIsrael);
    const currentMonthStr = todayStr.slice(0, 7);
    // Interested if the record is in current month AND the record was reported
    // before today (i.e., it was a future report) OR is still in the future.
    // Simplest useful signal: record's date is within current month.
    if (!recDateStr.startsWith(currentMonthStr)) {
      logger.info("watchfutureeditsalert: skip (record not in current month)", { recDate: recDateStr, month: currentMonthStr });
      return;
    }

    const db = admin.firestore();

    // Find instructor name from record.instructorUid
    let instructorName = "מדריכה";
    const instructorUid = after.instructorUid || before.instructorUid || null;
    try {
      if (instructorUid) {
        const uSnap = await db.collection("users").doc(String(instructorUid)).get();
        if (uSnap.exists) instructorName = uSnap.data().name || instructorName;
      }
    } catch (e) { /* noop */ }

    // Build human-readable diff
    const diffParts = [];
    if (changedFields.includes("date")) {
      diffParts.push(`תאריך ${before.date || "?"} → ${after.date || "?"}`);
    }
    if (changedFields.includes("garden")) {
      diffParts.push(`גן ${before.garden || "?"} → ${after.garden || "?"}`);
    }
    if (changedFields.includes("duration")) {
      diffParts.push(`${before.duration || "?"}דק → ${after.duration || "?"}דק`);
    }
    if (changedFields.includes("groups")) {
      diffParts.push(`קבוצות ${before.groups || "?"}→${after.groups || "?"}`);
    }
    const diffTxt = diffParts.join(" · ");
    const body = `${instructorName} שינתה דיווח: ${after.garden || before.garden || "?"} · ${after.date || before.date || "?"} · ${diffTxt}`;

    logger.info("watchfutureeditsalert: alerting admins", {
      instructorUid,
      instructorName,
      recordId: event.params.recordId,
      changedFields,
      diff: diffTxt,
    });

    // Fan out to admins
    let admins = [];
    try {
      const snap = await db.collection("users").where("role", "==", "admin").get();
      snap.forEach((d) => admins.push(d.id));
    } catch (e) {
      logger.error("watchfutureeditsalert: failed to load admins", { error: e.message });
      return;
    }
    let ok = 0, fail = 0;
    for (const adminUid of admins) {
      try {
        await _createNotif(
          db,
          adminUid,
          "future_edit_alert",
          "⚠",
          "⚠ שינוי בדיווח עתידי",
          body,
          { screen: "slr", filter: instructorUid }
        );
        ok++;
      } catch (e) {
        fail++;
        logger.warn("watchfutureeditsalert: notify failed", { adminUid, error: e.message });
      }
    }
    logger.info("watchfutureeditsalert: done", { ok, fail, adminCount: admins.length });
  }
);

/**
 * 3. sendmonthlyendreport
 * Runs daily at 12:00 on days 28..31. Only proceeds if today IS the last
 * day of the current month (since GCP Scheduler cron has no `L` symbol).
 * Creates monthlyReports/{uid_month} for every instructor who has records
 * this month, and pushes them "approve final report by 20:00".
 */
exports.sendmonthlyendreport = onSchedule(
  {
    schedule: "0 12 28-31 * *",
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    timeoutSeconds: 540,
  },
  async () => {
    const db = admin.firestore();
    const nowIsrael = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const dayOfMonth = nowIsrael.getDate();
    const lastDay = _lastDayOfMonth(nowIsrael.getFullYear(), nowIsrael.getMonth());
    if (dayOfMonth !== lastDay) {
      logger.info("sendmonthlyendreport: not last day, skipping", { dayOfMonth, lastDay });
      return;
    }
    const monthKey = nowIsrael.getFullYear() + "-" + String(nowIsrael.getMonth() + 1).padStart(2, "0");
    const monthNamesHe = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
    const monthLabel = monthNamesHe[nowIsrael.getMonth()] + " " + nowIsrael.getFullYear();
    // Deadline: today 20:00 Israel time (ISO)
    const deadlineIsrael = new Date(nowIsrael);
    deadlineIsrael.setHours(20, 0, 0, 0);
    // Convert deadline back to real UTC: nowIsrael was already an Israel-time-clock Date,
    // so we compute the actual UTC by treating it as an Israel wall-clock.
    // Simpler: today's date in Israel, at 20:00 local → build ISO with +03:00 offset.
    // Israel is UTC+2 (winter) or UTC+3 (summer). We use the string form to avoid offset math.
    const yStr = String(nowIsrael.getFullYear());
    const mStr = String(nowIsrael.getMonth() + 1).padStart(2, "0");
    const dStr = String(dayOfMonth).padStart(2, "0");
    const deadlineIsoLocal = `${yStr}-${mStr}-${dStr}T20:00:00+03:00`; // best-effort; DST edge cases OK for reminders
    const startedAt = Date.now();
    logger.info("sendmonthlyendreport: starting", { monthKey, deadline: deadlineIsoLocal });

    let created = 0, skipped = 0, failed = 0;

    try {
      // Load all instructors
      const usersSnap = await db.collection("users").get();
      const instructors = [];
      usersSnap.forEach((d) => {
        const u = d.data() || {};
        if (u.role === "admin") return;
        if (u.offboardedAt) return;
        instructors.push({ uid: d.id, name: u.name, id: u.id || null });
      });

      // Load all records in this month
      const recordsSnap = await db.collection("records").get();
      const monthRecordsByUid = {};
      recordsSnap.forEach((d) => {
        const r = d.data() || {};
        if (!r.date || !r.date.startsWith(monthKey)) return;
        const key = String(r.instructorUid || r.instructorId || "");
        if (!key) return;
        if (!monthRecordsByUid[key]) monthRecordsByUid[key] = [];
        monthRecordsByUid[key].push({ id: d.id, ...r });
      });

      for (const inst of instructors) {
        const records = monthRecordsByUid[String(inst.uid)] || monthRecordsByUid[String(inst.id)] || [];
        if (!records.length) { skipped++; continue; }

        const docId = `${inst.uid}_${monthKey}`;
        // Idempotent: skip if already exists (created earlier same day)
        try {
          const existing = await db.collection("monthlyReports").doc(docId).get();
          if (existing.exists && (existing.data().status === "approved" || existing.data().status === "rejected")) {
            skipped++; continue;
          }
        } catch (e) { /* noop */ }

        const totalMin = records.reduce((s, r) => s + (Number(r.duration) || 0), 0);
        const totalGroups = records.reduce((s, r) => s + (Number(r.groups) || 0), 0);

        const doc = {
          id: docId,
          instructorUid: inst.uid,
          instructorName: inst.name || "",
          month: monthKey,
          monthLabel,
          records: records.map(r => ({
            id: r.id,
            date: r.date,
            garden: r.garden || "",
            duration: r.duration || 0,
            groups: r.groups || 0,
            notes: r.notes || "",
          })),
          recordCount: records.length,
          totalMin,
          totalGroups,
          status: "pending_approval",
          deadline: deadlineIsoLocal,
          createdAt: new Date().toISOString(),
          createdBy: "system",
          approvedAt: null,
          approvedByUid: null,
          rejectionReason: null,
        };
        try {
          await db.collection("monthlyReports").doc(docId).set(doc, { merge: true });
          await _createNotif(
            db,
            inst.uid,
            "monthly_report_ready",
            "📋",
            "📋 אישור דוח סופי — עד 20:00 היום",
            `שלום ${inst.name || ""}! הדוח החודשי שלך ל־${monthLabel} מוכן לאישור. אנא היכנסי למסך "אישור דוח חודשי" ואשרי או דחי עד 20:00 היום.`,
            { screen: "monthly_approval" }
          );
          created++;
        } catch (e) {
          failed++;
          logger.warn("sendmonthlyendreport: create failed", { uid: inst.uid, error: e.message });
        }
      }
    } catch (e) {
      logger.error("sendmonthlyendreport: fatal", { error: e.message, stack: e.stack });
      throw e;
    }
    logger.info("sendmonthlyendreport: done", { created, skipped, failed, month: monthKey, durationMs: Date.now() - startedAt });
  }
);

/**
 * 4. enforcemonthlyapprovaldeadline
 * Runs hourly. Finds monthlyReports still 'pending_approval' whose deadline
 * has passed → sets status to 'auto_approved_past_deadline' (locks records).
 */
exports.enforcemonthlyapprovaldeadline = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    timeoutSeconds: 300,
  },
  async () => {
    const db = admin.firestore();
    const nowIso = new Date().toISOString();
    let scanned = 0, updated = 0, failed = 0;
    logger.info("enforcemonthlyapprovaldeadline: start");
    try {
      const snap = await db.collection("monthlyReports").where("status", "==", "pending_approval").get();
      for (const d of snap.docs) {
        scanned++;
        const data = d.data() || {};
        if (!data.deadline) continue;
        if (String(nowIso) < String(data.deadline)) continue;
        try {
          await d.ref.update({
            status: "auto_approved_past_deadline",
            approvedAt: nowIso,
            approvedByUid: "system_deadline",
          });
          // Notify instructor
          await _createNotif(
            db,
            data.instructorUid,
            "monthly_report_auto_approved",
            "⏰",
            "הדוח שלך אושר אוטומטית",
            `הדוח החודשי ל־${data.monthLabel || data.month} עבר את זמן האישור (20:00) ואושר אוטומטית. הדיווחים נעולים כעת.`,
            { screen: "monthly_approval" }
          );
          updated++;
        } catch (e) {
          failed++;
          logger.warn("enforcemonthlyapprovaldeadline: update failed", { docId: d.id, error: e.message });
        }
      }
    } catch (e) {
      logger.error("enforcemonthlyapprovaldeadline: fatal", { error: e.message });
      throw e;
    }
    logger.info("enforcemonthlyapprovaldeadline: done", { scanned, updated, failed });
  }
);

/**
 * 5. remindpaymentreceipt
 * Trigger: salaryPayments/{docId} is updated to paid=true.
 * Creates a scheduledTasks entry to remind the instructor 24h later to
 * upload a receipt. The actual push is sent by runscheduledtasks.
 */
exports.remindpaymentreceipt = onDocumentUpdated(
  { document: "salaryPayments/{docId}", region: "us-central1" },
  async (event) => {
    const before = event.data && event.data.before ? event.data.before.data() : null;
    const after = event.data && event.data.after ? event.data.after.data() : null;
    if (!before || !after) return;
    // Only when paid transitions false → true
    if (before.paid === true) return;
    if (after.paid !== true) return;
    const uid = after.userId || after.uid;
    const month = after.month;
    if (!uid || !month) {
      logger.warn("remindpaymentreceipt: missing uid/month", { after });
      return;
    }
    const paidAt = after.paidAt ? new Date(after.paidAt) : new Date();
    if (isNaN(paidAt.getTime())) {
      logger.warn("remindpaymentreceipt: invalid paidAt", { paidAt: after.paidAt });
      return;
    }
    const runAt = new Date(paidAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const db = admin.firestore();
    const taskDocId = `payment_receipt_${uid}_${month}`;
    try {
      await db.collection("scheduledTasks").doc(taskDocId).set({
        id: taskDocId,
        type: "payment_receipt_reminder",
        uid,
        month,
        runAt,
        salaryPaymentDocId: event.params.docId,
        createdAt: new Date().toISOString(),
        status: "pending",
      });
      logger.info("remindpaymentreceipt: scheduled", { taskDocId, runAt, uid, month });
    } catch (e) {
      logger.error("remindpaymentreceipt: schedule failed", { error: e.message });
    }
  }
);

/**
 * 6. runscheduledtasks
 * Runs hourly. Picks up scheduledTasks whose runAt has passed and status is
 * 'pending', executes them, marks them 'done' or 'failed'.
 */
exports.runscheduledtasks = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "Asia/Jerusalem",
    region: "us-central1",
    timeoutSeconds: 300,
  },
  async () => {
    const db = admin.firestore();
    const nowIso = new Date().toISOString();
    let scanned = 0, ran = 0, failed = 0;
    logger.info("runscheduledtasks: start");
    try {
      const snap = await db.collection("scheduledTasks")
        .where("status", "==", "pending")
        .get();
      for (const d of snap.docs) {
        scanned++;
        const t = d.data() || {};
        if (!t.runAt || String(nowIso) < String(t.runAt)) continue;
        try {
          if (t.type === "payment_receipt_reminder" && t.uid) {
            await _createNotif(
              db,
              t.uid,
              "upload_receipt_after_payment",
              "🧾",
              "הועבר לך תשלום — נא להעלות קבלה",
              "שלום! אתמול הועבר לך תשלום השכר. אנא העלי לחשבוניות באפליקציה קבלה עבור הסכום שהתקבל.",
              { screen: "rcp" }
            );
          }
          await d.ref.update({ status: "done", executedAt: nowIso });
          ran++;
        } catch (e) {
          failed++;
          logger.warn("runscheduledtasks: task failed", { docId: d.id, error: e.message });
          try { await d.ref.update({ status: "failed", error: e.message, executedAt: nowIso }); } catch (_) {}
        }
      }
    } catch (e) {
      logger.error("runscheduledtasks: fatal", { error: e.message });
      throw e;
    }
    logger.info("runscheduledtasks: done", { scanned, ran, failed });
  }
);

/**
 * Helper endpoint: instructor calls this to approve/reject their monthly
 * report. Also triggers push to admin on rejection.
 */
exports.submitmonthlyapproval = onCall(
  { region: "us-central1" },
  async (req) => {
    if (!req.auth || !req.auth.uid) {
      throw new HttpsError("unauthenticated", "Sign in required");
    }
    const { docId, action, rejectionReason } = req.data || {};
    if (!docId || !action) throw new HttpsError("invalid-argument", "missing docId or action");
    if (!["approve", "reject"].includes(action)) throw new HttpsError("invalid-argument", "invalid action");
    const db = admin.firestore();
    const ref = db.collection("monthlyReports").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "report not found");
    const data = snap.data();
    if (String(data.instructorUid) !== String(req.auth.uid)) {
      throw new HttpsError("permission-denied", "not your report");
    }
    if (data.status !== "pending_approval") {
      throw new HttpsError("failed-precondition", `already ${data.status}`);
    }
    const now = new Date().toISOString();
    if (action === "approve") {
      await ref.update({
        status: "approved",
        approvedAt: now,
        approvedByUid: req.auth.uid,
      });
      return { success: true, status: "approved" };
    }
    // reject
    await ref.update({
      status: "rejected",
      rejectionReason: rejectionReason || "(ללא הסבר)",
      rejectedAt: now,
      rejectedByUid: req.auth.uid,
    });
    // Notify all admins with the reason
    try {
      const adminsSnap = await db.collection("users").where("role", "==", "admin").get();
      for (const a of adminsSnap.docs) {
        await _createNotif(
          db,
          a.id,
          "monthly_report_rejected",
          "❌",
          `❌ ${data.instructorName || "מדריכה"} דחתה דוח ל־${data.monthLabel || data.month}`,
          `סיבה: ${rejectionReason || "(ללא הסבר)"}`,
          { screen: "slr", filter: data.instructorUid }
        );
      }
    } catch (e) {
      logger.warn("submitmonthlyapproval: admin notify failed", { error: e.message });
    }
    return { success: true, status: "rejected" };
  }
);

/* =========================================================================
 * FEATURE_MARKER:invoice-ocr-v1
 * parseinvoicewithclaude — Claude Vision OCR for receipts/invoices.
 *
 * Accepts ONE of:
 *   storagePath: string   (preferred; e.g. "receipts/uid/xxx.jpg" or "gs://bucket/path")
 *   imageUrl:    string   (fallback — public/signed URL, fetched server-side)
 *   dataUrl:     string   ("data:image/jpeg;base64,...")
 *
 * Returns:
 *   { parsed: {...schema}, modelUsed, latencyMs, tokensIn, tokensOut, source }
 *
 * Auth: admin OR the instructor who owns the receipt (checked via storagePath
 * prefix "receipts/{uid}/..." OR via ocrLogs docId match).
 *
 * Writes: ocrLogs/{autoId} for observability.
 *
 * Uses Claude Opus 4.7 (native PDF + image via document/image content blocks).
 * ========================================================================= */
const OCR_MAX_BYTES = 10 * 1024 * 1024; // 10MB cap (Claude allows 32MB; we keep costs down)
const OCR_MODEL = "claude-opus-4-7";
// Rough cost estimate (USD per 1M tokens) — Opus 4.7 pricing as of writing.
const OCR_COST_IN_PER_MTOK = 15.00;
const OCR_COST_OUT_PER_MTOK = 75.00;

function _extOfPath(p) {
  const m = String(p || "").toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
  return m ? m[1] : "";
}
function _mimeForExt(ext) {
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg"; // default (jpg, jpeg, unknown)
}
function _normalizeStoragePath(p) {
  if (!p) return null;
  let s = String(p).trim();
  if (s.startsWith("gs://")) {
    // strip gs://bucket/
    const rest = s.slice(5).split("/");
    rest.shift(); // bucket
    s = rest.join("/");
  }
  // strip leading slash
  if (s.startsWith("/")) s = s.slice(1);
  return s || null;
}
async function _fetchAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new HttpsError("failed-precondition", `download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > OCR_MAX_BYTES) throw new HttpsError("failed-precondition", `הקובץ גדול מדי (${(buf.length / 1024 / 1024).toFixed(1)}MB). מגבלה: 10MB.`);
  const ct = res.headers.get("content-type") || "";
  const ext = _extOfPath(url);
  const mime = ct.split(";")[0].trim() || _mimeForExt(ext);
  return { base64: buf.toString("base64"), mime, bytes: buf.length };
}

exports.parseinvoicewithclaude = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB", secrets: [anthropicApiKey] },
  async (req) => {
    if (!req.auth || !req.auth.uid) throw new HttpsError("unauthenticated", "יש להתחבר");
    if (!anthropicApiKey.value()) throw new HttpsError("failed-precondition", "ANTHROPIC_API_KEY לא הוגדר");

    const { storagePath, imageUrl, dataUrl, hintCategory, hintAmount } = req.data || {};
    if (!storagePath && !imageUrl && !dataUrl) {
      throw new HttpsError("invalid-argument", "חסר קלט: storagePath / imageUrl / dataUrl");
    }

    // --- Auth: admin, OR instructor who owns the receipts/{uid}/... path ---
    const uid = req.auth.uid;
    const db = admin.firestore();
    const userDoc = await db.collection("users").doc(uid).get();
    const isAdmin = userDoc.exists && userDoc.data().role === "admin";
    if (!isAdmin) {
      const path = _normalizeStoragePath(storagePath);
      const ownsPath = path && path.startsWith(`receipts/${uid}/`);
      if (!ownsPath) {
        throw new HttpsError("permission-denied", "אין הרשאה לסרוק את הקובץ הזה");
      }
    }

    const t0 = Date.now();
    let base64, mime, bytes, source;

    try {
      if (storagePath) {
        const path = _normalizeStoragePath(storagePath);
        source = "storage:" + path;
        const [buf] = await admin.storage().bucket().file(path).download();
        if (buf.length > OCR_MAX_BYTES) {
          throw new HttpsError("failed-precondition", `הקובץ גדול מדי (${(buf.length / 1024 / 1024).toFixed(1)}MB). מגבלה: 10MB.`);
        }
        bytes = buf.length;
        base64 = buf.toString("base64");
        mime = _mimeForExt(_extOfPath(path));
      } else if (dataUrl) {
        source = "dataUrl";
        const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
        if (!m) throw new HttpsError("invalid-argument", "dataUrl לא תקין");
        mime = m[1];
        base64 = m[2];
        bytes = Math.floor(base64.length * 3 / 4);
        if (bytes > OCR_MAX_BYTES) throw new HttpsError("failed-precondition", "קובץ גדול מדי (>10MB)");
      } else {
        source = "url";
        const r = await _fetchAsBase64(imageUrl);
        base64 = r.base64; mime = r.mime; bytes = r.bytes;
      }
    } catch (dlErr) {
      if (dlErr instanceof HttpsError) throw dlErr;
      logger.error("parseinvoicewithclaude: download failed", { error: dlErr.message, source });
      throw new HttpsError("internal", "הורדת הקובץ נכשלה: " + (dlErr.message || String(dlErr)).slice(0, 200));
    }

    const isPdf = mime === "application/pdf" || mime.startsWith("application/pdf");
    logger.info("parseinvoicewithclaude: input", { source, mime, bytes, isPdf, uid, isAdmin });

    const SYSTEM = `אתה מומחה עולמי בקריאת חשבוניות וקבלות בעברית (וגם באנגלית) עבור אפליקציית "בייביז קלאב" — חברה ישראלית של מדריכות חוגי חיות בגני ילדים.

מקבל תמונה או PDF של חשבונית / קבלה / חשבונית-מס-קבלה / חיוב אשראי / קבלת חניה / קבלת קופה, ומחזיר JSON מובנה בלבד — בלי הסברים, בלי markdown, בלי טקסט לפני או אחרי.

הפורמט המדויק (חובה על כל השדות; שדה שלא זוהה = null, אף פעם לא string ריק):
{
  "supplier": "שם הספק/החברה כפי שכתוב",
  "supplierTaxId": "ח.פ / ע.מ / מס' עוסק (רק ספרות, ללא רווחים) או null",
  "documentType": "receipt | invoice | invoice_receipt | credit | unknown",
  "documentNumber": "מספר חשבונית / קבלה או null",
  "date": "YYYY-MM-DD (תאריך המסמך; אם רק חודש/שנה — 01 ליום) או null",
  "amountBeforeVat": מספר או null,
  "vatAmount": מספר או null,
  "totalAmount": מספר או null,
  "currency": "ILS | USD | EUR | ...",
  "category": "נסורת | אוכל | חומרים | ציוד | חומרי ניקוי | חניה | אחר",
  "categoryConfidence": מספר בין 0 ל-1,
  "paymentMethod": "מזומן | אשראי | העברה בנקאית | ציק | ביט | פייבוקס | אפליקציה | null",
  "notes": "הערות רלוונטיות קצרות או null",
  "rawTextSample": "עד 200 תווים של טקסט גולמי שקראת מהמסמך — לצורך דיבוג"
}

כללי פירוש קריטיים:
- מטבע: אם רשום ₪ / ש"ח / NIS → "ILS". $ → "USD". € → "EUR".
- סכומים: החזר מספרים נקיים (12.50 לא "12.50 ₪"). נקודה עשרונית באנגלית.
- אם רשום רק "סה"כ" בלי פיצול — totalAmount = הסכום, amountBeforeVat + vatAmount = null.
- אם יש פיצול: totalAmount = הסכום הכולל לתשלום, amountBeforeVat + vatAmount משלימים.
- מע"מ ישראלי כרגע 18%. אם רק totalAmount ידוע ורוצה חישוב — אל תמציא; השאר null.
- תאריך: קבלות בישראל = DD/MM/YY או DD/MM/YYYY. שנה דו-ספרתית < 50 = 20XX, אחרת 19XX.
- תאריך חייב להיות תאריך המסמך (הנפקה), לא תאריך פירעון.
- קטגוריה: קבע לפי תוכן הקבלה:
    "חניה" — חניון, פנגו, סלאופארק, cellopark, אחוזה, ttl, iap, park&go, חניית עירייה
    "נסורת" — נסורת, שבבי עץ, מצע לבעלי חיים, שביסים
    "אוכל" — מזון לבעלי חיים (יבש, לח), פירות, ירקות, חציר, גזר לארנבים
    "חומרים" — צבעים, נייר, דבק, יצירה, ציוד יצירה לחוגים
    "ציוד" — כלובים, אביזרים, כלי אוכל לחיות, ציוד קבוע
    "חומרי ניקוי" — סבון, אקונומיקה, ניקוי, חיטוי
    "אחר" — כל דבר אחר (משרד, נסיעות, טלפון, וכו')
  categoryConfidence: 0.9+ אם ברור מהחשבונית, 0.6-0.8 אם ניחוש סביר, <0.6 אם לא בטוח.
- ספק לא ידוע → "supplier": "לא זוהה", supplierTaxId=null.
- rawTextSample: קטע קצר של הטקסט האמיתי מהמסמך (לא סיכום שלך).
${hintCategory ? `\nרמז מהמשתמשת: קטגוריה מבוקשת = "${hintCategory}" (אם ברור לך אחרת — עדיף להסתמך על המסמך).` : ""}${hintAmount ? `\nרמז מהמשתמשת: סכום מבוקש = ${hintAmount} ₪ (השתמש כאמצעי אימות; אם המסמך מציג סכום אחר — הצג את מה שכתוב בפועל).` : ""}

החזר אך ורק JSON תקין. בלי markdown, בלי \`\`\`, בלי הסברים.`;

    const client = new (require("@anthropic-ai/sdk"))({ apiKey: anthropicApiKey.value() });
    const contentBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mime, data: base64 } };

    let resp;
    try {
      resp = await client.messages.create({
        model: OCR_MODEL,
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: [
            contentBlock,
            { type: "text", text: "פרק את החשבונית/קבלה שבמסמך ל-JSON לפי הסכמה. החזר רק JSON תקין." },
          ],
        }],
      });
    } catch (apiErr) {
      const msg = String((apiErr && apiErr.message) || apiErr || "");
      const errType = apiErr && apiErr.error && apiErr.error.error && apiErr.error.error.type;
      logger.error("parseinvoicewithclaude: Anthropic error", { status: apiErr && apiErr.status, type: errType, msg: msg.slice(0, 300) });
      if (/credit balance is too low|insufficient_quota/i.test(msg)) {
        throw new HttpsError("resource-exhausted", "חשבון ה־Anthropic API אזל מקרדיטים.");
      }
      if (apiErr && apiErr.status === 429) throw new HttpsError("resource-exhausted", "Rate limit של Anthropic. נסי שוב בעוד דקה.");
      if (errType === "authentication_error" || (apiErr && apiErr.status === 401)) {
        throw new HttpsError("failed-precondition", "מפתח Anthropic API לא תקין.");
      }
      throw new HttpsError("internal", "Anthropic החזירה שגיאה: " + msg.slice(0, 200));
    }

    const text = resp.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    let parsed;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : text);
    } catch (e) {
      logger.error("parseinvoicewithclaude: JSON parse failed", { textPreview: text.slice(0, 500) });
      throw new HttpsError("internal", "Claude לא החזירה JSON תקין: " + text.slice(0, 200));
    }

    // Normalize / sanitize (defensive — Claude sometimes returns strings for numbers).
    const _num = (v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.-]/g, ""));
      return isFinite(n) ? n : null;
    };
    const out = {
      supplier: parsed.supplier || null,
      supplierTaxId: parsed.supplierTaxId || null,
      documentType: parsed.documentType || "unknown",
      documentNumber: parsed.documentNumber || null,
      date: parsed.date || null,
      amountBeforeVat: _num(parsed.amountBeforeVat),
      vatAmount: _num(parsed.vatAmount),
      totalAmount: _num(parsed.totalAmount),
      currency: parsed.currency || "ILS",
      category: parsed.category || "אחר",
      categoryConfidence: (typeof parsed.categoryConfidence === "number" && parsed.categoryConfidence >= 0 && parsed.categoryConfidence <= 1) ? parsed.categoryConfidence : 0.5,
      paymentMethod: parsed.paymentMethod || null,
      notes: parsed.notes || null,
      rawTextSample: (parsed.rawTextSample || "").slice(0, 300),
    };

    const latencyMs = Date.now() - t0;
    const tokensIn = (resp.usage && resp.usage.input_tokens) || 0;
    const tokensOut = (resp.usage && resp.usage.output_tokens) || 0;
    const costUsd = (tokensIn * OCR_COST_IN_PER_MTOK + tokensOut * OCR_COST_OUT_PER_MTOK) / 1e6;

    // Fire-and-forget log to ocrLogs (admin-only readable per firestore.rules).
    try {
      await db.collection("ocrLogs").add({
        uid,
        isAdmin,
        source,
        storagePath: storagePath ? _normalizeStoragePath(storagePath) : null,
        mime,
        bytes,
        isPdf,
        modelUsed: OCR_MODEL,
        latencyMs,
        tokensIn,
        tokensOut,
        costUsdEstimate: Number(costUsd.toFixed(6)),
        supplier: out.supplier,
        totalAmount: out.totalAmount,
        category: out.category,
        categoryConfidence: out.categoryConfidence,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (logErr) {
      logger.warn("parseinvoicewithclaude: ocrLog write failed", { error: logErr.message });
    }

    logger.info("parseinvoicewithclaude: done", {
      supplier: out.supplier, total: out.totalAmount, cat: out.category,
      latencyMs, tokensIn, tokensOut, costUsd: costUsd.toFixed(5),
    });

    return {
      parsed: out,
      modelUsed: OCR_MODEL,
      latencyMs,
      tokensIn,
      tokensOut,
      costUsdEstimate: Number(costUsd.toFixed(6)),
      source,
    };
  }
);
