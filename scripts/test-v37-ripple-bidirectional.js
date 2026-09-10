// v37 bi-directional ripple-swap regression harness.
//
// Reproduces the ripple-swap logic inside `_rippleSwap` (index.html ~L7343)
// in isolation and asserts:
//
//   Legacy v35 tests (regression — must still pass with bi-directional impl):
//     1. Same-instructor preference — future.
//     2. Cross-instructor fallback — future.
//     3. No candidate → null.
//     4. Rotation-group cell off-limits.
//     5. Sukkot fullWeek skipped.
//     6. Iron-rule breaker rejects candidate.
//     7. Category-cooldown breaker rejects candidate.
//
//   v37 additions (bi-directional):
//     8. Past swap — same instructor.
//     9. Past swap — cross instructor.
//    10. Preference for smaller |Δweeks| — future vs past for same uid.
//    11. Preference for smaller |Δweeks| — cross-instructor picks closer past
//        candidate over further future candidate.
//    12. Same-instructor still wins over cross-instructor when uid has a farther
//        candidate and someone else has a closer one.
//    13. Early-week edge: weekA at year start — only future exists (no past)
//        and future candidate is still found.
//
// Runs entirely offline (no Firestore, no browser). Node ≥12.

'use strict';

// -----------------------------------------------------------------------------
// Minimal re-implementation of `_rippleSwap` — pure JS, no DOM/DB deps.
// Mirrors index.html verbatim for the bi-directional logic.
// -----------------------------------------------------------------------------
function makeRipple({schedule, materials, users, region, rotGroups, holidays, yStart, yEnd}) {
  const matById = Object.fromEntries(materials.map(m => [m.id, m]));
  const regionUidSet = new Set(users.filter(u => u.region === region).map(u => String(u.uid)));
  const groupUids = new Set();
  (rotGroups || []).filter(g => g.regionName === region)
    .forEach(g => (g.instructorUids || []).forEach(u => groupUids.add(String(u))));
  const catGroup = c => (c === 'bird' || c === 'chick') ? 'feathered' : (c || 'other');
  const isSkipWeek = w => !!(holidays[w] && holidays[w].fullWeek);

  return function rippleSwap(uid, weekA, oldMatId, newMatId) {
    if (!uid || !weekA || !oldMatId || !newMatId || String(oldMatId) === String(newMatId)) return null;
    const oldMat = matById[oldMatId], newMat = matById[newMatId];
    if (!oldMat || !newMat) return null;
    if (isSkipWeek(weekA)) return null;

    const tA = Date.parse(weekA);
    const weekISOs = Object.keys(schedule)
      .filter(w => w !== weekA && w >= yStart && w <= yEnd)
      .sort((a, b) => {
        const dA = Math.abs(Date.parse(a) - tA);
        const dB = Math.abs(Date.parse(b) - tA);
        if (dA !== dB) return dA - dB;
        return a < b ? -1 : (a > b ? 1 : 0);
      });

    const wouldViolateIron = (targetUid, matId, freed) => {
      for (const w of Object.keys(schedule)) {
        if (w < yStart || w > yEnd) continue;
        const cur = ((schedule[w] || {}).assignments || {})[targetUid];
        if (!cur) continue;
        if (freed.some(e => String(e.uid) === String(targetUid) && e.week === w)) continue;
        if (String(cur) === String(matId)) return true;
      }
      return false;
    };

    const cooldownOK = (targetUid, overrides) => {
      const wkKeys = Object.keys(schedule).filter(w => w >= yStart && w <= yEnd).sort();
      let run = 1, prev = null;
      for (const w of wkKeys) {
        const has = Object.prototype.hasOwnProperty.call(overrides, w);
        const mid = has ? overrides[w] : ((schedule[w] || {}).assignments || {})[targetUid];
        if (!mid) { prev = null; run = 1; continue; }
        const m = matById[mid]; if (!m) { prev = null; run = 1; continue; }
        const cg = catGroup(m.category || 'other');
        if (cg && cg === prev) { run++; if (run >= 3) return false; }
        else run = 1;
        prev = cg;
      }
      return true;
    };

    for (const pass of ['self', 'other']) {
      for (const wISO of weekISOs) {
        if (isSkipWeek(wISO)) continue;
        const wk = schedule[wISO]; if (!wk || !wk.assignments) continue;
        const holders = Object.entries(wk.assignments).filter(([u, mid]) => {
          if (String(mid) !== String(newMatId)) return false;
          if (!regionUidSet.has(String(u))) return false;
          if (pass === 'self') return String(u) === String(uid);
          return String(u) !== String(uid);
        });
        for (const [uid2] of holders) {
          if (groupUids.has(String(uid2))) continue;
          const freed = [{ uid, week: weekA }, { uid: uid2, week: wISO }];
          if (wouldViolateIron(uid, newMatId, freed)) continue;
          if (wouldViolateIron(uid2, oldMatId, freed)) continue;
          const ov1 = { [weekA]: newMatId };
          if (String(uid2) === String(uid)) ov1[wISO] = oldMatId;
          if (!cooldownOK(uid, ov1)) continue;
          if (String(uid2) !== String(uid)) {
            const ov2 = { [wISO]: oldMatId };
            if (!cooldownOK(uid2, ov2)) continue;
          }
          return { uid2: String(uid2), weekB: wISO };
        }
      }
    }
    return null;
  };
}

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------
const MATERIALS = [
  { id: 'M1', name: 'עכבר', category: 'rodent', animalName: 'עכבר' },
  { id: 'M2', name: 'צבע מהטבע', category: 'generic', animalName: '' },
  { id: 'M3', name: 'ארנב', category: 'rodent', animalName: 'ארנב' },
  { id: 'M4', name: 'תוכי', category: 'bird', animalName: 'תוכי' },
  { id: 'M5', name: 'אפרוח', category: 'chick', animalName: 'אפרוח' },
  { id: 'M6', name: 'לטאה', category: 'reptile', animalName: 'לטאה' },
];

