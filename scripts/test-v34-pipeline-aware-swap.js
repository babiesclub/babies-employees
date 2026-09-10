// v34 pipeline-aware dedup harness — three-tier validation.
//
// STAGE 1 (SYNTHETIC):
//   Tier 1 · pool-internal pair swap (helper still fires for cases where
//            swap doesn't just shift a cross-region dup — e.g. same-region
//            dup we deliberately construct).
//   Tier 2 · temporal pool swap between current cycle and a future cycle
//            of the same sub-group; both cycles Latin-square valid post-swap.
//   Tier 3 · raw single-cell swap on protected cell + iron-rule check on
//            cycle-mates; sub-group Latin square holds for remaining cycles.
//   Test 4 · cross-cluster interaction — swapping one sub-group's pool
//            leaves other sub-groups in the same super-cluster untouched.
//
// STAGE 2 (LIVE FIRESTORE):
//   Feed the current schedule through _crossRegionDedupSwap (v34) with
//   synthesized pipelinePoolByWeek reconstructed from rotation-group
//   membership + current pool composition, and verify the Gita+Tali case
//   is resolved.
//
// Runs entirely OFFLINE — never writes to Firestore.

const fs = require('fs');
const path = require('path');

// Constants + helpers mirrored from index.html
const MAT_SEASONALITY = {
  any:{months:null}, winter:{months:[11,0,1]}, spring:{months:[2,3,4]},
  summer:{months:[5,6,7]}, autumn:{months:[8,9,10]},
  near_rosh_hashana:{months:[8,9]}, around_rosh_hashana_week:{months:[8,9]},
  near_purim:{months:[1,2]}, near_pesach:{months:[2,3]}, after_pesach:{months:[3,4,5]},
};
const MAT_CATEGORIES = {
  rodent:{winterRisky:false}, bird:{winterRisky:false}, chick:{winterRisky:true},
  reptile:{winterRisky:true}, insect:{winterRisky:false}, fish:{winterRisky:false},
  generic:{winterRisky:false},
};
const SEASON_HOLIDAY_WINDOWS = {
  before_purim:{holidayKey:'purim',daysBefore:28},
  before_pesach:{holidayKey:'pesach',daysBefore:28},
  before_independence_day:{holidayKey:'independence_day',daysBefore:28},
};
const HOLIDAYS_5787 = { rosh_hashana:'2026-09-12', purim:'2027-03-02', pesach:'2027-04-11', independence_day:'2027-05-12' };
const HOLIDAY_ONLY_WEEKS = {
  '2026-09-06':{}, '2026-09-13':{}, '2027-02-28':{}, '2027-03-07':{}, '2027-03-14':{},
  '2027-03-28':{}, '2027-04-04':{}, '2027-04-25':{}, '2027-05-09':{},
};
const ISRAELI_HOLIDAYS = {
  '2026-09-13':{name:'ראש השנה',fullWeek:false},
  '2026-09-27':{name:'סוכות',fullWeek:true},
  '2027-04-18':{name:'פסח א',fullWeek:true},
  '2027-04-25':{name:'פסח ב',fullWeek:true},
};
const END_OF_YEAR_MONTHS = [5,6,7];
const _monthOfISO = iso => parseInt(iso.split('-')[1],10)-1;
const _isWinter = m => m===11||m===0||m===1;
const _isoDiffDays = (a,b) => Math.round((new Date(b)-new Date(a))/86400000);
const _matIsEndOfYear = m => { const END = ['דגי','לובסטר','חתולי ים','דג','דגים']; const n=String(m.name||'').trim(); return END.some(k => n===k||n.startsWith(k+' ')||n.startsWith(k+'-')||n.startsWith(k+'–')||n.startsWith(k+'—')); };
const _matIsHolidayOnlyMaterial = m => /דבורה - דבש|ראש השנה|פורים|טווס|פסח|עצמאות/.test(String(m.name||''));
const _matIsHolidayOnlyFor = (m,w) => HOLIDAY_ONLY_WEEKS[w] && _matIsHolidayOnlyMaterial(m);
const _matSeasonFits = (m,w,h) => {
  if(HOLIDAY_ONLY_WEEKS[w] && !_matIsHolidayOnlyFor(m,w)) return false;
  if(_matIsHolidayOnlyMaterial(m) && !_matIsHolidayOnlyFor(m,w)) return false;
  if(_matIsEndOfYear(m) && !END_OF_YEAR_MONTHS.includes(_monthOfISO(w))) return false;
  const mi=_monthOfISO(w); const ci=MAT_CATEGORIES[m.category]||{};
  if(ci.winterRisky && _isWinter(mi)) return false;
  const s=m.seasonality||'any'; if(s==='any') return true;
  if(SEASON_HOLIDAY_WINDOWS[s]){const w1=SEASON_HOLIDAY_WINDOWS[s];const hd=h[w1.holidayKey];if(!hd)return true;const d=_isoDiffDays(w,hd);return d>=0&&d<=w1.daysBefore;}
  const sd=MAT_SEASONALITY[s]; return !(sd&&sd.months&&!sd.months.includes(mi));
};
const _matSeasonFitsRelaxed = _matSeasonFits;
const _matIsSharedPhysical = m => m && m.category !== 'generic' && !!(m.animalName||'').trim();
const _scoreMaterial = (mat, ctx) => {
  let score = 0;
  const animal = (mat.animalName||mat.name||'').trim();
  const gardens = ctx.gardens||[];
  const notSeen = gardens.filter(g => !ctx.gardensSeen[g]||!ctx.gardensSeen[g].has(animal)).length;
  score += notSeen*100;
  if(ctx.lastCategory && mat.category===ctx.lastCategory) score -= 20;
  if(mat.seasonality && mat.seasonality!=='any') score += 8;
  if(ctx.globallyUsed && !ctx.globallyUsed.has(mat.id)) score += 120;
  if(ctx.sharedThisWeek){
    const st = ctx.sharedThisWeek;
    const cnt = (typeof st.get==='function') ? (st.get(mat.id)||0) : (st.has(mat.id)?1:0);
    if(cnt===1) score -= 50; else if(cnt===2) score -= 150; else if(cnt>=3) score -= 300;
  }
  return score;
};

