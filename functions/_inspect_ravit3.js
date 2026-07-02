const XLSX=require('xlsx');
const path='C:\\Users\\David\\שיר דיין\\Shared - Documents\\קייטנות קיץ\\כל השיבוצים לקייטנות קיץ\\פיצול_גליונות_ויבנה_מתוקן\\שיבוצים מענבל_מנוקה_רווית.xlsx';
const wb=XLSX.readFile(path,{cellDates:false});
const ws=wb.Sheets[wb.SheetNames[0]];
const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:false,blankrows:false});

console.log('=== Full content row-by-row ===');
rows.forEach((row,i)=>{
  row.forEach((c,j)=>{
    const v=String(c||'').trim();
    if(v)console.log('r'+(i+1)+String.fromCharCode(65+j)+': '+v.replace(/\n/g,' | '));
  });
});
