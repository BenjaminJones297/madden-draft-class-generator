'use strict';

/**
 * Find every table named exactly "Team" and dump their capacities + the
 * structure of Roster fields so we can identify which is the real per-team
 * roster source (the schema's Team has 314 attrs including Roster Player[]).
 */
const Franchise = require('madden-franchise');
const filePath = process.argv[2];
if (!filePath) { console.error('Usage: <franchise>'); process.exit(1); }

(async () => {
  const fra = await new Promise((res, rej) => {
    const f = new Franchise(filePath, { gameYearOverride: 26 });
    f.on('error', rej); f.on('ready', () => res(f));
  });

  console.log('=== All tables literally named "Team" ===');
  const teams = fra.tables.filter(t => t.name === 'Team');
  for (const t of teams) {
    try { await t.readRecords(); } catch { continue; }
    const live = t.records.filter(r => !r.isEmpty).length;
    console.log(`  id=${t.header.tableId} cap=${t.header.recordCapacity} live=${live}`);
  }
  console.log();

  // For the 35-record Team table, dump Team[0]'s Roster ref and the structure
  // of the Player[] table it points at.
  const teamMain = teams.find(t => t.records.filter(r => !r.isEmpty).length >= 30);
  if (!teamMain) { console.log('No 32+ record Team table found.'); return; }
  console.log(`=== Inspecting "Team" id=${teamMain.header.tableId} (${teamMain.records.length} records) ===\n`);

  for (let i = 0; i < Math.min(3, teamMain.records.length); i++) {
    const rec = teamMain.records[i];
    if (rec.isEmpty) continue;
    const rosterField = rec.getFieldByKey('Roster');
    const cityField   = rec.getFieldByKey('City');
    const ars         = rec.getFieldByKey('ActiveRosterSize');
    const teamIndexField = rec.getFieldByKey('TeamIndex');
    const tnField     = rec.getFieldByKey('ShortName') || rec.getFieldByKey('DisplayName') || rec.getFieldByKey('TeamName');
    console.log(`Team[${i}]:`);
    console.log(`  TeamIndex   = ${teamIndexField?.value}`);
    console.log(`  Name        = ${tnField?.value}`);
    console.log(`  City ref    = ${JSON.stringify(cityField?.referenceData)}`);
    console.log(`  ActiveRosterSize = ${ars?.value}`);
    if (rosterField?.isReference) {
      const ref = rosterField.referenceData;
      console.log(`  Roster ref  = ${JSON.stringify(ref)}`);
      const arr = fra.getTableById(ref.tableId);
      if (arr) {
        try { await arr.readRecords(); } catch {}
        console.log(`    -> ${arr.name} (id=${ref.tableId}) cap=${arr.header.recordCapacity} live=${arr.records.filter(r=>!r.isEmpty).length}`);
        // Each row of arr is one slot. How many slots? Look at row count.
        // Each row has 1 Player ref field probably.
        const slotsLive = arr.records.filter(r => !r.isEmpty);
        const fieldsPerRec = arr.records[0]?.fieldsArray?.length || 0;
        console.log(`    fields per record = ${fieldsPerRec}`);
        // List first 5 slots' Player refs
        for (let s = 0; s < Math.min(5, arr.records.length); s++) {
          const slot = arr.records[s];
          if (slot.isEmpty) { console.log(`    slot[${s}] = EMPTY`); continue; }
          // Show each ref field
          const refFields = (slot.fieldsArray || []).filter(f => f.isReference);
          for (const rf of refFields.slice(0, 3)) {
            const r = rf.referenceData;
            console.log(`    slot[${s}].${rf.key} -> tid=${r?.tableId} row=${r?.rowNumber}`);
          }
        }
      }
    }
    console.log();
  }
})();
