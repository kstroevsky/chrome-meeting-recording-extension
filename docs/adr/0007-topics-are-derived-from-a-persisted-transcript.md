# ADR-0007 — Topics are derived from a persisted transcript, and local inference runs in the data plane

- **Status:** Accepted — 4A ran and passed; its frozen values are in "4A closed" below. 4B has run against a *synthetic* corpus only: every semantic value it produced is a candidate, not a contract, until validated against hand-labelled real conversation.

> **Reading this document.** Sections below are in the order they were written, so earlier ones describe a world where decisions were still open and say so in the present tense. Where an earlier section's status language contradicts this header — "stays `Proposed` until…", "still open for 4A" — **the header wins**: those conditions were subsequently met and are recorded in the dated amendments at the end. The historical text is kept rather than rewritten because the reasoning that led to a decision is worth more than a tidy narrative, and `lossless-plan-evolution` treats silent rewriting of a superseded rationale as a loss.
- **Date:** 2026-09-11

## Context

The extension records and plays back, but understands nothing about what was said. The transcript today is an in-memory `string[]` inside the Meet tab's content script (`src/content/captionBuffer.ts`): it is retrieved by one popup button, written straight to Downloads as a `.txt`, keyed to no recording, and destroyed when the tab closes. `RecordingPlaybackService.ts:44` hardcodes `transcriptStatus: 'none'` with the comment "No transcription pipeline exists yet, so the rail never renders today." There is no NLP, embedding or model-inference code anywhere in `src/`, and exactly one runtime dependency (`webm-duration-fix`).

We want a finished recording to be legible without reading it — a short list of what the conversation was actually about, timecoded so each entry seeks the player. `docs/plans/local-text-processing.md` is the canonical plan; this ADR records the decisions it rests on.

Four questions had to be answered before any code.

**1. Does this need a generative model?** The intuitive design puts a local LLM at the centre: feed it the transcript, ask what the meeting was about. That makes the feature's existence conditional on ~1.5 GB of weights, a WebGPU device, and seconds of autoregressive generation per query — and it makes the result non-deterministic and untestable.

**2. Where does the text come from?** Nothing persists a transcript. `docs/plans/portable-transcription.md` §B0 already specifies the segment seam, and §B1–B2 specify an audio-STT backbone behind it, but none of it is implemented. Topic analysis needs the seam; it does not need the backbone.

**3. Where does inference run?** WebLLM's own MV3 example runs WebGPU inside the extension service worker, and Chrome has supported that since 124. But an MV3 service worker is disposable — Chrome terminates it after inactivity — and a several-minute embedding pass over a three-hour transcript is exactly the kind of work that outlives one.

**4. Can this extension load a model at all?** No. `static/manifest.json` has no `content_security_policy` key, so the default MV3 policy applies and WebAssembly cannot instantiate. `webpack.config.js` has `experiments.asyncWebAssembly` off, no `.wasm` rule, and `resolve.extensions` of `['.ts', '.js']` — Transformers.js ships ESM `.mjs`.

## Decision

**1. A transcript is a persisted, timecoded aggregate keyed by `historyId` — not a string in a tab.** Implement `docs/plans/portable-transcription.md` §B0's contract at `src/shared/transcript.ts` (`TranscriptSource`, `TranscriptSegment`, `Transcript`) *plus* persistence: a `transcripts` store in the existing `recording-history` database, with a repository/service pair mirroring `RecordingNotationRepository` / `RecordingNotationService` layer for layer. Offsets are media-relative and pause-aware, identical to `RecordingNotation.tStartMs` semantics, so a transcript offset is directly a playback position. Populated from Meet captions only; this ADR takes no dependency on Plan B's PCM sidecar or STT work, and future sources append the same segment shape.

**2. Topics are a second derived aggregate over the transcript, never fields on the recording.** This is ADR-0005's stance applied one level up. ADR-0005 already names transcripts as the sibling case — "they are the same shape minus the speaker label" — and the same lifecycle argument holds: derived analysis has no row to attach to while a recording is still in flight, and an aggregate that can be recomputed or absent must not make a history row invalid.

**3. Conversation segments are temporal; topics are global.** A segment is one contiguous stretch of one subject; a topic gathers segments that need not be adjacent. A meeting that goes Berlin → Redis → Hiring → Redis → Berlin is five segments and three topics. Collapsing the two — the obvious single "topic per time range" model — cannot represent a subject that recurs, which is the normal shape of a real conversation.

**4. The pipeline is deterministic; a generative model is a deferred labelling layer.** Encode with a small multilingual embedding model, detect boundaries by cosine change, cluster online by centroid, rank by weighted vector arithmetic, label with c-TF-IDF. All five stages are pure functions over vectors, unit-testable against a stub encoder with no GPU, no model download and no network. A local LLM sits *above* this and is out of scope (see `docs/plans/local-text-processing.md` §12).

**5. Local inference runs in a dedicated Worker owned by the offscreen document, orchestrated by background.** Background stays the control plane and owns job state; the offscreen document is the data plane and outlives service-worker termination. Durability mirrors ADR-0004's upload jobs, because the failure mode is identical — long work in the data plane whose owner in the control plane can be killed at any moment:

- a per-job durable outbox in **IndexedDB** (`analysis-job-outbox`) — an offscreen document has no `chrome.storage` — replayed on reconnect;
- a completed result held in offscreen memory until background has **stored** it and acknowledged it, never merely sent it; on acknowledgement the durable row goes first;
- one definition of critical work — capture, uploads, and analysis including a held result — gating `closeForUpdate()`, `onUpdateAvailable`, the deferred reload, and the service-worker keep-alive;
- the history tombstone as the durable fence against a result arriving for a deleted recording.

*(As amended 2026-09-15 and 2026-09-17; the original wording is preserved under "Superseded text".)*

**6. Everything the engine needs is packaged; nothing is fetched.** Transformers.js, ONNX Runtime Web and its `.wasm` binaries, the tokenizer and configuration, and the quantized model graph all ship inside the extension and load from `chrome-extension://` resources, with `wasmPaths` pointed at them and remote model resolution disabled. There is therefore no weights origin, no host permission, and no model cache — the package *is* the cache, and ADR-0006's OPFS namespace is untouched. `content_security_policy.extension_pages` carries `'wasm-unsafe-eval'`, which is required for WebAssembly under MV3 and is store-review-visible. *(As amended by the 2026-09-12 artifact decision; the original wording is preserved under "Superseded text".)*

## Validation

This ADR rests on two platform assumptions. **Both must run and pass before anything is built on them**, and this ADR stays `Proposed` until they do. *(Historical: both ran; see "4A closed" and the 4B sections below. The ADR is `Accepted`.)*

1. **Packaged inference under MV3 CSP — RUN, PASSED.** See the 4A amendment below: both backends produce 384-dimension normalized vectors from packaged resources with all outbound HTTP(S) blocked. The weight-fetch half of this assumption was superseded before it ran — the artifact amendment packages the model instead.

2. **Embedding throughput at realistic scale — RUN, PASSED.** Embed a real three-hour transcript's worth of contextual windows at the production batch size of 32, with a realistic token-length distribution rather than repetitions of one short string. Records: load time, total embedding time, windows/sec, p50/p95 batch latency, the backend that ran, process RSS and JS heap, and the WebGPU-to-WASM delta. Q8 and FP16 are compared as **separate builds**, on package size, throughput, and embedding agreement on a multilingual sample.

