# Task Log — branch `rookie-visuals`

Running log for the rookie-visuals branch. Promote sections into the main
`task-log.md` on merge; keep this file as the working scratch-log meanwhile.

## 2026-05-11 (LATE PM +2) - OTC contract scraper + extension-aware year math

After the vet contract overlay (Phase 2.2) shipped, in-Madden checks showed
the limit was data freshness, not code: `nfl_rosters_2026.json` had 1581
entries (55%) with aav <= 0 and 1125 with contracts expired per data
(retired players, stale rookie deals). Built an Over The Cap scraper to
refresh it.

### New scripts

- **`scripts/7b_fetch_otc_contracts.py`** — two-stage OTC scraper. Phase 1:
  32 `/salary-cap/<team>/` pages → ~2,600 player profile URLs. Phase 2: each
  `/player/<slug>/<id>/` profile → Contract History table, picks the
  `Status == "Active"` row. Output `data/raw/otc_contracts.json` keyed by
  stable `otc_id`. Resumable (`--resume`), 1.5s rate limit, exp backoff on
  429/503. ~60-90 min full run. Captured 2,600 entries, 100% with aav > 0.
- **`scripts/7c_merge_otc_into_rosters.py`** — merges OTC contract fields
  into `nfl_rosters_2026.json` by normalized name. Overwrites
  aav/total_contract_value/guaranteed/contract_years/year_signed; adds
  free_agent_year + otc_contract_type + otc_id; preserves all roster-only
  fields. Warns on team mismatch (keeps roster team). Merged 2,165 of 2,854
  roster entries.

### 9g changes (same file, builds on commit 74b89fc)

- **Extension-aware ContractYear** — `mapContractFields` now reads
  `otc_contract_type`. For `Extension` deals, the contract's first active
  season is `year_signed + 1` (the new money starts the season after
  signing). Trey McBride signed a 2025 extension covering 2026-2029 — must
  show 4 years left in the 2026 league year, not 3. Josh Sweat (2025 UFA
  signing) correctly stays at year 1. Consolidated the prior stale-contract
  branch into a single `yearsInto <= 0 || yearsInto >= years` "treat fresh"
  rule.
- **Rookie contracts prefer OTC** — 9g now loads `data/raw/otc_contracts.json`
  (optional) and builds an `otcByName` lookup. The rookie inject path uses a
  rookie's real OTC "Drafted" contract when present, falling back to the
  hardcoded `rookieContract()` scale table only for UDFAs / unscraped names.
  Jeremiyah Love (pick 3) now shows his real $53M deal instead of the scale
  table's flat $40M.

### Apply test on fresh CAREER-UPDATED-ROSTER copy (--apply-vet-contracts)

- OTC contracts loaded: 2,593 usable
- Vet contracts overlaid: 1,783 (was 958 with stale nflverse data)
- Contract fallback (kept): 1,026 (was 1,851)
- Rookie contracts from OTC: 219 / from scale table: 46
- ContractLength=1 records: 2,156 → 1,006
- Resign queue: 2,048 → 1,352
- Spot-checks: McBride 4yr/year-0, Sweat 4yr/year-1, Love $53M total,
  Mahomes 7yr/$45M (year shifted 3→2 from the extension heuristic).

### Known follow-ups

- `data/raw/otc_contracts.json` `position` field is empty — the profile
  header position extractor didn't match OTC's layout. Not blocking (merge
  preserves nflverse position); fix on next iteration if needed.
- The extension `+1` heuristic is a simplification — without the prior
  deal's end year we can't know the exact extension start. Works for the
  common case (extension signed in the final year(s) of the prior deal).
- `build_franchise.ps1` still doesn't forward `--apply-vet-contracts`.

## 2026-05-11 (LATE PM) - Contract-accuracy Phase 2.2: vet overlay + fifth-year

