#!/usr/bin/env node
// upload-materials.js — uploads weekly lesson materials directly to Firebase
//                       from a local folder, bypassing the browser entirely.
//
// Usage: node upload-materials.js "<path-to-materials-folder>" [--force]
//
// Auth: requires a service-account.json file in this folder, downloaded from
//       Firebase Console → Project Settings → Service Accounts → Generate
//       new private key.

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json');
const STORAGE_BUCKET = 'babiez-app.firebasestorage.app';

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error('❌ service-account.json not found in scripts/ folder.');
  console.error('   Download it from Firebase Console:');
  console.error('   https://console.firebase.google.com/project/babiez-app/settings/serviceaccounts/adminsdk');
  console.error('   Save as: scripts/service-account.json');
  process.exit(1);
}

const serviceAccount = require(SERVICE_ACCOUNT_PATH);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: STORAGE_BUCKET,
});

const bucket = admin.storage().bucket();
const db = admin.firestore();

const rootPath = process.argv[2];
const force = process.argv.includes('--force');

if (!rootPath) {
  console.error('❌ Usage: node upload-materials.js "<path>" [--force]');
  console.error('   Example: node upload-materials.js "C:\\Users\\David\\שיר דיין\\Shared - Documents\\מערכי שיעור +שירים + מי בא לבקר"');
  process.exit(1);
}

if (!fs.existsSync(rootPath)) {
  console.error('❌ Folder not found: ' + rootPath);
  process.exit(1);
}

const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|aac|opus|flac|aiff|wma)$/i;
const PDF_EXT = /\.pdf$/i;
const SKIP_SUBFOLDER = 'מערך עצמו';

function classifyFile(fileName) {
  if (AUDIO_EXT.test(fileName)) return 'audio';
  if (!PDF_EXT.test(fileName)) return null;
  if (fileName.includes('מי בא לבקר')) return 'garden';
  return 'instructor';
}

function scanMaterialFolder(folderPath) {
  const result = { instructor: null, garden: null, audio: [] };
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('__')) continue;
    if (entry.isDirectory()) {
      if (entry.name === SKIP_SUBFOLDER) continue;
      continue; // skip other subfolders too
    }
    const type = classifyFile(entry.name);
    if (!type) continue;
    const filePath = path.join(folderPath, entry.name);
    if (type === 'instructor' && !result.instructor) {
      result.instructor = { fileName: entry.name, filePath };
    } else if (type === 'garden') {
      result.garden = { fileName: entry.name, filePath };
    } else if (type === 'audio') {
      result.audio.push({ fileName: entry.name, filePath });
    }
  }
  return result;
}

async function uploadFile(localPath, storagePath, contentType) {
  await bucket.upload(localPath, {
    destination: storagePath,
    metadata: { contentType },
  });
  const file = bucket.file(storagePath);
  await file.makePublic();
  return `https://storage.googleapis.com/${STORAGE_BUCKET}/${storagePath}`;
}

function contentTypeFor(fileName) {
  if (PDF_EXT.test(fileName)) return 'application/pdf';
  if (/\.mp3$/i.test(fileName)) return 'audio/mpeg';
  if (/\.wav$/i.test(fileName)) return 'audio/wav';
  if (/\.m4a$/i.test(fileName)) return 'audio/mp4';
  if (/\.ogg$/i.test(fileName)) return 'audio/ogg';
  if (/\.aac$/i.test(fileName)) return 'audio/aac';
  if (/\.opus$/i.test(fileName)) return 'audio/opus';
  if (/\.flac$/i.test(fileName)) return 'audio/flac';
  return 'application/octet-stream';
}

async function uploadMaterial(folderName, contents) {
  const matId = 'mat_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const storageRoot = `materials/${matId}`;

  const obj = {
    id: matId,
    name: folderName,
    animalName: folderName,
    summary: '',
    instructorPdfUrl: '',
    instructorPdfName: '',
    gardenPdfUrl: '',
    gardenPdfName: '',
    audioFiles: [],
    uploadedAt: Date.now(),
    uploadedBy: 'script',
  };

  if (contents.instructor) {
    const url = await uploadFile(
      contents.instructor.filePath,
      `${storageRoot}/instructor.pdf`,
      'application/pdf'
    );
    obj.instructorPdfUrl = url;
    obj.instructorPdfName = contents.instructor.fileName;
  }

  if (contents.garden) {
    const url = await uploadFile(
      contents.garden.filePath,
      `${storageRoot}/garden.pdf`,
      'application/pdf'
    );
    obj.gardenPdfUrl = url;
    obj.gardenPdfName = contents.garden.fileName;
  }

  for (let i = 0; i < contents.audio.length; i++) {
    const audio = contents.audio[i];
    const ext = audio.fileName.split('.').pop().toLowerCase();
    const url = await uploadFile(
      audio.filePath,
      `${storageRoot}/audio_${i + 1}.${ext}`,
      contentTypeFor(audio.fileName)
    );
    obj.audioFiles.push({ name: audio.fileName, url });
  }

  await db.collection('materials').doc(matId).set(obj);
  return obj;
}

async function main() {
  console.log('📂 Reading: ' + rootPath);
  const allEntries = fs.readdirSync(rootPath, { withFileTypes: true });
  const folders = allEntries.filter((e) => e.isDirectory()).map((e) => e.name);

  if (!folders.length) {
    console.log('⚠ No subfolders found. Is this a single-material folder?');
    return;
  }

  console.log(`📦 Found ${folders.length} material folders`);

  // Get existing materials
  const existing = await db.collection('materials').get();
  const existingNames = new Set(existing.docs.map((d) => d.data().name));
  console.log(`📚 ${existingNames.size} materials already in Firestore`);

  let done = 0,
    failed = 0,
    skipped = 0;
  const errors = [];

  for (const folderName of folders) {
    done++;
    const label = `[${done}/${folders.length}] ${folderName}`;

    if (!force && existingNames.has(folderName)) {
      console.log(`⏭  ${label} — skipping (already exists, use --force to override)`);
      skipped++;
      continue;
    }

    const folderPath = path.join(rootPath, folderName);
    const contents = scanMaterialFolder(folderPath);

    if (!contents.instructor && !contents.garden && contents.audio.length === 0) {
      console.log(`⚠ ${label} — no valid files found, skipping`);
      skipped++;
      continue;
    }

    process.stdout.write(`⬆ ${label} — uploading... `);
    try {
      await uploadMaterial(folderName, contents);
      const filesCount = (contents.instructor ? 1 : 0) + (contents.garden ? 1 : 0) + contents.audio.length;
      console.log(`✓ done (${filesCount} files)`);
    } catch (e) {
      console.log(`❌ FAILED: ${e.message || e.code || e}`);
      errors.push({ folder: folderName, error: e.message || e.code || String(e) });
      failed++;
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✓ Uploaded:  ${done - failed - skipped}`);
  console.log(`⏭ Skipped:   ${skipped}`);
  console.log(`❌ Failed:    ${failed}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (errors.length) {
    console.log('\nErrors:');
    errors.forEach((e) => console.log(`  • ${e.folder}: ${e.error}`));
  }
}

main()
  .then(() => {
    console.log('\n🎉 All done!');
    process.exit(0);
  })
  .catch((e) => {
    console.error('\n💥 Fatal error:', e);
    process.exit(1);
  });
