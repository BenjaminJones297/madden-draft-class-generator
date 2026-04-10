'use strict';
/**
 * polish_ratings5.js — 4 targeted bug-fix passes
 *
 * Pass 1: Injury ghost values (≤25 on healthy players) → 84 (calibration p10)
 * Pass 2: CB catching / catchInTraffic / spectacularCatch ghost values (needed for INTs)
 * Pass 3: CB changeOfDirection ghost (critical for coverage footwork) + release floor
 * Pass 4: Position-secondary "ball carrier" attributes for WRs/HBs/TEs zeroed out
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
function applyIf(r, attr, val, pass, name, pos, reason) {
  if (r[attr] === val) return;
  log(pass, name, pos, attr, r[attr], val, reason);
  if (FIX) r[attr] = val;
}
function report() {
  const byPass = {};
  changes.forEach(c => (byPass[c.pass] = byPass[c.pass] || []).push(c));
  Object.entries(byPass).forEach(([pass, list]) => {
    console.log(`\n── Pass ${pass} ──────────────────────────────────`);
    list.forEach(c =>
      console.log(`  ${(c.name).padEnd(26)} ${c.pos.padEnd(5)} ${c.attr.padEnd(28)} ${String(c.before).padStart(3)} → ${String(c.after).padStart(3)}  (${c.reason})`)
    );
  });
}

// ---------------------------------------------------------------------------
// Pass 1 — Injury ghost values (≤25) → 84 for players with no documented injury
// Calibration: min=78, p10=84, avg=88
// Players with documented injury (ACL, surgery, torn, fracture…) were intentionally rated low.
// ---------------------------------------------------------------------------
const INJURY_KEYWORDS = /\b(acl|mcl|torn|fracture|surgery|labrum|stress\s+fracture|broke|hamstring\s+concern|injury\s+history|injury[\s-]prone|injuries)\b/i;
const INJURY_CAL_P10  = 84;

function pass1_injury(prospects) {
  console.log('\n[Pass 1] Injury ghost values');
  let count = 0;
  prospects.forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    if (r.injury > 25) return;
    const hasInjuryHistory = INJURY_KEYWORDS.test(p.notes || '');
    if (!hasInjuryHistory) {
      applyIf(r, 'injury', INJURY_CAL_P10, 1, name, p.pos,
        `ghost value (${r.injury}); no documented injury history → cal p10=${INJURY_CAL_P10}`);
      count++;
    } else {
      console.log(`  KEEP low: ${name} (${p.pos}) injury=${r.injury} (has injury history in notes)`);
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 2 — CB catching / catchInTraffic / spectacularCatch ghost values
// CBs need catching to intercept passes.
// Calibration FS min=51 avg=54, SS min=34 avg=55 → floor 45 for CBs
// catchInTraffic floor = 38, spectacularCatch floor = 30
// ---------------------------------------------------------------------------
const CB_CATCH_FLOOR    = 45;
const CB_CIT_FLOOR      = 38;
const CB_SPEC_FLOOR     = 30;

function pass2_cbCatching(prospects) {
  console.log('\n[Pass 2] CB catching ghost values');
  let count = 0;
  prospects.filter(p => p.pos === 'CB').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;

    const fixes = [
      ['catching',          CB_CATCH_FLOOR],
      ['catchInTraffic',    CB_CIT_FLOOR],
      ['spectacularCatch',  CB_SPEC_FLOOR],
    ];
    fixes.forEach(([attr, floor]) => {
      if (r[attr] < floor) {
        applyIf(r, attr, floor, 2, name, p.pos,
          `below CB ${attr} floor (${r[attr]} < ${floor})`);
        count++;
      }
    });
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 3 — CB changeOfDirection ghost (≤25) and release floor (≤20 → 30)
// changeOfDirection:0 breaks coverage footwork entirely.
// Calibration FS/SS CoD min=68-73 → floor 68 for CBs
// release:12-16 is physically implausible; floor = 30 (secondary stat for CBs)
// ---------------------------------------------------------------------------
const CB_COD_FLOOR     = 68;
const CB_RELEASE_FLOOR = 30;

function pass3_cbMovement(prospects) {
  console.log('\n[Pass 3] CB changeOfDirection + release ghost values');
  let count = 0;
  prospects.filter(p => p.pos === 'CB').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;

    if (r.changeOfDirection < CB_COD_FLOOR) {
      applyIf(r, 'changeOfDirection', CB_COD_FLOOR, 3, name, p.pos,
        `ghost CoD (${r.changeOfDirection} < floor ${CB_COD_FLOOR})`);
      count++;
    }
    if (r.release < CB_RELEASE_FLOOR) {
      applyIf(r, 'release', CB_RELEASE_FLOOR, 3, name, p.pos,
        `ghost release (${r.release} < floor ${CB_RELEASE_FLOOR})`);
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 4 — Ball-carrier attribute ghosts for WRs / HBs / TEs
// WRs run reverses, end-arounds; carrying:0 & ballCarrierVision:0 cause fumble logic issues.
// jukeMove:0, spinMove:0, stiffArm:0 affect YAC.
// Floor values are conservative (bottom of calibration WR range).
// ---------------------------------------------------------------------------
const WR_BALL_CARRIER_FLOORS = {
  carrying:          50,   // calibration WR carrying ~75-88; floor 50 prevents fumble bugs
  ballCarrierVision: 40,
  jukeMove:          38,
  spinMove:          30,
  stiffArm:          28,
  breakTackle:       28,
  trucking:          28,
};

// HBs should always have non-zero pass blocking for pass protection assignments
const HB_SECONDARY_FLOORS = {
  passBlockPower:    35,
  passBlockFinesse:  30,
};

function pass4_ballCarrier(prospects) {
  console.log('\n[Pass 4] Ball-carrier / secondary attribute ghosts (WR/HB)');
  let count = 0;

  // WR ball carrier floors
  prospects.filter(p => p.pos === 'WR').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    for (const [attr, floor] of Object.entries(WR_BALL_CARRIER_FLOORS)) {
      if (typeof r[attr] === 'number' && r[attr] < floor) {
        applyIf(r, attr, floor, 4, name, p.pos,
          `ghost value (${r[attr]} < WR floor ${floor})`);
        count++;
      }
    }
  });

  // HB pass block floors
  prospects.filter(p => p.pos === 'HB').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    for (const [attr, floor] of Object.entries(HB_SECONDARY_FLOORS)) {
      if (typeof r[attr] === 'number' && r[attr] < floor) {
        applyIf(r, attr, floor, 4, name, p.pos,
          `ghost value (${r[attr]} < HB floor ${floor})`);
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

  console.log('=== Polish Ratings 5 — Secondary Ghost Value Sweep ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  pass1_injury(prospects);
  pass2_cbCatching(prospects);
  pass3_cbMovement(prospects);
  pass4_ballCarrier(prospects);

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
