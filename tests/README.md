# Tests — the test strategy

> What lives here vs. next to the source, the runner per tier, and how to run each. The non-obvious part: **unit tests are co-located in `src/`** (`src/**/__tests__/`); this folder holds only the tests that *can't* be co-located — integration, e2e, and build-level.

## The layered taxonomy

| Tier | Where | Runner | What |
| :--- | :--- | :--- | :--- |
| **Unit** | `src/**/__tests__/*.test.ts` (+ `src/debug/renderers/tests/`) | jest | one module in isolation; lives beside its source for scoped context, including recording-history pagination and upload-job state/retry behavior |
| **Integration** | `tests/background.test.ts` | jest | spans modules (the fence + watchdog across session + offscreen + wiring) — no single module home |
| **e2e** | `tests/e2e/*.spec.ts` (+ `helpers/`, `fixtures/`) | Playwright | the built extension against a mock (or real) Meet page |
| **Node build-level** | `tests/scripts/*.test.mjs` | `node --test` | manifest source/version/targets, telemetry endpoint permission, real-meet CLI/profile—release-build concerns |
| **Worker service** | `telemetry-worker/test/*.test.ts` | vitest | strict public ingestion, CORS, idempotency, rate/D1 failure classification, scheduled retention |
| **e2e-adjacent** | `tests/realMeetScenarios.test.ts` | jest | scenario logic that imports `e2e/helpers` (not a module unit) |

`setup.ts` is the jest global setup; `fixtures/mock-meet.html` is the DOM the mock-Meet e2e drives. Jest sets `watchman: false` in its repository config (and the npm command repeats it) so local/CI runs do not depend on a Watchman service.

## Why unit tests are co-located but these aren't

Co-locating a module's unit test (`src/foo/__tests__/foo.test.ts`) gives an agent or contributor working in that module everything in one place (see [the conventions](../docs/agents/module-readmes.md)). The tests **here** can't co-locate because they either span several modules (integration), drive the *built* artifact (e2e), or test the *build/release* itself (node). jest's `testMatch` globs both `src/**/*.test.ts` and `tests/**/*.test.ts`; `collectCoverageFrom` excludes `*.test.ts`.

## Running them

| Command | Runs |
| :--- | :--- |
| `npm run test:unit` | jest (all unit + integration) **+** `node --test` (build-level) |
| `npm run test:e2e:mock` | build the deterministic e2e bundle + Playwright functional specs and `@perf-smoke`; excludes `@production-build` and the heavier perf tiers |
| `npm run test:e2e:production` | build production `dist/` and run `@production-build` integration tests against the real packaged runtime |
| `npm run test:e2e:perf:smoke` / `:full` / `:contention` / `:endurance` / `:hardware` | the perf tiers (tagged `@perf-*`); these invocations enable numeric performance thresholds |
| `npm run test:e2e:real` | the real-Google-Meet harness (needs a configured profile — `test:e2e:real:profile`) |

The perf tiers are tagged in the spec titles (`@perf-smoke`, `@perf-full`, `@perf-contention`, `@perf-endurance`, `@perf-hardware`) and selected via Playwright `--grep`. Required functional CI still runs the `@perf-smoke` scenarios for their storage/upload correctness assertions, but numeric latency/event-loop SLOs are enforced only by the dedicated perf commands.

## The e2e specs

| Spec | Covers |
| :--- | :--- |
| `mock-meet-extension.spec.ts` | functional record/transcript/save against the mock Meet page |
| `mock-meet-performance.spec.ts` | the perf matrix + reliability (`@perf-*`) |
| `storage-contention.spec.ts` | OPFS worker vs. main-thread under load (`@perf-contention`) |
| `recovery.spec.ts` | crash / orphan recovery |
| `recording-history.spec.ts` | IndexedDB v2→v3 history migration and tombstone-free paged index |
| `recording-rename.spec.ts` | completed Drive naming prompt plus remote folder/file metadata rename through the built extension |
| `upload-retry.spec.ts` | retained-artifact retry, fallback, cancellation, and duplicate-local-download guards for detached Drive jobs |
| `src/recordings/__tests__/RecordingsController.test.ts` (unit) | history-page paging, rename, remove, and loading-state behavior against the background contract |
| `settings-matrix.spec.ts` | the settings → recorder parameter matrix |
| `real-meet.spec.ts` | the real-Meet harness path |

Production telemetry has two coordinated test homes. `src/shared/telemetry/__tests__/` covers client sanitization, reducer/storage bounds, delivery classification, and exactly-once recovery; `telemetry-worker/test/` mirrors the server allowlist and transport contract. Run the Worker checks from that directory with `npm test && npm run typecheck && npm run dry-run`.

## Related

- [Module README conventions](../docs/agents/module-readmes.md) — the co-location rationale.
- [Perf roadmap](../docs/plans/perf-optimization-roadmap.md) — what the `@perf-*` tiers validate before a flag flips default-on.
- [`scripts/`](../scripts/README.md) — the release-build guards the `node --test` tier complements.