Follow-up to the earlier Phase 2 pass. After user-led in-Madden verification
of commit `a20c7ff`, contracts still appeared as one-year veteran minimums
across the franchise. Root cause via `output/check_contracts.js` (read-only
diagnostic, not committed): the dominant 2156 records with `ContractLength=1`
were vets — which the active 9g leaves untouched (DISABLED block at the
former Pass 1b). Change 1 was working correctly on the 265 fresh-injected
rookies (Malik Benson, Caleb Tiernan etc. spot-checked with multi-year
contracts) but those are 8% of the population, not the players the user
spot-checked.

Implemented audit changes 4 + 7 + coupling.

### Change 4: Vet contract overlay (gated re-enable)
- 9g flag `--apply-vet-contracts` (default OFF). Off by default because
  the prior un-gated overlay pinned aav-less vets to 895k and demolished
  contracts at scale.
- Gates: (a) only fires under the flag; (b) only when `rosterByName`
  matches a 2026 nfl_rosters entry; (c) only when `Number(rosterEntry.aav) > 0`;
  (d) currentStatus inactive already filtered above.
- TeamIndex still NOT touched — bulk vet team moves remain out of scope per
  `decisions.md`. Only contract fields.
- Routes through the existing `writeContractToRecord` so the multi-year
  array shape (Change 1) and derived `ContractYear` (Change 2) apply
  consistently.
- New stats counter `vetContractsUpdated` surfaced in the Veterans summary
  alongside the existing `Contract fallback (kept)` counter.

### Change 7: Fifth-year option flag for round-1 rookies
- Rookie inject block writes `ContractExtraYearOption = (round === 1)`.
- Models the real NFL CBA mechanic. Engine reads this when modeling the
  team-option year on round-1 rookie deals.

### Coupling: --apply-vet-contracts implies --regenerate-resign
- The Pass 6 resign-queue regen (Change 5) was opt-in because the source
  franchise's one-year-shape vets would flood the queue. With Change 4
  re-writing those vets' Length/Year through the multi-year writer, the
  regen becomes safe to enable. So `--apply-vet-contracts` auto-enables
  Pass 6.

### Apply test on a fresh copy of CAREER-UPDATED-ROSTER

- `Vet contracts overlaid: 958` (out of 2640 ratings-updated vets)
- `Contract fallback (kept): 1851` — no nfl_rosters match or `aav=0`
- `ContractLength` distribution shifted: `Length=1` dropped 2156→1493,
  Length>1 went from 435→1122 (Length=4: 146→587 alone)
- Resign queue: 2048→1722 (improved; warning still fires — coverage gap)
- Spot-check of Mahomes (7y/$5.18M/yr filled), Adams (5y/$5.045M),
  Barkley (4y/$3.899M), Hendrickson (4y/$2.52M — note the BAL FA move
  did reach this build despite us not touching TeamIndex; he was already
  on BAL=24 in the V20 source apparently) — all multi-year, ContractYear
  derived correctly.

### Known data-quality issues (not code bugs)

- `Lamar Jackson` overlaid as 895k/1yr — no aav data for him in
  `data/nfl_rosters_2026.json` (matched but `aav=0`, hit the gate).
- `Maxx Crosby` cap=$23.5M but base salary $491k — unusual guarantee/bonus
  structure in source data (might be a units mismatch). Investigate
  separately.
- 1682 vets in the contract-fallback bucket still show source's
  one-year-shape contracts. Fix is to extend `nfl_rosters_2026.json`
  coverage, not 9g.

### CLI

```powershell
# Direct invocation
node scripts/9g_sync_franchise_from_data.js \
  --franchise "<path>" --apply --allow-unmatched --apply-vet-contracts
```

`build_franchise.ps1` does NOT yet forward this flag (the file has
uncommitted local edits — deliberately left alone). Either invoke 9g
directly with the flag or add a `-ApplyVetContracts` switch in a
follow-up.

### Next

User test cycle: load `CAREER-VETCONTRACT-TEST` in Madden, spot-check
Mahomes/Adams/Barkley contracts visible in roster screens, advance through
draft + preseason, confirm sim works post-cap-overhaul. Then we extend
build_franchise.ps1 to forward the flag and consider promotion to main
task-log.md.

