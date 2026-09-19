# Meeting Recording Extension (Chrome Extension)

**Copyright (c) 2026 Kostiantyn Stroievskyi. All Rights Reserved.**

No permission is granted to use, copy, modify, merge, publish, distribute, sublicense, or sell copies of this software or any portion of it, for any purpose, without explicit written permission from the copyright holder.

---

Scrape live captions from a Google Meet into a timestamped `.txt` transcript, or record the current Meet tab (video + system audio) — plus an optional microphone and camera — to WebM or MP4 video and WebM or M4A audio files. Save locally or straight to Google Drive, and browse the resulting local/Drive artifacts from a durable recording history.

Everything runs in your browser. Capture is **local-first**: recording data streams to the Origin Private File System (OPFS) during the call and is finalized to a download or Drive only after you stop. No audio or video leaves your device while you're recording.

## Why this extension

- **Private by design** — media and captions never enter diagnostics. Optional anonymous diagnostics send only bounded aggregates and sanitized error fingerprints; transcripts remain in the page until you explicitly download them.
- **Built for long meetings** — chunks stream to disk continuously, so memory stays flat on multi-hour recordings instead of growing until the tab crashes.
- **Efficient encoding** — the camera bitrate adapts to the frame Chrome actually delivers (and defaults to 24 fps for a talking head), and the tab bitrate follows its content type — so files and CPU stay low with no visible quality loss.
- **Flexible per run** — microphone off / mixed / separate, optional camera, screen-vs-video tab quality, and local-or-Drive, all chosen per recording.
- **Adjust without stopping** — mute the mic, hide the camera, or pause/resume the whole recording mid-call; paused spans are cut so the files resume as a seamless join.
- **Resilient** — survives service-worker eviction, recovers captured files, and retries interrupted Drive delivery on the next launch after a crash or power loss without losing the recording's history identity.

---

## Features

**Transcript saver** — parses Meet's live captions into a timestamped `.txt`. Turn captions on in Meet, then hit Download Transcript at any point during or after the call.

**Tab recorder** — captures the Meet tab (video + system audio) to the selected `.webm` or `.mp4` container via `MediaRecorder`. The resolution preset is the capture *ceiling*; the file reflects what Chrome actually delivers. A **per-recording tab content type** (`Screen` vs `Video`) sets the bitrate target — `Screen` for slides/UI/whiteboards (sharp text, small files), `Video` for motion-heavy content.

**Direct-to-disk streaming** — chunks stream continuously to OPFS during capture, keeping memory bounded to a small working buffer. If the disk falls behind, a soft warning fires first and a hard ceiling triggers a protective stop that seals what was captured — so memory stays bounded even on a slow or failing disk, and a 2-hour+ meeting never crashes the tab.

**Explicit microphone modes** — chosen per run:

- `Off` — no microphone capture
- `Mix into tab recording` — mic audio is blended into the main tab file via a real Web Audio graph
- `Save separately` — mic is recorded as a second `.webm` or `.m4a` artifact

