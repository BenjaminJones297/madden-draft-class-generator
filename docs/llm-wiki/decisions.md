# Decisions

Record durable architecture and workflow decisions here. Keep entries short and
link to source when possible.

## 2026-05-07 - Use A Repo-Local LLM Wiki

Decision: Maintain `docs/llm-wiki/` as the canonical context handoff for LLMs
working in this repository, with `AGENTS.md` as the root entry point.

Why: The project has large generated data files, two languages, current CLI
pipelines, and a separate future architecture document. A compact wiki lets LLMs
load stable project context without reading unrelated artifacts.

Implications:

- Update wiki pages when source changes make durable context stale.
- Use `data/contracts/` before opening large JSON artifacts.
- Treat `ARCHITECTURE.md` as future-state planning, not current behavior.

## 2026-05-08 (PM, latest) - .ros Encoding: No Off-The-Shelf Path For M26

`madden-franchise` (3.8.0 + 4.2.2) and `madden-file-tools` (the only sibling
that ever touched rosters) **do not** support reading or writing M26 `.ros`
files. Investigated 2026-05-08 across both libraries' source.

**Why:**
- `madden-franchise`'s `Constants.js` only declares `FRANCHISE` /
  `FRANCHISE_COMMON` formats. No roster code path.
- `FranchiseFile.js`'s `unpackFile` slices at fixed offset `0x52` and
  runs `zlib.inflateSync` — fails on `.ros` because the M24+ FBCHUNKS
  container isn't a zlib stream.
- `madden-file-tools`'s `MaddenRosterHelper.js` was last updated 2021-08
  for M21 TDB2 layout. Doesn't understand the FBCHUNKS wrapper that
  M24/M25/M26 added.
- M24+ uses a Frostbite chunked-archive wrapper (`FBCHUNKS`) as the
  outer container for both franchise AND roster files. The franchise
  inner reader is implemented; the roster inner reader (TDB2 in M26)
  isn't.

**Consequence:** `scripts/3_extract_roster_ratings.js` claims to read
.ros via the franchise constructor — it succeeds on franchise saves
(`CAREER-*`) but fails on actual `.ros` files like
`data/raw/ROSTER-Official` and the user's `ROSTER-NEW`. No commit in
this repo's git history shows it ever working on a real M26 .ros.

**Workarounds, ranked by effort:**
1. Use the V20 recipe (CAREER-UPDATED-ROSTER + 9g) — already working,
   no .ros work needed.
2. Reverse-engineer the FBCHUNKS chunk table to extract the inner
   TDB2, feed to a hand-rolled or revived MaddenRosterHelper.
3. Mine `madden-franchise`'s franchise FBCHUNKS extraction logic and
   adapt for `.ros`. Same Frostbite container, different inner schema.

For now: **option 1.** If we need the user-facing "build a roster from
JSON" experience, the realistic deliverable is `roster_players_rated.json`
(script 8 output) plus the V20 recipe — not a binary `.ros` file.

## 2026-05-08 (PM, late) - V20's Season Timeline

`CAREER-9G-V20` (and its source `CAREER-UPDATED-ROSTER`) sits at:
- `CurrentSeasonYear = 2025`
- `CurrentStage = OffSeason`
- `CurrentOffseasonStage = 9` (late offseason)
- `IsProDayComplete = true`
- `CurrentWeek = 11` (offseason week counter)

