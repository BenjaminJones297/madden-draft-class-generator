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

