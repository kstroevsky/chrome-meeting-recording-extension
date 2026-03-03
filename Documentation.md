# Chrome Extension Analysis & Documentation

## Project Overview
This extension is designed to **record Google Meet sessions** (audio + video) and **transcribe live captions**. It solves the limitation of Chrome Extensions not being able to access `MediaRecorder` or raw audio streams directly in service workers (Manifest V3) by utilizing an **Offscreen Document**.

## Architecture (Manifest V3)
The extension follows the modern MV3 architecture handling specific constraints around persistent background scripts and DOM access.

### 1. **Background Service Worker** (`background.ts`)
- **Role**: Orchestrator.
- **Responsibility**:
    - Runs as an event-driven service worker (terminates when idle).
    - Manages the lifecycle of the **Offscreen Document**.
    - Generates the `tabCapture` stream ID (`chrome.tabCapture.getMediaStreamId`).
    - Acts as a bridge between the **Popup** (UI) and the **Offscreen** (Recording Logic).

### 2. **Offscreen Document** (`offscreen.ts` / `offscreen.html`)
- **Role**: The Recording Studio.
- **Responsibility**:
    - Exists to provide a DOM environment for `MediaRecorder` and `AudioContext`.
    - Captures the tab stream using the `streamId` provided by the background.
    - Captures the Microphone stream (`navigator.mediaDevices.getUserMedia`).
    - **Keeps Audio Separate**: Records tab audio+video and mic audio into separate files.
    - Encodes the video/audio into `.webm` files.
    - Handles the file download process.

### 3. **Content Script** (`scrapingScript.ts`)
- **Role**: The Transcriber.
- **Responsibility**:
    - Injected into `https://meet.google.com/*`.
    - improved user privacy by running locally.
    - Uses a `MutationObserver` to watch specifically for Google Meet caption elements (obfuscated classes like `.ygicle`).
    - Debounces and collects caption fragments into a coherent transcript.
    - Sends the transcript to the Popup when requested.

### 4. **Popup & UI** (`popup.ts`)
- **Role**: Control Panel.
- **Responsibility**:
    - Allows user to Start/Stop recording.
    - Allows user to Save Transcript.
    - Handles Microphone Permissions "Priming" (opening `micsetup.html`).

## Data Flow

### Message Flow Diagram

```mermaid
sequenceDiagram
  participant P as Popup
  participant B as Background (SW)
  participant O as Offscreen
  participant C as Content Script (Meet)

  P->>C: RESET_TRANSCRIPT
  P->>B: START_RECORDING(tabId)
  B->>B: ensureOffscreen()
  B->>B: getMediaStreamId(tabId)
  B->>O: OFFSCREEN_START(streamId) [Port RPC]
  O->>O: getUserMedia(streamId) + MediaRecorder.start
  O-->>B: RECORDING_STATE(recording=true) [Port event]
  B-->>P: RECORDING_STATE(recording=true) [runtime.sendMessage]

  P->>B: STOP_RECORDING
  B->>O: OFFSCREEN_STOP [Port RPC]
  O-->>B: OFFSCREEN_SAVE(blobUrl, filename) [Port event]
  B->>B: downloads.download(blobUrl)
  B-->>P: RECORDING_SAVED
```

### Recording Flow
1. **User** clicks "Start Recording" in Popup.
2. **Popup** sends `START_RECORDING` -> **Background**.
3. **Background**:
    - Checks if **Offscreen** exists; creates it if not.
    - calls `chrome.tabCapture.getMediaStreamId` to get a secure `streamId` for the current tab.
    - Sends `OFFSCREEN_START` + `streamId` -> **Offscreen**.
4. **Offscreen**:
    - Receives `streamId`.
    - Calls `navigator.mediaDevices.getUserMedia` (using `chromeMediaSource: 'tab'`).
    - Calls `navigator.mediaDevices.getUserMedia` (for Microphone).
    - Starts tab `MediaRecorder` (video + tab audio).
    - Starts mic `MediaRecorder` (audio-only) when permitted.
5. **Stop**:
    - User clicks Stop.
    - **Offscreen** stops recorder -> produces `Blob`.
    - **Offscreen** messages Background to download the file.

### Transcription Flow
1. **Content Script** observes DOM changes on Google Meet.
2. Captures text from `.ygicle` / `.nMcdL` elements.
3. specific logic handles "unstable" captions (Google Meet updates captions live as you speak) by using a grace period/debounce before "committing" a line to the transcript array.
4. **User** clicks "Save Transcript" in Popup.
5. **Popup** requests `GET_TRANSCRIPT` from Content Script.
6. **Content Script** returns joined text.

## File Breakdown

| File | Context | Description |
| :--- | :--- | :--- |
| `src/background.ts` | Service Worker | Entry point. Wires `OffscreenManager` and message handlers. |
| `src/background/OffscreenManager.ts` | Service Worker | Offscreen lifecycle, Port connection, RPC client, badge, downloads. |
| `src/offscreen.ts` | Offscreen Document | Entry point. Wires `RecorderEngine` and Port RPC server. |
| `src/offscreen/RecorderEngine.ts` | Offscreen Document | MediaRecorder capture, mixing, saving. State machine for recording lifecycle. |
| `src/popup.ts` | Popup Page | Entry point. Passes DOM elements to `PopupController`. |
| `src/popup/PopupController.ts` | Popup Page | Start/stop, transcript download, recording state UI. |
| `src/popup/MicPermissionService.ts` | Popup Page | Permission query, inline priming, opens micsetup tab when needed. |
| `src/scrapingScript.ts` | Content Script | Watches Google Meet DOM for captions. `TranscriptCollector` class. |
| `src/micsetup.ts` | Browser Tab | Full-page permission primer for microphone. |
| `src/shared/protocol.ts` | All contexts | **Source of truth** for all inter-context message types. |
| `src/shared/rpc.ts` | All contexts | Port-based bidirectional RPC helpers (client + server). |
| `src/shared/timeouts.ts` | All contexts | Named constants for all timeout and poll values. |
| `src/shared/logger.ts` | All contexts | Prefixed logger factory (`makeLogger`). |
| `src/shared/async.ts` | All contexts | `sleep` and `withTimeout` utilities. |
| `manifest.json` | Chrome | Permissions (`tabCapture`, `offscreen`, `activeTab`) and entry points. |

## Key Concepts & logic

### The "Offscreen" Pattern
In Manifest V3, background scripts are Service Workers and cannot access DOM APIs like `MediaRecorder` or `AudioContext`. To record audio/video, extensions must create an "Offscreen Document" (`chrome.offscreen.createDocument`). This document is invisible but has full DOM access.

### Separate Audio Outputs
To keep meeting audio (tab) and mic audio separate, the extension records:
- **Tab stream**: Video + tab audio into a `.webm` file.
- **Mic stream**: Audio-only into a separate `.webm` file.

### Obfuscated Selectors
`scrapingScript.ts` relies on specific class names (`.ygicle`, `.NWpY1d`) used by Google Meet. These are likely generated classes and **may break** if Google updates their frontend code. The script attempts to find these elements via `aria-label="Captions"` regions to be somewhat robust.