// Extract _crossRegionDedupSwap from index.html
const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function extractFunction(name){
  const s = html.indexOf('function '+name);
  const e1 = html.indexOf('\n// Expose for Node harness testing', s);
  const e2 = html.indexOf('\nif(typeof window!==', s);
  const e = Math.min(e1>=0?e1:Infinity, e2>=0?e2:Infinity);
  if(s<0 || !isFinite(e)) throw new Error('could not find '+name);
  return html.slice(s, e);
}
const crSrc = extractFunction('_crossRegionDedupSwap');
const tsSrc = extractFunction('_temporalSwapDedup');

global.window = {};
global.DB = { get: k => (k==='users' ? [] : []) };
global.getMaterials = () => global.__allMats;
global.getVirtualInstructors = () => [];
global._rotGroups = [];
global._matIsSharedPhysical = _matIsSharedPhysical;
global._matIsHolidayOnlyMaterial = _matIsHolidayOnlyMaterial;
global._matIsHolidayOnlyFor = _matIsHolidayOnlyFor;
global.HOLIDAYS_5787 = HOLIDAYS_5787;
global.HOLIDAY_ONLY_WEEKS = HOLIDAY_ONLY_WEEKS;
global.ISRAELI_HOLIDAYS = ISRAELI_HOLIDAYS;
global._matSeasonFits = _matSeasonFits;
global._matSeasonFitsRelaxed = _matSeasonFitsRelaxed;
global._monthOfISO = _monthOfISO;
global._scoreMaterial = _scoreMaterial;
global.MAT_CATEGORIES = MAT_CATEGORIES;

const _crossRegionDedupSwap = new Function(`${crSrc}\n;return _crossRegionDedupSwap;`)();
const _temporalSwapDedup = new Function(`${tsSrc}\n;return _temporalSwapDedup;`)();

let _passCount = 0, _failCount = 0;
function assert(cond, msg){
  if(cond){ _passCount++; console.log('  ✓ '+msg); }
  else{ _failCount++; console.error('  ✗ '+msg); }
}

// -----------------------------------------------------------------------------
// TEST 1 — Tier 1 pool-internal swap (validation & fall-through path)
// Tier 1 for a 2-region cross-region dup where the whole pair is in one of
// the two regions ALWAYS rejects — swapping holder<->pair-mate just moves
// the dup to pair-mate (still cross-region-dupped with the other region).
// The tier engine correctly falls through to Tier 2/3. This test verifies
// the fall-through works and the dup is resolved.
function testTier1(){
  console.log('\n[test 1] Tier 1 rejects for pure-2-region dup, falls through to Tier 2/3');
  const mats = [
    { id:'m_p', name:'תוכי', animalName:'תוכי', category:'bird', seasonality:'any' },
    { id:'m_q', name:'שוגר', animalName:'שוגר גליידר', category:'rodent', seasonality:'any' },
    { id:'m_x', name:'ארנב', animalName:'ארנב', category:'rodent', seasonality:'any' },
  ];
  global.__allMats = mats;
  // Super-cluster of 2 pairs in TWO regions. In week 1, holder (uid1, region south)
  // has m_q; another region's uid5 also has m_q → cross-region dup.
  // The dup can be broken by pool-internal swap: uid1 <-> uid2 (both in south),
  // uid2 gets m_q, uid1 gets m_p. If uid5's mat differs from m_p, no new dup.
  const week1 = '2026-11-08';
  const week2 = '2026-11-15';
  const perRegion = [
    { region:'south', proposal:[
        { weekISO:week1, assignments:{ uid1:'m_q', uid2:'m_p' } },
        { weekISO:week2, assignments:{ uid1:'m_p', uid2:'m_q' } },
      ], warnings:[],
      pipelinePoolByWeek:{
        [week1]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_p','m_q'],shiftIdx:0,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_p','m_q'],shiftIdx:0,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
        },
        [week2]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_p','m_q'],shiftIdx:0,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_p','m_q'],shiftIdx:0,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
        },
      },
      pipelineProtectedUids:['uid1','uid2'],
    },
    { region:'north', proposal:[
        { weekISO:week1, assignments:{ uid5:'m_q' } }, // dup with south uid1
        { weekISO:week2, assignments:{ uid5:'m_x' } }, // no dup
      ], warnings:[] },
  ];
  const gardensByUid = { uid1:['g1'], uid2:['g2'], uid5:['g5'] };
  const inGroupUids = new Set(['uid1','uid2','uid5']);
  // Force tier path: uid5 pretends to be pipeline-protected too, so regular
  // logic sees zero-swappable and hands off to the tier engine.
  perRegion[1].pipelineProtectedUids = ['uid5'];
  const res = _crossRegionDedupSwap(perRegion, {
    materials: mats, gardensByUid, inGroupUids,
    seasonFits:_matSeasonFits, scoreMaterial:_scoreMaterial,
    monthOfISO:_monthOfISO, holidayDates:HOLIDAYS_5787,
    israeliHolidays:ISRAELI_HOLIDAYS,
  });
  console.log(`  tiers: T1=${res.tierCounts.T1} T2=${res.tierCounts.T2} T3=${res.tierCounts.T3}`);
  res.swapEvents.forEach(ev => console.log('   · '+ev.msg));
  // After swap: uid1 should NOT be on m_q at week1 (dup broken by some tier)
  const w1South = perRegion[0].proposal[0].assignments;
  assert(w1South.uid1 !== 'm_q', 'dup broken: uid1 no longer on m_q at week1');
  // Some tier fired (T1 falls through here → T2/T3 resolves)
  assert((res.tierCounts.T1+res.tierCounts.T2+res.tierCounts.T3) >= 1, 'some tier fired to resolve dup');
  // Iron rule for uid1: no repeated mat across her weeks
  const w2South = perRegion[0].proposal[1].assignments;
  const uid1Seen = [w1South.uid1, w2South.uid1];
  assert(new Set(uid1Seen).size === uid1Seen.filter(Boolean).length, `iron rule uid1: no repeats · got ${uid1Seen}`);
  const uid2Seen = [w1South.uid2, w2South.uid2];
  assert(new Set(uid2Seen).size === uid2Seen.filter(Boolean).length, `iron rule uid2: no repeats · got ${uid2Seen}`);
}

