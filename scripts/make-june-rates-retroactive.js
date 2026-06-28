// Make all charge + pay rates retroactive to 2026-06-01.
// For each rate-history entry that's effective AFTER 2026-06-01, push the EARLIEST
// entry's `from` back to 2026-06-01. This ensures that any record in June 2026
// (even those reported before the rate was actually entered into the system)
// will pick up a valid rate.
//
// Touches:
//   - meta/gardens.items[].chargeRatesHistory[0].from
//   - meta/gardens.items[].instructorPayHistory[0].from
//   - users/{uid}.gardenPayHistory[gardenName][0].from
//
// Usage:
//   node make-june-rates-retroactive.js          (dry run - shows what would change)
//   node make-june-rates-retroactive.js --apply  (actually writes)

const admin = require('firebase-admin');
const sa = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const TARGET_FROM = '2026-06-01';
const APPLY = process.argv.includes('--apply');

function earliestEntryIdx(history) {
  if (!Array.isArray(history) || !history.length) return -1;
  let idx = 0;
  for (let i = 1; i < history.length; i++) {
    if ((history[i].from || '') < (history[idx].from || '')) idx = i;
  }
  return idx;
}

(async () => {
  console.log(APPLY ? '🔥 APPLY mode - writing to Firestore' : '👁 DRY RUN - no writes');
  console.log('Target earliest "from" date:', TARGET_FROM);
  console.log('');

  // 1. GARDENS
  const gardensDoc = await db.collection('meta').doc('gardens').get();
  const items = gardensDoc.exists ? (gardensDoc.data().items || []) : [];
  let gardenChanges = 0, payChanges = 0;
  const updatedGardens = items.map(g => {
    if (typeof g !== 'object') return g;
    let changed = false;
    const out = { ...g };

    // Charge rates history
    if (Array.isArray(g.chargeRatesHistory) && g.chargeRatesHistory.length > 0) {
      const idx = earliestEntryIdx(g.chargeRatesHistory);
      if (idx >= 0 && g.chargeRatesHistory[idx].from > TARGET_FROM) {
        const newHist = g.chargeRatesHistory.map((h, i) =>
          i === idx ? { ...h, from: TARGET_FROM } : h
        );
        out.chargeRatesHistory = newHist;
        changed = true;
        console.log(`  🌿 ${g.name}: chargeRatesHistory[${idx}].from = ${g.chargeRatesHistory[idx].from} → ${TARGET_FROM}`);
        gardenChanges++;
      }
    }

    // Instructor pay history (garden-level fallback for instructor pay)
    if (Array.isArray(g.instructorPayHistory) && g.instructorPayHistory.length > 0) {
      const idx = earliestEntryIdx(g.instructorPayHistory);
      if (idx >= 0 && g.instructorPayHistory[idx].from > TARGET_FROM) {
        const newHist = g.instructorPayHistory.map((h, i) =>
          i === idx ? { ...h, from: TARGET_FROM } : h
        );
        out.instructorPayHistory = newHist;
        changed = true;
        console.log(`  🌿 ${g.name}: instructorPayHistory[${idx}].from = ${g.instructorPayHistory[idx].from} → ${TARGET_FROM}`);
        payChanges++;
      }
    }

    return changed ? out : g;
  });

  console.log(`\n✓ Gardens to update: ${gardenChanges} chargeRates + ${payChanges} instructorPay entries\n`);

  // 2. USERS
  const usersSnap = await db.collection('users').get();
  let userUpdates = 0;
  const userBatch = [];
  usersSnap.forEach(d => {
    const u = d.data();
    if (!u.gardenPayHistory || typeof u.gardenPayHistory !== 'object') return;
    let changed = false;
    const newGPH = { ...u.gardenPayHistory };
    for (const gardenName of Object.keys(newGPH)) {
      const history = newGPH[gardenName];
      if (!Array.isArray(history) || !history.length) continue;
      const idx = earliestEntryIdx(history);
      if (idx >= 0 && history[idx].from > TARGET_FROM) {
        newGPH[gardenName] = history.map((h, i) =>
          i === idx ? { ...h, from: TARGET_FROM } : h
        );
        changed = true;
        console.log(`  👤 ${u.name || d.id} → ${gardenName}: gardenPayHistory[${idx}].from = ${history[idx].from} → ${TARGET_FROM}`);
        userUpdates++;
      }
    }
    if (changed) userBatch.push({ ref: d.ref, data: { gardenPayHistory: newGPH } });
  });

  console.log(`\n✓ User pay-history entries to update: ${userUpdates}\n`);

  // Write
  if (APPLY) {
    if (gardenChanges > 0 || payChanges > 0) {
      await db.collection('meta').doc('gardens').set({ items: updatedGardens }, { merge: true });
      console.log('✓ Gardens updated in Firestore');
    }
    for (const { ref, data } of userBatch) {
      await ref.set(data, { merge: true });
    }
    if (userBatch.length) console.log(`✓ ${userBatch.length} user docs updated`);
    console.log('\n✅ DONE');
  } else {
    console.log('🚀 Run again with --apply to actually write the changes.');
  }

  process.exit(0);
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
