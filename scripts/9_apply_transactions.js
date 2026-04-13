'use strict';

/**
 * Script 9 — Apply Free-Agent Transactions
 *
 * Reads data/roster_players_rated.json (real 2025 NFL roster with team assignments)
 * and the Madden 26 franchise file.
 *
 * For every player who is a FREE AGENT in the franchise (TeamIndex = 32) but is
 * listed on an active 53-man roster in real life, this script:
 *   1. Sets their TeamIndex to the correct NFL team.
 *   2. Sets ContractStatus to Signed ("1").
 *   3. Sets a one-year minimum contract so the franchise doesn't complain.
 *
 * Players already on teams (TeamIndex 0-31) are left untouched.
 * Players with status != "ACT" in the real roster are left as free agents.
 *
 * Run:
 *   node scripts/9_apply_transactions.js [--franchise /path/to/CAREER-FRANCHISE]
 *   FRANCHISE_FILE=/path/to/CAREER-FRANCHISE node scripts/9_apply_transactions.js
 */

const fs      = require('fs');
const path    = require('path');
const Franchise = require('madden-franchise');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SCRIPT_DIR   = __dirname;
const PROJECT_ROOT = path.join(SCRIPT_DIR, '..');
const DATA_DIR     = path.join(PROJECT_ROOT, 'data');
const ENV_PATH     = path.join(PROJECT_ROOT, '.env');
const ROSTER_FILE  = path.join(DATA_DIR, 'roster_players_rated.json');

// ---------------------------------------------------------------------------
// nflverse abbreviation → Madden franchise TeamIndex (0-31)
// ---------------------------------------------------------------------------
const NFLVERSE_TO_TEAM_INDEX = {
  CHI: 0,  CIN: 1,  BUF: 2,  DEN: 3,  CLE: 4,  TB: 5,  ARI: 6,  LAC: 7,
  KC:  8,  IND: 9,  DAL: 10, MIA: 11, PHI: 12, ATL: 13, SF: 14, NYG: 15,
  JAX: 16, NYJ: 17, DET: 18, GB:  19, CAR: 20, NE:  21, LV: 22, LA:  23,
  BAL: 24, WAS: 25, NO:  26, SEA: 27, PIT: 28, TEN: 29, MIN: 30, HOU: 31,
};

// ContractStatus enum values (binary strings used by madden-franchise)
const CONTRACT_STATUS_SIGNED    = '1';    // Signed to a team
const TEAM_INDEX_FREE_AGENT     = 32;     // Free-agent / practice pool

// Minimum Madden base salary (in thousands of dollars)
const MIN_SALARY_K = 895;

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

// ---------------------------------------------------------------------------
// Resolve franchise file path: --franchise arg → env var → .env file
// ---------------------------------------------------------------------------
function resolveFranchisePath() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--franchise') return args[i + 1];
  }
  if (process.env.FRANCHISE_FILE) return process.env.FRANCHISE_FILE;
  const envVars = loadEnvFile(ENV_PATH);
  return envVars['FRANCHISE_FILE'] || null;
}

