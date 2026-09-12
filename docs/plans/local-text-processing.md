# Local text processing — canonical plan

> **Status: CANONICAL BASE r1.** Approved by the author on 2026-09-11. Declared the read-only base for every future `lossless-plan-evolution` revision of this subsystem.
> **Provenance.** The normative payload is the author's architecture proposal of 2026-09-10, indexed losslessly in Appendix A. Three scope decisions (input timing, WebLLM deferral, weight delivery) and two architecture decisions (transcript dependency, compute host) were authorized by the author in this session and are recorded as an explicit delta in Appendix B. Codebase facts come from a three-agent sweep of the working tree on `feat/local-text-processing` at `b43018f`.
> **No prior plan exists for this subsystem**, so this is initial creation under `lossless-plan-evolution` §4, not a preservation revision.
> **Transcription normalizations (semantically neutral, recorded for audit).** (a) `ConversationSegment`'s `start`/`end` are rendered as `tStartMs`/`tEndMs` to match the repository glossary and `RecordingNotation`; the semantics are unchanged (see D-07). (b) ASCII stage diagrams in the payload are rendered as prose and type sketches; the stage order is preserved exactly (ARCH-03).

---

## Context

This extension records Google Meet calls and already has a mature capture, storage, delivery and playback stack. What it does not have is any understanding of *what was said*. The transcript today is an in-memory `string[]` inside the Meet tab's content script (`src/content/captionBuffer.ts`), retrieved by one popup button and written straight to Downloads as a `.txt`. It is never persisted, it is keyed to nothing, and it dies with the tab. `RecordingPlaybackService.ts:44` hardcodes `transcriptStatus: 'none'` with the comment *"No transcription pipeline exists yet, so the rail never renders today."* There is zero NLP, embedding, or model-inference code anywhere in `src/`, and exactly one runtime dependency (`webm-duration-fix`).

The goal is to make a finished recording *legible* — to turn an hour of captions into a short list of what the conversation was actually about, with timecodes that seek the player. The intended outcome is that opening a recording shows something like `● redis · timeout · workers · pool — 23 min` before the user has read a word of transcript.

The architectural bet, stated in the payload and adopted here, is that **this does not need a generative model**. Topic structure is an embedding problem: encode, detect boundaries by cosine change, cluster online, rank by vector arithmetic. That is five stages of cheap, deterministic, testable computation. A local LLM is a labelling layer that sits *on top* of the result, and it is explicitly deferred out of this plan (§12). Everything ships without it and stays useful without it.

Two things make this non-trivial in this codebase specifically, and both are addressed before any modelling work: there is no persisted transcript to analyse (§3), and the build cannot currently load a model at all — no CSP key, WASM experiments off, `.mjs` unresolvable (§7).

---

## 1. What changes from the source proposal

Five authorized changes. Everything else in the payload is carried unchanged; Appendix A is the proof.

**The pipeline runs after the recording, not during it.** The payload's flow is live: a turn arrives, is appended, and only the new window is embedded (INC-02). Analysis instead runs once over a persisted transcript when the recording is finished. The *algorithm* is untouched — still one embedding pass per window, still single-pass online clustering, still never re-embedding or re-clustering anything (INC-01 stays rejected). What changes is the trigger. The honest cost: INC-03's "proportional to new text, not total history" now holds *within* a run and *across re-opens* (results are persisted and never recomputed) rather than against a growing live buffer. The live variant is deferred, not deleted (D-01).

**WebLLM does not ship.** The payload itself says the LLM can be postponed indefinitely, and that the initial UI can be driven entirely by c-TF-IDF keyword scoring (UI-01, UI-02). That is what ships. All of GEN-\*, the expand-to-generate interaction, and the two-model GPU residency handoff move to explicit deferred scope (§12). ARCH-02's stance — WebLLM is the last stage, not the core engine — is the reason this is possible, so it survives as an active architectural commitment. c-TF-IDF is promoted from a placeholder to the sole labelling mechanism (D-02).

**Weights are self-hosted.** The payload never named an origin. Weights come from an origin the project controls, not a third-party CDN, and reach `host_permissions` through a build-time define (D-03).

**The engines run in a Worker owned by the offscreen document, not in the service worker.** The payload puts them "below the service worker" (RT-03), which this satisfies; it names the service worker because the WebLLM MV3 example uses one (REF-01). This codebase has a stronger precedent: `opfsWorker` via `WorkerStorageTarget` is already a dedicated Worker owned by offscreen, ADR-0001 keeps all heavy and media work in the data plane, and `docs/plans/portable-transcription.md` §B2 already specifies "a **dedicated Worker** hosted by the long-lived offscreen document" for exactly this class of work. RT-02 is unaffected: background still orchestrates and owns job state. RT-05's warning is honoured by the same mechanism that already protects uploads (D-04).

**A transcript aggregate is a prerequisite of this plan, not an assumption of it.** §3 (D-05).

---

## 2. The shape of the thing

Three aggregates, each derived from the one above it, each independently persisted. This mirrors ADR-0005's stance that notations are a *separate* timecoded aggregate rather than a field on the recording — and ADR-0005 already names transcripts as the sibling case, noting they are "the same shape minus the speaker label."

```text
RecordingHistoryEntry (exists)
   └── Transcript            §3   utterances, media-relative, source-tagged
         └── ConversationSegment  §5   temporal, one topic each
               └── Topic          §5   global, gathers non-adjacent segments
```

The load-bearing distinction (MODEL-01, MODEL-05) is that **segments are temporal and topics are global**. A meeting that goes Berlin → Redis → Hiring → Redis → Berlin produces five segments and three topics, with segments 2 and 4 both pointing at the Redis topic (MODEL-04, MODEL-06).

```ts
// src/shared/transcript.ts  — Plan B §B0's contract, implemented here (TX-01)
type TranscriptSource = 'meet-captions' | 'stt';
type TranscriptSegment = { tStartMs: number; tEndMs: number; speaker?: string; text: string };
type Transcript = { source: TranscriptSource; segments: TranscriptSegment[] };

// The content script's wire shape: wall clock, because the Meet tab has no
// other one. Background projects it onto the media timeline (D-08).
type CaptionUtterance = { startedAt: number; endedAt: number; speaker: string; text: string };

// src/shared/analysis.ts — new
type ConversationSegment = { tStartMs: number; tEndMs: number; embedding: Float32Array; localTopicId: string };
type Topic = { id: string; centroid: Float32Array; segments: string[]; keywords: string[]; importance: number };
```

`ConversationSegment` is MODEL-02 with its `start`/`end` rendered in house vocabulary; `Topic` is MODEL-03 with an id added so `segments[]` can reference by key in IndexedDB rather than by object graph. Timecodes are media-relative and pause-aware throughout, identical to `RecordingNotation.tStartMs` semantics, so a topic offset is directly a playback position.

---

## 3. Phase 0 — the transcript has to exist first

