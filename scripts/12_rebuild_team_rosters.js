'use strict';

/**
 * Script 12 - Rebuild Team Roster Arrays
 *
 * Repairs Madden franchise saves after direct Player table edits.
 *
 * The Player table is the source of truth for who belongs to which team, but
 * Madden also stores per-team Player[] arrays on Team.Roster and
 * Team.PracticeSquad. If scripts move or rewrite Player records without
 * rebuilding those arrays, roster/cut screens can show the wrong player count
 * or the wrong players even though game-start validation sees the real roster.
 *
 * Run:
 *   node scripts/12_rebuild_team_rosters.js [--franchise /path/to/CAREER-FILE]
 *   node scripts/12_rebuild_team_rosters.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const Franchise = require('madden-franchise');
const utilService = require('madden-franchise/services/utilService');

const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.join(SCRIPT_DIR, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'franchise_backups');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');

const ZERO_REF = utilService.getBinaryReferenceData(0, 0);
const TEAM_INDEX_FREE_AGENT = 32;
const ACTIVE_CONTRACT_STATUSES = new Set([
  'Signed',
  'Expiring',
  'Extended',
  'Restructured',
]);
const PRACTICE_SQUAD_STATUS = 'PracticeSquad';

const POSITION_ORDER = [
  'QB',
  'HB',
  'FB',
  'WR',
  'TE',
  'LT',
  'LG',
  'C',
  'RG',
  'RT',
  'LE',
  'RE',
  'DT',
  'LOLB',
  'MLB',
  'ROLB',
  'CB',
  'FS',
  'SS',
  'K',
  'P',
  'LS',
];
const POSITION_RANK = new Map(POSITION_ORDER.map((pos, idx) => [pos, idx]));

function loadEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) return result;

  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) result[key] = val.replace(/\\\\/g, '\\');
  }

  return result;
}

function findFlag(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] || true;
  }
  return null;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function resolveFranchisePath() {
  const env = loadEnvFile(ENV_PATH);
  return findFlag('--franchise') ||
    process.env.FRANCHISE_FILE ||
    env.FRANCHISE_FILE ||
    null;
}

function safeGet(record, fieldName) {
  try {
    return record.getFieldByKey(fieldName)?.value;
  } catch (_) {
    return undefined;
  }
}

function playerName(record) {
  return `${safeGet(record, 'FirstName') || ''} ${safeGet(record, 'LastName') || ''}`.trim();
}

function playerSort(a, b) {
  const aPos = String(safeGet(a, 'Position') || '');
  const bPos = String(safeGet(b, 'Position') || '');
  const aRank = POSITION_RANK.has(aPos) ? POSITION_RANK.get(aPos) : 999;
  const bRank = POSITION_RANK.has(bPos) ? POSITION_RANK.get(bPos) : 999;
  if (aRank !== bRank) return aRank - bRank;

  const aOvr = Number(safeGet(a, 'OverallRating')) || 0;
  const bOvr = Number(safeGet(b, 'OverallRating')) || 0;
  if (aOvr !== bOvr) return bOvr - aOvr;

  return playerName(a).localeCompare(playerName(b)) || a.index - b.index;
}

function referenceForPlayer(playerTable, playerRecord) {
  return utilService.getBinaryReferenceData(playerTable.header.tableId, playerRecord.index);
}

async function getReferencedArray(franchise, binaryRef, label) {
  if (!binaryRef || binaryRef === ZERO_REF) {
    throw new Error(`${label} reference is empty.`);
  }

  const ref = utilService.getReferenceData(binaryRef);
  const table = franchise.getTableById(ref.tableId);
  if (!table) {
    throw new Error(`${label} table not found for ref ${binaryRef}.`);
  }
  await table.readRecords();

  const record = table.records[ref.rowNumber];
  if (!record) {
    throw new Error(`${label} row ${ref.rowNumber} not found in table ${table.name}.`);
  }
  if (!table.isArray) {
    throw new Error(`${label} points at non-array table ${table.name}.`);
  }

  return { table, record };
}

function countUsefulRefs(arrayRecord, playerTable, expectedTeamIndex, expectedStatus) {
  let useful = 0;
  const fields = arrayRecord.fieldsArray.slice(0, arrayRecord.arraySize || 0);
  for (const field of fields) {
    const ref = utilService.getReferenceData(field.value);
    if (ref.tableId !== playerTable.header.tableId) continue;
    const player = playerTable.records[ref.rowNumber];
    if (!player || player.isEmpty) continue;
    if (Number(safeGet(player, 'TeamIndex')) !== expectedTeamIndex) continue;
    if (expectedStatus && String(safeGet(player, 'ContractStatus')) !== expectedStatus) continue;
    if (!expectedStatus && !ACTIVE_CONTRACT_STATUSES.has(String(safeGet(player, 'ContractStatus')))) continue;
    useful++;
  }
  return useful;
}

function writeReferenceArray(arrayRecord, refs) {
  const capacity = arrayRecord.fieldsArray.length;
  const usableRefs = refs.slice(0, capacity);

  for (let i = 0; i < capacity; i++) {
    arrayRecord.fieldsArray[i].value = usableRefs[i] || ZERO_REF;
  }

  return {
    written: usableRefs.length,
    skipped: Math.max(0, refs.length - capacity),
    capacity,
  };
}

function makeBackup(franchisePath) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const backupPath = path.join(
    BACKUP_DIR,
    `${path.basename(franchisePath)}.bak-rostersync-${stamp}`
  );

  fs.copyFileSync(franchisePath, backupPath);
  return backupPath;
}

function openFranchise(franchisePath) {
  return new Promise((resolve, reject) => {
    const franchise = new Franchise(franchisePath, { gameYearOverride: 26 });
    franchise.on('error', (err) => reject(new Error(err?.message || String(err))));
    franchise.on('ready', () => resolve(franchise));
  });
}

async function main() {
  console.log('='.repeat(64));
  console.log('Script 12 - Rebuild Team Roster Arrays');
  console.log('='.repeat(64));

  const franchisePath = resolveFranchisePath();
  const dryRun = hasFlag('--dry-run');
  const noBackup = hasFlag('--no-backup');

  if (!franchisePath) {
    console.error('\nNo franchise file specified. Set FRANCHISE_FILE in .env or pass --franchise.');
    process.exit(1);
  }
  if (!fs.existsSync(franchisePath)) {
    console.error(`\nFranchise file not found: ${franchisePath}`);
    process.exit(1);
  }

  console.log(`\nFranchise file: ${franchisePath}`);
  if (dryRun) console.log('Mode          : dry run (no save)');

  const franchise = await openFranchise(franchisePath);
  const playerTable = franchise.getTableByName('Player');
  if (!playerTable) throw new Error('Player table not found.');
  await playerTable.readRecords([
    'FirstName',
    'LastName',
    'Position',
    'OverallRating',
    'TeamIndex',
    'ContractStatus',
  ]);

  const teamTable = franchise
    .getAllTablesByName('Team')
    .find((table) => table.header.recordCapacity > 1);
  if (!teamTable) throw new Error('Main Team table not found.');
  await teamTable.readRecords();

  const activeByTeam = new Map();
  const practiceByTeam = new Map();
  for (let i = 0; i < TEAM_INDEX_FREE_AGENT; i++) {
    activeByTeam.set(i, []);
    practiceByTeam.set(i, []);
  }

  for (const record of playerTable.records) {
    if (record.isEmpty) continue;

    const teamIndex = Number(safeGet(record, 'TeamIndex'));
    if (!Number.isInteger(teamIndex) || teamIndex < 0 || teamIndex >= TEAM_INDEX_FREE_AGENT) {
      continue;
    }

    const status = String(safeGet(record, 'ContractStatus') || '');
    if (status === PRACTICE_SQUAD_STATUS) {
      practiceByTeam.get(teamIndex).push(record);
    } else if (ACTIVE_CONTRACT_STATUSES.has(status)) {
      activeByTeam.get(teamIndex).push(record);
    }
  }

  const rows = [];
  let changedTeams = 0;
  let skippedRefs = 0;

  for (const teamRecord of teamTable.records) {
    if (teamRecord.isEmpty) continue;

    const teamIndex = Number(safeGet(teamRecord, 'TeamIndex'));
    if (!Number.isInteger(teamIndex) || teamIndex < 0 || teamIndex >= TEAM_INDEX_FREE_AGENT) {
      continue;
    }

    const activePlayers = activeByTeam.get(teamIndex).sort(playerSort);
    const practicePlayers = practiceByTeam.get(teamIndex).sort(playerSort);
    const activeRefs = activePlayers.map((player) => referenceForPlayer(playerTable, player));
    const practiceRefs = practicePlayers.map((player) => referenceForPlayer(playerTable, player));

    const rosterArray = await getReferencedArray(
      franchise,
      safeGet(teamRecord, 'Roster'),
      `Team ${teamIndex} Roster`
    );
    const practiceArray = await getReferencedArray(
      franchise,
      safeGet(teamRecord, 'PracticeSquad'),
      `Team ${teamIndex} PracticeSquad`
    );

    const beforeRosterSize = rosterArray.record.arraySize || 0;
    const beforePracticeSize = practiceArray.record.arraySize || 0;
    const beforeUsefulRoster = countUsefulRefs(rosterArray.record, playerTable, teamIndex, null);
    const beforeUsefulPractice = countUsefulRefs(
      practiceArray.record,
      playerTable,
      teamIndex,
      PRACTICE_SQUAD_STATUS
    );

    const rosterWrite = dryRun
      ? { written: Math.min(activeRefs.length, rosterArray.record.fieldsArray.length), skipped: Math.max(0, activeRefs.length - rosterArray.record.fieldsArray.length) }
      : writeReferenceArray(rosterArray.record, activeRefs);
    const practiceWrite = dryRun
      ? { written: Math.min(practiceRefs.length, practiceArray.record.fieldsArray.length), skipped: Math.max(0, practiceRefs.length - practiceArray.record.fieldsArray.length) }
      : writeReferenceArray(practiceArray.record, practiceRefs);

    skippedRefs += rosterWrite.skipped + practiceWrite.skipped;
    if (beforeRosterSize !== activePlayers.length ||
        beforePracticeSize !== practicePlayers.length ||
        beforeUsefulRoster !== activePlayers.length ||
        beforeUsefulPractice !== practicePlayers.length) {
      changedTeams++;
    }

    rows.push({
      team: teamIndex,
      name: safeGet(teamRecord, 'NickName') || safeGet(teamRecord, 'DisplayName') || '',
      rosterBefore: beforeRosterSize,
      validBefore: beforeUsefulRoster,
      rosterAfter: rosterWrite.written,
      psBefore: beforePracticeSize,
      psValidBefore: beforeUsefulPractice,
      psAfter: practiceWrite.written,
    });
  }

  console.table(rows.sort((a, b) => a.team - b.team));
  console.log(`\nTeams needing repair: ${changedTeams}`);
  if (skippedRefs > 0) {
    console.log(`WARNING: ${skippedRefs} player refs did not fit in their Player[] arrays.`);
  }

  if (dryRun) {
    console.log('\nDry run complete. No file was saved.');
    return;
  }

  let backupPath = null;
  if (!noBackup) {
    backupPath = makeBackup(franchisePath);
    console.log(`\nBackup created: ${backupPath}`);
  }

  await franchise.save(franchisePath);
  console.log('Saved rebuilt roster arrays.');
}

main().catch((err) => {
  console.error('\nFatal error:', err.message || err);
  process.exit(1);
});
