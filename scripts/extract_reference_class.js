'use strict';

/**
 * Script: Extract Reference Draft Class
 *
 * Reads a community-created Madden 26 draft class file (CAREERDRAFT format)
 * via madden-draft-class-tools and saves a player-keyed lookup of all ratings
 * to data/reference_draft_class.json.
 *
 * This file is consumed by 5_generate_ratings.py to add community reference
 * ratings to the LLM prompt for any matched prospect.
 *
 * Run from project root:
 *   node scripts/extract_reference_class.js [--file path/to/CAREERDRAFT-FILE]
 */

const fs   = require('fs');
const path = require('path');

const MaddenDCTools = require('madden-draft-class-tools');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'raw', 'CAREERDRAFT-NFLDRAFT2026');
const OUTPUT_PATH  = path.join(__dirname, '..', 'data', 'reference_draft_class.json');

/** DraftPositionE enum → position string (same mapping as 2_extract_calibration.js) */
const ENUM_TO_POS = {
  0: 'QB',  1: 'HB',  2: 'FB',  3: 'WR',  4: 'TE',
  5: 'T',   6: 'G',   7: 'C',   8: 'G',   9: 'T',
  10: 'OLB', 11: 'DE', 12: 'DT', 13: 'ILB', 14: 'ILB',
  15: 'OLB', 16: 'CB', 17: 'FS', 18: 'SS',
  19: 'K',  20: 'P',  21: 'LS',
};

/** Rating fields to capture (excludes cosmetic/non-rating fields) */
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
  'injury', 'morale', 'devTrait',
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseFileArg() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--file') return args[i + 1];
  }
  return null;
}

function normalizeName(firstName, lastName) {
  return `${firstName} ${lastName}`.toLowerCase().replace(/[^a-z ]/g, '');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const filePath = parseFileArg() || DEFAULT_FILE;

  if (!fs.existsSync(filePath)) {
    console.error(`Error: Reference draft class file not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`[ref] Reading reference draft class: ${filePath}`);

  const buf = fs.readFileSync(filePath);
  const dc  = MaddenDCTools.readDraftClass(buf);

  console.log(`[ref] Parsed ${dc.prospects.length} prospects`);

  const output = {};

  for (const p of dc.prospects) {
    const key = normalizeName(p.firstName, p.lastName);
    const pos = ENUM_TO_POS[p.position] ?? String(p.position);

    const entry = { pos, name: `${p.firstName} ${p.lastName}` };
    for (const field of RATING_FIELDS) {
      if (p[field] !== undefined && p[field] !== null) {
        entry[field] = p[field];
      }
    }

    output[key] = entry;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`[ref] Saved ${Object.keys(output).length} entries → ${OUTPUT_PATH}`);
}

main();
