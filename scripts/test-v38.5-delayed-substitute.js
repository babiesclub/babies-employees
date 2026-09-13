// v38.5 delayed-substitute — regression harness.
//
// Mirrors the substitute helpers from index.html:
//   - getSubbedGardensForUserOnDate (substitute-side, keyed by make-up date)
//   - getBlockedGardensForOriginalOnDate (original-side, keyed by ORIGINAL date)
//   - isGardenBlockedForOriginal
//   - addSubstituteAssignment (validation + originalDate semantics)
//   - _mySchedReportSubOneOff record shape (originalDate + actualDate)
//
// Assertions cover the user's story:
//   Gita missed 2026-09-10 (Thu). Meayan does the make-up on 2026-09-14 (Mon).
//   The block on Gita must apply ONLY to 10.9 + those gardens. Gita's own
//   regular schedule on 14.9 must remain FREE.
//
// Runs entirely offline. Node >= 12.

'use strict';

const assert = require('assert');

// -------- state mirrored from index.html --------
let _subAssignments = [];
let _users = [];
let _currentUserForCreate = { uid: 'admin-1', username: 'admin', role: 'admin' };

function _findUser(uid) {
  return _users.find(u => String(u.uid || u.id) === String(uid)) || null;
}

// mirror: getSubbedGardensForUserOnDate (v38.5)
function getSubbedGardensForUserOnDate(uid, date) {
  if (!uid || !date) return [];
  const matches = (_subAssignments || []).filter(s =>
    String(s.substituteUid) === String(uid) && s.date === date
  );
  const result = [];
  matches.forEach(s => {
    let gardens = Array.isArray(s.gardens) ? s.gardens : null;
    if (!gardens || !gardens.length) {
      const orig = _findUser(s.originalUid);
      gardens = orig ? (orig.gardens || []) : [];
    }
    gardens.forEach(g => {
      if (!result.find(r => r.garden === g)) result.push({
        garden: g,
        originalUid: s.originalUid,
        originalName: s.originalName,
        subId: s.id,
        notes: s.notes || '',
        originalDate: s.originalDate || s.date,
        actualDate: s.date
      });
    });
  });
  return result;
}

// mirror: getSubstituteInfoForGardenOnDate
function getSubstituteInfoForGardenOnDate(uid, garden, date) {
  if (!uid || !garden || !date) return null;
  const subs = getSubbedGardensForUserOnDate(uid, date);
  return subs.find(s => s.garden === garden) || null;
}

// mirror: getBlockedGardensForOriginalOnDate (v38.5 — keyed by originalDate)
function getBlockedGardensForOriginalOnDate(uid, date) {
  if (!uid || !date) return [];
  const matches = (_subAssignments || []).filter(s =>
    String(s.originalUid) === String(uid) && (s.originalDate || s.date) === date
  );
  const result = [];
  const orig = _findUser(uid);
  const origGardens = orig ? (orig.gardens || []) : [];
  matches.forEach(s => {
    const gardens = (Array.isArray(s.gardens) && s.gardens.length) ? s.gardens : origGardens;
    gardens.forEach(g => {
      if (!result.find(r => r.garden === g)) result.push({
        garden: g,
        subId: s.id,
        originalDate: s.originalDate || s.date,
        actualDate: s.date
      });
    });
  });
  return result;
}

function isGardenBlockedForOriginal(uid, garden, date) {
  return !!getBlockedGardensForOriginalOnDate(uid, date).find(b => b.garden === garden);
}

