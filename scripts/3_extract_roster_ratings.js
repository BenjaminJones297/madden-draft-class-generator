'use strict';

/**
 * Script 3 – Extract Current Roster Ratings
 *
 * Reads a user-provided Madden 26 .ros roster file via the madden-franchise
 * library, extracts current NFL player ratings from the Player table, groups
 * them by position, and saves the top-10 per position (sorted by overall desc)
 * to data/current_player_ratings.json.
 *
 * This step is OPTIONAL. If no roster file is provided via --ros or the
 * ROSTER_FILE environment variable, the script exits with code 0 and prints
 * a friendly message. Script 5 will then rely on calibration data only.
 *
 * Run from project root:
 *   node scripts/3_extract_roster_ratings.js --ros /path/to/file.ros
 *   ROSTER_FILE=/path/to/file.ros node scripts/3_extract_roster_ratings.js
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'current_player_ratings.json');
const ENV_PATH    = path.join(__dirname, '..', '.env');

/** Max players kept per position (top N by overall). */
const TOP_N = 10;

/**
 * Mapping from our output key names to the franchise file field name(s).
 * When an array is provided, the first field that exists on the record is used.
 */
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
  impactBlock:          'ImpactBlockRating',
  leadBlock:            'LeadBlockRating',
  jukeMove:             'JukeMoveRating',
  spinMove:             'SpinMoveRating',
  stiffArm:             'StiffArmRating',
  trucking:             'TruckingRating',
  breakTackle:          'BreakTackleRating',
  ballCarrierVision:    'BallCarrierVisionRating',
  changeOfDirection:    'ChangeOfDirectionRating',
  carrying:             'CarryingRating',
  kickPower:            'KickPowerRating',
  kickAccuracy:         'KickAccuracyRating',
  kickReturn:           'KickReturnRating',
  stamina:              'StaminaRating',
  toughness:            'ToughnessRating',
  injury:               'InjuryRating',
  morale:               'MoraleRating',
  // dev trait is a special case (enum string → number), handled separately
};

/**
 * The subset of rating fields to include in the output per position group.
 * Always includes "name", "overall", and "devTrait" automatically.
 * Only fields relevant to the position are written so the LLM context is tight.
 */
const POSITION_FIELDS = {
  QB: [
    'speed', 'acceleration', 'agility', 'strength', 'awareness',
    'throwPower', 'throwAccuracy', 'throwAccuracyShort', 'throwAccuracyMid',
    'throwAccuracyDeep', 'throwOnTheRun', 'throwUnderPressure', 'playAction',
  ],
  HB: [
    'speed', 'acceleration', 'agility', 'strength', 'awareness',
    'carrying', 'jukeMove', 'spinMove', 'stiffArm', 'trucking',
    'breakTackle', 'ballCarrierVision', 'changeOfDirection', 'catching',
  ],
  FB: [
    'speed', 'acceleration', 'strength', 'awareness',
    'carrying', 'trucking', 'breakTackle', 'impactBlock', 'leadBlock', 'catching',
  ],
  WR: [
    'speed', 'acceleration', 'agility', 'strength', 'awareness',
    'catching', 'catchInTraffic', 'spectacularCatch',
    'shortRouteRunning', 'mediumRouteRunning', 'deepRouteRunning', 'release',
  ],
  TE: [
    'speed', 'acceleration', 'agility', 'strength', 'awareness',
    'catching', 'catchInTraffic', 'spectacularCatch',
    'shortRouteRunning', 'mediumRouteRunning', 'deepRouteRunning', 'release',
    'runBlock', 'passBlock',
  ],
  T: [
    'speed', 'strength', 'agility', 'awareness',
    'runBlock', 'passBlock', 'runBlockPower', 'runBlockFinesse',
    'passBlockPower', 'passBlockFinesse',
  ],
  G: [
    'speed', 'strength', 'agility', 'awareness',
    'runBlock', 'passBlock', 'runBlockPower', 'runBlockFinesse',
    'passBlockPower', 'passBlockFinesse', 'impactBlock',
  ],
  C: [
    'speed', 'strength', 'agility', 'awareness',
    'runBlock', 'passBlock', 'runBlockPower', 'runBlockFinesse',
    'passBlockPower', 'passBlockFinesse', 'impactBlock',
  ],
  DE: [
    'speed', 'acceleration', 'agility', 'strength', 'awareness',
    'tackle', 'hitPower', 'blockShedding', 'finesseMoves', 'powerMoves', 'pursuit',
  ],
  DT: [
    'speed', 'acceleration', 'strength', 'awareness',
    'tackle', 'hitPower', 'blockShedding', 'finesseMoves', 'powerMoves',
  ],
  OLB: [
    'speed', 'acceleration', 'agility', 'strength', 'awareness',
    'tackle', 'hitPower', 'blockShedding', 'finesseMoves', 'powerMoves',
    'pursuit', 'zoneCoverage', 'manCoverage', 'playRecognition',
  ],
  MLB: [
    'speed', 'acceleration', 'agility', 'strength', 'awareness',
    'tackle', 'hitPower', 'pursuit', 'zoneCoverage', 'manCoverage', 'playRecognition',
  ],
  CB: [
    'speed', 'acceleration', 'agility', 'strength', 'awareness',
    'tackle', 'hitPower', 'zoneCoverage', 'manCoverage', 'pressCoverage',
    'playRecognition', 'jumping',
  ],
  FS: [
    'speed', 'acceleration', 'agility', 'strength', 'awareness',
    'tackle', 'hitPower', 'zoneCoverage', 'manCoverage', 'pressCoverage', 'playRecognition',
  ],
  SS: [
    'speed', 'acceleration', 'agility', 'strength', 'awareness',
    'tackle', 'hitPower', 'zoneCoverage', 'manCoverage', 'pressCoverage', 'playRecognition',
  ],
  K:  ['kickPower', 'kickAccuracy', 'awareness'],
  P:  ['kickPower', 'kickAccuracy', 'awareness'],
  LS: ['strength', 'awareness'],
};

