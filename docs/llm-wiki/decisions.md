# Decisions

Record durable architecture and workflow decisions here. Keep entries short and
link to source when possible.

## 2026-05-11 - Madden Contract Field Unit: $10k Per Cap-Int

**Decision:** All player contract fields on the M26 Player record
(`ContractSalary{0..7}`, `ContractBonus{0..7}`, `PLYR_CAPSALARY`) store values
in **$10,000 cap-int units**, not $1,000 as the prior code (and the initial
schema-audit report) assumed. NFL veteran minimum (~$900k) maps to stored 90.
A $45M Mahomes cap hit maps to stored 4500. The 14-bit field range
(0..16383) × $10k = up to $163.83M per year, which fits real-world top deals.

**Why this matters:** the prior `/ 1000` conversion in
`writeContractToRecord` and the rookie inject block was 10× too high. For
star contracts whose dollar value exceeded $16.383M per year, the lib
silently truncated to the low 14 bits — Mahomes' "5182" stored value was
actually `37950 & 0x3FFF`. That produced both wrong displayed amounts
(everything 10× too high) AND mangled arithmetic (low-14-bit modulo).
Empirically confirmed via in-Madden inspection 2026-05-11.

**Source:** `scripts/9g_sync_franchise_from_data.js` exposes
`SALARY_UNIT_USD = 10_000` constant; all contract conversions multiply or
divide by this. `MIN_SALARY_K = 90` (representing ~$900k league min).

**Implications:**
- `scripts/9c`, `scripts/9d`, `scripts/9_apply_transactions` still use the
  old `/ 1000` + `895` floor — they're not in the active build flow
  (`build_franchise.ps1`) but need the same fix on first reuse.
- Team-level cap fields (`SalCapCapRoom` etc.) had previously been observed
  at ~$10,500 per unit; same scale family.

## 2026-05-15 - Post-Sim Fake Rookies Use Deleted, Not rec.empty()

**Decision:** The phase-post cleanup path uses
`scripts/9m_purge_fake_rookies.js --include-yd1 --delete` by default via
`build_franchise.ps1`. Purged fake rookie rows are marked
`ContractStatus=Deleted`, moved to TeamIndex 32, removed from team Roster
arrays, removed from `Franchise.FreeAgents`, and roster-size counters are
recalculated.

**Why:** Cutting fake rookies to FA removes them from teams but leaves them
visible in the FA pool. Physically emptying the Player rows (`rec.empty()`)
is still forbidden because other live tables can reference those rows and
Madden can CTD when it dereferences empty Player records. `Deleted` hides the
rows from active/FA player surfaces while preserving row references.

**Implication:** Diagnostic scripts that bucket raw Player records may still
see YearDrafted=1 / YearsPro=0 rows after cleanup. Check `ContractStatus`:
`Deleted` rows are intentionally inactive and should not be treated as
remaining FA/team rookies.

## 2026-05-11 - Vet Contract Overlay: Gated Re-Enable

**Decision:** Re-enable the previously-DISABLED vet contract overlay in
`9g` Pass 1b, behind `--apply-vet-contracts` flag, default OFF.

**Why:** The prior unconditional overlay damaged contracts by pinning every
aav-less vet to the 895k floor (the now-corrected MIN_SALARY_K). The gated
version skips entries where `nfl_rosters_2026.json` has `aav <= 0` or no
match — those vets keep their source data (which is acceptable since the
data file is the limiting factor).

**Gates:**
- (a) Only fires under `--apply-vet-contracts`
- (b) Only when `rosterByName` matches a 2026 nfl_rosters entry
- (c) Only when `Number(rosterEntry.aav) > 0`
- (d) Currently-inactive `ContractStatus` filtered above (Retired/Deleted/None)

**Out of scope:** Vet `TeamIndex` is NOT touched. Bulk vet team moves cause
sim CTD per the V11-V19 documented failures.

**Stale-contract heuristic:** When `year_signed + contract_years <= leagueYear`
in the data (contract expired per data but player rostered with aav), treat
the deal as a fresh multi-year contract (`yearsLeft = years`, `ContractYear = 0`).
Without this, players like Josh Sweat (whose data shows his old 2021 PHI
contract) display as walk-year. Better-but-imperfect: shows multi-year shape
with the stale aav rather than the broken walk-year display.

