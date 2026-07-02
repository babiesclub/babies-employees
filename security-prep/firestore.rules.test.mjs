/**
 * ============================================================================
 * Firestore Security Rules — Unit Test Suite (SAFETY GATE, PREP ONLY)
 * ============================================================================
 *
 * Target ruleset : ../firestore.rules.proposed  (the HARDENED version)
 * Tooling        : @firebase/rules-unit-testing v3 + Firestore emulator + mocha
 *
 * This suite NEVER touches production. It runs entirely against the local
 * Firestore emulator. Seed data that must ignore rules (e.g. the users/{uid}
 * role docs used by isAdmin()) is written via withSecurityRulesDisabled().
 *
 * Run:
 *   npm install
 *   npm run emu           # -> firebase emulators:exec --only firestore "npm test"
 * or, with an emulator already running on localhost:8080:
 *   npm test
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert';

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
} from 'firebase/firestore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = resolve(__dirname, '..', 'firestore.rules.proposed');

const PROJECT_ID = 'babiez-app-rules-test';
const ADMIN_UID = 'admin_uid';
const INSTR_UID = 'instructor_uid';
const OTHER_UID = 'other_instructor_uid';

let testEnv;

// Auth contexts (rules-enforced)
let unauth;   // no auth
let admin;    // signed-in, users/{admin}.role == 'admin'
let instr;    // signed-in, users/{instr}.role == 'instructor'
let other;    // signed-in, users/{other}.role == 'instructor' (a DIFFERENT user)

// Convenience: get the firestore handle for a context.
// IMPORTANT: call context.firestore() ONLY ONCE per context and cache it.
// Calling it again re-initializes settings on an already-started Firestore
// and throws "settings can no longer be changed". clearFirestore() between
// tests wipes DATA but keeps these client handles valid.
let hUnauth, hAdmin, hInstr, hOther;
const dbUnauth = () => hUnauth;
const dbAdmin = () => hAdmin;
const dbInstr = () => hInstr;
const dbOther = () => hOther;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
before(async function () {
  this.timeout(30000);

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, 'utf8'),
    },
  });

  unauth = testEnv.unauthenticatedContext();
  admin = testEnv.authenticatedContext(ADMIN_UID);
  instr = testEnv.authenticatedContext(INSTR_UID);
  other = testEnv.authenticatedContext(OTHER_UID);

  // Cache each context's Firestore handle ONCE (see note above).
  hUnauth = unauth.firestore();
  hAdmin = admin.firestore();
  hInstr = instr.firestore();
  hOther = other.firestore();
});

after(async function () {
  if (testEnv) await testEnv.cleanup();
});

/**
 * Reset the emulator between tests and re-seed the baseline data using a
 * rules-DISABLED context (so seeds cannot be blocked by the ruleset itself).
 *
 * Seeded baseline:
 *   users/{admin}  = { role: 'admin' }        -> makes isAdmin() true for admin
 *   users/{instr}  = { role: 'instructor', ... }
 *   users/{other}  = { role: 'instructor', ... }
 */
beforeEach(async function () {
  this.timeout(15000);
  await testEnv.clearFirestore();

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ADMIN_UID), { role: 'admin', name: 'Admin' });
    await setDoc(doc(db, 'users', INSTR_UID), {
      role: 'instructor',
      name: 'Instructor',
      gardens: ['g1'],
      gardenPayHistory: { g1: 100 },
      travelMonthly: 200,
      oneSignalSubscriptionId: 'old-sub',
    });
    await setDoc(doc(db, 'users', OTHER_UID), {
      role: 'instructor',
      name: 'Other Instructor',
      gardens: ['g2'],
      gardenPayHistory: { g2: 50 },
      travelMonthly: 0,
    });
  });
});

/** Seed an arbitrary doc bypassing rules. */
async function seed(path, id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path, id), data);
  });
}

// ===========================================================================
// 1. Owner-keyed collections (field: instructorUid)
//    records, contracts, personalDocs, receipts
// ===========================================================================
const OWNER_COLLECTIONS = ['records', 'contracts', 'personalDocs', 'receipts'];

