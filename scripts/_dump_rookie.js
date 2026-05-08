'use strict';
/** Dump every field on the first non-empty rookie (YearDrafted=0) record. */
const Franchise = require('madden-franchise');

const filePath = process.argv[2];
const fra = new Franchise(filePath, { gameYearOverride: 26 });
fra.on('error', (e) => { console.error(e); process.exit(1); });
fra.on('ready', async () => {
  const t = fra.getTableByName('Player');
  await t.readRecords();

  let dumped = 0;
  for (const rec of t.records) {
    if (rec.isEmpty) continue;
    let yd, yp;
    try {
      yd = rec.getFieldByKey('YearDrafted')?.value;
      yp = rec.getFieldByKey('YearsPro')?.value;
    } catch { continue; }
    if (!(yd === 0 || yd === '0')) continue;
    if (!(yp === 0 || yp === '0')) continue;

    const fn = rec.getFieldByKey('FirstName')?.value;
    const ln = rec.getFieldByKey('LastName')?.value;
    console.log(`\n=== Rookie #${dumped + 1}: ${fn} ${ln} ===`);
    const fields = {};
    for (const key of Object.keys(rec.fields)) {
      try {
        const v = rec.fields[key].value;
        if (v !== undefined && v !== null && v !== '' && v !== 0) {
          fields[key] = String(v).length > 80 ? String(v).slice(0, 80) + '…' : v;
        }
      } catch {}
    }
    console.log(JSON.stringify(fields, null, 2));
    if (++dumped >= 1) break;
  }
  process.exit(0);
});
