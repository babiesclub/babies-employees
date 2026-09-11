// v38.3 slot-key retro migration — regression harness.
//
// Reproduces the classification + split logic from `_slotMigClassify` /
// `_slotMigSplitAll` / `_slotMigMarkSingle` in index.html and asserts:
//
//   1. Auto-backfill unambiguous case (1 slot for garden that day).
//   2. Auto-backfill with timeIn tie-breaker.
//   3. Ambiguous case (N slots, no timeIn or unmatched) → flagged, no auto-backfill.
//   4. Split-all creates N records with unique slotKey.
//   5. "keep as 1" (mark-single) marks record with slotKey='unknown', no new records.
//   6. Old records without slotKey and no weeklySchedule match — left alone,
//      logged as unknown-slot.
//   7. Records with status:'not_executed' are skipped.
//   8. Records with existing _slotMigrationDone are skipped.
//   9. Substitute records use the ORIGINAL instructor's weekly schedule.
//  10. Duplicate weekly-schedule entries (same start+end) collapse to one slotKey → auto.
//
// Runs entirely offline. Node >= 12.

'use strict';

const CUTOFF = '2026-09-06';

function _slotKey(s, e) { return (s || '') + '-' + (e || ''); }

function _lookupUser(r, users) {
  const targetKey = r._isSubstitute && r.substituteForUid ? String(r.substituteForUid) : null;
  if (targetKey) {
    const u = users.find(x => String(x.uid || '') === targetKey || String(x.id || '') === targetKey);
    if (u) return u;
  }
  return users.find(x => (r.instructorUid && String(x.uid || '') === String(r.instructorUid)) ||
                          (r.instructorId != null && String(x.id || '') === String(r.instructorId))) || null;
}

function _dow(dateStr) { return new Date(dateStr + 'T00:00:00').getDay(); }

function _matchesFor(r, users) {
  const u = _lookupUser(r, users);
  if (!u) return { u: null, matches: [] };
  const dow = _dow(r.date);
  const ws = (u.weeklySchedule && u.weeklySchedule[dow]) || [];
  const gLower = String(r.garden || '').toLowerCase();
  return { u, matches: ws.filter(e => e && String(e.garden || '').toLowerCase() === gLower) };
}

function _classify(r, users) {
  if (!r) return { action: 'skip-old' };
  if (r.date < CUTOFF) return { action: 'skip-old' };
  if (r.slotKey) return { action: 'skip-has-slot' };
  if (r._slotMigrationDone) return { action: 'skip-migrated' };
  if (r.status === 'not_executed') return { action: 'skip-not-exec' };
  const { u, matches } = _matchesFor(r, users);
  if (!u) return { action: 'skip-unknown-instructor' };
  if (!matches.length) return { action: 'unknown-slot', lookupUser: u };
  const uniqueKeys = [...new Set(matches.map(m => _slotKey(m.start, m.end)))];
  if (uniqueKeys.length === 1) return { action: 'auto', slotKey: uniqueKeys[0], matches, uniqueKeys, lookupUser: u };
  if (r.timeIn) {
    const exact = [...new Set(matches.filter(m => m.start === r.timeIn).map(m => _slotKey(m.start, m.end)))];
    if (exact.length === 1) return { action: 'auto', slotKey: exact[0], matches, uniqueKeys, lookupUser: u };
  }
  return { action: 'ambiguous', matches, uniqueKeys, lookupUser: u };
}

/* --- Action simulators mirroring index.html --- */

function applyAuto(records, users) {
  const out = records.slice();
  const idxMap = new Map(out.map((r, i) => [String(r.id), i]));
  const audit = [];
  out.forEach(r => {
    const c = _classify(r, users);
    if (c.action !== 'auto') return;
    const i = idxMap.get(String(r.id));
    out[i] = { ...r, slotKey: c.slotKey, _slotMigrationDone: true, _slotMigrationSource: 'auto' };
    audit.push({ id: String(r.id), slotKey: c.slotKey });
  });
  return { records: out, audit };
}

