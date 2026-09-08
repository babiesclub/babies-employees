// v32 temporal-swap dedup test harness.
//
// Two-stage validation:
//   1. SYNTHETIC — 3-week toy world, 3 reptile mats {שממית, צב, זיקית},
//      instructor A holds שממית in week 1 while instructor B ALSO holds
//      שממית in the same week. A has צב/זיקית in future weeks. Expected:
//      v32 swaps A's week-1 שממית with a future week's reptile → dup gone,
//      iron rule preserved (A still sees all three reptiles once each).
//
//   2. LIVE — pull the Firestore snapshot, feed all per-region proposals
//      through _crossRegionDedupSwap (v31), then _temporalSwapDedup (v32),
//      and report:
//        - swaps performed by v32
//        - is the 2026-10-04 שממית מנומרת dup resolved?
//        - remaining cross-region + intra-region dup counts.
//
// Runs entirely OFFLINE — never writes to Firestore.

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Mirrored constants + helpers (same as scripts/test-v31-dedup.js).
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
  '2027-08-06':{name:'קיץ א',fullWeek:true},
  '2027-08-15':{name:'קיץ ב',fullWeek:true},
  '2027-08-22':{name:'קיץ ג',fullWeek:true},
  '2027-08-29':{name:'קיץ ד',fullWeek:true},
};
const END_OF_YEAR_MONTHS = [5,6,7];

function _monthOfISO(iso){ return parseInt(iso.split('-')[1],10)-1; }
function _isWinter(m){ return m===11||m===0||m===1; }
function _isoDiffDays(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }
function _matIsEndOfYear(m){
  const END = ['דגי','לובסטר','חתולי ים','דג','דגים'];
  const n = String(m.name||'').trim();
  return END.some(k => n === k || n.startsWith(k+' ') || n.startsWith(k+'-') || n.startsWith(k+'–') || n.startsWith(k+'—'));
}
function _matIsHolidayOnlyMaterial(m){
  const n = String(m.name||'');
  return /דבורה - דבש|ראש השנה|פורים|טווס|פסח|עצמאות/.test(n);
}
function _matIsHolidayOnlyFor(m, weekISO){
  if(!HOLIDAY_ONLY_WEEKS[weekISO]) return false;
  return _matIsHolidayOnlyMaterial(m);
}
function _matSeasonFits(mat, weekISO, holidayDates){
  if(HOLIDAY_ONLY_WEEKS[weekISO] && !_matIsHolidayOnlyFor(mat, weekISO)) return false;
  if(_matIsHolidayOnlyMaterial(mat) && !_matIsHolidayOnlyFor(mat, weekISO)) return false;
  if(_matIsEndOfYear(mat) && !END_OF_YEAR_MONTHS.includes(_monthOfISO(weekISO))) return false;
  const monthIdx=_monthOfISO(weekISO);
  const catInfo=MAT_CATEGORIES[mat.category]||{};
  if(catInfo.winterRisky && _isWinter(monthIdx)) return false;
  const seas=mat.seasonality||'any';
  if(seas==='any') return true;
  if(SEASON_HOLIDAY_WINDOWS[seas]){
    const w=SEASON_HOLIDAY_WINDOWS[seas];
    const hDate=holidayDates[w.holidayKey]; if(!hDate) return true;
    const daysUntil=_isoDiffDays(weekISO, hDate);
    return daysUntil>=0 && daysUntil<=w.daysBefore;
  }
  const seasDef=MAT_SEASONALITY[seas];
  if(seasDef && seasDef.months && !seasDef.months.includes(monthIdx)) return false;
  return true;
}
function _matSeasonFitsRelaxed(mat, weekISO, holidayDates){
  if(HOLIDAY_ONLY_WEEKS[weekISO] && !_matIsHolidayOnlyFor(mat, weekISO)) return false;
  if(_matIsHolidayOnlyMaterial(mat) && !_matIsHolidayOnlyFor(mat, weekISO)) return false;
  if(_matIsEndOfYear(mat) && !END_OF_YEAR_MONTHS.includes(_monthOfISO(weekISO))) return false;
  const monthIdx=_monthOfISO(weekISO);
  const catInfo=MAT_CATEGORIES[mat.category]||{};
  if(catInfo.winterRisky && _isWinter(monthIdx)) return false;
  const seas=mat.seasonality||'any';
  if(seas==='any') return true;
  if(SEASON_HOLIDAY_WINDOWS[seas]){
    const w=SEASON_HOLIDAY_WINDOWS[seas];
    const hDate=holidayDates[w.holidayKey]; if(!hDate) return true;
    const daysUntil=_isoDiffDays(weekISO, hDate);
    return daysUntil>=0 && daysUntil<=(w.daysBefore+21);
  }
  const seasDef=MAT_SEASONALITY[seas];
  if(seasDef && seasDef.months){
    const expanded=new Set();
    seasDef.months.forEach(m=>{expanded.add(m);expanded.add((m+11)%12);expanded.add((m+1)%12)});
    if(!expanded.has(monthIdx)) return false;
  }
  return true;
}
function _matIsSharedPhysical(mat){
  if(!mat) return false;
  if(mat.category === 'generic') return false;
  const animal=(mat.animalName||'').trim();
  if(!animal) return false;
  return true;
}
function _scoreMaterial(mat, ctx){
  let score=0;
  const animal=(mat.animalName||mat.name||'').trim();
  const gardens=ctx.gardens||[];
  const notSeen=gardens.filter(g=>!ctx.gardensSeen[g]||!ctx.gardensSeen[g].has(animal)).length;
  score += notSeen*100;
  if(ctx.lastCategory && mat.category===ctx.lastCategory) score -= 20;
  if(mat.seasonality && mat.seasonality!=='any') score += 8;
  if(ctx.weekISO && HOLIDAY_ONLY_WEEKS[ctx.weekISO] && _matIsHolidayOnlyFor(mat, ctx.weekISO)) score += 300;
  if(ctx.globallyUsed && !ctx.globallyUsed.has(mat.id)) score += 120;
  if(ctx.sharedThisWeek){
    const st=ctx.sharedThisWeek;
    const cnt = (typeof st.get==='function') ? (st.get(mat.id)||0) : (st.has(mat.id)?1:0);
    if(cnt===1) score -= 50;
    else if(cnt===2) score -= 150;
    else if(cnt>=3) score -= 300;
  }
  return score;
}

