'use strict';

/**
 * Diff two franchise files (read-only). For every shared table, compare
 * non-empty records field-by-field and flag any mismatch. Useful to catch
 * unintended writes — e.g. confirm that 9g's only changes are in Player
 * (and the cleaned references in other tables), not in DepthChart slots
 * or other tables it doesn't claim to touch.
 *
 * Usage:
 *   node scripts/9z_diff_franchises.js --before <path> --after <path>
 *     [--summary]   per-table delta counts only (default: show 30 sample diffs)
 *     [--table X]   restrict to a single table name
 *     [--limit N]   max sample diffs (default 30)
 */

const fs        = require('fs');
const Franchise = require('madden-franchise');

function flag(n) { const a = process.argv.slice(2); for (let i = 0; i < a.length - 1; i++) if (a[i] === n) return a[i + 1]; return null; }
function has(n)  { return process.argv.slice(2).includes(n); }

function open(p) {
  return new Promise((res, rej) => {
    const f = new Franchise(p, { gameYearOverride: 26 });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });
}

async function readSafely(table) {
  try { await table.readRecords(); return true; } catch (_) { return false; }
}

function fieldValue(field) {
  if (!field) return undefined;
  if (field.isReference) {
    const r = field.referenceData;
    return r ? `ref(${r.tableId}:${r.rowNumber})` : 'ref(null)';
  }
  try { return field.value; } catch (_) { return '<unreadable>'; }
}

async function main() {
  const before = flag('--before');
  const after  = flag('--after');
  const tableFilter = flag('--table');
  const limit  = parseInt(flag('--limit') || '30', 10);
  const summaryOnly = has('--summary');

  if (!before || !after || !fs.existsSync(before) || !fs.existsSync(after)) {
    console.error('Usage: --before <path> --after <path>');
    process.exit(1);
  }

  console.log('='.repeat(64));
  console.log('Franchise Diff');
  console.log('='.repeat(64));
  console.log(`  Before : ${before}`);
  console.log(`  After  : ${after}\n`);

  const [a, b] = await Promise.all([open(before), open(after)]);

  // Index after-tables by name for matching
  const afterByName = new Map();
  for (const t of b.tables) afterByName.set(t.name, t);

  const perTable = [];   // { name, becameEmpty, becameLive, fieldDiffs, sampleDiffs[] }
  let totalFieldDiffs = 0;

  for (const aT of a.tables) {
    if (tableFilter && aT.name !== tableFilter) continue;
    const bT = afterByName.get(aT.name);
    if (!bT) continue;
    if (aT.header.tableId !== bT.header.tableId) continue;   // skip name collisions across schemas

    const okA = await readSafely(aT);
    const okB = await readSafely(bT);
    if (!okA || !okB) continue;

    const stats = { name: aT.name, recs: aT.records.length, becameEmpty: 0, becameLive: 0, fieldDiffs: 0, samples: [] };

    const max = Math.min(aT.records.length, bT.records.length);
    for (let i = 0; i < max; i++) {
      const rA = aT.records[i];
      const rB = bT.records[i];
      const eA = rA.isEmpty, eB = rB.isEmpty;
      if (eA && !eB) { stats.becameLive++; continue; }
      if (!eA && eB) { stats.becameEmpty++; continue; }
      if (eA && eB) continue;

      // Both live — compare fields. Use rA.fieldsArray as the iteration source.
      const fields = rA.fieldsArray || [];
      for (const fA of fields) {
        const key = fA.key;
        const fB = rB.getFieldByKey(key);
        const vA = fieldValue(fA);
        const vB = fieldValue(fB);
        if (vA === vB) continue;
        stats.fieldDiffs++;
        totalFieldDiffs++;
        if (stats.samples.length < limit) {
          stats.samples.push({ rec: i, field: key, before: String(vA).slice(0, 60), after: String(vB).slice(0, 60) });
        }
      }
    }

    if (stats.becameEmpty || stats.becameLive || stats.fieldDiffs) perTable.push(stats);
  }

  // Sort by total impact desc
  perTable.sort((x, y) => (y.becameEmpty + y.becameLive + y.fieldDiffs) - (x.becameEmpty + x.becameLive + x.fieldDiffs));

  console.log(`Tables with deltas: ${perTable.length}`);
  console.log(`Total field-level diffs: ${totalFieldDiffs}\n`);
  console.log('Per-table summary (sorted by delta size):');
  console.log('  table'.padEnd(50) + ' became_empty became_live field_diffs');
  for (const s of perTable) {
    console.log(`  ${s.name.padEnd(48)} ${String(s.becameEmpty).padStart(11)} ${String(s.becameLive).padStart(11)} ${String(s.fieldDiffs).padStart(11)}`);
  }

  if (summaryOnly) return;

  console.log('\nSample diffs per table (up to ' + limit + ' per table):');
  for (const s of perTable) {
    if (!s.samples.length) continue;
    console.log(`\n  ${s.name}:`);
    for (const d of s.samples) {
      console.log(`    rec ${String(d.rec).padStart(4)} ${d.field.padEnd(28)} ${d.before.padEnd(28)} -> ${d.after}`);
    }
  }
}

main().catch(e => { console.error(e.stack || e.message || e); process.exit(1); });
