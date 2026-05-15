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
| `data/rookie_ratings_post_madden.json` | Madden round-trip/manual export plus optional `scripts/9q_polish_rookie_ratings_post_madden.js` | `scripts/9g_sync_franchise_from_data.js`, `scripts/9m_purge_fake_rookies.js` | Flat per-rookie ratings/teams used for franchise injection and fake-rookie keep-list. |
| `data/roster_players_rated.json` | `scripts/8_generate_roster_ratings.py` | Roster/sync workflows | Active NFL players with ratings and contract fields. |
| `data/reference_draft_class.json` | `scripts/extract_reference_class.js` | `scripts/5_generate_ratings.py` | Optional community reference class anchor. |
| `data/prospect_profiles.json` | Prospect fetch/enrichment scripts | `scripts/5_generate_ratings.py` | Enriched prospect profiles used in prompts. |
| `data/raw/headshot_manifest.json` | `scripts/9n_fetch_rookie_headshots.py` | `scripts/9o_extract_skin_tones.py` | Per-rookie headshot fetch status: espn_id, url, source path, byte count. |
| `data/raw/skin_tone_measurements.json` | `scripts/9o_extract_skin_tones.py` | `scripts/9o_bucket_rookies.py` | Per-photo Lab L* metric + confidence + per-region skin_ratio. |
| `data/calibration_vets.json` | `scripts/9o_pick_calibration_vets.js` | `scripts/9n` (re-used) + `9o_build_calibration.py` | ~80 vets across all 8 skinTone truth buckets, rookie-shape so 9n consumes it directly. |
| `data/raw/vet_skin_measurements.json` | `scripts/9o_extract_skin_tones.py` (against vet headshots) | `scripts/9o_build_calibration.py` | Lab L* per calibration vet — the truth side of calibration. |
| `data/skin_tone_calibration.json` | `scripts/9o_build_calibration.py` | `scripts/9o_bucket_rookies.py` | Fit results: method (anchor / quantile_nfl), per-tone L* anchors, quantile edges, agreement stats, raw_pairs. |
| `data/rookie_appearances.json` | `scripts/9o_bucket_rookies.py` | `scripts/9p_apply_visuals.js` | Final per-rookie skinTone (1-8) + confidence + manualReview flag — the input to the franchise applier. |

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

## Rookie Visuals Pipeline Shape

`data/rookie_appearances.json` is an array of:

```jsonc
{
  "firstName":         "Jeremiyah",
  "lastName":          "Love",
  "skinTone":          7,                // 1 (lightest) to 8 (darkest)
  "confidence":        0.92,             // 0-1 — detection × skin-pixel ratio
  "l_star":            128.0,            // raw Lab L* (OpenCV 8-bit scale)
  "headshotUrl":       "https://a.espncdn.com/.../4870808.png",
  "file":              "jeremiyah_love.png",
  "notes":             "ok",             // "ok" | "no_face" | "no_skin"
  "calibrationMethod": "anchor",
  "manualReview":      false             // true when confidence < 0.5
}
```

`data/skin_tone_calibration.json` has:

```jsonc
{
  "method":         "anchor",            // or "quantile_nfl"
  "anchors":        { "1": 175.7, "2": 187.6, ..., "8": 117.7 },  // mean L*
  "quantile_edges": [193.0, 181.0, ..., 66.0],  // 7 cuts, lightest first
  "agreement": {
    "anchor":       { "exact": 29, "off1": 58, "n": 79 },
    "quantile_nfl": { "exact": 16, "off1": 53, "n": 79 }
  },
  "raw_pairs":      [ /* per-vet debug */ ]
}
```

When editing `rookie_appearances.json` by hand to fix algorithm mis-classifications,
preserve the shape — `9p_apply_visuals.js` reads `skinTone` and `confidence` and
ignores everything else.

## Generated Data Guidance

- Do not hand-edit large generated JSON unless the task is explicitly data repair.
- Prefer regenerating from the relevant script when possible.
- If modifying generated formats, update `data/contracts/*.schema.json` and this
  page.
- If adding fields consumed by both Python and Node, update both enum/util sides.
