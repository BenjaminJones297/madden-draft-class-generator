'use strict';

/**
 * Script 9h — Generate Roster-Change Checklist (read-only)
 *
 * Diffs a Madden 26 franchise against `data/full_solution_2_ratings.json`
 * (which is itself a Madden export and is the source of truth for desired
 * team assignments). Outputs a markdown checklist grouped by action type
 * — trades, signings, releases — that the user can execute in Madden's UI
 * one by one. Doing it in-game lets Madden's engine handle all the
 * cap-math / depth-chart / negotiation / acquisition-eval bookkeeping
 * that 9g's overlay approach can't replicate without CTDing the sim.
 *
 * Usage:
 *   node scripts/9h_generate_roster_changes.js --franchise <path>
 *     [--ratings <path>]  default: data/full_solution_2_ratings.json
 *     [--out <path>]      default: output/roster_changes.md
 *     [--min-ovr <N>]     only include moves where the player's OverallRating
 *                         is >= N. Default 0 (all moves). Useful to start
 *                         with high-impact roster changes only (e.g. 85).
 *     [--include-unmatched] also list vets not in the ratings file
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

const SCRIPT_DIR    = __dirname;
const PROJECT_ROOT  = path.join(SCRIPT_DIR, '..');
const DATA_DIR      = path.join(PROJECT_ROOT, 'data');
const ENV_PATH      = path.join(PROJECT_ROOT, '.env');

const RATINGS_DEFAULT = path.join(DATA_DIR, 'full_solution_2_ratings.json');
const OUT_DEFAULT     = path.join(PROJECT_ROOT, 'output', 'roster_changes.md');

const TEAM_ABBR_BY_INDEX = [
  'CHI', 'CIN', 'BUF', 'DEN', 'CLE', 'TB',  'ARI', 'LAC',
  'KC',  'IND', 'DAL', 'MIA', 'PHI', 'ATL', 'SF',  'NYG',
  'JAX', 'NYJ', 'DET', 'GB',  'CAR', 'NE',  'LV',  'LA',
  'BAL', 'WAS', 'NO',  'SEA', 'PIT', 'TEN', 'MIN', 'HOU',
];
const FA_INDEX = 32;
const teamLabel = (idx) => idx === FA_INDEX ? 'FA' : (TEAM_ABBR_BY_INDEX[idx] ?? `?(${idx})`);

const INACTIVE_STATUS = new Set(['Deleted', 'Retired', 'None']);

function loadEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    result[line.slice(0, eq).trim()] = val;
  }
  return result;
}
function findFlag(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) if (args[i] === name) return args[i + 1];
  return null;
}
function hasFlag(name) { return process.argv.slice(2).includes(name); }

function openFranchise(filePath) {
  return new Promise((resolve, reject) => {
    const fra = new Franchise(filePath, { gameYearOverride: 26 });
    fra.on('error', err => reject(new Error(`Franchise error: ${err?.message || err}`)));
    fra.on('ready', () => resolve(fra));
  });
}

function safeGet(record, fieldName) {
  try {
    const f = record.getFieldByKey(fieldName);
    return f ? f.value : null;
  } catch (_) { return null; }
}

function norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function main() {
  const env = loadEnvFile(ENV_PATH);
  const franchisePath = findFlag('--franchise') || env.FRANCHISE_FILE;
  const ratingsPath   = findFlag('--ratings')   || RATINGS_DEFAULT;
  const outPath       = findFlag('--out')       || OUT_DEFAULT;
  const includeUnmatched = hasFlag('--include-unmatched');
  const minOvr = parseInt(findFlag('--min-ovr') || '0', 10) || 0;

  if (!franchisePath || !fs.existsSync(franchisePath)) {
    console.error('Pass --franchise <path> (or set FRANCHISE_FILE in .env).');
    process.exit(1);
  }
  if (!fs.existsSync(ratingsPath)) {
    console.error(`Ratings file not found: ${ratingsPath}`);
    process.exit(1);
  }

  console.log('='.repeat(64));
  console.log('Script 9h — Roster Change Checklist');
  console.log('='.repeat(64));
  console.log(`  Franchise : ${franchisePath}`);
  console.log(`  Ratings   : ${ratingsPath}`);
  console.log(`  Output    : ${outPath}`);

  const franchise   = await openFranchise(franchisePath);
  const playerTable = franchise.getTableByName('Player');
  await playerTable.readRecords();

  const ratings = JSON.parse(fs.readFileSync(ratingsPath, 'utf8'));
  // Index ratings by (firstName|lastName) — same matching the rating-update pass uses.
  const ratingByName = new Map();
  for (const e of ratings) {
    const fn = e.firstName ?? e.FirstName ?? '';
    const ln = e.lastName  ?? e.LastName  ?? '';
    if (!fn || !ln) continue;
    const k = `${norm(fn)}|${norm(ln)}`;
    if (!ratingByName.has(k)) ratingByName.set(k, e);
  }

  // Bucket: same / trade / sign-from-fa / release-to-fa / unmatched
  const trades   = [];   // { player, fromAbbr, toAbbr, position, ovr }
  const signings = [];   // FA → team
  const releases = [];   // team → FA
  const unmatched = [];

  for (const rec of playerTable.records) {
    if (rec.isEmpty) continue;
    const yd = safeGet(rec, 'YearDrafted');
    // Skip 2026 prospects (handled separately by 9g's rookie pass)
    const yp = safeGet(rec, 'YearsPro');
    if (yd === 1 && (yp === 0 || yp === '0')) continue;

    const fn = safeGet(rec, 'FirstName');
    const ln = safeGet(rec, 'LastName');
    const ps = safeGet(rec, 'Position');
    if (!fn || !ln) continue;

    const cs = safeGet(rec, 'ContractStatus');
    if (INACTIVE_STATUS.has(cs)) continue;

    const currentTeam = Number(safeGet(rec, 'TeamIndex'));
    const ovr = safeGet(rec, 'OverallRating');

    const ratingEntry = ratingByName.get(`${norm(fn)}|${norm(ln)}`);
    if (!ratingEntry) {
      if (includeUnmatched) unmatched.push({ name: `${fn} ${ln}`, position: ps, currentTeam, ovr });
      continue;
    }
    const targetTeam = Number(ratingEntry.TeamIndex);
    if (!Number.isFinite(targetTeam) || targetTeam < 0 || targetTeam > 32) continue;
    if (targetTeam === currentTeam) continue;

    const row = {
      name:        `${fn} ${ln}`,
      position:    ps,
      fromAbbr:    teamLabel(currentTeam),
      toAbbr:      teamLabel(targetTeam),
      ovr:         Number(ovr) || 0,
      sourceStatus: ratingEntry.ContractStatus || '',
    };
    if (row.ovr < minOvr) continue;
    if (currentTeam === FA_INDEX && targetTeam !== FA_INDEX) signings.push(row);
    else if (targetTeam === FA_INDEX && currentTeam !== FA_INDEX) releases.push(row);
    else trades.push(row);
  }

  // Sort each bucket by from-team then OVR desc (high-impact moves first)
  const sortByTeamThenOvr = (a, b) => {
    if (a.fromAbbr !== b.fromAbbr) return a.fromAbbr.localeCompare(b.fromAbbr);
    return b.ovr - a.ovr;
  };
  trades.sort(sortByTeamThenOvr);
  signings.sort((a, b) => b.ovr - a.ovr);
  releases.sort(sortByTeamThenOvr);

  // ── Markdown output ───────────────────────────────────────────────────────
  const lines = [];
  lines.push(`# Roster-Change Checklist`);
  lines.push('');
  lines.push(`Generated from \`${path.basename(franchisePath)}\` against \`${path.basename(ratingsPath)}\`.`);
  lines.push('Execute these adjustments in Madden\'s in-game UI so the engine handles cap math, depth-chart updates, and negotiation bookkeeping correctly. 2026 rookies are handled separately by 9g.');
  if (minOvr > 0) lines.push(`*Filtered to OVR >= ${minOvr}.*`);
  lines.push('');
  lines.push(`**Trades (team → team):** ${trades.length}`);
  lines.push(`**Sign from FA pool:** ${signings.length}`);
  lines.push(`**Release to FA pool:** ${releases.length}`);
  if (unmatched.length) lines.push(`**Unmatched (no entry in ratings):** ${unmatched.length}`);
  lines.push('');

  function table(rows, includeFrom = true, includeTo = true) {
    const header = ['', 'Player', 'Pos', 'OVR'];
    if (includeFrom) header.push('From');
    if (includeTo) header.push('To');
    lines.push('| ' + header.join(' | ') + ' |');
    lines.push('|' + header.map(() => '---').join('|') + '|');
    for (const r of rows) {
      const cols = ['☐', r.name, r.position, r.ovr];
      if (includeFrom) cols.push(r.fromAbbr);
      if (includeTo) cols.push(r.toAbbr);
      lines.push('| ' + cols.join(' | ') + ' |');
    }
  }

  if (trades.length) {
    lines.push('## Trades');
    lines.push('');
    table(trades, true, true);
    lines.push('');
  }
  if (signings.length) {
    lines.push('## Sign from FA');
    lines.push('');
    table(signings, false, true);
    lines.push('');
  }
  if (releases.length) {
    lines.push('## Release to FA');
    lines.push('');
    table(releases, true, false);
    lines.push('');
  }
  if (includeUnmatched && unmatched.length) {
    lines.push('## Unmatched (no entry in ratings file)');
    lines.push('');
    lines.push('| Player | Pos | Current team |');
    lines.push('|---|---|---|');
    for (const r of unmatched) lines.push(`| ${r.name} | ${r.position} | ${teamLabel(r.currentTeam)} |`);
    lines.push('');
  }

  // Ensure output dir exists and write
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));

  console.log('');
  console.log('='.repeat(64));
  console.log('Summary');
  console.log('='.repeat(64));
  console.log(`  Trades  (team → team) : ${trades.length}`);
  console.log(`  Sign    (FA → team)   : ${signings.length}`);
  console.log(`  Release (team → FA)   : ${releases.length}`);
  if (includeUnmatched) console.log(`  Unmatched             : ${unmatched.length}`);
  console.log('');
  console.log(`Wrote ${outPath}`);
}

main().catch(e => { console.error(e.stack || e.message || e); process.exit(1); });
