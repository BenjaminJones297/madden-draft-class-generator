'use strict';
/**
 * polish_ratings10.js — HB kickReturn, QB CoD, DT pass rush variation, stamina variation
 *
 * Pass 1: HB kickReturn ghost (all 32, cal avg ~72) → speed-correlated [62, 80]
 * Pass 2: QB changeOfDirection ghost (all 67) → speed-correlated [72, 82]
 * Pass 3: DT powerMoves + finesseMoves uniform ghost → blockShedding-correlated
 * Pass 4: SS catching under-cal → grade-scaled [47, 62]
 * Pass 5: Stamina grade variation — any perfectly uniform stamina pool → ±4 by grade
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
  const v = Math.round(Math.max(0, Math.min(99, val)));
  if (r[attr] === v) return;
  log(pass, name, pos, attr, r[attr], v, reason);
  if (FIX) r[attr] = v;
}
function linearRescale(val, srcMin, srcMax, tgtMin, tgtMax) {
  if (srcMax === srcMin) return Math.round((tgtMin + tgtMax) / 2);
  return tgtMin + (val - srcMin) * (tgtMax - tgtMin) / (srcMax - srcMin);
}
function scaleGroupAttr(group, srcAttr, tgtAttr, tgtMin, tgtMax, pass, pos, label) {
  const sVals = group.map(p => p.ratings[srcAttr]);
  const srcMin = Math.min(...sVals), srcMax = Math.max(...sVals);
  group.forEach(p => {
    const target = linearRescale(p.ratings[srcAttr], srcMin, srcMax, tgtMin, tgtMax);
    applyIf(p.ratings, tgtAttr, target, pass, `${p.firstName} ${p.lastName}`, pos,
      `${label}; ${srcAttr}=${p.ratings[srcAttr]} → ${tgtAttr}=${Math.round(target)}`);
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

// Grade → stamina delta
const GRADE_STAMINA_DELTA = { 'A+':4,'A':3,'A-':2,'B+':1,'B':0,'B-':-1,'C+':2,'C':-3 };
const GRADE_CATCHING = { 'A+':62,'A':60,'A-':58,'B+':55,'B':52,'B-':50,'C+':48,'C':47 };

// ---------------------------------------------------------------------------
// Pass 1 — HB kickReturn all 32 (cal avg ~72) → speed-correlated [62, 80]
// ---------------------------------------------------------------------------
function pass1_hbKickReturn(prospects) {
  console.log('\n[Pass 1] HB kickReturn ghost → speed-correlated [62, 80]');
  const hbs = prospects.filter(p => p.pos === 'HB');
  const krVals = hbs.map(p => p.ratings.kickReturn);
  if (krVals.every(v => v === krVals[0])) {
    scaleGroupAttr(hbs, 'speed', 'kickReturn', 62, 80, 1, 'HB', 'KR ghost');
  } else console.log('  Not uniform — skipping.');
}

// ---------------------------------------------------------------------------
// Pass 2 — QB changeOfDirection all 67 → speed-correlated [72, 82]
// ---------------------------------------------------------------------------
function pass2_qbCoD(prospects) {
  console.log('\n[Pass 2] QB changeOfDirection ghost → speed-correlated [72, 82]');
  const qbs = prospects.filter(p => p.pos === 'QB');
  const codVals = qbs.map(p => p.ratings.changeOfDirection);
  if (codVals.every(v => v === codVals[0])) {
    scaleGroupAttr(qbs, 'speed', 'changeOfDirection', 72, 82, 2, 'QB', 'CoD ghost');
  } else console.log('  Not uniform — skipping.');
}

// ---------------------------------------------------------------------------
// Pass 3 — DT powerMoves + finesseMoves uniform ghost → blockShedding-correlated
// ---------------------------------------------------------------------------
function pass3_dtPassRush(prospects) {
  console.log('\n[Pass 3] DT powerMoves/finesseMoves uniform ghost → blockShedding-correlated');
  let n = 0;
  const dts = prospects.filter(p => p.pos === 'DT');
  const bsVals = dts.map(p => p.ratings.blockShedding);
  const bsMin = Math.min(...bsVals), bsMax = Math.max(...bsVals);

  for (const [attr, tgtMin, tgtMax] of [['powerMoves', 52, 74], ['finesseMoves', 46, 66]]) {
    const vals = dts.map(p => p.ratings[attr]);
    if (!vals.every(v => v === vals[0])) { console.log(`  ${attr}: not uniform, skipping`); continue; }
    dts.forEach(p => {
      const target = linearRescale(p.ratings.blockShedding, bsMin, bsMax, tgtMin, tgtMax);
      applyIf(p.ratings, attr, target, 3, `${p.firstName} ${p.lastName}`, p.pos,
        `uniform ghost; bShed=${p.ratings.blockShedding} → ${attr}=${Math.round(target)}`);
      n++;
    });
  }
  console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 4 — SS catching under-cal (avg 43 vs cal avg 55) → grade-scaled [47, 62]
// ---------------------------------------------------------------------------
function pass4_ssCatching(prospects) {
  console.log('\n[Pass 4] SS catching under-cal → grade-scaled [47, 62]');
  let n = 0;
  prospects.filter(p => p.pos === 'SS' && p.ratings.catching < 50).forEach(p => {
    const target = GRADE_CATCHING[p.grade] || 52;
    applyIf(p.ratings, 'catching', target, 4, `${p.firstName} ${p.lastName}`, p.pos,
      `under-cal catching (${p.ratings.catching}); grade=${p.grade} → ${target}`);
    n++;
  });
  console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 5 — Stamina grade variation: perfectly-uniform pools get ±4 by grade
// ---------------------------------------------------------------------------
const GRADE_DELTA = { 'A+':4,'A':3,'A-':2,'B+':1,'B':0,'B-':-1,'C+':2,'C':-3 };
const POS_GROUPS  = ['QB','HB','WR','TE','T','G','C','DE','DT','OLB','MLB','CB','FS','SS'];

function pass5_staminaVariation(prospects) {
  console.log('\n[Pass 5] Stamina grade variation (uniform pools only)');
  let total = 0;
  const byPos = {};
  prospects.forEach(p => (byPos[p.pos] = byPos[p.pos]||[]).push(p));

  for (const pos of POS_GROUPS) {
    const group = byPos[pos];
    if (!group || group.length < 3) continue;
    const vals = group.map(p => p.ratings.stamina);
    const isUniform = (Math.max(...vals) - Math.min(...vals)) <= 2;
    if (!isUniform) continue;
    const base = Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
    group.forEach(p => {
      const delta = GRADE_DELTA[p.grade] ?? 0;
      const target = base + delta;
      applyIf(p.ratings, 'stamina', target, 5, `${p.firstName} ${p.lastName}`, p.pos,
        `stamina uniform=${base}; grade=${p.grade} delta=${delta} → ${target}`);
    });
    total += group.length;
  }
  console.log(`  ${total} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_RATED, 'utf8'));
  console.log('=== Polish Ratings 10 — HB KR, QB CoD, DT pass rush, SS catch, stamina ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  pass1_hbKickReturn(prospects);
  pass2_qbCoD(prospects);
  pass3_dtPassRush(prospects);
  pass4_ssCatching(prospects);
  pass5_staminaVariation(prospects);

  console.log('\n=== Change Report ===');
  if (changes.length === 0) console.log('  No changes needed.');
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
