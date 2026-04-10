'use strict';
/**
 * polish_ratings8.js — Ghost value sweeps for tackle/hitPower, agility, and HB calibration
 *
 * Pass 1: CB tackle + hitPower ghost (all 30) → grade-scaled 56–72
 * Pass 2: DE agility ghost (all 61) → speed-correlated to cal range [72, 86]
 * Pass 3: G/C agility ghost (39–40, below cal min) → scaled to calibration range
 * Pass 4: HB passBlock inflation (71–88 vs cal max 56) → rescale to [44, 56]
 * Pass 5: HB ballCarrierVision / trucking / spinMove cap at calibration max
 * Pass 6: SS zoneCoverage cap at calibration max (71)
 */

const fs   = require('fs');
const path = require('path');

const ROOT            = path.join(__dirname, '..');
const PROSPECTS_RATED = path.join(ROOT, 'data', 'prospects_rated.json');
const OUTPUT_FILE     = path.join(ROOT, 'data', 'output', '2026_draft_class.draftclass');

const FIX     = process.argv.includes('--fix');
const REBUILD = process.argv.includes('--rebuild');

const changes = [];
function log(pass, name, pos, attr, before, after, reason) {
  changes.push({ pass, name, pos, attr, before, after, reason });
}
function applyIf(r, attr, val, pass, name, pos, reason) {
  const v = Math.round(val);
  if (r[attr] === v) return;
  log(pass, name, pos, attr, r[attr], v, reason);
  if (FIX) r[attr] = v;
}
function linearRescale(val, srcMin, srcMax, tgtMin, tgtMax) {
  if (srcMax === srcMin) return Math.round((tgtMin + tgtMax) / 2);
  return tgtMin + (val - srcMin) * (tgtMax - tgtMin) / (srcMax - srcMin);
}
function report() {
  const byPass = {};
  changes.forEach(c => (byPass[c.pass] = byPass[c.pass] || []).push(c));
  Object.entries(byPass).forEach(([pass, list]) => {
    console.log(`\n── Pass ${pass} ──────────────────────────────────`);
    list.forEach(c =>
      console.log(`  ${c.name.padEnd(26)} ${c.pos.padEnd(5)} ${c.attr.padEnd(22)} ${String(c.before).padStart(3)} → ${String(c.after).padStart(3)}  (${c.reason})`)
    );
  });
}

// ---------------------------------------------------------------------------
// Pass 1 — CB tackle + hitPower: all at ghost value 30
// FS calibration proxy: tackle avg=78, hitPower avg=79
// CBs are lighter than FSs; use conservative grade-scaled target 56–72
// ---------------------------------------------------------------------------
const GRADE_TACKLE_HIT = {
  'A+': 74, 'A': 72, 'A-': 68, 'B+': 64, 'B': 62, 'B-': 58, 'C+': 56, 'C': 54,
};

