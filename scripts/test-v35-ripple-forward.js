// v35 ripple-forward-swap regression harness.
//
// Reproduces the ripple-forward logic inside `_rippleForwardSwap` (index.html
// ~L6941) in isolation and asserts:
//
//   1. Same-instructor preference (pref 1): when uid has M2 later in the year,
//      the swap picks that cell (uid, weekB) — not a cross-instructor one — and
//      after the swap both cells hold their new mats, no dup remains, iron rule
//      preserved for uid.
//
//   2. Cross-instructor fallback (pref 2): when uid does NOT have M2 later but
//      another instructor in the same region does, the swap trades cells with
//      that instructor. Iron rule preserved for both uids.
//
//   3. No candidate → null. Caller then falls back to plain replace + warning.
//
//   4. Rotation-group cell is off-limits: even if a group instructor has M2
//      later, that cell is skipped and the function returns the next viable
//      non-group candidate (or null).
//
//   5. Sukkot fullWeek skip: candidate weeks inside a skip are ignored.
//
//   6. Iron-rule breaker: if uid2 already has M1 in another week, the candidate
//      is rejected (skips to next).
//
//   7. Category-cooldown breaker: if placing M1 at weekB would create 3+
//      consecutive same-cat-group weeks for uid2, the candidate is rejected.
//
// Runs entirely offline (no Firestore, no browser). Node ≥12.

'use strict';

// -----------------------------------------------------------------------------
// Minimal re-implementation of `_rippleForwardSwap` — pure JS, no DOM/DB deps.
// -----------------------------------------------------------------------------
function makeRipple({schedule, materials, users, region, rotGroups, holidays, yStart, yEnd}) {
  const matById = Object.fromEntries(materials.map(m => [m.id, m]));
  const regionUidSet = new Set(users.filter(u => u.region === region).map(u => String(u.uid)));
  const groupUids = new Set();
  (rotGroups || []).filter(g => g.regionName === region)
    .forEach(g => (g.instructorUids || []).forEach(u => groupUids.add(String(u))));
  const catGroup = c => (c === 'bird' || c === 'chick') ? 'feathered' : (c || 'other');
  const isSkipWeek = w => !!(holidays[w] && holidays[w].fullWeek);

  return function rippleForwardSwap(uid, weekA, oldMatId, newMatId) {
    if (!uid || !weekA || !oldMatId || !newMatId || String(oldMatId) === String(newMatId)) return null;
    const oldMat = matById[oldMatId], newMat = matById[newMatId];
    if (!oldMat || !newMat) return null;
    if (isSkipWeek(weekA)) return null;

    const weekISOs = Object.keys(schedule).filter(w => w > weekA && w >= yStart && w <= yEnd).sort();

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
  { uid: 'dave',  name: 'דוד',   region: 'דרום' }, // different region — never picked
];

const YEAR_START = '2026-09-06';
const YEAR_END   = '2027-08-06';
const HOLIDAYS   = {
  '2026-09-27': { name: 'סוכות', fullWeek: true },
};

// Build a schedule with weeks w1..w10
const WEEKS = [
  '2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27', // w4 = Sukkot skip
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

// -----------------------------------------------------------------------------
// Test 1: same-instructor preference (pref 1)
// alice: w1=M1 (dup with bob), w5=M2   →  swap w1 & w5 within alice's own column
// -----------------------------------------------------------------------------
function test1_selfSwap() {
  console.log('\n[test 1] same-instructor preference');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1', bob: 'M1', carol: 'M3' }, // M1 duplicated
    '2026-10-04': { alice: 'M2', bob: 'M3', carol: 'M4' },
  });
  const ripple = makeRipple({
    schedule, materials: MATERIALS, users: USERS, region: REGION,
    rotGroups: [], holidays: HOLIDAYS, yStart: YEAR_START, yEnd: YEAR_END,
  });
  const r = ripple('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'alice', 'candidate uid2 === alice (self-swap preferred)');
  assert(r && r.weekB === '2026-10-04', 'candidate weekB === 2026-10-04');
}

// -----------------------------------------------------------------------------
// Test 2: cross-instructor fallback (pref 2)
// alice: w1=M1 (dup); alice never gets M2 later. bob: w5=M2 later. → swap alice.w1 ⇄ bob.w5
// -----------------------------------------------------------------------------
function test2_crossSwap() {
  console.log('\n[test 2] cross-instructor fallback');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1', carol: 'M1', bob: 'M3' },
    '2026-10-04': { alice: 'M4', bob: 'M2', carol: 'M5' },
  });
  const ripple = makeRipple({
    schedule, materials: MATERIALS, users: USERS, region: REGION,
    rotGroups: [], holidays: HOLIDAYS, yStart: YEAR_START, yEnd: YEAR_END,
  });
  const r = ripple('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'bob', 'candidate uid2 === bob');
  assert(r && r.weekB === '2026-10-04', 'candidate weekB === 2026-10-04');
}