for (const col of OWNER_COLLECTIONS) {
  describe(`owner-keyed collection: ${col} (field instructorUid)`, () => {
    const MINE = 'doc_mine';
    const THEIRS = 'doc_theirs';

    beforeEach(async () => {
      await seed(col, MINE, { instructorUid: INSTR_UID, payload: 'a' });
      await seed(col, THEIRS, { instructorUid: OTHER_UID, payload: 'b' });
    });

    // ---- instructor on OWN doc: full CRUD allowed ----
    it('instructor CAN read own doc', async () => {
      await assertSucceeds(getDoc(doc(dbInstr(), col, MINE)));
    });
    it('instructor CAN create own doc (instructorUid == uid)', async () => {
      await assertSucceeds(
        setDoc(doc(dbInstr(), col, 'new_mine'), { instructorUid: INSTR_UID, payload: 'x' })
      );
    });
    it('instructor CAN update own doc', async () => {
      await assertSucceeds(updateDoc(doc(dbInstr(), col, MINE), { payload: 'updated' }));
    });
    it('instructor CAN delete own doc', async () => {
      await assertSucceeds(deleteDoc(doc(dbInstr(), col, MINE)));
    });

    // ---- instructor on SOMEONE ELSE's doc: denied ----
    it("instructor CANNOT read another user's doc", async () => {
      await assertFails(getDoc(doc(dbInstr(), col, THEIRS)));
    });
    it("instructor CANNOT create a doc owned by someone else (instructorUid != uid)", async () => {
      await assertFails(
        setDoc(doc(dbInstr(), col, 'new_theirs'), { instructorUid: OTHER_UID, payload: 'x' })
      );
    });
    it("instructor CANNOT update another user's doc", async () => {
      await assertFails(updateDoc(doc(dbInstr(), col, THEIRS), { payload: 'hax' }));
    });
    it("instructor CANNOT delete another user's doc", async () => {
      await assertFails(deleteDoc(doc(dbInstr(), col, THEIRS)));
    });

    // ---- admin: full access to any doc ----
    it('admin CAN read any doc', async () => {
      await assertSucceeds(getDoc(doc(dbAdmin(), col, THEIRS)));
    });
    it('admin CAN create any doc', async () => {
      await assertSucceeds(
        setDoc(doc(dbAdmin(), col, 'admin_new'), { instructorUid: OTHER_UID, payload: 'x' })
      );
    });
    it('admin CAN update any doc', async () => {
      await assertSucceeds(updateDoc(doc(dbAdmin(), col, THEIRS), { payload: 'admin-edit' }));
    });
    it('admin CAN delete any doc', async () => {
      await assertSucceeds(deleteDoc(doc(dbAdmin(), col, THEIRS)));
    });

    // ---- unauthenticated: denied everything ----
    it('unauthenticated CANNOT read', async () => {
      await assertFails(getDoc(doc(dbUnauth(), col, MINE)));
    });
    it('unauthenticated CANNOT create', async () => {
      await assertFails(
        setDoc(doc(dbUnauth(), col, 'anon_new'), { instructorUid: INSTR_UID, payload: 'x' })
      );
    });
    it('unauthenticated CANNOT update', async () => {
      await assertFails(updateDoc(doc(dbUnauth(), col, MINE), { payload: 'x' }));
    });
    it('unauthenticated CANNOT delete', async () => {
      await assertFails(deleteDoc(doc(dbUnauth(), col, MINE)));
    });
  });
}

// ===========================================================================
// 2. chatMessages — owner pattern keyed on threadUid
// ===========================================================================
describe('chatMessages (owner field: threadUid)', () => {
  const MINE = 'chat_mine';
  const THEIRS = 'chat_theirs';

  beforeEach(async () => {
    await seed('chatMessages', MINE, { threadUid: INSTR_UID, text: 'hi' });
    await seed('chatMessages', THEIRS, { threadUid: OTHER_UID, text: 'yo' });
  });

  it('instructor CAN read own thread message', async () => {
    await assertSucceeds(getDoc(doc(dbInstr(), 'chatMessages', MINE)));
  });
  it('instructor CAN create message in own thread', async () => {
    await assertSucceeds(
      setDoc(doc(dbInstr(), 'chatMessages', 'c_new'), { threadUid: INSTR_UID, text: 'x' })
    );
  });
  it('instructor CAN update own thread message', async () => {
    await assertSucceeds(updateDoc(doc(dbInstr(), 'chatMessages', MINE), { text: 'edit' }));
  });
  it('instructor CAN delete own thread message', async () => {
    await assertSucceeds(deleteDoc(doc(dbInstr(), 'chatMessages', MINE)));
  });

  it("instructor CANNOT read another user's thread message", async () => {
    await assertFails(getDoc(doc(dbInstr(), 'chatMessages', THEIRS)));
  });
  it("instructor CANNOT create message in another user's thread", async () => {
    await assertFails(
      setDoc(doc(dbInstr(), 'chatMessages', 'c_theirs'), { threadUid: OTHER_UID, text: 'x' })
    );
  });
  it("instructor CANNOT update another user's thread message", async () => {
    await assertFails(updateDoc(doc(dbInstr(), 'chatMessages', THEIRS), { text: 'hax' }));
  });
  it("instructor CANNOT delete another user's thread message", async () => {
    await assertFails(deleteDoc(doc(dbInstr(), 'chatMessages', THEIRS)));
  });

  it('admin CAN read any thread message', async () => {
    await assertSucceeds(getDoc(doc(dbAdmin(), 'chatMessages', THEIRS)));
  });
  it('admin CAN write any thread message', async () => {
    await assertSucceeds(updateDoc(doc(dbAdmin(), 'chatMessages', THEIRS), { text: 'admin' }));
  });

  it('unauthenticated CANNOT read', async () => {
    await assertFails(getDoc(doc(dbUnauth(), 'chatMessages', MINE)));
  });
  it('unauthenticated CANNOT write', async () => {
    await assertFails(
      setDoc(doc(dbUnauth(), 'chatMessages', 'anon'), { threadUid: INSTR_UID, text: 'x' })
    );
  });
});

