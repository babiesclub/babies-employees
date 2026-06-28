// Regression test for camp Excel parser.
// Extracts the current parser logic from index.html (kept in sync manually).
// Runs against all known camp files and saves a snapshot.
//
// Usage:
//   node _regression_baseline.js              -> prints summary
//   node _regression_baseline.js --save       -> saves baseline.json
//   node _regression_baseline.js --compare    -> compares to baseline.json
const XLSX=require('xlsx');
const fs=require('fs');
const path=require('path');

// ==== PARSERS (mirrors index.html — keep in sync) ====

function _ciParseDayHeader(text){const s=String(text||'').replace(/\s+/g,' ').trim();if(/\d{1,2}:\d{2}/.test(s))return null;const dateMatch=s.match(/(?:^|[^\d])(\d{1,2})[\.\/](\d{1,2})(?:[\.\/](\d{2,4}))?(?:$|[^\d])/);if(!dateMatch)return null;const day=parseInt(dateMatch[1],10);const month=parseInt(dateMatch[2],10);if(day<1||day>31||month<1||month>12)return null;return{day:String(day).padStart(2,'0'),month:String(month).padStart(2,'0'),year:dateMatch[3]||null,raw:s}}

function _ciParseSessionCell(text){if(!text)return null;const raw=String(text).trim();if(!raw)return null;const toMin=(t)=>{const[h,m]=t.split(':').map(Number);return h*60+m};const lines=raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(lines.some(l=>l.startsWith('🏠'))){let _gn='',_st=null,_et=null,_gc=1,_an='',_addr='',_phone='',_no='',_lastKey='';for(const line of lines){if(line.startsWith('🏠')){let _gp=line.slice('🏠'.length).trim();const _tm=_gp.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);if(_tm){_st=_tm[1];_et=_tm[2];_gp=_gp.replace(_tm[0],'').trim()}_gn=_gp;_lastKey='gn'}else if(line.startsWith('📍')){_addr=line.slice('📍'.length).trim();_lastKey='addr'}else if(line.startsWith('🕐')){const t=line.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);if(t){_st=t[1];_et=t[2]}_lastKey='time'}else if(line.startsWith('👥')){const g=line.match(/(\d+)/);if(g)_gc=parseInt(g[1],10)||1;_lastKey='grp'}else if(line.startsWith('✨')){_an=line.slice('✨'.length).trim();_lastKey='an'}else if(line.startsWith('📞')){_phone=line.slice('📞'.length).trim();_lastKey='phone'}else if(line.startsWith('📝')){_no=line.slice('📝'.length).trim();_lastKey='no'}else{const t=line.trim();if(!t)continue;if(_lastKey==='gn')_gn+=' '+t;else if(_lastKey==='addr')_addr+=' '+t;else if(_lastKey==='an')_an+=' '+t;else if(_lastKey==='phone')_phone+=' '+t;else if(_lastKey==='no')_no+=' '+t}}if(!_gn||!_st)return null;return{startTime:_st,endTime:_et,durationMinutes:toMin(_et)-toMin(_st),gardenName:_gn,address:_addr,groupsCount:_gc,activityName:_an}}let timeIdx=-1,startTime=null,endTime=null,gardenName='',address='',groupsCount=1;for(let i=0;i<lines.length;i++){const m=lines[i].match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/);if(m){timeIdx=i;startTime=m[1];endTime=m[2];break}}if(timeIdx>=0){const otherLines=lines.filter((_,i)=>i!==timeIdx);gardenName=otherLines[0]||'';address=otherLines.slice(1).join(', ')||'';const gm=raw.match(/(\d+)\s*(?:קבוצות?|קב'?|גנים|גן(?!\s*[֐-׿]))/);if(gm)groupsCount=parseInt(gm[1],10)||1;gardenName=gardenName.replace(/\s*\d+\s*(?:קבוצות?|קב'?|גנים|גן(?!\s*[֐-׿]))\s*/g,' ').trim()}else{const tm=raw.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);if(!tm)return null;startTime=tm[1];endTime=tm[2];let rest=raw.slice(raw.indexOf(tm[0])+tm[0].length).trim();const gm=rest.match(/(\d+)\s*(?:קבוצות?|קב'?|גנים|גן(?!\s*[֐-׿]))/);if(gm)groupsCount=parseInt(gm[1],10)||1;let gPart=rest,aPart='';const dashRe=/\s[-–—]\s/;const dashMatch=rest.match(dashRe);if(dashMatch&&dashMatch.index>0){gPart=rest.slice(0,dashMatch.index).trim();aPart=rest.slice(dashMatch.index+dashMatch[0].length).trim()}gardenName=gPart.replace(/\s*\d+\s*(?:קבוצות?|קב'?|גנים|גן(?!\s*[֐-׿]))\s*/g,' ').replace(/\s+/g,' ').trim();address=aPart}if(!gardenName)return null;return{startTime,endTime,gardenName,address,groupsCount}}