/** Dev trait enum string → integer used in prospects_rated.json */
const DEV_TRAIT_MAP = {
  Normal:   0,
  Impact:   1,
  Star:     2,
  XFactor:  3,
  'X-Factor': 3,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Minimal .env parser — reads KEY=VALUE lines, ignores comments and blanks.
 * Returns a plain object. Does NOT mutate process.env.
 * @param {string} envPath  Absolute path to the .env file.
 * @returns {Record<string, string>}
 */
function loadEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) return result;

  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let val    = line.slice(eqIdx + 1).trim();

    // Strip optional surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val;
  }
  return result;
}

/**
 * Parse the --ros /path/to/file.ros flag from process.argv.
 * @returns {string|null}
 */
function parseRosArg() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--ros') return args[i + 1];
  }
  return null;
}

/**
 * Safely read a field value from a franchise record.
 * Tries each candidate field name in order and returns the first one found.
 * Returns null if none of the candidate fields exist on this record.
 * @param {import('madden-franchise/FranchiseFileRecord')} record
 * @param {string|string[]} fieldNames  Single name or array of alternatives.
 * @returns {*}
 */
function safeGet(record, fieldNames) {
  const names = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
  for (const name of names) {
    try {
      const field = record.getFieldByKey(name);
      if (field !== undefined && field !== null) {
        return field.value;
      }
    } catch (_) {
      // field does not exist on this record — try next
    }
  }
  return null;
}

/**
 * Convert a dev trait string value to its integer representation.
 * Returns null if the value is unrecognized.
 * @param {*} raw
 * @returns {number|null}
 */
function parseDevTrait(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;
  const mapped = DEV_TRAIT_MAP[String(raw).trim()];
  return mapped !== undefined ? mapped : null;
}

/**
 * Build a player object from a franchise record for a given set of output keys.
 * Silently skips any field that doesn't exist on the record.
 * @param {string} name               Full player name.
 * @param {number} overall            Overall rating.
 * @param {string[]} positionKeys     List of extra field keys to include.
 * @param {import('madden-franchise/FranchiseFileRecord')} record
 * @returns {Object}
 */
