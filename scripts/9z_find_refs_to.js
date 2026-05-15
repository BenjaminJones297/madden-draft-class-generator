'use strict';

// Scan every reference field in every table for refs pointing at a specific
// (tableId, rowNumber). Use to find unfinished swap targets after 9k:
// e.g. anything still pointing at the Cards Team record (row 7 of Team table)
// is a binding 9k didn't update.
//
// Usage:
//   node scripts/9z_find_refs_to.js --franchise <path> --table 5917 --row 7

const Franchise = require('madden-franchise');

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}

(async () => {
  const fp = findFlag('--franchise');
  const wantTbl = Number(findFlag('--table'));
  const wantRow = Number(findFlag('--row'));
  if (!fp || !Number.isFinite(wantTbl) || !Number.isFinite(wantRow)) {
    console.error('--franchise --table <id> --row <n> required');
    process.exit(1);
  }

  const fra = await new Promise((res, rej) => {
    const f = new Franchise(fp, { gameYearOverride: 26 });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });
  console.log(`Scanning for refs → tableId=${wantTbl}, row=${wantRow}\n`);

  let scanned = 0, errored = 0, hits = 0;
  const hitsByTable = new Map();

  for (const t of fra.tables) {
    try { await t.readRecords(); } catch (_) { errored++; continue; }
    scanned++;
    for (let recIdx = 0; recIdx < t.records.length; recIdx++) {
      const rec = t.records[recIdx];
      if (rec.isEmpty) continue;
      for (const f of rec.fieldsArray) {
        if (!f.isReference) continue;
        const r = f.referenceData;
        if (!r) continue;
        if (r.tableId === wantTbl && r.rowNumber === wantRow) {
          hits++;
          const key = t.header.tableId;
          if (!hitsByTable.has(key)) hitsByTable.set(key, { name: t.name, fields: [] });
          hitsByTable.get(key).fields.push({ recIdx, fieldKey: f.key });
        }
      }
    }
  }

  console.log(`Scanned ${scanned} tables (${errored} read errors), found ${hits} refs.\n`);
  for (const [tblId, info] of hitsByTable) {
    console.log(`  tableId=${tblId} '${info.name}': ${info.fields.length} ref(s)`);
    for (const f of info.fields.slice(0, 10)) {
      console.log(`    rec ${f.recIdx} field ${f.fieldKey}`);
    }
    if (info.fields.length > 10) console.log(`    ... and ${info.fields.length - 10} more`);
  }
})().catch(e => { console.error(e); process.exit(1); });
