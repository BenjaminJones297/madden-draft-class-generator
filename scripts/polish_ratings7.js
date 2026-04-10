'use strict';
/**
 * polish_ratings7.js — 4 systematic calibration fixes
 *
 * Pass 1: CB / FS playRecognition linear rescale → [56, 66]
 *         SS playRecognition cap at calibration max (74)
 * Pass 2: SS acceleration linear rescale → cal range [81, 89]
 *         SS agility rescale from uniform ghost value 65 → speed-correlated [70, 82]
 * Pass 3: CB strength scale from ghost range [28–40] → calibration-grounded [44, 55]
 * Pass 4: T awareness cap at cal max 78; C awareness cap at cal max 77
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
// Pass 1 — playRecognition inflation for CB / FS / SS
// Calibration (FS proxy for CB): range 56–58, avg 57
// CB/FS current: 72–83 → target [56, 66]  (generous +8 above cal max for top prospects)
// SS calibration: range 57–74. Our SSs all at 78 → cap at 74
// ---------------------------------------------------------------------------
function pass1_playRecognition(prospects) {
  console.log('\n[Pass 1] playRecognition rescale (CB/FS) and cap (SS)');
  let count = 0;

  // CB + FS: linear rescale
  for (const pos of ['CB', 'FS']) {
    const group  = prospects.filter(p => p.pos === pos);
    const vals   = group.map(p => p.ratings.playRecognition);
    const srcMin = Math.min(...vals);
    const srcMax = Math.max(...vals);
    const tgtMin = 56;
    const tgtMax = 66;

    if (srcMax <= tgtMax) {
      console.log(`  ${pos}: already within target range (max=${srcMax}), skipping.`);
      continue;
    }
    group.forEach(p => {
      const target = linearRescale(p.ratings.playRecognition, srcMin, srcMax, tgtMin, tgtMax);
      applyIf(p.ratings, 'playRecognition', target, 1, `${p.firstName} ${p.lastName}`, p.pos,
        `rescaled ${p.ratings.playRecognition} (${srcMin}–${srcMax}) → [${tgtMin},${tgtMax}]`);
      count++;
    });
  }

  // SS: cap at calibration max 74
  prospects.filter(p => p.pos === 'SS' && p.ratings.playRecognition > 74).forEach(p => {
    applyIf(p.ratings, 'playRecognition', 74, 1, `${p.firstName} ${p.lastName}`, p.pos,
      `above SS cal max 74 (was ${p.ratings.playRecognition})`);
    count++;
  });

  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 2 — SS acceleration + agility: all below calibration minimum
// Calibration: accel avg=89 min=81 max=93; agility avg=78 min=70 max=86
// Acceleration: linear rescale current [76–80] → cal range [81, 89]
// Agility: uniform ghost value 65 → speed-correlated using cal range [70, 82]
// ---------------------------------------------------------------------------
function pass2_ssAthletics(prospects) {
  console.log('\n[Pass 2] SS acceleration + agility calibration');
  let count = 0;
  const ssList = prospects.filter(p => p.pos === 'SS');

  // Acceleration rescale
  const accVals = ssList.map(p => p.ratings.acceleration);
  const accMin  = Math.min(...accVals);
  const accMax  = Math.max(...accVals);
  ssList.forEach(p => {
    const target = linearRescale(p.ratings.acceleration, accMin, accMax, 81, 89);
    applyIf(p.ratings, 'acceleration', target, 2, `${p.firstName} ${p.lastName}`, p.pos,
      `below SS cal min 81 (was ${p.ratings.acceleration}); rescaled [${accMin},${accMax}]→[81,89]`);
    count++;
  });

  // Agility: derive from speed (cal min=70 max=86, correlated with speed)
  const spdVals = ssList.map(p => p.ratings.speed);
  const spdMin  = Math.min(...spdVals);
  const spdMax  = Math.max(...spdVals);
  ssList.forEach(p => {
    const target = linearRescale(p.ratings.speed, spdMin, spdMax, 70, 82);
    if (p.ratings.agility < 70) {
      applyIf(p.ratings, 'agility', target, 2, `${p.firstName} ${p.lastName}`, p.pos,
        `below SS cal min 70 (was ${p.ratings.agility}); speed-correlated [${spdMin},${spdMax}]→[70,82]`);
      count++;
    }
  });

  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 3 — CB strength: ghost range [28–40] far below FS calibration [66–70]
// CBs are lighter than FSs; using conservative target range [44, 55]
// Preserves relative ordering (physical/press CBs > speed CBs)
// ---------------------------------------------------------------------------
function pass3_cbStrength(prospects) {
  console.log('\n[Pass 3] CB strength rescale → [44, 55]');
  let count = 0;
  const cbList = prospects.filter(p => p.pos === 'CB');
  const vals   = cbList.map(p => p.ratings.strength);
  const srcMin = Math.min(...vals);
  const srcMax = Math.max(...vals);
  const tgtMin = 44;
  const tgtMax = 55;

  if (srcMax >= tgtMin) {
    console.log(`  CB strength already at or above target min (max=${srcMax}), no change.`);
    return;
  }

  cbList.forEach(p => {
    const target = linearRescale(p.ratings.strength, srcMin, srcMax, tgtMin, tgtMax);
    applyIf(p.ratings, 'strength', target, 3, `${p.firstName} ${p.lastName}`, p.pos,
      `ghost strength (${p.ratings.strength}); rescaled [${srcMin},${srcMax}]→[${tgtMin},${tgtMax}]`);
    count++;
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 4 — OL awareness caps
// T calibration max = 78; C calibration max = 77
// ---------------------------------------------------------------------------
const OL_AWARENESS_CAPS = { T: 78, C: 77 };

function pass4_olAwareness(prospects) {
  console.log('\n[Pass 4] T / C awareness cap at calibration max');
  let count = 0;
  for (const [pos, cap] of Object.entries(OL_AWARENESS_CAPS)) {
    prospects.filter(p => p.pos === pos && p.ratings.awareness > cap).forEach(p => {
      applyIf(p.ratings, 'awareness', cap, 4, `${p.firstName} ${p.lastName}`, p.pos,
        `above ${pos} cal max ${cap} (was ${p.ratings.awareness})`);
      count++;
    });
  }
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_RATED, 'utf8'));

  console.log('=== Polish Ratings 7 — playRecognition / SS Athletics / CB Strength / OL Awareness ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  pass1_playRecognition(prospects);
  pass2_ssAthletics(prospects);
  pass3_cbStrength(prospects);
  pass4_olAwareness(prospects);

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