// mirror: addSubstituteAssignment (v38.5 signature)
function addSubstituteAssignment(date, subUid, origUid, gardens, notes, originalDate) {
  const sub = _findUser(subUid);
  const orig = _findUser(origUid);
  if (!sub || !orig) throw new Error('משתמש לא נמצא');
  if (String(subUid) === String(origUid)) throw new Error('מדריכה לא יכולה להחליף את עצמה');
  const _origDate = (originalDate && String(originalDate).trim()) ? String(originalDate).trim() : null;
  if (_origDate && _origDate > date) throw new Error('תאריך המקור חייב להיות לפני או שווה לתאריך ההשלמה');
  const doc = {
    id: 'sa-' + (_subAssignments.length + 1),
    date,
    substituteUid: String(subUid),
    substituteName: sub.name || '',
    originalUid: String(origUid),
    originalName: orig.name || '',
    gardens: gardens && gardens.length ? gardens : null,
    notes: notes || '',
    createdAt: new Date().toISOString(),
    createdBy: _currentUserForCreate.uid || _currentUserForCreate.username || 'admin',
  };
  if (_origDate && _origDate !== date) doc.originalDate = _origDate;
  _subAssignments.push(doc);
  return doc;
}

// mirror of the record shape produced by _mySchedReportSubOneOff
function buildSubReportRecord(subUid, garden, makeupDateStr) {
  const cu = _findUser(subUid);
  const _subInfo = getSubstituteInfoForGardenOnDate(subUid, garden, makeupDateStr);
  if (!_subInfo) throw new Error('no sub info');
  const _origDate = _subInfo.originalDate || makeupDateStr;
  const _isDelayedSub = _origDate !== makeupDateStr;
  return {
    id: 'r-' + Date.now(),
    instructorId: cu.id, instructorUid: cu.uid, instructorName: cu.name,
    garden,
    date: makeupDateStr,
    timeIn: '09:00', duration: 30, groups: 1, classes: [], animal: '', notes: '',
    createdAt: new Date().toISOString(),
    fromSchedule: true, fromSubstitute: true, _isSubstitute: true,
    substituteForUid: _subInfo.originalUid,
    substituteForName: _subInfo.originalName,
    originalDate: _origDate,
    actualDate: makeupDateStr,
    ...(_isDelayedSub ? { _isDelayedSubstitute: true } : {}),
  };
}

// -------- helpers --------
function reset() {
  _subAssignments = [];
  _users = [
    { uid: 'u-gita',   name: 'Gita',   gardens: ['G1','G2','G3'] },
    { uid: 'u-meayan', name: 'Meayan', gardens: ['M1'] },
    { uid: 'u-orit',   name: 'Orit',   gardens: ['O1'] },
  ];
}

function ok(name) { console.log('   ✓ ' + name); }

// -------- tests --------

function test1_delayedSub_blocksOnlyOriginalDate() {
  reset();
  addSubstituteAssignment(
    '2026-09-14',            // make-up date
    'u-meayan', 'u-gita',
    ['G1','G2'],
    'gita missed thu',
    '2026-09-10'             // original date
  );
  const meayanSubs = getSubbedGardensForUserOnDate('u-meayan', '2026-09-14');
  assert.strictEqual(meayanSubs.length, 2, 'Meayan should see 2 sub gardens on 14.9');
  assert.deepStrictEqual(meayanSubs.map(s => s.garden).sort(), ['G1','G2']);
  assert.strictEqual(meayanSubs[0].originalDate, '2026-09-10');
  assert.strictEqual(meayanSubs[0].actualDate,   '2026-09-14');
  ok('Meayan sees the sub cards on the MAKE-UP date (14.9)');

  const meayanOn10 = getSubbedGardensForUserOnDate('u-meayan', '2026-09-10');
  assert.strictEqual(meayanOn10.length, 0);
  ok('Meayan does NOT see anything on the ORIGINAL date (10.9)');

  const gitaBlocked10 = getBlockedGardensForOriginalOnDate('u-gita', '2026-09-10');
  assert.strictEqual(gitaBlocked10.length, 2, 'Gita blocked on ORIGINAL date');
  assert.deepStrictEqual(gitaBlocked10.map(b => b.garden).sort(), ['G1','G2']);
  ok('Gita is blocked on G1+G2 on 10.9 (original date)');

  const gitaBlocked14 = getBlockedGardensForOriginalOnDate('u-gita', '2026-09-14');
  assert.strictEqual(gitaBlocked14.length, 0, 'Gita FREE on make-up date');
  ok('Gita is NOT blocked on 14.9 (the make-up date)');

  const gitaBlocked11 = getBlockedGardensForOriginalOnDate('u-gita', '2026-09-11');
  assert.strictEqual(gitaBlocked11.length, 0);
  ok('Gita is NOT blocked on 11.9 (unrelated date)');

  assert.strictEqual(isGardenBlockedForOriginal('u-gita','G1','2026-09-10'), true);
  assert.strictEqual(isGardenBlockedForOriginal('u-gita','G1','2026-09-14'), false);
  assert.strictEqual(isGardenBlockedForOriginal('u-gita','G3','2026-09-10'), false); // not in list
  ok('per-garden helper agrees');
}

