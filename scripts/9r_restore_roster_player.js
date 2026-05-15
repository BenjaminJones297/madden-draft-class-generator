'use strict';

/**
 * Script 9r - Restore one roster player into a franchise save.
 *
 * Useful when a real player is missing because the stable 9g recipe does not
 * bulk-move vets and 9m later deleted Madden's fake filler. Matches by
 * name + team + position so duplicate names (e.g. Aaron Brewer LS vs C) are
 * handled safely.
 * Reuses a Deleted Player row when available; otherwise uses the table's next
 * empty row.
 *
 * Usage:
 *   node scripts/9r_restore_roster_player.js --franchise <path> --name "Aaron Brewer" --team ARI --pos LS --apply
 */

const fs = require('fs');
const path = require('path');
const Franchise = require('madden-franchise');
const utilService = require('madden-franchise/services/utilService');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ENV_PATH = path.join(ROOT, '.env');

const TEAM_INDEX = {
  CHI: 0, CIN: 1, BUF: 2, DEN: 3, CLE: 4, TB: 5, ARI: 6, LAC: 7,
  KC: 8, IND: 9, DAL: 10, MIA: 11, PHI: 12, ATL: 13, SF: 14, NYG: 15,
  JAX: 16, NYJ: 17, DET: 18, GB: 19, CAR: 20, NE: 21, LV: 22, LA: 23,
  BAL: 24, WAS: 25, NO: 26, SEA: 27, PIT: 28, TEN: 29, MIN: 30, HOU: 31,
};
const TEAM_INDEX_FREE_AGENT = 32;
const CONTRACT_STATUS_SIGNED = 'Signed';
const SALARY_UNIT_USD = 10_000;
const MIN_SALARY_K = 90;
const CURRENT_LEAGUE_YEAR = 2026;
const NULL_REFERENCE = '0'.repeat(32);

