# Plan B — Provider-portable transcription (audio-STT backbone + Meet fast-path)

## Goal

Give **every** recording a transcript — any provider (Zoom-web, Teams-web,
Webex) and the no-meeting case (a solo lecture, a narrated presentation) — by
transcribing the **captured audio** the offscreen already holds, instead of
relying on DOM caption scraping. Keep the Google Meet DOM scraper as a free,
speaker-labeled **fast-path** where it works.

This plan owns transcription only; recording portability is Plan A
(`record-anywhere.md`). Plan B reuses Plan A's `meetingProviders` registry and
`source` field.

## Why not "just add more DOM scrapers"

The provider seam already exists — `MeetingProviderAdapter`
(`src/content/MeetingProviderAdapter.ts`), `GoogleMeetAdapter`
(`src/content/GoogleMeetAdapter.ts`), injected at
`src/scrapingScript.ts` (`new TranscriptCollector(new GoogleMeetAdapter())`).
Adding a `ZoomAdapter` is *architecturally* trivial. But DOM scraping is the
wrong backbone:

- **Selector rot** — `MEET_SELECTORS` (`GoogleMeetAdapter.ts:25`) already
  carries a `Last verified: 2026-03` comment. Every provider obfuscates and
  changes its caption DOM without notice; N adapters = N perpetual maintenance
  liabilities.
- **Many providers can't be scraped at all** — captions exist in the DOM only
  if the user turns CC on, and the common native Zoom/Teams desktop apps never
  reach the browser.
- **It does nothing for the no-meeting case** — a solo lecture has no captions
  to read.

Audio STT inverts this: **one** pipeline, provider-independent, immune to UI
redesigns, and it solves the solo case for free. The Meet scraper survives as an
optional fast-path (free + already speaker-labeled), not the foundation.

## How transcription works today (the starting point)

- `scrapingScript.ts` `TranscriptCollector` + `GoogleMeetAdapter` scrape Meet
  captions into `CaptionBuffer` (`src/content/captionBuffer.ts:32`), which
  commits deduped utterances with speaker + timing.
- Retrieval is **manual and decoupled from recording**: the popup Save button
  (`PopupController.wireTranscriptDownload`, `PopupController.ts:137`) sends
  `GET_TRANSCRIPT` to the active tab and downloads the returned text as a
  `.txt`. It is **not** tied to the recording lifecycle and **not** uploaded to
  Drive.
- Where the captured audio lives: the offscreen owns the streams
  (`RecorderEngine` fields `tabRecordingStream` / `micStream` / `mixedAudio`)
  and already builds an `AudioContext` graph in `MixedAudioMixer`
  (`src/offscreen/RecorderAudio.ts:15`) to mix mic + tab audio. **That graph is
  the natural STT tap point.**

## The core abstraction — a transcript with a *source*

Make a transcript a list of timed segments, independent of how it was produced:

```ts
type TranscriptSource = 'meet-captions' | 'stt';
type TranscriptSegment = { tStartMs: number; tEndMs: number; speaker?: string; text: string };
type Transcript = { source: TranscriptSource; segments: TranscriptSegment[] };
```

- `meet-captions`: `CaptionBuffer` already has utterances with speaker + start/
  end — adapt it to emit `TranscriptSegment[]` instead of a joined string.
- `stt`: produced by transcribing the captured audio (no speaker labels in v1;
  diarization is a later add).

This is the seam that lets the popup, the file naming, and the Drive upload stop
caring whether the words came from the DOM or from audio.

## The central decision: where and when STT runs

Two axes — **backend** (local-WASM vs cloud) and **timing** (live-streaming vs
post-recording batch).

**Recommended v1: post-recording *batch* STT over the sealed audio, backend
pluggable, default local-WASM, cloud opt-in.**

Rationale, grounded in this codebase:

- **Perf** — the offscreen is already CPU-bound doing live encode, and this
  project is perf-sensitive (see the perf initiative + backpressure machinery in
  `RecorderTaskUtils.makeChunkHandler`). Running heavy STT *during* capture
  would contend with the encoder on the same machine. Batch-after-stop removes
  that contention entirely.
- **Failsafe reuse** — the recording already seals durably to OPFS with resume/
  orphan-recovery guarantees. A transcription stage that runs after seal can
  lean on the same durable artifact and the same marker/retry pattern
  (`PendingUploadStore`, orphan recovery) instead of inventing new durability.
- **Privacy default** — local-WASM keeps audio on-device (important once we
  transcribe *other participants*; see Risks).

Live streaming (incremental transcript during the call) is deferred to B4 — it
is the highest perf/complexity risk and not required for "record a lecture and
get its transcript."

## Approach — tiers