function buildPlayerObject(name, overall, positionKeys, record) {
  const obj = { name, overall };

  for (const key of positionKeys) {
    const franchiseFieldNames = FIELD_MAP[key];
    if (!franchiseFieldNames) continue;

    const raw = safeGet(record, franchiseFieldNames);
    if (raw !== null && raw !== undefined) {
      const num = Number(raw);
      if (!isNaN(num)) obj[key] = num;
    }
  }

  // devTrait is always appended last
  const rawDevTrait = safeGet(record, ['TraitDevelopment', 'DevTrait', 'DevelopmentTrait']);
  const devTrait    = parseDevTrait(rawDevTrait);
  if (devTrait !== null) obj.devTrait = devTrait;

  return obj;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // -----------------------------------------------------------------------
  // 1. Resolve roster file path: --ros arg → ROSTER_FILE env → .env file
  // -----------------------------------------------------------------------
  let rosPath = parseRosArg();

  if (!rosPath) {
    // Try process.env first (already set in shell), then .env file
    rosPath = process.env.ROSTER_FILE || null;
  }

  if (!rosPath) {
    const envVars = loadEnvFile(ENV_PATH);
    rosPath = envVars['ROSTER_FILE'] || null;
  }

  if (!rosPath) {
    console.log('No roster file provided. Skipping.');
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // 2. Validate the file exists
  // -----------------------------------------------------------------------
  if (!fs.existsSync(rosPath)) {
    console.error(`Error: Roster file not found: ${rosPath}`);
    process.exit(1);
  }

  console.log(`[3] Reading roster file: ${rosPath}`);

  // -----------------------------------------------------------------------
  // 3. Open franchise file and read Player table
  // -----------------------------------------------------------------------
  const playersByPosition = await new Promise((resolve, reject) => {
    let franchise;

    try {
      franchise = new Franchise(rosPath);
    } catch (err) {
      reject(new Error(`Failed to open roster file: ${err.message}`));
      return;
    }

    franchise.on('ready', async (file) => {
      try {
        const table = file.getTableByName('Player');

        if (!table) {
          throw new Error('Player table not found in roster file.');
        }

        console.log('    Player table found — reading records …');
        await table.readRecords();

        const records = table.records;
        console.log(`    Total records in Player table: ${records.length}`);

        // ----------------------------------------------------------------
        // 4. Process each record
        // ----------------------------------------------------------------
        const grouped = {}; // { [posString]: playerObject[] }
        let active    = 0;
        let skipped   = 0;

        for (const record of records) {
          // Skip empty / placeholder rows
          if (record.isEmpty) {
            skipped++;
            continue;
          }

          // Read overall — try both common field names
          const overallRaw = safeGet(record, ['OverallRating', 'PlayerBestOvr']);
          const overall    = overallRaw !== null ? Number(overallRaw) : 0;

          // Skip records with 0 or invalid overall (placeholder/deleted players)
          if (!overall || overall <= 0) {
            skipped++;
            continue;
          }

          // Read position
          const posRaw = safeGet(record, ['Position', 'Pos']);
          if (!posRaw) {
            skipped++;
            continue;
          }
          const position = String(posRaw).trim();

          // Read name
          const firstName = safeGet(record, ['FirstName']) || '';
          const lastName  = safeGet(record, ['LastName'])  || '';
          const name      = `${firstName} ${lastName}`.trim();
          if (!name) {
            skipped++;
            continue;
          }

          // Determine which fields to include for this position
          const positionKeys = POSITION_FIELDS[position];
          if (!positionKeys) {
            // Unrecognized position (e.g. 'NA') — store with base fields only
            const obj = buildPlayerObject(name, overall, [], record);
            if (!grouped[position]) grouped[position] = [];
            grouped[position].push(obj);
            active++;
            continue;
          }

          const obj = buildPlayerObject(name, overall, positionKeys, record);
          if (!grouped[position]) grouped[position] = [];
          grouped[position].push(obj);
          active++;
        }

        console.log(`    Active players extracted : ${active}`);
        console.log(`    Skipped records          : ${skipped}`);

        // ----------------------------------------------------------------
        // 5. Sort each position by overall desc, keep top N
        // ----------------------------------------------------------------
        for (const pos of Object.keys(grouped)) {
          grouped[pos].sort((a, b) => b.overall - a.overall);
          grouped[pos] = grouped[pos].slice(0, TOP_N);
        }

        resolve(grouped);
      } catch (err) {
        reject(err);
      }
    });

    franchise.on('error', (err) => {
      reject(new Error(`Franchise file error: ${err ? err.message || err : 'unknown error'}`));
    });
  });

  // -----------------------------------------------------------------------
  // 6. Write output
  // -----------------------------------------------------------------------
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(playersByPosition, null, 2));
  console.log(`\n    Saved → ${OUTPUT_PATH}`);

  // -----------------------------------------------------------------------
  // 7. Print summary
  // -----------------------------------------------------------------------
  console.log('\n========== Summary ==========');
  const positions = Object.keys(playersByPosition).sort();
  for (const pos of positions) {
    const players  = playersByPosition[pos];
    const topOvr   = players[0] ? players[0].overall : 0;
    const topName  = players[0] ? players[0].name    : '';
    console.log(
      `  ${pos.padEnd(4)}: ${String(players.length).padStart(2)} players  ` +
      `(best: ${topName} OVR ${topOvr})`
    );
  }
  console.log('=============================\n');
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
