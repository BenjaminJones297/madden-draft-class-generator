'use strict';

/**
 * Script 9g — Sync Rookie Ratings In-Place
 *
 * For each rookie record in the target franchise (YearDrafted == 0 AND
 * YearsPro == 0), find the matching prospect in data/prospects_rated.json by
 * firstName+lastName (case/accent-insensitive) and overwrite ONLY the rating
 * fields. Identity, position, team, contract, visuals, traits, and every
 * other field are left untouched.
 *
 * This is the safest possible write to the Player table — no record.empty(),
 * no auto-unempty, no cross-table references touched. Use it when the target
 * franchise already has the right roster and contracts (e.g. a "good"
 * CAREER-…-START file) and you only want to refresh the rookie ratings to
 * match prospects_rated.json.
 *
 * Run:
 *   node scripts/9g_sync_rookie_ratings.js --franchise /path/to/CAREER-FRANCHISE
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

const SCRIPT_DIR     = __dirname;
const PROJECT_ROOT   = path.join(SCRIPT_DIR, '..');
const ENV_PATH       = path.join(PROJECT_ROOT, '.env');
const PROSPECTS_FILE = path.join(PROJECT_ROOT, 'data', 'prospects_rated.json');

// Mirrors 9c/9e — every rating attribute Madden tracks per Player.
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
  finesseMoves:         ['FinesseMoveRating', 'FinesseMovesRating'],
  powerMoves:           ['PowerMovesRating', 'PowerMoveRating'],
  pursuit:              'PursuitRating',
  zoneCoverage:         'ZoneCoverageRating',
  manCoverage:          'ManCoverageRating',
  pressCoverage:        ['PressCoverageRating', 'PressRating'],
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

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
const nameKey = (fn, ln) => `${norm(fn)}|${norm(ln)}`;

function safeRating(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(99, Math.round(n)));
}

function trySet(record, fieldName, value) {
  try {
    const f = record.getFieldByKey(fieldName);
    if (!f) return false;
    f.value = value;
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Script 9g — Sync Rookie Ratings In-Place');
  console.log('='.repeat(60));

  const env = loadEnvFile(ENV_PATH);
  const target = findFlag('--franchise') || process.env.FRANCHISE_FILE || env.FRANCHISE_FILE;
  if (!target) { console.error('\n✗ No franchise. Pass --franchise <path>'); process.exit(1); }
  if (!fs.existsSync(target)) { console.error(`\n✗ Not found: ${target}`); process.exit(1); }
  if (!fs.existsSync(PROSPECTS_FILE)) { console.error(`\n✗ Prospects file missing: ${PROSPECTS_FILE}`); process.exit(1); }

  console.log(`\n  Franchise : ${target}`);

  // Build name -> ratings dict from prospects.
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_FILE, 'utf8'));
  const byName = new Map();
  for (const p of prospects) {
    if (!p.firstName || !p.lastName || !p.ratings) continue;
    byName.set(nameKey(p.firstName, p.lastName), p);
  }
  console.log(`  Prospects : ${byName.size} indexed by name`);

  // Open target franchise.
  const fra = await new Promise((resolve, reject) => {
    const f = new Franchise(target, { gameYearOverride: 26 });
    f.on('error', (e) => reject(e));
    f.on('ready', () => resolve(f));
  });
  const tbl = fra.getTableByName('Player');
  if (!tbl) throw new Error('Player table not found');
  await tbl.readRecords();
  console.log(`  Records   : ${tbl.records.length} (capacity ${tbl.header.recordCapacity})\n`);

  let scanned = 0;
  let updated = 0;
  let unmatched = 0;
  const unmatchedSample = [];

  for (const rec of tbl.records) {
    if (rec.isEmpty) continue;
    let yd, yp;
    try {
      yd = rec.getFieldByKey('YearDrafted')?.value;
      yp = rec.getFieldByKey('YearsPro')?.value;
    } catch { continue; }
    if (!(yd === 0 || yd === '0')) continue;
    if (!(yp === 0 || yp === '0')) continue;

    scanned++;
    const fn = rec.getFieldByKey('FirstName')?.value;
    const ln = rec.getFieldByKey('LastName')?.value;
    if (!fn || !ln) continue;

    const p = byName.get(nameKey(fn, ln));
    if (!p) {
      unmatched++;
      if (unmatchedSample.length < 20) unmatchedSample.push(`${fn} ${ln}`);
      continue;
    }

    const ratings = p.ratings || {};
    for (const [key, val] of Object.entries(ratings)) {
      const fields = FIELD_MAP[key];
      if (!fields) continue;
      const safe = safeRating(val);
      if (safe === null) continue;
      const candidates = Array.isArray(fields) ? fields : [fields];
      for (const fname of candidates) {
        if (trySet(rec, fname, safe)) break;
      }
    }
    updated++;
  }

  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`  Rookies scanned : ${scanned}`);
  console.log(`  Updated         : ${updated}`);
  console.log(`  Unmatched       : ${unmatched}`);
  if (unmatchedSample.length) {
    console.log('\n  Unmatched (first 20):');
    for (const n of unmatchedSample) console.log(`    ${n}`);
    if (unmatched > unmatchedSample.length) console.log(`    … and ${unmatched - unmatchedSample.length} more`);
  }

  if (updated === 0) {
    console.log('\n  Nothing to save.');
    return;
  }

  console.log('\n  Saving …');
  await fra.save(target);
  console.log('✓ Saved.');
}

main().catch((err) => {
  console.error('\n✗ Fatal:', err?.message || err);
  process.exit(1);
});
