'use strict';
/**
 * polish_ratings4.js — Six targeted bug fixes
 *
 * Pass 1: TE route running ghost values (floor at calibration p10)
 * Pass 2: CB pressCoverage ghost values (floor 55–65 based on coverage style)
 * Pass 3: Morale = 50 for all draft class prospects (calibration universal standard)
 * Pass 4: Personality calibration by round + grade
 * Pass 5: HB carrying calibration cap (max 96 from calibration)
 * Pass 6: DT/DE pass rush ghost values (powerMoves/finesseMoves/blockShedding floors)
 */

const fs   = require('fs');
const path = require('path');

const ROOT            = path.join(__dirname, '..');
const PROSPECTS_RATED = path.join(ROOT, 'data', 'prospects_rated.json');
const OUTPUT_FILE     = path.join(ROOT, 'data', 'output', '2026_draft_class.draftclass');

const FIX     = process.argv.includes('--fix');
const REBUILD = process.argv.includes('--rebuild');

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }

const changes = [];
function log(pass, name, pos, attr, before, after, reason) {
  changes.push({ pass, name, pos, attr, before, after, reason });
}
function applyIf(obj, attr, val, pass, name, pos, reason) {
  if (obj[attr] === val) return;
  log(pass, name, pos, attr, obj[attr], val, reason);
  if (FIX) obj[attr] = val;
}
function report() {
  const byPass = {};
  changes.forEach(c => (byPass[c.pass] = byPass[c.pass] || []).push(c));
  Object.entries(byPass).forEach(([pass, list]) => {
    console.log(`\n── Pass ${pass} ──────────────────────────────────`);
    list.forEach(c =>
      console.log(`  ${c.name.padEnd(26)} ${c.pos.padEnd(5)} ${c.attr.padEnd(24)} ${String(c.before).padStart(3)} → ${String(c.after).padStart(3)}  (${c.reason})`)
    );
  });
}

// ---------------------------------------------------------------------------
// Pass 1 — TE route running ghost values
// Calibration: short p10=49 avg=56 min=46 / mid p10=54 avg=61 min=51 / deep p10=60 avg=66 min=57
// Only fix routes that are below calibration minimum (clearly wrong LLM defaults)
// Differentiate by description: seam threat → elevate deep, receiving TE → balanced
// ---------------------------------------------------------------------------
const TE_SEAM_RE    = /seam\s+(?:threat|run|route|presence)|attack.*zone|threaten.*middle|vertical.*seam/i;
const TE_BLOCKER_RE = /(?:elite|dominant|primary|willing|capable)\s+(?:in-line\s+)?block|blocking\s+TE|Y\s+tight\s+end|in-line\s+TE/i;

const TE_ROUTE_FLOORS = { short: 49, mid: 54, deep: 60 }; // calibration p10

