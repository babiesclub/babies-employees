// v38.4 multi-slot day audit — regression harness.
//
// Reproduces the scan/plan/split/keep logic from `_slotAuditScan` /
// `_slotAuditPlanSplit` / `_slotAuditSplitGroup` / `_slotAuditKeepGroup`
// in index.html and asserts:
//
//   1. Detect: instructor has 4 slots for garden X on day D, 1 record  → flagged (missing=3).
//   2. Detect: instructor has 4 slots for garden X on day D, 4 records → NOT flagged.
//   3. Detect: 4 slots, 2 records → flagged (missing=2).
//   4. Split action: 1 record + 4 slots → creates 3 clones, original tagged,
//      total 4 records with unique slotKeys covering all 4 expected keys.
//   5. Keep action: marks records `_slotAuditDone:'skipped'`, no new records.
//   6. Bulk action: processes multiple flagged days.
//   7. Guard: group is skipped if any record already has `_slotAuditDone`.
//   8. Guard: not_executed records are skipped from grouping.
//   9. Guard: 1-slot day is never flagged.
//  10. Biweekly slot on the wrong parity week is not counted.
//
// Runs entirely offline. Node >= 12.

'use strict';

const CUTOFF = '2026-09-06';

/* Mirror of helpers from index.html */
const BIWEEKLY_ANCHOR = new Date('2026-09-13T00:00:00');
function _weekParityFor(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  const diffMs = d - BIWEEKLY_ANCHOR;
  const idx = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
  return ((idx % 2) + 2) % 2;
}
function _entryMatchesWeek(e, parity) {
  if (!e || !e.biweekly) return true;
  const p = (typeof e.weekParity === 'number') ? e.weekParity : 0;
  return p === parity;
}
function _slotKey(s, e) { return (s || '') + '-' + (e || ''); }
function _dow(dateStr) { return new Date(dateStr + 'T00:00:00').getDay(); }

function _lookupUser(r, users) {
  const targetKey = r._isSubstitute && r.substituteForUid ? String(r.substituteForUid) : null;
  if (targetKey) {
    const u = users.find(x => String(x.uid || '') === targetKey || String(x.id || '') === targetKey);
    if (u) return u;
  }
  return users.find(x => (r.instructorUid && String(x.uid || '') === String(r.instructorUid)) ||
                          (r.instructorId != null && String(x.id || '') === String(r.instructorId))) || null;
}

function _expectedSlots(u, dateStr, garden) {
  if (!u || !dateStr || !garden) return { keys: [], byKey: new Map(), entries: [] };
  const dow = _dow(dateStr);
  if (dow < 0) return { keys: [], byKey: new Map(), entries: [] };
  const parity = _weekParityFor(new Date(dateStr + 'T00:00:00'));
  const raw = (u.weeklySchedule && u.weeklySchedule[dow]) || [];
  const gLower = String(garden || '').toLowerCase();
  const entries = raw.filter(e => e && String(e.garden || '').toLowerCase() === gLower && _entryMatchesWeek(e, parity));
  const keys = [...new Set(entries.map(e => _slotKey(e.start, e.end)))].sort();
  const byKey = new Map();
  entries.forEach(e => { const k = _slotKey(e.start, e.end); if (!byKey.has(k)) byKey.set(k, e); });
  return { keys, byKey, entries };
}

function _groupKey(r) {
  const uid = r._isSubstitute && r.substituteForUid ? String(r.substituteForUid)
    : (String(r.instructorUid || '') || ('id:' + String(r.instructorId || '')));
  return uid + '|' + String(r.date || '') + '|' + String(r.garden || '');
}