// ==== FORMAT 1: weekly block (most files) ====
function parseWeeklyBlocks(rows){
  const sessions=[];
  let curDayCols=null;
  for(let r=0;r<rows.length;r++){
    const row=rows[r]||[];
    const rowDayCols=[];
    row.forEach((h,idx)=>{const parsed=_ciParseDayHeader(h);if(parsed)rowDayCols.push({idx,...parsed})});
    if(rowDayCols.length>=2){curDayCols=rowDayCols;continue}
    if(!curDayCols)continue;
    for(const dc of curDayCols){
      const cell=row[dc.idx];
      const parsed=_ciParseSessionCell(cell);
      if(!parsed||!parsed.gardenName)continue;
      sessions.push({date:dc.month+'-'+dc.day,startTime:parsed.startTime,endTime:parsed.endTime,gardenName:parsed.gardenName,address:parsed.address||'',groupsCount:parsed.groupsCount||1});
    }
  }
  return sessions;
}

// ==== FORMAT 2: row-per-session (NEW — Kivunim) ====
// Header row contains: יום, תאריך, שעה, שם המסגרת, כתובת
// Each subsequent row is one session. Day/date inherited from above if blank.
function parseRowPerSession(rows){
  let headerRowIdx=-1, colDay=-1, colDate=-1, colTime=-1, colGarden=-1, colAddr=-1;
  for(let r=0;r<Math.min(rows.length,10);r++){
    const row=rows[r]||[];
    let d=-1,da=-1,t=-1,g=-1,a=-1;
    row.forEach((c,j)=>{
      const v=String(c||'').trim();
      if(v==='יום')d=j;
      else if(v==='תאריך')da=j;
      else if(v==='שעה'||v==='שעת התחלה')t=j;
      else if(/שם\s*המסגרת|שם\s*הגן|מסגרת|^גן$/.test(v)&&g<0)g=j;
      else if(/כתובת/.test(v))a=j;
    });
    if(t>=0 && g>=0){headerRowIdx=r;colDay=d;colDate=da;colTime=t;colGarden=g;colAddr=a;break}
  }
  if(headerRowIdx<0)return [];
  const sessions=[];
  let curDay='', curDate='', curGarden='', curAddr='';
  const toMin=t=>{const[h,m]=t.split(':').map(Number);return h*60+m};
  const fromMin=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
  for(let r=headerRowIdx+1;r<rows.length;r++){
    const row=rows[r]||[];
    const dayVal=colDay>=0?String(row[colDay]||'').trim():'';
    const dateValRaw=colDate>=0?String(row[colDate]||'').trim():'';
    const isNewDateBlock=!!dayVal||(!!dateValRaw&&/\d{1,2}[\.\/]\d{1,2}/.test(dateValRaw));
    if(dayVal)curDay=dayVal;
    if(dateValRaw){const m=dateValRaw.match(/(\d{1,2})[\.\/](\d{1,2})/);if(m)curDate=String(m[1]).padStart(2,'0')+'/'+String(m[2]).padStart(2,'0')}
    if(isNewDateBlock){curGarden='';curAddr=''}
    const timeStr=String(row[colTime]||'').trim();
    const gardenRaw=String(row[colGarden]||'').trim();
    if(gardenRaw)curGarden=gardenRaw;
    const addrRaw=colAddr>=0?String(row[colAddr]||'').trim():'';
    if(addrRaw)curAddr=addrRaw;
    if(!timeStr||!curGarden||!curDate)continue;
    const tm=timeStr.match(/(\d{1,2}):(\d{2})\s*(?:[-–—]\s*(\d{1,2}):(\d{2}))?/);
    if(!tm)continue;
    const startTime=tm[1].padStart(2,'0')+':'+tm[2];
    let endTime=tm[3]?(tm[3].padStart(2,'0')+':'+tm[4]):null;
    sessions.push({date:curDate.split('/').reverse().join('-'),startTime,endTime,gardenName:curGarden,address:curAddr,groupsCount:1,_day:curDay});
  }
  for(let i=0;i<sessions.length;i++){
    if(sessions[i].endTime)continue;
    const next=sessions[i+1];
    if(next&&next.date===sessions[i].date){
      const gap=toMin(next.startTime)-toMin(sessions[i].startTime);
      sessions[i].endTime = gap>=30 && gap<=90 ? next.startTime : fromMin(toMin(sessions[i].startTime)+40);
    }else{
      sessions[i].endTime = fromMin(toMin(sessions[i].startTime)+40);
    }
  }
  return sessions;
}