function applySplitAll(records, users, recId) {
  const out = records.slice();
  const idx = out.findIndex(r => String(r.id) === String(recId));
  if (idx < 0) throw new Error('not found');
  const r = out[idx];
  const c = _classify(r, users);
  if (c.action !== 'ambiguous') throw new Error('not ambiguous: ' + c.action);
  const uniqueKeys = [...new Set(c.matches.map(m => _slotKey(m.start, m.end)))].sort();
  const keyToMatch = new Map();
  c.matches.forEach(m => { const k = _slotKey(m.start, m.end); if (!keyToMatch.has(k)) keyToMatch.set(k, m); });
  const first = keyToMatch.get(uniqueKeys[0]);
  out[idx] = { ...r, slotKey: uniqueKeys[0], timeIn: r.timeIn || first.start || '', _slotMigrationDone: true, _slotMigrationSource: 'manual-split-all' };
  const newIds = [];
  for (let i = 1; i < uniqueKeys.length; i++) {
    const k = uniqueKeys[i];
    const m = keyToMatch.get(k);
    const nid = 'clone-' + i + '-' + r.id;
    out.push({ ...r, id: nid, slotKey: k, timeIn: (m && m.start) || '', _slotMigrationDone: true, _slotMigrationSource: 'manual-split-all-clone', _slotMigrationOfId: String(r.id) });
    newIds.push(nid);
  }
  return { records: out, newIds };
}

function applyMarkSingle(records, recId) {
  const out = records.slice();
  const idx = out.findIndex(r => String(r.id) === String(recId));
  if (idx < 0) throw new Error('not found');
  out[idx] = { ...out[idx], slotKey: 'unknown', _slotMigrationDone: true, _slotMigrationSource: 'manual-single' };
  return { records: out };
}

// -----------------------------------------------------------------------------
// Runner
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
function assert(label, cond) { check(label, !!cond, true); }

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------
const USERS = [
  {
    uid: 'uid-shir', id: 42, name: 'שיר',
    weeklySchedule: {
      // Sun = 0. 2026-09-06 is Sunday.
      0: [
        { garden: 'גן חיפושית', start: '09:00', end: '09:30', note: '1 קבוצה' },
      ],
      // Mon = 1. 2026-09-07.
      1: [
        { garden: 'אפטר סקול - שמגר', start: '13:00', end: '13:40' },
        { garden: 'אפטר סקול - שמגר', start: '13:40', end: '14:20' },
        { garden: 'אפטר סקול - שמגר', start: '14:20', end: '15:00' },
        { garden: 'אפטר סקול - שמגר', start: '15:00', end: '15:40' },
      ],
      // Tue = 2. 2026-09-08 — duplicate identical entries.
      2: [
        { garden: 'משפחתון תות', start: '08:30', end: '09:00' },
        { garden: 'משפחתון תות', start: '08:30', end: '09:00' },
      ],
    },
  },
  {
    uid: 'uid-orig', id: 99, name: 'המקורית',
    weeklySchedule: {
      3: [
        { garden: 'גן הפרפרים', start: '10:00', end: '10:30' },
      ],
    },
  },
];

// -----------------------------------------------------------------------------
console.log('\nTest 1 — auto-backfill unambiguous (single slot for garden that day)');
{
  const records = [
    { id: 'r1', instructorUid: 'uid-shir', instructorId: 42, garden: 'גן חיפושית', date: '2026-09-06', duration: 30, groups: 1 },
  ];
  const c = _classify(records[0], USERS);
  check('classified as auto', c.action, 'auto');
  check('slotKey picked', c.slotKey, '09:00-09:30');
  const applied = applyAuto(records, USERS);
  check('record now has slotKey', applied.records[0].slotKey, '09:00-09:30');
  assert('_slotMigrationDone flag set', applied.records[0]._slotMigrationDone === true);
  check('one audit entry', applied.audit.length, 1);
}

// -----------------------------------------------------------------------------
console.log('\nTest 2 — auto-backfill with timeIn tie-breaker among distinct slots');
{
  const records = [
    { id: 'r2', instructorUid: 'uid-shir', instructorId: 42, garden: 'אפטר סקול - שמגר', date: '2026-09-07', timeIn: '13:40', duration: 40, groups: 1 },
  ];
  const c = _classify(records[0], USERS);
  check('classified as auto (timeIn matched)', c.action, 'auto');
  check('slotKey = second slot', c.slotKey, '13:40-14:20');
}

