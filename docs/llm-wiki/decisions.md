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