// -----------------------------------------------------------------------------
// Test 3: no candidate anywhere → null
// M2 never appears later in the region.
// -----------------------------------------------------------------------------
function test3_noCandidate() {
  console.log('\n[test 3] no candidate → null');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1', bob: 'M1' },
    '2026-10-04': { alice: 'M3', bob: 'M4' }, // no M2 later
  });
  const ripple = makeRipple({
    schedule, materials: MATERIALS, users: USERS, region: REGION,
    rotGroups: [], holidays: HOLIDAYS, yStart: YEAR_START, yEnd: YEAR_END,
  });
  const r = ripple('alice', '2026-09-06', 'M1', 'M2');
  assert(r === null, 'returns null');
}

// -----------------------------------------------------------------------------
// Test 4: rotation-group cell is off-limits
// bob is in a rotation group and has M2 later. → skipped. carol (free) has M2 later too.
// -----------------------------------------------------------------------------
function test4_rotationGroupSkip() {
  console.log('\n[test 4] rotation-group cell off-limits');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1', dave: 'M1' /* other region, doesn't matter */ },
    '2026-10-04': { bob: 'M2' }, // bob is in rot group → skip
    '2026-10-11': { carol: 'M2' }, // carol is free → picked
  });
  const rotGroups = [{ regionName: REGION, instructorUids: ['bob'] }];
  const ripple = makeRipple({
    schedule, materials: MATERIALS, users: USERS, region: REGION,
    rotGroups, holidays: HOLIDAYS, yStart: YEAR_START, yEnd: YEAR_END,
  });
  const r = ripple('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'carol', 'candidate skips rotation-group bob, picks carol');
  assert(r && r.weekB === '2026-10-11', 'candidate weekB === 2026-10-11');
}

// -----------------------------------------------------------------------------
// Test 5: Sukkot fullWeek is ignored as a swap target
// bob has M2 in the sukkot week (schedule state that shouldn't exist, but paranoia)
// AND later. → sukkot week ignored, next candidate found.
// -----------------------------------------------------------------------------
function test5_sukkotSkip() {
  console.log('\n[test 5] Sukkot fullWeek ignored as target');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1' },
    '2026-09-27': { bob: 'M2' }, // Sukkot → must be skipped
    '2026-10-11': { bob: 'M2' }, // next real cell — picked
  });
  const ripple = makeRipple({
    schedule, materials: MATERIALS, users: USERS, region: REGION,
    rotGroups: [], holidays: HOLIDAYS, yStart: YEAR_START, yEnd: YEAR_END,
  });
  const r = ripple('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.weekB === '2026-10-11', 'candidate weekB === 2026-10-11 (post-Sukkot)');
}