// Extract _temporalSwapDedup from index.html and eval it here.
const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function extractFunction(name, endMarker){
  const funcStart = html.indexOf('function '+name);
  const funcEnd = html.indexOf('\n// Expose for Node harness testing', funcStart);
  const funcEnd2 = html.indexOf('\nif(typeof window!==', funcStart);
  const stop = (funcEnd>=0 ? funcEnd : Infinity);
  const stop2 = (funcEnd2>=0 ? funcEnd2 : Infinity);
  const cut = Math.min(stop, stop2);
  if(funcStart<0 || !isFinite(cut)){ throw new Error('could not find '+name+' in index.html'); }
  return html.slice(funcStart, cut);
}
const crSrc = extractFunction('_crossRegionDedupSwap');
const tsSrc = extractFunction('_temporalSwapDedup');

// Set up globals the extracted functions need.
global.window = {};
global.DB = { get: k => (k==='users' ? [] : []) };
global.getMaterials = () => global.__allMats;
global.getVirtualInstructors = () => [];
global._rotGroups = [];
global._matIsSharedPhysical = _matIsSharedPhysical;
global._matIsHolidayOnlyMaterial = _matIsHolidayOnlyMaterial;
global._matIsHolidayOnlyFor = _matIsHolidayOnlyFor;
global._matIsEndOfYear = _matIsEndOfYear;
global.HOLIDAYS_5787 = HOLIDAYS_5787;
global.HOLIDAY_ONLY_WEEKS = HOLIDAY_ONLY_WEEKS;
global.ISRAELI_HOLIDAYS = ISRAELI_HOLIDAYS;
global._matSeasonFits = _matSeasonFits;
global._matSeasonFitsRelaxed = _matSeasonFitsRelaxed;
global._monthOfISO = _monthOfISO;
global._scoreMaterial = _scoreMaterial;
global.MAT_CATEGORIES = MAT_CATEGORIES;

