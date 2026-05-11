'use strict';

/**
 * Script 9g — Data-Driven Post-Draft Franchise Sync
 *
 * Updates a Madden 26 CAREER- franchise from the JSON outputs of the data
 * pipeline, without needing a separate source franchise as the rating
 * authority. In one pass it:
 *
 *   1. Updates every active veteran's rating + dev trait from
 *      full_solution_2_ratings.json (with franchise_ratings.json fallback).
 *      Vet team / contract / depth-chart entries are not touched — the prior
 *      "Pass 1b" overlay corrupted contracts via floor-clamping and shipped
 *      vets to the wrong teams without depth-chart maintenance.
 *   2. (DISABLED — see comment near ENABLE_PASS_2_CLEAR.)
 *   3. Injects each rookie from rookie_ratings_post_madden.json into the next
 *      naturally-empty Player slot, with their post-Madden ratings, real-life
 *      draft team, a rookie-scale contract, and a Wikipedia-sourced birthdate
 *      when known. Each new rookie is also appended to their drafting team's
 *      Roster array (Player0..Player99 slots) so they appear on rosters,
 *      depth-chart and adjust-lineup screens.
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

// Pass toggles. PASS_2_CLEAR is OFF by default: Madden CTDs on sim if we
// empty the auto-generated rookie pool, even with reference cleaning, because
// HistoryEntry / PlayerAcquisitionEvaluation / Player[] arrays end up with
// null refs that the sim engine doesn't tolerate (the load engine does). The
// auto-rookies are harmless — they live in the future draft pool / FA pool,
// not on team rosters, so leaving them in place doesn't conflict with the
// real rookies we inject. The 977 naturally-empty Player slots accommodate
// the ~265 new rookies without any clearing needed.
const ENABLE_VET_PASS      = true;
const ENABLE_PASS_2_CLEAR  = false;  // OFF: emptying causes sim CTD (see comment above)
const ENABLE_PASS_3_INJECT = true;
// When ENABLE_PASS_3_INJECT is on, also send any unused auto-rookies to the
// FA pool so they don't sit in the future draft pool with their auto-generated
// names. Non-destructive: just changes their TeamIndex + ContractStatus.
const ENABLE_DISPOSE_UNUSED_AUTO_ROOKIES = true;
// Post-write hygiene passes (Pass 5/6). Pass 5 is cheap and always-on. Pass 6
// is gated because the V20 source franchise (CAREER-UPDATED-ROSTER) ships with
// vet contracts in the one-year shape (Length=1, Year=0), so regenerating the
// resign queue blindly would flood Madden's offseason UI with ~2000 walk-year
// vets. Re-enable once vet contract overlay (Change 4 in the contract-audit
// report) is also applied. CLI: --regenerate-resign forces it on.
const ENABLE_RECALC_ROSTER_SIZES = true;
const ENABLE_REGEN_RESIGN        = false;
// Warning threshold for resign regen — log a loud notice if the queue grows
// past this. Real NFL walk-year FA class is typically 50-200 players.
const RESIGN_QUEUE_WARN_THRESHOLD = 200;

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
// PlayerContractStatus is a 4-bit enum from the M26 schema. Use the enum NAME
// (the lib resolves it via _getEnumFromValue), not the integer — passing '1'
// happens to write decimal-1 = Signed, but '0' writes decimal-0 = Drafted,
// which is wrong for free agents (FreeAgent = decimal 6).
const CONTRACT_STATUS_SIGNED     = 'Signed';
const CONTRACT_STATUS_FREE_AGENT = 'FreeAgent';
// ContractStatus values that mean "this isn't an active player anymore" —
// skip these when re-teaming so we don't resurrect cap ghosts / retirees.
const CONTRACT_STATUS_INACTIVE = new Set(['Deleted', 'Retired', 'None']);
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

// Fill ContractSalary{i} / ContractBonus{i} for i=0..length-1 with the per-year
// flat cap-hit values. Slots [length..7] are zeroed — the engine reads them as
// "no more years on this deal." Without this multi-year fill every Player
// collapses to a one-year deal as soon as Madden increments ContractYear past
// 0: the engine reads ContractSalary{ContractYear} for the current cap hit
// and that index is 0 if we never wrote it. See SalaryCapManager.GetPlayerCapHitForYear
// in the M26 schema (assetId 7046) and CreateDraftedRookieContract (line 22920).
function fillContractYears(rec, salaryK, bonusK, length) {
  for (let i = 0; i < 8; i++) {
    const onContract = i < length;
    trySet(rec, `ContractSalary${i}`, onContract ? salaryK : 0);
    trySet(rec, `ContractBonus${i}`,  onContract ? bonusK  : 0);
  }
}

// Write the Madden contract fields onto a Player record.
function writeContractToRecord(rec, mapped) {
  const salaryK = Math.max(MIN_SALARY_K, Math.round(mapped.contractSalary / 1000));
  const bonusK  = mapped.contractLength > 0
    ? Math.round(mapped.contractBonus / mapped.contractLength / 1000)
    : 0;
  const length    = Math.max(1, Math.min(7, mapped.contractLength | 0));
  const yearsLeft = Math.max(1, Math.min(length, mapped.contractYearsLeft | 0));
  // ContractYear is the engine's "current year of the deal" cursor — 0 = signed
  // this season, length-1 = walk year. Derive from years-left so a vet two
  // years into a 4-year deal correctly reads ContractYear=2 and pulls his cap
  // hit from ContractSalary2/ContractBonus2.
  const contractYear = Math.max(0, Math.min(length - 1, length - yearsLeft));
  trySet(rec, 'ContractStatus', CONTRACT_STATUS_SIGNED);
  trySet(rec, 'ContractLength', length);
  trySet(rec, 'ContractYear',   contractYear);
  fillContractYears(rec, salaryK, bonusK, length);
  // PLYR_CAPSALARY is a cached convenience value the engine recomputes from
  // SalaryCapManager.GetPlayerCapHitForYear on each league-update tick — but
  // seeding it correctly avoids a one-frame stale display on first load.
  trySet(rec, 'PLYR_CAPSALARY', salaryK + bonusK);
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
// Reference-cleaning empty
//
// Madden's invariant (verified by 9z against a clean save): no live record
// references an empty Player row. Calling rec.empty() naively breaks this in
// every table that pointed at the now-empty row — HistoryEntry, Player[]
// roster arrays, stat snapshots, etc. — and the franchise won't load.
//
// `buildPlayerRefIndex` does a one-time scan of every table and indexes each
// reference field by the Player row it points at. `nullReferencesTo` then
// pre-emptively nulls every reference to a target row before we empty it,
// preserving the invariant.
// ---------------------------------------------------------------------------
const NULL_REFERENCE = '0'.repeat(32);   // 15-bit tableId=0 + 17-bit rowNumber=0

async function buildPlayerRefIndex(franchise, playerTableId) {
  const index = new Map();   // playerRow → Field[]
  for (const table of franchise.tables) {
    if (table.name === 'Player') continue;
    try { await table.readRecords(); } catch (_) { continue; }   // schema gaps — skip
    for (const rec of table.records) {
      if (rec.isEmpty) continue;
      const fields = rec.fieldsArray || [];
      for (const f of fields) {
        if (!f.isReference) continue;
        const r = f.referenceData;
        if (!r) continue;
        if (r.tableId === 0 && r.rowNumber === 0) continue;
        if (r.tableId !== playerTableId) continue;
        if (!index.has(r.rowNumber)) index.set(r.rowNumber, []);
        index.get(r.rowNumber).push(f);
      }
    }
  }
  return index;
}

function nullReferencesTo(refIndex, playerRow) {
  const fields = refIndex.get(playerRow);
  if (!fields) return 0;
  let nulled = 0;
  for (const f of fields) {
    try { f.value = NULL_REFERENCE; nulled++; } catch (_) { /* skip locked field */ }
  }
  return nulled;
}

