'use strict';

/**
 * Script 9s - Force one-way player move (single-player trade).
 *
 * Moves one Player record from --from-team to --to-team in an existing
 * franchise save. Matches by name + position + from-team so duplicate names
 * (e.g. two Aaron Brewers) are handled safely. Single-player scope only -
 * for bulk vet team moves see decisions.md 2026-05-08 (PM) (those CTD).
 *
 * What it touches (minimum-viable invariant set):
 *   - Player.TeamIndex          : new team
 *   - Player.PrevTeamIndex      : old team
 *   - Player.PLYR_CONSECYEARSWITHTEAM = 0
 *   - Team.Roster[old].PlayerN  : null the slot referencing this player
 *   - Team.Roster[new].PlayerN  : append player ref to first empty slot
 *   - Team[old].Active/SalCap/SalCapNextYearRosterSize : recalculated
 *   - Team[new].Active/SalCap/SalCapNextYearRosterSize : recalculated
 *
 * What it does NOT touch (deferred - run 9j after if depth chart looks wrong):
 *   - DepthChart pool slots referencing the player on the old team
 *   - ContractOffer / PlayerReSignNegotiation / PlayerAcquisitionEvaluation
 *   - Franchise.FreeAgents pool (player isn't an FA either way)
 *
 * Usage:
 *   node scripts/9s_force_trade.js --franchise <path> \
 *     --name "Russell Wilson" --from-team NYG --to-team CLE --pos QB
 *
 *   # write to file (default is dry-run):
 *   node scripts/9s_force_trade.js --franchise <path> ... --pos QB --apply
 */

const fs = require('fs');
const path = require('path');
const Franchise = require('madden-franchise');
const utilService = require('madden-franchise/services/utilService');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

const TEAM_INDEX = {
  CHI: 0, CIN: 1, BUF: 2, DEN: 3, CLE: 4, TB: 5, ARI: 6, LAC: 7,
  KC: 8, IND: 9, DAL: 10, MIA: 11, PHI: 12, ATL: 13, SF: 14, NYG: 15,
  JAX: 16, NYJ: 17, DET: 18, GB: 19, CAR: 20, NE: 21, LV: 22, LA: 23,
  BAL: 24, WAS: 25, NO: 26, SEA: 27, PIT: 28, TEN: 29, MIN: 30, HOU: 31,
};
const TEAM_ABBR = Object.fromEntries(Object.entries(TEAM_INDEX).map(([a, i]) => [i, a]));
const NULL_REFERENCE = '0'.repeat(32);

function findFlag(name, def = null) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : def;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const result = {};
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  }
  return result;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function safeGet(rec, key) {
  try {
    const f = rec.getFieldByKey(key);
    return f ? f.value : undefined;
  } catch {
    return undefined;
  }
}

function trySet(rec, key, value) {
  try {
    const f = rec.getFieldByKey(key);
    if (!f) return false;
    f.value = value;
    return true;
  } catch {
    return false;
  }
}

function playerName(rec) {
  return `${safeGet(rec, 'FirstName') || ''} ${safeGet(rec, 'LastName') || ''}`.trim();
}

async function loadPopulated(franchise, name, minLive = 30) {
  for (const t of franchise.tables.filter(t => t.name === name)) {
    try { await t.readRecords(); } catch { continue; }
    if (t.records.filter(r => !r.isEmpty).length >= minLive) return t;
  }
  return null;
}

async function teamRosterContext(franchise, playerTableId) {
  const teamMain = await loadPopulated(franchise, 'Team');
  if (!teamMain) throw new Error('No populated Team table found.');
  let rosterTable = null;
  const tiToRosterRow = new Map();
  for (const rec of teamMain.records) {
    if (rec.isEmpty) continue;
    const ti = Number(safeGet(rec, 'TeamIndex'));
    const roster = rec.getFieldByKey('Roster');
    if (Number.isFinite(ti) && roster?.isReference) {
      tiToRosterRow.set(ti, roster.referenceData.rowNumber);
      if (!rosterTable) rosterTable = franchise.getTableById(roster.referenceData.tableId);
    }
  }
  if (!rosterTable) throw new Error('No team Roster table found.');
  await rosterTable.readRecords();
  return { teamMain, rosterTable, tiToRosterRow, playerTableId };
}

