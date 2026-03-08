/**
 * @file popup/PopupController.ts
 *
 * Stateful popup controller. The popup is intentionally thin and disposable:
 * it initiates actions, reflects current recording/uploading state, and can be
 * closed/reopened at any time without owning the recording lifecycle.
 */

import { CameraPermissionService } from './CameraPermissionService';
import { MicPermissionService } from './MicPermissionService';
import { downloadFile } from '../platform/chrome/downloads';
import { createRuntimeTab, queryActiveTab } from '../platform/chrome/tabs';
import { sendToBackground, sendToContent } from '../shared/messages';
import type { BgToPopup } from '../shared/protocol';
import { isDevBuild, isTestRuntime } from '../shared/build';
import {
  createDefaultRunConfig,
  isBusyPhase,
  normalizeMicMode,
  normalizeRunConfig,
  normalizeSessionSnapshot,
  type MicMode,
  type RecordingPhase,
  type RecordingRunConfig,
  type RecordingSessionSnapshot,
  type UploadSummary,
} from '../shared/recording';

type Elements = {
  saveBtn: HTMLButtonElement | null;
  micBtn: HTMLButtonElement | null;
  micModeSelect: HTMLSelectElement | null;
  startBtn: HTMLButtonElement | null;
  stopBtn: HTMLButtonElement | null;
  storageModeSelect: HTMLSelectElement | null;
  recordSelfVideoCheckbox: HTMLInputElement | null;
  selfVideoHighQualityCheckbox: HTMLInputElement | null;
  openDiagnosticsBtn: HTMLButtonElement | null;
  recordingStatusEl: HTMLElement | null;
};

const STATUS_BY_PHASE: Record<Exclude<RecordingPhase, 'idle'>, string> = {
  starting: 'Starting recording...',
  recording: 'Recording in progress.',
  stopping: 'Stopping recording and sealing files...',
  uploading: 'Finalizing and saving files... you can close this popup.',
  failed: 'The last recording attempt failed.',
};

export class PopupController {
  private readonly el: Elements;
  private readonly mic = new MicPermissionService();
  private readonly camera = new CameraPermissionService();
  private inFlight = false;
  private lastPhase: RecordingPhase = 'idle';
  private shownUploadSummary = '';
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private persistentStatus = '';
  private activeRunConfig: RecordingRunConfig | null = createDefaultRunConfig();

  constructor(el: Elements) {
    this.el = el;
  }

  init() {
    this.setActiveRunConfig(createDefaultRunConfig());
    this.wireRecordingStateListener();
    this.wireTranscriptDownload();
    this.wireStartStop();
    this.wireMic();
    this.wireSelfVideoQualityToggle();
    this.wireDiagnosticsLink();
    void this.refreshInitialUi();
  }

  destroy() {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
  }

  private setUI(phase: RecordingPhase) {
    const {
      startBtn,
      stopBtn,
      micModeSelect,
      storageModeSelect,
      recordSelfVideoCheckbox,
      selfVideoHighQualityCheckbox,
    } = this.el;

    if (!startBtn || !stopBtn) return;

    const busy = isBusyPhase(phase);
    startBtn.disabled = busy;
    stopBtn.disabled = !(phase === 'starting' || phase === 'recording' || phase === 'stopping');

    if (micModeSelect) micModeSelect.disabled = busy;
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
    if (phase === 'idle') {
      this.persistentStatus = '';
    } else {
      const run = this.describeRunConfig(this.activeRunConfig);
      const suffix = run ? ` ${run}` : '';
      const errorSuffix = phase === 'failed' && this.lastPhase === 'failed'
        ? ''
        : '';
      this.persistentStatus = `${STATUS_BY_PHASE[phase]}${suffix}${errorSuffix}`;
    }
    if (!this.statusTimer) {
      this.setStatus(this.persistentStatus);
    }
  }

  private describeRunConfig(config: RecordingRunConfig | null): string {
    if (!config) return '';
    const mode = config.storageMode === 'drive' ? 'Mode: Drive.' : 'Mode: Local.';
    const mic =
      config.micMode === 'mixed'
        ? 'Microphone: Mixed into tab recording.'
        : config.micMode === 'separate'
          ? 'Microphone: Saved as a separate audio file.'
          : 'Microphone: Off.';
    const camera = config.recordSelfVideo
      ? config.selfVideoQuality === 'high'
        ? 'Camera: On (High quality).'
        : 'Camera: On (Standard quality).'
      : 'Camera: Off.';
    return `${mode} ${mic} ${camera}`.trim();
  }

