# Settings — the recorder configuration schema & derive pipeline

> A **deep module** under `shared/`: it owns the user-facing extension settings, their persistence and normalization, and the *derivation* of the concrete numbers the recorder consumes. Callers import only from `index.ts` — `model.ts` / `store.ts` / `normalize.ts` / `defaults.ts` are internal. For symbol-level structure use codegraph (`codegraph_explore "ExtensionSettings buildRecorderRuntimeSettingsSnapshot"`).

> **Archetype:** *Reference Catalog*. The valuable thing here is an accurate, complete **reference** — the full settings matrix and exactly how each field becomes a recorder parameter. So this README leads with the schema tables and the derive pipeline rather than prose. If you read one section, read **The settings schema**.

## Purpose & mental model

The single source of *configuration*. Two responsibilities: (1) hold the user's choices (`ExtensionSettings`, persisted in `chrome.storage.local`), and (2) **derive** them into the exact numeric `RecorderRuntimeSettingsSnapshot` the offscreen recorder needs. The mental model: **the Settings page edits the schema; the background freezes a derived snapshot at `start()` and ships it in `OFFSCREEN_START`** — so a run's configuration is fixed for its whole duration and a mid-run settings change can't perturb an active recording.

## The settings schema

`ExtensionSettings` (`model.ts`) splits into a **basic** tab (the common controls) and a **professional** tab (encode tuning):

### basic

| Field | Type | Drives |
| :--- | :--- | :--- |
| `recordingMode` | `'opfs' \| 'drive'` | `RunConfig.storageMode` (`opfs`→`local`) |
| `microphoneRecordingMode` | `'off' \| 'mixed' \| 'separate'` | `RunConfig.micMode` |
| `separateCameraCapture` | `boolean` | `RunConfig.recordSelfVideo` |
| `selfVideoResolutionPreset` | `640x360 \| 854x480 \| 1280x720 \| 1920x1080` | camera `getUserMedia` target dimensions |
| `selfVideoUseAutoResolution` | `boolean` | record the browser-delivered resolution, **skip the resize re-rasterization** |

### professional

| Field | Drives |
| :--- | :--- |
| `selfVideoBitrate`, `selfVideoMinAdaptiveBitrate`, `selfVideoFrameRate` | camera encode profile (bitrate ceiling/floor, fps) |
| `tabResolutionPreset`, `tabMaxFrameRate`, `tabVideoBitrate` | tab capture target + reference bitrate |
| `microphoneEchoCancellation`, `microphoneNoiseSuppression`, `microphoneAutoGainControl` | mic `getUserMedia` constraints (DSP) |
| `chunkDefaultTimesliceMs`, `chunkExtendedTimesliceMs` | `MediaRecorder` timeslice selection |

(That every one of these reaches the recorder is verified end-to-end by the real-hardware *settings matrix* check, not just by unit tests.)

## The derive pipeline

```mermaid
flowchart LR
    U["ExtensionSettings (basic + professional)"] --> D["derive helpers (store.ts)"]
    D --> RS["RecorderRuntimeSettingsSnapshot<br/>tab / selfVideo / microphone / chunking"]
    RS -->|frozen at start| R["OFFSCREEN_START → recorder"]
```

The derive helpers turn *choices* into *numbers*:

- **`resolveTabVideoBitrate`** scales the configured 1080p reference bitrate by `(width × height × fps) / referencePixelsPerSecond`, clamped to `[TAB_MIN_VIDEO_BITRATE, MAX_TAB_VIDEO_BITRATE]` — so **lowering the tab resolution preset lowers the encoded bitrate proportionally**, automatically.
- **`getSelfVideoProfileSettings`** maps the preset to dimensions + carries the adaptive bitrate floor/ceiling and the `autoResolution` flag.
- **`getMicrophoneCaptureSettings`** / **`getChunkingSettings`** pass the DSP toggles and timeslice timings through.
- **`buildRecorderRuntimeSettingsSnapshot`** assembles all of the above into the one frozen object the background sends down. `buildDefaultRunConfigFromSettings` derives the popup's default `RunConfig`.

