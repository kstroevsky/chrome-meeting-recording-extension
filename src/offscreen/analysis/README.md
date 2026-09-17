# Analysis engine — running the model in the data plane

> Part of [`offscreen`](../README.md). The pipeline this executes is [`shared/analysis`](../../shared/analysis/README.md); the control plane that queues and stores it is [`background`](../../background/README.md). Decisions: [ADR-0007](../../../docs/adr/0007-topics-are-derived-from-a-persisted-transcript.md), [ADR-0004](../../../docs/adr/0004-decouple-uploads-from-the-recording-session.md) for the durability shape.

## Purpose and mental model

Where the embedding model actually runs, and where one recording's analysis lives as a **job** that outlives the service worker.

Think of it as `UploadManager`'s sibling. The problems are the same shape — long work in the data plane whose owner in the control plane can be terminated mid-flight — so the answers are the same: a queue at concurrency 1, state reported as it moves, and a terminal state held in a durable outbox until background acknowledges it.

## Threading and execution context

```text
background (service worker, disposable)
    │  OFFSCREEN_ANALYZE_TRANSCRIPT  ─────────────┐
    ▼                                             │
offscreen document (long-lived)                   │
    │  AnalysisManager — queue, concurrency 1     │
    ▼                                             │
EmbeddingWorkerClient ──▶ analysisWorker (Worker) │
                          Transformers.js + ORT   │
                          WebGPU → WASM           │
    │                                             │
    └── OFFSCREEN_ANALYSIS_STATE / _RESULT ───────┘
```

Three separate threads of responsibility, deliberately:

| Runs in | Owns |
| :--- | :--- |
| Service worker | orchestration, the transcript read, persistence — **the only writer of `recording-history`** |
| Offscreen main thread | the job queue, the outbox, holding a completed result until acked |
| Dedicated `Worker` | the ONNX graph and every forward pass |

The worker exists for the same reason `opfsWorker` does: the offscreen main thread is busy with capture, encoding and the audio bridge, and a multi-second inference on it would be felt.

## Key invariants and gotchas

- **An offscreen document has no `chrome.storage`.** Its `chrome` object is `runtime` only — measured, not assumed. Anything here that needs durable state uses IndexedDB, which belongs to the extension origin and is shared with the service worker and extension pages. The outbox was first written against `chrome.storage.local` and silently stored nothing. (`UploadJobStateOutbox` in `../drive/` has the same defect.)
- **The worker is told where its artifacts are; it never looks them up.** No `chrome.*` in `analysisWorker.ts` — the parent hands it `modelBaseUrl` and `wasmBaseUrl`. That keeps it testable outside an extension and keeps extension knowledge in the one place that has it.
- **No network, enforced rather than assumed.** `env.allowRemoteModels = false`, so a wrong path fails loudly instead of quietly reaching a CDN. Stated precisely because the stronger claim is false: a worker still *has* `fetch`. `tests/e2e/analysis-embedding.spec.ts` proves it from outside by blocking all outbound HTTP(S) and still getting vectors.
- **The backend probe happens *inside* each attempt.** A driver can advertise WebGPU, initialize, and then fail on its first inference. Probing after the loop would report that as a hard failure instead of falling through to WASM; probing inside it, with `dispose()` on failure, is what makes the ladder real.
- **A downgrade is reported, never silent.** `EmbeddingWorkerClient` calls `reportWarning` when the backend that loaded is not the one requested — the house rule `WorkerStorageTarget` established. A machine without WebGPU is an ordinary tier (RES-06/08), but the user is about to wait considerably longer.
- **Concurrency is 1 and not configurable.** Two analyses contend for one GPU and one model; the second finishes no sooner for having started, and a live capture alongside would feel both.
- **The engine is released when the queue drains.** A loaded ONNX graph holds GPU buffers and analysis is a rare per-recording event, so one model load serves a whole queue and nothing stays resident between recordings.
- **A deliberately unsealed result is released without touching the outbox.** After bounded seal failures a result is delivered anyway (liveness over crash durability, for derived data only). Acknowledging it must not then ask the same broken store to remove a row that was never written — that failure would hold the payload forever, which is precisely what the fallback exists to prevent.
- **Acknowledgement removes the durable row first, then the held result.** If the row cannot be removed, the result stays, so a reconnect redelivers it rather than treating the row as a lost result and recomputing.
- **A result is released on acknowledgement, never on delivery.** `deliver` is a `postMessage`: it resolving means the message left, not that anything was stored. The gap between the two is where a result would otherwise be lost.
- **"Busy" includes a completed-but-unacknowledged result.** A job reports `completed` before its result is persisted, so a busy check watching only running jobs would let `closeForUpdate()` discard the only copy.
- **Job state is durable; the result is not.** A completed analysis is held in memory until background acks, and recomputed if this document dies first. That is proportionate — unlike upload bytes, an analysis is derived data the transcript can always reproduce, and the reconnect window is seconds because the offscreen's own reconnect wakes the service worker.
- **Vector width is checked every batch.** A width change mid-session would silently make stored vectors incomparable, so a mismatched reply is refused rather than let through.
- **The offscreen→background port is JSON, not a structured clone.** A `Float32Array` sent over it arrives as `{"0": …}`. Results cross as plain arrays via `toWireAnalysis`.

