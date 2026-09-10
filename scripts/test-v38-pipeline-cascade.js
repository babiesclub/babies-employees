// v38 Pipeline Logistics Cascade — regression harness.
//
// Reproduces the pipeline-cascade logic inside `_pipelineCascadeSwap`
// (index.html) in isolation and asserts:
//
//   1. Basic cascade: 3-pair super-cluster (2+2+2), a batch of 2 mats travels
//      through Pair0→Pair1→Pair2 over 6 cell-weeks. Swap in the middle pair
//      should propagate to every cell holding oldMat inside the batch.
//   2. Cascade with Sukkot skip: verify the cascade tolerates a fullWeek gap
//      between the source pair's cells and the target pair's cells.
//   3. Cascade that would violate iron rule for another instructor: MUST return
//      null so caller falls back to v37 (non-cascade single-cell swap).
//   4. Cascade in a cycle where newMatId is already in the sub-group's pool:
//      MUST return null (pool would degenerate — dup within pool).
//   5. Cross-region collision: newMatId already assigned outside super-cluster
//      at one of the changed weeks → MUST return null.
//   6. Regression: non-super-cluster cell (unlinked group / free agent) →
//      MUST return null so v37 ripple takes over.
//
// Runs entirely offline (no Firestore, no browser). Node ≥ 12.

'use strict';

// -----------------------------------------------------------------------------
// Pure re-implementation of `_pipelineCascadeSwap`. Mirrors index.html.
// -----------------------------------------------------------------------------
function makeCascade({schedule, materials, rotGroups, holidays, yStart, yEnd, holidayOnlyWeeks}) {
  const matById = Object.fromEntries(materials.map(m => [m.id, m]));
  holidayOnlyWeeks = holidayOnlyWeeks || {};

  const seasonOK = (mat, wISO) => true;    // Tests don't exercise seasonality; season logic mirrored to a passthrough.
  const holidayCompat = (mat, wISO) => {
    // If the mat is a "holiday-only" one and week isn't in the whitelist → false.
    // For the tests, no mat is holiday-only unless flagged.
    if (mat.holidayOnly) return !!holidayOnlyWeeks[wISO];
    if (holidayOnlyWeeks[wISO]) return false;
    return true;
  };
  const isSkipWeek = wISO => !!(holidays[wISO] && holidays[wISO].fullWeek);

  return function pipelineCascadeSwap(uid, weekA, oldMatId, newMatId) {
    if (!uid || !weekA || !oldMatId || !newMatId || String(oldMatId) === String(newMatId)) return null;
    const oldMat = matById[oldMatId], newMat = matById[newMatId];
    if (!oldMat || !newMat) return null;
    const uidStr = String(uid);
    const mySubGroup = rotGroups.find(g => (g.instructorUids || []).map(String).includes(uidStr));
    if (!mySubGroup) return null;
    if (!(mySubGroup.linkedGroupIds || []).length) return null;
    const groupsInRegion = rotGroups.filter(g => g.regionName === mySubGroup.regionName);
    const groupById = Object.fromEntries(groupsInRegion.map(g => [g.id, g]));
    const clusterIds = new Set();
    const q = [mySubGroup.id];
    while (q.length) {
      const gid = q.shift();
      if (clusterIds.has(gid)) continue;
      clusterIds.add(gid);
      const grp = groupById[gid]; if (!grp) continue;
      (grp.linkedGroupIds || []).forEach(o => { if (!clusterIds.has(o) && groupById[o]) q.push(o); });
    }
    if (clusterIds.size < 2) return null;
    const clusterUids = new Set();
    clusterIds.forEach(gid => { const g = groupById[gid]; if (g) (g.instructorUids || []).forEach(u => clusterUids.add(String(u))); });
    if (!clusterUids.has(uidStr)) return null;
    const subGroupUids = (mySubGroup.instructorUids || []).map(String);
    if (subGroupUids.length !== 2) return null;
    const partnerUid = subGroupUids.find(u => u !== uidStr);
    if (!partnerUid) return null;
    const weekAAssigns = (schedule[weekA] || {}).assignments || {};
    if (String(weekAAssigns[uidStr]) !== String(oldMatId)) return null;
    const partnerMatId = weekAAssigns[partnerUid];
    if (!partnerMatId) return null;
    if (String(partnerMatId) === String(oldMatId)) return null;
    if (String(partnerMatId) === String(newMatId)) return null;
    const poolBefore = [String(oldMatId), String(partnerMatId)];
    const poolAfter  = [String(newMatId), String(partnerMatId)];
    const affected = [];
    Object.entries(schedule).forEach(([wISO, wk]) => {
      if (!wk || !wk.assignments) return;
      if (wISO < yStart || wISO > yEnd) return;
      Object.entries(wk.assignments).forEach(([u, mid]) => {
        if (!clusterUids.has(String(u))) return;
        const midS = String(mid);
        if (midS === String(oldMatId) || midS === String(partnerMatId)) {
          affected.push({ uid: String(u), week: wISO, currentMat: midS });
        }
      });
    });
    if (!affected.length) return null;
    const changes = affected
      .filter(c => c.currentMat === String(oldMatId))
      .map(c => ({ uid: c.uid, week: c.week, oldMat: String(oldMatId), newMat: String(newMatId) }));
    if (!changes.length) return null;
    const changeKey = new Set(changes.map(c => c.uid + '|' + c.week));
    const changedUids = new Set(changes.map(c => c.uid));
    for (const u of changedUids) {
      for (const wISO of Object.keys(schedule)) {
        if (wISO < yStart || wISO > yEnd) continue;
        if (changeKey.has(u + '|' + wISO)) continue;
        const mid = ((schedule[wISO] || {}).assignments || {})[u];
        if (!mid) continue;
        if (String(mid) === String(newMatId)) return null;
      }
    }
    for (const c of changes) {
      if (isSkipWeek(c.week)) return null;
      if (!seasonOK(newMat, c.week)) return null;
      if (!holidayCompat(newMat, c.week)) return null;
    }
    for (const c of changes) {
      const wk = schedule[c.week];
      if (!wk || !wk.assignments) continue;
      for (const [u, mid] of Object.entries(wk.assignments)) {
        if (clusterUids.has(String(u))) continue;
        if (String(mid) === String(newMatId)) return null;
      }
    }
    return { changes, poolBefore, poolAfter, superClusterSize: clusterUids.size, affectedCount: affected.length };
  };
}