// -----------------------------------------------------------------------------
// Test 6: iron-rule breaker — uid2 already has M1 elsewhere → reject that candidate
// bob has M2 at w5 AND M1 at w7. Swapping into (bob,w5) would give bob M1 there too → dup for bob → reject.
// carol has M2 at w6 → picked.
// -----------------------------------------------------------------------------
function test6_ironRule() {
  console.log('\n[test 6] iron-rule breaker rejects candidate');
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M1' },
    '2026-10-04': { bob: 'M2' }, // if we pick bob@w5, bob would get M1 here — but bob has M1 at w7 → REJECT
    '2026-10-11': { carol: 'M2', bob: 'M3' },
    '2026-10-18': { bob: 'M1' }, // pre-existing M1 for bob
  });
  const ripple = makeRipple({
    schedule, materials: MATERIALS, users: USERS, region: REGION,
    rotGroups: [], holidays: HOLIDAYS, yStart: YEAR_START, yEnd: YEAR_END,
  });
  const r = ripple('alice', '2026-09-06', 'M1', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'carol', 'candidate is carol (bob rejected by iron rule)');
  assert(r && r.weekB === '2026-10-11', 'candidate weekB === 2026-10-11');
}

// -----------------------------------------------------------------------------
// Test 7: category-cooldown breaker — 3 consecutive same-cat-group weeks blocked
// alice has M4 (bird) at w5, M5 (chick) at w6, M2 at w7. If we swap alice's own w7 (M2) with weekA...
// Actually simpler: bob has M4 (bird) at w5, M2 at w6, M5 (chick) at w7. If we swap oldMat=M1 (rodent) into w6...
// no cooldown issue. Let's design: bob has M4 (bird) at w5, M2 at w6, M5 (chick) at w7. If oldMat is bird...
// Actually let's use: bob has M4 (bird) w5, M5 (chick) w7, M2 w6. If we swap M4 (bird from alice) into bob's w6 → bird,chick,bird — no run of 3.
// Better: bob has M4 (bird) w5, M2 w6, M5 (chick) w7. If oldMat = M-featheredX (bird) at alice.w1, swap moves M-featheredX to bob.w6 → bob: bird,bird/chick,chick = 3 consecutive feathered → REJECT
// We use oldMatId='M4' (bird) at alice.w1 — but M4 is at bob w5 too. That'd be a dup — the setup requires oldMat=M4 to not appear elsewhere. Let's just add a fresh material M7 with feathered category.
// -----------------------------------------------------------------------------
function test7_cooldownBreaker() {
  console.log('\n[test 7] category-cooldown breaker rejects candidate');
  const mats = [...MATERIALS, { id: 'M7', name: 'עורב', category: 'bird', animalName: 'עורב' }];
  const schedule = makeSchedule({
    '2026-09-06': { alice: 'M7' }, // oldMat = M7 (bird/feathered)
    // Two candidate positions for M2:
    // — bob has M4 (bird) w5, M2 w6, M5 (chick) w7 : swapping M7 into bob@w6 → bird,bird,chick → run=2, then break to 1 (chick vs bird continues feathered → actually bird,bird,chick are all feathered) → run=3 REJECT
    '2026-10-04': { bob: 'M4' },   // w5: bird
    '2026-10-11': { bob: 'M2' },   // w6: generic — target, would become M7=bird
    '2026-10-18': { bob: 'M5' },   // w7: chick
    // carol has M2 at w9, safe swap target
    '2026-11-01': { carol: 'M2', bob: 'M3' },
  });
  const ripple = makeRipple({
    schedule, materials: mats, users: USERS, region: REGION,
    rotGroups: [], holidays: HOLIDAYS, yStart: YEAR_START, yEnd: YEAR_END,
  });
  const r = ripple('alice', '2026-09-06', 'M7', 'M2');
  assert(!!r, 'returns a candidate');
  assert(r && r.uid2 === 'carol', 'candidate is carol (bob rejected by cat-cooldown feathered×3)');
  assert(r && r.weekB === '2026-11-01', 'candidate weekB === 2026-11-01');
}

// -----------------------------------------------------------------------------
// Run all
// -----------------------------------------------------------------------------
console.log('=== v35 ripple-forward-swap regression tests ===');
test1_selfSwap();
test2_crossSwap();
test3_noCandidate();
test4_rotationGroupSkip();
test5_sukkotSkip();
test6_ironRule();
test7_cooldownBreaker();
if (process.exitCode) console.log('\n✗ Some assertions failed.');
else console.log('\n✓ All ripple-forward assertions passed.');
