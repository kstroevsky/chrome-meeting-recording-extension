/**
 * @file popup/PopupController.ts
 *
 * Stateful popup controller. The popup is intentionally thin and disposable:
 * it initiates actions, reflects current recording/uploading state, and can be
 * closed/reopened at any time without owning the recording lifecycle.
 */

import { CameraPermissionService } from './CameraPermissionService';
import { MicPermissionService } from './MicPermissionService';
import { applyRunConfigToForm, buildRunConfigFromForm } from './popupRunConfig';
import {
  describeRunConfig,
  formatUploadFallbackMessage,
  setControlsForPhase,
  setStatusText,
  STATUS_BY_PHASE,
  type PopupElements,
} from './popupView';
import { downloadFile } from '../platform/chrome/downloads';
import { createRuntimeTab, queryActiveTab } from '../platform/chrome/tabs';
import { sendToBackground, sendToContent } from '../shared/messages';
import type { BgToPopup } from '../shared/protocol';
import { isDevBuild, isTestRuntime } from '../shared/build';
import {
  createDefaultRunConfig,
  normalizeRunConfig,
  normalizeSessionSnapshot,
  type RecordingPhase,
  type RecordingRunConfig,
  type RecordingSessionSnapshot,
  type UploadSummary,
} from '../shared/recording';

export class PopupController {
  private readonly el: PopupElements;
  private readonly mic = new MicPermissionService();
  private readonly camera = new CameraPermissionService();
  private inFlight = false;
  private lastPhase: RecordingPhase = 'idle';
  private shownUploadSummary = '';
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private persistentStatus = '';
  private activeRunConfig: RecordingRunConfig | null = createDefaultRunConfig();

  constructor(el: PopupElements) {
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
    setControlsForPhase(this.el, phase);
    this.lastPhase = phase;
    this.syncPhaseStatus(phase);
  }

  private setStatus(text: string) {
    setStatusText(this.el, text);
  }

  private syncPhaseStatus(phase: RecordingPhase) {
    if (phase === 'idle') {
      this.persistentStatus = '';
    } else {
      const run = describeRunConfig(this.activeRunConfig);
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

  private setActiveRunConfig(config: RecordingRunConfig | null) {
    this.activeRunConfig = config;
    applyRunConfigToForm(this.el, config);
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

    const fallbackMessage = formatUploadFallbackMessage(summary);
    if (fallbackMessage) {
      alert(fallbackMessage);
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

        const runConfig = buildRunConfigFromForm(this.el);
        const micMode = runConfig.micMode;
        const recordSelfVideo = runConfig.recordSelfVideo;

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