const REGION = 'מרכז';
const USERS = [
  { uid: 'alice', name: 'אליס', region: REGION },
  { uid: 'bob',   name: 'בוב',   region: REGION },
  { uid: 'carol', name: 'קרול', region: REGION },
  { uid: 'eve',   name: 'איב',   region: REGION },
  { uid: 'dave',  name: 'דוד',   region: 'דרום' }, // different region — never picked
];

const YEAR_START = '2026-09-06';
const YEAR_END   = '2027-08-06';
const HOLIDAYS   = {
  '2026-09-27': { name: 'סוכות', fullWeek: true },
};

// Build a schedule with weeks w1..w10 (w4 = 2026-09-27 = Sukkot skip)
const WEEKS = [
  '2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27',
  '2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25',
  '2026-11-01', '2026-11-08',
];

function makeSchedule(assigns) {
  const sched = {};
  for (const w of WEEKS) sched[w] = { weekStart: w, assignments: {} };
  Object.entries(assigns).forEach(([w, cells]) => { sched[w] = { weekStart: w, assignments: { ...cells } }; });
  return sched;
}

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; return false; }
  console.log('  ✓', msg); return true;
}

function mkRipple(schedule, opts) {
  return makeRipple({
    schedule, materials: (opts && opts.materials) || MATERIALS,
    users: USERS, region: REGION,
    rotGroups: (opts && opts.rotGroups) || [],
    holidays: HOLIDAYS, yStart: YEAR_START, yEnd: YEAR_END,
  });
}

// -----------------------------------------------------------------------------
// v35 regression tests
// -----------------------------------------------------------------------------
function test1_selfSwap_future() {
  console.log('\n[test 1] v35: same-instructor preference (future)');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1', bob: 'M1', carol: 'M3' },
    '2026-10-04': { alice: 'M2', bob: 'M3', carol: 'M4' },
  });
  const r = mkRipple(schedule)('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'alice', 'candidate uid2 === alice (self-swap preferred)');
  assert(r && r.weekB === '2026-10-04', 'candidate weekB === 2026-10-04');
}

function test2_crossSwap_future() {
  console.log('\n[test 2] v35: cross-instructor fallback (future)');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1', carol: 'M1', bob: 'M3' },
    '2026-10-04': { alice: 'M4', bob: 'M2', carol: 'M5' },
  });
  const r = mkRipple(schedule)('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'bob', 'candidate uid2 === bob');
  assert(r && r.weekB === '2026-10-04', 'candidate weekB === 2026-10-04');
}

function test3_noCandidate() {
  console.log('\n[test 3] v35: no candidate anywhere → null');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1', bob: 'M1' },
    '2026-10-04': { alice: 'M3', bob: 'M4' },
  });
  const r = mkRipple(schedule)('alice', '2026-09-06', 'M1', 'M2');
  assert(r === null, 'returns null');
}

