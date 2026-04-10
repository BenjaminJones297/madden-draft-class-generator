'use strict';
/**
 * polish_ratings12.js — OLB / FS / SS ghost value cleanup
 *
 * Pass 1:  OLB speed uniform → grade-scaled [88, 84]
 * Pass 2:  OLB acceleration uniform → grade-scaled [91, 87]
 * Pass 3:  OLB blockShedding uniform → grade-scaled [82, 74]
 * Pass 4:  OLB pursuit near-uniform → grade-scaled [88, 82]
 * Pass 5:  OLB tackle near-uniform → grade-scaled [86, 80]
 * Pass 6:  OLB awareness near-uniform → grade-scaled [82, 74]
 * Pass 7:  OLB hitPower near-uniform → grade-scaled [86, 78]
 * Pass 8:  FS agility uniform → grade-scaled [88, 78]
 * Pass 9:  FS manCoverage near-uniform → grade-scaled [78, 66]
 * Pass 10: FS tackle near-uniform → grade-scaled [76, 66]
 * Pass 11: FS hitPower near-uniform → grade-scaled [84, 74]
 * Pass 12: FS changeOfDirection near-uniform → grade-scaled [82, 70]
 * Pass 13: SS speed uniform → grade-scaled [90, 84]
 * Pass 14: SS manCoverage near-uniform → grade-scaled [76, 66]
 * Pass 15: SS zoneCoverage uniform → grade-scaled [76, 66]
 * Pass 16: SS tackle near-uniform → grade-scaled [82, 72]
 * Pass 17: SS hitPower near-uniform → grade-scaled [86, 76]
 * Pass 18: SS awareness uniform → grade-scaled [80, 72]
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

// Grade → value: tgtMin for best grade, tgtMax for worst grade.
const GRADE_ORDER = ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D'];
function gradeValue(grade, group, tgtMin, tgtMax) {
  const grades = group.map(p => p.grade);
  const sorted = [...new Set(grades)].sort((a,b) => GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b));
  const idx    = sorted.indexOf(grade);
  const n      = sorted.length;
  if (n === 1) return Math.round((tgtMin + tgtMax) / 2);
  return Math.round(tgtMin + idx * (tgtMax - tgtMin) / (n - 1));
}

function applyGradeScale(group, attr, tgtMin, tgtMax, pass, pos, label, threshold = 3) {
  const vals = group.map(p => p.ratings[attr]);
  if (Math.max(...vals) - Math.min(...vals) > threshold) {
    console.log(`\n[Pass ${pass}] ${pos} ${attr} not uniform (spread=${Math.max(...vals)-Math.min(...vals)}) — skip.`);
    return 0;
  }
  console.log(`\n[Pass ${pass}] ${pos} ${attr} uniform/near-uniform → grade-scaled [${tgtMin}, ${tgtMax}]`);
  let n = 0;
  group.forEach(p => {
    const target = gradeValue(p.grade, group, tgtMin, tgtMax);
    applyIf(p.ratings, attr, target, pass, `${p.firstName} ${p.lastName}`, pos,
      `${label}; grade=${p.grade} → ${target}`);
    n++;
  });
  console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
  return n;
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

function main() {
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_RATED, 'utf8'));
  console.log('=== Polish Ratings 12 — OLB / FS / SS Ghost Cleanup ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  const olbs = prospects.filter(p => p.pos === 'OLB');
  const fss  = prospects.filter(p => p.pos === 'FS');
  const sss  = prospects.filter(p => p.pos === 'SS');

  console.log(`\n  OLB: ${olbs.map(p=>`${p.firstName} ${p.lastName} (${p.grade})`).join(', ')}`);
  console.log(`  FS:  ${fss.map(p=>`${p.firstName} ${p.lastName} (${p.grade})`).join(', ')}`);
  console.log(`  SS:  ${sss.map(p=>`${p.firstName} ${p.lastName} (${p.grade})`).join(', ')}`);

  // ── OLB passes ──────────────────────────────────────────────────────────
  applyGradeScale(olbs, 'speed',         88, 84, 1,  'OLB', 'speed ghost');
  applyGradeScale(olbs, 'acceleration',  91, 87, 2,  'OLB', 'acceleration ghost');
  applyGradeScale(olbs, 'blockShedding', 82, 74, 3,  'OLB', 'blockShedding ghost');
  applyGradeScale(olbs, 'pursuit',       88, 82, 4,  'OLB', 'pursuit ghost', 4);
  applyGradeScale(olbs, 'tackle',        86, 80, 5,  'OLB', 'tackle ghost', 4);
  applyGradeScale(olbs, 'awareness',     82, 74, 6,  'OLB', 'awareness ghost', 4);
  applyGradeScale(olbs, 'hitPower',      86, 78, 7,  'OLB', 'hitPower ghost', 4);

  // ── FS passes ───────────────────────────────────────────────────────────
  applyGradeScale(fss,  'agility',           88, 78, 8,  'FS', 'agility ghost');
  applyGradeScale(fss,  'manCoverage',       78, 66, 9,  'FS', 'manCoverage ghost', 4);
  applyGradeScale(fss,  'tackle',            76, 66, 10, 'FS', 'tackle ghost', 4);
  applyGradeScale(fss,  'hitPower',          84, 74, 11, 'FS', 'hitPower ghost', 4);
  applyGradeScale(fss,  'changeOfDirection', 82, 70, 12, 'FS', 'changeOfDirection ghost', 4);

  // ── SS passes ───────────────────────────────────────────────────────────
  applyGradeScale(sss,  'speed',        90, 84, 13, 'SS', 'speed ghost');
  applyGradeScale(sss,  'manCoverage',  76, 66, 14, 'SS', 'manCoverage ghost', 4);
  applyGradeScale(sss,  'zoneCoverage', 76, 66, 15, 'SS', 'zoneCoverage ghost', 4);
  applyGradeScale(sss,  'tackle',       82, 72, 16, 'SS', 'tackle ghost', 4);
  applyGradeScale(sss,  'hitPower',     86, 76, 17, 'SS', 'hitPower ghost', 4);
  applyGradeScale(sss,  'awareness',    80, 72, 18, 'SS', 'awareness ghost', 4);
  applyGradeScale(sss,  'pursuit',      86, 78, 19, 'SS', 'pursuit ghost', 4);

  // ── FS follow-up ────────────────────────────────────────────────────────
  applyGradeScale(fss,  'zoneCoverage', 84, 74, 20, 'FS', 'zoneCoverage ghost', 4);

  console.log('\n=== Change Report ===');
  if (!changes.length) console.log('  No changes needed.');
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
