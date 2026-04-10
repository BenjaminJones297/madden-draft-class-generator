'use strict';
/**
 * polish_ratings6.js — DevTrait + Awareness calibration
 *
 * Pass 1: DevTrait correction
 *   X-Factor (2) requires overall ≥ 82 (calibration: 4/370 players, avg OVR 82)
 *   Downgrade over-assigned X-Factor players to Star (1)
 *
 * Pass 2: CB / FS awareness linear rescale
 *   Calibration: max 61, avg 60 — our CBs/FSs are 70–84 (17–19 pts inflated)
 *   Linearly scale current range → [60, 70] preserving relative ordering
 *
 * Pass 3: MLB / QB / SS awareness cap at calibration maximum
 *   MLB cal max 78, QB cal max 72, SS cal max 77
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
function report() {
  const byPass = {};
  changes.forEach(c => (byPass[c.pass] = byPass[c.pass] || []).push(c));
  Object.entries(byPass).forEach(([pass, list]) => {
    console.log(`\n── Pass ${pass} ──────────────────────────────────`);
    list.forEach(c =>
      console.log(`  ${c.name.padEnd(26)} ${c.pos.padEnd(5)} ${c.attr.padEnd(20)} ${String(c.before).padStart(3)} → ${String(c.after).padStart(3)}  (${c.reason})`)
    );
  });
}

// ---------------------------------------------------------------------------
// Pass 1 — DevTrait X-Factor correction
// Calibration: 4 X-Factor players in 370-prospect set, all with overall ≥ 78, avg 82.
// Rule: X-Factor only if overall ≥ 82. Downgrade others to Star (1).
// ---------------------------------------------------------------------------
const XFACTOR_OVR_THRESHOLD = 82;

function pass1_devTrait(prospects) {
  console.log('\n[Pass 1] DevTrait X-Factor correction');
  let count = 0;
  prospects.filter(p => p.ratings.devTrait === 2 && p.ratings.overall < XFACTOR_OVR_THRESHOLD).forEach(p => {
    const name = `${p.firstName} ${p.lastName}`;
    applyIf(p.ratings, 'devTrait', 1, 1, name, p.pos,
      `X-Factor requires overall ≥ ${XFACTOR_OVR_THRESHOLD}; overall=${p.ratings.overall} → Star`);
    count++;
  });
  const xfCount = prospects.filter(p => (FIX ? p.ratings.devTrait : (p.ratings.devTrait === 2)) === 2).length;
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}. Remaining X-Factor: ${prospects.filter(p=>p.ratings.devTrait===2).length}`);
}

// ---------------------------------------------------------------------------
// Pass 2 — CB / FS awareness linear rescale
// Calibration (using FS as CB proxy due to misalignment): range 58–61, avg 60
// Our CBs: 70–83. Our FSs: 75–84.
// Target: [60, 70] — preserves relative ordering within position group
// ---------------------------------------------------------------------------
function linearRescale(val, srcMin, srcMax, tgtMin, tgtMax) {
  if (srcMax === srcMin) return tgtMin;
  return tgtMin + (val - srcMin) * (tgtMax - tgtMin) / (srcMax - srcMin);
}

function pass2_cbFsAwareness(prospects) {
  console.log('\n[Pass 2] CB / FS awareness linear rescale → [60, 70]');
  let count = 0;

  for (const pos of ['CB', 'FS']) {
    const group = prospects.filter(p => p.pos === pos);
    if (!group.length) continue;
    const vals   = group.map(p => p.ratings.awareness);
    const srcMin = Math.min(...vals);
    const srcMax = Math.max(...vals);
    const tgtMin = 60;
    const tgtMax = 70;

    if (srcMax <= tgtMax) {
      console.log(`  ${pos}: already within target range (max=${srcMax}), skipping.`);
      continue;
    }

    group.forEach(p => {
      const target = linearRescale(p.ratings.awareness, srcMin, srcMax, tgtMin, tgtMax);
      const name   = `${p.firstName} ${p.lastName}`;
      applyIf(p.ratings, 'awareness', target, 2, name, p.pos,
        `rescaled ${p.ratings.awareness} (range ${srcMin}–${srcMax}) → target [${tgtMin},${tgtMax}]`);
      count++;
    });
  }
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 3 — MLB / QB / SS awareness cap at calibration maximum
// MLB cal max=78, QB cal max=72, SS cal max=77
// Only cap values above the calibration max — don't lower values that are within range
// ---------------------------------------------------------------------------
const AWARENESS_CAPS = { MLB: 78, QB: 72, SS: 77 };

function pass3_awarenessCap(prospects) {
  console.log('\n[Pass 3] MLB / QB / SS awareness cap at calibration max');
  let count = 0;
  for (const [pos, cap] of Object.entries(AWARENESS_CAPS)) {
    prospects.filter(p => p.pos === pos && p.ratings.awareness > cap).forEach(p => {
      const name = `${p.firstName} ${p.lastName}`;
      applyIf(p.ratings, 'awareness', cap, 3, name, p.pos,
        `above cal max ${cap} (was ${p.ratings.awareness})`);
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

  console.log('=== Polish Ratings 6 — DevTrait + Awareness Calibration ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  pass1_devTrait(prospects);
  pass2_cbFsAwareness(prospects);
  pass3_awarenessCap(prospects);

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
