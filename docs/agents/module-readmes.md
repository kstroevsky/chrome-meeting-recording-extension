# Module READMEs — conventions

How per-module `README.md` files under `src/` are structured. The goal is **scoped context**: an agent or contributor working in one module should get the *why*, the invariants, and the gotchas from that module's README without loading the whole root architecture reference. Consistency comes from a shared **vocabulary of section types** and a small set of **archetypes** — not from one rigid template.

## What earns a README

A directory gets a `README.md` when **any** of:

1. it's a cohesive subsystem with non-obvious internal invariants (e.g. `offscreen/storage`, `shared` projection), or
2. it's a distinct runtime context / entry surface (`background`, `offscreen`, `popup`, `content`), or
3. it's a small-but-architecturally-significant seam (`platform/capabilities` auth, `platform/chrome` adapters).

Do **not** add one where it would only restate codegraph-derivable structure with no invariants or rationale. Those leaf dirs fold into the parent (`popup/controllers`, `debug/renderers`, `shared/{types,constants,utils}`, `background/perf` — the last is covered by the [instrumentation doc](../plans/storage-and-instrumentation-architecture.md)).

## Module vs. root (the cross-cutting test)

> If a section describes **two of *our* runtime contexts as peers** (background↔offscreen, popup↔background) → it belongs in the **root README**. If it's **one context's internals** — even when the other side is an *external* API (Google Drive, `chrome.identity`) → it belongs in the **module README**.

Three levels max (root → `offscreen/README.md` → `offscreen/storage/README.md`); **each level links down and never restates** what a deeper level owns.

## The section library (the menu)

Pick the subset that fits; order them so substantive content precedes link sections:

| Section | Carries | Best for |
| :--- | :--- | :--- |
| Purpose / mental model | one-paragraph "think of this as X" | all |
| The contract | the interface/types that unify the module | subsystems |
| Design rationale & theory | *why*, with academic/industry refs tied to a concrete decision | algorithmic, protocol |
| Threading / execution context | what runs where | perf-sensitive |
| Key invariants & gotchas | non-obvious rules the code can't state | all |
| Failure modes & recovery | table: failure → detection → recovery → blast radius | resilience-critical |
| State model & transition table | formal states + the projection | state machines |
| Diagram(s) | state / sequence / dataflow — as many as the module needs | varies |
| Configuration & flags | the tunables + trade-offs | flag/settings-driven |
| Observability | emitted diagnostic events | producers of perf events |
| Files | annotated map | all |
| Wiring / entry points | how it's invoked; links up for cross-context | all |
| Testing notes | how to test, what e2e covers, mocking gotchas | all |
| Maintenance playbook | "when X upstream changes, do Y" | fragile boundaries |
| Alternatives considered | why this over the obvious alternative | non-obvious choices |
| Browser support & privacy | capability detection, data residency | platform-bound |
| Related | ADRs, plans, sibling modules | all |
| External references | curated specs / RFCs / vendor docs | all |

## Archetypes (compositions) and their owners

| Archetype | Emphasis | Modules |
| :--- | :--- | :--- |
| **Resilience Subsystem** | failure-modes table, durability budget, threading | `offscreen/storage`, `offscreen/engine` |
| **Protocol & State Model** | transition table, reconciliation theory, provable invariants | `shared` |
| **Fragile Boundary** | fragility, maintenance playbook, adapter isolation | `content` |
| **External Integration** | sequence diagrams, external API/RFC refs, retry table | `offscreen/drive`, `platform/capabilities` (auth) |
| **Platform Runtime** | MV3/Chrome-API constraints, lifecycle | `background`, `offscreen` (composition), `platform/chrome` |
| **Interactive Surface** | state-driven UI, message flow, "not authoritative" | `popup` |
| **Reference Catalog** | schema / event tables | `shared/settings`, `debug` |

Omitting a section that doesn't apply is correct (e.g. `shared` is pure logic → no threading/failure-table; `content` runs on the page thread → no worker offload). Be deliberate, not exhaustive.

## Accuracy practices (non-negotiable)

- **Write from verified source, not memory.** Read the module (codegraph `codegraph_explore`) before describing wiring/constants/behavior. Real bugs shipped from assuming (`makeChunkHandler`'s location, `recordingAutoStop`'s triggers) — confirm before asserting.
- **Validate every Mermaid diagram** with the Mermaid MCP tool *and* against the GitHub-renderer hazards below (the validator is more lenient than GitHub's pinned renderer).
- **Diff against the root** when migrating: the module README must be a *superset* of what root held for that module — nothing lost.

### Mermaid GitHub-renderer hazards (learned)

The Mermaid Chart validator accepts these; GitHub's renderer breaks on them. Avoid:

- a second colon inside a transition/edge label (`:=` breaks `stateDiagram` — use words);
- `<br/>` inside a **`stateDiagram` transition label** (flowchart/sequence tolerate it; state labels don't);
- nested `[ ]` inside a quoted flowchart node label;
- unquoted decision nodes / edge labels containing `?` or `/` → quote them: `C{"x?"}`, `-->|"a / b"|`;
- a `sequenceDiagram` participant id that collides with a keyword (`OFF` lexes as `off`) → use a longer id; and avoid trailing `()` in sequence self-messages.

## Status

**All 12 module READMEs exist and are diagram-validated:** `offscreen` (composition) + `offscreen/{engine,storage,drive}`, `shared` + `shared/settings`, `background`, `popup`, `content`, `debug`, `platform/{chrome,capabilities}`. Two deliberately bent the template: `offscreen/engine` is a *Media Pipeline* variant (dataflow + audio-graph diagrams instead of a failure table), and `platform/chrome` is a *seam catalog* (no diagram — it's a wrapper inventory).

The **root-consolidation is done**: the root README's module-internal sections (the domain model, Architecture components 1–11, the file map) and the 10 module-specific diagrams were gutted to pointers; only the **cross-cutting** content remains (overview, the layering/flow diagrams 1/2/4/6/15/17, the message contract, end-to-end flows, operational notes) plus a **Module guide** navigation index. Root went 2025 → ~1166 lines with no information loss (every gutted section is a superset in its module README).
