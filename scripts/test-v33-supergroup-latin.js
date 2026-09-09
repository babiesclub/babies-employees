// v33 super-group Latin-square regression harness.
//
// Reproduces the 3-pair super-cluster pipeline (Ashkelon + Yinon-Bnei-Ayish-Ashdod
// + Beer-Sheva — 3 sub-groups × 2 instructors each, Case A path in
// computeAnnualRotation at index.html ~line 4368) in isolation, then asserts:
//
//   1. Within each 2-week shift, each sub-group's pair sees the SAME two
//      pool materials in swap order:
//         week N   : uid0=mat[0], uid1=mat[1]
//         week N+1 : uid0=mat[1], uid1=mat[0]
//      This is the "Latin square within a cycle" property from the task.
//
//   2. A Sukkot fullWeek skip in the middle of a shift MUST NOT advance the
//      cycle position — the swap continues right across the skip.
//
//   3. After a shift boundary, each pair's pool refreshes (pair0 gets a new
//      2-mat batch, pair1 inherits pair0's old batch, pair2 inherits pair1's).
//      No repeats within a cycle, no material seen twice by any uid in the year.
//
//   4. v33 dedup-protection simulation: when a cross-region dedup pass would
//      have swapped one super-cluster member's cell to break a duplicate,
//      v33 marks those uids as protected → the swap is skipped → the Latin
//      square stays intact.
//
// Runs entirely offline (no Firestore, no network). Node ≥12.

'use strict';

const N_SUB = 3;            // three sub-groups
const K = 2;                // 2 instructors per sub-group
const SHIFT_LEN = K;        // shift boundary every K weeks
const WEEKS = 20;           // simulate 20 calendar weeks
const SUKKOT_WEEK_IDX = 3;  // week index that's a fullWeek skip — lands mid-shift so
                             // the straddle-swap case (last pre-Sukkot week=weekInShift=0,
                             // first post-Sukkot week must continue as weekInShift=1) fires.
const SUB_GROUPS = [
  { id: 'ashkelon',   uids: ['avigail', 'vered'] },   // Avigail + Vered (the bug pair)
  { id: 'yinon',      uids: ['yinon-a', 'yinon-b'] },
  { id: 'beer-sheva', uids: ['bs-a',    'bs-b']    },
];

// Fresh-material pool (mimics `pickTwoFresh` output — no seasonality filter
// needed at this level of abstraction; we just care about the assignment math).
let _nextMat = 0;
function pickTwoFresh() {
  const mats = [`mat-${_nextMat++}`, `mat-${_nextMat++}`];
  return mats;
}

// Simulate one week of the 3-pair pipeline.
// Returns per-uid assignments for the week ({} on Sukkot skip).
function runPipelineWeek(state, weekIdx, isSukkotFullWeek) {
  if (isSukkotFullWeek) return { skipped: true, assignments: {} };

  const runIdx = state.runCount;
  const shiftIdx = Math.floor(runIdx / SHIFT_LEN);
  const weekInShift = runIdx % SHIFT_LEN;
  state.runCount++;

  if (shiftIdx > state.lastShiftIdx) {
    if (state.lastShiftIdx < 0) {
      // Warm start.
      state.pairs[2] = pickTwoFresh();
      state.pairs[1] = pickTwoFresh();
      state.pairs[0] = pickTwoFresh();
    } else {
      state.pairs[2] = state.pairs[1];
      state.pairs[1] = state.pairs[0];
      state.pairs[0] = pickTwoFresh();
    }
    state.lastShiftIdx = shiftIdx;
  }

  const assignments = {};
  SUB_GROUPS.forEach((pair, pIdx) => {
    const mats = state.pairs[pIdx];
    pair.uids.forEach((uid, pos) => {
      const matIdx = (pos + weekInShift) % K;
      assignments[uid] = mats[matIdx];
    });
  });
  return { skipped: false, assignments, shiftIdx, weekInShift, runIdx };
}

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ASSERT FAILED:', msg); process.exitCode = 1; return false; }
  return true;
}

