'use strict';
/**
 * polish_ratings2.js — Seven-pass accuracy improvement (round 2)
 *
 * Pass 1: QB throwAccuracy header sync with components
 * Pass 2: WR/TE route depth specialization (slot vs deep threat)
 * Pass 3: Injury ratings from notes history
 * Pass 4: DB coverage type specialization (man vs zone vs press)
 * Pass 5: Pass rusher power/finesse ratio enforcement
 * Pass 6: Size-based attribute adjustments
 * Pass 7: Speed/acceleration gap cap by position
 *
 * Usage:
 *   node scripts/polish_ratings2.js            # dry run
 *   node scripts/polish_ratings2.js --fix      # apply fixes
 *   node scripts/polish_ratings2.js --fix --rebuild
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
function applyIf(FIX, obj, attr, val, pass, name, pos, reason) {
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
// Pass 1 — QB throwAccuracy header sync
// Calibration shows header ≈ 88–97% of component average.
// If header > component average, bring it to 0.92 * average (calibration median).
// ---------------------------------------------------------------------------
function pass1_qbAccuracyHeader(prospects) {
  console.log('\n[Pass 1] QB throwAccuracy header sync');
  let count = 0;
  prospects.filter(p => p.pos === 'QB').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const avg  = (r.throwAccuracyShort + r.throwAccuracyMid + r.throwAccuracyDeep) / 3;
    const target = Math.round(avg * 0.92);
    if (r.throwAccuracy > avg) {
      applyIf(FIX, r, 'throwAccuracy', target, 1, name, p.pos,
        `header(${r.throwAccuracy}) > component avg(${Math.round(avg)}); target=0.92*avg`);
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 2 — WR/TE route depth specialization
// ---------------------------------------------------------------------------
const DEEP_THREAT_RE  = /deep[\s-]threat|vertical\s+(?:threat|stretcher|separation)|field.?stretch|go\s+route|threaten(?:s|ing)?\s+(?:deep|vertically)|natural\s+deep.ball/i;
// Must be a dedicated slot player — exclude players who also line up outside
const SLOT_RE         = /slot\s+(?:receiver|target|weapon|specialist)|possession\s+receiver|chain\s+mover|primarily.*slot|best.*slot/i;
const OUTSIDE_WR_RE   = /slot\s+(?:or|and)\s+outside|from\s+slot\s+or|outside\s+(?:or|and)\s+slot|X\s+receiver|Z\s+receiver|split\s+end/i;
const ROUTE_TECH_RE   = /elite\s+route|route\s+technician|precise\s+(?:route|footwork)|sharp\s+break/i;
const YAC_RE          = /YAC[\s-](?:heavy|threat|ability|specialist)|elite\s+YAC|dynamic\s+YAC|yards\s+after\s+catch|RAC\s+ability/i;

function pass2_routeDepth(prospects) {
  console.log('\n[Pass 2] WR/TE route depth specialization');
  let count = 0;
  prospects.filter(p => p.pos === 'WR' || p.pos === 'TE').forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const n    = p.notes || '';

    const isDeep   = DEEP_THREAT_RE.test(n);
    const isSlot   = SLOT_RE.test(n) && !OUTSIDE_WR_RE.test(n);  // exclude versatile outside/slot players
    const hasRoute = ROUTE_TECH_RE.test(n);
    const isYAC    = YAC_RE.test(n);

    if (isDeep && !isSlot) {
      // Pure deep threat: deepRouteRunning should be highest route, at least short+6
      const targetDeep = Math.max(r.deepRouteRunning, r.shortRouteRunning + 6, 80);
      if (r.deepRouteRunning < targetDeep) {
        applyIf(FIX, r, 'deepRouteRunning', clamp(targetDeep, 70, 99), 2, name, p.pos,
          `deep threat: deepRoute must lead short by 6+ (short=${r.shortRouteRunning})`);
        count++;
      }
      // Cap short route for pure speed/vertical guys who lack route technique
      if (!hasRoute && r.shortRouteRunning > 76) {
        applyIf(FIX, r, 'shortRouteRunning', 76, 2, name, p.pos,
          'deep threat (no route tech): shortRoute capped at 76');
        count++;
      }
    }

    if (isSlot && !isDeep) {
      // Slot/possession: shortRouteRunning should lead deep by at least 5
      const targetShort = Math.max(r.shortRouteRunning, r.deepRouteRunning + 5, 80);
      if (r.shortRouteRunning < targetShort) {
        applyIf(FIX, r, 'shortRouteRunning', clamp(targetShort, 72, 94), 2, name, p.pos,
          `slot receiver: shortRoute must lead deep by 5+ (deep=${r.deepRouteRunning})`);
        count++;
      }
      // Deep route naturally lower for pure slot guys
      if (r.deepRouteRunning > r.shortRouteRunning - 3) {
        const targetDeep = r.shortRouteRunning - 5;
        applyIf(FIX, r, 'deepRouteRunning', clamp(targetDeep, 65, 88), 2, name, p.pos,
          'slot receiver: deepRoute reduced below short');
        count++;
      }
    }

    if (isYAC) {
      // YAC threats are quick/physical — medRoute should be within 5 of short (shallow crosses)
      if (r.mediumRouteRunning < r.shortRouteRunning - 6) {
        const target = r.shortRouteRunning - 4;
        applyIf(FIX, r, 'mediumRouteRunning', clamp(target, 68, 90), 2, name, p.pos,
          'YAC threat: medRoute brought closer to short');
        count++;
      }
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 3 — Injury ratings from notes history
// Madden injury rating: 99=most durable, lower = more injury prone
// R1/R2 prospects normally 80-92; coming off major injury = 65-75
// ---------------------------------------------------------------------------
const MAJOR_INJURY_RE = /ACL|torn\s+(?:ligament|meniscus|labrum|tendon)|season\s+ending\s+injur|miss.*(?:entire|full|2025|2024)\s+season/i;
const MINOR_INJURY_RE = /injury\s+concern|injury\s+history|durability\s+concern|missed.*games|multiple.*injur/i;

function pass3_injuryRating(prospects) {
  console.log('\n[Pass 3] Injury ratings from notes history');
  let count = 0;
  prospects.forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const n    = p.notes || '';

    let target = r.injury;
    if (MAJOR_INJURY_RE.test(n) && (r.injury === undefined || r.injury > 72)) {
      target = 68; // coming off major surgery — noticeably fragile
    } else if (MINOR_INJURY_RE.test(n) && (r.injury === undefined || r.injury > 80)) {
      target = 76; // history of soft-tissue issues
    }

    if (target !== r.injury && target !== undefined) {
      applyIf(FIX, r, 'injury', target, 3, name, p.pos,
        MAJOR_INJURY_RE.test(n) ? 'major injury in notes' : 'injury history in notes');
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 4 — DB coverage type specialization
// Calibration: FS/SS always have zone > man (by 4-10 pts)
// CBs: man specialists should have manCoverage > zoneCoverage; zone specialists vice versa
// ---------------------------------------------------------------------------
const MAN_SPECIALIST_RE  = /man.{0,15}specialist|elite\s+man|press.{0,10}(?:specialist|corner|cover)|man.{0,15}corner|excels\s+in\s+man/i;
const ZONE_SPECIALIST_RE = /zone.{0,15}specialist|elite\s+zone|zone.{0,10}corner|excels\s+in\s+zone|cover.{0,10}two|off.{0,10}coverage\s+specialist/i;

function pass4_dbCoverage(prospects) {
  console.log('\n[Pass 4] DB coverage type specialization');
  let count = 0;
  prospects.forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const n    = p.notes || '';

    if (p.pos === 'FS' || p.pos === 'SS') {
      // Safeties: zone should always be >= man + 4 (calibration baseline)
      if (r.zoneCoverage < r.manCoverage + 4) {
        const target = r.manCoverage + 5;
        applyIf(FIX, r, 'zoneCoverage', clamp(target, 50, 95), 4, name, p.pos,
          'safety: zone should be >= man+4 (calibration norm)');
        count++;
      }
    } else if (p.pos === 'CB') {
      const isMan  = MAN_SPECIALIST_RE.test(n);
      const isZone = ZONE_SPECIALIST_RE.test(n);

      if (isMan && !isZone) {
        // Man specialist: ensure manCoverage > zoneCoverage by at least 5
        if (r.manCoverage <= r.zoneCoverage) {
          const target = r.zoneCoverage + 6;
          applyIf(FIX, r, 'manCoverage', clamp(target, 60, 99), 4, name, p.pos,
            'man specialist: manCoverage elevated above zone');
          count++;
        }
        if (r.zoneCoverage > r.manCoverage - 3) {
          const target = Math.max(r.manCoverage - 6, 60);
          applyIf(FIX, r, 'zoneCoverage', target, 4, name, p.pos,
            'man specialist: zoneCoverage reduced below man');
          count++;
        }
      } else if (isZone && !isMan) {
        // Zone specialist: ensure zoneCoverage > manCoverage by at least 5
        if (r.zoneCoverage <= r.manCoverage) {
          const target = r.manCoverage + 6;
          applyIf(FIX, r, 'zoneCoverage', clamp(target, 60, 99), 4, name, p.pos,
            'zone specialist: zoneCoverage elevated above man');
          count++;
        }
        if (r.manCoverage > r.zoneCoverage - 3) {
          const target = Math.max(r.zoneCoverage - 6, 55);
          applyIf(FIX, r, 'manCoverage', target, 4, name, p.pos,
            'zone specialist: manCoverage reduced below zone');
          count++;
        }
      }
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 5 — Pass rusher power/finesse ratio enforcement
// If notes clearly indicate one style, that move type should lead by 6+ pts
// ---------------------------------------------------------------------------
const POWER_RUSHER_RE   = /bull.?rush|power.?rush|dominant.*power|physical.*rush|violent.*hands|powerful.*rip/i;
const FINESSE_RUSHER_RE = /finesse.?rush|speed.?rush|elite.*(?:spin|swim|rip|dip)|counter\s+move|quick\s+first\s+step|lightning\s+first\s+step/i;

function pass5_passRusherRatio(prospects) {
  console.log('\n[Pass 5] Pass rusher power/finesse ratio');
  let count = 0;
  const rushers = prospects.filter(p => ['DE','OLB','DT'].includes(p.pos));
  rushers.forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const n    = p.notes || '';
    const isPower   = POWER_RUSHER_RE.test(n);
    const isFinesse = FINESSE_RUSHER_RE.test(n);

    if (isPower && !isFinesse) {
      // Power style: powerMoves should lead finesseMoves by at least 6
      if (r.powerMoves < r.finesseMoves + 6) {
        const target = r.finesseMoves + 7;
        applyIf(FIX, r, 'powerMoves', clamp(target, 50, 99), 5, name, p.pos,
          'power rusher: powerMoves lifted above finesse');
        count++;
      }
    } else if (isFinesse && !isPower) {
      // Finesse style: finesseMoves should lead powerMoves by at least 6
      if (r.finesseMoves < r.powerMoves + 6) {
        const target = r.powerMoves + 7;
        applyIf(FIX, r, 'finesseMoves', clamp(target, 50, 99), 5, name, p.pos,
          'finesse rusher: finesseMoves lifted above power');
        count++;
      }
    }
    // If both styles mentioned, leave at parity (already handled by Pass 5 of polish_ratings.js floors)
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 6 — Size-based attribute adjustments
// Parse height (feet'inches") and weight (Xlbs) from notes, apply adjustments
// ---------------------------------------------------------------------------
function parseSize(notes) {
  const htMatch = notes.match(/(\d)'(\d{1,2})[""]/);  // e.g. 6'4" or 6'4"
  const wtMatch = notes.match(/(\d{2,3})\s*lbs/);
  return {
    heightIn: htMatch ? parseInt(htMatch[1]) * 12 + parseInt(htMatch[2]) : null,
    weight:   wtMatch ? parseInt(wtMatch[1]) : null,
  };
}

function pass6_sizeAttributes(prospects) {
  console.log('\n[Pass 6] Size-based attribute adjustments');
  let count = 0;

  prospects.forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const { heightIn, weight } = parseSize(p.notes || '');
    if (!heightIn && !weight) return;

    // WR: tall WRs (≥75") — better catch in traffic, spectacular catch, contested catch window
    if (p.pos === 'WR' && heightIn !== null && heightIn >= 75) {
      if (r.catchInTraffic < 72) {
        applyIf(FIX, r, 'catchInTraffic', 72, 6, name, p.pos, `tall WR (${heightIn}") catchInTraffic floor`);
        count++;
      }
      if (r.spectacularCatch < 74) {
        applyIf(FIX, r, 'spectacularCatch', 74, 6, name, p.pos, `tall WR (${heightIn}") spectacularCatch floor`);
        count++;
      }
    }

    // WR: small/slot WRs (<71") — cap catchInTraffic and spectacularCatch, boost release
    if (p.pos === 'WR' && heightIn !== null && heightIn < 71) {
      if (r.catchInTraffic > 78) {
        applyIf(FIX, r, 'catchInTraffic', 78, 6, name, p.pos, `small WR (${heightIn}") catchInTraffic ceiling`);
        count++;
      }
    }

    // HB: heavy backs (≥220 lbs) — better trucking/stiffArm, cap jukeMove
    if (p.pos === 'HB' && weight !== null && weight >= 220) {
      if (r.trucking < 72) {
        applyIf(FIX, r, 'trucking', 72, 6, name, p.pos, `heavy HB (${weight}lbs) trucking floor`);
        count++;
      }
      if (r.stiffArm < 70) {
        applyIf(FIX, r, 'stiffArm', 70, 6, name, p.pos, `heavy HB (${weight}lbs) stiffArm floor`);
        count++;
      }
      if (r.jukeMove > 80) {
        applyIf(FIX, r, 'jukeMove', 80, 6, name, p.pos, `heavy HB (${weight}lbs) jukeMove ceiling`);
        count++;
      }
    }

    // HB: light/elusive backs (≤205 lbs) — better jukeMove/spinMove, cap trucking
    if (p.pos === 'HB' && weight !== null && weight <= 205) {
      if (r.trucking > 72) {
        applyIf(FIX, r, 'trucking', 72, 6, name, p.pos, `light HB (${weight}lbs) trucking ceiling`);
        count++;
      }
    }

    // CB: big CBs (≥72", ≥195 lbs) — better press coverage, cap short-area quickness ceiling
    if (p.pos === 'CB' && heightIn !== null && heightIn >= 72) {
      if (r.pressCoverage < 76) {
        applyIf(FIX, r, 'pressCoverage', 76, 6, name, p.pos, `big CB (${heightIn}") pressCoverage floor`);
        count++;
      }
    }
    // Small CBs (<70") — lower press ceiling
    if (p.pos === 'CB' && heightIn !== null && heightIn < 70) {
      if (r.pressCoverage > 80) {
        applyIf(FIX, r, 'pressCoverage', 80, 6, name, p.pos, `small CB (${heightIn}") pressCoverage ceiling`);
        count++;
      }
    }

    // DE/OLB: big edge rushers (≥255 lbs) — better powerMoves floor, cap finesse ceiling slightly
    if ((p.pos === 'DE' || p.pos === 'OLB') && weight !== null && weight >= 255) {
      if (r.strength < 72) {
        applyIf(FIX, r, 'strength', 72, 6, name, p.pos, `big DE/OLB (${weight}lbs) strength floor`);
        count++;
      }
      if (r.powerMoves < 72) {
        applyIf(FIX, r, 'powerMoves', 72, 6, name, p.pos, `big DE/OLB (${weight}lbs) powerMoves floor`);
        count++;
      }
    }

    // OL: large OL (≥315 lbs) — better run block, strength
    if (['T','G','C'].includes(p.pos) && weight !== null && weight >= 315) {
      if (r.runBlock < 74) {
        applyIf(FIX, r, 'runBlock', 74, 6, name, p.pos, `heavy OL (${weight}lbs) runBlock floor`);
        count++;
      }
      if (r.strength < 74) {
        applyIf(FIX, r, 'strength', 74, 6, name, p.pos, `heavy OL (${weight}lbs) strength floor`);
        count++;
      }
    }

    // TE: tall TEs (≥76") — better catch radius, spectacularCatch
    if (p.pos === 'TE' && heightIn !== null && heightIn >= 76) {
      if (r.spectacularCatch < 70) {
        applyIf(FIX, r, 'spectacularCatch', 70, 6, name, p.pos, `tall TE (${heightIn}") spectacularCatch floor`);
        count++;
      }
      if (r.catchInTraffic < 70) {
        applyIf(FIX, r, 'catchInTraffic', 70, 6, name, p.pos, `tall TE (${heightIn}") catchInTraffic floor`);
        count++;
      }
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 7 — Speed/acceleration gap cap by position
// Calibration max gaps: WR=6, HB=5, QB=5, FS/SS=10, CB=15, TE/OLB=8, DE/DT/OL=10
// When gap exceeds max, bring acceleration up toward speed
// ---------------------------------------------------------------------------
const MAX_SPD_ACC_GAP = {
  WR:6, HB:5, QB:5, FS:10, SS:10, CB:15,
  TE:8, OLB:8, MLB:8, DE:10, DT:10,
  T:10, G:10, C:10,
};

function pass7_spdAccGap(prospects) {
  console.log('\n[Pass 7] Speed/acceleration gap cap by position');
  let count = 0;
  prospects.forEach(p => {
    const r    = p.ratings;
    const name = `${p.firstName} ${p.lastName}`;
    const maxGap = MAX_SPD_ACC_GAP[p.pos] || 12;
    const gap    = r.speed - r.acceleration;
    if (Math.abs(gap) > maxGap) {
      // Adjust acceleration to be within maxGap of speed
      const target = gap > 0
        ? r.speed - maxGap       // accel too low vs speed: bring accel up
        : r.speed + maxGap;      // accel too high vs speed: bring accel down
      applyIf(FIX, r, 'acceleration', clamp(target, 40, 99), 7, name, p.pos,
        `spd(${r.speed}) acc(${r.acceleration}) gap(${gap}) > max(${maxGap})`);
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_RATED, 'utf8'));

  console.log('=== Polish Ratings 2 — 7-Pass Improvement ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  pass1_qbAccuracyHeader(prospects);
  pass2_routeDepth(prospects);
  pass3_injuryRating(prospects);
  pass4_dbCoverage(prospects);
  pass5_passRusherRatio(prospects);
  pass6_sizeAttributes(prospects);
  pass7_spdAccGap(prospects);

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
