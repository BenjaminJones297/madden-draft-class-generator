'use strict';

/**
 * Diagnostic: per-team roster counts via two paths:
 *   (A) Player.TeamIndex filter   — what 9g/9d update
 *   (B) Team.Roster array length  — what Madden's UI reads
 *
 * If A and B disagree, that's the gap that's hiding rookies + re-teamed vets.
 *
 * Read-only. Run on two franchises and diff manually.
 *
 * Run: node scripts/9z_diagnose_rosters.js --franchise <path>
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

const ENV_PATH = path.join(__dirname, '..', '.env');

function loadEnv(p) {
  const r = {}; if (!fs.existsSync(p)) return r;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    r[t.slice(0, i).trim()] = v;
  }
  return r;
}
function flag(n)  { const a = process.argv.slice(2); for (let i = 0; i < a.length - 1; i++) if (a[i] === n) return a[i + 1]; return null; }

const TEAM_NAMES = [
  'CHI','CIN','BUF','DEN','CLE','TB','ARI','LAC',
  'KC','IND','DAL','MIA','PHI','ATL','SF','NYG',
  'JAX','NYJ','DET','GB','CAR','NE','LV','LA',
  'BAL','WAS','NO','SEA','PIT','TEN','MIN','HOU',
];

function open(p) {
  return new Promise((res, rej) => {
    const f = new Franchise(p, { gameYearOverride: 26 });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });
}

async function main() {
  const env = loadEnv(ENV_PATH);
  const franchisePath = flag('--franchise') || env.FRANCHISE_FILE;
  if (!franchisePath || !fs.existsSync(franchisePath)) {
    console.error('Pass --franchise <path>');
    process.exit(1);
  }
  console.log(`\nFranchise: ${franchisePath}\n`);

  const franchise = await open(franchisePath);

  // (A) Player.TeamIndex filter
  const player = franchise.getTableByName('Player');
  await player.readRecords();
  const playerTableId = player.header.tableId;

  const byTeamIndex = new Array(33).fill(0);
  let signedCount = 0, otherStatusCount = 0, emptyCount = 0;
  const statusBreakdown = {};
  for (const rec of player.records) {
    if (rec.isEmpty) { emptyCount++; continue; }
    const ti = rec.getFieldByKey('TeamIndex')?.value;
    if (typeof ti === 'number' && ti >= 0 && ti <= 32) byTeamIndex[ti]++;
    const cs = rec.getFieldByKey('ContractStatus')?.value;
    statusBreakdown[cs] = (statusBreakdown[cs] || 0) + 1;
    if (cs === 'Signed') signedCount++; else otherStatusCount++;
  }

  // (B) Team.Roster array — find Team table, walk each row's Roster ref
  const team = franchise.getTableByName('Team');
  await team.readRecords();

  console.log(`Player table : ${player.records.length} records, ${emptyCount} empty`);
  console.log(`Team table   : ${team.records.length} records (first 32 are NFL teams)\n`);

  console.log(`Status breakdown across non-empty Player rows:`);
  for (const [k, v] of Object.entries(statusBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(k).padEnd(24)} ${v}`);
  }
  console.log();

  // For each NFL team, dereference Team.Roster and count non-null Player entries
  const rosterStats = []; // { idx, name, rosterArrayLen, nonNullPlayers, byTeamIndexFilter }
  for (let teamIdx = 0; teamIdx < 32; teamIdx++) {
    const teamRec = team.records[teamIdx];
    if (!teamRec || teamRec.isEmpty) {
      rosterStats.push({ idx: teamIdx, name: TEAM_NAMES[teamIdx], rosterArrayLen: 0, nonNullPlayers: 0, byTeamIndexFilter: byTeamIndex[teamIdx] });
      continue;
    }
    const rosterField = teamRec.getFieldByKey('Roster');
    let arrayLen = 0, nonNull = 0;
    if (rosterField && rosterField.isReference) {
      // Roster is a reference to a Player[] table
      const ref = rosterField.referenceData;
      if (ref && ref.tableId !== 0) {
        const rosterTable = franchise.getTableById(ref.tableId);
        if (rosterTable) {
          try { await rosterTable.readRecords(); } catch (_) {}
          // The Player[] sub-table — each record represents one slot
          // Each record has a Player ref field (or is itself a single-field record)
          for (const slot of rosterTable.records) {
            arrayLen++;
            if (slot.isEmpty) continue;
            // Look at the slot's reference to a Player row
            for (const f of (slot.fieldsArray || [])) {
              if (!f.isReference) continue;
              const r = f.referenceData;
              if (!r) continue;
              if (r.tableId === playerTableId && r.rowNumber !== 0) {
                // Check that target Player row is non-empty
                const playerRow = player.records[r.rowNumber];
                if (playerRow && !playerRow.isEmpty) {
                  nonNull++;
                }
              }
              break; // first ref field only
            }
          }
        }
      }
    }
    rosterStats.push({ idx: teamIdx, name: TEAM_NAMES[teamIdx], rosterArrayLen: arrayLen, nonNullPlayers: nonNull, byTeamIndexFilter: byTeamIndex[teamIdx] });
  }

  // Print comparison table
  console.log('Per-team comparison:');
  console.log(`  idx team   array_len   non_null_in_array   players_with_TeamIndex==idx`);
  for (const s of rosterStats) {
    console.log(`  ${String(s.idx).padStart(3)} ${s.name.padEnd(5)}  ${String(s.rosterArrayLen).padStart(4)}        ${String(s.nonNullPlayers).padStart(4)}                ${String(s.byTeamIndexFilter).padStart(4)}`);
  }
  console.log(`\n  FA (TeamIndex=32): ${byTeamIndex[32]}`);
  console.log();
}

main().catch(e => { console.error(e.stack || e.message || e); process.exit(1); });
