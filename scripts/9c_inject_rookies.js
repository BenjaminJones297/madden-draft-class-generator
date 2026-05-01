'use strict';

/**
 * Script 9c — Inject 2026 Rookies Directly into a Franchise Roster
 *
 * Reads `data/prospects_rated.json` (rookies + Madden ratings produced by the
 * draft-class pipeline) and writes them straight into the franchise's Player
 * table — bypassing the Custom Draft Class import. Useful when your franchise
 * is past the 2026 NFL draft and you want to replace Madden's CPU-drafted
 * rookies with the ones from this tool.
 *
 * Behavior:
 *   1. Empties every Player record in the franchise with `YearDrafted == 0`
 *      (i.e. the auto-generated 2026 rookie class).
 *   2. For each prospect in prospects_rated.json:
 *        - Resolves the drafting team via `draftTeamId` (UUID lookup); if no
 *          draft data is present the rookie goes to the FA pool.
 *        - Picks a position-appropriate jersey number, avoiding collisions
 *          with rookies we've placed on the same team in this run.
 *        - Sets a 4-year rookie-scale contract sized roughly to the draft pick.
 *        - Writes name, position, height, weight, age, ratings, dev trait,
 *          draft round/pick, and contract fields into the next empty slot.
 *
 * Veteran ratings are NEVER touched — the script only deletes 2026 rookies and
 * inserts new ones.
 *
 * Run:
 *   node scripts/9c_inject_rookies.js [--franchise /path/to/CAREER-FRANCHISE]
 *   FRANCHISE_FILE=/path/to/CAREER-FRANCHISE node scripts/9c_inject_rookies.js
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SCRIPT_DIR    = __dirname;
const PROJECT_ROOT  = path.join(SCRIPT_DIR, '..');
const DATA_DIR      = path.join(PROJECT_ROOT, 'data');
const ENV_PATH      = path.join(PROJECT_ROOT, '.env');
const PROSPECTS_FILE = path.join(DATA_DIR, 'prospects_rated.json');
const TEAM_MAP_FILE  = path.join(DATA_DIR, 'nfl_team_id_to_abbr.json');

// ---------------------------------------------------------------------------
// nflverse abbreviation → Madden franchise TeamIndex (0-31)
// (mirrors scripts/9_apply_transactions.js so the two tools agree)
// ---------------------------------------------------------------------------
const NFLVERSE_TO_TEAM_INDEX = {
  CHI: 0,  CIN: 1,  BUF: 2,  DEN: 3,  CLE: 4,  TB: 5,  ARI: 6,  LAC: 7,
  KC:  8,  IND: 9,  DAL: 10, MIA: 11, PHI: 12, ATL: 13, SF: 14, NYG: 15,
  JAX: 16, NYJ: 17, DET: 18, GB:  19, CAR: 20, NE:  21, LV: 22, LA:  23,
  BAL: 24, WAS: 25, NO:  26, SEA: 27, PIT: 28, TEN: 29, MIN: 30, HOU: 31,
};
const TEAM_INDEX_FREE_AGENT  = 32;
const CONTRACT_STATUS_SIGNED = '1';

// ---------------------------------------------------------------------------
// Mapping: prospects_rated.json rating key  → franchise Player field name(s).
// Mirrors scripts/3_extract_roster_ratings.js so the two stay in sync.
// When an array is given, the first existing field is used.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// NFL jersey number ranges by position. Each entry is one or more
// [low, high] inclusive ranges. Numbers are picked in the order listed.
// Reflects the post-2023 NFL rules (where most positions can wear 1–49).
// ---------------------------------------------------------------------------
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

// Madden TraitDevelopment enum strings (some franchise versions use bit values
// instead). We try the string form first; integer fallback handled at write
// time via getFieldByKey error catching.
const DEV_TRAIT_STRINGS = ['Normal', 'Star', 'Superstar', 'XFactor'];

// ---------------------------------------------------------------------------
// .env parsing
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

function resolveFranchisePath() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--franchise') return args[i + 1];
  }
  if (process.env.FRANCHISE_FILE) return process.env.FRANCHISE_FILE;
  const envVars = loadEnvFile(ENV_PATH);
  return envVars['FRANCHISE_FILE'] || null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert "6-2" height string → total inches (default 72 = 6'0"). */
function parseHeight(htStr) {
  if (!htStr) return 72;
  const parts = String(htStr).split('-');
  return parseInt(parts[0], 10) * 12 + parseInt(parts[1] || 0, 10);
}

/** Madden Weight is stored as (lbs - 160). Default 220 lb (= 60). */
function encodeWeight(lbs) {
  const w = Number(lbs);
  if (!Number.isFinite(w) || w <= 0) return 60;
  return Math.max(0, Math.min(255, Math.round(w - 160)));
}

