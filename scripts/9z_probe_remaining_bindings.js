'use strict';

// Find user-team bindings beyond the FranchiseUser.Team + Coach.IsUserControlled
// pair that 9k handles. Targets the symptoms reported on
// CAREER-UPDATED-ROSTER-HAWKS after 9k swap to SEA: Week-1 matchups not
// visible + trade-block popups for non-user-team players.

const Franchise = require('madden-franchise');

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}
function safeGet(rec, key) { try { const f = rec.getFieldByKey(key); return f ? f.value : undefined; } catch { return undefined; } }

(async () => {
  const fp = findFlag('--franchise');
  const fra = await new Promise((res, rej) => {
    const f = new Franchise(fp, { gameYearOverride: 26 });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });
  console.log(`Franchise: ${fp}\n`);

  // --- 1. FranchiseUser.TeamSetting target — what's at table 4172?
  const fuTbl = fra.getTableById(4293);
  await fuTbl.readRecords();
  const userRec = fuTbl.records.find(r => !r.isEmpty);
  const tsRef = userRec.getFieldByKey('TeamSetting').referenceData;
  console.log(`FranchiseUser.TeamSetting → tableId=${tsRef.tableId} row=${tsRef.rowNumber}`);

  const tsTbl = fra.getTableById(tsRef.tableId);
  await tsTbl.readRecords();
  console.log(`Table ${tsRef.tableId} name='${tsTbl.name}': ${tsTbl.records.length} records, ${tsTbl.records.filter(r=>!r.isEmpty).length} live`);
  const tsRec = tsTbl.records[tsRef.rowNumber];
  if (tsRec && !tsRec.isEmpty) {
    console.log(`Sample fields on row ${tsRef.rowNumber}:`);
    for (const f of tsRec.fieldsArray) {
      const ref = f.isReference ? f.referenceData : null;
      const v = ref ? `→ t${ref.tableId} r${ref.rowNumber}` : `value=${JSON.stringify(safeGet(tsRec, f.key))}`;
      console.log(`  ${f.key.padEnd(30)} ${v}`);
    }
  }
  console.log();

  // --- 2. PlayerPersonnel — list all 32, look for any team-bound ref
  const ppTbl = fra.getTableById(4271);
  await ppTbl.readRecords();
  const ppLive = ppTbl.records.filter(r => !r.isEmpty);
  console.log(`PlayerPersonnel: ${ppLive.length} live records. Field keys:`);
  if (ppLive[0]) {
    for (const f of ppLive[0].fieldsArray.slice(0, 25)) console.log(`  ${f.key}`);
    if (ppLive[0].fieldsArray.length > 25) console.log(`  ... ${ppLive[0].fieldsArray.length - 25} more`);
  }
  console.log(`\nPlayerPersonnel rows that look user-related (TeamIndex=27 SEA + TeamIndex=6 ARI):`);
  for (let i = 0; i < ppTbl.records.length; i++) {
    const r = ppTbl.records[i];
    if (r.isEmpty) continue;
    const ti = Number(safeGet(r, 'TeamIndex'));
    if (ti !== 27 && ti !== 6) continue;
    console.log(`  row ${i}  TeamIndex=${ti}  IsUserControlled=${safeGet(r, 'IsUserControlled')}  ${safeGet(r,'FirstName')||''} ${safeGet(r,'LastName')||''}`);
  }
  console.log();

  // --- 3. Owner records — any with TeamIndex=6 (Cards) or 27 (SEA)?
  const ownerTblCands = fra.tables.filter(t => t.name === 'Owner');
  for (const t of ownerTblCands) {
    try { await t.readRecords(); } catch (_) { continue; }
    const live = t.records.filter(r => !r.isEmpty);
    if (live.length < 2) continue;
    console.log(`Owner table id=${t.header.tableId}: ${live.length} live`);
    for (let i = 0; i < t.records.length; i++) {
      const r = t.records[i];
      if (r.isEmpty) continue;
      const ti = Number(safeGet(r, 'TeamIndex'));
      if (ti !== 6 && ti !== 27 && ti !== 32) continue;
      const isU = safeGet(r, 'IsUserControlled');
      console.log(`  row ${String(i).padStart(3)}  TeamIndex=${String(ti).padStart(2)}  ${safeGet(r,'FirstName')} ${safeGet(r,'LastName')}  AdminLevel=${safeGet(r,'AdminLevel')}  IsUserControlled=${isU}  Position=${safeGet(r,'Position')}`);
    }
    console.log();
  }

  // --- 4. Search for trade / scouting / activity / notification / news tables
  console.log(`Tables with 'trade' / 'scouting' / 'notification' / 'newsfeed' / 'tradeblock' / 'targetlist':`);
  const TRADE_PATTERNS = /trade|scouting|notification|newsfeed|tradeblock|targetlist|watchlist|interest/i;
  for (const t of fra.tables) {
    if (!TRADE_PATTERNS.test(t.name)) continue;
    try { await t.readRecords(); } catch (_) { continue; }
    const live = t.records.filter(r => !r.isEmpty);
    if (live.length === 0) continue;
    console.log(`  id=${String(t.header.tableId).padStart(5)} '${t.name}'  ${live.length} live / ${t.records.length}`);
  }
  console.log();

  // --- 5. UserRequestIssuer — what does it bind to?
  const uriTbl = fra.getTableById(5457);
  if (uriTbl) {
    await uriTbl.readRecords();
    const uriLive = uriTbl.records.filter(r => !r.isEmpty);
    console.log(`UserRequestIssuer (id=5457): ${uriLive.length} live`);
    if (uriLive[0]) {
      for (const f of uriLive[0].fieldsArray.slice(0, 20)) {
        const ref = f.isReference ? f.referenceData : null;
        const v = ref ? `→ t${ref.tableId} r${ref.rowNumber}` : `value=${JSON.stringify(safeGet(uriLive[0], f.key))}`;
        console.log(`  ${f.key.padEnd(28)} ${v}`);
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
