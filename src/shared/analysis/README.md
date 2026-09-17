# Analysis — turning a transcript into topics

> Part of [`shared`](../README.md). The engine that runs this lives in [`offscreen/analysis`](../../offscreen/analysis/README.md); the aggregate it is stored in is owned by [`background`](../../background/README.md). Decisions: [ADR-0007](../../../docs/adr/0007-topics-are-derived-from-a-persisted-transcript.md). Plan: [`local-text-processing.md`](../../../docs/plans/local-text-processing.md).

## Purpose and mental model

Given a recording's transcript, say what the conversation was **about** — a short list of subjects with timecodes that seek the player.

Think of it as **five pure functions over vectors**. Nothing here imports `chrome.*`, touches storage, or knows a model exists. Text goes in, an encoder is handed in, topics come out.

```text
transcript → windows → embeddings → boundaries → peaks → segments
                           ↓                                ↓
                           └────────────── clusters ← ──────┘
                                              ↓
                                    labels + importance
```

The bet the whole design rests on: **this is not a generative problem.** Topic structure is an embedding problem — encode, detect change by cosine distance, cluster online, rank by vector arithmetic. A local LLM would be a labelling layer on top, and it is deferred (plan §12). Everything ships and stays useful without one.

## The contract

Two aggregates, and keeping them apart is the load-bearing decision:

> **A `ConversationSegment` is temporal. A `Topic` is global.**

A meeting that goes Berlin → Redis → Hiring → Redis → Berlin is **five segments and three topics**, with segments 2 and 4 pointing at the same topic. Collapsing the two into "one topic per time range" cannot represent a subject that recurs, which is the normal shape of a real conversation.

| Type | Is | Carries |
| :--- | :--- | :--- |
| `ContextWindow` | 3–5 consecutive utterances | text, speakers, media bounds, `opensWithDiscourseCue` |
| `ConversationSegment` | one contiguous stretch of one subject | media bounds, embedding, `localTopicId`, `startWindow`/`endWindow` |
| `Topic` | one subject, wherever it occurs | centroid, segment ids, keywords, importance |
| `AnalysisProvenance` | the conditions a result was computed under | model, revision, dtype, `configHash`, pipeline version |

`startWindow`/`endWindow` exist because a topic has to be readable back into **words**: c-TF-IDF pools a topic's text to label it and importance ranks its passages, and neither is reachable from timecodes alone.

## Design rationale & theory

**Why an encoder and not a generator.** An encoder makes one forward pass per *batch*; a generator emits token after token. Three hours of conversation is ~1,000–3,000 turns, which becomes 300–800 contextual windows, which is 10–25 batched forward passes. That is the difference between affordable in a browser and not.

**Why online micro-clusters and not BERTopic.** `embeddings → UMAP → HDBSCAN` is reasonable offline and wrong here: both are batch algorithms over a fixed corpus. A cluster is instead a centroid `C` and a count `n`; a segment joins when `cosine(x, C)` exceeds the assignment threshold, and the centroid updates as `C_new = (n·C + x)/(n + 1)` — free. A periodic sweep merges centroids, which is what turns *Redis incident #1*, *#2* and *Redis config* into one **Redis**. At 50 topics a full sweep is 2,500 comparisons.

**Why boundary contexts must be disjoint.** Stated precisely, because the loose version is wrong: *the two semantic contexts compared across one candidate boundary must not share utterances.* An earlier build unified the contextual window with the boundary-comparison span, and the shared context smeared the signal — adjacent within-topic windows scored 0.954 against 0.946 across a real boundary. Making the shapes disjoint took boundary F1 from 0.767 to 0.892. It is *not* a rule that windows must always be disjoint.

**Why the errors are asymmetric.** An over-tight assignment threshold makes extra micro-clusters, which the merge sweep can still reunite. An over-loose one folds two subjects into one, and **this pipeline has no split operation**. Prefer over-splitting when two candidate values score alike.

## Configuration & flags

Every value in `SegmentationConfig`, `ClusterConfig`, `KeywordConfig` and `ImportanceConfig` is a plan §9 **open contract**. There is deliberately **no default export of `AnalysisConfig`** — a plausible-looking number chosen at the type would become the frozen value by accident.

What ships is `CANDIDATE_ANALYSIS_CONFIG`, named so it cannot be mistaken for settled. Every value comes from ADR-0007's 4B calibration except two, marked inline: `keywordsPerTopic: 4` (read off UI-02's own examples) and `mmrLambda: 0.7` (the Carbonell & Goldstein default; never calibrated).

| Value | Status |
| :--- | :--- |
| window 4 / stride 4 | strong structural result |
| peak neighbourhood 2, prominence 0.05 | candidate default |
| `minSegmentMs` 15 s | candidate default |
| assignment 0.93, merge 0.95, period 12 | candidate region |
| `longPauseMs` 3 s | candidate, **no measured effect** — 3 s, 5 s and 8 s were identical across the whole grid |
| MMR lambda | **outside the config** — `selectRepresentative` has no caller (D-20) |
| `PAYLOAD_ASSIGNMENT_THRESHOLD` (0.82) | **retained for provenance, not used** |

4B's corpus is synthetic. It underrepresents interruptions, callbacks, weak transitions and mixed-topic turns — exactly the cases that decide a threshold. **None of this is validated against real conversation yet.**

## Key invariants & gotchas

