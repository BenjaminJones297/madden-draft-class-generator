# Madden 26 – 2026 Draft Class Generator

Generate a real-world 2026 NFL draft class and write it into a Madden 26 `.draftclass` file.
The LLM is calibrated using the 2025 class: real pre-draft profiles paired with their actual
Madden 26 launch ratings as ground truth, and current NFL player ratings as position benchmarks.

---

## Architecture Overview

```
nflverse combine CSV (2025) ─────────────┐
CAREERDRAFT-2025_M26 (launch ratings) ──►│ calibration_set.json
nflverse draft_picks CSV (2025) ─────────┘

User's Madden 26 .ros file ──────────────► current_player_ratings.json (position benchmarks)

Web scrape / combine data (2026) ────────► prospects_2026.json

calibration_set.json ────────────────────┐
current_player_ratings.json ─────────────►│ Ollama llama3:8b ──► prospects_rated.json
prospects_2026.json ─────────────────────┘

prospects_rated.json + header template ──► 2026_draft_class.draftclass
```

---

## Pipeline Scripts

### `scripts/1_fetch_combine_and_picks.py`
- Downloads `nflverse` combine CSV (all years) → filters 2025 & 2026
- Downloads `nflverse` draft_picks CSV → filters 2025
- Saves `data/raw/combine.csv`, `data/raw/draft_picks.csv`

### `scripts/2_extract_calibration.js`
- Downloads `CAREERDRAFT-2025_M26` from madden-draft-class-tools test data
  (this is the real Madden 26 launch draft class with Cam Ward, Travis Hunter, etc.)
- Reads it via `madden-draft-class-tools` → gets every prospect's full Madden ratings
- Joins on `firstName + lastName` to 2025 combine data
- Output: `data/calibration_set.json`
  ```json
  {
    "QB": [
      {
        "profile": { "name": "Cam Ward", "pos": "QB", "school": "Miami", "forty": 4.65,
                     "wt": 221, "ht": "6-2", "draft_round": 1, "draft_pick": 1 },
        "ratings": { "overall": 76, "speed": 72, "throwPower": 88, "throwAccuracy": 80, ... }
      }
    ],
    "WR": [...],
    ...
  }
  ```

### `scripts/3_extract_roster_ratings.js`
- Accepts a path to a user-provided Madden 26 `.ros` roster file
- Reads it using `madden-franchise` library
- Reads the `Player` table → exports current NFL player ratings grouped by position
- Output: `data/current_player_ratings.json`
  ```json
  {
    "QB": [ { "name": "Josh Allen", "overall": 99, "speed": 88, "throwPower": 97, ... } ],
    ...
  }
  ```
- **Optional**: If no roster file is provided, this step is skipped (calibration alone is used)

### `scripts/4_fetch_2026_prospects.py`
- Fetches 2026 NFL draft prospect data from multiple sources with fallbacks:
  1. **nflverse combine CSV** for measurables (if 2026 data exists)
  2. **Web scrape**: NFL.com, Pro Football Reference, or NFL Mock Draft Database
     for big board rankings, grades, position, school, measurables
  3. **Fallback**: reads `data/raw/prospects_2026_manual.csv` template if scraping fails
- Enriches with draft position ranking and consensus grade
- Output: `data/prospects_2026.json`

### `scripts/5_generate_ratings.py`
- For each 2026 prospect:
  1. Looks up calibration examples at same position (3–5 closest matches by measurable profile)
  2. Optionally includes 2–3 current NFL players at same position as rating anchors
  3. Builds a structured Ollama prompt:
     ```
     You are calibrating Madden 26 player ratings.

     REFERENCE — 2025 Rookies at [POSITION] (real profile → actual Madden 26 launch ratings):
     - Cam Ward | QB | Miami | 6-2, 221 lbs | 40yd: 4.65 | Round 1, Pick 1 | Draft Grade: A
       Madden ratings: overall=76, speed=72, throwPower=88, throwAccuracy=80, awareness=72, ...

     ANCHOR — Current NFL [POSITION] ratings:
     - Josh Allen | OVR 99 | speed=88, throwPower=97, throwAccuracy=92, awareness=97, ...

     Generate Madden 26 ratings for this 2026 prospect:
     Name: [name] | Pos: [pos] | School: [school] | [measurables] | Grade: [grade] | Board: #[rank]

     Return ONLY a JSON object with these exact fields: overall, speed, acceleration, agility,
     strength, awareness, throwPower, throwAccuracy, throwAccuracyShort, throwAccuracyMid,
     throwAccuracyDeep, throwOnTheRun, throwUnderPressure, playAction, ... [all draftclass fields]
     devTrait (0=Normal, 1=Impact, 2=Star, 3=XFactor), draftRound, draftPick
     ```
  4. Parses the JSON response, validates all required fields are present and in 0–99 range
  5. Retries with a correction prompt if any fields are missing or out of range
- Output: `data/prospects_rated.json`
- Uses **Ollama `llama3:8b`** via the `ollama` Python package (local, no API key needed)

### `scripts/6_create_draft_class.js`
- Reads `data/prospects_rated.json`
- Downloads `CAREERDRAFT-2025_M26` as a header template → reads it to extract header metadata
- Maps each prospect to the draftclass format:
  - Position string → `DraftPositionE` enum number (QB=0, HB=1, WR=3, TE=4, T=5, G=6, C=7,
    DE=8, DT=9, OLB=10, MLB=11, CB=12, FS=13, SS=14, K=15, P=16)
  - Applies default visuals JSON blob (generic body type)
  - Sets `draftable=1`, fills `homeState`, `homeTown`, `college=0` (no college enum mapping)
  - Computes `birthDate` and `age` based on typical prospect ages
