'use strict';

/**
 * Script 11 — Apply Game Results (ForceWin)
 *
 * Reads data\game_results_2025.json (real 2025 NFL season results) and the
 * Madden 26 franchise file, then sets the ForceWin field on every SeasonGame
 * record so that when weeks are simmed in-game the correct team wins.
 *
 * ForceWin values used by Madden 26:
 *   "0"  → Home team wins
 *   "1"  → Away team wins
 *   "10" → No override (random simulation, the default)
 *
 * This script is safe to run multiple times (idempotent — overwrites with
 * the same value).  Run it again after the regular season completes so that
 * the newly-populated playoff matchups also get their ForceWin set.
 *
 * Run:
 *   node scripts\11_apply_game_results.js data\game_results_2025.json --franchise C:\path\to\CAREER-FRANCHISE
 *   node scripts\11_apply_game_results.js --franchise C:\path\to\CAREER-FRANCHISE --results data\game_results_2025.json
 *   node scripts\11_apply_game_results.js "@.\data\game_results_2025.json" --franchise C:\path\to\CAREER-FRANCHISE
 *   FRANCHISE_FILE=C:\path\to\CAREER-FRANCHISE node scripts\11_apply_game_results.js
 *
 * Note: quote @file-style paths in PowerShell (for example,
 * "@.\data\game_results_2025.json") so PowerShell passes the value to Node.
 */

const fs      = require('fs');
const path    = require('path');
const Franchise = require('madden-franchise');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SCRIPT_DIR     = __dirname;
const PROJECT_ROOT   = path.join(SCRIPT_DIR, '..');
const DATA_DIR       = path.join(PROJECT_ROOT, 'data');
const ENV_PATH       = path.join(PROJECT_ROOT, '.env');
const DEFAULT_RESULTS_FILE = path.join(DATA_DIR, 'game_results_2025.json');

// ---------------------------------------------------------------------------
// Madden franchise TeamIndex (0-31) → nflverse abbreviation
// ---------------------------------------------------------------------------
const TEAM_INDEX_TO_NFLVERSE = {
  0:'CHI', 1:'CIN', 2:'BUF', 3:'DEN', 4:'CLE', 5:'TB',  6:'ARI', 7:'LAC',
  8:'KC',  9:'IND', 10:'DAL',11:'MIA',12:'PHI',13:'ATL',14:'SF', 15:'NYG',
  16:'JAX',17:'NYJ',18:'DET',19:'GB', 20:'CAR',21:'NE', 22:'LV', 23:'LA',
  24:'BAL',25:'WAS',26:'NO', 27:'SEA',28:'PIT',29:'TEN',30:'MIN',31:'HOU',
};

// Franchise SeasonWeekType (binary string) → nflverse game_type
// SeasonWeekType "1"   = Regular season  →  "REG"
// SeasonWeekType "10"  = Wild-card round →  "WC"
// SeasonWeekType "11"  = Divisional      →  "DIV"
// SeasonWeekType "100" = Conf. champ.    →  "CON"
// SeasonWeekType "101" = Super Bowl      →  "SB"
const WEEK_TYPE_TO_GAME_TYPE = {
  '1':   'REG',
  '10':  'WC',
  '11':  'DIV',
  '100': 'CON',
  '101': 'SB',
};

// Franchise regular-season SeasonWeek (0-17) → nflverse week (1-18)
const regWeekToNfl = (w) => w + 1;

// ForceWin enum values
const FORCE_WIN_HOME = '0';
const FORCE_WIN_AWAY = '1';
const FORCE_WIN_NONE = '10';

// ---------------------------------------------------------------------------
// Minimal .env parser
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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--franchise') return args[i + 1];
    if (args[i].startsWith('--franchise=')) return args[i].slice('--franchise='.length);
  }
  if (process.env.FRANCHISE_FILE) return process.env.FRANCHISE_FILE;
  const envVars = loadEnvFile(ENV_PATH);
  return envVars['FRANCHISE_FILE'] || null;
}

