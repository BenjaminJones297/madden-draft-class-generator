# Task Log

Append brief handoff notes for meaningful work. This file is for future LLMs,
not a full changelog.

## 2026-05-15 - Fix 9m YD=1 duplicate rookie purge

User reported post-phase cleanup still left "old rookies" on
`CAREER-CARDINALS-AUTOSAVE`. Re-reading Claude session
`20b8c80c-8bc3-444e-a983-665d6cf24692` showed the failure landed after
the wrapper's post phase, not during pre-build.

Root cause: `scripts/9m_purge_fake_rookies.js` kept any YearsPro=0 player
whose normalized name appeared in `data/rookie_ratings_post_madden.json`.
Madden's next-year synthetic pool (`YearDrafted=1`, `YearsPro=0`) can contain
duplicate names from the real class, so `--include-yd1` was accidentally
protecting many old-rookie duplicates.

Fix: with `--include-yd1`, 9m now purges all `YearDrafted=1` / `YearsPro=0`
players on real teams regardless of name. It still uses the rookie file as
the keep-list for `YearDrafted=0` current-year rookies. Also tightened team
Roster removal, FA-pool duplicate checks, and roster-size counter recalculation.

Verification on current failed save:
- Before fix: dry-run found only 30 purge targets.
- After fix: dry-run found 90 purge targets (76 YD=1 synthetic + 14
  name-unmatched current-year records).
- Applied to `CAREER-CARDINALS-AUTOSAVE` after saving backup
  `CAREER-CARDINALS-AUTOSAVE.codex-before-9m-fix`.
- Follow-up dry-run: 0 purge targets; `9z_validate_franchise.js`: 0 broken refs.

Follow-up same day: user noticed the fakes were cut but still visible in FA.
Added `--delete` mode to 9m and wired `build_franchise.ps1` phase post to pass
`--include-yd1 --delete`. Delete mode scans both real teams and FA pool, marks
fake rows `ContractStatus=Deleted`, removes them from team Roster arrays and
`Franchise.FreeAgents`, and recalculates roster-size counters without
`rec.empty()`.

Verification on `CAREER-CARDINALS-AUTOSAVE`:
- Delete-mode dry-run found 312 fake rows (271 already in FA pool).
- Applied after saving backup `CAREER-CARDINALS-AUTOSAVE.codex-before-9m-delete`.
- Wrote 312 `Deleted` statuses, removed 41 team-roster refs and 271 FA-pool refs.
- Follow-up delete dry-run: 0 purge targets; validator: 0 broken refs.

## 2026-05-11 (+1) - Rookie skin-tone visuals pass (branch `rookie-visuals`)

End-to-end pipeline that gives each injected 2026 rookie a per-player skin
tone derived from their real-life headshot, instead of every rookie sharing
the same `skinTone=8` + `gen_7_B_G_005` template Madden's auto-prospect
generator produces.

**Full pipeline (one-time build + per-franchise apply):**
1. `9n_fetch_rookie_headshots.py` — ESPN CDN via nflverse `espn_id`. 97%
   coverage on the 265-rookie class.
2. `9o_extract_skin_tones.py` — MediaPipe FaceLandmarker forehead+cheek →
   YCbCr-filtered Lab L* median → per-photo metric.
3. `9o_pick_calibration_vets.js` + 9n + 9o on the picks → vet truth pairs.
4. `9o_build_calibration.py` — fits anchor + quantile classifiers; anchor
   wins at 37% exact / 73% within ±1.
5. `9o_bucket_rookies.py` → `data/rookie_appearances.json`.
6. `9p_apply_visuals.js --apply` writes skinTone + GenericHeadAssetName
   into a franchise. Wired into `build_franchise.ps1` as opt-in
   `-ApplyVisuals` switch.

**Decisions:** see `decisions.md` 2026-05-11 entry for the approach-B
rationale.

**Detailed history:** see `task-log-rookie-visuals.md` for the
branch-specific working log (schema findings, agent research outputs,
calibration analysis, end-to-end test results).

**Open follow-ups:**
- 9g fresh-inject path doesn't allocate unique CV rows, so 9p can only
  write proper `RawData.skinTone` for ~54/306 matched rookies. The other
  252 get a `GenericHeadAssetName`-only update (Madden's renderer still
  picks up skin family from that).
- Algorithm has poor dynamic range in middle tones; some outliers
  (e.g. Cam Ward as tone 8) need manual override in
  `rookie_appearances.json` until calibration improves.

## 2026-05-11 - build_franchise.ps1: forward custom ratings/rookies files

