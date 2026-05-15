'use strict';

/**
 * Script 9l — Dispose Auto-Generated Draft Prospects to FA Pool
 *
 * After 9g injects real 2026 rookies, the franchise still contains Madden's
 * pre-generated synthetic 2026 draft class (filter: ContractStatus=Draft,
 * YearDrafted=0, YearsPro=0, TeamIndex=32). Without disposal these show
 * up in the draft pool and create duplicates with our injected real rookies.
 *
 * Disposal approach: set ContractStatus to "FreeAgent" — removes them from
 * the draft pool, leaves all references intact (no rec.empty() — that path
 * causes sim CTDs per V11-V19 lessons documented in decisions.md).
 *
 * Usage:
 *   node scripts/9l_dispose_auto_prospects.js --franchise <path> [--dry-run]
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

const SCRIPT_DIR    = __dirname;
const PROJECT_ROOT  = path.join(SCRIPT_DIR, '..');
const ENV_PATH      = path.join(PROJECT_ROOT, '.env');

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}
function hasFlag(name) { return process.argv.slice(2).includes(name); }
function safeGet(rec, k) { try { const f = rec.getFieldByKey(k); return f ? f.value : undefined; } catch { return undefined; } }
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const r = {};
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq+1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1,-1);
    if (k) r[k] = v;
  }
  return r;
}

(async () => {
  console.log('='.repeat(64));
  console.log('Script 9l — Dispose Auto-Generated Draft Prospects');
  console.log('='.repeat(64));

  const franchisePath = findFlag('--franchise') || process.env.FRANCHISE_FILE || loadEnvFile(ENV_PATH).FRANCHISE_FILE;
  const isDryRun = hasFlag('--dry-run');
  if (!franchisePath || !fs.existsSync(franchisePath)) { console.error('--franchise <path> required'); process.exit(1); }
  console.log(`  Franchise: ${franchisePath}`);
  console.log(`  Mode     : ${isDryRun ? 'DRY-RUN' : 'WRITE'}\n`);

  const fra = await new Promise((res, rej) => {
    const f = new Franchise(franchisePath, { gameYearOverride: 26, autoUnempty: true });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });

  const pt = fra.getTableByName('Player');
  await pt.readRecords();

  // Find auto-prospects: YD=0, YP=0, CS=Draft, TI=32
  const targets = [];
  for (let i = 0; i < pt.records.length; i++) {
    const r = pt.records[i];
    if (r.isEmpty) continue;
    const yd = Number(safeGet(r, 'YearDrafted'));
    const yp = Number(safeGet(r, 'YearsPro'));
    const cs = safeGet(r, 'ContractStatus');
    if (yd === 0 && yp === 0 && cs === 'Draft') targets.push({ row: i, rec: r });
  }
  console.log(`  Auto-prospects found (YD=0, YP=0, ContractStatus=Draft): ${targets.length}`);

  if (targets.length === 0) {
    console.log('\n  Nothing to dispose.');
    return;
  }

  // Sample
  console.log('\n  First 5 to be disposed:');
  for (const { row, rec } of targets.slice(0, 5)) {
    const fn = safeGet(rec, 'FirstName') || '';
    const ln = safeGet(rec, 'LastName') || '';
    const pos = safeGet(rec, 'Position');
    const dr = safeGet(rec, 'PLYR_DRAFTROUND');
    const dp = safeGet(rec, 'PLYR_DRAFTPICK');
    console.log(`    row ${row}  ${pos.padEnd(4)}  R${dr}P${dp}  ${fn} ${ln}`);
  }
  if (targets.length > 5) console.log(`    ... ${targets.length - 5} more`);

  if (isDryRun) {
    console.log('\n(dry-run; no save)');
    return;
  }

  // Disposal: set ContractStatus to FreeAgent. TeamIndex stays 32 (already FA).
  // Leaves all records intact (no rec.empty()) so no dangling refs.
  let disposed = 0;
  for (const { rec } of targets) {
    try {
      rec.getFieldByKey('ContractStatus').value = 'FreeAgent';
      disposed++;
    } catch (_) {}
  }
  console.log(`\n  Disposed: ${disposed} → ContractStatus=FreeAgent`);

  console.log('\n  Saving franchise file…');
  await fra.save(franchisePath);
  console.log('  ✓ Saved.');
})().catch(e => { console.error('\n✗ Fatal:', e.message || e); process.exit(1); });