This is the dependency the payload assumed. `docs/plans/portable-transcription.md` §B0 already specifies the seam; none of it is implemented. This plan implements the B0 contract **plus persistence**, populated from Meet captions only, and takes no dependency on Plan B's PCM sidecar or STT work (TX-03). Future sources append the same segment shape and the analysis pipeline never learns they exist (TX-05).

**Segments, not a string.** `CaptionBuffer` already holds `{ startTime, endTime, speaker, text }` chunks internally and destroys them on commit by collapsing into `[iso] [iso] speaker : text`. Give it `getUtterances(): CaptionUtterance[]` and make `getTranscriptText()` a *render* of those records — Plan B §B0's refactor, with its emitted type split by time base per D-08. `normalizeCaptionText()` stays a dedupe helper.

**Wall-clock has to become media-relative.** Captions carry `Date.now()`; the aggregate needs pause-aware media offsets, and only background knows the pause ledger. So the content script pushes committed utterances to background as wall-clock as they commit — fire-and-forget state transfer, the existing carrier for this — and background projects them onto the media timeline. Pushing incrementally rather than pulling at stop is a durability decision, not a live-analysis one: captions are ephemeral and the Meet tab can close before or during finalize.

The projection is a **span ledger**, not a single origin (D-09). `RecordingSession` records every contiguous stretch of wall clock that was actually written into the media, and projects through it. A single origin was not enough for three reasons that all bite at the edges of a run: the end-of-run sweep reads the clock *after* the session is idle; utterances spoken before a pause live in an earlier span; and an utterance still in progress when a pause or stop lands has to be truncated to real recorded time. Anything that falls in no span is dropped, never clamped — a clamped offset seeks to words that are not in the file. Utterances are always projected from **when they were spoken**, never from when the buffer committed them.

The push is armed only for the duration of a run, so an ordinary Meet call never wakes the service worker; a content script that loads mid-run (a Meet reload or navigation) asks background whether it should be shipping and arms itself from the answer, so the pipeline stays incremental for the rest of that run rather than deferring to the end. Arming also flushes whatever is already buffered, closing the race with the arming message. Every push carries the run's fencing token (ADR-0003), so a message delayed across a stop/start boundary cannot be filed under the next run. The end-of-run sweep remains as reconciliation.

**Persistence mirrors the notation aggregate exactly.** A `transcripts` store in the existing `recording-history` database (`recordingHistoryDatabase.ts`, version 4 → 5, presence-driven idempotent upgrade), a `RecordingTranscriptRepository` implementing a port with a read-modify-write `update()` inside one `readwrite` transaction, and a `RecordingTranscriptService` above it — the same four-layer stack as `RecordingNotationRepository` / `RecordingNotationService`. Protocol follows the house rule that live commands are id-less and history commands are keyed, and the new response types join `NON_SESSION_RESPONSE_MESSAGE_TYPES` so a transcript failure can never kill capture.

`PlaybackManifest.transcriptStatus` stops being hardcoded and starts reporting `'none' | 'processing' | 'ready'` — the type already exists and is already on the manifest (TX-06). The popup Save path becomes source-agnostic (Plan B §B0) and keeps working unchanged for Meet.

**Exit criterion:** stop a Meet recording with captions on, reopen it from the library, and read back a `TranscriptSegment[]` whose offsets seek correctly in the player across a pause/resume cycle.

---

## 4. Where the compute runs

```text
content script ──push segments──▶ background (control plane)
                                     │  orchestrates, owns job state, persists (RT-02, RT-06)
                                     ▼
                                  offscreen document (data plane)
                                     │  AnalysisManager: queue, concurrency 1, durable outbox
                                     ▼
                                  embedding Worker
                                     Transformers.js · WebGPU, WASM fallback
```

`EmbeddingWorkerClient` mirrors `WorkerStorageTarget` structurally: `new Worker(chrome.runtime.getURL('embeddingWorker.js'))`, a hand-rolled promise-per-seq ack map, an `openHandshake()` on spawn, transferable `ArrayBuffer`s for embeddings, and a static `unsupported` latch that probes once and stays latched for the session. Its fallback ladder is `WebGPU → WASM → analysis unavailable`, and per the house rule established by `WorkerStorageTarget` a downgrade is reported through `deps.reportWarning`, never taken silently (RES-06, RES-08).

Durability is a direct mirror of ADR-0004's upload jobs, because the failure modes are identical — a long job in the data plane whose owner in the control plane can be terminated at any moment. Terminal analysis state goes to a durable outbox in `chrome.storage.local` under an `analysisJobState:` prefix, one key per job to avoid read-modify-write races, released only after background acks; replayed on reconnect. `OffscreenManager.closeForUpdate()` already refuses while `activeUploadJobs.size > 0` and must refuse for active analysis jobs the same way (HOST-04). RT-07 then follows: killing the service worker is harmless.

---

## 5. The deterministic pipeline

Five stages, all pure functions over vectors, all unit-testable with a stub encoder and no model present. This is the whole product (ARCH-04).

**Encode (EMB).** Utterances are grouped into contextual windows and embedded with `multilingual-e5-small` — Transformers.js-compatible ONNX weights, 384 dimensions, a quantized dtype from {FP16, INT8/Q8, Q4}. Sizing: 3 hours ≈ 30,000–50,000 words ≈ 1,000–3,000 turns becomes 300–800 windows, batched 32 at a time into one GPU forward pass each. That is the whole reason this is affordable: an encoder does one pass per batch instead of generating token by token.

**Detect boundaries (SEG).** For each candidate boundary, embed the previous 3–5 utterances as `A` and the next 3–5 as `B`, score `change = 1 - cosine(A, B)`, and take local peaks. The semantic score is then blended with three cheap non-semantic signals at fixed weights:

```text
topicChange = 0.70 × semanticChange
            + 0.10 × longPause
            + 0.10 × speakerPatternChange
            + 0.10 × discourseCue
```

`longPause` comes free from the gap between `tEndMs` and the next `tStartMs`; `speakerPatternChange` from the `speaker` field; `discourseCue` from the fixed set `"anyway"`, `"by the way"`, `"next question"`, `"moving on"`, `"another thing"`, `"speaking of..."`. Honest gap worth flagging now: those cues are English-only while the encoder is deliberately multilingual, so on a non-English call that term contributes nothing and the blend degrades to 0.70/0.10/0.10/0.00 rather than failing. It is a known asymmetry, not a bug to discover later.

**Cluster online (CLU).** BERTopic is explicitly not run here — `embeddings → UMAP → HDBSCAN` is fine offline and wrong for a browser extension, and neither is necessary for this problem (CLU-01). Instead each cluster is a centroid `C` and a count `n`. A new segment embedding `x` joins the cluster when `cosine(x, C) > 0.82`, otherwise it opens a potential new cluster; the centroid updates as `C_new = (n·C + x) / (n + 1)`, which is free. Closely related micro-clusters are then merged periodically by cosine similarity between centroids — the operation that turns *Redis incident #1*, *Redis incident #2* and *Redis config* into one **Redis**. At 50 topics a full merge sweep is 50 × 50 = 2,500 comparisons, which is nothing.

