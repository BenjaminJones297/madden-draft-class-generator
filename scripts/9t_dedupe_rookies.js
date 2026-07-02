'use strict';

/**
 * Script 9t — Safe, repeatable rookie de-duplication.
 *
 * Madden regenerates the imported custom draft class as a duplicate YD=1
 * "next-year" cohort (same PLYR_ASSETNAME) and signs the copies to random
 * rosters. See docs: the YD=0 record is the real import, the YD=1 is the
 * regenerated shadow. This script removes the shadows without erasing anyone.
 *
 * Run it whenever the duplicates come back. It is idempotent: on a clean save
 * it removes nothing.
 *
 * What it does (in order):
 *   1. Any REAL player whose only live copy is YD=1 (no YD=0 twin) is converted
 *      to YD=0 — otherwise a blanket YD=1 purge would erase them.
 *   2. Every remaining YD=1 record is a duplicate/synthetic and is deleted.
 *   3. YD=0 records with a truncated name that duplicate a surviving full-name
 *      copy (Madden clips FirstName to the field width) are deleted.
 *   4. Everything else YD=0 is kept. Synthetic unique-name filler is kept unless
 *      --purge-filler is given.
 *
 * Removal is shift-compact (never null-in-place) across Team.Roster,
 * PracticeSquad and Franchise.FreeAgents, so arraySize never truncates.
 *
 * Usage:
 *   node scripts/9t_dedupe_rookies.js --franchise <path> [--dry-run]
 *     [--rookies <path>]   default: data/rookie_ratings_post_madden.json
 *     [--purge-filler]     also delete YD=0 unique-name synthetic filler
 *     [--no-backup]        skip the automatic <path>.before-dedup backup
 */

const fs          = require('fs');
const path        = require('path');
const Franchise   = require('madden-franchise');

const SCRIPT_DIR   = __dirname;
const PROJECT_ROOT = path.join(SCRIPT_DIR, '..');
const DATA_DIR     = path.join(PROJECT_ROOT, 'data');
const ENV_PATH     = path.join(PROJECT_ROOT, '.env');

const NULL_REFERENCE           = '0'.repeat(32);
const TEAM_INDEX_FREE_AGENT    = 32;
const CONTRACT_STATUS_DELETED  = 'Deleted';
const FRANCHISE_SINGLETON_TABLE = 4635;

function findFlag(name) { const a = process.argv.slice(2); const i = a.indexOf(name); return (i >= 0 && i < a.length - 1) ? a[i + 1] : null; }
function hasFlag(name) { return process.argv.slice(2).includes(name); }
function safeGet(rec, k) { try { const f = rec.getFieldByKey(k); return f ? f.value : undefined; } catch { return undefined; } }
function trySet(rec, k, v) { try { const f = rec.getFieldByKey(k); if (!f) return false; f.value = v; return true; } catch { return false; } }
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const r = {};
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) r[k] = v;
  }
  return r;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const pfx  = (a, b) => a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
// A prefix match on FirstName OR LastName (Madden truncates to the field width).
function truncMatch(nf, nl, pairs) {
  for (const p of pairs) {
    if (p.nl === nl && pfx(p.nf, nf)) return p;
    if (p.nf === nf && pfx(p.nl, nl)) return p;
  }
  return null;
}

function getPlayerSlot(rec, i) { try { return rec.getFieldByKey(`Player${i}`); } catch { return null; } }
function isPlayerRef(field, pid, row) { const r = field?.referenceData; return Boolean(field?.isReference && r && r.tableId === pid && r.rowNumber === row); }

