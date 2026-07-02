const XLSX=require('xlsx');
const path='C:\\Users\\David\\שיר דיין\\Shared - Documents\\קייטנות קיץ\\כל השיבוצים לקייטנות קיץ\\פיצול_גליונות_ויבנה_מתוקן\\שיבוצים מענבל_מנוקה_רווית.xlsx';
const wb=XLSX.readFile(path,{cellDates:false});
const ws=wb.Sheets[wb.SheetNames[0]];
const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:false,blankrows:false});

// Print all cells that contain group counts > 1
console.log('=== All cells with קבוצות counts ===\n');
rows.forEach((row,r)=>{
  row.forEach((cell,c)=>{
    const v=String(cell||'').trim();
    if(!v)return;
    // Check if cell mentions קבוצות or groups
    if(/\d\s*קבוצ|👥/.test(v)){
      console.log('r'+(r+1)+'c'+String.fromCharCode(65+c)+':');
      v.split('\n').forEach(line=>console.log('  '+line));
      console.log('');
    }
  });
});
