'use strict';

/**
 * Script 2 – Extract Calibration Set
 *
 * Downloads the real Madden 26 launch draft class (CAREERDRAFT-2025_M26),
 * reads every prospect's Madden ratings via madden-draft-class-tools, joins
 * each prospect to their real 2025 NFL combine measurables from nflverse,
 * and outputs data/calibration_set.json grouped by position.
 *
 * Run from project root:  node scripts/2_extract_calibration.js
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const MaddenDCTools = require('madden-draft-class-tools');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DRAFT_CLASS_URL =
  'https://raw.githubusercontent.com/WiiExpertise/madden-draft-class-tools/main/tests/data/CAREERDRAFT-2025_M26';

const COMBINE_CSV_URL =
  'https://github.com/nflverse/nflverse-data/releases/download/combine/combine.csv';

const DRAFT_CLASS_PATH   = path.join(__dirname, '..', 'data', 'raw', 'CAREERDRAFT-2025_M26');
const DEFAULT_VISUALS_PATH = path.join(__dirname, '..', 'data', 'raw', 'default_visuals.json');
const COMBINE_CSV_PATH   = path.join(__dirname, '..', 'data', 'raw', 'combine_2025.csv');
const OUTPUT_PATH        = path.join(__dirname, '..', 'data', 'calibration_set.json');

/** M26 DraftPositionE enum → position string
 *
 *  NOTE: The M26 binary enum values differ from the logical order.
 *  Verified by cross-referencing the 2025 draft class binary against
 *  known player identities (Mason Graham=DT, Travis Hunter=CB, etc.).
 *
 *  Enums 8 and 9 are additional interior OL types (extra G / extra T);
 *  they are merged into G and T respectively for calibration purposes.
 *  Enums 13 and 14 are both ILB types; merged into ILB.
 *  Enum 15 is a coverage-OLB type; merged into OLB.
 */
const ENUM_TO_POS = {
  0: 'QB',  1: 'HB',  2: 'FB',  3: 'WR',  4: 'TE',
  5: 'T',   6: 'G',   7: 'C',   8: 'G',   9: 'T',
  10: 'OLB', 11: 'DE', 12: 'DT', 13: 'ILB', 14: 'ILB',
  15: 'OLB', 16: 'CB', 17: 'FS', 18: 'SS',
  19: 'K',  20: 'P',  21: 'LS',
};

/** All numeric rating fields to capture from each prospect */
const RATING_FIELDS = [
  'overall', 'speed', 'acceleration', 'agility', 'strength', 'awareness',
  'throwPower', 'throwAccuracy', 'throwAccuracyShort', 'throwAccuracyMid',
  'throwAccuracyDeep', 'throwOnTheRun', 'throwUnderPressure', 'playAction',
  'breakSack', 'tackle', 'hitPower', 'blockShedding', 'finesseMoves',
  'powerMoves', 'pursuit', 'zoneCoverage', 'manCoverage', 'pressCoverage',
  'playRecognition', 'jumping', 'catching', 'catchInTraffic', 'spectacularCatch',
  'shortRouteRunning', 'mediumRouteRunning', 'deepRouteRunning', 'release',
  'runBlock', 'passBlock', 'runBlockPower', 'runBlockFinesse', 'passBlockPower',
  'passBlockFinesse', 'impactBlocking', 'leadBlock', 'jukeMove', 'spinMove',
  'stiffArm', 'trucking', 'breakTackle', 'ballCarrierVision', 'changeOfDirection',
  'carrying', 'kickPower', 'kickAccuracy', 'kickReturn', 'stamina', 'toughness',
  'injury', 'morale', 'personality', 'devTrait', 'unkRating1',
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Download a URL to a local file, following redirects.
 * Collects binary chunks and writes them with Buffer.concat.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    function doGet(currentUrl) {
      https.get(currentUrl, (res) => {
        // Follow HTTP redirects (301, 302, 307, 308)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${currentUrl}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            fs.writeFileSync(destPath, Buffer.concat(chunks));
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      }).on('error', reject);
    }
    doGet(url);
  });
}

/**
 * Download a URL and return its text content (with redirect following).
 * @param {string} url
 * @returns {Promise<string>}
 */
function downloadText(url) {
  return new Promise((resolve, reject) => {
    function doGet(currentUrl) {
      https.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${currentUrl}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }).on('error', reject);
    }
    doGet(url);
  });
}

/**
 * Parse a CSV string into an array of objects.
 * Handles quoted fields with commas inside.
 * @param {string} csvText
 * @returns {Array<Object>}
 */
