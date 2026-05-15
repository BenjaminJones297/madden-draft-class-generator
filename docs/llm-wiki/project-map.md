# Project Map

## Entrypoints

- `run.py`: main draft-class pipeline orchestrator.
- `roster_run.py`: current NFL roster pipeline orchestrator.
- `README.md`: user-facing setup and usage. Some pipeline details may lag behind
  `run.py`.
- `ARCHITECTURE.md`: future web app blueprint. It is not the current app.

## Current Draft-Class Pipeline

`run.py` currently runs 7 steps:

| Step | File | Purpose |
|---|---|---|
| 1 | `scripts/1_fetch_combine_and_picks.py` | Fetch nflverse combine and draft-pick CSVs. |
| 2 | `scripts/2_extract_calibration.js` | Build Madden 26 calibration data from the 2025 class. |
| 3 | `scripts/3_extract_roster_ratings.js` | Optional roster rating extraction from a `.ros` file. |
| 4 | `scripts/4_fetch_2026_prospects.py` | Fetch and normalize 2026 prospect data. |
| 5 | `scripts/5_generate_ratings.py` | Generate Madden ratings with Ollama. |
| 6 | `scripts/polish_ratings4.js` through `scripts/polish_ratings12.js` | Deterministic calibration polish passes. |
| 7 | `scripts/6_create_draft_class.js` | Write the final `.draftclass` file. |

Optional reference input:

- `data/raw/CAREERDRAFT-NFLDRAFT2026` can be extracted by
  `scripts/extract_reference_class.js` when present.

## Current Roster Pipeline

`roster_run.py` runs:

| Step | File | Purpose |
|---|---|---|
| 7 | `scripts/7_fetch_nfl_roster_and_contracts.py` | Fetch active NFL rosters and contract data. |
| 7b | `scripts/7b_fetch_otc_contracts.py` | Scrape current contracts from Over The Cap (32 team pages → ~2,600 player profiles). Output `data/raw/otc_contracts.json`. Resumable; ~60-90 min full run. |
| 7c | `scripts/7c_merge_otc_into_rosters.py` | Merge OTC contract data into `nfl_rosters_2026.json` by normalized name. Run after 7b. |
| 3 | `scripts/3_extract_roster_ratings.js` | Optional official Madden ratings extraction. |
| 8 | `scripts/8_generate_roster_ratings.py` | Merge roster, contract, and rating data. |

## Additional Scripts

- `scripts/9_apply_transactions.js`: apply transaction data to Madden files.
- `scripts/9c_inject_rookies.js`: inject rookie data.
- `scripts/9d_sync_roster.js`: sync roster records.
- `scripts/9e_sync_ratings.js`: sync ratings.
- `scripts/9f_inject_rookies_from_franchise.js`: inject rookies from a source
  franchise file (alternative to `9g` when a separate franchise has the
  desired 2026 class).
- `scripts/9g_sync_franchise_from_data.js`: post-draft franchise sync. Updates
  vet ratings + overlays 2026 rookies onto auto-prospect placeholders + adds
  rookies to drafting team's Roster array. **Working recipe: run on a copy of
  `CAREER-UPDATED-ROSTER` (vets already on real teams).** See `decisions.md`
  for why default does NOT change vet TeamIndex. 2026-05-11 (PM): contract
  writes go through `fillContractYears()` (multi-year shape), Pass 5 recomputes
  team roster-size counters via `recalculateRosterSizes()`, optional Pass 6
  regenerates `PlayerReSignNegotiation` queue via `regenerateResignTables()`
  (opt-in `--regenerate-resign`; off by default — V20 source has corrupted
  vet contracts).
- `scripts/9h_generate_roster_changes.js`: read-only diff. Outputs a markdown
  checklist (`output/roster_changes.md`) of trades / signings / releases the
  user should execute in Madden's UI to make rosters match
  `full_solution_2_ratings.json`.
- `scripts/9j_fill_depth_chart.js`: standalone depth-chart fill — for each
  team's DC record, fills null position slots with highest-OVR players at
  that position (35 position slots × 6 depth × 32 teams). Composable. Did
  NOT fix the V19 sim CTD on its own (still kept for diagnostic value /
  future use).
- `scripts/9k_swap_user_team.js`: **swap the user's controlled team in a
  franchise.** Edits the full 8-binding user-team set (FranchiseUser.Team
  + UserEntity, Coach.IsUserControlled on old/new HC, Franchise.LeagueOwner,
  Team.UserCharacter on old/new, ArcContext.Team). Use to re-bind
  CAREER-UPDATED-ROSTER (Cards) to any team. See `commands.md` "User-Team
  Swap on V20 Source" recipe.
- `scripts/9l_dispose_auto_prospects.js`: dispose Madden's pre-generated
  2026 draft prospects (filter: YearDrafted=0, YearsPro=0,
  ContractStatus=Draft) to the FA pool. Removes draft-pool duplicates
  with 9g-injected real rookies. CAREER-UPDATED-ROSTER ships ~310 of these.
- `scripts/9m_purge_fake_rookies.js`: post-sim cleanup. After user advances
  through draft + preseason, Madden auto-signs UDFAs + generates next-year
  synthetic prospects. 9m purges YearsPro=0 records that are not in
  `data/rookie_ratings_post_madden.json`. With `--include-yd1`, it purges all
  YearDrafted=1 / YearsPro=0 players even if their names match real rookies.
  With `--delete` (used by `build_franchise.ps1` phase post), it marks purged
  rows `ContractStatus=Deleted` and removes them from team rosters plus
  Franchise.FreeAgents; it does not `rec.empty()`. Edit-the-autosave pattern
  (quit Madden without saving first).
