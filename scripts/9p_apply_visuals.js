'use strict';

/**
 * Script 9p — Apply rookie skin-tone overrides to a Madden 26 franchise.
 *
 * For each rookie in data/rookie_appearances.json (built by 9o), locate the
 * Player record by (firstName, lastName) and write:
 *
 *   1. CharacterVisuals[row].RawData.skinTone   (the in-game render input)
 *   2. Player.GenericHeadAssetName              (head-shape asset; gen_<N>_…)
 *   3. Player.PLYR_PORTRAIT     →  0            (clear hijacked face-scan ID)
 *   4. Player.PLYR_ASSETNAME    →  stub         (clear hijacked player asset)
 *
 * If the Player has no CharacterVisuals row yet (the 9g fresh-inject case —
 * applies to ~250 of 306 rookies), this script allocates a fresh row in the
 * CharacterVisuals table (tableId=4204) and points Player.CharacterVisuals at
 * it. The new row is seeded from a default RawData template (loadouts +
 * skinTone). Without this, Madden has no skin/gear data to render the rookie
 * with and falls back to a fully-generic default appearance regardless of
 * what GenericHeadAssetName says — which was the symptom prior to this fix:
 * edit screen showed our writes but in-game rendering used defaults.
 *
 * The two other field writes (3, 4) are still required because 9g's overlay
 * path inherits real-player face-scan ID + asset bundle from the
 * auto-rookie placeholder; without clearing these Madden renders the
 * rookie as the hijacked real player and ignores the generic head asset.
 *
 * Skipped entirely when:
 *   - rookie's name doesn't match any Player record (counts → notFound)
 *   - rookie's confidence < CONFIDENCE_MIN (default 0.3) — hard floor
 *   - --skip-low-confidence is set AND rookie has manualReview=true
 *
 * Run:
 *   node scripts/9p_apply_visuals.js --franchise <path> --apply
 *   node scripts/9p_apply_visuals.js --franchise <path>            # dry-run
 *   node scripts/9p_apply_visuals.js --franchise <path> --apply --appearances <path>
 *   node scripts/9p_apply_visuals.js --franchise <path> --apply --skip-low-confidence
 */

const fs        = require('fs');
const path      = require('path');
const Franchise = require('madden-franchise');

const PROJECT_ROOT  = path.join(__dirname, '..');
const DEFAULT_APP   = path.join(PROJECT_ROOT, 'data', 'rookie_appearances.json');
const DEFAULT_VIS   = path.join(PROJECT_ROOT, 'data', 'raw', 'default_visuals.json');

const CV_TABLE_ID    = 4204;
const CONFIDENCE_MIN = 0.30;   // hard floor — never apply if below this

// Fallback used when data/raw/default_visuals.json is missing. Minimal blob:
// PlayerOnField + Base loadouts (empty element lists) + skinTone placeholder.
// Madden's renderer accepts variable-element loadouts; empty arrays render
// the per-position defaults — fine for procedural rookies.
const FALLBACK_VISUALS_BLOB = {
  loadouts: [
    { loadoutType: 'PlayerOnField', loadoutElements: [] },
    { loadoutCategory: 'Base',      loadoutElements: [] },
  ],
  skinTone: 5,
};

// ---------------------------------------------------------------------------
function findFlag(name, def) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) return args[i + 1];
  }
  return def;
}
function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}
function safeGet(r, key) {
  try { return r.getFieldByKey(key)?.value; } catch (_) { return null; }
}
function trySet(r, key, value) {
  try { r.getFieldByKey(key).value = value; return true; } catch (_) { return false; }
}

// 32-bit ref: top 15 bits = tableId, bottom 17 bits = row.
function encodeCVRef(tableId, row) {
  return tableId.toString(2).padStart(15, '0') + row.toString(2).padStart(17, '0');
}

