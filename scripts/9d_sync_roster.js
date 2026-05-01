'use strict';

/**
 * Script 9d — Sync Franchise Roster from a Source Roster File
 *
 * Mirrors the Player table of a source .ros (or other Madden 26 roster) file
 * into a target CAREER- franchise file, then layers the generated 2026 rookie
 * class on top with real team assignments.
 *
 * What it does (in order):
 *   1. Opens the source roster file and snapshots every active Player record
 *      (non-empty, overall > 0).
 *   2. Opens the target franchise file and EMPTIES every existing Player
 *      record. Anyone not in the source file is gone after this step.
 *   3. Writes each source player into the next empty slot in the target.
 *      YearDrafted is shifted by −1 by default — the source's "this year"
 *      rookies become last-year's class in the target, on the assumption that
 *      the target franchise is one league year ahead of the source.
 *   4. Injects every prospect from data/prospects_rated.json as a 2026 rookie
 *      (YearDrafted = 0) on their real-life draft team. Prospects without
 *      draft data go to the FA pool.
 *   5. Saves the target franchise file.
 *
 * This is destructive on the franchise — back it up first.
 *
 * Run:
 *   node scripts/9d_sync_roster.js --ros /path/to/SOURCE.ros [--franchise /path/to/CAREER-FRANCHISE]
 *   ROSTER_FILE=… FRANCHISE_FILE=… node scripts/9d_sync_roster.js
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SCRIPT_DIR     = __dirname;
const PROJECT_ROOT   = path.join(SCRIPT_DIR, '..');
const DATA_DIR       = path.join(PROJECT_ROOT, 'data');
const ENV_PATH       = path.join(PROJECT_ROOT, '.env');
const PROSPECTS_FILE = path.join(DATA_DIR, 'prospects_rated.json');
const TEAM_MAP_FILE  = path.join(DATA_DIR, 'nfl_team_id_to_abbr.json');

// ---------------------------------------------------------------------------
// Constants shared with scripts 9 and 9c
// ---------------------------------------------------------------------------
const NFLVERSE_TO_TEAM_INDEX = {
  CHI: 0,  CIN: 1,  BUF: 2,  DEN: 3,  CLE: 4,  TB: 5,  ARI: 6,  LAC: 7,
  KC:  8,  IND: 9,  DAL: 10, MIA: 11, PHI: 12, ATL: 13, SF: 14, NYG: 15,
  JAX: 16, NYJ: 17, DET: 18, GB:  19, CAR: 20, NE:  21, LV: 22, LA:  23,
  BAL: 24, WAS: 25, NO:  26, SEA: 27, PIT: 28, TEN: 29, MIN: 30, HOU: 31,
};
const TEAM_INDEX_FREE_AGENT  = 32;
const CONTRACT_STATUS_SIGNED = '1';

// Mirrors scripts/3_extract_roster_ratings.js / scripts/9c_inject_rookies.js
const FIELD_MAP = {
  overall:              ['OverallRating', 'PlayerBestOvr'],
  speed:                'SpeedRating',
  acceleration:         'AccelerationRating',
  agility:              'AgilityRating',
  strength:             'StrengthRating',
  awareness:            'AwarenessRating',
  throwPower:           'ThrowPowerRating',
  throwAccuracy:        'ThrowAccuracyRating',
  throwAccuracyShort:   'ThrowAccuracyShortRating',
  throwAccuracyMid:     'ThrowAccuracyMidRating',
  throwAccuracyDeep:    'ThrowAccuracyDeepRating',
  throwOnTheRun:        'ThrowOnTheRunRating',
  throwUnderPressure:   'ThrowUnderPressureRating',
  playAction:           'PlayActionRating',
  breakSack:            'BreakSackRating',
  tackle:               'TackleRating',
  hitPower:             'HitPowerRating',
  blockShedding:        'BlockSheddingRating',
  finesseMoves:         'FinesseMoveRating',
  powerMoves:           'PowerMovesRating',
  pursuit:              'PursuitRating',
  zoneCoverage:         'ZoneCoverageRating',
  manCoverage:          'ManCoverageRating',
  pressCoverage:        'PressCoverageRating',
  playRecognition:      'PlayRecognitionRating',
  jumping:              'JumpingRating',
  catching:             'CatchingRating',
  catchInTraffic:       'CatchInTrafficRating',
  spectacularCatch:     'SpectacularCatchRating',
  shortRouteRunning:    'ShortRouteRunningRating',
  mediumRouteRunning:   'MediumRouteRunningRating',
  deepRouteRunning:     'DeepRouteRunningRating',
  release:              'ReleaseRating',
  runBlock:             'RunBlockRating',
  passBlock:            'PassBlockRating',
  runBlockPower:        'RunBlockPowerRating',
  runBlockFinesse:      'RunBlockFinesseRating',
  passBlockPower:       'PassBlockPowerRating',
  passBlockFinesse:     'PassBlockFinesseRating',
  impactBlocking:       ['ImpactBlockRating', 'ImpactBlockingRating'],
  leadBlock:            'LeadBlockRating',
  jukeMove:             'JukeMoveRating',
  spinMove:             'SpinMoveRating',
  stiffArm:             'StiffArmRating',
  trucking:             'TruckingRating',
  breakTackle:          'BreakTackleRating',
  ballCarrierVision:    ['BallCarrierVisionRating', 'BCVisionRating'],
  changeOfDirection:    'ChangeOfDirectionRating',
  carrying:             'CarryingRating',
  kickPower:            'KickPowerRating',
  kickAccuracy:         'KickAccuracyRating',
  kickReturn:           'KickReturnRating',
  stamina:              'StaminaRating',
  toughness:            'ToughnessRating',
  injury:               'InjuryRating',
  morale:               'MoraleRating',
};

const POSITION_JERSEY_RANGES = {
  QB:  [[1, 19]],
  HB:  [[20, 49]],
  FB:  [[40, 49], [20, 39]],
  WR:  [[10, 19], [80, 89], [1, 9]],
  TE:  [[80, 89], [40, 49]],
  T:   [[60, 79]],
  G:   [[60, 79]],
  C:   [[50, 79]],
  DE:  [[90, 99], [50, 79]],
  DT:  [[90, 99], [50, 79]],
  OLB: [[40, 59], [90, 99]],
  MLB: [[40, 59], [90, 99]],
  CB:  [[20, 39], [1, 19], [40, 49]],
  FS:  [[20, 49], [1, 19]],
  SS:  [[20, 49], [1, 19]],
  K:   [[1, 19]],
  P:   [[1, 19]],
  LS:  [[40, 49]],
};

const DEV_TRAIT_STRINGS = ['Normal', 'Star', 'Superstar', 'XFactor'];

// Identity / roster fields we copy verbatim (subject to YearDrafted shift).
const IDENTITY_FIELDS = [
  'FirstName', 'LastName', 'Position', 'College', 'Age', 'Height', 'Weight',
  'BirthDate', 'JerseyNum', 'TeamIndex', 'ContractStatus',
  'YearDrafted', 'YearsPro', 'PLYR_DRAFTROUND', 'PLYR_DRAFTPICK',
  'ContractLength', 'ContractYear',
  'ContractSalary0', 'ContractSalary1', 'ContractSalary2',
  'ContractSalary3', 'ContractSalary4', 'ContractSalary5', 'ContractSalary6',
  'ContractBonus0',  'ContractBonus1',  'ContractBonus2',
  'ContractBonus3',  'ContractBonus4',  'ContractBonus5',  'ContractBonus6',
  'PLYR_CAPSALARY',
];

// Rating field names (flattened from FIELD_MAP).
const RATING_FIELD_NAMES = (() => {
  const out = [];
  for (const v of Object.values(FIELD_MAP)) {
    if (Array.isArray(v)) out.push(...v);
    else                   out.push(v);
  }
  return out;
})();

// ---------------------------------------------------------------------------
// .env / argument parsing
// ---------------------------------------------------------------------------
function loadEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val   = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key) result[key] = val;
  }
  return result;
}

function findFlag(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) return args[i + 1];
  }
  return null;
}

function resolvePaths() {
  const env = loadEnvFile(ENV_PATH);
  const ros = findFlag('--ros') || process.env.ROSTER_FILE || env.ROSTER_FILE || null;
  const fra = findFlag('--franchise') || process.env.FRANCHISE_FILE || env.FRANCHISE_FILE || null;
  return { ros, fra };
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------
function safeGet(record, fieldNames) {
  const names = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
  for (const name of names) {
    try {
      const f = record.getFieldByKey(name);
      if (f !== undefined && f !== null) return f.value;
    } catch (_) { /* try next */ }
  }
  return null;
}

