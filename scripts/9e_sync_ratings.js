'use strict';

/**
 * Script 9e — Sync Veteran Ratings from a Source Franchise
 *
 * Copies rating fields (and dev trait) from a source CAREER- franchise onto
 * matching records in the target franchise, identified by firstName+lastName+
 * position. Leaves identity, team, contract, and 2026-rookie records alone.
 *
 *   - Records in target with YearDrafted == 0 are skipped (preserves the
 *     2026 rookies injected by 9c).
 *   - Source records with YearDrafted == 0 are skipped too (a 2025 rookie
 *     in the source isn't a useful veteran rating reference).
 *
 * Run:
 *   node scripts/9e_sync_ratings.js --source /path/to/SOURCE-CAREER --franchise /path/to/TARGET-CAREER
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

const SCRIPT_DIR     = __dirname;
const PROJECT_ROOT   = path.join(SCRIPT_DIR, '..');
const ENV_PATH       = path.join(PROJECT_ROOT, '.env');
const PROSPECTS_FILE = path.join(PROJECT_ROOT, 'data', 'prospects_rated.json');

// Mirrors 9d's FIELD_MAP — every rating attribute Madden tracks per Player.
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

const RATING_FIELD_NAMES = (() => {
  const out = [];
  for (const v of Object.values(FIELD_MAP)) {
    if (Array.isArray(v)) out.push(...v);
    else                   out.push(v);
  }
  return out;
})();

const DEV_TRAIT_FIELDS  = ['TraitDevelopment', 'DevTrait', 'DevelopmentTrait'];
const DEV_TRAIT_STRINGS = ['Normal', 'Star', 'Superstar', 'XFactor'];

// ---------------------------------------------------------------------------
// .env / arg parsing
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
  } catch (_) { return false; }
}
function setDevTrait(record, devValue) {
  const idx = typeof devValue === 'number'
    ? Math.max(0, Math.min(3, devValue))
    : Math.max(0, DEV_TRAIT_STRINGS.indexOf(String(devValue)));
  for (const name of DEV_TRAIT_FIELDS) {
    try {
      const f = record.getFieldByKey(name);
      if (!f) continue;
      try { f.value = DEV_TRAIT_STRINGS[idx]; return; } catch (_) {}
      try { f.value = idx; return; } catch (_) {}
    } catch (_) { /* try next */ }
  }
}