**Coupled change:** `--apply-vet-contracts` auto-enables Pass 6
(`regenerateResignTables`), since vet `Length`/`Year` is now reliable.


## 2026-05-11 - Contracts Must Use The Multi-Year Array Shape

**Decision:** Every contract write into a Player record must populate
`ContractSalary{i}` and `ContractBonus{i}` for `i = 0..ContractLength-1` (slots
`[ContractLength..7]` left at 0), and `ContractYear` must reflect the actual
year-of-contract cursor (0 for a new signing, `Length-1` for a walk year).
Hard-coding `ContractYear=0` plus writing only year-0 indices is forbidden.

**Why:** The M26 sim engine reads `SalaryCapManager.GetPlayerCapHitForYear(player, yearFromCurrent)`
(schema assetId 7046, line 9317), which indexes the per-year arrays. After one
sim year Madden increments `ContractYear` and reads `ContractSalary{ContractYear}`
for the current cap hit — if we only wrote slot 0, every player collapses to a
one-year deal regardless of `ContractLength`. Confirmed against the schema's
own `PlayerContractManager.CreateDraftedRookieContract` (line 22920) which
populates both `SalaryTable` and `BonusTable` for the full contract length.

**Implementation:** `scripts/9g_sync_franchise_from_data.js` exposes
`fillContractYears(rec, salaryK, bonusK, length)`. Any new contract-writing
code path must call it. See the contract-audit report at
`.claude/worktrees/contract-audit-report.md` for the full bug analysis.

**Implications:**
- `scripts/9c`, `scripts/9d`, `scripts/9_apply_transactions` still write only
  year-0 indices — they're not in the active build flow
  (`build_franchise.ps1`), so they're flagged for the same fix on first reuse
  rather than fixed eagerly.
- `Player.ContractYearsLeft` does not exist on the M26 Player schema. Any
  `trySet(rec, 'ContractYearsLeft', …)` write is a silent no-op. Removed in 9g.
- Resign-queue regeneration (`regenerateResignTables`, opt-in via
  `--regenerate-resign`) only makes sense once vet contracts are also written
  through `fillContractYears` — otherwise the queue gets flooded with vets the
  V20 source franchise wrongly marks as walk-year.

## 2026-05-11 - Rookie Skin-Tone Optimization: Approach B (Image-Based)

**Decision:** For per-rookie skin-tone realism, scrape headshots from ESPN
CDN (via nflverse `espn_id`) and extract a Lab L* metric using MediaPipe
Face Mesh landmarks + YCbCr skin filtering. Bucket to Madden's `skinTone`
1-8 via anchor calibration against ~80 vets with known truth.

**Why this beats the alternatives considered:**

- **Approach A (NFL-distribution randomization):** trivial to implement
  but gets every individual wrong. Rookies look diverse but unrelated to
  their real selves.
- **Approach C (manual lookup table):** most accurate but ~265 rows of
  eyeballing per rookie class; non-reproducible across years; brittle
  to roster turnover.
- **Approach B (chosen):** ~97% photo coverage via ESPN CDN, 73% within-±1
  accuracy on vet calibration. Reproducible: regenerate the appearances
  file whenever the rookie class changes by re-running 9n/9o. The pipeline
  is data-source-driven, matching the project's nflverse style.

**Trade-offs accepted:**
- 37% exact match means ~30% of rookies will be visibly off-tone (e.g.
  Cam Ward classified as tone 8 instead of tone 4 — algorithm highlight
  bias from studio flash on cheeks/forehead). Manual override of
  `data/rookie_appearances.json` after the auto-run is the escape hatch
  for outliers.
- 9g's fresh-inject duplicate records have null `CharacterVisuals` refs,
  so 9p can't write to their CV row 0 (would collide across records).
  Workaround: write only `GenericHeadAssetName` for those (~252 records);
  Madden's renderer uses the asset name as the primary appearance driver.
- The algorithm has poor dynamic range above L*~150, so middle tones
  (1-5) collapse into a narrow L* band. Calibration tones 1 vs 2 and
  7 vs 8 are essentially indistinguishable in the algorithm's output.