function trySet(record, fieldName, value) {
  if (value === null || value === undefined) return false;
  try {
    const f = record.getFieldByKey(fieldName);
    if (!f) return false;
    f.value = value;
    return true;
  } catch (_) {
    return false;
  }
}

function setDevTrait(record, devValue) {
  const idx = typeof devValue === 'number'
    ? Math.max(0, Math.min(3, devValue))
    : Math.max(0, DEV_TRAIT_STRINGS.indexOf(String(devValue)));
  for (const name of ['TraitDevelopment', 'DevTrait', 'DevelopmentTrait']) {
    try {
      const f = record.getFieldByKey(name);
      if (!f) continue;
      try { f.value = DEV_TRAIT_STRINGS[idx]; return; } catch (_) {}
      try { f.value = idx; return; } catch (_) {}
    } catch (_) { /* try next */ }
  }
}

function safeRating(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(99, Math.round(n)));
}

function parseHeight(htStr) {
  if (!htStr) return 72;
  const parts = String(htStr).split('-');
  return parseInt(parts[0], 10) * 12 + parseInt(parts[1] || 0, 10);
}

function encodeWeight(lbs) {
  const w = Number(lbs);
  if (!Number.isFinite(w) || w <= 0) return 60;
  return Math.max(0, Math.min(255, Math.round(w - 160)));
}

