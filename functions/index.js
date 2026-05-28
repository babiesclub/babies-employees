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
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

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