function test4_rotationGroupSkip() {
  console.log('\n[test 4] v35: rotation-group cell off-limits');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1', dave: 'M1' },
    '2026-10-04': { bob: 'M2' },
    '2026-10-11': { carol: 'M2' },
  });
  const rotGroups = [{ regionName: REGION, instructorUids: ['bob'] }];
  const r = mkRipple(schedule, { rotGroups })('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'carol', 'candidate skips rotation-group bob, picks carol');
  assert(r && r.weekB === '2026-10-11', 'candidate weekB === 2026-10-11');
}

function test5_sukkotSkip() {
  console.log('\n[test 5] v35: Sukkot fullWeek ignored as target');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1' },
    '2026-09-27': { bob: 'M2' },
    '2026-10-11': { bob: 'M2' },
  });
  const r = mkRipple(schedule)('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.weekB === '2026-10-11', 'candidate weekB === 2026-10-11 (post-Sukkot)');
}

function test6_ironRule() {
  console.log('\n[test 6] v35: iron-rule breaker rejects candidate');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1' },
    '2026-10-04': { bob: 'M2' },
    '2026-10-11': { carol: 'M2', bob: 'M3' },
    '2026-10-18': { bob: 'M1' },
  });
  const r = mkRipple(schedule)('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'carol', 'candidate is carol (bob rejected by iron rule)');
  assert(r && r.weekB === '2026-10-11', 'candidate weekB === 2026-10-11');
}

function test7_cooldownBreaker() {
  console.log('\n[test 7] v35: category-cooldown breaker rejects candidate');
  const mats = [...MATERIALS, { id: 'M7', name: 'עורב', category: 'bird', animalName: 'עורב' }];
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M7' },
    '2026-10-04': { bob: 'M4' },
    '2026-10-11': { bob: 'M2' },
    '2026-10-18': { bob: 'M5' },
    '2026-11-01': { carol: 'M2', bob: 'M3' },
  });
  const r = mkRipple(schedule, { materials: mats })('alice', '2026-09-06', 'M7', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'carol', 'candidate is carol (bob rejected by cat-cooldown feathered×3)');
  assert(r && r.weekB === '2026-11-01', 'candidate weekB === 2026-11-01');
}

// -----------------------------------------------------------------------------
// v37 bi-directional additions
// -----------------------------------------------------------------------------

// Test 8: past swap, same instructor.
// Original ים-יבשה regression: alice has M2 in a PAST week; picking M2 for alice's
// current (dup) cell should swap with her own past cell — old material moves back in time.
function test8_pastSelfSwap() {
  console.log('\n[test 8] v37: past swap — same instructor');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M2', bob: 'M3', carol: 'M4' }, // alice's earlier M2
    '2026-10-11': { alice: 'M1', bob: 'M1', carol: 'M6' }, // weekA — duplicated M1
  });
  const r = mkRipple(schedule)('alice', '2026-10-11', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'alice', 'candidate uid2 === alice (past self-swap)');
  assert(r && r.weekB === '2026-09-06', 'candidate weekB === 2026-09-06 (past)');
}

// Test 9: past swap, cross instructor.
// alice has no other M2 anywhere. bob has M2 in a past week. Swap trades cells with bob.
function test9_pastCrossSwap() {
  console.log('\n[test 9] v37: past swap — cross instructor');
  const schedule = makeSchedule({
    '2026-09-06': { bob: 'M2', carol: 'M4' },              // bob's earlier M2
    '2026-10-11': { alice: 'M1', bob: 'M3', carol: 'M1' }, // weekA — dup M1
  });
  const r = mkRipple(schedule)('alice', '2026-10-11', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'bob', 'candidate uid2 === bob (past cross swap)');
  assert(r && r.weekB === '2026-09-06', 'candidate weekB === 2026-09-06');
}

