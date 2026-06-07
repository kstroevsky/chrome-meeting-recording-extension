# Scenario B: Real Google Meet Live Calibration

Scenario B drives the **real production Google Meet** in **stable Google Chrome**
with a **signed-in account**, real `chrome.tabCapture`, and the real
operating-system **camera and microphone** used concurrently by Meet and the
extension. It is a **manual, headed calibration tier**: a host admits the test
account, and a human grants OS permissions once.

It complements — and does not replace — the deterministic
[Scenario A mock suite](testing-scenario-a.md), which remains the CI gate.
Scenario B is **not** a CI gate.

## How Scenario B differs from Scenario A

| | Scenario A (mock) | Scenario B (live) |
| :-- | :-- | :-- |
| Browser | bundled Chromium | stable Google Chrome (signed-in) |
| Meet page | `tests/fixtures/mock-meet.html` route | real `meet.google.com` |
| Tab capture | deterministic synthetic stream | real `chrome.tabCapture` via the `Control+Shift+9` user gesture |
| Devices | fake by default (real in the hardware tier) | always the real OS camera + microphone |
| Build | `dist-e2e` (`build:e2e:mock`) | `dist` (`dev --env e2eRealCaptureTab=1`) |
| Admission | none | host admits the account |
| Role | deterministic CI gate | manual real-world calibration |

## What it validates

- Production Meet pre-join, join/admission, and content-script provider detection.
- Real `chrome.tabCapture` acquired through the genuine `activeTab` gesture.
- Every Settings-page control reaching capture/recorder diagnostics (the perf
  snapshot asserts requested tab/camera resolution, frame rate, bitrate,
  timeslice, and the microphone echo/noise/AGC constraints — requested and
  applied).
- Concurrent OS camera/microphone use by Meet and the extension, plus
  device reacquisition across repeated start/stop cycles.
- Finalized `webm` artifacts via FFprobe/FFmpeg plus audio/video signal quality.

The runner always executes `npm run dev -- --env e2eRealCaptureTab=1` first, so
`dist/` contains real capture **and** development diagnostics (perf events). It
never loads `dist-e2e`, never installs the mock Meet route, and never enables
fake media devices.

## Prerequisites

- `ffmpeg` and `ffprobe` on `PATH` (`brew install ffmpeg`).
- A **dedicated Google test account** — do not use your everyday Chrome profile,
  and do not copy cookies or profile files from it.
- **Stable Google Chrome** installed (the default `--browser chrome`).
- The native-input tool for the recording gesture: macOS `osascript` (built in),
  Linux `xdotool`, Windows PowerShell `SendKeys` (built in).

## Permissions (one-time)

1. **OS camera + microphone for Google Chrome.**
   macOS: **System Settings → Privacy & Security → Camera** and **→ Microphone**,
   enable *Google Chrome*. The in-page Meet/extension permission prompt is
   auto-accepted by the harness, so no manual click is required.

2. **Accessibility for the app that launches the test** (Terminal, iTerm, or the
   Codex/agent app). macOS: **System Settings → Privacy & Security →
   Accessibility**, enable that app. This is required because the harness sends a
   real `Control+Shift+9` keystroke through the OS — Chrome only grants
   `activeTab` to `chrome.tabCapture` after a genuine user gesture. Verify it is
   active (exit code `0`, no error):

   ```bash
   osascript -e 'tell application "System Events" to key code 25 using {control down, shift down}'
   ```

   Linux: `sudo apt-get install -y xdotool`. Windows: PowerShell `SendKeys` is
   built in.

## Google login (one-time per account)

```bash
npm run test:e2e:real:profile
```

This builds `dist`, opens `output/real-meet/stable-chrome-profile` in stable
Chrome, verifies the unpacked extension opens, binds `Control+Shift+9` to
**Start recording the active tab**, and opens Google's account chooser. Sign in
with the dedicated test account, return to the terminal, and press Enter; it
confirms a Google session and writes only non-sensitive readiness metadata to
`.real-meet-profile.json`. It never stores passwords or prints cookies, and the
profile lives under the gitignored `output/` tree.