// ==== DISPATCHER ====
const FORMATS=[
  {name:'row-per-session',tryParse:parseRowPerSession},
  {name:'weekly-blocks',tryParse:parseWeeklyBlocks},
];

function parseFile(filepath){
  const wb=XLSX.readFile(filepath,{cellDates:false});
  const allSessions=[];
  let formatUsed='';
  for(const sn of wb.SheetNames){
    const ws=wb.Sheets[sn];
    const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:false,blankrows:false});
    for(const fmt of FORMATS){
      const result=fmt.tryParse(rows);
      if(result&&result.length){
        allSessions.push(...result);
        formatUsed=fmt.name;
        break;
      }
    }
  }
  return {formatUsed,sessions:allSessions};
}

// ==== RUN ON ALL FILES ====
const BASE='C:\\Users\\David\\שיר דיין\\Shared - Documents\\קייטנות קיץ\\כל השיבוצים לקייטנות קיץ';
const files=[];
function scan(dir){
  const entries=fs.readdirSync(dir,{withFileTypes:true});
  for(const e of entries){
    if(e.isDirectory()){scan(path.join(dir,e.name));}
    else if(e.name.endsWith('.xlsx')&&!e.name.startsWith('~$'))files.push(path.join(dir,e.name));
  }
}
scan(BASE);

const baseline={};
files.forEach(f=>{
  try{
    const r=parseFile(f);
    const rel=path.relative(BASE,f);
    const gardens=Array.from(new Set(r.sessions.map(s=>s.gardenName).filter(Boolean))).sort();
    const totalGroups=r.sessions.reduce((s,x)=>s+(x.groupsCount||1),0);
    baseline[rel]={format:r.formatUsed,sessionCount:r.sessions.length,gardenCount:gardens.length,totalGroups,gardens};
    console.log(rel.padEnd(70),'|',r.formatUsed.padEnd(20),'|',r.sessions.length+' ביקורים','|',gardens.length+' גנים','|',totalGroups+' קבוצות');
  }catch(e){
    console.error('ERROR',f,':',e.message);
    baseline[path.relative(BASE,f)]={error:e.message};
  }
});

if(process.argv.includes('--save')){
  fs.writeFileSync(__dirname+'/baseline.json',JSON.stringify(baseline,null,2));
  console.log('\n✓ Saved baseline.json');
}
if(process.argv.includes('--compare')){
  const prev=JSON.parse(fs.readFileSync(__dirname+'/baseline.json','utf8'));
  let diffCount=0;
  for(const k of Object.keys({...prev,...baseline})){
    const a=prev[k],b=baseline[k];
    if(JSON.stringify(a)!==JSON.stringify(b)){
      diffCount++;
      console.log('\n⚠ DIFF',k);
      console.log('  prev:',JSON.stringify(a));
      console.log('  curr:',JSON.stringify(b));
    }
  }
  console.log(diffCount?`\n❌ ${diffCount} files differ from baseline`:'\n✓ All files match baseline');
}