// -----------------------------------------------------------------------------
// TEST 2 — Tier 2 temporal pool swap
// Current cycle pool [m_dup, m_pair] dups cross-region with north uid5.
// Future cycle pool [m_fresh1, m_fresh2] is available. Tier 2 swaps them.
// -----------------------------------------------------------------------------
function testTier2(){
  console.log('\n[test 2] Tier 2 · temporal pool swap between current and future cycle');
  const mats = [
    { id:'m_dup', name:'שוגר', animalName:'שוגר גליידר', category:'rodent', seasonality:'any' },
    { id:'m_pair', name:'תוכי', animalName:'תוכי', category:'bird', seasonality:'any' },
    { id:'m_f1', name:'ארנב', animalName:'ארנב', category:'rodent', seasonality:'any' },
    { id:'m_f2', name:'צב', animalName:'צב', category:'reptile', seasonality:'any' },
    { id:'m_other', name:'חמוס', animalName:'חמוס', category:'rodent', seasonality:'any' },
  ];
  global.__allMats = mats;
  const w1='2026-11-08', w2='2026-11-15', w3='2026-11-22', w4='2026-11-29';
  const perRegion = [
    { region:'south', proposal:[
        { weekISO:w1, assignments:{ uid1:'m_dup', uid2:'m_pair' } },
        { weekISO:w2, assignments:{ uid1:'m_pair', uid2:'m_dup' } },
        { weekISO:w3, assignments:{ uid1:'m_f1', uid2:'m_f2' } },
        { weekISO:w4, assignments:{ uid1:'m_f2', uid2:'m_f1' } },
      ], warnings:[],
      pipelinePoolByWeek:{
        [w1]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
        },
        [w2]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
        },
        [w3]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_f1','m_f2'],shiftIdx:1,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_f1','m_f2'],shiftIdx:1,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
        },
        [w4]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_f1','m_f2'],shiftIdx:1,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_f1','m_f2'],shiftIdx:1,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
        },
      },
      pipelineProtectedUids:['uid1','uid2'],
    },
    { region:'north', proposal:[
        { weekISO:w1, assignments:{ uid5:'m_dup' } }, // dup with south uid1
        { weekISO:w2, assignments:{ uid5:'m_other' } },
        { weekISO:w3, assignments:{ uid5:'m_other' } },
        { weekISO:w4, assignments:{ uid5:'m_other' } },
      ], warnings:[] },
  ];
  const gardensByUid = { uid1:['g1'], uid2:['g2'], uid5:['g5'] };
  const inGroupUids = new Set(['uid1','uid2','uid5']);
  // Force tier path: uid5 pretends to be pipeline-protected too, so regular
  // logic sees zero-swappable and hands off to the tier engine.
  perRegion[1].pipelineProtectedUids = ['uid5'];
  const res = _crossRegionDedupSwap(perRegion, {
    materials: mats, gardensByUid, inGroupUids,
    seasonFits:_matSeasonFits, scoreMaterial:_scoreMaterial,
    monthOfISO:_monthOfISO, holidayDates:HOLIDAYS_5787,
    israeliHolidays:ISRAELI_HOLIDAYS,
  });
  console.log(`  tiers: T1=${res.tierCounts.T1} T2=${res.tierCounts.T2} T3=${res.tierCounts.T3}`);
  res.swapEvents.forEach(ev => console.log('   · '+ev.msg));
  // After swap: cycle 0 pool for south should be {m_f1, m_f2}, cycle 1 pool should be {m_dup, m_pair}
  const s = perRegion[0].proposal;
  const cyc0mats = new Set([s[0].assignments.uid1, s[0].assignments.uid2, s[1].assignments.uid1, s[1].assignments.uid2]);
  const cyc1mats = new Set([s[2].assignments.uid1, s[2].assignments.uid2, s[3].assignments.uid1, s[3].assignments.uid2]);
  assert(cyc0mats.has('m_f1') && cyc0mats.has('m_f2'), `cycle 0 now has {m_f1,m_f2}: ${[...cyc0mats].join(',')}`);
  assert(cyc1mats.has('m_dup') && cyc1mats.has('m_pair'), `cycle 1 now has {m_dup,m_pair}: ${[...cyc1mats].join(',')}`);
  // Iron rule: each uid sees each mat exactly once
  const uid1Year = [s[0].assignments.uid1, s[1].assignments.uid1, s[2].assignments.uid1, s[3].assignments.uid1].sort();
  const uid2Year = [s[0].assignments.uid2, s[1].assignments.uid2, s[2].assignments.uid2, s[3].assignments.uid2].sort();
  assert(JSON.stringify(uid1Year) === JSON.stringify(['m_dup','m_f1','m_f2','m_pair']), `uid1 iron rule: ${uid1Year}`);
  assert(JSON.stringify(uid2Year) === JSON.stringify(['m_dup','m_f1','m_f2','m_pair']), `uid2 iron rule: ${uid2Year}`);
  assert(res.tierCounts.T2 >= 1, 'Tier 2 fired at least once');
  // Latin square within each cycle: uid1 and uid2 see different mats each week
  assert(s[0].assignments.uid1 !== s[0].assignments.uid2, 'week1 latin: uid1 != uid2');
  assert(s[1].assignments.uid1 !== s[1].assignments.uid2, 'week2 latin: uid1 != uid2');
  assert(s[2].assignments.uid1 !== s[2].assignments.uid2, 'week3 latin: uid1 != uid2');
  assert(s[3].assignments.uid1 !== s[3].assignments.uid2, 'week4 latin: uid1 != uid2');
}