// Shift-compact removal — see project note on the arraySize-shrink bug
// (FranchiseFileRecord.js:146-151). Snapshot tail, shift down, null only the
// trailing slot. Handles uncounted arrays (arraySize null) with a safe null.
function compactRemovePlayerFromRecord(rec, pid, row) {
  if (!rec || rec.isEmpty) return 0;
  const counted = rec.arraySize !== null && rec.arraySize !== undefined;
  if (!counted) {
    let removed = 0;
    for (let i = 0; i < 3600; i++) { const f = getPlayerSlot(rec, i); if (!f) break; if (isPlayerRef(f, pid, row)) { try { f.value = NULL_REFERENCE; removed++; } catch {} } }
    return removed;
  }
  let removed = 0;
  for (;;) {
    const size = Number(rec.arraySize ?? 0);
    let slot = -1;
    for (let i = 0; i < size; i++) { const f = getPlayerSlot(rec, i); if (!f) break; if (isPlayerRef(f, pid, row)) { slot = i; break; } }
    if (slot < 0) break;
    const tail = [];
    for (let i = slot + 1; i < size; i++) { const f = getPlayerSlot(rec, i); if (!f) break; tail.push(f.value); }
    for (let i = 0; i < tail.length; i++) { const dst = getPlayerSlot(rec, slot + i); if (!dst) break; dst.value = tail[i]; }
    const last = getPlayerSlot(rec, size - 1); if (last) last.value = NULL_REFERENCE;
    removed++;
  }
  return removed;
}

async function loadPopulated(fra, name, minLive = 30) {
  for (const t of fra.tables.filter(t => t.name === name)) {
    try { await t.readRecords(); } catch { continue; }
    if (t.records.filter(r => !r.isEmpty).length >= minLive) return t;
  }
  return null;
}

async function recalculateRosterSizes(playerTable, teamMain) {
  let touched = 0;
  for (const teamRec of teamMain.records) {
    if (teamRec.isEmpty) continue;
    const ti = Number(safeGet(teamRec, 'TeamIndex'));
    if (!Number.isFinite(ti) || ti < 0 || ti > 31) continue;
    let active = 0, salCap = 0, nextYear = 0;
    for (const pRec of playerTable.records) {
      if (pRec.isEmpty) continue;
      if (Number(safeGet(pRec, 'TeamIndex')) !== ti) continue;
      const cs = safeGet(pRec, 'ContractStatus');
      if (cs !== 'Signed' && cs !== 'Expiring') continue;
      salCap++;
      if (!safeGet(pRec, 'IsInjuredReserve')) active++;
      if (Number(safeGet(pRec, 'ContractLength')) > 1) nextYear++;
    }
    trySet(teamRec, 'ActiveRosterSize', active);
    trySet(teamRec, 'SalCapRosterSize', salCap);
    trySet(teamRec, 'SalCapNextYearRosterSize', nextYear);
    touched++;
  }
  return touched;
}

