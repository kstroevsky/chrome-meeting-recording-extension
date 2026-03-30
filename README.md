# Meeting Recording Extension (Chrome Extension)

*Copyright (c) 2026 Kostiantyn Stroievskyi. All Rights Reserved.*

No permission is granted to use, copy, modify, merge, publish, distribute, sublicense, or sell copies of this software or any portion of it, for any purpose, without explicit written permission from the copyright holder.

-----

Scrape live captions from a Google Meet and save them as a `.txt` transcript, or record the current Google Meet tab (video + audio) to a `.webm` file. Microphone capture is explicit per run: off, mixed into the main recording, or saved as a separate audio file.

Everything happens in your browser, and capture is local-first.
Current note: when `drive` storage mode is selected the finalized files are uploaded to Google Drive after stop.

## Features

**Transcript saver** – parses Google Meet’s live captions and downloads a timestamped .txt file.

**Tab recorder** – captures Google Meet tab video + audio into a .webm via MediaRecorder, with the selected tab preset enforced on the final saved file.

**Direct-to-Disk / Cloud Storage Flow** — stream recording chunks directly to Origin Private File System (OPFS) during capture to prevent memory crashes on 2-hour+ meetings, then finalize to local download or Drive upload. Memory is strictly bounded to a 5MB buffer!
Current note: Drive uploads happen during finalization after stop, not as live in-meeting cloud streaming.

**Drive folder organization** — in Drive mode, recordings are saved under `Google Meet Records/<google-meet-id>-<timestamp>/`.

**Explicit microphone modes** – disable mic capture, mix microphone into the tab recording, or save the mic as a separate `.webm` audio file.

**Optional self video capture** – record your camera feed as a separate `.webm` file via popup checkbox.

**MV3/Offscreen architecture** – recording runs in a hidden offscreen document. Resilient to Service Worker suspension with keep-alive routines and event-driven backoff reconnects!

## How it works (high level)

1. Content script watches the Google Meet caption DOM and buffers text with timestamps.

2. Popup lets you download the transcript or control recording.

3. Background service worker creates/coordinates an offscreen document and requests the correct capture streamId for the active tab. It also maintains a keep-alive interval and session-storage to prevent state loss if Chrome suspends the worker.

4. Offscreen page captures the tab, applies the selected microphone mode, and streams the recording buffer via OPFS-backed chunking before saving locally or uploading to Google Drive after stop.
Current note: Drive mode uploads finalized files after stop and can fall back per-file to local download if an upload fails.

## Requirements

**Google Chrome** (or Chromium-based browser) with `Manifest V3` support and the `Offscreen API`.

**Node.js 18+** and **npm** (or **pnpm/yarn**) to build the extension.

The extension uses the following Chrome permissions:
`activeTab`, `downloads`, `tabCapture`, `offscreen`, `storage`, `tabs`, `desktopCapture`
and is scoped to `https://meet.google.com/*`.
Current note: Drive mode also relies on `identity` permission and host access to `https://www.googleapis.com/*`.

## Quick start
1) Clone and install
```
git clone https://github.com/kstroevsky/chrome-meeting-recording-extension.git
cd chrome-recording-transcription-extension
npm install
```

2) Build
```
npm run build   # outputs to `./dist`
```
If you plan to use Drive mode, also create `.env` from `.env.example` and set `GOOGLE_OAUTH_CLIENT_ID` before building.

3) Load into Chrome
- Open `chrome://extensions`
- Toggle "Developer mode" (top right)
- Click "Load unpacked"
- Select the `./dist` folder


Open a Google Meet, click the extension icon:
 - **Download Transcript** – saves a `.txt` of the live captions (turn captions ON in Google Meet).
 - **Enable Microphone** – grants mic permission so microphone modes can be used reliably.
 - **Microphone Mode** — choose `Off`, `Mix into tab recording`, or `Save separately`.
 - **Storage Mode Dropdown** — Choose whether to finalize files to Local Disk or upload them to Google Drive after stop.
 - **Record my camera separately** — optional checkbox to save your camera stream as a separate recording file.
 - **Start Recording (tab) / Stop Recording** – creates a `.webm` file streamed continuously to the local capture target and then finalizes it according to the selected storage mode.