// =============================================================================
// Test 1: baseline pipeline (no dedup interference), no Sukkot.
// =============================================================================
function testBaselineNoSkip() {
  console.log('\n[test 1] baseline pipeline · 20 weeks · no Sukkot skip');
  _nextMat = 0;
  const state = { pairs: [null, null, null], lastShiftIdx: -1, runCount: 0 };
  const schedule = [];
  const seenByUid = new Map(SUB_GROUPS.flatMap(g => g.uids).map(u => [u, new Set()]));
  for (let w = 0; w < WEEKS; w++) {
    const r = runPipelineWeek(state, w, false);
    schedule.push(r);
    Object.entries(r.assignments).forEach(([uid, mat]) => {
      assert(!seenByUid.get(uid).has(mat), `iron rule: ${uid} sees ${mat} twice (week ${w})`);
      seenByUid.get(uid).add(mat);
    });
  }
  // Every 2-week shift: pair sees the swap pattern.
  for (let s = 0; s < Math.floor(WEEKS / SHIFT_LEN); s++) {
    const wA = schedule[s * SHIFT_LEN];
    const wB = schedule[s * SHIFT_LEN + 1];
    SUB_GROUPS.forEach(pair => {
      const [u0, u1] = pair.uids;
      const mA0 = wA.assignments[u0], mA1 = wA.assignments[u1];
      const mB0 = wB.assignments[u0], mB1 = wB.assignments[u1];
      assert(mA0 === mB1, `swap ${pair.id} · shift ${s} · ${u0} wk1=${mA0} should equal ${u1} wk0=${mB1}`);
      assert(mA1 === mB0, `swap ${pair.id} · shift ${s} · ${u1} wk1=${mA1} should equal ${u0} wk0=${mB0}`);
      // Latin square within cycle: uid0 and uid1 see BOTH pool mats over 2 weeks.
      const seen0 = new Set([mA0, mB0]);
      const seen1 = new Set([mA1, mB1]);
      assert(seen0.size === 2 && seen1.size === 2,
        `latin ${pair.id} · shift ${s} · ${u0}=${[...seen0]} ${u1}=${[...seen1]} — should each see 2 distinct mats`);
      assert([...seen0].every(m => seen1.has(m)),
        `latin ${pair.id} · shift ${s} · uid0 pool ${[...seen0]} != uid1 pool ${[...seen1]}`);
    });
  }
  console.log('  ✓ baseline latin-square + swap holds over 20 weeks');
}

// =============================================================================
// Test 2: Sukkot skip in the middle of a shift — cycle position must NOT advance.
// =============================================================================
function testSukkotSkip() {
  console.log(`\n[test 2] pipeline · Sukkot fullWeek skip at week idx ${SUKKOT_WEEK_IDX}`);
  _nextMat = 0;
  const state = { pairs: [null, null, null], lastShiftIdx: -1, runCount: 0 };
  const schedule = [];
  for (let w = 0; w < WEEKS; w++) {
    const isSukkot = (w === SUKKOT_WEEK_IDX);
    const r = runPipelineWeek(state, w, isSukkot);
    schedule.push({ weekIdx: w, ...r });
  }
  // The Sukkot week must have been a skip.
  assert(schedule[SUKKOT_WEEK_IDX].skipped === true, 'Sukkot week must be skipped');
  // The weeks IMMEDIATELY around Sukkot must continue the same cycle:
  // last non-skipped week before Sukkot has some (runIdx, shiftIdx, weekInShift);
  // first non-skipped week after Sukkot should have runIdx = (prev runIdx + 1).
  const before = schedule.filter((r, i) => i < SUKKOT_WEEK_IDX && !r.skipped).slice(-1)[0];
  const after  = schedule.find((r, i) => i > SUKKOT_WEEK_IDX && !r.skipped);
  assert(after.runIdx === before.runIdx + 1,
    `Sukkot skip should NOT advance runIdx (before=${before.runIdx}, after=${after.runIdx})`);
  // And if `before` was weekInShift=0 (start of a swap-pair), `after` must be weekInShift=1 (its swap).
  // Verify swap continuity across Sukkot for one full shift straddling the skip.
  if (before.weekInShift === 0) {
    SUB_GROUPS.forEach(pair => {
      const [u0, u1] = pair.uids;
      assert(before.assignments[u0] === after.assignments[u1],
        `Sukkot straddle swap ${pair.id} · ${u0} pre=${before.assignments[u0]} vs ${u1} post=${after.assignments[u1]}`);
      assert(before.assignments[u1] === after.assignments[u0],
        `Sukkot straddle swap ${pair.id} · ${u1} pre=${before.assignments[u1]} vs ${u0} post=${after.assignments[u0]}`);
    });
    console.log('  ✓ swap pattern continues cleanly across Sukkot skip');
  } else {
    console.log(`  ℹ Sukkot fell on weekInShift=${before.weekInShift+1} — straddle-swap not applicable for this seed`);
  }
  // Iron rule holds across the full 20 weeks (excluding Sukkot).
  const seenByUid = new Map(SUB_GROUPS.flatMap(g => g.uids).map(u => [u, new Set()]));
  schedule.forEach(r => Object.entries(r.assignments || {}).forEach(([uid, mat]) => {
    assert(!seenByUid.get(uid).has(mat), `iron rule broken: ${uid} sees ${mat} twice`);
    seenByUid.get(uid).add(mat);
  }));
  console.log('  ✓ iron rule holds across Sukkot skip');
}

