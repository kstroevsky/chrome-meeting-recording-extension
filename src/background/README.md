# Background — the control plane (MV3 service worker)

> The extension's brain: it owns the canonical recording state, orchestrates start/stop, manages the offscreen document's lifecycle, and survives its own death. It runs as an **MV3 service worker** — ephemeral and restartable at any moment — which shapes every decision here. For symbol-level structure use codegraph (`codegraph_explore "RecordingController RecordingSession OffscreenManager"`). The phase *projection* it depends on is documented in [`shared`](../shared/README.md); the offscreen *data plane* it commands is [`offscreen`](../offscreen/README.md).

> **Archetype:** *Platform Runtime*. The hard part here isn't business logic — it's that the runtime (the MV3 SW) can be **evicted between any two events** and restarted with empty memory. So this README leads with the platform constraints and how the control plane is built to survive them. If you read one section, read **MV3 service-worker constraints**.

## Purpose & mental model

The background is the **single source of truth** and the only place that *commands* recording. The mental model is **command plane vs. data plane**: the background decides *what should happen* (start/stop/discard, the `desired` intent) and persists it; the offscreen document *does* the recording and reports *what is happening* (the `observed` status). The background also owns durable recording-history transitions. It never captures media; the offscreen never decides policy. Everything below exists to keep that authority coherent across service-worker restarts.

## MV3 service-worker constraints (the platform reality)

A Manifest V3 service worker is **not** a long-lived background page. Chrome evicts it when idle and restarts it on the next event, with **all in-memory state gone**. Three mechanisms cope:

- **Persisted snapshot.** The `RecordingSessionSnapshot` lives in `chrome.storage.session` (survives SW restarts, cleared on browser close — exactly a run's lifetime). On startup the worker calls `session.hydrate(...)` to rebuild in-memory state from it.
- **Keep-alive while busy.** `startKeepAlive` pokes the runtime every **20 s** while capture is active **or** a detached upload job is still draining. Capture can now be `idle` while Drive work continues, so the lifecycle uses the upload-job state as well as the recording phase; `stopKeepAlive` ends it only when both are settled. (See the [`@perf`] note: this is a cost paid only during useful work.)
- **Liveness backstop.** Because an in-flight RPC promise dies with the worker, a session can rehydrate stuck in `starting`/`stopping` — the **phase watchdog** rescues it (below).

```mermaid
stateDiagram-v2
    [*] --> Active: an event wakes the worker
    Active --> Suspended: idle, Chrome evicts
    Suspended --> Active: next event (message, command, timer)
    Active --> Active: keep-alive poke (20s) while busy
    note right of Suspended
        in-memory state gone;
        snapshot persisted in chrome.storage.session
    end note
    note right of Active
        on wake: rehydrate the snapshot,
        re-arm the watchdog from updatedAt
    end note
```

This is also why **`updatedAt` matters**: timers (the watchdog budget) are measured from the snapshot's `updatedAt`, not from when the worker happened to wake — so a session rehydrated into an already-stale phase is treated correctly, not granted a fresh budget.

## The control-plane flow (start)

```mermaid
sequenceDiagram
    participant P as Popup or shortcut
    participant BG as RecordingController
    participant SES as RecordingSession
    participant OM as OffscreenManager
    participant OS as Offscreen

    P->>BG: START_RECORDING (tabId, runConfig)
    BG->>BG: validate, check tab-capture conflict, load settings
    BG->>SES: start, desired=recording, epoch += 1
    BG->>OM: ensureReady
    BG->>BG: getMediaStreamIdForTab(tabId)
    BG->>OS: OFFSCREEN_START (streamId, settings, epoch)
    OS-->>BG: ok (RPC ack)
    OS-->>SES: OFFSCREEN_STATE (observed, epoch)
    SES->>SES: applyOffscreenPhase, writes observed only
    Note over SES: phase = projectPhase(desired, observed, failed)
```

`RecordingController.start` is the orchestration: validate the request → reject if the tab already has a capture → create an independent random telemetry run ID → load the frozen recorder + perf settings → `session.start()` (which assigns a fresh, strictly-increasing **epoch** and history id) → `ensureReady()` the offscreen → resolve a `tabCapture` stream id → fire `OFFSCREEN_START` over RPC. The telemetry ID is carried through capture/finalization/detached upload but never replaces the epoch, history ID, or upload job ID. `stop` is the mirror: collect the final caption snapshot, guard `isStoppablePhase`, `markStopping()` (`desired=idle`), fire `OFFSCREEN_STOP`. `discard` takes the same guarded stop path but sends `OFFSCREEN_DISCARD`, which deletes temporary artifacts rather than downloading or uploading them. Any failure on either path calls `session.fail(error)` and records only an allowlisted sanitized incident when diagnostics are enabled.

## The session state machine

`RecordingSession` is the canonical machine (ADR-0003 Decision 4). It writes the two planes; it never writes `phase` (derived). Method → effect:

| Method | Writes | Notes |
| :--- | :--- | :--- |
| `start(runConfig, target)` | `desired=recording`, `observed=starting`, `epoch += 1` | fresh fencing token per run |
| `markStopping()` | `desired=idle` | phase derives to `stopping` while capture drains |
| `applyOffscreenPhase(update)` | `observed` only (or finalize) | a same-run `idle` finalizes; `failed` → `fail()` |
| `markIdle()` | resets to idle | preserves `epoch` (monotonic across runs) |
| `fail(error)` | `failed=true` | preserves run context for the error view |
| `setMicMuted/CameraMuted/Paused` | overlay flags + the pause-aware timer | mirrors offscreen actuation for a reopened popup |
| `upsertUploadJob(job)` | `uploadJobs` | persists a detached Drive job independently of the recording phase |
| `flush()` | — | waits for queued `chrome.storage.session` writes before an upload-state acknowledgement |

Every mutation goes through `commit()` → persist + notify the change listener. The pause-aware timer (`recordedMs`/`runningSince`) is banked/restarted by `nextTimer` and `setPaused` so the popup clock excludes paused spans.

## Liveness: the phase watchdog

The epoch fence drops *stale* status; it does nothing for *missing* status. A worker that dies mid-start/stop leaves a session rehydrated in `starting`/`stopping` with no one to drive it on (the offscreen's reconnect re-broadcast is itself fenced out by the stale epoch). `createPhaseWatchdog` watches exactly those two orphan-prone phases (per-phase budget map: `STARTING_WATCHDOG_MS` / `STOPPING_WATCHDOG_MS`), armed from the session change-listener **including the rehydrated transition** (budget measured from `updatedAt`, so an already-stale phase fires immediately). On timeout it fails the session and tears down the offscreen so a retry starts clean. `recording` and `idle` are deliberately unwatched; detached uploads use their own recovery and job persistence rather than becoming a recording phase.

## Crash recovery & save

- **Rehydration:** on startup, `session.hydrate()` rebuilds from the persisted snapshot; the change-listener immediately re-arms keep-alive and the watchdog.
- **Save is crash-safe:** the `OFFSCREEN_SAVE` handler downloads the blob, then waits for the download to **actually settle** (`awaitDownloadSettled`, event-driven — not a blind timer). The OPFS source is deleted **only** on confirmed `complete`; an `interrupted` download frees the URL but keeps the OPFS file, and a `timeout` keeps both — so a recording is never lost to premature cleanup, and orphan recovery can reclaim it next launch.
- **History is durable, ordered, and deletion-scalable.** `RecordingHistoryRepository` stores normalized entries in IndexedDB. Its v3 `activeCreatedAtId` compound index contains only visible entries, ordered by `(createdAt, id)`; the upgrade migrates valid v2 rows into that index. `RecordingHistoryService` creates a pending record before delivery begins and atomically applies download or Drive outcomes. A local rename updates history directly; a current Drive rename first delegates folder/file metadata changes to the offscreen data plane, commits history only after success, and reconciles observed remote names if rollback is incomplete. Deletion leaves a durable tombstone so delayed recovery cannot resurrect the entry, but the tombstone is intentionally absent from page scans.


- **A row's `durationMs` is written by whoever creates the row.** The session's timer is capture-scoped — `markIdle()` drops both `recordedMs` and `historyId` — but history rows are created asynchronously by the finalize path (`createPending` for local, `applyUploadJob` for Drive) and can land either side of that. So `RecordingSession` banks the finished run's duration privately and answers `runDurationMs(historyId)` regardless of ordering, and each row-creation site follows up with `history.setDuration(...)`. The value is the same pause-aware duration notation timecodes are measured in, so a mark is always within its recording's duration — the invariant a timeline UI needs.

- **Notations are a second aggregate in the same database, not a field on the entry** (ADR-0005). A mark is stamped from `RecordingSession.currentRecordedMs()` — the pause-aware clock, whose domain equals playback position because a paused span is never written into the media — and stored under the run's `historyId`. It has to be its own store because a mark is made *during* capture, while the history row is not created until finalize; there is no row to attach to yet. Consequently the lifecycle owners clean up explicitly: `RecordingController.discard()` drops the run's notations, and `RecordingHistoryService.remove()` drops them through an injected `onRemoved` callback. A failed notation write is a data-plane error and never fails the recording session — the notation message types are listed in `NON_SESSION_RESPONSE_MESSAGE_TYPES` for exactly that reason.
- **Terminal upload delivery is acknowledged.** The background serializes upload-state persistence, updates history, then flushes the session snapshot before replying with `OFFSCREEN_ACK_UPLOAD_STATE`. This is the acknowledgement that lets the offscreen outbox delete its durable terminal-state record.

## Entry paths & offscreen lifecycle

- **Two ways to start:** the popup `START_RECORDING` message, and a **keyboard shortcut** (`recordingCommands`). The shortcut path matters because Chrome grants `activeTab` to user-invoked commands, keeping `tabCapture` tied to a real gesture.
- **`OffscreenManager`** owns the offscreen document: `ensureReady()` (create-or-reconnect + a version handshake that heals SW/offscreen code skew), and `ensureRecorderTabReady()` — a fallback that hosts the same recorder runtime in a normal extension *tab* when a Chrome version can't scope a tab-capture stream id to an offscreen document. On every reconnect it hydrates active upload-job liveness and receives replayed terminal job states before acknowledging them.

## Observability

The background owns the **persisted** perf snapshot and its **reducers** (`PerfDebugStore` + `perf/PerfDebugReducers`), folding events from *every* context into the summary. It does **not** emit `lifecycle.*` events itself — those come from the [offscreen](../offscreen/README.md) engine; `PerfDebugStore` reduces them into `summary.lifecycle` (`startRequested`/`startCompleted`, `stopRequested`/`stopCompleted`, `failureCount`, `warningCount`, `activeTracks`/`peakActiveTracks`, `lastStopDurationMs`). That reduction is what makes a `startRequested` with no matching `startCompleted` legible as the orphaned-start the watchdog exists to catch. Its persisted raw-event buffer is bounded: on overflow it evicts the oldest high-frequency samples before rare lifecycle/failure/warning/finalization signals, while incremental summary aggregates remain whole-session. The snapshot is read-only-rendered by [`debug`](../debug/README.md); why sampling (offscreen) and persistence (here) are split lives in the [instrumentation doc](../../docs/plans/storage-and-instrumentation-architecture.md).

Production telemetry is a separate bounded path owned by `TelemetryRuntime`. It assigns a random telemetry-only run ID, merges sanitized producer snapshots, checkpoints active/recoverable work in IndexedDB, turns stale unclosed work into one idempotent `recording_interrupted` incident, and manages the 10-batch/256 KiB outbox plus one-shot 5/15/60-minute retry alarms. Healthy capture and detached-upload outcomes flush separately; critical incidents queue immediately. Preference hydration is fail-closed, and opting out broadcasts disablement, cancels alarms, resets reducers, and deletes checkpoints/outbox data without changing recording or delivery behavior. The contract and privacy boundary live in [`shared/telemetry`](../shared/README.md#production-telemetry-contract); server operations live in the [telemetry Worker runbook](../../telemetry-worker/README.md).

## Key invariants & gotchas

- **The SW can die between any two lines.** Never hold run state only in memory; if it must survive a restart, it's in the snapshot.
- **`desired` has exactly one writer** (the command path here); `observed` is written only by `applyOffscreenPhase`. Don't cross them.
- **The epoch is assigned here and never written back** from offscreen status — the offscreen only echoes it so the fence can match.
- **Keep-alive is busy-only.** Don't pin the worker while idle; it's a deliberate cost paid during a run.
- **Recording and upload are different lifecycles.** A Drive job can be `uploading` while the canonical recording phase is `idle`, and starting a new recording must preserve that job.
- **History writes are atomic.** Never reconstruct an entry with an asynchronous read-then-write; use the repository transaction/update operation so a late delivery result cannot overwrite a rename, delete tombstone, or another file outcome.
- **`getSnapshot()` returns a `structuredClone`** — callers can't mutate the canonical state by reference.

## Files

| File | Role |
| :--- | :--- |
| `RecordingSession.ts` | the canonical state machine (writes planes, derives phase, owns the timer, answers `runDurationMs` for a run that has already ended) |
| `RecordingController.ts` | start/stop/discard/mute/pause orchestration (validate → command offscreen) |
| `OffscreenManager.ts` | offscreen document lifecycle: ensure/reconnect, version handshake, recorder-tab fallback, RPC, and upload-state acknowledgement |
| `RecordingHistoryRepository.ts` | IndexedDB persistence: normalized records, v2→v3 active-entry index migration, bounded visible-page reads, atomic updates |
| `RecordingHistoryService.ts` | history transitions for pending files, settled downloads, Drive jobs, rename/delete, duration, and opening local downloads |
| `recordingHistoryDatabase.ts` | the shared `recording-history` IndexedDB connection + schema (v4): owns the version and creates both object stores, so no repository can downgrade-block another |
| `RecordingNotationRepository.ts` | IndexedDB persistence for notations, keyed by `historyId`: atomic read-modify-write of the whole list |
| `RecordingNotationService.ts` | notation transitions (add/update/end-open/remove/remove-all) with strict write validation |
| `TelemetryRuntime.ts` | production telemetry preference, per-run coordination, recovery, outbox delivery, retry alarms, and opt-out deletion |
| `phaseWatchdog.ts` | liveness backstop for orphaned `starting`/`stopping` |
| `sessionLifecycle.ts` | keep-alive loop, crash-safe save handler, and `isFreshRecordingStart` (resets diagnostics at the start of a new run, so a finished run's snapshot survives for export) |
| `recordingAutoStop.ts` | auto-stop when the recorded tab is **closed** or **navigates away** from the meeting → `controller.stop()` |
| `recordingCommands.ts` | keyboard-shortcut start path (preserves `activeTab`) |
| `messageHandlers.ts` | registers the `chrome.runtime.onMessage` listener and dispatches popup commands to their handlers |
| `legacySession.ts` | rehydrates pre-refactor persisted state (the old separate `phase` / `activeRunConfig` keys) into a snapshot |
| `driveAuth.ts` | Drive OAuth token acquisition (silent→interactive, bad-client-id diagnosis) — token *use* is [`offscreen/drive`](../offscreen/drive/README.md) |
| `PerfDebugStore.ts` + `perf/` | the persisted perf snapshot + reducers (`PerfDebugReducers`, `PerfDebugState`) + `CpuSampler` (dev-only); see the [instrumentation doc](../../docs/plans/storage-and-instrumentation-architecture.md) |

Wiring entry: `src/background.ts` (the SW entrypoint) routes messages/commands to `RecordingController` (including the content script's `MEETING_ENDED` → `controller.stop()`), serializes upload-state persistence into the session and history service, drives the session change-listener (persist → broadcast → keep-alive → `watchdog.observe` → reset diagnostics on a fresh-run start), and rehydrates on startup.

## Testing notes

- `RecordingSession`, `RecordingController`, `phaseWatchdog`, `OffscreenManager`, `RecordingHistoryRepository`, `RecordingHistoryService`, `RecordingNotationRepository`, and `RecordingNotationService` are tested in `__tests__/` with injected persistors/clocks/timers (the watchdog takes injectable `now`/`setTimer` precisely so budgets are deterministic). History tests cover cursor ordering, atomic rename/delete, Drive metadata success/rollback/incomplete rollback, tombstones, and delayed local/Drive outcomes. The browser tests `tests/e2e/recording-history.spec.ts` and `recording-rename.spec.ts` cover real IndexedDB migration and the post-upload remote rename path. Notation tests cover the v3→v4 upgrade against real seeded v3 data (`RecordingNotationRepository.test.ts`), the pause-exclusion guarantee that makes a timecode seekable (`RecordingSession.test.ts`), and end-to-end message routing (`tests/backgroundNotations.test.ts`). `tests/e2e/recording-notations.spec.ts` proves that guarantee against the real pipeline — a real `MediaRecorder` pause in a real browser — by asserting that two marks separated by 2 s of recording and 3 s of pause are ~2 s apart, not ~5 s.
- `background.test.ts` (kept in the central `tests/` tree) is the **integration** test: it hydrates a stale phase and asserts the fence + watchdog behavior end-to-end across session + offscreen + wiring — it spans modules, so it doesn't live here.

## Related

- [ADR-0003](../../docs/adr/0003-recording-phase-ownership-and-stale-offscreen-status.md) — the epoch fence + desired/observed split + watchdog rationale.
- [ADR-0004](../../docs/adr/0004-decouple-uploads-from-the-recording-session.md) — why Drive upload jobs outlive the recording phase.
- [`shared`](../shared/README.md) — the `projectPhase` projection and snapshot shape this machine writes.
- [`recordings`](../recordings/README.md) — the page that consumes the durable history service.
- [`offscreen`](../offscreen/README.md) — the data plane this commands.

## External references

- Chrome — [Service workers in extensions](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers) and [their lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) (eviction, events, keep-alive realities).
- Chrome — [`chrome.offscreen`](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [`chrome.tabCapture`](https://developer.chrome.com/docs/extensions/reference/api/tabCapture), [`chrome.storage`](https://developer.chrome.com/docs/extensions/reference/api/storage) (`session` area), [`chrome.commands`](https://developer.chrome.com/docs/extensions/reference/api/commands), [`chrome.downloads`](https://developer.chrome.com/docs/extensions/reference/api/downloads).