**Rank (IMP).** Per topic, take the centroid over its segment embeddings and score passages:

```text
importance = 0.30 × similarity_to_topic
           + 0.25 × novelty
           + 0.20 × keyword_distinctiveness
           + 0.15 × recurrence
           + 0.10 × discourse_signal
```

`discourse_signal` fires on the fixed set `"I think we should..."`, `"Let's do..."`, `"The reason is..."`, `"We discovered..."`, `"The problem is..."`, `"It turned out..."`, `"I'll..."`, `"We agreed..."` — same English-only caveat. MMR then removes near-duplicate passages. All of it is vector arithmetic on CPU.

**Label (c-TF-IDF).** Class-based TF-IDF over each topic's pooled text produces the keyword sets that name topics in the UI. With generation deferred this is the only labelling mechanism, which raises its bar: it is the thing the user reads.

Stage boundaries are the test seams. §5's five stages get unit coverage against fixture transcripts with a deterministic stub encoder, so the entire product logic is provable without a GPU, a model download, or a network.

---

## 6. Persistence of results

One `analyses` store keyed by `recordingId`, holding the segments, the topics, the cluster centroids and the window embeddings, plus job state (RT-06). Embeddings are the only bulky part — 384 × 4 bytes × ~800 windows ≈ 1.2 MB per recording, stored as a packed `ArrayBuffer` rather than JSON arrays. They are kept rather than discarded because they are what makes the deferred retrieval index (QRY-01) and the deferred cross-session query (QRY-02) cheap later: this is the payload's "reusable computational memory" claim (ARCH-08), and discarding embeddings would forfeit it.

Results are computed once and never recomputed on reopen.

---

## 7. Build, CSP, and weight delivery

Nothing here is optional; the extension currently cannot load a model at all.

- **CSP.** `static/manifest.json` has no `content_security_policy` key, so the default MV3 policy applies and WASM cannot instantiate. Add `extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"` (BLD-04). This is a store-review-visible change and belongs in the ADR.
- **Webpack.** `experiments.asyncWebAssembly` is off, there is no `.wasm` rule, `resolve.extensions` is `['.ts','.js']` only (Transformers.js is ESM `.mjs`), and `output` sets no `chunkFilename` or worker chunk loading. All four need fixing (BLD-05). `tsconfig.json`'s `lib` excludes `WebWorker` — `opfsWorker.ts` works around this by hand-declaring types; the new worker should get a proper worker tsconfig instead of repeating that.
- **Everything ships in the package (BLD-06).** Runtime, ONNX Runtime WASM, tokenizer, config, model graph and quantized weights are all `chrome-extension://` resources, with `ort.env.wasm.wasmPaths` pointed at `chrome.runtime.getURL(...)`. **Analysis makes no network request at all.** An ONNX file carries a computational graph, not just floats, so fetching one and executing it sits awkwardly under MV3's self-contained-logic rule regardless of who serves it — see ADR-0007's artifact amendment. No model host permission, no weights-origin define, no production-build check for one.
- **No model cache (STO-01…03 superseded).** A packaged resource needs no Cache API, no OPFS fallback, no download progress and no first-install transfer. This also keeps model bytes out of the OPFS namespace ADR-0006 governs without needing a rule to say so.
- **CSP is proven, not presumed (BLD-07).** Transformers.js and ONNX Runtime commonly need packaged WASM to be executable, which under MV3 means `'wasm-unsafe-eval'` in `content_security_policy.extension_pages`. Do **not** add it speculatively. The spike runs the smallest real embedding worker in a production build and adds only what that run proves necessary; if nothing is needed, the manifest keeps its current absence of a custom CSP, which is the better story for store review.
- **Package size is measured, not assumed.** A quantized `multilingual-e5-small` plus the ONNX Runtime WASM is the cost; the spike reports it alongside the `ts-loader` build-time delta, and a later ADR may externalize cryptographically pinned *raw tensor data only* if it proves unacceptable.
- **Build cost risk.** `ts-loader` runs without `transpileOnly`, so a full type-check runs on every build. Measure the delta after adding the dependency; if it is material, that is a separate decision, not a silent switch to `transpileOnly` inside this work.

Privacy (PRIV-01) is stronger than the payload asked for: audio → transcript → embeddings → topics never leaves the device, and under BLD-06 the analysis path makes **no outbound request whatsoever** — not even for weights.

---

## 8. Surface

Topics attach to the **recordings page and the player modal**, which is where a finished recording is surfaced. Nothing goes in the popup, so no popup-gallery stories are needed.

- `PlaybackManifest` gains `topics` alongside the existing `notations`.
- The player scrub bar already renders `player__marks` / `player__mark` from `manifest.notations`; topics get a second band on the same bar, in their own token family mirroring the ADR-0005-scoped `--note-*` family. The palette is warm cream + red — `--surface: #faf8f4`, `--accent: #d23f2f`, `--detail: #8a6a3f` — and a new family must live inside it. Note `--focus` is deliberately never the accent red; that rule holds for anything new.
- A TOPICS popover in the player mirrors the existing FILES popover (`playerTracks.ts` / `describeTracks`), rendering UI-02's list form: `● redis · timeout · workers · pool     23 min`. Clicking a topic seeks.
- On the library table, topic keywords fold into the existing search. `RecordingsView.setNoteSummaries(...)` is the precedent to copy exactly — an asynchronous, fire-and-forget per-page digest painted into an existing column.
- Any new key binding goes through `resolvePlayerAction` in `playerKeymap.ts` and must respect `isFieldTarget` — bare letters must never fire while a field has focus.

---

## 9. Values the payload does not fix

The payload fixes a lot exactly — 0.82, `C_new = (nC + x)/(n + 1)`, the 0.70/0.10/0.10/0.10 blend, the 0.30/0.25/0.20/0.15/0.10 ranking, batch 32, 384 dimensions — and those are carried verbatim. It does **not** fix the following, and this plan deliberately does not invent them.

**Two different kinds of question, settled two different ways.** A GPU benchmark can tell you what a dtype costs; it cannot tell you whether a merge threshold of 0.93 groups a conversation's topics better than 0.96. Freezing the second kind from a throughput run would smuggle guessing back in through the door this section exists to close. So each value names the lane that settles it: **4A** the platform spike, **4B** quality calibration over a corpus of meetings with known boundaries and known recurrence (§10).