- **First run on a fresh profile:** stable Chrome 137+ blocks automated
  unpacked-extension installation, so Chrome opens the native **Load unpacked**
  picker. Select the absolute `dist` path printed in the terminal once; later
  runs reuse it.
- **Custom or multiple accounts:** pass `--profile <path>` and use the *same*
  path for both setup and the test run:

  ```bash
  npm run test:e2e:real:profile -- --profile "$HOME/.real-meet-tests/account-a"
  ```

- Close every Chrome process using a profile before launching (a profile cannot
  be opened concurrently). Re-run setup when the Google session expires; delete
  the profile directory to reset it completely.

## Run the live matrix

```bash
npm run test:e2e:real -- https://meet.google.com/abc-defg-hij
```

The command builds the real-capture dev extension, opens the signed-in profile
with the extension and real default camera/microphone, joins or requests
admission **once**, then runs the serial scenario matrix in that single meeting
session. Aliases: `npm run test:e2e:live`, `npm run test:real-meet`.

Keep the terminal and Chrome visible. Invite the test account to the meeting's
Calendar event when possible (more reliable than anonymous knocking and may
allow direct admission); otherwise the organizer must be in the call and admit
the signed-in account. Leave the meeting open until Playwright prints the
aggregate result. A join is only considered successful once Meet exposes the
in-call **Leave call**, microphone, and camera controls and the content script
answers as the Google Meet provider.

### Options

| Flag | Effect |
| :-- | :-- |
| `--scenario <id>` | Run one scenario instead of the full matrix |
| `--strict-media` | Promote signal findings (silence/clipping/black/freeze/drift) to failures |
| `--meet-media on\|off` | Keep Meet's own mic/camera on (contention test) or off (isolate extension device access) |
| `--profile <path>` | Use a specific prepared stable-Chrome profile |
| `--browser chrome\|chrome-for-testing` | Stable Chrome (default) or the anonymous temporary-profile fallback |
| `--guest-name <name>` | Name shown when knocking (anonymous flow only) |

Environment: `RECORD_SECONDS` (default `10`), `JOIN_TIMEOUT_MS` (`240000`),
`ADMISSION_FAILURE_GRACE_MS` (`60000`), `REAL_MEET_FAILURE_HOLD_MS` (`30000`;
`0` closes Chrome immediately on failure), `REAL_MEET_CHROME_PROFILE`.

## Scenarios

The matrix runs in a single admitted page; the runner applies every
Settings-page control, resets diagnostics, records existing Chrome download IDs,
and analyzes only the new artifacts per iteration.

- `tab-baseline` — tab-only `640x360@24`.
- `mixed-microphone` — `1280x720@24` tab with real microphone mixing.
- `separate-low-profile` — separate real microphone and `640x360@24` camera.
- `separate-high-profile` — separate microphone and `1280x720@30` camera with a
  `1920x1080@30` tab request.
- `device-reacquisition` — three start/stop cycles with separate mic and camera.

```bash
npm run test:e2e:real -- <meet-url> --scenario separate-low-profile
```

## Output, reports, and named recordings

```text
output/real-meet/test-results/        # per-iteration JSON + failure evidence
output/real-meet/html-report/         # npx playwright show-report output/real-meet/html-report
output/real-meet/recordings/          # named .webm copies, easy to play
```

Per-iteration JSON contains settings, run config, Meet media state, the perf
diagnostics snapshot, browser metrics, hardware reacquisition, FFprobe/FFmpeg
analyses, and signal findings. Failed iterations also retain screenshots, DOM
dumps, and the media artifacts.