// ===========================================================================
// 3. users/{uid}
// ===========================================================================
describe('users/{uid}', () => {
  // ---- read ----
  it('signed-in instructor CAN read any user doc', async () => {
    await assertSucceeds(getDoc(doc(dbInstr(), 'users', OTHER_UID)));
  });
  it('signed-in admin CAN read any user doc', async () => {
    await assertSucceeds(getDoc(doc(dbAdmin(), 'users', INSTR_UID)));
  });
  it('unauthenticated CANNOT read a user doc', async () => {
    await assertFails(getDoc(doc(dbUnauth(), 'users', INSTR_UID)));
  });

  // ---- create ----
  it('admin CAN create a user doc', async () => {
    await assertSucceeds(
      setDoc(doc(dbAdmin(), 'users', 'brand_new'), { role: 'instructor', name: 'New' })
    );
  });
  it('instructor CANNOT create a user doc', async () => {
    await assertFails(
      setDoc(doc(dbInstr(), 'users', 'brand_new'), { role: 'instructor', name: 'New' })
    );
  });
  it('unauthenticated CANNOT create a user doc', async () => {
    await assertFails(
      setDoc(doc(dbUnauth(), 'users', 'brand_new'), { role: 'instructor', name: 'New' })
    );
  });

  // ---- delete ----
  it('admin CAN delete a user doc', async () => {
    await assertSucceeds(deleteDoc(doc(dbAdmin(), 'users', OTHER_UID)));
  });
  it('instructor CANNOT delete a user doc (even their own)', async () => {
    await assertFails(deleteDoc(doc(dbInstr(), 'users', INSTR_UID)));
  });
  it('unauthenticated CANNOT delete a user doc', async () => {
    await assertFails(deleteDoc(doc(dbUnauth(), 'users', INSTR_UID)));
  });

  // ---- update: admin can update anyone ----
  it('admin CAN update any user doc (including role)', async () => {
    await assertSucceeds(updateDoc(doc(dbAdmin(), 'users', INSTR_UID), { role: 'admin' }));
  });

  // ---- update: self-update rules (privilege-escalation guard) ----
  it('instructor CAN update OWN doc with a benign field (oneSignalSubscriptionId)', async () => {
    await assertSucceeds(
      updateDoc(doc(dbInstr(), 'users', INSTR_UID), { oneSignalSubscriptionId: 'new-sub-123' })
    );
  });

  it("instructor CANNOT escalate: update OWN doc changing role to 'admin'", async () => {
    await assertFails(updateDoc(doc(dbInstr(), 'users', INSTR_UID), { role: 'admin' }));
  });

  it("instructor CANNOT update ANOTHER user's doc", async () => {
    await assertFails(
      updateDoc(doc(dbInstr(), 'users', OTHER_UID), { oneSignalSubscriptionId: 'x' })
    );
  });

  // ---- extra guarded-field escalation checks (gardens / pay / travel) ----
  it('instructor CANNOT change own gardens', async () => {
    await assertFails(updateDoc(doc(dbInstr(), 'users', INSTR_UID), { gardens: ['g1', 'g99'] }));
  });
  it('instructor CANNOT change own gardenPayHistory', async () => {
    await assertFails(
      updateDoc(doc(dbInstr(), 'users', INSTR_UID), { gardenPayHistory: { g1: 999 } })
    );
  });
  it('instructor CANNOT change own travelMonthly', async () => {
    await assertFails(updateDoc(doc(dbInstr(), 'users', INSTR_UID), { travelMonthly: 9999 }));
  });
  it('unauthenticated CANNOT update a user doc', async () => {
    await assertFails(
      updateDoc(doc(dbUnauth(), 'users', INSTR_UID), { oneSignalSubscriptionId: 'x' })
    );
  });
});