function parseCsv(csvText) {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length === 0) return [];

  const headers = splitCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = values[idx] !== undefined ? values[idx].trim() : '';
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Split a single CSV line respecting double-quoted fields.
 * @param {string} line
 * @returns {string[]}
 */
function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Convert height string "6-2" or "6'2\"" → "H-I" format,
 * or return raw string if already formatted.
 * nflverse stores height as total inches (e.g. "74"), convert to "6-2".
 * @param {string|number|null} rawHt
 * @returns {string}
 */
function formatHeight(rawHt) {
  if (rawHt === null || rawHt === undefined || rawHt === '') return null;
  const n = Number(rawHt);
  if (!isNaN(n) && n > 0) {
    const feet = Math.floor(n / 12);
    const inches = n % 12;
    return `${feet}-${inches}`;
  }
  return String(rawHt);
}

/**
 * Parse a float from a string, returning null if empty / NaN.
 * @param {string} val
 * @returns {number|null}
 */
function parseFloatOrNull(val) {
  if (val === null || val === undefined || String(val).trim() === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/**
 * Parse an int from a string, returning null if empty / NaN.
 * @param {string} val
 * @returns {number|null}
 */
function parseIntOrNull(val) {
  if (val === null || val === undefined || String(val).trim() === '') return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

/**
 * Normalize a player name for lookup: lowercase and trim.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return String(name).toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Ensure output directories exist
  fs.mkdirSync(path.join(__dirname, '..', 'data', 'raw'), { recursive: true });
  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });

  // ------------------------------------------------------------------
  // Step 1 – Download CAREERDRAFT-2025_M26 (binary)
  // ------------------------------------------------------------------
  if (fs.existsSync(DRAFT_CLASS_PATH)) {
    console.log(`[1] Draft class already downloaded: ${DRAFT_CLASS_PATH}`);
  } else {
    console.log(`[1] Downloading CAREERDRAFT-2025_M26 …`);
    await downloadFile(DRAFT_CLASS_URL, DRAFT_CLASS_PATH);
    console.log(`    Saved to ${DRAFT_CLASS_PATH}`);
  }

  // ------------------------------------------------------------------
  // Step 2 – Read draft class
  // ------------------------------------------------------------------
  console.log('[2] Reading draft class …');
  const dcBuffer = fs.readFileSync(DRAFT_CLASS_PATH);
  const draftClass = MaddenDCTools.readDraftClass(dcBuffer);
  console.log(`    Loaded ${draftClass.prospects.length} prospects (header says ${draftClass.header.numProspects})`);

  // ------------------------------------------------------------------
  // Step 3 – Save first prospect's visuals as default_visuals.json
  // ------------------------------------------------------------------
  if (draftClass.prospects.length > 0) {
    const defaultVisuals = draftClass.prospects[0].visuals;
    fs.writeFileSync(DEFAULT_VISUALS_PATH, JSON.stringify(defaultVisuals, null, 2));
    console.log(`[3] Saved default visuals template → ${DEFAULT_VISUALS_PATH}`);
  }

  // ------------------------------------------------------------------
  // Step 4 – Load or download combine_2025.csv
  // ------------------------------------------------------------------
  let combineRows = [];

  if (fs.existsSync(COMBINE_CSV_PATH)) {
    console.log(`[4] Loading existing combine data: ${COMBINE_CSV_PATH}`);
    const csvText = fs.readFileSync(COMBINE_CSV_PATH, 'utf8');
    combineRows = parseCsv(csvText);
  } else {
    console.log('[4] combine_2025.csv not found – downloading from nflverse …');
    try {
      const csvText = await downloadText(COMBINE_CSV_URL);
      // Filter to 2025 season only before saving
      const allRows = parseCsv(csvText);
      combineRows = allRows.filter((r) => {
        const yr = r['season'] || r['year'] || r['draft_year'] || '';
        return String(yr).trim() === '2025';
      });
      if (combineRows.length === 0) {
        // Fallback: maybe column is named differently; try keeping all and warn
        console.warn('    Warning: could not filter to 2025 season; keeping all rows');
        combineRows = allRows;
      }
      // Write the filtered subset as combine_2025.csv
      const header = Object.keys(combineRows[0] || {}).join(',');
      const dataLines = combineRows.map((r) => Object.values(r).map((v) =>
        v.includes(',') ? `"${v}"` : v
      ).join(','));
      fs.writeFileSync(COMBINE_CSV_PATH, [header, ...dataLines].join('\n'));
      console.log(`    Downloaded and saved ${combineRows.length} 2025 combine rows → ${COMBINE_CSV_PATH}`);
    } catch (err) {
      console.warn(`    Warning: Could not download combine data – ${err.message}`);
      console.warn('    Combine measurables will be null for all prospects.');
    }
  }

  // Build lookup map: normalized full name → combine row
  // nflverse combine columns include: player_name, pos, school, ht, wt, forty, bench,
  // vertical, broad_jump, cone, shuttle, draft_year, season, round, pick
  const combineMap = new Map();
  for (const row of combineRows) {
    // Column names vary slightly across nflverse releases; try common variants
    const nameKey =
      row['player_name'] || row['Player'] || row['name'] ||
      `${row['first_name'] || ''} ${row['last_name'] || ''}`.trim();
    if (nameKey) {
      combineMap.set(normalizeName(nameKey), row);
    }
  }
  console.log(`    Combine lookup map has ${combineMap.size} entries`);

  // ------------------------------------------------------------------
  // Step 5 – Build calibration entries
  // ------------------------------------------------------------------
  console.log('[5] Building calibration entries …');

  const calibration = {}; // { [posString]: [ { profile, ratings }, … ] }
  let totalProspects = 0;
  let totalMatched = 0;

  for (const prospect of draftClass.prospects) {
    totalProspects++;

    const posString = ENUM_TO_POS[prospect.position] || `UNK_${prospect.position}`;
    const fullName  = `${prospect.firstName} ${prospect.lastName}`;
    const lookupKey = normalizeName(fullName);

    // Try to find combine row
    const combineRow = combineMap.get(lookupKey) || null;
    if (combineRow) totalMatched++;

    // Height: prospect stores heightInches (total inches as integer)
    const htFormatted = formatHeight(prospect.heightInches);

    // Combine fields – column names tried in priority order
    const school = combineRow
      ? (combineRow['school'] || combineRow['college'] || combineRow['school_name'] || '')
      : '';

    const forty      = combineRow ? parseFloatOrNull(combineRow['forty']   || combineRow['forty_yd']    || combineRow['40yd']) : null;
    const bench      = combineRow ? parseIntOrNull  (combineRow['bench']   || combineRow['bench_press']) : null;
    const vertical   = combineRow ? parseFloatOrNull(combineRow['vertical'] || combineRow['vert'])       : null;
    const broad_jump = combineRow ? parseIntOrNull  (combineRow['broad_jump'] || combineRow['broad'])    : null;
    const cone       = combineRow ? parseFloatOrNull(combineRow['cone']    || combineRow['3cone'])       : null;
    const shuttle    = combineRow ? parseFloatOrNull(combineRow['shuttle'] || combineRow['shuttle_20yd']) : null;

    // Profile
    const profile = {
      name:        fullName,
      pos:         posString,
      school:      school,
      ht:          htFormatted,
      wt:          prospect.weight,
      forty,
      bench,
      vertical,
      broad_jump,
      cone,
      shuttle,
      draft_round: prospect.draftRound || null,
      draft_pick:  prospect.draftPick  || null,
    };

    // Ratings – collect all numeric rating fields present on the prospect
    const ratings = {};
    for (const field of RATING_FIELDS) {
      if (prospect[field] !== undefined) {
        ratings[field] = prospect[field];
      }
    }

    // Group by position
    if (!calibration[posString]) {
      calibration[posString] = [];
    }
    calibration[posString].push({ profile, ratings });
  }

  // ------------------------------------------------------------------
  // Step 6 – Write data/calibration_set.json
  // ------------------------------------------------------------------
  console.log('[6] Writing calibration_set.json …');
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(calibration, null, 2));
  console.log(`    Saved → ${OUTPUT_PATH}`);

  // ------------------------------------------------------------------
  // Step 7 – Print summary
  // ------------------------------------------------------------------
  console.log('\n========== Summary ==========');
  console.log(`Total prospects processed : ${totalProspects}`);
  console.log(`Matched to combine data   : ${totalMatched}`);
  console.log(`Not matched               : ${totalProspects - totalMatched}`);
  console.log('\nBreakdown by position:');

  const positions = Object.keys(calibration).sort();
  for (const pos of positions) {
    const entries  = calibration[pos];
    const matched  = entries.filter((e) => e.profile.forty !== null || e.profile.bench !== null).length;
    console.log(`  ${pos.padEnd(4)} : ${String(entries.length).padStart(3)} prospects  (${matched} with combine data)`);
  }
  console.log('=============================\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
