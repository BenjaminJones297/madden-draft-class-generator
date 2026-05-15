'use strict';

// Diagnostic: dump per-team SalCapCapRoom + sum of active player PLYR_CAPSALARY
// + sum of (ContractSalary0 + ContractBonus0). Helps reveal unit mismatches
// when cap math goes wrong.
//
// Usage:
//   node scripts/9z_dump_team_cap.js --franchise <path>

const path      = require('path');
const Franchise = require('madden-franchise');

const TEAM_NAMES = {
  0:'CHI', 1:'CIN', 2:'BUF', 3:'DEN', 4:'CLE', 5:'TB', 6:'ARI', 7:'LAC',
  8:'KC', 9:'IND', 10:'DAL', 11:'MIA', 12:'PHI', 13:'ATL', 14:'SF', 15:'NYG',
  16:'JAX', 17:'NYJ', 18:'DET', 19:'GB', 20:'CAR', 21:'NE', 22:'LV', 23:'LA',
  24:'BAL', 25:'WAS', 26:'NO', 27:'SEA', 28:'PIT', 29:'TEN', 30:'MIN', 31:'HOU',
};

const INACTIVE = new Set(['Deleted', 'Retired', 'None']);

function safeGet(rec, fields) {
  const list = Array.isArray(fields) ? fields : [fields];
  for (const name of list) {
    try {
      const f = rec.getFieldByKey(name);
      if (f && f.value !== undefined) return f.value;
    } catch (_) {}
  }
  return undefined;
}

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}

(async () => {
  const fp = findFlag('--franchise');
  if (!fp) { console.error('--franchise required'); process.exit(1); }

  const fra = await new Promise((res, rej) => {
    const f = new Franchise(fp, { gameYearOverride: 26 });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });

  const playerTable = fra.getTableByName('Player');
  await playerTable.readRecords();

  // Find the populated Team table (skip stub).
  const teamCandidates = fra.tables.filter(t => t.name === 'Team');
  let teamMain = null;
  for (const t of teamCandidates) {
    try { await t.readRecords(); } catch (_) { continue; }
    if (t.records.filter(r => !r.isEmpty).length >= 30) { teamMain = t; break; }
  }
  if (!teamMain) { console.error('Team table not found'); process.exit(1); }

  // Sum per-team
  const sums = new Map();   // ti → { count, capSal, contractSalBon }
  for (const rec of playerTable.records) {
    if (rec.isEmpty) continue;
    const cs = safeGet(rec, 'ContractStatus');
    if (INACTIVE.has(cs)) continue;
    const ti = Number(safeGet(rec, 'TeamIndex'));
    if (!Number.isFinite(ti) || ti < 0 || ti > 31) continue;
    const cur = sums.get(ti) || { count: 0, capSal: 0, contractSalBon: 0 };
    cur.count++;
    cur.capSal         += Number(safeGet(rec, 'PLYR_CAPSALARY')) || 0;
    cur.contractSalBon += (Number(safeGet(rec, 'ContractSalary0')) || 0) +
                         (Number(safeGet(rec, 'ContractBonus0'))  || 0);
    sums.set(ti, cur);
  }

  // Pull stored SalCapCapRoom per Team record
  console.log('TEAM  N    sum(PLYR_CAPSALARY)  sum(Sal0+Bon0)  stored_CapRoom');
  console.log('---- ---  -------------------- ---------------- ----------------');
  for (const rec of teamMain.records) {
    if (rec.isEmpty) continue;
    const ti = Number(safeGet(rec, 'TeamIndex'));
    if (!Number.isFinite(ti) || ti < 0 || ti > 31) continue;
    const s = sums.get(ti) || { count: 0, capSal: 0, contractSalBon: 0 };
    const cr = Number(safeGet(rec, 'SalCapCapRoom'));
    const tn = TEAM_NAMES[ti] || String(ti);
    console.log(
      `${tn.padEnd(4)} ${String(s.count).padStart(3)}  ` +
      `${String(s.capSal).padStart(20)} ${String(s.contractSalBon).padStart(16)} ` +
      `${String(cr).padStart(16)}`
    );
  }

  // Show one sample player from SEA with all three numbers
  console.log('\nSample SEA active player records (first 5):');
  let n = 0;
  for (const rec of playerTable.records) {
    if (rec.isEmpty) continue;
    if (Number(safeGet(rec, 'TeamIndex')) !== 27) continue;
    const cs = safeGet(rec, 'ContractStatus');
    if (INACTIVE.has(cs)) continue;
    const fn = safeGet(rec, 'FirstName') || '';
    const ln = safeGet(rec, 'LastName') || '';
    const cap = safeGet(rec, 'PLYR_CAPSALARY');
    const sal = safeGet(rec, 'ContractSalary0');
    const bon = safeGet(rec, 'ContractBonus0');
    const cy  = safeGet(rec, 'ContractYear');
    const cl  = safeGet(rec, 'ContractLength');
    console.log(`  ${(fn + ' ' + ln).padEnd(28)}  PLYR_CAPSALARY=${cap}  Sal0=${sal}  Bon0=${bon}  CY=${cy}/${cl}`);
    if (++n >= 5) break;
  }
})().catch(e => { console.error(e); process.exit(1); });
