# Materials Upload Script

Uploads all weekly lesson materials directly to Firebase from a local folder.
Bypasses the browser entirely - works with any folder size (even 3+ GB) and
doesn't care about OneDrive sync issues.

## One-time setup

1. **Open Terminal/PowerShell** in this `scripts/` folder.

2. **Install dependencies:**
   ```
   npm install
   ```

3. **Get the service account key:**
   - Go to: https://console.firebase.google.com/project/babiez-app/settings/serviceaccounts/adminsdk
   - Click **"Generate new private key"** → **"Generate key"**
   - A JSON file will download
   - Move/rename it to `scripts/service-account.json`
   - ⚠ This file is private. It's already in `.gitignore`, do NOT commit it.

## Run

```
node upload-materials.js "C:\path\to\materials\folder"
```

Example with your OneDrive folder:
```
node upload-materials.js "C:\Users\David\שיר דיין\Shared - Documents\מערכי שיעור +שירים + מי בא לבקר"
```

### What happens:
- Reads all subfolders inside the path you give it
- For each subfolder = one material:
  - Picks the PDF whose name contains "מי בא לבקר" → garden PDF
  - Picks any other PDF → instructor PDF
  - Picks all audio files (mp3/wav/m4a/ogg/aac/opus/flac/aiff/wma)
  - Skips the `מערך עצמו` subfolder
- Uploads each file directly to Firebase Storage
- Creates a Firestore doc in the `materials` collection
- Logs progress per material

### Options:
- `--force` → re-upload even materials that already exist (creates duplicates)

## Expected output

```
📂 Reading: C:\Users\David\...\מערכי שיעור +שירים + מי בא לבקר
📦 Found 51 material folders
📚 0 materials already in Firestore
⬆ [1/51] אביב - מסיבת חרקים — uploading... ✓ done (5 files)
⬆ [2/51] אוגר סורי — uploading... ✓ done (4 files)
⬆ [3/51] אוגר סיבירי - חורף — uploading... ✓ done (6 files)
...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Uploaded:  51
⏭ Skipped:   0
❌ Failed:    0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎉 All done!
```

## Troubleshooting

- **"service-account.json not found"** — Follow setup step 3 above.
- **"Folder not found"** — Check the path you gave. On Windows use forward
  slashes or escape backslashes inside quotes.
- **One material fails midway** — Just re-run. It'll skip already-uploaded
  ones and try the failed ones again.
- **All fail with permission errors** — Check that the service account has
  the "Storage Admin" + "Firestore User" roles in Google Cloud Console.
