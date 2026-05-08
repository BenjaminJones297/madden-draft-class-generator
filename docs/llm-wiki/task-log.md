# Task Log

Append brief handoff notes for meaningful work. This file is for future LLMs,
not a full changelog.

## 2026-05-07 - Created LLM Wiki

- Added `AGENTS.md` as the root entry point for agents.
- Added `docs/llm-wiki/README.md`, `project-map.md`, `commands.md`,
  `data-contracts.md`, `decisions.md`, and this task log.
- Captured the current CLI pipeline shape from `run.py` and `roster_run.py`.
- Noted that `ARCHITECTURE.md` is a future web app blueprint, not the current
  implementation.

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

