'use strict';

/**
 * Script 9g — Data-Driven Post-Draft Franchise Sync
 *
 * Updates a Madden 26 CAREER- franchise from the JSON outputs of the data
 * pipeline, without needing a separate source franchise as the rating
 * authority. In one pass it:
 *
 *   1. Updates every veteran in place — rating + dev trait from the rating
 *      source, team + contract from nfl_rosters_2026.json. Veterans currently
 *      on the wrong team are re-teamed; this is the difference vs. script 9
 *      (which only signs free agents).
 *   2. Empties every YearDrafted == 0 record (auto-drafted 2026 rookies).
 *   3. Injects each rookie from rookie_ratings_post_madden.json into the next
 *      empty slot, with their post-Madden ratings, real-life draft team, a
 *      rookie-scale contract, and a Wikipedia-sourced birthdate when known.
 *
 * Defaults to dry-run. Pass --apply to write.
 *
 * Run:
 *   node scripts/9g_sync_franchise_from_data.js [--franchise <path>] [--apply]
 *     [--ratings <path>]    default: data/full_solution_2_ratings.json
 *                           falls back to data/franchise_ratings.json
 *     [--rookies <path>]    default: data/rookie_ratings_post_madden.json
 *                           falls back to data/prospects_rated.json
 *     [--aliases <path>]    default: data/player_name_aliases.json (optional)
 *     [--birthdates <path>] default: data/prospect_birthdates.json
 *     [--allow-unmatched]   don't abort on unmatched veterans when --apply
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

const RATINGS_PRIMARY    = path.join(DATA_DIR, 'full_solution_2_ratings.json');
const RATINGS_FALLBACK   = path.join(DATA_DIR, 'franchise_ratings.json');
const ROOKIES_PRIMARY    = path.join(DATA_DIR, 'rookie_ratings_post_madden.json');
const ROOKIES_FALLBACK   = path.join(DATA_DIR, 'prospects_rated.json');
const NFL_ROSTERS_FILE   = path.join(DATA_DIR, 'nfl_rosters_2026.json');
const PROSPECTS_META     = path.join(DATA_DIR, 'prospects_rated.json');
const TEAM_MAP_FILE      = path.join(DATA_DIR, 'nfl_team_id_to_abbr.json');
const BIRTHDATES_FILE    = path.join(DATA_DIR, 'prospect_birthdates.json');
const ALIASES_FILE       = path.join(DATA_DIR, 'player_name_aliases.json');

const CURRENT_LEAGUE_YEAR = 2026;

// Bisect toggles. Branches `9g-rookies-only` and `9g-vets-only` flip these to
// isolate which pass causes a Madden load crash. Default (this branch): both on.
const ENABLE_VET_PASS      = true;
const ENABLE_ROOKIE_PASSES = true;

// ---------------------------------------------------------------------------
// nflverse abbr → Madden franchise TeamIndex (0-31). Mirrors script 9 / 9c so
// the three tools stay in sync.
// ---------------------------------------------------------------------------
const NFLVERSE_TO_TEAM_INDEX = {
  CHI: 0,  CIN: 1,  BUF: 2,  DEN: 3,  CLE: 4,  TB: 5,  ARI: 6,  LAC: 7,
  KC:  8,  IND: 9,  DAL: 10, MIA: 11, PHI: 12, ATL: 13, SF: 14, NYG: 15,
  JAX: 16, NYJ: 17, DET: 18, GB:  19, CAR: 20, NE:  21, LV: 22, LA:  23,
  BAL: 24, WAS: 25, NO:  26, SEA: 27, PIT: 28, TEN: 29, MIN: 30, HOU: 31,
};
const TEAM_INDEX_FREE_AGENT  = 32;
const CONTRACT_STATUS_SIGNED = '1';
const MIN_SALARY_K           = 895;

// nfl_team_id_to_abbr.json emits AZ/LAR; NFLVERSE_TO_TEAM_INDEX uses ARI/LA.
// Mirrors utils/4e_fetch_team_mapping.py:NFL_TO_MADDEN inverted.
const ABBR_NORMALIZE = { AZ: 'ARI', LAR: 'LA' };

// ---------------------------------------------------------------------------
// Rating field map. Same as 9c/9e. When the rating source's keys are short
// names (overall, speed, …) they're translated through this map; when keys
// are already Madden internal names (OverallRating, SpeedRating, …) they
// match `RATING_FIELD_NAMES` directly.
// ---------------------------------------------------------------------------
const FIELD_MAP = {
  overall:              ['OverallRating', 'PlayerBestOvr'],
  overallStored:        ['OverallRating', 'PlayerBestOvr'],
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
  bcVision:             ['BallCarrierVisionRating', 'BCVisionRating'],
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

// rookie_ratings_post_madden.json uses college-scouting labels. Map them onto
// Madden's standard dev-trait ladder so XFactor is reserved for projected elites.
const COLLEGE_DEV_TRAIT_MAP = {
  College_Normal: 'Normal',
  College_Star:   'Star',
  College_Impact: 'Superstar',
  College_Elite:  'XFactor',
};

// NFL jersey number ranges by position. Copied from 9c.
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

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

// ---------------------------------------------------------------------------
// Field helpers (same shape as 9c/9e — kept self-contained per repo convention)
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
  const resolved = typeof devValue === 'string' && COLLEGE_DEV_TRAIT_MAP[devValue]
    ? COLLEGE_DEV_TRAIT_MAP[devValue]
    : devValue;
  const idx = typeof resolved === 'number'
    ? Math.max(0, Math.min(3, resolved))
    : Math.max(0, DEV_TRAIT_STRINGS.indexOf(String(resolved)));
  for (const name of DEV_TRAIT_FIELDS) {
    try {
      const f = record.getFieldByKey(name);
      if (!f) continue;
      try { f.value = DEV_TRAIT_STRINGS[idx]; return; } catch (_) {}
      try { f.value = idx; return; } catch (_) {}
    } catch (_) { /* try next */ }
  }
}