- Calls `writeDraftClass()` from `madden-draft-class-tools`
- Writes `data/output/2026_draft_class.draftclass`
- This file can be imported directly into Madden 26 Franchise mode via **Import Local File**

---

## Orchestrator

### `run.py`
Runs the full pipeline end-to-end with CLI flags:
```
python run.py \
  --ros /path/to/madden26.ros \   # optional: Madden 26 roster file for player rating benchmarks
  --out ./data/output \           # output directory
  --model llama3:8b \             # Ollama model to use
  --prospects 250                 # number of prospects to generate (default: 250)
```

---

## Key Data Sources

| Source | What it provides | How accessed |
|---|---|---|
| nflverse combine CSV | 2025 combine measurables (40yd, bench, vert, broad, cone, shuttle) | Direct CSV download |
| nflverse draft_picks CSV | 2025 draft round/pick per player | Direct CSV download |
| `CAREERDRAFT-2025_M26` | 2025 class Madden 26 **launch ratings** (ground truth calibration) | madden-draft-class-tools test data |
| User `.ros` file | Current NFL player ratings (position benchmarks) | `madden-franchise` library |
| NFL.com / PFR / Mock Draft DB | 2026 prospect names, positions, schools, grades, rankings | Web scrape (BeautifulSoup / requests) |
| Ollama `llama3:8b` | Generates all Madden rating fields per prospect | Local Ollama HTTP API |

---

## Key Technical Details

### Position Enum (M26 `DraftPositionE`)
| Label | Value | Label | Value |
|---|---|---|---|
| QB | 0 | OLB | 10 |
| HB | 1 | MLB | 11 |
| FB | 2 | CB | 12 |
| WR | 3 | FS | 13 |
| TE | 4 | SS | 14 |
| T (OT) | 5 | K | 15 |
| G (OG) | 6 | P | 16 |
| C | 7 | LS | 17 |
| DE | 8 | | |
| DT | 9 | | |

### Dev Trait Values
`0 = Normal`, `1 = Impact`, `2 = Star`, `3 = X-Factor`

### Draft Class File Fields per Prospect
All ratings are 0–99 unsigned bytes: `overall`, `speed`, `acceleration`, `agility`, `strength`,
`awareness`, `catching`, `carrying`, `throwPower`, `throwAccuracy`, `throwAccuracyShort`,
`throwAccuracyMid`, `throwAccuracyDeep`, `throwOnTheRun`, `throwUnderPressure`, `playAction`,
`breakSack`, `tackle`, `hitPower`, `blockShedding`, `finesseMoves`, `powerMoves`, `pursuit`,
`zoneCoverage`, `manCoverage`, `pressCoverage`, `playRecognition`, `jumpint`, `catching`,
`catchInTraffic`, `spectacularCatch`, `shortRouteRunning`, `mediumRouteRunning`, `deepRouteRunning`,
`release`, `runBlock`, `passBlock`, `runBlockPower`, `runBlockFinesse`, `passBlockPower`,
`passBlockFinesse`, `impactBlocking`, `leadBlock`, `jukeMove`, `spinMove`, `stiffArm`,
`trucking`, `breakTackle`, `ballCarrierVision`, `changeOfDirection`, `kickPower`, `kickAccuracy`,
`kickReturn`, `stamina`, `toughness`, `injury`, `jumping`, `morale`, `devTrait`,
`personality`, `unkRating1` (M26 only)

---

## Project File Structure

```
madden-add-draft-class/
├── plan.md
├── run.py                          # Orchestrator
├── requirements.txt                # Python deps (requests, beautifulsoup4, ollama, tqdm)
├── package.json                    # Node deps (madden-franchise, madden-draft-class-tools)
├── .env.example                    # Config (OLLAMA_HOST, roster file path, etc.)
│
├── scripts/
│   ├── 1_fetch_combine_and_picks.py
│   ├── 2_extract_calibration.js
│   ├── 3_extract_roster_ratings.js
│   ├── 4_fetch_2026_prospects.py
│   ├── 5_generate_ratings.py
│   └── 6_create_draft_class.js
│
├── utils/
│   ├── enums.py                    # Position/state/dev trait mappings
│   ├── enums.js                    # Same for Node.js
│   ├── defaults.py                 # Default ratings by position (fallback)
│   └── visuals_template.js         # Default CharacterVisuals JSON blob
│
└── data/
    ├── raw/                        # Downloaded CSVs
    ├── prospects_2026_manual.csv   # Template if scraping fails
    ├── calibration_set.json        # Built by script 2
    ├── current_player_ratings.json # Built by script 3 (optional)
    ├── prospects_2026.json         # Built by script 4
    ├── prospects_rated.json        # Built by script 5
    └── output/
        └── 2026_draft_class.draftclass
```

---

## Implementation Todos

1. **Scaffold project** – `package.json`, `requirements.txt`, `.env.example`, directory structure  
2. **Script 1** – Fetch nflverse combine + draft picks data  
3. **Script 2** – Extract 2025 class calibration from `CAREERDRAFT-2025_M26`  
4. **Script 3** – Extract current player ratings from user-provided `.ros` file  
5. **Script 4** – Scrape/fetch 2026 draft prospects with measurables + grades  
6. **Script 5** – Generate 2026 ratings via Ollama with calibration + benchmark context  
7. **Script 6** – Write `.draftclass` file  
8. **Orchestrator** – `run.py` wires all steps together with CLI args  
9. **Utils** – Enum maps, position defaults, visuals template  
10. **README** – Usage instructions
