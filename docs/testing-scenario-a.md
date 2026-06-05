# Scenario A: Mock Google Meet E2E Testing

This guide is the human- and agent-readable operating manual for the
deterministic Playwright suite. It covers functional tests, the full performance
matrix, mocked Drive uploads, media artifact analysis, and the optional physical
microphone/camera tier.

## What Scenario A Runs

Playwright launches a persistent Chromium context with the real unpacked MV3
extension. Requests for `https://meet.google.com/abc-defg-hij` are fulfilled with
`tests/fixtures/mock-meet.html`.

The test still crosses the extension's production runtime boundaries:

- content script on a `meet.google.com` origin;
- popup/settings pages and background service worker;
- offscreen document, recorder tasks, OPFS, finalizer, and downloads;
- fake microphone/camera devices by default;
- deterministic captions, participants, DOM replacement, and animation load;
- simulated Drive folder and resumable-upload HTTP protocol;
- Chromium and extension performance diagnostics;
- FFprobe/FFmpeg validation of finalized media.

Playwright cannot reliably grant the toolbar-triggered `activeTab` permission
needed by `chrome.tabCapture`. The E2E build therefore uses a deterministic
synthetic tab stream with synchronized visual and audio markers.

`dist-e2e/` contains two separately guarded capabilities:

- synthetic tab capture;
- fake OAuth plus the background fetch bridge used by the Drive simulator.

The production build must not contain either capability. Verify this with:

```bash
npm run build
npm run test:production-guards
```

## Installation

```bash
npm install
npx playwright install chromium
```