| Open contract | Settled by | Where it bites |
|---|---|---|
| ~~Default dtype among FP16 / INT8-Q8 / Q4~~ | — | **Frozen: `q8`.** FP16 is 21× faster on WebGPU but does not load on WASM at all, so FP16-only contradicts RES-08 |
| ~~Embedding throughput target~~ | — | **Baseline frozen: 4.4 windows/sec** (181 s for three hours). A regression *gate* still needs run-to-run variance — step 9, not a blocker |
| ~~Whether `'wasm-unsafe-eval'` is required~~ | — | **Closed.** Not an open contract: MV3's default CSP disables WASM and this directive is how it is enabled. Declared in the manifest (BLD-07) |
| ~~Which ONNX Runtime WASM variants must be packaged~~ | — | **All four ship.** `asyncify`+`jsep` suffices on one machine (−26.2 MB) but ORT selects by feature detection; re-measure across real targets before trimming |
| Window size and stride for contextual windows | **4B** | EMB-06 gives only the 300–800 count for 3 hours |
| Local-peak rule for boundary detection (width, prominence) | **4B** | SEG-04 gives an illustrative series, no rule |
| `longPause` threshold in ms | **4B** | SEG-05 names the term only |
| `speakerPatternChange` definition | **4B** | SEG-05 names the term only; currently a provisional Jaccard distance |
| Micro-cluster **merge** threshold, and "periodically" | **4B** | CLU-04's 0.82 is the *assignment* threshold; CLU-06 gives neither |
| Definitions of `novelty`, `keyword_distinctiveness`, `recurrence` | **4B** | IMP-03 fixes the weights, not the terms; all three are provisional today |
| MMR lambda | **4B** | IMP-05 names MMR only |
| Minimum segment length | **4B** | Unstated; needed to stop 20-second topics |

---

## 10. Implementation plan

Risk-ordered, one phase at a time, each independently green. The order exists to kill the two platform assumptions before anything is built on them.

1. ~~**ADR-0007.**~~ **Done** — `docs/adr/0007-topics-are-derived-from-a-persisted-transcript.md`, `Status: Proposed` until its spike runs. The spikes themselves are step 4 below.
2. ~~**Phase 0 — transcript aggregate.**~~ **Done** (§3). `transcriptStatus` is real; captions persist as media-relative segments.
3. ~~**Pipeline stages.**~~ **Done** (§5) — `src/shared/analysis/`: windows, boundaries, peaks, segments, online clusters, c-TF-IDF labels, importance with MMR. Pure functions against a stub encoder; no GPU, no model, no network. Every §9 value is a required config field with no default anywhere.
4. ~~**4A — Platform spike.**~~ **Done** — ADR-0007 is `Accepted`. Frozen: dtype `q8`, throughput baseline 4.4 windows/sec, `'wasm-unsafe-eval'` declared, all four ORT variants packaged, 104.6 MB release ZIP. Original scope follows.

   **4A — Platform spike.** The smallest real embedding worker, in a production build: `@huggingface/transformers` + ONNX Runtime loading a **packaged** Q8 `multilingual-e5-small` inside an offscreen-owned Worker, with remote model resolution disabled, producing one 384-dimension normalized vector from two sentences and issuing no network request. Then force WebGPU unavailable and prove the WASM path. Only then run the 300–800-window workload. Establishes and freezes: whether `'wasm-unsafe-eval'` is required at all (BLD-07), the default packaged dtype, packaged size, initialization time, batch throughput, peak memory, the WebGPU/WASM delta, and the `ts-loader` build-time delta. Exit criterion (conjunctive): it runs in a production build, **and** §9's *platform* values are frozen into ADR-0007, **and** ADR-0007 moves to `Accepted`.

   Q8 is the baseline rather than Q4, because this model's published exports do not order the way the names suggest: the INT8 export is ≈118 MB while plain `q4` is ≈399 MB and `q4f16` ≈205 MB. FP16 (≈235 MB) is the WebGPU challenger. The spike may load several; the extension packages exactly one.

   **4B — Quality calibration.** Run the deterministic pipeline over a small corpus of real and synthetic meetings with known topic boundaries and known recurrence, and freeze §9's *semantic* values from how well the output matches: window size and stride, the peak rule, `longPauseMs`, `minSegmentMs`, the merge threshold and period, MMR lambda, and the provisional definitions of `speakerPatternChange`, `novelty`, `keyword_distinctiveness` and `recurrence`. Needs 4A only for a real encoder; needs no GPU benchmark, and a GPU benchmark could not answer any of it.
5. **Build seams.** §7 — only what step 4 proved: webpack worker entry and asset copying, worker tsconfig, and any CSP the spike demonstrated. No weights-origin define, no host permission, no production-build check for either (BLD-02/BLD-03 superseded).
6. **Embedding engine.** `EmbeddingWorkerClient` + `analysisWorker`, WebGPU/WASM ladder, batch 32. Exit criterion: 384-dim vectors out, WASM fallback exercised by forcing the latch.
7. **Analysis job and results.** `AnalysisManager` + durable outbox + ack + `closeForUpdate` refusal + the `analyses` store, every row carrying `AnalysisProvenance` (PROV-01). Exit criterion: kill the service worker mid-analysis and have the job complete and report; a stored result computed under different conditions is recognized as stale.
8. **Surface.** §8.
9. **Hardening.** Multilingual pass on a non-English recording, quota behaviour, and per-module READMEs for the new directories (`src/offscreen/analysis/`, `src/shared/analysis/`) per `docs/agents/module-readmes.md`.

Steps 5 and 6 are large and mechanical enough to be worth handing to Codex with a cold brief, gated on `npm run typecheck` + `npm run test:unit`.

---

## 11. Verification

1. `npm run typecheck` and `npm run test:unit` green throughout; new suites co-located under `src/` per house practice.
2. **Stage tests without a model:** fixture transcript + deterministic stub encoder proves boundary blending at the exact 0.70/0.10/0.10/0.10 weights, the `> 0.82` assignment rule, `C_new = (n·C + x)/(n + 1)`, the 0.30/0.25/0.20/0.15/0.10 ranking, and MMR de-duplication.
3. **The Berlin/Redis/Hiring case (MODEL-06):** a fixture that goes Berlin → Redis → Hiring → Redis → Berlin must yield five `ConversationSegment`s and three `Topic`s, with segments 2 and 4 on the same topic. This is the single test that proves the temporal/global split actually works.
4. **Real recording, end to end:** record a Meet call with captions on, stop, and confirm topics appear on the player with keyword labels, that clicking one seeks to the right place, and that reopening reads persisted results without recomputing.
5. **Durability:** kill the service worker mid-analysis; the job completes in offscreen, replays its terminal state on reconnect, and the sealed recording is never touched. Attempt an extension update mid-analysis; `closeForUpdate()` refuses.
6. **Tiering:** force the `unsupported` latch and confirm WASM embeddings still produce topics with a visible warning — RES-08's claim that topic organization works on every tier.
7. **Non-English call:** confirm graceful degradation of the English-only cue terms rather than failure.
8. **Production build:** the built package contains the pinned model, tokenizer, config and ONNX Runtime WASM as `chrome-extension://` resources; the manifest declares **no model host permission**; and an analysis run issues **no network request** (BLD-06). The last is assertable rather than observable — Transformers.js is configured with remote model resolution disabled, so a run that tried would fail rather than silently reach the network.

---

## 12. Deferred scope — named, not dropped

Explicitly out of this plan, and required to stay out until separately approved. Each remains in Appendix A with `deferred` status and its exact payload intact, so a later revision restores rather than re-derives it.