// ---------------------------------------------------------------------------
// Per-team roster maintenance
//
// Each Team record (in the 35-record Team table — NOT the 1-record one
// getTableByName accidentally returns) has a Roster field that points at one
// row of a Player[] sub-table. That row has 100 fields (Player0..Player99),
// each a Player reference. Madden's roster screen reads from these slots.
// 9g must add injected rookies to the right team's row, or they're invisible.
// ---------------------------------------------------------------------------
async function buildTeamRosterContext(franchise, playerTableId) {
  // Find the populated Team table (skip the 1-record stub).
  const teamCandidates = franchise.tables.filter(t => t.name === 'Team');
  let teamMain = null;
  for (const t of teamCandidates) {
    try { await t.readRecords(); } catch (_) { continue; }
    const live = t.records.filter(r => !r.isEmpty).length;
    if (live >= 30) { teamMain = t; break; }
  }
  if (!teamMain) {
    console.warn('  ! No populated Team table found — skipping roster maintenance.');
    return null;
  }
  // Resolve the Roster sub-table from the first live Team record.
  let rosterTableId = null;
  for (const rec of teamMain.records) {
    if (rec.isEmpty) continue;
    const f = rec.getFieldByKey('Roster');
    if (f?.isReference) { rosterTableId = f.referenceData.tableId; break; }
  }
  if (!rosterTableId) {
    console.warn('  ! No Roster ref on Team[*] — skipping roster maintenance.');
    return null;
  }
  const rosterTable = franchise.getTableById(rosterTableId);
  if (!rosterTable) return null;
  await rosterTable.readRecords();

  // Map: NFL TeamIndex (0-31) → row number inside the roster sub-table.
  const teamIndexToRosterRow = new Map();
  for (const rec of teamMain.records) {
    if (rec.isEmpty) continue;
    const tiVal = rec.getFieldByKey('TeamIndex')?.value;
    const rosterRef = rec.getFieldByKey('Roster')?.referenceData;
    if (tiVal == null || rosterRef == null) continue;
    teamIndexToRosterRow.set(Number(tiVal), rosterRef.rowNumber);
  }

  console.log(`  Team table: ${teamMain.records.filter(r => !r.isEmpty).length} live records, roster sub-table id=${rosterTableId}`);
  return { teamMain, rosterTable, rosterTableId, teamIndexToRosterRow, playerTableId };
}

