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
    - **Mixes Audio**: Merges Tab Audio + Mic Audio into a single stream using Web Audio API.
    - Encodes the video/audio into a `.webm` file.
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

---

## Data Flow

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
    - Mixes streams.
    - Starts `MediaRecorder`.
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

| File | Type | Description |
| :--- | :--- | :--- |
| `background.ts` | Service Worker | MV3 background controller. Manages ports and offscreen creation. |
| `offscreen.ts` | Valid DOM Script | Runs in hidden HTML. Handles heavy media processing (Recording, Mixing). |
| `popup.ts` | UI Logic | Click handlers for the extension popup. |
| `scrapingScript.ts` | Content Script | Scrapes the DOM for captions. Reverse-engineered selectors for Meet. |
| `micsetup.ts` | Helper Page | A full-page tab used to prompt the user for Mic permissions (since popups/offscreen often can't prompt). |
| `manifest.json` | Config | Defines permissions (`tabCapture`, `offscreen`, `activeTab`) and entry points. |

## Key Concepts & logic

### The "Offscreen" Pattern
In Manifest V3, background scripts are Service Workers and cannot access DOM APIs like `MediaRecorder` or `AudioContext`. To record audio/video, extensions must create an "Offscreen Document" (`chrome.offscreen.createDocument`). This document is invisible but has full DOM access.

### Audio Mixing
To record *both* the meeting audio (what others say) and the user's mic (what you say), the extension creates an `AudioContext`.
- **Source 1**: Tab Audio (from `tabCapture`).
- **Source 2**: Mic Audio (from `getUserMedia`).
- **Destination**: A `MediaStreamDestination` node.
These are connected `Source -> Destination`. The `MediaRecorder` then records the *Destination* stream.

### Obfuscated Selectors
`scrapingScript.ts` relies on specific class names (`.ygicle`, `.NWpY1d`) used by Google Meet. These are likely generated classes and **may break** if Google updates their frontend code. The script attempts to find these elements via `aria-label="Captions"` regions to be somewhat robust.
