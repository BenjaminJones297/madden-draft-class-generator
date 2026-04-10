'use strict';
/**
 * polish_ratings.js — Six-pass rating accuracy improvement
 *
 * Pass 1: Combine → attribute correlations (vertical→jumping, bench→strength, cone/shuttle→agility+CoD)
 * Pass 2: Dev trait calibration (grade + round → Normal/Impact/Star)
 * Pass 3: Overall vs grade/rank alignment (within-position rank ordering + calibration clamp)
 * Pass 4: Position key ratings validation (skill-specific bounds from calibration)
 * Pass 5: Notes-based cross-checks (keyword→rating floor enforcement)
 * Pass 6: Awareness scaling (floor/ceiling by round)
 *
 * Usage:
 *   node scripts/polish_ratings.js            # dry run (report only)
 *   node scripts/polish_ratings.js --fix      # apply all fixes
 *   node scripts/polish_ratings.js --fix --rebuild
 */

const fs   = require('fs');
const path = require('path');

const ROOT            = path.join(__dirname, '..');
const CALIBRATION     = path.join(ROOT, 'data', 'calibration_set.json');
const PROSPECTS_RATED = path.join(ROOT, 'data', 'prospects_rated.json');
const OUTPUT_FILE     = path.join(ROOT, 'data', 'output', '2026_draft_class.draftclass');

const FIX     = process.argv.includes('--fix');
const REBUILD = process.argv.includes('--rebuild');

// Known-misaligned calibration groups (same as validate_ratings.js)
const MISALIGNED = new Set(['CB', 'DE']);

const POS_FALLBACKS = {
  EDGE:['OLB','DE'], ILB:['MLB','OLB'], LB:['OLB','MLB'],
  OLB:['MLB'], MLB:['OLB'],
  OT:['T'], LT:['T'], RT:['T'],
  OG:['G'], LG:['G'], RG:['G'],
  NT:['DT'], DE:['OLB','DT'],
  CB:['FS','SS'], FS:['SS'], SS:['FS'],
  S:['FS','SS'], DB:['CB','FS'],
  RB:['HB'], PK:['K'],
};

function resolveCal(pos, cal) {
  if (cal[pos] && !MISALIGNED.has(pos)) return cal[pos];
  for (const fb of (POS_FALLBACKS[pos] || [])) {
    if (cal[fb] && !MISALIGNED.has(fb)) return cal[fb];
  }
  return null;
}