// ===========================================================================
// 4. notifications
//    read/update/delete: recipient or admin. create: any signed-in.
// ===========================================================================
describe('notifications', () => {
  const FOR_INSTR = 'notif_for_instr';
  const FOR_OTHER = 'notif_for_other';

  beforeEach(async () => {
    await seed('notifications', FOR_INSTR, { recipientUid: INSTR_UID, msg: 'hi' });
    await seed('notifications', FOR_OTHER, { recipientUid: OTHER_UID, msg: 'yo' });
  });

  // create: any signed-in user
  it('instructor CAN create a notification (to anyone)', async () => {
    await assertSucceeds(
      setDoc(doc(dbInstr(), 'notifications', 'n_new'), { recipientUid: ADMIN_UID, msg: 'x' })
    );
  });
  it('admin CAN create a notification', async () => {
    await assertSucceeds(
      setDoc(doc(dbAdmin(), 'notifications', 'n_new2'), { recipientUid: INSTR_UID, msg: 'x' })
    );
  });
  it('unauthenticated CANNOT create a notification', async () => {
    await assertFails(
      setDoc(doc(dbUnauth(), 'notifications', 'n_anon'), { recipientUid: INSTR_UID, msg: 'x' })
    );
  });

  // read: recipient or admin
  it('recipient instructor CAN read their notification', async () => {
    await assertSucceeds(getDoc(doc(dbInstr(), 'notifications', FOR_INSTR)));
  });
  it("instructor CANNOT read a notification addressed to someone else", async () => {
    await assertFails(getDoc(doc(dbInstr(), 'notifications', FOR_OTHER)));
  });
  it('admin CAN read any notification', async () => {
    await assertSucceeds(getDoc(doc(dbAdmin(), 'notifications', FOR_OTHER)));
  });
  it('unauthenticated CANNOT read a notification', async () => {
    await assertFails(getDoc(doc(dbUnauth(), 'notifications', FOR_INSTR)));
  });

  // update: recipient or admin
  it('recipient instructor CAN update their notification', async () => {
    await assertSucceeds(updateDoc(doc(dbInstr(), 'notifications', FOR_INSTR), { read: true }));
  });
  it("instructor CANNOT update a notification addressed to someone else", async () => {
    await assertFails(updateDoc(doc(dbInstr(), 'notifications', FOR_OTHER), { read: true }));
  });
  it('admin CAN update any notification', async () => {
    await assertSucceeds(updateDoc(doc(dbAdmin(), 'notifications', FOR_OTHER), { read: true }));
  });

  // delete: recipient or admin
  it('recipient instructor CAN delete their notification', async () => {
    await assertSucceeds(deleteDoc(doc(dbInstr(), 'notifications', FOR_INSTR)));
  });
  it("instructor CANNOT delete a notification addressed to someone else", async () => {
    await assertFails(deleteDoc(doc(dbInstr(), 'notifications', FOR_OTHER)));
  });
  it('admin CAN delete any notification', async () => {
    await assertSucceeds(deleteDoc(doc(dbAdmin(), 'notifications', FOR_OTHER)));
  });
});

// ===========================================================================
// 5. Admin-only collections (read AND write only for admin)
// ===========================================================================
const ADMIN_ONLY = [
  'invoices',
  'whatsapp_conversations',
  'whatsapp_messages',
  'companyDocs',
  'tenders',
  'customNotifications',
  'camp_clients',
  'camp_sessions',
  'external_schedules',
  'whatsapp_usage',
  'aiAssistantLog',
  'settings',
  'sendLog',
  'sendLogIndex',
  'backupLog',
];