function scan(records, users) {
  const groups = new Map();
  records.forEach(r => {
    if (!r || !r.date || !r.garden) return;
    if (r.date < CUTOFF) return;
    if (r.status === 'not_executed') return;
    if (r._slotAuditDone) return;
    const k = _groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const flagged = [];
  groups.forEach((recs, gk) => {
    if (recs.some(r => r._slotAuditDone)) return;
    const first = recs[0];
    const u = _lookupUser(first, users);
    if (!u) return;
    const { keys, byKey, entries } = _expectedSlots(u, first.date, first.garden);
    const sCount = keys.length;
    const rCount = recs.length;
    if (sCount < 2) return;
    if (sCount <= rCount) return;
    recs.sort((a, b) => {
      const ca = String(a.createdAt || ''); const cb = String(b.createdAt || '');
      if (ca !== cb) return ca.localeCompare(cb);
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    flagged.push({ groupKey: gk, recs, firstRec: recs[0], user: u, date: first.date, garden: first.garden, expectedKeys: keys, expectedByKey: byKey, expectedEntries: entries, sCount, rCount, missing: sCount - rCount });
  });
  flagged.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return flagged;
}

function planSplit(flag) {
  const { recs, firstRec, expectedKeys, expectedByKey } = flag;
  const usedKeys = new Set();
  const existingUpdates = [];
  recs.forEach(r => {
    const k = r.slotKey;
    if (k && k !== 'unknown' && expectedKeys.includes(k) && !usedKeys.has(k)) {
      usedKeys.add(k);
      existingUpdates.push({ rec: r, newSlotKey: k, markType: 'template-kept' });
    } else {
      existingUpdates.push({ rec: r, newSlotKey: null, markType: 'template-assign' });
    }
  });
  const unusedKeys = expectedKeys.filter(k => !usedKeys.has(k));
  let uIdx = 0;
  existingUpdates.forEach(eu => {
    if (eu.newSlotKey == null) {
      if (uIdx < unusedKeys.length) eu.newSlotKey = unusedKeys[uIdx++];
      else { eu.newSlotKey = eu.rec.slotKey || 'unknown'; eu.markType = 'overflow-kept'; }
    }
  });
  const remainingKeys = unusedKeys.slice(uIdx);
  const newRecs = remainingKeys.map(k => {
    const m = expectedByKey.get(k);
    return { template: firstRec, slotKey: k, timeIn: (m && m.start) || '' };
  });
  return { existingUpdates, newRecs, orderedKeys: expectedKeys };
}

function splitGroup(records, flag) {
  const plan = planSplit(flag);
  const nowIso = new Date().toISOString();
  const idxMap = new Map(records.map((r, i) => [String(r.id), i]));
  const touchedIds = []; const newRecIds = [];
  for (const eu of plan.existingUpdates) {
    const idx = idxMap.get(String(eu.rec.id));
    if (idx == null) continue;
    const updated = { ...eu.rec, slotKey: eu.newSlotKey, _slotAuditDone: 'split', _slotAuditAt: nowIso };
    if (!eu.rec.timeIn) {
      const m = flag.expectedByKey.get(eu.newSlotKey);
      if (m && m.start) updated.timeIn = m.start;
    }
    records[idx] = updated;
    touchedIds.push(String(eu.rec.id));
  }
  let seq = 0;
  for (const nr of plan.newRecs) {
    const nid = Date.now() + Math.floor(Math.random() * 10000) + (seq++);
    const clone = { ...nr.template, id: nid, slotKey: nr.slotKey, timeIn: nr.timeIn || nr.template.timeIn || '', _slotAuditDone: 'split-clone', _slotAuditAt: nowIso, _slotAuditOfId: String(nr.template.id) };
    records.push(clone);
    newRecIds.push(String(nid));
  }
  return { touchedIds, newRecIds };
}

function keepGroup(records, flag) {
  const nowIso = new Date().toISOString();
  const idxMap = new Map(records.map((r, i) => [String(r.id), i]));
  const touchedIds = [];
  for (const r of flag.recs) {
    const idx = idxMap.get(String(r.id));
    if (idx == null) continue;
    records[idx] = { ...r, _slotAuditDone: 'skipped', _slotAuditAt: nowIso };
    touchedIds.push(String(r.id));
  }
  return { touchedIds };
}

/* ----- tests ----- */
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; console.log('  ✗ FAIL:', msg); }
}
function assertEq(a, b, msg) { assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

function mkUser(uid, name, sched) { return { uid, id: uid, name, weeklySchedule: sched }; }
function mkRec(id, uid, date, garden, extras) {
  return Object.assign({ id, instructorUid: uid, instructorId: uid, instructorName: 'X', date, garden, duration: 30, groups: 1, classes: [], animal: '', notes: '', createdAt: new Date().toISOString() }, extras || {});
}

const DATE_MON = '2026-09-14'; // Monday
const DATE_TUE = '2026-09-15'; // Tuesday
const DATE_WED = '2026-09-16'; // Wednesday

function scheduleWith(dow, entries) {
  const s = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
  s[dow] = entries;
  return s;
}

/* Case 1: 4 slots, 1 record → flagged, missing=3 */
console.log('\nTest 1 — 4 slots, 1 record → flagged missing=3');
{
  const u = mkUser('u1', 'שרון', scheduleWith(1, [
    { start: '08:00', end: '09:00', garden: 'שרת' },
    { start: '09:00', end: '10:00', garden: 'שרת' },
    { start: '10:00', end: '11:00', garden: 'שרת' },
    { start: '11:00', end: '12:00', garden: 'שרת' },
  ]));
  const recs = [mkRec('r1', 'u1', DATE_MON, 'שרת')];
  const f = scan(recs, [u]);
  assertEq(f.length, 1, 'exactly one flagged group');
  assertEq(f[0].sCount, 4, 'sCount=4');
  assertEq(f[0].rCount, 1, 'rCount=1');
  assertEq(f[0].missing, 3, 'missing=3');
}

/* Case 2: 4 slots, 4 records → NOT flagged */
console.log('\nTest 2 — 4 slots, 4 records → NOT flagged');
{
  const u = mkUser('u2', 'שרון', scheduleWith(1, [
    { start: '08:00', end: '09:00', garden: 'שרת' },
    { start: '09:00', end: '10:00', garden: 'שרת' },
    { start: '10:00', end: '11:00', garden: 'שרת' },
    { start: '11:00', end: '12:00', garden: 'שרת' },
  ]));
  const recs = [
    mkRec('r1', 'u2', DATE_MON, 'שרת', { slotKey: '08:00-09:00' }),
    mkRec('r2', 'u2', DATE_MON, 'שרת', { slotKey: '09:00-10:00' }),
    mkRec('r3', 'u2', DATE_MON, 'שרת', { slotKey: '10:00-11:00' }),
    mkRec('r4', 'u2', DATE_MON, 'שרת', { slotKey: '11:00-12:00' }),
  ];
  const f = scan(recs, [u]);
  assertEq(f.length, 0, 'no groups flagged');
}

/* Case 3: 4 slots, 2 records → flagged missing=2 */
console.log('\nTest 3 — 4 slots, 2 records → flagged missing=2');
{
  const u = mkUser('u3', 'שרון', scheduleWith(1, [
    { start: '08:00', end: '09:00', garden: 'שרת' },
    { start: '09:00', end: '10:00', garden: 'שרת' },
    { start: '10:00', end: '11:00', garden: 'שרת' },
    { start: '11:00', end: '12:00', garden: 'שרת' },
  ]));
  const recs = [
    mkRec('r1', 'u3', DATE_MON, 'שרת', { slotKey: '08:00-09:00' }),
    mkRec('r2', 'u3', DATE_MON, 'שרת', { slotKey: '09:00-10:00' }),
  ];
  const f = scan(recs, [u]);
  assertEq(f.length, 1, 'exactly one flagged group');
  assertEq(f[0].sCount, 4, 'sCount=4');
  assertEq(f[0].rCount, 2, 'rCount=2');
  assertEq(f[0].missing, 2, 'missing=2');
}

/* Case 4: Split action — 1 record + 4 slots → 4 total, unique slotKeys */
console.log('\nTest 4 — split action produces 4 records with unique slotKeys');
{
  const u = mkUser('u4', 'שרון', scheduleWith(1, [
    { start: '08:00', end: '09:00', garden: 'שרת' },
    { start: '09:00', end: '10:00', garden: 'שרת' },
    { start: '10:00', end: '11:00', garden: 'שרת' },
    { start: '11:00', end: '12:00', garden: 'שרת' },
  ]));
  const records = [mkRec('r1', 'u4', DATE_MON, 'שרת', { duration: 45, groups: 2, notes: 'הערה' })];
  const f = scan(records, [u]);
  assertEq(f.length, 1, 'flagged before split');
  const res = splitGroup(records, f[0]);
  assertEq(res.touchedIds.length, 1, '1 original touched');
  assertEq(res.newRecIds.length, 3, '3 clones created');
  const forGroup = records.filter(r => r.instructorUid === 'u4' && r.date === DATE_MON && r.garden === 'שרת');
  assertEq(forGroup.length, 4, 'total 4 records for group');
  const keys = new Set(forGroup.map(r => r.slotKey));
  assertEq(keys.size, 4, 'all slotKeys unique');
  ['08:00-09:00', '09:00-10:00', '10:00-11:00', '11:00-12:00'].forEach(k => assert(keys.has(k), `covers ${k}`));
  forGroup.forEach(r => {
    assertEq(r.duration, 45, `duration copied on ${r.id}`);
    assertEq(r.groups, 2, `groups copied on ${r.id}`);
    assert(!!r._slotAuditDone, `_slotAuditDone set on ${r.id}`);
  });
  /* Iron rule: no violation — same date+garden allowed IFF different slotKey */
  const f2 = scan(records, [u]);
  assertEq(f2.length, 0, 'no longer flagged after split');
}

/* Case 5: Keep action — no new records, all tagged skipped */
console.log('\nTest 5 — keep action tags all records skipped, no new records');
{
  const u = mkUser('u5', 'שרון', scheduleWith(1, [
    { start: '08:00', end: '09:00', garden: 'שרת' },
    { start: '09:00', end: '10:00', garden: 'שרת' },
    { start: '10:00', end: '11:00', garden: 'שרת' },
    { start: '11:00', end: '12:00', garden: 'שרת' },
  ]));
  const records = [mkRec('r1', 'u5', DATE_MON, 'שרת')];
  const before = records.length;
  const f = scan(records, [u]);
  const res = keepGroup(records, f[0]);
  assertEq(res.touchedIds.length, 1, '1 record tagged');
  assertEq(records.length, before, 'no records added');
  assertEq(records[0]._slotAuditDone, 'skipped', 'tagged skipped');
  const f2 = scan(records, [u]);
  assertEq(f2.length, 0, 'no longer flagged after keep');
}

/* Case 6: Bulk action — multiple flagged days processed correctly */
console.log('\nTest 6 — bulk action processes multiple flagged days');
{
  const u = mkUser('u6', 'שרון', {
    1: [{ start: '08:00', end: '09:00', garden: 'שרת' }, { start: '09:00', end: '10:00', garden: 'שרת' }],
    2: [{ start: '14:00', end: '15:00', garden: 'רננים' }, { start: '15:00', end: '16:00', garden: 'רננים' }, { start: '16:00', end: '17:00', garden: 'רננים' }],
  });
  const records = [
    mkRec('r1', 'u6', DATE_MON, 'שרת'),           // 1 of 2
    mkRec('r2', 'u6', DATE_TUE, 'רננים'),        // 1 of 3
  ];
  const f = scan(records, [u]);
  assertEq(f.length, 2, 'two flagged groups');
  for (const flag of f) splitGroup(records, flag);
  const monRecs = records.filter(r => r.date === DATE_MON && r.garden === 'שרת');
  const tueRecs = records.filter(r => r.date === DATE_TUE && r.garden === 'רננים');
  assertEq(monRecs.length, 2, 'Monday 2 total');
  assertEq(tueRecs.length, 3, 'Tuesday 3 total');
  const f2 = scan(records, [u]);
  assertEq(f2.length, 0, 'no more flagged groups after bulk split');
}

/* Case 7: Guard — group with any _slotAuditDone record is skipped */
console.log('\nTest 7 — group skipped when any record already audited');
{
  const u = mkUser('u7', 'שרון', scheduleWith(1, [
    { start: '08:00', end: '09:00', garden: 'שרת' },
    { start: '09:00', end: '10:00', garden: 'שרת' },
    { start: '10:00', end: '11:00', garden: 'שרת' },
  ]));
  const records = [
    mkRec('r1', 'u7', DATE_MON, 'שרת', { _slotAuditDone: 'skipped' }),
  ];
  const f = scan(records, [u]);
  assertEq(f.length, 0, 'audited record is filtered before grouping');
}

/* Case 8: Guard — not_executed records are filtered from grouping */
console.log('\nTest 8 — not_executed records filtered');
{
  const u = mkUser('u8', 'שרון', scheduleWith(1, [
    { start: '08:00', end: '09:00', garden: 'שרת' },
    { start: '09:00', end: '10:00', garden: 'שרת' },
  ]));
  const records = [
    mkRec('r1', 'u8', DATE_MON, 'שרת', { status: 'not_executed', notExecutedReason: 'לקוח ביטל' }),
  ];
  const f = scan(records, [u]);
  assertEq(f.length, 0, 'not_executed record filtered — group empty');
}

/* Case 9: Guard — 1-slot day never flagged */
console.log('\nTest 9 — 1-slot day is not flagged');
{
  const u = mkUser('u9', 'שרון', scheduleWith(1, [
    { start: '08:00', end: '09:00', garden: 'שרת' },
  ]));
  const records = [mkRec('r1', 'u9', DATE_MON, 'שרת')];
  const f = scan(records, [u]);
  assertEq(f.length, 0, '1-slot day not flagged');
}

/* Case 10: Biweekly — off-parity slot is not counted */
console.log('\nTest 10 — biweekly slot on wrong parity is excluded');
{
  const dateParity = _weekParityFor(new Date(DATE_MON + 'T00:00:00'));
  const wrongParity = dateParity === 0 ? 1 : 0;
  const u = mkUser('u10', 'שרון', scheduleWith(1, [
    { start: '08:00', end: '09:00', garden: 'שרת' },
    { start: '09:00', end: '10:00', garden: 'שרת', biweekly: true, weekParity: wrongParity },
  ]));
  const records = [mkRec('r1', 'u10', DATE_MON, 'שרת')];
  const f = scan(records, [u]);
  assertEq(f.length, 0, '2nd slot is off-parity → effective sCount=1, not flagged');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
