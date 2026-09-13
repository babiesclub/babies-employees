// Standalone verification harness for v38.6 inventory management.
// Exercises the same collections + shape the client writes, then cleans up.
// Usage: node scripts/test-v38.6-inventory.js
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const TAG = 'v38.6-test-' + Date.now();
const createdItems = [];
const createdMovements = [];

const nowMs = () => Date.now();
const uid = () => 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function createItem(fields) {
  const id = uid();
  const now = nowMs();
  const doc = {
    id,
    type: fields.type,
    templateId: fields.templateId || null,
    templateName: fields.templateName || '',
    serialLabel: fields.serialLabel || '',
    location: fields.location || 'warehouse',
    locationName: fields.locationName || 'מחסן',
    notes: fields.notes || '',
    deleted: false,
    createdAt: now,
    createdBy: 'harness',
    createdByName: TAG,
    updatedAt: now,
    updatedBy: 'harness',
    _harness: TAG,
  };
  await db.collection('inventoryItems').doc(id).set(doc);
  createdItems.push(id);
  const mvRef = await db.collection('inventoryMovements').add({
    itemId: id,
    from: { location: '', locationName: '' },
    to: { location: doc.location, locationName: doc.locationName },
    movedBy: 'harness',
    movedByName: TAG,
    movedAt: now,
    reason: 'יצירה',
    action: 'create',
    _harness: TAG,
  });
  createdMovements.push(mvRef.id);
  return doc;
}

async function moveItem(itemId, to, reason) {
  const now = nowMs();
  const snap = await db.collection('inventoryItems').doc(itemId).get();
  const before = snap.data();
  await db.collection('inventoryItems').doc(itemId).update({
    location: to.location,
    locationName: to.locationName,
    updatedAt: now,
    updatedBy: 'harness',
  });
  const mvRef = await db.collection('inventoryMovements').add({
    itemId,
    from: { location: before.location, locationName: before.locationName },
    to,
    movedBy: 'harness',
    movedByName: TAG,
    movedAt: now,
    reason: reason || '',
    action: 'transfer',
    _harness: TAG,
  });
  createdMovements.push(mvRef.id);
}

async function softDeleteItem(itemId) {
  const now = nowMs();
  const snap = await db.collection('inventoryItems').doc(itemId).get();
  const before = snap.data();
  await db.collection('inventoryItems').doc(itemId).update({
    deleted: true,
    deletedAt: now,
    deletedBy: 'harness',
    deletedByName: TAG,
    updatedAt: now,
  });
  const mvRef = await db.collection('inventoryMovements').add({
    itemId,
    from: { location: before.location || '', locationName: before.locationName || '' },
    to: { location: 'deleted', locationName: 'מחוק' },
    movedBy: 'harness',
    movedByName: TAG,
    movedAt: now,
    reason: 'מחיקה',
    action: 'delete',
    _harness: TAG,
  });
  createdMovements.push(mvRef.id);
}

async function countByLocation(items, location) {
  return items.filter(x => !x.deleted && x.location === location).length;
}

function pass(name, cond, extra) {
  const mark = cond ? '✅ PASS' : '❌ FAIL';
  console.log(`${mark} — ${name}${extra ? ' — ' + extra : ''}`);
  return !!cond;
}

async function loadHarnessItems() {
  const snap = await db.collection('inventoryItems').where('_harness', '==', TAG).get();
  const arr = [];
  snap.forEach(d => arr.push({ ...d.data(), _docId: d.id }));
  return arr;
}