Current note:
- The current popup button labels are `Start Recording` and `Stop Recording`.
- In `drive` mode the finalized files upload after stop; they are not streamed directly to Drive during capture.

## Install & build (detailed)

**1. Install Node**
  - macOS: `brew install node`

  - Ubuntu/Debian: `sudo apt-get install -y nodejs npm`

  - Verify: `node -v && npm -v`

**2. Install dependencies**

```
npm install
```


**3. Build once (production)**

```
npm run build
```

This compiles TypeScript via `ts-loader` and copies the HTML/manifest to `dist/`.

**4. Load the extension**

  - Visit `chrome://extensions`
  - Turn on `Developer mode`
  - Click `Load unpacked` → select the `dist` directory that was created inside your repo when you ran `npm run build`

> During development you can also run:
> `npm run watch` which will force a rebuild on file changes (when you save a file)
> After each rebuild, click Reload on the extension (in `chrome://extensions`) to pick up changes. If you changed the service worker or manifest, you must reload the extension; for content script-only changes, a page refresh of the Google Meet tab may be enough.

## Using the extension

1. Open a Google Meet at https://meet.google.com/...

2. (For transcripts) turn on Captions in Google Meet.

3. Click the extension icon (puzzle → pin it for quick access).

4. In the popup:
 
  - **Download Transcript**: Turn closed captions on then hit Download Transcript after the meeting. This saves **google-meet-transcript-<meeting-id>-<timestamp>.txt**
  - ** Recording **
      - **Enable Microphone** - Turn on before you hit "Start Recording" so microphone modes can be used without a startup error
        - The mic prompt may not appear reliably in a popup. If so, the button opens a dedicated `Enable Microphone` page (`micsetup.html`) where you can click `Enable` and allow mic access.
        - Once granted, the label changes to `Microphone Enabled`.
      - **Microphone Mode**: `Off` skips microphone capture, `Mix into tab recording` blends your mic into the main tab file, and `Save separately` creates an additional `google-meet-mic-<meeting-id>-<timestamp>.webm`.
      - **Start Recording**: Starts a recording of the current tab (video + system audio) using the selected storage, microphone, and optional self-video settings.
        - The extension captures the tab at a stable ceiling, tries live downscale for performance, and if that live path cannot deliver the requested preset it downscales the finalized tab file before save/upload.
      - **Record my camera separately**: If checked, starts an additional camera-only recorder and saves `google-meet-self-video-<meeting-id>-<timestamp>.webm`. If camera permission is missing, a camera setup tab opens.
        - Camera quality is controlled only by the extension settings; Meet's own video setting does not change the separate camera file.
        - The extension always tries the same fallback ladder for camera capture: exact preset size/FPS, then exact size with bounded FPS, then best-effort preset constraints.
        - The actual recorded resolution still depends on Chrome, camera sharing, and hardware limits. If the browser delivers a lower profile, the popup/debug status shows a warning instead of hiding the mismatch.
      - **Stop Recording** (older wording: `Stop & Download`): Releases the extension-owned camera immediately, then finalizes the recording and downloads it locally or uploads it to Drive depending on the selected storage mode.

> The extension shows a “REC” badge while recording. All files are saved locally via Chrome’s Downloads API.
Current note: in `drive` mode the popup may pass through an `uploading` phase after stop before returning to idle.