**Exit criterion (conjunctive):** both spikes run and pass, *and* every open contract in `docs/plans/local-text-processing.md` §9 is frozen from spike 2's measurements into this ADR. Those values — window size and stride, the local-peak rule, the `longPause` threshold, the `speakerPatternChange` definition, the micro-cluster merge threshold and period, the definitions of `novelty` / `keyword_distinctiveness` / `recurrence`, the MMR lambda, the default dtype, the minimum segment length, and the throughput target — are deliberately not guessed now. The plan fixes every value its source payload fixed (`C_new = (n·C + x) / (n + 1)`, the 0.70/0.10/0.10/0.10 boundary blend, the 0.30/0.25/0.20/0.15/0.10 ranking, batch 32, 384 dimensions) and invents none that it did not. *(Current as of 2026-09-17. The payload's `> 0.82` was on this list until 4B showed it illustrative and inoperative for this encoder — plan D-16. MMR lambda has left the list of values to freeze, because nothing consumes it — D-20. The throughput target is frozen as a reference-machine floor.)*

## Alternatives considered

**BERTopic as specified — `embeddings → UMAP → HDBSCAN`.** Rejected. It is the right answer offline and the wrong one in a browser extension: both stages are global re-computations over the full embedding set, so every update re-does all prior work. Neither is necessary here. Online micro-clusters — a centroid, a count, a cosine test and an incremental mean — give the same grouping at effectively zero cost, and a periodic centroid-to-centroid merge sweep is 2,500 comparisons at 50 topics.

**LLM-first: WebLLM reads the transcript and writes to the database.** Rejected. It inverts cost and reliability. Feeding 15,000 tokens of a 90-minute meeting through a local 1–3B model to discover structure spends generation on work that vector arithmetic does deterministically and testably. The accepted inversion — a conversation database that a model *interprets*, rather than a model that produces the database — also leaves the accumulated embeddings reusable for retrieval later, which the LLM-first shape forfeits.

**WebGPU inference directly in the service worker.** Rejected. This is the literal shape of WebLLM's MV3 example, but the service worker is disposable mid-batch, and ADR-0001 keeps heavy and media work in the data plane. The offscreen document already hosts exactly this class of work through `opfsWorker` / `WorkerStorageTarget`, and Plan B §B2 independently reached the same placement.

**Host the analysis worker in the recordings page.** Rejected. It is where the user triggers analysis and the model would stay warm while the page is open, but the job dies with the tab, which means inventing a second resumability story instead of reusing the upload-job pattern that already survives service-worker death.

**Fetch weights from the HuggingFace or MLC CDN.** Rejected. It is the standard path and the models are public, but it adds a third-party origin to `host_permissions` and puts version pinning outside our control for a privacy-positioned feature.

**Cache weights in the OPFS `library/`.** Rejected. `library/` means retained user media under ADR-0006, with promotion, leases and reconciliation attached. Model bytes are a replaceable cache with none of those semantics, and putting them there would force an ADR-0006 amendment to say so.

**Block on Plan B's STT backbone.** Rejected. Universal transcript coverage is the better end state, but gating topic analysis behind an unstarted PCM-sidecar-plus-Whisper initiative delays it indefinitely. Decision 1 implements Plan B's seam without its backbone, so Plan B lands later underneath an unchanged pipeline.

**Continuous resummarization during recording.** Rejected. Worth recording because it is the intuitive design: regenerating a summary every 30 seconds is the single most wasteful cadence available. Deterministic state updates continuously; generation, when it eventually exists, fires only at meaningful transitions.

## Consequences

*Current as of 2026-09-17. The consequences as first written are preserved under "Superseded text".*

- The transcript stops being a tab-local artifact. `PlaybackManifest.transcriptStatus` is real, and the player shows topics from `PlaybackManifest.topics`.
- The `recording-history` database gains `transcripts` and `analyses` stores (v6); the upgrade stays presence-driven and idempotent. The analysis outbox is a separate small database, so background remains `recording-history`'s only writer.
- The extension gains a `content_security_policy` key for the first time. It is visible to store review and should be expected to draw a question about `'wasm-unsafe-eval'`.
- The package grows by the model and its runtime: ~118 MB of Q8 weights, ~16 MB of tokenizer, ~74 MB of ONNX Runtime WASM variants.
- `skipLibCheck: true` is a **requirement** of `@huggingface/transformers`, whose own declarations fail to type-check; type-checking remains a third of a ten-second build, so `transpileOnly` stays off.
- Captions are the only transcript source, so recordings without Meet captions have no topics — including every Russian and Ukrainian call, since Meet does not caption them usefully. The product needs Plan B for those; calibration does not.
- Discourse cues and signals cover English, Russian and Ukrainian. A language outside the list degrades the boundary blend to 0.70/0.10/0.10/0.00 rather than failing. Scripts without word spacing (CJK) produce useless c-TF-IDF labels, though their topics are still found.
- **Segment** embeddings and topic centroids are retained, not per-window embeddings: retrieval resolves topic → segment and re-embeds a segment's windows on demand. ARCH-08's reusable memory holds at segment grain, ~2.4 MB per three-hour recording.
- The backend that produced an analysis is recorded but not compared: WebGPU and WASM are indistinguishable in throughput on the reference machine, and their topic agreement near the calibrated thresholds is unmeasured.
- Nothing in this decision requires a GPU. Topic organization works on every hardware tier; only the sophistication of interpretation would change if a generative layer is added later.

## The wall-to-media projection is a span ledger (2026-09-11)

Decision 1 said transcript offsets are media-relative and pause-aware, "matching `RecordingNotation.tStartMs` semantics". Implementing it exposed that notations and transcripts need *different* readings of the same clock, and the difference is load-bearing.

A notation is stamped **now**, while the run is live, so `RecordingSession.currentRecordedMs()` — banked time plus the current running span — is all it ever needs. A transcript segment is placed **afterwards**, from a wall-clock instant remembered in another context. Three edges break the single-origin reading:

1. **The end-of-run sweep runs after the session is idle.** By then `runningSince` is cleared, so a single-origin projection answers `undefined` for *every* instant and the sweep stores nothing at all.
2. **Utterances spoken before a pause** belong to an earlier span, which the banked total has already absorbed.
3. **An utterance still in progress when a pause or stop lands** has no end inside the media.

So `RecordingSessionSnapshot` gains `recordedSpans: RecordedSpan[]` — every contiguous stretch of wall clock actually written into the file, each with the media offset it begins at. Projection walks it. Like `epoch`, the ledger is phase-independent: it survives the return to idle, because that is exactly when the sweep reads it, and is reset by the next `start()`. It is bounded by `MAX_RECORDED_SPANS`.

Three consequent rules:

- **Project from when words were spoken, not when they were delivered.** `CaptionUtterance` carries `startWallMs`/`endWallMs` — deliberately *not* `tStartMs`/`tEndMs`, which mean media-relative everywhere in this codebase. Mapping the commit instant instead would discard the final utterance of every call, which typically commits after the recorder stops.
- **Truncate, never clamp, and never invent.** An utterance whose start maps but whose end runs past its span is truncated to that span's real end; one whose *start* maps nowhere is dropped entirely.
- **Every push names its run.** Pushes carry the session's fencing token, so a message delayed across a stop/start boundary cannot be filed under the next run.