function test2_gitaFreeOnMakeupDate_evenIfSameGardens() {
  reset();
  // Gita normally does G1 both Thu and Sun. Meayan does make-up on Sun.
  // Delayed sub: originalDate=Thu 2026-09-10, date=Sun 2026-09-13.
  addSubstituteAssignment('2026-09-13','u-meayan','u-gita',['G1'],'','2026-09-10');
  // Meayan does the make-up on 13.9 for G1.
  assert.strictEqual(isGardenBlockedForOriginal('u-gita','G1','2026-09-13'), false,
    'Gita on 13.9 is free — her own regular G1 on Sun stays open');
  ok('Gita can still report G1 on 13.9 (her regular Sun slot)');
  assert.strictEqual(isGardenBlockedForOriginal('u-gita','G1','2026-09-10'), true);
  ok('Gita still blocked on G1 on 10.9 (the original)');
}

function test3_backwardCompat_noOriginalDate() {
  reset();
  // Pre-v38.5 flat assignment: no originalDate passed.
  addSubstituteAssignment('2026-09-14','u-meayan','u-gita',['G1']);
  const rec = _subAssignments[0];
  assert.strictEqual('originalDate' in rec, false, 'no originalDate field is stored');
  assert.strictEqual(isGardenBlockedForOriginal('u-gita','G1','2026-09-14'), true,
    'legacy assignment blocks on the date itself');
  assert.strictEqual(isGardenBlockedForOriginal('u-gita','G1','2026-09-10'), false);
  const meayanSubs = getSubbedGardensForUserOnDate('u-meayan','2026-09-14');
  assert.strictEqual(meayanSubs.length, 1);
  assert.strictEqual(meayanSubs[0].originalDate, '2026-09-14',
    'reader falls back originalDate to date');
  ok('legacy no-originalDate assignment behaves exactly as pre-v38.5');
}

function test4_originalDateEqualsDate_flattens() {
  reset();
  // Explicitly passing originalDate === date should not persist the field
  // (keeps storage clean) and behave like a same-day assignment.
  addSubstituteAssignment('2026-09-14','u-meayan','u-gita',['G1'],'','2026-09-14');
  const rec = _subAssignments[0];
  assert.strictEqual('originalDate' in rec, false,
    'originalDate === date is treated as same-day (not stored)');
  ok('originalDate === date is a no-op (same-day sub)');
}

function test5_validation_originalDateAfterDate_rejected() {
  reset();
  let thrown = null;
  try {
    addSubstituteAssignment('2026-09-14','u-meayan','u-gita',['G1'],'','2026-09-20');
  } catch (e) { thrown = e; }
  assert.ok(thrown, 'validation must throw');
  assert.ok(/תאריך המקור חייב להיות לפני או שווה/.test(thrown.message),
    'error message names the rule');
  assert.strictEqual(_subAssignments.length, 0, 'nothing persisted on rejection');
  ok('originalDate > date is rejected with the Hebrew error');
}