## Persistence & the deep-module boundary

- **`store.ts`** keeps an in-memory `runtimeSettings` cache and `load`/`save`/`reset` against `chrome.storage.local` (key `EXTENSION_SETTINGS_STORAGE_KEY`). When the storage area is absent (e.g. the e2e tab-capture runtime), it **degrades to defaults** rather than throwing.
- **`normalize.ts`** is the trust boundary: `normalizeExtensionSettings` coerces any persisted/incoming value into a valid, fully-populated `ExtensionSettings` (every field defaulted), so downstream derive code never sees a partial object.
- **Legacy migration is built in.** `normalizeLegacyVideoFormat` upgrades the *old numeric* self-video size (`1080 | 720 | 480 | 360`, used before preset selectors existed) into a `ResolutionPreset`, so settings persisted by an older version load losslessly — no migration script. Validation is **bounded**: `normalizePositiveInt` clamps numeric fields to a `[min, max]`, and unknown enum values coerce to the default.
- **The public surface is `index.ts`.** Nothing outside this folder should import `model`/`store`/`normalize`/`defaults` directly.

## Key invariants & gotchas

- **Import from the module index, not internal files** — that boundary is what lets the internals evolve.
- **Normalize on every read.** Persisted settings are untrusted (old versions, manual edits); `normalizeExtensionSettings` is the only safe entry.
- **Tab bitrate is derived, not stored raw.** Don't set a tab bitrate directly expecting it to stick at any resolution — it's scaled from the 1080p reference by `resolveTabVideoBitrate`.
- **A run's settings are frozen at `start()`.** Editing settings mid-recording affects only the *next* run; the active run uses its snapshot.
- **`selfVideoUseAutoResolution` short-circuits the resize.** It's the lever that trades enforced dimensions for skipping the per-frame re-rasterization.

## Files

| File | Role |
| :--- | :--- |
| `index.ts` | the public interface (the only import surface) |
| `model.ts` | `ExtensionSettings` + the derived `*Settings` / `RecorderRuntimeSettingsSnapshot` types |
| `defaults.ts` | `DEFAULT_EXTENSION_SETTINGS`, storage key, bitrate reference/clamp constants |
| `normalize.ts` | `normalizeExtensionSettings`, preset→dimensions, clone/normalize the recorder snapshot |
| `store.ts` | in-memory cache, load/save/reset, all the derive helpers |
| `validate.ts` | bounded validators (`normalizePositiveInt` min/max clamps, `readBoundedPositiveInt`) used by normalize |

Consumers: the **Settings page** (`../../settings.ts`) edits the schema; the **popup** derives its default `RunConfig`; the **background** freezes `buildRecorderRuntimeSettingsSnapshot` into `OFFSCREEN_START`; the **offscreen** recorder (`RecorderProfiles`, capture) consumes the snapshot.

## Testing notes

- `__tests__/extensionSettings.test.ts` and `settings.test.ts` cover normalization (partial/invalid → defaulted), the derive math (especially `resolveTabVideoBitrate` scaling + clamping), and the run-config derivation.
- Normalization and derivation are pure given a settings object — test with values, no storage mock needed (the storage seam is `hasLocalStorageArea`/`get`/`set`, mocked separately).

## Related

- [`offscreen`](../../offscreen/README.md) — `RecorderProfiles` and capture consume the frozen snapshot (MIME/bitrate/timeslice policy).
- [`background`](../../background/README.md) — freezes the snapshot at `start()` and sends it in `OFFSCREEN_START`.
- [Perf roadmap](../../../docs/plans/perf-optimization-roadmap.md) — `PerfFlags` are a **separate** runtime-flag system from these user settings; don't conflate them.

## External references

- MDN — [`MediaTrackConstraints`](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints) (the resolution/frameRate/DSP constraints these fields populate) and [`MediaRecorder` options](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/MediaRecorder#options) (`videoBitsPerSecond`, `timeslice`).
- Chrome — [`chrome.storage.local`](https://developer.chrome.com/docs/extensions/reference/api/storage) (where settings persist across restarts).
