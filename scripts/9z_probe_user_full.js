'use strict';

// Resolve the actual user→team binding by following refs.

const Franchise = require('madden-franchise');

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
  const fra = await new Promise((res, rej) => {
    const f = new Franchise(fp, { gameYearOverride: 26 });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });

  // --- 1. FranchiseUser
  const fu = fra.getTableById(4293);
  await fu.readRecords();
  const liveUser = fu.records.find(r => !r.isEmpty);
  console.log('FranchiseUser live record idx=' + liveUser.index);
  const teamRef = liveUser.getFieldByKey('Team').referenceData;
  const userEntRef = liveUser.getFieldByKey('UserEntity').referenceData;
  console.log('  Team ref → tableId=' + teamRef.tableId + ', row=' + teamRef.rowNumber);
  console.log('  UserEntity ref → tableId=' + userEntRef.tableId + ', row=' + userEntRef.rowNumber);
  console.log('  AdminLevel: ' + safeGet(liveUser, 'AdminLevel'));

  // --- 2. Team table at row 7
  const teamTable = fra.getTableById(teamRef.tableId);
  await teamTable.readRecords();
  const teamRec = teamTable.records[teamRef.rowNumber];
  console.log('\nTeam record at row ' + teamRef.rowNumber + ':');
  console.log('  TeamIndex: ' + safeGet(teamRec, 'TeamIndex'));
  console.log('  DisplayName: ' + safeGet(teamRec, 'DisplayName'));
  console.log('  ShortName: ' + safeGet(teamRec, 'ShortName'));

  // --- 3. Coach table at row 64
  const coachTable = fra.getTableById(userEntRef.tableId);
  await coachTable.readRecords();
  const coachRec = coachTable.records[userEntRef.rowNumber];
  console.log('\nCoach (UserEntity) record at row ' + userEntRef.rowNumber + ':');
  console.log('  Name: ' + safeGet(coachRec, 'FirstName') + ' ' + safeGet(coachRec, 'LastName'));
  console.log('  TeamIndex: ' + safeGet(coachRec, 'TeamIndex'));
  console.log('  IsUserControlled: ' + safeGet(coachRec, 'IsUserControlled'));
  console.log('  Position: ' + safeGet(coachRec, 'Position'));

  // --- 4. Map all 32 teams: row → TeamIndex/Name
  console.log('\nTeam table row → TeamIndex mapping:');
  for (let i = 0; i < teamTable.records.length; i++) {
    const r = teamTable.records[i];
    if (r.isEmpty) continue;
    const ti = safeGet(r, 'TeamIndex');
    if (ti == null || ti === 32) continue;   // skip FA
    console.log(`  row ${String(i).padStart(2)} → TeamIndex=${String(ti).padStart(2)}  ${safeGet(r, 'DisplayName')}`);
  }

  // --- 5. All Coach records with IsUserControlled=true
  console.log('\nAll Coach records with IsUserControlled=true:');
  for (let i = 0; i < coachTable.records.length; i++) {
    const r = coachTable.records[i];
    if (r.isEmpty) continue;
    if (safeGet(r, 'IsUserControlled') === true || safeGet(r, 'IsUserControlled') === 'true') {
      console.log(`  row ${i}  ${safeGet(r, 'FirstName')} ${safeGet(r, 'LastName')}  TeamIndex=${safeGet(r, 'TeamIndex')}  Position=${safeGet(r, 'Position')}`);
    }
  }

  // --- 6. PlayerPersonnel with IsUserControlled
  const ppTbl = fra.getTableById(4271);
  await ppTbl.readRecords();
  console.log(`\nPlayerPersonnel records (${ppTbl.records.filter(r=>!r.isEmpty).length} live):`);
  for (let i = 0; i < ppTbl.records.length; i++) {
    const r = ppTbl.records[i];
    if (r.isEmpty) continue;
    const isU = safeGet(r, 'IsUserControlled');
    if (isU === true || isU === 'true') {
      console.log(`  row ${i}  TeamIndex=${safeGet(r, 'TeamIndex')}  Position=${safeGet(r, 'Position')}  IsUserControlled=true`);
    }
  }

  // --- 7. Player records with IsUserControlled (just count + first 5)
  const playerTbl = fra.getTableById(4222);
  await playerTbl.readRecords();
  let playerUserCount = 0;
  const samples = [];
  for (let i = 0; i < playerTbl.records.length; i++) {
    const r = playerTbl.records[i];
    if (r.isEmpty) continue;
    if (safeGet(r, 'IsUserControlled') === true || safeGet(r, 'IsUserControlled') === 'true') {
      playerUserCount++;
      if (samples.length < 5) samples.push({ row: i, name: `${safeGet(r,'FirstName')} ${safeGet(r,'LastName')}`, ti: safeGet(r,'TeamIndex') });
    }
  }
  console.log(`\nPlayer records with IsUserControlled=true: ${playerUserCount}`);
  for (const s of samples) console.log(`  row ${s.row} ${s.name} TeamIndex=${s.ti}`);
})().catch(e => { console.error(e); process.exit(1); });