- **The entire WebLLM stage** (GEN-01…07): the 1–5% of text, the 90-min/15,000-token case, representative passages per topic, the `{ topic, summary, decisions }` JSON contract, and the 300–800 in / 50–150 out per-cluster budget.
- **Expand-to-generate** (UI-03, UI-04) and the generation trigger set (BUD-03).
- **Two-model GPU residency** (RES-01…05): unload-LLM-while-recording, the finish-batch → release-buffers → load-LLM handoff, and the WASM-embeddings-with-WebGPU-LLM pairing. RES-06/07/08's *embedding* tiering is active; only the LLM columns of the tier table defer.
- **Live incremental analysis during recording** (the INC-02 trigger variant): the algorithm ships now, the live trigger does not.
- **A tiny classifier replacing the discourse heuristics** (IMP-07).
- **Cross-session query over accumulated recordings** (QRY-02, QRY-03) — the "when did we first start discussing local inference?" case and its `query embedding → topic centroid search → ~5 clusters → segment search → ~15 passages → local LLM` path. §6 keeps the embeddings that make it cheap.
- **Plan B's STT backbone**: this plan implements the transcript *seam* and persistence, not audio transcription. Meet captions only.

---

## Appendix A — Requirement ledger (base ledger r1)

Every normative signal in the source payload maps to exactly one ID. `active` = must appear operationally in this plan. `deferred` = explicitly outside scope, payload retained verbatim so a later revision restores rather than re-derives it. `superseded` = explicitly rejected, must remain absent from the design. `evidence` = a cited external fact, not itself a requirement.

### ARCH — pipeline shape and staging

- **ARCH-01** `active` — The entire pipeline runs in-browser: no server, and without keeping a large LLM hot all the time.
- **ARCH-02** `active` — WebLLM is the **last stage, not the core engine**. It is the reasoning/labeling layer; a cheaper incremental vector pipeline maintains the actual conversational structure.
- **ARCH-03** `active` *(amended by D-02)* — Stage order, exactly: web page / meeting / transcript → content script (extract new conversation turns incrementally) → small embedding model → **embeddings only** → branch to (topic boundary detection) and (semantic clustering) → topic segments → branch to (importance scoring) and (retrieval index) → representative excerpts → optional local 1–3B LLM (WebLLM), only when needed → outputs. The final LLM stage is `deferred` per §12; stages 1–5 are active and their order is unchanged.
- **ARCH-04** `active` — The first five stages do not require generative AI.
- **ARCH-05** `active` *(amended by D-02)* — Example end outputs: `"Redis scaling issue"`, `"Hiring discussion"`, decisions / summaries. Keyword-derived labels are active; generated decisions/summaries defer.
- **ARCH-06** `superseded` — Rejected architecture: `WebLLM → understand transcript → database`. Replaced by ARCH-07.
- **ARCH-07** `active` *(amended by D-02)* — Adopted architecture: a **Conversation DB** is the hub holding, as parallel facets: raw transcript, temporal segments, embeddings, topic graph, important moments, entities/decisions — and WebLLM sits above it as an **interpretation layer**. The entities/decisions facet and the interpretation layer defer.
- **ARCH-08** `active` — Accumulated data becomes **reusable computational memory**.

### INC — incremental processing

- **INC-01** `superseded` — Rejected loop: `entire 3-hour conversation → re-embed everything → re-cluster everything`. Must not be done repeatedly.
- **INC-02** `active` *(amended by D-01)* — Per-turn incremental flow, exactly: turn arrives → append to IndexedDB → embed only the new context window → compare to current topic → same topic? **yes** → update centroid; **no** → close segment and start a new one. Trigger amended from live caption arrival to replay of the persisted transcript after the recording ends; the algorithm is unchanged. The live-arrival trigger is `deferred` per §12.
- **INC-03** `active` *(amended by D-01)* — Processing is essentially proportional to **new text**, not total history. Under D-01 this holds within a run (each window embedded exactly once, never re-embedded, clustering single-pass) and across re-opens (results persisted, never recomputed).

### EMB — embedding stage

- **EMB-01** `active` — Embeddings run in the browser via **Transformers.js** with **WebGPU** feature extraction.
- **EMB-02** `active` — Embedding model budget: **100–300 MB-ish**.
- **EMB-03** `active` — For multilingual conversation, start with the **multilingual-E5 family**; specifically `multilingual-e5-small`, which has Transformers.js-compatible ONNX weights and produces **384-dimensional** embeddings.
- **EMB-04** `active` — Quantized variants are in scope; the Transformers.js ecosystem supports **FP16, INT8/Q8 and Q4** depending on the model. The default choice is an open contract (§9).
- **EMB-05** `active` — Working-set sizing: 3 hours of transcription ≈ **30,000–50,000 words** ≈ **1,000–3,000 conversation turns**.
- **EMB-06** `active` — That does **not** mean 3,000 LLM calls. It becomes roughly **300–800 contextual embedding windows**.
- **EMB-07** `active` — Windows are batched: `[window1, window2, ... window32]` → one GPU batch. Batch size **32**.
- **EMB-08** `active` — Rationale: an encoder embedding model makes essentially **one forward pass per batch**, rather than generating token after token; dramatically cheaper than autoregressive generation.

### SEG — segmentation and topic-boundary detection

- **SEG-01** `active` — Topic boundary detection needs practically no LLM.
- **SEG-02** `active` — For every potential boundary: previous **3–5 utterances** → embedding **A**; next **3–5 utterances** → embedding **B**.
- **SEG-03** `active` — Boundary score: `change = 1 - cosine(A, B)`.
- **SEG-04** `active` — Detect **local peaks** in the resulting score series. Reference series shape: `10:02 .08`, `10:06 .11`, `10:11 .09`, `10:16 .72`, `10:21 .13`, `10:26 .08`. The peak rule itself is an open contract (§9).
- **SEG-05** `active` — Combined boundary signal, exact weights: `topicChange = 0.70 × semanticChange + 0.10 × longPause + 0.10 × speakerPatternChange + 0.10 × discourseCue`.
- **SEG-06** `active` — Discourse cues, exact set: `"anyway"`, `"by the way"`, `"next question"`, `"moving on"`, `"another thing"`, `"speaking of..."`.
- **SEG-07** `active` — The entire boundary operation is very cheap.

### MODEL — segments vs. global topics

- **MODEL-01** `active` — **Separate "conversation segments" from "global topics."** This is especially important.
- **MODEL-02** `active` *(amended by D-07)* — `ConversationSegment { start, end, embedding, localTopicId }`. Field names rendered `tStartMs` / `tEndMs` to match the repository glossary; semantics unchanged, offsets media-relative and pause-aware.
- **MODEL-03** `active` *(amended by D-07)* — `Topic { centroid, segments[], keywords[], importance }`. An `id` is added so `segments[]` references by key in IndexedDB.
- **MODEL-04** `active` — A topic gathers non-adjacent segments: Segment 2 and Segment 4 both → Topic `"Redis"`.
- **MODEL-05** `active` — **Topic segmentation remains temporal; clustering is global.**
- **MODEL-06** `active` — Reference timeline the model must represent: `00:01–05:20 Berlin`, `05:20–19:00 Redis`, `19:00–31:00 Hiring`, `31:00–38:00 Redis again`, `38:00–45:00 Berlin again`.
- **MODEL-07** `active` — This split gives much better UX.