The arming gap in Decision 1 is closed properly rather than by the sweep: a content script that loads mid-run asks background whether it should be shipping and arms itself from the answer, and arming flushes whatever is already buffered. The end-of-run sweep remains, as reconciliation rather than as the recovery path. The armed tab is remembered by `RecordingTranscriptCapture` rather than read from the session at sweep time, because `markIdle` has already dropped `targetTabId` by then — the second defect this ledger work surfaced.

## A caption that straddles a pause (2026-09-11)

Truncating a range to its span's end is geometrically safe but not always semantically safe. Consider a caption observed from 09.0 to 14.0 with recording on 0–10s, paused 10–13s, and on again from 13s, whose final text is "we should deploy it tomorrow morning". Some of those words were spoken after the resume. Truncating `tEndMs` to 10s while keeping the whole text attributes post-resume speech to pre-pause media — and with no word-level timing there is nothing that says where the text divides.

**Decision: close the caption buffer at the pause boundary, and refuse anything that straddles one anyway.**

`RecordingController.setPaused(true)` drains the meeting tab after the pause succeeds, which makes the caption buffer commit whatever is still inside its grace window. The utterance therefore ends at the boundary and the next one begins after the resume, so ordinary span projection stays exact and no transcript-level splitting logic is needed. Resuming needs no counterpart: it opens a new span, and there is nothing to close.

**The stop is the same boundary as a pause, and gets the same treatment.** Meet also keeps refining a caption *after* the recorder stops: a caption whose final text reads "that's the answer and actually…" may have had its trailing clause spoken entirely after the cutoff. Truncating its timestamp to the end of the run does not make those words valid for the recording — it is the stop-equivalent of the pause problem. So `RecordingController.stop()` drains the tab immediately after `markStopping()`, which is where the run's last span closes and therefore where the cutoff is fixed. It is awaited, for the same reason the notes sidecar is: it must describe the run, not some moment after it.

The invariant is then explicit: **the final drain and sweep must not admit caption refinements representing speech first observed after the recording cutoff.**

`RecordingSession.recordedRangeAt` enforces it with one uniform rule: **a range whose end lies past its span is refused, whether the gap is a pause or the end of the run.** `endWallMs` is when the caption's text was last observed to *change*, so an end beyond the span means words arrived after the recorder stopped writing, and no word-level timing exists to say where the text divides. The caller drops the utterance and counts it in a warning.

Truncation was considered and rejected: there is nothing legitimate for it to do. An utterance that simply *committed* after the cutoff, having stopped changing before it, ends inside its span and maps whole — commit time is not part of the range at all. The only ranges that overrun are the ambiguous ones.

Draining at both boundaries makes refusal rare: it can only arise when a drain does not land, such as a closed tab or a caption that changed in the gap before the message arrived. That is what makes dropping an acceptable answer rather than a routine loss.

**Known artifact, accepted.** Meet owns the caption object and keeps refining it, so a flush mid-sentence can leave the post-resume caption carrying the full sentence including words already committed before the pause. The result is duplicated text across the boundary.

State the guarantee precisely, because it is weaker than it first sounds: such a segment remains **correctly temporally anchored to recorded media** — its `tStartMs`/`tEndMs` bound a stretch of the file that genuinely exists — but **its text may carry a duplicated prefix that was spoken in the preceding recorded span**. A segment's timecodes are not a word-level alignment, and nothing downstream may assume they are. That distinction matters for topic analysis: boundary detection and importance scoring may treat a segment's offsets as the location of its *segment*, never as the location of any particular word inside it.

Recovering the difference would mean prefix-stripping raw caption text against a normalized comparison, and the index arithmetic between the two is exactly the kind of text surgery that produces silent corruption. A visible, bounded duplication is safer than a heuristic that can quietly delete real words. Not worth it for one utterance per mid-sentence pause.

## Embedding artifacts are extension-owned (2026-09-12)

Decision 6 said engine code ships packaged while weights are fetched as data from a self-hosted origin. That split is wrong, and it is wrong for a policy reason rather than an engineering one.

**Decision: embedding artifacts are extension-owned for v1.** All executable runtime artifacts, tokenizer and configuration, the model graph, and the quantized weights ship in the extension package and are loaded from `chrome-extension://` resources. Analysis performs no network fetch. If packaged model size becomes unacceptable, a later ADR may externalize cryptographically pinned raw tensor data only; remotely supplied executable model graphs or runtime code are out of scope.

```text
EXTENSION PACKAGE                    NETWORK
├── Transformers.js runtime          └── nothing required for analysis
├── ONNX Runtime / required WASM
├── tokenizer + config
├── quantized embedding model
└── analysisWorker.js
```

**Why this supersedes the fetch-weights plan.** Chrome permits remote *data* but requires extension logic to be self-contained, and explicitly names interpreting remotely fetched material as logic a potential violation. An ONNX file is not an array of floats: it normally carries the computational graph too. Fetching a model from a CDN — ours or anyone's — and then executing that graph is materially less clear under Web Store policy than fetching passive data. Self-hosting the origin does not change that, because the question is what the artifact *is*, not who served it.

**It also fits this codebase better than the alternative.** `webpack.config.js` already has the precedent for a dedicated worker entry (`opfsWorker`) and for copying static assets, so `analysisWorker` plus a model asset directory follows the existing build model rather than inventing a second one. The manifest currently declares no model host permission and no custom CSP, and `unlimitedStorage` is already granted. And there is no ML runtime in `package.json` yet, so the spike establishes the requirements cleanly instead of unwinding an integration built on a different assumption.

**Consequences.**

- `BLD-02` (self-hosted origin) and `BLD-03` (host permission via a build-time define) are superseded. No model host permission is added, and `scripts/check-production-build.mjs` gains no weights-origin check.
- The Cache-API and OPFS model cache is superseded with them: a packaged resource needs no cache, no download progress, and no first-install transfer. `STO-01`, `STO-02` and `STO-03` go with it.
- `PRIV-01` strengthens from "no user content leaves the device" to "analysis makes no network request at all".
- The package grows by the size of a quantized `multilingual-e5-small` plus the ONNX Runtime WASM. Measuring that, and the `ts-loader` build-time cost, is part of the spike rather than an assumption.

**CSP is proven, not presumed.** Transformers.js and ONNX Runtime commonly need their packaged WASM to be executable, which under MV3 means `'wasm-unsafe-eval'` in `content_security_policy.extension_pages`. That allowance is **not** to be added speculatively. The spike runs the smallest real embedding worker in a production build and adds only what that run demonstrates is required — and if it turns out not to be required, the manifest keeps its current absence of a custom CSP, which is the better outcome for store review.

## 4A platform spike — RUN, PASSED (2026-09-12)

`tests/e2e/analysis-embedding.spec.ts`, against a built extension loaded unpacked, with **every http(s) request aborted** for the duration.

The no-network claim rests on two independent things, because either alone is weak. `allowRemoteModels = false` with `localModelPath` and `wasmPaths` pointed at `chrome-extension://` resources proves Transformers.js will not *fall back* to a remote model; it proves nothing about what any dependency might fetch. Aborting all outbound http(s) and still getting vectors closes that gap. Both hold.