Practical interpretation: **right before the 2026 NFL Draft.** Madden's
offseason stages run 1–10; stage 9 is pro-day-complete + pre-draft. From
this state, the user can sim the draft in-game (which uses our injected
2026 rookies' real-life draft-team data to place them on real teams via
Madden's draft engine) without needing 9g's vet TeamIndex moves.

Implication for future workflows: applying changes at this offseason
stage may be more sim-tolerant than at Week-1-regular-season state
(which is where our V11..V19 team-move attempts broke). The original
`CAREER-CARDSWEEK1B4SIM` source we'd been editing was at week 1 of the
regular season — possibly part of why team moves CTD'd there.

## 2026-05-08 (PM, late) - The Working Recipe: pre-rosters franchise + V8 9g

**The working approach** for getting accurate vet teams + real 2026 rookies
+ working sim:

1. **Start from a franchise that already has vets on real teams**, not the
   default Madden state. The user has `CAREER-UPDATED-ROSTER` in the saves
   dir — built in an earlier session, probably by importing a custom roster
   file. Use it as the source. (`data/raw/ROSTER-Official` may have been
   the base; recreating that build from scratch is open work.)

2. **Run the default 9g** (rookie-stat-baseline branch — `ENABLE_VET_TEAM_MOVE = false`)
   on a copy of that source. 9g updates vet ratings via
   `full_solution_2_ratings.json` and fresh-injects 2026 rookies on their
   real-life teams via `rookie_ratings_post_madden.json`.

3. **Sim past Week 1 works** — confirmed on `CAREER-9G-V20`.

**Why this works and our V11..V19 attempts didn't:** we don't move any vets'
TeamIndex. The pre-rosters franchise already has them on the right teams.
9g only adds rookies (which go into empty Player slots — no team-roster
disturbance) and writes ratings in place (no structural change). Madden's
sim invariants stay intact.

**Alternative path** the user mentioned (worth exploring as a v2):
- Sim through preseason in a normal franchise to right before the 2026 draft
- Import a `.draftclass` file (we already build `data/output/2026_draft_class.draftclass`
  via `scripts/6_create_draft_class.js`)
- Sim the draft — Madden's engine assigns rookies to teams via the draft
  itself, sidestepping our team-write code paths entirely
- Then dispose any auto-rookies that got drafted alongside

**Open question:** how was `CAREER-UPDATED-ROSTER` originally built? It has
2,326 Signed players on real-life teams (Adams on LAR, Barkley on PHI, etc.)
plus 310 records with `ContractStatus=Draft` — these look like a draft pool
already injected. The build pipeline isn't documented in this repo;
identifying it (probably a one-time roster-builder script + an in-game
roster import) would let us reproduce the starting state without depending
on the existing file.

## 2026-05-08 - 9g Overlays Rookies; Does Not `rec.empty()` Them

Decision: In `scripts/9g_sync_franchise_from_data.js`, populate real 2026
rookies by **mutating** auto-rookie placeholder records in place
(`YearDrafted=1, YearsPro=0`) rather than calling `rec.empty()` on them and
re-injecting fresh records.

Why: `rec.empty()` on a record that other tables reference (HistoryEntry,
Player[] roster arrays, PlayerAcquisitionEvaluation, etc.) leaves dangling
references — even with a full reference-cleaning sweep that nulls all those
refs, Madden's sim engine CTDs on the resulting null entries. Mutate-in-place
preserves every ref pointing at the row.

Implications:

- Use a same-team prefer when matching real prospects to auto placeholders;
  fall back to V5-style fresh inject for cross-team mismatches.
- 2026-prospect filter MUST be `YearDrafted=1 AND YearsPro=0`.
  `YearDrafted=0` catches 2025 rookies + UDFAs that must not be touched.
- See `scripts/9z_validate_franchise.js` for the reference-integrity check
  that surfaced this issue.

## 2026-05-08 (PM) - File-Edit Vet Team Moves Are Structurally Hard

Updated assessment after 8 iterations + 3 parallel agent investigations:
post-franchise bulk vet team moves via file editing are not a known-
working pattern. We've handled 8 distinct invariants (Roster, DepthChart
pool, 13 team-affiliated arrays, 3 contract tracking tables,
PrevTeamIndex, contract layout normalization, Team SalCap fields,
Franchise.FreeAgents pool); validator clean each iteration; sim CTDs
immediately every time.

External evidence:
- madden-franchise 4.2.2 (latest) is ESM rewrite + schema fixes only.
  No new trade/team-move APIs.
- Community tools (bep713 editor, FFC Retro Rosters, Bowersrd's PC
  hub) operate on `.ros` files PRE-franchise or do single-player serial
  cuts/sign POST-franchise. Nobody publishes working bulk-move-post-sim.

Why: Madden's sim engine validates a wide invariant set spanning
Player records, Team-affiliated arrays, league-singleton arrays,
per-record contract tables, derived per-team cap totals, plus likely
internal sim state we can't introspect from outside.

Decision still stands: default 9g (rookie-stat-baseline) does not
move vet TeamIndex. The full V19 implementation lives on
`9g-vets-team-move` for future research. For accurate vet teams, use
`scripts/9h_generate_roster_changes.js` to generate an in-game
checklist (Madden's engine handles every invariant correctly).

## 2026-05-08 - Vet Team Moves Are Out-Of-Scope For 9g (original entry)

Decision: 9g updates vet ratings only. It does NOT change `Player.TeamIndex`
on existing veterans. The `ENABLE_VET_TEAM_MOVE` flag in 9g is OFF by default.
For real-life trades and free-agent signings, generate a checklist with
`scripts/9h_generate_roster_changes.js` and execute the moves in Madden's
in-game UI.

Why: Moving a vet's TeamIndex requires synchronously updating at least 16
team-affiliated tables (Roster, PracticeSquad, Marketed*, ActiveAbilities*,
training lists, DepthChart pool, ContractOffer, PlayerReSignNegotiation,
PlayerAcquisitionEvaluation, plus `Player.PrevTeamIndex`) and recalculating
the 27 cap-derived fields on each affected `Team` record. Each layer we add
exposes more invariants. The `9g-vets-team-move` branch implements layers
1-5 and CTDs sim; layer 6 (cap math) is open-ended. In-game moves let
Madden's engine handle every layer correctly.

Implications:

- 9g's `Pass 1b` (vet team move) lives on the `9g-vets-team-move` branch,
  not on `rookie-stat-baseline`. Re-enable only when a working cap-math
  pass is added.
- 9h is the user-facing path for accurate roster moves.
- The same-team-mismatch case in `Pass 3` (rookies) uses fresh inject
  rather than team-change overlay for the same reason.