// ---------------------------------------------------------------------------
// Name normalisation for fuzzy matching
// ---------------------------------------------------------------------------
function norm(name) {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(60));
  console.log('Script 9 — Apply Free-Agent Transactions');
  console.log('='.repeat(60));

  // ── Resolve franchise path ────────────────────────────────────────────────
  const franchisePath = resolveFranchisePath();
  if (!franchisePath) {
    console.error('\n✗ No franchise file specified.');
    console.error('  Set FRANCHISE_FILE in .env or pass --franchise /path/to/file');
    process.exit(1);
  }
  if (!fs.existsSync(franchisePath)) {
    console.error(`\n✗ Franchise file not found: ${franchisePath}`);
    process.exit(1);
  }
  console.log(`\n  Franchise file : ${franchisePath}`);

  // ── Load real roster ──────────────────────────────────────────────────────
  if (!fs.existsSync(ROSTER_FILE)) {
    console.error(`\n✗ Roster file not found: ${ROSTER_FILE}`);
    console.error('  Run script 8 first: python scripts/8_generate_roster_ratings.py');
    process.exit(1);
  }
  const rosterPlayers = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
  console.log(`  Real roster    : ${rosterPlayers.length} players loaded`);

  // ── Build name lookup: normalised → player record ────────────────────────
  //    Only include ACT (active 53-man roster) players with a real team.
  const rosterLookup = {};
  let rosterActive = 0;
  for (const p of rosterPlayers) {
    if (p.status !== 'ACT') continue;
    if (!p.team || p.team === 'FA') continue;
    if (!(p.team in NFLVERSE_TO_TEAM_INDEX)) continue;

    const key = norm(p.playerName || `${p.firstName} ${p.lastName}`);
    if (key && !rosterLookup[key]) {
      rosterLookup[key] = p;
      rosterActive++;
    }
  }
  console.log(`  Active players : ${rosterActive} with known teams\n`);

  // ── Open franchise file ───────────────────────────────────────────────────
  await new Promise((resolve, reject) => {
    const franchise = new Franchise(franchisePath, { gameYearOverride: 26 });

    franchise.on('error', (err) => reject(new Error(`Franchise error: ${err?.message || err}`)));

    franchise.on('ready', async () => {
      try {
        const playerTable = franchise.getTableByName('Player');
        if (!playerTable) throw new Error('Player table not found in franchise file.');

        await playerTable.readRecords();
        console.log(`  Player records : ${playerTable.records.length} total`);

        // ── Process each free-agent record ───────────────────────────────────
        let moved     = 0;
        let skipped   = 0;
        let notFound  = 0;
        const log     = [];

        for (const record of playerTable.records) {
          if (record.isEmpty) continue;

          const teamIndex = record.getFieldByKey('TeamIndex')?.value;
          if (teamIndex !== TEAM_INDEX_FREE_AGENT) continue;   // Only free agents

          const firstName = record.getFieldByKey('FirstName')?.value || '';
          const lastName  = record.getFieldByKey('LastName')?.value  || '';
          const fullName  = `${firstName} ${lastName}`.trim();
          const key       = norm(fullName);
          if (!key) { skipped++; continue; }

          const real = rosterLookup[key];
          if (!real) { notFound++; continue; }

          const newTeamIndex = NFLVERSE_TO_TEAM_INDEX[real.team];

          // ── Update fields ─────────────────────────────────────────────────
          record.getFieldByKey('TeamIndex').value       = newTeamIndex;
          record.getFieldByKey('ContractStatus').value  = CONTRACT_STATUS_SIGNED;

          // Set a minimal 1-year contract so the franchise is valid.
          // ContractYear = 0 means "currently in year 0 of the deal".
          const contractLen = Math.max(1, real.contractLength || 1);
          const salaryK     = real.contractSalary
            ? Math.max(895, Math.round(real.contractSalary / 1000))
            : MIN_SALARY_K;
          const bonusK      = real.contractBonus && contractLen > 0
            ? Math.round(real.contractBonus / contractLen / 1000)
            : 0;

          record.getFieldByKey('ContractLength').value  = contractLen;
          record.getFieldByKey('ContractYear').value    = 0;
          record.getFieldByKey('ContractSalary0').value = salaryK;
          record.getFieldByKey('ContractBonus0').value  = bonusK;
          record.getFieldByKey('PLYR_CAPSALARY').value  = salaryK + bonusK;

          moved++;
          log.push(`  ✓  ${fullName.padEnd(26)} → ${real.team.padEnd(4)} (idx ${newTeamIndex})`);
        }

        // ── Print transaction log ─────────────────────────────────────────
        console.log(`\n  Players moved  : ${moved}`);
        console.log(`  Not in roster  : ${notFound} (stayed as FA)`);
        console.log(`  Skipped (empty): ${skipped}`);

        if (log.length > 0) {
          console.log('\nTransactions:');
          log.forEach(l => console.log(l));
        }

        if (moved === 0) {
          console.log('\n  No changes to save — franchise file unchanged.');
          resolve();
          return;
        }

        // ── Save franchise file ───────────────────────────────────────────
        console.log(`\nSaving franchise file…`);
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