Artifact analysis also requires `ffmpeg` and `ffprobe`:

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y ffmpeg
```

## Test Tiers

| Command | Coverage |
| :--- | :--- |
| `npm run test:e2e:mock` | Functional mocked-Meet tests plus performance smoke |
| `npm run test:e2e:perf:smoke` | Critical 360p local, 1080p three-stream local, and three-stream Drive cases |
| `npm run test:e2e:perf:full` | Smoke, profiles, streams, cameras, workloads, flags, Drive, pairwise interactions, and reliability |
| `npm run test:e2e:perf` | Alias for the full tier |
| `npm run test:e2e:perf:endurance` | Ten-minute local recording and two-minute throttled Drive recording/upload |
| `npm run test:e2e:perf:hardware` | Headed physical microphone/camera validation |
| `npm run test:e2e:live` | Manual real-Meet calibration path |

Use a visible browser for investigation:

```bash
PW_HEADLESS=0 npm run test:e2e:mock
```

Run a single scenario:

```bash
npm run build:e2e:mock
npx playwright test --config=playwright.config.ts --grep "Drive partial-commit"
```

Durations can be shortened for local wiring checks:

```bash
PERF_CASE_SECONDS=2 \
PERF_SMOKE_TAB_SECONDS=3 \
PERF_SMOKE_MEDIA_SECONDS=3 \
npm run test:e2e:perf:full
```

Do not use reduced durations as benchmark results. The committed defaults define
the measured tiers.

## Coverage Matrix

The performance spec is tagged and data driven:

- **Smoke:** `640x360@24` tab-only local for 8 seconds.
- **Smoke:** `1920x1080@30` tab plus separate mic and camera for 10 seconds.
- **Smoke:** three streams followed by successful mocked Drive upload.
- **Profiles:** all four tab presets at 15, 24, and 30 FPS.
- **Streams:** mic off, mixed, separate, mixed plus camera, separate plus camera.
- **Camera:** all four presets with requested-versus-delivered diagnostics.
- **Workloads:** minimal, normal, caption-heavy, participant-heavy, combined.
- **Flags:** audio bridge, timeslice, adaptive camera bitrate, Drive chunk sizing,
  and upload concurrency.
- **Drive:** fast, throttled, transient retry, partial commit, token refresh,
  permanent failure with local fallback, sequential, and parallel uploads.
- **Reliability:** cold/warm behavior, failure recovery, one discarded warm-up
  plus five measured runs, and 20 start/stop cycles.
- **Endurance:** ten-minute three-stream local and two-minute throttled Drive.

The suite uses generated pairwise coverage for cross-factor interactions instead
of a full Cartesian product. Structural cells run once. The repeatability case
reports the median and p95 of five measured runs after discarding one warm-up.

## Important Files

| File | Responsibility |
| :--- | :--- |
| `tests/e2e/mock-meet-extension.spec.ts` | Functional scenarios |
| `tests/e2e/mock-meet-performance.spec.ts` | Tagged performance matrix |
| `tests/e2e/helpers/extensionHarness.ts` | Typed browser/extension harness |
| `tests/e2e/helpers/performanceRunner.ts` | One complete measured recording case |
| `tests/e2e/helpers/driveSimulator.ts` | Stateful Drive protocol simulator |
| `tests/e2e/helpers/mediaAnalysis.ts` | FFprobe/FFmpeg analysis |
| `tests/fixtures/mock-meet.html` | Deterministic Meet DOM and workloads |
| `playwright.config.ts` | Timeouts, reporters, traces, screenshots, and output |
| `scripts/check-production-build.mjs` | Production E2E-capability guard |

## Adding Functional Scenarios

Use the shared harness rather than copying browser setup:

```ts
const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
try {
  const meetPage = await openMockMeetPage(harness.context);
  const tabId = await findMockMeetTabId(harness.controlPage);

  await saveRecordingSettings(harness.controlPage, {
    recordingMode: 'opfs',
    micMode: 'off',
    tabResolution: '640x360',
    tabFrameRate: 24,
  });
  await startRecording(harness.controlPage, tabId, {
    storageMode: 'local',
    micMode: 'off',
    recordSelfVideo: false,
  });

  // Exercise observable behavior through meetPage or runtime messages.

  await stopRecording(harness.controlPage);
  await waitForCompletedDownloads(
    harness.controlPage,
    harness.downloadsDir,
    1
  );
} finally {
  await closeHarness(harness);
}
```

Prefer fixture functions exposed on `window.mockMeet` for deterministic Meet
changes. Wait for observable extension state rather than arbitrary delays.

## Adding Performance Scenarios

For a normal matrix cell, call `runPerformanceCase`. It handles browser launch,
settings, debug retention, recording, Drive routing, finalization, diagnostics,
CDP metrics, artifact analysis, attachments, assertions, and cleanup.

```ts
test('@perf-full workload custom', async ({}, testInfo) => {
  const result = await runPerformanceCase(testInfo, {
    id: 'workload-custom',
    durationMs: 4_000,
    storageMode: 'local',
    micMode: 'separate',
    recordSelfVideo: true,
    tabResolution: '1280x720',
    tabFrameRate: 30,
    selfVideoResolution: '640x360',
    selfVideoFrameRate: 30,
    workload: {
      participants: 24,
      animationComplexity: 40,
      captionIntervalMs: 100,
      replacementIntervalMs: 500,
    },
    perfSettings: {
      extendedTimeslice: true,
    },
  });

  expect(result.snapshot.summary.storage.currentPendingWrites).toBe(0);
  expect(result.artifacts).toHaveLength(3);
});
```

Choose the tag based on execution cost:

- `@perf-smoke`: required on every PR;
- `@perf-full`: daily matrix and manually dispatched full runs;
- `@perf-endurance`: weekly or manual long runs;
- `@perf-hardware`: manually dispatched self-hosted hardware only.

Do not introduce E2E branches without a compile-time guard. Add a forbidden
production marker to `scripts/check-production-build.mjs` when a new E2E-only
capability is required.

## Mock Workloads

`window.mockMeet.startWorkload(...)` supports:

```ts
await meetPage.evaluate(() => {
  window.mockMeet.startWorkload({
    participants: 64,
    animationComplexity: 100,
    captionIntervalMs: 50,
    replacementIntervalMs: 250,
  });
});
```

This drives participant count, caption mutation rate, caption-container
replacement, canvas animation pressure, and combined load in a repeatable way.
Use `window.mockMeet.getStats()` to verify the requested workload was applied.

## Mock Drive

Set `storageMode: 'drive'` and choose a `driveProfile`:

```ts
const result = await runPerformanceCase(testInfo, {
  // other required case fields
  storageMode: 'drive',
  driveProfile: 'partial-commit',
});
```

Supported profiles are `fast`, `throttled`, `retry`, `partial-commit`,
`token-refresh`, and `permanent-failure`. The simulator records folder calls,
resumable sessions, PUTs, status probes, auth failures, committed bytes, and
maximum concurrent uploads in `result.drive`.

`permanent-failure` is expected to exercise per-file local fallback. Other Drive
profiles fail if an unexpected local download occurs.

## Metrics And Assertions

The retained `PerfDebugSnapshot` contains complete raw events plus summaries for:

- capture acquisition and requested/delivered settings;
- recorder start, stop, chunks, bytes, throughput, percentiles, and artifacts;
- OPFS open, write, close, cleanup, queues, and failures;
- local/Drive finalization and download latency;
- caption mutations, source/processing latency, coalescing, and observers;
- lifecycle starts, stops, failures, warnings, tracks, and recorder counts;
- Drive sessions, chunks, retries, throughput, fallback, and concurrency;
- runtime heap, event-loop lag, and long tasks where Chromium exposes them.

Every measured case also collects:

- page `Performance.getMetrics`;
- browser process CPU time by process type;
- GPU device metadata and video-encoding capabilities;
- FFprobe codec, streams, duration, dimensions, FPS, frames, bitrate, and size;
- FFmpeg silence, clipping inputs, black/frozen frames, A/V duration drift, and
  synchronized marker drift where detectable.

Experimental or platform-dependent metrics are nullable. Structural failures are
hard gates: negative metrics, missing events/streams, leaked tracks or pending
writes, broken artifacts, wrong dimensions/codecs/duration, excessive silence,
black/frozen output, Drive protocol errors, and deterministic flag regressions.
Tab dimensions are exact because the synthetic source is deterministic. Camera
artifacts must match the delivered aspect ratio; Chromium and physical devices
may encode a native size even when `MediaTrackSettings` reports the requested
size, so both delivered and encoded dimensions remain in the JSON report.

CPU, heap, lag, throughput, bitrate, file size, and absolute latency are reports
until at least ten stable runs exist on the same runner class. Then introduce
runner-specific median/p95 budgets; do not use one universal machine threshold.

## Reports And Failure Artifacts

Each performance case attaches:

- `<case>-performance-report.json`;
- `<case>-perf-debug-snapshot.json`;
- media analyses and finalized downloads when applicable;
- Playwright trace, screenshot, and video on failure.

Outputs are under:

```text
output/playwright/test-results/
output/playwright/html-report/
```

Open a retained trace with:

```bash
npx playwright show-trace output/playwright/test-results/<test>/trace.zip
```

CI uploads the complete `output/playwright` directory.

## Physical Hardware Tier

The hardware tier retains mocked Meet and synthetic tab capture but removes
Chromium's fake-device flags. It uses the operating-system default microphone
and camera:

```bash
npm run test:e2e:perf:hardware
```

Requirements:

- run on a machine with a camera and microphone;
- allow Chromium camera/microphone access in the operating system;
- allow access for the extension when prompted;
- use a self-hosted runner labelled `self-hosted` and `hardware-media` in CI.

The command sets `PW_REAL_MEDIA=1`, runs headed, probes both devices first, and
skips with a clear reason if permission or tracks are unavailable. Device labels
are written only to the local `hardware-probe.json` test artifact.

An optional controlled physical synchronization cue is available:

```bash
PERF_HARDWARE_MARKER=1 npm run test:e2e:perf:hardware
```

This flashes and sounds a marker five seconds into the mocked meeting. Position
the camera and microphone to observe it. The artifact analyzer reports marker
drift when both detections are available.

## CI Schedule

- Pull requests and `main` pushes: unit tests, source and E2E type checks,
  production build/guards, functional E2E, and performance smoke.
- Daily at `02:00 UTC`: full pairwise matrix and repeated benchmarks.
- Weekly Sunday at `03:00 UTC`: endurance tier.
- Manual dispatch: full, endurance, or labelled self-hosted hardware tier.

JSON reports, snapshots, traces, FFmpeg analyses, and failed media are uploaded
as workflow artifacts.

## Limitations

Scenario A does not measure production Meet rendering, network behavior, account
login, invitations, host admission, or Chrome's real tab compositor. Synthetic
tab capture validates the extension pipeline, not toolbar permission behavior.
Hardware results vary by device, driver, room, and operating system.

Keep `npm run test:e2e:live` as the manual production-DOM and real-tab-capture
calibration tier. It complements Scenario A; it is not a deterministic CI gate.