// -----------------------------------------------------------------------------
// Fixture: a 3-pair super-cluster in Region 'south'.
//   Pair0 (entry):  Gita + Boaz         [ashkelon]  — linked to Pair1, Pair2
//   Pair1 (middle): Maayan + Noa        [yinon]     — linked to Pair0, Pair2
//   Pair2 (exit):   Rina + Tal          [beer-sheva]— linked to Pair0, Pair1
//
// Weeks (year 2026-09-06 → 2027-08-06):
//   w1=2026-09-06  w2=2026-09-13  w3=2026-09-20  w4=2026-09-27 (Sukkot)
//   w5=2026-10-04  w6=2026-10-11  w7=2026-10-18  w8=2026-10-25
//
// Batch b1={M1, M2} travels through the pipeline (Pair-swap Latin square):
//   Pair0 w1: Gita=M1, Boaz=M2
//   Pair0 w2: Gita=M2, Boaz=M1
//   → shift after 2 weeks
//   Pair1 w3: Maayan=M1, Noa=M2
//   Pair1 w5: Maayan=M2, Noa=M1     (w4 is Sukkot skip)
//   → shift
//   Pair2 w6: Rina=M1, Tal=M2
//   Pair2 w7: Rina=M2, Tal=M1
//   → retire
//
// Warm-start non-cascade cells: Pair1 also has b2 at w1-w2, Pair2 has b3 at
// w1-w4 (skipping Sukkot), etc. Those distractors let us verify the cascade
// only touches cells actually holding b1's mats.
// -----------------------------------------------------------------------------