function test6_recordFromSubFlow_hasOriginalDateAndActualDate() {
  reset();
  addSubstituteAssignment('2026-09-14','u-meayan','u-gita',['G1','G2'],'','2026-09-10');
  const rec = buildSubReportRecord('u-meayan','G1','2026-09-14');
  assert.strictEqual(rec.date, '2026-09-14', 'record.date = make-up date');
  assert.strictEqual(rec.originalDate, '2026-09-10', 'record.originalDate set');
  assert.strictEqual(rec.actualDate, '2026-09-14', 'record.actualDate set');
  assert.strictEqual(rec._isSubstitute, true);
  assert.strictEqual(rec._isDelayedSubstitute, true);
  assert.strictEqual(rec.substituteForUid, 'u-gita');
  assert.strictEqual(rec.substituteForName, 'Gita');
  ok('sub record carries originalDate + actualDate + _isDelayedSubstitute');
}

function test7_recordFromSubFlow_sameDay_isNotFlaggedDelayed() {
  reset();
  addSubstituteAssignment('2026-09-14','u-meayan','u-gita',['G1']);   // no originalDate
  const rec = buildSubReportRecord('u-meayan','G1','2026-09-14');
  assert.strictEqual(rec.date, '2026-09-14');
  assert.strictEqual(rec.originalDate, '2026-09-14',
    'same-day sub: originalDate mirrors date');
  assert.strictEqual(rec.actualDate, '2026-09-14');
  assert.strictEqual(rec._isDelayedSubstitute, undefined,
    'no _isDelayedSubstitute flag for same-day subs');
  ok('same-day sub records do NOT get the delayed flag');
}

function test8_multipleAssignments_independent() {
  reset();
  // Same substitute Meayan covers Gita on 14.9 (delayed from 10.9)
  // and Orit on 14.9 (same-day). Both should coexist.
  addSubstituteAssignment('2026-09-14','u-meayan','u-gita',['G1'],'','2026-09-10');
  addSubstituteAssignment('2026-09-14','u-meayan','u-orit',['O1']);
  const subs = getSubbedGardensForUserOnDate('u-meayan','2026-09-14');
  assert.strictEqual(subs.length, 2);
  const gitaCard  = subs.find(s => s.garden === 'G1');
  const oritCard  = subs.find(s => s.garden === 'O1');
  assert.strictEqual(gitaCard.originalDate, '2026-09-10');
  assert.strictEqual(oritCard.originalDate, '2026-09-14');
  // Blocks land in the right places:
  assert.strictEqual(isGardenBlockedForOriginal('u-gita','G1','2026-09-10'), true);
  assert.strictEqual(isGardenBlockedForOriginal('u-gita','G1','2026-09-14'), false);
  assert.strictEqual(isGardenBlockedForOriginal('u-orit','O1','2026-09-14'), true);
  ok('delayed + same-day subs coexist and route blocks independently');
}

// -------- runner --------
const tests = [
  ['delayed sub — reader routing', test1_delayedSub_blocksOnlyOriginalDate],
  ['Gita free on make-up date even for same garden', test2_gitaFreeOnMakeupDate_evenIfSameGardens],
  ['backward compat — no originalDate', test3_backwardCompat_noOriginalDate],
  ['originalDate === date flattens', test4_originalDateEqualsDate_flattens],
  ['validation — originalDate > date rejected', test5_validation_originalDateAfterDate_rejected],
  ['record carries originalDate + actualDate', test6_recordFromSubFlow_hasOriginalDateAndActualDate],
  ['same-day sub records unflagged', test7_recordFromSubFlow_sameDay_isNotFlaggedDelayed],
  ['delayed + same-day coexist', test8_multipleAssignments_independent],
];

let failed = 0;
console.log('v38.5 delayed-substitute harness');
console.log('================================');
tests.forEach(([name, fn]) => {
  console.log('· ' + name);
  try { fn(); }
  catch (e) { failed++; console.log('   ✗ ' + (e && e.message ? e.message : e)); }
});
console.log('================================');
if (failed) {
  console.log('FAIL — ' + failed + '/' + tests.length + ' tests failed');
  process.exit(1);
}
console.log('OK — ' + tests.length + '/' + tests.length + ' tests passed');
