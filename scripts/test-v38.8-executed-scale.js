#!/usr/bin/env node
/*
 * v38.8 test harness — "% executed" monthly scale.
 *
 * Mirrors the four compute helpers added in index.html:
 *   _slrPlannedSlotsFor(user, month)
 *   _slrExecutedSlotsFor(user, month)
 *   _slrSlotMatch(plannedSlot, records)
 *   _slrExecutionPercent(user, month)
 *
 * Run: `node scripts/test-v38.8-executed-scale.js`
 * (Standalone — no Firestore, no browser.)
 */

'use strict';

/* ---- helpers copied verbatim from index.html ---- */
const _BIWEEKLY_ANCHOR = new Date('2026-09-13T00:00:00');
function _weekParityFor(date){const d=new Date(date);d.setHours(0,0,0,0);const day=d.getDay();d.setDate(d.getDate()-day);const diffMs=d-_BIWEEKLY_ANCHOR;const idx=Math.floor(diffMs/(7*24*60*60*1000));return((idx%2)+2)%2}
function _readEntry(e){if(!e)return e;if(e.biweekly!==undefined)return e;const noteRaw=e.note||'';const biRe=/^\s*\[דו[-\s]שבועי\]\s*/;if(biRe.test(noteRaw))return Object.assign({},e,{biweekly:true,weekParity:0,note:noteRaw.replace(biRe,'').trim()});return e}
function _entryMatchesWeek(e,parity){if(!e||!e.biweekly)return true;const p=(typeof e.weekParity==='number')?e.weekParity:0;return p===parity}
function _mySchedSlotKey(startTime,endTime){return (startTime||'')+'-'+(endTime||'')}

/* Records store; the helpers pull records for the target instructor+month. */
let _records = [];
function _getInstrMonthRecords(user, month){
  const uid = user.uid || null, id = user.id;
  return _records.filter(r => {
    if (!r.date || !r.date.startsWith(month)) return false;
    if (uid && r.instructorUid && r.instructorUid === uid) return true;
    if (r.instructorId != null && String(r.instructorId) === String(id)) return true;
    return false;
  }).sort((a,b) => a.date.localeCompare(b.date));
}

/* ---- ports of the v38.8 helpers ---- */
function _slrPlannedSlotsFor(user, month){
  if (!user || !month) return [];
  const sched = user.weeklySchedule || {};
  const parts = String(month).split('-');
  if (parts.length < 2) return [];
  const y = parseInt(parts[0],10), m = parseInt(parts[1],10);
  if (!y || !m) return [];
  const daysInMonth = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= daysInMonth; d++){
    const date = new Date(y, m-1, d);
    const dow = date.getDay();
    const parity = _weekParityFor(date);
    const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayRaw = sched[dow] || sched[String(dow)] || [];
    const entries = dayRaw.map(_readEntry).filter(e => e && _entryMatchesWeek(e, parity));
    entries.forEach(e => {
      if (!e || !e.garden) return;
      out.push({ date:dateStr, day:dow, garden:e.garden, start:e.start||'', end:e.end||'', note:e.note||'', entry:e });
    });
  }
  return out;
}
function _slrExecutedSlotsFor(user, month){
  return _getInstrMonthRecords(user, month).filter(r => r && r.status !== 'not_executed');
}
function _slrSlotMatch(plannedSlot, records){
  if (!plannedSlot || !records || !records.length) return null;
  const wanted = _mySchedSlotKey(plannedSlot.start, plannedSlot.end);
  const candidates = records.filter(r => r && r.date === plannedSlot.date && r.garden === plannedSlot.garden);
  if (!candidates.length) return null;
  const bySlot = candidates.find(r => r.slotKey && r.slotKey === wanted);
  if (bySlot) return bySlot;
  const legacy = candidates.find(r => !r.slotKey);
  if (legacy) return legacy;
  return candidates[0] || null;
}
function _slrExecutionPercent(user, month){
  const planned = _slrPlannedSlotsFor(user, month);
  const executed = _slrExecutedSlotsFor(user, month);
  if (!planned.length) return { planned:0, executed:executed.length, matched:0, missing:[], details:[], percent:0 };
  const remaining = executed.slice();
  const details = planned.map(ps => {
    const wanted = _mySchedSlotKey(ps.start, ps.end);
    let idx = remaining.findIndex(r => r.date === ps.date && r.garden === ps.garden && r.slotKey === wanted);
    if (idx === -1) idx = remaining.findIndex(r => r.date === ps.date && r.garden === ps.garden && !r.slotKey);
    if (idx === -1) idx = remaining.findIndex(r => r.date === ps.date && r.garden === ps.garden);
    let rec = null;
    if (idx !== -1) { rec = remaining[idx]; remaining.splice(idx,1); }
    return { slot: ps, record: rec };
  });
  const missing = details.filter(d => !d.record).map(d => d.slot);
  const matched = details.length - missing.length;
  return { planned: planned.length, executed: executed.length, matched, missing, details, percent: planned.length ? (executed.length / planned.length) : 0 };
}

