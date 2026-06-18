# Docs — index

Project documentation. (Architecture lives in the repo-root `README.md` and the per-module `src/**/README.md` files; this folder is decisions, agent guides, plans, and test protocols.)

| Path | What |
| :--- | :--- |
| `adr/` | **Architecture Decision Records** — `0001` single-context docs layout, `0002` cross-browser strategy, `0003` recording-phase ownership (the desired/observed split + epoch fence + watchdog) |
| `agents/` | **Agent/skill guides** — `domain.md` (CONTEXT/glossary convention), `module-readmes.md` (the per-module README conventions), `issue-tracker.md`, `triage-labels.md` |
| `plans/` | **Living plans** — `perf-optimization-roadmap.md`, `storage-and-instrumentation-architecture.md` |
| `testing-scenario-a.md`, `testing-scenario-b.md` | real-hardware manual test protocols |
| `brand/` | brand assets |

## Conventions

- **ADRs** are append-only decisions; if your change contradicts one, surface it rather than silently overriding (see `agents/domain.md`).
- **Per-module READMEs** follow `agents/module-readmes.md` (section library + archetypes + the Mermaid GitHub-renderer hazards).
- Diagnostics JSON exports (`extension-diagnostics-*.json`) are captured perf snapshots from real runs, kept for analysis.