// -----------------------------------------------------------------------------
// TEST 3 — Tier 3 raw swap + iron-rule check
// Neither pair-mate swap NOR future pool swap resolves the dup (contrived).
// Tier 3 picks a raw candidate that's iron-rule-safe.
// -----------------------------------------------------------------------------
function testTier3(){
  console.log('\n[test 3] Tier 3 · raw swap on protected cell + iron-rule check');
  const mats = [
    { id:'m_dup', name:'שוגר', animalName:'שוגר גליידר', category:'rodent', seasonality:'any' },
    { id:'m_pair', name:'תוכי', animalName:'תוכי', category:'bird', seasonality:'any' },
    { id:'m_alt', name:'כלב', animalName:'כלב', category:'generic', seasonality:'any' }, // generic → not "shared physical"
    { id:'m_alt2', name:'חולדה', animalName:'חולדה', category:'rodent', seasonality:'any' },
  ];
  global.__allMats = mats;
  const w1='2026-11-08', w2='2026-11-15';
  const perRegion = [
    { region:'south', proposal:[
        { weekISO:w1, assignments:{ uid1:'m_dup', uid2:'m_pair' } },
        { weekISO:w2, assignments:{ uid1:'m_pair', uid2:'m_dup' } },
      ], warnings:[],
      pipelinePoolByWeek:{
        [w1]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
        },
        [w2]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
        },
      },
      pipelineProtectedUids:['uid1','uid2'],
    },
    { region:'north', proposal:[
        { weekISO:w1, assignments:{ uid5:'m_dup' } }, // dup with south uid1
        { weekISO:w2, assignments:{ uid5:'m_alt2' } },
      ], warnings:[] },
  ];
  const gardensByUid = { uid1:['g1'], uid2:['g2'], uid5:['g5'] };
  const inGroupUids = new Set(['uid1','uid2','uid5']);
  // Force tier path: uid5 pretends to be pipeline-protected too, so regular
  // logic sees zero-swappable and hands off to the tier engine.
  perRegion[1].pipelineProtectedUids = ['uid5'];
  const res = _crossRegionDedupSwap(perRegion, {
    materials: mats, gardensByUid, inGroupUids,
    seasonFits:_matSeasonFits, scoreMaterial:_scoreMaterial,
    monthOfISO:_monthOfISO, holidayDates:HOLIDAYS_5787,
    israeliHolidays:ISRAELI_HOLIDAYS,
  });
  console.log(`  tiers: T1=${res.tierCounts.T1} T2=${res.tierCounts.T2} T3=${res.tierCounts.T3}`);
  res.swapEvents.forEach(ev => console.log('   · '+ev.msg));
  // uid1 should have moved OFF m_dup at week 1.
  const w1S = perRegion[0].proposal[0].assignments;
  assert(w1S.uid1 !== 'm_dup', `Tier 3 moved uid1 off m_dup at week1 (got ${w1S.uid1})`);
  // Some tier fired (Tier 1 would move dup to uid2 which STILL dups w/ uid5; so Tier 1 fails validation
  // and Tier 3 should fire since no future cycle exists here for Tier 2).
  assert(res.tierCounts.T1 + res.tierCounts.T2 + res.tierCounts.T3 >= 1, 'at least one tier fired');
}