Added optional `-Ratings <path>` and `-Rookies <path>` parameters to
`scripts/build_franchise.ps1`. When non-empty, they're appended as
`--ratings`/`--rookies` to the underlying 9g call in Phase 'pre' and (for
`-Rookies`) the 9m call in Phase 'post' (where the rookies file acts as 9m's
keep-list for distinguishing real rookies from fake auto-generated ones).

Omitting the params preserves prior behavior — 9g/9m fall back to their built-in
defaults (`data/full_solution_2_ratings.json`, `data/rookie_ratings_post_madden.json`).

Motivation: lets the one-line wrapper consume local files like
`data/roster_players_rated_full2.json` + `data/rookie_ratings_post_fix.json`
without renaming or copying them to the default paths. This is the "skip data
generation, use what's already on disk" workflow.

Verified `roster_players_rated_full2.json` (script-8 merged shape with nested
`ratings` object) and `rookie_ratings_post_fix.json` (flat shape) both work
through 9g unmodified — name/position lookup is shape-tolerant and
`applyRatingsObject` handles both `entry.ratings` and flat top-level rating
keys.

Wiki updates: `commands.md` "End-to-End Franchise Build" got an
`Optional flags` subsection; `project-map.md` build_franchise.ps1 entry now
mentions the flags.

## 2026-05-08 (LATE EVE +7) - Post-Sim Auto-Rookie Purge + One-Line Build Wrapper

User loaded `CAREER-HAWKS-FINAL` (built from V20 source + 9k swap to SEA +
9g rookie inject + 9l draft-pool dispose), advanced through draft +
preseason to Week 1 in Madden. Reported still seeing auto-generated
rookies on team rosters.

**Root cause**: Madden's natural offseason flow auto-signed many UDFAs
during the post-draft signing wave. Of the 310 pre-built draft prospects
9l had pushed to FA, ~223 got signed back to teams. Plus Madden generated
224 next-year (YearDrafted=1) synthetic prospects, many also signed to
team rosters.

**Built `scripts/9m_purge_fake_rookies.js`**:
- Filter: YearsPro=0 on a real team (TI 0-31), name NOT in
  `data/rookie_ratings_post_madden.json` (normalized)
- Cut path: TeamIndex=32, ContractStatus=FreeAgent, remove from team
  Roster array, append to Franchise.FreeAgents pool
- `--include-yd1` flag also purges next-year synthetic pool
- No `rec.empty()` (V11-V19 lessons stand)

**Test on `CAREER-HAWKS-FINAL-AUTOSAVE`**:
- 557 rookie-class records scanned (333 YD=0 + 224 YD=1)
- 131 already in FA pool (skipped)
- 285 matched real rookies (kept — note this is more than 265 because
  some real names match across YD=0 and YD=1 buckets)
- **141 fakes cut** (16 YD=0 + 125 YD=1) → FA pool, removed from rosters
- Validator clean (55,606 refs / 0 broken)
- User confirmed it worked — fakes no longer on rosters

**Critical workflow rule**: 9m edits the autosave file directly. User
must **quit Madden without saving in-game** first or Madden's next save
overwrites our edits with in-memory state.

**Built one-line wrapper `scripts/build_franchise.ps1`** that orchestrates
the full pipeline as two phases (because the middle requires manual
in-game sim):

```powershell
./scripts/build_franchise.ps1 -TargetTeamIndex 27 -DestName CAREER-HAWKS-FINAL -Phase pre
# (load Madden, sim through draft + preseason, quit without in-game save)
./scripts/build_franchise.ps1 -DestName CAREER-HAWKS-FINAL -Phase post
```

Phase 'pre' chains: copy → 9k → validate → 9g → 9l → validate.
Phase 'post' chains: 9m --include-yd1 → validate.

Wiki canonical: `commands.md` "End-to-End Franchise Build" + per-script
`project-map.md` entries.

**Future work flagged by user**: "later we will have to update the
rookies a little bit." Likely means iterating on rookie ratings or
re-applying 9g + 9l to an existing franchise after rating changes.
Pattern would be: re-copy from a Phase 'pre'-output snapshot (kept as
a backup), edit data/rookie_ratings_post_madden.json, re-run 9g + 9l.
9g's same-team overlay path means re-running on a fresh franchise
should be idempotent.

## 2026-05-08 (LATE EVE +6) - User-Team Swap: Complete Binding Set (8 edits)

After v1 9k worked but left UI weirdness (Week-1 matchups not visible,
trade-block popups for non-user-team players), built `scripts/9z_find_refs_to.js`
to scan all tables for refs still pointing at the old user binding
(Team row 7 = Cards, Coach row 64 = Matt Lafleur). Found three more
high-signal bindings 9k v1 missed:

- **`Franchise.LeagueOwner`** → still pointing at old coach (probably the
  primary user binding the UI uses for league-wide context)
