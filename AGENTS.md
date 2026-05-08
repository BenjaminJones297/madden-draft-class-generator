# Agent Context

This repository uses a repo-local LLM wiki for context handoff. Start with:

1. `docs/llm-wiki/README.md`
2. `docs/llm-wiki/project-map.md`
3. The specific wiki page for the task at hand

The wiki is a guide, not a substitute for source. If the wiki conflicts with code,
trust the code and update the wiki as part of the change.

## Project Snapshot

This project generates Madden 26 draft classes and roster data from real football
data, Madden file parsing, and local LLM rating generation.

Current runnable entry points:

- `run.py`: draft class pipeline.
- `roster_run.py`: active NFL roster pipeline.

Important source directories:

- `scripts/`: numbered pipeline steps plus audit, polish, and sync utilities.
- `utils/`: shared rating defaults, enum mappings, and visual templates.
- `data/contracts/`: lightweight schema examples for important generated JSON.
- `docs/llm-wiki/`: context wiki for future LLM sessions.

## Working Rules

- Prefer small, source-backed changes over large rewrites.
- Do not load large generated JSON files unless the task requires sample data.
  Use `data/contracts/*.schema.json` first.
- Keep `.env`, Madden binary files, and generated output out of new docs.
- If you learn durable context while working, update the LLM wiki.
- If you make an architectural choice, append it to `docs/llm-wiki/decisions.md`.
- If you complete meaningful work, append a brief handoff note to
  `docs/llm-wiki/task-log.md`.

## Verification

There is no formal test suite in this repo today. Prefer the narrowest practical
verification for the change:

- Python syntax: `python -m py_compile <file.py>`
- Node syntax/runtime smoke: `node <script.js> --help` when supported
- Draft pipeline smoke: `python run.py --prospects 5 --skip-fetch --skip-calibration`
- Rating validation: `node scripts/validate_ratings.js`