const utilService = require('madden-franchise/services/utilService');

function appendToTeamRoster(ctx, teamIndex, playerRow) {
  if (!ctx) return false;
  const rosterRowIdx = ctx.teamIndexToRosterRow.get(Number(teamIndex));
  if (rosterRowIdx == null) return false;
  const rosterRec = ctx.rosterTable.records[rosterRowIdx];
  if (!rosterRec || rosterRec.isEmpty) return false;
  // Find the first null/empty slot and write the new player ref.
  for (let i = 0; i < 100; i++) {
    const f = rosterRec.getFieldByKey(`Player${i}`);
    if (!f) continue;
    const r = f.referenceData;
    if (!r || (r.tableId === 0 && r.rowNumber === 0)) {
      try {
        f.value = utilService.getBinaryReferenceData(ctx.playerTableId, playerRow);
        return true;
      } catch (_) { return false; }
    }
  }
  return false;   // no open slot in roster
}

// Find which Player slot in a team's Roster (Player0..Player99) currently
// references the given player row. Returns the field, or null.
function findInTeamRoster(ctx, teamIndex, playerRow) {
  if (!ctx) return null;
  const rosterRowIdx = ctx.teamIndexToRosterRow.get(Number(teamIndex));
  if (rosterRowIdx == null) return null;
  const rosterRec = ctx.rosterTable.records[rosterRowIdx];
  if (!rosterRec || rosterRec.isEmpty) return null;
  for (let i = 0; i < 100; i++) {
    const f = rosterRec.getFieldByKey(`Player${i}`);
    if (!f || !f.isReference) continue;
    const r = f.referenceData;
    if (r && r.tableId === ctx.playerTableId && r.rowNumber === playerRow) return f;
  }
  return null;
}

