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

## 2026-05-08 - Vet Team Moves Are Out-Of-Scope For 9g

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