/** Clamp a rating to [0, 99]. */
function safeRating(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(99, Math.round(n)));
}

/** Safe contract numbers — rookie scale by overall draft pick. Returns dollars. */
function rookieContract(overallPick, round) {
  // Approximate 2026 CBA rookie scale (signing bonus + 4-yr base totals).
  // We only need ballpark numbers; Madden treats these as cosmetic-ish.
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

/** Build a per-team jersey allocator that hands out unique numbers per team. */
function makeJerseyAllocator() {
  const usedByTeam = new Map(); // teamIndex → Set<number>
  return function pickJersey(teamIndex, position) {
    if (!usedByTeam.has(teamIndex)) usedByTeam.set(teamIndex, new Set());
    const used   = usedByTeam.get(teamIndex);
    const ranges = POSITION_JERSEY_RANGES[position] || [[1, 99]];
    for (const [lo, hi] of ranges) {
      for (let n = lo; n <= hi; n++) {
        if (!used.has(n)) {
          used.add(n);
          return n;
        }
      }
    }
    // All position-appropriate numbers exhausted on this team — fall back to
    // any unused number 1–99.
    for (let n = 1; n <= 99; n++) {
      if (!used.has(n)) {
        used.add(n);
        return n;
      }
    }
    return 0;
  };
}

/**
 * Set a field on a record, swallowing "field doesn't exist" errors so the
 * script tolerates schema variants between Madden 26 patches/builds.
 */
function trySet(record, fieldName, value) {
  try {
    const f = record.getFieldByKey(fieldName);
    if (f === undefined || f === null) return false;
    f.value = value;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Set the dev-trait field. Some franchise builds use a string enum
 * ('Normal' / 'Star' / 'Superstar' / 'XFactor'); others use a bit value.
 * Try string first, then numeric, then give up silently.
 */
function setDevTrait(record, devInt) {
  const idx = Math.max(0, Math.min(3, Number(devInt) || 0));
  const fieldNames = ['TraitDevelopment', 'DevTrait', 'DevelopmentTrait'];
  for (const name of fieldNames) {
    try {
      const f = record.getFieldByKey(name);
      if (!f) continue;
      try { f.value = DEV_TRAIT_STRINGS[idx]; return; } catch (_) {}
      try { f.value = idx; return; } catch (_) {}
    } catch (_) { /* try next */ }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(60));
  console.log('Script 9c — Inject 2026 Rookies into Franchise');
  console.log('='.repeat(60));

  // ── Resolve franchise path ────────────────────────────────────────────────
  const franchisePath = resolveFranchisePath();
  if (!franchisePath) {
    console.error('\n✗ No franchise file specified.');
    console.error('  Set FRANCHISE_FILE in .env or pass --franchise /path/to/file');
    process.exit(1);
  }
  if (!fs.existsSync(franchisePath)) {
    console.error(`\n✗ Franchise file not found: ${franchisePath}`);
    process.exit(1);
  }
  console.log(`\n  Franchise file : ${franchisePath}`);

  // ── Load prospects ────────────────────────────────────────────────────────
  if (!fs.existsSync(PROSPECTS_FILE)) {
    console.error(`\n✗ Prospects file not found: ${PROSPECTS_FILE}`);
    console.error('  Run the draft-class pipeline first: python3 run.py');
    process.exit(1);
  }
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_FILE, 'utf8'));
  console.log(`  Prospects      : ${prospects.length} loaded`);

  // ── Load team UUID → abbreviation map ─────────────────────────────────────
  if (!fs.existsSync(TEAM_MAP_FILE)) {
    console.error(`\n✗ Team map not found: ${TEAM_MAP_FILE}`);
    process.exit(1);
  }
  const uuidToAbbr = JSON.parse(fs.readFileSync(TEAM_MAP_FILE, 'utf8'));

  // ── Open franchise file ───────────────────────────────────────────────────
  await new Promise((resolve, reject) => {
    const franchise = new Franchise(franchisePath, { gameYearOverride: 26 });
    franchise.on('error', (err) => reject(new Error(`Franchise error: ${err?.message || err}`)));

    franchise.on('ready', async () => {
      try {
        const playerTable = franchise.getTableByName('Player');
        if (!playerTable) throw new Error('Player table not found in franchise file.');
        await playerTable.readRecords();
        console.log(`  Player records : ${playerTable.records.length} (${playerTable.header.recordCapacity} capacity)\n`);

        // ── Pass 1: empty existing 2026 rookies (YearDrafted == 0) ──────────
        let cleared = 0;
        for (const record of playerTable.records) {
          if (record.isEmpty) continue;
          let yd;
          try { yd = record.getFieldByKey('YearDrafted')?.value; } catch (_) { continue; }
          if (yd === 0 || yd === '0') {
            try {
              record.empty();
              cleared++;
            } catch (err) {
              // Some records can't be emptied (e.g. linked to other tables).
              // Skip and continue.
            }
          }
        }
        console.log(`  Cleared rookies: ${cleared} existing 2026 rookies removed`);

        // ── Pass 2: write each prospect into an empty slot ──────────────────
        const pickJersey = makeJerseyAllocator();
        let written = 0;
        let toFA    = 0;
        let skipped = 0;

        for (const p of prospects) {
          // Resolve drafting team
          let teamIndex = TEAM_INDEX_FREE_AGENT;
          const uuid = p.draftTeamId;
          if (uuid && uuidToAbbr[uuid]) {
            const abbr = uuidToAbbr[uuid];
            if (abbr in NFLVERSE_TO_TEAM_INDEX) {
              teamIndex = NFLVERSE_TO_TEAM_INDEX[abbr];
            }
          }
          if (teamIndex === TEAM_INDEX_FREE_AGENT) toFA++;

          // Find next empty slot
          const idx = playerTable.header.nextRecordToUse;
          if (idx >= playerTable.header.recordCapacity) {
            skipped++;
            continue; // Player table is full — nothing we can do
          }
          const record = playerTable.records[idx];

          // ── Identity ─────────────────────────────────────────────────────
          trySet(record, 'FirstName', String(p.firstName || '').slice(0, 11));
          trySet(record, 'LastName',  String(p.lastName  || '').slice(0, 14));
          trySet(record, 'Position',  String(p.pos || 'WR'));
          trySet(record, 'Age', 22);

          // ── Physicals ────────────────────────────────────────────────────
          trySet(record, 'Height', parseHeight(p.ht));
          trySet(record, 'Weight', encodeWeight(p.wt));

          // ── Roster status ────────────────────────────────────────────────
          trySet(record, 'TeamIndex',      teamIndex);
          trySet(record, 'ContractStatus', CONTRACT_STATUS_SIGNED);
          trySet(record, 'YearDrafted',    0);
          trySet(record, 'YearsPro',       0);
          trySet(record, 'PLYR_DRAFTROUND', Math.max(0, Math.min(7,  Number(p.actual_draft_round || p.draftRound || 7))));
          trySet(record, 'PLYR_DRAFTPICK',  Math.max(0, Math.min(99, Number(p.actual_draft_pick  || p.draftPick  || 99))));

          // ── Jersey number ────────────────────────────────────────────────
          trySet(record, 'JerseyNum', pickJersey(teamIndex, p.pos));

          // ── Rookie contract ──────────────────────────────────────────────
          const c = rookieContract(Number(p.actual_draft_pick || p.draftPick || 0),
                                   Number(p.actual_draft_round || p.draftRound || 7));
          const aav        = Math.round(c.totalValue / c.years);
          const baseSalary = Math.max(895, Math.round((aav - c.signingBonus / c.years) / 1000));
          const bonusK     = Math.round(c.signingBonus / c.years / 1000);
          trySet(record, 'ContractLength',  c.years);
          trySet(record, 'ContractYear',    0);
          trySet(record, 'ContractSalary0', baseSalary);
          trySet(record, 'ContractBonus0',  bonusK);
          trySet(record, 'PLYR_CAPSALARY',  baseSalary + bonusK);

          // ── Ratings ──────────────────────────────────────────────────────
          const ratings = p.ratings || {};
          for (const [key, value] of Object.entries(ratings)) {
            const fieldNames = FIELD_MAP[key];
            if (!fieldNames) continue;
            const candidates = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
            for (const name of candidates) {
              if (trySet(record, name, safeRating(value))) break;
            }
          }

          // ── Dev trait ────────────────────────────────────────────────────
          setDevTrait(record, ratings.devTrait || 0);

          written++;
        }

        // ── Summary ─────────────────────────────────────────────────────────
        console.log(`  Rookies written: ${written}`);
        console.log(`    on real team : ${written - toFA}`);
        console.log(`    in FA pool   : ${toFA} (no draftTeamId in prospect data)`);
        if (skipped > 0) {
          console.log(`  WARNING: ${skipped} prospects skipped — Player table is at capacity`);
        }

        if (written === 0) {
          console.log('\n  No changes to save — franchise file unchanged.');
          resolve();
          return;
        }

        // ── Save franchise file ─────────────────────────────────────────────
        console.log(`\nSaving franchise file…`);
        await franchise.save(franchisePath);
        console.log('✓ Saved.');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

main().catch((err) => {
  console.error('\n✗ Fatal error:', err.message || err);
  process.exit(1);
});