const FIELD_MAP = {
  overall: ['OverallRating', 'PlayerBestOvr'],
  overallStored: ['OverallRating', 'PlayerBestOvr'],
  speed: 'SpeedRating',
  acceleration: 'AccelerationRating',
  agility: 'AgilityRating',
  strength: 'StrengthRating',
  awareness: 'AwarenessRating',
  throwPower: 'ThrowPowerRating',
  throwAccuracy: 'ThrowAccuracyRating',
  throwAccuracyShort: 'ThrowAccuracyShortRating',
  throwAccuracyMid: 'ThrowAccuracyMidRating',
  throwAccuracyDeep: 'ThrowAccuracyDeepRating',
  throwOnTheRun: 'ThrowOnTheRunRating',
  throwUnderPressure: 'ThrowUnderPressureRating',
  playAction: 'PlayActionRating',
  breakSack: 'BreakSackRating',
  tackle: 'TackleRating',
  hitPower: 'HitPowerRating',
  blockShedding: 'BlockSheddingRating',
  finesseMoves: 'FinesseMoveRating',
  powerMoves: 'PowerMovesRating',
  pursuit: 'PursuitRating',
  zoneCoverage: 'ZoneCoverageRating',
  manCoverage: 'ManCoverageRating',
  pressCoverage: ['PressRating', 'PressCoverageRating'],
  playRecognition: 'PlayRecognitionRating',
  jumping: 'JumpingRating',
  catching: 'CatchingRating',
  catchInTraffic: 'CatchInTrafficRating',
  spectacularCatch: 'SpectacularCatchRating',
  shortRouteRunning: 'ShortRouteRunningRating',
  mediumRouteRunning: 'MediumRouteRunningRating',
  deepRouteRunning: 'DeepRouteRunningRating',
  release: 'ReleaseRating',
  runBlock: 'RunBlockRating',
  passBlock: 'PassBlockRating',
  runBlockPower: 'RunBlockPowerRating',
  runBlockFinesse: 'RunBlockFinesseRating',
  passBlockPower: 'PassBlockPowerRating',
  passBlockFinesse: 'PassBlockFinesseRating',
  impactBlocking: ['ImpactBlockRating', 'ImpactBlockingRating'],
  leadBlock: 'LeadBlockRating',
  jukeMove: 'JukeMoveRating',
  spinMove: 'SpinMoveRating',
  stiffArm: 'StiffArmRating',
  trucking: 'TruckingRating',
  breakTackle: 'BreakTackleRating',
  ballCarrierVision: ['BallCarrierVisionRating', 'BCVisionRating'],
  bcVision: ['BallCarrierVisionRating', 'BCVisionRating'],
  changeOfDirection: 'ChangeOfDirectionRating',
  carrying: 'CarryingRating',
  kickPower: 'KickPowerRating',
  kickAccuracy: 'KickAccuracyRating',
  kickReturn: 'KickReturnRating',
  longSnap: 'LongSnapRating',
  stamina: 'StaminaRating',
  toughness: 'ToughnessRating',
  injury: 'InjuryRating',
  morale: 'MoraleRating',
};

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
function parseHeight(htStr, fallback = 72) {
  if (!htStr) return fallback;
  const m = String(htStr).match(/^(\d+)-(\d+)$/);
  if (!m) return fallback;
  return Number(m[1]) * 12 + Number(m[2]);
}
function encodeWeight(lbs, fallback = 60) {
  const n = Number(lbs);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(0, Math.min(255, Math.round(n - 160)));
}
function ageAtSeasonStart(dobIso) {
  if (!dobIso) return null;
  const dob = new Date(dobIso);
  if (Number.isNaN(dob.getTime())) return null;
  const seasonStart = Date.UTC(CURRENT_LEAGUE_YEAR, 8, 1);
  return Math.floor((seasonStart - dob.getTime()) / (365.25 * 24 * 3600 * 1000));
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function displayName(entry) {
  return entry.name || entry.playerName || entry.player_name ||
    [entry.firstName || entry.first_name || entry.FirstName, entry.lastName || entry.last_name || entry.LastName]
      .filter(Boolean)
      .join(' ');
}
function entryTeamIndex(entry) {
  if (entry.TeamIndex !== undefined) return Number(entry.TeamIndex);
  const abbr = String(entry.team || entry.Team || '').toUpperCase();
  return TEAM_INDEX[abbr];
}
function entryPos(entry) {
  return String(entry.pos || entry.position || entry.Position || '').toUpperCase();
}
function selectEntry(file, name, teamIndex, pos) {
  const data = readJson(file);
  const entries = Array.isArray(data) ? data : Object.values(data).flatMap(v => Array.isArray(v) ? v : [v]);
  const hits = entries.filter(entry =>
    norm(displayName(entry)) === norm(name) &&
    entryTeamIndex(entry) === teamIndex &&
    entryPos(entry) === pos
  );
  if (hits.length !== 1) {
    throw new Error(`Expected exactly one ${name} ${pos} teamIndex=${teamIndex} in ${file}; found ${hits.length}.`);
  }
  return hits[0];
}
function ratingFields(ratings) {
  const out = {};
  for (const [key, value] of Object.entries(ratings || {})) {
    if (/Rating$/.test(key) || /^OverallGrade\d$/.test(key) || key === 'TraitDevelopment') {
      out[key] = value;
      continue;
    }
    const target = FIELD_MAP[key];
    if (!target) continue;
    for (const fieldName of Array.isArray(target) ? target : [target]) out[fieldName] = value;
  }
  return out;
}
function applyRatings(rec, ratings) {
  for (const [key, value] of Object.entries(ratingFields(ratings))) {
    if (key === 'TraitDevelopment') {
      trySet(rec, key, value);
      continue;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    const v = Math.max(0, Math.min(99, Math.round(n)));
    trySet(rec, key, v);
    trySet(rec, `Original${key}`, v);
  }
}
function writeContract(rec, rosterEntry) {
  const length = Math.max(1, Math.min(7, Number(rosterEntry.contractLength || rosterEntry.contract_years || 1) | 0));
  const yearsLeft = Math.max(1, Math.min(length, Number(rosterEntry.contractYearsLeft || rosterEntry.contract_years || 1) | 0));
  const contractYear = Math.max(0, Math.min(length - 1, length - yearsLeft));
  const salary = Number(rosterEntry.contractSalary);
  const bonus = Number(rosterEntry.contractBonus);
  const aav = Number(rosterEntry.aav || rosterEntry.contractAAV || 0);
  const salaryK = Number.isFinite(salary) && salary > 0
    ? Math.max(MIN_SALARY_K, Math.round(salary / SALARY_UNIT_USD))
    : Math.max(MIN_SALARY_K, Math.round(aav / SALARY_UNIT_USD));
  const bonusK = Number.isFinite(bonus) && bonus > 0 ? Math.round(bonus / SALARY_UNIT_USD) : 0;

  trySet(rec, 'ContractStatus', CONTRACT_STATUS_SIGNED);
  trySet(rec, 'ContractLength', length);
  trySet(rec, 'ContractYear', contractYear);
  for (let i = 0; i < 8; i++) {
    const onContract = i < length;
    trySet(rec, `ContractSalary${i}`, onContract ? salaryK : 0);
    trySet(rec, `ContractBonus${i}`, onContract ? bonusK : 0);
  }
  trySet(rec, 'PLYR_CAPSALARY', salaryK + bonusK);
}
function getPlayerSlot(rec, i) {
  try {
    return rec.getFieldByKey(`Player${i}`);
  } catch {
    return null;
  }
}
function isPlayerRef(field, playerTableId, playerRow) {
  const r = field?.referenceData;
  return Boolean(field?.isReference && r && r.tableId === playerTableId && r.rowNumber === playerRow);
}
function isNullishRef(field) {
  const r = field?.referenceData;
  return !r || (r.tableId === 0 && r.rowNumber === 0);
}
async function loadPopulated(franchise, name, minLive = 30) {
  for (const t of franchise.tables.filter(t => t.name === name)) {
    try { await t.readRecords(); } catch { continue; }
    if (t.records.filter(r => !r.isEmpty).length >= minLive) return t;
  }
  return null;
}
async function teamRosterContext(franchise) {
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
  return { teamMain, rosterTable, tiToRosterRow };
}
function appendToRoster(ctx, playerTableId, teamIndex, playerRow) {
  const rosterRow = ctx.tiToRosterRow.get(teamIndex);
  if (rosterRow === undefined) return false;
  const rec = ctx.rosterTable.records[rosterRow];
  if (!rec || rec.isEmpty) return false;
  for (let i = 0; i < 3500; i++) {
    const f = getPlayerSlot(rec, i);
    if (!f) break;
    if (isPlayerRef(f, playerTableId, playerRow)) return true;
  }
  for (let i = 0; i < 3500; i++) {
    const f = getPlayerSlot(rec, i);
    if (!f) break;
    if (!isNullishRef(f)) continue;
    f.value = utilService.getBinaryReferenceData
      ? utilService.getBinaryReferenceData(playerTableId, playerRow)
      : utilService.dec2bin(playerTableId, 15) + utilService.dec2bin(playerRow, 17);
    return true;
  }
  return false;
}
async function recalculateRosterSizes(playerTable, teamMain) {
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
  const teamAbbr = String(findFlag('--team', '')).toUpperCase();
  const pos = String(findFlag('--pos', '')).toUpperCase();
  const apply = hasFlag('--apply');
  const ratingSourcePath = path.resolve(ROOT, findFlag('--ratings-source', 'data/franchise_ratings.json'));
  const rosterSourcePath = path.resolve(ROOT, findFlag('--roster-source', 'data/roster_players_rated.json'));

  if (!franchisePath || !fs.existsSync(franchisePath)) throw new Error('--franchise <path> required.');
  if (!name || !teamAbbr || !pos) throw new Error('--name, --team, and --pos are required.');
  const teamIndex = TEAM_INDEX[teamAbbr];
  if (teamIndex === undefined) throw new Error(`Unknown team: ${teamAbbr}`);

  const ratingEntry = selectEntry(ratingSourcePath, name, teamIndex, pos);
  const rosterEntry = selectEntry(rosterSourcePath, name, teamIndex, pos);

  console.log('='.repeat(64));
  console.log('Script 9r - Restore Roster Player');
  console.log('='.repeat(64));
  console.log(`  Franchise : ${franchisePath}`);
  console.log(`  Player    : ${name} / ${teamAbbr} / ${pos}`);
  console.log(`  Mode      : ${apply ? 'WRITE' : 'DRY-RUN'}\n`);

  const franchise = await loadFranchise(franchisePath);
  const playerTable = franchise.getTableByName('Player');
  await playerTable.readRecords();
  const playerTableId = playerTable.header.tableId;
  const rosterCtx = await teamRosterContext(franchise);

  const existing = [];
  for (let i = 0; i < playerTable.records.length; i++) {
    const rec = playerTable.records[i];
    if (rec.isEmpty) continue;
    if (norm(playerName(rec)) === norm(name) &&
        String(safeGet(rec, 'Position')).toUpperCase() === pos &&
        Number(safeGet(rec, 'TeamIndex')) === teamIndex &&
        safeGet(rec, 'ContractStatus') !== 'Deleted') {
      existing.push(i);
    }
  }
  if (existing.length) {
    console.log(`Already present on ${teamAbbr}: row(s) ${existing.join(', ')}`);
    return;
  }

  let targetRow = -1;
  let targetKind = 'deleted';
  for (let i = 0; i < playerTable.records.length; i++) {
    const rec = playerTable.records[i];
    if (rec.isEmpty) continue;
    if (safeGet(rec, 'ContractStatus') === 'Deleted' && String(safeGet(rec, 'Position')).toUpperCase() === pos) {
      targetRow = i;
      break;
    }
  }
  if (targetRow < 0) {
    for (let i = 0; i < playerTable.records.length; i++) {
      const rec = playerTable.records[i];
      if (!rec.isEmpty && safeGet(rec, 'ContractStatus') === 'Deleted') {
        targetRow = i;
        break;
      }
    }
  }
  if (targetRow < 0) {
    const next = Number(playerTable.header.nextRecordToUse);
    if (Number.isFinite(next) &&
        next >= 0 &&
        next < playerTable.header.recordCapacity &&
        playerTable.records[next]?.isEmpty) {
      targetRow = next;
      targetKind = 'empty';
    }
  }
  if (targetRow < 0) {
    for (let i = 0; i < playerTable.records.length; i++) {
      if (playerTable.records[i].isEmpty) {
        targetRow = i;
        targetKind = 'empty';
        break;
      }
    }
  }
  if (targetRow < 0) throw new Error('No deleted or empty Player row available to reuse.');

  const rec = playerTable.records[targetRow];
  const yearsPro = Math.max(
    Number(ratingEntry.YearsPro || 0),
    Number(rosterEntry.experience || 0) + (String(rosterEntry.season || '') === '2025' ? 1 : 0)
  );
  const age = ageAtSeasonStart(rosterEntry.birthDate || rosterEntry.birth_date) ?? Number(ratingEntry.Age || 22);

  console.log(`Will reuse ${targetKind} row ${targetRow}: ${playerName(rec) || '(empty)'} / ${safeGet(rec, 'Position') || '(none)'} / ${safeGet(rec, 'ContractStatus') || '(none)'}`);
  console.log(`  Ratings source: ${path.relative(ROOT, ratingSourcePath)} row ${ratingEntry.row ?? '(n/a)'}`);
  console.log(`  Roster source : ${path.relative(ROOT, rosterSourcePath)}`);

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to write.');
    return;
  }

  trySet(rec, 'FirstName', String(rosterEntry.firstName || rosterEntry.first_name || ratingEntry.FirstName || name.split(/\s+/)[0]).slice(0, 11));
  trySet(rec, 'LastName', String(rosterEntry.lastName || rosterEntry.last_name || ratingEntry.LastName || name.split(/\s+/).slice(1).join(' ')).slice(0, 14));
  trySet(rec, 'Position', pos);
  trySet(rec, 'TeamIndex', teamIndex);
  trySet(rec, 'PrevTeamIndex', teamIndex);
  trySet(rec, 'Age', age);
  trySet(rec, 'Height', Number(ratingEntry.Height) || parseHeight(rosterEntry.ht || rosterEntry.height));
  trySet(rec, 'Weight', Number(ratingEntry.Weight) || encodeWeight(rosterEntry.wt || rosterEntry.weight));
  trySet(rec, 'YearsPro', yearsPro);
  trySet(rec, 'YearDrafted', Number(ratingEntry.YearDrafted) || -Math.max(1, yearsPro));
  trySet(rec, 'PLYR_DRAFTROUND', Number(ratingEntry.PLYR_DRAFTROUND) || 63);
  trySet(rec, 'PLYR_DRAFTPICK', Number(ratingEntry.PLYR_DRAFTPICK) || 511);
  trySet(rec, 'PlayerType', ratingEntry.PlayerType || `${pos}_Accurate`);
  trySet(rec, 'JerseyNum', Number(rosterEntry.jerseyNumber || rosterEntry.jersey_number) || 46);
  trySet(rec, 'PLYR_ASSETNAME', `${String(ratingEntry.LastName || rosterEntry.lastName || '').replace(/[^A-Za-z]/g, '')}${String(ratingEntry.FirstName || rosterEntry.firstName || '').replace(/[^A-Za-z]/g, '')}`);
  trySet(rec, 'PLYR_PORTRAIT', 0);
  trySet(rec, 'PortraitForceSilhouette', false);
  trySet(rec, 'PLYR_ICON', false);
  trySet(rec, 'PLYR_FLAGPROBOWL', false);
  trySet(rec, 'ContractExtraYearOption', false);
  trySet(rec, 'PLYR_CONSECYEARSWITHTEAM', 0);

  applyRatings(rec, ratingEntry.ratings || rosterEntry.ratings || {});
  writeContract(rec, rosterEntry);

  if (!appendToRoster(rosterCtx, playerTableId, teamIndex, targetRow)) {
    throw new Error(`Could not append row ${targetRow} to ${teamAbbr} roster.`);
  }
  await recalculateRosterSizes(playerTable, rosterCtx.teamMain);

  console.log('\nSaving franchise file...');
  await franchise.save(franchisePath);
  console.log(`Restored ${name} to ${teamAbbr} as ${pos} on row ${targetRow}.`);
})().catch(err => {
  console.error('\nFatal:', err.message || err);
  process.exit(1);
});