function normalizeInputPath(rawPath) {
  if (!rawPath) return rawPath;
  let inputPath = String(rawPath).trim();

  // Some callers pass tagged/context files as @./path/to/file.json.
  // Treat the leading @ as metadata, not as part of the filesystem path.
  if (inputPath.startsWith('@')) inputPath = inputPath.slice(1);

  if ((inputPath.startsWith('"') && inputPath.endsWith('"')) ||
      (inputPath.startsWith("'") && inputPath.endsWith("'"))) {
    inputPath = inputPath.slice(1, -1);
  }

  return inputPath;
}

function resolveInputPath(rawPath, fallbackPath) {
  const inputPath = normalizeInputPath(rawPath);
  if (!inputPath) return fallbackPath;
  if (path.isAbsolute(inputPath)) return inputPath;

  const cwdPath = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(cwdPath)) return cwdPath;

  return path.resolve(PROJECT_ROOT, inputPath);
}

function resolveResultsPath() {
  const args = process.argv.slice(2);
  const envVars = loadEnvFile(ENV_PATH);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--results' && args[i + 1]) return resolveInputPath(args[i + 1], DEFAULT_RESULTS_FILE);
    if (args[i].startsWith('--results=')) return resolveInputPath(args[i].slice('--results='.length), DEFAULT_RESULTS_FILE);
  }

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--franchise' || arg === '--results') {
      i++;
      continue;
    }
    if (!arg.startsWith('--')) positional.push(arg);
  }

  if (positional.length > 0) return resolveInputPath(positional[0], DEFAULT_RESULTS_FILE);
  if (process.env.GAME_RESULTS_FILE) return resolveInputPath(process.env.GAME_RESULTS_FILE, DEFAULT_RESULTS_FILE);
  if (envVars.GAME_RESULTS_FILE) return resolveInputPath(envVars.GAME_RESULTS_FILE, DEFAULT_RESULTS_FILE);

  return DEFAULT_RESULTS_FILE;
}