// -----------------------------------------------------------------------------
// TEST 4 — Cross-cluster interaction — sibling sub-groups unaffected
// A super-cluster of 3 pair sub-groups. Swap Tier 2 fires on sub-group1;
// verify sub-group2 and sub-group3 are UNTOUCHED.
// -----------------------------------------------------------------------------
function testCrossClusterIsolation(){
  console.log('\n[test 4] Cross-cluster isolation · sibling sub-groups unaffected');
  const mats = [
    { id:'m_dup', name:'שוגר', animalName:'שוגר גליידר', category:'rodent', seasonality:'any' },
    { id:'m_pair', name:'תוכי', animalName:'תוכי', category:'bird', seasonality:'any' },
    { id:'m_a1', name:'ארנב', animalName:'ארנב', category:'rodent', seasonality:'any' },
    { id:'m_a2', name:'חמוס', animalName:'חמוס', category:'rodent', seasonality:'any' },
    { id:'m_b1', name:'צב', animalName:'צב', category:'reptile', seasonality:'any' },
    { id:'m_b2', name:'זיקית', animalName:'זיקית', category:'reptile', seasonality:'any' },
    { id:'m_f1', name:'שרקן', animalName:'שרקן', category:'rodent', seasonality:'any' },
    { id:'m_f2', name:'עכבר', animalName:'עכבר', category:'rodent', seasonality:'any' },
    { id:'m_other', name:'חולדה', animalName:'חולדה', category:'rodent', seasonality:'any' },
  ];
  global.__allMats = mats;
  const w1='2026-11-08', w2='2026-11-15', w3='2026-11-22', w4='2026-11-29';
  const perRegion = [
    { region:'south', proposal:[
        { weekISO:w1, assignments:{
            uid1:'m_dup', uid2:'m_pair', // sub1 (affected)
            uid3:'m_a1',  uid4:'m_a2',   // sub2 (should stay)
            uid5:'m_b1',  uid6:'m_b2',   // sub3 (should stay)
        } },
        { weekISO:w2, assignments:{
            uid1:'m_pair', uid2:'m_dup',
            uid3:'m_a2', uid4:'m_a1',
            uid5:'m_b2', uid6:'m_b1',
        } },
        { weekISO:w3, assignments:{
            uid1:'m_f1', uid2:'m_f2',
            uid3:'m_dup', uid4:'m_pair', // sub2 inherits (irrelevant here, purely rotational)
            uid5:'m_a1', uid6:'m_a2',
        } },
        { weekISO:w4, assignments:{
            uid1:'m_f2', uid2:'m_f1',
            uid3:'m_pair', uid4:'m_dup',
            uid5:'m_a2', uid6:'m_a1',
        } },
      ], warnings:[],
      pipelinePoolByWeek:{
        [w1]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid3:{superId:'sc',subGroupId:'sub2',subGroupUids:['uid3','uid4'],poolMatIds:['m_a1','m_a2'],shiftIdx:0,weekInShift:0,pIdx:1,cycleLen:2,pipelineKind:'3pair'},
          uid4:{superId:'sc',subGroupId:'sub2',subGroupUids:['uid3','uid4'],poolMatIds:['m_a1','m_a2'],shiftIdx:0,weekInShift:0,pIdx:1,cycleLen:2,pipelineKind:'3pair'},
          uid5:{superId:'sc',subGroupId:'sub3',subGroupUids:['uid5','uid6'],poolMatIds:['m_b1','m_b2'],shiftIdx:0,weekInShift:0,pIdx:2,cycleLen:2,pipelineKind:'3pair'},
          uid6:{superId:'sc',subGroupId:'sub3',subGroupUids:['uid5','uid6'],poolMatIds:['m_b1','m_b2'],shiftIdx:0,weekInShift:0,pIdx:2,cycleLen:2,pipelineKind:'3pair'},
        },
        [w2]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_dup','m_pair'],shiftIdx:0,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid3:{superId:'sc',subGroupId:'sub2',subGroupUids:['uid3','uid4'],poolMatIds:['m_a1','m_a2'],shiftIdx:0,weekInShift:1,pIdx:1,cycleLen:2,pipelineKind:'3pair'},
          uid4:{superId:'sc',subGroupId:'sub2',subGroupUids:['uid3','uid4'],poolMatIds:['m_a1','m_a2'],shiftIdx:0,weekInShift:1,pIdx:1,cycleLen:2,pipelineKind:'3pair'},
          uid5:{superId:'sc',subGroupId:'sub3',subGroupUids:['uid5','uid6'],poolMatIds:['m_b1','m_b2'],shiftIdx:0,weekInShift:1,pIdx:2,cycleLen:2,pipelineKind:'3pair'},
          uid6:{superId:'sc',subGroupId:'sub3',subGroupUids:['uid5','uid6'],poolMatIds:['m_b1','m_b2'],shiftIdx:0,weekInShift:1,pIdx:2,cycleLen:2,pipelineKind:'3pair'},
        },
        [w3]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_f1','m_f2'],shiftIdx:1,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_f1','m_f2'],shiftIdx:1,weekInShift:0,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid3:{superId:'sc',subGroupId:'sub2',subGroupUids:['uid3','uid4'],poolMatIds:['m_dup','m_pair'],shiftIdx:1,weekInShift:0,pIdx:1,cycleLen:2,pipelineKind:'3pair'},
          uid4:{superId:'sc',subGroupId:'sub2',subGroupUids:['uid3','uid4'],poolMatIds:['m_dup','m_pair'],shiftIdx:1,weekInShift:0,pIdx:1,cycleLen:2,pipelineKind:'3pair'},
          uid5:{superId:'sc',subGroupId:'sub3',subGroupUids:['uid5','uid6'],poolMatIds:['m_a1','m_a2'],shiftIdx:1,weekInShift:0,pIdx:2,cycleLen:2,pipelineKind:'3pair'},
          uid6:{superId:'sc',subGroupId:'sub3',subGroupUids:['uid5','uid6'],poolMatIds:['m_a1','m_a2'],shiftIdx:1,weekInShift:0,pIdx:2,cycleLen:2,pipelineKind:'3pair'},
        },
        [w4]:{
          uid1:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_f1','m_f2'],shiftIdx:1,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid2:{superId:'sc',subGroupId:'sub1',subGroupUids:['uid1','uid2'],poolMatIds:['m_f1','m_f2'],shiftIdx:1,weekInShift:1,pIdx:0,cycleLen:2,pipelineKind:'3pair'},
          uid3:{superId:'sc',subGroupId:'sub2',subGroupUids:['uid3','uid4'],poolMatIds:['m_dup','m_pair'],shiftIdx:1,weekInShift:1,pIdx:1,cycleLen:2,pipelineKind:'3pair'},
          uid4:{superId:'sc',subGroupId:'sub2',subGroupUids:['uid3','uid4'],poolMatIds:['m_dup','m_pair'],shiftIdx:1,weekInShift:1,pIdx:1,cycleLen:2,pipelineKind:'3pair'},
          uid5:{superId:'sc',subGroupId:'sub3',subGroupUids:['uid5','uid6'],poolMatIds:['m_a1','m_a2'],shiftIdx:1,weekInShift:1,pIdx:2,cycleLen:2,pipelineKind:'3pair'},
          uid6:{superId:'sc',subGroupId:'sub3',subGroupUids:['uid5','uid6'],poolMatIds:['m_a1','m_a2'],shiftIdx:1,weekInShift:1,pIdx:2,cycleLen:2,pipelineKind:'3pair'},
        },
      },
      pipelineProtectedUids:['uid1','uid2','uid3','uid4','uid5','uid6'],
    },
    { region:'north', proposal:[
        { weekISO:w1, assignments:{ uid10:'m_dup' } }, // cross-region dup with sub1
        { weekISO:w2, assignments:{ uid10:'m_other' } },
        { weekISO:w3, assignments:{ uid10:'m_other' } },
        { weekISO:w4, assignments:{ uid10:'m_other' } },
      ], warnings:[] },
  ];
  // Snapshot sub2 & sub3 assignments BEFORE
  const before = JSON.parse(JSON.stringify(perRegion[0].proposal.map(p=>({
    w:p.weekISO,
    sub2:{uid3:p.assignments.uid3, uid4:p.assignments.uid4},
    sub3:{uid5:p.assignments.uid5, uid6:p.assignments.uid6},
  }))));
  const gardensByUid = {}; for(let i=1;i<=6;i++) gardensByUid['uid'+i]=['g'+i]; gardensByUid.uid10=['g10'];
  const inGroupUids = new Set(['uid1','uid2','uid3','uid4','uid5','uid6','uid10']);
  perRegion[1].pipelineProtectedUids = ['uid10'];
  const res = _crossRegionDedupSwap(perRegion, {
    materials: mats, gardensByUid, inGroupUids,
    seasonFits:_matSeasonFits, scoreMaterial:_scoreMaterial,
    monthOfISO:_monthOfISO, holidayDates:HOLIDAYS_5787,
    israeliHolidays:ISRAELI_HOLIDAYS,
  });
  console.log(`  tiers: T1=${res.tierCounts.T1} T2=${res.tierCounts.T2} T3=${res.tierCounts.T3}`);
  res.swapEvents.forEach(ev => console.log('   · '+ev.msg));
  // Sub2 and sub3 must be UNTOUCHED
  const after = perRegion[0].proposal.map(p=>({
    w:p.weekISO,
    sub2:{uid3:p.assignments.uid3, uid4:p.assignments.uid4},
    sub3:{uid5:p.assignments.uid5, uid6:p.assignments.uid6},
  }));
  before.forEach((b,i)=>{
    assert(JSON.stringify(after[i].sub2)===JSON.stringify(b.sub2), `sub2 untouched at ${b.w}: before=${JSON.stringify(b.sub2)} after=${JSON.stringify(after[i].sub2)}`);
    assert(JSON.stringify(after[i].sub3)===JSON.stringify(b.sub3), `sub3 untouched at ${b.w}: before=${JSON.stringify(b.sub3)} after=${JSON.stringify(after[i].sub3)}`);
  });
}