// Test 10: preference for smaller |Δweeks| — cross-instructor, closer FUTURE beats
// farther PAST. (Same-uid can only hold M2 once per year (iron rule), so smaller-|Δ|
// preference is only meaningful across different M2-holders — one per candidate week.)
function test10_smallerDeltaPref_futureCloser() {
  console.log('\n[test 10] v37: prefer smaller |Δ| — cross, closer future beats farther past');
  const schedule = makeSchedule({
    '2026-09-06': { carol: 'M2' },                     // |Δ| = 4 (past, carol)
    '2026-10-04': { alice: 'M1', bob: 'M1' },          // weekA
    '2026-10-11': { eve: 'M2' },                       // |Δ| = 1 (future, eve)
  });
  const r = mkRipple(schedule)('alice', '2026-10-04', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'eve', 'closer eve (future, |Δ|=1) picked over farther carol (past, |Δ|=4)');
  assert(r && r.weekB === '2026-10-11', 'candidate weekB === 2026-10-11');
}

// Test 10b: mirror — cross-instructor, closer PAST beats farther PAST.
function test10b_smallerDeltaPref_pastCloserAmongPasts() {
  console.log('\n[test 10b] v37: prefer smaller |Δ| — cross, closer past beats farther past');
  const schedule = makeSchedule({
    '2026-09-06': { carol: 'M2' },                     // |Δ| = 4 (past, carol)
    '2026-09-20': { eve: 'M2' },                       // |Δ| = 2 (past, eve)
    '2026-10-04': { alice: 'M1', bob: 'M1' },          // weekA
  });
  const r = mkRipple(schedule)('alice', '2026-10-04', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'eve', 'closer eve (past, |Δ|=2) picked over farther carol (past, |Δ|=4)');
  assert(r && r.weekB === '2026-09-20', 'candidate weekB === 2026-09-20');
}

// Test 11: cross-instructor smaller |Δ| — closer past bob beats further future carol.
// alice has no M2 anywhere else. bob has M2 in past. carol has M2 further in future.
function test11_crossSmallerDelta() {
  console.log('\n[test 11] v37: cross-instructor — closer past beats further future');
  const schedule = makeSchedule({
    '2026-09-20': { bob: 'M2' },                       // |Δ| = 1 (past, bob)
    '2026-10-04': { alice: 'M1', carol: 'M1' },        // weekA
    '2026-11-01': { carol: 'M2' },                     // |Δ| = 4 (future, carol)
  });
  const r = mkRipple(schedule)('alice', '2026-10-04', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'bob', 'closer bob (past, |Δ|=1) picked over further carol (|Δ|=4)');
  assert(r && r.weekB === '2026-09-20', 'candidate weekB === 2026-09-20');
}

// Test 12: same-instructor still wins over cross-instructor even when farther.
// alice has M2 far in the future. bob has M2 close in past. Self-preference wins.
function test12_selfBeatsCrossEvenIfFarther() {
  console.log('\n[test 12] v37: self-preference beats closer cross-instructor');
  const schedule = makeSchedule({
    '2026-09-20': { bob: 'M2' },                       // |Δ| = 1 (past, bob — cross)
    '2026-10-04': { alice: 'M1', bob: 'M1' },          // weekA
    '2026-11-01': { alice: 'M2' },                     // |Δ| = 4 (future, alice — self)
  });
  const r = mkRipple(schedule)('alice', '2026-10-04', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'alice', 'same-instructor beats closer cross-instructor');
  assert(r && r.weekB === '2026-11-01', 'candidate weekB === 2026-11-01 (self, further)');
}

// Test 13: edge — weekA is the very first week of the year; no past exists.
// Future candidate should still be found.
function test13_edgeEarlyWeek() {
  console.log('\n[test 13] v37: edge — very first week (no past to search)');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1', bob: 'M1' },          // weekA = year start
    '2026-10-04': { alice: 'M2' },
  });
  const r = mkRipple(schedule)('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'alice' && r.weekB === '2026-10-04', 'future candidate found even with no past');
}

// -----------------------------------------------------------------------------
// Run all
// -----------------------------------------------------------------------------
console.log('=== v37 bi-directional ripple-swap regression tests ===');
test1_selfSwap_future();
test2_crossSwap_future();
test3_noCandidate();
test4_rotationGroupSkip();
test5_sukkotSkip();
test6_ironRule();
test7_cooldownBreaker();
test8_pastSelfSwap();
test9_pastCrossSwap();
test10_smallerDeltaPref_futureCloser();
test10b_smallerDeltaPref_pastCloserAmongPasts();
test11_crossSmallerDelta();
test12_selfBeatsCrossEvenIfFarther();
test13_edgeEarlyWeek();
if (process.exitCode) console.log('\n✗ Some assertions failed.');
else console.log('\n✓ All bi-directional ripple-swap assertions passed.');