// -----------------------------------------------------------------------------
console.log('\nTest 3 — ambiguous (N distinct slots, no timeIn or unmatched)');
{
  const records = [
    // No timeIn at all
    { id: 'r3a', instructorUid: 'uid-shir', instructorId: 42, garden: 'אפטר סקול - שמגר', date: '2026-09-07', duration: 40, groups: 1 },
    // timeIn that matches none of the slot starts
    { id: 'r3b', instructorUid: 'uid-shir', instructorId: 42, garden: 'אפטר סקול - שמגר', date: '2026-09-07', timeIn: '09:10', duration: 40, groups: 1 },
  ];
  records.forEach(r => {
    const c = _classify(r, USERS);
    check(`record ${r.id} ambiguous`, c.action, 'ambiguous');
    check(`record ${r.id} unique-key count`, c.uniqueKeys.length, 4);
  });
  const applied = applyAuto(records, USERS);
  assert('r3a NOT auto-backfilled', !applied.records[0].slotKey);
  assert('r3b NOT auto-backfilled', !applied.records[1].slotKey);
  assert('_slotMigrationDone NOT set', !applied.records[0]._slotMigrationDone);
}

// -----------------------------------------------------------------------------
console.log('\nTest 4 — split-all creates N records with unique slotKeys');
{
  const records = [
    { id: 'r4', instructorUid: 'uid-shir', instructorId: 42, garden: 'אפטר סקול - שמגר', date: '2026-09-07', duration: 40, groups: 1, notes: 'yay' },
  ];
  const result = applySplitAll(records, USERS, 'r4');
  check('total records after split', result.records.length, 4);
  const forGardenDate = result.records.filter(r => r.garden === 'אפטר סקול - שמגר' && r.date === '2026-09-07');
  check('4 records for that garden+date', forGardenDate.length, 4);
  const keys = forGardenDate.map(r => r.slotKey).sort();
  check('unique slotKeys', keys, ['13:00-13:40', '13:40-14:20', '14:20-15:00', '15:00-15:40']);
  assert('all have _slotMigrationDone', forGardenDate.every(r => r._slotMigrationDone));
  assert('duration preserved on all', forGardenDate.every(r => r.duration === 40));
  assert('notes preserved on all', forGardenDate.every(r => r.notes === 'yay'));
  assert('3 new records tagged with _slotMigrationOfId', result.records.filter(r => r._slotMigrationOfId === 'r4').length === 3);
}

// -----------------------------------------------------------------------------
console.log('\nTest 5 — mark-single sets slotKey=unknown, no new records');
{
  const records = [
    { id: 'r5', instructorUid: 'uid-shir', instructorId: 42, garden: 'אפטר סקול - שמגר', date: '2026-09-07', duration: 40, groups: 1 },
  ];
  const result = applyMarkSingle(records, 'r5');
  check('still one record', result.records.length, 1);
  check('slotKey = unknown', result.records[0].slotKey, 'unknown');
  assert('_slotMigrationDone true', result.records[0]._slotMigrationDone === true);
  const c2 = _classify(result.records[0], USERS);
  check('re-classify skips as has-slot', c2.action, 'skip-has-slot');
}

// -----------------------------------------------------------------------------
console.log('\nTest 6 — unknown garden (not in weekly schedule): left alone');
{
  const records = [
    { id: 'r6', instructorUid: 'uid-shir', instructorId: 42, garden: 'גן שלא קיים במערכת', date: '2026-09-06', duration: 30, groups: 1 },
  ];
  const c = _classify(records[0], USERS);
  check('classified as unknown-slot', c.action, 'unknown-slot');
  const applied = applyAuto(records, USERS);
  assert('no slotKey assigned', !applied.records[0].slotKey);
  assert('_slotMigrationDone NOT set', !applied.records[0]._slotMigrationDone);
  check('no audit entries for unknown-slot', applied.audit.length, 0);
}

