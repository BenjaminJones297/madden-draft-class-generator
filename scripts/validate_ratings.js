'use strict';
/**
 * validate_ratings.js
 *
 * Checks prospects_rated.json against per-position statistical bounds derived
 * from the M26 2025 calibration set.  For each physical trait, computes p10/p90
 * per position and flags prospects whose ratings fall outside those bounds.
 *
 * Usage:
 *   node scripts/validate_ratings.js            # report only
 *   node scripts/validate_ratings.js --fix      # clamp outliers to bounds
 *   node scripts/validate_ratings.js --fix --rebuild  # fix + rebuild .draftclass
 */

const fs   = require('fs');
const path = require('path');

const ROOT            = path.join(__dirname, '..');
const CALIBRATION     = path.join(ROOT, 'data', 'calibration_set.json');
const PROSPECTS_RATED = path.join(ROOT, 'data', 'prospects_rated.json');
const OUTPUT_FILE     = path.join(ROOT, 'data', 'output', '2026_draft_class.draftclass');

const FIX     = process.argv.includes('--fix');
const REBUILD = process.argv.includes('--rebuild');

// Physical traits to validate — irrelevant cross-position traits (e.g. throwPower
// for a CB) are naturally excluded because calibration bounds will cover them.
const PHYSICAL_TRAITS = [
  'speed', 'acceleration', 'agility', 'strength',
  'changeOfDirection', 'jumping',
];

// Position fallback map mirrors the one in step 5 — used when a prospect's
// exact position has no calibration examples.
const POSITION_FALLBACKS = {
  EDGE: ['OLB', 'DE'], ILB: ['MLB', 'OLB'], LB: ['OLB', 'MLB'],
  OLB:  ['MLB'],       MLB: ['OLB'],
  OT:   ['T'],         LT:  ['T'],  RT: ['T'],
  OG:   ['G'],         LG:  ['G'],  RG: ['G'],
  NT:   ['DT'],        DE:  ['OLB', 'DT'],
  CB:   ['FS', 'SS'],  FS:  ['SS'], SS: ['FS'],
  S:    ['FS', 'SS'],  DB:  ['CB', 'FS'],
  RB:   ['HB'],        PK:  ['K'],
};

// These calibration groups are known to be misaligned (wrong position players
// were mapped into them by the M26 draft class).  Always use their fallbacks.
const MISALIGNED_CALIBRATION = new Set(['CB', 'DE']);

// ---------------------------------------------------------------------------
// Build per-position bounds from calibration
// ---------------------------------------------------------------------------
function buildBounds(calibration) {
  const bounds = {};   // { POS: { trait: { min, p10, p25, p75, p90, max } } }

  for (const [pos, players] of Object.entries(calibration)) {
    bounds[pos] = {};
    for (const trait of PHYSICAL_TRAITS) {
      const vals = players
        .map(p => p.ratings[trait])
        .filter(v => typeof v === 'number')
        .sort((a, b) => a - b);
      if (vals.length < 3) continue;
      bounds[pos][trait] = {
        min: vals[0],
        p10: vals[Math.floor(vals.length * 0.10)],
        p25: vals[Math.floor(vals.length * 0.25)],
        p75: vals[Math.floor(vals.length * 0.75)],
        p90: vals[Math.floor(vals.length * 0.90)],
        max: vals[vals.length - 1],
        n:   vals.length,
      };
    }
  }
  return bounds;
}