const YEAR_START = '2026-09-06';
const YEAR_END   = '2027-08-06';
const HOLIDAYS   = { '2026-09-27': { name: 'Sukkot', fullWeek: true } };
const REGION     = 'south';

const MATS = [
  { id: 'M1', name: 'שרקן',   category: 'rodent',  animalName: 'שרקן'   },
  { id: 'M2', name: 'פילים',  category: 'mammal',  animalName: 'פילים'  },
  { id: 'M3', name: 'ים-יבשה',category: 'reptile', animalName: 'ים-יבשה'},
  { id: 'M4', name: 'תוכי',   category: 'bird',    animalName: 'תוכי'   },
  { id: 'M5', name: 'ארנב',   category: 'rodent',  animalName: 'ארנב'   },
  { id: 'M6', name: 'לטאה',   category: 'reptile', animalName: 'לטאה'   },
  { id: 'M7', name: 'עכבר',   category: 'rodent',  animalName: 'עכבר'   },
  { id: 'M8', name: 'צב',     category: 'reptile', animalName: 'צב'     },
];

// 3-pair super-cluster: gita+boaz linked to maayan+noa linked to rina+tal.
function makeSuperCluster() {
  return [
    { id: 'g_pair0', regionName: REGION, name: 'Pair0', instructorUids: ['gita','boaz'],  linkedGroupIds: ['g_pair1','g_pair2'] },
    { id: 'g_pair1', regionName: REGION, name: 'Pair1', instructorUids: ['maayan','noa'], linkedGroupIds: ['g_pair0','g_pair2'] },
    { id: 'g_pair2', regionName: REGION, name: 'Pair2', instructorUids: ['rina','tal'],   linkedGroupIds: ['g_pair0','g_pair1'] },
  ];
}

function makeScheduleBase() {
  // b1={M1,M2} travels Pair0→Pair1→Pair2.
  // b2={M3,M4} starts at Pair1, then shifts to Pair2, then retires.
  // b3={M5,M6} starts at Pair2, retires after 2 weeks. Then Pair2 waits for b1.
  return {
    '2026-09-06': { weekStart: '2026-09-06', assignments: {
      // Warm start: Pair0=b1, Pair1=b2, Pair2=b3.
      gita: 'M1', boaz: 'M2',
      maayan: 'M3', noa: 'M4',
      rina: 'M5', tal: 'M6',
    }},
    '2026-09-13': { weekStart: '2026-09-13', assignments: {
      gita: 'M2', boaz: 'M1',       // Pair0 b1 wk2 (swap)
      maayan: 'M4', noa: 'M3',      // Pair1 b2 wk2 (swap)
      rina: 'M6', tal: 'M5',        // Pair2 b3 wk2 (swap)
    }},
    '2026-09-20': { weekStart: '2026-09-20', assignments: {
      // First shift: Pair0=new b4, Pair1=b1 (from Pair0), Pair2=b2 (from Pair1). b3 retires.
      gita: 'M7', boaz: 'M8',       // Pair0 b4 wk1
      maayan: 'M1', noa: 'M2',      // Pair1 b1 wk1
      rina: 'M3', tal: 'M4',        // Pair2 b2 wk1
    }},
    '2026-09-27': { weekStart: '2026-09-27', assignments: {}, holiday: 'Sukkot', skipped: true },
    '2026-10-04': { weekStart: '2026-10-04', assignments: {
      gita: 'M8', boaz: 'M7',       // Pair0 b4 wk2
      maayan: 'M2', noa: 'M1',      // Pair1 b1 wk2 — MAAYAN holds M2 here (batch second week)
      rina: 'M4', tal: 'M3',        // Pair2 b2 wk2
    }},
  };
}

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; return false; }
  console.log('  ✓', msg); return true;
}