### CLU — clustering

- **CLU-01** `superseded` — Do **not** run BERTopic literally in the extension. The traditional `embeddings → UMAP → HDBSCAN` chain is reasonable offline but must not run continuously in a browser extension receiving conversation data. Neither UMAP nor HDBSCAN is necessary for the main problem. Replaced by CLU-02.
- **CLU-02** `active` — Maintain **online micro-clusters** instead.
- **CLU-03** `active` — Cluster state is a centroid `C` plus a segment count `n` (worked example: `n = 14`).
- **CLU-04** `active` — Assignment rule for a new segment embedding `x`: compute `s = cosine(x, C)`; if `s > 0.82` add it to the cluster and update the centroid; otherwise it is a **potential new cluster**. Threshold **0.82** is the stated value.
- **CLU-05** `active` — Centroid update, exactly: `C_new = (n·C + x) / (n + 1)`. This is essentially free.
- **CLU-06** `active` — **Periodically** merge closely related micro-clusters using cosine similarity **between cluster centroids**. Worked examples: `Redis incident #1` + `Redis incident #2` + `Redis config` → `Redis`; `Berlin travel #1` + `Berlin club` → `Berlin`. Merge threshold and period are open contracts (§9).
- **CLU-07** `active` — Merge cost for 50 topics is `50 × 50 = 2,500` similarity comparisons — nothing for JavaScript.

### IMP — importance scoring and excerpt selection

- **IMP-01** `active` — Finding important moments is even cheaper than segmentation.
- **IMP-02** `active` — Per topic, compute the centroid over its segment embeddings (`e1 … e30` in the worked example).
- **IMP-03** `active` — Passage ranking, exact weights: `importance = 0.30 * similarity_to_topic + 0.25 * novelty + 0.20 * keyword_distinctiveness + 0.15 * recurrence + 0.10 * discourse_signal`. Term definitions are open contracts (§9).
- **IMP-04** `active` — Discourse signals, exact set: `"I think we should..."`, `"Let's do..."`, `"The reason is..."`, `"We discovered..."`, `"The problem is..."`, `"It turned out..."`, `"I'll..."`, `"We agreed..."`.
- **IMP-05** `active` — **MMR** eliminates duplicates. Lambda is an open contract (§9).
- **IMP-06** `active` — All of this is basic vector arithmetic; browser **CPU** is more than sufficient.
- **IMP-07** `deferred` — The discourse heuristics could **eventually** be replaced by a **tiny classifier, not an LLM**.

### GEN — WebLLM generation stage

- **GEN-01** `deferred` *(D-02)* — WebLLM handles only perhaps **1–5%** of the text.
- **GEN-02** `deferred` *(D-02)* — Reference case: a 90-minute meeting, raw transcript ≈ **15,000 tokens**.
- **GEN-03** `deferred` *(D-02)* — After clustering the input becomes representative passages per topic: `Topic 1 → 4`, `Topic 2 → 5`, `Topic 3 → 3`, and so on.
- **GEN-04** `superseded` — Rejected prompt shape: `Summarize these 15,000 tokens.`
- **GEN-05** `deferred` *(D-02)* — Adopted prompt shape: given ~**600 tokens** of representative passages, return `{ "topic": "...", "summary": "...", "decisions": [...] }`.
- **GEN-06** `deferred` *(D-02)* — Per-cluster budget: **300–800 input tokens + 50–150 generated tokens**.
- **GEN-07** `deferred` *(D-02)* — That is exactly where a **1–3B** browser model becomes practical.

### UI — surface behavior

- **UI-01** `active` — The LLM can be postponed indefinitely. The initial view is driven entirely by **c-TF-IDF / keyword scoring**, no generation. Under D-02 this is the shipping surface, and c-TF-IDF is the sole labelling mechanism.
- **UI-02** `active` — Initial label shape, exactly: `● redis · timeout · workers · pool     23 min`, `● berlin · hotel · flight              12 min`, `● interview · frontend · candidate     17 min`.
- **UI-03** `deferred` *(D-02)* — Only when the user **expands** a topic does the extension ask WebLLM: *"Give this topic a concise title and identify the key conclusions."*
- **UI-04** `deferred` *(D-02)* — GPU generation happens **on interaction**. This may be an excellent tradeoff for a browser extension.

### RT — extension runtime architecture

- **RT-01** `active` — **Content script** owns: DOM/transcript extraction, MutationObserver, speaker/timestamp parsing. Under D-05 its output feeds the Phase 0 transcript aggregate rather than the pipeline directly.
- **RT-02** `active` — **Extension service worker** owns: orchestration, conversation state, job queue, storage coordination.
- **RT-03** `active` *(amended by D-04)* — Two compute engines sit below the service worker: an **embedding worker** (Transformers.js, WebGPU) and a **generation engine** (WebLLM, WebGPU). "Below" is realized as a Worker owned by the offscreen document (HOST-01); the generation engine defers per D-02.
- **RT-04** `active` — Both engines write down into **IndexedDB / OPFS / Cache**.
- **RT-05** `active` — MV3 service workers are **disposable**; Chrome normally terminates one after periods of inactivity. Do **not** keep important analysis state only in JavaScript globals.
- **RT-06** `active` — Persist to IndexedDB, exactly this set: `conversation`, `segments`, `embeddings`, `cluster centroids`, `job state`.
- **RT-07** `active` — Given RT-06, killing/restarting the worker is harmless.

### STO / PRIV — model caching and privacy

- **STO-01** `superseded` *(D-13)* — Persistent model-cache backends: **Cache API, IndexedDB, OPFS**. A packaged resource needs no cache. Returns if a later ADR externalizes raw tensor data.
- **STO-02** `superseded` *(D-13)* — First-install download shape: embedding model ≈ **120 MB**; optional LLM ≈ **1.5 GB**, shown as progress. Nothing is downloaded.
- **STO-03** `superseded` *(D-13)* — Subsequent sessions use local cached artifacts. There is no cache to read.
- **PRIV-01** `active` *(strengthened by D-13)* — Privacy chain, device-only end to end: `microphone/audio → transcript → embeddings → topics → summaries`. No transcription content has to leave the machine, assuming transcription is also local. Under BLD-06 the analysis path makes no network request at all.

### RES — GPU residency and hardware tiers

