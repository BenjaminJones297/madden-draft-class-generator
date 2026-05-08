# Data Contracts

Start with the compact examples in `data/contracts/` before opening large JSON
files. Many `data/*.json` files are generated artifacts and can be large.

## Important Files

| File | Producer | Consumer | Notes |
|---|---|---|---|
| `data/prospects_2026.json` | `scripts/4_fetch_2026_prospects.py` | `scripts/5_generate_ratings.py` | Prospect profiles and measurables. |
| `data/calibration_set.json` | `scripts/2_extract_calibration.js` | `scripts/5_generate_ratings.py` | Madden 2025 calibration examples grouped by position. |
| `data/current_player_ratings.json` | `scripts/3_extract_roster_ratings.js` | `scripts/5_generate_ratings.py` | Optional current-player anchors grouped by position. |
| `data/prospects_rated.json` | `scripts/5_generate_ratings.py`, polish scripts | `scripts/6_create_draft_class.js` | Generated Madden attributes for prospects. |
| `data/roster_players_rated.json` | `scripts/8_generate_roster_ratings.py` | Roster/sync workflows | Active NFL players with ratings and contract fields. |
| `data/reference_draft_class.json` | `scripts/extract_reference_class.js` | `scripts/5_generate_ratings.py` | Optional community reference class anchor. |
| `data/prospect_profiles.json` | Prospect fetch/enrichment scripts | `scripts/5_generate_ratings.py` | Enriched prospect profiles used in prompts. |

## Prospect Input Shape

Schema example: `data/contracts/prospects_2026.schema.json`

Core fields:

- Identity: `name`, `firstName`, `lastName`
- Football context: `pos`, `school`, `rank`, `grade`, `notes`
- Measurables: `ht`, `wt`, `forty`, `bench`, `vertical`, `broad_jump`,
  `cone`, `shuttle`

## Rated Prospect Shape

Schema example: `data/contracts/prospects_rated.schema.json`

Core fields:

- Identity and context: `firstName`, `lastName`, `pos`, `school`, `ht`, `wt`,
  `rank`, `draftRound`, `draftPick`
- `ratings`: Madden attribute map. Field names come from `utils/enums.py` and
  `utils/enums.js`.

Important rating fields include:

- Base traits: `overall`, `speed`, `acceleration`, `agility`, `strength`,
  `awareness`
- Position skills: throwing, blocking, coverage, rushing, receiving, kicking
- Metadata-like values: `devTrait`, `morale`, `personality`, `unkRating1`

## Calibration Shape

Schema example: `data/contracts/calibration_set.schema.json`

The file is grouped by position. Each item has:

- `profile`: real prospect profile and draft context.
- `ratings`: actual Madden launch ratings.

`scripts/5_generate_ratings.py` samples nearby examples by position, draft
round, weight, and available athletic testing.

## Current Player Ratings Shape

Schema example: `data/contracts/current_player_ratings.schema.json`

The file is grouped by position. It provides optional elite/current-player
anchors in the LLM prompt. This is separate from
`data/current_player_ratings_full.json`, which is used by the roster pipeline.

## Generated Data Guidance

- Do not hand-edit large generated JSON unless the task is explicitly data repair.
- Prefer regenerating from the relevant script when possible.
- If modifying generated formats, update `data/contracts/*.schema.json` and this
  page.
- If adding fields consumed by both Python and Node, update both enum/util sides.

