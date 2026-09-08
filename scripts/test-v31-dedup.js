// v31 dedup test harness — pulls current Firestore state, extracts the dedup
// functions from index.html, and simulates the cross-region post-pass on the
// live per-region proposals to confirm the Tali+Gita 2026-10-11 שוגר גליידר
// case (and other group-locked cases) get resolved.
//
// Runs entirely OFFLINE — never writes to Firestore. Uses the actual dedup
// pass code from index.html via a lightweight window shim.
//
// Expected v31 outcome: Tali (טלי דולברג, צפון) OR Gita (גיטה גפן, דרום) is
// swapped off שוגר גליידר on 2026-10-11; cross-region dup count drops.

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Constants needed by the dedup function (mirrored from index.html — kept in sync).
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
const END_OF_YEAR_MONTHS = [5,6,7];

// Utility mirrors
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
  return _matIsHolidayOnlyMaterial(m); // approximation
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

// Extract the v31 _crossRegionDedupSwap function from index.html and eval it here.
const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const funcStart = html.indexOf('function _crossRegionDedupSwap');
const funcEnd = html.indexOf('\n// Expose for Node harness testing', funcStart);
if(funcStart<0 || funcEnd<0){ console.error('could not find _crossRegionDedupSwap in index.html'); process.exit(1); }
const funcSrc = html.slice(funcStart, funcEnd);
// Provide the globals it references (window, DB.get, getMaterials, _rotGroups, HOLIDAYS_5787).
global.window = {};
global.DB = { get: k => (k==='users' ? [] : []) };
global.getMaterials = () => global.__allMats;
global.getVirtualInstructors = () => [];
global._rotGroups = [];
global._matIsSharedPhysical = _matIsSharedPhysical;
// eslint-disable-next-line no-new-func
const _crossRegionDedupSwap = new Function('opts','__globals',
  `${funcSrc}\n;return _crossRegionDedupSwap;`)(null, {});

(async () => {
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

  // Build per-region proposals from current schedule state, grouping instructors by region.
  const wksByRegion = {}; // {region: {weekISO: {assignments: {uid: matId}}}}
  wksSnap.forEach(d => {
    const wk = d.data();
    const asg = wk.assignments || {};
    Object.entries(asg).forEach(([uid, mid]) => {
      const u = usersById[uid] || Object.values(usersById).find(x => x.uid === uid);
      const region = u ? u.region : null;
      if (!region) return;
      if (!wksByRegion[region]) wksByRegion[region] = {};
      if (!wksByRegion[region][d.id]) wksByRegion[region][d.id] = { weekISO: d.id, assignments: {}, holidayOnly: !!wk.holidayOnly, skipped: !!wk.skipped };
      wksByRegion[region][d.id].assignments[uid] = mid;
    });
  });
  const perRegion = Object.entries(wksByRegion).map(([region, wks]) => ({
    region,
    proposal: Object.values(wks).sort((a,b) => a.weekISO.localeCompare(b.weekISO)),
    warnings: [],
  }));

  // Print pre-state for 2026-10-11
  const printState = label => {
    console.log(`\n===== ${label} =====`);
    perRegion.forEach(rr => {
      const w = rr.proposal.find(p => p.weekISO === '2026-10-11');
      if (!w) return;
      Object.entries(w.assignments).forEach(([uid, mid]) => {
        const u = usersById[uid] || Object.values(usersById).find(x => x.uid === uid);
        const m = mats.find(x => x.id === mid);
        if (m && m.name === 'שוגר גליידר') {
          console.log(`  [${rr.region}] ${u?u.name:uid.slice(0,8)} → שוגר גליידר`);
        }
      });
    });
    // Count cross-region dups (real, not safe)
    const byWeek = {};
    perRegion.forEach(rr => rr.proposal.forEach(p => {
      if (!byWeek[p.weekISO]) byWeek[p.weekISO] = {};
      Object.entries(p.assignments||{}).forEach(([uid, mid]) => {
        if (!byWeek[p.weekISO][mid]) byWeek[p.weekISO][mid] = new Set();
        byWeek[p.weekISO][mid].add(rr.region);
      });
    }));
    let real=0, safe=0;
    Object.entries(byWeek).forEach(([wISO, useByMat]) => {
      Object.entries(useByMat).forEach(([mid, regs]) => {
        if (regs.size < 2) return;
        const m = mats.find(x => x.id === mid);
        if (_matIsSharedPhysical(m)) real++; else safe++;
      });
    });
    console.log(`  cross-region dups: real=${real}, safe(generic)=${safe}, total=${real+safe}`);
  };
  printState('PRE (current Firestore state)');

  // Run v31 cross-region dedup
  const res = _crossRegionDedupSwap(perRegion, {
    materials: mats.filter(m => !m.excludeFromAuto),
    gardensByUid,
    inGroupUids,
    seasonFits: _matSeasonFits,
    scoreMaterial: _scoreMaterial,
    monthOfISO: _monthOfISO,
    holidayDates: HOLIDAYS_5787,
  });

  console.log(`\n===== _crossRegionDedupSwap result =====`);
  console.log(`  swaps: ${res.swaps}, passes: ${res.passes}, remainingDups: ${res.remainingDups.length}`);
  console.log(`\n  first 10 swap events:`);
  res.swapEvents.slice(0,10).forEach(ev => {
    const u = usersById[ev.uid] || Object.values(usersById).find(x => x.uid === ev.uid);
    console.log(`    ${ev.weekISO} · [${ev.region}] ${u?u.name:ev.uid.slice(0,8)} · ${ev.msg.replace(/^🌍 cross-region dedup: [a-zA-Z0-9]+ /,'')}`);
  });
  console.log(`\n  remaining dups (up to 10):`);
  res.remainingDups.slice(0,10).forEach(d => {
    console.log(`    ${d.weekISO} · "${d.mat}" · [${d.regions.join(', ')}] · ${d.uids} מדריכות (${d.swappable} להחלפה)`);
  });

  printState('POST v31 dedup');

  // Specifically: is Tali OR Gita still on שוגר גליידר on 2026-10-11?
  const sug = mats.find(m => m.name === 'שוגר גליידר');
  const tali = usersById['s50KJerL7IggQFs3hwBZy9behZE3'];
  const gita = usersById['loUz3D3jgNhsc9LdK8e2m1uIxyv1'];
  console.log(`\n===== SPECIFIC CASE VERIFICATION =====`);
  const north = perRegion.find(r => r.region === tali.region);
  const south = perRegion.find(r => r.region === gita.region);
  const wN = north ? north.proposal.find(p => p.weekISO === '2026-10-11') : null;
  const wS = south ? south.proposal.find(p => p.weekISO === '2026-10-11') : null;
  const taliMat = wN ? mats.find(x => x.id === wN.assignments['s50KJerL7IggQFs3hwBZy9behZE3']) : null;
  const gitaMat = wS ? mats.find(x => x.id === wS.assignments['loUz3D3jgNhsc9LdK8e2m1uIxyv1']) : null;
  console.log(`  טלי דולברג [צפון] → ${taliMat ? taliMat.name : '(none)'}`);
  console.log(`  גיטה גפן [דרום] → ${gitaMat ? gitaMat.name : '(none)'}`);
  const stillDup = taliMat && gitaMat && taliMat.id === sug.id && gitaMat.id === sug.id;
  console.log(`  ${stillDup ? '❌ STILL DUPLICATE' : '✅ CASE RESOLVED (at least one swapped)'}`);

  process.exit(stillDup ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