function rookieContract(overallPick, round) {
  if (!overallPick || overallPick <= 0) {
    return { years: 3, totalValue: 2_900_000, signingBonus: 100_000 };
  }
  let totalValue;
  if (overallPick <= 5)        totalValue = 40_000_000;
  else if (overallPick <= 15)  totalValue = 22_000_000;
  else if (overallPick <= 32)  totalValue = 14_000_000;
  else if (overallPick <= 64)  totalValue = 8_000_000;
  else if (overallPick <= 100) totalValue = 5_500_000;
  else if (overallPick <= 150) totalValue = 4_400_000;
  else if (overallPick <= 200) totalValue = 4_000_000;
  else                          totalValue = 3_700_000;
  const years        = round && round <= 4 ? 4 : 3;
  const signingBonus = Math.round(totalValue * 0.45);
  return { years, totalValue, signingBonus };
}

function makeJerseyAllocator() {
  const usedByTeam = new Map();
  return function pickJersey(teamIndex, position) {
    if (!usedByTeam.has(teamIndex)) usedByTeam.set(teamIndex, new Set());
    const used   = usedByTeam.get(teamIndex);
    const ranges = POSITION_JERSEY_RANGES[position] || [[1, 99]];
    for (const [lo, hi] of ranges) {
      for (let n = lo; n <= hi; n++) {
        if (!used.has(n)) { used.add(n); return n; }
      }
    }
    for (let n = 1; n <= 99; n++) {
      if (!used.has(n)) { used.add(n); return n; }
    }
    return 0;
  };
}

// ---------------------------------------------------------------------------
// Source-record snapshot / write
// ---------------------------------------------------------------------------

/** Pull every field we care about off a source Player record into a plain object. */
function snapshotRecord(record) {
  const data = {};
  for (const name of [...IDENTITY_FIELDS, ...RATING_FIELD_NAMES]) {
    const v = safeGet(record, name);
    if (v !== null && v !== undefined) data[name] = v;
  }
  // Dev trait — try string form first, then numeric
  for (const name of ['TraitDevelopment', 'DevTrait', 'DevelopmentTrait']) {
    const v = safeGet(record, name);
    if (v !== null && v !== undefined) {
      data._devTrait = v;
      break;
    }
  }
  return data;
}

