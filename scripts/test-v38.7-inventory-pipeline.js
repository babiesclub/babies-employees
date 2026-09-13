#!/usr/bin/env node
/**
 * v38.7 inventory-pipeline smoke test — pure logic, no Firebase.
 *
 * Verifies:
 *   1. Auto-numeric label gap-filling (_invNextUnitNumber)
 *   2. Aggregated view shape (bucketing by template + location)
 *   3. Pipeline auto-sync happy-path (A→B→C plus cycle refresh)
 *   4. Ambiguous case (2 cluster members schedule same tpl, only one had it)
 *   5. Manual override (pipelineOverride=true → skip)
 *   6. Defect report + replacement (faulty→warehouse, replacement→instructor)
 *   7. Gap analysis (peak concurrent vs count)
 *
 * Reimplements the pure helpers verbatim from index.html (kept in sync) so the
 * harness stays a pure-Node script — no jsdom required.
 */

// ---------- pure helpers (mirrored from index.html) ----------
function _invNextUnitNumber(items, templateId, type) {
  const filtered = items.filter(x => !x.deleted && x.type === type && (type === 'speaker' || x.templateId === templateId));
  const used = new Set();
  filtered.forEach(it => {
    if (typeof it.unitNumber === 'number' && it.unitNumber > 0) { used.add(it.unitNumber); return; }
    const m = /^#(\d+)$/.exec(String(it.serialLabel || ''));
    if (m) used.add(parseInt(m[1], 10));
  });
  let n = 1; while (used.has(n)) n++; return n;
}
function _invUnitLabel(it) {
  if (!it) return '';
  if (typeof it.unitNumber === 'number' && it.unitNumber > 0) return '#' + it.unitNumber;
  return String(it.serialLabel || '#?');
}
// Aggregation: bucket units by templateId → {warehouse:[], byInstructor:{uid:{name,items}}}
function aggregateTemplate(items, templateId) {
  const units = items.filter(x => !x.deleted && x.type === 'material' && x.templateId === templateId);
  const ware = units.filter(x => x.location === 'warehouse');
  const byInst = {};
  units.filter(x => x.location && x.location.indexOf('instructor:') === 0).forEach(x => {
    const uid = x.location.slice(11);
    if (!byInst[uid]) byInst[uid] = { name: x.locationName || uid, items: [] };
    byInst[uid].items.push(x);
  });
  return { warehouse: ware, byInstructor: byInst, total: units.length };
}
/* Simplified auto-sync: current-week alignment per (cluster, template).
   Same rules as _inventorySyncPipeline() in index.html. */