  private setActiveRunConfig(config: RecordingRunConfig | null) {
    this.activeRunConfig = config;
    if (!config) return;

    if (this.el.storageModeSelect) {
      this.el.storageModeSelect.value = config.storageMode;
    }
    if (this.el.micModeSelect) {
      this.el.micModeSelect.value = config.micMode;
    }
    if (this.el.recordSelfVideoCheckbox) {
      this.el.recordSelfVideoCheckbox.checked = config.recordSelfVideo;
    }
    if (this.el.selfVideoHighQualityCheckbox) {
      this.el.selfVideoHighQualityCheckbox.checked = config.selfVideoQuality === 'high';
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

    if (isTestRuntime()) console.log('[popup]', msg);
  }

  private applySession(snapshot: RecordingSessionSnapshot) {
    const prevPhase = this.lastPhase;
    const runConfig = snapshot.phase === 'idle'
      ? createDefaultRunConfig()
      : normalizeRunConfig(snapshot.runConfig);
    this.setActiveRunConfig(runConfig);
    this.setUI(snapshot.phase);

    if (snapshot.phase === 'failed' && snapshot.error) {
      this.toast(`Recording error: ${snapshot.error}`);
    }

    this.handleUploadSummary(prevPhase, snapshot.phase, snapshot.uploadSummary);
  }

  private async refreshInitialUi() {
    try {
      const res = await sendToBackground({ type: 'GET_RECORDING_STATUS' });
      this.applySession(normalizeSessionSnapshot(res.session));
    } catch {
      this.setActiveRunConfig(createDefaultRunConfig());
      this.setUI('idle');
    }
  }

  private wireRecordingStateListener() {
    chrome.runtime.onMessage.addListener((msg: BgToPopup) => {
      if (msg?.type === 'RECORDING_STATE') {
        this.applySession(normalizeSessionSnapshot(msg.session));
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

  private wireDiagnosticsLink() {
    const { openDiagnosticsBtn } = this.el;
    if (!openDiagnosticsBtn) return;

    if (!isDevBuild()) {
      openDiagnosticsBtn.hidden = true;
      return;
    }

    openDiagnosticsBtn.hidden = false;
    openDiagnosticsBtn.addEventListener('click', async () => {
      await createRuntimeTab('debug.html');
    });
  }

  private wireTranscriptDownload() {
    const { saveBtn } = this.el;
    if (!saveBtn) return;

    saveBtn.addEventListener('click', async () => {
      const tab = await queryActiveTab();
      if (!tab?.id) return;

      const res = await sendToContent(tab.id, { type: 'GET_TRANSCRIPT' }).catch(() => {
        this.toast('No transcript on this page');
        return undefined;
      });

      const transcript = res?.transcript;
      if (!transcript?.trim()) {
        this.toast('Transcript is empty');
        return;
      }

      const blob = new Blob([transcript], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const suffix = res?.provider.meetingId || 'google-meet';

      try {
        await downloadFile({
          url,
          filename: `google-meet-transcript-${suffix}-${Date.now()}.txt`,
          saveAs: true,
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    });
  }

  private getSelectedMicMode(): MicMode {
    return normalizeMicMode(this.el.micModeSelect?.value);
  }

  private wireStartStop() {
    const { startBtn, stopBtn } = this.el;
    if (!startBtn || !stopBtn) return;

    startBtn.addEventListener('click', async () => {
      if (this.inFlight) return;
      this.inFlight = true;
      startBtn.disabled = true;

      try {
        const tab = await queryActiveTab();
        if (!tab?.id) throw new Error('No active tab');

        await sendToContent(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {});

        const defaultRunConfig = createDefaultRunConfig();
        const micMode = this.getSelectedMicMode();
        const recordSelfVideo = this.el.recordSelfVideoCheckbox?.checked ?? defaultRunConfig.recordSelfVideo;
        const selfVideoQuality =
          recordSelfVideo && this.el.selfVideoHighQualityCheckbox?.checked
            ? 'high'
            : defaultRunConfig.selfVideoQuality;
        const runConfig = normalizeRunConfig({
          storageMode: this.el.storageModeSelect?.value,
          micMode,
          recordSelfVideo,
          selfVideoQuality,
        }) ?? defaultRunConfig;

        const micReady = await this.mic.ensureReadyForRecording(micMode);
        if (!micReady) {
          throw new Error(
            micMode === 'mixed'
              ? 'Microphone permission is required to mix your voice into the tab recording. A setup tab was opened.'
              : 'Microphone permission is required to save a separate microphone file. A setup tab was opened.'
          );
        }

        if (recordSelfVideo) {
          const cameraReady = await this.camera.ensureReadyForRecording();
          if (!cameraReady) {
            throw new Error(
              'Camera permission is required for "Record my camera separately". ' +
              'A setup tab was opened. Enable camera there and start again.'
            );
          }
        }

        const resp = await sendToBackground({
          type: 'START_RECORDING',
          tabId: tab.id,
          runConfig,
        });
        if (resp.ok === false) throw new Error(resp.error || 'Failed to start');

        this.applySession(resp.session);
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
        const resp = await sendToBackground({ type: 'STOP_RECORDING' });
        if (resp.ok === false) throw new Error(resp.error || 'Failed to stop');
        this.applySession(resp.session);
        this.toast('Stopping... finalizing local files. You can close this popup.');
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