function pass1_teRoutes(prospects) {
  console.log('\n[Pass 1] TE route running ghost values');
  let count = 0;
  prospects.filter(p => p.pos === 'TE').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const n    = p.notes || '';

    const isSeam    = TE_SEAM_RE.test(n);
    const isBlocker = TE_BLOCKER_RE.test(n);

    // Determine target floors based on player type
    let shortFloor = TE_ROUTE_FLOORS.short;
    let midFloor   = TE_ROUTE_FLOORS.mid;
    let deepFloor  = TE_ROUTE_FLOORS.deep;

    if (isSeam && !isBlocker) {
      // Seam threat: deep routes should be strong
      deepFloor  = Math.max(deepFloor, 65);
      midFloor   = Math.max(midFloor, 60);
      shortFloor = Math.max(shortFloor, 55);
    } else if (isBlocker && !isSeam) {
      // Blocking TE: route running is secondary, keep at floor
      shortFloor = TE_ROUTE_FLOORS.short;
      midFloor   = TE_ROUTE_FLOORS.mid;
      deepFloor  = TE_ROUTE_FLOORS.deep;
    } else {
      // Generic TE: slightly above floor
      shortFloor = Math.max(shortFloor, 54);
      midFloor   = Math.max(midFloor, 58);
      deepFloor  = Math.max(deepFloor, 63);
    }

    const fixes = [
      ['shortRouteRunning', shortFloor],
      ['mediumRouteRunning', midFloor],
      ['deepRouteRunning', deepFloor],
    ];
    fixes.forEach(([attr, floor]) => {
      if (r[attr] < floor) {
        applyIf(r, attr, floor, 1, name, p.pos, `below TE route floor (${r[attr]} < ${floor})`);
        count++;
      }
    });
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 2 — CB pressCoverage ghost values
// Even zone corners need pressCoverage ≥ 52 (FS/SS calibration max is 52)
// Man-dominant CBs (manCoverage > zoneCoverage + 5) need pressCoverage ≥ 65
// ---------------------------------------------------------------------------
function pass2_cbPressCoverage(prospects) {
  console.log('\n[Pass 2] CB pressCoverage ghost values');
  let count = 0;
  prospects.filter(p => p.pos === 'CB').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;

    const isManDominant = r.manCoverage > r.zoneCoverage + 5;
    const floor = isManDominant ? 65 : 52;

    if (r.pressCoverage < floor) {
      applyIf(r, 'pressCoverage', floor, 2, name, p.pos,
        `pressCoverage ghost (${r.pressCoverage}); ${isManDominant ? 'man-dominant' : 'zone'} floor=${floor}`);
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 3 — Morale = 50 for all draft class prospects
// Calibration shows morale is universally 50 for draft class imports
// ---------------------------------------------------------------------------
function pass3_morale(prospects) {
  console.log('\n[Pass 3] Morale = 50 (draft class standard)');
  let count = 0;
  prospects.forEach(p => {
    if (p.ratings.morale !== 50) {
      applyIf(p.ratings, 'morale', 50, 3, `${p.firstName} ${p.lastName}`, p.pos,
        `draft class standard (was ${p.ratings.morale})`);
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 4 — Personality calibration by round + grade
// Calibration: R1 avg=78 (35–96), R2 avg=74 (44–90)
// Grade → personality target:
//   A+/A  : R1 85–94, R2 80–88
//   A-/B+ : R1 74–84, R2 70–80
//   B/B-  : R1 68–74, R2 65–74
//   C+/C  : R2 58–68
// ---------------------------------------------------------------------------
const GRADE_PERSONALITY = {
  'A+': { 1: 90, 2: 85 },
  'A':  { 1: 86, 2: 82 },
  'A-': { 1: 80, 2: 76 },
  'B+': { 1: 76, 2: 72 },
  'B':  { 1: 72, 2: 68 },
  'B-': { 1: 70, 2: 65 },
  'C+': { 1: 68, 2: 62 },
  'C':  { 1: 65, 2: 58 },
  'C-': { 1: 62, 2: 55 },
};

function pass4_personality(prospects) {
  console.log('\n[Pass 4] Personality calibration');
  let count = 0;
  prospects.forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const row  = GRADE_PERSONALITY[p.grade];
    if (!row) return;

    const target = row[p.draftRound] || row[2] || 68;

    // Only adjust if current value differs by more than 4 pts (avoid micro-corrections)
    if (Math.abs(r.personality - target) > 4) {
      applyIf(r, 'personality', target, 4, name, p.pos,
        `grade=${p.grade} R${p.draftRound}: target personality=${target} (was ${r.personality})`);
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 5 — HB carrying calibration cap
// Calibration max is 96; cap outliers above that
// ---------------------------------------------------------------------------
function pass5_hbCarrying(prospects) {
  console.log('\n[Pass 5] HB carrying calibration cap');
  let count = 0;
  prospects.filter(p => p.pos === 'HB').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    if (r.carrying > 96) {
      applyIf(r, 'carrying', 96, 5, name, p.pos, `above calibration max 96 (was ${r.carrying})`);
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 6 — DT/DE pass rush ghost values
// For R1/R2 DTs and DEs, powerMoves/finesseMoves/blockShedding should not be ghost values
// Floors based on position and round; also parse notes for style
// ---------------------------------------------------------------------------
const PASS_RUSH_FLOORS = {
  DE:  { blockShedding: 65, powerMoves: 60, finesseMoves: 56 },
  DT:  { blockShedding: 62, powerMoves: 58, finesseMoves: 55 },
  OLB: { blockShedding: 58, powerMoves: 45, finesseMoves: 42 },
};

function pass6_passRushGhosts(prospects) {
  console.log('\n[Pass 6] DT/DE/OLB pass rush ghost values');
  let count = 0;
  prospects.filter(p => ['DE','DT','OLB'].includes(p.pos)).forEach(p => {
    const r      = p.ratings;
    const name   = `${p.firstName} ${p.lastName}`;
    const floors = PASS_RUSH_FLOORS[p.pos] || {};

    for (const [attr, floor] of Object.entries(floors)) {
      if (typeof r[attr] === 'number' && r[attr] < floor) {
        applyIf(r, attr, floor, 6, name, p.pos,
          `ghost value (${r[attr]} < floor ${floor})`);
        count++;
      }
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_RATED, 'utf8'));

  console.log('=== Polish Ratings 4 — 6 Targeted Fixes ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  pass1_teRoutes(prospects);
  pass2_cbPressCoverage(prospects);
  pass3_morale(prospects);
  pass4_personality(prospects);
  pass5_hbCarrying(prospects);
  pass6_passRushGhosts(prospects);

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
