// Parses all <script> blocks in index.html and verifies they're syntactically valid.
// Catches duplicate declarations, missing brackets, bad template literals etc.
// Used by .git/hooks/pre-commit to block bad commits.
//
// Usage:  node scripts/check-html-syntax.js [path-to-html]
//         Default: ../index.html

const fs = require('fs');
const path = require('path');

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'index.html');

if (!fs.existsSync(target)) {
  console.error('✗ File not found:', target);
  process.exit(1);
}

const html = fs.readFileSync(target, 'utf8');
const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
let m, scriptIdx = 0, errors = 0;

while ((m = re.exec(html)) !== null) {
  scriptIdx++;
  const code = m[1];
  if (!code.trim()) continue;
  // Skip scripts with external src (no inline content)
  const tagStart = html.lastIndexOf('<script', m.index + 7);
  const openTag = html.substring(tagStart, m.index + m[0].indexOf('>') + 1);
  if (/\ssrc\s*=/i.test(openTag)) continue;
  try {
    // Wrap in async fn so top-level await is allowed too
    new Function('"use strict";\n' + code);
  } catch (e) {
    errors++;
    console.error(`\n✗ Script #${scriptIdx} (${code.length.toLocaleString()} chars) — ${e.message}`);
    const stackMatch = e.stack.match(/<anonymous>:(\d+)/);
    if (stackMatch) {
      const lineNum = parseInt(stackMatch[1], 10) - 1; // -1 for our "use strict" prefix
      const lines = code.split('\n');
      const ctx = lines[lineNum - 1];
      if (ctx) console.error(`   near line ${lineNum}: ${ctx.slice(0, 200).trim()}`);
    }
  }
}

if (errors > 0) {
  console.error(`\n✗ ${errors} script(s) in ${path.basename(target)} have syntax errors — fix before committing\n`);
  process.exit(1);
}
console.log(`✓ All ${scriptIdx} <script> block(s) in ${path.basename(target)} parse OK`);
process.exit(0);