// -----------------------------------------------------------------------------
// STAGE 2 — LIVE FIRESTORE: verify Gita+Tali 2026-10-11 case
// -----------------------------------------------------------------------------
async function runLive(){
  console.log('\n===== STAGE 2: LIVE FIRESTORE (Gita+Tali 2026-10-11 שוגר גליידר) =====');
  let admin;
  try{ admin = require('firebase-admin'); }catch(e){ console.log('  (skipped — no firebase-admin)'); return null; }
  try{
    if(!admin.apps || !admin.apps.length){
      const serviceAccount = require('./service-account.json');
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
  }catch(e){ console.log('  (skipped — service-account init failed: '+(e.message||e)+')'); return null; }
  const db = admin.firestore();
  const [matSnap, userSnap, wksSnap, rgSnap] = await Promise.all([
    db.collection('materials').get(),
    db.collection('users').get(),
    db.collection('weeklySchedule').get(),
    db.collection('rotationGroups').get(),
  ]);
  const mats = [];
  matSnap.forEach(d => mats.push({ ...d.data(), id: d.id }));
  global.__allMats = mats;
  const usersById = {};
  userSnap.forEach(d => { const u = { ...d.data(), uid: d.data().uid || d.id, docId: d.id }; usersById[String(u.uid||u.docId)] = u; });
  const gardensByUid = {};
  Object.values(usersById).forEach(u => { gardensByUid[String(u.uid||u.docId)] = u.gardens||[]; });
  const rotGroups = []; rgSnap.forEach(d => rotGroups.push({ id:d.id, ...d.data() }));
  const inGroupUids = new Set();
  rotGroups.forEach(g => (g.instructorUids||[]).forEach(u => inGroupUids.add(String(u))));
  global._rotGroups = rotGroups;

  const wksByRegion = {};
  wksSnap.forEach(d => {
    const wk = d.data();
    const asg = wk.assignments || {};
    Object.entries(asg).forEach(([uid, mid]) => {
      const u = usersById[String(uid)];
      const region = u ? u.region : null;
      if(!region) return;
      if(!wksByRegion[region]) wksByRegion[region] = {};
      if(!wksByRegion[region][d.id]) wksByRegion[region][d.id] = { weekISO:d.id, assignments:{}, holidayOnly:!!wk.holidayOnly, skipped:!!wk.skipped };
      wksByRegion[region][d.id].assignments[uid] = mid;
    });
  });
  // Reconstruct pipeline pool metadata from super-clusters (BFS via linkedGroupIds)
  // For each week and each pipeline-protected sub-group, pool = mats currently assigned to that sub-group's uids.
  const groupById = {}; rotGroups.forEach(g => groupById[g.id]=g);
  const superOf = {}; // groupId → cluster (sorted list of sub-groups)
  const _visited = new Set();
  rotGroups.forEach(g => {
    if(_visited.has(g.id)) return;
    const cluster = [];
    const q = [g.id]; const inC = new Set();
    while(q.length){
      const cur = q.shift();
      if(inC.has(cur)) continue;
      inC.add(cur); _visited.add(cur);
      const gg = groupById[cur]; if(!gg) continue;
      cluster.push(gg);
      (gg.linkedGroupIds||[]).forEach(x => { if(!inC.has(x) && groupById[x]) q.push(x); });
    }
    cluster.forEach(sg => { superOf[sg.id] = cluster; });
  });
  // Identify protected sub-groups: those in a 3-pair (all size 2) or 2+2+3 super-cluster
  const isPipelineProtected = (cluster) => {
    if(!cluster || cluster.length !== 3) return false;
    const sizes = cluster.map(g => (g.instructorUids||[]).length).sort();
    if(sizes.join(',') === '2,2,2') return true;      // 3 pairs
    if(sizes.join(',') === '2,2,3') return true;      // 2 pairs + triple
    return false;
  };
  const pipelineProtectedUids = new Set();
  Object.values(superOf).forEach(cluster => {
    if(isPipelineProtected(cluster)) cluster.forEach(g => (g.instructorUids||[]).forEach(u => pipelineProtectedUids.add(String(u))));
  });
  // Build pipelinePoolByWeek per region
  const pipelinePoolByWeek = {};
  Object.entries(wksByRegion).forEach(([region, wks]) => {
    const proposalWeeks = Object.keys(wks).sort();
    // Track shiftIdx per (superId, subGroupId) — increment when pool changes
    const shiftIdxTrack = {}; // key = superId+':'+subGroupId → { lastPool: '', shiftIdx:-1 }
    const weekInShiftTrack = {}; // key → integer 0..cycleLen-1
    proposalWeeks.forEach(wISO => {
      const assigns = wks[wISO].assignments || {};
      // For each rotation group in this region, if protected, capture pool
      rotGroups.filter(g => g.regionName === region).forEach(sg => {
        const cluster = superOf[sg.id];
        if(!isPipelineProtected(cluster)) return;
        const subUids = (sg.instructorUids||[]).map(String);
        const size = subUids.length;
        const assignedMats = subUids.map(u => assigns[u]).filter(Boolean);
        if(assignedMats.length !== size) return;
        // Pool = distinct mats assigned to this sub-group this week (should be `size` of them)
        const pool = [...new Set(assignedMats)];
        if(pool.length !== size) return;
        const superId = cluster.map(g=>g.id).sort().join('|');
        const key = superId+':'+sg.id;
        const poolStr = pool.slice().sort().join(',');
        if(!shiftIdxTrack[key]) { shiftIdxTrack[key] = { lastPool:'', shiftIdx:-1 }; weekInShiftTrack[key]=0; }
        if(shiftIdxTrack[key].lastPool !== poolStr){
          shiftIdxTrack[key].shiftIdx++;
          shiftIdxTrack[key].lastPool = poolStr;
          weekInShiftTrack[key] = 0;
        } else {
          weekInShiftTrack[key]++;
        }
        const shiftIdx = shiftIdxTrack[key].shiftIdx;
        const weekInShift = weekInShiftTrack[key];
        const pIdx = cluster.slice().sort((a,b)=>((a.pipelineOrder||99)-(b.pipelineOrder||99))||(a.id||'').localeCompare(b.id||'')).findIndex(x=>x.id===sg.id);
        if(!pipelinePoolByWeek[wISO]) pipelinePoolByWeek[wISO] = {};
        subUids.forEach(u => {
          pipelinePoolByWeek[wISO][u] = {
            superId, subGroupId: sg.id, subGroupUids: subUids.slice(),
            poolMatIds: pool.slice(),
            shiftIdx, weekInShift, pIdx,
            cycleLen: size,
            pipelineKind: size===3 ? 'triple2p3' : (cluster.length===3 && cluster.every(g=>(g.instructorUids||[]).length===2) ? '3pair' : 'pair2p3'),
          };
        });
      });
    });
  });
  const perRegion = Object.entries(wksByRegion).map(([region, wks]) => ({
    region,
    proposal: Object.values(wks).sort((a,b)=>a.weekISO.localeCompare(b.weekISO)),
    warnings: [],
    pipelineProtectedUids: [...pipelineProtectedUids],
    pipelinePoolByWeek,
  }));

  const sug = mats.find(m => m.name === 'שוגר גליידר');
  const gita = Object.values(usersById).find(u => (u.name||'').includes('גיטה גפן'));
  const tali = Object.values(usersById).find(u => (u.name||'').includes('טלי דולברג'));
  console.log(`  Gita uid: ${gita ? (gita.uid||gita.docId) : 'NF'}`);
  console.log(`  Tali uid: ${tali ? (tali.uid||tali.docId) : 'NF'}`);
  console.log(`  שוגר גליידר mat id: ${sug ? sug.id : 'NF'}`);
  const check = label => {
    const wN = perRegion.find(r=>r.region===(tali&&tali.region)); const wNw = wN && wN.proposal.find(p=>p.weekISO==='2026-10-11');
    const wS = perRegion.find(r=>r.region===(gita&&gita.region)); const wSw = wS && wS.proposal.find(p=>p.weekISO==='2026-10-11');
    const gMat = wSw && gita ? mats.find(x=>x.id===wSw.assignments[String(gita.uid||gita.docId)]) : null;
    const tMat = wNw && tali ? mats.find(x=>x.id===wNw.assignments[String(tali.uid||tali.docId)]) : null;
    console.log(`  [${label}] Gita → ${gMat?gMat.name:'?'} | Tali → ${tMat?tMat.name:'?'}`);
    return { gMat, tMat };
  };
  check('PRE');
  // Count PRE dup counts for comparison
  const countDups = () => {
    const merged = {};
    perRegion.forEach(rr => rr.proposal.forEach(p => {
      if(!merged[p.weekISO]) merged[p.weekISO] = {};
      Object.entries(p.assignments||{}).forEach(([uid, mid]) => {
        if(!merged[p.weekISO][mid]) merged[p.weekISO][mid] = [];
        merged[p.weekISO][mid].push({ uid, region: rr.region });
      });
    }));
    let realCross=0, realIntra=0, safe=0;
    Object.entries(merged).forEach(([w, byMat]) => {
      Object.entries(byMat).forEach(([mid, holders]) => {
        if(holders.length<2) return;
        const m = mats.find(x=>x.id===mid);
        const regs = new Set(holders.map(h=>h.region));
        if(!_matIsSharedPhysical(m)) safe++;
        else if(regs.size>=2) realCross++;
        else realIntra++;
      });
    });
    return { realCross, realIntra, safe };
  };
  const preDups = countDups();
  console.log(`  PRE dup counts: real cross=${preDups.realCross}, real intra=${preDups.realIntra}, safe generic=${preDups.safe}`);
  // Deep-clone perRegion so we can compare v34-off vs v34-on cleanly
  const clonePerRegion = () => perRegion.map(rr => ({
    region: rr.region,
    proposal: rr.proposal.map(p => ({ weekISO: p.weekISO, assignments: {...p.assignments}, holidayOnly: p.holidayOnly, skipped: p.skipped })),
    warnings: [],
    pipelineProtectedUids: rr.pipelineProtectedUids ? rr.pipelineProtectedUids.slice() : undefined,
    pipelinePoolByWeek: rr.pipelinePoolByWeek,
  }));
  const controlPerRegion = clonePerRegion();
  const controlDups = (() => {
    // Real v33 baseline: pipelineProtectedUids IS populated (so protected
    // cells stay protected), but pipelinePoolByWeek is EMPTY so tier engine
    // has no pool metadata → tier attempts fail → falls through to skip
    // (same as v33 behavior: protected cells unhandled).
    const optsNoTier = {
      materials: mats.filter(m => !m.excludeFromAuto),
      gardensByUid, inGroupUids,
      seasonFits:_matSeasonFits, scoreMaterial:_scoreMaterial,
      monthOfISO:_monthOfISO, holidayDates:HOLIDAYS_5787,
      israeliHolidays:ISRAELI_HOLIDAYS,
      pipelineProtectedUids: [...pipelineProtectedUids],
      pipelinePoolByWeek: {},
    };
    const rC = _crossRegionDedupSwap(controlPerRegion, optsNoTier);
    _temporalSwapDedup(controlPerRegion, optsNoTier);
    let realCross=0, realIntra=0, safe=0;
    const merged={};
    controlPerRegion.forEach(rr => rr.proposal.forEach(p => {
      if(!merged[p.weekISO]) merged[p.weekISO]={};
      Object.entries(p.assignments||{}).forEach(([uid,mid]) => {
        if(!merged[p.weekISO][mid]) merged[p.weekISO][mid]=[];
        merged[p.weekISO][mid].push({uid,region:rr.region});
      });
    }));
    Object.entries(merged).forEach(([w,bm]) => {
      Object.entries(bm).forEach(([mid,holders]) => {
        if(holders.length<2) return;
        const m = mats.find(x=>x.id===mid);
        const regs = new Set(holders.map(h=>h.region));
        if(!_matIsSharedPhysical(m)) safe++;
        else if(regs.size>=2) realCross++;
        else realIntra++;
      });
    });
    return { realCross, realIntra, safe, rC };
  })();
  console.log(`  CONTROL (v33/v32 baseline, tier OFF): cross=${controlDups.realCross}, intra=${controlDups.realIntra} · cr_swaps=${controlDups.rC.swaps}`);
  // Serialize CONTROL's dup set so we can compare with v34
  const controlDupSet = new Set();
  {
    const merged={};
    controlPerRegion.forEach(rr => rr.proposal.forEach(p => {
      if(!merged[p.weekISO]) merged[p.weekISO]={};
      Object.entries(p.assignments||{}).forEach(([uid,mid]) => {
        if(!merged[p.weekISO][mid]) merged[p.weekISO][mid]=[];
        merged[p.weekISO][mid].push({uid,region:rr.region});
      });
    }));
    Object.entries(merged).forEach(([w,bm]) => {
      Object.entries(bm).forEach(([mid,holders]) => {
        if(holders.length<2) return;
        const m = mats.find(x=>x.id===mid);
        const regs = new Set(holders.map(h=>h.region));
        if(_matIsSharedPhysical(m) && regs.size>=2) controlDupSet.add(w+'|'+mid);
      });
    });
  }
  const opts = {
    materials: mats.filter(m => !m.excludeFromAuto),
    gardensByUid, inGroupUids,
    seasonFits:_matSeasonFits, scoreMaterial:_scoreMaterial,
    monthOfISO:_monthOfISO, holidayDates:HOLIDAYS_5787,
    israeliHolidays:ISRAELI_HOLIDAYS,
    pipelineProtectedUids: [...pipelineProtectedUids],
    pipelinePoolByWeek,
  };
  const res = _crossRegionDedupSwap(perRegion, opts);
  console.log(`  cross-region dedup: swaps=${res.swaps} passes=${res.passes} tiers: T1=${res.tierCounts.T1} T2=${res.tierCounts.T2} T3=${res.tierCounts.T3}`);
  const v34Events = res.swapEvents.filter(e => e.tier);
  console.log(`  v34-tier swap events: ${v34Events.length}`);
  v34Events.slice(0,15).forEach(ev => console.log(`    ${ev.msg}`));
  // Report POST cross-region only (before temporal-swap) so we can attribute
  // any new dups to cross-region tiers vs temporal-swap.
  {
    const post_cr = check('POST cross-region only');
    // Count dups
    const m={};
    perRegion.forEach(rr => rr.proposal.forEach(p => {
      if(!m[p.weekISO]) m[p.weekISO]={};
      Object.entries(p.assignments||{}).forEach(([uid,mid]) => {
        if(!m[p.weekISO][mid]) m[p.weekISO][mid]=[];
        m[p.weekISO][mid].push({uid,region:rr.region});
      });
    }));
    let rc=0,ri=0;
    Object.entries(m).forEach(([w,bm]) => {
      Object.entries(bm).forEach(([mid,holders]) => {
        if(holders.length<2) return;
        const mm = mats.find(x=>x.id===mid);
        const regs = new Set(holders.map(h=>h.region));
        if(_matIsSharedPhysical(mm)){ if(regs.size>=2) rc++; else ri++; }
      });
    });
    console.log(`  POST cross-region only: cross=${rc}, intra=${ri}`);
  }
  // Also run temporal-swap to compare with v33 baseline
  const ts = _temporalSwapDedup(perRegion, opts);
  console.log(`  temporal-swap: swaps=${ts.swaps} passes=${ts.passes}`);
  const post = check('POST all');
  const stillDup = post.gMat && post.tMat && sug && post.gMat.id === sug.id && post.tMat.id === sug.id;
  console.log(`  Gita+Tali 2026-10-11 שוגר גליידר: ${stillDup ? '❌ STILL DUP' : '✅ RESOLVED'}`);
  // Total remaining dups
  const merged = {};
  perRegion.forEach(rr => rr.proposal.forEach(p => {
    if(!merged[p.weekISO]) merged[p.weekISO] = {};
    Object.entries(p.assignments||{}).forEach(([uid,mid]) => {
      if(!merged[p.weekISO][mid]) merged[p.weekISO][mid] = [];
      merged[p.weekISO][mid].push({ uid, region:rr.region });
    });
  }));
  let realCross=0, realIntra=0, safe=0;
  Object.entries(merged).forEach(([w, byMat]) => {
    Object.entries(byMat).forEach(([mid, holders]) => {
      if(holders.length<2) return;
      const m = mats.find(x=>x.id===mid);
      const regs = new Set(holders.map(h=>h.region));
      if(!_matIsSharedPhysical(m)) safe++;
      else if(regs.size>=2) realCross++;
      else realIntra++;
    });
  });
  console.log(`  FINAL dup counts: real cross=${realCross}, real intra=${realIntra}, safe generic=${safe}`);
  // Diff v34 vs control
  const v34DupSet = new Set();
  Object.entries(merged).forEach(([w,bm]) => {
    Object.entries(bm).forEach(([mid,holders]) => {
      if(holders.length<2) return;
      const m = mats.find(x=>x.id===mid);
      const regs = new Set(holders.map(h=>h.region));
      if(_matIsSharedPhysical(m) && regs.size>=2) v34DupSet.add(w+'|'+mid);
    });
  });
  const inV34NotControl = [...v34DupSet].filter(x=>!controlDupSet.has(x));
  const inControlNotV34 = [...controlDupSet].filter(x=>!v34DupSet.has(x));
  console.log(`  DIFF vs control: v34-only dups=${inV34NotControl.length}, control-only dups=${inControlNotV34.length}`);
  inV34NotControl.slice(0,10).forEach(k=>{
    const [w,mid]=k.split('|');const m=mats.find(x=>x.id===mid);
    // Print who has this mat this week PRE vs POST-v34, in both regions
    console.log(`    +NEW ${w} "${m?m.name:mid}"`);
    console.log(`      PRE (baseline snapshot):`);
    controlPerRegion.forEach(rr=>{
      const p=rr.proposal.find(pp=>pp.weekISO===w);
      if(!p)return;
      Object.entries(p.assignments||{}).forEach(([uid,mm])=>{if(mm===mid){const u=usersById[String(uid)];console.log(`        [${rr.region}] ${u?u.name:uid.slice(0,8)}`)}});
    });
    console.log(`      POST (v34):`);
    perRegion.forEach(rr=>{
      const p=rr.proposal.find(pp=>pp.weekISO===w);
      if(!p)return;
      Object.entries(p.assignments||{}).forEach(([uid,mm])=>{if(mm===mid){const u=usersById[String(uid)];console.log(`        [${rr.region}] ${u?u.name:uid.slice(0,8)}`)}});
    });
  });
  inControlNotV34.slice(0,10).forEach(k=>{const [w,mid]=k.split('|');const m=mats.find(x=>x.id===mid);console.log(`    -GONE ${w} "${m?m.name:mid}"`);});
  return { stillDup, realCross, realIntra, tierCounts: res.tierCounts };
}

console.log('=== v34 pipeline-aware dedup harness ===');
try{
  testTier1();
  testTier2();
  testTier3();
  testCrossClusterIsolation();
}catch(e){ _failCount++; console.error('exception during synthetic tests:', e); }

(async () => {
  let live = null;
  try{ live = await runLive(); }catch(e){ console.error('live stage error:', e && (e.stack||e.message||e)); }
  console.log(`\n===== SUMMARY =====`);
  console.log(`  synthetic asserts: passed=${_passCount}, failed=${_failCount}`);
  if(live){
    console.log(`  live case Gita+Tali 2026-10-11 שוגר גליידר: ${live.stillDup ? 'STILL DUP' : 'RESOLVED'}`);
    console.log(`  live tier counts: T1=${live.tierCounts.T1} T2=${live.tierCounts.T2} T3=${live.tierCounts.T3}`);
    console.log(`  live final dups: cross=${live.realCross}, intra=${live.realIntra}`);
  }
  process.exit(_failCount ? 1 : 0);
})();
