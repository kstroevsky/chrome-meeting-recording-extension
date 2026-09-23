# Offscreen Engine — the recorder core (capture → encode → artifacts)

> The media engine of the [offscreen runtime](../README.md): it acquires the capture streams, runs a `MediaRecorder` per stream, and hands sealed artifacts to the storage layer. For symbol-level structure use codegraph (`codegraph_explore "RecorderEngine RecorderProfiles startTabRecorder"`). Where the bytes *go* after the recorder emits them is [`offscreen/storage`](../storage/README.md); this folder is everything up to `ondataavailable`.

> **Archetype:** *Media Pipeline* (an altered Resilience-Subsystem — storage owns the durability/failure story, so this README leads with the **dataflow** and the **audio graph** instead of a failure table). The hard parts here are the multi-stream parallel startup, the Web Audio mixing, and actuating live controls without interrupting capture. If you read one section, read **The capture → encode pipeline**.

## Purpose & mental model

Turn one tab-capture stream id (plus optional mic and camera) into one-to-three encoded artifacts: WebM or MP4 for video, and WebM or M4A for a separate microphone. The mental model is **N independent per-stream recorders started in parallel, with one load-bearing stream**: the **tab** recorder is required (its failure aborts the run); the **separate mic** and **self-video** recorders are optional (their failures are warned and degraded, never fatal). The engine owns stream lifetimes, live actuation (mute/hide/pause), and actual tab-resolution reporting; it does *not* decide policy (that's the [background](../../background/README.md)) or persist bytes (that's [storage](../storage/README.md)).

## The capture → encode pipeline

```mermaid
flowchart TD
    SID["OFFSCREEN_START (streamId, settings)"] --> CAP["captureTabStreamFromId (chromeMediaSource: tab)"]
    CAP --> PB["ensureAudiblePlayback (replay tab audio to speakers)"]
    CAP --> MM{"micMode?"}
    MM -->|mixed| MIX["MixedAudioMixer: tab + mic into one stream"]
    MM -->|"separate / off"| TABS["tab stream as-is"]
    MIX --> TR["tab MediaRecorder (extended timeslice)"]
    TABS --> TR
    MICSEP["separate mic getUserMedia"] --> MR["mic MediaRecorder (default timeslice)"]
    CAM["self-video getUserMedia (constraint ladder)"] --> RS["resize if delivered != preset"]
    RS --> SVR["self-video MediaRecorder (extended timeslice)"]
    TR --> CH["ondataavailable → makeChunkHandler → storage"]
    MR --> CH
    SVR --> CH
```

`startFromStreamId` acquires the tab stream, sets up audible playback, builds the optional streams, then starts all recorders in **parallel** (`Promise.all` over `buildRecorderStartTasks`). The tab task is un-caught (its rejection aborts the start); the optional tasks are `.catch`-warned.

## The engine state machine

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> starting: startFromStreamId
    starting --> recording: all start tasks resolved
    starting --> idle: start threw (reset run state)
    recording --> stopping: stop()
    stopping --> idle: all artifacts sealed
    note right of starting
        a monotonic runId guards staleness;
        isStale() short-circuits late start tasks
    end note
```

A monotonic **`runId`** (bumped each `startFromStreamId`) is the staleness guard: any task that resolves after a stop/new-run checks `isStale()` and bows out, so a slow camera acquisition from an abandoned run can't attach to the live one.

The engine reads the actual width and height from the acquired tab video track and includes them in the first `recording` phase report. Requested presets remain ceilings; the popup and diagnostics can therefore distinguish Chrome's delivered tab resolution from the requested one without guessing from encoder settings.

## Mic modes & the audio graph

Three modes (`off` / `mixed` / `separate`):

- **`mixed`** folds the mic into the tab recording via a real Web Audio graph (`MixedAudioMixer`) — there is no separate mic file:

```mermaid
flowchart LR
    TA["tab audio track"] --> SRC1["MediaStreamSource"]
    MA["mic audio track"] --> SRC2["MediaStreamSource"]
    SRC1 --> DST["MediaStreamDestination"]
    SRC2 --> DST
    TV["tab video track"] --> OUT["mixed MediaStream (tab video + mixed audio)"]
    DST --> OUT
    OUT --> REC["tab MediaRecorder"]
