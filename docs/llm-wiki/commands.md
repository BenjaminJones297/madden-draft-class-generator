# Commands

Use PowerShell from the repository root on Windows.

## Install

```powershell
npm install
pip install -r requirements.txt
ollama pull llama3:8b
```

Ollama must be running before rating generation:

```powershell
ollama serve
```

## Draft-Class Pipeline

Full run:

```powershell
python run.py
```

Fast smoke run using existing data:

```powershell
python run.py --prospects 5 --skip-fetch --skip-calibration
```

Resume interrupted rating generation:

```powershell
python run.py --skip-fetch --skip-calibration --resume
```

Rebuild only the final `.draftclass` after ratings already exist:

```powershell
python run.py --start-from 7
```

Run with a Madden roster file for calibration anchors:

```powershell
python run.py --ros "C:\path\to\ROSTER.ros"
```

## Roster Pipeline

Full roster run with official Madden ratings:

```powershell
python roster_run.py --ros "C:\path\to\ROSTER.ros"
```

Reuse existing fetched roster data:

```powershell
python roster_run.py --ros "C:\path\to\ROSTER.ros" --skip-fetch
```

Fetch/merge without extracting official ratings:

```powershell
python roster_run.py --skip-extract
```

## Regenerate Draft Class From Franchise-Style Rookie File

Script 6 already supports both shapes (`prospects_rated.json` and the
flat-keyed franchise-export shape used by `rookie_ratings_from_franchise.json`).
Just point `--input` at it.

```powershell
node scripts/6_create_draft_class.js --input data/rookie_ratings_from_franchise.json --out data/output/2026_draft_class_from_franchise.draftclass
```

Import in Madden: Main Hub → Choose Draft Class → Import Local File.

## Build Combined Roster JSON (full_solution_2_ratings + nfl_rosters_2026)

Script 8 now accepts `--ratings` and `--out` flags. Pass either the
script-3 output (dict-shape) or the franchise-export shape
(`full_solution_2_ratings.json`).

```powershell
python scripts/8_generate_roster_ratings.py --ratings data/full_solution_2_ratings.json --out data/roster_players_rated_full2.json
```

Output: per-player JSON with team + contract (from nflverse) + ratings
(from the supplied ratings file). Note: this is a JSON merge, not a
binary `.ros` file. mf 3.8 / 4.2 can't decompress real `.ros` files
(`incorrect header check`), so writing one is open work.

## Recommended Workflow: Pre-Rosters Franchise + 9g

**Verified working pattern (CAREER-9G-V20, 2026-05-08):**

```powershell
# Source MUST already have vets on their real-life teams.
# CAREER-UPDATED-ROSTER is the user's verified working template.
$src = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves\CAREER-UPDATED-ROSTER"
$dst = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves\CAREER-9G-START"
Copy-Item $src $dst
node scripts/9g_sync_franchise_from_data.js --franchise $dst --apply --allow-unmatched
node scripts/9z_validate_franchise.js --franchise $dst
```

Result: vet ratings + 2026 rookies on real teams + working sim. See
`decisions.md` 2026-05-08 (PM, late) for why this works and the
`9g-vets-team-move` branch for what doesn't.

## Post-Draft Franchise Sync (raw apply against any starting save)

Apply vet ratings + 2026 rookies into a `.franchise` save. **Always copy first
and target the copy** — never write to the original.

```powershell
$src = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves\CAREER-START"
$dst = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves\CAREER-9G"
Copy-Item $src $dst
node scripts/9g_sync_franchise_from_data.js --franchise $dst --apply --allow-unmatched
```

Validate the result before loading in Madden:

```powershell
node scripts/9z_validate_franchise.js --franchise $dst
```

Diff against the original to confirm only intended fields changed:

```powershell
node scripts/9z_diff_franchises.js --before $src --after $dst --summary
```

Generate the in-game roster-change checklist (markdown to
`output/roster_changes.md`):

```powershell
node scripts/9h_generate_roster_changes.js --franchise $dst
```

## Validation And Audits

Python syntax check:

```powershell
python -m py_compile run.py roster_run.py
```

Validate generated ratings:

```powershell
node scripts/validate_ratings.js
```

Audit generated ratings:

```powershell
node scripts/audit_ratings.js
```

Trace the pipeline when diagnosing data flow:

```powershell
python scripts/_trace_pipeline.py
```

## Notes

- The repo does not currently define a formal test suite.
- `package.json` exposes only a few Node helper scripts:
  `extract-calibration`, `extract-roster`, and `create-draft-class`.
- Prefer targeted smoke runs because full LLM generation can be slow.

