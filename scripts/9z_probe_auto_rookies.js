'use strict';

// Find auto-generated rookies / UDFAs in a franchise. Madden's draft engine
// pre-fills the prospect pool with synthetic players (fake names, generic
// portraits) before each draft. Common identifiers:
//   - YearDrafted == 1, YearsPro == 0 (the synthetic 2026 draft class)
//   - YearDrafted == 0, YearsPro == 0 with generic names (auto-UDFA pool)

const Franchise = require('madden-franchise');

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}
function safeGet(rec, k) { try { const f = rec.getFieldByKey(k); return f ? f.value : undefined; } catch { return undefined; } }

(async () => {
  const fp = findFlag('--franchise');
  const fra = await new Promise((res, rej) => {
    const f = new Franchise(fp, { gameYearOverride: 26 });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });

  const pt = fra.getTableByName('Player');
  await pt.readRecords();

  console.log(`Player table: ${pt.records.length} records, ${pt.records.filter(r=>!r.isEmpty).length} live\n`);

  // Bucket by (YearDrafted, YearsPro)
  const buckets = new Map();
  for (let i = 0; i < pt.records.length; i++) {
    const r = pt.records[i];
    if (r.isEmpty) continue;
    const yd = String(safeGet(r, 'YearDrafted') ?? '?');
    const yp = String(safeGet(r, 'YearsPro') ?? '?');
    const k = `YD=${yd},YP=${yp}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push({ row: i, rec: r });
  }

  console.log('Player records by (YearDrafted, YearsPro):');
  const sorted = [...buckets.entries()].sort((a,b)=>b[1].length-a[1].length);
  for (const [k, list] of sorted.slice(0, 12)) {
    console.log(`  ${k}: ${list.length}`);
  }

  // For YD=0,YP=0 (current-year rookies — our injects + any auto-UDFAs),
  // sample to see if any have generic / blank / nonsense names
  console.log('\nSample of YD=0, YP=0 records (first 10 by team):');
  const yd0yp0 = buckets.get('YD=0,YP=0') || [];
  console.log(`Total YD=0, YP=0: ${yd0yp0.length}`);
  for (const { row, rec } of yd0yp0.slice(0, 12)) {
    const fn = safeGet(rec, 'FirstName') || '';
    const ln = safeGet(rec, 'LastName') || '';
    const ti = safeGet(rec, 'TeamIndex');
    const cs = safeGet(rec, 'ContractStatus');
    const pos = safeGet(rec, 'Position');
    const dr = safeGet(rec, 'PLYR_DRAFTROUND');
    const dp = safeGet(rec, 'PLYR_DRAFTPICK');
    const ovr = safeGet(rec, 'OverallRating');
    const college = safeGet(rec, 'College');
    console.log(`  row ${String(row).padStart(4)}  TI=${String(ti).padStart(2)}  ${pos.padEnd(4)}  OVR=${ovr}  R${dr}P${dp}  ${(fn+' '+ln).padEnd(28)}  ${cs.padEnd(10)}  ${college}`);
  }

  // Look for the user's injected rookies — they should have draftRound 1-7,
  // real names from data/rookie_ratings_post_madden.json. Auto-UDFAs typically
  // have draftRound=0 and ContractStatus=FreeAgent.
  console.log('\nYD=0, YP=0 records by ContractStatus:');
  const csCounts = new Map();
  for (const { rec } of yd0yp0) {
    const cs = safeGet(rec, 'ContractStatus') || '?';
    csCounts.set(cs, (csCounts.get(cs) || 0) + 1);
  }
  for (const [cs, n] of [...csCounts.entries()].sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${cs}: ${n}`);
  }

  // Also check YD=1,YP=0 (the auto-prospect pool)
  console.log('\nYD=1, YP=0 records by ContractStatus + sample names:');
  const yd1yp0 = buckets.get('YD=1,YP=0') || [];
  console.log(`Total YD=1, YP=0: ${yd1yp0.length}`);
  for (const { row, rec } of yd1yp0.slice(0, 8)) {
    const fn = safeGet(rec, 'FirstName') || '';
    const ln = safeGet(rec, 'LastName') || '';
    const ti = safeGet(rec, 'TeamIndex');
    const cs = safeGet(rec, 'ContractStatus');
    const pos = safeGet(rec, 'Position');
    const college = safeGet(rec, 'College');
    console.log(`  row ${String(row).padStart(4)}  TI=${String(ti).padStart(2)}  ${pos.padEnd(4)}  ${(fn+' '+ln).padEnd(28)}  ${cs.padEnd(10)}  ${college}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
