'use strict';

/**
 * Script 9o_pick — Pick ~80 vets across skinTone 1-8 for calibration.
 * (Default --per-bucket 10 × 8 buckets = 80; rare tones 3/8 limited to their
 * available vet count.)
 *
 * Reads CAREER-UPDATED-ROSTER (or any franchise), buckets non-rookie Player
 * records by their actual skinTone (decoded from CharacterVisuals.RawData),
 * and writes data/calibration_vets.json in the rookie-shape so it can flow
 * straight through 9n_fetch_rookie_headshots.py.
 *
 * Output shape (array, rookie-compatible):
 *   [{ firstName, lastName, position, team, trueSkinTone, ... }, ...]
 *
 * Run:
 *   node scripts/9o_pick_calibration_vets.js \
 *     --franchise "C:/.../CAREER-UPDATED-ROSTER" \
 *     --out data/calibration_vets.json \
 *     [--per-bucket 8]
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_OUT  = path.join(PROJECT_ROOT, 'data', 'calibration_vets.json');

function findFlag(name, def) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) return args[i + 1];
  }
  return def;
}

async function main() {
  const franchisePath = findFlag('--franchise',
    `${process.env.USERPROFILE}/OneDrive/Documents/Madden NFL 26/saves/CAREER-UPDATED-ROSTER`);
  const outPath   = findFlag('--out', DEFAULT_OUT);
  const perBucket = Number(findFlag('--per-bucket', 8));

  console.log('='.repeat(64));
  console.log('Script 9o_pick — pick calibration vets across skinTone 1-8');
  console.log('='.repeat(64));
  console.log(`  Franchise   : ${franchisePath}`);
  console.log(`  Output      : ${outPath}`);
  console.log(`  Per bucket  : ${perBucket}`);

  const fra = await new Promise((resolve, reject) => {
    const f = new Franchise(franchisePath, { gameYearOverride: 26 });
    f.on('error', e => reject(e));
    f.on('ready', () => resolve(f));
  });

  const player = fra.getTableByName('Player');
  await player.readRecords();
  const cv = fra.tables.find(t => t.header.tableId === 4204);
  await cv.readRecords();

  // Bucket vets by truth skinTone
  const buckets = {}; // tone -> array of {firstName, lastName, ...}
  let scanned = 0, skipped = 0;
  for (const r of player.records) {
    if (r.isEmpty) continue;
    scanned++;
    const yp = r.getFieldByKey('YearsPro')?.value;
    if (!yp || yp < 1) { skipped++; continue; }   // only real vets
    const fn = r.getFieldByKey('FirstName')?.value;
    const ln = r.getFieldByKey('LastName')?.value;
    if (!fn || !ln) continue;
    const pos = r.getFieldByKey('Position')?.value || '';
    const cvRef = r.getFieldByKey('CharacterVisuals')?.value;
    if (!cvRef || cvRef.length !== 32) continue;
    const row = parseInt(cvRef.slice(15), 2);
    const cvRec = cv.records[row];
    if (!cvRec || cvRec.isEmpty) continue;
    let skinTone = null;
    try {
      skinTone = JSON.parse(cvRec.getFieldByKey('RawData').value).skinTone;
    } catch (_) { continue; }
    if (skinTone === undefined || skinTone === null) continue;
    buckets[skinTone] = buckets[skinTone] || [];
    buckets[skinTone].push({
      firstName: fn,
      lastName:  ln,
      position:  pos,
      trueSkinTone: skinTone,
    });
  }

  // Pick up to per-bucket from each tone, oversampling rare tones (3, 8).
  // Deterministic shuffle: stable by name within bucket, then take first N.
  const picked = [];
  const breakdown = {};
  for (const tone of Object.keys(buckets).sort((a, b) => +a - +b)) {
    const arr = buckets[tone];
    arr.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
    // Pseudo-random pick using deterministic spacing for diversity
    const target = perBucket;
    const step = Math.max(1, Math.floor(arr.length / target));
    const chosen = [];
    for (let i = 0; i < arr.length && chosen.length < target; i += step) {
      chosen.push(arr[i]);
    }
    breakdown[tone] = { available: arr.length, chosen: chosen.length };
    picked.push(...chosen);
  }

  console.log(`\n  Vets scanned: ${scanned}, vet-eligible: ${scanned - skipped}`);
  console.log(`  Per-bucket pool / picked:`);
  for (const [tone, b] of Object.entries(breakdown).sort((a, b) => +a[0] - +b[0])) {
    console.log(`    skinTone ${tone}: ${b.available.toString().padStart(4)} avail / ${b.chosen} picked`);
  }
  console.log(`\n  Total picked: ${picked.length}`);

  fs.writeFileSync(outPath, JSON.stringify(picked, null, 2));
  console.log(`\nWritten: ${outPath}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