## Project structure
```
.
├─ README.md
├─ Documentation.md
├─ webpack.config.js
├─ tsconfig.json
├─ package.json
├─ jest.config.js
├─ static/
│  ├─ manifest.json      # source manifest copied/transformed into dist/
│  ├─ popup.html         # popup HTML shell
│  ├─ debug.html         # diagnostics HTML shell
│  ├─ offscreen.html     # offscreen document shell
│  ├─ micsetup.html      # microphone permission setup page
│  └─ camsetup.html      # camera permission setup page
├─ src/
│  ├─ background.ts                 # MV3 service worker entrypoint
│  ├─ offscreen.ts                  # offscreen runtime entrypoint
│  ├─ popup.ts                      # popup entrypoint
│  ├─ debug.ts                      # diagnostics entrypoint
│  ├─ scrapingScript.ts             # caption scraping content script
│  ├─ micsetup.ts                   # mic setup page logic
│  ├─ camsetup.ts                   # camera setup page logic
│  ├─ background/
│  │  ├─ OffscreenManager.ts
│  │  ├─ PerfDebugStore.ts
│  │  ├─ RecordingSession.ts
│  │  └─ driveAuth.ts
│  ├─ offscreen/
│  │  ├─ DriveTarget.ts
│  │  ├─ LocalFileTarget.ts
│  │  ├─ RecorderAudio.ts
│  │  ├─ RecorderCapture.ts
│  │  ├─ RecorderEngine.ts
│  │  ├─ RecorderProfiles.ts
│  │  ├─ RecorderSupport.ts
│  │  ├─ RecordingFinalizer.ts
│  │  ├─ TabArtifactPostprocessor.ts
│  │  ├─ errors.ts
│  │  └─ drive/                     # Drive upload helpers
│  ├─ popup/
│  │  ├─ PopupController.ts
│  │  ├─ popupRunConfig.ts
│  │  ├─ popupView.ts
│  │  ├─ popupStatus.ts
│  │  ├─ popupMessages.ts
│  │  ├─ MicPermissionService.ts
│  │  └─ CameraPermissionService.ts
│  ├─ platform/
│  │  └─ chrome/                    # thin wrappers for Chrome APIs
│  ├─ debug/
│  ├─ content/
│  └─ shared/
│     ├─ recording.ts
│     ├─ recordingTypes.ts
│     ├─ recordingConstants.ts
│     ├─ protocol.ts
│     ├─ protocolMessageTypes.ts
│     └─ typeGuards.ts
├─ tests/
└─ dist/                # build output (generated)
```
Current note: source HTML/manifest assets now live under `static/`, while `dist/` still emits a flat extension root (`popup.html`, `offscreen.html`, `manifest.json`, etc.) because Chrome expects those runtime entrypoints at the extension root.

## Configuration knobs

### Google Drive Setup (Important)
If you want to use the **Google Drive** storage target, you must provision an OAuth App in the Google Cloud Console:
1. Enable the Google Drive API.
2. Setup an OAuth Consent Screen and add the `https://www.googleapis.com/auth/drive.file` scope.
3. In `chrome://extensions`, confirm your extension ID after loading `dist/`.
4. Create an OAuth client with **Application type: Chrome Extension** and that exact extension ID.
5. Create a local `.env` file (or export a shell variable) with:
   - `GOOGLE_OAUTH_CLIENT_ID=<your chrome extension oauth client id>`
   - You can copy from `.env.example`.
   - If omitted, build still succeeds with a placeholder client ID, but Drive uploads will fail.
6. Build again so webpack injects it into `dist/manifest.json`.
7. Keep a stable extension ID:
   - Keep `static/manifest.json -> key` checked into your repo (already present in this project).
   - Webpack emits the runtime manifest to `dist/manifest.json`.
   - If the key changes, the extension ID changes and OAuth will fail until you recreate the Chrome Extension OAuth client for the new ID.
8. Drive mode will auto-create:
   - top-level folder: `Google Meet Records`
   - per-recording folder: `<google-meet-id>-<timestamp>`

Important: a Google credential JSON with `"installed"` is usually a Desktop client and will not work with `chrome.identity.getAuthToken` in an extension. Use a **Chrome Extension** OAuth client.

### Source Code Adjustments
- Output filenames
  - Recordings: `google-meet-recording-<meet-suffix>-<timestamp>.webm`
  - Separate microphone: `google-meet-mic-<meet-suffix>-<timestamp>.webm`
  - Self video (optional): `google-meet-self-video-<meet-suffix>-<timestamp>.webm`
  - Transcripts: `google-meet-transcript-<meet-suffix>-<timestamp>.txt`

## Scripts

`npm run build` – single production build to `dist/`
`npm run watch` – rebuild on change (remember to reload the extension in Chrome)
`npm run typecheck` – strict TS check across `src/`
`npm test` / `npm run test:unit` – unit suite without the browser-dependent E2E test
`npm run test:e2e` – browser-dependent E2E flow

## Dependencies & toolchain

- TypeScript (target es2020)
- webpack 5 + ts-loader
- copy-webpack-plugin, clean-webpack-plugin
- @types/chrome, @types/node

