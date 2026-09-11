// v38.2 Independent Per-Slot Reports — regression harness.
//
// Reproduces the slot-lookup logic inside `_mySchedFindReport` (index.html)
// in isolation and asserts:
//
//   1. Create instructor with 4 slots same day/garden different times.
//   2. Report slot 1 → find slot 1 finds it, slots 2-4 don't.
//   3. Report slot 2 → find slot 2 finds it, slots 3-4 still don't.
//   4. Old-format record (no slotKey) → detected only for the FIRST matching slot.
//   5. finalizeAttSubmit-style record with slotKey derived from timeIn+duration
//      is correctly matched by its slot on the mysched view.
//
// Runs entirely offline. Node ≥ 12.

'use strict';

// -----------------------------------------------------------------------------
// Pure re-implementation of index.html helpers.
// -----------------------------------------------------------------------------
function _mySchedSlotKey(startTime, endTime) {
  return (startTime || '') + '-' + (endTime || '');
}

function _mySchedComputeEndTime(startTime, dur) {
  const d = parseInt(dur, 10);
  if (!startTime || !d || isNaN(d)) return '';
  const p = String(startTime).split(':').map(Number);
  if (p.length < 2 || isNaN(p[0]) || isNaN(p[1])) return '';
  const t = p[0] * 60 + p[1] + d;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

// cu-aware variant — takes explicit cu so we can test with different instructors.
function _mySchedFindReport(records, cu, date, garden, slotKey, isFirstSlotForGarden) {
  return records.find(r => {
    if (r.date !== date || r.garden !== garden) return false;
    if (!(r.instructorId == cu.id || r.instructorUid === cu.uid)) return false;
    if (slotKey === undefined) return true; // legacy caller
    if (r.slotKey) return r.slotKey === slotKey; // new record — exact match
    return !!isFirstSlotForGarden; // legacy record: first-slot fallback
  }) || null;
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------
const cu = { id: 'u1', uid: 'uid-1', name: 'שיר בדיקה' };
const DATE = '2026-09-14';
const GARDEN = 'אפטר סקול - שמגר';

const SLOTS = [
  { garden: GARDEN, start: '13:00', end: '13:40', note: '1 קבוצה' },
  { garden: GARDEN, start: '13:40', end: '14:20', note: '1 קבוצה' },
  { garden: GARDEN, start: '14:20', end: '15:00', note: '1 קבוצה' },
  { garden: GARDEN, start: '15:00', end: '15:40', note: '1 קבוצה' },
];

const isFirstSlotForGardenAt = (idx) => idx === 0; // slot 0 is the earliest

// -----------------------------------------------------------------------------
// Test runner
// -----------------------------------------------------------------------------
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}`);
  if (!ok) {
    console.log(`         expected: ${JSON.stringify(expected)}`);
    console.log(`         actual  : ${JSON.stringify(actual)}`);
    failures++;
  }
}

// -----------------------------------------------------------------------------
// Test 1: Compute helpers
// -----------------------------------------------------------------------------
console.log('\nTest 1 — helpers');
check('slotKey(13:00, 13:40)', _mySchedSlotKey('13:00', '13:40'), '13:00-13:40');
check('slotKey(empty)', _mySchedSlotKey('', ''), '-');
check('computeEndTime(13:00, 40)', _mySchedComputeEndTime('13:00', 40), '13:40');
check('computeEndTime(13:40, 40)', _mySchedComputeEndTime('13:40', 40), '14:20');
check('computeEndTime(15:00, 40)', _mySchedComputeEndTime('15:00', 40), '15:40');

// -----------------------------------------------------------------------------
// Test 2: Report slot 1 → slots 2/3/4 stay unreported
// -----------------------------------------------------------------------------
console.log('\nTest 2 — reporting slot 1 does not affect slots 2/3/4');
{
  const records = [];
  const slot1 = SLOTS[0];
  records.push({
    id: 1001,
    instructorId: cu.id,
    instructorUid: cu.uid,
    garden: slot1.garden,
    date: DATE,
    timeIn: slot1.start,
    duration: 40,
    slotKey: _mySchedSlotKey(slot1.start, slot1.end),
    createdAt: '2026-09-14T13:41:00Z',
    fromSchedule: true,
  });

  SLOTS.forEach((s, i) => {
    const sk = _mySchedSlotKey(s.start, s.end);
    const rec = _mySchedFindReport(records, cu, DATE, GARDEN, sk, isFirstSlotForGardenAt(i));
    check(`slot ${i + 1} (${sk}) reported?`, !!rec, i === 0);
  });
}

// -----------------------------------------------------------------------------
// Test 3: Report slot 2 as well → slots 3/4 still unreported
// -----------------------------------------------------------------------------
console.log('\nTest 3 — after reporting slots 1 & 2, only 3/4 are unreported');
{
  const records = [];
  [0, 1].forEach(i => {
    const s = SLOTS[i];
    records.push({
      id: 2000 + i,
      instructorId: cu.id,
      instructorUid: cu.uid,
      garden: s.garden,
      date: DATE,
      timeIn: s.start,
      duration: 40,
      slotKey: _mySchedSlotKey(s.start, s.end),
      createdAt: '2026-09-14T14:00:00Z',
      fromSchedule: true,
    });
  });

  SLOTS.forEach((s, i) => {
    const sk = _mySchedSlotKey(s.start, s.end);
    const rec = _mySchedFindReport(records, cu, DATE, GARDEN, sk, isFirstSlotForGardenAt(i));
    check(`slot ${i + 1} (${sk}) reported?`, !!rec, i <= 1);
  });
}

// -----------------------------------------------------------------------------
// Test 4: Legacy record (no slotKey) → matches only slot 1 (first slot)
// -----------------------------------------------------------------------------
console.log('\nTest 4 — legacy record (no slotKey) matches only first slot');
{
  const records = [{
    id: 3000,
    instructorId: cu.id,
    instructorUid: cu.uid,
    garden: GARDEN,
    date: DATE,
    timeIn: '13:00',
    duration: 40,
    // NO slotKey — pre-v38.2 record
    createdAt: '2026-01-01T00:00:00Z',
    fromSchedule: true,
  }];

  SLOTS.forEach((s, i) => {
    const sk = _mySchedSlotKey(s.start, s.end);
    const rec = _mySchedFindReport(records, cu, DATE, GARDEN, sk, isFirstSlotForGardenAt(i));
    check(`slot ${i + 1} (${sk}) matched by legacy record?`, !!rec, i === 0);
  });

  // Legacy caller with no slotKey argument → matches (backward compat)
  const legacyLookup = _mySchedFindReport(records, cu, DATE, GARDEN);
  check('legacy caller (no slotKey arg) still finds the record', !!legacyLookup, true);
}

// -----------------------------------------------------------------------------
// Test 5: finalizeAttSubmit-style record — slotKey from timeIn+duration
// -----------------------------------------------------------------------------
console.log('\nTest 5 — admin att-created record with slotKey via computeEndTime');
{
  const ti = '13:40';
  const dur = 40;
  const attEnd = _mySchedComputeEndTime(ti, dur);
  const attSlotKey = _mySchedSlotKey(ti, attEnd);
  check('admin att slotKey derived', attSlotKey, '13:40-14:20');

  const records = [{
    id: 4000,
    instructorId: cu.id,
    instructorUid: cu.uid,
    garden: GARDEN,
    date: DATE,
    timeIn: ti,
    duration: dur,
    slotKey: attSlotKey,
    createdByAdmin: 'admin',
    createdAt: '2026-09-14T15:00:00Z',
  }];

  SLOTS.forEach((s, i) => {
    const sk = _mySchedSlotKey(s.start, s.end);
    const rec = _mySchedFindReport(records, cu, DATE, GARDEN, sk, isFirstSlotForGardenAt(i));
    check(`slot ${i + 1} (${sk}) reported by admin att?`, !!rec, s.start === ti);
  });
}

// -----------------------------------------------------------------------------
// Test 6: Different instructor → not matched
// -----------------------------------------------------------------------------
console.log('\nTest 6 — record for a different instructor does not match');
{
  const cu2 = { id: 'u2', uid: 'uid-2' };
  const records = [{
    id: 5000,
    instructorId: cu2.id,
    instructorUid: cu2.uid,
    garden: GARDEN,
    date: DATE,
    timeIn: '13:00',
    duration: 40,
    slotKey: _mySchedSlotKey('13:00', '13:40'),
  }];

  const sk = _mySchedSlotKey('13:00', '13:40');
  const rec = _mySchedFindReport(records, cu, DATE, GARDEN, sk, true);
  check('slot 1 record for a different instructor', !!rec, false);
}

// -----------------------------------------------------------------------------
if (failures > 0) {
  console.log(`\n❌ ${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\n✅ All v38.2 slot-lookup tests passed.');