function mkCascade(schedule, opts) {
  return makeCascade({
    schedule,
    materials: (opts && opts.materials) || MATS,
    rotGroups: (opts && opts.rotGroups) || makeSuperCluster(),
    holidays: HOLIDAYS,
    yStart: YEAR_START, yEnd: YEAR_END,
    holidayOnlyWeeks: (opts && opts.holidayOnlyWeeks) || {},
  });
}

// -----------------------------------------------------------------------------
// Test 1: Basic cascade.
// Swap Maayan's Pair1 week 2 (wk 10-04, currently M2) to a fresh mat X (=M99).
// Adds M99 to fixture so it's known but unused elsewhere.
// Expected: batch b1's pool {M1, M2} → {M1, M99}. Every cell with M2 in b1 cells
//   (maayan w10-04, gita w9-13, boaz w9-06, noa w9-20) → M99.
// Cells with M1 (batch's OTHER member) stay untouched.
// Distractor cells: maayan/noa w9-06 hold b2 (M3/M4), gita/boaz w9-20 hold b4
// (M7/M8), rina/tal at all weeks hold b2/b3/b4 mats — none of them contain M1 or
// M2 so they remain untouched.
// -----------------------------------------------------------------------------
function test1_basicCascade() {
  console.log('\n[test 1] basic cascade — swap Maayan w10-04 (M2 → M99), 4 cells expected');
  const mats = [...MATS, { id: 'M99', name: 'ים-יבשה-NEW', category: 'reptile', animalName: 'ים-יבשה-NEW' }];
  const schedule = makeScheduleBase();
  const r = mkCascade(schedule, { materials: mats })('maayan', '2026-10-04', 'M2', 'M99');
  assert(!!r, 'returns a cascade result');
  if (!r) return;
  assert(r.changes.length === 4, `4 cells changed (got ${r.changes.length})`);
  const key = new Set(r.changes.map(c => c.uid + '|' + c.week));
  assert(key.has('gita|2026-09-13'),  'gita 2026-09-13 (b1 wk2 Pair0) — M2 → M99');
  assert(key.has('boaz|2026-09-06'),  'boaz 2026-09-06 (b1 wk1 Pair0) — M2 → M99');
  assert(key.has('noa|2026-09-20'),   'noa 2026-09-20 (b1 wk1 Pair1) — M2 → M99');
  assert(key.has('maayan|2026-10-04'),'maayan 2026-10-04 (b1 wk2 Pair1) — M2 → M99 (admin pick)');
  // Cells with M1 (partner mat) stay:
  const untouched = ['gita|2026-09-06','boaz|2026-09-13','maayan|2026-09-20','noa|2026-10-04'];
  untouched.forEach(k => assert(!key.has(k), `M1-holding cell untouched: ${k}`));
  // Distractor cells unchanged (they hold b2/b3/b4 mats, not in pool):
  ['maayan|2026-09-06','rina|2026-09-06','gita|2026-09-20'].forEach(k => assert(!key.has(k), `distractor unchanged: ${k}`));
  assert(r.poolAfter[0] === 'M99' && r.poolAfter[1] === 'M1', 'poolAfter = {M99, M1}');
  assert(r.superClusterSize === 6, 'super-cluster has 6 uids');
}

