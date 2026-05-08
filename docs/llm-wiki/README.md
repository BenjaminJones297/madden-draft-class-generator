# LLM Wiki

This wiki is the canonical context handoff for LLMs working in this repository.
It is intentionally short and source-linked. Load only the pages needed for the
current task.

## Fast Load Order

1. Read this file.
2. Read `project-map.md` for the current system shape.
3. Read `commands.md` before running anything.
4. Read `data-contracts.md` before touching `data/*.json` formats.
5. Read `decisions.md` before making architecture or workflow changes.
6. Append `task-log.md` when you finish useful work.

## Current State

The repo is a CLI-first Madden 26 data pipeline. It has two main orchestrators:

- `run.py` builds a 2026 Madden draft class.
- `roster_run.py` builds a current NFL roster rating dataset.

There is also a large `ARCHITECTURE.md` that describes a future web application.
Treat that file as a target-state blueprint. Treat `run.py`, `roster_run.py`,
and the numbered scripts as the source of truth for the current implementation.

## Mental Model

The draft-class pipeline:

1. Fetch real-world football inputs.
2. Extract Madden calibration examples.
3. Optionally extract current Madden roster ratings.
4. Fetch/enrich 2026 prospect profiles.
5. Ask a local Ollama model to generate Madden attributes.
6. Apply deterministic polish passes.
7. Write a `.draftclass` file.

The roster pipeline:

1. Fetch current NFL roster and contract data.
2. Optionally extract official Madden ratings from a `.ros` file.
3. Merge ratings, roster data, and contract data.

## Wiki Maintenance Rules

- Keep wiki pages concise. Link to source files instead of copying code.
- Prefer durable facts: commands, contracts, responsibilities, constraints.
- Do not paste secrets, `.env` values, personal file paths, or proprietary Madden
  binary contents.
- If a page becomes long, split it by task area.
- When code changes make wiki facts stale, update the wiki in the same change.

