// One-shot scanner: how many records from 2026-09-06 onward already have slotKey,
// how many can be auto-backfilled, how many are ambiguous. Does NOT mutate.
const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const CUTOFF = '2026-09-06';

function _slotKey(s, e) { return (s || '') + '-' + (e || ''); }

(async () => {
  const [recSnap, userSnap] = await Promise.all([
    db.collection('records').where('date', '>=', CUTOFF).get(),
    db.collection('users').get(),
  ]);
  const users = [];
  userSnap.forEach(d => { const x = d.data(); users.push({ ...x, id: x.id || d.id, uid: d.id }); });
  // legacy users in meta/users
  try {
    const metaU = await db.collection('meta').doc('users').get();
    if (metaU.exists) (metaU.data().items || []).forEach(u => users.push(u));
  } catch (_) {}

  const byUid = new Map();
  const byId = new Map();
  users.forEach(u => {
    if (u.uid) byUid.set(String(u.uid), u);
    if (u.id != null) byId.set(String(u.id), u);
  });

  let hasSlot = 0;
  let migrated = 0;
  let notExec = 0;
  let auto = 0;
  let ambiguous = 0;
  let unknownGarden = 0;
  let noInstructor = 0;
  const ambigSamples = [];

  recSnap.forEach(d => {
    const r = d.data();
    if (r.date < CUTOFF) return;
    if (r.slotKey) { hasSlot++; return; }
    if (r._slotMigrationDone) { migrated++; return; }
    if (r.status === 'not_executed') { notExec++; return; }

    // Substitute records: look at the ORIGINAL instructor's schedule for the garden.
    const lookupU = (r._isSubstitute && r.substituteForUid)
      ? (byUid.get(String(r.substituteForUid)) || byId.get(String(r.substituteForUid)))
      : ((r.instructorUid && byUid.get(String(r.instructorUid))) ||
         (r.instructorId != null && byId.get(String(r.instructorId))));
    if (!lookupU) { noInstructor++; return; }

    const dow = new Date(r.date + 'T00:00:00').getDay();
    const ws = (lookupU.weeklySchedule && lookupU.weeklySchedule[dow]) || [];
    const gLower = String(r.garden || '').toLowerCase();
    const matches = ws.filter(e => e && String(e.garden || '').toLowerCase() === gLower);

    if (matches.length === 0) { unknownGarden++; return; }
    // Distinct slotKeys among matches. If all matches produce the SAME slotKey
    // (a duplicated weekly-schedule entry), that isn't real ambiguity.
    const distinctKeys = new Set(matches.map(m => _slotKey(m.start, m.end)));
    if (distinctKeys.size === 1) { auto++; return; }
    // Multi-key: try timeIn as tie-breaker.
    if (r.timeIn) {
      const exactKeys = new Set(matches.filter(m => m.start === r.timeIn).map(m => _slotKey(m.start, m.end)));
      if (exactKeys.size === 1) { auto++; return; }
    }
    ambiguous++;
    if (ambigSamples.length < 5) {
      ambigSamples.push({
        id: d.id, date: r.date, garden: r.garden, timeIn: r.timeIn,
        instructor: lookupU.name, slots: matches.map(m => `${m.start}-${m.end}`),
      });
    }
  });

  console.log('=== Slot migration scan (records >= ' + CUTOFF + ') ===');
  console.log('Total records in range          :', recSnap.size);
  console.log('  already have slotKey          :', hasSlot);
  console.log('  already migrated (_done flag) :', migrated);
  console.log('  not_executed (skipped)        :', notExec);
  console.log('  no instructor found (skipped) :', noInstructor);
  console.log('  auto-backfillable             :', auto);
  console.log('  ambiguous (need admin review) :', ambiguous);
  console.log('  unknown garden (leave alone)  :', unknownGarden);
  if (ambigSamples.length) {
    console.log('\nAmbiguous samples:');
    ambigSamples.forEach(s => console.log(' -', JSON.stringify(s)));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
