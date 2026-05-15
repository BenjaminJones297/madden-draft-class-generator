'use strict';

/**
 * Script 9q - Post-Madden rookie rating polish
 *
 * Audits and optionally fixes the flat rookie ratings file consumed by 9g/9m.
 * The main polish_ratings* chain works on data/prospects_rated.json before the
 * Madden round-trip. This pass is for the post-Madden flat shape, and joins the
 * file back to prospect notes/measurables so profile-specific conflicts can be
 * caught after manual edits or franchise exports.
 *
 * Usage:
 *   node scripts/9q_polish_rookie_ratings_post_madden.js
 *   node scripts/9q_polish_rookie_ratings_post_madden.js --apply
 *   node scripts/9q_polish_rookie_ratings_post_madden.js --input data/foo.json --output data/foo_polished.json
 *   node scripts/9q_polish_rookie_ratings_post_madden.js --include-ol-ghosts
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

function findFlag(name, def = null) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) return args[i + 1];
  }
  return def;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

const INPUT = path.resolve(ROOT, findFlag('--input', 'data/rookie_ratings_post_madden.json'));
const OUTPUT = path.resolve(ROOT, findFlag('--output', path.relative(ROOT, INPUT)));
const APPLY = hasFlag('--apply') || hasFlag('--fix') || OUTPUT !== INPUT;
const INCLUDE_OL_GHOSTS = hasFlag('--include-ol-ghosts');

const META_FILES = [
  path.join(DATA_DIR, 'prospects_2026.json'),
  path.join(DATA_DIR, 'prospects_rated.json'),
];

const changes = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function displayName(rec) {
  return [rec.firstName || rec.FirstName || rec.FIRSTNAME, rec.lastName || rec.LastName || rec.LASTNAME]
    .filter(Boolean)
    .join(' ')
    .trim() || rec.name || rec.Name || '';
}

function ratingsOf(rec) {
  return rec && rec.ratings && typeof rec.ratings === 'object' ? rec.ratings : rec;
}

function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizePos(pos) {
  const p = String(pos || '').toUpperCase();
  if (p === 'LT' || p === 'RT' || p === 'OT') return 'T';
  if (p === 'LG' || p === 'RG' || p === 'OG') return 'G';
  if (p === 'NT') return 'DT';
  if (p === 'MLB') return 'ILB';
  if (p === 'EDGE') return 'DE';
  return p;
}

function recordPos(rec, meta) {
  return normalizePos(rec.position || rec.pos || rec.Position || meta.pos || meta.position);
}

function recordWeight(rec, meta) {
  return parseNumber(rec.weight ?? rec.wt ?? rec.Weight ?? meta.weight ?? meta.wt);
}

function buildMetaIndex() {
  const index = new Map();
  for (const file of META_FILES) {
    const data = readJsonIfExists(file);
    if (!data) continue;
    const list = Array.isArray(data) ? data : Object.values(data);
    for (const rec of list) {
      const name = displayName(rec);
      const key = normalizeName(name);
      if (!key) continue;
      const prev = index.get(key) || {};
      index.set(key, { ...prev, ...rec });
    }
  }
  return index;
}

function logChange(pass, rec, pos, attr, before, after, reason) {
  changes.push({
    pass,
    name: displayName(rec),
    pos,
    attr,
    before,
    after,
    reason,
  });
}

function setAttr(rec, attr, after, pass, pos, reason) {
  const ratings = ratingsOf(rec);
  const before = ratings[attr];
  if (typeof before !== 'number') return false;
  const target = Math.max(0, Math.min(99, Math.round(after)));
  if (target === before) return false;
  logChange(pass, rec, pos, attr, before, target, reason);
  if (APPLY) ratings[attr] = target;
  return true;
}

function capAttr(rec, attr, cap, pass, pos, reason) {
  const ratings = ratingsOf(rec);
  const before = ratings[attr];
  if (typeof before !== 'number' || before <= cap) return before;
  setAttr(rec, attr, cap, pass, pos, reason);
  return cap;
}

function floorAttr(rec, attr, floor, pass, pos, reason) {
  const ratings = ratingsOf(rec);
  const before = ratings[attr];
  if (typeof before !== 'number' || before >= floor) return before;
  setAttr(rec, attr, floor, pass, pos, reason);
  return floor;
}

const MOVE_BASED_INTERIOR_RE =
  /elusive rusher|explosive first step|rare playmaking range|varied approaches|angles|quickness|athletic gifts|move-based|mismatch interior/i;
const LOW_ANCHOR_INTERIOR_RE =
  /undersized|lacks (?:the )?anchor|limited recourse|linemen have him squared|put hands on him|contact balance|withstand power/i;

function passMoveBasedInterior(rec, meta) {
  const pos = recordPos(rec, meta);
  if (pos !== 'DT') return;

  const ratings = ratingsOf(rec);
  const notes = String(rec.notes || meta.notes || '');
  const wt = recordWeight(rec, meta);
  const undersized = (wt !== null && wt <= 295) || LOW_ANCHOR_INTERIOR_RE.test(notes);

  if (!undersized) return;
  if (!MOVE_BASED_INTERIOR_RE.test(notes) || !LOW_ANCHOR_INTERIOR_RE.test(notes)) return;

  const pass = 'move-based interior rush';
  const blockShedBefore = ratings.blockShedding;
  const blockShedAfter = typeof blockShedBefore === 'number'
    ? Math.min(blockShedBefore, 70)
    : blockShedBefore;

  capAttr(
    rec,
    'blockShedding',
    70,
    pass,
    pos,
    'undersized move rusher profile caps block shedding'
  );

  const power = typeof ratings.powerMoves === 'number' ? ratings.powerMoves : null;
  const finesseTargets = [76];
  if (typeof blockShedAfter === 'number') finesseTargets.push(blockShedAfter + 6);
  if (power !== null) finesseTargets.push(power + 3);

  floorAttr(
    rec,
    'finesseMoves',
    Math.max(...finesseTargets),
    pass,
    pos,
    'undersized move rusher profile lifts finesse above block shedding/power'
  );
}

const OL_POSITIONS = new Set(['T', 'G', 'C']);
function passOffensiveLineDefensiveGhosts(rec, meta) {
  const pos = recordPos(rec, meta);
  if (!OL_POSITIONS.has(pos)) return;

  const pass = 'OL defensive ghost traits';
  capAttr(rec, 'blockShedding', 30, pass, pos, 'offensive linemen should not carry DL block-shed ratings');
  capAttr(rec, 'powerMoves', 30, pass, pos, 'offensive linemen should not carry pass-rush move ratings');
  capAttr(rec, 'finesseMoves', 30, pass, pos, 'offensive linemen should not carry pass-rush move ratings');
  capAttr(rec, 'tackle', 35, pass, pos, 'offensive linemen should not carry defender tackle ratings');
  capAttr(rec, 'hitPower', 35, pass, pos, 'offensive linemen should not carry defender hit-power ratings');
  capAttr(rec, 'pursuit', 35, pass, pos, 'offensive linemen should not carry defender pursuit ratings');
}

function report(list) {
  const byPass = new Map();
  for (const change of list) {
    if (!byPass.has(change.pass)) byPass.set(change.pass, []);
    byPass.get(change.pass).push(change);
  }

  for (const [pass, passChanges] of byPass.entries()) {
    console.log(`\n[${pass}]`);
    for (const c of passChanges) {
      console.log(
        `  ${c.name.padEnd(25)} ${c.pos.padEnd(4)} ${c.attr.padEnd(16)} ` +
        `${String(c.before).padStart(3)} -> ${String(c.after).padStart(3)}  (${c.reason})`
      );
    }
  }
}

function main() {
  const rookies = readJson(INPUT);
  if (!Array.isArray(rookies)) {
    throw new Error(`Expected ${INPUT} to be a JSON array.`);
  }

  const metaIndex = buildMetaIndex();

  for (const rec of rookies) {
    const key = normalizeName(displayName(rec));
    const meta = metaIndex.get(key) || {};
    passMoveBasedInterior(rec, meta);
    if (INCLUDE_OL_GHOSTS) passOffensiveLineDefensiveGhosts(rec, meta);
  }

  console.log('=== Post-Madden Rookie Rating Polish ===');
  console.log(`  Input : ${path.relative(ROOT, INPUT)}`);
  console.log(`  Mode  : ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  OL cap: ${INCLUDE_OL_GHOSTS ? 'on' : 'off'}`);
  console.log(`  Count : ${rookies.length}`);

  if (!changes.length) {
    console.log('\nNo profile conflicts found.');
  } else {
    report(changes);
    console.log(`\nTotal changes: ${changes.length}`);
  }

  if (APPLY) {
    fs.writeFileSync(OUTPUT, JSON.stringify(rookies, null, 2) + '\n');
    console.log(`Saved: ${path.relative(ROOT, OUTPUT)}`);
  } else if (changes.length) {
    console.log('\nRe-run with --apply to overwrite the input, or --output <file> to write a polished copy.');
  }
}

main();