/* ---- test runner ---- */
let _passed = 0, _failed = 0;
function assert(name, cond, details){
  if (cond){ _passed++; console.log(`  ✓ ${name}`); }
  else { _failed++; console.log(`  ✗ ${name}`); if (details) console.log('     ' + details); }
}
function eq(name, actual, expected){
  const ok = (JSON.stringify(actual) === JSON.stringify(expected));
  assert(name, ok, ok ? '' : `expected=${JSON.stringify(expected)}  actual=${JSON.stringify(actual)}`);
}
function section(title){ console.log('\n' + title); }

/* ================================================================
   TEST 1 — 4 planned slots on Mondays × 4 Mondays = 16 planned.
                12 records → 75%.
   In Sep 2026: Mondays fall on 7, 14, 21, 28  →  4 Mondays. ✓
=================================================================== */
section('Test 1: weekly Mondays × month → planned=16, records=12 → 75%');
const user1 = {
  uid: 'u1', id: 1, name: 'טסט אחת',
  weeklySchedule: {
    1: [ // Monday
      { garden:'גן א', start:'08:00', end:'09:00' },
      { garden:'גן א', start:'09:00', end:'10:00' },
      { garden:'גן ב', start:'10:30', end:'11:30' },
      { garden:'גן ב', start:'11:30', end:'12:30' },
    ]
  }
};
_records = [];
// 12 executed records — 3 slots × 4 Mondays (missing slot #4)
['2026-09-07','2026-09-14','2026-09-21','2026-09-28'].forEach(date => {
  _records.push({ id:'r'+date+'1', instructorUid:'u1', date, garden:'גן א', slotKey:'08:00-09:00', duration:60, groups:1 });
  _records.push({ id:'r'+date+'2', instructorUid:'u1', date, garden:'גן א', slotKey:'09:00-10:00', duration:60, groups:1 });
  _records.push({ id:'r'+date+'3', instructorUid:'u1', date, garden:'גן ב', slotKey:'10:30-11:30', duration:60, groups:1 });
});
const r1 = _slrExecutionPercent(user1, '2026-09');
eq('planned = 16', r1.planned, 16);
eq('executed = 12', r1.executed, 12);
eq('missing.length = 4', r1.missing.length, 4);
assert('percent = 75%', Math.round(r1.percent*100) === 75, `got ${Math.round(r1.percent*100)}%`);
const missingSlotKeys = r1.missing.map(s => `${s.date}|${s.garden}|${s.start}-${s.end}`);
assert('4 unreported are all the 11:30-12:30 גן ב slot',
  missingSlotKeys.every(k => k.includes('גן ב|11:30-12:30')),
  missingSlotKeys.join('  '));

/* ================================================================
   TEST 2 — status='not_executed' records are EXCLUDED from executed.
=================================================================== */
section('Test 2: status=not_executed excluded from executed count');
const user2 = { uid:'u2', id:2, weeklySchedule:{ 1:[{garden:'גן א',start:'08:00',end:'09:00'}] } };
_records = [
  { id:'x1', instructorUid:'u2', date:'2026-09-07', garden:'גן א', slotKey:'08:00-09:00', status:'not_executed' },
  { id:'x2', instructorUid:'u2', date:'2026-09-14', garden:'גן א', slotKey:'08:00-09:00' },
];
const r2 = _slrExecutionPercent(user2, '2026-09');
eq('planned = 4 (4 Mondays)', r2.planned, 4);
eq('executed = 1 (not_executed excluded)', r2.executed, 1);
eq('matched = 1', r2.matched, 1);
eq('missing = 3', r2.missing.length, 3);