- **RES-01** `deferred` *(D-02)* — Do **not** keep the embedding model and a 3B LLM resident on the GPU simultaneously.
- **RES-02** `deferred` *(D-02)* — While recording is active: embedding model loaded, **LLM unloaded**.
- **RES-03** `deferred` *(D-02)* — When the user asks for analysis, in order: finish the embedding batch → **release embedding GPU buffers** → load the WebLLM model → generate the analysis.
- **RES-04** `deferred` *(D-02)* — Justification: the embedding model is cheap to reload compared with holding another ~GB of GPU memory.
- **RES-05** `deferred` *(D-02)* — A **CPU/WASM embedding fallback with a WebGPU LLM** is a supported combination on memory-constrained machines. The WASM-embedding half is carried actively by RES-06/RES-07.
- **RES-06** `active` — The extension inspects **WebGPU availability** and behaves differently per tier.
- **RES-07** `active` *(amended by D-02)* — Hardware tiers, exact table: *Low-end / no WebGPU* → WASM embeddings + no LLM; *Normal laptop* → WebGPU embeddings + 0.5–1.5B LLM; *Good Apple Silicon / discrete GPU* → WebGPU embeddings + 2–4B LLM; *Powerful desktop* → larger local model optionally. The embedding column is active; the LLM columns defer.
- **RES-08** `active` — Crucially, **topic organization itself continues working on all tiers**. Only the sophistication of generative interpretation changes.

### BUD — generation cadence and compute budget

- **BUD-01** `superseded` — Rejected cadence: `every 30 sec: "resummarize meeting so far"`. This wastes the most compute.
- **BUD-02** `active` — Continuously updated deterministic state, exactly: embeddings, segments, topic centroids, keywords, importance scores.
- **BUD-03** `deferred` *(D-02)* — Generation fires only at meaningful transitions, exact trigger set: topic ends, meeting ends, user opens topic, user asks question, uncertain classification occurs.
- **BUD-04** `active` *(amended by D-02)* — Target budget for a 1-hour meeting: embedding passes **~200**; cluster updates **~200**; vector comparisons **few thousand**; **LLM calls 3–10** — rather than **120+** LLM calls. The deterministic counts are active; the LLM-call clause defers with GEN-\*.

### QRY — retrieval

- **QRY-01** `active` — A **retrieval index** is a first-class consumer of topic segments (see ARCH-03). Realized as the retained embeddings of §6.
- **QRY-02** `deferred` — Cross-session historical query over accumulated recordings (worked example: after 200 hours, *"When did we first start discussing local inference?"*).
- **QRY-03** `deferred` — Query path for QRY-02, exactly: `query embedding → topic centroid search → ~5 clusters → segment search → ~15 passages → local LLM`. Must not require sending 200 hours into a model.

### TX — transcript aggregate *(added by D-05)*

- **TX-01** `active` — Implement the shared transcript contract at `src/shared/transcript.ts` exactly as specified by `docs/plans/portable-transcription.md` §B0: `TranscriptSource = 'meet-captions' | 'stt'`; `TranscriptSegment = { tStartMs: number; tEndMs: number; speaker?: string; text: string }`; `Transcript = { source: TranscriptSource; segments: TranscriptSegment[] }`.
- **TX-02** `active` — A minimal IndexedDB-backed transcript aggregate keyed by `historyId`, mirroring the notation aggregate (ADR-0005) layer for layer.
- **TX-03** `active` — Initially populated from Meet captions only; **no dependency** on Plan B's PCM sidecar or STT work.
- **TX-04** `active` — Timecodes are media-relative and pause-aware, matching `RecordingNotation.tStartMs` semantics.
- **TX-05** `active` — Future transcription sources append the same segment shape and require no change to the topic-analysis pipeline.
- **TX-06** `active` — `PlaybackManifest.transcriptStatus` stops being hardcoded `'none'`.

### HOST — compute host *(added by D-04)*

- **HOST-01** `active` — The embedding engine is a dedicated Worker owned by the offscreen document, not the service worker; mirrors `opfsWorker` / `WorkerStorageTarget` and Plan B §B2.
- **HOST-02** `active` — Background remains the orchestrator and owns job state (RT-02); the offscreen document outlives service-worker termination.
- **HOST-03** `active` — Analysis job terminal state is held in a durable outbox and released only on background ack, mirroring `UploadJobStateOutbox` + `OFFSCREEN_ACK_UPLOAD_STATE`.
- **HOST-04** `active` — `OffscreenManager.closeForUpdate()` must refuse while an analysis job is active, mirroring its existing refusal for `activeUploadJobs`.

### BLD — build, CSP and weight delivery *(added by D-03, D-06)*

- **BLD-01** `active` — Engine code (Transformers.js and ONNX Runtime Web, including `.wasm`) is **packaged**. Only model weights are fetched, as data.
- **BLD-02** `superseded` *(D-13)* — Model weights are **self-hosted on an origin the project controls**, not a third-party CDN. Replaced by BLD-06: nothing is fetched, so no origin exists.
- **BLD-03** `superseded` *(D-13)* — The weights origin reaches `host_permissions` through a build-time define, mirroring `telemetryHostPermission()`, and is required for production builds. Replaced by BLD-06; no model host permission is added.
- **BLD-04** `active` *(amended by D-13)* — `static/manifest.json` gains `content_security_policy.extension_pages` carrying `'wasm-unsafe-eval'`. Added only if the spike proves it necessary, never speculatively (BLD-07).
- **BLD-05** `active` — webpack gains `experiments.asyncWebAssembly`, a `.wasm` rule, `.mjs` in `resolve.extensions`, and worker-safe chunk output; the worker gets its own tsconfig with `WebWorker` in `lib`.
- **BLD-06** `active` *(added by D-13)* — Embedding artifacts are **extension-owned**. All executable runtime artifacts, tokenizer and configuration, the model graph and the quantized weights ship in the extension package and load from `chrome-extension://` resources. Analysis performs no network fetch. A later ADR may externalize cryptographically pinned **raw tensor data only**; remotely supplied executable model graphs or runtime code are out of scope.
- **BLD-07** `active` *(amended by D-15)* — `'wasm-unsafe-eval'` in `content_security_policy.extension_pages` is **required, not open**: Chrome's default extension CSP disables WebAssembly, and MV3 documents this directive as the way to enable it. The spike's job is to prove the packaged Transformers.js/ORT stack *works under* that CSP, not to decide whether the directive is needed. Any allowance beyond it is still established by a real run, never presumed.

### PROV — provenance of a stored analysis *(added by D-13)*

- **PROV-01** `active` — Every persisted analysis carries `AnalysisProvenance`: `pipelineVersion`, `embeddingModel`, `embeddingModelRevision`, `embeddingDimensions`, `configHash`. Four scoring terms are provisional and every §9 value is open, so a result computed under one set of conditions must be distinguishable from one computed under another rather than silently looking equivalent.
- **PROV-02** `active` — `PIPELINE_VERSION` is bumped whenever a stage's behaviour changes in a way that would make an earlier result different — a provisional term redefined, a stage reordered, a contract corrected — because such a change moves no config value and is otherwise invisible to `configHash`.

### KW — topic labels *(added by D-12)*