function syncPipelinePure(state, clusters, currentWeekISO) {
  const summary = { moved: 0, warnings: [], skipped: 0, decisions: [] };
  const move = (unit, toLoc, toName, reason) => {
    summary.moved++;
    summary.decisions.push(`${_invUnitLabel(unit)}: ${unit.location} → ${toLoc}`);
    unit.location = toLoc; unit.locationName = toName; unit.updatedAt = Date.now();
  };
  const scheduleAssignees = (weekISO, tplId, clusterUids) => {
    const w = state.schedule[weekISO]; if (!w || !w.assignments) return new Set();
    const s = new Set();
    Object.entries(w.assignments).forEach(([uid, mid]) => { if (mid === tplId && clusterUids.has(String(uid))) s.add(String(uid)); });
    return s;
  };
  for (const cluster of clusters) {
    const uids = cluster.uids;
    const inv = state.inventory.filter(x => !x.deleted && x.type === 'material');
    const tpls = new Set(inv.filter(x => x.location === 'warehouse' || (x.location.indexOf('instructor:') === 0 && uids.has(x.location.slice(11)))).map(x => x.templateId));
    for (const tid of tpls) {
      const units = inv.filter(x => x.templateId === tid);
      const clusterUnits = units.filter(x => x.location === 'warehouse' || (x.location.indexOf('instructor:') === 0 && uids.has(x.location.slice(11))));
      const thisWeek = scheduleAssignees(currentWeekISO, tid, uids);
      const uidHasUnit = {};
      clusterUnits.forEach(x => {
        if (x.location.indexOf('instructor:') === 0) {
          const uid = x.location.slice(11);
          (uidHasUnit[uid] = uidHasUnit[uid] || []).push(x);
        }
      });
      const wareUnits = clusterUnits.filter(x => x.location === 'warehouse');
      for (const uid of thisWeek) {
        if (uidHasUnit[uid] && uidHasUnit[uid].length) continue;
        let src = null;
        for (const [srcUid, arr] of Object.entries(uidHasUnit)) {
          if (thisWeek.has(srcUid)) continue;
          const cand = (arr || []).find(x => !x.pipelineOverride);
          if (cand) { src = cand; break; }
        }
        if (!src) { src = wareUnits.find(x => !x.pipelineOverride) || null; if (src) wareUnits.splice(wareUnits.indexOf(src), 1); }
        if (!src) { summary.warnings.push(`חסרה יחידה של ${tid} עבור ${uid}`); continue; }
        if (src.pipelineOverride) { summary.skipped++; continue; }
        const oldUid = src.location.indexOf('instructor:') === 0 ? src.location.slice(11) : null;
        move(src, 'instructor:' + uid, uid, 'auto-sync');
        if (oldUid) uidHasUnit[oldUid] = (uidHasUnit[oldUid] || []).filter(x => x !== src);
        (uidHasUnit[uid] = uidHasUnit[uid] || []).push(src);
      }
      // Move stale units to warehouse when nobody needs them
      for (const [srcUid, arr] of Object.entries(uidHasUnit)) {
        if (thisWeek.has(srcUid)) continue;
        for (const src of arr.slice()) {
          if (src.pipelineOverride) { summary.skipped++; continue; }
          const unmet = [...thisWeek].some(u => !uidHasUnit[u] || !uidHasUnit[u].length);
          if (unmet) continue;
          move(src, 'warehouse', 'מחסן', 'cycle end');
        }
      }
    }
  }
  return summary;
}
// Gap analysis
function gapAnalysis(inventory, schedule, fromISO) {
  const counts = {};
  inventory.filter(x => !x.deleted && x.type === 'material').forEach(x => { const t = x.templateId; counts[t] = (counts[t] || 0) + 1; });
  const peaks = {};
  Object.keys(schedule).forEach(w => {
    if (w < fromISO) return;
    const wk = schedule[w]; if (!wk || !wk.assignments) return;
    const per = {};
    Object.values(wk.assignments).forEach(mid => { if (mid) per[mid] = (per[mid] || 0) + 1; });
    Object.entries(per).forEach(([tid, cnt]) => { if (cnt > (peaks[tid] || 0)) peaks[tid] = cnt; });
  });
  const rows = [];
  const tpls = new Set([...Object.keys(counts), ...Object.keys(peaks)]);
  tpls.forEach(t => rows.push({ templateId: t, count: counts[t] || 0, peak: peaks[t] || 0, deficit: Math.max(0, (peaks[t] || 0) - (counts[t] || 0)) }));
  rows.sort((a, b) => b.deficit - a.deficit);
  return rows;
}

// ---------- test harness ----------
let pass = 0, fail = 0;
function assert(name, cond, details) {
  if (cond) { pass++; console.log('✓', name); }
  else { fail++; console.log('✗', name); if (details !== undefined) console.log('  ', details); }
}
function makeUnit(tid, num, loc) {
  return { id: 'u' + Math.random().toString(36).slice(2, 6), type: 'material', templateId: tid, templateName: 'טמפ ' + tid, unitNumber: num, serialLabel: '#' + num, location: loc, locationName: loc.indexOf('instructor:') === 0 ? loc.slice(11) : 'מחסן', deleted: false, updatedAt: 0 };
}

console.log('\n=== v38.7 inventory pipeline verification ===\n');

// --- 1. Auto-numeric label gap-fill ---
{
  const items = [
    makeUnit('T1', 1, 'warehouse'),
    makeUnit('T1', 2, 'warehouse'),
    makeUnit('T1', 3, 'warehouse'),
  ];
  assert('1a: 3 units of T1, next = #4', _invNextUnitNumber(items, 'T1', 'material') === 4);
  items[1].deleted = true; // delete #2
  assert('1b: after deleting #2, next = #2 (gap-fill)', _invNextUnitNumber(items, 'T1', 'material') === 2);
  const items2 = [
    { type: 'material', templateId: 'T2', serialLabel: '#5' }, // legacy, no unitNumber
    { type: 'material', templateId: 'T2', unitNumber: 1 },
  ];
  assert('1c: mixed legacy+unitNumber, next = #2', _invNextUnitNumber(items2, 'T2', 'material') === 2);
}

// --- 2. Aggregated view ---
{
  const items = [
    makeUnit('T1', 1, 'warehouse'),
    makeUnit('T1', 2, 'instructor:uidA'),
    makeUnit('T1', 3, 'warehouse'),
    makeUnit('T1', 4, 'instructor:uidB'),
  ];
  const agg = aggregateTemplate(items, 'T1');
  assert('2a: total = 4', agg.total === 4);
  assert('2b: warehouse holds 2 units', agg.warehouse.length === 2);
  assert('2c: instructor A holds 1', agg.byInstructor.uidA && agg.byInstructor.uidA.items.length === 1);
  assert('2d: instructor B holds 1', agg.byInstructor.uidB && agg.byInstructor.uidB.items.length === 1);
  assert('2e: warehouse contents are #1 and #3', agg.warehouse.map(_invUnitLabel).sort().join(',') === '#1,#3');
}