### B0 — Transcript-source seam (no new capability)

- Add the `Transcript`/`TranscriptSegment`/`TranscriptSource` types
  (`src/shared/transcript.ts`).
- Refactor `CaptionBuffer.getTranscriptText()` to also expose
  `getSegments(): TranscriptSegment[]`; keep the text join as a render of
  segments.
- Make the popup Save path source-agnostic: it asks "is there a transcript for
  this recording?" rather than "scrape the active tab." Backward compatible —
  Meet still returns captions.

**Ships nothing user-visible; isolates everything below from the UI.**

### B1 — Audio sidecar for STT (behind a setting)

STT wants 16 kHz mono PCM; the recording produces a webm. Two options:

- **(chosen) Worklet tap → PCM sidecar.** Add an `AudioWorkletNode` on the
  existing mixed/tab `AudioContext` (`RecorderAudio.ts`) that downsamples to
  16 kHz mono and streams `Float32`/`Int16` frames to an **OPFS sidecar**
  (`{source}-{slug}-{dt}-audio16k.pcm`) during recording. Pros: directly yields
  model input, runs on the audio thread (off the encoder's hot path), reuses the
  AudioContext that already exists. Cons: ~115 MB/hour on disk — bounded and
  deleted right after STT (treat like the orphan backlog: capped, cleaned).
- **(alternative) Decode after the fact.** Skip the sidecar; post-recording,
  decode the sealed webm audio via `WebCodecs AudioDecoder` / `decodeAudioData`
  to PCM for STT. Pros: no extra disk during capture. Cons: a full decode pass
  and more code; revisit if sidecar disk cost bites.

Wire sidecar capture into the recording lifecycle next to the existing
recorders, **off by default**, gated by a Settings toggle ("Generate transcript
from audio"). Verify with the perf harness that the worklet adds no measurable
capture regression (it must not).

### B2 — Local-WASM batch transcription (delivers transcription everywhere)

- **Engine**: Whisper via WASM (whisper.cpp-wasm or transformers.js Whisper
  tiny/base) in a **dedicated Worker** hosted by the long-lived offscreen
  document. Model weights (~40–150 MB) fetched once as **data** and cached in
  OPFS/Cache. MV3 note: ship the wasm/JS *packaged* (no remote code); only the
  weights are fetched as data. CSP may need `wasm-unsafe-eval`.
- **Trigger**: a new finalize stage. After `RecordingFinalizer` seals the
  recording, if the audio sidecar exists, enqueue an STT job → worker
  transcribes the PCM → produces `TranscriptSegment[]` with timestamps.
- **Durability**: model the job like uploads — a marker so a crash/SW-suspend
  mid-transcription is retried, bounded per launch (mirror the orphan-recovery
  caps), sidecar deleted on success.
- **Output**: persist the transcript artifact (`.txt` like today, plus a
  structured `.json` of segments) next to the recording, and **optionally upload
  it to the same Drive folder** (reuse `folderNaming` + `DriveTarget`). The
  popup surfaces progress ("Transcribing… 40%") and then a download/open action.

After B2, **any** recording — any provider, or none — gets a transcript. This is
the tier that fulfils both of the user's ideas.

### B3 — Cloud STT backend (opt-in, consent-gated)

- A second backend behind the same `TranscriptSource='stt'` seam: stream/post
  the sidecar (or live audio) to a cloud STT API. Better accuracy + **speaker
  diarization** (which local Whisper doesn't give cheaply).
- Requires: the API host in `host_permissions`, auth/api-key handling, and an
  **explicit consent gate** (it sends meeting audio off-device). Off by default;
  local stays the default.

### B4 — Live streaming STT (optional, deferred)

Incremental segments during the recording (the Meet-captions-like live feel for
any provider). Highest perf/complexity risk because it reintroduces
during-capture compute. Only pursue if a live transcript is a product
requirement; the worklet tap from B1 is the feed.

### B5 — Additional DOM caption fast-paths (parallel, optional)

Independently, add `ZoomAdapter` / `TeamsAdapter` implementing
`MeetingProviderAdapter` for providers that *do* expose captions in a web
client, registered via Plan A's `meetingProviders` table + broadened
`content_scripts` matches and `host_permissions`. These are free, low-latency,
speaker-labeled fast-paths; STT (B2) is the universal fallback when they're
absent. Accept the selector-rot maintenance cost knowingly, per provider.

## Source selection policy

When both exist for a recording, prefer the richer source: **Meet captions**
(speaker-labeled, zero-cost) when present and complete; **STT** otherwise. Make
it a small explicit policy function over `Transcript.source`, not scattered
`if (provider === 'google-meet')` checks.

## Critical files

- `src/shared/transcript.ts` — **new** segment/source model (B0).
- `src/content/captionBuffer.ts` — emit `TranscriptSegment[]` (B0).
- `src/popup/PopupController.ts` / `popupMessages.ts` — source-agnostic Save +
  progress UI (B0/B2).
- `src/offscreen/RecorderAudio.ts` (+ a new AudioWorklet module) — PCM sidecar
  tap (B1).
- `src/offscreen/RecorderEngine.ts` — wire sidecar capture into start/stop (B1).
- `src/offscreen/stt/` — **new** Whisper worker + engine + job/marker (B2).
- `src/offscreen/RecordingFinalizer.ts` — post-seal STT stage + transcript
  persistence (B2).
- `src/offscreen/drive/folderNaming.ts` / `DriveTarget.ts` — transcript upload
  into the recording's folder (B2).
- `src/shared/settings.ts` + Settings UI — "transcribe from audio" toggle,
  backend choice, consent gate (B1/B3).
- `static/manifest.json` — cloud STT host (B3) and/or extra provider matches
  (B5). **Local-WASM needs no host change** beyond possibly a CSP tweak.

## Edge cases / guards

- **Perf is the headline guardrail**: STT runs *after* capture stops (batch). If
  B4 is ever pursued, it must prove no live-capture regression on the perf
  harness first.
- **Storage**: the PCM sidecar is large — bound it, delete on STT success,
  respect existing OPFS backpressure/failsafe; if disk is constrained, fall back
  to B1's decode-after-the-fact path.
- **MV3 remote-code rule**: STT engine code is packaged; only model weights are
  fetched (as data). No `eval` of remote code.
- **Failsafe semantics**: an STT job interrupted by SW suspend/offscreen reuse
  must resume next launch, bounded per run (reuse the orphan-recovery shape), and
  must never delete the sealed *recording* (only its own sidecar, on success).
- **Diarization gap**: local Whisper gives timestamps but not speakers — hence
  keeping the Meet fast-path (free speaker labels) and offering cloud (B3) for
  diarization elsewhere.

## Risks / product decisions (need an explicit stance)

- **Consent & legality** — transcribing *other participants'* audio, and
  (cloud) sending it off-device, has real implications in two-party-consent
  jurisdictions. Local-default mitigates; a clear consent UI is required before
  B3. This is a product decision, not an afterthought.
- **Backbone bet** — committing to STT-as-foundation (with DOM scrapers demoted
  to optional fast-paths) vs. a treadmill of per-provider scrapers. This plan
  takes the former; worth recording as an ADR alongside
  `docs/adr/0001-…` since it's a direction decision.

## Tests

- `CaptionBuffer.getSegments`: speaker/timing preserved; text render unchanged.
- Source-selection policy: captions-present → captions; captions-absent → STT.
- STT engine (worker mocked): PCM in → segments out; job marker written/cleared;
  interrupted job retried next launch and bounded per run; sidecar deleted only
  on success; **recording artifact never deleted** by the STT stage.
- Sidecar worklet: produces 16 kHz mono frames; absent when the toggle is off.
- Drive: transcript uploads into the recording's folder via `folderNaming`.
- Perf harness: sidecar tap adds no measurable capture regression.
- `npm run typecheck` + `npm run test:unit` green throughout.

## Verification

1. Unit + typecheck + perf-harness green.
2. Meet call with captions on: transcript still comes from captions (fast-path),
   speaker labels intact (regression).
3. **Solo lecture, no meeting**: record a narrated presentation tab → after
   Stop, local-WASM produces a timestamped transcript; `.txt`/`.json` saved and
   (if enabled) uploaded to the recording's Drive folder.
4. **Non-Meet meeting** (Zoom-web/Teams-web with captions off): STT still yields
   a transcript from audio — the provider-independence proof.
5. Crash mid-transcription (kill the SW): next launch resumes the STT job,
   bounded, and never harms the sealed recording.

## Relationship to Plan A

Plan A makes recording work everywhere; Plan B gives those everywhere-recordings
a transcript. They share Plan A's `meetingProviders` registry (B5 reuses it) and
`source` field (B2 names transcript artifacts with it). Recommended order: ship
Plan A first (cheap, independently valuable), then B0→B1→B2 to light up
universal transcription, with B3/B4/B5 as demand-driven follow-ons.

---

## Review against the shipped codebase (2026-09-18)

This plan was written before `local-text-processing` shipped. That work implemented B0, and — more importantly — settled several questions this plan still answers the old way. Nothing below is deleted; where the plan and this section disagree, **this section is current**.

### B0 is done

`src/shared/transcript.ts` carries `TranscriptSource = 'meet-captions' | 'stt'`, `TranscriptSegment` and `Transcript` exactly as §B0 specifies, with an IndexedDB aggregate keyed by `historyId`, media-relative pause-aware offsets, and `PlaybackManifest.transcriptStatus` driven by it. Topic analysis already consumes whatever transcript exists and never learns where the words came from.

**So `'stt'` is a source with no producer. That is the whole remaining gap.**

### B2's weight delivery is superseded by ADR-0007 D-13

> "Model weights (~40–150 MB) fetched once as **data** and cached in OPFS/Cache."

ADR-0007 settled the opposite for the embedding model, and the reasoning transfers unchanged: an ONNX export is a **computational graph**, not data, so MV3's remote-code rule applies to it. Everything ships packaged — runtime, graph and weights — and nothing is fetched. There is no weights origin, no `host_permissions` entry and no model cache.

That decision collides with this plan's purpose, which is the point of the spike below. ADR-0007 left exactly one door open: *a later ADR may externalize cryptographically pinned **raw tensor data only**.* Taking that door is a decision, not a default.

### B2's durability is now built, and must be reused rather than re-derived

> "model the job like uploads — a marker so a crash/SW-suspend mid-transcription is retried"

The marker pattern that sentence points at was **silently inert in production** until 2026-09-17: an offscreen document's `chrome` object is `runtime` only, and `platform/chrome/storage.ts` degrades to a no-op rather than throwing, so every marker write succeeded and stored nothing. See ADR-0007's D-24 and the repair on `main`.

An STT job should take the shape that now exists and is proven by two E2E durability tests:

- `createIndexedDbKeyValueArea` for durable state the offscreen document owns — never `chrome.storage`;
- a per-job outbox released only on background acknowledgement, durable row removed before the held payload;
- a completed result held until background has **stored** it, and counted as active work until then, so `closeForUpdate()` and every reload path refuse to tear the runtime down over it;
- the history tombstone as the fence against a result arriving for a deleted recording.

### Two integration points this plan cannot see, because they did not exist

**The analysis trigger fires too early for STT.** Topic analysis is queued in the run-finished hook, immediately after the final caption sweep. An STT transcript arrives *after* finalize, so on an STT-only recording that trigger finds nothing and never fires again. B2 must queue analysis when the transcript lands, not when the run ends.

**`AnalysisProvenance` records no transcript identity.** It captures the model, revision, dtype, dimensions, config hash and pipeline version — which is complete today only because a transcript is final before analysis begins. The moment STT can replace or extend one, a stored analysis silently describes an older transcript and nothing marks it stale. B2 must add a transcript fingerprint (source plus a digest over the segments) to provenance, mirroring `configHash`, and it has to land **with** B2 rather than after it.

### The sidecar has no owner

`recoverOrphanRecordings` matches `google-meet-{slug}-{datetime}-(recording|mic|self-video).(webm|mp4|m4a)` and nothing else — verified, not assumed. A `.pcm` sidecar is therefore never mistaken for an orphan recording, which is correct, and never collected either, which is not: a crash mid-recording leaves ~115 MB/hour in OPFS that nothing owns. B1 needs its own reconciliation with its own cap, or the sidecar needs a name the existing scanner understands.

### B1.5 — the model spike, before any size is chosen

The plan offers "whisper.cpp-wasm or transformers.js Whisper tiny/base" as if the choice were between engines. For this project's primary languages it is not: Meet captions fail for Russian and Ukrainian, which is *why* Plan B exists, and `tiny`/`base` are weak in exactly those languages. `small`/`medium` are 250 MB–1.5 GB against an extension that already ships ~104 MB.

**No size can be chosen without measurement**, so this spike comes before B1 and B2, in the shape ADR-0007's 4A used:

- transcribe a genuine Russian and a genuine Ukrainian sample — the same recordings 4B will calibrate against — with `tiny`, `base` and `small` in WASM;
- record **word error rate against a hand-corrected reference**, wall-clock against the reference machine as a real-time factor, peak memory, and packaged size per model;
- report the smallest model whose transcript is good enough to *segment and label*, which is a lower bar than a readable transcript and the only bar this pipeline needs;
- state plainly whether that model can be packaged, or whether D-13 must be amended for pinned tensor data.

Exit criterion: a measured table, and a recommendation that names the model, its cost and which of the two delivery shapes it forces. No B1 or B2 work starts before it.

### Sequencing note

Two heavy jobs now want the same data plane: STT and topic analysis. `AnalysisManager` runs at concurrency 1 by design, and an STT job in its own queue would contend with it for CPU, memory and — if a future model uses it — the GPU. Whichever lands second should share the first's queue rather than open a parallel one.