- **KW-01** `active` — c-TF-IDF scoring is unmodified and keeps every term, including ones used across the whole conversation, for search and for `keyword_distinctiveness`. **Display labels** additionally drop any term occurring in *every* topic, which has zero power to distinguish one label from another; the rule does not apply when there is a single topic. This makes `● redis · pool · timeout · the` impossible without a stopword dictionary or a new threshold.

### REF — cited external evidence (not requirements)

- **REF-01** `evidence` — WebLLM has an official Manifest V3 Chrome-extension example running WebGPU in the extension service worker; WebGPU support for service workers has been enabled by default in Chrome since **124**.
- **REF-02** `evidence` — Transformers.js supports feature-extraction/embedding models directly through WebGPU.
- **REF-03** `evidence` — `Xenova/multilingual-e5-small` ships Transformers.js-compatible ONNX weights.
- **REF-04** `evidence` — Transformers.js dtype support.
- **REF-05** `evidence` — The extension service worker lifecycle.
- **REF-06** `evidence` — WebLLM cache backends.
- **REF-07** `evidence` — Transformers.js supports WASM as well as WebGPU.

---

## Appendix B — Delta manifest

Closed-world. Every requirement not named here is `NO_CHANGE` from the source payload.

| ID | Operation | Requirements | Authorization |
|---|---|---|---|
| D-01 | AMEND | INC-02, INC-03 | Author: input is the finished transcript, after recording. Trigger changes; algorithm does not. Live trigger → deferred. |
| D-02 | DEFER | GEN-01, GEN-02, GEN-03, GEN-05, GEN-06, GEN-07, UI-03, UI-04, RES-01…RES-05, BUD-03 | Author: defer WebLLM, deterministic pipeline first. Consequent amendments to ARCH-03, ARCH-05, ARCH-07, STO-01, STO-02, RES-07, BUD-04, UI-01. |
| D-03 | ADD + AMEND | BLD-02, BLD-03; amends STO-01 | Author: self-host weights on own origin. |
| D-04 | AMEND + ADD | RT-03; adds HOST-01…HOST-04 | Author: Worker owned by the offscreen document. |
| D-05 | ADD | TX-01…TX-06; amends RT-01 | Author: carry a minimal transcript aggregate implementing Plan B §B0's seam, Meet captions only, no PCM/STT dependency. |
| D-06 | ADD | BLD-01, BLD-04, BLD-05 | Codebase fact: default MV3 CSP, WASM experiments off, `.mjs` unresolvable. Required for BLD-01's packaged engine to run at all. |
| D-07 | MOVE | MODEL-02, MODEL-03 | Naming conformance to the repository glossary (`docs/agents/domain.md` rule 3). No semantic change. |
| D-08 | AMEND | §3 prose only; TX-01 and TX-04 unchanged | Implementation finding (2026-09-11): `CaptionBuffer` emits `CaptionUtterance` (wall clock, fields `startWallMs`/`endWallMs`), not `TranscriptSegment` (media-relative, `tStartMs`/`tEndMs`). One type carrying two time bases would mean a field whose meaning depends on which side of a message boundary reads it. `TranscriptSegment`'s shape is Plan B §B0 verbatim and TX-04's media-relative guarantee is strengthened, not weakened. |
| D-15 | AMEND | BLD-07; §9 prose | Author review (2026-09-12). `'wasm-unsafe-eval'` is closed, not open: Chrome's default extension CSP disables WebAssembly and MV3 documents this directive as the way to enable it, so the manifest declares it and the spike proves the packaged stack runs under it. Corrects an over-strong claim about threading: an extension *can* opt into cross-origin isolation via COOP/COEP; this one does not, so the WASM fallback is single-threaded by choice, and COOP/COEP is a separate optimization spike if WASM proves too slow. Strengthens the no-network proof from configuration to configuration **plus** a run with all http(s) aborted. |
| D-14 | AMEND | PROV-01; §9 and §11.8 prose | Author review (2026-09-12). `AnalysisProvenance` gains `embeddingDtype`: re-quantizing the same model at the same revision moves the vectors and therefore every boundary and cluster derived from them. The throughput target stays out — an acceptance target, not a condition on the result. §9 splits its open contracts into what a platform spike can settle (4A) and what needs quality calibration against known-good conversations (4B); freezing the latter from a throughput run would reintroduce guessing. §11.8's weights-origin check is replaced, having contradicted D-13. |
| D-13 | SUPERSEDE + ADD | Supersedes BLD-02, BLD-03, STO-01, STO-02, STO-03; amends BLD-04, PRIV-01; adds BLD-06, BLD-07, PROV-01, PROV-02 | Author decision (2026-09-12): bundle the complete embedding model with the extension for v1. An ONNX file carries a computational graph, not just floats, so fetching and executing one sits awkwardly under MV3's self-contained-logic rule regardless of who serves it — self-hosting does not change what the artifact *is*. Removes the downloader, cache, integrity and failure machinery before the model has even been benchmarked. CSP allowances are proven by the spike, never presumed. Provenance is persisted because the provisional terms and §9 values will change. |
| D-12 | ADD | KW-01; amends UI-01, UI-02 | Author decision (2026-09-12): fix the universal-term label problem outside c-TF-IDF. The formula is unchanged and keeps every term for scoring and search; display labels drop terms occurring in every topic, which is a statement about discrimination rather than about English — no stopword dictionary, no new threshold. |
| D-11 | AMEND | §3 prose only; TX-04 strengthened | Author review (2026-09-11). The stop is the same boundary as a pause: Meet refines a caption after the recorder stops, so `stop()` drains the tab at `markStopping()` and the overrun rule becomes uniform — any range ending past its span is refused, never truncated. Records the invariant that the final drain and sweep must not admit refinements representing speech first observed after the cutoff, and states precisely that a segment is temporally anchored to real media but its text is **not** a word-level alignment — which topic analysis must not assume. |
| D-10 | AMEND | §3 prose only; TX-04 strengthened | Author review (2026-09-11). Pause-boundary semantics: the caption buffer is flushed when a run pauses, so an utterance closes at the boundary and the next opens after the resume. A range that still straddles a pause is refused rather than truncated — truncating would attribute post-resume speech to pre-pause media, and nothing in a caption says where its text divides. A range overrunning its span because the *recording ended* still truncates, since nothing after that instant was recorded anywhere. Confirms `epoch` as the run identifier and no `utteranceId`: push and sweep share one projection path and stored segments are append-only, so content identity is deterministic. |
| D-09 | AMEND | §3 prose only; TX-04 strengthened | Author review (2026-09-11), plus two defects it surfaced. The wall→media projection is a **span ledger** on `RecordingSession`, not a single origin: the previous reading answered `undefined` for every instant once a run ended, so the end-of-run sweep stored nothing, and `markIdle` additionally dropped the tab to sweep. Adds: run-scoped fencing on every push, a re-arm handshake for a content script that loads mid-run, a buffer flush on arming, and truncation (never clamping) of an utterance that outlives its recorded span. |

### Ledger counts (r1)

| Status | Count |
|---|---|
| active | 77 |
| deferred | 17 |
| superseded | 10 |
| evidence | 7 |
| **total** | **111** |