function getPlayerSlot(rec, i) {
  try { return rec.getFieldByKey(`Player${i}`); } catch { return null; }
}

function isPlayerRef(field, playerTableId, playerRow) {
  const r = field?.referenceData;
  return Boolean(field?.isReference && r && r.tableId === playerTableId && r.rowNumber === playerRow);
}

function isNullishRef(field) {
  const r = field?.referenceData;
  return !r || (r.tableId === 0 && r.rowNumber === 0);
}

function getRosterRow(ctx, teamIndex) {
  const rosterRow = ctx.tiToRosterRow.get(teamIndex);
  if (rosterRow === undefined) return null;
  const rec = ctx.rosterTable.records[rosterRow];
  if (!rec || rec.isEmpty) return null;
  return rec;
}

function findRosterSlot(ctx, teamIndex, playerRow) {
  const rec = getRosterRow(ctx, teamIndex);
  if (!rec) return null;
  const size = Number(rec.arraySize ?? 0);
  for (let i = 0; i < size; i++) {
    const f = getPlayerSlot(rec, i);
    if (!f) break;
    if (isPlayerRef(f, ctx.playerTableId, playerRow)) return { rec, field: f, slotIdx: i, arraySize: size };
  }
  return null;
}

// Shift-compact removal. Nulling a Player ref in-place triggers the
// madden-franchise library to shrink the record's arraySize to that index
// (FranchiseFileRecord.js:146-151), orphaning every slot after it. To
// remove the player without truncating the array, copy slots K+1..size-1
// down by one and null only the last slot.
function compactRemoveFromRoster(ctx, teamIndex, playerRow) {
  const slot = findRosterSlot(ctx, teamIndex, playerRow);
  if (!slot) return null;
  const { rec, slotIdx, arraySize } = slot;
  // Snapshot tail ref values before any mutation.
  const tail = [];
  for (let i = slotIdx + 1; i < arraySize; i++) {
    const f = getPlayerSlot(rec, i);
    if (!f) break;
    tail.push(f.value);
  }
  // Shift down.
  for (let i = 0; i < tail.length; i++) {
    const dst = getPlayerSlot(rec, slotIdx + i);
    if (!dst) break;
    dst.value = tail[i];
  }
  // Null the now-vacated last slot. This is the ONLY null-in-place we do,
  // and the lib will correctly shrink arraySize from N to N-1.
  const lastIdx = arraySize - 1;
  const last = getPlayerSlot(rec, lastIdx);
  if (last) last.value = NULL_REFERENCE;
  return { slotIdx, arraySize };
}

function appendToRoster(ctx, teamIndex, playerRow) {
  const rec = getRosterRow(ctx, teamIndex);
  if (!rec) return -1;
  // Already present?
  const size = Number(rec.arraySize ?? 0);
  for (let i = 0; i < size; i++) {
    const f = getPlayerSlot(rec, i);
    if (!f) break;
    if (isPlayerRef(f, ctx.playerTableId, playerRow)) return i;
  }
  // Prefer appending at the array boundary so arraySize grows by exactly 1.
  // If somehow there's an internal null gap, fall back to filling it (which
  // does not change arraySize and is safe).
  const writeRef = utilService.getBinaryReferenceData
    ? utilService.getBinaryReferenceData(ctx.playerTableId, playerRow)
    : utilService.dec2bin(ctx.playerTableId, 15) + utilService.dec2bin(playerRow, 17);
  const boundary = getPlayerSlot(rec, size);
  if (boundary) {
    boundary.value = writeRef;
    return size;
  }
  for (let i = 0; i < size; i++) {
    const f = getPlayerSlot(rec, i);
    if (!f) break;
    if (!isNullishRef(f)) continue;
    f.value = writeRef;
    return i;
  }
  return -1;
}