function removeFromTeamRoster(ctx, teamIndex, playerRow) {
  const f = findInTeamRoster(ctx, teamIndex, playerRow);
  if (!f) return false;
  try { f.value = NULL_REFERENCE; return true; } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Player-validity + roster-size helpers
//
// Adapted from WiiExpertise/madden-franchise-utils Utils/FranchiseUtils.js
// (isValidPlayer :2481, recalculateRosterSizes :1369). Two-call API: filter
// records via isValidPlayer, then recalculate the three Team-level roster
// counters that Madden's sim engine reads during cap evaluation.
// ---------------------------------------------------------------------------

// Returns true if the player record is in a "real player" state. Default
// filter includes Signed + Expiring + FA + PracticeSquad; flip the options
// to exclude any of those (e.g. roster-size counters want FA+PS off).
function isValidPlayer(rec, opts = {}) {
  if (rec.isEmpty) return false;
  if (!opts.includeLegends && safeGet(rec, 'IsLegend')) return false;

  const cs = safeGet(rec, 'ContractStatus');
  // Exclusions: pass false to drop a state. Statuses we don't recognise here
  // (or null) fall through as "include" — same behaviour as WiiExpertise.
  if (opts.includeSignedPlayers    === false && cs === 'Signed')         return false;
  if (opts.includeFreeAgents       === false && cs === 'FreeAgent')      return false;
  if (opts.includePracticeSquad    === false && cs === 'PracticeSquad')  return false;
  if (opts.includeExpiringPlayers  === false && cs === 'Expiring')       return false;
  // Statuses that are off by default — pass true to include.
  if (opts.includeDraftPlayers     !== true  && cs === 'Draft')          return false;
  if (opts.includeRetiredPlayers   !== true  && cs === 'Retired')        return false;
  if (opts.includeDeletedPlayers   !== true  && cs === 'Deleted')        return false;
  if (opts.includeCreatedPlayers   !== true  && cs === 'Created')        return false;
  if (opts.includeNoneTypePlayers  !== true  && cs === 'None')           return false;
  return true;
}

// Resign tables (M26 unique IDs from WiiExpertise/Utils/FranchiseTableId.js).
// Same uniqueId across the M24/M25/M26 generations for the main table; only
// the array table changed (was 91905499 in M24, became 298416424 in M25/M26).
const RESIGN_TABLE_UID       = 846670960;
const RESIGN_ARRAY_TABLE_UID = 298416424;

// Default column values for an emptied resign row. Mirrors WiiExpertise's
// emptyResignTable defaults (Utils/FranchiseUtils.js:1025-1052). Madden treats
// a row with these zeros + Invalid/NotReady enum strings as "no pending
// re-sign negotiation" and re-derives offer values on the next league tick.
const RESIGN_RECORD_DEFAULTS = {
  Team: NULL_REFERENCE, Player: NULL_REFERENCE,
  ActiveRequestID: -2147483648,
  NegotiationWeek: 0, TeamReSignInterest: 0, ContractSalary: 0,
  NegotiationCount: 0, PlayerReSignInterest: 0, ContractBonus: 0,
  PreviousOfferedContractBonus: 0, PreviousOfferedContractSalary: 0,
  FairMarketContractBonus: 0, FairMarketContractSalary: 0,
  ActualDesiredContractBonus: 0, ActualDesiredContractSalary: 0,
  LatestOfferStage: 'PreSeason', ContractLength: 0,
  FairMarketContractLength: 0, PreviousOfferedContractLength: 0,
  PreviousReSignStatus: 'Invalid', ReSignStatus: 'NotReady',
  LatestOfferWeek: 0, PlayerPreviousReSignInterest: 0,
  InitialContract: false, NegotiationsEnded: false,
  ActualDesiredContractLength: 0,
};

// Regenerate the PlayerReSignNegotiation table from the live Player state.
// Mirrors WiiExpertise's emptyResignTable + fillResignTable (FranchiseUtils.js
// :1018 and :1080). The resign queue is what Madden's offseason re-sign phase
// reads to surface "this player wants a new deal" prompts; without regen, the
// queue stays pinned to whatever the source franchise had — which is wrong as
// soon as Pass 1 + Pass 3 change any vet's Length/Year math (see Change 1+2
// in docs/llm-wiki). Returns { skipped?, emptied, queued, arrayTables }.
async function regenerateResignTables(franchise, playerTable, teamTable) {
  const resignTable = franchise.getTableByUniqueId(RESIGN_TABLE_UID);
  if (!resignTable) return { skipped: true, reason: 'no_resign_table' };
  await resignTable.readRecords();

  // M26 has multiple PlayerReSignNegotiation[] sub-tables — one canonical
  // array table (UID above) plus per-team / per-role variants. Clear them all
  // to avoid stale refs pointing at rows we're about to empty.
  const arrayTables = franchise.getAllTablesByName('PlayerReSignNegotiation[]');
  for (const t of arrayTables) await t.readRecords();

  // Step 1: zero out + empty every existing resign row.
  let emptied = 0;
  for (const rec of resignTable.records) {
    if (rec.isEmpty) continue;
    for (const [k, v] of Object.entries(RESIGN_RECORD_DEFAULTS)) trySet(rec, k, v);
    try { rec.empty(); emptied++; } catch (_) { /* some rows can't be emptied */ }
  }

  // Step 2: null every ref in every array sub-table.
  for (const t of arrayTables) {
    const colNames = (t.offsetTable || []).map(o => o && o.name).filter(Boolean);
    for (const rec of t.records) {
      if (rec.isEmpty) continue;
      for (const name of colNames) trySet(rec, name, NULL_REFERENCE);
    }
  }

  // Step 3: build TeamIndex → team binary lookup.
  const teamBinaryByIndex = new Map();
  for (const teamRec of teamTable.records) {
    if (teamRec.isEmpty) continue;
    const ti = safeGet(teamRec, 'TeamIndex');
    if (ti == null) continue;
    teamBinaryByIndex.set(
      Number(ti),
      utilService.getBinaryReferenceData(teamTable.header.tableId, teamRec.index)
    );
  }

  // Step 4: requeue walk-year players. Use the canonical array table for
  // the back-ref array (per WiiExpertise — additional [] tables are
  // role-specific and get filled later by the engine).
  const primaryArrayTable = arrayTables.find(t => t.header && t.header.uniqueId === RESIGN_ARRAY_TABLE_UID)
    || (arrayTables.length ? arrayTables[0] : null);
  const arrayCols = primaryArrayTable
    ? (primaryArrayTable.offsetTable || []).map(o => o && o.name).filter(Boolean)
    : [];

  let queued = 0;
  for (const pRec of playerTable.records) {
    if (!isValidPlayer(pRec, {
      includeFreeAgents: false, includePracticeSquad: false,
    })) continue;
    const length = Number(safeGet(pRec, 'ContractLength')) || 0;
    const year   = Number(safeGet(pRec, 'ContractYear'))   || 0;
    if (length - year !== 1) continue;
    const ti = Number(safeGet(pRec, 'TeamIndex'));
    const teamBin = teamBinaryByIndex.get(ti);
    if (!teamBin) continue;

    // Next empty resign row.
    let target = null;
    for (const rec of resignTable.records) {
      if (rec.isEmpty) { target = rec; break; }
    }
    if (!target) break;   // table full — stop queueing

    const playerBin = utilService.getBinaryReferenceData(playerTable.header.tableId, pRec.index);
    trySet(target, 'Team',            teamBin);
    trySet(target, 'Player',          playerBin);
    trySet(target, 'ActiveRequestID', -1);
    trySet(target, 'NegotiationWeek', 2);

    if (primaryArrayTable && arrayCols.length) {
      const resignBin = utilService.getBinaryReferenceData(resignTable.header.tableId, target.index);
      for (const col of arrayCols) {
        try {
          const f = primaryArrayTable.records[0].getFieldByKey(col);
          if (!f) continue;
          if (f.value === NULL_REFERENCE) {
            f.value = resignBin;
            break;
          }
        } catch (_) { /* try next slot */ }
      }
    }
    queued++;
  }
  return { emptied, queued, arrayTables: arrayTables.length };
}

// Recompute each team's ActiveRosterSize / SalCapRosterSize / SalCapNextYearRosterSize
// from the actual Player rows. Without this, those counters drift any time we
// add/remove/cut players on a team — which then drifts the cap math the engine
// derives from them. Called as the last write-side step of Pass 3/4 before save.
async function recalculateRosterSizes(playerTable, teamTable) {
  let touched = 0;
  for (const teamRec of teamTable.records) {
    if (teamRec.isEmpty) continue;
    const dn = safeGet(teamRec, 'DisplayName');
    if (dn === 'AFC' || dn === 'NFC') continue;
    const visible = safeGet(teamRec, 'TEAM_VISIBLE');
    if (visible === false) continue;
    const ti = Number(safeGet(teamRec, 'TeamIndex'));
    if (!Number.isFinite(ti) || ti < 0 || ti > 31) continue;

    let active = 0, salCap = 0, nextYear = 0;
    for (const pRec of playerTable.records) {
      if (!isValidPlayer(pRec, { includePracticeSquad: false, includeFreeAgents: false })) continue;
      if (Number(safeGet(pRec, 'TeamIndex')) !== ti) continue;
      salCap++;
      if (!safeGet(pRec, 'IsInjuredReserve')) active++;
      if (Number(safeGet(pRec, 'ContractLength')) > 1) nextYear++;
    }
    trySet(teamRec, 'ActiveRosterSize',         active);
    trySet(teamRec, 'SalCapRosterSize',         salCap);
    trySet(teamRec, 'SalCapNextYearRosterSize', nextYear);
    touched++;
  }
  return { touched };
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
  console.log(`  Pass 2 (clear)  : ${ENABLE_PASS_2_CLEAR ? 'ON' : 'OFF (bisect)'}`);
  console.log(`  Pass 3 (inject) : ${ENABLE_PASS_3_INJECT ? 'ON' : 'OFF (bisect)'}`);

  // ── Pass 1: Veteran update ────────────────────────────────────────────────
  const stats = {
    skippedEmpty: 0, skippedNoName: 0, skippedRookieSlot: 0, skippedKnownRookie: 0, skippedInactiveVets: 0,
    ratingsUpdated: 0, aliasedCount: 0, nameOnlyFallback: 0,
    teamUpdated: 0, contractFallback: 0,
    unmatched: [],
    rookiesCleared: 0, refsNulled: 0, refIndexBuildMs: 0,
    rookiesInjected: 0, rookiesToFA: 0, rookiesSkipped: 0,
    rookieMetaMissing: 0,
    realDobSet: 0, dobFallback: 0,
    rookiesAddedToRoster: 0, rookiesNoRosterSlot: 0,
    rookiesFreshInjected: 0,
    unusedAutoRookiesDisposed: 0,
    teamsRecalculated: 0,
    resignEmptied: 0, resignQueued: 0,
  };

  if (ENABLE_VET_PASS) for (const rec of playerTable.records) {
    if (rec.isEmpty) { stats.skippedEmpty++; continue; }
    const yd = safeGet(rec, 'YearDrafted');
    // Skip the 2026 auto-rookie placeholders. In M26's franchise convention,
    // YearDrafted=1 + YearsPro=0 are next-year draft-pool prospects (Madden's
    // synthetic 2026 class to be replaced by Pass 3). YearDrafted=0 records
    // are CURRENT-year rookies + UDFAs we want to leave alone.
    const yp = safeGet(rec, 'YearsPro');
    if (yd === 1 && (yp === 0 || yp === '0')) { stats.skippedRookieSlot++; continue; }

    // Don't resurrect cap ghosts / retirees by overwriting their team / contract.
    const currentStatus = safeGet(rec, 'ContractStatus');
    if (CONTRACT_STATUS_INACTIVE.has(currentStatus)) { stats.skippedInactiveVets++; continue; }

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

    // 1b. (DISABLED) Team + contract overlay used to come from nfl_rosters_2026.json,
    //               but it crushed depth-chart consistency and demolished contracts
    //               for any vet whose nflverse aav was 0 (pinning them to the 895k
    //               minimum). The diff against the original confirmed thousands of
    //               unintended contract overwrites. Vets now keep whatever team and
    //               contract the franchise had for them. Only ratings update above.
    stats.contractFallback++;
  }

  // Build per-team roster context once — used by Pass 3 to append rookies
  // to the right team's roster array (Player0..Player99 slots).
  console.log('\n  Building team-roster index …');
  const rosterCtx = await buildTeamRosterContext(franchise, playerTable.header.tableId);

  // ── Pass 2: Clear 2026 rookie slots (reference-cleaning empty) ────────────
  if (ENABLE_PASS_2_CLEAR) {
    console.log('\n  Pass 2: scanning all tables for player references …');
    const t0 = Date.now();
    const refIndex = await buildPlayerRefIndex(franchise, playerTable.header.tableId);
    stats.refIndexBuildMs = Date.now() - t0;
    console.log(`  Reference index built in ${stats.refIndexBuildMs}ms — ${refIndex.size} player rows referenced`);

    for (const rec of playerTable.records) {
      if (rec.isEmpty) continue;
      const yd = safeGet(rec, 'YearDrafted');
      if (yd === 0 || yd === '0') {
        try {
          stats.refsNulled += nullReferencesTo(refIndex, rec.index);
          rec.empty();
          stats.rookiesCleared++;
        } catch (_) {
          // Some records can't be emptied; skip silently (matches 9c behavior).
        }
      }
    }
  }

  // ── Pass 3: Overlay rookies onto auto-generated rookie slots ──────────────
  //
  // For each post-Madden rookie, find an auto-generated rookie record
  // (YearDrafted=0) — preferring one already on the same drafting team to
  // avoid roster-array maintenance — and rewrite its identity in place. If
  // the auto-rookie is on a different team than the rookie's real-life
  // drafter, swap roster-array slots: remove from old team's Roster, add to
  // new team's Roster, update TeamIndex.
  //
  // Mutating in place (rather than empty + inject) preserves every reference
  // pointing at the row (HistoryEntry, PlayerAcquisitionEvaluation, depth-
  // chart slots, etc.). That's the difference that lets sim work.
  // Auto-rookie placeholders: YearDrafted=1, YearsPro=0 (Madden's synthetic
  // 2026 draft class on real teams with fake names). YearDrafted=0 catches
  // 2025 rookies + UDFAs we MUST NOT touch.
  const autoRookiePool = [];   // { row, teamIndex, used }
  if (ENABLE_PASS_3_INJECT) {
    for (let i = 0; i < playerTable.records.length; i++) {
      const arRec = playerTable.records[i];
      if (arRec.isEmpty) continue;
      const yd = safeGet(arRec, 'YearDrafted');
      const yp = safeGet(arRec, 'YearsPro');
      if (yd === 1 && (yp === 0 || yp === '0')) {
        autoRookiePool.push({ row: i, teamIndex: Number(safeGet(arRec, 'TeamIndex')), used: false });
      }
    }
    console.log(`  Auto-rookie pool        : ${autoRookiePool.length} eligible for overlay (YearDrafted=1, YearsPro=0)`);
  }
  // Bucket by team for fast same-team picks
  const autoRookieByTeam = new Map();
  for (let i = 0; i < autoRookiePool.length; i++) {
    const t = autoRookiePool[i].teamIndex;
    if (!autoRookieByTeam.has(t)) autoRookieByTeam.set(t, []);
    autoRookieByTeam.get(t).push(i);
  }
  // Same-team only — no fallback. Mismatches get injected as new records
  // (V5 path) below, which is sim-safe; cross-team overlay required Roster
  // swap + DepthChart maintenance which we aren't doing.
  function pickAutoRookieSameTeam(preferTeam) {
    if (!autoRookieByTeam.has(preferTeam)) return null;
    const bucket = autoRookieByTeam.get(preferTeam);
    while (bucket.length) {
      const k = bucket.shift();
      if (!autoRookiePool[k].used) {
        autoRookiePool[k].used = true;
        return autoRookiePool[k];
      }
    }
    return null;
  }

  const pickJersey = makeJerseyAllocator();
  if (ENABLE_PASS_3_INJECT) for (const r of rookieEntries) {
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

    // Try overlay first (same-team only). If none, inject as new record.
    const autoRookie = pickAutoRookieSameTeam(teamIndex);
    let idx, rec;
    if (autoRookie) {
      idx = autoRookie.row;
      rec = playerTable.records[idx];
    } else {
      // Fresh inject path (V5-style): use next empty Player slot.
      idx = playerTable.header.nextRecordToUse;
      if (idx >= playerTable.header.recordCapacity) { stats.rookiesSkipped++; continue; }
      rec = playerTable.records[idx];
      stats.rookiesFreshInjected++;
    }

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

    // Same-team overlay → no team change needed (autoRookie already on the
    // right team). Inject path → set TeamIndex fresh.
    if (!autoRookie) {
      trySet(rec, 'TeamIndex', teamIndex);
    }
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
    const rookieLength = Math.max(1, Math.min(7, c.years | 0));
    trySet(rec, 'ContractLength', rookieLength);
    trySet(rec, 'ContractYear',   0);   // rookie is in year 0 of the deal
    fillContractYears(rec, baseSalary, bonusK, rookieLength);
    trySet(rec, 'PLYR_CAPSALARY', baseSalary + bonusK);

    // Ratings (post-Madden) + dev trait
    applyRatingsObject(rec, r.ratings || r);
    if (r.traitDevelopment !== undefined) {
      setDevTrait(rec, r.traitDevelopment);
    }

    // Add to drafting team's Roster array so the player shows up in Madden's
    // roster / depth-chart / lineup screens. We only need to add when:
    //   (a) the team changed (we removed from old team's Roster above), OR
    //   (b) the auto-rookie wasn't already in any Roster slot.
    // For (b), findInTeamRoster on the same team returns null so we always
    // append. Cheap enough to just check & append unconditionally.
    if (teamIndex !== TEAM_INDEX_FREE_AGENT) {
      const alreadyInRoster = findInTeamRoster(rosterCtx, teamIndex, idx);
      if (!alreadyInRoster) {
        if (appendToTeamRoster(rosterCtx, teamIndex, idx)) stats.rookiesAddedToRoster++;
        else                                                stats.rookiesNoRosterSlot++;
      }
    }

    stats.rookiesInjected++;
  }

  // ── Pass 4: dispose unused auto-rookies ───────────────────────────────────
  // Move any auto-rookie we didn't overlay to the FA pool so they don't
  // pollute the future draft pool / clutter team rosters. This is a non-
  // destructive disposition: no rec.empty(), no broken refs.
  if (ENABLE_PASS_3_INJECT && ENABLE_DISPOSE_UNUSED_AUTO_ROOKIES) {
    for (let i = 0; i < autoRookiePool.length; i++) {
      if (autoRookiePool[i].used) continue;
      const ar  = autoRookiePool[i];
      const rec = playerTable.records[ar.row];
      if (ar.teamIndex !== TEAM_INDEX_FREE_AGENT && ar.teamIndex >= 0 && ar.teamIndex <= 31) {
        removeFromTeamRoster(rosterCtx, ar.teamIndex, ar.row);
      }
      trySet(rec, 'TeamIndex',      TEAM_INDEX_FREE_AGENT);
      trySet(rec, 'ContractStatus', CONTRACT_STATUS_FREE_AGENT);
      stats.unusedAutoRookiesDisposed++;
    }
  }

  // ── Pass 5: recompute Team-level roster-size counters ─────────────────────
  // After we've moved rookies onto teams and disposed unused auto-rookies, the
  // three counters Madden's cap math reads (ActiveRosterSize, SalCapRosterSize,
  // SalCapNextYearRosterSize) are stale. Re-derive them from the actual Player
  // table state. Adopted from WiiExpertise.
  if (ENABLE_RECALC_ROSTER_SIZES && rosterCtx && rosterCtx.teamMain) {
    const recalc = await recalculateRosterSizes(playerTable, rosterCtx.teamMain);
    stats.teamsRecalculated = recalc.touched;
    console.log(`\n  Roster-size recalc      : ${recalc.touched} teams`);
  }

  // ── Pass 6: regenerate PlayerReSignNegotiation queue ──────────────────────
  // Off by default — the V20 source has vets in the one-year-shape (Length=1,
  // Year=0), so regen queues every vet as walk-year (~2000 entries). That
  // floods Madden's offseason UI. Re-enable once vet contracts get the
  // multi-year fill (Change 4 in the audit report). CLI: --regenerate-resign.
  const regenResign = ENABLE_REGEN_RESIGN || hasFlag('--regenerate-resign');
  if (regenResign && rosterCtx && rosterCtx.teamMain) {
    const resign = await regenerateResignTables(franchise, playerTable, rosterCtx.teamMain);
    if (resign.skipped) {
      console.log(`  Resign regenerate       : skipped (${resign.reason})`);
    } else {
      stats.resignEmptied = resign.emptied;
      stats.resignQueued  = resign.queued;
      console.log(`  Resign regenerate       : emptied ${resign.emptied}, queued ${resign.queued} walk-year players (across ${resign.arrayTables} array tables)`);
      if (resign.queued > RESIGN_QUEUE_WARN_THRESHOLD) {
        console.log(`  ⚠  Resign queue size ${resign.queued} > ${RESIGN_QUEUE_WARN_THRESHOLD} — suggests source franchise has`);
        console.log(`     vets in one-year contract shape. Madden's offseason UI may surface too many`);
        console.log(`     re-sign prompts. Apply Change 4 (vet contract overlay) to fix at source.`);
      }
    }
  } else if (rosterCtx && rosterCtx.teamMain) {
    console.log(`  Resign regenerate       : OFF (use --regenerate-resign to enable; see Pass 6 comment)`);
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
  console.log(`  Auto-rookie pool size   : ${autoRookiePool.length}`);
  console.log(`  Total processed         : ${stats.rookiesInjected}`);
  console.log(`    Overlaid (same team)  : ${stats.rookiesInjected - stats.rookiesFreshInjected}`);
  console.log(`    Fresh-injected        : ${stats.rookiesFreshInjected}`);
  console.log(`    Added to team Roster  : ${stats.rookiesAddedToRoster}`);
  console.log(`    No open Roster slot   : ${stats.rookiesNoRosterSlot}`);
  console.log(`  Routed to FA (no draft) : ${stats.rookiesToFA}`);
  console.log(`  Disposed (unused → FA)  : ${stats.unusedAutoRookiesDisposed}`);
  console.log(`  Routed to FA pool       : ${stats.rookiesToFA}`);
  console.log(`  Metadata fallback used  : ${stats.rookieMetaMissing}`);
  console.log(`  Real birthdate set      : ${stats.realDobSet}`);
  console.log(`  Birthdate fallback (22) : ${stats.dobFallback}`);
  console.log(`  Skipped (capacity/name) : ${stats.rookiesSkipped}`);
  console.log('Skipped (Pass 1)');
  console.log(`  Empty slots             : ${stats.skippedEmpty}`);
  console.log(`  Known 2026 rookie names : ${stats.skippedKnownRookie}`);
  console.log(`  Inactive vets (kept)    : ${stats.skippedInactiveVets}`);
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