| | requested `webgpu` | requested `wasm` |
| --- | --- | --- |
| backend that ran | **webgpu** | **wasm** |
| model load | 3,439 ms | 1,474 ms |
| embed, 2 sentences | 326 ms | 78 ms |
| network requests | 0 | 0 |

Vectors are 384-dimension, finite, L2-normalized to within 1e-3, distinct for distinct inputs, and reproducible across worker instances. The worker *reports* which backend ran rather than leaving it to be inferred from timing.

WASM beating WebGPU at two sentences is expected — per-call GPU overhead has nothing to amortize over — and is exactly why the throughput target must be measured at the 300–800-window scale rather than extrapolated from this run.

**Three integration facts this established, none of which were guessable.**

1. **The worker needs worker-native chunk loading.** webpack's `web` target derives its public path from `document.currentScript` and loads chunks by injecting `<script>`; a worker has no `document`, and the bundle threw `ReferenceError: document is not defined` at module scope. Fixed with an explicit `output.publicPath: '/'` — in an extension that is the package root — and `chunkLoading: 'import-scripts'` on the `analysisWorker` entry. `opfsWorker` never hit this because it has no async chunks; `@huggingface/transformers` splits its ONNX backends into them.
2. **ORT's WASM variant cannot be inferred from its file names.** An earlier attempt packaged only `jsep` (WebGPU) and the plain build, reasoning they were RES-06's two rungs. ORT then requested `ort-wasm-simd-threaded.asyncify.mjs` and failed with "no available backend found". All four variants now ship; which are genuinely reachable is a measurement to make against a working build, not an inference from names.
3. **The `import.meta` build warning is harmless on this path.** `transformers.web.js` does `Object(import.meta).url` for a base URL we override anyway. The module evaluates and produces embeddings, which is the only evidence that settles it — and is why this was left to the run rather than to speculative webpack surgery.

**Package cost, measured.** 228 MB unpacked; **104.6 MB as the release ZIP**, which is what the store receives. `dist/models` 129 MB (113 MB Q8 ONNX + 17 MB tokenizer), `dist/ort` 90 MB across four WASM variants. Trimming ORT is the obvious first reduction, and it is now a measurement rather than a guess.

**Threading.** `numThreads = 1`. Threaded ORT needs `SharedArrayBuffer` and therefore cross-origin isolation, which an extension *can* opt into with `cross_origin_embedder_policy` / `cross_origin_opener_policy`. This extension does not, so the WASM fallback is single-threaded by choice. If WASM throughput proves unacceptable at scale, COOP/COEP is its own spike rather than a rider on this one.

**Still open for 4A:** throughput, peak memory and the WebGPU/WASM delta at the 300–800-window workload; the default packaged dtype (Q8 vs FP16); and which ORT variants can be dropped. ADR-0007 stays `Proposed` until those are recorded here. *(Historical: all recorded below. Q8 was chosen, all four ORT variants ship, and the WebGPU/WASM delta turned out to be no delta at all on the reference machine.)*

## 4A throughput at realistic scale — RUN (2026-09-12)