// -----------------------------------------------------------------------------
// Test 2: Cascade with Sukkot skip in the middle.
// b1's cells span across the Sukkot skip week (2026-09-27). The cascade must
// still find and update all 4 cells correctly — Sukkot cells hold no
// assignments and thus don't appear in `affected`, but the algorithm's iron-rule
// scan for `newMatId` must skip the empty Sukkot week without confusion.
// Also verify that if we ADD a stray M99 assignment during Sukkot to some uid
// outside the super-cluster it doesn't count (fullWeek should be empty anyway).
// -----------------------------------------------------------------------------
function test2_sukkotSkip() {
  console.log('\n[test 2] cascade tolerates Sukkot skip inside batch');
  const mats = [...MATS, { id: 'M99', name: 'ים-יבשה-NEW' }];
  const schedule = makeScheduleBase();
  // Sukkot week 09-27 has empty assignments — verify it stays empty.
  const r = mkCascade(schedule, { materials: mats })('maayan', '2026-10-04', 'M2', 'M99');
  assert(!!r, 'cascade succeeds despite Sukkot gap');
  if (!r) return;
  const weeks = new Set(r.changes.map(c => c.week));
  assert(!weeks.has('2026-09-27'), 'Sukkot week is NOT in the change list');
  assert(r.changes.length === 4, `4 cells changed (got ${r.changes.length})`);
}

// -----------------------------------------------------------------------------
// Test 3: Iron rule violation for a super-cluster uid → cascade must return null.
// If Gita already has M99 assigned somewhere else in the year, the cascade
// would give Gita M99 a SECOND time (violates iron rule) → fall back.
// -----------------------------------------------------------------------------
function test3_ironRuleFallback() {
  console.log('\n[test 3] iron rule for another super-cluster uid → null (fall back to v37)');
  const mats = [...MATS, { id: 'M99', name: 'ים-יבשה-NEW' }];
  const schedule = makeScheduleBase();
  // Plant M99 at Gita in a later week — cascade would repeat it for Gita.
  schedule['2026-11-15'] = { weekStart: '2026-11-15', assignments: { gita: 'M99' } };
  const r = mkCascade(schedule, { materials: mats })('maayan', '2026-10-04', 'M2', 'M99');
  assert(r === null, 'returns null — iron rule blocks cascade');
}

// -----------------------------------------------------------------------------
// Test 4: newMatId already in the pool (partner mat) → cascade must return null.
// The partner (Noa at w10-04) currently holds M1. Admin picks M1 for Maayan.
// Pool would become {M1, M1} (degenerate) — bail.
// -----------------------------------------------------------------------------
function test4_newMatInPoolFallback() {
  console.log('\n[test 4] newMatId equals partner mat → null (pool would degenerate)');
  const schedule = makeScheduleBase();
  const r = mkCascade(schedule)('maayan', '2026-10-04', 'M2', 'M1');
  assert(r === null, 'returns null — degenerate pool');
}

// -----------------------------------------------------------------------------
// Test 5: Cross-region collision → cascade must return null.
// If M99 is already assigned to someone OUTSIDE the super-cluster at any of
// the changed weeks, cascade introduces a cross-region duplicate. Bail.
// -----------------------------------------------------------------------------
function test5_crossRegionCollisionFallback() {
  console.log('\n[test 5] cross-region collision at a changed week → null');
  const mats = [...MATS, { id: 'M99', name: 'ים-יבשה-NEW' }];
  const schedule = makeScheduleBase();
  // Plant M99 at a stranger uid (not in super-cluster) at Gita's 2026-09-13 week.
  schedule['2026-09-13'].assignments['STRANGER'] = 'M99';
  const r = mkCascade(schedule, { materials: mats })('maayan', '2026-10-04', 'M2', 'M99');
  assert(r === null, 'returns null — cross-region duplicate would surface');
}

// -----------------------------------------------------------------------------
// Test 6: Non-super-cluster cell → cascade must return null so v37 handles it.
// Free-agent uid ('freeAlice') not in any rotation group — cascade should
// return null immediately.
// -----------------------------------------------------------------------------
function test6_regressionFreeAgent() {
  console.log('\n[test 6] regression — free agent cell → null (v37 handles it)');
  const mats = [...MATS, { id: 'M99', name: 'ים-יבשה-NEW' }];
  const schedule = { '2026-09-06': { weekStart: '2026-09-06', assignments: { freeAlice: 'M2' } } };
  const r = mkCascade(schedule, { materials: mats })('freeAlice', '2026-09-06', 'M2', 'M99');
  assert(r === null, 'returns null — free agent not in super-cluster');
}

