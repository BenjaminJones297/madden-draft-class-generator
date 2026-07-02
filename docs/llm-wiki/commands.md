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

## End-to-End Franchise Build (one-line wrapper)

`scripts/build_franchise.ps1` orchestrates the full pipeline. Two phases
because the middle requires you to advance through the draft + preseason
in Madden manually.

```powershell
# Phase 1 — pre-sim build (copy → 9k swap → validate → 9g rookies → 9l dispose)
./scripts/build_franchise.ps1 -TargetTeamIndex 27 -DestName CAREER-HAWKS-FINAL -Phase pre

# (load in Madden, sim through draft + preseason to Week 1, QUIT WITHOUT IN-GAME SAVE)

# Phase 2 — post-sim cleanup (9m delete fake/YD=1 auto-rookies on the autosave)
./scripts/build_franchise.ps1 -DestName CAREER-HAWKS-FINAL -Phase post
```

### Optional flags: `-Ratings` and `-Rookies`

Use these to skip the data-generation phase (`run.py` / `roster_run.py`) and
build directly from local JSON files. Both are optional; omit them to use
9g/9m's built-in defaults (`data/full_solution_2_ratings.json` and
`data/rookie_ratings_post_madden.json`).

```powershell
# Phase 1 with custom inputs
./scripts/build_franchise.ps1 -TargetTeamIndex 27 -DestName CAREER-LOVE-TEST -Phase pre `
  -Ratings data\roster_players_rated_full2.json `
  -Rookies data\rookie_ratings_post_fix.json

# Phase 2 — only -Rookies matters here (it's 9m's keep-list)
./scripts/build_franchise.ps1 -DestName CAREER-LOVE-TEST -Phase post `
  -Rookies data\rookie_ratings_post_fix.json
```

Forwarding:
- `-Ratings` → `9g_sync_franchise_from_data.js --ratings <path>` in Phase pre
- `-Rookies` → `9g --rookies <path>` in Phase pre AND
  `9m_purge_fake_rookies.js --rookies <path>` in Phase post (the keep-list)
- `-ApplyVisuals` → runs `9p_apply_visuals.js --apply` in Phase pre after 9l
- `-Appearances` → forwards `--appearances <path>` to 9p (default
  `data/rookie_appearances.json`)

`roster_players_rated_full2.json` (script-8 merged shape, nested `ratings`
object) and `rookie_ratings_post_fix.json` (flat shape) are both accepted by
9g without modification — 9g handles both shapes via `applyRatingsObject`.

## Rookie visuals (skin-tone) — one-time build

The `-ApplyVisuals` flag on `build_franchise.ps1` consumes
`data/rookie_appearances.json`. Build it once per rookie class:

```powershell
# 1. Fetch headshots from ESPN CDN via nflverse espn_id lookup.
python scripts/9n_fetch_rookie_headshots.py

# 2. Extract Lab L* metric from each photo using MediaPipe Face Mesh.
python scripts/9o_extract_skin_tones.py

# 3. Pick ~80 vets across all 8 Madden skinTone buckets for calibration.
node scripts/9o_pick_calibration_vets.js --per-bucket 10

# 4. Fetch vet headshots + run extractor on them.
python scripts/9n_fetch_rookie_headshots.py `
  --input data/calibration_vets.json `
  --out-dir data/raw/headshots_calibration `
  --manifest data/raw/headshot_manifest_calibration.json
python scripts/9o_extract_skin_tones.py `
  --photo-dir data/raw/headshots_calibration `
  --manifest data/raw/headshot_manifest_calibration.json `
  --out data/raw/vet_skin_measurements.json `
  --debug-overlays 0

# 5. Fit anchor + quantile classifiers; the better one wins.
python scripts/9o_build_calibration.py

# 6. Apply calibration → data/rookie_appearances.json.
python scripts/9o_bucket_rookies.py
```

End state: `data/rookie_appearances.json` is ready, and any future
`build_franchise.ps1 ... -ApplyVisuals` run uses it.