```

- **`separate`** records the mic as its own audio-only file (its own `MediaRecorder`).
- **`off`** acquires no mic.


**`ensureAudiblePlayback`** (the `AudioPlaybackBridge`) replays the captured tab audio back to the speakers — `tabCapture` mutes the tab locally while capturing, so without this the user hears nothing during recording.

## Self-video: constraint ladder, adaptive bitrate, resize

- **Constraint ladder** (`getSelfVideoConstraintRequests`): try `exact-size-and-fps` → `exact-size` → `best-effort`, so a camera that can't hit the exact preset still yields a usable stream.
- **Resolution enforcement / resize:** if the delivered track resolution ≠ the preset, a per-frame resize re-rasterizes to the target. `selfVideoUseAutoResolution` **skips** this (records the browser-delivered resolution), trading enforced dimensions for the CPU of the resize pump.
- **Adaptive bitrate** (`resolveSelfVideoBitrate`, gated by the `adaptiveSelfVideoProfile` flag): estimate `width × height × fps × SELF_VIDEO_QUALITY_FACTOR` (0.05 bits/pixel/frame — a webcam talking head is low-motion, so it needs far fewer bits/pixel than general video), clamped to `[minAdaptive, configured]` — so a camera delivering less than the preset doesn't waste bits, and one delivering the full preset gets the configured ceiling.

## Codec & timeslice policy (`RecorderProfiles`)

- **Format profiles are resolved before stream acquisition.** Each selected format resolves to `{ recorderMimeType, contentType, extension }`, and that exact profile travels through the `MediaRecorder`, filename builder, storage target, sealed artifact, downloads, and Drive upload. The default WebM profiles retain their VP8/Opus (tab), VP8 (camera), and Opus (mic) preferences.
- **MP4/M4A candidates are native only.** Tab MP4 prefers H.264/AAC, then VP9/Opus, AV1/Opus, then browser-selected `video/mp4`; camera MP4 prefers H.264, then VP9, AV1, then browser-selected `video/mp4`; M4A requires `audio/mp4;codecs=mp4a.40.2`. `MediaRecorder.isTypeSupported()` chooses the first supported candidate — there is no transcoding.
- **No silent container fallback.** A stale MP4/M4A setting that is no longer supported fails startup with an actionable Settings error. Format capability is ignored for a disabled camera/microphone and for a mixed microphone, which is part of the tab artifact and therefore uses the tab profile.
- **Content hints**: each recorded video track is tagged with a `MediaStreamTrack.contentHint` — camera → `motion` (a talking head; bias toward temporal smoothness), tab → `text` for `screen` content / `motion` for `video` content — an advisory hint that steers the encoder's rate/quality tradeoff. Best-effort: `MediaRecorder` may ignore it.
- **Timeslice** (`getChunkTimesliceMs`): tab + self-video use the **extended** (longer) cadence — fewer, larger OPFS writes cut churn; a crash loses at most one timeslice of unflushed buffer, and a power cut is bounded by storage's ~10 s flush window anyway. The mic stays on the **default** (shorter) cadence unless `extendedTimeslice` opts it in.

## Live controls (actuation, not policy)

The popup toggles, the background commands, the engine **actuates** — never interrupting capture:

- **mute mic** → the mic track is silenced (records silence); **hide camera** → black frames; both via per-stream control callbacks captured at start.
- **pause** (`setPaused` / `applyPauseState`) pauses every recorder *and* idles the upstream producers, **in order**: on resume, restart producers (mixer/self-video) *before* the recorders so frames/audio are already flowing; on pause, idle producers *after* the recorders so no work is wasted. A toggle during `starting` is applied to recorders as they come up.
- **switch input device** replaces the live microphone/camera source behind the existing recorder path so the artifact timeline stays continuous. A physical picker choice pins that device for the run. Selecting the microphone's `default` alias keeps follow-default mode active; on `devicechange` the engine reopens that alias so Chrome resolves the current browser/OS default even when offscreen enumeration hides physical IDs. Camera follow-default still compares the first enumerated camera because there is no equivalent reliable virtual video alias.
- **stop/discard during startup** is valid. If device acquisition resolves after the engine has left `starting`, it releases the just-acquired tracks instead of starting a late recorder. If a stop wins before any recorder reaches `onstart`, the engine still completes cleanup and resolves the stop path.

## Key invariants & gotchas

- **The tab stream is load-bearing.** Its recorder task is the one not swallowed — a tab failure aborts the whole run; optional streams degrade.
- **The resolved profile is part of the artifact contract.** Keep its recorder MIME, base content type, and filename extension together; deriving a content type from an assumed `.webm` file breaks downloads and Drive uploads for MP4/M4A.
- **Stop the mic *source* track before nulling `micStream`.** Stopping a `MediaRecorder` does **not** stop its source track; in `separate` mode the engine owns that track, so the `onStopped` callback stops it first (`safeStopStream`, idempotent) — otherwise the OS mic indicator stays lit after recording ends. (This was a real regression; the fix lives in `buildRecorderStartTasks`.)
- **`runId` is the staleness fence.** Every async task re-checks it; don't attach a recorder without the `isStale()` guard.
- **Pause ordering matters** — producers and recorders start/stop in the opposite order on pause vs. resume (see above) to avoid black/blank filler and wasted mixing.
- **`default` microphone is semantic, not a physical ID.** Keep `followsDefaultInput.microphone` true when that alias is selected; otherwise an OS default change silently leaves the recording on the old device.
- **Stop owns all source cleanup.** The mic analyser, microphone stream, tab stream, mixer, and playback bridge must be released whether stop happens during startup, normal recording, or a partial optional-stream failure.

## Files

| File | Role |
| :--- | :--- |
| `../RecorderEngine.ts` | the orchestrator: acquire → parallel start → stop → seal; live-control actuation |
| `TabRecorderTask.ts`, `MicRecorderTask.ts`, `SelfVideoRecorderTask.ts` | per-stream start/stop, each owning its `MediaRecorder` + storage target |
| `RecorderEngineSetup.ts`, `RecorderTaskUtils.ts` | start-task helpers, `openStorageTarget` + `makeChunkHandler` (the storage seam) |
| `RecorderEngineTypes.ts` | `StorageTarget`, `SealedStorageFile`, `CompletedRecordingArtifact`, `InMemoryStorageTarget`, `RecorderEngineDeps` |
| `../RecorderProfiles.ts`, `../../shared/recordingFormats.ts` | MIME / container / bitrate / timeslice / self-video-constraint policy |
| `../RecorderCapture.ts` | tab/mic/self-video media acquisition |
| `../RecorderAudio.ts` | `MixedAudioMixer` (mixed mode) + `AudioPlaybackBridge` (audible playback) |
| `../SelfVideoResize.ts` | the insertable-streams per-frame resize to the preset |
| `../RecorderSupport.ts` | recorder media-error formatting (`describeMediaError`) |

(Several collaborators sit at the `offscreen/` root rather than in `engine/` — they're cross-referenced above.)

## Observability

The engine emits the `lifecycle.*` events (`start_requested`/`start_completed`, `stop_requested`/`stop_completed`, `failure`, recorder/required-stream failures) and the `capture.*` / `recorder.*` metrics (per-stream attempt/success/failure, requested-vs-delivered profile, start latency, chunk throughput, seal duration, last bitrate/timeslice). `background/observability/perf/PerfDebugStore` keeps the rich development timeline/distributions for [`debug`](../../debug/README.md); the allowlisted production reducer separately keeps bounded counts/totals/maxima and turns terminal recorder or required-stream failures into sanitized incidents. Neither path can include media bytes or device labels.

## Testing notes

- `__tests__/RecorderEngine.test.ts` drives start/stop/pause/device switching and the per-stream task wiring against mocked `MediaRecorder`/streams—including regressions for late startup after stop/discard, actual tab-resolution reporting, the live `default` microphone alias after `devicechange`, and stopping the separate-mic source track (the lingering-mic-indicator bug).
- `RecorderProfiles`, `SelfVideoResize`, `RecorderCapture` have focused unit tests; real encode/CPU behavior is only meaningful on real hardware → the `@perf-*` e2e tiers, not jsdom.

## Related

- [`offscreen/storage`](../storage/README.md) — where `ondataavailable` chunks go (the `makeChunkHandler` seam).
- [`shared/settings`](../../shared/settings/README.md) — the frozen `RecorderRuntimeSettingsSnapshot` this engine consumes.
- [Perf roadmap](../../../docs/plans/perf-optimization-roadmap.md) — the candidate WebCodecs encode path for self-video; `adaptiveSelfVideoProfile` / `extendedTimeslice` flags.

## External references

- MDN — [`MediaRecorder`](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder) (and [`isTypeSupported`](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported)), [`MediaDevices.getUserMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) (the mixing graph).
- Chrome — [`chrome.tabCapture`](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) (why captured tab audio needs the playback bridge).
- MDN — [Insertable streams / `MediaStreamTrackProcessor`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor) (the self-video resize) and [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) (the roadmap encode path).