// -----------------------------------------------------------------------------
// Test 6b: Single unlinked group (linkedGroupIds empty) → cascade returns null.
// -----------------------------------------------------------------------------
function test6b_regressionSingleGroup() {
  console.log('\n[test 6b] regression — single-group (unlinked) → null');
  const mats = [...MATS, { id: 'M99', name: 'ים-יבשה-NEW' }];
  const rotGroups = [
    { id: 'g_solo', regionName: REGION, name: 'Solo', instructorUids: ['alice','bob'], linkedGroupIds: [] },
  ];
  const schedule = { '2026-09-06': { weekStart: '2026-09-06', assignments: { alice: 'M2', bob: 'M1' } } };
  const r = mkCascade(schedule, { materials: mats, rotGroups })('alice', '2026-09-06', 'M2', 'M99');
  assert(r === null, 'returns null — single group has no linkedGroupIds');
}

// -----------------------------------------------------------------------------
// Test 7: Sukkot cell in the change list would be rejected. Construct a case
// where the pool includes a mat assigned on Sukkot (shouldn't happen in real
// data but defensively verify: cascade returns null if any change lands on a
// fullWeek). Sukkot week normally has empty assignments — simulate a stale
// entry to prove the guard fires.
// -----------------------------------------------------------------------------
function test7_sukkotAssignmentBailsCascade() {
  console.log('\n[test 7] defensive — stray Sukkot assignment inside pool → null');
  const mats = [...MATS, { id: 'M99', name: 'ים-יבשה-NEW' }];
  const schedule = makeScheduleBase();
  // Force a stray M2 assignment on Sukkot for gita — cascade would try to change it.
  schedule['2026-09-27'] = { weekStart: '2026-09-27', assignments: { gita: 'M2' }, holiday: 'Sukkot', skipped: true };
  const r = mkCascade(schedule, { materials: mats })('maayan', '2026-10-04', 'M2', 'M99');
  assert(r === null, 'returns null — a change would land on a fullWeek Sukkot cell');
}

// -----------------------------------------------------------------------------
// Test 8: Iron rule for uid whose cell is NOT being changed but IS in the
// super-cluster. Rina holds M99 at some future date; cascade should NOT bail
// because Rina isn't in the change set — she still holds M1 at Pair2 (unchanged).
// This verifies the iron-rule scan only checks CHANGED uids.
// -----------------------------------------------------------------------------
function test8_ironRuleOnlyCheckChangedUids() {
  console.log('\n[test 8] iron rule only checked for uids actually changing → success');
  const mats = [...MATS, { id: 'M99', name: 'ים-יבשה-NEW' }];
  const schedule = makeScheduleBase();
  // Rina holds M99 later, but Rina is not in the change set for this batch (batch
  // b1 hits her at w10-11 / w10-18 which aren't in fixture — she's holding b2 at
  // those weeks with M3/M4). Since Rina's cells stay untouched, this M99 doesn't
  // create a Rina duplicate for the CHANGES.
  schedule['2026-11-15'] = { weekStart: '2026-11-15', assignments: { rina: 'M99' } };
  const r = mkCascade(schedule, { materials: mats })('maayan', '2026-10-04', 'M2', 'M99');
  assert(!!r, 'succeeds — Rina isn\'t in the change set so her existing M99 is irrelevant');
}

// -----------------------------------------------------------------------------
console.log('=== v38 Pipeline Cascade regression tests ===');
test1_basicCascade();
test2_sukkotSkip();
test3_ironRuleFallback();
test4_newMatInPoolFallback();
test5_crossRegionCollisionFallback();
test6_regressionFreeAgent();
test6b_regressionSingleGroup();
test7_sukkotAssignmentBailsCascade();
test8_ironRuleOnlyCheckChangedUids();
if (process.exitCode) console.log('\n✗ Some assertions failed.');
else console.log('\n✓ All v38 pipeline-cascade assertions passed.');
