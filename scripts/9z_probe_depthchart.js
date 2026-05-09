'use strict';

// Diagnostic probe: dump the DepthChart record schema + sample contents from
// one team. Used to design the depth-chart fill pass without guessing.
//
// Usage:
//   node scripts/9z_probe_depthchart.js --franchise <path> [--team <ti>]

const path      = require('path');
const Franchise = require('madden-franchise');

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}

(async () => {
  const fp = findFlag('--franchise');
  if (!fp) { console.error('--franchise required'); process.exit(1); }
  const wantTi = Number(findFlag('--team') ?? 27);   // SEA default

  const fra = await new Promise((res, rej) => {
    const f = new Franchise(fp, { gameYearOverride: 26 });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });

  // Find populated DepthChart table.
  const dcCandidates = fra.tables.filter(t => t.name === 'DepthChart');
  let dcMain = null;
  for (const t of dcCandidates) {
    try { await t.readRecords(); } catch (_) { continue; }
    if (t.records.filter(r => !r.isEmpty).length >= 30) { dcMain = t; break; }
  }
  if (!dcMain) { console.error('No populated DepthChart table'); process.exit(1); }
  console.log(`DepthChart table id=${dcMain.header.tableId}, ${dcMain.records.length} records (${dcMain.records.filter(r=>!r.isEmpty).length} live)`);

  // Find the record for the requested team. DepthChart records may not have a
  // TeamIndex field directly — try a few options.
  let target = null;
  for (let i = 0; i < dcMain.records.length; i++) {
    const rec = dcMain.records[i];
    if (rec.isEmpty) continue;
    const tiField = rec.getFieldByKey('TeamIndex');
    const ti = tiField ? Number(tiField.value) : null;
    if (ti === wantTi) { target = { rec, idx: i }; break; }
  }
  if (!target) {
    console.log(`No DC record with TeamIndex=${wantTi}; using first live record instead.`);
    for (let i = 0; i < dcMain.records.length; i++) {
      if (!dcMain.records[i].isEmpty) { target = { rec: dcMain.records[i], idx: i }; break; }
    }
  }
  console.log(`\nDepthChart record ${target.idx}:`);

  // Dump every field on the record.
  const fields = target.rec.fieldsArray;
  console.log(`  ${fields.length} fields total`);
  console.log('\n  All fields (name : isRef : value/refTarget):');
  const refFields = [];
  for (const f of fields) {
    const ref = f.isReference ? f.referenceData : null;
    const refStr = ref ? `→ tableId=${ref.tableId}, row=${ref.rowNumber}` : '';
    console.log(`    ${f.key.padEnd(28)}  isRef=${String(f.isReference).padEnd(5)}  ${ref ? refStr : `value=${f.value}`}`);
    if (f.isReference && ref && ref.tableId !== 0) refFields.push({ key: f.key, ref });
  }

  // Pick the first referenced sub-table that LOOKS like the DC pool (Player-array).
  console.log(`\n${refFields.length} ref fields. Inspecting first 3 unique referenced tables:`);
  const seenTables = new Set();
  for (const rf of refFields) {
    if (seenTables.has(rf.ref.tableId)) continue;
    seenTables.add(rf.ref.tableId);
    if (seenTables.size > 3) break;
    const sub = fra.getTableById(rf.ref.tableId);
    if (!sub) continue;
    try { await sub.readRecords(); } catch (e) { console.log(`  Read error on tableId=${rf.ref.tableId}: ${e.message}`); continue; }
    console.log(`\n  Table id=${rf.ref.tableId} name='${sub.name}' (referenced via DC.${rf.key})`);
    console.log(`    ${sub.records.length} records, ${sub.records.filter(r=>!r.isEmpty).length} live`);
    const firstRec = sub.records[rf.ref.rowNumber];
    if (firstRec) {
      console.log(`    Row ${rf.ref.rowNumber} (referenced via DC.${rf.key}):`);
      console.log(`      empty=${firstRec.isEmpty}, ${firstRec.fieldsArray.length} fields`);
      // Show first 10 field keys + values
      for (let i = 0; i < Math.min(10, firstRec.fieldsArray.length); i++) {
        const f = firstRec.fieldsArray[i];
        const ref = f.isReference ? f.referenceData : null;
        const v = ref ? `→ tableId=${ref.tableId},row=${ref.rowNumber}` : `value=${f.value}`;
        console.log(`        ${f.key.padEnd(20)} ${v}`);
      }
      if (firstRec.fieldsArray.length > 10) console.log(`        ... ${firstRec.fieldsArray.length - 10} more`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
