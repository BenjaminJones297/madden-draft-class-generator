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
| 3 | `scripts/3_extract_roster_ratings.js` | Optional official Madden ratings extraction. |
| 8 | `scripts/8_generate_roster_ratings.py` | Merge roster, contract, and rating data. |

## Additional Scripts

- `scripts/9_apply_transactions.js`: apply transaction data to Madden files.
- `scripts/9c_inject_rookies.js`: inject rookie data.
- `scripts/9d_sync_roster.js`: sync roster records.
- `scripts/9e_sync_ratings.js`: sync ratings.
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

