'use strict';

/**
 * Script 9f — Inject Real Rookies from a Source Franchise
 *
 * Copies every Player record with YearDrafted == 0 from a source franchise
 * (e.g. one where Madden has already drafted the real 2026 class) into the
 * target franchise's empty Player slots. Preserves identity, ratings, team,
 * contract, and dev trait verbatim.
 *
 * Uses madden-franchise's autoUnempty setting so writes to previously-empty
 * slots actually persist (without it, writes silently no-op — that's why
 * 9c's injection didn't take).
 *
 * Run:
 *   node scripts/9f_inject_rookies_from_franchise.js \
 *     --source /path/to/SOURCE-CAREER --franchise /path/to/TARGET-CAREER
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

const SCRIPT_DIR   = __dirname;
const PROJECT_ROOT = path.join(SCRIPT_DIR, '..');
const ENV_PATH     = path.join(PROJECT_ROOT, '.env');

// Identity / roster fields copied verbatim from source.
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
  if (devValue === null || devValue === undefined) return;
  for (const name of DEV_TRAIT_FIELDS) {
    try {
      const f = record.getFieldByKey(name);
      if (!f) continue;
      try { f.value = devValue; return; } catch (_) {}
      if (typeof devValue === 'string') {
        const idx = DEV_TRAIT_STRINGS.indexOf(devValue);
        if (idx >= 0) { try { f.value = idx; return; } catch (_) {} }
      } else if (typeof devValue === 'number') {
        const str = DEV_TRAIT_STRINGS[Math.max(0, Math.min(3, devValue))];
        try { f.value = str; return; } catch (_) {}
      }
    } catch (_) { /* try next */ }
  }
}

function snapshotRecord(record) {
  const data = {};
  for (const name of [...IDENTITY_FIELDS, ...RATING_FIELD_NAMES]) {
    const v = safeGet(record, name);
    if (v !== null && v !== undefined) data[name] = v;
  }
  for (const name of DEV_TRAIT_FIELDS) {
    const v = safeGet(record, name);
    if (v !== null && v !== undefined) { data._devTrait = v; break; }
  }
  return data;
}
function applyRecord(record, data) {
  // Write Position FIRST — Position field sits in the first 4 bytes of the
  // record, which forces the table to mark the record as non-empty even if
  // autoUnempty is disabled. (No-op cost when autoUnempty is true.)
  if ('Position' in data) trySet(record, 'Position', data.Position);
  for (const name of IDENTITY_FIELDS) {
    if (name === 'Position') continue;
    if (name in data) trySet(record, name, data[name]);
  }
  for (const name of RATING_FIELD_NAMES) {
    if (name in data) trySet(record, name, data[name]);
  }
  if ('_devTrait' in data) setDevTrait(record, data._devTrait);
}

// ---------------------------------------------------------------------------
function openFranchise(filePath) {
  return new Promise((resolve, reject) => {
    const fra = new Franchise(filePath, {
      gameYearOverride: 26,
      autoUnempty:      true,
    });
    fra.on('error', (err) => reject(new Error(`Franchise error (${filePath}): ${err?.message || err}`)));
    fra.on('ready', () => resolve(fra));
  });
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(60));
  console.log('Script 9f — Inject Rookies from Source Franchise');
  console.log('='.repeat(60));

  const env       = loadEnvFile(ENV_PATH);
  const sourceArg = findFlag('--source')    || env.SOURCE_FILE;
  const targetArg = findFlag('--franchise') || env.FRANCHISE_FILE;

  if (!sourceArg) { console.error('\n✗ --source missing'); process.exit(1); }
  if (!targetArg) { console.error('\n✗ --franchise missing'); process.exit(1); }
  if (!fs.existsSync(sourceArg)) { console.error(`\n✗ Source not found: ${sourceArg}`); process.exit(1); }
  if (!fs.existsSync(targetArg)) { console.error(`\n✗ Target not found: ${targetArg}`); process.exit(1); }

  console.log(`\n  Source : ${sourceArg}`);
  console.log(`  Target : ${targetArg}`);

  // --- Source: snapshot rookies (yd == 0) ---------------------------------
  console.log('\n  Reading source franchise …');
  const srcFra   = await openFranchise(sourceArg);
  const srcTable = srcFra.getTableByName('Player');
  if (!srcTable) throw new Error('Source: Player table not found.');
  await srcTable.readRecords();

  const snapshots = [];
  let srcSeen     = 0;
  for (const r of srcTable.records) {
    if (r.isEmpty) continue;
    srcSeen++;
    const yd = safeGet(r, 'YearDrafted');
    if (yd !== 0 && yd !== '0') continue;
    const fn = safeGet(r, 'FirstName');
    const ln = safeGet(r, 'LastName');
    if (!fn && !ln) continue;
    snapshots.push(snapshotRecord(r));
  }
  console.log(`  Source nonempty: ${srcSeen}, rookies snapshotted (yd=0): ${snapshots.length}`);

  // --- Target: empty target rookie filler, then write snapshots ----------
  console.log('\n  Opening target franchise …');
  const tgtFra   = await openFranchise(targetArg);
  const tgtTable = tgtFra.getTableByName('Player');
  if (!tgtTable) throw new Error('Target: Player table not found.');
  await tgtTable.readRecords();

  // Empty Madden's autogen rookie filler (yd=1 + yp=0) so they don't
  // double-up with the real rookies we're about to inject.
  let cleared = 0;
  for (const r of tgtTable.records) {
    if (r.isEmpty) continue;
    const yd = safeGet(r, 'YearDrafted');
    const yp = safeGet(r, 'YearsPro');
    if ((yd === 1 || yd === '1') && (yp === 0 || yp === '0')) {
      try { r.empty(); cleared++; } catch (_) { /* skip */ }
    }
  }
  console.log(`  Target autogen filler emptied: ${cleared} (yd=1 + yp=0)`);

  // Find empty slots and inject snapshots.
  let written      = 0;
  let outOfSpace   = 0;
  for (const data of snapshots) {
    let slot = null;
    for (const r of tgtTable.records) {
      if (r.isEmpty) { slot = r; break; }
    }
    if (!slot) { outOfSpace++; continue; }
    applyRecord(slot, data);
    written++;
  }
  console.log(`  Rookies written: ${written}`);
  if (outOfSpace) console.log(`  ⚠  Out of space: ${outOfSpace} rookies dropped`);

  if (written === 0 && cleared === 0) {
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
