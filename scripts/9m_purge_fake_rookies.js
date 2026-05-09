'use strict';

/**
 * Script 9m — Purge Fake Auto-Generated Rookies From Team Rosters
 *
 * Post-draft / preseason cleanup. Madden's offseason flow auto-generates
 * rookies (UDFAs + next-year draft pool) and signs many to team rosters
 * with synthetic names. This script identifies any YearsPro=0 player on a
 * real team whose name does NOT appear in data/rookie_ratings_post_madden.json
 * and cuts them: TeamIndex=32, ContractStatus=FreeAgent, removed from team's
 * Roster array, added to Franchise.FreeAgents pool.
 *
 * No rec.empty() (V11-V19 lessons: that path causes sim CTDs).
 *
 * Usage:
 *   node scripts/9m_purge_fake_rookies.js --franchise <path> [--dry-run]
 *     [--rookies <path>]      default: data/rookie_ratings_post_madden.json
 *     [--include-yd1]         also purge fake YearDrafted=1, YearsPro=0
 *                             (Madden's next-year synthetic draft pool)
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

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}
function hasFlag(name) { return process.argv.slice(2).includes(name); }
function safeGet(rec, k) { try { const f = rec.getFieldByKey(k); return f ? f.value : undefined; } catch { return undefined; } }
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

(async () => {
  console.log('='.repeat(64));
  console.log('Script 9m — Purge Fake Auto-Generated Rookies');
  console.log('='.repeat(64));

  const franchisePath = findFlag('--franchise') || process.env.FRANCHISE_FILE || loadEnvFile(ENV_PATH).FRANCHISE_FILE;
  const rookiesPath = findFlag('--rookies') || path.join(DATA_DIR, 'rookie_ratings_post_madden.json');
  const isDryRun = hasFlag('--dry-run');
  const includeYd1 = hasFlag('--include-yd1');
  if (!franchisePath || !fs.existsSync(franchisePath)) { console.error('--franchise <path> required'); process.exit(1); }
  if (!fs.existsSync(rookiesPath)) { console.error(`Rookies file not found: ${rookiesPath}`); process.exit(1); }
  console.log(`  Franchise   : ${franchisePath}`);
  console.log(`  Real rookies: ${rookiesPath}`);
  console.log(`  Mode        : ${isDryRun ? 'DRY-RUN' : 'WRITE'}`);
  console.log(`  Include YD=1: ${includeYd1 ? 'yes (also purge next-year synthetic pool)' : 'no'}\n`);

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
    if (rosterRowIdx === undefined) return false;
    const rec = rosterTable.records[rosterRowIdx];
    if (!rec || rec.isEmpty) return false;
    for (let i = 0; i < 100; i++) {
      const f = rec.getFieldByKey(`Player${i}`);
      if (!f) continue;
      const r = f.referenceData;
      if (r && r.tableId === playerTableId && r.rowNumber === playerRow) {
        try { f.value = NULL_REFERENCE; return true; } catch { return false; }
      }
    }
    return false;
  }

  function addToFreeAgentsPool(playerRow) {
    if (!faTbl || faRow == null) return false;
    const rec = faTbl.records[faRow];
    if (!rec || rec.isEmpty) return false;
    // FA pool slots are typically Player0..Player(N-1); typically 3500
    for (let i = 0; i < 3500; i++) {
      const f = rec.getFieldByKey(`Player${i}`);
      if (!f) break;
      const r = f.referenceData;
      if (!r || r.tableId === 0 || r.rowNumber === 0) {
        try {
          f.value = utilService.dec2bin(playerTableId, 15) + utilService.dec2bin(playerRow, 17);
          return true;
        } catch { return false; }
      }
    }
    return false;
  }

  // Identify fakes
  const fakes = [];
  let realRookies = 0, alreadyFA = 0, scanned = 0;
  for (let i = 0; i < playerTable.records.length; i++) {
    const r = playerTable.records[i];
    if (r.isEmpty) continue;
    const yp = Number(safeGet(r, 'YearsPro'));
    const yd = Number(safeGet(r, 'YearDrafted'));
    if (yp !== 0) continue;
    // Filter: YD=0 (this year) or YD=1 (next year synthetic, opt-in via flag)
    if (yd !== 0 && !(includeYd1 && yd === 1)) continue;
    scanned++;
    const ti = Number(safeGet(r, 'TeamIndex'));
    if (ti === TEAM_INDEX_FREE_AGENT) { alreadyFA++; continue; }
    if (!Number.isFinite(ti) || ti < 0 || ti > 31) continue;
    const fn = safeGet(r, 'FirstName') || '';
    const ln = safeGet(r, 'LastName') || '';
    const key = norm(fn + ln);
    if (realNames.has(key)) { realRookies++; continue; }
    fakes.push({ row: i, name: `${fn} ${ln}`, pos: safeGet(r,'Position'), ti, yd, yp });
  }

  console.log(`  Rookie-class records scanned (YP=0${includeYd1?', YD ∈ {0,1}':', YD=0'}, on a real team): ${scanned}`);
  console.log(`    Already in FA pool       : ${alreadyFA} (skipped)`);
  console.log(`    Matched real rookie list : ${realRookies} (kept)`);
  console.log(`    Fake / unmatched         : ${fakes.length} (will purge)\n`);

  console.log('  First 8 fakes:');
  for (const f of fakes.slice(0, 8)) {
    console.log(`    row ${String(f.row).padStart(4)}  TI=${String(f.ti).padStart(2)}  YD=${f.yd}  ${f.pos.padEnd(4)}  ${f.name}`);
  }
  if (fakes.length > 8) console.log(`    ... ${fakes.length - 8} more`);

  if (isDryRun || fakes.length === 0) {
    console.log(isDryRun ? '\n(dry-run; no save)' : '\nNothing to purge.');
    return;
  }

  // Apply: cut each fake
  let cut = 0, rosterRemoved = 0, faPoolAdded = 0;
  for (const f of fakes) {
    const rec = playerTable.records[f.row];
    try {
      rec.getFieldByKey('TeamIndex').value = TEAM_INDEX_FREE_AGENT;
      rec.getFieldByKey('ContractStatus').value = CONTRACT_STATUS_FREE_AGENT;
      cut++;
    } catch (_) { continue; }
    if (removeFromRoster(f.ti, f.row)) rosterRemoved++;
    if (addToFreeAgentsPool(f.row)) faPoolAdded++;
  }

  console.log(`\n  Cut to FA pool       : ${cut}`);
  console.log(`  Removed from Roster  : ${rosterRemoved}`);
  console.log(`  Added to FA pool     : ${faPoolAdded}`);

  console.log('\n  Saving franchise file…');
  await fra.save(franchisePath);
  console.log('  ✓ Saved.');
})().catch(e => { console.error('\n✗ Fatal:', e.message || e); process.exit(1); });