// ---------------------------------------------------------------------------
// Name normalization for matching
// ---------------------------------------------------------------------------
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9]/g, '');
}
function makeKey(firstName, lastName, position) {
  return `${norm(firstName)}|${norm(lastName)}|${norm(position)}`;
}
function makeNameOnlyKey(firstName, lastName) {
  return `${norm(firstName)}|${norm(lastName)}`;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------
function snapshotRatings(record) {
  const data = {};
  for (const name of RATING_FIELD_NAMES) {
    const v = safeGet(record, name);
    if (v !== null && v !== undefined) data[name] = v;
  }
  for (const name of DEV_TRAIT_FIELDS) {
    const v = safeGet(record, name);
    if (v !== null && v !== undefined) { data._devTrait = v; break; }
  }
  return data;
}
function applyRatings(record, data) {
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
  console.log('Script 9e — Sync Veteran Ratings from Source Franchise');
  console.log('='.repeat(60));

  const env       = loadEnvFile(ENV_PATH);
  const sourceArg = findFlag('--source') || process.env.SOURCE_FILE || env.SOURCE_FILE;
  const targetArg = findFlag('--franchise') || process.env.FRANCHISE_FILE || env.FRANCHISE_FILE;

  if (!sourceArg)  { console.error('\n✗ No source file. Pass --source /path/to/SOURCE-CAREER'); process.exit(1); }
  if (!targetArg)  { console.error('\n✗ No franchise file. Pass --franchise /path/to/TARGET-CAREER'); process.exit(1); }
  if (!fs.existsSync(sourceArg)) { console.error(`\n✗ Source not found: ${sourceArg}`); process.exit(1); }
  if (!fs.existsSync(targetArg)) { console.error(`\n✗ Target not found: ${targetArg}`); process.exit(1); }

  console.log(`\n  Source     : ${sourceArg}`);
  console.log(`  Target     : ${targetArg}`);

  // --- 2026 rookie name set (don't overwrite their ratings) ---------------
  const rookieNames = new Set();
  if (fs.existsSync(PROSPECTS_FILE)) {
    const prospects = JSON.parse(fs.readFileSync(PROSPECTS_FILE, 'utf8'));
    for (const p of prospects) {
      if (p?.firstName && p?.lastName) {
        rookieNames.add(makeNameOnlyKey(p.firstName, p.lastName));
      }
    }
    console.log(`  2026 rookies to protect : ${rookieNames.size} names from prospects_rated.json`);
  } else {
    console.log('  ⚠  data/prospects_rated.json not found — rookie protection disabled');
  }

  // --- Source: build name map ----------------------------------------------
  console.log('\n  Reading source franchise …');
  const srcFra   = await openFranchise(sourceArg);
  const srcTable = srcFra.getTableByName('Player');
  if (!srcTable) throw new Error('Source: Player table not found.');
  await srcTable.readRecords();

  const byKey         = new Map();   // first|last|position → snapshot
  const byNameOnly    = new Map();   // first|last          → array of { position, snapshot }
  let srcConsidered   = 0;
  let srcSkippedEmpty = 0;
  let srcSkippedRookie= 0;

  for (const rec of srcTable.records) {
    if (rec.isEmpty) { srcSkippedEmpty++; continue; }
    const yd = safeGet(rec, 'YearDrafted');
    if (yd === 0 || yd === '0') { srcSkippedRookie++; continue; }   // 2025 rookie — not a veteran reference
    const fn = safeGet(rec, 'FirstName');
    const ln = safeGet(rec, 'LastName');
    const ps = safeGet(rec, 'Position');
    if (!fn || !ln) continue;
    const snap = snapshotRatings(rec);
    const k    = makeKey(fn, ln, ps);
    const k2   = makeNameOnlyKey(fn, ln);
    byKey.set(k, snap);
    if (!byNameOnly.has(k2)) byNameOnly.set(k2, []);
    byNameOnly.get(k2).push({ position: ps, snapshot: snap });
    srcConsidered++;
  }
  console.log(`  Source players  : ${srcConsidered} active veterans  (skipped: ${srcSkippedRookie} rookies, ${srcSkippedEmpty} empty)`);

  // --- Target: walk veterans, apply ratings -------------------------------
  console.log('\n  Opening target franchise …');
  const tgtFra   = await openFranchise(targetArg);
  const tgtTable = tgtFra.getTableByName('Player');
  if (!tgtTable) throw new Error('Target: Player table not found.');
  await tgtTable.readRecords();

  let updated         = 0;
  let updatedNameOnly = 0;
  let skippedRookie   = 0;
  let skippedEmpty    = 0;
  let skippedNoName   = 0;
  let missing         = 0;
  const missingList   = [];

  for (const rec of tgtTable.records) {
    if (rec.isEmpty) { skippedEmpty++; continue; }
    const fn = safeGet(rec, 'FirstName');
    const ln = safeGet(rec, 'LastName');
    const ps = safeGet(rec, 'Position');
    const yd = safeGet(rec, 'YearDrafted');
    const yp = safeGet(rec, 'YearsPro');
    if (!fn || !ln) { skippedNoName++; continue; }
    // Skip rookie-like records: drafted-this-year or pre-draft rookies still showing yp=0.
    if (yd === 0 || yd === '0' || ((yd === 1 || yd === '1') && (yp === 0 || yp === '0'))) {
      skippedRookie++; continue;
    }
    if (rookieNames.has(makeNameOnlyKey(fn, ln))) { skippedRookie++; continue; }   // belt + suspenders
    const k = makeKey(fn, ln, ps);
    const snap = byKey.get(k);
    if (snap) {
      applyRatings(rec, snap);
      updated++;
      continue;
    }
    // Position changed between source and target? Try name-only match if unique.
    const candidates = byNameOnly.get(makeNameOnlyKey(fn, ln));
    if (candidates && candidates.length === 1) {
      applyRatings(rec, candidates[0].snapshot);
      updatedNameOnly++;
      continue;
    }
    missing++;
    if (missingList.length < 30) missingList.push(`${fn} ${ln} (${ps})`);
  }

  // --- Summary -------------------------------------------------------------
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`  Veterans updated         : ${updated}`);
  console.log(`  Updated by name-only     : ${updatedNameOnly}  (position differed)`);
  console.log(`  Skipped (2026 rookies)   : ${skippedRookie}`);
  console.log(`  Skipped (empty record)   : ${skippedEmpty}`);
  console.log(`  Skipped (no name)        : ${skippedNoName}`);
  console.log(`  Not found in source      : ${missing}`);

  if (missingList.length) {
    console.log('\n  Sample of unmatched veterans:');
    for (const n of missingList) console.log(`    ${n}`);
    if (missing > missingList.length) console.log(`    … and ${missing - missingList.length} more`);
  }

  if (updated === 0 && updatedNameOnly === 0) {
    console.log('\n  No changes — nothing to save.');
    return;
  }

  console.log('\n  Saving target franchise …');
  await tgtFra.save(targetArg);
  console.log('✓ Saved.');
}

main().catch((err) => {
  console.error('\n✗ Fatal error:', err.message || err);
  process.exit(1);
});