## 2026-05-11 (PM) - Contract-accuracy pipeline pass

Per a Phase-2 audit cloned from `WiiExpertise/madden-franchise-utils` (cloned
read-only into `.claude/worktrees/wiiexpertise-utils/`, gitignored), adopted
five low-risk changes into 9g and three sibling scripts to fix the one-year-
shape bug + add post-write roster-size and resign-queue hygiene. Full audit
report at `.claude/worktrees/contract-audit-report.md` (not committed).

**The bug.** Every contract-writing script (9c, 9d, 9g, 9_apply_transactions)
was writing only `ContractSalary0` + `ContractBonus0` and hard-coding
`ContractYear = 0`. After one sim year the engine increments `ContractYear`
to 1, reads `ContractSalary1` / `ContractBonus1` which were still 0 — every
Player collapsed to a one-year deal regardless of `ContractLength`. Schema
truth comes from `SalaryCapManager.GetPlayerCapHitForYear(player, yearFromCurrent)`
(M26 schema line 9317, assetId 7046) and `PlayerContractManager.CreateDraftedRookieContract`
(line 22920) — both confirm per-year array indexing.

**Changes adopted** (audit's ranked plan, low-risk subset only):

1. **Multi-year array fill** — new `fillContractYears(rec, salaryK, bonusK, length)`
   helper at `9g_sync_franchise_from_data.js`. Writes `ContractSalary{i}` /
   `ContractBonus{i}` for `i=0..length-1`, zeros slots `[length..7]`. Called
   from both `writeContractToRecord` (vets path, currently DISABLED) and the
   rookie inject block.
2. **ContractYear derived from year_signed** — `writeContractToRecord` now
   computes `ContractYear = clamp(0, length-1, length - yearsLeft)`. Rookies
   still hard-code 0 since they're starting year 0. Removed the dead
   `ContractYearsLeft` write — no such field exists on the M26 Player schema.
3. **`recalculateRosterSizes(playerTable, teamTable)`** ported from
   WiiExpertise `Utils/FranchiseUtils.js:1369`. Re-derives `ActiveRosterSize`,
   `SalCapRosterSize`, `SalCapNextYearRosterSize` per team from actual
   Player rows. Always on; Pass 5 in 9g.
5. **`regenerateResignTables(franchise, playerTable, teamTable)`** ported
   from `Utils/FranchiseUtils.js:1018+1080`. Empties + refills the
   `PlayerReSignNegotiation` table from current Player state. **Disabled by
   default** (`ENABLE_REGEN_RESIGN = false`); opt-in via `--regenerate-resign`
   because the V20 source `CAREER-UPDATED-ROSTER` has pre-existing
   one-year-shape vet contracts that would flood the offseason UI with ~2048
   walk-year entries. Wire it on once the vet contract overlay (Change 4) is
   also implemented. Warns above queue size 200 when enabled.
6. **`ContractStatus` canonicalised to enum-name strings** in 9c, 9d,
   9_apply_transactions — `'1'` → `'Signed'`. 9g already used the name form.
   Eliminates the latent FA `'0' → "Drafted"` foot-gun documented in 9g.

**Skipped** (deferred): Change 4 (vet contract overlay re-enable — medium
risk; documented in `decisions.md`) and Change 7 (fifth-year option flag —
not in the user-confirmed scope).

**Dry-run verification on `CAREER-UPDATED-ROSTER`**:
- 32 teams recalc'd, default flow unchanged.
- `--regenerate-resign` would queue 2048 walk-year players (warning fires) —
  confirms the corrupted-source hypothesis; matches audit prediction.
- `node --check` clean on all four modified scripts.

**Files modified**:
- `scripts/9g_sync_franchise_from_data.js` (helpers + writeContractToRecord +
  rookie block + Pass 5/6 calls + new stats counters)
- `scripts/9c_inject_rookies.js` (CONTRACT_STATUS_SIGNED)
- `scripts/9d_sync_roster.js` (CONTRACT_STATUS_SIGNED)
- `scripts/9_apply_transactions.js` (CONTRACT_STATUS_SIGNED)

**Next**: not yet promoted to main `task-log.md` — gated on a live in-Madden
test (load post-9g franchise, sim one season, confirm vet cap hits track the
contract year correctly).

## 2026-05-11 - Branch created + orchestration plan

Branch: `rookie-visuals`, off `rookie-stat-baseline`.

### Problem

All 310 auto-rookies in `CAREER-UPDATED-ROSTER` share `skinTone=8` and
`GenericHeadAssetName=gen_7_B_G_005`. 9g's same-team overlay path inherits the
CharacterVisuals reference verbatim, so after injection every real 2026 rookie
still has the same generic dark-skinned procedural face regardless of the
actual prospect's appearance.

NFL vet skinTone distribution (sampled from 2592 vets on `CAREER-UPDATED-ROSTER`):
~17% in 1, ~18% in 2, ~2% in 3, ~6% in 4, ~7% in 5, ~12% in 6, ~36% in 7,
~2% in 8. Auto-rookies at 100% in 8 are way off the real distribution.

### Goal

Per-prospect skin-tone accuracy via approach B (from earlier in this session):
nflverse + fallback-source headshot scrape → image-based skin-tone extraction
→ bucket to Madden's `skinTone` 1-8 → write `CharacterVisuals.RawData.skinTone`
+ paired `GenericHeadAssetName=gen_<N>_B_<X>_005`.

### Schema findings (from prior session turn, before branch)

- `Player.CharacterVisuals` is a 32-bit reference: top 15 bits = `tableId`,
  bottom 17 bits = `row`. Decodes to a row in the `CharacterVisuals` table
  (`tableId=4204`, capacity 5056, ~3000+ used).
- `CharacterVisuals[row].RawData` is a JSON blob. Top-level keys: `skinTone`
  (integer 1-8), `loadouts` (array — `loadoutType: "PlayerOnField"` with ~29
  gear/equipment elements + an empty `loadoutCategory: "Base"`).
- Face/hair/eyes/beard are NOT in `RawData`. They're baked into the
  `Player.GenericHeadAssetName` model (e.g. `gen_7_B_G_005`).
- **Pattern**: `gen_<N>_B_<X>_<NNN>` where `N` (1-7) correlates with `skinTone`
  in a 1-7 cross-tab on vets (see numbers in `decisions.md` entry once written).
  So setting both `skinTone` AND a matching `gen_N` head asset gives a
  consistent look.

### Orchestration plan

- **Phase 1 (research, parallel)**: 2 agents + 1 local check
  - Agent A: 2026-prospect headshot sources (nflverse + fallbacks)
  - Agent B: lightweight Python skin-tone extraction algorithm
  - Local: madden-franchise RawData field schema — variable vs fixed length
- **Phase 2 (implementation, serial)**:
  - `9n_fetch_rookie_headshots.py` — fetch + cache
  - `9o_extract_skin_tones.py` — sample face region → bucket → JSON
  - Calibrate on ~50 known vets spanning all 8 skinTones
  - Applier (`9p_apply_visuals.js` or 9g extension) — write `skinTone` +
    `GenericHeadAssetName` to franchise
- **Phase 3 (integration + docs)**:
  - Optional `-ApplyVisuals` flag on `build_franchise.ps1` (opt-in initially)
  - `commands.md`, `project-map.md`, `decisions.md`, main `task-log.md`

### Open questions to resolve in phase 1

- Does nflverse have 2026 draft prospect headshots, or only post-roster?
- What's the right face-region sampling approach? Naïve crop or face-detect?
- Is `CharacterVisuals.RawData` a fixed-byte field that pads on write?

### Phase 1 results (2026-05-11)

**Headshot sources (Agent A):** ESPN CDN is the primary, keyed by `espn_id`
from nflverse `players.csv`.

- nflverse `players.csv` has rows for all 376 2026 rookies; `headshot`
  column is empty for UDFs but `espn_id` is populated for ~369 of 376.
- Primary URL: `https://a.espncdn.com/i/headshots/nfl/players/full/{espn_id}.png`
  (600x436 PNG, ~250KB, no auth, no anti-bot, clean 404 on bad ID).
- Fallback path on 404: `.../college-football/players/full/{espn_id}.png`.
- Fallback for missing-espn_id (~7 names): ESPN search API
  `https://site.web.api.espn.com/apis/common/v3/search?query={name}&limit=5&type=player`
  returns `items[0].id`.
- Expected coverage: ~98-100% on the 265 rookies.
- Throttle: ~200ms between requests; retry once on 5xx.
- Sources NOT worth pursuing: PFR / sports-reference (403 / anti-bot),
  CFBD (no photos), ESPN draft hub (URL doesn't exist anymore),
  nfl.com/players/* for UDF prospects (silhouette placeholder, not real photo).
- Verified samples: Mendoza, Love, Tate, Ward all return ~250KB PNGs.
- Existing `scripts/10_fetch_current_rosters.py` has reusable `download_raw`
  + `norm_name` patterns. New script can mirror its structure.

**Extraction algorithm (Agent B):** MediaPipe Face Mesh → Lab L* median with
YCbCr skin filter → quantile binning to 1-8.

- Libraries: `opencv-python mediapipe numpy` (Pillow already present). Skip
  dlib (Windows build pain) and sklearn (quantile binning is trivial in numpy).
- Face localization: MediaPipe Face Mesh's 468 landmarks. Forehead quad from
  landmarks {10, 151, 108, 337}. Cheek backup from {50, 205, 187} (L) and
  {280, 425, 411} (R). Median across all sampled regions.
- Color metric: Lab `L*` channel (`cv2.cvtColor(..., COLOR_BGR2LAB)`). Filter
  pixels to skin range in YCbCr: `77 <= Cb <= 127`, `133 <= Cr <= 173` (Hsu et
  al.). Take median, NOT mean (robust to glare highlights).
- No global white-balance: studio-lit photos break gray-world; Cb/Cr gate is
  already doing lighting tolerance.
- Calibration: **quantile binning against the NFL vet skinTone distribution**
  (17/18/2/6/7/12/36/2% for tones 1-8) is the primary approach. Anchor-based
  binning (mean L* per known tone) is a sanity check.
- Confidence score combines: MediaPipe detection confidence, skin-pixel ratio
  in sampled region (<30% = helmet/shadow dominates), distance to nearest bucket
  edge (borderline cases). Flag for review when confidence < 0.5.
- Known failure modes: (1) helmet covers forehead — detect via low forehead
  skin-pixel ratio + good cheek ratio; fall back to cheek-only. (2) No face
  detected — flag for manual, DO NOT fall back to fixed crop. (3) Flash on
  light skin — cap L* contribution by dropping pixels with L* > 240 before
  median.

**RawData schema (local check):**

```
RawData field on CharacterVisuals (tableId=4204):
  type: "binaryblob"
  isReference: false
  valueInThirdTable: true        ← variable-length storage
  maxLength: 375                 ← (semantics unclear; samples exceed this)
  length: 32                     ← in-record reference width in bits
```

Sample JSON-string lengths in CV table: 592, 592, 2023, 2011, 2031, 1924,
1924, 1941, 2039, 2136, 1859, 2325, 1893, 2209, 592, 2008, 2175, 1900, 2013,
1658, 1842, 1790, 1991, 2209, 1921 (min 592, max 2325).

The `valueInThirdTable: true` + binaryblob shape + actual lengths exceeding
the declared `maxLength` of 375 strongly suggests madden-franchise stores
this in a separate variable-length area and the field schema's `maxLength`
is either bytes-of-something-else or a stale hint. **Variable-length writes
should work** — but verify with a roundtrip test before the applier touches
real franchises (write, save, re-open, read back, confirm).

### Phase 2 plan

(See TaskList for live status.) Order:

1. **9n_fetch_rookie_headshots.py** — nflverse → espn_id → ESPN CDN, with
   college-football and search-API fallbacks. Cache to
   `data/raw/headshots/{first}_{last}.png`. Outputs a manifest
   `data/raw/headshot_manifest.json` recording url, status, bytes.
2. **9o_extract_skin_tones.py** — MediaPipe + Lab L* + YCbCr skin gate +
   median → continuous metric. Cache to
   `data/raw/skin_tone_measurements.json` with per-photo confidence.
3. **Calibration** — fetch headshots for ~50 vets spanning skinTone 1-8
   from `CAREER-UPDATED-ROSTER`, run extractor, build calibration
   (`data/skin_tone_calibration.json`) using quantile-on-NFL-distribution
   as primary + per-tone anchor sanity check.
4. **Bucket rookies** — apply calibration → `data/rookie_appearances.json`
   with `{firstName, lastName, skinTone, confidence, headshotUrl}` per
   rookie. Manual review queue for low-confidence cases.
5. **9p_apply_visuals.js** — read `rookie_appearances.json`, find each
   rookie's Player record, decode CharacterVisuals ref, mutate
   `RawData.skinTone`, write back; set
   `Player.GenericHeadAssetName=gen_<N>_B_G_005` to match. Save franchise.
6. **End-to-end test** — run on a copy of `CAREER-UPDATED-ROSTER`, spot-
   check Love + 5 other prospects, run `9z_validate_franchise.js`.

### Phase 3 plan

1. Add optional `-ApplyVisuals` switch to `build_franchise.ps1` (runs 9p
   after 9g in phase 'pre').
2. Wiki: append `commands.md` recipe, `project-map.md` entries for 9n/9o/9p,
   `decisions.md` entry (chose approach B over A/C, why), promote
   summary into main `task-log.md` on merge.

### Open questions still tracked

- Madden's reliance on consistency between `Player.GenericHeadAssetName`
  and `CharacterVisuals.RawData.skinTone` — verified strongly correlated in
  data, but is mismatch tolerated at load? Resolved (probably): 9p always
  writes BOTH consistently, so we never test mismatch in practice.
- The `maxLength: 375` mystery — does writing a longer RawData blob via
  madden-franchise silently truncate or corrupt? **Resolved 2026-05-11**:
  roundtrip test (write skinTone change, save, reopen, read) succeeded.
  `maxLength: 375` is a misleading schema hint — actual content goes into
  the third-table (variable-length) area and madden-franchise handles
  resize/preserve correctly. The roundtrip preserved RawData length at
  2023 chars (same as before/after — we changed `skinTone: 6` to
  `skinTone: 1`, both single digits).

### Phase 2 progress (2026-05-11)

**Scripts written:**
- `scripts/9n_fetch_rookie_headshots.py` — ESPN CDN via nflverse espn_id.
  Coverage: 256/265 (97%) on first run. 8 no-espn-id, 1 CDN miss.
- `scripts/9o_extract_skin_tones.py` — MediaPipe FaceLandmarker (new
  tasks API; the legacy `mp.solutions.face_mesh` is gone in 0.10.35) +
  Lab L* with YCbCr skin filter. Downloads `face_landmarker.task`
  (3.7 MB) on first run.
- `scripts/9o_pick_calibration_vets.js` — picks 10 vets per skinTone
  bucket from the franchise truth. 80 total picks; nflverse coverage
  on those was 79/80.
- `scripts/9o_build_calibration.py` — fits both anchor-mean and
  quantile-NFL classifiers, picks the better one (anchor here).
- `scripts/9o_bucket_rookies.py` — applies calibration to
  measurements, writes `data/rookie_appearances.json`.
- `scripts/9p_apply_visuals.js` — the franchise applier. Writes
  `CharacterVisuals.RawData.skinTone` + `Player.GenericHeadAssetName`
  consistently.
- New deps: `opencv-python`, `mediapipe`, `numpy` (added to
  `requirements.txt`).

**Calibration accuracy on 79 vet truth:**
- Anchor method: 29/79 exact (37%), 58/79 within ±1 (73%)
- Quantile-NFL: 16/79 exact (20%), 53/79 within ±1 (67%)
- Anchor wins on both metrics → recommended method.
- **Anchor monotonicity is broken** — middle tones (1-5) overlap in mean
  L* because the algorithm has poor dynamic range above L*~150. Highlight
  bias from studio flash on cheeks/forehead inflates medium-skin readings.
  The 1-2 and 7-8 pairs are also cosmetically indistinguishable. The 73%
  ±1 floor is probably the best this algorithm achieves without face-
  landmark-aware highlight rejection.

**Rookie distribution (255 bucketed of 256 measured of 265 total):**

| tone | count | rookie % | NFL %  | observation |
|------|-------|----------|--------|-------------|
|  1   |  12   |   4.7%   | 17.0%  | under-represented |
|  2   |  64   |  25.1%   | 18.0%  | over-represented (medium → tone 2 bias) |
|  3   |   9   |   3.5%   |  2.0%  | ~ok |
|  4   |  14   |   5.5%   |  6.0%  | ok |
|  5   |  49   |  19.2%   |  7.0%  | over-represented (mid bias) |
|  6   |  61   |  23.9%   | 12.0%  | over-represented |
|  7   |  32   |  12.5%   | 36.0%  | under-represented (most dark-skinned vets read brighter than they should) |
|  8   |  14   |   5.5%   |  2.0%  | over-represented |

Net: the algorithm tends to mis-classify some dark-skinned players as
medium and some medium as light, but every rookie gets a NON-default
skin tone, which is the main goal. The result is visibly more varied
than 265-rookies-all-skinTone-8.

**Roundtrip write test:** PASSED. Read row 2, changed skinTone 6→1,
saved, reopened, value persisted, franchise still loads. Cleaned up
test file.

### Phase 2 step 5: applier built

`scripts/9p_apply_visuals.js` ready. Iterates Player records with
YearDrafted=0, YearsPro=0 (the 9g-injected real rookies + Madden's
auto-prospects), matches names against `rookie_appearances.json`, and
on match: writes both `CharacterVisuals[row].RawData.skinTone` and
`Player.GenericHeadAssetName` (= `gen_<min(7, tone)>_B_G_005` to match).

`--apply` actually writes; default is dry-run. `--skip-low-confidence`
skips entries marked `manualReview` in the appearances file.

### Phase 2 step 6: end-to-end test results (RESOLVED)

**Test sequence:** copy `CAREER-UPDATED-ROSTER` → `CAREER-VISUALS-TEST`,
9g with custom ratings + rookies → 9p apply → 9z validate.

**Initial counts (single-path write — all records):**
- 575 rookie rows scanned (YearDrafted=0, YearsPro=0)
- 306 matched to `rookie_appearances.json` by name
- 252 of 306 had `CharacterVisuals` ref pointing at row 0 (NULL/default)

**Root cause discovered:** 9g's fresh-inject path (V5-style for cross-team
rookies who don't have a same-team auto-prospect placeholder) creates new
Player records without allocating a unique CharacterVisuals row. The CV
field defaults to all-zeros, which decodes to (tableId=0, row=0). When 9p
naively wrote skinTone to row 0, all 252 fresh-inject duplicates collided
on the same shared row — last-writer-wins. Spot-check confirmed: the
"second Mendoza" / "second Love" / etc. records (one per rookie that 9g
both overlaid AND fresh-injected) all pointed at row 0.

**Fix (split-path logic in 9p):**
- PATH A (CV ref non-null, ~54 records): write CV `RawData.skinTone` AND
  `Player.GenericHeadAssetName` as a consistent pair.
- PATH B (CV ref null/zero, ~252 records): skip the CV write (row 0
  collision), update only `Player.GenericHeadAssetName`. Madden's renderer
  reads head shape + skin family primarily from the asset name, so these
  records still get a visible appearance change.

**Final test results:**
- 306 head-asset writes / 54 skin-tone writes
- 9z validator clean (51,545 refs, 0 broken)
- Spot-check of 13 named rookies showed overlay records with sensible
  tones (Bowers → tone 1; Mendoza → 3; Tate, Hunter, Sanders, Downs → 7).
  Outlier: Cam Ward classified as tone 8 (he's Latino, should be ~4) due
  to algorithm highlight bias — manual override in
  `rookie_appearances.json` is the escape hatch.
- Head-family distribution shifted from heavily-gen_7-weighted
  (119/306) toward varied (gen_2 +13, gen_5 +20, gen_6 +38, gen_7 −60).

### Phase 3 complete

- `build_franchise.ps1` now accepts opt-in `-ApplyVisuals` switch +
  `-Appearances <path>` override. Runs 9p between 9l and the final
  validate step.
- Wiki updated: `commands.md` (recipe), `project-map.md` (entries for
  all 6 new scripts), `decisions.md` (approach B rationale +
  trade-offs), main `task-log.md` (promoted summary),
  `data-contracts.md` (new generated-file entries + schema examples).
- `.gitignore` extended to exclude the regeneratable cache files
  (headshots, manifests, measurements, the 3.7MB face_landmarker.task
  model download).

### Phase 4: post-deployment fix (PLYR_PORTRAIT / PLYR_ASSETNAME hijack)

After the user ran `build_franchise.ps1 ... -ApplyVisuals` and loaded the
result in Madden, they reported "nothing looks changed." Investigation
found that 9g's overlay path inherits `Player.PLYR_PORTRAIT` (a real
face-scan ID) and `Player.PLYR_ASSETNAME` (a real-player asset bundle
name like `AveryTre_22605`) from the auto-rookie placeholder. These two
fields are Madden's primary keys for rendering — when set, they
completely override `GenericHeadAssetName` + `CharacterVisuals`. So
Caleb Downs was rendering as Tre Avery, Fernando Mendoza as Tycen
Anderson, etc.

Inventory on `CAREER-VISUALS-DEMO` (247 real-team rookies):
- 162 had empty `PLYR_ASSETNAME` (would have worked with prior 9p)
- ~85 had hijacked `LastFirst_NNNN` asset names with non-zero portraits
  (rendered as wrong real players)

**Fix:** 9p now also writes on every matched rookie:
- `PLYR_PORTRAIT` → 0
- `PLYR_ASSETNAME` → `<firstname><lastname>` lowercased stub (matches the
  pattern 9g's overlay path produces, e.g. `jeremiyahlove`)

Vets (`YearsPro >= 1`) are untouched — they keep their authentic face
scans (Bowers 10018, Mason Graham 10564, Cam Ward 10768 stayed put).

**Retest results:**
- 306 head-asset writes / 54 skin-tone writes (same as before)
- 252 portraits cleared (real-team rookies that had hijacked refs)
- 252 asset names stubbed
- Validator clean (51,545 refs, 0 broken)
- Spot-check: Love-on-ARI now `asset=jeremiyahlove portrait=0`. Mendoza,
  Downs, Tate, Bernard, Proctor similarly cleared.

### Open follow-ups (not done on this branch)

- 9g could allocate unique CV rows for fresh-inject records so 9p can
  do PATH A on them too. Would lift coverage from 54/306 to 306/306.
  Tricky: CV table is at capacity (5056/5056), so would need to find
  unused rows or grow the table.
- Calibration algorithm has poor dynamic range above L*~150 (mid-tones
  collapse). Better forehead-only or face-segment-aware sampling could
  improve from 73% within ±1 to ~85%.
- Madden's real-portrait library (the IDs like 10768 for Cam Ward) is
  out-of-scope for this branch. Could be a future enhancement: map
  rookie name → real portrait ID when Madden has a face scan for that
  player, fall through to procedural for the rest.