function setBirthDate(record, dobIso) {
  if (!dobIso) return false;
  const d = new Date(dobIso);
  if (Number.isNaN(d.getTime())) return false;
  const yr = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const da = d.getUTCDate();
  let any = false;
  if (trySet(record, 'BirthYear',  yr)) any = true;
  if (trySet(record, 'BirthMonth', mo)) any = true;
  if (trySet(record, 'BirthDay',   da)) any = true;
  // Some franchise builds also expose a string field.
  const iso = `${yr}-${String(mo).padStart(2,'0')}-${String(da).padStart(2,'0')}`;
  if (trySet(record, 'BirthDate', iso)) any = true;
  return any;
}

// Compute age at NFL season start (Sept 1) of CURRENT_LEAGUE_YEAR. Matches
// how Madden frames player age at the top of a season.
function ageAtSeasonStart(dobIso) {
  const dob = new Date(dobIso);
  if (Number.isNaN(dob.getTime())) return null;
  const seasonStart = Date.UTC(CURRENT_LEAGUE_YEAR, 8, 1); // Sept = month 8
  const ageMs = seasonStart - dob.getTime();
  return Math.floor(ageMs / (365.25 * 24 * 3600 * 1000));
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

// Split "First Last Suffix" into first / last (everything after first token).
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// ---------------------------------------------------------------------------
// Contract translation — port of scripts/8_generate_roster_ratings.py:105
// Reads raw nflverse fields (aav, total_contract_value, guaranteed,
// contract_years, year_signed) and returns dollar-denominated Madden contract
// fields. Caller converts to thousands when writing.
// ---------------------------------------------------------------------------
function mapContractFields(rosterEntry, leagueYear = CURRENT_LEAGUE_YEAR) {
  const aav        = Number(rosterEntry.aav) || 0;
  const guaranteed = Number(rosterEntry.guaranteed) || 0;
  let years        = Number.parseInt(rosterEntry.contract_years, 10) || 0;
  if (years <= 0) years = 1;

  // Use the recorded signing year only when the deal hasn't already lapsed.
  // Mirrors the Python heuristic so 9g and script 8 stay consistent.
  const yearSigned = Number.parseInt(rosterEntry.year_signed, 10) || 0;
  let yearsLeft;
  if (yearSigned > 0 && (yearSigned + years) > leagueYear) {
    yearsLeft = Math.min(years, (yearSigned + years) - leagueYear);
  } else {
    yearsLeft = Math.max(1, years - Math.min(years - 1, 2));
  }

  // Signing bonus ≈ 50% of guaranteed money. Per-year base = AAV minus pro-
  // rated bonus, with an 800k floor so rookie minimums stay sane.
  const signingBonus  = guaranteed > 0 ? Math.round(guaranteed * 0.5) : 0;
  const proRatedBonus = Math.floor(signingBonus / Math.max(years, 1));
  const baseSalary    = Math.max(800_000, aav - proRatedBonus);

  return {
    contractLength:    years,
    contractYearsLeft: yearsLeft,
    contractBonus:     signingBonus,   // total signing bonus (all years)
    contractSalary:    baseSalary,
  };
}

// Write the Madden contract fields onto a Player record.
function writeContractToRecord(rec, mapped) {
  const salaryK = Math.max(MIN_SALARY_K, Math.round(mapped.contractSalary / 1000));
  const bonusK  = mapped.contractLength > 0
    ? Math.round(mapped.contractBonus / mapped.contractLength / 1000)
    : 0;
  trySet(rec, 'ContractStatus',   CONTRACT_STATUS_SIGNED);
  trySet(rec, 'ContractLength',   mapped.contractLength);
  trySet(rec, 'ContractYearsLeft', mapped.contractYearsLeft);
  trySet(rec, 'ContractYear',     0);
  trySet(rec, 'ContractSalary0',  salaryK);
  trySet(rec, 'ContractBonus0',   bonusK);
  trySet(rec, 'PLYR_CAPSALARY',   salaryK + bonusK);
}

// ---------------------------------------------------------------------------
// Rating snapshot helpers
// ---------------------------------------------------------------------------

// Translate a rating object that uses short keys (overall, speed) to one that
// uses Madden internal field names. If the input already uses Madden names,
// the lookup is a no-op for those keys.
function ratingObjectToMaddenFields(ratings) {
  if (!ratings || typeof ratings !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(ratings)) {
    if (RATING_FIELD_NAMES.includes(k)) {
      // Already a Madden field name (e.g. 'OverallRating')
      out[k] = v;
    } else if (FIELD_MAP[k] !== undefined) {
      // Short key — translate via FIELD_MAP. May be string or array of names.
      const target = FIELD_MAP[k];
      const names  = Array.isArray(target) ? target : [target];
      // Store under every candidate; trySet will pick the one that exists.
      for (const n of names) out[n] = v;
    }
    // else: unknown key (e.g. 'devTrait', 'personality', 'unkRating1'); keep
    // raw — handled by the caller for non-rating fields.
  }
  return out;
}

function applyRatingsObject(record, ratings) {
  const fields = ratingObjectToMaddenFields(ratings);
  for (const [name, value] of Object.entries(fields)) {
    const v = Number(value);
    if (!Number.isFinite(v)) continue;
    trySet(record, name, Math.max(0, Math.min(99, Math.round(v))));
  }
  // Dev trait may live on the rating object as a numeric short key.
  if (ratings && ratings.devTrait !== undefined) {
    setDevTrait(record, ratings.devTrait);
  }
}

// ---------------------------------------------------------------------------
// Rookie helpers — copied from 9c
// ---------------------------------------------------------------------------
function parseHeight(htStr) {
  if (!htStr) return 72;
  const parts = String(htStr).split('-');
  const ft = parseInt(parts[0], 10);
  const inch = parseInt(parts[1] || 0, 10);
  if (!Number.isFinite(ft)) return 72;
  return ft * 12 + (Number.isFinite(inch) ? inch : 0);
}

function encodeWeight(lbs) {
  const w = Number(lbs);
  if (!Number.isFinite(w) || w <= 0) return 60;
  return Math.max(0, Math.min(255, Math.round(w - 160)));
}

function safeRating(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(99, Math.round(n)));
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
// Franchise open
// ---------------------------------------------------------------------------
function openFranchise(filePath) {
  return new Promise((resolve, reject) => {
    // autoUnempty: true so writes to slots emptied earlier in this run persist.
    // (See 9f comment — without it, writes to empty slots silently no-op.)
    const fra = new Franchise(filePath, { gameYearOverride: 26, autoUnempty: true });
    fra.on('error', (err) => reject(new Error(`Franchise error (${filePath}): ${err?.message || err}`)));
    fra.on('ready', () => resolve(fra));
  });
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------
function resolveWithFallback(primary, fallback, label) {
  if (fs.existsSync(primary))  return { path: primary,  used: 'primary' };
  if (fs.existsSync(fallback)) return { path: fallback, used: 'fallback' };
  throw new Error(`${label}: neither ${primary} nor ${fallback} exists`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(64));
  console.log('Script 9g — Data-Driven Post-Draft Franchise Sync');
  console.log('='.repeat(64));

  const env = loadEnvFile(ENV_PATH);

  // ── Resolve paths ─────────────────────────────────────────────────────────
  const franchisePath = findFlag('--franchise')
                        || process.env.FRANCHISE_FILE
                        || env.FRANCHISE_FILE;
  if (!franchisePath) {
    console.error('\n✗ No franchise file. Pass --franchise <path> or set FRANCHISE_FILE in .env');
    process.exit(1);
  }
  if (!fs.existsSync(franchisePath)) {
    console.error(`\n✗ Franchise file not found: ${franchisePath}`);
    process.exit(1);
  }

  const ratingsArg     = findFlag('--ratings');
  const rookiesArg     = findFlag('--rookies');
  const aliasesArg     = findFlag('--aliases');
  const birthdatesArg  = findFlag('--birthdates');
  const apply          = hasFlag('--apply');
  const allowUnmatched = hasFlag('--allow-unmatched');

  const ratingsResolved = ratingsArg
    ? { path: ratingsArg, used: 'cli' }
    : resolveWithFallback(RATINGS_PRIMARY, RATINGS_FALLBACK, 'Veteran ratings file');
  const rookiesResolved = rookiesArg
    ? { path: rookiesArg, used: 'cli' }
    : resolveWithFallback(ROOKIES_PRIMARY, ROOKIES_FALLBACK, 'Rookie ratings file');
  const aliasesPath     = aliasesArg || ALIASES_FILE;
  const birthdatesPath  = birthdatesArg || BIRTHDATES_FILE;

  console.log(`\n  Mode            : ${apply ? 'APPLY (will save)' : 'DRY-RUN'}`);
  console.log(`  Franchise       : ${franchisePath}`);
  console.log(`  Veteran ratings : ${ratingsResolved.path} (${ratingsResolved.used})`);
  console.log(`  Rookie ratings  : ${rookiesResolved.path} (${rookiesResolved.used})`);
  console.log(`  Aliases         : ${fs.existsSync(aliasesPath) ? aliasesPath : '(none — optional)'}`);
  console.log(`  Birthdates      : ${fs.existsSync(birthdatesPath) ? birthdatesPath : '(none — Age fallback to 22)'}`);

  // ── Load inputs ───────────────────────────────────────────────────────────
  const ratingSource  = JSON.parse(fs.readFileSync(ratingsResolved.path, 'utf8'));
  const rookieSource  = JSON.parse(fs.readFileSync(rookiesResolved.path, 'utf8'));
  const nflRosters    = JSON.parse(fs.readFileSync(NFL_ROSTERS_FILE, 'utf8'));
  const prospectsMeta = fs.existsSync(PROSPECTS_META)
    ? JSON.parse(fs.readFileSync(PROSPECTS_META, 'utf8'))
    : [];
  const teamIdToAbbr  = JSON.parse(fs.readFileSync(TEAM_MAP_FILE, 'utf8'));
  const birthdatesRaw = fs.existsSync(birthdatesPath)
    ? JSON.parse(fs.readFileSync(birthdatesPath, 'utf8'))
    : {};
  const aliases = fs.existsSync(aliasesPath)
    ? JSON.parse(fs.readFileSync(aliasesPath, 'utf8'))
    : {};

  // ── Build veteran rating lookup ───────────────────────────────────────────
  // Each rating entry exposes (firstName, lastName, position, ratings object).
  // Tolerant of both array and object top-level shapes.
  const ratingEntries = Array.isArray(ratingSource)
    ? ratingSource
    : Object.values(ratingSource);
  const ratingByKey      = new Map();   // first|last|position → rating entry
  const ratingByNameOnly = new Map();   // first|last → array of entries

  for (const entry of ratingEntries) {
    let first = entry.firstName ?? entry.FirstName ?? '';
    let last  = entry.lastName  ?? entry.LastName  ?? '';
    if (!first && !last && (entry.name || entry.player_name)) {
      const split = splitName(entry.name || entry.player_name);
      first = split.first;
      last  = split.last;
    }
    const pos = entry.position ?? entry.Position ?? entry.pos ?? '';
    if (!first || !last) continue;
    const k  = makeKey(first, last, pos);
    const k2 = makeNameOnlyKey(first, last);
    if (!ratingByKey.has(k)) ratingByKey.set(k, entry);
    if (!ratingByNameOnly.has(k2)) ratingByNameOnly.set(k2, []);
    ratingByNameOnly.get(k2).push({ position: pos, entry });
  }

  // ── Build nfl_rosters_2026.json lookup (team + raw contract) ──────────────
  const rosterByName = new Map();
  for (const r of nflRosters) {
    const first = r.first_name || splitName(r.player_name).first;
    const last  = r.last_name  || splitName(r.player_name).last;
    if (!first || !last) continue;
    const k = makeNameOnlyKey(first, last);
    if (!rosterByName.has(k)) rosterByName.set(k, r);
  }

  // ── Build prospect metadata + birthdate lookups (for rookies) ─────────────
  const prospectMetaByName = new Map();
  for (const p of prospectsMeta) {
    const k = makeNameOnlyKey(p.firstName, p.lastName);
    if (!prospectMetaByName.has(k)) prospectMetaByName.set(k, p);
  }
  // birthdates: UUID → ISO dob string (only entries with populated dob)
  const dobByNflId = new Map();
  for (const [uuid, info] of Object.entries(birthdatesRaw)) {
    if (info && info.dob) dobByNflId.set(uuid, info.dob);
  }

  // ── Build the set of 2026 rookie names so the veteran pass skips them ─────
  const rookieNameSet = new Set();
  const rookieEntries = Array.isArray(rookieSource) ? rookieSource : Object.values(rookieSource);
  for (const r of rookieEntries) {
    let first = r.firstName ?? r.FirstName ?? '';
    let last  = r.lastName  ?? r.LastName  ?? '';
    if (!first && !last && (r.name || r.player_name)) {
      const split = splitName(r.name || r.player_name);
      first = split.first;
      last  = split.last;
    }
    if (first && last) rookieNameSet.add(makeNameOnlyKey(first, last));
  }

  console.log(`\n  Rating entries  : ${ratingEntries.length}`);
  console.log(`  NFL roster rows : ${nflRosters.length}`);
  console.log(`  Rookie entries  : ${rookieEntries.length}`);
  console.log(`  Prospect meta   : ${prospectsMeta.length}`);
  console.log(`  Birthdates (DOB): ${dobByNflId.size}`);
  console.log(`  Aliases loaded  : ${Object.keys(aliases).length}`);

  // ── Open franchise ────────────────────────────────────────────────────────
  console.log('\n  Opening franchise …');
  const franchise   = await openFranchise(franchisePath);
  const playerTable = franchise.getTableByName('Player');
  if (!playerTable) throw new Error('Player table not found in franchise file.');
  await playerTable.readRecords();
  console.log(`  Player records  : ${playerTable.records.length} (${playerTable.header.recordCapacity} capacity)`);

  console.log(`\n  Vet pass        : ${ENABLE_VET_PASS ? 'ON' : 'OFF (bisect)'}`);
  console.log(`  Rookie passes   : ${ENABLE_ROOKIE_PASSES ? 'ON' : 'OFF (bisect)'}`);

  // ── Pass 1: Veteran update ────────────────────────────────────────────────
  const stats = {
    skippedEmpty: 0, skippedNoName: 0, skippedRookieSlot: 0, skippedKnownRookie: 0,
    ratingsUpdated: 0, aliasedCount: 0, nameOnlyFallback: 0,
    teamUpdated: 0, contractFallback: 0,
    unmatched: [],
    rookiesCleared: 0,
    rookiesInjected: 0, rookiesToFA: 0, rookiesSkipped: 0,
    rookieMetaMissing: 0,
    realDobSet: 0, dobFallback: 0,
  };

  if (ENABLE_VET_PASS) for (const rec of playerTable.records) {
    if (rec.isEmpty) { stats.skippedEmpty++; continue; }
    const yd = safeGet(rec, 'YearDrafted');
    if (yd === 0 || yd === '0') { stats.skippedRookieSlot++; continue; }

    const fn = safeGet(rec, 'FirstName');
    const ln = safeGet(rec, 'LastName');
    const ps = safeGet(rec, 'Position');
    if (!fn || !ln) { stats.skippedNoName++; continue; }
    if (rookieNameSet.has(makeNameOnlyKey(fn, ln))) { stats.skippedKnownRookie++; continue; }

    // 1a. Rating lookup (key, then alias, then unique-name fallback)
    let ratingEntry = ratingByKey.get(makeKey(fn, ln, ps));
    let usedAlias   = false;

    if (!ratingEntry) {
      const aliasTo = aliases[`${fn} ${ln}`];
      if (aliasTo) {
        const split = splitName(aliasTo);
        ratingEntry = ratingByKey.get(makeKey(split.first, split.last, ps));
        if (ratingEntry) usedAlias = true;
      }
    }
    if (!ratingEntry) {
      const candidates = ratingByNameOnly.get(makeNameOnlyKey(fn, ln));
      if (candidates && candidates.length === 1) {
        ratingEntry = candidates[0].entry;
        stats.nameOnlyFallback++;
      }
    }

    if (ratingEntry) {
      applyRatingsObject(rec, ratingEntry.ratings || ratingEntry);
      // Many rating sources include dev trait outside the ratings object.
      if (ratingEntry.devTrait !== undefined && (!ratingEntry.ratings || ratingEntry.ratings.devTrait === undefined)) {
        setDevTrait(rec, ratingEntry.devTrait);
      }
      stats.ratingsUpdated++;
      if (usedAlias) stats.aliasedCount++;
    } else {
      stats.unmatched.push(`${fn} ${ln} (${ps})`);
    }

    // 1b. Team + contract lookup from nfl_rosters_2026.json
    let rosterHit = rosterByName.get(makeNameOnlyKey(fn, ln));
    if (!rosterHit) {
      const aliasTo = aliases[`${fn} ${ln}`];
      if (aliasTo) {
        const split = splitName(aliasTo);
        rosterHit = rosterByName.get(makeNameOnlyKey(split.first, split.last));
      }
    }

    if (rosterHit) {
      const rawTeam = String(rosterHit.team || '').toUpperCase();
      const team    = ABBR_NORMALIZE[rawTeam] ?? rawTeam;
      if (team === 'FA' || team === '') {
        trySet(rec, 'TeamIndex', TEAM_INDEX_FREE_AGENT);
        trySet(rec, 'ContractStatus', '0');
      } else if (team in NFLVERSE_TO_TEAM_INDEX) {
        trySet(rec, 'TeamIndex', NFLVERSE_TO_TEAM_INDEX[team]);
        const mapped = mapContractFields(rosterHit);
        writeContractToRecord(rec, mapped);
      } else {
        stats.contractFallback++;  // unrecognized abbr — leave as-is
        continue;
      }
      stats.teamUpdated++;
    } else {
      stats.contractFallback++;
    }
  }

  // ── Pass 2: Clear 2026 rookie slots ───────────────────────────────────────
  if (ENABLE_ROOKIE_PASSES) for (const rec of playerTable.records) {
    if (rec.isEmpty) continue;
    const yd = safeGet(rec, 'YearDrafted');
    if (yd === 0 || yd === '0') {
      try {
        rec.empty();
        stats.rookiesCleared++;
      } catch (_) {
        // Some records can't be emptied; skip silently (matches 9c behavior).
      }
    }
  }

  // ── Pass 3: Inject rookies ────────────────────────────────────────────────
  const pickJersey = makeJerseyAllocator();
  if (ENABLE_ROOKIE_PASSES) for (const r of rookieEntries) {
    // Identity (tolerant of multiple shapes)
    let first = r.firstName ?? r.FirstName ?? '';
    let last  = r.lastName  ?? r.LastName  ?? '';
    if (!first && !last && (r.name || r.player_name)) {
      const split = splitName(r.name || r.player_name);
      first = split.first;
      last  = split.last;
    }
    const pos = r.pos ?? r.position ?? r.Position ?? 'WR';
    if (!first || !last) { stats.rookiesSkipped++; continue; }

    // Recover metadata from prospects_rated.json when the post-Madden file
    // lacks supplementary fields (draftTeamId, nfl_id, draft round/pick, ht/wt).
    const meta = prospectMetaByName.get(makeNameOnlyKey(first, last)) || null;
    if (!meta) stats.rookieMetaMissing++;

    const draftTeamId       = r.draftTeamId       ?? meta?.draftTeamId       ?? null;
    const nflId             = r.nfl_id            ?? meta?.nfl_id            ?? null;
    const actualDraftRound  = r.actual_draft_round ?? meta?.actual_draft_round ?? r.draftRound ?? meta?.draftRound ?? 7;
    const actualDraftPick   = r.actual_draft_pick  ?? meta?.actual_draft_pick  ?? r.draftPick  ?? meta?.draftPick  ?? 99;
    const ht                = r.ht ?? meta?.ht ?? null;
    const wt                = r.wt ?? meta?.wt ?? null;

    // Resolve drafting team
    let teamIndex = TEAM_INDEX_FREE_AGENT;
    if (draftTeamId && teamIdToAbbr[draftTeamId]) {
      const rawAbbr = String(teamIdToAbbr[draftTeamId]).toUpperCase();
      const abbr    = ABBR_NORMALIZE[rawAbbr] ?? rawAbbr;
      if (abbr in NFLVERSE_TO_TEAM_INDEX) {
        teamIndex = NFLVERSE_TO_TEAM_INDEX[abbr];
      }
    }
    if (teamIndex === TEAM_INDEX_FREE_AGENT) stats.rookiesToFA++;

    // Find next empty slot
    const idx = playerTable.header.nextRecordToUse;
    if (idx >= playerTable.header.recordCapacity) { stats.rookiesSkipped++; continue; }
    const rec = playerTable.records[idx];

    // Identity
    trySet(rec, 'FirstName', String(first).slice(0, 11));
    trySet(rec, 'LastName',  String(last).slice(0, 14));
    trySet(rec, 'Position',  String(pos));
    if (r.playerType) trySet(rec, 'PlayerType', r.playerType);

    // Age + birthdate
    const dob = nflId ? dobByNflId.get(nflId) : null;
    if (dob) {
      const age = ageAtSeasonStart(dob);
      if (age !== null) trySet(rec, 'Age', age);
      setBirthDate(rec, dob);
      stats.realDobSet++;
    } else {
      trySet(rec, 'Age', 22);
      stats.dobFallback++;
    }

    // Physicals
    trySet(rec, 'Height', parseHeight(ht));
    trySet(rec, 'Weight', encodeWeight(wt));

    // Roster status
    trySet(rec, 'TeamIndex',       teamIndex);
    trySet(rec, 'ContractStatus',  CONTRACT_STATUS_SIGNED);
    trySet(rec, 'YearDrafted',     0);
    trySet(rec, 'YearsPro',        0);
    trySet(rec, 'PLYR_DRAFTROUND', Math.max(0, Math.min(7,  Number(actualDraftRound) || 7)));
    trySet(rec, 'PLYR_DRAFTPICK',  Math.max(0, Math.min(99, Number(actualDraftPick)  || 99)));

    // Jersey
    trySet(rec, 'JerseyNum', pickJersey(teamIndex, pos));

    // Rookie contract
    const c          = rookieContract(Number(actualDraftPick) || 0, Number(actualDraftRound) || 7);
    const aav        = Math.round(c.totalValue / c.years);
    const baseSalary = Math.max(MIN_SALARY_K, Math.round((aav - c.signingBonus / c.years) / 1000));
    const bonusK     = Math.round(c.signingBonus / c.years / 1000);
    trySet(rec, 'ContractLength',  c.years);
    trySet(rec, 'ContractYear',    0);
    trySet(rec, 'ContractSalary0', baseSalary);
    trySet(rec, 'ContractBonus0',  bonusK);
    trySet(rec, 'PLYR_CAPSALARY',  baseSalary + bonusK);

    // Ratings (post-Madden) + dev trait
    applyRatingsObject(rec, r.ratings || r);
    if (r.traitDevelopment !== undefined) {
      setDevTrait(rec, r.traitDevelopment);
    }

    stats.rookiesInjected++;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(64));
  console.log('Summary');
  console.log('='.repeat(64));
  console.log('Veterans');
  console.log(`  Ratings updated         : ${stats.ratingsUpdated}`);
  console.log(`    via alias             : ${stats.aliasedCount}`);
  console.log(`    via name-only fallback: ${stats.nameOnlyFallback}`);
  console.log(`  Team + contract updated : ${stats.teamUpdated}`);
  console.log(`  Contract fallback (kept): ${stats.contractFallback}`);
  console.log(`  Unmatched (no ratings)  : ${stats.unmatched.length}`);
  console.log('Rookies');
  console.log(`  Source                  : ${path.basename(rookiesResolved.path)} (${rookieEntries.length} entries)`);
  console.log(`  Cleared (YearDrafted=0) : ${stats.rookiesCleared}`);
  console.log(`  Injected on real teams  : ${stats.rookiesInjected - stats.rookiesToFA}`);
  console.log(`  Routed to FA pool       : ${stats.rookiesToFA}`);
  console.log(`  Metadata fallback used  : ${stats.rookieMetaMissing}`);
  console.log(`  Real birthdate set      : ${stats.realDobSet}`);
  console.log(`  Birthdate fallback (22) : ${stats.dobFallback}`);
  console.log(`  Skipped (capacity/name) : ${stats.rookiesSkipped}`);
  console.log('Skipped (Pass 1)');
  console.log(`  Empty slots             : ${stats.skippedEmpty}`);
  console.log(`  Known 2026 rookie names : ${stats.skippedKnownRookie}`);
  console.log(`  Records with no name    : ${stats.skippedNoName}`);

  if (stats.unmatched.length) {
    console.log('\nSample of unmatched veterans:');
    for (const n of stats.unmatched.slice(0, 30)) console.log(`  ${n}`);
    if (stats.unmatched.length > 30) {
      console.log(`  … and ${stats.unmatched.length - 30} more`);
    }
  }

  // ── Apply gate ────────────────────────────────────────────────────────────
  if (!apply) {
    console.log('\n(dry-run — no changes saved. Re-run with --apply to write.)');
    return;
  }
  if (stats.unmatched.length > 0 && !allowUnmatched) {
    console.error(`\n✗ ${stats.unmatched.length} unmatched veterans. Add to ${path.basename(aliasesPath)} or pass --allow-unmatched.`);
    process.exit(1);
  }

  console.log('\nSaving franchise file …');
  await franchise.save(franchisePath);
  console.log('✓ Saved.');
}

main().catch((err) => {
  console.error('\n✗ Fatal error:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
