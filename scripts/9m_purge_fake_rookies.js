'use strict';

/**
 * Script 9m — Purge Fake Auto-Generated Rookies From Team Rosters
 *
 * Post-draft / preseason cleanup. Madden's offseason flow auto-generates
 * rookies (UDFAs + next-year draft pool) and signs many to team rosters
 * with synthetic names. This script identifies any YearsPro=0 player on a
 * real team whose name does NOT appear in data/rookie_ratings_post_madden.json
 * and either cuts them or, with --delete, hides them from the player pool:
 * TeamIndex=32, ContractStatus=Deleted, removed from team's Roster array and
 * from Franchise.FreeAgents.
 *
 * When --include-yd1 is set, YearDrafted=1 / YearsPro=0 players on real teams
 * are always cut. Those are Madden's next-year synthetic rookies; name matching
 * is intentionally ignored because Madden can generate duplicates with the
 * same names as our real 2026 rookies.
 *
 * One roster-balance safeguard is intentionally built in: a fake LS is not
 * purged when it is the team's last signed long snapper. The source franchise
 * can already be missing real-life LS moves because the stable 9g recipe does
 * not bulk-move vets; deleting Madden's emergency LS filler leaves the roster
 * invalid in game.
 *
 * No rec.empty() (V11-V19 lessons: that path causes sim CTDs).
 *
 * Usage:
 *   node scripts/9m_purge_fake_rookies.js --franchise <path> [--dry-run]
 *     [--rookies <path>]      default: data/rookie_ratings_post_madden.json
 *     [--include-yd1]         also purge fake YearDrafted=1, YearsPro=0
 *                             (Madden's next-year synthetic draft pool)
 *     [--include-retired]     also tombstone Retired YearsPro=0 rookies (the
 *                             disposal pile). Madden un-retires these on
 *                             offseason processing and re-signs them as YD=1
 *                             duplicates; deleting them prevents that recurrence.
 *                             Requires --delete (cutting a Retired player to FA
 *                             would revive it).
 *     [--delete]              mark purged rows Deleted and remove them from
 *                             FreeAgents instead of cutting them to FA
 *
 * Array removal uses shift-compact (never null-in-place): nulling a Player ref
 * inside a Player[] record shrinks its arraySize and orphans later slots
 * (FranchiseFileRecord.js:146-151) — verified to decimate team rosters.
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');
const utilService = require('madden-franchise/services/utilService');

const SCRIPT_DIR    = __dirname;
const PROJECT_ROOT  = path.join(SCRIPT_DIR, '..');
const DATA_DIR      = path.join(PROJECT_ROOT, 'data');
const ENV_PATH      = path.join(PROJECT_ROOT, '.env');

const NULL_REFERENCE = '0'.repeat(32);
const TEAM_INDEX_FREE_AGENT = 32;
const CONTRACT_STATUS_FREE_AGENT = 'FreeAgent';
const CONTRACT_STATUS_DELETED = 'Deleted';
const CONTRACT_STATUS_RETIRED = 'Retired';

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}
function hasFlag(name) { return process.argv.slice(2).includes(name); }
function safeGet(rec, k) { try { const f = rec.getFieldByKey(k); return f ? f.value : undefined; } catch { return undefined; } }
function trySet(rec, k, v) { try { const f = rec.getFieldByKey(k); if (!f) return false; f.value = v; return true; } catch { return false; } }
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const r = {};
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq+1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1,-1);
    if (k) r[k] = v;
  }
  return r;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

async function loadPopulated(franchise, name, minLive = 30) {
  for (const t of franchise.tables.filter(t => t.name === name)) {
    try { await t.readRecords(); } catch (_) { continue; }
    if (t.records.filter(r => !r.isEmpty).length >= minLive) return t;
  }
  return null;
}

function getPlayerSlot(rec, i) {
  try { return rec.getFieldByKey(`Player${i}`); } catch { return null; }
}

function isNullishRef(field) {
  const r = field?.referenceData;
  return !r || (r.tableId === 0 && r.rowNumber === 0);
}

function isPlayerRef(field, playerTableId, playerRow) {
  const r = field?.referenceData;
  return Boolean(field?.isReference && r && r.tableId === playerTableId && r.rowNumber === playerRow);
}

// Remove a Player ref from a Player[] sub-table record WITHOUT triggering the
// arraySize-shrink truncation bug (FranchiseFileRecord.js:146-151). Nulling a
// ref in-place at index < arraySize shrinks arraySize to that index, orphaning
// every later slot (verified: it decimated 27 team rosters here). For a counted
// array we shift the tail down by one and null ONLY the trailing slot (the one
// null-in-place the lib handles correctly). For an uncounted array (arraySize
// null) a null-in-place does not shrink and is safe. Returns occurrences removed.
function compactRemovePlayerFromRecord(rec, playerTableId, playerRow) {
  if (!rec || rec.isEmpty) return 0;
  const counted = rec.arraySize !== null && rec.arraySize !== undefined;
  if (!counted) {
    let removed = 0;
    for (let i = 0; i < 3600; i++) {
      const f = getPlayerSlot(rec, i);
      if (!f) break;
      if (isPlayerRef(f, playerTableId, playerRow)) { try { f.value = NULL_REFERENCE; removed++; } catch {} }
    }
    return removed;
  }
  let removed = 0;
  for (;;) {
    const size = Number(rec.arraySize ?? 0);
    let slotIdx = -1;
    for (let i = 0; i < size; i++) {
      const f = getPlayerSlot(rec, i);
      if (!f) break;
      if (isPlayerRef(f, playerTableId, playerRow)) { slotIdx = i; break; }
    }
    if (slotIdx < 0) break;
    const tail = [];
    for (let i = slotIdx + 1; i < size; i++) {
      const f = getPlayerSlot(rec, i);
      if (!f) break;
      tail.push(f.value);
    }
    for (let i = 0; i < tail.length; i++) {
      const dst = getPlayerSlot(rec, slotIdx + i);
      if (!dst) break;
      dst.value = tail[i];
    }
    const last = getPlayerSlot(rec, size - 1);
    if (last) last.value = NULL_REFERENCE;
    removed++;
  }
  return removed;
}

async function recalculateRosterSizes(playerTable, teamMain) {
  let touched = 0;
  for (const teamRec of teamMain.records) {
    if (teamRec.isEmpty) continue;
    const ti = Number(safeGet(teamRec, 'TeamIndex'));
    if (!Number.isFinite(ti) || ti < 0 || ti > 31) continue;

    let active = 0;
    let salCap = 0;
    let nextYear = 0;
    for (const pRec of playerTable.records) {
      if (pRec.isEmpty) continue;
      if (Number(safeGet(pRec, 'TeamIndex')) !== ti) continue;
      const cs = safeGet(pRec, 'ContractStatus');
      if (cs !== 'Signed' && cs !== 'Expiring') continue;

      salCap++;
      if (!safeGet(pRec, 'IsInjuredReserve')) active++;
      if (Number(safeGet(pRec, 'ContractLength')) > 1) nextYear++;
    }

    trySet(teamRec, 'ActiveRosterSize', active);
    trySet(teamRec, 'SalCapRosterSize', salCap);
    trySet(teamRec, 'SalCapNextYearRosterSize', nextYear);
    touched++;
  }
  return touched;
}

(async () => {
  console.log('='.repeat(64));
  console.log('Script 9m — Purge Fake Auto-Generated Rookies');
  console.log('='.repeat(64));

  const franchisePath = findFlag('--franchise') || process.env.FRANCHISE_FILE || loadEnvFile(ENV_PATH).FRANCHISE_FILE;
  const rookiesPath = findFlag('--rookies') || path.join(DATA_DIR, 'rookie_ratings_post_madden.json');
  const isDryRun = hasFlag('--dry-run');
  const includeYd1 = hasFlag('--include-yd1');
  const includeRetired = hasFlag('--include-retired');
  const deleteMode = hasFlag('--delete');
  if (!franchisePath || !fs.existsSync(franchisePath)) { console.error('--franchise <path> required'); process.exit(1); }
  if (!fs.existsSync(rookiesPath)) { console.error(`Rookies file not found: ${rookiesPath}`); process.exit(1); }
  console.log(`  Franchise   : ${franchisePath}`);
  console.log(`  Real rookies: ${rookiesPath}`);
  console.log(`  Mode        : ${isDryRun ? 'DRY-RUN' : 'WRITE'}${deleteMode ? ' + DELETE' : ' + CUT'}`);
  console.log(`  Include YD=1: ${includeYd1 ? 'yes (also purge next-year synthetic pool)' : 'no'}`);
  console.log(`  Include Retired: ${includeRetired ? 'yes (also purge Retired YP=0 disposal pile — prevents Madden resurrection)' : 'no'}\n`);

  // Build normalized name set from real rookies
  const rookies = JSON.parse(fs.readFileSync(rookiesPath, 'utf8'));
  const realNames = new Set();
  for (const r of rookies) {
    const fn = r.firstName || r.FirstName || (r.name || r.player_name || '').split(' ')[0];
    const ln = r.lastName || r.LastName || (r.name || r.player_name || '').split(' ').slice(1).join(' ');
    if (fn && ln) realNames.add(norm(fn + ln));
  }
  console.log(`  Real rookie name set: ${realNames.size}\n`);

  const fra = await new Promise((res, rej) => {
    const f = new Franchise(franchisePath, { gameYearOverride: 26, autoUnempty: true });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });

  const playerTable = fra.getTableByName('Player');
  await playerTable.readRecords();
  const playerTableId = playerTable.header.tableId;

  // Build team roster map (TeamIndex → Roster sub-table row)
  const teamMain = await loadPopulated(fra, 'Team');
  if (!teamMain) { console.error('No populated Team table'); process.exit(1); }
  let rosterTableId = null;
  for (const rec of teamMain.records) {
    if (rec.isEmpty) continue;
    const f = rec.getFieldByKey('Roster');
    if (f?.isReference) { rosterTableId = f.referenceData.tableId; break; }
  }
  if (!rosterTableId) { console.error('No Roster ref on Team'); process.exit(1); }
  const rosterTable = fra.getTableById(rosterTableId);
  await rosterTable.readRecords();
  const tiToRosterRow = new Map();
  for (const rec of teamMain.records) {
    if (rec.isEmpty) continue;
    const ti = Number(safeGet(rec, 'TeamIndex'));
    const row = rec.getFieldByKey('Roster')?.referenceData?.rowNumber;
    if (Number.isFinite(ti) && row !== undefined) tiToRosterRow.set(ti, row);
  }

  // Build PracticeSquad roster map (TeamIndex -> PS sub-table row). Purged
  // players sit in these Player[] arrays too, and leaving a ref to a Deleted
  // player behind is a dangling ref — remove them (shift-compact) as well.
  let psTableId = null;
  for (const rec of teamMain.records) {
    if (rec.isEmpty) continue;
    const f = rec.getFieldByKey('PracticeSquad');
    if (f?.isReference) { psTableId = f.referenceData.tableId; break; }
  }
  let psTable = null;
  const tiToPsRow = new Map();
  if (psTableId) {
    psTable = fra.getTableById(psTableId);
    await psTable.readRecords();
    for (const rec of teamMain.records) {
      if (rec.isEmpty) continue;
      const ti = Number(safeGet(rec, 'TeamIndex'));
      const row = rec.getFieldByKey('PracticeSquad')?.referenceData?.rowNumber;
      if (Number.isFinite(ti) && row !== undefined) tiToPsRow.set(ti, row);
    }
  } else {
    console.warn('  ! No Team.PracticeSquad ref — skipping practice-squad maintenance');
  }

  // Find FreeAgents pool sub-table on Franchise singleton
  const franchiseTbl = fra.getTableById(4635);
  await franchiseTbl.readRecords();
  const fRec = franchiseTbl.records.find(r => !r.isEmpty);
  let faTbl = null;
  let faRow = null;
  if (fRec) {
    const faField = fRec.getFieldByKey('FreeAgents');
    if (faField?.isReference) {
      const ref = faField.referenceData;
      faTbl = fra.getTableById(ref.tableId);
      faRow = ref.rowNumber;
      if (faTbl) await faTbl.readRecords();
    }
  }
  if (!faTbl || faRow == null) console.warn('  ! No Franchise.FreeAgents pool — will skip FA-pool maintenance');

  function removeFromRoster(ti, playerRow) {
    const rosterRowIdx = tiToRosterRow.get(ti);
    if (rosterRowIdx === undefined) return 0;
    const rec = rosterTable.records[rosterRowIdx];
    return compactRemovePlayerFromRecord(rec, playerTableId, playerRow);
  }

  function removeFromAllTeamRosters(playerRow) {
    let removed = 0;
    for (const ti of tiToRosterRow.keys()) {
      removed += removeFromRoster(ti, playerRow);
    }
    return removed;
  }

  function removeFromAllPracticeSquads(playerRow) {
    if (!psTable) return 0;
    let removed = 0;
    for (const psRow of tiToPsRow.values()) {
      const rec = psTable.records[psRow];
      removed += compactRemovePlayerFromRecord(rec, playerTableId, playerRow);
    }
    return removed;
  }

  function removeFromFreeAgentsPool(playerRow) {
    if (!faTbl || faRow == null) return 0;
    const rec = faTbl.records[faRow];
    return compactRemovePlayerFromRecord(rec, playerTableId, playerRow);
  }

  function addToFreeAgentsPool(playerRow) {
    if (!faTbl || faRow == null) return false;
    const rec = faTbl.records[faRow];
    if (!rec || rec.isEmpty) return false;

    // Do not duplicate a row if a prior run already appended it.
    for (let i = 0; i < 3500; i++) {
      const f = getPlayerSlot(rec, i);
      if (!f) break;
      if (isPlayerRef(f, playerTableId, playerRow)) return true;
    }

    // FA pool slots are typically Player0..Player(N-1); usually 3500.
    for (let i = 0; i < 3500; i++) {
      const f = getPlayerSlot(rec, i);
      if (!f) break;
      if (isNullishRef(f)) {
        try {
          f.value = utilService.getBinaryReferenceData
            ? utilService.getBinaryReferenceData(playerTableId, playerRow)
            : utilService.dec2bin(playerTableId, 15) + utilService.dec2bin(playerRow, 17);
          return true;
        } catch { return false; }
      }
    }
    return false;
  }

  const signedLike = new Set(['Signed', 'Expiring']);
  const activeLsByTeam = new Map();
  for (const r of playerTable.records) {
    if (r.isEmpty) continue;
    const pos = safeGet(r, 'Position');
    const ti = Number(safeGet(r, 'TeamIndex'));
    const cs = safeGet(r, 'ContractStatus');
    if (pos === 'LS' && Number.isFinite(ti) && ti >= 0 && ti <= 31 && signedLike.has(cs)) {
      activeLsByTeam.set(ti, (activeLsByTeam.get(ti) || 0) + 1);
    }
  }

  // Identify fakes
  const fakes = [];
  const protectedLastLs = [];
  const pendingLsPurgeByTeam = new Map();
  let realRookies = 0, skippedAlreadyFA = 0, fakeAlreadyFA = 0, scanned = 0, yd1Synthetic = 0, nameUnmatched = 0, retiredPurged = 0;
  for (let i = 0; i < playerTable.records.length; i++) {
    const r = playerTable.records[i];
    if (r.isEmpty) continue;
    const cs = safeGet(r, 'ContractStatus');
    if (cs === CONTRACT_STATUS_DELETED) continue;
    const yp = Number(safeGet(r, 'YearsPro'));
    const yd = Number(safeGet(r, 'YearDrafted'));
    if (yp !== 0) continue;
    // Filter: YD=0 (this year) or YD=1 (next year synthetic, opt-in via flag).
    // With --include-retired, let any Retired YP=0 rookie through regardless of YD.
    if (yd !== 0 && !(includeYd1 && yd === 1) && !(includeRetired && cs === CONTRACT_STATUS_RETIRED)) continue;
    scanned++;
    const ti = Number(safeGet(r, 'TeamIndex'));
    const onRealTeam = Number.isFinite(ti) && ti >= 0 && ti <= 31;
    const inFaPool = ti === TEAM_INDEX_FREE_AGENT;
    if (!onRealTeam && !inFaPool) continue;
    const fn = safeGet(r, 'FirstName') || '';
    const ln = safeGet(r, 'LastName') || '';
    const key = norm(fn + ln);
    const pos = safeGet(r, 'Position');
    const name = `${fn} ${ln}`;

    function protectIfLastLs(reason) {
      if (!onRealTeam || pos !== 'LS' || !signedLike.has(cs)) return false;
      const activeLs = activeLsByTeam.get(ti) || 0;
      const pending = pendingLsPurgeByTeam.get(ti) || 0;
      if (activeLs - pending > 1) {
        pendingLsPurgeByTeam.set(ti, pending + 1);
        return false;
      }
      protectedLastLs.push({ row: i, name, pos, ti, yd, yp, reason });
      return true;
    }

    // Retired YP=0 rookies are the pipeline's disposal pile. Madden un-retires
    // them on offseason processing and re-signs them as YD=1 duplicates, so with
    // --include-retired we tombstone them (Deleted). Only meaningful with --delete:
    // cutting a Retired player to FA would REVIVE it (the opposite of hardening).
    if (includeRetired && cs === CONTRACT_STATUS_RETIRED) {
      if (!deleteMode) continue;
      retiredPurged++;
      if (protectIfLastLs('last signed LS on team')) continue;
      fakes.push({ row: i, name, pos, ti, yd, yp, reason: 'Retired disposal' });
      continue;
    }
    if (includeYd1 && yd === 1) {
      yd1Synthetic++;
      if (inFaPool) fakeAlreadyFA++;
      if (inFaPool && !deleteMode) { skippedAlreadyFA++; continue; }
      if (protectIfLastLs('last signed LS on team')) continue;
      fakes.push({ row: i, name, pos, ti, yd, yp, reason: 'YD=1 synthetic' });
      continue;
    }
    if (realNames.has(key)) { realRookies++; continue; }
    nameUnmatched++;
    if (inFaPool) fakeAlreadyFA++;
    if (inFaPool && !deleteMode) { skippedAlreadyFA++; continue; }
    if (protectIfLastLs('last signed LS on team')) continue;
    fakes.push({ row: i, name, pos, ti, yd, yp });
  }

  console.log(`  Rookie-class records scanned (YP=0${includeYd1?', YD in {0,1}':', YD=0'}): ${scanned}`);
  console.log(`    Fake already in FA pool  : ${fakeAlreadyFA} (${deleteMode ? 'will delete' : `${skippedAlreadyFA} skipped`})`);
  console.log(`    Matched real rookie list : ${realRookies} (kept)`);
  if (includeYd1) console.log(`    YD=1 synthetic records   : ${yd1Synthetic} (will purge even on name match)`);
  if (includeRetired) console.log(`    Retired disposal records : ${retiredPurged} (will tombstone as Deleted)`);
  console.log(`    Name-unmatched records   : ${nameUnmatched} (will purge)`);
  console.log(`    Protected last-team LS   : ${protectedLastLs.length} (kept)`);
  console.log(`    Fake / unmatched         : ${fakes.length} (will purge)\n`);

  console.log('  First 8 fakes:');
  for (const f of fakes.slice(0, 8)) {
    const reason = f.reason ? `  ${f.reason}` : '';
    console.log(`    row ${String(f.row).padStart(4)}  TI=${String(f.ti).padStart(2)}  YD=${f.yd}  ${f.pos.padEnd(4)}  ${f.name}${reason}`);
  }
  if (fakes.length > 8) console.log(`    ... ${fakes.length - 8} more`);

  if (protectedLastLs.length) {
    console.log('\n  Protected last-team LS:');
    for (const f of protectedLastLs.slice(0, 8)) {
      console.log(`    row ${String(f.row).padStart(4)}  TI=${String(f.ti).padStart(2)}  YD=${f.yd}  ${f.pos.padEnd(4)}  ${f.name}  ${f.reason}`);
    }
    if (protectedLastLs.length > 8) console.log(`    ... ${protectedLastLs.length - 8} more`);
  }

  if (isDryRun || fakes.length === 0) {
    console.log(isDryRun ? '\n(dry-run; no save)' : '\nNothing to purge.');
    return;
  }

  // Apply: cut or delete each fake. Never rec.empty(); live refs to empty rows
  // are a known Madden load/sim crash vector.
  let cut = 0, deleted = 0, rosterRemoved = 0, psRemoved = 0, faPoolAdded = 0, faPoolRemoved = 0;
  for (const f of fakes) {
    const rec = playerTable.records[f.row];
    if (!trySet(rec, 'TeamIndex', TEAM_INDEX_FREE_AGENT)) continue;
    if (deleteMode) {
      trySet(rec, 'ContractStatus', CONTRACT_STATUS_DELETED);
      deleted++;
      rosterRemoved += removeFromAllTeamRosters(f.row);
      psRemoved += removeFromAllPracticeSquads(f.row);
      faPoolRemoved += removeFromFreeAgentsPool(f.row);
    } else {
      trySet(rec, 'ContractStatus', CONTRACT_STATUS_FREE_AGENT);
      cut++;
      rosterRemoved += removeFromRoster(f.ti, f.row);
      psRemoved += removeFromAllPracticeSquads(f.row);
      if (addToFreeAgentsPool(f.row)) faPoolAdded++;
    }
  }

  const rosterSizesRecalculated = await recalculateRosterSizes(playerTable, teamMain);

  console.log(`\n  Cut to FA pool       : ${cut}`);
  console.log(`  Marked Deleted       : ${deleted}`);
  console.log(`  Removed from Roster  : ${rosterRemoved}`);
  console.log(`  Removed from PracSqd : ${psRemoved}`);
  console.log(`  Added to FA pool     : ${faPoolAdded}`);
  console.log(`  Removed from FA pool : ${faPoolRemoved}`);
  console.log(`  Roster-size recalc   : ${rosterSizesRecalculated} teams`);

  console.log('\n  Saving franchise file…');
  await fra.save(franchisePath);
  console.log('  ✓ Saved.');
})().catch(e => { console.error('\n✗ Fatal:', e.message || e); process.exit(1); });
