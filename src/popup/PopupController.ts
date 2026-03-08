/**
 * @file popup/PopupController.ts
 *
 * Stateful popup controller. The popup is intentionally thin and disposable:
 * it initiates actions, reflects current recording/uploading state, and can be
 * closed/reopened at any time without owning the recording lifecycle.
 */

import { CameraPermissionService } from './CameraPermissionService';
import { MicPermissionService } from './MicPermissionService';
import type { RecordingPhase, UploadSummary } from '../shared/protocol';

type Elements = {
  saveBtn: HTMLButtonElement | null;
  micBtn: HTMLButtonElement | null;
  startBtn: HTMLButtonElement | null;
  stopBtn: HTMLButtonElement | null;
  storageModeSelect: HTMLSelectElement | null;
  recordSelfVideoCheckbox: HTMLInputElement | null;
  selfVideoHighQualityCheckbox: HTMLInputElement | null;
  recordingStatusEl: HTMLElement | null;
};

const UPLOADING_STATUS = 'Uploading to Google Drive... you can close this popup.';

export class PopupController {
  private readonly el: Elements;
  private readonly mic = new MicPermissionService();
  private readonly camera = new CameraPermissionService();
  private inFlight = false;
  private lastPhase: RecordingPhase = 'idle';
  private shownUploadSummary = '';
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private persistentStatus = '';

  constructor(el: Elements) {
    this.el = el;
  }

  init() {
    this.wireRecordingStateListener();
    this.wireTranscriptDownload();
    this.wireStartStop();
    this.wireMic();
    this.wireSelfVideoQualityToggle();
    void this.refreshInitialUi();
  }

  private setUI(phase: RecordingPhase) {
    const {
      startBtn,
      stopBtn,
      storageModeSelect,
      recordSelfVideoCheckbox,
      selfVideoHighQualityCheckbox,
    } = this.el;

    if (!startBtn || !stopBtn) return;

    startBtn.disabled = phase !== 'idle';
    stopBtn.disabled = phase !== 'recording';

    const busy = phase !== 'idle';
    if (storageModeSelect) storageModeSelect.disabled = busy;
    if (recordSelfVideoCheckbox) recordSelfVideoCheckbox.disabled = busy;
    if (selfVideoHighQualityCheckbox) {
      selfVideoHighQualityCheckbox.disabled =
        busy || !recordSelfVideoCheckbox?.checked;
    }

    this.lastPhase = phase;
    this.syncPhaseStatus(phase);
  }

  private setStatus(text: string) {
    if (this.el.recordingStatusEl) this.el.recordingStatusEl.textContent = text;
  }

  private syncPhaseStatus(phase: RecordingPhase) {
    this.persistentStatus = phase === 'uploading' ? UPLOADING_STATUS : '';
    if (!this.statusTimer) {
      this.setStatus(this.persistentStatus);
    }
  }

  private toast(msg: string) {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }

    this.setStatus(msg);
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.setStatus(this.persistentStatus);
    }, 12_000);

    console.log('[popup]', msg);
  }

  private async refreshInitialUi() {
    try {
      const st = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
      const phase = st?.phase === 'recording' || st?.phase === 'uploading' ? st.phase : 'idle';
      this.setUI(phase);
    } catch {
      this.setUI('idle');
    }
  }

  private wireRecordingStateListener() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'RECORDING_STATE') {
        const prevPhase = this.lastPhase;
        const phase = msg.phase === 'recording' || msg.phase === 'uploading' ? msg.phase : 'idle';
        this.setUI(phase);
        this.handleUploadSummary(prevPhase, phase, msg.uploadSummary as UploadSummary | undefined);
      }

      if (msg?.type === 'RECORDING_SAVED') {
        this.toast(`Saved locally: ${msg.filename || 'recording.webm'}`);
      }

      if (msg?.type === 'RECORDING_SAVE_ERROR') {
        const name = msg.filename || 'recording.webm';
        const error = msg.error || 'Unknown save error';
        this.toast(`Local save failed: ${name} (${error})`);
        alert(`Failed to save ${name} locally:\n${error}`);
      }
    });
  }

  private handleUploadSummary(
    prevPhase: RecordingPhase,
    phase: RecordingPhase,
    summary?: UploadSummary
  ) {
    if (phase !== 'idle' || !summary) return;

    const key = JSON.stringify(summary);
    if (this.shownUploadSummary === key) return;
    this.shownUploadSummary = key;

    if (summary.localFallbacks.length > 0) {
      const uploaded = summary.uploaded.map((x) => x.filename).join('\n') || '(none)';
      const fallback = summary.localFallbacks
        .map((x) => `${x.filename}${x.error ? `\n  ${x.error}` : ''}`)
        .join('\n\n');
      alert(
        'Drive upload completed with local fallback for some files.\n\n' +
        `Uploaded to Drive:\n${uploaded}\n\n` +
        `Saved locally instead:\n${fallback}`
      );
      return;
    }

    if (prevPhase === 'uploading' && summary.uploaded.length > 0) {
      this.toast(`Uploaded ${summary.uploaded.length} file(s) to Google Drive`);
    }
  }

  private wireMic() {
    if (!this.el.micBtn) return;
    this.mic.bindButton(this.el.micBtn);
  }

  private wireSelfVideoQualityToggle() {
    const { recordSelfVideoCheckbox, selfVideoHighQualityCheckbox } = this.el;
    if (!recordSelfVideoCheckbox || !selfVideoHighQualityCheckbox) return;

    const refresh = () => {
      if (!recordSelfVideoCheckbox.disabled) {
        selfVideoHighQualityCheckbox.disabled = !recordSelfVideoCheckbox.checked;
      }
    };

    recordSelfVideoCheckbox.addEventListener('change', refresh);
    refresh();
  }

  private wireTranscriptDownload() {
    const { saveBtn } = this.el;
    if (!saveBtn) return;

    saveBtn.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;

      const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPT' }).catch(() => {
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
        await this.mic.ensurePrimedBestEffort();

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('No active tab');

        await chrome.tabs.sendMessage(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {});

        const storageMode = this.el.storageModeSelect?.value === 'drive' ? 'drive' : 'local';
        const recordSelfVideo = !!this.el.recordSelfVideoCheckbox?.checked;
        const selfVideoQuality =
          recordSelfVideo && this.el.selfVideoHighQualityCheckbox?.checked ? 'high' : 'standard';

        if (recordSelfVideo) {
          const cameraReady = await this.camera.ensureReadyForRecording();
          if (!cameraReady) {
            throw new Error(
              'Camera permission is required for "Record my camera separately". ' +
              'A setup tab was opened. Enable camera there and start again.'
            );
          }
        }

        const resp = await chrome.runtime.sendMessage({
          type: 'START_RECORDING',
          tabId: tab.id,
          storageMode,
          recordSelfVideo,
          selfVideoQuality,
        });
        if (!resp) throw new Error('No response from background');
        if (resp.ok === false) throw new Error(resp.error || 'Failed to start');

        this.setUI('recording');
        this.toast('Recording started');
      } catch (e: any) {
        console.error('[popup] START_RECORDING error', e);
        this.setUI('idle');
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
        this.toast('Stopping... finalizing local files...');
      } catch (e: any) {
        console.error('[popup] STOP_RECORDING error', e);
        alert(`Failed to stop recording:\n${e?.message || e}`);
        this.setUI('idle');
      } finally {
        this.inFlight = false;
      }
    });
  }
}
