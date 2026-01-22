// src/popup.ts

/**
 * POPUP CONTROL PANEL
 * 
 * Handles user interactions for:
 * 1. Starting/Stopping the recording engine.
 * 2. Downloading the transcript collected by the content script.
 * 3. Managing "primed" microphone permissions.
 */

const saveBtn = document.getElementById('save') as HTMLButtonElement | null;
const micBtn = document.getElementById('enable-mic') as HTMLButtonElement | null;
const startBtn = document.getElementById('start-rec') as HTMLButtonElement | null;
const stopBtn = document.getElementById('stop-rec') as HTMLButtonElement | null;

function setUI(recording: boolean) {
  if (!startBtn || !stopBtn) return;
  startBtn.disabled = recording;
  stopBtn.disabled = !recording;
}

function toast(msg: string) {
  console.log('[popup]', msg);
}

/**
 * MICROPHONE PERMISSION "PRIMING"
 * 
 * Chrome Extensions cannot always prompt for mic permission via a standard popup 
 * or an offscreen document. To solve this, we open a full-page tab (micsetup.html)
 * which allows the user to grant permission to the extension's origin permanently.
 */
async function openMicSetupTab() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('micsetup.html') });
}

/**
 * Checks the current permission state and updates the UI button accordingly.
 */
async function refreshMicButton() {
  if (!micBtn || !('permissions' in navigator)) return;
  try {
    // @ts-ignore - chrome supports this permission name
    const status = await (navigator as any).permissions.query({ name: 'microphone' });
    const set = () => {
      micBtn.textContent =
        status.state === 'granted'
          ? 'Microphone Enabled ✓'
          : status.state === 'denied'
          ? 'Microphone Blocked'
          : 'Enable Microphone';
      micBtn.disabled = status.state === 'granted';
      micBtn.title =
        status.state === 'granted'
          ? 'Microphone is already enabled for this extension'
          : 'Grant microphone permission so your voice is included in recordings';
    };
    set();
    status.onchange = set;
  } catch {
    // permissions API might not be available
  }
}

// Initialization: Check if a recording is currently in progress
void (async () => {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
    setUI(!!st?.recording);
  } catch {
    setUI(false);
  }
  refreshMicButton().catch(() => {});
})();

/**
 * Listen for recording state updates from the background/offscreen engine.
 */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RECORDING_STATE') setUI(!!msg.recording);
  if (msg?.type === 'RECORDING_SAVED') {
    toast(`Saved: ${msg.filename || 'recording.webm'}`);
    setUI(false);
  }
});

/**
 * Handle Microphone Enable button clicks.
 */
micBtn?.addEventListener('click', async () => {
  try {
    if ('permissions' in navigator) {
      // @ts-ignore
      const p = await (navigator as any).permissions.query({ name: 'microphone' });
      if (p.state === 'granted') {
        alert('Microphone is already enabled for this extension.');
        await refreshMicButton();
        return;
      }
      if (p.state === 'denied') {
        await openMicSetupTab();
        return;
      }
    }
    // Attempt inline permission request
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      alert('Microphone enabled for the extension.');
      await refreshMicButton();
    } catch {
      await openMicSetupTab();
    }
  } catch (e) {
    console.error('[popup] mic enable flow error', e);
    alert('Could not open the microphone setup page. Please try again.');
  }
});

/**
 * TRANSCRIPT DOWNLOADING
 * 
 * The transcript is stored in the memory of the CONTENT SCRIPT (on the Meet page).
 * We must message the active tab to retrieve the data.
 */
saveBtn?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const res = await chrome.tabs
    .sendMessage(tab.id, { type: 'GET_TRANSCRIPT' })
    .catch((_e) => {
      toast('No transcript on this page');
      return undefined;
    });

  const transcript = (res as any)?.transcript as string | undefined;
  if (!transcript?.trim()) {
    toast('Transcript is empty');
    return;
  }

  // Generate a Blob and trigger a download from the popup context
  const blob = new Blob([transcript], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const suffix =
    new URL(tab.url ?? 'https://meet.google.com').pathname.split('/').pop() || 'google-meet';

  chrome.downloads.download(
    { url, filename: `google-meet-transcript-${suffix}-${Date.now()}.txt`, saveAs: true },
    () => URL.revokeObjectURL(url)
  );
});

let inFlight = false;

/**
 * START RECORDING
 * 
 * 1. Resets the transcript buffer in the content script.
 * 2. Asks the background orchestrator to start the engine.
 */
startBtn?.addEventListener('click', async () => {
  if (!startBtn || !stopBtn || inFlight) return;
  inFlight = true;
  startBtn.disabled = true;

  try {
    // Auto-prime mic if not granted (silent fail)
    if ('permissions' in navigator) {
      try {
        // @ts-ignore
        const status = await (navigator as any).permissions.query({ name: 'microphone' });
        if (status.state !== 'granted') {
          try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true });
            s.getTracks().forEach(t => t.stop());
          } catch { /* proceed without mic */ }
        }
      } catch { /* proceed without mic */ }
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    // Step 1: Tell the Meet page to clear its local transcript array
    await chrome.tabs.sendMessage(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {
      // Possible if user isn't on a Meet page or the extension isn't injected yet
    });

    // Step 2: Signal the background to initialize Offscreen and start MediaRecorder
    const resp = await chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id });
    if (!resp) throw new Error('No response from background');
    if (resp.ok === false) throw new Error(resp.error || 'Failed to start');

    setUI(true);
    toast('Recording started');
  } catch (e: any) {
    console.error('[popup] START_RECORDING error', e);
    setUI(false);
    alert(`Failed to start recording:\n${e?.message || e}`);
  } finally {
    inFlight = false;
  }
});

/**
 * STOP RECORDING
 * 
 * Contacts the background orchestrator to finalize the recording.
 */
stopBtn?.addEventListener('click', async () => {
  if (!startBtn || !stopBtn || inFlight) return;
  inFlight = true;
  stopBtn.disabled = true;

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    if (!resp) throw new Error('No response from background');
    if (resp.ok === false) throw new Error(resp.error || 'Failed to stop');
    toast('Stopping… finalizing…');
  } catch (e: any) {
    console.error('[popup] STOP_RECORDING error', e);
    alert(`Failed to stop recording:\n${e?.message || e}`);
    setUI(false);
  } finally {
    inFlight = false;
  }
});