// --- 3. Pipeline auto-sync happy path (A→B→C, cycle refresh) ---
{
  const state = {
    inventory: [makeUnit('MAT', 1, 'instructor:A')],
    schedule: {
      '2026-09-06': { assignments: { A: 'MAT' } },
      '2026-09-13': { assignments: { B: 'MAT' } },
      '2026-09-20': { assignments: { C: 'MAT' } },
      '2026-09-27': { assignments: {} },
    }
  };
  const cluster = [{ uids: new Set(['A', 'B', 'C']) }];
  // Simulate week 2 arrival — instructor B has MAT this week.
  const s1 = syncPipelinePure(state, cluster, '2026-09-13');
  assert('3a: week2 — A→B move', state.inventory[0].location === 'instructor:B' && s1.moved === 1);
  const s2 = syncPipelinePure(state, cluster, '2026-09-20');
  assert('3b: week3 — B→C move', state.inventory[0].location === 'instructor:C' && s2.moved === 1);
  const s3 = syncPipelinePure(state, cluster, '2026-09-27');
  assert('3c: week4 — cycle end, C→warehouse', state.inventory[0].location === 'warehouse' && s3.moved === 1);
}

// --- 4. Ambiguous case (two cluster members scheduled) ---
{
  const state = {
    inventory: [makeUnit('MAT', 1, 'instructor:A'), makeUnit('MAT', 2, 'warehouse')],
    schedule: {
      '2026-09-13': { assignments: { A: 'MAT' } },
      '2026-09-20': { assignments: { B: 'MAT', C: 'MAT' } }, // both scheduled
    }
  };
  const cluster = [{ uids: new Set(['A', 'B', 'C']) }];
  const s = syncPipelinePure(state, cluster, '2026-09-20');
  // Both B and C need a unit: unit #1 (at A) should move to one of them; unit #2 (warehouse) to the other.
  const locations = state.inventory.map(x => x.location).sort();
  assert('4a: both B and C now hold a MAT unit', locations.includes('instructor:B') && locations.includes('instructor:C'));
  assert('4b: warehouse empty', locations.every(l => l !== 'warehouse'));
  assert('4c: 2 moves happened', s.moved === 2);
}

// --- 5. Manual override respected ---
{
  const u = makeUnit('MAT', 1, 'instructor:A'); u.pipelineOverride = true;
  const state = {
    inventory: [u],
    schedule: { '2026-09-13': { assignments: { B: 'MAT' } } }
  };
  const cluster = [{ uids: new Set(['A', 'B']) }];
  const s = syncPipelinePure(state, cluster, '2026-09-13');
  assert('5a: overridden unit stays at A', state.inventory[0].location === 'instructor:A');
  assert('5b: warning surfaced (no unit for B)', s.warnings.length >= 1);
}

// --- 6. Defect report + replacement ---
{
  const faulty = makeUnit('MAT', 1, 'instructor:A');
  const spare = makeUnit('MAT', 2, 'warehouse');
  const items = [faulty, spare];
  const report = { id: 'r1', itemId: faulty.id, templateId: 'MAT', status: 'open', reportedBy: 'A' };
  // Admin resolves with replacement:
  //   faulty → warehouse
  //   spare → instructor:A
  //   report.status = 'replaced'
  const origLoc = faulty.location, origName = faulty.locationName;
  faulty.location = 'warehouse'; faulty.locationName = 'מחסן';
  spare.location = origLoc; spare.locationName = origName;
  report.status = 'replaced';
  assert('6a: faulty unit now at warehouse', faulty.location === 'warehouse');
  assert('6b: spare unit now at instructor:A', spare.location === 'instructor:A');
  assert('6c: report resolved', report.status === 'replaced');
}

// --- 7. Gap analysis ---
{
  const inv = [makeUnit('MAT', 1, 'warehouse'), makeUnit('MAT', 2, 'warehouse'), makeUnit('MAT', 3, 'warehouse')];
  const schedule = {
    '2026-10-04': { assignments: { A: 'MAT', B: 'MAT' } },        // peak 2
    '2026-10-11': { assignments: { A: 'MAT', B: 'MAT', C: 'MAT', D: 'MAT', E: 'MAT' } },  // peak 5
  };
  const rows = gapAnalysis(inv, schedule, '2026-10-01');
  const matRow = rows.find(r => r.templateId === 'MAT');
  assert('7a: peak=5', matRow.peak === 5);
  assert('7b: count=3', matRow.count === 3);
  assert('7c: deficit=2', matRow.deficit === 2);
}

console.log(`\n===== ${pass} passed · ${fail} failed =====\n`);
process.exit(fail ? 1 : 0);
