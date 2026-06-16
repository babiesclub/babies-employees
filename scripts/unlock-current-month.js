// Adds the current month (YYYY-MM in Israel time) to every instructor's
// `unlockedMonths` array. This lets them retroactively report visits from
// the start of the month, bypassing the Friday-16:00 week lock for dates
// in that month.
//
// To revert later (after the grace period), run with --remove.
//
// Usage:
//   node unlock-current-month.js               → preview
//   node unlock-current-month.js --apply       → actually update
//   node unlock-current-month.js --apply --remove  → remove the unlock
//   node unlock-current-month.js --apply --month 2026-06  → specific month

const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const APPLY = process.argv.includes('--apply');
const REMOVE = process.argv.includes('--remove');
const monthIdx = process.argv.indexOf('--month');
let MONTH;
if (monthIdx >= 0) {
  MONTH = process.argv[monthIdx + 1];
} else {
  const nowIsrael = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  MONTH = `${nowIsrael.getFullYear()}-${String(nowIsrael.getMonth() + 1).padStart(2, '0')}`;
}

(async () => {
  const snap = await db.collection('users').where('role', '==', 'instructor').get();
  const docs = [];
  snap.forEach(d => docs.push({ docId: d.id, ...d.data() }));
  docs.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));

  console.log(`\n📅 חודש: ${MONTH}`);
  console.log(`🎯 פעולה: ${REMOVE ? 'הסרת unlock' : 'הוספת unlock'}\n`);
  console.log(`📋 ${docs.length} מדריכות:\n`);

  let toChange = 0, alreadyOk = 0;
  for (const u of docs) {
    const cur = Array.isArray(u.unlockedMonths) ? u.unlockedMonths : [];
    const has = cur.includes(MONTH);
    let action = '';
    if (REMOVE) {
      if (has) { action = `🔄 יוסר`; toChange++; }
      else { action = '✓ לא קיים (אין מה להסיר)'; alreadyOk++; }
    } else {
      if (has) { action = '✓ כבר פתוח'; alreadyOk++; }
      else { action = `🔄 ייפתח`; toChange++; }
    }
    console.log(`  ${(u.name || '?').padEnd(22)} ${action}`);
  }

  console.log(`\n📊 ${toChange} ישתנו · ${alreadyOk} כבר במצב הנכון\n`);

  if (!APPLY) {
    console.log(`💡 זה היה מצב תצוגה. להפעיל בפועל: node unlock-current-month.js --apply${REMOVE ? ' --remove' : ''}`);
    process.exit(0);
  }

  let ok = 0, failed = 0;
  for (const u of docs) {
    const cur = Array.isArray(u.unlockedMonths) ? u.unlockedMonths : [];
    let next;
    if (REMOVE) {
      if (!cur.includes(MONTH)) continue;
      next = cur.filter(m => m !== MONTH);
    } else {
      if (cur.includes(MONTH)) continue;
      next = [...cur, MONTH];
    }
    try {
      await db.collection('users').doc(u.docId).update({ unlockedMonths: next });
      ok++;
      process.stdout.write('.');
    } catch (e) {
      failed++;
      console.error(`\n  ✗ ${u.name}: ${e.message}`);
    }
  }
  console.log(`\n\n✅ ${ok} עודכנו, ${failed} נכשלו.`);
  console.log(`\n💡 לבטל: node unlock-current-month.js --apply --remove --month ${MONTH}`);
  process.exit(0);
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
