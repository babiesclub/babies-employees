// v38.4 read-only scan: how many (instructor, date, garden) days from 2026-09-06
// onward have missing slots (sCount > rCount, sCount >= 2). Does NOT mutate.
const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const CUTOFF = '2026-09-06';
const BIWEEKLY_ANCHOR = new Date('2026-09-13T00:00:00');

function _weekParityFor(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const day = d.getDay(); d.setDate(d.getDate() - day);
  const diffMs = d - BIWEEKLY_ANCHOR;
  const idx = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
  return ((idx % 2) + 2) % 2;
}
function _entryMatchesWeek(e, parity) {
  if (!e || !e.biweekly) return true;
  const p = (typeof e.weekParity === 'number') ? e.weekParity : 0;
  return p === parity;
}
function _readEntry(e) {
  if (!e) return e;
  if (e.biweekly !== undefined) return e;
  const noteRaw = e.note || '';
  const biRe = /^\s*\[דו[-\s]שבועי\]\s*/;
  if (biRe.test(noteRaw)) return Object.assign({}, e, { biweekly: true, weekParity: 0, note: noteRaw.replace(biRe, '').trim() });
  return e;
}
function _slotKey(s, e) { return (s || '') + '-' + (e || ''); }
function _dow(dateStr) { try { return new Date(dateStr + 'T00:00:00').getDay(); } catch (e) { return -1; } }

function _lookupUser(r, byUid, byId) {
  const targetKey = r._isSubstitute && r.substituteForUid ? String(r.substituteForUid) : null;
  if (targetKey) return byUid.get(targetKey) || byId.get(targetKey) || null;
  return (r.instructorUid && byUid.get(String(r.instructorUid))) || (r.instructorId != null && byId.get(String(r.instructorId))) || null;
}

function _expectedSlots(u, dateStr, garden) {
  if (!u || !dateStr || !garden) return { keys: [], byKey: new Map() };
  const dow = _dow(dateStr);
  if (dow < 0) return { keys: [], byKey: new Map() };
  const parity = _weekParityFor(new Date(dateStr + 'T00:00:00'));
  const raw = (u.weeklySchedule && u.weeklySchedule[dow]) || [];
  const gLower = String(garden || '').toLowerCase();
  const entries = raw.map(_readEntry).filter(e => e && String(e.garden || '').toLowerCase() === gLower && _entryMatchesWeek(e, parity));
  const keys = [...new Set(entries.map(e => _slotKey(e.start, e.end)))].sort();
  const byKey = new Map();
  entries.forEach(e => { const k = _slotKey(e.start, e.end); if (!byKey.has(k)) byKey.set(k, e); });
  return { keys, byKey };
}

function _groupKey(r) {
  const uid = r._isSubstitute && r.substituteForUid ? String(r.substituteForUid)
    : (String(r.instructorUid || '') || ('id:' + String(r.instructorId || '')));
  return uid + '|' + String(r.date || '') + '|' + String(r.garden || '');
}

(async () => {
  const [recSnap, userSnap] = await Promise.all([
    db.collection('records').where('date', '>=', CUTOFF).get(),
    db.collection('users').get(),
  ]);
  const users = [];
  userSnap.forEach(d => { const x = d.data(); users.push({ ...x, id: x.id || d.id, uid: d.id }); });
  try {
    const metaU = await db.collection('meta').doc('users').get();
    if (metaU.exists) (metaU.data().items || []).forEach(u => users.push(u));
  } catch (_) {}
  const byUid = new Map(); const byId = new Map();
  users.forEach(u => { if (u.uid) byUid.set(String(u.uid), u); if (u.id != null) byId.set(String(u.id), u); });

  const records = [];
  recSnap.forEach(d => records.push({ ...d.data(), _docId: d.id }));

  const groups = new Map();
  let skippedOld = 0, skippedNotExec = 0, skippedAudited = 0;
  records.forEach(r => {
    if (!r || !r.date || !r.garden) return;
    if (r.date < CUTOFF) { skippedOld++; return; }
    if (r.status === 'not_executed') { skippedNotExec++; return; }
    if (r._slotAuditDone) { skippedAudited++; return; }
    const k = _groupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });

  const flagged = [];
  let skippedNoInstructor = 0, groupsAllReported = 0, singleSlotGroups = 0;
  groups.forEach((recs, gk) => {
    if (recs.some(r => r._slotAuditDone)) return;
    const first = recs[0];
    const u = _lookupUser(first, byUid, byId);
    if (!u) { skippedNoInstructor++; return; }
    const { keys, byKey } = _expectedSlots(u, first.date, first.garden);
    const sCount = keys.length;
    const rCount = recs.length;
    if (sCount < 2) { singleSlotGroups++; return; }
    if (sCount <= rCount) { groupsAllReported++; return; }
    flagged.push({
      groupKey: gk, date: first.date, garden: first.garden,
      instructor: u.name || u.username || '?',
      sCount, rCount, missing: sCount - rCount,
      expectedKeys: keys,
      reportedKeys: recs.map(r => r.slotKey || '(no-slotKey)'),
    });
  });
  flagged.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  console.log('=== v38.4 multi-slot audit scan (records >= ' + CUTOFF + ') ===');
  console.log('Total records in range   :', records.length);
  console.log('  skipped (before cutoff):', skippedOld);
  console.log('  skipped (not_executed) :', skippedNotExec);
  console.log('  skipped (already audit):', skippedAudited);
  console.log('Groups formed            :', groups.size);
  console.log('  no instructor found    :', skippedNoInstructor);
  console.log('  1-slot day (no split)  :', singleSlotGroups);
  console.log('  all slots reported     :', groupsAllReported);
  console.log('  FLAGGED (missing slots):', flagged.length);
  console.log('  total missing sessions :', flagged.reduce((s, f) => s + f.missing, 0));
  if (flagged.length) {
    console.log('\nFlagged groups (newest first):');
    flagged.forEach(f => {
      console.log(` - ${f.date} · ${f.instructor} · ${f.garden} · ${f.rCount} of ${f.sCount} (missing ${f.missing})`);
      console.log(`     expected: ${f.expectedKeys.join(', ')}`);
      console.log(`     reported: ${f.reportedKeys.join(', ')}`);
    });
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