// ---------------------------------------------------------------------------
// Build game-result lookup keyed by "GAME_TYPE:WEEK:HOME:AWAY"
// Also add a reverse key "GAME_TYPE:WEEK:AWAY:HOME" pointing to the same game
// so we can find games regardless of which way the schedule is listed.
// ---------------------------------------------------------------------------
function buildResultLookup(results) {
  const lookup = {};
  for (const g of results) {
    const key1 = `${g.game_type}:${g.week}:${g.home_team}:${g.away_team}`;
    const key2 = `${g.game_type}:${g.week}:${g.away_team}:${g.home_team}`;
    lookup[key1] = { ...g, homeIsRealHome: true  };
    lookup[key2] = { ...g, homeIsRealHome: false };
  }
  return lookup;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(60));
  console.log('Script 11 — Apply Game Results (ForceWin)');
  console.log('='.repeat(60));

  // ── Validate inputs ───────────────────────────────────────────────────────
  const franchisePath = resolveFranchisePath();
  const resultsPath   = resolveResultsPath();
  if (!franchisePath) {
    console.error('\n✗ No franchise file specified.');
    console.error('  Set FRANCHISE_FILE in .env or pass --franchise /path/to/file');
    process.exit(1);
  }
  if (!fs.existsSync(franchisePath)) {
    console.error(`\n✗ Franchise file not found: ${franchisePath}`);
    process.exit(1);
  }
  if (!fs.existsSync(resultsPath)) {
    console.error(`\n✗ Game results file not found: ${resultsPath}`);
    console.error('  Run script 10 first: python scripts/10_fetch_game_results.py');
    console.error('  Or pass an explicit file: node scripts\\11_apply_game_results.js data\\game_results_2025.json --franchise <file>');
    process.exit(1);
  }

  console.log(`\n  Franchise file  : ${franchisePath}`);
  console.log(`  Results file    : ${resultsPath}`);

  // ── Load real game results ────────────────────────────────────────────────
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  console.log(`  Game results    : ${results.length} completed games`);
  const lookup = buildResultLookup(results);

  // ── Open franchise and apply ──────────────────────────────────────────────
  await new Promise((resolve, reject) => {
    const franchise = new Franchise(franchisePath, { gameYearOverride: 26 });

    franchise.on('error', (err) => reject(new Error(`Franchise error: ${err?.message || err}`)));

    franchise.on('ready', async () => {
      try {
        const sgTable = franchise.getTableByName('SeasonGame');
        if (!sgTable) throw new Error('SeasonGame table not found in franchise file.');
        await sgTable.readRecords();

        let applied   = 0;
        let skipped   = 0;   // team TBD / row >= 32
        let notFound  = 0;   // no matching real result
        let alreadyOk = 0;   // ForceWin already set correctly
        const missed  = [];

        for (const record of sgTable.records) {
          if (record.isEmpty) continue;

          const weekTypeRaw = record.getFieldByKey('SeasonWeekType')?.value;
          const gameType    = WEEK_TYPE_TO_GAME_TYPE[weekTypeRaw];
          if (!gameType) continue;   // preseason ("0") — skip

          const seasonWeek = record.getFieldByKey('SeasonWeek')?.value;
          const homeRow    = record.getFieldByKey('HomeTeam')?.referenceData?.rowNumber;
          const awayRow    = record.getFieldByKey('AwayTeam')?.referenceData?.rowNumber;

          // Skip TBD/placeholder games (team rows >= 32 haven't been seeded yet)
          if (homeRow == null || awayRow == null || homeRow >= 32 || awayRow >= 32) {
            skipped++;
            continue;
          }

          const homeAbbr = TEAM_INDEX_TO_NFLVERSE[homeRow];
          const awayAbbr = TEAM_INDEX_TO_NFLVERSE[awayRow];
          if (!homeAbbr || !awayAbbr) { skipped++; continue; }

          // Compute the nflverse week for this game
          let nflWeek;
          if (gameType === 'REG') {
            nflWeek = regWeekToNfl(seasonWeek);
          } else {
            // Playoff week numbers in nflverse: WC=19, DIV=20, CON=21, SB=22
            const PLAYOFF_WEEK = { WC: 19, DIV: 20, CON: 21, SB: 22 };
            nflWeek = PLAYOFF_WEEK[gameType];
          }

          // Look up the real result
          const key  = `${gameType}:${nflWeek}:${homeAbbr}:${awayAbbr}`;
          const real = lookup[key];

          if (!real) {
            notFound++;
            missed.push({ gameType, nflWeek, homeAbbr, awayAbbr });
            continue;
          }

          // Determine which team won from the franchise's perspective
          // real.homeIsRealHome tells us if homeAbbr is also the real-world home team.
          let franchiseHomeWon;
          if (real.homeIsRealHome) {
            franchiseHomeWon = real.home_won;
          } else {
            // The real home/away was reversed; flip who won
            franchiseHomeWon = !real.home_won;
          }

          const desiredFW = franchiseHomeWon ? FORCE_WIN_HOME : FORCE_WIN_AWAY;
          const currentFW = record.getFieldByKey('ForceWin')?.value;

          if (currentFW === desiredFW) {
            alreadyOk++;
            continue;
          }

          record.getFieldByKey('ForceWin').value = desiredFW;
          applied++;
        }

        // ── Summary ───────────────────────────────────────────────────────
        console.log('\n' + '='.repeat(60));
        console.log('Summary');
        console.log('='.repeat(60));
        console.log(`  ForceWin updated : ${applied}`);
        console.log(`  Already correct  : ${alreadyOk}`);
        console.log(`  TBD/unknown team : ${skipped}  (playoff brackets not seeded yet)`);
        console.log(`  No result found  : ${notFound}`);

        if (missed.length > 0 && missed.length <= 20) {
          console.log('\n  Unmatched games:');
          for (const g of missed) {
            console.log(`    ${g.gameType} week ${g.nflWeek}: ${g.homeAbbr} vs ${g.awayAbbr}`);
          }
        }

        if (applied === 0 && alreadyOk > 0) {
          console.log('\n  All matched games already have correct ForceWin — no changes needed.');
          resolve();
          return;
        }

        if (applied === 0) {
          console.log('\n  No changes to save — franchise file unchanged.');
          resolve();
          return;
        }

        // ── Save ──────────────────────────────────────────────────────────
        console.log('\nSaving franchise file…');
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
