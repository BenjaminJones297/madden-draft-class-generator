'use strict';
/**
 * polish_ratings3.js — Six-pass accuracy improvement (round 3)
 *
 * Pass 1: QB pocket vs mobile attribute calibration (throwOnTheRun, throwUnderPressure, breakSack)
 * Pass 2: Stamina/toughness calibration floors by position
 * Pass 3: School prestige → awareness bonus/penalty
 * Pass 4: Stats-based production cross-checks (sacks, INTs, PBUs, receptions)
 * Pass 5: OL zone vs power blocking scheme differentiation
 * Pass 6: Catching component consistency (catchInTraffic/spectacularCatch gap cap)
 *
 * Usage:
 *   node scripts/polish_ratings3.js            # dry run
 *   node scripts/polish_ratings3.js --fix      # apply fixes
 *   node scripts/polish_ratings3.js --fix --rebuild
 */

const fs   = require('fs');
const path = require('path');

const ROOT            = path.join(__dirname, '..');
const PROSPECTS_RATED = path.join(ROOT, 'data', 'prospects_rated.json');
const PROSPECTS_2026  = path.join(ROOT, 'data', 'prospects_2026.json');
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
// Pass 1 — QB pocket vs mobile attribute calibration
// Calibration ranges:
//   Mobile (spd ≥ 85): breakSack 64-78, throwOnTheRun 77-82
//   Pocket (spd < 82): throwUnderPressure 72-81, throwOnTheRun 72-79
// ---------------------------------------------------------------------------
function pass1_qbMobility(prospects) {
  console.log('\n[Pass 1] QB pocket vs mobile calibration');
  let count = 0;
  prospects.filter(p => p.pos === 'QB').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;

    if (r.speed >= 85) {
      // Mobile QB: enforce breakSack and throwOnTheRun floors
      if (r.breakSack < 70) {
        applyIf(r, 'breakSack', 70, 1, name, p.pos, `mobile QB (spd=${r.speed}): breakSack floor 70`);
        count++;
      }
      if (r.throwOnTheRun < 80) {
        applyIf(r, 'throwOnTheRun', 80, 1, name, p.pos, `mobile QB (spd=${r.speed}): throwOnTheRun floor 80`);
        count++;
      }
    } else if (r.speed < 82) {
      // Pocket QB: enforce throwUnderPressure floor
      if (r.throwUnderPressure < 74) {
        applyIf(r, 'throwUnderPressure', 74, 1, name, p.pos, `pocket QB (spd=${r.speed}): throwUnderPressure floor 74`);
        count++;
      }
      // Pocket QBs shouldn't have very high throwOnTheRun (cap at 82 for calibration consistency)
      if (r.throwOnTheRun > 83) {
        applyIf(r, 'throwOnTheRun', 83, 1, name, p.pos, `pocket QB (spd=${r.speed}): throwOnTheRun ceiling 83`);
        count++;
      }
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 2 — Stamina/toughness calibration floors by position
// From calibration minimums; also boost for high-motor notes
// ---------------------------------------------------------------------------
const STAM_TOUGH_FLOORS = {
  QB:  { stam: 81, tough: 81 },
  HB:  { stam: 81, tough: 81 },
  WR:  { stam: 79, tough: 78 },
  TE:  { stam: 79, tough: 78 },
  T:   { stam: 81, tough: 79 },
  G:   { stam: 80, tough: 81 },
  C:   { stam: 77, tough: 80 },
  DE:  { stam: 75, tough: 81 },
  DT:  { stam: 81, tough: 80 },
  OLB: { stam: 73, tough: 82 },
  MLB: { stam: 73, tough: 78 },
  CB:  { stam: 70, tough: 81 },
  FS:  { stam: 82, tough: 85 },
  SS:  { stam: 79, tough: 83 },
};

// Fallback for unmapped positions
const DEFAULT_FLOORS = { stam: 73, tough: 78 };

const HIGH_MOTOR_RE    = /high[\s-]motor|elite\s+motor|relentless\s+(?:effort|worker|pursuit)|tireless|workhorse|plays\s+through|warrior\s+mentality|grind|never\s+(?:quit|stop)/i;
const CONCERN_RE       = /conditioning\s+concern|weight\s+(?:issue|concern)|character\s+concern|effort\s+question|motor\s+(?:issue|question)|inconsistent\s+effort/i;

function pass2_staminaToughness(prospects) {
  console.log('\n[Pass 2] Stamina/toughness calibration floors');
  let count = 0;
  prospects.forEach(p => {
    const r       = p.ratings;
    const name    = `${p.firstName} ${p.lastName}`;
    const floors  = STAM_TOUGH_FLOORS[p.pos] || DEFAULT_FLOORS;
    const hasMotor   = HIGH_MOTOR_RE.test(p.notes || '');
    const hasConcern = CONCERN_RE.test(p.notes || '');

    let stamFloor  = floors.stam;
    let toughFloor = floors.tough;

    if (hasMotor) {
      stamFloor  = Math.min(99, stamFloor + 7);
      toughFloor = Math.min(99, toughFloor + 5);
    }
    if (hasConcern) {
      stamFloor  = Math.max(55, stamFloor - 12);
      toughFloor = Math.max(55, toughFloor - 8);
    }

    if (r.stamina < stamFloor) {
      applyIf(r, 'stamina', stamFloor, 2, name, p.pos,
        `below calibration floor (${r.stamina} < ${stamFloor})` + (hasMotor ? ' +motor bonus' : ''));
      count++;
    }
    if (r.toughness < toughFloor) {
      applyIf(r, 'toughness', toughFloor, 2, name, p.pos,
        `below calibration floor (${r.toughness} < ${toughFloor})` + (hasMotor ? ' +motor bonus' : ''));
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 3 — School prestige → awareness bonus
// Top-tier NFL pipeline programs produce more football-IQ-ready players
// ---------------------------------------------------------------------------
const SCHOOL_TIERS = {
  // Tier 1: elite systems, complex playbooks, NFL coaching trees (+3)
  tier1: new Set([
    'Alabama','Georgia','Ohio State','LSU','Clemson','Michigan','Notre Dame',
    'Oklahoma','Florida State',
  ]),
  // Tier 2: strong P4 programs with NFL development (+1)
  tier2: new Set([
    'Texas','Penn State','USC','Oregon','Auburn','Florida','Washington',
    'Miami (FL)','Texas A&M','Indiana','Kentucky','Utah','Tennessee',
    'North Carolina','Missouri','Arkansas','Stanford','Ole Miss',
  ]),
  // Tier 3: mid-major or smaller programs (−2)
  tier3: new Set([
    'North Dakota State','Connecticut','San Diego State','Troy','New Hampshire',
    'Utah State','UCF','Tulane','Vanderbilt','Arizona','Arizona State','Duke',
    'Illinois',
  ]),
};

function pass3_schoolPrestige(prospects, prospects2026) {
  console.log('\n[Pass 3] School prestige → awareness');
  let count = 0;

  // Build name→school lookup from raw 2026 data
  const schoolMap = {};
  prospects2026.forEach(p => {
    const key = `${p.first_name || p.firstName} ${p.last_name || p.lastName}`;
    schoolMap[key] = p.school;
  });

  prospects.forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const school = schoolMap[name];
    if (!school) return;

    let bonus = 0;
    if (SCHOOL_TIERS.tier1.has(school)) bonus = 3;
    else if (SCHOOL_TIERS.tier3.has(school)) bonus = -2;

    if (bonus === 0) return;

    const roundFloor = p.draftRound === 1 ? 68 : 62;
    const target = clamp(r.awareness + bonus, roundFloor, 88);
    if (target !== r.awareness) {
      applyIf(r, 'awareness', target, 3, name, p.pos,
        `${school} (tier${bonus > 0 ? '1 +' + bonus : '3 ' + bonus})`);
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 4 — Stats-based production cross-checks
// Parse sacks, TFLs, INTs, PBUs, receptions from notes
// ---------------------------------------------------------------------------
function extractStat(notes, pattern) {
  const m = notes.match(pattern);
  return m ? parseFloat(m[1].replace(',', '')) : null;
}

function pass4_statsProduction(prospects) {
  console.log('\n[Pass 4] Stats-based production cross-checks');
  let count = 0;

  prospects.forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const n    = p.notes || '';

    const sacks = extractStat(n, /(\d+(?:\.\d+)?)\s+sacks/i);
    const tfls  = extractStat(n, /(\d+(?:\.\d+)?)\s+TFLs/i);
    const ints  = extractStat(n, /(\d+)\s+INTs/i);
    const pbus  = extractStat(n, /(\d+)\s+PBUs/i);
    const recs  = extractStat(n, /(\d+)\s+receptions/i);

    // Pass rushers: elite sack production → blockShedding floor
    if (['DE','OLB','DT'].includes(p.pos)) {
      if (sacks !== null && sacks >= 12 && r.blockShedding < 82) {
        applyIf(r, 'blockShedding', 82, 4, name, p.pos, `${sacks} sacks → blockShedding floor 82`);
        count++;
      } else if (sacks !== null && sacks >= 8 && r.blockShedding < 78) {
        applyIf(r, 'blockShedding', 78, 4, name, p.pos, `${sacks} sacks → blockShedding floor 78`);
        count++;
      }
      if (tfls !== null && tfls >= 15 && r.blockShedding < 80) {
        applyIf(r, 'blockShedding', 80, 4, name, p.pos, `${tfls} TFLs → blockShedding floor 80`);
        count++;
      }
      if (tfls !== null && tfls >= 20 && r.pursuit < 80) {
        applyIf(r, 'pursuit', 80, 4, name, p.pos, `${tfls} TFLs → pursuit floor 80`);
        count++;
      }
    }

    // DBs: interception production → playRecognition floor
    if (['CB','FS','SS','MLB','OLB'].includes(p.pos)) {
      if (ints !== null && ints >= 4 && r.playRecognition < 82) {
        applyIf(r, 'playRecognition', 82, 4, name, p.pos, `${ints} INTs → playRecognition floor 82`);
        count++;
      }
      if (pbus !== null && pbus >= 8 && r.playRecognition < 80) {
        applyIf(r, 'playRecognition', 80, 4, name, p.pos, `${pbus} PBUs → playRecognition floor 80`);
        count++;
      }
    }

    // Receiving HBs: high reception count → catching and shortRouteRunning floor
    if (p.pos === 'HB') {
      if (recs !== null && recs >= 60 && r.catching < 75) {
        applyIf(r, 'catching', 75, 4, name, p.pos, `${recs} receptions → catching floor 75`);
        count++;
      }
      if (recs !== null && recs >= 40 && r.shortRouteRunning < 70) {
        applyIf(r, 'shortRouteRunning', 70, 4, name, p.pos, `${recs} receptions → shortRouteRunning floor 70`);
        count++;
      }
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 5 — OL zone vs power blocking scheme
// ---------------------------------------------------------------------------
const ZONE_BLOCKER_RE  = /zone[\s-](?:block|scheme)|athletic\s+(?:blocker|OL)|nimble|movement\s+blocker|reach\s+block/i;
const POWER_BLOCKER_RE = /(?:power\s+block|mauler|drive\s+block|dominate(?:s|ing)?\s+(?:at\s+point|the\s+point)|physical\s+(?:nasty|dominant|blocker))/i;

function pass5_olScheme(prospects) {
  console.log('\n[Pass 5] OL zone vs power blocking scheme');
  let count = 0;
  prospects.filter(p => ['T','G','C'].includes(p.pos)).forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const n    = p.notes || '';

    const isZone  = ZONE_BLOCKER_RE.test(n);
    const isPower = POWER_BLOCKER_RE.test(n);

    if (isZone && !isPower) {
      // Zone scheme: finesse variants should lead power by 4+
      for (const [fin, pow] of [['runBlockFinesse','runBlockPower'],['passBlockFinesse','passBlockPower']]) {
        if (r[fin] < r[pow] + 4) {
          const target = r[pow] + 5;
          applyIf(r, fin, clamp(target, 60, 99), 5, name, p.pos,
            `zone blocker: ${fin} lifted above ${pow}`);
          count++;
        }
      }
    } else if (isPower && !isZone) {
      // Power scheme: power variants should lead finesse by 4+
      for (const [pow, fin] of [['runBlockPower','runBlockFinesse'],['passBlockPower','passBlockFinesse']]) {
        if (r[pow] < r[fin] + 4) {
          const target = r[fin] + 5;
          applyIf(r, pow, clamp(target, 60, 99), 5, name, p.pos,
            `power blocker: ${pow} lifted above ${fin}`);
          count++;
        }
      }
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 6 — Catching component consistency
// catchInTraffic and spectacularCatch should be within 12 pts of catching
// ---------------------------------------------------------------------------
function pass6_catchingComponents(prospects) {
  console.log('\n[Pass 6] Catching component consistency');
  let count = 0;
  prospects.filter(p => ['WR','TE','HB'].includes(p.pos)).forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const base = r.catching;

    for (const attr of ['catchInTraffic','spectacularCatch']) {
      if (typeof r[attr] !== 'number') continue;
      const gap = base - r[attr];
      if (gap > 12) {
        const target = base - 12;
        applyIf(r, attr, clamp(target, 55, 99), 6, name, p.pos,
          `${attr}(${r[attr]}) lags catching(${base}) by ${gap} pts; capped at base-12`);
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
  const prospects    = JSON.parse(fs.readFileSync(PROSPECTS_RATED, 'utf8'));
  const prospects2026 = JSON.parse(fs.readFileSync(PROSPECTS_2026, 'utf8'));

  console.log('=== Polish Ratings 3 — 6-Pass Improvement ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  pass1_qbMobility(prospects);
  pass2_staminaToughness(prospects);
  pass3_schoolPrestige(prospects, prospects2026);
  pass4_statsProduction(prospects);
  pass5_olScheme(prospects);
  pass6_catchingComponents(prospects);

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
