'use strict';
/**
 * Diagnostic only — open a franchise, optionally read the Player table,
 * then save it back with no edits. Used to determine whether the library's
 * save by itself corrupts the file (vs. corruption from specific writes).
 */
const Franchise = require('madden-franchise');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/_nullsave_test.js <franchise-path>');
  process.exit(1);
}

console.log('Opening:', filePath);
const fra = new Franchise(filePath, { gameYearOverride: 26 });

fra.on('error', (err) => {
  console.error('Open error:', err);
  process.exit(1);
});

fra.on('ready', async () => {
  try {
    console.log('  Ready. Reading Player table…');
    const t = fra.getTableByName('Player');
    await t.readRecords();
    console.log(`  Player records: ${t.records.length} (capacity ${t.header.recordCapacity})`);
    console.log('  Saving back with no edits…');
    await fra.save(filePath);
    console.log('✓ Saved.');
  } catch (err) {
    console.error('Save error:', err);
    process.exit(1);
  }
});