(async () => {
  console.log('='.repeat(64));
  console.log('Script 9t — Safe rookie de-duplication');
  console.log('='.repeat(64));

  const franchisePath = findFlag('--franchise') || process.env.FRANCHISE_FILE || loadEnvFile(ENV_PATH).FRANCHISE_FILE;
  const rookiesPath   = findFlag('--rookies') || path.join(DATA_DIR, 'rookie_ratings_post_madden.json');
  const isDryRun      = hasFlag('--dry-run');
  const purgeFiller   = hasFlag('--purge-filler');
  const noBackup      = hasFlag('--no-backup');
  if (!franchisePath || !fs.existsSync(franchisePath)) { console.error('--franchise <path> required'); process.exit(1); }
  if (!fs.existsSync(rookiesPath)) { console.error(`Rookies file not found: ${rookiesPath}`); process.exit(1); }
  console.log(`  Franchise : ${franchisePath}`);
  console.log(`  Rookies   : ${rookiesPath}`);
  console.log(`  Mode      : ${isDryRun ? 'DRY-RUN' : 'WRITE'}${purgeFiller ? ' + purge-filler' : ''}\n`);

  const rookies = JSON.parse(fs.readFileSync(rookiesPath, 'utf8'));
  const realNames = new Set();
  const refPairs = [];
  for (const r of rookies) {
    const fn = r.firstName || r.FirstName || (r.name || r.player_name || '').split(' ')[0];
    const ln = r.lastName  || r.LastName  || (r.name || r.player_name || '').split(' ').slice(1).join(' ');
    if (fn && ln) { realNames.add(norm(fn + ln)); refPairs.push({ nf: norm(fn), nl: norm(ln) }); }
  }

  const fra = await new Promise((res, rej) => {
    const f = new Franchise(franchisePath, { gameYearOverride: 26, autoUnempty: true });
    f.on('error', rej); f.on('ready', () => res(f));
  });

  const playerTable = fra.getTableByName('Player');
  await playerTable.readRecords();
  const pid = playerTable.header.tableId;

  // Roster + PracticeSquad maps (loadPopulated — getTableByName('Team') is an empty placeholder)
  const teamMain = await loadPopulated(fra, 'Team');
  if (!teamMain) { console.error('No populated Team table'); process.exit(1); }
  const tiToRosterRow = new Map();
  const tiToPsRow = new Map();
  let rosterTable = null, psTable = null;
  for (const rec of teamMain.records) {
    if (rec.isEmpty) continue;
    const ti = Number(safeGet(rec, 'TeamIndex'));
    const rr = rec.getFieldByKey('Roster');
    const ps = rec.getFieldByKey('PracticeSquad');
    if (Number.isFinite(ti) && rr?.isReference) { tiToRosterRow.set(ti, rr.referenceData.rowNumber); if (!rosterTable) rosterTable = fra.getTableById(rr.referenceData.tableId); }
    if (Number.isFinite(ti) && ps?.isReference) { tiToPsRow.set(ti, ps.referenceData.rowNumber); if (!psTable) psTable = fra.getTableById(ps.referenceData.tableId); }
  }
  if (rosterTable) await rosterTable.readRecords();
  if (psTable) await psTable.readRecords();

  // FreeAgents pool
  const fTbl = fra.getTableById(FRANCHISE_SINGLETON_TABLE); await fTbl.readRecords();
  const fRec = fTbl.records.find(r => !r.isEmpty);
  let faTbl = null, faRow = null;
  if (fRec) { const fa = fRec.getFieldByKey('FreeAgents'); if (fa?.isReference) { faTbl = fra.getTableById(fa.referenceData.tableId); faRow = fa.referenceData.rowNumber; if (faTbl) await faTbl.readRecords(); } }

  function removeFromAllArrays(row) {
    let n = 0;
    for (const r of tiToRosterRow.values()) n += compactRemovePlayerFromRecord(rosterTable && rosterTable.records[r], pid, row);
    if (psTable) for (const r of tiToPsRow.values()) n += compactRemovePlayerFromRecord(psTable.records[r], pid, row);
    if (faTbl && faRow != null) n += compactRemovePlayerFromRecord(faTbl.records[faRow], pid, row);
    return n;
  }

  // Snapshot live rookies (non-Deleted, YearsPro==0)
  const live = [];
  for (let i = 0; i < playerTable.records.length; i++) {
    const r = playerTable.records[i]; if (r.isEmpty) continue;
    if (safeGet(r, 'ContractStatus') === CONTRACT_STATUS_DELETED) continue;
    if (Number(safeGet(r, 'YearsPro')) !== 0) continue;
    const fn = safeGet(r, 'FirstName') || '', ln = safeGet(r, 'LastName') || '';
    live.push({ row: i, rec: r, nf: norm(fn), nl: norm(ln), key: norm(fn + ln), name: `${fn} ${ln}`.trim(),
      yd: Number(safeGet(r, 'YearDrafted')), cs: safeGet(r, 'ContractStatus'), ti: Number(safeGet(r, 'TeamIndex')), pos: safeGet(r, 'Position'), ovr: safeGet(r, 'OverallRating') });
  }
  const liveKeys = new Set(live.map(o => o.key));
  const yd0Keys = new Set(live.filter(o => o.yd === 0).map(o => o.key));
  const yd0Pairs = live.filter(o => o.yd === 0).map(o => ({ nf: o.nf, nl: o.nl }));

  // --- Step 1: convert sole-copy YD=1 real players to YD=0 ---
  const converted = [];
  for (const o of live) {
    if (o.yd !== 1) continue;
    const hasYd0Twin = yd0Keys.has(o.key) || truncMatch(o.nf, o.nl, yd0Pairs);
    const isReal = realNames.has(o.key) || truncMatch(o.nf, o.nl, refPairs);
    if (isReal && !hasYd0Twin) {
      o.yd = 0; trySet(o.rec, 'YearDrafted', 0);
      realNames.add(o.key); yd0Keys.add(o.key); yd0Pairs.push({ nf: o.nf, nl: o.nl });
      converted.push(o);
    }
  }
  // full-name originals that survive (used to spot truncated duplicates)
  const keptYd0Keys = new Set(live.filter(o => o.yd === 0 && realNames.has(o.key)).map(o => o.key));

  // --- Step 2/3: decide purge set ---
  const signedLike = new Set(['Signed', 'Expiring']);
  const activeLsByTeam = new Map();
  for (const o of live) if (o.pos === 'LS' && o.ti >= 0 && o.ti <= 31 && signedLike.has(o.cs)) activeLsByTeam.set(o.ti, (activeLsByTeam.get(o.ti) || 0) + 1);
  const pendingLs = new Map();
  const purge = [], syntheticSoleCopies = [], protectedLs = [];
  for (const o of live) {
    let reason = null;
    if (o.yd === 1) {
      reason = 'YD=1 duplicate';
    } else if (!realNames.has(o.key)) {
      const p = truncMatch(o.nf, o.nl, refPairs);
      if (p && keptYd0Keys.has(norm(p.nf + p.nl))) reason = 'truncated-name duplicate';
      else if (!p) { if (purgeFiller) reason = 'synthetic filler'; else continue; }
      else continue; // sole truncated copy — keep
    } else continue; // matched original — keep
    // last-team LS guard
    if (o.pos === 'LS' && o.ti >= 0 && o.ti <= 31 && signedLike.has(o.cs)) {
      const activeLs = activeLsByTeam.get(o.ti) || 0, pend = pendingLs.get(o.ti) || 0;
      if (activeLs - pend <= 1) { protectedLs.push(o); continue; }
      pendingLs.set(o.ti, pend + 1);
    }
    purge.push({ ...o, reason });
    if (o.yd === 1 && !realNames.has(o.key) && !truncMatch(o.nf, o.nl, refPairs)) syntheticSoleCopies.push(o);
  }

  console.log(`  Live rookies scanned          : ${live.length}`);
  console.log(`  Converted sole-copy YD=1→YD=0 : ${converted.length}`);
  converted.forEach(o => console.log(`      keep row ${String(o.row).padStart(4)}  ${o.name} (${o.pos})`));
  console.log(`  To delete                     : ${purge.length}`);
  const byReason = {}; purge.forEach(o => byReason[o.reason] = (byReason[o.reason] || 0) + 1);
  console.log(`      by reason: ${JSON.stringify(byReason)}`);
  if (protectedLs.length) console.log(`  Protected last-team LS        : ${protectedLs.length}`);
  if (syntheticSoleCopies.length) {
    console.log(`  NOTE: ${syntheticSoleCopies.length} deletions are YD=1 with no YD=0 twin and not in the rookie list`);
    console.log(`        (treated as Madden synthetic). Review — a real name here means the list is incomplete:`);
    syntheticSoleCopies.slice(0, 20).forEach(o => console.log(`          row ${String(o.row).padStart(4)}  ${o.name.padEnd(24)} ${o.pos}  ovr=${o.ovr}`));
    if (syntheticSoleCopies.length > 20) console.log(`          ... ${syntheticSoleCopies.length - 20} more`);
  }

  if (isDryRun) { console.log('\n(dry-run; no changes written)'); await verify(); return; }
  if (!purge.length && !converted.length) { console.log('\nNothing to do — already clean.'); return; }

  if (!noBackup) { const bak = franchisePath + '.before-dedup'; fs.copyFileSync(franchisePath, bak); console.log(`\n  Backup: ${bak}`); }

  let rosterRemoved = 0;
  for (const o of purge) {
    trySet(o.rec, 'TeamIndex', TEAM_INDEX_FREE_AGENT);
    trySet(o.rec, 'ContractStatus', CONTRACT_STATUS_DELETED);
    rosterRemoved += removeFromAllArrays(o.row);
  }
  const teamsRecalced = await recalculateRosterSizes(playerTable, teamMain);
  console.log(`  Deleted ${purge.length} records; removed ${rosterRemoved} array refs; recalced ${teamsRecalced} teams.`);

  await verify();
  console.log('\n  Saving…');
  await fra.save(franchisePath);
  console.log('  ✓ Saved.');

  // In-memory post-state check (matches what will be saved).
  async function verify() {
    const alive = [];
    for (let i = 0; i < playerTable.records.length; i++) {
      const r = playerTable.records[i]; if (r.isEmpty) continue;
      if (safeGet(r, 'ContractStatus') === CONTRACT_STATUS_DELETED) continue;
      if (Number(safeGet(r, 'YearsPro')) !== 0) continue;
      alive.push({ key: norm((safeGet(r, 'FirstName') || '') + (safeGet(r, 'LastName') || '')), yd: Number(safeGet(r, 'YearDrafted')), ti: Number(safeGet(r, 'TeamIndex')), cs: safeGet(r, 'ContractStatus') });
    }
    // NB: in dry-run the purge set is only predicted, so exclude it here.
    const purgeRows = new Set(purge.map(o => o.row));
    const survivors = alive.filter((_, idx) => true).filter(o => true);
    const kept = [];
    for (let i = 0, j = 0; i < playerTable.records.length; i++) {
      const r = playerTable.records[i]; if (r.isEmpty) continue;
      if (safeGet(r, 'ContractStatus') === CONTRACT_STATUS_DELETED) continue;
      if (Number(safeGet(r, 'YearsPro')) !== 0) continue;
      if (isDryRun && purgeRows.has(i)) continue;
      kept.push({ key: norm((safeGet(r, 'FirstName') || '') + (safeGet(r, 'LastName') || '')), yd: Number(safeGet(r, 'YearDrafted')), ti: Number(safeGet(r, 'TeamIndex')), cs: safeGet(r, 'ContractStatus') });
    }
    const m = new Map(); kept.forEach(o => m.set(o.key, (m.get(o.key) || 0) + 1));
    const dupGroups = [...m.values()].filter(v => v > 1).length;
    const yd1Signed = kept.filter(o => o.yd === 1 && o.ti >= 0 && o.ti <= 31 && signedLike.has(o.cs)).length;
    // array integrity
    let orphans = 0, dangling = 0;
    const deletedRows = new Set();
    for (let i = 0; i < playerTable.records.length; i++) { const r = playerTable.records[i]; if (!r.isEmpty && safeGet(r, 'ContractStatus') === CONTRACT_STATUS_DELETED) deletedRows.add(i); }
    if (isDryRun) purge.forEach(o => deletedRows.add(o.row));
    const auditRec = rec => {
      if (!rec || rec.isEmpty) return; const arr = rec.arraySize; const size = arr != null ? Number(arr) : 3600;
      for (let i = 0; i < (arr != null ? size + 80 : size); i++) { const f = getPlayerSlot(rec, i); if (!f) break; const rd = f.referenceData; if (f.isReference && rd && rd.tableId === pid && !(rd.tableId === 0 && rd.rowNumber === 0)) { if (arr != null && i >= size) orphans++; if (!isDryRun && deletedRows.has(rd.rowNumber)) dangling++; } }
    };
    for (const r of tiToRosterRow.values()) auditRec(rosterTable && rosterTable.records[r]);
    if (psTable) for (const r of tiToPsRow.values()) auditRec(psTable.records[r]);
    if (faTbl && faRow != null) auditRec(faTbl.records[faRow]);
    console.log(`\n  ${isDryRun ? 'Predicted' : 'Post'} state: kept ${kept.length} rookies | duplicate-name groups ${dupGroups} | YD=1 signed ${yd1Signed}`);
    console.log(`  Array integrity: roster/PS/FA orphans ${orphans}${isDryRun ? '' : `, dangling-to-Deleted ${dangling}`}`);
    if (dupGroups || yd1Signed || orphans || (!isDryRun && dangling)) console.log('  ** WARNING: expected all zeros — inspect before trusting **');
  }
})().catch(e => { console.error('\n✗ Fatal:', e.message || e); process.exit(1); });