// Allocate a fresh CharacterVisuals row by writing rawJson into the table's
// next-empty record. The madden-franchise lib auto-unEmpty's the record on
// write (autoUnempty: true) and advances cvT.header.nextRecordToUse to the
// next empty slot in the chain. Returns the new row index, or -1 if no
// capacity is available.
function allocateCVRow(cvT, rawJson) {
  const idx = cvT.header.nextRecordToUse;
  if (idx >= cvT.header.recordCapacity) return -1;
  const rec = cvT.records[idx];
  if (!rec || !rec.isEmpty) return -1;
  try {
    rec.getFieldByKey('RawData').value = rawJson;
    return idx;
  } catch (_) {
    return -1;
  }
}

// Deterministic 32-bit string hash (djb2). Used to assign each rookie a
// stable index into the head-model pool so re-runs pick the same face
// (idempotent) instead of reshuffling appearances every apply.
function hashName(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
async function openFranchise(filePath) {
  return new Promise((resolve, reject) => {
    const f = new Franchise(filePath, { gameYearOverride: 26, autoUnempty: true });
    f.on('error', e => reject(e));
    f.on('ready', () => resolve(f));
  });
}

async function main() {
  const franchisePath = findFlag('--franchise');
  const appearancesPath = findFlag('--appearances', DEFAULT_APP);
  const apply = hasFlag('--apply');
  const skipLowConfidence = hasFlag('--skip-low-confidence');

  if (!franchisePath) {
    console.error('✗ --franchise <path> required');
    process.exit(1);
  }
  if (!fs.existsSync(franchisePath)) {
    console.error(`✗ Franchise not found: ${franchisePath}`);
    process.exit(1);
  }
  if (!fs.existsSync(appearancesPath)) {
    console.error(`✗ Appearances file not found: ${appearancesPath}`);
    process.exit(1);
  }

  console.log('='.repeat(64));
  console.log('Script 9p — apply rookie skin-tone visuals');
  console.log('='.repeat(64));
  console.log(`  Mode         : ${apply ? 'APPLY (will save)' : 'DRY-RUN'}`);
  console.log(`  Franchise    : ${franchisePath}`);
  console.log(`  Appearances  : ${appearancesPath}`);
  console.log(`  Skip low-conf: ${skipLowConfidence}`);

  const appearances = JSON.parse(fs.readFileSync(appearancesPath, 'utf8'));
  console.log(`  Entries      : ${appearances.length}`);

  // Template blob used when a Player has no CharacterVisuals row yet.
  // data/raw/default_visuals.json is a real rookie's RawData (extracted by
  // script 2 from the 2025 launch class) — has 31 PlayerOnField loadout
  // elements + Base CharacterBodyType element. Fall back to a minimal blob
  // if the file is missing; Madden still renders a default loadout but with
  // the correct skinTone applied.
  let templateBlob;
  if (fs.existsSync(DEFAULT_VIS)) {
    try {
      templateBlob = JSON.parse(fs.readFileSync(DEFAULT_VIS, 'utf8'));
      // Strip genericHeadName from the template — vets' RawData blobs don't
      // include it, and we set Player.GenericHeadAssetName separately. Avoids
      // a stale value persisting in the JSON.
      delete templateBlob.genericHeadName;
      console.log(`  Template     : ${DEFAULT_VIS} (loadouts: ${(templateBlob.loadouts||[]).length})`);
    } catch (_) {
      templateBlob = FALLBACK_VISUALS_BLOB;
      console.log(`  Template     : fallback (default_visuals.json parse failed)`);
    }
  } else {
    templateBlob = FALLBACK_VISUALS_BLOB;
    console.log(`  Template     : fallback (default_visuals.json missing)`);
  }

  // Build name → entry lookup
  const byName = new Map();
  for (const a of appearances) {
    const key = norm(a.firstName + a.lastName);
    if (key) byName.set(key, a);
  }

  const fra      = await openFranchise(franchisePath);
  const playerT  = fra.getTableByName('Player');
  await playerT.readRecords();
  const cvT      = fra.tables.find(t => t.header.tableId === CV_TABLE_ID);
  if (!cvT) throw new Error('CharacterVisuals table not found');
  await cvT.readRecords();

  console.log(`  Player rows  : ${playerT.records.length}`);
  console.log(`  CV rows      : ${cvT.records.length}`);

  // Build the generic-head pool from veterans (YearsPro >= 1). These are
  // real, valid procedural head models already shipped in the franchise.
  // Bucket by skin family (leading gen_<N>) so a rookie can be given a
  // distinct FACE within its measured skin tone; keep a flat list for filler
  // prospects that have no measured tone (they get a face + plausible skin
  // family together). Vets only → the pool is stable across re-runs, which
  // keeps hashName()-based picks idempotent.
  const headPool = new Map();     // N (1-7) -> sorted distinct head strings
  const headPoolFlat = [];        // all distinct vet heads, sorted
  {
    const perFamily = new Map();
    const flatSeen = new Set();
    for (const r of playerT.records) {
      if (r.isEmpty) continue;
      if (!(safeGet(r, 'YearsPro') >= 1)) continue;
      const h = safeGet(r, 'GenericHeadAssetName') || '';
      const m = h.match(/^gen_(\d+)_.+/);
      if (!m) continue;
      const n = Number(m[1]);
      if (n < 1 || n > 7) continue;
      if (!perFamily.has(n)) perFamily.set(n, new Set());
      perFamily.get(n).add(h);
      if (!flatSeen.has(h)) { flatSeen.add(h); headPoolFlat.push(h); }
    }
    for (const [n, set] of perFamily) headPool.set(n, [...set].sort());
    headPoolFlat.sort();
  }
  console.log(`  Head pool    : ${headPoolFlat.length} distinct vet heads across ${headPool.size} families`);

  // Stats
  const stats = {
    rookieRows: 0, matched: 0, notFound: 0,
    appliedSkin: 0, appliedHead: 0,
    skippedLowConfidence: 0, skippedHardFloor: 0,
    cvDecodeFail: 0, cvRecordEmpty: 0, jsonParseFail: 0,
    cvAllocated: 0, cvAllocFail: 0, cvAllocWouldBeNeeded: 0,
    portraitsCleared: 0, assetNamesStubbed: 0,
    portraitsAlreadyZero: 0, assetNamesAlreadyClean: 0,
    fillerDiversified: 0, distinctHeadsUsed: new Set(),
    headBefore: new Map(), headAfter: new Map(),
    toneBefore: new Map(), toneAfter: new Map(),
  };
  function bumpMap(m, k) { m.set(k, (m.get(k) || 0) + 1); }

  // Iterate Player records, look for rookies (yd=0 OR yp=0) that match
  for (const r of playerT.records) {
    if (r.isEmpty) continue;
    const yd = safeGet(r, 'YearDrafted');
    const yp = safeGet(r, 'YearsPro');
    // Only target rookies (the 9g-injected ones have yd=0, yp=0)
    if (yp !== 0 || yd !== 0) continue;
    stats.rookieRows++;

    const fn  = safeGet(r, 'FirstName');
    const ln  = safeGet(r, 'LastName');
    if (!fn || !ln) continue;
    const key = norm(fn + ln);
    const entry = byName.get(key);
    let target;              // skin tone to write (1-8)
    let isFiller = false;    // true = no measured tone; diversify from pool
    let fillerHead = null;   // head chosen from the full pool for filler
    if (entry) {
      stats.matched++;
      target = Number(entry.skinTone);
      if (!Number.isInteger(target) || target < 1 || target > 8) continue;
      const conf = Number(entry.confidence || 0);
      if (conf < CONFIDENCE_MIN) {
        stats.skippedHardFloor++;
        continue;
      }
      if (skipLowConfidence && entry.manualReview) {
        stats.skippedLowConfidence++;
        continue;
      }
    } else {
      // Unmatched filler prospect — a Madden-generated rookie with no
      // measured skin tone (not one of the real 2026 names). Without this
      // branch these ~269 rows stay cloned as gen_7_B_G_005. Give each a
      // distinct face drawn deterministically from the full vet head pool;
      // the picked head's gen_<N> family also sets a plausible skin tone, so
      // the whole draft board varies instead of all teams sharing one look.
      stats.notFound++;
      if (!headPoolFlat.length) continue;   // nothing to diversify with
      isFiller = true;
      fillerHead = headPoolFlat[hashName(key) % headPoolFlat.length];
      const fm = fillerHead.match(/^gen_(\d+)_/);
      target = fm ? Number(fm[1]) : 7;
      stats.fillerDiversified++;
    }

    // Resolve a writeable CharacterVisuals row. The 9g fresh-inject path
    // leaves Player.CharacterVisuals = all-zeros (points at row 0, which is
    // coach data and shared across records, so we can't write skinTone there
    // safely). For these records we allocate a fresh CV row, seed it from
    // the template, and rebind Player.CharacterVisuals to the new row.
    // Without this, Madden has no per-rookie skin/loadout data to read and
    // renders a fully-generic default model regardless of
    // Player.GenericHeadAssetName.
    const cvRef = safeGet(r, 'CharacterVisuals');
    let cvRow = -1;
    if (cvRef && cvRef.length === 32 && cvRef !== '0'.repeat(32)) {
      const decodedRow = parseInt(cvRef.slice(15), 2);
      if (decodedRow > 0) cvRow = decodedRow;
    } else if (cvRef === undefined || cvRef === null) {
      stats.cvDecodeFail++;
    }

    if (cvRow < 0) {
      // Allocate a fresh CV row. In dry-run, count it but don't write.
      if (apply) {
        const blob = JSON.parse(JSON.stringify(templateBlob));
        blob.skinTone = target;
        const newIdx = allocateCVRow(cvT, JSON.stringify(blob));
        if (newIdx >= 0) {
          trySet(r, 'CharacterVisuals', encodeCVRef(CV_TABLE_ID, newIdx));
          cvRow = newIdx;
          stats.cvAllocated++;
          stats.appliedSkin++;
          bumpMap(stats.toneAfter, target);
        } else {
          stats.cvAllocFail++;
        }
      } else {
        stats.cvAllocWouldBeNeeded++;
        bumpMap(stats.toneAfter, target);
      }
    } else {
      // PATH A: existing CV row — update skinTone in place.
      const cvRec = cvT.records[cvRow];
      if (!cvRec || cvRec.isEmpty) {
        stats.cvRecordEmpty++;
      } else {
        const raw = safeGet(cvRec, 'RawData');
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (_) { stats.jsonParseFail++; parsed = null; }
        if (parsed !== null) {
          const beforeTone = parsed.skinTone;
          bumpMap(stats.toneBefore, beforeTone);
          parsed.skinTone = target;
          bumpMap(stats.toneAfter, target);
          if (apply) {
            cvRec.getFieldByKey('RawData').value = JSON.stringify(parsed);
            stats.appliedSkin++;
          }
        }
      }
    }

    // Assign the head MODEL (the face, encoded in the full
    // gen_<N>_<X>_<Y>_<NNN> asset name — not just the leading skin family).
    // The old behaviour kept a fixed _B_G_005 suffix, so every rookie in a
    // skin family shared one identical face. Instead pick a distinct face
    // from the veteran pool within the rookie's skin family (gen_<headN>),
    // deterministically by name so re-runs are stable. Filler prospects were
    // already assigned a head from the full pool above. Fall back to the old
    // suffix-swap only if the family bucket is empty.
    const headN  = Math.min(7, target);
    const before = safeGet(r, 'GenericHeadAssetName') || '';
    bumpMap(stats.headBefore, before.replace(/^gen_(\d+)_.*/, 'gen_$1'));
    let after;
    if (isFiller && fillerHead) {
      after = fillerHead;
    } else {
      const bucket = headPool.get(headN);
      if (bucket && bucket.length) {
        after = bucket[hashName(key) % bucket.length];
      } else {
        const m = before.match(/^gen_\d+_(.*)$/);
        after = m ? `gen_${headN}_${m[1]}` : `gen_${headN}_B_G_005`;
      }
    }
    bumpMap(stats.headAfter, after.replace(/^gen_(\d+)_.*/, 'gen_$1'));
    stats.distinctHeadsUsed.add(after);

    if (apply) {
      trySet(r, 'GenericHeadAssetName', after);
      stats.appliedHead++;
    }

    // Clear PLYR_PORTRAIT + PLYR_ASSETNAME hijacks.
    //
    // 9g's overlay path mutates an auto-rookie's identity fields but leaves
    // the inherited PLYR_PORTRAIT (real face-scan ID) and PLYR_ASSETNAME
    // (real-player asset bundle) intact. Madden renders the rookie as the
    // hijacked player — completely overriding our GenericHeadAssetName +
    // CharacterVisuals writes. Setting portrait=0 and asset to a
    // firstnamelastname stub forces Madden to fall back to the procedural
    // path which DOES use our visual writes. The stub format matches what
    // 9g's overlay path already produces for some records (e.g.
    // PLYR_ASSETNAME='jeremiyahlove').
    const portraitBefore = safeGet(r, 'PLYR_PORTRAIT');
    const assetBefore    = safeGet(r, 'PLYR_ASSETNAME') || '';
    const stubAsset      = (String(fn) + String(ln)).toLowerCase().replace(/[^a-z0-9]/g, '');

    if (apply) {
      if (portraitBefore && portraitBefore !== 0) {
        if (trySet(r, 'PLYR_PORTRAIT', 0)) stats.portraitsCleared++;
      } else {
        stats.portraitsAlreadyZero++;
      }
      if (assetBefore !== stubAsset) {
        if (trySet(r, 'PLYR_ASSETNAME', stubAsset)) stats.assetNamesStubbed++;
      } else {
        stats.assetNamesAlreadyClean++;
      }
    } else {
      // Dry-run counts: what WOULD change
      if (portraitBefore && portraitBefore !== 0) stats.portraitsCleared++;
      else stats.portraitsAlreadyZero++;
      if (assetBefore !== stubAsset) stats.assetNamesStubbed++;
      else stats.assetNamesAlreadyClean++;
    }
  }

  if (apply) {
    console.log('\n  Saving franchise …');
    await fra.save(franchisePath);
    console.log('  ✓ Saved.');
  }

  // ── Report ──
  console.log('\n  ' + '─'.repeat(50));
  console.log(`  Rookie rows scanned        : ${stats.rookieRows}`);
  console.log(`  Matched to appearances     : ${stats.matched}`);
  console.log(`  No appearance entry        : ${stats.notFound}`);
  console.log(`  Skipped (conf < ${CONFIDENCE_MIN})  : ${stats.skippedHardFloor}`);
  console.log(`  Skipped (manualReview)     : ${stats.skippedLowConfidence}`);
  console.log(`  CV decode fail             : ${stats.cvDecodeFail}`);
  console.log(`  CV record empty            : ${stats.cvRecordEmpty}`);
  console.log(`  RawData parse fail         : ${stats.jsonParseFail}`);
  console.log(`  CV rows allocated (new)    : ${stats.cvAllocated}`);
  if (!apply) {
    console.log(`  CV rows that WOULD alloc   : ${stats.cvAllocWouldBeNeeded}  (dry-run)`);
  }
  console.log(`  CV allocation failures     : ${stats.cvAllocFail}`);
  console.log(`  Writes (skinTone)          : ${stats.appliedSkin}`);
  console.log(`  Writes (head asset)        : ${stats.appliedHead}`);
  console.log(`  Filler prospects varied    : ${stats.fillerDiversified}`);
  console.log(`  Distinct head models used  : ${stats.distinctHeadsUsed.size}`);
  console.log(`  Portraits cleared (→0)     : ${stats.portraitsCleared}  (already 0: ${stats.portraitsAlreadyZero})`);
  console.log(`  Asset names stubbed        : ${stats.assetNamesStubbed}  (already stub: ${stats.assetNamesAlreadyClean})`);

  console.log('\n  Tone before → after distribution:');
  for (let t = 1; t <= 8; t++) {
    console.log(`    ${t}: ${String(stats.toneBefore.get(t) || 0).padStart(4)} → ${stats.toneAfter.get(t) || 0}`);
  }
  console.log('\n  Head family before → after:');
  for (let n = 1; n <= 7; n++) {
    const k = `gen_${n}`;
    console.log(`    ${k}: ${String(stats.headBefore.get(k) || 0).padStart(4)} → ${stats.headAfter.get(k) || 0}`);
  }
}

main().catch(err => {
  console.error('\n✗ Fatal:', err.message || err);
  process.exit(1);
});
