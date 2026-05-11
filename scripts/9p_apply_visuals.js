'use strict';

/**
 * Script 9p — Apply rookie skin-tone overrides to a Madden 26 franchise.
 *
 * For each rookie in data/rookie_appearances.json (built by 9o), locate the
 * Player record by (firstName, lastName), then apply one of two paths
 * depending on whether the record has a usable CharacterVisuals reference:
 *
 *   PATH A — CV ref non-null (typical for 9g overlay records, ~54/306):
 *     1. Decode Player.CharacterVisuals (32-bit ref) → (tableId=4204, row).
 *     2. Parse CharacterVisuals[row].RawData JSON, set skinTone = target.
 *     3. Write the updated JSON back to the same field.
 *     4. Set Player.GenericHeadAssetName to `gen_<N>_<X>_<Y>_<NNN>` where N =
 *        min(7, target_skinTone) and the (X, Y, NNN) suffix is preserved from
 *        the current asset name (falls back to `_B_G_005` if no suffix).
 *
 *   PATH B — CV ref null/zero (typical for 9g fresh-inject duplicates, ~252/306):
 *     1. Skip the CV JSON write (row 0 is shared; writes would collide).
 *     2. Still set Player.GenericHeadAssetName as in PATH A. Madden's
 *        renderer picks up skin family primarily from the asset name, so
 *        the visual still changes even without a proper CV blob.
 *
 * Both paths ALSO clear two fields that Madden uses as primary keys for
 * face/body rendering — without this step, the GenericHeadAssetName +
 * CharacterVisuals writes above have no visible effect:
 *
 *   Player.PLYR_PORTRAIT  →  0   (face-scan ID; non-zero means Madden has
 *                                  a real face for this asset and will use
 *                                  it instead of the generic head asset)
 *   Player.PLYR_ASSETNAME →  "firstnamelastname"   (lowercase stub; replaces
 *                                  inherited hijacked real-player asset
 *                                  names like "AveryTre_22605")
 *
 * 9g's overlay path inherits PLYR_PORTRAIT + PLYR_ASSETNAME from the
 * auto-rookie placeholder. Many auto-rookies (especially "Day1Starter"-tagged
 * ones used for high-pick slots) reference real players' face scans — so
 * post-9g, a rookie like Caleb Downs (pick 10, Cowboys) was rendering as
 * "Tre Avery" (portrait 2760). Clearing forces Madden's procedural path.
 *
 * The `gen_*_*_*_NNN` template family is what Madden's auto-rookies use, so
 * the asset names we write are guaranteed to exist in the game.
 *
 * Skipped entirely when:
 *   - rookie's name doesn't match any Player record (counts → notFound)
 *   - rookie's confidence < CONFIDENCE_MIN (default 0.3) — hard floor
 *   - --skip-low-confidence is set AND rookie has manualReview=true
 *
 * Output report includes per-path write counts so you can tell how many
 * records got the full skinTone update vs head-asset-only.
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

const CV_TABLE_ID    = 4204;
const CONFIDENCE_MIN = 0.30;   // hard floor — never apply if below this

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

  // Stats
  const stats = {
    rookieRows: 0, matched: 0, notFound: 0,
    appliedSkin: 0, appliedHead: 0,
    skippedLowConfidence: 0, skippedHardFloor: 0,
    cvDecodeFail: 0, cvNullRef: 0, cvRecordEmpty: 0, jsonParseFail: 0,
    portraitsCleared: 0, assetNamesStubbed: 0,
    portraitsAlreadyZero: 0, assetNamesAlreadyClean: 0,
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
    if (!entry) {
      stats.notFound++;
      continue;
    }
    stats.matched++;

    const target = Number(entry.skinTone);
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

    // Decode CharacterVisuals reference. NULL/zero refs (32-bit all-zeros
    // or row=0) point at a default/shared CV row. The 9g fresh-inject path
    // creates records without allocating unique CV rows. We can still update
    // the Player.GenericHeadAssetName for these records — Madden renders the
    // head primarily from that asset name, so skin family will change. We
    // just skip the CV blob write (which would collide on row 0).
    const cvRef = safeGet(r, 'CharacterVisuals');
    let cvWriteable = true;
    if (!cvRef || cvRef.length !== 32) {
      stats.cvDecodeFail++; cvWriteable = false;
    } else if (cvRef === '0'.repeat(32)) {
      stats.cvNullRef++; cvWriteable = false;
    } else {
      const cvRow = parseInt(cvRef.slice(15), 2);
      if (cvRow === 0) { stats.cvNullRef++; cvWriteable = false; }
    }

    if (cvWriteable) {
      const cvRow = parseInt(cvRef.slice(15), 2);
      const cvRec = cvT.records[cvRow];
      if (!cvRec || cvRec.isEmpty) {
        stats.cvRecordEmpty++;
        cvWriteable = false;
      } else {
        const raw = safeGet(cvRec, 'RawData');
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (_) { stats.jsonParseFail++; cvWriteable = false; parsed = null; }
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

    // Update GenericHeadAssetName — keep the (X, Y, NNN) suffix, swap the
    // leading gen_<N>. Cap N at 7 since the cross-tab shows tone 8 vets
    // overwhelmingly use head_7.
    const headN  = Math.min(7, target);
    const before = safeGet(r, 'GenericHeadAssetName') || '';
    bumpMap(stats.headBefore, before.replace(/^gen_(\d+)_.*/, 'gen_$1'));
    let after = before;
    const m = before.match(/^gen_\d+_(.*)$/);
    if (m) {
      after = `gen_${headN}_${m[1]}`;
    } else {
      after = `gen_${headN}_B_G_005`;
    }
    bumpMap(stats.headAfter, after.replace(/^gen_(\d+)_.*/, 'gen_$1'));

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
  console.log(`  Rookie rows scanned       : ${stats.rookieRows}`);
  console.log(`  Matched to appearances    : ${stats.matched}`);
  console.log(`  No appearance entry       : ${stats.notFound}`);
  console.log(`  Skipped (conf < ${CONFIDENCE_MIN}) : ${stats.skippedHardFloor}`);
  console.log(`  Skipped (manualReview)    : ${stats.skippedLowConfidence}`);
  console.log(`  CV decode fail            : ${stats.cvDecodeFail}`);
  console.log(`  CV null/zero ref (skipped): ${stats.cvNullRef}`);
  console.log(`  CV record empty           : ${stats.cvRecordEmpty}`);
  console.log(`  RawData parse fail        : ${stats.jsonParseFail}`);
  console.log(`  Writes (skinTone)         : ${stats.appliedSkin}`);
  console.log(`  Writes (head asset)       : ${stats.appliedHead}`);
  console.log(`  Portraits cleared (→0)    : ${stats.portraitsCleared}  (already 0: ${stats.portraitsAlreadyZero})`);
  console.log(`  Asset names stubbed       : ${stats.assetNamesStubbed}  (already stub: ${stats.assetNamesAlreadyClean})`);

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