- **`0.82` is unusable with this encoder.** CLU-04 states it, and 4B measured every genuinely different topic pair above it — 27 of 27, lowest 0.861 — so `cosine > 0.82` means "always join" and every conversation collapses to one cluster. E5-family models compress cosine into a narrow high band. The constant is kept, renamed, and unused.
- **Adjacent windows never share an utterance at the calibrated stride** — including the tail. A trailing remainder gets a *short* window; anchoring a full-size one at the end overlaps its predecessor and reintroduces the smearing 4B eliminated (D-22).
- **Boundary resolution is quantized to window boundaries.** Window 4 / stride 4 satisfies the disjointness invariant by construction; the cost is that a boundary can only land on a 4-utterance edge. A higher-resolution detector remains open.
- **Timecodes are segment-level, never word-level.** Offsets are inherited from `TranscriptSegment` and bound media that genuinely exists, but a caption's text is not word-aligned to its own timecodes. Nothing here may locate an individual word from a segment's offsets.
- **E5 needs its instruction prefix.** `toEncoderInput` applies `"query: "` and is idempotent. Embedding raw text produces vectors that are subtly and unrecoverably wrong.
- **Vectors do not survive a structured clone here.** Neither `Float32Array` nor a raw `ArrayBuffer` round-trips through this project's test harness, so durable rows and the offscreen→background port both carry plain number arrays (`toDurableRow`, `toWireAnalysis`). The pipeline works in `Float32Array` in memory and converts at the boundary. ~2.4 MB per three-hour recording, against `unlimitedStorage`.
- **Discourse cues cover English, Russian and Ukrainian.** A language absent from the list contributes nothing and the blend degrades to `0.70/0.10/0.10/0.00` rather than failing. The matcher is Unicode-aware: an ASCII-only word-boundary class treats every Cyrillic letter as a break, so `кстатиь` would match the cue `кстати`.
- **Tokenization assumes spaces.** `tokenize` splits on non-letter/non-number, which is right for Latin and Cyrillic and wrong for CJK: Japanese or Chinese text becomes a single enormous "term", so c-TF-IDF labels for such a call would be useless. The *embeddings* are unaffected — the encoder is multilingual and segmentation and clustering work normally — so topics are still found and seekable; only their names degrade. A segmenter would be the fix, and it is not in scope.
- **A label never contains a term every topic shares.** c-TF-IDF ranks a ubiquitous term last but cannot exclude it, so a four-slot list can still reach it. Terms with `df === topicCount` are dropped at label selection, outside the scoring.
- **Importance is measured against the cluster centroid, not a segment.** IMP-02 is explicit, and the distinction only bites for recurrent topics — ranking against the first segment scores a topic by how much it resembles its own opening, penalising exactly the later stretches that global topics exist to gather.
- **Importance for a *topic* is our definition, not the payload's.** IMP-03 defines importance for passages only. A topic's score is the **mean** over its passages — averaging rather than summing, so a long dull stretch cannot outrank a short consequential one on length alone.

## Files

| File | Role |
| :--- | :--- |
| `types.ts` | The vocabulary, `BOUNDARY_WEIGHTS`, `DISCOURSE_CUES`, the open-contract config types |
| `windows.ts` | Utterances → contextual windows; enforces SEG-02's 3–5 bound |
| `boundaries.ts` | The four signals, the 0.70/0.10/0.10/0.10 blend, local-peak detection |
| `segments.ts` | Peaks → temporal segments; merges runs shorter than `minSegmentMs` |
| `clusters.ts` | Online micro-clusters, centroid update, the periodic merge sweep |
| `keywords.ts` | c-TF-IDF scoring and label selection |
| `importance.ts` | The 0.30/0.25/0.20/0.15/0.10 ranking, and MMR awaiting a consumer (D-20) |
| `vector.ts` | `cosine`, centroid arithmetic |
| `analyzeTranscript.ts` | The whole pipeline, with the encoder injected |
| `encoderInput.ts` | The E5 instruction prefix |
| `provenance.ts` | What produced a result, and whether it is stale |
| `candidateConfig.ts` | The §9 values a run uses today — candidates, not contracts |
| `storedAnalysis.ts` | Durable shape, wire shape, and the two digests surfaces read |
| `playbackTopics.ts` | Stored analysis → the player's topic list |
| `job.ts` | One analysis run as a durable fact |
| `packagedModel.ts` | Which model this build packaged |

## Testing notes

Every stage is unit-tested against a **deterministic stub encoder** — text about the same subject points the same way. That is the point of injecting the encoder: the entire product logic is provable with no GPU, no model, no network.

The one test that proves the design works is the Berlin/Redis/Hiring case: a transcript that returns to a subject must yield more segments than topics, with the recurring subject reunited under one.

Real-vector work lives in E2E instead: `tests/e2e/analysis-embedding*.spec.ts` for the runtime proof and throughput, `analysis-calibration-dump.spec.ts` for the corpus 4B was frozen from.

## Alternatives considered

| Instead of | We do | Because |
| :--- | :--- | :--- |
| BERTopic (UMAP + HDBSCAN) | online micro-clusters | batch algorithms over a fixed corpus; neither is necessary for this problem |
| Re-embedding the conversation as it grows | one pass per window, ever | INC-01 is explicitly rejected; cost stays proportional to new text |
| A generated title per topic | c-TF-IDF keywords | generation is deferred; this raises the bar on labelling rather than lowering it |
| Discarding embeddings after clustering | keeping them | they are what makes the deferred retrieval index cheap later |
| Storing packed `ArrayBuffer`s | plain number arrays | a packed row is one no unit test in this harness can verify |

## Related

- [ADR-0007](../../../docs/adr/0007-topics-are-derived-from-a-persisted-transcript.md) — topics are derived from a persisted transcript
- [`offscreen/analysis`](../../offscreen/analysis/README.md) — the engine and the job that runs this
- [`docs/plans/local-text-processing.md`](../../../docs/plans/local-text-processing.md) — the canonical plan and its requirement ledger