- **`Team[old].UserCharacter`** → still pointing at old coach
- **`Team[new].UserCharacter`** → was NULL, should point at new coach
- **`ArcContext.Team`** → still pointing at old team's row

Extended 9k v2 to apply 8 edits total (4 originals + 4 above). Test on
`CAREER-UPDATED-ROSTER-HAWKS-V2`: validator clean, **user reports the
weirdness is fixed.** Week-1 matchups visible; no stray Cards-player popups.

**Complete user-team binding set (canonical for M26 franchise files):**

| # | Field | Source pointer (Cards example) | Target (SEA example) |
|---|---|---|---|
| 1 | `FranchiseUser.Team` | Team table row 7 | row 32 |
| 2 | `FranchiseUser.UserEntity` | Coach row 64 | row 68 |
| 3 | `Coach[old HC].IsUserControlled` | true | false |
| 4 | `Coach[new HC].IsUserControlled` | false | true |
| 5 | `Franchise.LeagueOwner` | Coach row 64 | row 68 |
| 6 | `Team[old row].UserCharacter` | Coach row 64 | NULL |
| 7 | `Team[new row].UserCharacter` | NULL | Coach row 68 |
| 8 | `ArcContext.Team` | Team row 7 | row 32 |

All 8 implemented in `scripts/9k_swap_user_team.js`.

**Diagnostic script kept:** `scripts/9z_find_refs_to.js` — generic ref-scanner
useful for any future "what else points at X" investigation.

## 2026-05-08 (LATE EVE +5) - BREAKTHROUGH: User-Team Swap Sidesteps V11-V19

After 7 failed attempts to crack the V11-V19 ceiling on `CAREER-HAWKSSTG9`,
pivoted to the user's better suggestion: instead of fighting Madden's sim
invariants, **start from `CAREER-UPDATED-ROSTER` (V20 source — already has
vets on real-life teams + sims past the draft cleanly) and swap the user's
controlled team from Cardinals to whatever they want.**

**Discovery — user→team binding lives in three places (probed via
`scripts/9z_probe_user_full.js`):**
1. `FranchiseUser` table (id=4293): 1 live record with
   - `Team` ref → Team table row (currently row 7 = Cardinals)
   - `UserEntity` ref → Coach table row (currently row 64 = "Matt Lafleur" HC)
   - `AdminLevel`: "Owner"
