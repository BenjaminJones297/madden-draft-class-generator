# Madden 26 — 2026 Draft Class Generator

Generate a **real-world 2026 NFL draft class** and import it directly into Madden NFL 26. The pipeline downloads real combine measurables and scouting data, uses the actual Madden 26 launch ratings for the 2025 class as calibration ground truth, then calls an LLM to generate every Madden attribute for each 2026 prospect — no manual editing required.

Supports multiple LLM providers via [LangChain](https://www.langchain.com/): run locally with **Ollama** (no API key needed) or switch to **OpenAI** with a single config change.

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
| **Ollama** *(default)* | latest | Runs the LLM locally — [install](https://ollama.com/) |
| Model: `llama3:8b` | — | Pull with `ollama pull llama3:8b` |

> **Ollama must be running** before you start the pipeline (default provider).  
> Start it with: `ollama serve`

See [LangChain / Multi-Provider Support](#langchain--multi-provider-support) if you prefer to use OpenAI or another cloud provider instead.

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
  --ros PATH                Path to Madden 26 .ros roster file
                            (optional — improves rating calibration)
  --provider PROVIDER       LLM provider for step 5 (default: ollama)
                            ollama           — direct Ollama call (no extra deps)
                            ollama-langchain — Ollama via LangChain
                            openai           — OpenAI API via LangChain
                            multi-chain      — 3-chain decomposition (best quality)
  --model MODEL             LLM model (default: llama3:8b / gpt-4o-mini for openai)
  --athleticism-model MODEL Smaller model for athleticism chain in multi-chain mode
  --out DIR                 Output directory (default: data/output)
  --prospects N             Max prospects to generate (default: all)
  --skip-fetch              Skip steps 1 & 4 — reuse existing downloaded data
  --skip-calibration        Skip step 2 — reuse existing calibration_set.json
  --resume                  Resume an interrupted step 5 rating generation
  --start-from N            Start from step N (1–6), skip earlier steps
  --help                    Show this help message
```

### Examples

```bash
# Basic run — downloads everything fresh
python3 run.py

# With a roster file for better calibration
python3 run.py --ros ~/Documents/"Madden NFL 26"/saves/ROSTER_FILE.ros

# Use a larger Ollama model for higher-quality ratings
python3 run.py --model llama3:70b

# Multi-chain: 3 specialised LLM calls, chains 1+2 run in parallel
python3 run.py --provider multi-chain

# Multi-chain: fast model for physical attributes, large model for skills
python3 run.py --provider multi-chain --athleticism-model llama3:8b --model llama3:70b

# Use OpenAI GPT-4o-mini instead of Ollama (requires OPENAI_API_KEY in .env)
python3 run.py --provider openai

# Use OpenAI with multi-chain decomposition
python3 run.py --provider multi-chain --model gpt-4o-mini

# Use Ollama via the LangChain abstraction layer
python3 run.py --provider ollama-langchain

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
| 5 | `5_generate_ratings.py` | Python | `calibration_set.json` + `prospects_2026.json` + LLM | `data/prospects_rated.json` |
| 6 | `6_create_draft_class.js` | Node | `prospects_rated.json` | `data/output/2026_draft_class.draftclass` |

---

## Configuration via `.env`

Copy `.env.example` to `.env` to set persistent defaults:

```dotenv
# Path to your Madden 26 .ros roster file (optional)
ROSTER_FILE=

# LLM provider: ollama | ollama-langchain | openai | multi-chain  (default: ollama)
LLM_PROVIDER=ollama

# Ollama host (default: http://localhost:11434)
OLLAMA_HOST=http://localhost:11434

# Ollama model to use (for ollama / ollama-langchain / multi-chain providers)
OLLAMA_MODEL=llama3:8b

# OpenAI API key and model (only needed when LLM_PROVIDER=openai or multi-chain + OPENAI_API_KEY)
# OPENAI_API_KEY=sk-...
# OPENAI_MODEL=gpt-4o-mini

# Athleticism chain model for multi-chain mode (default: same as OLLAMA_MODEL)
# Use a smaller/faster model — physical mapping is nearly deterministic
# ATHLETICISM_MODEL=llama3:8b

# Max prospects to generate (default: all)
NUM_PROSPECTS=250

# Output directory
OUTPUT_DIR=./data/output
```

CLI flags always override `.env` values.

---

## LangChain / Multi-Provider Support

Step 5 uses [LangChain](https://www.langchain.com/) to abstract the LLM backend. This means you can switch providers by changing a single flag — no code changes required.

### Available providers

| `--provider` | Backend | Notes |
|---|---|---|
| `ollama` | Direct Ollama call | **Default.** No extra deps; fastest for local use |
| `ollama-langchain` | Ollama via LangChain (`langchain-ollama`) | Same local model, routed through LangChain's chain abstraction |
| `openai` | OpenAI API via LangChain (`langchain-openai`) | Requires `OPENAI_API_KEY` in `.env`; no local GPU needed |
| `multi-chain` | 3-chain decomposition via LangChain | **Best quality.** Breaks the problem into specialised sub-tasks |

### Multi-chain strategy

The `multi-chain` provider decomposes what was previously a single monolithic prompt into three specialised LLM calls. Each chain has a narrow, well-defined responsibility — yielding more reliable outputs, shorter prompts, and the opportunity to use different (cheaper/faster) models per sub-task.

```
                          ┌── Chain 1: Athleticism ──┐
    prospect context ─────┤                          ├─► merge ─► Chain 3: Overall + DevTrait
                          └── Chain 2: Skills ───────┘
```

| Chain | Model | Input | Output |
|---|---|---|---|
| **1 — Athleticism** | `ATHLETICISM_MODEL` (fast) | Combine measurables (40-time, bench, vertical…) | `speed`, `acceleration`, `agility`, `jumping`, `strength`, `stamina`, `toughness`, `injury` |
| **2 — Skills** | main `--model` | Position, calibration examples, NFL comp | All position-specific skill ratings |
| **3 — Dev/Overall** | main `--model` | Draft capital + merged chain 1+2 ratings | `overall`, `devTrait` |

Chains 1 and 2 are independent and run **in parallel** via LangChain's `RunnableParallel`. Chain 3 runs sequentially once both results are available.

**Why this is better:**

- **Shorter, focused prompts** — each chain asks the LLM to do one thing well, reducing hallucinations on the fields it doesn't specialise in
- **Different models per sub-task** — physical attribute mapping from measurables is nearly deterministic; a cheap/fast model (e.g. `llama3:8b`) works just as well as a large one for Chain 1, while Chain 2 benefits from a more capable model
- **Parallel execution** — Chains 1 and 2 run simultaneously, reducing total latency per prospect
- **Independent retry** — if one chain fails, only that chain needs to be retried

### LangChain LCEL chain pattern

All providers (except `ollama`) use LangChain's **LCEL (LangChain Expression Language)** to compose the LLM calls:

```python
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnableParallel, RunnableLambda

# Single-chain providers (ollama-langchain, openai):
chain = ChatPromptTemplate.from_messages([("human", "{input}")]) | llm | StrOutputParser()

# Multi-chain: parallel chains feeding into a sequential chain
parallel_step = RunnableParallel(
    athleticism=athleticism_chain,  # Chain 1 — fast model
    skills=skills_chain,            # Chain 2 — main model
    prospect=RunnableLambda(lambda ctx: ctx["prospect"]),
)
full_pipeline = parallel_step | dev_trait_chain  # Chain 3
```

### Using multi-chain

```bash
# Local Ollama — same model for all chains
python3 run.py --provider multi-chain

# Local Ollama — fast model for athleticism, larger model for skills
python3 run.py --provider multi-chain --athleticism-model llama3:8b --model llama3:70b

# OpenAI backend (auto-detected when OPENAI_API_KEY is set)
python3 run.py --provider multi-chain --model gpt-4o-mini
```

Or set it permanently in `.env`:

```dotenv
LLM_PROVIDER=multi-chain
OLLAMA_MODEL=llama3:70b         # skills + dev-trait model
ATHLETICISM_MODEL=llama3:8b     # fast model for physical attributes
```

### Using OpenAI

1. Add your key to `.env`:

   ```dotenv
   LLM_PROVIDER=openai
   OPENAI_API_KEY=sk-...
   OPENAI_MODEL=gpt-4o-mini   # or gpt-4o, gpt-4o-2024-11-20, etc.
   ```

2. Run the pipeline:

   ```bash
   python3 run.py
   ```

   Or specify the provider on the command line:

   ```bash
   python3 run.py --provider openai --model gpt-4o
   ```

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
