# Madden 26 — 2026 Draft Class Generator

Generate a **real-world 2026 NFL draft class** and import it directly into Madden NFL 26. The pipeline downloads real combine measurables and scouting data, uses the actual Madden 26 launch ratings for the 2025 class as calibration ground truth, then calls a local Ollama LLM to generate every Madden attribute for each 2026 prospect — no manual editing required.

---

## How It Works

1. **Calibration** — The real Madden 26 2025 draft class (`CAREERDRAFT-2025_M26`) is used as ground truth. Each prospect's pre-draft profile (height, weight, 40-yard dash, school, draft position) is paired with their actual Madden launch ratings. This gives the LLM examples of how Madden translates real-world measurables and draft capital into in-game ratings.

2. **Benchmarks (optional)** — If you provide your current Madden 26 roster file, the tool also extracts current NFL player ratings by position (e.g., Josh Allen's QB stats), giving the LLM an anchor for what "elite" looks like at each position.

3. **Generation** — For each 2026 prospect, the LLM receives the calibration examples and (optionally) the benchmark ratings, then outputs a complete set of Madden attributes. Results are written to a `.draftclass` file that Madden 26 can import directly.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | ≥ 18 | Used for Madden file I/O |
| [Python](https://www.python.org/) | ≥ 3.9 | Used for data fetching and LLM calls |
| [Ollama](https://ollama.com/) | latest | Runs the LLM locally |
| Model: `llama3:8b` | — | Pull with `ollama pull llama3:8b` |

> **Ollama must be running** before you start the pipeline.  
> Start it with: `ollama serve`

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-user/madden-add-draft-class.git
cd madden-add-draft-class

# 2. Install Node dependencies
npm install

# 3. Install Python dependencies
pip3 install -r requirements.txt

# 4. Pull the Ollama model (first time only)
ollama pull llama3:8b

# 5. (Optional) Copy and edit the config file
cp .env.example .env
```

---

## Quick Start

Make sure Ollama is running (`ollama serve`), then:

```bash
python3 run.py
```

That's it. The full pipeline runs automatically and writes the draft class to:

```
data/output/2026_draft_class.draftclass
```

---

## Full Usage

```
python3 run.py [options]

Options:
  --ros PATH          Path to Madden 26 .ros roster file
                      (optional — improves rating calibration)
  --model MODEL       Ollama model (default: llama3:8b)
  --out DIR           Output directory (default: data/output)
  --prospects N       Max prospects to generate (default: all)
  --skip-fetch        Skip steps 1 & 4 — reuse existing downloaded data
  --skip-calibration  Skip step 2 — reuse existing calibration_set.json
  --resume            Resume an interrupted step 5 rating generation
  --start-from N      Start from step N (1–6), skip earlier steps
  --help              Show this help message
```

### Examples

```bash
# Basic run — downloads everything fresh
python3 run.py

# With a roster file for better calibration
python3 run.py --ros ~/Documents/"Madden NFL 26"/saves/ROSTER_FILE.ros

# Use a larger model for higher-quality ratings
python3 run.py --model llama3:70b

# Fast test run — only generate 30 prospects
python3 run.py --prospects 30

# Re-run without re-downloading data (after a successful run)
python3 run.py --skip-fetch --skip-calibration

# Resume an interrupted rating generation run
python3 run.py --skip-fetch --skip-calibration --resume

# Jump straight to writing the .draftclass file (all data already generated)
python3 run.py --start-from 6

# Save output to a custom directory
python3 run.py --out ~/Desktop/madden-exports
```

---

## Optional: Roster File

Providing a Madden 26 roster file (`.ros`) enables **Step 3**, which extracts current NFL player ratings and gives the LLM concrete benchmarks like "Josh Allen is a 99 overall QB with 97 throw power." This leads to better-calibrated ratings for elite prospects.

### Where to find the .ros file

| Platform | Location |
|---|---|
| **Windows** | `C:\Users\<YourName>\Documents\Madden NFL 26\saves\` |
| **macOS** | `~/Documents/Madden NFL 26/saves/` |

Look for a file ending in `.ros` (the name varies by save slot).

```bash
python3 run.py --ros "C:\Users\YourName\Documents\Madden NFL 26\saves\ROSTERFILE.ros"
```

You can also set it permanently in your `.env` file:

```
ROSTER_FILE=C:\Users\YourName\Documents\Madden NFL 26\saves\ROSTERFILE.ros
```

---

## Output

The final file is saved to:

```
data/output/2026_draft_class.draftclass
```

### Importing into Madden 26

1. **Copy** `2026_draft_class.draftclass` to your Madden saves folder:
   - **Windows:** `C:\Users\<YourName>\Documents\Madden NFL 26\saves\`
   - **macOS:** `~/Documents/Madden NFL 26/saves/`
2. **Launch Madden 26** and start a new Franchise mode.
3. When prompted, choose **"Custom Draft Class"**.
4. Select **`2026_draft_class`** from the list.

---

## Updating a 2026 Franchise (Existing Save)

If you already have a franchise saved at the **beginning of the 2026 league
year** (i.e. just after Super Bowl LX, before the 2026 draft), you can refresh
it with current real-world team assignments and import the 2026 rookie class on
top. The result is a 2026 franchise where rosters, contracts, and the upcoming
draft class all reflect real life.

### What you need

- A Madden 26 `CAREER-…` franchise file saved at the start of 2026.
- The Madden 26 `.ros` roster file you started the franchise from (for official
  player ratings).
- Node ≥ 18, Python ≥ 3.9, and Ollama (same prerequisites as the draft-class
  pipeline).

> **Always back up your franchise file before running the scripts below — they
> save changes in place.** Copy the `CAREER-…` file somewhere safe first.

### Workflow

#### 1. Point the tools at your franchise

Add `FRANCHISE_FILE` to your `.env` (or pass `--franchise` on the command line):

```dotenv
ROSTER_FILE=C:\Users\YourName\Documents\Madden NFL 26\saves\ROSTERFILE.ros
FRANCHISE_FILE=C:\Users\YourName\Documents\Madden NFL 26\saves\CAREER-FRANCHISE
```

#### 2. Refresh the current NFL roster + contract data

```bash
python3 roster_run.py --ros "%ROSTER_FILE%"
```

This runs the **roster pipeline** (steps 7 → 3 → 8) and writes
`data/roster_players_rated.json` — every active NFL player paired with their
official Madden ratings, current team, and current contract (years remaining,
AAV, signing bonus, base salary).

| Step | Script | What it does |
|---|---|---|
| 7 | `7_fetch_nfl_roster_and_contracts.py` | Downloads current rosters + contracts from nflverse and applies hand-curated 2026 free-agent moves |
| 3 | `3_extract_roster_ratings.js` | Pulls official Madden ratings out of your `.ros` file |
| 8 | `8_generate_roster_ratings.py` | Merges the two and computes Madden contract fields |

#### 3. Apply real-world team assignments to the franchise

```bash
node scripts/9_apply_transactions.js
```

For every **free agent** in the franchise file (`TeamIndex = 32`) who is on a
real 53-man roster, this signs them to their real-world team with a
matching-length contract pulled from `roster_players_rated.json`. The franchise
file is saved in place. Re-run any time you want to pick up new FA signings.

> **Players already on a team in the franchise are not moved.** Script 9 only
> resolves the FA pool — players the franchise already has on the wrong team
> won't be retraded by this tool.

#### 4. (Optional) Backfill the 2025 season results

If your save is right at the start of the 2026 league year (Madden has just
finished simming the 2025 season), you can pin the 2025 results to the real
NFL outcomes before resuming play:

```bash
node scripts/11_apply_game_results.js
```

This sets `ForceWin` on every 2025 SeasonGame so the franchise's 2025 history
matches reality. Skip this step if your save already has the 2025 season the
way you want it.

#### 5. Generate the 2026 rookie class

```bash
python3 run.py --ros "%ROSTER_FILE%"
```

This is the **draft-class pipeline** (steps 1–6) described in
[Quick Start](#quick-start). It writes
`data/output/2026_draft_class.draftclass`.

#### 6. Import the rookies into the franchise

The `.draftclass` file is loaded by Madden itself, not by these scripts:

1. Copy `data/output/2026_draft_class.draftclass` into your Madden saves folder
   (see [Importing into Madden 26](#importing-into-madden-26)).
2. Launch Madden 26 and load your franchise.
3. Advance to the **2026 NFL Draft** screen.
4. Choose **"Custom Draft Class"** when prompted and pick `2026_draft_class`.

After the draft, your franchise has the real 2026 NFL rookie class on top of
the real 2026 NFL veteran rosters.

### Re-running

The pipelines are safe to re-run. Common shortcuts:

```bash
# Roster data already downloaded — just remerge ratings and contracts
python3 roster_run.py --ros "%ROSTER_FILE%" --skip-fetch

# Re-apply transactions after editing roster_players_rated.json
node scripts/9_apply_transactions.js

# Regenerate the .draftclass without re-fetching prospect data
python3 run.py --skip-fetch --skip-calibration
```

---

## Customizing Prospects

If web scraping in Step 4 is blocked or you want to add/edit specific prospects, you can manually edit:

```
data/raw/prospects_2026_manual.csv
```

This CSV is created automatically by Step 4 as a template. Open it in Excel or any spreadsheet app, add or modify rows, save, then re-run skipping the fetch:

```bash
python3 run.py --skip-fetch
```

The CSV columns are: `name, position, school, height, weight, forty, bench, vertical, broad_jump, cone, shuttle, grade, rank`

Any row with a valid `name` and `position` will be included in the pipeline even if measurables are incomplete — the LLM will infer missing attributes from comparable players in the calibration set.

---

## Pipeline Steps

| Step | Script | Runtime | Input | Output |
|---|---|---|---|---|
| 1 | `1_fetch_combine_and_picks.py` | Python | nflverse URLs | `data/raw/combine_2025.csv`, `combine_2026.csv`, `draft_picks_2025.csv` |
| 2 | `2_extract_calibration.js` | Node | `CAREERDRAFT-2025_M26` (downloaded) | `data/calibration_set.json` |
| 3 *(optional)* | `3_extract_roster_ratings.js` | Node | Your `.ros` file | `data/current_player_ratings.json` |
| 4 | `4_fetch_2026_prospects.py` | Python | Web scrape + nflverse combine | `data/prospects_2026.json` |
| 5 | `5_generate_ratings.py` | Python | `calibration_set.json` + `prospects_2026.json` + Ollama | `data/prospects_rated.json` |
| 6 | `6_create_draft_class.js` | Node | `prospects_rated.json` | `data/output/2026_draft_class.draftclass` |

---

## Configuration via `.env`

Copy `.env.example` to `.env` to set persistent defaults:

```dotenv
# Path to your Madden 26 .ros roster file (optional)
ROSTER_FILE=

# Path to your Madden 26 CAREER- franchise file
# (only needed for the franchise-update workflow — scripts 9 and 11)
FRANCHISE_FILE=

# Ollama host (default: http://localhost:11434)
OLLAMA_HOST=http://localhost:11434

# Ollama model to use
OLLAMA_MODEL=llama3:8b

# Max prospects to generate (default: all)
NUM_PROSPECTS=250

# Output directory
OUTPUT_DIR=./data/output
```

CLI flags always override `.env` values.

---

## Troubleshooting

### `Error: ollama not running` or connection refused on step 5

Ollama must be running before the pipeline starts.

```bash
ollama serve
```

Then re-run from step 5:

```bash
python3 run.py --start-from 5
```

---

### Step 5 is very slow or times out

- The default `llama3:8b` model needs ~4 GB of RAM. If your machine is slow, try reducing the number of prospects: `--prospects 50`
- If the run is interrupted, **don't start over** — use `--resume` to continue from the last saved prospect:

```bash
python3 run.py --skip-fetch --skip-calibration --resume
```

---

### No 2026 combine data yet

Early in the year (before the NFL Combine in February), nflverse won't have 2026 measurables. Step 4 has automatic fallbacks:

1. Tries nflverse combine CSV for 2026 data
2. Tries scraping ESPN, Pro Football Network, and NFL Mock Draft Database
3. Falls back to a hardcoded list of known 2026 top prospects

You can also manually populate `data/raw/prospects_2026_manual.csv` with your own scouting data.

---

### Web scraping is blocked (step 4 fails)

Some sites block automated requests. If Step 4 fails with scraping errors:

1. Open `data/raw/prospects_2026_manual.csv` in a spreadsheet app
2. Add prospects manually (name, position, school, and any available measurables)
3. Re-run skipping the fetch: `python3 run.py --skip-fetch`

---

### `node: command not found`

Install Node.js 18 or later:

- **macOS:** `brew install node`
- **Ubuntu/Debian:** `sudo apt install nodejs npm`
- **Windows:** Download from [nodejs.org](https://nodejs.org/)

---

### `ModuleNotFoundError: No module named 'ollama'`

Run:

```bash
pip3 install -r requirements.txt
```

---

### The .draftclass file doesn't appear in Madden

- Confirm the file is in the correct saves folder for your platform (see [Output](#output) above).
- The file name must end in `.draftclass` — do not rename it.
- On Windows, make sure the file isn't blocked: right-click → Properties → Unblock.

---

## Project Structure

```
madden-add-draft-class/
├── run.py                          # Pipeline orchestrator (this tool)
├── requirements.txt                # Python dependencies
├── package.json                    # Node.js dependencies
├── .env.example                    # Configuration template
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
│   ├── enums.py / enums.js         # Position/dev trait mappings
│   ├── defaults.py                 # Default ratings by position
│   └── visuals_template.js         # Default player appearance data
│
└── data/
    ├── raw/                        # Downloaded CSVs and source files
    │   └── prospects_2026_manual.csv   ← edit this to customise prospects
    ├── calibration_set.json        # Built by step 2
    ├── current_player_ratings.json # Built by step 3 (optional)
    ├── prospects_2026.json         # Built by step 4
    ├── prospects_rated.json        # Built by step 5
    └── output/
        └── 2026_draft_class.draftclass  ← final output
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