/* ================================================================
   TEST 3 — Substitute records (_isSubstitute:true) count as executed
              for the substitute (who owns the record via instructorUid).
=================================================================== */
section('Test 3: _isSubstitute records count for the substitute');
const userSub = { uid:'sub', id:99, weeklySchedule:{} }; // no planned slots
_records = [
  { id:'s1', instructorUid:'sub', date:'2026-09-10', garden:'גן ג', slotKey:'08:00-09:00',
    _isSubstitute:true, substituteForUid:'orig', substituteForName:'המקורית' },
];
const rSub = _slrExecutionPercent(userSub, '2026-09');
eq('substitute has 0 planned', rSub.planned, 0);
eq('substitute executed = 1', rSub.executed, 1);
eq('substitute record is included in executed', _slrExecutedSlotsFor(userSub,'2026-09').length, 1);
// And that the substitute record does NOT count for the original (unless matched by planned/executed rules)
const userOrig = { uid:'orig', id:100, weeklySchedule:{ 4:[{garden:'גן ג',start:'08:00',end:'09:00'}] } };
_records = [
  { id:'s1', instructorUid:'sub', date:'2026-09-10', garden:'גן ג', slotKey:'08:00-09:00',
    _isSubstitute:true, substituteForUid:'orig' },
];
const rOrig = _slrExecutionPercent(userOrig, '2026-09');
eq('original executed = 0 (the sub record is owned by sub, not orig)', rOrig.executed, 0);

/* ================================================================
   TEST 4 — Biweekly slots count only weeks matching the parity.
              Anchor is 2026-09-13 (parity 0 week starts there).
=================================================================== */
section('Test 4: biweekly slot — half the Mondays only');
const parities = ['2026-09-07','2026-09-14','2026-09-21','2026-09-28']
  .map(d => ({ date:d, parity: _weekParityFor(new Date(d+'T00:00:00')) }));
console.log('  Monday parities in Sep 2026: ' + parities.map(p=>`${p.date}=${p.parity}`).join(', '));
const user4 = { uid:'u4', id:4, weeklySchedule:{ 1:[
  { garden:'גן ד', start:'08:00', end:'09:00', biweekly:true, weekParity:0 },
]}};
_records = [];
const r4 = _slrExecutionPercent(user4, '2026-09');
const p0Mondays = parities.filter(p => p.parity===0).length;
eq(`biweekly parity=0 → planned = ${p0Mondays}`, r4.planned, p0Mondays);
// And parity=1 slot should give the complement.
const user4b = { uid:'u4b', id:41, weeklySchedule:{ 1:[
  { garden:'גן ד', start:'08:00', end:'09:00', biweekly:true, weekParity:1 },
]}};
const r4b = _slrExecutionPercent(user4b, '2026-09');
const p1Mondays = parities.filter(p => p.parity===1).length;
eq(`biweekly parity=1 → planned = ${p1Mondays}`, r4b.planned, p1Mondays);
eq('parity 0 + parity 1 = all 4 Mondays', r4.planned + r4b.planned, 4);

/* ================================================================
   TEST 5 — Detail modal data: shows 4 unreported slots correctly.
=================================================================== */
section('Test 5: detail modal — 4 planned, 0 executed, all 4 missing');
const user5 = { uid:'u5', id:5, weeklySchedule:{
  1:[{ garden:'גן ה', start:'08:00', end:'09:00' }],
}};
_records = [];
const r5 = _slrExecutionPercent(user5, '2026-09');
eq('planned = 4', r5.planned, 4);
eq('executed = 0', r5.executed, 0);
eq('missing = 4', r5.missing.length, 4);
eq('details length = 4', r5.details.length, 4);
assert('every detail row has record=null', r5.details.every(d => d.record === null));
const missingDates = r5.missing.map(s => s.date).sort();
eq('missing dates are the 4 Sep-2026 Mondays', missingDates, ['2026-09-07','2026-09-14','2026-09-21','2026-09-28']);

/* ================================================================
   BONUS — Legacy record without slotKey collapses onto the first slot only.
=================================================================== */
section('Bonus: legacy record (no slotKey) matches one planned slot, others stay missing');
const user6 = { uid:'u6', id:6, weeklySchedule:{
  1:[
    { garden:'גן ו', start:'08:00', end:'09:00' },
    { garden:'גן ו', start:'09:00', end:'10:00' },
  ],
}};
_records = [
  { id:'legacy1', instructorUid:'u6', date:'2026-09-07', garden:'גן ו' /* no slotKey */ },
];
const r6 = _slrExecutionPercent(user6, '2026-09');
eq('planned = 8 (2 slots × 4 Mondays)', r6.planned, 8);
eq('executed = 1', r6.executed, 1);
eq('matched = 1 (legacy record consumes exactly one slot)', r6.matched, 1);
eq('missing = 7', r6.missing.length, 7);

/* ---- summary ---- */
console.log('\n=====================');
console.log(`${_passed} passed, ${_failed} failed`);
console.log('=====================');
process.exit(_failed === 0 ? 0 : 1);