/** Apply a snapshot onto an empty target record. */
function applyRecord(record, data, opts = {}) {
  const yearDraftedShift = opts.yearDraftedShift || 0;

  for (const name of IDENTITY_FIELDS) {
    if (!(name in data)) continue;
    let value = data[name];
    if (name === 'YearDrafted' && typeof value === 'number') {
      value = value + yearDraftedShift;
    }
    trySet(record, name, value);
  }
  for (const name of RATING_FIELD_NAMES) {
    if (name in data) trySet(record, name, data[name]);
  }
  if ('_devTrait' in data) setDevTrait(record, data._devTrait);
}

// ---------------------------------------------------------------------------
// Franchise open helper
// ---------------------------------------------------------------------------
function openFranchise(filePath) {
  return new Promise((resolve, reject) => {
    const fra = new Franchise(filePath, { gameYearOverride: 26 });
    fra.on('error', (err) => reject(new Error(`Franchise error (${filePath}): ${err?.message || err}`)));
    fra.on('ready', () => resolve(fra));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(60));
  console.log('Script 9d — Sync Franchise Roster from Source File');
  console.log('='.repeat(60));

  const { ros: rosPath, fra: franchisePath } = resolvePaths();
  if (!rosPath) {
    console.error('\n✗ No source roster file specified.');
    console.error('  Pass --ros /path/to/file.ros, or set ROSTER_FILE in .env');
    process.exit(1);
  }
  if (!franchisePath) {
    console.error('\n✗ No franchise file specified.');
    console.error('  Pass --franchise /path/to/CAREER-FRANCHISE, or set FRANCHISE_FILE in .env');
    process.exit(1);
  }
  if (!fs.existsSync(rosPath))       { console.error(`\n✗ Source not found: ${rosPath}`);       process.exit(1); }
  if (!fs.existsSync(franchisePath)) { console.error(`\n✗ Franchise not found: ${franchisePath}`); process.exit(1); }

  console.log(`\n  Source file    : ${rosPath}`);
  console.log(`  Franchise file : ${franchisePath}`);

  // ── Load prospects + team map ────────────────────────────────────────────
  if (!fs.existsSync(PROSPECTS_FILE)) {
    console.error(`\n✗ Prospects file not found: ${PROSPECTS_FILE}`);
    console.error('  Run the draft-class pipeline first: python3 run.py');
    process.exit(1);
  }
  const prospects  = JSON.parse(fs.readFileSync(PROSPECTS_FILE, 'utf8'));
  const uuidToAbbr = JSON.parse(fs.readFileSync(TEAM_MAP_FILE, 'utf8'));
  console.log(`  Prospects      : ${prospects.length} loaded`);

  // ── Open source and snapshot active players ──────────────────────────────
  console.log(`\n  Reading source roster …`);
  const source            = await openFranchise(rosPath);
  const sourcePlayerTable = source.getTableByName('Player');
  if (!sourcePlayerTable) throw new Error('Source roster has no Player table.');
  await sourcePlayerTable.readRecords();

  const snapshots = [];
  for (const rec of sourcePlayerTable.records) {
    if (rec.isEmpty) continue;
    const overall = safeGet(rec, ['OverallRating', 'PlayerBestOvr']);
    if (!overall || overall <= 0) continue;
    snapshots.push(snapshotRecord(rec));
  }
  console.log(`  Source players : ${snapshots.length} snapshotted`);

  // ── Open target franchise ────────────────────────────────────────────────
  console.log(`\n  Opening franchise …`);
  const target            = await openFranchise(franchisePath);
  const targetPlayerTable = target.getTableByName('Player');
  if (!targetPlayerTable) throw new Error('Franchise has no Player table.');
  await targetPlayerTable.readRecords();
  console.log(`  Player records : ${targetPlayerTable.records.length} (${targetPlayerTable.header.recordCapacity} capacity)`);

  // ── Pass 1: empty every existing Player record ───────────────────────────
  let cleared = 0;
  for (const rec of targetPlayerTable.records) {
    if (rec.isEmpty) continue;
    try { rec.empty(); cleared++; } catch (_) { /* skip un-emptyable records */ }
  }
  console.log(`\n  Cleared        : ${cleared} existing player records`);

  // ── Pass 2: copy source snapshots into the next empty slots ──────────────
  let copied = 0;
  let skippedSource = 0;
  for (const data of snapshots) {
    const idx = targetPlayerTable.header.nextRecordToUse;
    if (idx >= targetPlayerTable.header.recordCapacity) {
      skippedSource++;
      continue;
    }
    const dest = targetPlayerTable.records[idx];
    applyRecord(dest, data, { yearDraftedShift: -1 });
    copied++;
  }
  console.log(`  Copied         : ${copied} source players` +
              (skippedSource > 0 ? `  (skipped ${skippedSource} — table at capacity)` : ''));

  // ── Pass 3: inject 2026 rookies on their real teams ──────────────────────
  const pickJersey  = makeJerseyAllocator();
  let injected      = 0;
  let injectedFA    = 0;
  let injectSkipped = 0;

  for (const p of prospects) {
    let teamIndex = TEAM_INDEX_FREE_AGENT;
    const uuid = p.draftTeamId;
    if (uuid && uuidToAbbr[uuid] && uuidToAbbr[uuid] in NFLVERSE_TO_TEAM_INDEX) {
      teamIndex = NFLVERSE_TO_TEAM_INDEX[uuidToAbbr[uuid]];
    }
    if (teamIndex === TEAM_INDEX_FREE_AGENT) injectedFA++;

    const idx = targetPlayerTable.header.nextRecordToUse;
    if (idx >= targetPlayerTable.header.recordCapacity) { injectSkipped++; continue; }
    const record = targetPlayerTable.records[idx];

    trySet(record, 'FirstName',       String(p.firstName || '').slice(0, 11));
    trySet(record, 'LastName',        String(p.lastName  || '').slice(0, 14));
    trySet(record, 'Position',        String(p.pos || 'WR'));
    trySet(record, 'College',         String(p.school || '').slice(0, 24));
    trySet(record, 'Age',             22);
    trySet(record, 'Height',          parseHeight(p.ht));
    trySet(record, 'Weight',          encodeWeight(p.wt));
    trySet(record, 'TeamIndex',       teamIndex);
    trySet(record, 'ContractStatus',  CONTRACT_STATUS_SIGNED);
    trySet(record, 'YearDrafted',     0);
    trySet(record, 'YearsPro',        0);
    trySet(record, 'PLYR_DRAFTROUND', Math.max(0, Math.min(7,  Number(p.actual_draft_round || p.draftRound || 7))));
    trySet(record, 'PLYR_DRAFTPICK',  Math.max(0, Math.min(99, Number(p.actual_draft_pick  || p.draftPick  || 99))));
    trySet(record, 'JerseyNum',       pickJersey(teamIndex, p.pos));

    const c          = rookieContract(Number(p.actual_draft_pick || p.draftPick || 0),
                                      Number(p.actual_draft_round || p.draftRound || 7));
    const aav        = Math.round(c.totalValue / c.years);
    const baseSalary = Math.max(895, Math.round((aav - c.signingBonus / c.years) / 1000));
    const bonusK     = Math.round(c.signingBonus / c.years / 1000);
    trySet(record, 'ContractLength',  c.years);
    trySet(record, 'ContractYear',    0);
    trySet(record, 'ContractSalary0', baseSalary);
    trySet(record, 'ContractBonus0',  bonusK);
    trySet(record, 'PLYR_CAPSALARY',  baseSalary + bonusK);

    const ratings = p.ratings || {};
    for (const [key, value] of Object.entries(ratings)) {
      const fieldNames = FIELD_MAP[key];
      if (!fieldNames) continue;
      const candidates = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
      for (const name of candidates) {
        if (trySet(record, name, safeRating(value))) break;
      }
    }
    setDevTrait(record, ratings.devTrait || 0);
    injected++;
  }
  console.log(`  Rookies added  : ${injected}` +
              `  (on team: ${injected - injectedFA}, FA: ${injectedFA}` +
              (injectSkipped > 0 ? `, skipped: ${injectSkipped} — table full` : '') +
              ')');

  // ── Save ─────────────────────────────────────────────────────────────────
  console.log(`\nSaving franchise file…`);
  await target.save(franchisePath);
  console.log('✓ Saved.');
}

main().catch((err) => {
  console.error('\n✗ Fatal error:', err.message || err);
  process.exit(1);
});
