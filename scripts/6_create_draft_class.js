'use strict';

/**
 * Script 6: Create Madden 26 Draft Class Binary
 *
 * Reads data/prospects_rated.json, maps each prospect's ratings into the
 * draftclass binary format using the 2025 M26 draft class as a structural
 * template, and writes data/output/2026_draft_class.draftclass.
 *
 * Usage:
 *   node scripts/6_create_draft_class.js [--input <path>] [--out <path>]
 */

const fs   = require('fs');
const path = require('path');
const MaddenDCTools = require('madden-draft-class-tools');

const { POSITION_TO_ENUM, DEV_TRAIT, STATE_TO_ENUM, ALL_RATING_FIELDS } = require('../utils/enums.js');
const { DEFAULT_VISUALS } = require('../utils/visuals_template.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const ROOT         = path.resolve(__dirname, '..');
const INPUT_PATH   = path.resolve(ROOT, getArg('--input', 'data/prospects_rated.json'));
const OUTPUT_PATH  = path.resolve(ROOT, getArg('--out',   'data/output/2026_draft_class.draftclass'));
const TEMPLATE_PATH = path.resolve(ROOT, 'data/raw/CAREERDRAFT-2025_M26');
const VISUALS_PATH  = path.resolve(ROOT, 'data/raw/default_visuals.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert "6-2" height string → total inches (default 72 = 6'0") */
function parseHeight(htStr) {
  if (!htStr) return 72;
  const parts = String(htStr).split('-');
  return parseInt(parts[0], 10) * 12 + parseInt(parts[1] || 0, 10);
}

/**
 * Clamp a value to the uint8 range [0, 99] for ratings,
 * or [0, 255] for other uint8 fields, and coerce undefined → 0.
 */
function safeRating(val, max = 99) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

/** Build asset name from first + last name */
function buildAssetName(firstName, lastName) {
  return (firstName + lastName)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 41);
}

/** Safely truncate a string to maxLen, defaulting undefined → "" */
function safeStr(val, maxLen) {
  const s = val == null ? '' : String(val);
  return s.substring(0, maxLen);
}

// ---------------------------------------------------------------------------
// Load inputs
// ---------------------------------------------------------------------------

// 1. Prospects data
if (!fs.existsSync(INPUT_PATH)) {
  console.error(`ERROR: Input file not found: ${INPUT_PATH}`);
  console.error('Please run script 5 (rate_prospects) first to generate prospects_rated.json.');
  process.exit(1);
}
const prospectsRaw = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
console.log(`Loaded ${prospectsRaw.length} prospects from ${INPUT_PATH}`);

// 2. Template draft class (for header + per-position field defaults)
if (!fs.existsSync(TEMPLATE_PATH)) {
  console.error(`ERROR: Template file not found: ${TEMPLATE_PATH}`);
  console.error('Please run script 2 (extract_calibration) first.');
  process.exit(1);
}
const templateDC = MaddenDCTools.readDraftClass(fs.readFileSync(TEMPLATE_PATH));
console.log(`Loaded template draft class with ${templateDC.prospects.length} prospects.`);

// 3. Visuals
let defaultVisuals;
if (fs.existsSync(VISUALS_PATH)) {
  try {
    defaultVisuals = JSON.parse(fs.readFileSync(VISUALS_PATH, 'utf8'));
    console.log('Using real M26 visuals from data/raw/default_visuals.json');
  } catch (e) {
    console.warn('WARNING: Could not parse default_visuals.json, using fallback visuals.');
    defaultVisuals = DEFAULT_VISUALS;
  }
} else {
  console.log('default_visuals.json not found, using built-in DEFAULT_VISUALS fallback.');
  defaultVisuals = DEFAULT_VISUALS;
}

// ---------------------------------------------------------------------------
// Build templateByPosition map
// Fields to copy: runningStyle, bodyType, traitPredictability, unkByte2,
//                 unk3, unk4, unk5, unk6, visMoveType, unk8
// ---------------------------------------------------------------------------
const COPY_FIELDS = [
  'runningStyle', 'bodyType', 'traitPredictability', 'unkByte2',
  'unk3', 'unk4', 'unk5', 'unk6', 'visMoveType', 'unk8',
];

const templateByPosition = {};
for (const tp of templateDC.prospects) {
  const pos = tp.position;
  if (templateByPosition[pos] === undefined) {
    templateByPosition[pos] = tp;
  }
}
// Fallback: first prospect in template
const fallbackTemplate = templateDC.prospects[0];

// ---------------------------------------------------------------------------
// Build header
// ---------------------------------------------------------------------------
const header = Object.assign({}, templateDC.header);
header.numProspects = prospectsRaw.length;
// Update fileName: replace any year-like suffix to reflect 2026.
// The binary field has a fixed max width (~21 chars), so use a compact name.
if (header.fileName.includes('2025')) {
  header.fileName = header.fileName.replace(/2025/g, '2026');
} else {
  // Original template uses an internal build name; substitute a short 2026 identifier.
  header.fileName = 'Madden-26-DC-2026';
}

console.log(`Header fileName: ${header.fileName}`);

// ---------------------------------------------------------------------------
// Map each prospect → Madden prospect object
// ---------------------------------------------------------------------------

/** Fields that should never be undefined (uint8 sentinel defaults) */
const UINT8_DEFAULTS = {
  archetype: 0,
  jerseyNum: 0,
  draftable: 1,
  qbStyle:   0,
  qbStance:  0,
};

let draftPick  = 1;
let draftRound = 1;
const PICKS_PER_ROUND = 32; // approximate — just for sequential ordering

const builtProspects = [];
const skipped        = [];

for (let i = 0; i < prospectsRaw.length; i++) {
  const raw = prospectsRaw[i];

  try {
    // -- Position --
    const posKey    = String(raw.pos || raw.position || 'QB').toUpperCase().trim();
    const posEnum   = POSITION_TO_ENUM[posKey] !== undefined ? POSITION_TO_ENUM[posKey] : 0;

    // -- Template values for this position --
    const tmpl = templateByPosition[posEnum] !== undefined
      ? templateByPosition[posEnum]
      : fallbackTemplate;

    // -- Height / Weight --
    const heightInches = parseHeight(raw.ht || raw.height);
    // weight stored in file as actual lbs; writeDraftClass expects raw weight value
    // (the library handles weight-160 encoding internally OR stores actual — inspect template)
    // Template prospect[0]: weight=219 (Cam Ward, real weight ~220). Stored as actual lbs.
    const weightLbs = Number(raw.wt || raw.weight || 215);

    // -- Draft pick ordering --
    // Use raw.draftRound if available; otherwise assign sequentially
    const prospectRound = Number(raw.draftRound || draftRound) || 1;
    const prospectPick  = draftPick;
    draftPick++;
    if (draftPick > PICKS_PER_ROUND * draftRound) draftRound++;

    // -- Ratings source: prefer raw.ratings{} then fall back to top-level raw fields --
    const ratings = (raw.ratings && typeof raw.ratings === 'object') ? raw.ratings : raw;

    // -- Dev trait --
    let devTraitVal = 0;
    const devTraitRaw = ratings.devTrait !== undefined ? ratings.devTrait : raw.devTrait;
    if (devTraitRaw !== undefined) {
      if (typeof devTraitRaw === 'string') {
        devTraitVal = DEV_TRAIT[devTraitRaw] !== undefined ? DEV_TRAIT[devTraitRaw] : 0;
      } else {
        devTraitVal = safeRating(devTraitRaw, 3);
      }
    }

    // -- State --
    const stateKey  = String(raw.homeState || raw.state || '').toUpperCase().trim();
    const homeState = STATE_TO_ENUM[stateKey] !== undefined ? STATE_TO_ENUM[stateKey] : 0;

    // -- Rating helper: read from ratings{}, fall back to a sensible default --
    const r = (field, def = 50) => safeRating(ratings[field] !== undefined ? ratings[field] : def);

    // -- Build the prospect object --
    const prospect = {
      // --- Visuals ---
      visuals: defaultVisuals,

      // --- Identity ---
      firstName:  safeStr(raw.firstName || (raw.name || '').split(' ')[0] || 'Unknown', 17),
      lastName:   safeStr(raw.lastName  || (raw.name || '').split(' ').slice(1).join(' ') || 'Prospect', 21),
      homeState:  homeState,
      homeTown:   safeStr(raw.homeTown || raw.hometown || '', 27),
      college:    0,  // no college enum in M26
      birthDate:  1000,
      age:        safeRating(raw.age || 22, 255),

      // --- Physical ---
      heightInches: safeRating(heightInches, 255),
      weight:       Math.max(0, Math.round(weightLbs)),
      position:     posEnum,

      // --- Draft info ---
      archetype:  0,
      jerseyNum:  0,
      draftable:  1,
      draftPick:  prospectPick,
      draftRound: prospectRound,

      // ----------------------------------------------------------------
      // Ratings (uint8, 0-99)
      // ----------------------------------------------------------------
      overall:             r('overall',            70),
      acceleration:        r('acceleration',        70),
      agility:             r('agility',             70),
      awareness:           r('awareness',           50),
      ballCarrierVision:   r('ballCarrierVision',   50),
      blockShedding:       r('blockShedding',       50),
      breakSack:           r('breakSack',           50),
      breakTackle:         r('breakTackle',         50),
      carrying:            r('carrying',            50),
      catching:            r('catching',            50),
      catchInTraffic:      r('catchInTraffic',      50),
      changeOfDirection:   r('changeOfDirection',   70),
      finesseMoves:        r('finesseMoves',        50),
      hitPower:            r('hitPower',            50),
      impactBlocking:      r('impactBlocking',      50),
      injury:              r('injury',              80),
      jukeMove:            r('jukeMove',            50),
      jumping:             r('jumping',             70),
      kickAccuracy:        r('kickAccuracy',        50),
      kickPower:           r('kickPower',           50),
      kickReturn:          r('kickReturn',          50),
      leadBlock:           r('leadBlock',           50),
      unkRating1:          r('unkRating1',          50),
      manCoverage:         r('manCoverage',         50),
      passBlockFinesse:    r('passBlockFinesse',    50),
      passBlockPower:      r('passBlockPower',      50),
      passBlock:           r('passBlock',           50),
      personality:         r('personality',         80),
      playAction:          r('playAction',          50),
      playRecognition:     r('playRecognition',     50),
      powerMoves:          r('powerMoves',          50),
      pressCoverage:       r('pressCoverage',       50),
      pursuit:             r('pursuit',             50),
      release:             r('release',             50),
      shortRouteRunning:   r('shortRouteRunning',   50),
      mediumRouteRunning:  r('mediumRouteRunning',  50),
      deepRouteRunning:    r('deepRouteRunning',    50),
      runBlockFinesse:     r('runBlockFinesse',     50),
      runBlockPower:       r('runBlockPower',       50),
      runBlock:            r('runBlock',            50),
      runningStyle:        safeRating(tmpl.runningStyle, 255),
      spectacularCatch:    r('spectacularCatch',    50),
      speed:               r('speed',              70),
      spinMove:            r('spinMove',            50),
      stamina:             r('stamina',             80),
      stiffArm:            r('stiffArm',            50),
      strength:            r('strength',            50),
      tackle:              r('tackle',              50),
      throwAccuracyDeep:   r('throwAccuracyDeep',  50),
      throwAccuracyMid:    r('throwAccuracyMid',   50),
      throwAccuracy:       r('throwAccuracy',       50),
      throwAccuracyShort:  r('throwAccuracyShort', 50),
      throwOnTheRun:       r('throwOnTheRun',       50),
      throwPower:          r('throwPower',          50),
      throwUnderPressure:  r('throwUnderPressure', 50),
      toughness:           r('toughness',           80),
      trucking:            r('trucking',            50),
      zoneCoverage:        r('zoneCoverage',        50),

      // ----------------------------------------------------------------
      // Non-rating uint8 fields (M26 only)
      // ----------------------------------------------------------------
      morale:               r('morale',     80),
      devTrait:             devTraitVal,
      bodyType:             safeRating(tmpl.bodyType, 255),
      traitPredictability:  safeRating(tmpl.traitPredictability, 255),
      unkByte2:             safeRating(tmpl.unkByte2, 255),

      // ----------------------------------------------------------------
      // uint16 / special fields
      // ----------------------------------------------------------------
      handedness:   safeRating(raw.handedness !== undefined ? raw.handedness : 0, 255),
      portraitId:   0,

      // ----------------------------------------------------------------
      // uint8 unknowns — copy from position-matched template
      // ----------------------------------------------------------------
      qbStyle:      0,
      qbStance:     0,
      unk3:         safeRating(tmpl.unk3,  255),
      unk4:         safeRating(tmpl.unk4,  255),
      unk5:         safeRating(tmpl.unk5,  255),
      unk6:         safeRating(tmpl.unk6,  255),
      visMoveType:  safeRating(tmpl.visMoveType, 255),
      unk8:         safeRating(tmpl.unk8,  255),

      // uint16
      commentaryId: 0,

      // string
      assetName: buildAssetName(
        raw.firstName || (raw.name || '').split(' ')[0] || 'unknown',
        raw.lastName  || (raw.name || '').split(' ').slice(1).join(' ') || 'prospect'
      ),
    };

    builtProspects.push(prospect);

  } catch (err) {
    console.warn(`WARNING: Skipping prospect #${i + 1} (${raw.name || raw.firstName || 'unknown'}): ${err.message}`);
    skipped.push({ index: i, name: raw.name || raw.firstName || 'unknown', error: err.message });
  }
}

if (skipped.length > 0) {
  console.warn(`\nSkipped ${skipped.length} prospect(s) due to errors:`);
  skipped.forEach(s => console.warn(`  #${s.index + 1} ${s.name}: ${s.error}`));
}

if (builtProspects.length === 0) {
  console.error('ERROR: No prospects were successfully mapped. Aborting.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Update header prospect count
// ---------------------------------------------------------------------------
header.numProspects = builtProspects.length;

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------
console.log(`\nWriting ${builtProspects.length} prospects to ${OUTPUT_PATH} …`);

let outputBuffer;
try {
  outputBuffer = MaddenDCTools.writeDraftClass({ header, prospects: builtProspects });
} catch (err) {
  console.error(`ERROR: writeDraftClass failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}

if (!outputBuffer || outputBuffer.length === 0) {
  console.error('ERROR: writeDraftClass returned an empty buffer. Aborting.');
  process.exit(1);
}

// Ensure output directory exists
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, outputBuffer);

console.log(`\nOutput written: ${OUTPUT_PATH} (${outputBuffer.length.toLocaleString()} bytes)`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
// Invert POSITION_TO_ENUM: keep first-seen name per enum value
const ENUM_TO_POSITION = {};
for (const [name, val] of Object.entries(POSITION_TO_ENUM)) {
  if (ENUM_TO_POSITION[val] === undefined) ENUM_TO_POSITION[val] = name;
}

const byPosition = {};
for (const p of builtProspects) {
  const posName = ENUM_TO_POSITION[p.position] || `pos${p.position}`;
  byPosition[posName] = (byPosition[posName] || 0) + 1;
}

console.log(`\nTotal prospects written: ${builtProspects.length}`);
console.log('Breakdown by position:');
Object.entries(byPosition)
  .sort((a, b) => b[1] - a[1])
  .forEach(([pos, count]) => console.log(`  ${pos.padEnd(6)} ${count}`));

console.log('\n─────────────────────────────────────────────────────────────');
console.log('Import this file into Madden 26 Franchise mode via:');
console.log('  Main Hub → Choose Draft Class → Import Local File');
console.log('─────────────────────────────────────────────────────────────\n');
