'use strict';

// Targeted probe: dump records that hold the actual user→team binding.
// We expect IsUserControlled=true on the Cards' Coach/PlayerPersonnel/etc.,
// and refs to the Cards Team (TeamIndex=6 = ARI) on Owner / FranchiseUser /
// UserEntity / UserRegistry.

const Franchise = require('madden-franchise');

const TARGET_NAMES = [
  'FranchiseUser', 'UserEntity', 'UserRegistry', 'Owner', 'Owner[]',
  'Coach', 'PlayerPersonnel', 'Trainer', 'Scout',
];

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}

function safeGet(rec, key) {
  try { const f = rec.getFieldByKey(key); return f ? f.value : undefined; } catch { return undefined; }
}

(async () => {
  const fp = findFlag('--franchise');
  if (!fp) { console.error('--franchise required'); process.exit(1); }

  const fra = await new Promise((res, rej) => {
    const f = new Franchise(fp, { gameYearOverride: 26 });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });
  console.log(`Franchise: ${fp}\n`);

  // Find populated Team table to verify TeamIndex mapping (ARI = 6)
  const teamCandidates = fra.tables.filter(t => t.name === 'Team');
  let teamMain = null;
  for (const t of teamCandidates) {
    try { await t.readRecords(); } catch (_) { continue; }
    if (t.records.filter(r => !r.isEmpty).length >= 30) { teamMain = t; break; }
  }
  if (teamMain) {
    console.log(`Team table found at id=${teamMain.header.tableId}`);
    const ariRec = teamMain.records.find(r => !r.isEmpty && Number(safeGet(r, 'TeamIndex')) === 6);
    if (ariRec) {
      console.log(`ARI record (TeamIndex=6) DisplayName='${safeGet(ariRec, 'DisplayName')}' ShortName='${safeGet(ariRec, 'ShortName')}'`);
    }
    console.log();
  }

  for (const targetName of TARGET_NAMES) {
    const matches = fra.tables.filter(t => t.name === targetName);
    if (matches.length === 0) {
      console.log(`---- ${targetName}: not found`);
      continue;
    }
    for (const tbl of matches) {
      try { await tbl.readRecords(); } catch (e) {
        console.log(`---- ${targetName} (id=${tbl.header.tableId}): READ FAILED: ${e.message}`);
        continue;
      }
      const live = tbl.records.filter(r => !r.isEmpty);
      console.log(`---- ${targetName} (id=${tbl.header.tableId}): ${tbl.records.length} records, ${live.length} live`);
      if (live.length === 0) continue;

      // Show fields of the first live record
      const sample = live[0];
      console.log(`     Sample record fields (${sample.fieldsArray.length}):`);
      for (const f of sample.fieldsArray) {
        const ref = f.isReference ? f.referenceData : null;
        const v = ref
          ? `→ tableId=${ref.tableId},row=${ref.rowNumber}`
          : `value=${JSON.stringify(safeGet(sample, f.key))}`;
        console.log(`       ${f.key.padEnd(28)}  ${v}`);
      }

      // For per-team tables, show records flagged IsUserControlled or with a team ref
      const hasIsUser = sample.getFieldByKey('IsUserControlled') !== undefined;
      const hasTeamIdx = sample.getFieldByKey('TeamIndex') !== undefined;
      const teamRefField = sample.fieldsArray.find(f => f.isReference && /team/i.test(f.key));
      if (hasIsUser) {
        const userControlled = live.filter(r => safeGet(r, 'IsUserControlled') === true || safeGet(r, 'IsUserControlled') === 'true');
        console.log(`     IsUserControlled=TRUE records: ${userControlled.length}`);
        for (const rec of userControlled.slice(0, 5)) {
          const fn = safeGet(rec, 'FirstName') || '';
          const ln = safeGet(rec, 'LastName') || '';
          const ti = safeGet(rec, 'TeamIndex');
          let teamRefStr = '';
          if (teamRefField) {
            const ref = rec.getFieldByKey(teamRefField.key)?.referenceData;
            if (ref) teamRefStr = ` ${teamRefField.key}=t${ref.tableId}r${ref.rowNumber}`;
          }
          console.log(`       row=${rec.index} ${(fn+' '+ln).trim() || '(no name)'}  TeamIndex=${ti}${teamRefStr}`);
        }
      }
      console.log();
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