## Failure modes and recovery

| Failure | Detected by | Recovery | Blast radius |
| :--- | :--- | :--- | :--- |
| No WebGPU on this machine | worker's first inference throws | falls through to WASM, warns | slower analysis, same topics |
| Neither backend loads | both ladder rungs throw | `unsupported` latches for the session; jobs end `unsupported` | no topics; recording unaffected |
| Worker crashes mid-batch | `worker.onerror` | every in-flight request rejects; the job ends `failed` and the engine is dropped | one job |
| Worker wedges silently | per-request timeout | request rejects, job reaches a terminal state | one job; without this the outbox entry would never settle |
| Background dies mid-analysis | port disconnect | job completes anyway; state replays from the outbox and the result is re-offered on reconnect | none |
| Background never acks | ack absent | outbox entry and held result both persist; re-delivered on every reconnect | none |
| Job ends without a result | `failed` / `canceled` / `unsupported` | background acknowledges immediately — nothing is coming, and the outbox drains only on acknowledgement | none |
| Recording deleted mid-run | background's purge marker | job cancelled; a late result is acknowledged and discarded rather than stored | none |
| Extension update mid-analysis | `closeForUpdate()` | **refuses** while a job is active (HOST-04) | update deferred, not the job |
| Result arrives damaged | `fromWireAnalysis` rejects it | dropped *and still acked* — resending cannot fix it | recording reads as un-analysed, re-runnable |
| Background dies after receiving a result, before storing it | no acknowledgement | result still held; redelivered on reconnect and stored (E2E: ~0.5 s) | none |
| Offscreen document restarts while holding a result | replayed `completed` row with no result behind it | reported as a lost result; background acknowledges and re-runs from the transcript | one recomputation |
| Outbox row cannot be removed on ack | IndexedDB error | row *and* result kept; next reconnect redelivers and acknowledges again | none |

## Files

| File | Role |
| :--- | :--- |
| `analysisWorker.ts` | The engine: Transformers.js + ONNX Runtime, the WebGPU→WASM ladder, mean-pooled and L2-normalized output |
| `analysisWorkerProtocol.ts` | The wire between document and worker. Deliberately free of `chrome.*` |
| `EmbeddingWorkerClient.ts` | Spawn, open handshake, promise-per-seq, the `unsupported` latch, batch splitting |
| `engineConfig.ts` | Where the packaged artifacts are — the URLs only an extension context can form |
| `AnalysisManager.ts` | The queue: one job at a time, progress, cancellation, engine lifetime, held results |
| `AnalysisJobStateOutbox.ts` | Terminal job state in IndexedDB (`analysis-job-outbox`), one key per job; the acknowledgement ordering |
| `AnalysisSealLedger.ts` | One sealing outcome per job, and what acknowledging it therefore does |

## Configuration

The model is chosen at **build** time, not runtime. `scripts/fetch-analysis-model.mjs` verifies byte length and SHA-256 against pinned digests, webpack copies exactly one ONNX export, and the same manifest fills the `__ANALYSIS_MODEL__` define — so a build that packaged Q8 cannot produce an analysis claiming FP16.

Currently `Xenova/multilingual-e5-small` at Q8: 384 dimensions, 118 MB. WASM is single-threaded because threaded ORT needs `SharedArrayBuffer`, which needs cross-origin isolation. An extension *can* opt into that with COOP/COEP headers; this one does not, and doing so is its own spike rather than a rider on this work.

## Testing notes

The manager and the client are unit-tested against fakes — a `Worker` double and a stub engine — so the queue, the ladder reporting, cancellation, the held-result replay and every failure row above are provable without a model.

Everything involving real weights is E2E, because that is the only place the CSP, the webpack chunking and the ORT WASM paths are real:

- `analysis-embedding.spec.ts` — the runtime proof, with all outbound HTTP(S) blocked
- `analysis-embedding-bench.spec.ts` — throughput and browser RSS
- `analysis-embedding-agreement.spec.ts` — Q8 against FP16
- `analysis-calibration-dump.spec.ts` — the corpus 4B was frozen from

## Maintenance playbook

| When | Do |
| :--- | :--- |
| Bumping `@huggingface/transformers` or ORT | re-run the bench and the agreement dump; the pinned ORT variant list in `webpack.config.js` is derived from what ORT actually demands, not from file names |
| Changing the model or its dtype | update `scripts/fetch-analysis-model.mjs`'s pins, then re-run 4B — thresholds are calibrated against one encoder's cosine distribution |
| Changing a `shared/analysis` stage's behaviour | bump `PIPELINE_VERSION`; stored results go stale and recompute rather than being compared against new ones |
| Adding a runtime device | extend the ladder in `analysisWorker.ts`, not in the client — the client reports what loaded, it does not choose |

## Related

- [ADR-0007](../../../docs/adr/0007-topics-are-derived-from-a-persisted-transcript.md) — the compute host and the packaged-weights decision
- [ADR-0004](../../../docs/adr/0004-decouple-uploads-from-the-recording-session.md) — the job/outbox/ack shape this mirrors
- [`shared/analysis`](../../shared/analysis/README.md) — the pipeline this executes
- [`offscreen/storage`](../storage/README.md) — `WorkerStorageTarget`, the structural precedent for the client