// eslint-disable-next-line no-new-func
const _crossRegionDedupSwap = new Function(
  `${crSrc}\n;return _crossRegionDedupSwap;`
)();
// eslint-disable-next-line no-new-func
const _temporalSwapDedup = new Function(
  `${tsSrc}\n;return _temporalSwapDedup;`
)();

// ---------- STAGE 1: SYNTHETIC ----------
function runSynthetic(){
  console.log('\n===== STAGE 1: SYNTHETIC =====');
  const mats = [
    { id:'m_smamit', name:'שממית', animalName:'שממית', category:'reptile', seasonality:'any' },
    { id:'m_tsav',   name:'צב',    animalName:'צב',    category:'reptile', seasonality:'any' },
    { id:'m_zikit',  name:'זיקית', animalName:'זיקית', category:'reptile', seasonality:'any' },
    { id:'m_dog',    name:'כלב',   animalName:'כלב',   category:'generic', seasonality:'any' },
  ];
  global.__allMats = mats;
  // A is in 'north', B is in 'south'. Free-agents (no rotation group).
  // Week 1: A=שממית, B=שממית  (dup cross-region on shared physical)
  // Week 2: A=צב
  // Week 3: A=זיקית
  const perRegion = [
    { region:'north', proposal:[
        { weekISO:'2026-10-04', assignments:{ 'A':'m_smamit' } },
        { weekISO:'2026-10-11', assignments:{ 'A':'m_tsav'   } },
        { weekISO:'2026-10-18', assignments:{ 'A':'m_zikit'  } },
      ], warnings:[] },
    { region:'south', proposal:[
        { weekISO:'2026-10-04', assignments:{ 'B':'m_smamit' } },
        { weekISO:'2026-10-11', assignments:{ 'B':'m_dog'    } },
        { weekISO:'2026-10-18', assignments:{ 'B':'m_dog'    } },
      ], warnings:[] },
  ];
  const gardensByUid = { A:['gan1'], B:['gan2'] };
  const inGroupUids = new Set();
  const opts = { materials: mats, gardensByUid, inGroupUids,
                 seasonFits:_matSeasonFits, scoreMaterial:_scoreMaterial,
                 monthOfISO:_monthOfISO, holidayDates:HOLIDAYS_5787,
                 israeliHolidays: ISRAELI_HOLIDAYS };

  // Run v32 (v31 wouldn't help — B has no reptile alternatives and A's seen-set is full).
  const res = _temporalSwapDedup(perRegion, opts);
  console.log(`  swaps=${res.swaps}, passes=${res.passes}, remaining=${res.remainingDups.length}`);
  res.swapEvents.forEach(ev => console.log(`    ${ev.msg}`));

  // Verify: A's week-1 mat is now צב or זיקית (a reptile from her future). B's stays שממית.
  const wk1_A = perRegion[0].proposal[0].assignments.A;
  const wk1_B = perRegion[1].proposal[0].assignments.B;
  const A_year = perRegion[0].proposal.map(w => w.assignments.A).sort();
  const expectedYear = ['m_smamit','m_tsav','m_zikit'].sort();

  let pass = true;
  if(wk1_A === 'm_smamit' && wk1_B === 'm_smamit'){
    console.log('  ❌ FAIL — dup NOT broken');
    pass = false;
  } else {
    console.log(`  ✅ dup broken: A[wk1]=${wk1_A}, B[wk1]=${wk1_B}`);
  }
  // Iron rule: A must still see שממית + צב + זיקית each exactly once
  if(JSON.stringify(A_year) !== JSON.stringify(expectedYear)){
    console.log(`  ❌ FAIL — iron rule broken. A's year: ${A_year.join(',')}`);
    pass = false;
  } else {
    console.log(`  ✅ iron rule preserved — A sees {שממית, צב, זיקית} exactly once each`);
  }
  return pass;
}