**Optional self-video capture** — record your camera feed to its own `.webm` or `.mp4` file. A constraint ladder (exact size+FPS → exact size with bounded FPS → best-effort) keeps it working across cameras, and the encoded resolution is enforced to your preset even when Meet holds the camera open at a higher one (Chrome otherwise records the shared native buffer; a toggle opts out to keep Meet's auto-resolution). The camera bitrate is fully automatic — it adapts to the delivered frame so the camera never wastes bits.

**Live recording controls** — adjust a recording in place, without stopping it:

- **Mute / unmute the microphone** — records true digital silence for the muted span (the mic track stays live, so the timeline never breaks). Works in both `mixed` and `separate` mic modes.
- **Hide / show the camera** — records black frames while hidden, on the separate self-video file.
- **Pause / resume the whole recording** — pauses every stream (tab, mic, camera) at once. The paused span is **not** written, so the files resume as a **seamless join** — before and after are stitched directly together, with no black/blank/frozen filler. Tracks stay live so resume is instant.

**State-driven popup** — a different layout per capture phase: a clean **configuration** screen before recording, a **recording** screen with a red banner, a pause-aware elapsed **timer** (counts recorded time only — it freezes on pause and equals the saved file's duration), a read-only live **mic meter**, status chips (a Transcript indicator that tracks whether Meet captions are actually on, plus the storage target), mic/camera **toggle rows**, and a short **finalizing** screen while capture seals.

**Local or Google Drive output** — finalized files download locally or enter a detached background upload to `Google Meet Records/<meeting-id>-<timestamp>/` in Drive. Capture returns to idle as soon as a Drive job is queued, so another recording can start; the job has its own progress tab, is retryable briefly after a fallback, and falls back per file to a local download on failure or cancellation. After a successful Drive upload, the popup offers a one-time naming prompt: saving renames the Drive folder and every uploaded media file, while Skip leaves their original names unchanged.

**Recording history** — the popup opens a paginated, IndexedDB-backed history page for local and Drive artifacts. A local recording rename changes its history label; a modern Drive recording rename updates the remote folder and uploaded filenames before committing the matching history projection, rolling completed remote changes back if a later rename fails. Open a confirmed local download or Drive file, or hide its history entry without deleting the underlying file. Pending and unavailable recovery outcomes are shown honestly rather than reported as saved.

**MV3 / offscreen architecture** — recording runs in a hidden offscreen document, the only MV3 context Chrome allows `MediaRecorder` and `AudioContext`. The background service worker keeps the run alive and rehydrates session state from `chrome.storage.session` after Chrome suspends and restarts it.

**Diagnostics dashboard** (dev builds) — aggregates structured perf events from every runtime context: recorder start latency, chunk persistence, audio-bridge behavior, Drive upload timings, memory, event-loop lag, and long tasks (offscreen and the Meet-tab main thread).

**Anonymous production diagnostics** — enabled by default with an opt-out in Settings. The extension keeps bounded counters/totals/maxima locally, checkpoints active runs once per minute, and sends compact completion summaries plus incident breadcrumbs only for failures or data-loss risks. It never sends recording media, captions, meeting/file names, Drive or device identifiers, OAuth data, raw error messages, raw stacks, a persistent browser identity, or per-event network requests. Pending diagnostics are deleted immediately on opt-out.

---

## Requirements

- **Google Chrome** (or the supported Chromium-based browsers: Edge, Brave, Opera, Vivaldi, and Arc) with Manifest V3, `tabCapture`, and the Offscreen API. Chrome 116+ is sufficient. Firefox is not currently supported because its capture/media-host adapters have not been implemented.
- **Node.js 18+** and **npm** to build the extension.
- **FFmpeg and FFprobe** for performance E2E artifact analysis.

The extension requests the following Chrome permissions: `activeTab`, `downloads`, `tabCapture`, `offscreen`, `storage`, `tabs`, `desktopCapture`, `alarms`. The one-shot alarm retries a queued anonymous diagnostics batch after a retryable network failure; it does not create a periodic heartbeat.

Drive mode additionally requires: `identity` and host access to `https://www.googleapis.com/*`.

---

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/kstroevsky/chrome-meeting-recording-extension.git
cd chrome-recording-transcription-extension
npm install

# 2. Build production with the deployed write-only telemetry endpoint
TELEMETRY_ENDPOINT=https://recording-extension-telemetry.kstroevsky.workers.dev/api/telemetry/batches npm run build
# outputs to ./dist; development builds may omit TELEMETRY_ENDPOINT

# 3. Load into Chrome
#    chrome://extensions → Developer mode ON → Load unpacked → select ./dist
```

> If you plan to use Drive mode, create `.env` from `.env.example` and set `GOOGLE_OAUTH_CLIENT_ID` before building. See [Google Drive setup](#google-drive-setup).

Open a Google Meet, click the extension icon, and you're ready to record or download transcripts.

---

## Detailed build setup

### 1. Install Node

- macOS: `brew install node`
- Ubuntu/Debian: `sudo apt-get install -y nodejs npm`
- Verify: `node -v && npm -v`

### 2. Install dependencies

```bash
npm install
```

### 3. Build

```bash
npm run build       # production build — minified, output to dist/
npm run dev         # development build — unminified, with source maps
npm run watch       # rebuild on every file change (development)
```

All three commands compile TypeScript via `ts-loader`, copy HTML shells, styles, fonts, and the manifest from `static/`, copy public icons, and emit a flat extension layout to `dist/`. Finder metadata is ignored so it cannot leak into an extension package.

### 4. Load the extension

- Visit `chrome://extensions`
- Turn on **Developer mode** (top-right toggle)
- Click **Load unpacked** and select the `dist/` directory

> After each `watch` rebuild, click **Reload** on the extension in `chrome://extensions`. For service worker or manifest changes, a full extension reload is required. For content-script-only changes, refreshing the Google Meet tab may be enough.

---

## Using the extension

1. Open a Google Meet at `https://meet.google.com/...`
2. (For transcripts) turn on **Captions** in the Google Meet UI.
3. Click the extension icon in the Chrome toolbar (pin it from the puzzle-piece menu for quick access).

### Transcript

**Download Transcript** — saves `google-meet-transcript-<meeting-id>-<timestamp>.txt` from the buffered live captions. Captions must be enabled in Google Meet before the meeting or the buffer will be empty.

### Recording

**Enable Microphone** — click this before starting a recording if you want to use any mic mode. The popup prompt may not appear reliably; if it fails, the button opens a dedicated `micsetup.html` page where you can click **Enable** and grant mic access. Once granted, the label changes to **Microphone Enabled**.

**Microphone Mode** — controls mic capture for the upcoming recording:

- `Off` — no microphone capture.
- `Mix into tab recording` — your mic is blended into the main tab recording via an audio graph. No separate mic file is created.
- `Save separately` — a second `.webm` or `.m4a` artifact is created for the mic stream only, according to the separate microphone format setting.

**Storage Mode** — `Local Disk` or `Google Drive`. Drive uploads happen after capture stops, not during capture. In Drive mode the recording returns to idle once its sealed artifacts are queued; upload progress, retry, and cancellation live in a separate session tab.

**Record my camera separately** — if checked, starts an additional camera-only recorder. If camera permission is missing when you click Start, a `camsetup.html` tab opens so you can grant access. Camera quality is controlled by the extension settings page, not Google Meet's own video setting.

**Start Recording** — begins capturing the current tab (video + system audio). The extension asks Chrome for the selected tab resolution preset as the capture ceiling. Actual resolution still depends on Chrome tab-capture behavior and what Meet renders into the tab.

**Stop Recording** — releases the extension-owned camera immediately, seals all active recorders, and runs the delivery handoff. The extension also stops the active run if the recorded tab closes, navigates away from the meeting, or the Meet page stays in an ended-call state for 30 seconds. In local mode a file download begins; in Drive mode a detached upload job starts and capture returns to idle immediately.

**Discard Recording** — stops the active capture and deletes its temporary artifacts instead of downloading or uploading them. The action waits for cleanup; if cleanup fails, the popup reports the error and does not claim the recording was discarded.

### The popup is state-driven

The popup renders one of three **capture** layouts depending on the current recording phase, so each screen only shows the controls that make sense for that state. A separate upload tab is overlaid when a detached Drive job is selected:

- **Configuration** (idle) — the setup screen above: microphone mode, storage, "record my camera separately", Download Transcript, Enable Mic, and **Start Recording**. None of the in-recording controls appear here.
- **Recording** (recording / paused) — a red **Recording** banner (amber **Paused** when paused) with a live elapsed **timer**, a read-only **mic meter**, two status chips (**Transcript on/off** and the storage target), a **Microphone** row and a **Camera** row each with an on/off toggle, and **Pause**, **Stop**, and **Discard**.
- **Finalizing** (stopping) — a spinner with the run summary: storage target, recorded duration, microphone mode, and whether the camera was separate, plus "you can close this popup".
- **Upload tab** (independent of capture phase) — the progress and per-file results of one background Drive job. It may continue while the setup screen starts another recording; retry is available only while its failed artifacts remain temporarily retained, and cancel saves unfinished files locally. A completed unnamed job opens the accessible **Name this recording** dialog once; saving updates the remote Drive names and session/history projections, while Skip durably suppresses the prompt.

**The live timer is pause-aware.** It counts only *recorded* time: it freezes while paused and stops at stop, so the number you see equals the duration of the saved file. It is computed from authoritative timing on the session, so reopening the popup mid-recording shows the correct elapsed time.

**The Transcript chip reflects live captions.** While recording, the popup polls the active Meet tab and shows *Transcript on* only while Google Meet's captions region is actually present (dimmed *Transcript off* otherwise).

**The mic meter is observational.** While an unmuted mic is active, it samples the live input at 100 ms intervals through a read-only analyser. It does not alter gain, create an output, or affect what is recorded.

**Live controls (recording view)** — these act on the running recording in place and never interrupt it:

- **Microphone toggle** — shown when the run uses a microphone (`mixed` or `separate`). Switching it off records true silence for as long as it stays off; switching back on resumes live audio. A rejected toggle leaves the recording untouched.
- **Camera toggle** — shown when the run records the camera separately. Off records black frames; on resumes the live camera.
- **Pause / Resume** — pauses the entire recording (tab + mic + camera). While paused nothing is recorded — the banner reads **Paused**, the timer freezes, and **Stop** still works — and on Resume the files continue as a seamless join, with the paused time absent rather than filled with a blank or frozen gap. Reopening the popup while paused still shows **Resume**.

> The extension badge shows `REC` while recording and `UP` while any detached Drive job is still active.

### Recording history

Use the history icon in the popup header to open the **Recordings** page. It is paginated; select **Load more** to append older entries. Each recording shows the tab, mic, and self-video artifacts with their current delivery state. Local files can be opened only after Chrome confirms their download; Drive files expose their Drive link after upload. **Delete history** hides the entry only — it never deletes the saved local or Drive files.

---

## Settings page

Open the settings page by clicking the gear icon in the popup. Settings persist across sessions via `chrome.storage.local`.

| Setting | Description |
| :--- | :--- |
| Anonymous diagnostics | Default on; sends bounded recording/upload summaries and sanitized failure evidence. Turning it off deletes queued batches and active checkpoints immediately. |
| Tab capture preset | Output resolution for the tab recording: `640×360`, `854×480`, `1280×720`, or `1920×1080` |
| Tab video bitrate | Encoder bitrate at the `1920×1080`@30 reference; the recorder scales it down automatically for smaller tab presets / frame rates |
| Tab recording format | `WebM` (default) or `MP4`; controls the main tab artifact, including mixed microphone audio |
| Camera capture preset | Output resolution for the self-video recording, same preset options |
| Camera recording format | `WebM` (default) or `MP4`; controls the separate self-video artifact |
| Separate microphone format | `WebM/Opus` (default) or `M4A/AAC`; applies only to a separately saved microphone, never to mixed microphone audio |
| Prefer the automatically selected resolution | When on, the camera is recorded at whatever resolution Chrome/Meet already selected instead of re-encoding it to the camera preset above — skips the per-frame resize work. Off by default |

The tab and camera capture presets control what size the final file targets, not what resolution Chrome delivers from the source. Actual resolution depends on Chrome, camera hardware, and sharing limits. During recording, the popup labels the tab source with the reported delivered height when Chrome exposes it; the diagnostics data records requested-versus-delivered profiles. Separately, selecting separate camera capture with a sub-1080p **configured** preset shows a non-blocking setup nudge to raise that setting. That nudge is profile guidance, not a guarantee of the camera's delivered resolution.

Every settings field shows a tooltip (click the label) with a short operational explanation. MP4 and M4A are offered only when the current browser reports a compatible native `MediaRecorder` encoder; unavailable options are disabled. The extension never substitutes another container: if a persisted MP4/M4A choice becomes unsupported, starting a recording explains that you must change the format in Settings.

Legacy stored width/height values from previous extension versions are normalized to the nearest supported preset on settings load.

Production builds require `TELEMETRY_ENDPOINT` to be the exact HTTPS `/api/telemetry/batches` route. Webpack injects that endpoint and only its origin into `host_permissions`; an invalid or missing production endpoint fails the build. The Worker, D1 schema, deployment sequence, tests, retention job, and read-only operational queries live in [`telemetry-worker/`](telemetry-worker/README.md).

---

## Output files

All filenames include the Google Meet meeting ID suffix and a UTC timestamp.

| Artifact | Filename pattern |
| :--- | :--- |
| Tab recording | `google-meet-recording-<meet-suffix>-<timestamp>.webm` (default) or `.mp4` |
| Microphone (separate mode) | `google-meet-mic-<meet-suffix>-<timestamp>.webm` (default) or `.m4a` |
| Self-video | `google-meet-self-video-<meet-suffix>-<timestamp>.webm` (default) or `.mp4` |
| Transcript | `google-meet-transcript-<meet-suffix>-<timestamp>.txt` |

In Drive mode, all artifacts for one recording session are uploaded to a per-recording folder: `Google Meet Records/<meeting-id>-<timestamp>/`. The detached upload tab and recording history expose the folder and per-file Drive links once Drive returns them. Naming a completed Drive recording slugifies the title for the folder and preserves each artifact extension while producing `<slug>-recording.<ext>`, `<slug>-mic.<ext>`, and `<slug>-self-video.<ext>` filenames. The metadata update is sequential and rollback-aware so history is not advanced to names Drive did not accept.

---

## Google Drive setup

Drive mode requires a **Chrome Extension** OAuth 2.0 client. A Desktop or Web client type will not work with `chrome.identity.getAuthToken`.

1. In the [Google Cloud Console](https://console.cloud.google.com/), enable the **Google Drive API** for your project.
2. Configure an **OAuth consent screen** and add the scope `https://www.googleapis.com/auth/drive.file`.
3. Load the extension into Chrome (`chrome://extensions` → Load unpacked → `dist/`) and note your extension ID.
4. Create an **OAuth 2.0 client** with **Application type: Chrome Extension** and enter the exact extension ID.
5. Create a `.env` file at the repo root (copy from `.env.example`) and set:

   ```
   GOOGLE_OAUTH_CLIENT_ID=<your-chrome-extension-oauth-client-id>
   ```

   If the variable is missing, the build succeeds with a placeholder client ID, but Drive auth will fail at runtime.
6. Rebuild: `npm run build` or `npm run watch`. Webpack injects the client ID into `dist/manifest.json`.
7. Reload the extension in Chrome after rebuilding.

**Keep a stable extension ID** — the `key` field in `static/manifest.json` is checked into this repo and pins the extension ID. If the key changes, the extension ID changes and the OAuth client must be recreated for the new ID. The webpack build emits the runtime manifest to `dist/manifest.json`.

### Other Chromium browsers (Edge, Brave, Opera, …)

`chrome.identity.getAuthToken` is Chrome-only, so the other supported Chromium browsers sign in via `chrome.identity.launchWebAuthFlow` against a **Web application** OAuth client (ADR-0002). Build per target — `npm run build:brave`, `build:edge`, `build:opera`, or `npm exec -- webpack --mode=production --env target=<vivaldi|arc>` — which emit to `dist-<target>/`. All supported Chromium targets keep the **same `key`**, so they share one extension ID and therefore **one redirect URI**. Firefox has no build target yet because the recording runtime also depends on Chromium capture and offscreen-media APIs.

1. Create an **OAuth 2.0 client** with **Application type: Web application**, enable the Drive API, and add the `drive.file` scope on the consent screen (add yourself as a test user while the app is unverified).
2. Get the redirect URI to register: `npm run redirect-uri` prints `https://<id>.chromiumapp.org/`. Add that exact value (trailing `/` included) to the client's **Authorized redirect URIs**.
3. In `.env`, set `GOOGLE_WEB_OAUTH_CLIENT_ID` and `GOOGLE_WEB_OAUTH_CLIENT_SECRET` (for a Desktop/Web client the secret is shipped in the non-Chrome bundle and never in the Chrome bundle).
4. Build the target, load `dist-<target>/` unpacked, and sign in.

Each **store-published** build (Chrome Web Store, Edge Add-ons) gets its own store-assigned ID; add that build's `https://<id>.chromiumapp.org/` to the same OAuth client. The `redirect-uri` script covers the stable unpacked/dev ID.

**Drive folder structure** — Drive mode auto-creates:

- Root folder: `Google Meet Records` (created once, reused)
- Per-recording folder: `<meeting-id>-<timestamp>` (created fresh each run)

---

## Scripts

| Command | Description |
| :--- | :--- |
| `npm run build` | Production build to `dist/` (minified, Chrome target) |
| `npm run build:edge` / `build:brave` / `build:opera` | Per-browser production build to `dist-<target>/` (drops Chrome-only `oauth2`, **keeps** the stable `key`, and authenticates via `launchWebAuthFlow`) |
| `npm exec -- webpack --mode=production --env target=vivaldi` / `target=arc` | Build either additional supported Chromium profile to `dist-<target>/` |
| `npm run dev` | Development build to `dist/` (unminified, source maps) |
| `npm run watch` | Rebuild on every file save (development) |
| `npm run typecheck` | Strict TypeScript check across `src/` without emitting |
| `npm run typecheck:e2e` | TypeScript check for Playwright specs and helpers |
| `npm run lint` | Alias for `typecheck` |
| `npm test` / `npm run test:unit` | Unit test suite (skips E2E) |
| `npm run release:version` | Print the release version of the checked-out commit (`a.b.c.d`, counted from git) |
| `npm run hooks:install` | Install the commit-msg hook that checks commit prefixes (also runs on `npm install`) |
| `npm run release:build` | Production build to `dist/` then the production guards (version + no E2E markers) |
| `npm run test:e2e` / `npm run test:e2e:mock` | Functional mocked-Meet E2E plus performance smoke |
| `npm run test:e2e:perf:smoke` | Three critical browser/extension performance cases |
| `npm run test:e2e:perf:full` / `npm run test:e2e:perf` | Complete pairwise matrix and repeated benchmarks |
| `npm run test:e2e:perf:endurance` | Ten-minute local and two-minute throttled-Drive runs |
| `npm run test:e2e:perf:hardware` | Headed physical microphone/camera tier |
| `npm run test:production-guards` | Proves E2E capture, fake OAuth, and Drive bridge markers are absent from `dist/` |
| `npm run test:e2e:real:profile` | Prepare or verify the persistent signed-in Chrome profile |
| `npm run test:e2e:real -- <meet-url>` | One-admission real Google Meet scenario matrix |
| `npm run test:e2e:live -- <meet-url>` / `npm run test:real-meet -- <meet-url>` | Compatibility aliases for the real-Meet suite |

### Versioning and releasing

There are two independent version identifiers; do not conflate them:

- **Build ID** (`globalThis.__BUILD_ID__`) is a content hash stamped into every bundle by webpack. It changes on every code change and drives the service-worker ↔ offscreen skew handshake and the on-update reload. It is fully automatic — never set it by hand.
- **Release version** (`a.b.c.d`) is **counted from git history at build time**; nobody bumps it. Only `a` is written down, as the major of `package.json`'s version (kept at `a.0.0`). The rest comes from `scripts/lib/releaseVersion.cjs`, and the build writes the result into `dist/manifest.json`. The `version` in `static/manifest.json` is an ignored `0.0.0` placeholder.

| Segment | Counts | Goes up on |
| :--- | :--- | :--- |
| `a` | the major in `package.json` | a deliberate new era: `npm version major -m "Release: %s"` |
| `b` | merged pull requests since `a` was last raised | every merge into main |
| `c` | `Feature` commits since the last merged pull request | `Feature:` / `feat:` |
| `d` | fix-type commits since the last `Feature` | `Fix:` `Refactor:` `Perf:` `Draft:`, and reverts |

`Testing:`, `Docs:`, `Infrastructure:`, `Setup:` and `Release:` commits bump nothing, because nothing shipped changes. A higher segment going up resets the ones after it. So a branch shows its own work while you build and test it (`0.15.6.2`), and merging it folds that work into the pull request (`0.16.0.0`). A commit's version is never lower than its parent's, which is what Chrome's update check needs.

What this relies on:

- **Commit prefixes are the input.** A commit-msg hook (installed by `npm install`, or `npm run hooks:install`) refuses a subject without a known prefix. Lowercase and scoped forms (`feat(popup):`, `fix:`) count the same.
- **Pull requests are merged with a merge commit.** A squash or rebase merge leaves nothing to count. Merging main into a branch (`Merge branch 'main' into …`) is not counted as a pull request.
- **The build needs the full history.** A shallow clone fails a production build (`git fetch --unshallow`). A dev build without git still builds, as `a.0.0.0`.

`version_name` (shown on `chrome://extensions`) adds what makes a build differ from its commit, for example `0.15.6.2 (dev, uncommitted changes)`.

To cut a release:

```bash
npm run release:build   # refuses uncommitted changes and a version lower than the latest release tag
# zip ./dist and upload it to the Chrome Web Store, then record the release:
git tag -a "v$(npm run -s release:version)" -m "Release $(npm run -s release:version)"
git push origin --tags
```

Release from main, or from a branch that contains the latest release. A build from an older branch counts lower, and `release:build` refuses it, because the Chrome Web Store rejects an upload that does not go up.

Two end-to-end testing scenarios exist:

- **Scenario A** — the deterministic mocked-Meet Playwright suite and CI gate: functional tests, the performance matrix, mocked Drive, media analysis, and the physical camera/microphone tier. See the [Scenario A guide](docs/testing-scenario-a.md).
- **Scenario B** — manual real Google Meet calibration in stable Chrome with a signed-in account, real `chrome.tabCapture`, and real devices. See the [Scenario B guide](docs/testing-scenario-b.md).

### Real Google Meet (Scenario B)

Scenario B drives the **real** production Meet in stable Chrome with a signed-in account, real `chrome.tabCapture`, and the real camera/microphone used concurrently by Meet and the extension. It is a manual, headed tier — a host admits the test account — and is **not** a CI gate.

```bash
npm run test:e2e:real:profile                                  # one-time: sign in + install the extension
npm run test:e2e:real -- https://meet.google.com/abc-defg-hij  # run the live matrix
```

It requires OS camera/microphone access for Google Chrome and **Accessibility** permission for the launching terminal/app, because the suite starts recording with a real `Control+Shift+9` keystroke so Chrome grants `activeTab` to `tabCapture`. Validated recordings are saved as named artifacts under `output/real-meet/recordings/`.

Full setup, OS permissions, Google login, run options, scenarios, named recordings, reports, and troubleshooting are in the [Scenario B guide](docs/testing-scenario-b.md).

---

## How it works

```
User
 ├─ Popup ────────────────────────────────► Background Service Worker
 │    START_RECORDING / STOP_RECORDING        │   canonical state owner · MV3 keep-alive · re-hydrates after suspend
 │    GET_TRANSCRIPT → Content Script          ├─ RecordingController    single start/stop orchestrator (one seam)
 │                                             ├─ RecordingSession       capture state machine + detached upload-job views
 │                                             ├─ RecordingHistoryService IndexedDB history transitions / pages
 │                                             ├─ OffscreenManager       reconnecting Port RPC + action badge
 │                                             ├─ recordingAutoStop      tab closed / navigated / MEETING_ENDED
 │                                             ├─ driveAuth              OAuth token (silent → interactive)
 │                                             ├─ PerfDebugStore         aggregates PERF_EVENTs
 │                                             └─ Offscreen Document  ◄── only MV3 context allowed media APIs
 │                                                 │   OFFSCREEN_START/STOP ▸ OFFSCREEN_READY/STATE/SAVE
 │                                                 ├─ RecorderEngine (facade + state machine)
 │                                                 │   ├─ TabRecorderTask       ◄── tabCapture streamId (video + system audio)
 │                                                 │   ├─ MicRecorderTask       ◄── getUserMedia(microphone)
 │                                                 │   ├─ SelfVideoRecorderTask ◄── getUserMedia(camera)
 │                                                 │   └─ MixedAudioMixer / AudioPlaybackBridge (AudioContext audio graph)
 │                                                 ├─ StorageTarget: WorkerStorageTarget (OPFS sync-handle worker) ▸ LocalFileTarget (OPFS) ▸ InMemory fallback
 │                                                 └─ OffscreenController (runs only after capture stops)
 │                                                     ├─ local : RecordingFinalizer → blob URL ─OFFSCREEN_SAVE→ Chrome Downloads API
 │                                                     └─ drive : UploadManager → DriveTarget ─resumable upload→ Google Drive API
 │
 ├─ Content Script (meet.google.com tab)
 │    ├─ GoogleMeetAdapter → CaptionBuffer ─(GET_TRANSCRIPT)→ Popup
 │    └─ MeetingEndDetector ─MEETING_ENDED→ Background (auto-stop)
 │
 └─ Debug Dashboard (dev builds) ─reads aggregated perf snapshot→ Background

State persistence:  chrome.storage.session → RecordingSessionSnapshot + detached job views + perf snapshot   ·   IndexedDB → recording history   ·   chrome.storage.local → user settings + recovery markers/outbox
```

1. **Content script** observes the Google Meet caption DOM, debounces speech fragments into committed transcript lines, and serves them on demand.
2. **Popup** collects user intent (run config), checks permissions, and sends commands to the background worker.
3. **Background service worker** owns session state, coordinates the offscreen document, acquires the tab capture stream ID, and handles local downloads.
4. **Offscreen document** runs the recorder engine, streams chunks to OPFS, and drives the post-stop handoff (local save or detached Drive job). The background persists the job and its durable history transitions.

---

## Dependencies and toolchain

**Runtime dependency**

| Package | Purpose |
| :--- | :--- |
| `webm-duration-fix` | Patches missing duration metadata in sealed **WebM** `MediaRecorder` files by streaming the file (no whole-file load into memory) and adds seek cues; runs inside the OPFS storage worker. MP4 and M4A artifacts bypass it. Replaced `fix-webm-duration`, which loaded the entire file into the JS heap at finalize |

**Development dependencies**

| Package | Purpose |
| :--- | :--- |
| `typescript` | TypeScript compiler (target: ES2020) |
| `webpack` / `webpack-cli` | Module bundler |
| `ts-loader` | TypeScript loader for webpack |
| `copy-webpack-plugin` | Copies `static/` assets into `dist/` |
| `clean-webpack-plugin` | Cleans `dist/` before each build |
| `@types/chrome` | Chrome extension API type definitions |
| `@types/node` | Node.js type definitions |
| `jest` / `ts-jest` | Test runner and TypeScript Jest transform |
| `jest-environment-jsdom` | DOM environment for unit tests |
| `@types/jest` | Jest type definitions |
| `playwright` | Browser automation for E2E tests |
| `puppeteer` / `puppeteer-core` | Alternative browser automation for E2E |
| `@types/puppeteer` | Puppeteer type definitions |

---

## Permissions explained

| Permission | Why it is needed |
| :--- | :--- |
| `activeTab` | Query the active tab to target and label the recording |
| `tabs` | Query tab metadata needed for stream acquisition and labeling |
| `downloads` | Save transcript and recording files locally via Chrome's Downloads API |
| `tabCapture` / `desktopCapture` | Capture video and audio from the current tab |
| `offscreen` | Create a hidden offscreen document to run `MediaRecorder` (not available in MV3 service workers) |
| `storage` | Persist ephemeral session state for UI sync and service worker recovery after suspension |
| `alarms` | Schedule one-shot 5/15/60-minute retries for queued anonymous diagnostics after retryable delivery failures |
| `identity` | Authenticate the user silently to write to Google Drive (Drive mode only) |
| `host: meet.google.com/*` | Scope the content script to Google Meet pages |
| `host: googleapis.com/*` | Allow Drive API requests during post-stop upload (Drive mode only) |
| `host: <telemetry Worker>/*` | Injected from the exact production `TELEMETRY_ENDPOINT`; allows bounded anonymous batch delivery to that one origin |
| `system.cpu` | **Dev builds only** — system CPU% for the diagnostics dashboard; injected into the manifest only in development builds, never requested in production |

---

## Troubleshooting

**I don't see any transcript text.**

- Enable **Captions** in the Google Meet UI before or during the meeting.
- The extension only scrapes from `https://meet.google.com/*`.
- Reload the Google Meet page after loading or reloading the extension.

**"Failed to start recording: Offscreen not ready" or similar.**

- Open `chrome://extensions`, click **Reload** on the extension, then try again.
- Ensure Chrome is up to date (MV3 + Offscreen API require Chrome 116+).
- Some enterprise policies can block offscreen documents — check with your admin if applicable.

**No microphone audio in the recording.**

- Click **Enable Microphone** in the popup before starting. If the inline prompt fails, a mic setup tab opens — click **Enable** there and allow access.
- Check OS mic permissions for Chrome: `System Settings → Privacy & Security → Microphone`.

**Recording is silent or very quiet.**

- Make sure the Google Meet tab is playing audio (the tab is not muted and Meet audio is not muted).
- If a microphone mode is enabled, confirm the OS input device and volume levels.

**Stop Recording finishes but no file appears.**

- Check the Chrome Downloads panel (`chrome://downloads`).
- If **Ask where to save each file** is enabled in Chrome settings, a save dialog appears — it may be behind other windows.
- Some download manager extensions can interfere. Disable them and retry.

**Popup buttons are not enabling or disabling correctly.**

- The popup reflects state broadcast from the background worker. If it falls out of sync, stop any active recording, then click **Reload** on the extension in `chrome://extensions`.

**`Token fetch failed ... bad client id` when saving to Drive.**

- Google rejected the `manifest.oauth2.client_id`.
- Verify the OAuth credential type is **Chrome Extension** (not Web, Desktop, or Installed).
- Verify the client was created for the exact extension ID shown in `chrome://extensions`.
- Verify the consent screen includes the scope `https://www.googleapis.com/auth/drive.file` and your account is listed as a test user if the app is in Testing mode.
- Rebuild (`npm run build`) after editing `.env`, reload the extension, and retry.

**`Drive session init failed: 403`.**

- Open the extension service worker console and read the full Google API error text.
- `insufficientPermissions` / `scope` — re-consent and verify the Drive scope is configured.
- `accessNotConfigured` / `Drive API has not been used` — enable the Drive API in the same Google Cloud project as your OAuth client.
- Test user or consent restrictions — add your account to OAuth test users or publish the consent screen.

---

## Development tips

- Use `npm run watch` during iteration. Changes rebuild automatically; you still need to click **Reload** in `chrome://extensions` for service worker or manifest changes.
- **Background / service worker logs**: `chrome://extensions` → your extension → **service worker** → **Inspect**.
- **Offscreen logs**: visible in the same service worker console under `[offscreen]` prefix.
- **Content script logs**: open DevTools in the Google Meet tab → **Console**.
- **Diagnostics dashboard**: in a dev build, the popup shows a link to the debug dashboard, which renders the aggregated perf snapshot for the current session (recorder start latency, chunk sizes, Drive upload timings, event-loop lag, long tasks).
- **Google Meet DOM selectors** live in `src/content/GoogleMeetAdapter.ts`. If transcripts stop working after a Meet UI update, start there.
- **Drive mode without a real OAuth client**: set `GOOGLE_OAUTH_CLIENT_ID` to any non-empty string before building to suppress the build warning. Drive auth will still fail at runtime, but the build and all non-Drive features work normally.

---
---

# Architecture Reference

---

## Architecture overview

The extension is built around Manifest V3 constraints. Four runtime contexts own strictly separated responsibilities — nothing bleeds across context boundaries:

- The **background service worker** owns orchestration and privileged Chrome APIs.
- The **offscreen document** owns media APIs and OPFS-backed file writing.
- The **popup** is disposable and never owns recording state.
- The **content script** owns transcript collection inside the Meet page.

Recording state is canonical in the background. The offscreen document is the only context that can run `MediaRecorder` and `AudioContext` under MV3. Closing the popup never stops a recording.

---

## Module guide

Per-module documentation lives in each module's `README.md` — the *why*, invariants, and gotchas, scoped to that directory. This root reference keeps only the **cross-cutting** picture (the layering/flow diagrams below, the message contract, the end-to-end flows).

| Module | README | Owns |
| :--- | :--- | :--- |
| Background (control plane) | [`src/background`](src/background/README.md) | SW lifecycle, session state machine, watchdog, control-plane orchestration |
| Offscreen (data plane) | [`src/offscreen`](src/offscreen/README.md) | the recording runtime + stop→finalize composition |
| &nbsp;&nbsp;└ Recorder engine | [`src/offscreen/engine`](src/offscreen/engine/README.md) | capture→encode pipeline, audio graph, live controls |
| &nbsp;&nbsp;└ Storage | [`src/offscreen/storage`](src/offscreen/storage/README.md) | OPFS streaming, fallback ladder, crash recovery |
| &nbsp;&nbsp;└ Drive | [`src/offscreen/drive`](src/offscreen/drive/README.md) | resumable upload, OAuth use, recovery |
| Shared kernel | [`src/shared`](src/shared/README.md) | recording state model + `projectPhase`, messaging substrate |
| &nbsp;&nbsp;└ Settings | [`src/shared/settings`](src/shared/settings/README.md) | the config schema + derive pipeline |
| Popup | [`src/popup`](src/popup/README.md) | state-driven control UI, permission readiness |
| Recordings | [`src/recordings`](src/recordings/README.md) | paginated recording history UI |
| Content | [`src/content`](src/content/README.md) | Meet transcript scraping, meeting-end detection |
| Debug | [`src/debug`](src/debug/README.md) | the diagnostics dashboard |
| Platform | [`src/platform`](src/platform/README.md) | browser-abstraction layer ([chrome seam](src/platform/chrome/README.md), [auth capability](src/platform/capabilities/README.md)) |

Also: [`tests/`](tests/README.md) · [`scripts/`](scripts/README.md) · [`static/`](static/README.md) · [`docs/`](docs/README.md) · [`telemetry-worker/`](telemetry-worker/README.md) · [module-README conventions](docs/agents/module-readmes.md).


## Design principles

- **Local-first capture** — live recording data is always written to local storage targets first. Google Drive upload starts only after capture is sealed.
- **Single active session** — one canonical session snapshot is persisted in `chrome.storage.session`. There is no distributed state across context globals.
- **Typed contracts** — popup/background/offscreen/content communication is defined in shared protocol types. Untyped message passing is not used.
- **Extension-first boundaries** — Chrome APIs are wrapped behind small platform adapters in `src/platform/chrome/*`. Business modules do not call `chrome.*` directly.
- **Detached post-stop delivery** — Google Drive upload begins only after `RecorderEngine.stop()` returns sealed artifacts, then runs as a job independent of capture phase. Real-time capture stability is never coupled to network conditions, and a new recording need not wait for the network.

---

## Runtime contexts

### Background Service Worker

Files: `src/background.ts`, `src/background/*`

**Purpose:**

- Own the extension control plane.
- Receive commands from popup.
- Keep recording lifecycle state durable across service worker restarts.
- Create and reconnect the offscreen document.
- Broker local download requests and Drive token requests.

**Key responsibilities:**

- Maintains the canonical `RecordingSession`.
- Persists the session snapshot under `recordingSession` in `chrome.storage.session`.
- Keeps the worker alive while capture is busy (`starting`, `recording`, `stopping`) or a detached upload job remains active.
- Bridges offscreen events into popup updates.
- Handles `OFFSCREEN_SAVE` by triggering `chrome.downloads.download`.
- Hydrates legacy session keys (`phase`, `activeRunConfig`) when present so old in-session state is not lost during migration.

**Module decomposition:**

- `src/background/RecordingController.ts` — single start/stop orchestrator for the recording control plane. Owns the start/stop decisions, the session transitions they imply, and the `OFFSCREEN_START`/`OFFSCREEN_STOP` RPC handshake. Every trigger — popup commands, auto-stop tab listeners, and the content-script meeting-ended signal — drives recording through this one seam.
- `src/background/recordingAutoStop.ts` — conservative automatic stop triggers. `registerRecordingAutoStop` binds tab-removed / tab-updated listeners (recorded tab closed or navigated away from the meeting); `handleMeetingEndedMessage` handles the content-script `MEETING_ENDED` signal. Both call into `RecordingController.stop()`.
- `src/background/messageHandlers.ts` — routes popup messages, delegating `START_RECORDING`/`STOP_RECORDING` to `RecordingController` and serving `GET_RECORDING_STATUS` and `GET_DRIVE_TOKEN`; also forwards the content-script `MEETING_ENDED` message to the auto-stop handler. Owns `successResult`/`failureResult` helpers.
- `src/background/sessionLifecycle.ts` — manages the service-worker keep-alive loop (`startKeepAlive` / `stopKeepAlive`) and perf-diagnostics clearing driven by session phase transitions. Isolates all `setInterval` keep-alive logic.
- `src/background/legacySession.ts` — hydrates old single-key session storage shapes (`phase`, `activeRunConfig`) into the current `RecordingSessionSnapshot` layout so in-flight sessions are not lost during extension upgrades.
- `src/background/perf/PerfDebugReducers.ts` — reduces incoming `PERF_EVENT` messages into the debug snapshot state.
- `src/background/perf/PerfDebugState.ts` — defines the mutable debug snapshot shape and its initialization / clearing helpers.

### Offscreen Document

Files: `static/offscreen.html`, `src/offscreen.ts`, `src/offscreen/rpcHandlers.ts`

**Purpose:**

- Own all browser APIs unavailable in MV3 service workers:
  - `getUserMedia`
  - `MediaRecorder`
  - `AudioContext`
  - OPFS (`navigator.storage.getDirectory()`)

**Key responsibilities:**

- Maintains a reconnecting `chrome.runtime.Port` to background.
- Runs `RecorderEngine`.
- Streams chunks to a storage target during capture — by default an OPFS sync-access-handle Worker, so disk writes stay off the offscreen main thread.
- Runs local delivery or queues detached Drive delivery after stop.
- On startup (while idle), runs crash recovery — re-uploads interrupted Drive artifacts through fresh resumable sessions and recovers orphaned recordings left by a previous crash (see [6.1 Resilience and crash recovery](#61-resilience-and-crash-recovery)).
- Emits explicit capture-phase updates back to background: `starting`, `recording`, `stopping`, `failed`, `idle`; detached Drive work reports upload-job state separately.

**Entrypoint decomposition:**

- `src/offscreen.ts` — runtime shell: port connect/reconnect, perf sampling loop, long-task diagnostics, finalize orchestration.
- `src/offscreen/rpcHandlers.ts` — wires all background→offscreen RPC and runtime messages (`OFFSCREEN_START`, `OFFSCREEN_STOP`, `REVOKE_BLOB_URL`, `OFFSCREEN_CONNECT`) to their handlers, keeping the entrypoint focused on setup and sampling rather than message dispatch.

### Popup

Files: `static/popup.html`, `src/popup.ts`, `src/popup/*`

**Purpose:**

- Collect user intent and render current session state.

**Key responsibilities:**

- Builds a `RecordingRunConfig`.
- Resets transcript buffer before a new recording starts.
- Enforces microphone and camera permission readiness.
- Reflects session state sent from background.
- Downloads transcript text returned by the content script.

**Important property:** The popup is disposable. Closing it does not stop recording or upload.

### Content Script

File: `src/scrapingScript.ts`, `src/content/*`

**Purpose:**

- Observe the Google Meet DOM and accumulate caption transcript text.

**Key responsibilities:**

- Detects the captions region when it appears.
- Observes speaker blocks and incremental text updates.
- Debounces speech fragments into committed transcript lines via `captionBuffer.ts`.
- Serves transcript requests from popup.
- Uses a provider adapter abstraction instead of hard-coding Meet logic into the collector itself.
- Detects meeting end (`MeetingEndDetector`) and signals the background for auto-stop.

**End-detector coalescing (F8):** `MeetingEndDetector` observes the page for the meeting ending, but its DOM observer wakes only on structural changes (`childList`/`subtree`), **not** `characterData` — live caption text mutates the body almost every frame, and re-running the doc-wide leave-call `querySelector` on each was pure waste. Mutation bursts are further coalesced to one throttled evaluation (`MEETING_END_OBSERVER_THROTTLE_MS`). A 2 s poll backstop and 30 s grace own detection latency, so the throttle costs nothing on correctness.

---

## Canonical domain model

→ The recording domain model — `RecordingRunConfig`, the full `RecordingSessionSnapshot`, the derived `phase` (`projectPhase`), and the legacy migration — is documented with the code that owns it: **[`src/shared`](src/shared/README.md)**.

## Architecture components

### 1. Recording Session State Machine

→ The canonical state machine (writes `desired`/`observed`/`failed`, derives `phase`): **[`src/background`](src/background/README.md)**.

### 1.1 Recording Control Plane Orchestrator

→ The start/stop orchestration (`RecordingController`): **[`src/background`](src/background/README.md)**.

### 2. Offscreen Lifecycle Manager

→ `OffscreenManager` (ensure/reconnect, version handshake, recorder-tab fallback): **[`src/background`](src/background/README.md)**.

### 3. Offscreen Runtime Entrypoint

→ The offscreen runtime composition + port/RPC wiring: **[`src/offscreen`](src/offscreen/README.md)**.

### 4. Recorder Engine

→ Capture→encode pipeline, mic modes + audio graph, the artifact model, and live mute/hide/pause: **[`src/offscreen/engine`](src/offscreen/engine/README.md)**.

### 5. Storage Targets (worker, OPFS, RAM)

The long-meeting safety mechanism: chunks stream straight to OPFS (default off the main thread via a sync-access worker), through a fallback ladder **`WorkerStorageTarget` ▸ `LocalFileTarget` ▸ `InMemoryStorageTarget`**, with backpressure guards, protective-stop escalations, a hang-proof `close()`, periodic flush, and orphan recovery for bytes left on disk after a crash.

→ Full subsystem reference (invariants, the OPFS streaming/fallback diagram, files, wiring): [`src/offscreen/storage/README.md`](src/offscreen/storage/README.md).

### 6. Recording Finalizer and Drive Upload

→ The post-stop finalize pipeline lives in **[`src/offscreen`](src/offscreen/README.md)**; the resumable upload in **[`src/offscreen/drive`](src/offscreen/drive/README.md)**.

### 6.1 Resilience and crash recovery

→ Split across **[storage](src/offscreen/storage/README.md)** (orphan recovery, protective stop), **[drive](src/offscreen/drive/README.md)** (fresh re-upload), and **[offscreen](src/offscreen/README.md)** (the crash-safe save).

### 7. Popup Control Layer

→ State-driven views, optimistic-but-reconciled controls, the timer: **[`src/popup`](src/popup/README.md)**.

### 7.1 Settings Page

→ The settings schema + derive pipeline: **[`src/shared/settings`](src/shared/settings/README.md)** (the page UI is a thin `src/settings.ts` shell over `src/settings/SettingsController.ts`).

### 8. Meeting Provider Adapter Boundary

→ The Meet adapter boundary, transcript scraping, and meeting-end detection: **[`src/content`](src/content/README.md)**.

### 9. Shared Protocol and Messaging

→ The rpc/protocol mechanism: **[`src/shared`](src/shared/README.md)**. The full message catalogue is in [Message contract reference](#message-contract-reference) below.

### 10. Platform Adapters

→ The browser-abstraction layer (chrome seam + auth capability): **[`src/platform`](src/platform/README.md)**.

### 11. Diagnostics and Debug Dashboard

→ The diagnostics dashboard: **[`src/debug`](src/debug/README.md)** (and the [instrumentation doc](docs/plans/storage-and-instrumentation-architecture.md)).

## End-to-end flows

### Recording Start

1. Popup queries the active tab.
2. Popup resets transcript state in the content script.
3. Popup builds `RecordingRunConfig`.
4. Popup ensures microphone and camera permission readiness as needed.
5. Popup sends `START_RECORDING` to background.
6. Background normalizes the run config and transitions the canonical session to `starting`.
7. Background ensures offscreen is ready.
8. Background acquires the tab capture `streamId`.
9. Background sends `OFFSCREEN_START`.
10. Offscreen starts `RecorderEngine`.
11. Offscreen emits `OFFSCREEN_STATE(phase='recording')` once the first recorder starts.
12. Background applies that phase to the canonical session and broadcasts `RECORDING_STATE` to popup.

### Recording Stop

1. Popup sends `STOP_RECORDING`.
2. Background marks the session `stopping`.
3. Background sends `OFFSCREEN_STOP`.
4. Offscreen transitions to `stopping` and starts finalize orchestration.
5. `RecorderEngine.stop()` releases the extension-owned camera immediately, then seals artifacts.
6. Local mode calls `RecordingFinalizer` to request downloads; Drive mode enqueues a detached `UploadManager` job with the recording history id.
7. Offscreen emits `OFFSCREEN_STATE(phase='idle')` once capture is settled. Drive job progress and terminal outcomes travel separately as `OFFSCREEN_UPLOAD_STATE`.
8. Background persists the final capture state, upload job, and history outcome, then broadcasts the updated popup view. It acknowledges terminal job state only after that persistence completes.

### Transcript Download

1. Popup sends `GET_TRANSCRIPT` to the active tab.
2. Content script flushes open caption chunks.
3. Content script returns transcript text and provider info.
4. Popup downloads a local `.txt` file using the meeting identifier when available.

---

## Architecture diagrams

These diagrams are the canonical visual reference for the runtime. They are grouped so you can read them in dependency order: **topology** (what runs where), then the **control plane** (who decides start/stop), then the **media engine** (how capture works), then **persistence** (where bytes go after stop), then **transcript / auto-stop**, and finally **permissions and diagnostics**. Every box and edge maps to a named symbol or file in `src/` so the picture stays honest against the code.

---

**Topology — what runs where**

### 1. Runtime Context Map

Four isolated MV3 contexts plus the optional debug page, the media sources they pull from, and the persistence/sinks they write to. Solid edges are commands/data; dashed edges are best-effort or diagnostic.

```mermaid
graph TB
    U["User"]

    subgraph EXT["Chrome Extension (Manifest V3)"]
        P["Popup<br/><i>disposable UI · owns no state</i>"]
        RH["Recordings Page<br/><i>cursor-paged history UI</i>"]
        SET["Settings Page<br/><i>presets + tooltips</i>"]
        MIC["micsetup.html"]
        CAM["camsetup.html"]
        B["Background Service Worker<br/><b>canonical session · privileged APIs</b>"]
        O["Offscreen Document<br/><b>only MV3 media runtime</b>"]
        C["Content Script<br/><i>meet.google.com</i>"]
        Dbg["Debug Dashboard<br/><i>dev builds only</i>"]
    end

    subgraph SRC["Media sources"]
        T["Google Meet Tab<br/>(tabCapture streamId)"]
        MICDEV["Microphone<br/>(getUserMedia)"]
        CAMDEV["Camera<br/>(getUserMedia)"]
    end

    subgraph PERSIST["Persistence & sinks"]
        SES["chrome.storage.session<br/>session + detached jobs + perf snapshot"]
        HIST["IndexedDB<br/>recording history"]
        LOC["chrome.storage.local<br/>settings + recovery markers/outbox"]
        OPFS["OPFS temp files<br/>(live capture buffer)"]
        DL["Chrome Downloads"]
        Drive["Google Drive API"]
    end

    U -->|click action| P
    U -->|dev link| Dbg
    P -->|gear| SET
    P -->|history| RH
    P -.->|on denied mic| MIC
    P -.->|on denied camera| CAM

    P -->|"START/STOP/DISCARD · upload controls"| B
    RH -->|"list/rename/remove/open"| B
    P -->|"GET/RESET_TRANSCRIPT"| C
    C -->|observe captions DOM| T
    C -->|"MEETING_ENDED"| B

    B <-->|"Port RPC + capture/upload state/save"| O
    B -->|"acquire streamId"| T
    B <-->|persist / hydrate| SES
    B <-->|history transitions| HIST
    SET <-->|load / save| LOC
    B -->|"download (local mode)"| DL

    O -->|"MediaRecorder chunks"| OPFS
    O -->|"getUserMedia"| MICDEV
    O -->|"getUserMedia"| CAMDEV
    O -->|"capture stream"| T
    O -->|"resumable upload (drive mode)"| Drive
    O -.->|"OFFSCREEN_SAVE → background downloads"| B

    C -.->|"PERF_EVENT"| B
    O -.->|"PERF_EVENT"| B
    Dbg -->|read snapshot| B
```

### 2. Module Layering and Dependency Direction

Dependencies point **downward only**. Feature modules depend on shared contracts and the platform wrappers; nothing in a feature module calls `chrome.*` directly. The offscreen layer is the only one that touches raw Web media APIs.

```mermaid
graph TD
    subgraph ENTRY["Entrypoints (webpack bundles to dist/)"]
        bg["background.ts"]
        off["offscreen.ts"]
        pop["popup.ts"]
        rec["recordings.ts"]
        scr["scrapingScript.ts"]
        setp["settings.ts"]
        dbg["debug.ts"]
    end

    subgraph FEAT["Feature modules"]
        bgmod["background/*<br/>Controller · Session · OffscreenManager"]
        offmod["offscreen/*<br/>RecorderEngine · Finalizer · Drive"]
        popmod["popup/*<br/>controllers · permission services"]
        recmod["recordings/*<br/>history controller · view"]
        cont["content/*<br/>adapter · buffer · end detector"]
    end

    subgraph SHARED["src/shared — typed contracts (no chrome.* I/O)"]
        sh["protocol · messages · rpc<br/>recording domain · settings · perf"]
    end

    subgraph PLAT["src/platform/chrome — thin Chrome wrappers"]
        pl["action · downloads · identity · offscreen<br/>runtime · storage · tabs"]
    end

    subgraph HOST["Browser / Chrome APIs"]
        ch["chrome.*"]
        web["MediaRecorder · AudioContext<br/>OPFS · getUserMedia"]
    end

    bg --> bgmod
    off --> offmod
    pop --> popmod
    rec --> recmod
    scr --> cont
    setp --> sh
    dbg --> sh

    bgmod --> sh
    offmod --> sh
    popmod --> sh
    recmod --> sh
    cont --> sh

    bgmod --> pl
    offmod --> pl
    popmod --> pl
    recmod --> pl
    cont --> pl

    pl --> ch
    offmod --> web
```

> The platform layer wraps Chrome **operations** only. Entry-point listener
> *registration* (`onMessage` / `onConnect` / `onSuspend`) stays inline in the
> entrypoints — see [ADR-0001](docs/adr/0001-platform-chrome-is-a-utility-layer-not-a-port.md).

### 3. Service Worker Lifecycle, Keep-Alive & Rehydration

→ Moved to its module: **[`src/background`](src/background/README.md)** (the MV3 SW-lifecycle diagram).

### 4. Recording Start / Stop Control Plane

Every start and stop — popup buttons, tab auto-stop, and the content-script meeting-ended signal — funnels through `RecordingController`, which owns the session transitions and the offscreen RPC handshake. Each run carries a monotonic **epoch** (a fencing token): the background stamps it on `start()`, sends it in `OFFSCREEN_START`, and drops any `OFFSCREEN_STATE` whose epoch ≠ the current run — so stale status from a previous run (after a port reconnect or service-worker restart) can't clobber the session. See [ADR-0003](docs/adr/0003-recording-phase-ownership-and-stale-offscreen-status.md).

```mermaid
sequenceDiagram
    actor User
    participant P as Popup
    participant C as Content Script
    participant B as RecordingController
    participant S as RecordingSession
    participant OM as OffscreenManager
    participant O as Offscreen
    participant E as RecorderEngine

    rect rgba(238,246,255,0)
    note over User,E: START
    User->>P: Start recording
    P->>P: ensure mic / camera permission ready
    P->>C: RESET_TRANSCRIPT
    P->>B: START_RECORDING(tabId, runConfig)
    B->>B: parseRunConfig + tabCapture conflict check
    B->>B: loadRecorderRuntimeSettingsSnapshot()
    B->>B: resolveMeetingSlug(tabId)
    B->>S: start(runConfig) → starting (epoch++)
    S-->>B: persist + broadcast RECORDING_STATE
    B->>OM: ensureReady()
    OM-->>B: offscreen ready (Port)
    B->>OM: getMediaStreamIdForTab(tabId)
    B->>O: OFFSCREEN_START(streamId, slug, runConfig, recorderSettings, epoch)
    O->>E: startFromStreamId(...)
    E->>E: acquire tab stream + mic/mixer + start tasks
    E-->>O: first recorder onstart → notifyPhase(recording)
    O-->>B: OFFSCREEN_STATE(recording, epoch)
    B->>B: fence — drop if epoch ≠ current run (ADR-0003)
    B->>S: applyOffscreenPhase(recording)
    S-->>P: RECORDING_STATE + badge REC
    end

    rect rgba(255,245,238,0)
    note over User,E: STOP (also fired by auto-stop / MEETING_ENDED)
    User->>P: Stop recording
    P->>B: STOP_RECORDING
    B->>S: markStopping()
    B->>O: OFFSCREEN_STOP
    O->>E: stop()
    E->>E: release camera eagerly, seal tab / mic / self-video
    O-->>B: OFFSCREEN_STATE(stopping, epoch)
    alt storageMode = local
        O->>B: OFFSCREEN_SAVE (per artifact)
    else storageMode = drive and artifacts > 0
        O->>O: UploadManager.enqueue(sealed artifacts)
        O-->>B: OFFSCREEN_UPLOAD_STATE(uploading job) + badge UP
    end
    O-->>B: OFFSCREEN_STATE(idle, epoch) or (failed, error)
    B->>S: applyOffscreenPhase(...)
    S-->>P: RECORDING_STATE (capture idle; upload job may remain) + badge UP / ERR
    end
```

### 5. Recording Session State Machine (Background)

→ Moved to **[`src/shared`](src/shared/README.md)** (the derived-phase lifecycle) / **[`src/background`](src/background/README.md)**.

### 6. Offscreen Ready / Reconnect Handshake

`OffscreenManager.ensureReady()` either creates the offscreen document or asks an existing one to reconnect, then waits (Promise, not poll) for the `OFFSCREEN_READY` handshake. The offscreen side reconnects its port with exponential backoff after the worker sleeps or the page is torn down.

```mermaid
sequenceDiagram
    participant B as OffscreenManager
    participant API as Chrome Offscreen API
    participant O as Offscreen Script

    B->>B: ensureReady() — resolve immediately if port + ready
    B->>API: hasOffscreenDocument()
    alt no offscreen context
        B->>API: createOffscreenDocument(reasons: BLOBS, AUDIO_PLAYBACK, USER_MEDIA)
    else context exists, no live port
        B->>O: OFFSCREEN_CONNECT (runtime message)
    end

    O->>B: runtime.connect(name=offscreen)
    O->>B: OFFSCREEN_READY
    O->>B: OFFSCREEN_STATE(currentPhase, epoch, warnings?)
    B->>B: ready=true, resolve readyPromise, set badge
    Note over B: re-broadcast is epoch-fenced — a stale phase from a prior run is dropped (ADR-0003)
    Note over B: withTimeout(READY_TIMEOUT_MS = 5s) outer safety net

    opt Port drops (SW idle / crash)
        O->>O: onDisconnect → reconnect backoff 1s, 2s ... capped 30s
        O->>B: runtime.connect + OFFSCREEN_READY (re-handshake)
    end
```

---

**Media engine — how capture works**

### 7. Recorder Engine Internal Architecture

→ Moved to **[`src/offscreen/engine`](src/offscreen/engine/README.md)** (the capture→encode dataflow).

### 8. Recorder Engine State Machine (Offscreen)

→ Moved to **[`src/offscreen/engine`](src/offscreen/engine/README.md)** (the engine state machine).

### 9. Mixed-Mic Audio Graph

→ Moved to **[`src/offscreen/engine`](src/offscreen/engine/README.md)** (the mixed-mic audio graph).

### 10. OPFS Streaming & Storage-Target Fallback

This diagram (chunk → backpressure → fallback ladder → seal, with the protective-stop and RAM-cap escalations) now lives with the subsystem it documents:
→ [`src/offscreen/storage/README.md`](src/offscreen/storage/README.md#diagram-opfs-streaming--storage-target-fallback).

---

**Persistence — where bytes go after stop**

### 11. Post-Stop Persistence Pipeline

→ Moved to **[`src/offscreen`](src/offscreen/README.md)** (the stop→finalize pipeline).

### 12. Drive Folder Resolution & Resumable Upload Session

→ Moved to **[`src/offscreen/drive`](src/offscreen/drive/README.md)** (the resumable-upload protocol).

### 13. Drive OAuth Token Fallback

→ Moved to **[`src/offscreen/drive`](src/offscreen/drive/README.md)** (token use) + **[`src/platform/capabilities`](src/platform/capabilities/README.md)** (acquisition).

### 14. Transcript Collection Pipeline

→ Moved to **[`src/content`](src/content/README.md)** (the transcript-collection diagram).

### 15. Meeting-End Auto-Stop

A deliberately conservative content-script detector: it only arms after a live call is seen, then requires a 30-second grace window of "ended" state before signalling. Two hard background triggers (tab closed, tab navigated away) bypass the grace entirely.

```mermaid
stateDiagram-v2
    [*] --> watching
    watching --> active: leave-call control present
    active --> active: still in call
    active --> pendingEnd: control gone or ended-text (scheduleEnd, grace 30s)
    pendingEnd --> active: call controls reappear (cancel)
    pendingEnd --> ended: grace elapsed and still not active
    ended --> [*]: emit MEETING_ENDED (once)

    note right of watching
        Observes body mutations + polls every
        MEETING_END_POLL_MS (2s). Never fires unless
        an active call was seen first — favors late
        stops over false auto-stops.
    end note

    note right of ended
        Background recordingAutoStop also hard-stops on:
        - recorded tab closed (tab-removed)
        - tab navigated away from the meeting
        Each routes through RecordingController.stop(),
        guarded by matching tabId + meetingSlug.
    end note
```

---

**Permissions & diagnostics**

### 16. Microphone & Camera Permission Readiness

→ Moved to **[`src/popup`](src/popup/README.md)** (the permission-readiness flow).

### 17. Diagnostics / Perf Event Flow

All runtime contexts emit structured `PERF_EVENT`s through `configurePerfRuntime`. The background store reduces them into a session-scoped snapshot that the dev dashboard renders; the snapshot is reset at the **start of the next recording** (not on idle), so a finished run survives for export, and the event log is bounded so a long run can't overflow the storage quota.

```mermaid
flowchart LR
    subgraph SRC["PERF_EVENT sources (configurePerfRuntime)"]
        CS["content<br/>observer_count · long_task"]
        OS["offscreen<br/>recorder_started · chunk_persisted<br/>drive_* · runtime sample"]
        BG["background"]
    end
    CS -->|PERF_EVENT| RT["runtime.sendMessage"]
    OS -->|PERF_EVENT| RT
    BG --> STORE
    RT --> STORE["PerfDebugStore.record()"]
    STORE --> RED["PerfDebugReducers"]
    RED --> ST["PerfDebugState<br/>(session-scoped snapshot)"]
    ST --> PERSIST["chrome.storage.session"]
    ST --> DASH["DebugDashboard (dev)<br/>EventTableRenderer + SystemInfoReader"]
    PERSIST -.->|hydrate on SW restart| STORE
    ST -.->|reset at next recording start| X["isFreshRecordingStart"]
```

---

## Message contract reference

### Popup → Background

| Message | Payload | Response |
| :--- | :--- | :--- |
| `START_RECORDING` | `tabId`, `runConfig` | `CommandResult` with session snapshot |
| `STOP_RECORDING` | none | `CommandResult` with session snapshot |
| `DISCARD_RECORDING` | none | `CommandResult`; deletes temporary artifacts without delivery |
| `GET_RECORDING_STATUS` | none | current session snapshot |
| `RETRY_UPLOAD_JOB` / `CANCEL_UPLOAD_JOB` | `jobId` | `CommandResult`; retry is bounded by retained artifact availability, cancel falls back locally |
| `GET_DRIVE_TOKEN` | optional `refresh` | token or error |
| `LIST_RECORDING_HISTORY` | optional `(createdAt, id)` cursor | cursor page of history entries |
| `RENAME_RECORDING_HISTORY` | entry id + requested title | updated entry/session; current Drive rows rename remote folder/files before history commits |
| `SKIP_RECORDING_NAMING` | completed upload `jobId` | authoritative session with its one-time naming prompt marked handled |
| `REMOVE_RECORDING_HISTORY` | entry id | atomic soft delete |
| `OPEN_RECORDING_HISTORY_FILE` | recording id + file id | open a confirmed local Chrome download |

### Popup → Content

| Message | Response |
| :--- | :--- |
| `GET_TRANSCRIPT` | transcript text + provider info |
| `RESET_TRANSCRIPT` | `{ ok: true }` |
| `GET_CAPTION_STATE` | `{ captionsActive: boolean }` |

### Offscreen → Background

| Message | Meaning |
| :--- | :--- |
| `OFFSCREEN_READY` | offscreen port is attached and ready |
| `OFFSCREEN_STATE` | phase transition or finalize result; carries the fenced run `epoch` and optional bounded telemetry snapshot |
| `OFFSCREEN_SAVE` | request a local save through background |
| `OFFSCREEN_UPLOAD_STATE` | current or terminal detached Drive job plus optional telemetry-only run association/snapshot; terminal jobs replay until acknowledged |
| `TELEMETRY_SNAPSHOT` / `TELEMETRY_FLUSH` | bounded producer aggregate for background merge/checkpoint or lifecycle flush; never per-event media/text data |

### Content Script → Background

| Message | Meaning |
| :--- | :--- |
| `MEETING_ENDED` | Meet page entered a post-call state; routed to auto-stop, which stops any active recording |
| `TELEMETRY_SNAPSHOT` | bounded caption counts/totals/maxima and sanitized incidents for the current telemetry-only run |

### Background → Content

| Message | Meaning |
| :--- | :--- |
| `TELEMETRY_RUN` | start/reset the caption reducer for a random telemetry-only run, or disable it on opt-out |
| `TELEMETRY_GET_SNAPSHOT` | request the final bounded caption aggregate before stopping capture |

### Background → Offscreen

| Message | Meaning |
| :--- | :--- |
| `OFFSCREEN_START` | begin a run for a specific `streamId`/`runConfig`; carries independent fenced `epoch` and telemetry-only run ID |
| `OFFSCREEN_STOP` | stop active recording and begin finalize flow |
| `OFFSCREEN_DISCARD` | stop capture and delete sealed temporary artifacts without delivery |
| `OFFSCREEN_RETRY_UPLOAD` / `OFFSCREEN_CANCEL_UPLOAD` | control a detached Drive job by id |
| `OFFSCREEN_RENAME_DRIVE_RESOURCES` | rename an exact bounded list of Drive file/folder IDs and names with rollback-aware result |
| `OFFSCREEN_ACK_UPLOAD_STATE` | confirms background/session/history persistence of a terminal upload state, allowing outbox removal |
| `REVOKE_BLOB_URL` | release local save blob URLs and optionally cleanup OPFS temp files |
| `OFFSCREEN_CONNECT` | ask an existing offscreen page to reconnect its runtime port |

### Background → Popup

| Message | Meaning |
| :--- | :--- |
| `RECORDING_STATE` | canonical session snapshot update |
| `RECORDING_SAVED` | local save succeeded |
| `RECORDING_SAVE_ERROR` | local save failed |

---

## Project structure

```
.
├─ static/       # source HTML shells and manifest (webpack copies to dist/)
├─ public/       # shared static assets copied to dist/ (e.g. gear.png)
├─ src/
│  ├─ background.ts / background/    # service worker and session lifecycle
│  ├─ offscreen.ts / offscreen/      # media runtime (recorder engine, OPFS, Drive upload)
│  ├─ popup.ts / popup/              # popup UI and permission flows
│  ├─ recordings.ts / recordings/     # recording-history page and its controller/view
│  ├─ settings.ts / settings/        # settings page (thin shell + controller)
│  ├─ scrapingScript.ts / content/   # caption scraping content script
│  ├─ debug.ts / debug/              # diagnostics dashboard
│  ├─ platform/chrome/               # thin Chrome API wrappers
│  └─ shared/                        # domain model, protocol, settings, perf types
├─ tests/        # unit and E2E test suite
└─ dist/         # build output (generated, not committed)
```

> Source HTML shells and the manifest live under `static/`. The `dist/` layout is flat (`popup.html`, `offscreen.html`, `manifest.json`, etc.) because Chrome expects extension entrypoints at the extension root.

---

## File map

→ Per-module file maps now live in each module's README (see the **Module guide** near the top). This root no longer duplicates them.

## Manifest and entry surfaces

File: `static/manifest.json`

- `oauth2.client_id` in source control is a placeholder.
- Webpack injects the real value from `.env` / shell env key `GOOGLE_OAUTH_CLIENT_ID` into `dist/manifest.json` at build time.
- If the env var is missing, build keeps the placeholder and logs a warning; Drive auth will fail until configured.
- The extension icon is declared by the top-level `icons` block and `action.default_icon` (sizes 16/32/48/128). The `icon16/32/48/128.png` set lives in `public/`; without it Chrome falls back to a generic grey placeholder for the toolbar button and the extensions menu.
- Source HTML shells and the source manifest live under `static/`, shared static assets (the `icon*.png` set and the settings-page `gear.png`) live under `public/`, and both are copied to `dist/` at build time. The emitted extension layout in `dist/` is flat because Chrome requires entrypoints at the extension root.

Extension entrypoints:

- action popup: `popup.html`
- background service worker: `background.js`
- content script: `scrapingScript.js`
- offscreen document: `offscreen.html`

---

## Operational notes

### Popup state is not authoritative

The popup is a client. The source of truth is the background `RecordingSession`.

### Service worker restarts are expected

The background service worker may be suspended and restarted by Chrome. Rehydration from `chrome.storage.session` and offscreen reconnect are required parts of the design, not edge cases.

### Offscreen is the only media runtime

Do not move capture or `MediaRecorder` logic into background. MV3 service workers cannot support it reliably.

### Local-first capture is intentional

Even in Drive mode, the extension records locally first and uploads only after stop. This avoids coupling real-time capture stability to network conditions.

### Google Meet selectors are fragile

`GoogleMeetAdapter` contains reverse-engineered selectors. If transcripts stop working after a Meet UI change, start there.

### Mixed mic mode uses a real audio graph

`mixed` is not just UI wording. It is implemented by building an audio graph and recording the composed stream.

### Local save cleanup is deferred

Background waits before revoking blob URLs and optionally removing OPFS files so the handoff to Chrome Downloads is not cut off too early.

### Diagnostics are session-scoped

Perf debug data is persisted in session storage and cleared when appropriate. The dashboard is meant for development and runtime diagnosis, not user-facing product state.

---

## Safe extension points

If you need to extend the system, prefer these seams:

- **Add a new meeting provider** — implement `MeetingProviderAdapter`; keep provider-specific selector logic out of `TranscriptCollector`.

- **Add a new storage backend** — preserve `RecorderEngine` as a local artifact producer; extend post-stop persistence around `RecordingFinalizer`.

- **Add new runtime commands** — update `src/shared/protocol.ts`; add typed helpers in `src/shared/messages.ts` if needed; keep message payload normalization in shared/domain code.

- **Change lifecycle behavior** — start in `RecordingSession`; keep background as the canonical owner of session state.

- **Change media behavior** — prefer `RecorderCapture`, `RecorderProfiles`, or `RecorderAudio` before expanding `RecorderEngine`.

---

The architecture is intentionally split into: a canonical background session model, an offscreen media runtime, a post-stop persistence pipeline, a disposable popup UI, a provider-adapter-based transcript collector, a typed shared message contract, and thin Chrome platform wrappers. That split is the main structural rule to preserve as the extension grows.
