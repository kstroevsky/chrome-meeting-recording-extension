import { MicPermissionService } from './MicPermissionService';
import { CameraPermissionService } from './CameraPermissionService';

type Elements = {
  saveBtn: HTMLButtonElement | null;
  micBtn: HTMLButtonElement | null;
  startBtn: HTMLButtonElement | null;
  stopBtn: HTMLButtonElement | null;
  storageModeSelect: HTMLSelectElement | null;
  recordSelfVideoCheckbox: HTMLInputElement | null;
};

export class PopupController {
  private el: Elements;
  private mic = new MicPermissionService();
  private camera = new CameraPermissionService();
  private inFlight = false;

  constructor(el: Elements) {
    this.el = el;
  }

  init() {
    this.wireRecordingStateListener();
    this.wireTranscriptDownload();
    this.wireStartStop();
    this.wireMic();
    void this.refreshInitialUi();
  }

  private setUI(recording: boolean) {
    const { startBtn, stopBtn, storageModeSelect, recordSelfVideoCheckbox } = this.el;
    if (!startBtn || !stopBtn) return;
    startBtn.disabled = recording;
    stopBtn.disabled = !recording;
    if (storageModeSelect) storageModeSelect.disabled = recording;
    if (recordSelfVideoCheckbox) recordSelfVideoCheckbox.disabled = recording;
  }

  private toast(msg: string) {
    console.log('[popup]', msg);
  }

  private async refreshInitialUi() {
    try {
      const st = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
      this.setUI(!!st?.recording);
    } catch {
      this.setUI(false);
    }
  }

  private wireRecordingStateListener() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'RECORDING_STATE') this.setUI(!!msg.recording);
      if (msg?.type === 'RECORDING_SAVED') {
        this.toast(`Saved: ${msg.filename || 'recording.webm'}`);
        this.setUI(false);
      }
    });
  }

  private wireMic() {
    if (!this.el.micBtn) return;
    this.mic.bindButton(this.el.micBtn);
  }

  private wireTranscriptDownload() {
    const { saveBtn } = this.el;
    if (!saveBtn) return;

    saveBtn.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;

      const res = await chrome.tabs
        .sendMessage(tab.id, { type: 'GET_TRANSCRIPT' })
        .catch(() => {
          this.toast('No transcript on this page');
          return undefined;
        });

      const transcript = (res as any)?.transcript as string | undefined;
      if (!transcript?.trim()) {
        this.toast('Transcript is empty');
        return;
      }

      const blob = new Blob([transcript], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const suffix =
        new URL(tab.url ?? 'https://meet.google.com').pathname.split('/').pop() || 'google-meet';

      chrome.downloads.download(
        { url, filename: `google-meet-transcript-${suffix}-${Date.now()}.txt`, saveAs: true },
        () => URL.revokeObjectURL(url)
      );
    });
  }

  private wireStartStop() {
    const { startBtn, stopBtn } = this.el;
    if (!startBtn || !stopBtn) return;

    startBtn.addEventListener('click', async () => {
      if (this.inFlight) return;
      this.inFlight = true;
      startBtn.disabled = true;

      try {
        // Best-effort mic priming (same intent as old code)
        await this.mic.ensurePrimedBestEffort();

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('No active tab');

        // Clear transcript buffer (silent fail if not injected)
        await chrome.tabs.sendMessage(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {});

        const storageMode = (this.el.storageModeSelect?.value === 'drive') ? 'drive' : 'local';
        const recordSelfVideo = !!this.el.recordSelfVideoCheckbox?.checked;
        if (recordSelfVideo) {
          const cameraReady = await this.camera.ensureReadyForRecording();
          if (!cameraReady) {
            throw new Error(
              'Camera permission is required for "Record my camera separately". ' +
              'A setup tab was opened. Enable camera there and start again.'
            );
          }
        }

        // Start recording
        const resp = await chrome.runtime.sendMessage({
          type: 'START_RECORDING',
          tabId: tab.id,
          storageMode,
          recordSelfVideo,
        });
        if (!resp) throw new Error('No response from background');
        if (resp.ok === false) throw new Error(resp.error || 'Failed to start');

        this.setUI(true);
        this.toast('Recording started');
      } catch (e: any) {
        console.error('[popup] START_RECORDING error', e);
        this.setUI(false);
        alert(`Failed to start recording:\n${e?.message || e}`);
      } finally {
        this.inFlight = false;
      }
    });

    stopBtn.addEventListener('click', async () => {
      if (this.inFlight) return;
      this.inFlight = true;
      stopBtn.disabled = true;

      try {
        const resp = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
        if (!resp) throw new Error('No response from background');
        if (resp.ok === false) throw new Error(resp.error || 'Failed to stop');
        this.toast('Stopping… finalizing…');
      } catch (e: any) {
        console.error('[popup] STOP_RECORDING error', e);
        alert(`Failed to stop recording:\n${e?.message || e}`);
        this.setUI(false);
      } finally {
        this.inFlight = false;
      }
    });
  }
}