async function recalcRosterSizes(playerTable, teamMain, onlyTeamIndices = null) {
  const want = onlyTeamIndices ? new Set(onlyTeamIndices) : null;
  for (const teamRec of teamMain.records) {
    if (teamRec.isEmpty) continue;
    const ti = Number(safeGet(teamRec, 'TeamIndex'));
    if (!Number.isFinite(ti) || ti < 0 || ti > 31) continue;
    if (want && !want.has(ti)) continue;
    let active = 0, salCap = 0, nextYear = 0;
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
  }
}

function loadFranchise(file) {
  return new Promise((resolve, reject) => {
    const franchise = new Franchise(file, { gameYearOverride: 26, autoUnempty: true });
    franchise.on('error', reject);
    franchise.on('ready', () => resolve(franchise));
  });
}

(async () => {
  const env = loadEnvFile(ENV_PATH);
  const franchisePath = findFlag('--franchise') || process.env.FRANCHISE_FILE || env.FRANCHISE_FILE;
  const name = findFlag('--name');
  const fromAbbr = String(findFlag('--from-team', '')).toUpperCase();
  const toAbbr = String(findFlag('--to-team', '')).toUpperCase();
  const pos = String(findFlag('--pos', '')).toUpperCase();
  const apply = hasFlag('--apply');

  if (!franchisePath || !fs.existsSync(franchisePath)) {
    throw new Error('--franchise <path> required (or set FRANCHISE_FILE in .env)');
  }
  if (!name || !fromAbbr || !toAbbr || !pos) {
    throw new Error('--name, --from-team, --to-team, and --pos are all required.');
  }
  const fromIdx = TEAM_INDEX[fromAbbr];
  const toIdx = TEAM_INDEX[toAbbr];
  if (fromIdx === undefined) throw new Error(`Unknown from-team: ${fromAbbr}`);
  if (toIdx === undefined) throw new Error(`Unknown to-team: ${toAbbr}`);
  if (fromIdx === toIdx) throw new Error('--from-team and --to-team must differ.');

  console.log('='.repeat(64));
  console.log('Script 9s - Force Trade (one-way player move)');
  console.log('='.repeat(64));
  console.log(`  Franchise : ${franchisePath}`);
  console.log(`  Player    : ${name} / ${pos}`);
  console.log(`  Move      : ${fromAbbr} (idx ${fromIdx}) -> ${toAbbr} (idx ${toIdx})`);
  console.log(`  Mode      : ${apply ? 'WRITE' : 'DRY-RUN'}\n`);

  const franchise = await loadFranchise(franchisePath);
  const playerTable = franchise.getTableByName('Player');
  if (!playerTable) throw new Error('Player table not found.');
  await playerTable.readRecords();
  const playerTableId = playerTable.header.tableId;
  const rosterCtx = await teamRosterContext(franchise, playerTableId);

  // Locate the player.
  const matches = [];
  for (let i = 0; i < playerTable.records.length; i++) {
    const rec = playerTable.records[i];
    if (rec.isEmpty) continue;
    if (norm(playerName(rec)) !== norm(name)) continue;
    if (String(safeGet(rec, 'Position') || '').toUpperCase() !== pos) continue;
    if (Number(safeGet(rec, 'TeamIndex')) !== fromIdx) continue;
    const cs = safeGet(rec, 'ContractStatus');
    if (cs === 'Deleted' || cs === 'Retired' || cs === 'None') continue;
    matches.push(i);
  }
  if (matches.length === 0) {
    throw new Error(`No matching player on ${fromAbbr} at ${pos} named "${name}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} matches for "${name}" / ${fromAbbr} / ${pos}; expected exactly one. Rows: ${matches.join(', ')}`);
  }
  const playerRow = matches[0];
  const rec = playerTable.records[playerRow];

  // Pre-flight: confirm slot exists in old team's roster.
  const oldSlot = findRosterSlot(rosterCtx, fromIdx, playerRow);
  if (!oldSlot) {
    console.log(`  WARN: ${name} (row ${playerRow}) has TeamIndex=${fromIdx} but is not in Team[${fromAbbr}].Roster.`);
    console.log(`        Will proceed to set TeamIndex + append to new team; no slot to null on old team.`);
  } else {
    console.log(`  Found on ${fromAbbr}: Player row ${playerRow}, Roster slot Player${oldSlot.slotIdx}`);
  }

  // Pre-flight: capture current state for the summary.
  const curTi = Number(safeGet(rec, 'TeamIndex'));
  const curPrev = Number(safeGet(rec, 'PrevTeamIndex'));
  const curConsec = Number(safeGet(rec, 'PLYR_CONSECYEARSWITHTEAM'));
  const curCs = safeGet(rec, 'ContractStatus');
  console.log('');
  console.log('  Before:');
  console.log(`    TeamIndex                : ${curTi} (${TEAM_ABBR[curTi] || '?'})`);
  console.log(`    PrevTeamIndex            : ${curPrev} (${TEAM_ABBR[curPrev] || '?'})`);
  console.log(`    PLYR_CONSECYEARSWITHTEAM : ${curConsec}`);
  console.log(`    ContractStatus           : ${curCs}`);
  console.log('');
  console.log('  Plan:');
  console.log(`    TeamIndex                : ${curTi} -> ${toIdx}`);
  console.log(`    PrevTeamIndex            : ${curPrev} -> ${fromIdx}`);
  console.log(`    PLYR_CONSECYEARSWITHTEAM : ${curConsec} -> 0`);
  console.log(`    Old roster slot          : ${oldSlot ? `shift-compact Team[${fromAbbr}].Roster slots ${oldSlot.slotIdx}..${oldSlot.arraySize - 1}` : '(none to compact)'}`);
  console.log(`    New roster slot          : append at Team[${toAbbr}].Roster boundary (slot=arraySize)`);
  console.log(`    Roster-size recalc       : ${fromAbbr}, ${toAbbr}`);
  console.log('');

  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to write.');
    return;
  }

  // Apply.
  trySet(rec, 'TeamIndex', toIdx);
  trySet(rec, 'PrevTeamIndex', fromIdx);
  trySet(rec, 'PLYR_CONSECYEARSWITHTEAM', 0);

  if (oldSlot) {
    const removed = compactRemoveFromRoster(rosterCtx, fromIdx, playerRow);
    if (!removed) {
      throw new Error(`Failed to compact-remove player from ${fromAbbr} roster slot Player${oldSlot.slotIdx}.`);
    }
    console.log(`  Removed from ${fromAbbr}.Roster slot ${removed.slotIdx} (compacted slots ${removed.slotIdx + 1}..${removed.arraySize - 1} down by 1; arraySize: ${removed.arraySize} -> ${removed.arraySize - 1}).`);
  }
  const newSlotIdx = appendToRoster(rosterCtx, toIdx, playerRow);
  if (newSlotIdx < 0) {
    throw new Error(`Failed to append player row ${playerRow} to ${toAbbr} roster.`);
  }
  console.log(`  Appended to ${toAbbr}.Roster.Player${newSlotIdx}`);

  await recalcRosterSizes(playerTable, rosterCtx.teamMain, [fromIdx, toIdx]);
  console.log(`  Recalculated roster sizes for ${fromAbbr} and ${toAbbr}.`);

  console.log('\nSaving franchise file...');
  await franchise.save(franchisePath);
  console.log(`OK: ${name} (${pos}) moved ${fromAbbr} -> ${toAbbr}.`);
  console.log('Suggested next: node scripts/9z_validate_franchise.js --franchise <path>');
})().catch(err => {
  console.error('\nFatal:', err.message || err);
  process.exit(1);
});
