'use strict';

/**
 * Script 9k — Swap User-Controlled Team in a Franchise
 *
 * Takes a franchise (e.g. CAREER-UPDATED-ROSTER currently controlled by ARI)
 * and re-binds the user to a different team. Minimal-touch implementation:
 * just changes FranchiseUser.Team ref + FranchiseUser.UserEntity ref + flips
 * the IsUserControlled flag on the old/new HeadCoach records.
 *
 * Why: V11-V19 attempts to bulk-move vets onto real-life 2026 teams CTD sim.
 * The V20 source CAREER-UPDATED-ROSTER already has vets on real teams and
 * sims past the draft cleanly, but is locked to the Cardinals. Swapping the
 * user-team binding is a much smaller surgical edit that sidesteps the
 * V11-V19 ceiling entirely.
 *
 * Usage:
 *   node scripts/9k_swap_user_team.js --franchise <path> --target-team-index <0-31>
 *
 * Verify with: node scripts/9z_probe_user_full.js --franchise <path>
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');
const utilService = require('madden-franchise/services/utilService');

const SCRIPT_DIR    = __dirname;
const PROJECT_ROOT  = path.join(SCRIPT_DIR, '..');
const ENV_PATH      = path.join(PROJECT_ROOT, '.env');

const TEAM_NAMES = {
  0:'Bears', 1:'Bengals', 2:'Bills', 3:'Broncos', 4:'Browns', 5:'Buccaneers',
  6:'Cardinals', 7:'Chargers', 8:'Chiefs', 9:'Colts', 10:'Cowboys', 11:'Dolphins',
  12:'Eagles', 13:'Falcons', 14:'49ers', 15:'Giants', 16:'Jaguars', 17:'Jets',
  18:'Lions', 19:'Packers', 20:'Panthers', 21:'Patriots', 22:'Raiders', 23:'Rams',
  24:'Ravens', 25:'Commanders', 26:'Saints', 27:'Seahawks', 28:'Steelers',
  29:'Titans', 30:'Vikings', 31:'Texans',
};

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}
function hasFlag(name) { return process.argv.slice(2).includes(name); }
function safeGet(rec, key) { try { const f = rec.getFieldByKey(key); return f ? f.value : undefined; } catch { return undefined; } }
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

async function loadPopulated(franchise, name, minLive = 30) {
  for (const t of franchise.tables.filter(t => t.name === name)) {
    try { await t.readRecords(); } catch (_) { continue; }
    if (t.records.filter(r => !r.isEmpty).length >= minLive) return t;
  }
  return null;
}

(async () => {
  console.log('='.repeat(64));
  console.log('Script 9k — Swap User-Controlled Team');
  console.log('='.repeat(64));

  const franchisePath = findFlag('--franchise') || process.env.FRANCHISE_FILE || loadEnvFile(ENV_PATH).FRANCHISE_FILE;
  const targetTi = Number(findFlag('--target-team-index'));
  const isDryRun = hasFlag('--dry-run');
  if (!franchisePath) { console.error('--franchise required'); process.exit(1); }
  if (!fs.existsSync(franchisePath)) { console.error(`Not found: ${franchisePath}`); process.exit(1); }
  if (!Number.isFinite(targetTi) || targetTi < 0 || targetTi > 31) {
    console.error('--target-team-index 0..31 required');
    process.exit(1);
  }
  console.log(`  Franchise   : ${franchisePath}`);
  console.log(`  Target team : ${targetTi} (${TEAM_NAMES[targetTi] || '?'})`);
  console.log(`  Mode        : ${isDryRun ? 'DRY-RUN' : 'WRITE'}\n`);

  const fra = await new Promise((res, rej) => {
    const f = new Franchise(franchisePath, { gameYearOverride: 26, autoUnempty: true });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });

  // 1. FranchiseUser
  const fuTbl = fra.getTableById(4293);
  if (!fuTbl) throw new Error('FranchiseUser table (id=4293) not found — schema may differ');
  await fuTbl.readRecords();
  const userRec = fuTbl.records.find(r => !r.isEmpty);
  if (!userRec) throw new Error('No live FranchiseUser record');
  const oldTeamRef = userRec.getFieldByKey('Team').referenceData;
  const oldUserEntRef = userRec.getFieldByKey('UserEntity').referenceData;
  console.log(`  FranchiseUser row: ${userRec.index}`);
  console.log(`    Team        → t${oldTeamRef.tableId} r${oldTeamRef.rowNumber}`);
  console.log(`    UserEntity  → t${oldUserEntRef.tableId} r${oldUserEntRef.rowNumber}`);

  // 2. Resolve TARGET team's row in Team table
  const teamTbl = fra.getTableById(oldTeamRef.tableId);
  await teamTbl.readRecords();
  let targetTeamRow = null;
  let oldTeamIdx = null;
  for (let i = 0; i < teamTbl.records.length; i++) {
    const r = teamTbl.records[i];
    if (r.isEmpty) continue;
    const ti = Number(safeGet(r, 'TeamIndex'));
    if (ti === targetTi) targetTeamRow = i;
    if (i === oldTeamRef.rowNumber) oldTeamIdx = ti;
  }
  if (targetTeamRow == null) throw new Error(`Could not find Team record with TeamIndex=${targetTi}`);
  console.log(`    Old team    : row ${oldTeamRef.rowNumber} (TeamIndex=${oldTeamIdx} = ${TEAM_NAMES[oldTeamIdx] || '?'})`);
  console.log(`    New team    : row ${targetTeamRow} (TeamIndex=${targetTi} = ${TEAM_NAMES[targetTi]})`);

  if (oldTeamIdx === targetTi) {
    console.log('\n  ⓘ Already controlling this team. Nothing to swap.');
    return;
  }

  // 3. Resolve old + new HeadCoach in Coach table
  const coachTbl = fra.getTableById(oldUserEntRef.tableId);
  await coachTbl.readRecords();
  const oldCoachRec = coachTbl.records[oldUserEntRef.rowNumber];
  if (!oldCoachRec) throw new Error('Old coach row not resolvable');
  console.log(`    Old coach   : row ${oldUserEntRef.rowNumber} ${safeGet(oldCoachRec,'FirstName')} ${safeGet(oldCoachRec,'LastName')} (TeamIndex=${safeGet(oldCoachRec,'TeamIndex')})`);

  let newCoachRow = null;
  for (let i = 0; i < coachTbl.records.length; i++) {
    const r = coachTbl.records[i];
    if (r.isEmpty) continue;
    if (Number(safeGet(r, 'TeamIndex')) !== targetTi) continue;
    if (safeGet(r, 'Position') !== 'HeadCoach') continue;
    newCoachRow = i;
    console.log(`    New coach   : row ${i} ${safeGet(r,'FirstName')} ${safeGet(r,'LastName')} (HeadCoach, TeamIndex=${targetTi})`);
    break;
  }
  if (newCoachRow == null) throw new Error(`Could not find HeadCoach record on TeamIndex=${targetTi}`);

  // 4. Apply edits
  console.log('\n  Edits to apply:');
  console.log(`    1. FranchiseUser.Team       row ${oldTeamRef.rowNumber} → ${targetTeamRow}`);
  console.log(`    2. FranchiseUser.UserEntity row ${oldUserEntRef.rowNumber} → ${newCoachRow}`);
  console.log(`    3. Coach row ${oldUserEntRef.rowNumber} IsUserControlled true → false`);
  console.log(`    4. Coach row ${newCoachRow} IsUserControlled false → true`);

  if (isDryRun) {
    console.log('\n(dry-run; no save)');
    return;
  }

  // Reference values are 32-bit binary strings: 15-bit tableId + 17-bit rowNumber
  const teamRefBin = utilService.dec2bin(oldTeamRef.tableId, 15) + utilService.dec2bin(targetTeamRow, 17);
  const coachRefBin = utilService.dec2bin(oldUserEntRef.tableId, 15) + utilService.dec2bin(newCoachRow, 17);
  userRec.getFieldByKey('Team').value = teamRefBin;
  userRec.getFieldByKey('UserEntity').value = coachRefBin;
  oldCoachRec.getFieldByKey('IsUserControlled').value = false;
  coachTbl.records[newCoachRow].getFieldByKey('IsUserControlled').value = true;

  console.log('\n  Saving franchise file…');
  await fra.save(franchisePath);
  console.log('  ✓ Saved.');
})().catch(e => { console.error('\n✗ Fatal:', e.message || e); process.exit(1); });