**Post-deployment fix (2026-05-11):** initial deploy was visually
ineffective because 9g's overlay path inherits real-player
`PLYR_PORTRAIT` + `PLYR_ASSETNAME` from auto-rookie placeholders. Madden
uses those fields as primary rendering keys, overriding our
`GenericHeadAssetName` + `CharacterVisuals` writes. 9p now also clears
`PLYR_PORTRAIT = 0` and stubs `PLYR_ASSETNAME = 'firstnamelastname'`
on every matched rookie, forcing Madden into procedural rendering
which DOES pick up our visual writes. Vets (`YearsPro >= 1`) are
untouched — they keep their authentic face scans.

**Second-deployment fix (2026-05-15):** after the PLYR_PORTRAIT fix, the
~250 fresh-inject rookies still rendered defaulted in-game (edit screen
showed our head-asset writes, but the 3D model used a fully-generic
appearance). Root cause: their `Player.CharacterVisuals` was all-zeros —
no CV row pointing to any skin/loadout data. The CV table is NOT at
capacity (probe shows ~1962 of 5056 empty rows available) and the
`madden-franchise` lib auto-allocates on write to an empty record's
`RawData` field. 9p now allocates a fresh CV row per null-ref rookie,
seeded from `data/raw/default_visuals.json` (or a minimal fallback) with
the rookie's target skinTone, and re-binds `Player.CharacterVisuals`. CV
allocations are idempotent — re-running 9p sees the now-non-null refs
and updates the existing rows.

**Implications:**
- New scripts on the path: `9n_fetch_rookie_headshots.py`,
  `9o_extract_skin_tones.py`, `9o_pick_calibration_vets.js`,
  `9o_build_calibration.py`, `9o_bucket_rookies.py`, `9p_apply_visuals.js`.
- New deps: `opencv-python`, `mediapipe`, `numpy` (added to requirements.txt).
- `build_franchise.ps1` gets a `-ApplyVisuals` opt-in switch + an
  `-Appearances <path>` override. Default behavior unchanged.
- Cache files (`data/raw/headshots/*.png`, `headshot_manifest.json`,
  `skin_tone_measurements.json`, `skin_tone_calibration.json`,
  `rookie_appearances.json`) are reproducible from public sources — no
  need to commit photos.

**Future work tracked:**
- Replace anchor with a face-segmentation-aware highlight rejector to
  improve calibration agreement past 73% within ±1.
- Real-portrait IDs (`PLYR_PORTRAIT`) and asset names
  (`PLYR_ASSETNAME`) are out-of-scope for this branch; would require
  a name → portrait-ID mapping table that Madden ships internally.

## 2026-05-07 - Use A Repo-Local LLM Wiki

Decision: Maintain `docs/llm-wiki/` as the canonical context handoff for LLMs
working in this repository, with `AGENTS.md` as the root entry point.

Why: The project has large generated data files, two languages, current CLI
pipelines, and a separate future architecture document. A compact wiki lets LLMs
load stable project context without reading unrelated artifacts.

Implications:

- Update wiki pages when source changes make durable context stale.
- Use `data/contracts/` before opening large JSON artifacts.
- Treat `ARCHITECTURE.md` as future-state planning, not current behavior.

## 2026-05-08 (LATE EVE) - Recommended Recipe: User-Team Swap on V20 Source

**Decision:** For franchises where the user wants to control a non-Cardinals
team with vets on real teams + sim-clean state, the canonical workflow is now:

1. Start from `CAREER-UPDATED-ROSTER` (the V20 source — vets on real teams,
   pre-draft, sims past draft).
2. `Copy-Item` to a new save name.
3. Run `scripts/9k_swap_user_team.js --target-team-index <N>` to re-bind the
   user to a different team via FranchiseUser.Team + UserEntity refs +
   Coach.IsUserControlled flag.
