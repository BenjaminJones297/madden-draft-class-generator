'use strict';

/**
 * Script 9j — Fill Depth Chart Null Slots
 *
 * V11-V19 nulled DepthChart slots when vets moved teams but never repopulated
 * them. Madden's draft engine reads the depth chart to slot drafted prospects
 * and to evaluate team needs; null entries in active position arrays are the
 * suspected root cause of the post-V19 draft-sim CTDs.
 *
 * For each team's DepthChart record (1 per team):
 *   For each of 35 position slots (QB, HB, WR, … plus specialty: 3DRB, KR, etc.):
 *     For each of 6 depth slots (Player0..Player5):
 *       If null, fill with the highest-OVR player on that team matching the
 *       slot's acceptable position list (deduped within position).
 *
 * Standalone — does not modify any other state. Composable with V20 9g, the
 * CUT_MODE V19 + script 9 pipeline, or any other producer.
 *
 * Usage:
 *   node scripts/9j_fill_depth_chart.js --franchise <path> [--dry-run]
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');
const utilService = require('madden-franchise/services/utilService');

const SCRIPT_DIR    = __dirname;
const PROJECT_ROOT  = path.join(SCRIPT_DIR, '..');
const ENV_PATH      = path.join(PROJECT_ROOT, '.env');

// Inactive ContractStatus values — exclude these when picking depth-chart fill candidates.
const CONTRACT_STATUS_INACTIVE = new Set(['Deleted', 'Retired', 'None', 'FreeAgent']);

const NULL_REFERENCE = '0'.repeat(32);   // 15-bit tableId=0 + 17-bit rowNumber=0

// Map each DepthChart slot key to ordered list of acceptable Player.Position
// values. First match wins; secondary positions are fallbacks when a team has
// nobody at the primary spot.
const DC_TO_POSITIONS = {
  // Standard 22
  QB:    ['QB'],
  HB:    ['HB', 'FB'],
  FB:    ['FB', 'HB'],
  WR:    ['WR'],
  TE:    ['TE'],
  LT:    ['LT', 'RT'],
  LG:    ['LG', 'RG'],
  C:     ['C', 'LG', 'RG'],
  RG:    ['RG', 'LG'],
  RT:    ['RT', 'LT'],
  LE:    ['LE', 'RE'],
  DT:    ['DT'],
  RE:    ['RE', 'LE'],
  LOLB:  ['LOLB', 'ROLB'],
  MLB:   ['MLB', 'LOLB', 'ROLB'],
  ROLB:  ['ROLB', 'LOLB'],
  CB:    ['CB'],
  FS:    ['FS', 'SS'],
  SS:    ['SS', 'FS'],
  K:     ['K'],
  P:     ['P'],
  LS:    ['LS', 'C', 'TE'],
  // Specialty
  '3DRB':['HB'],
  PWHB:  ['HB', 'FB'],
  SLWR:  ['WR'],
  SLCB:  ['CB', 'FS', 'SS'],
  SUBLB: ['LOLB', 'MLB', 'ROLB'],
  NT:    ['DT'],
  RLE:   ['LE', 'DT'],
  RRE:   ['RE', 'DT'],
  RDT:   ['DT'],
  GAD:   ['LE', 'RE', 'DT'],   // gap defender (best guess — DL)
  KR:    ['WR', 'HB', 'CB'],
  PR:    ['WR', 'HB', 'CB'],
  KOS:   ['K', 'P'],
};

function loadEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key) result[key] = val;
  }
  return result;
}

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function safeGet(rec, fields) {
  const list = Array.isArray(fields) ? fields : [fields];
  for (const name of list) {
    try {
      const f = rec.getFieldByKey(name);
      if (f && f.value !== undefined) return f.value;
    } catch (_) {}
  }
  return undefined;
}

async function loadPopulated(franchise, name, minLive = 30) {
  for (const t of franchise.tables.filter(t => t.name === name)) {
    try { await t.readRecords(); } catch (_) { continue; }
    if (t.records.filter(r => !r.isEmpty).length >= minLive) return t;
  }
  return null;
}

async function main() {
  console.log('='.repeat(64));
  console.log('Script 9j — Fill Depth Chart Null Slots');
  console.log('='.repeat(64));

  const franchisePath = findFlag('--franchise') || process.env.FRANCHISE_FILE || loadEnvFile(ENV_PATH).FRANCHISE_FILE;
  if (!franchisePath) { console.error('--franchise required'); process.exit(1); }
  if (!fs.existsSync(franchisePath)) { console.error(`Not found: ${franchisePath}`); process.exit(1); }
  const isDryRun = hasFlag('--dry-run');
  console.log(`  Franchise: ${franchisePath}`);
  console.log(`  Mode     : ${isDryRun ? 'DRY-RUN' : 'WRITE'}`);

  const franchise = await new Promise((res, rej) => {
    const f = new Franchise(franchisePath, { gameYearOverride: 26, autoUnempty: true });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });

  const playerTable = franchise.getTableByName('Player');
  if (!playerTable) throw new Error('Player table not found');
  await playerTable.readRecords();
  console.log(`  Player records: ${playerTable.records.length}`);

  const dcMain = await loadPopulated(franchise, 'DepthChart');
  if (!dcMain) { console.error('No populated DepthChart table'); process.exit(1); }
  console.log(`  DepthChart    : ${dcMain.records.length} records (${dcMain.records.filter(r=>!r.isEmpty).length} live)`);

  // DC pool tableId — find via any DC record's first valid position ref.
  let dcPoolTableId = null;
  for (const rec of dcMain.records) {
    if (rec.isEmpty) continue;
    for (const k of Object.keys(DC_TO_POSITIONS)) {
      const f = rec.getFieldByKey(k);
      if (f && f.isReference && f.referenceData && f.referenceData.tableId !== 0) {
        dcPoolTableId = f.referenceData.tableId;
        break;
      }
    }
    if (dcPoolTableId) break;
  }
  if (!dcPoolTableId) { console.error('Could not resolve DC pool tableId'); process.exit(1); }
  const dcPool = franchise.getTableById(dcPoolTableId);
  await dcPool.readRecords();
  console.log(`  DC pool       : tableId=${dcPoolTableId}, ${dcPool.records.length} records`);

  // Map DC record idx → TeamIndex via Team.DepthChart ref
  const teamMain = await loadPopulated(franchise, 'Team');
  const dcRowToTeamIndex = new Map();
  if (teamMain) {
    for (const teamRec of teamMain.records) {
      if (teamRec.isEmpty) continue;
      const ti = Number(safeGet(teamRec, 'TeamIndex'));
      if (!Number.isFinite(ti) || ti < 0 || ti > 31) continue;
      const dcField = teamRec.getFieldByKey('DepthChart');
      if (dcField && dcField.isReference) {
        const ref = dcField.referenceData;
        if (ref && ref.tableId === dcMain.header.tableId) dcRowToTeamIndex.set(ref.rowNumber, ti);
      }
    }
    console.log(`  Team→DC mapping: ${dcRowToTeamIndex.size} teams resolved`);
  }

  // Per-team active roster grouped by Position, sorted by OverallRating desc.
  const teamRosters = new Map();   // ti → Map<position, [{ row, ovr }]>
  for (let i = 0; i < playerTable.records.length; i++) {
    const rec = playerTable.records[i];
    if (rec.isEmpty) continue;
    const cs = safeGet(rec, 'ContractStatus');
    if (CONTRACT_STATUS_INACTIVE.has(cs)) continue;
    const ti = Number(safeGet(rec, 'TeamIndex'));
    if (!Number.isFinite(ti) || ti < 0 || ti > 31) continue;
    const pos = String(safeGet(rec, 'Position') || '');
    const ovr = Number(safeGet(rec, 'OverallRating')) || 0;
    if (!teamRosters.has(ti)) teamRosters.set(ti, new Map());
    const byPos = teamRosters.get(ti);
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push({ row: i, ovr });
  }
  for (const byPos of teamRosters.values()) {
    for (const list of byPos.values()) list.sort((a, b) => b.ovr - a.ovr);
  }
  let totalActive = 0;
  for (const m of teamRosters.values()) for (const l of m.values()) totalActive += l.length;
  console.log(`  Active vets   : ${totalActive} across ${teamRosters.size} teams\n`);

  const playerTableId = playerTable.header.tableId;
  const refToBin = (rowNumber) =>
    utilService.dec2bin(playerTableId, 15) + utilService.dec2bin(rowNumber, 17);
  const isNullRef = (binStr) => binStr === NULL_REFERENCE || binStr === '0' || binStr == null;

  let teamsTouched = 0, slotsScanned = 0, slotsAlreadyFilled = 0, slotsFilledNow = 0, slotsLeftEmpty = 0;
  for (let i = 0; i < dcMain.records.length; i++) {
    const dcRec = dcMain.records[i];
    if (dcRec.isEmpty) continue;
    let ti = null;
    const tiField = dcRec.getFieldByKey('TeamIndex');
    if (tiField && tiField.value !== undefined) ti = Number(tiField.value);
    if (ti == null || !Number.isFinite(ti) || ti < 0 || ti > 31) {
      ti = dcRowToTeamIndex.get(i);
    }
    if (ti == null || !Number.isFinite(ti)) continue;
    teamsTouched++;
    const teamPos = teamRosters.get(ti) || new Map();

    for (const dcSlotKey of Object.keys(DC_TO_POSITIONS)) {
      const dcField = dcRec.getFieldByKey(dcSlotKey);
      if (!dcField || !dcField.isReference) continue;
      const poolRef = dcField.referenceData;
      if (!poolRef || poolRef.tableId !== dcPoolTableId) continue;
      const poolRec = dcPool.records[poolRef.rowNumber];
      if (!poolRec || poolRec.isEmpty) continue;

      const acceptablePositions = DC_TO_POSITIONS[dcSlotKey];
      const candidates = [];
      const seenRows = new Set();
      for (const pos of acceptablePositions) {
        const list = teamPos.get(pos);
        if (!list) continue;
        for (const c of list) {
          if (seenRows.has(c.row)) continue;
          seenRows.add(c.row);
          candidates.push(c);
        }
      }

      // First pass: collect already-filled rows in this slot to avoid duplicating
      const alreadyHere = new Set();
      for (let s = 0; s < 6; s++) {
        const slotField = poolRec.getFieldByKey(`Player${s}`);
        if (!slotField) continue;
        if (!slotField.isReference) continue;
        const ref = slotField.referenceData;
        if (ref && ref.tableId === playerTableId && ref.rowNumber !== 0) {
          alreadyHere.add(ref.rowNumber);
        }
      }

      let candIdx = 0;
      for (let s = 0; s < 6; s++) {
        const slotField = poolRec.getFieldByKey(`Player${s}`);
        if (!slotField) break;
        slotsScanned++;
        const cur = slotField.value;
        if (!isNullRef(cur)) { slotsAlreadyFilled++; continue; }

        // Find next unused candidate
        let chose = null;
        while (candIdx < candidates.length) {
          const c = candidates[candIdx++];
          if (alreadyHere.has(c.row)) continue;
          chose = c;
          alreadyHere.add(c.row);
          break;
        }
        if (chose) {
          if (!isDryRun) {
            try { slotField.value = refToBin(chose.row); } catch (_) {}
          }
          slotsFilledNow++;
        } else {
          slotsLeftEmpty++;
        }
      }
    }
  }

  console.log(`  Teams touched         : ${teamsTouched}`);
  console.log(`  Slots scanned         : ${slotsScanned}  (32 teams × 35 positions × 6 depth = 6720 ideal)`);
  console.log(`  Slots already filled  : ${slotsAlreadyFilled}`);
  console.log(`  Slots filled this run : ${slotsFilledNow}`);
  console.log(`  Slots left empty      : ${slotsLeftEmpty}  (no candidates at primary or fallback positions)`);

  if (!isDryRun && slotsFilledNow > 0) {
    console.log(`\nSaving franchise file…`);
    await franchise.save(franchisePath);
    console.log('✓ Saved.');
  } else if (isDryRun) {
    console.log('\n(dry-run; no save)');
  } else {
    console.log('\nNo changes to save.');
  }
}

main().catch(e => { console.error('\n✗ Fatal:', e.message || e); process.exit(1); });
