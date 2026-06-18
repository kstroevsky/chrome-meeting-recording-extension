# Tests — the test strategy

> What lives here vs. next to the source, the runner per tier, and how to run each. The non-obvious part: **unit tests are co-located in `src/`** (`src/**/__tests__/`); this folder holds only the tests that *can't* be co-located — integration, e2e, and build-level.

## The layered taxonomy

| Tier | Where | Runner | What |
| :--- | :--- | :--- | :--- |
| **Unit** | `src/**/__tests__/*.test.ts` (+ `src/debug/renderers/tests/`) | jest | one module in isolation; lives beside its source for scoped context |
| **Integration** | `tests/background.test.ts` | jest | spans modules (the fence + watchdog across session + offscreen + wiring) — no single module home |
| **e2e** | `tests/e2e/*.spec.ts` (+ `helpers/`, `fixtures/`) | Playwright | the built extension against a mock (or real) Meet page |
| **Node build-level** | `tests/scripts/*.test.mjs` | `node --test` | manifest source/version, real-meet CLI/profile — release-build concerns |
| **e2e-adjacent** | `tests/realMeetScenarios.test.ts` | jest | scenario logic that imports `e2e/helpers` (not a module unit) |

`setup.ts` is the jest global setup; `fixtures/mock-meet.html` is the DOM the mock-Meet e2e drives.

## Why unit tests are co-located but these aren't

Co-locating a module's unit test (`src/foo/__tests__/foo.test.ts`) gives an agent or contributor working in that module everything in one place (see [the conventions](../docs/agents/module-readmes.md)). The tests **here** can't co-locate because they either span several modules (integration), drive the *built* artifact (e2e), or test the *build/release* itself (node). jest's `testMatch` globs both `src/**/*.test.ts` and `tests/**/*.test.ts`; `collectCoverageFrom` excludes `*.test.ts`.

## Running them

| Command | Runs |
| :--- | :--- |
| `npm run test:unit` | jest (all unit + integration) **+** `node --test` (build-level) |
| `npm run test:e2e:mock` | build the e2e bundle + Playwright functional specs (excludes perf tiers) |
| `npm run test:e2e:perf:smoke` / `:full` / `:contention` / `:endurance` / `:hardware` | the perf tiers (tagged `@perf-*`) |
| `npm run test:e2e:real` | the real-Google-Meet harness (needs a configured profile — `test:e2e:real:profile`) |

The perf tiers are tagged in the spec titles (`@perf-smoke`, `@perf-full`, `@perf-contention`, `@perf-endurance`, `@perf-hardware`) and selected via Playwright `--grep`.

## The e2e specs

| Spec | Covers |
| :--- | :--- |
| `mock-meet-extension.spec.ts` | functional record/transcript/save against the mock Meet page |
| `mock-meet-performance.spec.ts` | the perf matrix + reliability (`@perf-*`) |
| `storage-contention.spec.ts` | OPFS worker vs. main-thread under load (`@perf-contention`) |
| `recovery.spec.ts` | crash / orphan recovery |
| `settings-matrix.spec.ts` | the settings → recorder parameter matrix |
| `real-meet.spec.ts` | the real-Meet harness path |

## Related

- [Module README conventions](../docs/agents/module-readmes.md) — the co-location rationale.
- [Perf roadmap](../docs/plans/perf-optimization-roadmap.md) — what the `@perf-*` tiers validate before a flag flips default-on.
- [`scripts/`](../scripts/README.md) — the release-build guards the `node --test` tier complements.
