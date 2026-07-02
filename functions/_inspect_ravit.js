const XLSX=require('xlsx');
const path='C:\\Users\\David\\שיר דיין\\Shared - Documents\\קייטנות קיץ\\כל השיבוצים לקייטנות קיץ\\פיצול_גליונות_ויבנה_מתוקן\\שיבוצים מענבל_מנוקה_רווית.xlsx';

function _ciParseDayHeader(text){const s=String(text||'').replace(/\s+/g,' ').trim();if(/\d{1,2}:\d{2}/.test(s))return null;const dateMatch=s.match(/(?:^|[^\d])(\d{1,2})[\.\/](\d{1,2})(?:[\.\/](\d{2,4}))?(?:$|[^\d])/);if(!dateMatch)return null;const day=parseInt(dateMatch[1],10);const month=parseInt(dateMatch[2],10);if(day<1||day>31||month<1||month>12)return null;return{day:String(day).padStart(2,'0'),month:String(month).padStart(2,'0'),year:dateMatch[3]||null,raw:s}}

function _ciParseSessionCell(text){if(!text)return null;const raw=String(text).trim();if(!raw)return null;const toMin=(t)=>{const[h,m]=t.split(':').map(Number);return h*60+m};const lines=raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(lines.some(l=>l.startsWith('🏠'))){let _gn='',_st=null,_et=null,_gc=1,_an='',_addr='',_phone='',_no='',_lastKey='';for(const line of lines){if(line.startsWith('🏠')){let _gp=line.slice('🏠'.length).trim();const _tm=_gp.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);if(_tm){_st=_tm[1];_et=_tm[2];_gp=_gp.replace(_tm[0],'').trim()}_gn=_gp;_lastKey='gn'}else if(line.startsWith('📍')){_addr=line.slice('📍'.length).trim();_lastKey='addr'}else if(line.startsWith('🕐')){const t=line.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);if(t){_st=t[1];_et=t[2]}_lastKey='time'}else if(line.startsWith('👥')){const g=line.match(/(\d+)/);if(g)_gc=parseInt(g[1],10)||1;_lastKey='grp'}else if(line.startsWith('✨')){_an=line.slice('✨'.length).trim();_lastKey='an'}else if(line.startsWith('📞')){_phone=line.slice('📞'.length).trim();_lastKey='phone'}else if(line.startsWith('📝')){_no=line.slice('📝'.length).trim();_lastKey='no'}else{const t=line.trim();if(!t)continue;if(_lastKey==='gn')_gn+=' '+t;else if(_lastKey==='addr')_addr+=' '+t;else if(_lastKey==='an')_an+=' '+t;else if(_lastKey==='phone')_phone+=' '+t;else if(_lastKey==='no')_no+=' '+t}}if(!_gn||!_st)return null;return{startTime:_st,endTime:_et,gardenName:_gn,groupsCount:_gc}}let timeIdx=-1,startTime=null,endTime=null,gardenName='',address='',groupsCount=1;for(let i=0;i<lines.length;i++){const m=lines[i].match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/);if(m){timeIdx=i;startTime=m[1];endTime=m[2];break}}if(timeIdx>=0){const otherLines=lines.filter((_,i)=>i!==timeIdx);gardenName=otherLines[0]||'';address=otherLines.slice(1).join(', ')||'';const gm=raw.match(/(\d+)\s*(?:קבוצות?|קב'?|גנים|גן(?!\s*[֐-׿]))/);if(gm)groupsCount=parseInt(gm[1],10)||1;gardenName=gardenName.replace(/\s*\d+\s*(?:קבוצות?|קב'?|גנים|גן(?!\s*[֐-׿]))\s*/g,' ').trim()}else{const tm=raw.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);let rest;if(tm){startTime=tm[1];endTime=tm[2];rest=raw.slice(raw.indexOf(tm[0])+tm[0].length).trim()}else{const sm=raw.match(/(\d{1,2}:\d{2})\b/);if(!sm)return null;startTime=sm[1];const _tm=(s)=>{const[h,m]=s.split(':').map(Number);return h*60+m};const _fm=(n)=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');endTime=_fm(_tm(startTime)+40);rest=raw.slice(raw.indexOf(sm[0])+sm[0].length).trim()}const gm=rest.match(/(\d+)\s*(?:קבוצות?|קב'?|גנים|גן(?!\s*[֐-׿]))/);if(gm)groupsCount=parseInt(gm[1],10)||1;let gPart=rest,aPart='';const dashRe=/\s[-–—]\s/;const dashMatch=rest.match(dashRe);if(dashMatch&&dashMatch.index>0){gPart=rest.slice(0,dashMatch.index).trim();aPart=rest.slice(dashMatch.index+dashMatch[0].length).trim()}gardenName=gPart.replace(/\s*\d+\s*(?:קבוצות?|קב'?|גנים|גן(?!\s*[֐-׿]))\s*/g,' ').replace(/\s+/g,' ').trim();address=aPart}if(!gardenName)return null;return{startTime,endTime,gardenName,groupsCount}}

const wb=XLSX.readFile(path,{cellDates:false});
const ws=wb.Sheets[wb.SheetNames[0]];
const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:false,blankrows:false});

let curDayCols=null;
let count=0;
for(let r=0;r<rows.length;r++){
  const row=rows[r]||[];
  const rowDayCols=[];
  row.forEach((h,idx)=>{const parsed=_ciParseDayHeader(h);if(parsed)rowDayCols.push({idx,...parsed})});
  if(rowDayCols.length>=2){curDayCols=rowDayCols;continue}
  if(!curDayCols)continue;
  for(const dc of curDayCols){
    const cell=row[dc.idx];
    if(!cell)continue;
    const parsed=_ciParseSessionCell(cell);
    if(parsed){
      count++;
      console.log('#'+count,'r'+(r+1)+' ('+dc.day+'.'+dc.month+')','→', parsed.gardenName, '·', parsed.startTime+'-'+parsed.endTime, '·', parsed.groupsCount+' קב');
    }else{
      const v=String(cell||'').trim();
      if(v)console.log('   r'+(r+1)+' ('+dc.day+'.'+dc.month+') SKIP:',JSON.stringify(v).slice(0,120));
    }
  }
}
console.log('\nTOTAL:',count,'פעילויות');