**Coverage notes:**
- 9p writes `CharacterVisuals.RawData.skinTone` for rookies that 9g overlaid
  onto auto-prospect placeholders (CV ref non-null, ~54 records per
  franchise). It writes `Player.GenericHeadAssetName` for ALL matched
  rookies (~306, including 9g's fresh-inject duplicates with null CV refs).
  Madden renders head primarily from the asset name, so even null-CV records
  get a visible skin family change.
- Calibration accuracy on 79 vet truth: 37% exact / 73% within ±1. Most
  errors are off-by-one cosmetic mismatches; some Latino/biracial players
  (e.g. Cam Ward) classify into an obviously wrong bucket due to algorithm
  highlight bias. Manual override of `rookie_appearances.json` after step 6
  is the easiest fix for outliers.

End state: a franchise controlled by your chosen team, with vets on real-life
teams, 265 real 2026 rookies on real teams, and Madden's auto-generated
rookies (pre-draft pool + post-draft UDFAs + next-year synthetic class) all
purged from team rosters.

`9m` uses the rookie file as the keep-list for YearDrafted=0 current-year
rookies. The wrapper's post phase passes `--include-yd1 --delete`:
YearDrafted=1 / YearsPro=0 players are purged regardless of name, then fake
rows are marked `ContractStatus=Deleted` and removed from team roster arrays
plus `Franchise.FreeAgents`. Rows are not physically emptied because live refs
to empty Player rows are a known Madden CTD vector.

TeamIndex map: 0=Bears 1=Bengals 2=Bills 3=Broncos 4=Browns 5=Buccaneers
6=Cardinals 7=Chargers 8=Chiefs 9=Colts 10=Cowboys 11=Dolphins 12=Eagles
13=Falcons 14=49ers 15=Giants 16=Jaguars 17=Jets 18=Lions 19=Packers
20=Panthers 21=Patriots 22=Raiders 23=Rams 24=Ravens 25=Commanders
26=Saints 27=Seahawks 28=Steelers 29=Titans 30=Vikings 31=Texans

**Critical between-phase rule:** **quit Madden without manually saving**
before phase 2. Phase 2 edits the autosave file directly. If you save
in-game first, Madden overwrites our edits with in-memory state.

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

# 5. (Optional) Dispose Madden's auto-generated 2026 draft prospects.
#    CAREER-UPDATED-ROSTER ships with 310 ContractStatus=Draft prospects
#    (YearDrafted=0, YearsPro=0, TeamIndex=32) that exist alongside the
#    265 real rookies 9g injects. 9l moves them to FA pool so they don't
#    appear in the draft pool / create draft-pool duplicates.
node scripts/9l_dispose_auto_prospects.js --franchise $dst
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

Polish the post-Madden flat rookie ratings file used by 9g/9m:

```powershell
# Dry-run: reports profile conflicts only
node scripts/9q_polish_rookie_ratings_post_madden.js

# Apply in place to data/rookie_ratings_post_madden.json
node scripts/9q_polish_rookie_ratings_post_madden.js --apply

# Write a polished copy instead
node scripts/9q_polish_rookie_ratings_post_madden.js --input data/rookie_ratings_post_fix.json --output data/rookie_ratings_post_fix_polished.json
```

Restore one missing real roster player into a franchise save:

```powershell
$fp = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves\CAREER-CARDINALS-AUTOSAVE"
Copy-Item $fp "$fp.codex-before-restore-aaron-brewer-ls" -Force
node scripts/9r_restore_roster_player.js --franchise $fp --name "Aaron Brewer" --team ARI --pos LS --apply
node scripts/9z_validate_franchise.js --franchise $fp
```

Force one one-way trade in an existing franchise (verified 2026-05-18 on a
post-sim autosave). Do NOT loop this for bulk moves — see decisions.md
2026-05-08 PM:

```powershell
$fp = "$env:USERPROFILE\OneDrive\Documents\Madden NFL 26\saves\YOUR-AUTOSAVE"
Copy-Item $fp "$fp.before-9s" -Force

# Dry-run first.
node scripts/9s_force_trade.js --franchise $fp `
  --name "Player Name" --from-team SEA --to-team KC --pos QB

# Apply.
node scripts/9s_force_trade.js --franchise $fp `
  --name "Player Name" --from-team SEA --to-team KC --pos QB --apply

# Validate + diff.
node scripts/9z_validate_franchise.js --franchise $fp
node scripts/9z_diff_franchises.js --before "$fp.before-9s" --after $fp --summary
```

Touches: `Player.TeamIndex`, `PrevTeamIndex`, `PLYR_CONSECYEARSWITHTEAM`,
nulls old `Team.Roster` slot + appends to new, recalcs roster-size counters
on both teams. Skips DepthChart / ContractOffer / PlayerReSignNegotiation
(run 9j after if the depth chart looks wrong).

Trace the pipeline when diagnosing data flow:

```powershell
python scripts/_trace_pipeline.py
```

## Notes

- The repo does not currently define a formal test suite.
- `package.json` exposes only a few Node helper scripts:
  `extract-calibration`, `extract-roster`, and `create-draft-class`.
- Prefer targeted smoke runs because full LLM generation can be slow.