// ---------- STAGE 2: LIVE FIRESTORE ----------
async function runLive(){
  console.log('\n===== STAGE 2: LIVE FIRESTORE =====');
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
  userSnap.forEach(d => { usersById[d.id] = { ...d.data(), uid: d.data().uid || d.id, docId: d.id }; });
  const gardensByUid = {};
  Object.values(usersById).forEach(u => { gardensByUid[String(u.uid||u.docId)] = u.gardens||[]; });
  const rotGroups = [];
  rgSnap.forEach(d => rotGroups.push({ id:d.id, ...d.data() }));
  const inGroupUids = new Set();
  rotGroups.forEach(g => (g.instructorUids||[]).forEach(u => inGroupUids.add(String(u))));
  global._rotGroups = rotGroups;

  const wksByRegion = {};
  wksSnap.forEach(d => {
    const wk = d.data();
    const asg = wk.assignments || {};
    Object.entries(asg).forEach(([uid, mid]) => {
      const u = usersById[uid] || Object.values(usersById).find(x => x.uid === uid);
      const region = u ? u.region : null;
      if (!region) return;
      if (!wksByRegion[region]) wksByRegion[region] = {};
      if (!wksByRegion[region][d.id]) wksByRegion[region][d.id] = {
        weekISO: d.id, assignments: {},
        holidayOnly: !!wk.holidayOnly, skipped: !!wk.skipped,
      };
      wksByRegion[region][d.id].assignments[uid] = mid;
    });
  });
  const perRegion = Object.entries(wksByRegion).map(([region, wks]) => ({
    region,
    proposal: Object.values(wks).sort((a,b) => a.weekISO.localeCompare(b.weekISO)),
    warnings: [],
  }));

  const opts = {
    materials: mats.filter(m => !m.excludeFromAuto),
    gardensByUid,
    inGroupUids,
    seasonFits: _matSeasonFits,
    scoreMaterial: _scoreMaterial,
    monthOfISO: _monthOfISO,
    holidayDates: HOLIDAYS_5787,
    israeliHolidays: ISRAELI_HOLIDAYS,
  };

  // helper: count real dups (shared physical) + safe dups (generic) in current perRegion state
  function countDups(){
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
        if(holders.length < 2) return;
        const m = mats.find(x => x.id === mid);
        const regs = new Set(holders.map(h => h.region));
        if(!_matIsSharedPhysical(m)) safe++;
        else if(regs.size >= 2) realCross++;
        else realIntra++;
      });
    });
    return { realCross, realIntra, safe };
  }

  const namesOfSmamit = new Set(['שממית','שממית מנומרת']);
  function reportSmamit(label){
    console.log(`  --- ${label} ---`);
    perRegion.forEach(rr => {
      const w = rr.proposal.find(p => p.weekISO === '2026-10-04');
      if(!w) return;
      Object.entries(w.assignments).forEach(([uid, mid]) => {
        const m = mats.find(x => x.id === mid);
        if(!m || !namesOfSmamit.has(m.name)) return;
        const u = usersById[uid] || Object.values(usersById).find(x => x.uid === uid);
        console.log(`    [${rr.region}] ${u?u.name:uid.slice(0,8)} → ${m.name}`);
      });
    });
    const d = countDups();
    console.log(`    dups: cross-region=${d.realCross}, intra-region=${d.realIntra}, safe(generic)=${d.safe}`);
  }

  reportSmamit('PRE v31');
  const cr = _crossRegionDedupSwap(perRegion, opts);
  console.log(`  v31 result: swaps=${cr.swaps}, passes=${cr.passes}, remaining=${cr.remainingDups.length}`);
  reportSmamit('POST v31 / PRE v32');
  const ts = _temporalSwapDedup(perRegion, opts);
  console.log(`  v32 result: swaps=${ts.swaps}, passes=${ts.passes}, remaining=${ts.remainingDups.length}`);
  console.log(`  first 15 v32 swap events:`);
  ts.swapEvents.slice(0,15).forEach(ev => {
    const u = usersById[ev.uid] || Object.values(usersById).find(x => x.uid === ev.uid);
    console.log(`    ${ev.weekA} ↔ ${ev.weekB} · [${ev.region}] ${u?u.name:ev.uid.slice(0,8)} · ${ev.msg}`);
  });
  reportSmamit('POST v32');

  // Specific case: 2026-10-04 שממית מנומרת between נאווה שולמן and נטלי בנעים
  const smamitMenumeret = mats.find(m => m.name === 'שממית מנומרת');
  const naavaEntry = Object.values(usersById).find(u => (u.name||'').includes('נאווה שולמן'));
  const nataliEntry = Object.values(usersById).find(u => (u.name||'').includes('נטלי בנעים'));
  console.log(`\n  Specific case identifiers:`);
  console.log(`    שממית מנומרת mat.id = ${smamitMenumeret ? smamitMenumeret.id : 'NOT FOUND'}`);
  console.log(`    נאווה שולמן uid = ${naavaEntry ? (naavaEntry.uid||naavaEntry.docId) : 'NOT FOUND'}`);
  console.log(`    נטלי בנעים uid = ${nataliEntry ? (nataliEntry.uid||nataliEntry.docId) : 'NOT FOUND'}`);
  let stillDup = false;
  if(smamitMenumeret && naavaEntry && nataliEntry){
    let naavaMat = null, nataliMat = null;
    perRegion.forEach(rr => {
      const w = rr.proposal.find(p => p.weekISO === '2026-10-04');
      if(!w) return;
      const nuid = String(naavaEntry.uid || naavaEntry.docId);
      const tuid = String(nataliEntry.uid || nataliEntry.docId);
      if(w.assignments[nuid]) naavaMat = mats.find(x => x.id === w.assignments[nuid]);
      if(w.assignments[tuid]) nataliMat = mats.find(x => x.id === w.assignments[tuid]);
    });
    console.log(`    נאווה [${naavaEntry.region}] 2026-10-04 → ${naavaMat ? naavaMat.name : '(none)'}`);
    console.log(`    נטלי  [${nataliEntry.region}] 2026-10-04 → ${nataliMat ? nataliMat.name : '(none)'}`);
    stillDup = !!(naavaMat && nataliMat && naavaMat.id === smamitMenumeret.id && nataliMat.id === smamitMenumeret.id);
    console.log(`    ${stillDup ? '❌ STILL DUP' : '✅ 2026-10-04 שממית dup RESOLVED (or was never a dup after v31)'}`);
  }

  const d = countDups();
  console.log(`\n  FINAL: real cross-region dups=${d.realCross}, real intra-region dups=${d.realIntra}, safe(generic)=${d.safe}`);
  return { stillDup, dups: d, v32Swaps: ts.swaps };
}

(async () => {
  try {
    const syn = runSynthetic();
    if(!syn){ console.log('\n❌ synthetic failed — bailing before live check'); process.exit(1); }
    const live = await runLive();
    console.log('\n===== DONE =====');
    console.log(`  synthetic: ${syn ? 'PASS' : 'FAIL'}`);
    console.log(`  v32 live swaps: ${live.v32Swaps}`);
    console.log(`  2026-10-04 שממית מנומרת still dup? ${live.stillDup ? 'YES' : 'NO'}`);
    console.log(`  remaining real dups: cross=${live.dups.realCross}, intra=${live.dups.realIntra}`);
    process.exit(0);
  } catch(e){
    console.error(e);
    process.exit(1);
  }
})();
