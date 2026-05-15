'use strict';

/**
 * Script 9z — Franchise Reference-Integrity Validator (read-only)
 *
 * Walks every table in a Madden 26 franchise and checks for **broken
 * references to empty Player rows**. A live record (e.g. a DepthChart entry)
 * pointing at a Player row that has been emptied is the leading cause of
 * "load crashes immediately" after running scripts that empty Player records
 * (9c / 9g pass 2). This script catches that class of corruption without
 * loading the franchise in Madden.
 *
 * Read-only — never writes. Default output is a summary plus up to 30
 * sample broken refs. Use --verbose to dump them all, --json for machine
 * output.
 *
 * Run:
 *   node scripts/9z_validate_franchise.js --franchise <path>
 *     [--verbose]   list every broken reference (otherwise capped at 30)
 *     [--json]      machine-readable JSON output (suppresses the summary)
 *
 * Exit codes:
 *   0 — clean (no broken references)
 *   1 — broken references found (or fatal error opening franchise)
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

// ---------------------------------------------------------------------------
// Boilerplate — same .env / arg helpers as 9g
// ---------------------------------------------------------------------------
const SCRIPT_DIR    = __dirname;
const PROJECT_ROOT  = path.join(SCRIPT_DIR, '..');
const ENV_PATH      = path.join(PROJECT_ROOT, '.env');

function loadEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val   = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key) result[key] = val;
  }
  return result;
}
function findFlag(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) if (args[i] === name) return args[i + 1];
  return null;
}
function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function openFranchise(filePath) {
  return new Promise((resolve, reject) => {
    const fra = new Franchise(filePath, { gameYearOverride: 26 });
    fra.on('error', err => reject(new Error(`Franchise error (${filePath}): ${err?.message || err}`)));
    fra.on('ready', () => resolve(fra));
  });
}

// ---------------------------------------------------------------------------
// Validation core
// ---------------------------------------------------------------------------
async function validate(franchisePath, opts = {}) {
  const { verbose = false } = opts;
  const log = opts.json ? () => {} : (...a) => console.log(...a);

  log('='.repeat(64));
  log('Script 9z — Franchise Reference-Integrity Validator');
  log('='.repeat(64));
  log(`\n  Franchise : ${franchisePath}`);

  const franchise = await openFranchise(franchisePath);

  // Identify the Player table and the empty row indices.
  const playerTable = franchise.getTableByName('Player');
  if (!playerTable) throw new Error('Player table not found.');
  await playerTable.readRecords();
  const playerTableId = playerTable.header.tableId;
  const emptyPlayerRows = new Set();
  let totalPlayerRows = playerTable.records.length;
  for (let i = 0; i < totalPlayerRows; i++) {
    if (playerTable.records[i].isEmpty) emptyPlayerRows.add(i);
  }
  log(`  Player    : ${totalPlayerRows} records, ${emptyPlayerRows.size} empty (tableId=${playerTableId})\n`);

  // Walk every other table; flag any live reference to an empty Player row.
  const issues = [];                        // [{ table, recordIndex, fieldName, playerRow }]
  const refsByTable = new Map();            // table.name → { scanned, total, broken }
  let tablesWithErrors = 0;
  let tablesScanned    = 0;
  let totalReferencesScanned = 0;

  for (const table of franchise.tables) {
    if (table.name === 'Player') continue;

    let stats = { scanned: 0, total: 0, broken: 0 };
    refsByTable.set(table.name, stats);

    try {
      await table.readRecords();
    } catch (err) {
      // Some tables fail to parse (rare schema mismatches, table3 issues, etc.).
      // Skip silently — they don't reference Player rows we care about.
      stats.error = err.message?.slice(0, 80) || 'readRecords failed';
      continue;
    }
    tablesScanned++;
    stats.total = table.records.length;

    for (const rec of table.records) {
      if (rec.isEmpty) continue;
      // fieldsArray is populated after readRecords. Fields we never accessed
      // still parse their offset metadata; isReference comes from the schema.
      const fields = rec.fieldsArray || [];
      for (const field of fields) {
        if (!field.isReference) continue;
        const ref = field.referenceData;
        if (!ref) continue;
        // Skip null references (tableId=0, rowNumber=0) — that's "no link".
        if (ref.tableId === 0 && ref.rowNumber === 0) continue;
        totalReferencesScanned++;
        if (ref.tableId !== playerTableId) continue;
        stats.scanned++;
        if (emptyPlayerRows.has(ref.rowNumber)) {
          stats.broken++;
          issues.push({
            table:        table.name,
            recordIndex:  rec.index,
            fieldName:    field.key,
            playerRow:    ref.rowNumber,
          });
        }
      }
    }
    if (stats.broken > 0) tablesWithErrors++;
  }

  // ── Output ────────────────────────────────────────────────────────────────
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      franchise: franchisePath,
      tablesScanned,
      totalPlayerRows,
      emptyPlayerRows: emptyPlayerRows.size,
      totalReferencesScanned,
      brokenReferences: issues.length,
      brokenByTable: Object.fromEntries(
        [...refsByTable.entries()]
          .filter(([_, s]) => s.broken > 0)
          .map(([name, s]) => [name, s.broken])
      ),
      issues,
    }, null, 2) + '\n');
    return issues;
  }

  log('='.repeat(64));
  log('Summary');
  log('='.repeat(64));
  log(`  Tables scanned          : ${tablesScanned} of ${franchise.tables.length}`);
  log(`  Player references found : ${[...refsByTable.values()].reduce((a, s) => a + s.scanned, 0)}`);
  log(`  Broken references       : ${issues.length}`);
  log(`  Tables with broken refs : ${tablesWithErrors}`);

  if (issues.length === 0) {
    log('\n✓ Clean — no live records reference an empty Player row.');
    return issues;
  }

  // Per-table breakdown
  log('\nBroken refs by table:');
  const sortedTables = [...refsByTable.entries()]
    .filter(([_, s]) => s.broken > 0)
    .sort((a, b) => b[1].broken - a[1].broken);
  for (const [name, s] of sortedTables) {
    log(`  ${name.padEnd(40)} ${s.broken} broken / ${s.scanned} scanned`);
  }

  // Sample (or full list with --verbose)
  const limit = verbose ? issues.length : Math.min(30, issues.length);
  log(`\n${verbose ? 'All' : `First ${limit}`} broken references:`);
  for (let i = 0; i < limit; i++) {
    const x = issues[i];
    log(`  ${x.table}[${x.recordIndex}].${x.fieldName} → Player[${x.playerRow}] (empty)`);
  }
  if (!verbose && issues.length > limit) {
    log(`  … and ${issues.length - limit} more (use --verbose to list all)`);
  }

  log(`\n✗ Found ${issues.length} broken references. Madden will likely crash on load.`);
  return issues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const env = loadEnvFile(ENV_PATH);
  const franchisePath =
        findFlag('--franchise')
     || process.env.FRANCHISE_FILE
     || env.FRANCHISE_FILE;

  if (!franchisePath) {
    console.error('✗ No franchise file. Pass --franchise <path> or set FRANCHISE_FILE in .env');
    process.exit(1);
  }
  if (!fs.existsSync(franchisePath)) {
    console.error(`✗ Franchise file not found: ${franchisePath}`);
    process.exit(1);
  }

  try {
    const issues = await validate(franchisePath, {
      verbose: hasFlag('--verbose'),
      json:    hasFlag('--json'),
    });
    process.exit(issues.length > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n✗ Fatal:', err.message || err);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
})();