`tests/e2e/analysis-embedding-bench.spec.ts`, 800 windows (EMB-06's upper reference for three hours) at batch 32 (EMB-07), Q8, over a corpus with a realistic length spread — mean 31.3 words per window, p50 37, p90 59, max 74, including short backchannels and non-English text. Model loaded once; batches timed individually. Apple Silicon, headless Chromium.

| | WebGPU | WASM |
| --- | --- | --- |
| adapter | `apple / metal-3` | — |
| model load | 2,431 ms | 1,548 ms |
| total, 800 windows | 180,659 ms | 183,908 ms |
| throughput | 4.4 windows/sec | 4.4 windows/sec |
| batch latency p50 | 7,082 ms | 7,564 ms |
| batch latency p95 | 8,323 ms | 8,102 ms |
| browser RSS delta | ~64 MB | noise (−82 MB) |

**Corrected 2026-09-12 — read with the dtype comparison below: the limitation is Q8's, not WebGPU's. FP16 on the same adapter runs 21× faster.**

**WebGPU delivers no measurable speedup over single-threaded WASM here, on real hardware.** The adapter is a genuine Metal 3 device, not a software fallback, so this is not a headless artifact. Three readings, and the benchmark cannot distinguish them: the Q8 graph's integer operators may not be accelerated and are emulated or dequantized per-op; ORT's JSEP path may be falling back operator-by-operator while still reporting `webgpu`; or per-call overhead dominates at this model size. FP16 is the dtype Hugging Face documents for WebGPU, which makes the Q8-vs-FP16 comparison the next measurement rather than an optional one.

**Absolute cost.** Three hours of conversation takes ~3 minutes to embed. That is acceptable for post-hoc analysis, which is what D-01 scoped this to, and it would not be acceptable for the live-arrival variant deferred in §12 — worth recording before anyone reconsiders that deferral.

**Memory.** JS heap is 4–7 MB and meaningless here: the work is in the worker's WASM linear memory and ORT's native allocations. Browser-tree RSS moves ~64 MB on the WebGPU run and is pure noise on the WASM one, so it is a weak floor rather than a measurement. **GPU allocation is not captured by either number** — no API available in this context exposes it. An earlier version of this benchmark matched processes by name and reported 10 GB, having swept in every unrelated Chrome on the machine; it now matches the harness's throwaway `--user-data-dir`.

**Still open for 4A:** Q8 vs FP16 as separate builds (package size, throughput, and embedding agreement on a multilingual sample); whether any ORT variant can be dropped; and the resulting frozen dtype and throughput target.

## 4A dtype comparison, Q8 vs FP16 — RUN (2026-09-12)

Measured as **separate builds**, each packaging exactly one ONNX export (`ANALYSIS_DTYPE` selects it; the fetcher verifies only that export, and webpack copies only that one).

| | Q8 | FP16 |
| --- | --- | --- |
| release ZIP | **104.6 MB** | **233.9 MB** |
| unpacked | 228 MB | 340 MB |
| loads on WebGPU | yes | yes |
| loads on WASM | yes | **no — fails at session creation** |
| throughput, WebGPU | 4.4 windows/sec | **92.6 windows/sec** |
| throughput, WASM | 4.4 windows/sec | n/a |
| 800 windows (≈3 h) | 181 s | **8.6 s** |
| batch p50 / p95, WebGPU | 7,082 / 8,323 ms | 338 / 526 ms |
| browser RSS delta | ~64 MB | ~449 MB |

**FP16 on WebGPU is 21× faster than Q8 on WebGPU, on the same adapter.** This corrects the reading of the throughput section above: WebGPU was not failing to accelerate — it was failing to accelerate *Q8*, whose integer operators evidently get emulated. With the dtype it is documented for, the GPU path is exactly the step change the architecture assumed.

**FP16 does not run on WASM at all.** Not slowly — it fails at session creation:

```
Can't create a session. ERROR_CODE: 1
graph_utils.cc:30 GetIndexFromName … itr != node_args.end() was false
Attempting to get index by a name which does not exist:
InsertedPrecisionFreeCast_/encoder/layer.11/output/LayerNorm/Constant_output_0
```

An ORT graph-fusion pass on the CPU provider referencing a node arg the FP16 export does not carry. So **packaging FP16 alone would leave every machine without WebGPU with no embedding path whatsoever**, which contradicts RES-08 — topic organization must keep working on all tiers.

**The two dtypes do not produce the same vectors.** Sampled on the *same* backend, so this isolates quantization from device: per-sentence cosine agreement min 0.9907, p10 0.9919, mean 0.9944; top-5 nearest-neighbour overlap min 0.60, p10 0.80, **mean 0.85**. The cosines look reassuring and the neighbour overlap is the number that matters: roughly one in seven neighbour relationships reorders, and neighbour order is precisely what clustering consumes. The least-agreeing items are short backchannels and single sentences whose neighbours are genuinely close together — where small drift reorders a tie.

**Consequence for sequencing: the dtype must be frozen before 4B, not after.** Calibrating `mergeThreshold`, the peak rule and MMR lambda against one dtype's neighbour structure and then shipping the other would invalidate the calibration. `AnalysisProvenance.embeddingDtype` already makes stored results distinguishable across such a change (D-14), but calibration effort is not recoverable that way.

**Three options, and the choice is a product decision rather than a technical one.**

- **Q8 only.** 104.6 MB, works on every tier, ~3 minutes for a three-hour recording. Simplest: one dtype, one calibration, RES-08 satisfied trivially.
- **FP16 only.** Rejected — no WASM tier at all, contradicting RES-08.
- **Both.** ~338 MB ZIP, FP16 on WebGPU and Q8 on WASM. This is literally RES-07's tier table, and the per-tier capability difference it anticipates. Costs a doubled package and two calibrations, since the tiers would produce different neighbour structures.

**Still open for 4A:** the dtype decision above, and whether any ORT variant can be dropped.

## 4A closed — frozen values (2026-09-12)

**Packaged dtype: Q8.** FP16's 21× WebGPU speedup is real and tempting, but it does not load on WASM at all, so FP16-only contradicts RES-08 and shipping both doubles the package *and* forces two calibrations against two different neighbour structures. Analysis is post-hoc background work under D-01, where ~3 minutes for a three-hour recording is affordable; one dtype and one calibration are worth more than 170 seconds saved on a job nobody is watching.

Reversible by design rather than by luck: `AnalysisProvenance.embeddingDtype` already makes results computed under one dtype distinguishable from the other (D-14), and `ANALYSIS_DTYPE` builds either. The cost of revisiting is re-running 4B, not re-architecting.

**The deciding assumption, stated so it can be challenged:** topics are computed when a recording *stops*, not when someone *opens* it. If that inverts — if a user opens a three-hour recording and waits for analysis — three minutes of spinner is not affordable and this decision should be reopened in favour of FP16-on-WebGPU with a Q8 WASM fallback.

**Throughput baseline: 4.4 windows/sec** (Q8, 800 windows, batch 32, Apple Silicon, WebGPU and WASM alike), which is 181 s for EMB-06's three-hour reference. Recorded as a *baseline*, not yet as a regression gate: a gate needs run-to-run variance, and these are single runs. Establishing that variance is a step-9 hardening task, not a 4A blocker.

**ONNX Runtime variants: all four ship.** Measured: `asyncify` + `jsep` alone passes the runtime proof on both backends, which would save 26.2 MB. Not adopted. ORT selects its variant from *detected features*, and this was measured on one machine and one Chromium — a browser with JS Promise Integration available could select `jspi`, and the earlier failure in this ADR is exactly what inferring this set from names costs. `ORT_VARIANTS` exists so the trim can be re-measured across real targets; until it is, 26.2 MB is cheaper than a tier that cannot embed.

**Final package: 104.6 MB release ZIP**, 228 MB unpacked.

**Resolved §9 platform contracts:** dtype → `q8`; throughput → baseline above; `'wasm-unsafe-eval'` → required and declared (closed, not open); ORT variant set → all four, pending multi-target measurement.

4A is complete. 4B — semantic calibration of the remaining §9 values against conversations with known boundaries and known recurrence — has not run, and is now unblocked by a frozen encoder.

## 4B calibration, first pass — two findings, one blocking (2026-09-12)

Method: five synthetic meetings with known topic blocks and deliberate recurrence (`tests/e2e/helpers/calibrationCorpus.ts`), embedded once with the frozen Q8 encoder (`analysis-calibration-dump.spec.ts`), then 8,100 configurations scored offline against ground truth (`scripts/calibrate-analysis.ts`). Boundary F1 allows ±1 window of slack; clustering is scored pairwise, so a pipeline that never reunites a recurring subject scores badly however clean its boundaries are.

**Stated limit of this corpus.** Generated topics are lexically cleaner than real ones, so values tuned here run confident and will likely need loosening against real transcripts. It is a starting region, not a final answer.

### Finding 1 — windows must be disjoint. Fixed.

Boundary F1 rose from **0.767 to 0.892** by changing nothing but the window stride.

SEG-02 compares "the previous 3–5 utterances" with "the next 3–5" — two spans that share nothing. This implementation had unified the boundary-comparison span with the contextual embedding window and then given it a stride shorter than its size, so neighbouring windows overlapped. A window straddling a boundary shared most of its content with both sides, and the change signal was smeared away. Measured on the overlapping shape, adjacent windows *within* a topic sat at cosine p50 0.954 and adjacent windows *across a true boundary* at 0.946 — a difference of 0.008, which is no signal at all.

The first calibration grid contained no disjoint shape, so it measured only degrees of smearing. Best shape is now **4 utterances, stride 4**.

### Finding 2 — CLU-04's 0.82 assignment threshold is inoperative for this encoder. Blocking.

Segment-centroid cosines, measured on the best shape against ground truth:

| | min | p25 | p50 | p75 | max |
| --- | --- | --- | --- | --- | --- |
| same true topic | 0.885 | 0.924 | 0.950 | 0.953 | 0.969 |
| **different** true topic | **0.861** | 0.877 | 0.898 | 0.914 | 0.933 |

**Every genuinely different topic pair scores above 0.82 — 27 of 27.** The lowest is 0.861. So "join the current cluster when `cosine > 0.82`" evaluates to "always join": every meeting collapses to a single cluster, and the merge sweep has nothing left to do. That is why the merge threshold showed *no* effect across 8,100 configurations — it was never reached.

This is not a tuning miss. `multilingual-e5-small` compresses cosine into a narrow high band, as E5-family models do; an absolute threshold chosen without reference to a specific encoder cannot land in it. The usable separation for this encoder is around **0.92**, where the two distributions cross.

**Why this is not being changed here.** CLU-04 is recorded in the plan's ledger as an exact contract — "Threshold **0.82** is the stated value" — and the `lossless-plan-evolution` discipline forbids amending an exact contract without authorization. The source payload is genuinely ambiguous on the point: 0.82 appears inside an illustrative passage ("Imagine the current topic has … number of segments = 14", "If: `s > 0.82` for example"), and this plan's own first ledger draft called it "the stated example value" before a later edit tightened it. Whether it was ever intended as a frozen contract is the author's to say.

Clustering calibration is blocked until it is resolved. Boundary detection is not, and its values are ready to freeze.

## 4B calibration, second pass — CLU-04 amended, candidates chosen (2026-09-12)

The assignment threshold moved into `ClusterConfig` on the author's authorization (plan D-16) and was searched jointly with the merge threshold across 40,500 configurations. **Cluster F1 rose from 0.585 — flat across every configuration, because the merge stage was unreachable — to 0.749.**

Best: **4 utterances / stride 4, peak neighbourhood 2, prominence 0.05, `minSegmentMs` 15 s, assignment 0.93, merge 0.95, merge period 12.** Boundary F1 0.892, cluster F1 0.749 (precision 0.718, recall 0.796), and the produced cluster count matches ground truth exactly (2.8 vs 2.8 per meeting).

**The operating curve, since precision was the thing to watch:**

| assignment | merge | cluster F1 | precision | recall | clusters / true |
| --- | --- | --- | --- | --- | --- |
| 0.91 | 0.95 | 0.706 | 0.602 | 0.951 | 2.0 / 2.8 |
| **0.93** | **0.95** | **0.749** | 0.718 | 0.796 | **2.8 / 2.8** |
| 0.95 | 0.95 | 0.696 | 0.726 | 0.675 | 3.2 / 2.8 |
| 0.97 | 0.95 | 0.696 | 0.726 | 0.675 | 3.2 / 2.8 |

Raising assignment past 0.95 changes nothing: same-topic segment centroids top out at 0.969, so beyond that everything splits on contact and the merge sweep does all the work. The prefer-over-splitting rule was applied and did **not** select 0.95 here — it breaks *near-ties*, and 0.749 against 0.696 is not a tie. At 0.93 the pipeline still leans slightly toward joining (recall above precision), which is the direction worth watching on real data.

**`longPauseMs` has no measured effect.** 3 s, 5 s and 8 s produce identical results everywhere in the grid. Either the synthetic corpus's pauses are not discriminative or the 0.10 weight cannot move a peak on its own. Not resolved; carried as a candidate at 3 s with the caveat attached.

**MMR lambda is not calibrated.** The harness scores boundaries and clustering only; the importance stage has no ground truth in this corpus. It remains open.

### What this corpus does and does not establish

**Established.** Overlapping boundary contexts are wrong for this implementation; 0.82 is unusable with this encoder; the merge stage was previously unreachable; and the mechanics of recurrence and short-topic handling work.

**Suggested only.** Every value below is a *candidate default*, not a frozen contract. Synthetic topic blocks underrepresent interruptions, weak transitions, callbacks, mixed-topic turns and vocabulary overlap — exactly the cases that decide a threshold. Real dialogue will most likely require loosening rather than tightening.

| | status |
| --- | --- |
| 4 utterances / stride 4 | strong structural result |
| assignment 0.82 rejected | definitive for this encoder |
| peak neighbourhood 2, prominence 0.05 | candidate default |
| `longPauseMs` 3,000 | candidate default, no measured effect |
| `minSegmentMs` 15,000 | candidate default |
| assignment 0.93, merge 0.95, period 12 | candidate region |
| MMR lambda | not calibrated |

### On the boundary-context invariant

Stated precisely, because the loose version would be wrong: **the two semantic contexts compared across one candidate boundary must not share utterances.** That is what SEG-02's "previous 3–5" versus "next 3–5" describes. It is *not* a rule that contextual windows must always be disjoint.

Using 4-utterance blocks at stride 4 for both segmentation and clustering satisfies it by construction and is a reasonable v1 simplification, with one consequence worth recording: **boundary resolution is quantized to those block boundaries.** A later higher-resolution detector — sliding a disjoint pair of contexts across every utterance position — remains open and is not prohibited by this result.

**Next:** validate the candidate configuration against a small set of hand-labelled real conversations before any of it is called frozen.

## Amendment, 2026-09-15 — hardening measurements

Step 9 of the plan. Four things were measured rather than assumed.

### The package carried 16 MB nothing could load

`dist/ort` was 90 MB. Only **73 MB** of that is the four `ort-wasm-simd-threaded.*.wasm` variants; the rest was ONNX Runtime's own package entry points — `ort.all.mjs`, `ort.webgl.mjs`, `ort.mjs` and a dozen more — copied because the CopyPlugin filter admitted every `.wasm` and `.mjs` unless `ORT_VARIANTS` was set.

Those are **build-time** imports. Webpack has already inlined the one the worker imports into `analysisWorker.js`, and `wasmPaths` only ever resolves `ort-wasm-simd-threaded[.variant].{wasm,mjs}`. Verified directly: the built worker contains zero references to any `ort.*.mjs` filename, and constructs only `ort-wasm-simd-threaded.*` names.

The filter now requires that prefix always. Package: **229 MB → 213 MB**, `dist/ort` 90 MB → 74 MB.

**This is not the variant trim, which stays declined.** All four `.wasm` variants still ship. Dropping `jspi` and the base build would save a further ~26 MB and was measured sufficient *on one machine* — not enough evidence to risk a tier we cannot see. The 16 MB removed here is provably unreachable, which is a different claim.

**RUN, PASSED.** `tests/e2e/analysis-embedding.spec.ts` against the trimmed build: WebGPU load 2,621 ms / embed 174 ms; WASM load 1,346 ms / embed 72 ms; identical vectors for identical input; all outbound HTTP(S) blocked throughout.

### Build cost (plan §7's open risk)

| | wall | CPU |
| --- | --- | --- |
| `tsc --noEmit` (`skipLibCheck: true`) | 3.7 s | 7.4 s |
| `tsc --noEmit --skipLibCheck false` | 5.6 s | 12.1 s, **and fails** |
| full `webpack --mode=development`, cold | 10.3 s | 16.4 s |
| same, warm | 10.8 s | 16.6 s |

Not material: type-checking is roughly a third of a build that takes ten seconds, so `transpileOnly` buys nothing worth the loss of checking. **§7's risk is closed.**

The second row is the more important result. Without `skipLibCheck` the build does not merely slow down, it *fails* — inside `@huggingface/transformers`' own `.d.ts`, on a tuple mismatch in code we do not own. So `skipLibCheck: true` is a **requirement** of this dependency, not a speed optimization, and it remains scoped to declaration files: our own code and our use of those declarations stay fully checked.

### Quota

An analysis that cannot be stored is now **discarded and acknowledged**, not retried forever. `QuotaExceededError` (and Firefox's `NS_ERROR_DOM_QUOTA_REACHED`) is distinguished from a transient failure, which still holds the acknowledgement so the data plane re-offers the result on reconnect.

Affordable only because an analysis is *derived*: the transcript survives, so the recording reads as un-analysed and can be run again once space exists. Holding would pin megabytes of vectors in the offscreen document for the session and re-offer them on every reconnect. Upload bytes are never dropped this way, which is the distinction ADR-0004 turns on.

### Multilingual

The pipeline runs end to end over Russian and Ukrainian transcripts and labels its topics in the language spoken. Tokenization is Unicode-aware, the Cyrillic word boundary holds (`кстатиь` does not match the cue `кстати`), c-TF-IDF drops a ubiquitous term in Cyrillic as in English, and a language outside the cue list degrades to a `0.70/0.10/0.10/0.00` blend rather than failing.

**One limitation found and not fixed.** `tokenize` splits on non-letter/non-number, so a script without spaces — Japanese, Chinese — collapses to a single term and c-TF-IDF labels become useless. Embeddings are unaffected, so topics are still found, segmented and seekable; only their *names* degrade. A segmenter is the fix and is out of scope.

**Still outstanding:** all of this uses a stub encoder over synthetic transcripts. The real-conversation validation the 4B section asks for is still blocked on a transcript of an actual Russian or Ukrainian call, which Meet captions cannot produce.

### Throughput variance, and a claim we had to withdraw

Four runs, Apple Metal-3, Q8, 800 windows at batch 32 — EMB-06's upper reference for a three-hour conversation:

| run | webgpu w/s | wasm w/s |
| --- | --- | --- |
| 1 | 5.4 | 5.6 |
| 2 | 5.4 | 5.2 |
| 3 | 5.3 | 4.9 |
| 4 | 5.2 | 5.1 |
| **mean** | **5.33** | **5.20** |

Plan §9's last open contract is closed with a **3.5 windows/sec regression floor**, asserted in the bench. Deliberately a tripwire rather than a target: ~30% below the slowest observation, so it catches a lost SIMD path, an accidental batch-size change or a dtype swap, while tolerating a loaded machine. A floor set at the observed value would flake on the first busy afternoon and get deleted, which is worse than no floor.

A three-hour recording therefore analyses in **about two and a half minutes**, which comfortably justifies the deferred trigger: nobody waits on it.

Worth noting rather than quietly overwriting: 4A froze a **4.4 windows/sec** baseline, and every run here beat it by roughly 20%. Nothing in the packaged runtime changed that would explain a speed-up — the 16 MB removed above was never loaded — so the likeliest explanation is machine state during the original run. The frozen baseline stands as the recorded 4A result; the floor is set below both.

**The claim we withdrew.** `EmbeddingWorkerClient` warned that a WASM fallback "will be slower". On this hardware that is false — the two backends sit inside each other's variance, and WebGPU is the *slower* of the two to load (≈2.3 s against ≈1.4 s). Q8 quantized operators appear not to benefit from ORT's WebGPU backend the way an FP16 model would.

The warning now reports which backend ran and promises nothing about speed. The ladder itself is unchanged: this is one GPU family, and a discrete GPU may well behave differently — which is exactly why the honest thing is to report what happened rather than predict what it means.

RES-08's claim holds and is now measured: **topic organization works on every tier**, and on this one the tiers are indistinguishable.

### Durability, proven against a real service worker

**RUN, PASSED** — `tests/e2e/analysis-durability.spec.ts`, three consecutive runs (~40 s each).

A recording is started, ~400 utterances are seeded through `TRANSCRIPT_UTTERANCES` (the content script's own channel, in one batch rather than four hundred caption grace windows), the recording is stopped so analysis queues, and the MV3 service worker is killed via CDP `ServiceWorker.stopAllWorkers` while ~100 windows are still embedding. The analysis then appears on the playback manifest without a second run, and no `analysisJobState:` key is left behind.

**The two guards matter more than the assertion.** A durability test that kills nothing, or kills something after the work already finished, passes just as green as a real one:

1. *Was it in flight?* The manifest is asserted to carry **no** topics immediately before the kill. The first draft of this test would have passed without it.
2. *Did it actually die?* `Target.getTargets` is polled until no `service_worker` target remains. The obvious choice — Playwright's `context.on('serviceworker')` — is **wrong here**: Chrome reuses the same target id when an extension worker restarts, so the event never fires a second time. That guard reported zero restarts on a run where the worker had genuinely been terminated and had come back, which is exactly the false negative worth recording.

What this does not cover: an extension update arriving mid-analysis. `closeForUpdate()`'s refusal is unit-tested from both directions in `OffscreenManager.test.ts`; there is no harness seam for driving a real update, and inventing one for a single assertion was not worth it.


## Amendment, 2026-09-15 — review findings

An external review of the branch found eight defects. All are fixed; three were durability bugs that the existing tests could not have caught, and two were semantic errors in the pipeline itself.

### The result was released before it was safe (P0)

`AnalysisManager.redeliver()` deleted a held result as soon as `deliver()` resolved. In production `deliver()` is a `postMessage`: it resolves when the message *left*, which says nothing about whether the background persisted anything. The interval between delivery and persistence was therefore unprotected — a control plane that died in it, or an IndexedDB write that failed transiently, lost the only copy while the durable state row still claimed a completed analysis.

`acknowledge()` is now the single release point, and it is called only once the row is on disk (or is known to be unstorable). The durability E2E did not catch this because it kills the worker *during embedding*, not in the much narrower post-computation window.

### Terminal failures leaked outbox rows forever (P0)

The outbox is drained by acknowledgement and by nothing else, but only `completed` reached an acknowledgement — through `handleResult`. `failed`, `canceled` and `unsupported` passed through `handleJobState`, which acknowledged nothing, so their `analysisJobState:` keys were replayed on every reconnect for the life of the profile. Those three are now acknowledged immediately; only `completed` waits.

### An update could tear down a completed-but-unsaved analysis (P0)

`OffscreenManager` cleared its busy flag on any terminal state, and `AnalysisManager.hasActiveJobs()` ignored held results. Since `completed` is reported *before* delivery and persistence, `closeForUpdate()` could permit an update while the only copy of an analysis was still in offscreen memory. Busy now means "queued, running, **or holding an unacknowledged result**", on both sides.

### Topic importance ranked against the wrong vector (P0/P1)

`topicImportance` ranked passages against `segments[0].embedding` rather than the cluster centroid IMP-02 requires — scoring a topic by how much it resembles its own opening. It is worst exactly where global topics earn their keep: for a recurrent subject, the later stretches were penalised for differing from the first, which is the thing a centroid exists to average away.

Pinned by an **order-independence** test, which took three attempts to make discriminating. Symmetric fixtures pass with the bug present, because the mean similarity to either endpoint of a two-stretch topic is identical; the working fixture needs stretches that are both **unequal in size** and far enough apart to move the 0.30 term. With the bug it reads 0.5168 one way and 0.4817 the other.

### The tail window reintroduced the overlap 4B had just eliminated (P1)

The trailing window was anchored at `length - windowUtterances`, so any remainder shorter than a window overlapped its predecessor. At the calibrated 4/4 over ten turns: `[0,4) [4,8) [6,10)` — two shared utterances between the last pair, which is precisely the smearing that cost the earlier build its boundary signal. The tail now covers exactly the remainder and is short when the remainder is. A regression test asserts disjointness and gaplessness at every remainder from 1 to 40 turns.

### Provenance described the wrong moment (P1)

`save()` stamped `currentProvenance()` at persistence time. Provenance is supposed to describe the run that produced the vectors; the two coincide only while nothing changes mid-run, which is exactly when staleness stops mattering. Provenance is now captured at **enqueue**, carried with the job, and persisted as-is. A job whose carried provenance is lost to a worker restart falls back to current conditions — the same guess the old code always made.

### Deleting a recording leaked its analysis (P1)

The removal callback dropped notations and transcripts but not analyses, which are the largest rows in the database. `purge()` now marks the recording, cancels a run still in flight, and removes what is stored; a result that arrives afterwards is acknowledged and discarded rather than written, because a row for a deleted recording would never be cleaned up again.

### Two claims withdrawn

The fallback warning said the other backend "produces the same topics". Unverified: the backends agree on vectors to within floating-point noise, but 0.93 and 0.95 are *decision boundaries*, and a pair sitting within noise of one can land on either side and change the partition. It now reports the backend and promises nothing. Making that promise needs a WebGPU-vs-WASM agreement run over the calibration corpus.

The 3.5 windows/sec floor is reframed as a **reference-machine tripwire**, explicitly not a statement about supported hardware. An older laptop at 2 windows/sec is slow, not broken — analysis is a background job nobody waits on, and RES-08 claims topic organization works on every tier, not that it works at a given speed.

### And one correction to our own sequencing

We had said real 4B calibration was blocked on Plan B's STT. That was wrong, and conflated two things. The *product* needs STT for Russian and Ukrainian recordings. **Calibration needs only real conversational text with hand-labelled boundaries** — obtainable from any offline transcription tool, converted to fixture `TranscriptSegment[]`, embedded once with the packaged Q8 encoder and replayed through the same offline grid. Plan B is a product decision, not a calibration prerequisite.

## Amendment, 2026-09-17 — second review, and a platform fact we had wrong

### An offscreen document has no `chrome.storage`

Measured with CDP against the built extension: the offscreen document's `chrome` object has exactly `csi`, `loadTimes` and `runtime`. **The analysis outbox had never stored anything.** Every `put` threw and was caught as a warning, so HOST-03's durability existed only on paper — and the first durability E2E's "no outbox rows left behind" check passed because there never were any.

It surfaced only because this round's own fix made it visible. Removing the durable row before releasing the held result is correct, but against a store that always throws it meant the result was **never** released, so every later update would have been refused indefinitely. The new post-completion E2E caught that before it shipped.

The outbox now lives in IndexedDB, which belongs to the extension origin and is shared by the offscreen document, the service worker and extension pages. **`UploadJobStateOutbox` (ADR-0004, already on `main`) has the same defect**, as does anything else in the offscreen document that assumes `chrome.storage`; that is outside this ADR and is recorded here so it is not lost.

### The lifecycle corrections

- **Every reload path now honours analysis.** `onUpdateAvailable` and the deferred reload checked only capture and uploads, so an idle session reloaded straight over a running analysis. All of them now read one definition of critical work, a deferred reload is re-evaluated when analysis settles (which changes nothing in `RecordingSession`), and before applying an update the data plane is asked directly — background's own view is empty after a restart. The worker is kept alive during analysis too: Chrome installs a pending update by itself when the service worker unloads.
- **`completed` holds the recording** until its result is stored or discarded, so a second run cannot start while the first result is still in flight.
- **The deletion fence is the tombstone**, not service-worker memory. An absent history row is deliberately *not* treated as deleted: analysis is queued at `markStopping`, before finalize creates the row, so a short recording's result can legitimately arrive first.
- **A result lost with its offscreen document is re-run.** A `completed` row replayed with nothing behind it is reported as a lost result instead of leaving background waiting for it forever.
- **Provenance travels with the job** and returns with the result, with the backend stamped on as a diagnostic that staleness does not compare.
- **`PIPELINE_VERSION` is 2**, for the tail-window and centroid corrections, which changed outputs without changing a threshold.
- **A discarded run is not swept or analysed.** Found while tracing the fence: discard fires the same run-finished hook as stop, so the final transcript sweep raced the discard's removal and could re-create the transcript, and analysis then ran on it. The run now announces whether it is being kept.

### The post-completion window, proven — **RUN, PASSED**

`tests/e2e/analysis-durability.spec.ts`, second test. Killing the worker at the right instant turned out to be a race that could not be won reliably: a worker revived by the data plane's port stores and acknowledges a result in tens of milliseconds. So the window is **held open** instead. The control page keeps a `readwrite` transaction on `analyses` alive, IndexedDB queues background's write behind it, and the worker is killed while blocked — result delivered, not stored, not acknowledged.

The assertion that matters is *how* the analysis comes back, because the lost-result path now recovers a dropped result by recomputing it:

| | recovery after the kill | original analysis |
| --- | --- | --- |
| fixed | **545 ms** — redelivered | 27.7 s |
| release-on-delivery re-inserted | **26.7 s** — recomputed; test fails | 27.6 s |

The mutated run also proves the lost-result recovery end to end.

## Superseded text

Preserved verbatim, because the reasoning behind a replaced decision is part of the record.

**5. Local inference runs in a dedicated Worker owned by the offscreen document, orchestrated by background.** Background stays the control plane and owns job state; the offscreen document is the data plane and outlives service-worker termination. Durability is a direct mirror of ADR-0004's upload jobs, because the failure mode is identical — long work in the data plane whose owner in the control plane can be killed at any moment: a per-job durable outbox in `chrome.storage.local`, released only on background ack, replayed on reconnect, and `OffscreenManager.closeForUpdate()` refusing while a job is active exactly as it already refuses for `activeUploadJobs`.

---

**6. Engine code is packaged; only weights are fetched, from an origin we control, and they cache outside ADR-0006's namespace.** Transformers.js and ONNX Runtime Web — including its `.wasm` binaries — ship inside the extension, with `ort.env.wasm.wasmPaths` pointed at `chrome.runtime.getURL(...)`; this is MV3's remote-code rule and Plan B §B2's stance. Weights are self-hosted and reach `host_permissions` through a build-time define, reusing the `telemetryHostPermission()` pattern. They cache in the **Cache API** — unused in this repo until now, which is the point: model bytes stay entirely out of the OPFS `staging/` ÷ `library/` namespace that ADR-0006 governs, so ADR-0006 needs no amendment. This requires adding `content_security_policy.extension_pages` with `'wasm-unsafe-eval'`, which is store-review-visible.

---

The plan fixes every value its source payload fixed (the `> 0.82` assignment threshold, `C_new = (n·C + x) / (n + 1)`, the 0.70/0.10/0.10/0.10 boundary blend, the 0.30/0.25/0.20/0.15/0.10 ranking, batch 32, 384 dimensions) and invents none that it did not.

---

**Consequences, as first written:**

- The transcript stops being a tab-local artifact. `PlaybackManifest.transcriptStatus` becomes real, and the player rail that `src/recordings/player/PlayerView.ts` documents as "not built" gains a reason to exist.
- The `recording-history` database gains stores and a version bump; the upgrade stays presence-driven and idempotent, as it already is.
- The extension gains a `content_security_policy` key for the first time. This is visible to store review and should be expected to draw a question about `'wasm-unsafe-eval'`.
- The extension gains its first substantial runtime dependency. `ts-loader` runs without `transpileOnly`, so full type-checking on every build will get slower; measure the delta rather than silently switching.
- Captions are the only transcript source, so recordings without Meet captions have no topics. This is a coverage gap that Plan B closes, not a defect of this design.
- The discourse-cue and discourse-signal term sets are English-only while the encoder is deliberately multilingual. On a non-English call those terms contribute nothing and the boundary blend degrades to 0.70/0.10/0.10/0.00 rather than failing. Known asymmetry, recorded here so it is not rediscovered as a bug.
- Window embeddings are retained (~1.2 MB per recording) rather than discarded after clustering, because they are what makes cross-session retrieval cheap later. Discarding them would forfeit the "reusable computational memory" claim the architecture rests on.
- Nothing in this decision requires a GPU. Topic organization works on every hardware tier; only the sophistication of interpretation would change if a generative layer is added later.