// -----------------------------------------------------------------------------
console.log('\nTest 7 — not_executed records skipped');
{
  const records = [
    { id: 'r7', instructorUid: 'uid-shir', instructorId: 42, garden: 'גן חיפושית', date: '2026-09-06', status: 'not_executed', notExecutedReason: 'ילד חולה' },
  ];
  const c = _classify(records[0], USERS);
  check('classified as skip-not-exec', c.action, 'skip-not-exec');
  const applied = applyAuto(records, USERS);
  assert('not_executed record untouched', !applied.records[0].slotKey);
}

// -----------------------------------------------------------------------------
console.log('\nTest 8 — records already migrated (_slotMigrationDone) skipped');
{
  const records = [
    { id: 'r8', instructorUid: 'uid-shir', instructorId: 42, garden: 'גן חיפושית', date: '2026-09-06', _slotMigrationDone: true },
  ];
  const c = _classify(records[0], USERS);
  check('classified as skip-migrated', c.action, 'skip-migrated');
}

// -----------------------------------------------------------------------------
console.log('\nTest 9 — substitute records use ORIGINAL instructor schedule');
{
  const records = [
    // Substitute (shir) reported for uid-orig's Wed slot at גן הפרפרים.
    { id: 'r9', instructorUid: 'uid-shir', instructorId: 42, _isSubstitute: true, substituteForUid: 'uid-orig', substituteForName: 'המקורית',
      garden: 'גן הפרפרים', date: '2026-09-09' /* Wed */, duration: 30, groups: 1 },
  ];
  const c = _classify(records[0], USERS);
  check('sub classified auto via original schedule', c.action, 'auto');
  check('slotKey from original', c.slotKey, '10:00-10:30');
  check('lookupUser is the original', c.lookupUser && c.lookupUser.uid, 'uid-orig');
}

// -----------------------------------------------------------------------------
console.log('\nTest 10 — duplicate identical weekly entries collapse to one slotKey → auto');
{
  const records = [
    { id: 'r10', instructorUid: 'uid-shir', instructorId: 42, garden: 'משפחתון תות', date: '2026-09-08' /* Tue */, duration: 30, groups: 1 },
  ];
  const c = _classify(records[0], USERS);
  check('classified as auto (dup entries → single unique key)', c.action, 'auto');
  check('slotKey', c.slotKey, '08:30-09:00');
}

// -----------------------------------------------------------------------------
console.log('\nTest 11 — old records (< CUTOFF) skipped');
{
  const records = [
    { id: 'r11', instructorUid: 'uid-shir', instructorId: 42, garden: 'גן חיפושית', date: '2026-08-20', duration: 30, groups: 1 },
  ];
  const c = _classify(records[0], USERS);
  check('classified as skip-old', c.action, 'skip-old');
}

// -----------------------------------------------------------------------------
console.log('\nTest 12 — payroll count invariant: split-all leaves same aggregate duration');
{
  const records = [
    { id: 'r12', instructorUid: 'uid-shir', instructorId: 42, garden: 'אפטר סקול - שמגר', date: '2026-09-07', duration: 40, groups: 1 },
  ];
  const totalBefore = records.reduce((s, r) => s + (r.duration || 0), 0);
  const result = applySplitAll(records, USERS, 'r12');
  const totalAfter = result.records
    .filter(r => r.garden === 'אפטר סקול - שמגר' && r.date === '2026-09-07')
    .reduce((s, r) => s + (r.duration || 0), 0);
  /* Split "all N executed" means N * original_duration — the whole point. */
  check('sum(duration) after = N * before', totalAfter, 4 * totalBefore);
  /* Iron rule: 4 distinct slotKeys on same date+garden. */
  const keys = new Set(result.records
    .filter(r => r.garden === 'אפטר סקול - שמגר' && r.date === '2026-09-07')
    .map(r => r.slotKey));
  check('4 distinct slotKeys (iron rule)', keys.size, 4);
}

// -----------------------------------------------------------------------------
if (failures > 0) {
  console.log(`\n❌ ${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\n✅ All v38.3 slot-migration tests passed.');
