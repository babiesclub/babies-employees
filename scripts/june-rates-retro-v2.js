// V2: Push ANY rate entry with `from` in June 2026 back to 2026-06-01
// (the original script only touched the EARLIEST entry per history; some gardens
// had pre-existing 1970 entries that were < target, so nothing changed.)
//
// Usage:
//   node june-rates-retro-v2.js           (dry run)
//   node june-rates-retro-v2.js --apply   (apply changes)

const admin=require('firebase-admin');
const sa=require('./service-account.json');
admin.initializeApp({credential:admin.credential.cert(sa)});
const db=admin.firestore();

const TARGET='2026-06-01';
const JUNE_START='2026-06-02';  // anything > 2026-06-01
const JUNE_END='2026-07-01';    // anything < 2026-07-01
const APPLY=process.argv.includes('--apply');

function fixHistory(history){
  // For each entry with from in (2026-06-01, 2026-07-01), push to 2026-06-01.
  // If multiple end up at the same from, keep the one originally with highest from.
  if(!Array.isArray(history)||!history.length)return{changed:false,history,changes:[]};
  const changes=[];
  const cloned=history.map(h=>({...h}));
  cloned.forEach((h,i)=>{
    const f=h.from||'';
    if(f>='2026-06-02'&&f<'2026-07-01'){
      changes.push({idx:i,oldFrom:f,newFrom:TARGET,rates:JSON.stringify(h.rates||{})});
      h.from=TARGET;
    }
  });
  // Dedupe: if multiple entries now share 2026-06-01, keep the one with originally
  // highest from (which was at the END of changes). Drop the others.
  const samedate=cloned.map((h,i)=>({h,i,origIdx:i})).filter(x=>x.h.from===TARGET);
  let toDrop=new Set();
  if(samedate.length>1){
    // Determine winner: the one with the originally highest `from` (latest change wins).
    // Reconstruct original from history[i].from
    let winnerIdx=samedate[0].i;
    let winnerOrigFrom=history[samedate[0].i].from||'';
    for(const x of samedate.slice(1)){
      const origFrom=history[x.i].from||'';
      if(origFrom>winnerOrigFrom){winnerOrigFrom=origFrom;winnerIdx=x.i}
    }
    samedate.forEach(x=>{if(x.i!==winnerIdx)toDrop.add(x.i)});
  }
  const finalHist=cloned.filter((_,i)=>!toDrop.has(i));
  return{changed:changes.length>0,history:finalHist,changes,dropped:Array.from(toDrop)};
}

(async()=>{
  console.log(APPLY?'🔥 APPLY mode':'👁 DRY RUN');
  console.log('יעד: דחיפת כל ערך עם from ביוני 2026 ל-'+TARGET+'\n');

  // 1. GARDENS
  const gardensDoc=await db.collection('meta').doc('gardens').get();
  const items=(gardensDoc.exists?(gardensDoc.data().items||[]):[]);
  let gardenChChanges=0,gardenPayChanges=0;
  const updatedItems=items.map(g=>{
    if(typeof g!=='object')return g;
    const out={...g};
    let changed=false;
    if(Array.isArray(g.chargeRatesHistory)){
      const r=fixHistory(g.chargeRatesHistory);
      if(r.changed){
        out.chargeRatesHistory=r.history;
        changed=true;
        r.changes.forEach(c=>{
          console.log('  🌿 '+g.name+': chargeRatesHistory ['+c.idx+'] '+c.oldFrom+' → '+c.newFrom+' · '+c.rates);
          gardenChChanges++;
        });
        if(r.dropped.length)console.log('     (הוסרו '+r.dropped.length+' ערכים כפולים)');
      }
    }
    if(Array.isArray(g.instructorPayHistory)){
      const r=fixHistory(g.instructorPayHistory);
      if(r.changed){
        out.instructorPayHistory=r.history;
        changed=true;
        r.changes.forEach(c=>{
          console.log('  🌿 '+g.name+': instructorPayHistory ['+c.idx+'] '+c.oldFrom+' → '+c.newFrom+' · '+c.rates);
          gardenPayChanges++;
        });
        if(r.dropped.length)console.log('     (הוסרו '+r.dropped.length+' ערכים כפולים)');
      }
    }
    return changed?out:g;
  });
  console.log('\n✓ Gardens: '+gardenChChanges+' chargeRates + '+gardenPayChanges+' instructorPay');

  // 2. USERS
  const usersSnap=await db.collection('users').get();
  let userChanges=0;
  const batches=[];
  usersSnap.forEach(d=>{
    const u=d.data();
    if(!u.gardenPayHistory||typeof u.gardenPayHistory!=='object')return;
    let changed=false;
    const newGPH={...u.gardenPayHistory};
    for(const gardenName of Object.keys(newGPH)){
      const r=fixHistory(newGPH[gardenName]);
      if(r.changed){
        newGPH[gardenName]=r.history;
        changed=true;
        r.changes.forEach(c=>{
          console.log('  👤 '+(u.name||d.id)+' → '+gardenName+': ['+c.idx+'] '+c.oldFrom+' → '+c.newFrom+' · '+c.rates);
          userChanges++;
        });
        if(r.dropped.length)console.log('     (הוסרו '+r.dropped.length+' ערכים כפולים)');
      }
    }
    if(changed)batches.push({ref:d.ref,data:{gardenPayHistory:newGPH}});
  });
  console.log('\n✓ Users: '+userChanges+' entries ב-'+batches.length+' משתמשים\n');

  if(APPLY){
    if(gardenChChanges+gardenPayChanges>0){
      await db.collection('meta').doc('gardens').set({items:updatedItems},{merge:true});
      console.log('✓ Gardens עודכן ב-Firestore');
    }
    for(const{ref,data} of batches)await ref.set(data,{merge:true});
    if(batches.length)console.log('✓ '+batches.length+' user docs עודכנו');
    console.log('\n✅ DONE');
  }else{
    console.log('🚀 הרץ שוב עם --apply לביצוע');
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
