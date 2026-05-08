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