function pass1_cbTackleHit(prospects) {
  console.log('\n[Pass 1] CB tackle + hitPower ghost values');
  let count = 0;
  prospects.filter(p => p.pos === 'CB').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const target = GRADE_TACKLE_HIT[p.grade] || 58;

    for (const attr of ['tackle', 'hitPower']) {
      if (r[attr] < 50) {   // ghost floor — don't override intentionally low values
        applyIf(r, attr, target, 1, name, p.pos,
          `ghost value (${r[attr]}); grade=${p.grade} → ${target}`);
        count++;
      }
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 2 — DE agility: all at ghost value 61 (below cal min 66, OLB proxy)
// Speed-correlated: DE speed range [84–89] → agility [72, 86]
// ---------------------------------------------------------------------------
function pass2_deAgility(prospects) {
  console.log('\n[Pass 2] DE agility ghost values → speed-correlated [72, 86]');
  let count = 0;
  const deList  = prospects.filter(p => p.pos === 'DE');
  const spdVals = deList.map(p => p.ratings.speed);
  const spdMin  = Math.min(...spdVals);
  const spdMax  = Math.max(...spdVals);

  deList.forEach(p => {
    if (p.ratings.agility < 66) {   // below cal min
      const target = linearRescale(p.ratings.speed, spdMin, spdMax, 72, 86);
      applyIf(p.ratings, 'agility', target, 2, `${p.firstName} ${p.lastName}`, p.pos,
        `ghost agility (${p.ratings.agility}); speed ${p.ratings.speed} → agility ${Math.round(target)}`);
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 3 — G/C agility: all below calibration minimum (G min=41, C min=45)
// passBlock spread is too narrow (1 pt) to differentiate — use grade instead
// G cal range 41–65, C cal range 45–71
// ---------------------------------------------------------------------------
const GRADE_OL_AGILITY = {
  'A+': { G: 64, C: 68 }, 'A':  { G: 62, C: 66 }, 'A-': { G: 60, C: 64 },
  'B+': { G: 58, C: 60 }, 'B':  { G: 55, C: 58 }, 'B-': { G: 52, C: 54 },
  'C+': { G: 50, C: 52 }, 'C':  { G: 48, C: 50 }, 'C-': { G: 46, C: 48 },
};

function pass3_olAgility(prospects) {
  console.log('\n[Pass 3] G/C agility ghost values (grade-scaled)');
  let count = 0;

  for (const pos of ['G', 'C']) {
    const calMin = pos === 'G' ? 41 : 45;
    prospects.filter(p => p.pos === pos && p.ratings.agility < calMin).forEach(p => {
      const row    = GRADE_OL_AGILITY[p.grade] || GRADE_OL_AGILITY['C'];
      const target = row[pos];
      applyIf(p.ratings, 'agility', target, 3, `${p.firstName} ${p.lastName}`, p.pos,
        `ghost agility (${p.ratings.agility} < cal min ${calMin}); grade=${p.grade} → ${target}`);
      count++;
    });
  }
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 4 — HB passBlock inflation (71–88 vs calibration max 56)
// HBs pass-block occasionally on screens/chip; elite pass-catching backs ~54–56
// Scale current [min, max] → [44, 56]
// ---------------------------------------------------------------------------
function pass4_hbPassBlock(prospects) {
  console.log('\n[Pass 4] HB passBlock inflation → [44, 56]');
  let count = 0;
  const hbList = prospects.filter(p => p.pos === 'HB');
  const vals   = hbList.map(p => p.ratings.passBlock);
  const srcMin = Math.min(...vals);
  const srcMax = Math.max(...vals);

  if (srcMax <= 56) { console.log('  Already within calibration range.'); return; }

  hbList.forEach(p => {
    const target = linearRescale(p.ratings.passBlock, srcMin, srcMax, 44, 56);
    applyIf(p.ratings, 'passBlock', target, 4, `${p.firstName} ${p.lastName}`, p.pos,
      `inflation (${p.ratings.passBlock} vs cal max 56); rescaled [${srcMin},${srcMax}]→[44,56]`);
    count++;
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 5 — HB ballCarrierVision / trucking / spinMove: above calibration max
// ballCarrierVision cal max=87, trucking cal max=89, spinMove cal max=84
// ---------------------------------------------------------------------------
const HB_CAL_CAPS = { ballCarrierVision: 87, trucking: 89, spinMove: 84 };

function pass5_hbBallCarrier(prospects) {
  console.log('\n[Pass 5] HB ball-carrier attribute caps at calibration max');
  let count = 0;
  prospects.filter(p => p.pos === 'HB').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    for (const [attr, cap] of Object.entries(HB_CAL_CAPS)) {
      if (r[attr] > cap) {
        applyIf(r, attr, cap, 5, name, p.pos,
          `above cal max ${cap} (was ${r[attr]})`);
        count++;
      }
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 6 — SS zoneCoverage cap at calibration max (71)
// ---------------------------------------------------------------------------
function pass6_ssZoneCoverage(prospects) {
  console.log('\n[Pass 6] SS zoneCoverage cap at calibration max (71)');
  let count = 0;
  prospects.filter(p => p.pos === 'SS' && p.ratings.zoneCoverage > 71).forEach(p => {
    applyIf(p.ratings, 'zoneCoverage', 71, 6, `${p.firstName} ${p.lastName}`, p.pos,
      `above SS cal max 71 (was ${p.ratings.zoneCoverage})`);
    count++;
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_RATED, 'utf8'));

  console.log('=== Polish Ratings 8 — Tackle/Agility/HB Calibration Sweeps ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  pass1_cbTackleHit(prospects);
  pass2_deAgility(prospects);
  pass3_olAgility(prospects);
  pass4_hbPassBlock(prospects);
  pass5_hbBallCarrier(prospects);
  pass6_ssZoneCoverage(prospects);

  console.log('\n=== Change Report ===');
  if (changes.length === 0) {
    console.log('  No changes needed.');
  } else {
    report();
    console.log(`\n  Total changes: ${changes.length}`);
  }

  if (FIX && changes.length > 0) {
    fs.writeFileSync(PROSPECTS_RATED, JSON.stringify(prospects, null, 2));
    console.log(`\n✅ Saved → ${PROSPECTS_RATED}`);
    if (REBUILD) {
      const { execSync } = require('child_process');
      console.log('Rebuilding .draftclass ...');
      execSync(`node "${path.join(__dirname, '6_create_draft_class.js')}" --out "${OUTPUT_FILE}"`, { stdio: 'inherit' });
    }
  } else if (!FIX && changes.length > 0) {
    console.log('\nRe-run with --fix to apply, --fix --rebuild to also regenerate .draftclass');
  }
}

main();
