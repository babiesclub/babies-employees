// Convert each material's instructor PDF to a series of PNG images,
// upload them to Storage, and write a pageImages array onto the material doc.
// The frontend already prefers pageImages over the iframe path.
//
// Uses mupdf (WASM build of MuPDF) - renders Hebrew correctly out of the box
// because mupdf has proper RTL/BiDi text shaping.
//
// Usage:
//   node convert-pdfs-to-images.js                → preview which mats will be processed
//   node convert-pdfs-to-images.js --apply        → actually convert + upload + update
//   node convert-pdfs-to-images.js --apply --re   → re-convert mats that already have pageImages
//   node convert-pdfs-to-images.js --only <matId> → only one material

const admin = require('firebase-admin');
const fetch = require('node-fetch');
const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'babiez-app.firebasestorage.app',
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

const APPLY = process.argv.includes('--apply');
const REPROCESS = process.argv.includes('--re');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
const RENDER_DPI = 144; // ~2x screen density; good balance of size/quality

let mupdf;
async function loadMupdf() {
  if (!mupdf) mupdf = await import('mupdf');
  return mupdf;
}

async function renderPdfToPngs(pdfBytes) {
  const m = await loadMupdf();
  const doc = m.PDFDocument.openDocument(pdfBytes, 'application/pdf');
  const numPages = doc.countPages();
  const matrix = m.Matrix.scale(RENDER_DPI / 72, RENDER_DPI / 72);
  const pngs = [];
  for (let i = 0; i < numPages; i++) {
    const page = doc.loadPage(i);
    const pixmap = page.toPixmap(matrix, m.ColorSpace.DeviceRGB, false, true);
    const pngBuffer = pixmap.asPNG();
    pngs.push(Buffer.from(pngBuffer));
    pixmap.destroy && pixmap.destroy();
    page.destroy && page.destroy();
  }
  doc.destroy && doc.destroy();
  return pngs;
}

async function uploadPng(buffer, storagePath) {
  const file = bucket.file(storagePath);
  await file.save(buffer, {
    contentType: 'image/png',
    metadata: { metadata: { generatedFrom: 'pdf-to-image' } },
    public: false,
  });
  await file.makePublic().catch(() => {});
  return `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
}

async function processMaterial(m) {
  const url = m.instructorPdfUrl;
  if (!url) {
    return { skipped: true, reason: 'no instructor PDF' };
  }
  if (m.pageImages && m.pageImages.length && !REPROCESS) {
    return { skipped: true, reason: 'already has pageImages (use --re to redo)' };
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch failed ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());

  const pngs = await renderPdfToPngs(buf);
  const urls = [];
  for (let i = 0; i < pngs.length; i++) {
    const path = `materials/${m.id}/pages/page-${String(i + 1).padStart(2, '0')}.png`;
    const u = await uploadPng(pngs[i], path);
    urls.push(u);
    process.stdout.write(`page ${i + 1} `);
  }

  await db.collection('materials').doc(m.id).update({
    pageImages: urls,
    pageImagesUpdatedAt: Date.now(),
  });
  return { pages: pngs.length, urls };
}

(async () => {
  let mats;
  if (ONLY) {
    const doc = await db.collection('materials').doc(ONLY).get();
    if (!doc.exists) {
      console.error('Material not found:', ONLY);
      process.exit(1);
    }
    mats = [{ id: doc.id, ...doc.data() }];
  } else {
    const snap = await db.collection('materials').get();
    mats = [];
    snap.forEach(d => mats.push({ id: d.id, ...d.data() }));
    mats.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));
  }

  console.log(`\n📦 ${mats.length} מערכים נבדקים${APPLY ? ' (ייווצרו תמונות)' : ' (תצוגה בלבד)'}\n`);

  const will = [];
  for (const m of mats) {
    const has = m.pageImages && m.pageImages.length;
    const hasPdf = !!m.instructorPdfUrl;
    let status;
    if (!hasPdf) status = '⏭ אין PDF';
    else if (has && !REPROCESS) status = `✓ כבר יש ${m.pageImages.length} עמודים`;
    else status = '🔄 ייווצר';
    console.log(`  ${status.padEnd(20)} ${m.name}`);
    if (hasPdf && (!has || REPROCESS)) will.push(m);
  }

  console.log(`\n📊 ${will.length} מערכים ייווצרו / ישודרגו.\n`);

  if (!APPLY) {
    console.log('💡 זה היה מצב תצוגה. להפעיל בפועל: node convert-pdfs-to-images.js --apply');
    process.exit(0);
  }

  let ok = 0, failed = 0;
  for (const m of will) {
    try {
      process.stdout.write(`\n→ ${m.name}: `);
      const result = await processMaterial(m);
      if (result.skipped) {
        process.stdout.write(`⏭ ${result.reason}`);
      } else {
        process.stdout.write(`✓ ${result.pages} עמודים הועלו`);
        ok++;
      }
    } catch (e) {
      process.stdout.write(`\n  ✗ שגיאה: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n\n✅ סיים! ${ok} הצליחו, ${failed} נכשלו.`);
  process.exit(0);
})().catch(e => {
  console.error('\nFatal:', e);
  process.exit(1);
});