4. Optionally layer `scripts/9g_sync_franchise_from_data.js` (rookie-stat-baseline
   branch's V20 9g, no team moves) for 2026 rookies + ratings.

**Why this beats the V11-V19 file-edit team-move approach:** the V11-V19
branch tried to MOVE vets onto real teams in a stock-Madden franchise. After
9 distinct iterations + 7 hypotheses tested 2026-05-08 evening (cap math
in 4 variants, rookie inject interaction, stage-9 vs Week-1 timeline,
cut+sign decomposition, depth chart fill) — every version produced sim CTDs
during the draft. The V11-V19 file-edit pattern is **structurally bounded
against post-franchise bulk vet team moves** by an unidentified Madden sim
invariant we can't introspect from outside the binary.

The user-team swap sidesteps this entirely: no team moves, no cap edits,
no roster array maintenance. Just three field edits on a known-working
franchise. Validator clean, loads, sims past draft (verified 2026-05-08
late evening on `CAREER-UPDATED-ROSTER-HAWKS`).

**Implications:**
- The `9g-vets-team-move` branch (V11-V19) is now a research-only artifact.
  Do not commit further work there expecting sim to clear.
- The V20 source `CAREER-UPDATED-ROSTER` is the load-bearing artifact. Back
  it up. Reproducing it from scratch remains open work (see decisions.md
  2026-05-08 PM late).
- Initial 9k v1 had UI weirdness (Week-1 matchups not visible + cross-team
  trade-block popups). Resolved in v2 by extending the swap to 8 total
  fields: added Franchise.LeagueOwner, Team.UserCharacter (clear old + set
  new), ArcContext.Team. See task-log.md 2026-05-08 (LATE EVE +6) for the
  full canonical binding set + table reference.

## 2026-05-08 (PM, latest) - .ros Encoding: No Off-The-Shelf Path For M26

`madden-franchise` (3.8.0 + 4.2.2) and `madden-file-tools` (the only sibling
that ever touched rosters) **do not** support reading or writing M26 `.ros`
files. Investigated 2026-05-08 across both libraries' source.

**Why:**
- `madden-franchise`'s `Constants.js` only declares `FRANCHISE` /
  `FRANCHISE_COMMON` formats. No roster code path.
- `FranchiseFile.js`'s `unpackFile` slices at fixed offset `0x52` and
  runs `zlib.inflateSync` — fails on `.ros` because the M24+ FBCHUNKS
  container isn't a zlib stream.
- `madden-file-tools`'s `MaddenRosterHelper.js` was last updated 2021-08
  for M21 TDB2 layout. Doesn't understand the FBCHUNKS wrapper that
  M24/M25/M26 added.
- M24+ uses a Frostbite chunked-archive wrapper (`FBCHUNKS`) as the
  outer container for both franchise AND roster files. The franchise
  inner reader is implemented; the roster inner reader (TDB2 in M26)
  isn't.

**Consequence:** `scripts/3_extract_roster_ratings.js` claims to read
.ros via the franchise constructor — it succeeds on franchise saves
(`CAREER-*`) but fails on actual `.ros` files like
`data/raw/ROSTER-Official` and the user's `ROSTER-NEW`. No commit in
this repo's git history shows it ever working on a real M26 .ros.

**Workarounds, ranked by effort:**
1. Use the V20 recipe (CAREER-UPDATED-ROSTER + 9g) — already working,
   no .ros work needed.
2. Reverse-engineer the FBCHUNKS chunk table to extract the inner
   TDB2, feed to a hand-rolled or revived MaddenRosterHelper.
3. Mine `madden-franchise`'s franchise FBCHUNKS extraction logic and
   adapt for `.ros`. Same Frostbite container, different inner schema.

For now: **option 1.** If we need the user-facing "build a roster from
JSON" experience, the realistic deliverable is `roster_players_rated.json`
(script 8 output) plus the V20 recipe — not a binary `.ros` file.

## 2026-05-08 (PM, late) - V20's Season Timeline

`CAREER-9G-V20` (and its source `CAREER-UPDATED-ROSTER`) sits at:
- `CurrentSeasonYear = 2025`
- `CurrentStage = OffSeason`
- `CurrentOffseasonStage = 9` (late offseason)
- `IsProDayComplete = true`
- `CurrentWeek = 11` (offseason week counter)

Practical interpretation: **right before the 2026 NFL Draft.** Madden's
offseason stages run 1–10; stage 9 is pro-day-complete + pre-draft. From
this state, the user can sim the draft in-game (which uses our injected
2026 rookies' real-life draft-team data to place them on real teams via
Madden's draft engine) without needing 9g's vet TeamIndex moves.

Implication for future workflows: applying changes at this offseason
stage may be more sim-tolerant than at Week-1-regular-season state
(which is where our V11..V19 team-move attempts broke). The original
`CAREER-CARDSWEEK1B4SIM` source we'd been editing was at week 1 of the
regular season — possibly part of why team moves CTD'd there.

## 2026-05-08 (PM, late) - The Working Recipe: pre-rosters franchise + V8 9g

**The working approach** for getting accurate vet teams + real 2026 rookies
+ working sim:

1. **Start from a franchise that already has vets on real teams**, not the
   default Madden state. The user has `CAREER-UPDATED-ROSTER` in the saves
   dir — built in an earlier session, probably by importing a custom roster
   file. Use it as the source. (`data/raw/ROSTER-Official` may have been
   the base; recreating that build from scratch is open work.)

2. **Run the default 9g** (rookie-stat-baseline branch — `ENABLE_VET_TEAM_MOVE = false`)
   on a copy of that source. 9g updates vet ratings via
   `full_solution_2_ratings.json` and fresh-injects 2026 rookies on their
   real-life teams via `rookie_ratings_post_madden.json`.

3. **Sim past Week 1 works** — confirmed on `CAREER-9G-V20`.

**Why this works and our V11..V19 attempts didn't:** we don't move any vets'
TeamIndex. The pre-rosters franchise already has them on the right teams.
9g only adds rookies (which go into empty Player slots — no team-roster
disturbance) and writes ratings in place (no structural change). Madden's
sim invariants stay intact.

**Alternative path** the user mentioned (worth exploring as a v2):
- Sim through preseason in a normal franchise to right before the 2026 draft
- Import a `.draftclass` file (we already build `data/output/2026_draft_class.draftclass`
  via `scripts/6_create_draft_class.js`)
- Sim the draft — Madden's engine assigns rookies to teams via the draft
  itself, sidestepping our team-write code paths entirely
- Then dispose any auto-rookies that got drafted alongside

**Open question:** how was `CAREER-UPDATED-ROSTER` originally built? It has
2,326 Signed players on real-life teams (Adams on LAR, Barkley on PHI, etc.)
plus 310 records with `ContractStatus=Draft` — these look like a draft pool
already injected. The build pipeline isn't documented in this repo;
identifying it (probably a one-time roster-builder script + an in-game
roster import) would let us reproduce the starting state without depending
on the existing file.

## 2026-05-08 - 9g Overlays Rookies; Does Not `rec.empty()` Them

Decision: In `scripts/9g_sync_franchise_from_data.js`, populate real 2026
rookies by **mutating** auto-rookie placeholder records in place
(`YearDrafted=1, YearsPro=0`) rather than calling `rec.empty()` on them and
re-injecting fresh records.

Why: `rec.empty()` on a record that other tables reference (HistoryEntry,
Player[] roster arrays, PlayerAcquisitionEvaluation, etc.) leaves dangling
references — even with a full reference-cleaning sweep that nulls all those
refs, Madden's sim engine CTDs on the resulting null entries. Mutate-in-place
preserves every ref pointing at the row.

Implications:

- Use a same-team prefer when matching real prospects to auto placeholders;
  fall back to V5-style fresh inject for cross-team mismatches.
- 2026-prospect filter MUST be `YearDrafted=1 AND YearsPro=0`.
  `YearDrafted=0` catches 2025 rookies + UDFAs that must not be touched.
- See `scripts/9z_validate_franchise.js` for the reference-integrity check
  that surfaced this issue.

## 2026-05-18 - madden-franchise Auto-Shrinks Array On Null-In-Place

**Decision:** Never null a Player reference in-place inside a `Player[]`
sub-table record (e.g. `Team.Roster`). Use shift-compact instead — copy
slots `K+1..arraySize-1` down by one, then null only the (now-vacated) last
slot. See `scripts/9s_force_trade.js` → `compactRemoveFromRoster` for the
reference implementation.

**Why:** `node_modules/madden-franchise/FranchiseFileRecord.js:146-151`
auto-shrinks `arraySize` to `field.offset.index` when any reference field
inside an array record is set to the null reference (`tableId=0,
rowNumber=0`):

```js
else if (field.isReference) {
  if (referenceData.tableId === 0 && referenceData.rowNumber === 0) {
    this.arraySize = field.offset.index;
  }
}
```

Nulling slot K therefore truncates the array to length K, orphaning every
Player ref at slots `K+1..arraySize-1`. Madden's roster reader respects
`arraySize` and treats slots past it as nonexistent. On load, Madden
re-derives `DepthChart` from the truncated Roster, picking the next-best
player at each position — which surfaces as wrong-position players in the
depth chart (e.g. a DT showing up as the team's best Guard).

**How verified:** 9s --apply on a post-sim autosave with the original
null-in-place pattern produced exactly this symptom (Wyatt DT → G,
Holland S → C, Burns DE → G on the NYG depth chart). After switching to
shift-compact, the same trade left the depth chart intact (verified
2026-05-18).

**Implications:**
- `scripts/9g_sync_franchise_from_data.js` → `removeFromTeamRoster` (line
  698) uses the same null-in-place pattern. It is only called by Pass 4
  for auto-rookie disposal; the rookies are typically at trailing slots so
  the truncation is mostly benign, but the bug is latent and any cross-team
  use will hit it.
- The append direction is also affected: appending must write at index
  `arraySize` so the lib grows the array by exactly 1. Searching for
  "first internal null" is safe (no arraySize change) but writing past
  arraySize without going via the boundary slot would silently
  over-extend the array.
- Any future code that mutates a `Player[]` sub-table — `Team.PracticeSquad`,
  `Team.MarketedPlayers`, `Franchise.FreeAgents`, depth-chart pool rows,
  etc. — must use the shift-compact pattern, not null-in-place.

## 2026-05-08 (PM) - File-Edit Vet Team Moves Are Structurally Hard

Updated assessment after 8 iterations + 3 parallel agent investigations:
post-franchise bulk vet team moves via file editing are not a known-
working pattern. We've handled 8 distinct invariants (Roster, DepthChart
pool, 13 team-affiliated arrays, 3 contract tracking tables,
PrevTeamIndex, contract layout normalization, Team SalCap fields,
Franchise.FreeAgents pool); validator clean each iteration; sim CTDs
immediately every time.

External evidence:
- madden-franchise 4.2.2 (latest) is ESM rewrite + schema fixes only.
  No new trade/team-move APIs.
- Community tools (bep713 editor, FFC Retro Rosters, Bowersrd's PC
  hub) operate on `.ros` files PRE-franchise or do single-player serial
  cuts/sign POST-franchise. Nobody publishes working bulk-move-post-sim.

Why: Madden's sim engine validates a wide invariant set spanning
Player records, Team-affiliated arrays, league-singleton arrays,
per-record contract tables, derived per-team cap totals, plus likely
internal sim state we can't introspect from outside.

Decision still stands: default 9g (rookie-stat-baseline) does not
move vet TeamIndex. The full V19 implementation lives on
`9g-vets-team-move` for future research. For accurate vet teams, use
`scripts/9h_generate_roster_changes.js` to generate an in-game
checklist (Madden's engine handles every invariant correctly).

## 2026-05-08 - Vet Team Moves Are Out-Of-Scope For 9g (original entry)

Decision: 9g updates vet ratings only. It does NOT change `Player.TeamIndex`
on existing veterans. The `ENABLE_VET_TEAM_MOVE` flag in 9g is OFF by default.
For real-life trades and free-agent signings, generate a checklist with
`scripts/9h_generate_roster_changes.js` and execute the moves in Madden's
in-game UI.

Why: Moving a vet's TeamIndex requires synchronously updating at least 16
team-affiliated tables (Roster, PracticeSquad, Marketed*, ActiveAbilities*,
training lists, DepthChart pool, ContractOffer, PlayerReSignNegotiation,
PlayerAcquisitionEvaluation, plus `Player.PrevTeamIndex`) and recalculating
the 27 cap-derived fields on each affected `Team` record. Each layer we add
exposes more invariants. The `9g-vets-team-move` branch implements layers
1-5 and CTDs sim; layer 6 (cap math) is open-ended. In-game moves let
Madden's engine handle every layer correctly.

Implications:

- 9g's `Pass 1b` (vet team move) lives on the `9g-vets-team-move` branch,
  not on `rookie-stat-baseline`. Re-enable only when a working cap-math
  pass is added.
- 9h is the user-facing path for accurate roster moves.
- The same-team-mismatch case in `Pass 3` (rookies) uses fresh inject
  rather than team-change overlay for the same reason.

