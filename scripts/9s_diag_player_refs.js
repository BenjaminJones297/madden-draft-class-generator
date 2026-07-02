'use strict';

/**
 * Diagnostic — find every reference to a specific Player record.
 *
 * Walks every populated table in the franchise, scans every reference field
 * on every live record, and reports refs that point at the target Player
 * row. Groups by source-table name. Used to find stale refs left behind by
 * a force-trade (Marketed*, ActiveAbilities*, training lists, stat records,
 * etc. on the OLD team that didn't get cleaned up).
 *
 * Read-only.
 *
 * Usage:
 *   node scripts/9s_diag_player_refs.js --franchise <path> \
 *     --name "Russell Wilson" --team CIN --pos QB
 *
 * Also prints PrevTeamIndex so we know which team's arrays to suspect.
 */

const fs = require('fs');
const path = require('path');
const Franchise = require('madden-franchise');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

const TEAM_INDEX = {
  CHI: 0, CIN: 1, BUF: 2, DEN: 3, CLE: 4, TB: 5, ARI: 6, LAC: 7,
  KC: 8, IND: 9, DAL: 10, MIA: 11, PHI: 12, ATL: 13, SF: 14, NYG: 15,
  JAX: 16, NYJ: 17, DET: 18, GB: 19, CAR: 20, NE: 21, LV: 22, LA: 23,
  BAL: 24, WAS: 25, NO: 26, SEA: 27, PIT: 28, TEN: 29, MIN: 30, HOU: 31,
};
const TEAM_ABBR = Object.fromEntries(Object.entries(TEAM_INDEX).map(([a, i]) => [i, a]));

function findFlag(name, def = null) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : def;
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const result = {};
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key) result[key] = val;
  }
  return result;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function safeGet(rec, key) {
  try {
    const f = rec.getFieldByKey(key);
    return f ? f.value : undefined;
  } catch {
    return undefined;
  }
}

function playerName(rec) {
  return `${safeGet(rec, 'FirstName') || ''} ${safeGet(rec, 'LastName') || ''}`.trim();
}

(async () => {
  const env = loadEnvFile(ENV_PATH);
  const franchisePath = findFlag('--franchise') || process.env.FRANCHISE_FILE || env.FRANCHISE_FILE;
  const name = findFlag('--name');
  const teamAbbr = String(findFlag('--team', '')).toUpperCase();
  const pos = String(findFlag('--pos', '')).toUpperCase();

  if (!franchisePath || !fs.existsSync(franchisePath)) {
    throw new Error('--franchise <path> required (or set FRANCHISE_FILE in .env)');
  }
  if (!name || !teamAbbr || !pos) {
    throw new Error('--name, --team, and --pos are required.');
  }
  const teamIndex = TEAM_INDEX[teamAbbr];
  if (teamIndex === undefined) throw new Error(`Unknown team: ${teamAbbr}`);

  const franchise = await new Promise((resolve, reject) => {
    const f = new Franchise(franchisePath, { gameYearOverride: 26 });
    f.on('error', reject);
    f.on('ready', () => resolve(f));
  });

  const playerTable = franchise.getTableByName('Player');
  await playerTable.readRecords();
  const playerTableId = playerTable.header.tableId;

  // Locate the player.
  let playerRow = -1;
  for (let i = 0; i < playerTable.records.length; i++) {
    const rec = playerTable.records[i];
    if (rec.isEmpty) continue;
    if (norm(playerName(rec)) !== norm(name)) continue;
    if (String(safeGet(rec, 'Position') || '').toUpperCase() !== pos) continue;
    if (Number(safeGet(rec, 'TeamIndex')) !== teamIndex) continue;
    playerRow = i;
    break;
  }
  if (playerRow < 0) {
    throw new Error(`No matching player: ${name} / ${teamAbbr} / ${pos}`);
  }

  const rec = playerTable.records[playerRow];
  const curTi = Number(safeGet(rec, 'TeamIndex'));
  const prevTi = Number(safeGet(rec, 'PrevTeamIndex'));
  const cs = safeGet(rec, 'ContractStatus');

  console.log('='.repeat(64));
  console.log('9s — Diagnostic: refs to player');
  console.log('='.repeat(64));
  console.log(`  Player        : ${name} / ${pos}`);
  console.log(`  Player row    : ${playerRow}  (Player tableId=${playerTableId})`);
  console.log(`  TeamIndex     : ${curTi} (${TEAM_ABBR[curTi] || '?'})`);
  console.log(`  PrevTeamIndex : ${prevTi} (${TEAM_ABBR[prevTi] || '?'})`);
  console.log(`  ContractStatus: ${cs}`);
  console.log('');
  console.log('Scanning all populated tables…\n');

  let scannedTables = 0, errored = 0, totalHits = 0;
  // hitsByTable: key = sourceTableId, value = { name, fields: [{ recIdx, fieldKey }] }
  const hitsByTable = new Map();

  for (const t of franchise.tables) {
    try { await t.readRecords(); } catch { errored++; continue; }
    scannedTables++;
    for (let recIdx = 0; recIdx < t.records.length; recIdx++) {
      const r = t.records[recIdx];
      if (r.isEmpty) continue;
      // Use fieldsArray to walk every field on the record.
      for (const f of r.fieldsArray) {
        if (!f.isReference) continue;
        const ref = f.referenceData;
        if (!ref) continue;
        if (ref.tableId !== playerTableId || ref.rowNumber !== playerRow) continue;
        totalHits++;
        const key = t.header.tableId;
        if (!hitsByTable.has(key)) {
          hitsByTable.set(key, { name: t.name, fields: [] });
        }
        hitsByTable.get(key).fields.push({ recIdx, fieldKey: f.key });
      }
    }
  }

  console.log(`Scanned ${scannedTables} tables (${errored} read errors).`);
  console.log(`Found ${totalHits} reference(s) to ${name} (Player row ${playerRow}).\n`);

  // Sort by table name for readability.
  const sortedKeys = [...hitsByTable.keys()].sort((a, b) => {
    const na = hitsByTable.get(a).name || '';
    const nb = hitsByTable.get(b).name || '';
    return na.localeCompare(nb);
  });
  for (const k of sortedKeys) {
    const info = hitsByTable.get(k);
    console.log(`  tableId=${k} '${info.name}': ${info.fields.length} ref(s)`);
    for (const f of info.fields.slice(0, 15)) {
      console.log(`    rec ${f.recIdx} field ${f.fieldKey}`);
    }
    if (info.fields.length > 15) {
      console.log(`    ... and ${info.fields.length - 15} more`);
    }
  }

  console.log('\nInterpretation hints:');
  console.log(`  - Refs from a 'Roster' table at rec=<row for ${TEAM_ABBR[curTi]}> are expected (player IS on this team).`);
  console.log(`  - Refs from any sub-table that maps back to ${TEAM_ABBR[prevTi]} are STALE and should be cleaned.`);
  console.log(`  - Player[]-shaped sub-tables likely affecting stats screens: MarketedPlayers, OffenseActiveAbilitiesPlayers, DefenseActiveAbilitiesPlayers, DrillCompletedList, FocusTrainingList, MiniGameCompletedList, PracticeSquad.`);
  console.log(`  - Stat record tables: PlayerStatRecords, anything named *StatRecords* or *Stats*.`);
})().catch(err => {
  console.error('\nFatal:', err.message || err);
  process.exit(1);
});