Playwright stores raw browser downloads under opaque GUID filenames, and the
extension's downloads are initiated by the service worker (so no Playwright
`download` event fires to rename them). After each iteration validates its
artifacts, `saveNamedRecordings()` copies them to
`output/real-meet/recordings/<scenario>-<iteration>-<stream>.webm` so you can
play the real tab/camera/microphone captures directly.

## Assertions

Hard failures: admission, extension/device initialization, loss of Meet media,
settings not reaching capture/recorder diagnostics, missing lifecycle events or
streams, leaked tracks, failed device reacquisition, corrupt or missing files.

Silence, clipping, black frames, frozen frames, and A/V duration drift are
**report findings** by default because an unattended room can legitimately be
quiet or static. Promote them to failures with `--strict-media` and speak/move
during the run.

## Diagnostics constraints (why some metrics are post-matrix)

Real Chrome tab-capture stream IDs are invalidated by starting Playwright
tracing, by attaching a CDP session before recording, or by opening media tracks
from the settings tab. Therefore Scenario B:

- disables Playwright tracing (the aggregate report notes this);
- collects browser/process/GPU CDP metrics once **after** the matrix;
- uses non-invasive `enumerateDevices()` for the device preflight, and runs one
  final settings-page acquisition after all tab-capture scenarios to prove
  device release.

Per-scenario performance still comes from the extension's own
recorder/capture/storage diagnostics.

## Extending the suite

Add a `RealMeetScenario` to `buildRealMeetScenarios()` in
`tests/e2e/helpers/realMeetScenarios.ts`:

```ts
{
  id: 'my-case',
  settings: baseRecordingSettings({ tabResolutionPreset: '1280x720', micMode: 'mixed' }),
  runConfig: { storageMode: 'local', micMode: 'mixed', recordSelfVideo: false },
  durationMs: 10_000,
  expectedStreams: ['tab'],
  // repeatCount?: number
}
```

`assertScenarioSnapshot()` derives every expected value from `settings`, so a new
scenario needs **no new assertion code**. Reusable primitives live in
`tests/e2e/helpers/realMeetHarness.ts` (launch, join, start-via-shortcut,
snapshot read, media analysis, named recordings, diagnostics, cleanup). Natural
additions: Drive upload (needs real OAuth), endurance/long-form, mid-recording
device unplug, present/screen-share capture, network throttling, and auto-stop
on meeting end.

## Troubleshooting

- **"You can't join this video call" immediately.** The automated browser was
  detected (`navigator.webdriver` / `--enable-automation`) or is an unsupported
  browser. The harness hides the webdriver flag and avoids automation switches
  where possible; use stable Chrome with the signed-in profile, invite the
  account to the Calendar event, and make sure the organizer is in the call.
  `--browser chrome-for-testing` is anonymous-only and is often blocked by the
  organizer or Workspace administrator.
- **`osascript is not allowed to send keystrokes (1002)`** (or no recording
  starts). Grant Accessibility to the launching app (see Permissions) and verify
  with the `osascript` probe above. Linux needs `xdotool`.
- **`ERR_BLOCKED_BY_CLIENT` / the extension page will not open on stable Chrome.**
  Chrome 137+ requires the one-time manual **Load unpacked**; run
  `npm run test:e2e:real:profile` and select the printed `dist` path.
- **"Timed out waiting for recording; last phase was idle".** The native
  keystroke missed Chrome's focus. The trigger auto-retries (the command is
  start-only, so retries are safe); keep the Chrome window frontmost and avoid
  moving other windows over it during start.
- **Profile cannot be opened / is locked.** Close every Chrome process using
  that profile first.

## Relationship to Scenario A

Scenario A remains fully available and unchanged
(`npm run test:e2e:mock`, `:perf:*`, `:perf:hardware`). Scenario B does not
replace A's deterministic workloads, Drive failure injection, synthetic markers,
or performance budgets — it adds production-DOM, real-tab-capture, and
simultaneous-device coverage that a mock cannot provide. See
[Scenario A](testing-scenario-a.md).
