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

## Recommended Workflow: User-Team Swap on V20 Source (best for non-Cards control)

**Verified working 2026-05-08 (LATE EVE) — `CAREER-UPDATED-ROSTER-HAWKS`.**

The V20 source `CAREER-UPDATED-ROSTER` already has vets on real-life teams
and sims past the draft, but is locked to the Cardinals. Use
`scripts/9k_swap_user_team.js` to re-bind the user to any team.

```powershell
# 1. Copy V20 source → fresh destination.
$src = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves\CAREER-UPDATED-ROSTER"
$dst = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves\CAREER-UPDATED-ROSTER-HAWKS"
Copy-Item $src $dst -Force

# 2. Swap user-controlled team to Seahawks (TeamIndex 27).
node scripts/9k_swap_user_team.js --franchise $dst --target-team-index 27

# 3. Validate.
node scripts/9z_validate_franchise.js --franchise $dst

# 4. (Optional) Layer V20 9g for 2026 rookies + updated ratings.
node scripts/9g_sync_franchise_from_data.js --franchise $dst --apply --allow-unmatched
```

TeamIndex map: 0=Bears, 1=Bengals, 2=Bills, 3=Broncos, 4=Browns, 5=Buccaneers,
6=Cardinals, 7=Chargers, 8=Chiefs, 9=Colts, 10=Cowboys, 11=Dolphins,
12=Eagles, 13=Falcons, 14=49ers, 15=Giants, 16=Jaguars, 17=Jets, 18=Lions,
19=Packers, 20=Panthers, 21=Patriots, 22=Raiders, 23=Rams, 24=Ravens,
25=Commanders, 26=Saints, 27=Seahawks, 28=Steelers, 29=Titans, 30=Vikings,
31=Texans.

**What 9k changes** (8 fields total — full user-team binding set, verified
2026-05-08):
1. `FranchiseUser.Team` ref → target team's row in Team table
2. `FranchiseUser.UserEntity` ref → target team's HeadCoach row
3. `Coach[old HC].IsUserControlled`: true → false
4. `Coach[new HC].IsUserControlled`: false → true
5. `Franchise.LeagueOwner` ref → new coach (the primary user binding the UI uses)
6. `Team[old row].UserCharacter` ref → NULL
7. `Team[new row].UserCharacter` ref → new coach
8. `ArcContext.Team` ref → new team

UI-clean: Week-1 matchups visible, no stray cross-team trade-block popups.

## Recommended Workflow: Pre-Rosters Franchise + 9g (canonical V20 recipe)

**Verified working (CAREER-9G-V20 + V20-AUTOSAVE, 2026-05-08).** Result: vet
ratings correct, 2026 rookies on real-life teams, sim past Week 1 confirmed,
sim past the 2026 in-game draft confirmed (V20-AUTOSAVE captures the
post-draft state).

### CLI

```powershell
# 1. Use the V20-producer 9g (rookie-stat-baseline; tip 97d3ab9).
git checkout rookie-stat-baseline

# 2. Copy the source franchise → fresh destination. Never edit the source.
$src = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves\CAREER-UPDATED-ROSTER"
$dst = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves\CAREER-9G-V21"
Copy-Item $src $dst

# 3. Apply vet ratings + 2026 rookies (writes in-place to $dst).
node scripts/9g_sync_franchise_from_data.js --franchise $dst --apply --allow-unmatched

# 4. Reference-integrity check before loading Madden.
node scripts/9z_validate_franchise.js --franchise $dst
```

### In Madden

1. Main Menu → Load Franchise → pick the new save (`CAREER-9G-V21`).
2. *(Optional)* Main Hub → Choose Draft Class → Import Local →
   `data/output/2026_draft_class_from_franchise.draftclass`.
3. Advance Stage → through stage 10 (the 2026 NFL Draft).
4. Continue advancing → preseason → Week 1 of the 2026 regular season.

Madden's autosave (e.g. `CAREER-9G-V21-AUTOSAVE`) captures the post-sim
state automatically.

### Why each piece

| Piece | Why |
| --- | --- |
| `CAREER-UPDATED-ROSTER` source | Already has vets on real-life teams + offseason stage 9 (pre-draft) timeline. The recipe is "add 2026 rookies + ratings to a franchise that already has correct vet teams." Building this source from scratch is open work. |
| `rookie-stat-baseline` branch | 9g here is the V8 hybrid (same-team overlay + fresh inject) with `ENABLE_VET_TEAM_MOVE = false`. Branch `9g-vets-team-move` has the V11..V19 team-move attempts that CTD sim. |
| `--apply --allow-unmatched` | `--apply` writes (default is dry-run); `--allow-unmatched` proceeds when a few `full_solution_2_ratings.json` vets don't match franchise records (mostly retired / practice-squad). |
| `9z_validate_franchise.js` | Catches live records pointing at empty Player rows — the leading load-CTD class. |

### Gotchas

- **Don't kill Madden between iterations.** At the main menu Madden does
  not lock save files; killing it wastes ~30s/iteration.
- **Draft class import is optional.** If imported, Madden's draft engine
  uses our prospects' pick slots; if not, Madden generates synthetic
  prospects for any rookies 9g didn't overlay (Pass 4 already disposed
  unused auto-rookies to the FA pool, so the synthetic class is small).
  Both paths produced sim-clean autosaves.
- **2026 rookies are tagged `YearDrafted=0, YearsPro=0`** by 9g — treated
  as drafted-current-year, not next-year prospects. That's why they
  appear on real teams immediately on load.

See `decisions.md` 2026-05-08 (PM, late) for the architectural reasoning.

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