- `scripts/build_franchise.ps1`: PowerShell wrapper orchestrating the
  pre-sim and post-sim phases. Accepts optional `-Ratings <path>` and
  `-Rookies <path>` flags that forward to 9g (`--ratings`/`--rookies`) and
  9m (`--rookies`) — lets the wrapper consume custom local files in place of
  the canonical `full_solution_2_ratings.json` / `rookie_ratings_post_madden.json`
  defaults. Also accepts `-ApplyVisuals` to run 9p after 9l and
  `-Appearances <path>` to override 9p's input. See `commands.md` "End-to-End
  Franchise Build" recipe.
- `scripts/9n_fetch_rookie_headshots.py`: fetches PNG headshots for the 265
  rookies via ESPN CDN, keyed by `espn_id` from nflverse `players.csv`.
  Fallback ladder: `/nfl/players/full/{id}.png` → `/college-football/...` →
  ESPN search API. Throttled ~200ms. Cache to `data/raw/headshots/` +
  manifest at `data/raw/headshot_manifest.json`. Coverage ~97% on first run.
- `scripts/9o_extract_skin_tones.py`: per-photo skin-tone metric extractor.
  MediaPipe FaceLandmarker (new `mediapipe.tasks` API — auto-downloads
  `face_landmarker.task` to `data/raw/`) → forehead+cheek landmark
  polygons → YCbCr skin filter (Hsu et al.) + Lab L* highlight cap → median
  L* per region → confidence-weighted output to
  `data/raw/skin_tone_measurements.json`. Supports `--debug-overlays N` to
  write annotated PNGs for eyeball verification.
- `scripts/9o_pick_calibration_vets.js`: picks N vets per truth skinTone
  bucket from a source franchise (default `CAREER-UPDATED-ROSTER`),
  outputs `data/calibration_vets.json` in rookie shape so 9n consumes it
  directly. Decodes `CharacterVisuals.RawData.skinTone` as truth.
- `scripts/9o_build_calibration.py`: joins vet truth + vet measurements,
  fits both anchor-mean and quantile-NFL classifiers, picks the better one
  on exact-match agreement (with off-by-one as tiebreaker), writes
  `data/skin_tone_calibration.json`. Anchor wins in practice (~37% exact /
  73% within ±1).
- `scripts/9o_bucket_rookies.py`: applies the chosen calibration method to
  rookie measurements, writes `data/rookie_appearances.json` (the input 9p
  consumes). Flags entries with `confidence < 0.5` for manual review.
- `scripts/9p_apply_visuals.js`: writes per-rookie skin-tone overrides into
  a franchise. For each rookie in `rookie_appearances.json`, locates the
  Player record by name, then: (a) if `CharacterVisuals` ref is non-null,
  updates `CharacterVisuals[row].RawData.skinTone`; (b) updates
  `Player.GenericHeadAssetName` to `gen_<min(7,tone)>_B_G_005` (consistent
  with Madden's auto-rookie template). The split path handles 9g's fresh-
  inject duplicates which have null CV refs — they still get a head-asset
  update which Madden renders from. Supports `--apply` / dry-run /
  `--skip-low-confidence`.
- `scripts/9z_probe_auto_rookies.js`: read-only diagnostic — buckets the
  Player table by (YearDrafted, YearsPro), shows samples by ContractStatus.
  Useful for understanding rookie/prospect state before disposal.
- `scripts/9z_validate_franchise.js`: ref-integrity check. Flags live records
  pointing at empty Player rows (the leading load-CTD class).
- `scripts/9z_diff_franchises.js`: field-level diff between two franchise files.
- `scripts/9z_diagnose_rosters.js`: per-team Player counts + ContractStatus
  distribution.
- `scripts/9z_dump_team_cap.js`: per-team SalCapCapRoom + sum(PLYR_CAPSALARY)
  diagnostic. Useful for cap-math debugging.
- `scripts/9z_explore_player_arrays.js`: maps the populated Team table to its
  Roster Player[] sub-table (skips the 1-record stub `getTableByName` returns).
- `scripts/9z_probe_depthchart.js`: dumps DepthChart record + DC pool schema.
- `scripts/9z_probe_user_team.js` / `9z_probe_user_binding.js` /
  `9z_probe_user_full.js`: progressively narrower probes of user→team
  binding tables (FranchiseUser, Coach, PlayerPersonnel, Owner, etc.).
  Built while designing 9k.
- `scripts/10_fetch_current_rosters.py`: fetch current roster data.
- `scripts/10_fetch_game_results.py`: fetch game results.
- `scripts/11_apply_game_results.js`: apply game result updates.
- `scripts/audit_ratings.js` and `_audit_*.py`: inspect quality and coverage.
- `scripts/validate_ratings.js`: validate generated rating data.

These scripts are more specialized than the two orchestrators. Read their headers
and call sites before changing them.

## Shared Utilities

- `utils/enums.py` and `utils/enums.js`: rating fields, positions, and enum maps.
- `utils/defaults.py`: default ratings by position.
- `utils/visuals_template.js`: default Madden appearance data.
- `scripts/lib/neighbor_sampler.py`: baseline sampling for LLM rating generation.

## Data Areas

- `data/contracts/`: compact schema examples. Read these before large JSON files.
- `data/raw/`: fetched CSVs, manual prospect CSV, Madden source files.
- `data/output/`: generated `.draftclass` output.
- `data/*.json`: generated and sometimes tracked pipeline artifacts.

## Dependency Shape

- Python handles orchestration, scraping, LLM calls, roster merge logic, and data
  shaping.
- Node handles Madden file I/O through `madden-franchise` and
  `madden-draft-class-tools`.
- Ollama is the default local LLM runtime.

