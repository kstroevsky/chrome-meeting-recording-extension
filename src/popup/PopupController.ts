/**
 * @file popup/PopupController.ts
 *
 * Stateful popup controller. The popup is intentionally thin and disposable:
 * it initiates actions, reflects current recording/uploading state, and can be
 * closed/reopened at any time without owning the recording lifecycle.
 */

import { CameraPermissionService } from './CameraPermissionService';
import { MicPermissionService } from './MicPermissionService';
import { PopupStateController } from './controllers/PopupStateController';
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
import {
  setControlsForPhase,
  setStatusText,
  type PopupElements,
} from './popupView';
import { downloadFile } from '../platform/chrome/downloads';
import { createRuntimeTab, queryActiveTab } from '../platform/chrome/tabs';
import { sendToBackground, sendToContent } from '../shared/messages';
import type { BgToPopup } from '../shared/protocol';
import { isDevBuild, isTestRuntime } from '../shared/build';
import { normalizeSessionSnapshot, type RecordingPhase } from '../shared/recording';

export class PopupController {
  private readonly el: PopupElements;
  private readonly mic = new MicPermissionService();
  private readonly camera = new CameraPermissionService();
  private readonly state: PopupStateController;
  private inFlight = false;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private persistentStatus = '';

  constructor(el: PopupElements) {
    this.el = el;
    this.state = new PopupStateController(el, {
      onPhaseChange: (phase, session) => this.onPhaseChange(phase),
      onToast: (msg) => this.toast(msg),
      onAlert: (msg) => alert(msg),
    });
  }

  /** Wires every popup interaction and kicks off the initial status refresh. */
  init() {
    this.wireRecordingStateListener();
    this.wireTranscriptDownload();
    this.wireStartStop();
    this.wireMic();
    this.wireSettingsLink();
    this.wireDiagnosticsLink();
    void this.state.refreshInitialState();
  }

  /** Clears transient timers when the popup is torn down. */
  destroy() {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
  }

  private onPhaseChange(phase: RecordingPhase) {
    setControlsForPhase(this.el, phase);
    this.persistentStatus = this.state.buildPersistentStatus(phase);
    if (!this.statusTimer) {
      setStatusText(this.el, this.persistentStatus);
    }
  }

  private toast(msg: string) {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    setStatusText(this.el, msg);
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      setStatusText(this.el, this.persistentStatus);
    }, POPUP_TOAST_DURATION_MS);
    if (isTestRuntime()) console.log('[popup]', msg);
  }

  private wireRecordingStateListener() {
    chrome.runtime.onMessage.addListener((msg: BgToPopup) => {
      if (msg?.type === 'RECORDING_STATE') {
        this.state.applySession(normalizeSessionSnapshot(msg.session));
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

  private wireMic() {
    if (!this.el.micBtn) return;
    this.mic.bindButton(this.el.micBtn);
  }

  private wireSettingsLink() {
    if (!this.el.openSettingsBtn) return;
    this.el.openSettingsBtn.addEventListener('click', async () => {
      await createRuntimeTab('settings.html');
    });
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
        await downloadFile({ url, filename: buildTranscriptFilename(suffix), saveAs: true });
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

        const runConfig = this.state.getRunConfigFromForm();
        const { micMode, recordSelfVideo } = runConfig;

        const micReady = await this.mic.ensureReadyForRecording(micMode);
        if (!micReady) throw new Error(buildMicPermissionError(micMode));

        if (recordSelfVideo) {
          const cameraReady = await this.camera.ensureReadyForRecording();
          if (!cameraReady) throw new Error(CAMERA_PERMISSION_ERROR);
        }

        const resp = await sendToBackground({ type: 'START_RECORDING', tabId: tab.id, runConfig });
        if (resp.ok === false) throw new Error(resp.error || 'Failed to start');

        this.state.applySession(resp.session);
        this.toast(POPUP_TOAST_TEXT.recordingStarted);
      } catch (e: unknown) {
        console.error('[popup] START_RECORDING error', e);
        this.onPhaseChange('idle');
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
        this.state.applySession(resp.session);
        this.toast(POPUP_TOAST_TEXT.stopping);
      } catch (e: unknown) {
        console.error('[popup] STOP_RECORDING error', e);
        alert(buildStopErrorAlert(e));
        this.onPhaseChange('idle');
      } finally {
        this.inFlight = false;
      }
    });
  }
}
