/**
 * @file popup/PopupController.ts
 *
 * Stateful popup controller. The popup is intentionally thin and disposable:
 * it initiates actions, reflects current recording/uploading state, and can be
 * closed/reopened at any time without owning the recording lifecycle.
 */

import { CameraPermissionService } from './CameraPermissionService';
import { MicPermissionService } from './MicPermissionService';
import {
  buildLocalSaveFailedAlert,
  buildLocalSaveFailedToast,
  buildMicPermissionError,
  buildSavedLocallyMessage,
  buildStartErrorAlert,
  buildStopErrorAlert,
  buildTranscriptFilename,
  CAMERA_PERMISSION_ERROR,
  POPUP_TOAST_DURATION_MS,
  POPUP_TOAST_TEXT,
} from './popupMessages';
import { applyRunConfigToForm, buildRunConfigFromForm } from './popupRunConfig';
import {
  setControlsForPhase,
  setStatusText,
  type PopupElements,
} from './popupView';
import { describeRunConfig, formatUploadFallbackMessage, STATUS_BY_PHASE } from './popupStatus';
import { downloadFile } from '../platform/chrome/downloads';
import { createRuntimeTab, queryActiveTab } from '../platform/chrome/tabs';
import { sendToBackground, sendToContent } from '../shared/messages';
import type { BgToPopup } from '../shared/protocol';
import { isDevBuild, isTestRuntime } from '../shared/build';
import {
  buildDefaultRunConfigFromSettings,
  loadExtensionSettingsFromStorage,
} from '../shared/extensionSettings';
import {
  createDefaultRunConfig,
  getRunConfigOrDefault,
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
  private idleDefaultRunConfig: RecordingRunConfig = createDefaultRunConfig();

  /** Binds popup DOM elements to the controller that owns interaction logic. */
  constructor(el: PopupElements) {
    this.el = el;
  }

  /** Wires every popup interaction and kicks off the initial status refresh. */
  init() {
    this.setActiveRunConfig({ ...this.idleDefaultRunConfig });
    this.wireRecordingStateListener();
    this.wireTranscriptDownload();
    this.wireStartStop();
    this.wireMic();
    this.wireSettingsLink();
    this.wireDiagnosticsLink();
    void this.refreshInitialUi();
  }

  /** Clears transient timers when the popup is torn down. */
  destroy() {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /** Applies control enabled/disabled state and persistent text for a phase change. */
  private setUI(phase: RecordingPhase) {
    setControlsForPhase(this.el, phase);
    this.lastPhase = phase;
    this.syncPhaseStatus(phase);
  }

  /** Writes one line of status text into the popup. */
  private setStatus(text: string) {
    setStatusText(this.el, text);
  }

  /** Recomputes the persistent phase text shown when no toast is active. */
  private syncPhaseStatus(phase: RecordingPhase) {
    if (phase === 'idle') {
      this.persistentStatus = '';
    } else {
      const run = describeRunConfig(this.activeRunConfig);
      const suffix = run ? ` ${run}` : '';
      this.persistentStatus = `${STATUS_BY_PHASE[phase]}${suffix}`;
    }
    if (!this.statusTimer) {
      this.setStatus(this.persistentStatus);
    }
  }

  /** Stores the active run config and reflects it into the popup controls. */
  private setActiveRunConfig(config: RecordingRunConfig | null) {
    this.activeRunConfig = config;
    applyRunConfigToForm(this.el, config);
  }

  /** Shows a temporary toast before restoring the persistent phase status. */
  private toast(msg: string) {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }

    this.setStatus(msg);
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.setStatus(this.persistentStatus);
    }, POPUP_TOAST_DURATION_MS);

    if (isTestRuntime()) console.log('[popup]', msg);
  }

  /** Applies a canonical session snapshot coming from background into the popup UI. */
  private applySession(snapshot: RecordingSessionSnapshot) {
    const prevPhase = this.lastPhase;
    const runConfig = snapshot.phase === 'idle'
      ? { ...this.idleDefaultRunConfig }
      : getRunConfigOrDefault(snapshot.runConfig);
    this.setActiveRunConfig(runConfig);
    this.setUI(snapshot.phase);

    if (snapshot.phase === 'failed' && snapshot.error) {
      this.toast(`Recording error: ${snapshot.error}`);
    }

    this.handleUploadSummary(prevPhase, snapshot.phase, snapshot.uploadSummary);
  }

  /** Loads settings-derived defaults and then hydrates the live background session state. */
  private async refreshInitialUi() {
    try {
      const settings = await loadExtensionSettingsFromStorage();
      this.idleDefaultRunConfig = buildDefaultRunConfigFromSettings(settings);
    } catch {
      this.idleDefaultRunConfig = createDefaultRunConfig();
    }

    try {
      const res = await sendToBackground({ type: 'GET_RECORDING_STATUS' });
      this.applySession(normalizeSessionSnapshot(res.session));
    } catch {
      this.setActiveRunConfig({ ...this.idleDefaultRunConfig });
      this.setUI('idle');
    }
  }

  /** Subscribes the popup to background session and save notifications. */
  private wireRecordingStateListener() {
    chrome.runtime.onMessage.addListener((msg: BgToPopup) => {
      if (msg?.type === 'RECORDING_STATE') {
        this.applySession(normalizeSessionSnapshot(msg.session));
      }

      if (msg?.type === 'RECORDING_SAVED') {
        this.toast(buildSavedLocallyMessage(msg.filename));
      }

      if (msg?.type === 'RECORDING_SAVE_ERROR') {
        this.toast(buildLocalSaveFailedToast(msg.filename, msg.error));
        alert(buildLocalSaveFailedAlert(msg.filename, msg.error));
      }
    });
  }

  /** Shows at most one upload summary for each completed finalize result. */
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

  /** Connects the microphone permission button to its service helper. */
  private wireMic() {
    if (!this.el.micBtn) return;
    this.mic.bindButton(this.el.micBtn);
  }

  /** Opens the dedicated settings page from the popup gear button. */
  private wireSettingsLink() {
    const { openSettingsBtn } = this.el;
    if (!openSettingsBtn) return;

    openSettingsBtn.addEventListener('click', async () => {
      await createRuntimeTab('settings.html');
    });
  }

  /** Opens diagnostics in dev builds and hides the button elsewhere. */
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

  /** Downloads the accumulated transcript from the active meeting tab. */
  private wireTranscriptDownload() {
    const { saveBtn } = this.el;
    if (!saveBtn) return;

    saveBtn.addEventListener('click', async () => {
      const tab = await queryActiveTab();
      if (!tab?.id) return;

      const res = await sendToContent(tab.id, { type: 'GET_TRANSCRIPT' }).catch(() => {
        this.toast(POPUP_TOAST_TEXT.noTranscriptOnPage);
        return undefined;
      });

      const transcript = res?.transcript;
      if (!transcript?.trim()) {
        this.toast(POPUP_TOAST_TEXT.transcriptEmpty);
        return;
      }

      const blob = new Blob([transcript], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const suffix = res?.provider.meetingId || 'google-meet';

      try {
        await downloadFile({
          url,
          filename: buildTranscriptFilename(suffix),
          saveAs: true,
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    });
  }

  /** Wires the popup's start/stop controls into the background recording flow. */
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
        const { micMode, recordSelfVideo } = runConfig;

        const micReady = await this.mic.ensureReadyForRecording(micMode);
        if (!micReady) throw new Error(buildMicPermissionError(micMode));

        if (recordSelfVideo) {
          const cameraReady = await this.camera.ensureReadyForRecording();
          if (!cameraReady) {
            throw new Error(CAMERA_PERMISSION_ERROR);
          }
        }

        const resp = await sendToBackground({
          type: 'START_RECORDING',
          tabId: tab.id,
          runConfig,
        });
        if (resp.ok === false) throw new Error(resp.error || 'Failed to start');

        this.applySession(resp.session);
        this.toast(POPUP_TOAST_TEXT.recordingStarted);
      } catch (e: unknown) {
        console.error('[popup] START_RECORDING error', e);
        this.setUI('idle');
        alert(buildStartErrorAlert(e));
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
        this.toast(POPUP_TOAST_TEXT.stopping);
      } catch (e: unknown) {
        console.error('[popup] STOP_RECORDING error', e);
        alert(buildStopErrorAlert(e));
        this.setUI('idle');
      } finally {
        this.inFlight = false;
      }
    });
  }
}