// ---------------------------------------------------------------------------
// Resolve which position's bounds to use for a given prospect position
// ---------------------------------------------------------------------------
function resolveBounds(pos, bounds) {
  // Skip known-misaligned calibration groups; go straight to fallbacks
  if (bounds[pos] && !MISALIGNED_CALIBRATION.has(pos)) {
    return { usedPos: pos, b: bounds[pos] };
  }
  for (const fb of (POSITION_FALLBACKS[pos] || [])) {
    if (bounds[fb] && !MISALIGNED_CALIBRATION.has(fb)) {
      return { usedPos: fb, b: bounds[fb] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const calibration = JSON.parse(fs.readFileSync(CALIBRATION, 'utf8'));
  const prospects   = JSON.parse(fs.readFileSync(PROSPECTS_RATED, 'utf8'));
  const bounds      = buildBounds(calibration);

  console.log('\n=== Rating Bounds Validator ===');
  console.log(`  Calibration positions: ${Object.keys(bounds).join(', ')}`);
  console.log(`  Prospects to check   : ${prospects.length}`);
  console.log(`  Mode                 : ${FIX ? 'FIX (clamp outliers)' : 'REPORT ONLY'}\n`);

  const issues = [];
  let fixCount = 0;

  for (const prospect of prospects) {
    const name = `${prospect.firstName} ${prospect.lastName}`;
    const pos  = prospect.pos;
    const resolved = resolveBounds(pos, bounds);
    if (!resolved) continue;
    const { usedPos, b } = resolved;

    for (const trait of PHYSICAL_TRAITS) {
      if (!b[trait]) continue;
      const actual = prospect.ratings[trait];
      if (typeof actual !== 'number') continue;

      const { p10, p90, min, max } = b[trait];

      // Soft bounds: flag anything below p10 or above p90
      // Hard bounds: flag anything below min-5 or above max+5
      const softLo = p10, softHi = p90;
      const hardLo = Math.max(0,   min - 5);
      const hardHi = Math.min(99,  max + 5);

      let severity = null;
      if (actual < hardLo || actual > hardHi) severity = 'HARD';
      else if (actual < softLo || actual > softHi) severity = 'soft';

      if (!severity) continue;

      const clamped = Math.min(hardHi, Math.max(hardLo, actual));
      issues.push({ name, pos, usedPos, trait, actual, softLo, softHi, hardLo, hardHi, clamped, severity });

      if (FIX && severity === 'HARD') {
        prospect.ratings[trait] = clamped;
        fixCount++;
      }
    }
  }

  // Print report
  const hardIssues = issues.filter(i => i.severity === 'HARD');
  const softIssues = issues.filter(i => i.severity === 'soft');

  if (hardIssues.length) {
    console.log(`🚨 HARD violations (outside min-5 / max+5) — ${FIX ? 'AUTO-FIXED' : 'review these'}:`);
    for (const i of hardIssues) {
      const arrow = FIX ? ` → ${i.clamped}` : '';
      console.log(`  ${i.name.padEnd(25)} ${i.pos.padEnd(5)} ${i.trait.padEnd(20)} actual:${String(i.actual).padStart(3)}  bounds:[${i.hardLo}–${i.hardHi}]${arrow}`);
    }
  } else {
    console.log('✅ No HARD violations found.');
  }

  if (softIssues.length) {
    console.log(`\n⚠️  Soft warnings (outside p10/p90) — manual review suggested:`);
    for (const i of softIssues) {
      console.log(`  ${i.name.padEnd(25)} ${i.pos.padEnd(5)} ${i.trait.padEnd(20)} actual:${String(i.actual).padStart(3)}  p10–p90:[${i.softLo}–${i.softHi}]`);
    }
  } else {
    console.log('✅ No soft warnings found.');
  }

  console.log(`\nSummary: ${hardIssues.length} hard, ${softIssues.length} soft warnings.`);

  if (FIX) {
    fs.writeFileSync(PROSPECTS_RATED, JSON.stringify(prospects, null, 2));
    console.log(`\n✅ Fixed ${fixCount} hard violations → ${PROSPECTS_RATED}`);

    if (REBUILD) {
      const { execSync } = require('child_process');
      console.log('\nRebuilding .draftclass ...');
      execSync(`node "${path.join(__dirname, '6_create_draft_class.js')}" --out "${OUTPUT_FILE}"`, { stdio: 'inherit' });
    }
  } else if (hardIssues.length || softIssues.length) {
    console.log('\nRe-run with --fix to auto-clamp HARD violations.');
    console.log('Re-run with --fix --rebuild to also regenerate the .draftclass file.');
  }
}

main();
