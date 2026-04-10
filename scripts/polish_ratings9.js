'use strict';
/**
 * polish_ratings9.js — Pursuit, stamina, jumping, CoD, release, kickReturn
 *
 * Pass 1: CB pursuit ghost (all 30) → grade-scaled [72, 82]
 * Pass 2: CB stamina under-calibrated → scale current [70–80] → [82, 90]
 * Pass 3: FS changeOfDirection below cal min 73 → floor/scale to [73, 74]
 * Pass 4: TE release under-calibrated → scale to cal range [57, 74]
 * Pass 5: Universal jumping calibration — all positions with uniform ghost values
 * Pass 6: DE / CB / OLB changeOfDirection uniform ghost → speed-correlated
 * Pass 7: DT acceleration + agility uniform ghost → blockShedding-correlated
 * Pass 8: WR kickReturn ghosts (0-values) → speed-correlated [40, 78]
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
function scaleGroup(group, srcAttr, tgtAttr, tgtMin, tgtMax, pass, pos, reason) {
  const vals = group.map(p => p.ratings[srcAttr]);
  const srcMin = Math.min(...vals), srcMax = Math.max(...vals);
  group.forEach(p => {
    const target = linearRescale(p.ratings[srcAttr], srcMin, srcMax, tgtMin, tgtMax);
    applyIf(p.ratings, tgtAttr, target, pass, `${p.firstName} ${p.lastName}`, pos,
      `${reason} (${srcAttr}=${p.ratings[srcAttr]} → ${tgtAttr}=${Math.round(target)})`);
  });
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
// Pass 1 — CB pursuit: all 30, game-breaking (cal 78–80 avg 79)
// ---------------------------------------------------------------------------
const GRADE_PURSUIT = {
  'A+': 82, 'A': 80, 'A-': 78, 'B+': 76, 'B': 74, 'B-': 72, 'C+': 70, 'C': 68,
};
function pass1_cbPursuit(prospects) {
  console.log('\n[Pass 1] CB pursuit ghost → grade-scaled [68,82]');
  let n = 0;
  prospects.filter(p => p.pos === 'CB' && p.ratings.pursuit < 60).forEach(p => {
    const target = GRADE_PURSUIT[p.grade] || 70;
    applyIf(p.ratings, 'pursuit', target, 1, `${p.firstName} ${p.lastName}`, p.pos,
      `ghost pursuit (${p.ratings.pursuit}); grade=${p.grade} → ${target}`);
    n++;
  });
  console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 2 — CB stamina: avg 74 vs cal 86–87; scale current [70,80] → [82, 90]
// ---------------------------------------------------------------------------
function pass2_cbStamina(prospects) {
  console.log('\n[Pass 2] CB stamina under-calibrated → [82, 90]');
  let n = 0;
  const cbs  = prospects.filter(p => p.pos === 'CB');
  const vals  = cbs.map(p => p.ratings.stamina);
  const srcMin = Math.min(...vals), srcMax = Math.max(...vals);
  cbs.forEach(p => {
    const target = linearRescale(p.ratings.stamina, srcMin, srcMax, 82, 90);
    applyIf(p.ratings, 'stamina', target, 2, `${p.firstName} ${p.lastName}`, p.pos,
      `under-cal stamina; rescaled [${srcMin},${srcMax}]→[82,90]`);
    n++;
  });
  console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 3 — FS changeOfDirection: all below cal min 73 (range 73–74)
// ---------------------------------------------------------------------------
function pass3_fsCoD(prospects) {
  console.log('\n[Pass 3] FS changeOfDirection below cal min 73');
  let n = 0;
  const fss  = prospects.filter(p => p.pos === 'FS');
  const vals  = fss.map(p => p.ratings.changeOfDirection);
  const srcMin = Math.min(...vals), srcMax = Math.max(...vals);
  fss.forEach(p => {
    if (p.ratings.changeOfDirection < 73) {
      const target = linearRescale(p.ratings.changeOfDirection, srcMin, srcMax, 73, 76);
      applyIf(p.ratings, 'changeOfDirection', target, 3, `${p.firstName} ${p.lastName}`, p.pos,
        `below FS cal min 73; rescaled [${srcMin},${srcMax}]→[73,76]`);
      n++;
    }
  });
  console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 4 — TE release: avg 47 vs cal min 57 → scale to [57, 74]
// ---------------------------------------------------------------------------
function pass4_teRelease(prospects) {
  console.log('\n[Pass 4] TE release under-calibrated → scale to [57, 74]');
  let n = 0;
  const tes   = prospects.filter(p => p.pos === 'TE');
  const vals   = tes.map(p => p.ratings.release);
  const srcMin = Math.min(...vals), srcMax = Math.max(...vals);
  tes.filter(p => p.ratings.release < 57).forEach(p => {
    const target = linearRescale(p.ratings.release, srcMin, srcMax, 57, 74);
    applyIf(p.ratings, 'release', target, 4, `${p.firstName} ${p.lastName}`, p.pos,
      `below TE cal min 57; rescaled [${srcMin},${srcMax}]→[57,74]`);
    n++;
  });
  console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 5 — Universal jumping calibration
// For each position where all players share the same below-cal-min jumping value,
// scale based on the most relevant physical attribute.
// ---------------------------------------------------------------------------
const JUMPING_CONFIG = {
  // [pos, calMin, calMax, scaleByAttr, tgtMin, tgtMax]
  QB:  ['speed',         65, 80],
  HB:  ['speed',         72, 90],
  SS:  ['speed',         78, 90],
  OLB: ['speed',         74, 88],
  MLB: ['speed',         74, 88],  // only flag if uniform
  DE:  ['speed',         74, 88],
  DT:  ['strength',      67, 80],
  T:   ['passBlockPower',61, 80],
  G:   ['passBlockPower',52, 78],
  C:   ['passBlockPower',67, 78],
};

function pass5_jumping(prospects) {
  console.log('\n[Pass 5] Universal jumping calibration');
  let total = 0;
  for (const [pos, [scaleAttr, tgtMin, tgtMax]] of Object.entries(JUMPING_CONFIG)) {
    const group = prospects.filter(p => p.pos === pos);
    if (!group.length) continue;
    const jumpVals = group.map(p => p.ratings.jumping);
    const allSame  = jumpVals.every(v => v === jumpVals[0]);
    const belowMin = jumpVals[0] < tgtMin;
    if (!allSame && !belowMin) continue;  // already varied and in range
    const scalerVals = group.map(p => p.ratings[scaleAttr]);
    const srcMin = Math.min(...scalerVals), srcMax = Math.max(...scalerVals);
    let n = 0;
    group.forEach(p => {
      const target = linearRescale(p.ratings[scaleAttr], srcMin, srcMax, tgtMin, tgtMax);
      applyIf(p.ratings, 'jumping', target, 5, `${p.firstName} ${p.lastName}`, p.pos,
        `jumping ghost/uniform; ${scaleAttr}=${p.ratings[scaleAttr]} → ${Math.round(target)}`);
      n++;
    });
    total += n;
    console.log(`  ${pos}: ${n} corrections`);
  }
  console.log(`  Total jumping: ${total} ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 6 — DE / OLB changeOfDirection uniform ghost → speed-correlated
// DE: all 53 (cal min 58) → scale by speed to [62, 78]
// C:  all 45 (cal min 50) → scale by passBlock to [50, 62]
// G:  partial low CoD → scale by passBlock to [42, 58]
// ---------------------------------------------------------------------------
function pass6_codGhosts(prospects) {
  console.log('\n[Pass 6] changeOfDirection uniform ghosts');
  let total = 0;

  const codConfig = [
    { pos: 'DE',  scaleAttr: 'speed',         calMin: 58, tgtMin: 62, tgtMax: 78 },
    { pos: 'C',   scaleAttr: 'passBlockPower', calMin: 50, tgtMin: 50, tgtMax: 62 },
    { pos: 'G',   scaleAttr: 'passBlockPower', calMin: 39, tgtMin: 44, tgtMax: 58 },
  ];

  for (const { pos, scaleAttr, calMin, tgtMin, tgtMax } of codConfig) {
    const group = prospects.filter(p => p.pos === pos);
    if (!group.length) continue;
    const codVals = group.map(p => p.ratings.changeOfDirection);
    const allSame = codVals.every(v => v === codVals[0]);
    if (!allSame && codVals.every(v => v >= calMin)) continue;
    const scaleVals = group.map(p => p.ratings[scaleAttr]);
    const srcMin = Math.min(...scaleVals), srcMax = Math.max(...scaleVals);
    let n = 0;
    group.filter(p => p.ratings.changeOfDirection < calMin || allSame).forEach(p => {
      const target = linearRescale(p.ratings[scaleAttr], srcMin, srcMax, tgtMin, tgtMax);
      applyIf(p.ratings, 'changeOfDirection', target, 6, `${p.firstName} ${p.lastName}`, p.pos,
        `CoD ghost; ${scaleAttr}=${p.ratings[scaleAttr]} → CoD ${Math.round(target)}`);
      n++;
    });
    total += n;
    console.log(`  ${pos}: ${n} corrections`);
  }
  console.log(`  Total CoD: ${total} ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 7 — DT acceleration + agility uniform ghost
// DT calibration is contaminated; use blockShedding as athleticism proxy
// accel: scale blockShedding range → [64, 76]
// agility: scale blockShedding range → [48, 60]
// ---------------------------------------------------------------------------
function pass7_dtAthletics(prospects) {
  console.log('\n[Pass 7] DT acceleration + agility uniform ghost → blockShedding-correlated');
  let n = 0;
  const dts   = prospects.filter(p => p.pos === 'DT');
  const bsVals = dts.map(p => p.ratings.blockShedding);
  const bsMin = Math.min(...bsVals), bsMax = Math.max(...bsVals);

  for (const [attr, tgtMin, tgtMax] of [['acceleration', 64, 76], ['agility', 48, 60]]) {
    const vals = dts.map(p => p.ratings[attr]);
    if (!vals.every(v => v === vals[0])) continue;  // skip if not uniform ghost
    dts.forEach(p => {
      const target = linearRescale(p.ratings.blockShedding, bsMin, bsMax, tgtMin, tgtMax);
      applyIf(p.ratings, attr, target, 7, `${p.firstName} ${p.lastName}`, p.pos,
        `uniform ghost; bShed=${p.ratings.blockShedding} → ${attr} ${Math.round(target)}`);
      n++;
    });
  }
  console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 8 — WR kickReturn ghosts (0 or very low) → speed-correlated [40, 78]
// WRs with kickReturn=0 will effectively be unusable as returners
// ---------------------------------------------------------------------------
function pass8_wrKickReturn(prospects) {
  console.log('\n[Pass 8] WR kickReturn ghost values → speed-correlated [40, 78]');
  let n = 0;
  const wrs  = prospects.filter(p => p.pos === 'WR' && p.ratings.kickReturn < 35);
  if (!wrs.length) { console.log('  None found.'); return; }
  const spdVals = wrs.map(p => p.ratings.speed);
  const srcMin = Math.min(...spdVals), srcMax = Math.max(...spdVals);
  wrs.forEach(p => {
    const target = linearRescale(p.ratings.speed, srcMin, srcMax, 40, 70);
    applyIf(p.ratings, 'kickReturn', target, 8, `${p.firstName} ${p.lastName}`, p.pos,
      `ghost KR (${p.ratings.kickReturn}); speed ${p.ratings.speed} → KR ${Math.round(target)}`);
    n++;
  });
  console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_RATED, 'utf8'));
  console.log('=== Polish Ratings 9 — Pursuit/Stamina/Jumping/CoD/Release/KickReturn ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  pass1_cbPursuit(prospects);
  pass2_cbStamina(prospects);
  pass3_fsCoD(prospects);
  pass4_teRelease(prospects);
  pass5_jumping(prospects);
  pass6_codGhosts(prospects);
  pass7_dtAthletics(prospects);
  pass8_wrKickReturn(prospects);

  console.log('\n=== Change Report ===');
  if (changes.length === 0) { console.log('  No changes needed.'); }
  else {
    report();
    console.log(`\n  Total changes: ${changes.length}`);
  }

  if (FIX && changes.length > 0) {
    fs.writeFileSync(PROSPECTS_RATED, JSON.stringify(prospects, null, 2));
    console.log(`\n✅ Saved → ${PROSPECTS_RATED}`);
    if (REBUILD) {
      const { execSync } = require('child_process');
      execSync(`node "${path.join(__dirname, '6_create_draft_class.js')}" --out "${OUTPUT_FILE}"`, { stdio: 'inherit' });
    }
  } else if (!FIX) console.log('\nRe-run with --fix [--rebuild]');
}
main();