function percentile(sorted, p) {
  return sorted[Math.floor(sorted.length * p)];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
const changes = [];
function log(pass, name, pos, attr, before, after, reason) {
  changes.push({ pass, name, pos, attr, before, after, reason });
}
function report() {
  const byPass = {};
  changes.forEach(c => {
    (byPass[c.pass] = byPass[c.pass] || []).push(c);
  });
  Object.entries(byPass).forEach(([pass, list]) => {
    console.log(`\n── Pass ${pass} ──────────────────────────────────`);
    list.forEach(c => {
      console.log(`  ${c.name.padEnd(26)} ${c.pos.padEnd(5)} ${c.attr.padEnd(22)} ${String(c.before).padStart(3)} → ${String(c.after).padStart(3)}  (${c.reason})`);
    });
  });
}

// ---------------------------------------------------------------------------
// Pass 1 — Combine → attribute correlations
// ---------------------------------------------------------------------------
function buildCombineCurve(calAll, combineField, ratingField) {
  const points = calAll
    .filter(p => p.profile[combineField] && typeof p.ratings[ratingField] === 'number')
    .map(p => ({ x: p.profile[combineField], y: p.ratings[ratingField] }));
  if (points.length < 5) return null;
  return points;
}

function interpolateCurve(points, x) {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const lo = sorted.filter(p => p.x <= x).pop();
  const hi = sorted.find(p => p.x >= x);
  if (!lo) return Math.round(hi.y);
  if (!hi) return Math.round(lo.y);
  if (lo.x === hi.x) return Math.round((lo.y + hi.y) / 2);
  const t = (x - lo.x) / (hi.x - lo.x);
  return Math.round(lo.y + t * (hi.y - lo.y));
}

function pass1_combine(prospects, cal) {
  console.log('\n[Pass 1] Combine → attribute correlations');
  const all = Object.values(cal).flat();

  const curves = {
    bench:   { field: 'strength',         curve: buildCombineCurve(all, 'bench',   'strength') },
    vertical:{ field: 'jumping',          curve: buildCombineCurve(all, 'vertical','jumping') },
    cone:    { field: 'changeOfDirection', curve: buildCombineCurve(all, 'cone',    'changeOfDirection') },
    shuttle: { field: 'agility',           curve: buildCombineCurve(all, 'shuttle', 'agility') },
  };

  // Parse measurements out of notes text
  const MEASURE_RE = {
    vertical: /(\d+(?:\.\d+)?)["\u201c\u2019\u0022']?\s*(?:vertical|vert)/i,
    bench:    /(\d+)\s*(?:bench\s*(?:reps?|press)|reps?\s*at\s*225)/i,
    cone:     /(\d+\.\d+)\s*(?:three|3)[\s-]*cone/i,
    shuttle:  /(\d+\.\d+)\s*(?:short\s*)?shuttle/i,
  };

  let count = 0;
  prospects.forEach(p => {
    const name = `${p.firstName} ${p.lastName}`;
    for (const [measureKey, { field, curve }] of Object.entries(curves)) {
      if (!curve) continue;
      let val = p[measureKey] || null;

      // Try to parse from notes if not in structured data
      if (!val && p.notes && MEASURE_RE[measureKey]) {
        const m = p.notes.match(MEASURE_RE[measureKey]);
        if (m) val = parseFloat(m[1]);
      }
      if (!val) continue;

      const expected = interpolateCurve(curve, val);
      const actual   = p.ratings[field];
      const diff     = Math.abs(actual - expected);

      // Only correct if off by 5+ points
      if (diff >= 5) {
        log(1, name, p.pos, field, actual, expected, `${measureKey}=${val}`);
        if (FIX) p.ratings[field] = expected;
        count++;
      }
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 2 — Dev trait calibration
// ---------------------------------------------------------------------------
// M26 dev trait values: 0=Normal, 1=Impact, 2=Star, 3=XFactor
// Calibration ground truth (R1: mostly 1, ~4 have 2 / R2: mix 0-1 / R3+: mostly 0)
const GRADE_ORDER = ['A+','A','A-','B+','B','B-','C+','C','C-'];
function gradeRank(grade) { return GRADE_ORDER.indexOf(grade ?? 'C'); }

function pass2_devTrait(prospects) {
  console.log('\n[Pass 2] Dev trait calibration');
  let count = 0;
  prospects.forEach(p => {
    const name = `${p.firstName} ${p.lastName}`;
    const gr   = gradeRank(p.grade);
    const pick = p.rank || 999;
    let target;

    if (p.draftRound === 1 && gr <= 1 && pick <= 10) {
      target = 2; // Star — elite R1 (A+ or A, top 10)
    } else if (p.draftRound === 1) {
      target = 1; // Impact — rest of R1
    } else if (p.draftRound === 2 && gr <= 2) {
      target = 1; // Impact — top-grade R2 (A+/A/A-)
    } else {
      target = 0; // Normal — later R2, low grades
    }

    if (p.ratings.devTrait !== target) {
      log(2, name, p.pos, 'devTrait', p.ratings.devTrait, target,
          `R${p.draftRound} pick${pick} grade=${p.grade}`);
      if (FIX) p.ratings.devTrait = target;
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 3 — Overall vs grade/rank alignment
// ---------------------------------------------------------------------------
function pass3_overall(prospects, cal) {
  console.log('\n[Pass 3] Overall vs grade/rank alignment');
  const all = Object.values(cal).flat();
  let count = 0;

  // Build per-position overall range from calibration R1 as ceiling guide
  const posR1Ranges = {};
  all.filter(p => p.profile.draft_round === 1).forEach(p => {
    const pos = p.profile.pos;
    if (!posR1Ranges[pos]) posR1Ranges[pos] = [];
    posR1Ranges[pos].push(p.ratings.overall);
  });
  const r1Max = {};
  const r1Min = {};
  Object.entries(posR1Ranges).forEach(([pos, vals]) => {
    vals.sort((a, b) => a - b);
    r1Max[pos] = vals[vals.length - 1] + 3; // allow +3 above calibration max
    r1Min[pos] = vals[0] - 3;               // allow -3 below calibration min
  });

  // Within each position group, ensure rank ordering is preserved
  const byPos = {};
  prospects.forEach(p => (byPos[p.pos] = byPos[p.pos] || []).push(p));

  Object.entries(byPos).forEach(([pos, group]) => {
    // Sort by rank (lower rank = better prospect)
    group.sort((a, b) => (a.rank || 999) - (b.rank || 999));

    // Ensure rank ordering: each prospect's overall >= next prospect's overall
    for (let i = 0; i < group.length - 1; i++) {
      const better = group[i];
      const worse  = group[i + 1];
      if (better.ratings.overall < worse.ratings.overall) {
        const swapped = worse.ratings.overall;
        log(3, `${better.firstName} ${better.lastName}`, pos, 'overall',
            better.ratings.overall, swapped,
            `rank${better.rank} should be >= rank${worse.rank}`);
        if (FIX) better.ratings.overall = swapped;
        count++;
      }
    }

    // Clamp against calibration R1 range (resolve fallback positions)
    const calPos = MISALIGNED.has(pos) ? null : pos;
    const lo = calPos && r1Min[calPos] ? r1Min[calPos] : 60;
    const hi = calPos && r1Max[calPos] ? r1Max[calPos] : 90;

    group.forEach(p => {
      const clamped = clamp(p.ratings.overall, lo, hi);
      if (clamped !== p.ratings.overall) {
        log(3, `${p.firstName} ${p.lastName}`, pos, 'overall',
            p.ratings.overall, clamped, `outside calibration range [${lo}–${hi}]`);
        if (FIX) p.ratings.overall = clamped;
        count++;
      }
    });
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 4 — Position key ratings validation
// ---------------------------------------------------------------------------
// Key attributes per position group to validate against calibration bounds
const POS_KEY_ATTRS = {
  QB:  ['throwPower','throwAccuracy','throwAccuracyShort','throwAccuracyMid','throwAccuracyDeep',
        'throwOnTheRun','throwUnderPressure','playAction','breakSack'],
  HB:  ['carrying','ballCarrierVision','breakTackle','trucking','stiffArm','spinMove','jukeMove'],
  WR:  ['catching','catchInTraffic','spectacularCatch','shortRouteRunning','mediumRouteRunning',
        'deepRouteRunning','release'],
  TE:  ['catching','catchInTraffic','runBlock','passBlock','impactBlocking'],
  T:   ['passBlock','passBlockPower','passBlockFinesse','runBlock','runBlockPower','runBlockFinesse',
        'impactBlocking'],
  G:   ['passBlock','passBlockPower','passBlockFinesse','runBlock','runBlockPower','runBlockFinesse',
        'impactBlocking'],
  C:   ['passBlock','passBlockPower','passBlockFinesse','runBlock','runBlockPower','runBlockFinesse',
        'impactBlocking'],
  DE:  ['blockShedding','finesseMoves','powerMoves','tackle','hitPower','pursuit'],
  DT:  ['blockShedding','finesseMoves','powerMoves','tackle','hitPower','pursuit'],
  OLB: ['blockShedding','tackle','hitPower','pursuit','zoneCoverage','manCoverage','playRecognition'],
  MLB: ['tackle','hitPower','pursuit','zoneCoverage','manCoverage','playRecognition'],
  CB:  ['manCoverage','zoneCoverage','pressCoverage','playRecognition','tackle','release'],
  FS:  ['zoneCoverage','manCoverage','playRecognition','tackle','hitPower'],
  SS:  ['tackle','hitPower','zoneCoverage','manCoverage','playRecognition','pursuit'],
};

function pass4_posKeyRatings(prospects, cal) {
  console.log('\n[Pass 4] Position key ratings validation');
  let count = 0;

  // Build bounds per position for key attrs
  const bounds = {};
  Object.entries(cal).forEach(([pos, players]) => {
    bounds[pos] = {};
    const allAttrs = new Set(Object.values(POS_KEY_ATTRS).flat());
    allAttrs.forEach(attr => {
      const vals = players.map(p => p.ratings[attr]).filter(v => typeof v === 'number').sort((a,b)=>a-b);
      if (vals.length < 3) return;
      bounds[pos][attr] = {
        p10: percentile(vals, 0.10),
        p90: percentile(vals, 0.90),
        hardLo: Math.max(0,  vals[0] - 5),
        hardHi: Math.min(99, vals[vals.length-1] + 5),
      };
    });
  });

  prospects.forEach(p => {
    const name = `${p.firstName} ${p.lastName}`;
    const pos  = p.pos;
    const calPlayers = resolveCal(pos, cal);
    if (!calPlayers) return;

    // Determine which bounds key to use
    let boundsKey = pos;
    if (MISALIGNED.has(pos)) {
      boundsKey = (POS_FALLBACKS[pos] || []).find(fb => bounds[fb] && !MISALIGNED.has(fb));
    }
    if (!boundsKey || !bounds[boundsKey]) return;
    const b = bounds[boundsKey];

    const attrs = POS_KEY_ATTRS[pos] || POS_KEY_ATTRS[boundsKey] || [];
    attrs.forEach(attr => {
      if (!b[attr]) return;
      const actual = p.ratings[attr];
      if (typeof actual !== 'number') return;
      const { hardLo, hardHi } = b[attr];
      const clamped = clamp(actual, hardLo, hardHi);
      if (clamped !== actual) {
        log(4, name, pos, attr, actual, clamped, `outside hard bounds [${hardLo}–${hardHi}]`);
        if (FIX) p.ratings[attr] = clamped;
        count++;
      }
    });
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 5 — Notes-based cross-checks
// ---------------------------------------------------------------------------
// Each rule: { pattern, pos (optional), attr, floor?, ceiling?, reason }
const NOTES_RULES = [
  // Speed / athleticism
  { p: /elite speed|blazing speed|elite athleticism|elite athlete/i,   attr:'speed',         floor:91 },
  { p: /elite acceleration|explosive burst|elite burst/i,              attr:'acceleration',  floor:91 },
  { p: /lacks.*speed|limited.*speed|not.*fast|slow.*for/i,             attr:'speed',         ceiling:83, pos:['WR','CB','HB','TE'] },

  // QB
  { p: /elite accuracy|pinpoint accuracy|exceptional accuracy/i,       attr:'throwAccuracy', floor:82, pos:['QB'] },
  { p: /elite arm|cannon arm|elite arm talent|strong arm/i,            attr:'throwPower',    floor:88, pos:['QB'] },
  { p: /elite deep ball|elite downfield/i,                             attr:'throwAccuracyDeep', floor:80, pos:['QB'] },
  { p: /elite mobility|elite scramble|elite rusher/i,                  attr:'speed',         floor:88, pos:['QB'] },
  { p: /limited mobility|immobile|not a runner/i,                      attr:'speed',         ceiling:72, pos:['QB'] },

  // WR
  { p: /elite route|precise route|route.*technician|sharp.*break/i,   attr:'shortRouteRunning', floor:82, pos:['WR','TE'] },
  { p: /elite hands|reliable.*catch|exceptional.*catch/i,             attr:'catching',       floor:84, pos:['WR','TE'] },
  { p: /elite YAC|dynamic YAC|yards.*after.*catch/i,                  attr:'breakTackle',    floor:74, pos:['WR','HB'] },
  { p: /elite separation|elite release/i,                              attr:'release',        floor:84, pos:['WR','CB'] },

  // CB / DB
  { p: /elite press|press.*master|elite man.*cover|elite.*mirror/i,   attr:'pressCoverage',  floor:85, pos:['CB','SS','FS'] },
  { p: /elite man.*cover|elite.*mirror|man.*specialist/i,             attr:'manCoverage',    floor:85, pos:['CB','SS','FS'] },
  { p: /elite zone|zone.*specialist/i,                                 attr:'zoneCoverage',   floor:85, pos:['CB','SS','FS'] },
  { p: /elite ball.*skill|exceptional.*ball.*skill|ball.*hawk/i,      attr:'playRecognition',floor:83, pos:['CB','SS','FS','MLB','OLB'] },

  // Pass rushers
  { p: /elite pass.?rush|elite edge/i,                                 attr:'blockShedding',  floor:82, pos:['DE','OLB','DT'] },
  { p: /bull.?rush|power.?rusher|dominant.*power/i,                   attr:'powerMoves',     floor:82, pos:['DE','OLB','DT'] },
  { p: /finesse.?mover|speed.?rusher|elite.*spin|elite.*swim/i,       attr:'finesseMoves',   floor:82, pos:['DE','OLB','DT'] },

  // OL
  { p: /elite pass.?block|dominant.*pass.?block/i,                    attr:'passBlock',      floor:82, pos:['T','G','C'] },
  { p: /elite run.?block|dominant.*run.?block|mauler/i,               attr:'runBlock',       floor:82, pos:['T','G','C'] },

  // LB
  { p: /elite tackl|sure.*tackl|elite.*stop/i,                        attr:'tackle',         floor:85, pos:['MLB','OLB','SS'] },
  { p: /elite coverage|cover.*linebacker/i,                            attr:'zoneCoverage',   floor:80, pos:['MLB','OLB'] },

  // General
  { p: /elite playmaker|generational/i,                               attr:'overall',        floor:80 },
  { p: /raw|developmental|needs refinement/i,                         attr:'awareness',      ceiling:72 },
];

function pass5_notes(prospects) {
  console.log('\n[Pass 5] Notes-based cross-checks');
  let count = 0;

  prospects.forEach(p => {
    const name = `${p.firstName} ${p.lastName}`;
    if (!p.notes) return;

    NOTES_RULES.forEach(rule => {
      // Position filter
      if (rule.pos && !rule.pos.includes(p.pos)) return;
      if (!rule.p.test(p.notes)) return;

      const actual = p.ratings[rule.attr];
      if (typeof actual !== 'number') return;

      let target = actual;
      if (rule.floor  !== undefined && actual < rule.floor)   target = rule.floor;
      if (rule.ceiling !== undefined && actual > rule.ceiling) target = rule.ceiling;

      if (target !== actual) {
        log(5, name, p.pos, rule.attr, actual, target,
            `notes: "${p.notes.match(rule.p)[0]}"`);
        if (FIX) p.ratings[rule.attr] = target;
        count++;
      }
    });
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Pass 6 — Awareness scaling by draft round
// ---------------------------------------------------------------------------
const AWARENESS_BOUNDS = {
  1: { lo: 68, hi: 82 }, // Round 1
  2: { lo: 62, hi: 78 }, // Round 2
};

function pass6_awareness(prospects) {
  console.log('\n[Pass 6] Awareness scaling by round');
  let count = 0;

  prospects.forEach(p => {
    const name  = `${p.firstName} ${p.lastName}`;
    const round = p.draftRound || 3;
    const { lo, hi } = AWARENESS_BOUNDS[round] || { lo: 55, hi: 72 };
    const clamped = clamp(p.ratings.awareness, lo, hi);
    if (clamped !== p.ratings.awareness) {
      log(6, name, p.pos, 'awareness', p.ratings.awareness, clamped,
          `R${round} bounds [${lo}–${hi}]`);
      if (FIX) p.ratings.awareness = clamped;
      count++;
    }
  });
  console.log(`  ${count} corrections ${FIX ? 'applied' : 'found'}.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const cal       = JSON.parse(fs.readFileSync(CALIBRATION, 'utf8'));
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_RATED, 'utf8'));

  console.log('=== Polish Ratings — 6-Pass Improvement ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  pass1_combine(prospects, cal);
  pass2_devTrait(prospects);
  pass3_overall(prospects, cal);
  pass4_posKeyRatings(prospects, cal);
  pass5_notes(prospects);
  pass6_awareness(prospects);

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