async function main() {
  const results = [];
  console.log(`\n🧪 v38.6 inventory harness (tag=${TAG})\n`);

  // --------- 1. Create a material unit at warehouse
  const shrekan1 = await createItem({
    type: 'material',
    templateId: 'tpl_shrekan',
    templateName: 'שרקן',
    serialLabel: '#1',
    location: 'warehouse',
    locationName: 'מחסן',
  });
  await wait(150);
  let items = await loadHarnessItems();
  results.push(pass('T1: create material at warehouse → warehouse count == 1',
    (await countByLocation(items, 'warehouse')) === 1,
    `warehouse=${await countByLocation(items, 'warehouse')}`));

  // --------- 2. Transfer to instructor
  const instrUid = 'test-uid-tali';
  const instrName = 'טלי (הרנס)';
  await moveItem(shrekan1.id, { location: 'instructor:' + instrUid, locationName: instrName }, 'שיבוץ מבחן');
  await wait(150);
  items = await loadHarnessItems();
  const wAfter = await countByLocation(items, 'warehouse');
  const iAfter = items.filter(x => !x.deleted && x.location === 'instructor:' + instrUid).length;
  results.push(pass('T2a: warehouse count drops to 0', wAfter === 0, `warehouse=${wAfter}`));
  results.push(pass('T2b: instructor:' + instrUid + ' count rises to 1', iAfter === 1, `count=${iAfter}`));
  const mvSnap = await db.collection('inventoryMovements')
    .where('_harness', '==', TAG)
    .where('itemId', '==', shrekan1.id).get();
  const mvArr = []; mvSnap.forEach(d => mvArr.push(d.data()));
  const hasTransfer = mvArr.some(m => m.action === 'transfer' && m.to && m.to.location === 'instructor:' + instrUid);
  results.push(pass('T2c: movement record written for transfer', hasTransfer, `mv-count=${mvArr.length}`));

  // --------- 3. Multiple copies of same template → aggregation
  const shrekan2 = await createItem({
    type: 'material', templateId: 'tpl_shrekan', templateName: 'שרקן',
    serialLabel: '#2', location: 'warehouse', locationName: 'מחסן',
  });
  const shrekan3 = await createItem({
    type: 'material', templateId: 'tpl_shrekan', templateName: 'שרקן',
    serialLabel: '#3', location: 'warehouse', locationName: 'מחסן',
  });
  await wait(150);
  items = await loadHarnessItems();
  const totalShrekan = items.filter(x => !x.deleted && x.templateId === 'tpl_shrekan').length;
  const shrekanWare = items.filter(x => !x.deleted && x.templateId === 'tpl_shrekan' && x.location === 'warehouse').length;
  const shrekanInstr = items.filter(x => !x.deleted && x.templateId === 'tpl_shrekan' && x.location && x.location.indexOf('instructor:') === 0).length;
  results.push(pass('T3a: 3 יחידות שרקן (aggregation)', totalShrekan === 3, `total=${totalShrekan}`));
  results.push(pass('T3b: 2 במחסן', shrekanWare === 2, `warehouse=${shrekanWare}`));
  results.push(pass('T3c: 1 אצל מדריכה', shrekanInstr === 1, `instructor=${shrekanInstr}`));

  // --------- 4. Speaker: create in warehouse then assign to instructor
  const sp1 = await createItem({
    type: 'speaker', templateId: null, templateName: 'רמקול',
    serialLabel: '#1', location: 'warehouse', locationName: 'מחסן',
  });
  await wait(150);
  items = await loadHarnessItems();
  let spWare = items.filter(x => !x.deleted && x.type === 'speaker' && x.location === 'warehouse').length;
  let spInstr = items.filter(x => !x.deleted && x.type === 'speaker' && x.location && x.location.indexOf('instructor:') === 0).length;
  results.push(pass('T4a: speaker in warehouse (before assign)', spWare === 1 && spInstr === 0, `w=${spWare} i=${spInstr}`));

  await moveItem(sp1.id, { location: 'instructor:test-uid-shir', locationName: 'שיר (הרנס)' }, 'הקצאת רמקול');
  await wait(150);
  items = await loadHarnessItems();
  spWare = items.filter(x => !x.deleted && x.type === 'speaker' && x.location === 'warehouse').length;
  spInstr = items.filter(x => !x.deleted && x.type === 'speaker' && x.location && x.location.indexOf('instructor:') === 0).length;
  results.push(pass('T4b: warehouse speakers -1 after assign', spWare === 0, `w=${spWare}`));
  results.push(pass('T4c: instructor speakers +1 after assign', spInstr === 1, `i=${spInstr}`));

  // --------- 5. Delete: marked deleted but movement history preserved
  const beforeMovementCount = (await db.collection('inventoryMovements').where('itemId', '==', shrekan2.id).get()).size;
  await softDeleteItem(shrekan2.id);
  await wait(150);
  items = await loadHarnessItems();
  const notShown = !items.filter(x => !x.deleted).some(x => (x.id || x._docId) === shrekan2.id);
  const stillPresent = items.some(x => (x.id || x._docId) === shrekan2.id);
  results.push(pass('T5a: deleted item hidden from live counts', notShown, ''));
  results.push(pass('T5b: deleted item record preserved', stillPresent, ''));
  const afterMovementCount = (await db.collection('inventoryMovements').where('itemId', '==', shrekan2.id).get()).size;
  results.push(pass('T5c: movement history preserved (>= before)',
    afterMovementCount >= beforeMovementCount + 1, `before=${beforeMovementCount}, after=${afterMovementCount}`));

  const totalShrekanAfterDelete = items.filter(x => !x.deleted && x.templateId === 'tpl_shrekan').length;
  results.push(pass('T5d: shrekan count drops from 3 to 2 after delete', totalShrekanAfterDelete === 2, `count=${totalShrekanAfterDelete}`));

  // --------- Cleanup: remove every harness doc
  console.log('\n🧹 Cleaning up harness docs...');
  const cleanupItems = await db.collection('inventoryItems').where('_harness', '==', TAG).get();
  const cleanupMoves = await db.collection('inventoryMovements').where('_harness', '==', TAG).get();
  const batch = db.batch();
  cleanupItems.forEach(d => batch.delete(d.ref));
  cleanupMoves.forEach(d => batch.delete(d.ref));
  await batch.commit();
  console.log(`   Removed ${cleanupItems.size} items + ${cleanupMoves.size} movements`);

  // --------- Summary
  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\n📊 ${passed}/${total} checks passed\n`);
  process.exit(passed === total ? 0 : 1);
}

main().catch(e => {
  console.error('❌ harness crashed:', e);
  process.exit(2);
});