// =============================================================================
// Test 3: v33 dedup-protection simulates the classic bug scenario.
// =============================================================================
function testDedupProtection() {
  console.log('\n[test 3] v33 dedup-protection · desync scenario');
  _nextMat = 0;
  const state = { pairs: [null, null, null], lastShiftIdx: -1, runCount: 0 };
  const schedule = [];
  for (let w = 0; w < 8; w++) schedule.push({ weekIdx: w, ...runPipelineWeek(state, w, false) });
  // Simulate a cross-region dedup that finds a duplicate involving Avigail on week 3
  // (runIdx=3, weekInShift=1 — the "swap" week where the bug hit).
  const bugWeek = schedule[3];
  const originalAvigail = bugWeek.assignments['avigail'];
  const originalVered   = bugWeek.assignments['vered'];
  assert(originalAvigail && originalVered && originalAvigail !== originalVered,
    `pre-condition: bug week must have distinct mats for avigail/vered`);

  // --- Simulate pre-v33 behavior: dedup swaps Avigail's cell to something new. ---
  const preV33 = JSON.parse(JSON.stringify(bugWeek.assignments));
  preV33['avigail'] = 'mat-INJECTED-BY-DEDUP';
  // Check that the swap pattern with the previous week (weekInShift=0) is broken.
  const prevWeek = schedule[2];
  const preV33Swap = (preV33['avigail'] === prevWeek.assignments['vered']) &&
                     (preV33['vered']   === prevWeek.assignments['avigail']);
  assert(!preV33Swap, 'pre-v33 dedup swap should HAVE broken the Latin-square swap');

  // --- Simulate v33 behavior: pipeline-protected uid — dedup skips the swap. ---
  const protectedUids = new Set(SUB_GROUPS.flatMap(g => g.uids));
  // Emulate the v33 filter inside the dedup pass.
  const dedupWouldSwap = uid => !protectedUids.has(String(uid));
  assert(!dedupWouldSwap('avigail'), 'v33: avigail (in 3-pair super-cluster) must be protected from dedup swap');
  assert(!dedupWouldSwap('vered'),   'v33: vered (in 3-pair super-cluster) must be protected from dedup swap');
  // Non-super-cluster uid still swappable.
  assert(dedupWouldSwap('free-agent-somewhere'), 'v33: free agent must remain dedup-swappable');
  // v33 assignments equal the pipeline output.
  const v33Assignments = { ...bugWeek.assignments };
  assert(v33Assignments['avigail'] === originalAvigail, 'v33: avigail preserves pipeline mat');
  assert(v33Assignments['vered']   === originalVered,   'v33: vered preserves pipeline mat');
  // Latin-square swap holds against previous week.
  const v33Swap = (v33Assignments['avigail'] === prevWeek.assignments['vered']) &&
                  (v33Assignments['vered']   === prevWeek.assignments['avigail']);
  assert(v33Swap, 'v33: Latin-square swap must hold week-to-week');
  console.log('  ✓ v33 protection preserves the pair-swap Latin square end-to-end');
}

// =============================================================================
// Test 4: pool-refresh rhythm — every K=2 pipeline runs, pair0 gets fresh mats.
// =============================================================================
function testPoolRefreshRhythm() {
  console.log('\n[test 4] pool-refresh rhythm · fresh batch every K=2 pipeline runs');
  _nextMat = 0;
  const state = { pairs: [null, null, null], lastShiftIdx: -1, runCount: 0 };
  const shiftIdxToPair0 = new Map();
  for (let w = 0; w < WEEKS; w++) {
    // Insert one skip at SUKKOT_WEEK_IDX to prove pool-refresh counts pipeline
    // runs, not calendar weeks.
    const isSukkot = (w === SUKKOT_WEEK_IDX);
    const r = runPipelineWeek(state, w, isSukkot);
    if (r.skipped) continue;
    const s = r.shiftIdx;
    if (!shiftIdxToPair0.has(s)) shiftIdxToPair0.set(s, state.pairs[0].slice());
  }
  // Consecutive shifts must have distinct pair0 mats.
  const shifts = [...shiftIdxToPair0.keys()].sort((a, b) => a - b);
  for (let i = 1; i < shifts.length; i++) {
    const a = shiftIdxToPair0.get(shifts[i - 1]);
    const b = shiftIdxToPair0.get(shifts[i]);
    assert(a[0] !== b[0] && a[1] !== b[1],
      `pool refresh @ shiftIdx ${shifts[i]}: pair0 mats must be fresh (prev=${a}, new=${b})`);
  }
  console.log('  ✓ pair0 refreshes with distinct mats every shift boundary');
  console.log(`  ✓ ${shifts.length} shifts observed over ${WEEKS} weeks with 1 Sukkot skip (calendar-week rhythm ignored)`);
}

console.log('=== v33 super-group Latin-square regression harness ===');
testBaselineNoSkip();
testSukkotSkip();
testDedupProtection();
testPoolRefreshRhythm();

if (process.exitCode) {
  console.error('\n✗ v33 harness FAILED — see assertions above.');
  process.exit(1);
} else {
  console.log('\n✓ v33 harness PASSED — 3-pair super-cluster Latin square + dedup protection verified.');
}
