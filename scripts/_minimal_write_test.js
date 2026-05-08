'use strict';
/**
 * Diagnostic — open a franchise, find one rookie, change ONE rating field
 * on it (just OverallRating), save. The minimal possible write to the
 * Player table.
 */
const Franchise = require('madden-franchise');

const filePath = process.argv[2];
const fra = new Franchise(filePath, { gameYearOverride: 26 });
fra.on('error', (e) => { console.error(e); process.exit(1); });
fra.on('ready', async () => {
  const t = fra.getTableByName('Player');
  await t.readRecords();

  let target = null;
  for (const rec of t.records) {
    if (rec.isEmpty) continue;
    let yd, yp;
    try {
      yd = rec.getFieldByKey('YearDrafted')?.value;
      yp = rec.getFieldByKey('YearsPro')?.value;
    } catch { continue; }
    if (!(yd === 0 || yd === '0')) continue;
    if (!(yp === 0 || yp === '0')) continue;
    target = rec;
    break;
  }
  if (!target) {
    console.error('No rookie found');
    process.exit(1);
  }

  const fn = target.getFieldByKey('FirstName')?.value;
  const ln = target.getFieldByKey('LastName')?.value;
  const ovrField = target.getFieldByKey('OverallRating');
  const oldOvr = ovrField.value;
  const newOvr = oldOvr === 99 ? 98 : oldOvr + 1;
  console.log(`Target rookie: ${fn} ${ln}`);
  console.log(`OverallRating: ${oldOvr} → ${newOvr}`);
  ovrField.value = newOvr;

  await fra.save(filePath);
  console.log('✓ Saved.');
  process.exit(0);
});
