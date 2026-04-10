'use strict';
/**
 * polish_ratings11.js — Final OL ghost value cleanup
 *
 * Pass 1: C runBlock uniform (all 75) → grade-scaled [72, 80]
 * Pass 2: C strength uniform (all 84) → grade-scaled [80, 88]
 * Pass 3: G runBlock near-uniform (76–78) → grade-scaled [72, 82]
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

// Grade → index for linear spread within [tgtMin, tgtMax]
const GRADE_ORDER = ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D'];
function gradeValue(grade, group, tgtMin, tgtMax) {
  // rank this prospect's grade within the group
  const grades = group.map(p => p.grade);
  const sorted = [...new Set(grades)].sort((a,b) => GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b));
  const idx    = sorted.indexOf(grade);
  const n      = sorted.length;
  if (n === 1) return Math.round((tgtMin + tgtMax) / 2);
  return Math.round(tgtMin + idx * (tgtMax - tgtMin) / (n - 1));
}

function applyGradeScale(group, attr, tgtMin, tgtMax, pass, pos, label) {
  let n = 0;
  group.forEach(p => {
    const target = gradeValue(p.grade, group, tgtMin, tgtMax);
    applyIf(p.ratings, attr, target, pass, `${p.firstName} ${p.lastName}`, pos,
      `${label}; grade=${p.grade} → ${target}`);
    n++;
  });
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
  console.log('=== Polish Ratings 11 — Final OL Ghost Cleanup ===');
  console.log(`  Mode: ${FIX ? 'FIX' : 'DRY RUN (report only)'}`);

  const centers = prospects.filter(p => p.pos === 'C');
  const guards  = prospects.filter(p => p.pos === 'G');

  // Pass 1: C runBlock
  const cRB = centers.map(p => p.ratings.runBlock);
  if (Math.max(...cRB) - Math.min(...cRB) <= 3) {
    console.log('\n[Pass 1] C runBlock uniform → grade-scaled [72, 80]');
    const n = applyGradeScale(centers, 'runBlock', 72, 80, 1, 'C', 'runBlock ghost');
    console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
  } else console.log('\n[Pass 1] C runBlock not uniform — skip.');

  // Pass 2: C strength
  const cStr = centers.map(p => p.ratings.strength);
  if (Math.max(...cStr) - Math.min(...cStr) <= 3) {
    console.log('\n[Pass 2] C strength uniform → grade-scaled [80, 88]');
    const n = applyGradeScale(centers, 'strength', 80, 88, 2, 'C', 'strength ghost');
    console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
  } else console.log('\n[Pass 2] C strength not uniform — skip.');

  // Pass 3: G runBlock
  const gRB = guards.map(p => p.ratings.runBlock);
  if (Math.max(...gRB) - Math.min(...gRB) <= 4) {
    console.log('\n[Pass 3] G runBlock near-uniform → grade-scaled [72, 82]');
    const n = applyGradeScale(guards, 'runBlock', 72, 82, 3, 'G', 'runBlock ghost');
    console.log(`  ${n} corrections ${FIX ? 'applied' : 'found'}.`);
  } else console.log('\n[Pass 3] G runBlock not uniform — skip.');

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
