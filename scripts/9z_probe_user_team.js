'use strict';

// Probe: find every field across every table that looks like "controlled team"
// state — UserPlayer, IsUserControlled, IsOwner, OwnedTeams, ControlSettings,
// UserTeamIndex, etc. We compare CAREER-UPDATED-ROSTER (Cards-controlled) to
// any other franchise to see which field values differ for the controlled team.
//
// Usage:
//   node scripts/9z_probe_user_team.js --franchise <path>

const path      = require('path');
const Franchise = require('madden-franchise');

const NEEDLES = /(?:user|owner|control|commissioner|isuser|isowner|iscommissioner|owned|usercontrol)/i;

function findFlag(name) {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return (i >= 0 && i < args.length - 1) ? args[i + 1] : null;
}

function safeGet(rec, key) {
  try {
    const f = rec.getFieldByKey(key);
    return f ? f.value : undefined;
  } catch { return undefined; }
}

(async () => {
  const fp = findFlag('--franchise');
  if (!fp) { console.error('--franchise required'); process.exit(1); }

  const fra = await new Promise((res, rej) => {
    const f = new Franchise(fp, { gameYearOverride: 26 });
    f.on('error', rej);
    f.on('ready', () => res(f));
  });

  console.log(`Franchise: ${fp}`);
  console.log(`Total tables: ${fra.tables.length}\n`);

  // Find any table whose name OR field keys match user/owner/control needles.
  const interesting = [];
  for (const t of fra.tables) {
    if (NEEDLES.test(t.name)) interesting.push({ tbl: t, reason: `table name '${t.name}'` });
  }

  // Read all tables, look at their schemas for matching field keys.
  // (Schemas come from the loaded franchise; we don't need to read records yet.)
  for (const t of fra.tables) {
    if (!t.schema || !t.schema.attributes) continue;
    const matchingKeys = t.schema.attributes.filter(a => NEEDLES.test(a.name)).map(a => a.name);
    if (matchingKeys.length > 0) {
      interesting.push({ tbl: t, reason: `field(s): ${matchingKeys.join(', ')}` });
    }
  }

  // De-dupe by tableId
  const seen = new Set();
  const uniq = interesting.filter(({ tbl }) => {
    if (seen.has(tbl.header.tableId)) return false;
    seen.add(tbl.header.tableId);
    return true;
  });

  console.log(`Tables matching user/owner/control patterns: ${uniq.length}`);
  for (const { tbl, reason } of uniq) {
    console.log(`  tableId=${tbl.header.tableId.toString().padStart(5)}  name='${tbl.name.padEnd(35)}'  ${reason}`);
  }
  console.log();

  // For each, dump record count + sample values.
  for (const { tbl } of uniq) {
    try { await tbl.readRecords(); } catch (e) {
      console.log(`-- ${tbl.name} (id=${tbl.header.tableId}): READ FAILED: ${e.message}`);
      continue;
    }
    const live = tbl.records.filter(r => !r.isEmpty);
    console.log(`-- ${tbl.name} (id=${tbl.header.tableId}): ${tbl.records.length} records, ${live.length} live`);

    if (live.length === 0) continue;
    const sample = live[0];
    const matchingKeys = sample.fieldsArray.map(f => f.key).filter(k => NEEDLES.test(k));
    if (matchingKeys.length === 0) {
      console.log(`   (no matching field keys on records — table name matched but record schema didn't)`);
      continue;
    }
    console.log(`   matching fields: ${matchingKeys.join(', ')}`);

    // For Team-like tables with TeamIndex, dump field values per team
    const hasTeamIndex = sample.getFieldByKey('TeamIndex') !== undefined;
    if (hasTeamIndex) {
      console.log(`   per-team values for matching fields:`);
      for (const rec of live) {
        const ti = safeGet(rec, 'TeamIndex');
        const kv = matchingKeys.map(k => `${k}=${safeGet(rec, k)}`).join('  ');
        console.log(`     ti=${String(ti).padStart(2)}  ${kv}`);
      }
    } else {
      // Singleton-style: dump first 3 records' matching field values
      for (let i = 0; i < Math.min(3, live.length); i++) {
        const kv = matchingKeys.map(k => {
          const f = live[i].getFieldByKey(k);
          if (f && f.isReference) {
            const r = f.referenceData;
            return `${k}=ref(t=${r.tableId},r=${r.rowNumber})`;
          }
          return `${k}=${safeGet(live[i], k)}`;
        }).join('  ');
        console.log(`     [${i}]  ${kv}`);
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