These are already declared in `package.json`:
```
"devDependencies": {
  "@types/chrome": "^0.0.326",
  "@types/node": "^24.0.4",
  "clean-webpack-plugin": "^4.0.0",
  "copy-webpack-plugin": "^13.0.1",
  "ts-loader": "^9.5.0",
  "typescript": "^5.8.3",
  "webpack": "^5.99.9",
  "webpack-cli": "^6.0.1"
}
```
## Permissions explained
- `activeTab`, `tabs` – query the active tab (needed to target/label the recording).
- `downloads` – save transcript/recording files locally via blob streams.
- `tabCapture` / `desktopCapture` – capture video/audio from the current tab.
- `offscreen` – create an offscreen document for safe/background recording logic.
- `storage` – store ephemeral recording-state hints (for UI sync + SW keep-alive recovery).
- `identity` – authenticate the user behind-the-scenes to write to Google Drive.
- `host_permissions: ["https://meet.google.com/*"]` – limit content script to Google Meet.
- `host_permissions: ["https://www.googleapis.com/*"]` – allow Drive API requests during Drive uploads.

## Troubleshooting / FAQ

Q: What do I do if I don’t see any transcript text?
Answer: 
 - Make sure `Captions` are enabled in the Google Meet UI.
 - The extension only scrapes from `https://meet.google.com/*`.
 - Reload the Google Meet page after (re)loading the extension.

Question: What do I do when I see: “Failed to start recording: Offscreen not ready” or similar?
Answer: 
 - Open chrome://extensions, click Reload on the extension, then try again.
 - Ensure Chrome is up to date (Manifest V3 + Offscreen API supported).
 - Some enterprise policies can block offscreen—check your admin/device policies if applicable.

No microphone audio in the recording.
- Click `Enable Microphone` in the popup. If the inline prompt fails, a Mic Setup tab opens. Click `Enable` there and allow.
- Also check the OS mic permissions for Chrome (`System Settings` → `Privacy` → `Microphone`).

Question: Why is my recording silent or very quiet?
Answer:
 - Make sure the Google Meet tab is playing audio (unmuted).
 - If you muted the site/tab or Google Meet, tab audio won’t be captured.
 - If a microphone mode is enabled, confirm the OS/input device and levels.

Question: `Stop Recording` (older docs/UI may say `Stop & Download`) finishes but no file appears. What do I do?
Answer:
 - Check the browser Downloads panel.
 - If you have “Ask where to save each file” enabled, a save dialog should appear.
 - Some download managers/extensions can interfere. Disable and retry.

Question: Why are the popup buttons not enabling/disabling correctly?
Answer:
 - The popup reflects state broadcast from `background`/`offscreen`. If it gets out of sync, stop the recording (if any), then click `Reload` on the extension in `chrome://extensions`.

Question: I see `Token fetch failed ... bad client id` when saving to Google Drive.
Answer:
 - This means Google rejected `manifest.oauth2.client_id` for extension auth.
 - Verify the OAuth credential type is **Chrome Extension** (not Web/Desktop/Installed).
 - Verify the OAuth client was created for the exact ID shown in `chrome://extensions`.
 - Verify your OAuth consent screen includes `https://www.googleapis.com/auth/drive.file` and your account is added as a test user if the app is in Testing mode.
 - Rebuild (`npm run build` or `npm run watch`) after updating `.env`, then reload the extension and retry Drive mode.

Question: I see `Drive session init failed: 403`.
Answer:
 - Open extension logs and read the full error detail (the extension now includes Google API message text).
 - If detail mentions `insufficientPermissions`/`scope`, re-consent and verify `https://www.googleapis.com/auth/drive.file` is configured.
 - If detail mentions `accessNotConfigured` or `Drive API has not been used`, enable Drive API in the same project as your OAuth client.
 - If detail mentions test users / consent restrictions, add your account to OAuth test users or publish the consent screen.

## Development tips

 - Use `npm run watch` during iteration.
 - Background logs appear in the `service worker` console:
    - `chrome://extensions` → your extension → `service worker` → `Inspect`
 - Offscreen logs: open `chrome://extensions` → your extension → `service worker` → look for messages from `[offscreen]`.
- Content script logs: in the Google Meet tab → DevTools Console.