2. `Coach` table (id=4160, 470 records, 128 live): the `IsUserControlled`
   flag — exactly one Coach has it true (the user's HC).
3. (Probably) various per-team binding tables (TeamSetting, PlayerPersonnel)
   — see "Known issues" below.

**Schema map (CAREER-UPDATED-ROSTER):**
- Team table id=5917, 32+ records. Row order ≠ TeamIndex; need to
  iterate to find each TeamIndex's row. SEA = TeamIndex 27 = row 32.
- Coach table id=4160. Each team's HeadCoach is one record with
  `Position='HeadCoach'` and `TeamIndex` set. SEA HC = Mike Macdonald row 68.

**Implemented `scripts/9k_swap_user_team.js`** — minimal-touch swap:
1. `FranchiseUser.Team` ref: row N (old) → row M (target team's row in Team table)
2. `FranchiseUser.UserEntity` ref: row of old HC → row of target team's HC
3. `Coach.IsUserControlled`: false on old HC, true on new HC

Test: copied `CAREER-UPDATED-ROSTER` → `CAREER-UPDATED-ROSTER-HAWKS`, ran
`9k_swap_user_team.js --target-team-index 27`. Validator clean (51,545 refs,
0 broken). **User test: loads, controls Seahawks (Mike Macdonald HC), sims
past the draft cleanly.**

**Known issues to fix (additional user-team bindings not yet swapped):**
- Week 1 matchups not visible on the schedule UI
- Trade-block popups for players that aren't on the user's team (some other
  table still considers Cards-related players as the user's)

These point to additional bindings beyond `FranchiseUser` + `Coach`. Probable
suspects:
- `FranchiseUser.TeamSetting` ref (currently → tableId=4172, row=33) — likely
  per-team settings record we should also point at the new team
- `PlayerPersonnel` (32 live records, one per team) — may have a hidden
  per-team owner/control flag
- `Owner` records — 33 live owner records on the Cards franchise; may need
  re-pointing
- `UserRequestIssuer` / various `*RegisterUserReaction` tables — UI-driven
  notifications routed by team

Next iteration: probe these tables, identify per-team rows for SEA, swap.

**Recommended new architecture (validated):**
1. Source: `CAREER-UPDATED-ROSTER` (vets on real teams, V20-quality, sims clean)
2. Copy → `CAREER-UPDATED-ROSTER-<TEAM>`
3. `node scripts/9k_swap_user_team.js --franchise <copy> --target-team-index <0-31>`
4. `node scripts/9z_validate_franchise.js --franchise <copy>` — sanity check
5. Optionally layer V20 9g (rookie-stat-baseline branch) for 2026 rookies +
   updated ratings: `node scripts/9g_sync_franchise_from_data.js --franchise <copy> --apply --allow-unmatched`
6. Load in Madden, control any team, sim past the draft.

**This sidesteps the V11-V19 ceiling entirely** — no team moves, no cap math,
no depth chart fill needed. The V20 source already has the vets in place;
we just swap who's at the wheel.

**Artifacts created tonight (kept):**
- `scripts/9k_swap_user_team.js` — user-team swap, primary new tool
- `scripts/9z_probe_user_team.js` — broad probe of user/owner/control fields
- `scripts/9z_probe_user_binding.js` — targeted probe of binding tables
- `scripts/9z_probe_user_full.js` — full resolve of FranchiseUser → Team + Coach
- `scripts/9z_probe_depthchart.js` — DepthChart schema probe
- `scripts/9z_dump_team_cap.js` — per-team cap diagnostic
- `scripts/9j_fill_depth_chart.js` — depth-chart fill pass (didn't fix V19,
  but kept for reference / future use)

## 2026-05-08 (LATE EVE +4) - Depth-Chart Fill Pass: Built, Tested, Doesn't Fix CTD

After ruling out cap math and operational decomposition, depth chart fill
was the most coherent remaining hypothesis. Built **`scripts/9j_fill_depth_chart.js`**
(standalone, composable with any state) that:
- Reads each team's DepthChart record (35 position fields × 6 depth slots = 210
  potential entries per team; 6,720 league-wide)
- For each null slot, fills with highest-OVR active player on that team
  matching the slot's primary/fallback Madden position list
- Standard 22 + 13 specialty slots (3DRB, KR, PR, SLWR, NT, etc.)

**Test on `CAREER-HAWKSSTG9-CUT-FA-DC`** (built from CUT_MODE V19 + script 9
sign + DC fill):
- 2,531 previously-null slots filled
- Validator clean (51,249 refs, 0 broken)
- Total filled DC slots went from 2,555 → 5,086 (76% of league-wide capacity)

**User test: still CTDs same way.**

**Schema artifact (worth keeping):** the DC pool is at `tableId=5878` (1260
records, 6 Player slots per row). DC record has 36 fields (35 position +
LockedEntries). Mapping to Madden Player.Position:
```
DC slot → Player.Position fallback list
QB→[QB] HB→[HB,FB] FB→[FB,HB] WR→[WR] TE→[TE]
LT→[LT,RT] LG→[LG,RG] C→[C,LG,RG] RG→[RG,LG] RT→[RT,LT]
LE→[LE,RE] DT→[DT] RE→[RE,LE]
LOLB→[LOLB,ROLB] MLB→[MLB,LOLB,ROLB] ROLB→[ROLB,LOLB]
CB→[CB] FS→[FS,SS] SS→[SS,FS] K→[K] P→[P] LS→[LS,C,TE]
3DRB→[HB] PWHB→[HB,FB] SLWR→[WR] SLCB→[CB,FS,SS]
SUBLB→[LOLB,MLB,ROLB] NT→[DT]
RLE→[LE,DT] RRE→[RE,DT] RDT→[DT] GAD→[LE,RE,DT]
KR→[WR,HB,CB] PR→[WR,HB,CB] KOS→[K,P]
```

**Definitive close on the V11-V19 ceiling.** Tested 7 distinct hypotheses
this evening:
1. Cap math: zero (V11-V18 pattern) — CTD
2. Cap math: preserve source — CTD
3. Cap math: flat $285M — CTD
4. Cap math: per-team snapshot (correct) — CTD
5. Stage timeline: stage 9 vs Week 1 — both CTD for team moves
6. Operational decomposition: cut + sign two-phase — CTD (cap +$93M)
7. Depth chart fill: 2,531 slots populated — CTD

**The V11-V19 file-edit team-move pattern is empirically irrecoverable for
post-franchise bulk vet moves at stage 9 (or Week 1).** Some unidentified
sim-engine invariant validates state we cannot introspect from outside the
binary. Future sessions: do NOT spend further time on this branch — the wiki
now documents every path tried.

**Production recommendation, validated:**
- `CAREER-HAWKSSTG9-FA` (script 9 FA moves only) sims past the draft.
- + V20 9g (rookie-stat-baseline `9g_sync_franchise_from_data.js`, vet team
  moves OFF) for ratings + 2026 rookies on real teams.
- Walker stays on SEA, ~50-100 vets on Madden's stock teams (the trades).
- Use `9h_generate_roster_changes.js` for the markdown checklist of residual
  trades to execute manually IF accuracy matters more than zero-manual-work.

**Artifacts kept (useful to future work):**
- `scripts/9j_fill_depth_chart.js` — standalone, composable
- `scripts/9z_dump_team_cap.js` — diagnostic
- `scripts/9z_probe_depthchart.js` — schema probe
- `output/blob_*_9g.js` — extracted unreachable 9g blobs (pre-V11 reference
  versions)
- Worktree `.claude/worktrees/vets-team-move-test` with V19 + cap snapshot +
  CUT_MODE flag (can be removed)

## 2026-05-08 (LATE EVE +3) - Cut+Sign Decomposition Also CTDs; Cap Ruled Out

User proposed clever decomposition: instead of bulk team→team moves (V19's
broken pattern), CUT misplaced vets to FA pool, then re-sign them via the
proven `9_apply_transactions.js` (script 9). Both halves use code paths
Madden handles natively.

**Implementation:** added `CUT_MODE` flag to V19 in worktree
(`.claude/worktrees/vets-team-move-test`). When `CUT_MODE=true`, the
team-move pass redirects every team→team and FA→team move to FA pool.
Existing FA-pool maintenance (Roster array removal, FreeAgents append, ref
nulling) handles the cut.

**Pipeline test:**
1. Cut V19 run → 495 vets cut to FA pool, validator clean. **User test: CTDs
   part way through draft sim.** Cuts at scale aren't the issue.
2. Cut + script 9 sign → 519 FAs re-signed to real teams, validator clean.
   **User test: CTDs during draft sim, SEA cap shown +$93M.**

**Cap is now decisively ruled out** as the CTD root cause. We've CTD'd at
-$193M, -$48M, and +$93M cap states. Same failure regardless of cap.

**What we've now ruled out across 6 attempts on this branch:**
- Cap math (zero / preserve / flat $285M / per-team snapshot)
- Rookie injection interaction (test with rookies off)
- Stage timeline (V20 confirmed Week 1 vs stage 9 has no effect for team moves)
- Operational decomposition (atomic move vs cut+sign two-phase)

**The V11-V19 ceiling is structural.** Bulk vet team movement at any scale,
via any code path tested, breaks Madden's draft sim. Specifically: when a
team enters the 2026 draft with players on different teams than Madden's
stock-roster expectation, the draft engine encounters something it can't
process — most likely depth chart slots that V19 nulled but never refilled
(invariant #2 from the original list, only "null" half implemented).

**Remaining technical lever:** depth chart fill pass. Walks every team's
DepthChart records, finds null slots, fills with highest-rated remaining
player at that position. Real engineering work (~1 hour focused), addresses
a known V19 gap, but no guarantee other invariants don't also break sim.

**Realistic recommendation now well-supported by evidence:** V20 + script 9
is the achievable automatic path. Walker stays on SEA, ~50-100 vets on
stock-Madden teams, all FAs accurate, all rookies on real teams, sims clean.

## 2026-05-08 (LATE EVE +2) - Diagnostic: Team-Move-Only Also CTDs Draft Sim

**Diagnostic test (`CAREER-HAWKSSTG9-VTM5`):** disabled `ENABLE_PASS_3_INJECT`,
ran V19 with vet team moves + per-team cap snapshot ONLY (no rookie inject,
no auto-rookie disposal). 1,084 vet moves applied, validator clean. SEA cap
display: −$48M (less negative than VTM4's −$193M because no rookies added).

**Result: still CTDs at draft sim.**

**This rules out cap-math AND rookie-inject interaction as CTD root causes.**
The remaining V11-V19 unhandled state, by elimination:

1. **DepthChart slots V19 nulled but never repopulated** — top suspect. Draft
   engine reads depth chart to slot drafted prospects; null entries dereference
   into bad state.
2. **Per-record contract tables on moved vets** (PlayerReSignNegotiation,
   ContractOffer, PlayerAcquisitionEvaluation) — V19 nulls Player refs but
   may need to delete the records or recreate for new team.
3. **Some other invariant we haven't identified.**

**Combined ruling on the V11-V19 stage-9 hypothesis (across all 5 attempts
on this branch this evening):** the post-franchise bulk vet team move pattern
remains structurally bounded. Stage 9 is sim-tolerant for V20-style ratings +
rookie injection (no team moves). It is NOT sim-tolerant for team moves alone,
regardless of cap state.

**Where this leaves the user:**
- For accurate vet teams + working sim: still 9h checklist + manual UI work.
- For zero-manual-work + working sim: V20 + script 9 (FA-only). Walker still
  on SEA, ~50-100 vets on stock-Madden teams.
- For continued team-move dev: depth-chart-fill pass is the next coherent
  feature to attempt. Real engineering work (likely hours), uncertain to fix
  the CTD but addresses a known V19 gap.

## 2026-05-08 (LATE EVE +1) - Per-Team Cap Snapshot: Math Right, Sim Still CTDs (now in Draft)

**Attempt #3 (per-team cap snapshot)** — added `captureSourceCapBudget` to V19
that snapshots per-team `(sum(PLYR_CAPSALARY), SalCapCapRoom)` BEFORE any
modifications. `effectiveLimit = sourceSum + sourceCapRoom`. Then
`recalcTeamCapFields` computes `new_CapRoom = effectiveLimit − new_sum`.

Per-team cap math now mathematically consistent: SEA effectiveLimit=32,468,
new commitments=50,832 → CapRoom=−18,364. Validator clean. **Sim CTDs at a
new point: when user enters the draft and attempts to sim picks** (load +
stage 9→10 transition both work; the draft engine itself fails).

User-reported displayed cap: SEA shows **−$193M**. With stored CapRoom
−18,364, that's a display ratio of ~$10,500 per Madden cap unit. Not a clean
power-of-ten — suggests either (a) other cap-derived fields (RookieReserve,
NextYearCapRoom, etc.) feed into the displayed value, or (b) Madden applies
a ~10K-per-unit display scaling. Worth investigating but not the CTD trigger
(V20 attempt #1 also had positive cap + CTD).

**What this finally rules out about cap as the CTD root cause:** every cap
variant we tried — zero, preserve, flat-$285M, snapshot-based — produced a
sim CTD. Cap-math improvements are real (we now have legible cap displays
and the wiki has a working snapshot pattern), but cap is not the missing
invariant. The next suspect is the draft engine itself given the new CTD
location: post-stage-10-entry, during draft-pick simulation.

**Hypotheses for the draft-sim CTD:**
1. **Disposed auto-prospects + injected rookies leave the draft pool in an
   inconsistent state.** V19 sets all real rookies to YearDrafted=0 (already
   drafted) and disposes unused auto-prospects to FA. The draft engine has
   nothing valid to draft. (V20 has the same setup and sims past the draft,
   so this alone isn't sufficient — but combined with team moves may be.)
2. **DepthChart slots nulled by the team-move pass remain unfilled.** The
   draft engine may try to slot drafted rookies into depth charts that have
   null entries, dereferencing into a bad state. V19 nulls but never
   repopulates.
3. **Per-record contract tables on moved vets** (PlayerReSignNegotiation,
   ContractOffer, PlayerAcquisitionEvaluation) may need refreshing for
   draft engine's negotiation logic, not just null-clearing.

**Diagnostic added (kept):** `scripts/9z_dump_team_cap.js` — read-only,
dumps per-team commitment + stored CapRoom + sample player records.

**Recommendation:** the V11-V19 ceiling persists at stage 9 with full cap
math. Each new fix exposes a new failure point. After 4 attempts on this
branch (V19 baseline + 3 cap variants), pivoting to `V20 + script 9` for the
zero-manual-work path is the realistic answer. Accept ~50-100 vets on wrong
teams (the trades), full FA accuracy, full rookie accuracy, sims clean.

## 2026-05-08 (LATE EVE) - Cap-Math Attempts on Stage-9 Vet Team Move

User pushed to fix the V19 stage-9 CTD rather than pivot to manual trades. Three
cap-handling variants attempted on the worktree at
`.claude/worktrees/vets-team-move-test` (branched from `9g-vets-team-move`
tip `4d2218b`):

**Attempt #1 (preserve)** — removed the V11-V18 zeroing pass entirely. Source
franchise's original `SalCapCapRoom` carries through. User result: cap shown
on main screen (non-zero) + Walker correctly off SEA. **Sim still CTD.**
Hypothesis: source CapRoom is stale relative to the team-move composition
(KC accepts many big new contracts → over its source-stored room).

**Attempt #2 (compute with $285M flat limit)** — `SalCapCapRoom = 285_000K -
sum(PLYR_CAPSALARY)`. User result: SEA showed -$289M in main screen. **Sim
CTD.** Diagnostic via `scripts/9z_dump_team_cap.js` revealed the unit
assumption was wrong: in the pristine `CAREER-HAWKSSTG9`, SEA's effective cap
budget (sum of PLYR_CAPSALARY + stored CapRoom) is only ~32,468 — not 285,000.
Each team has a different effective cap limit (rollover, dead money, prior
penalties), so a single hardcoded league cap doesn't apply uniformly. Also
discovered weird wrap behavior: my writes of `~234,000` to SalCapCapRoom
displayed as `-27,976` for some teams (sign-bit interpretation differs by
team, not yet understood). **Investigation pending; cap might not be the
actual CTD trigger** — same CTD behavior across all three cap variants.

**Open suspect after cap-math is ruled out:** invariant #2 (DepthChart pool).
V19 nulls depth-chart slots that pointed at moved vets but never repopulates.
Madden's sim engine may require every depth-chart slot to be filled with a
present roster player. Worth testing if a per-team depth-chart-fill pass
unblocks sim.

**Diagnostic added:** `scripts/9z_dump_team_cap.js` (read-only, dumps per-team
PLYR_CAPSALARY sum + stored SalCapCapRoom). Useful for any future cap-debug
work.

## 2026-05-08 (EVE) - Stage-9 Vet Team Move: Falsified via $0 Cap CTD

User asked: "if I make a fresh franchise file with vets on real teams + pre-draft
state, does the codebase have something to assign rookies to real teams after the
in-game draft?" Answer: 9g already does that overlay BEFORE the draft (Pass 3 onto
YearDrafted=1, YearsPro=0 auto-prospects); the draft engine then drafts the leftover
synthetic class. No separate post-draft script needed.

Then user recalled having "a script that could move players when in stage 9 of free
agency". Found it: **`scripts/9_apply_transactions.js`** (commit 5b87814,
2026-04-13). Reads `data/roster_players_rated.json`, filters `TeamIndex === 32`
(FA pool only), looks up by name, sets to real-life signing team + Signed status +
1-yr min contract. **Tested against `CAREER-HAWKSSTG9`:** 347 FAs moved,
validator clean (51,799 refs / 0 broken), Madden loaded fine.

Limitation surfaced: Kenneth Walker III still on SEA in the result. Cause: Walker is
*signed* in CAREER-HAWKSSTG9 (TeamIndex=27 = SEA stock), not in FA pool. Script 9's
filter skips signed players → trades aren't handled. The data file
`roster_players_rated.json` correctly lists Walker on KC, but script 9 can't act on
already-signed records.

Tested the V20 hypothesis ("stage 9 is more sim-tolerant than Week 1") against
the V11-V19 vet-team-move pass: copied `CAREER-HAWKSSTG9-FA` → ran V19 9g
(`9g-vets-team-move` branch tip 4d2218b, `ENABLE_VET_TEAM_MOVE=true`) →
**validator clean** (3,960 records / 50,417 refs / 0 broken / 810 vets moved /
265 rookies injected). Repeated against pristine `CAREER-HAWKSSTG9` to rule out
script 9's contract changes as a confound: also validator clean, 1,084 vet moves
(more, since FA layer hadn't pre-placed any). **Both CTD on sim.**

User loaded the result and reported: **"$0 cap space" on the main franchise
screen.** That's the smoking gun. V19's cap pass zeroes
`SalCapCapRoom`/`SalCapSpendingMoney`/etc. on the assumption Madden recomputes
on load — Madden doesn't, it trusts the stored 0, and the sim engine validates
cap before advancing. **Stage-9-tolerant hypothesis: falsified for the team-move
case.** Holds only for V20's ratings + rookie injection (which doesn't touch any
team or cap field).

Worktree at `.claude/worktrees/vets-team-move-test` for V19 reproduction; can be
removed.

## 2026-05-07 - Created LLM Wiki

- Added `AGENTS.md` as the root entry point for agents.
- Added `docs/llm-wiki/README.md`, `project-map.md`, `commands.md`,
  `data-contracts.md`, `decisions.md`, and this task log.
- Captured the current CLI pipeline shape from `run.py` and `roster_run.py`.
- Noted that `ARCHITECTURE.md` is a future web app blueprint, not the current
  implementation.

## 2026-05-08 (PM, late) - Working Recipe Confirmed: V20

After the team-move file-edit dead end, found the recipe by user-recall:

- The user has `CAREER-UPDATED-ROSTER` in their Madden saves dir from a
  prior session — a franchise template with vets already on real-life
  teams (Davante Adams on LAR, Saquon Barkley on PHI, etc.).
- Running default V8 9g on a copy of it produces **`CAREER-9G-V20`** —
  vets correct + 2026 rookies fresh-injected on real-life teams + sim
  past Week 1 works + exit clean.
- The recipe does NOT require any vet TeamIndex changes. The pre-built
  source already has them right. 9g just adds rookies + updates ratings.

`ROSTER-NEW` (also in the saves dir) is in a different binary format —
`madden-franchise` v3.8.0 AND v4.2.2 both fail with `incorrect header
check` on it. Likely a `.ros` file in a format mf doesn't fully
decompress. Not needed for the V20 recipe.

How `CAREER-UPDATED-ROSTER` was originally built isn't documented here
— likely an in-game roster import from `data/raw/ROSTER-Official` or a
community roster file. Tracked as open work in `decisions.md`.

## 2026-05-08 (PM) - Vet Team-Move Investigation: 8 invariants, sim CTD persists

Tried to make 9g move ~1086 vets between teams per
`full_solution_2_ratings.json` and have the franchise still sim past
Week 1. Status: validator clean every iteration, franchise loads, sim
CTDs immediately. Work paused on `9g-vets-team-move` branch with
`ENABLE_VET_TEAM_MOVE = false` on baseline.

8 invariants identified (all implemented in V11..V18):
1. Roster Player[] per team — remove from old, append to new, compact.
2. DepthChart pool — null any slot pointing at the moved vet.
3. 13 team-affiliated Player[] sub-tables on populated Team record
   (PracticeSquad / Marketed* / training / active-abilities).
4. Per-record contract tables: PlayerReSignNegotiation, ContractOffer,
   PlayerAcquisitionEvaluation — null Player ref on stale records.
5. Player.PrevTeamIndex — set to old team.
6. Contract layout normalization — pull Salary{ContractYear} as new
   uniform per-year value, Bonus = Salary/9, ContractYear = 0. Mirrors
   the working `CAREER-SEAHAWKSWEEK1` pattern.
7. Team SalCap derived fields — recompute SalCapRosterSize +
   SalCapRookieCount; zero SalCapCapRoom etc. for Madden recompute.
8. Franchise.FreeAgents pool — 3500-slot Player[] sub-table on the
   Franchise singleton holding league-wide FA refs. Append on
   move-to-FA, remove on move-off-FA.

Three parallel-agent investigations (2026-05-08):
- madden-franchise lib v4.2.2 = ESM rewrite + schema fixes only. No new
  trade/team-move APIs. Stay on 3.8.0.
- Community tools survey: nobody publishes a working "bulk team move
  via file edit, post-sim". Pattern is build rosters in `.ros` BEFORE
  the franchise starts (FFC Retro Rosters etc.).
- Auto-UDFA records (YD=0, YP=0): Madden auto-generates ~444 of them
  as depth fillers with procedural names. One tagged "Day1Starter" on
  the Chiefs prompted V19's dispose pass.

V19 (on `9g-vets-team-move`): Pass 5 disposes 288 auto-UDFAs to FA
pool. Fixes the visible "fake-named players on team rosters" issue.
**Sim CTD on team-moved vets remains unresolved.**

Bottom line: the file-edit path appears structurally bounded against
post-sim bulk team moves. Recommendation for accurate vet teams is
`scripts/9h_generate_roster_changes.js` (in-game checklist) or accept
the V8 baseline (Madden's curated rosters).

## 2026-05-08 - Post-Draft Franchise Sync (9g) + Validators (9z) + In-Game Checklist (9h)

Built end-to-end tooling to apply our generated 2026 rookie data and our
veteran ratings into a live Madden 26 `.franchise` save.

- `scripts/9g_sync_franchise_from_data.js`: updates vet ratings/dev trait
  from `full_solution_2_ratings.json`; overlays 2026 rookies onto Madden's
  auto-prospect placeholders (filter: `YearDrafted=1 AND YearsPro=0`, ~224
  records per franchise) using a same-team-prefer overlay + V5-style fresh
  inject for cross-team mismatches; appends each rookie to its drafting
  team's `Roster` Player[] sub-table. Tested end-to-end: validator clean,
  rosters look right, sim past Week 1 works, exit clean.
- Vet team moves are implemented in `9g_sync_franchise_from_data.js` but
  the flag `ENABLE_VET_TEAM_MOVE` is OFF by default — see `decisions.md`.
- `scripts/9z_validate_franchise.js`: read-only reference-integrity check.
  Walks every table, finds Player-row references, flags any live record
  pointing at an empty Player row. ~1.5s per franchise.
- `scripts/9z_diff_franchises.js`: field-level diff between two franchise
  files. Used during debugging to spot the contract-floor bug
  (`PLYR_CAPSALARY -> 895` on hundreds of vets).
- `scripts/9z_diagnose_rosters.js`: per-team Player count via TeamIndex +
  ContractStatus distribution. Quick sanity check.
- `scripts/9z_explore_player_arrays.js`: maps the populated Team table
  (id != the 1-record stub returned by `getTableByName('Team')`) to its
  Roster Player[] sub-table.
- `scripts/9h_generate_roster_changes.js`: read-only diff between the
  franchise's current TeamIndex assignments and `full_solution_2_ratings.json`,
  output as a markdown checklist (`output/roster_changes.md`) of trades /
  signings / releases for the user to execute in Madden's UI.