describe('admin-only collections (read+write admin only)', () => {
  for (const col of ADMIN_ONLY) {
    describe(col, () => {
      const ID = 'doc1';
      beforeEach(async () => {
        await seed(col, ID, { data: 'x' });
      });

      it('admin CAN read', async () => {
        await assertSucceeds(getDoc(doc(dbAdmin(), col, ID)));
      });
      it('admin CAN write', async () => {
        await assertSucceeds(setDoc(doc(dbAdmin(), col, 'doc2'), { data: 'y' }));
      });

      it('instructor CANNOT read', async () => {
        await assertFails(getDoc(doc(dbInstr(), col, ID)));
      });
      it('instructor CANNOT write', async () => {
        await assertFails(setDoc(doc(dbInstr(), col, 'doc2'), { data: 'y' }));
      });

      it('unauthenticated CANNOT read', async () => {
        await assertFails(getDoc(doc(dbUnauth(), col, ID)));
      });
      it('unauthenticated CANNOT write', async () => {
        await assertFails(setDoc(doc(dbUnauth(), col, 'doc2'), { data: 'y' }));
      });
    });
  }

  // Explicit subcollection check for whatsapp_conversations/{c}/{document=**}
  describe('whatsapp_conversations subcollection (document=**)', () => {
    beforeEach(async () => {
      await seed('whatsapp_conversations/conv1/messages', 'm1', { text: 'hi' });
    });
    it('admin CAN read a nested message', async () => {
      await assertSucceeds(getDoc(doc(dbAdmin(), 'whatsapp_conversations/conv1/messages', 'm1')));
    });
    it('instructor CANNOT read a nested message', async () => {
      await assertFails(getDoc(doc(dbInstr(), 'whatsapp_conversations/conv1/messages', 'm1')));
    });
    it('unauthenticated CANNOT read a nested message', async () => {
      await assertFails(getDoc(doc(dbUnauth(), 'whatsapp_conversations/conv1/messages', 'm1')));
    });
  });
});

// ===========================================================================
// 6. Shared-read / admin-write collections
//    any signed-in user READ; only admin WRITE; unauth denied
// ===========================================================================
const SHARED_READ = [
  'gardens',
  'materials',
  'weeklySchedule',
  'animals',
  'rotationGroups',
  'regionRoutes',
  'substituteAssignments',
  'meta',
  'tasks',
];

describe('shared-read / admin-write collections', () => {
  for (const col of SHARED_READ) {
    describe(col, () => {
      const ID = 'doc1';
      beforeEach(async () => {
        await seed(col, ID, { data: 'x' });
      });

      it('instructor CAN read', async () => {
        await assertSucceeds(getDoc(doc(dbInstr(), col, ID)));
      });
      it('admin CAN read', async () => {
        await assertSucceeds(getDoc(doc(dbAdmin(), col, ID)));
      });
      it('unauthenticated CANNOT read', async () => {
        await assertFails(getDoc(doc(dbUnauth(), col, ID)));
      });

      it('admin CAN write', async () => {
        await assertSucceeds(setDoc(doc(dbAdmin(), col, 'doc2'), { data: 'y' }));
      });
      it('instructor CANNOT write', async () => {
        await assertFails(setDoc(doc(dbInstr(), col, 'doc2'), { data: 'y' }));
      });
      it('unauthenticated CANNOT write', async () => {
        await assertFails(setDoc(doc(dbUnauth(), col, 'doc2'), { data: 'y' }));
      });
    });
  }
});

// ===========================================================================
// 7. Default deny — an unlisted collection must deny everyone
// ===========================================================================
describe('default deny (unlisted collection)', () => {
  const COL = 'someUnlistedCollection';
  const ID = 'x1';

  beforeEach(async () => {
    await seed(COL, ID, { data: 'x' });
  });

  it('admin CANNOT read an unlisted collection', async () => {
    await assertFails(getDoc(doc(dbAdmin(), COL, ID)));
  });
  it('admin CANNOT write an unlisted collection', async () => {
    await assertFails(setDoc(doc(dbAdmin(), COL, 'x2'), { data: 'y' }));
  });
  it('instructor CANNOT read an unlisted collection', async () => {
    await assertFails(getDoc(doc(dbInstr(), COL, ID)));
  });
  it('instructor CANNOT write an unlisted collection', async () => {
    await assertFails(setDoc(doc(dbInstr(), COL, 'x2'), { data: 'y' }));
  });
  it('unauthenticated CANNOT read an unlisted collection', async () => {
    await assertFails(getDoc(doc(dbUnauth(), COL, ID)));
  });
  it('unauthenticated CANNOT write an unlisted collection', async () => {
    await assertFails(setDoc(doc(dbUnauth(), COL, 'x2'), { data: 'y' }));
  });
});

// sanity: the rules file path resolves and is non-empty
describe('meta: ruleset file loaded', () => {
  it('firestore.rules.proposed is present and non-trivial', () => {
    const txt = readFileSync(RULES_PATH, 'utf8');
    assert.ok(txt.includes('service cloud.firestore'), 'ruleset header present');
    assert.ok(txt.length > 500, 'ruleset is non-trivial');
  });
});
