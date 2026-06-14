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
import { isStoppablePhase, type RecordingPhase, type RecordingStatusView } from '../shared/recording';

export class PopupController {
  private readonly el: PopupElements;
  private readonly mic = new MicPermissionService();
  private readonly camera = new CameraPermissionService();
  private readonly state: PopupStateController;
  private inFlight = false;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private persistentStatus = '';
  private micMuted = false;
  private cameraMuted = false;

  constructor(el: PopupElements) {
    this.el = el;
    this.state = new PopupStateController(el, {
      onPhaseChange: (phase, session) => this.onPhaseChange(phase, session),
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
    this.wireMuteMic();
    this.wireHideCamera();
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

  private onPhaseChange(phase: RecordingPhase, session?: RecordingStatusView) {
    setControlsForPhase(this.el, phase);
    this.updateMuteControl(phase, session);
    this.updateCameraControl(phase, session);
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
        this.state.applySession(msg.session);
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

  private wireMuteMic() {
    const btn = this.el.muteMicBtn;
    if (!btn) return;
    btn.addEventListener('click', () => void this.toggleMute());
  }

  /**
   * Toggles mic mute on the live recording. Optimistically disables the button,
   * sends the command, and syncs the UI from the authoritative session in the
   * response (so a rejected toggle reverts). Recording is never interrupted.
   */
  private async toggleMute(): Promise<void> {
    const btn = this.el.muteMicBtn;
    if (!btn || btn.disabled) return;
    const next = !this.micMuted;
    btn.disabled = true;
    try {
      const resp = await sendToBackground({ type: 'SET_MIC_MUTED', muted: next });
      if (resp.ok === false) throw new Error(resp.error || 'Failed to toggle microphone');
      this.state.applySession(resp.session);
      this.toast(next ? POPUP_TOAST_TEXT.micMuted : POPUP_TOAST_TEXT.micUnmuted);
    } catch (e: unknown) {
      console.error('[popup] SET_MIC_MUTED error', e);
      btn.disabled = false;
    }
  }

  /**
   * Shows the mute toggle only while a recording with a microphone is active,
   * and reflects the current mute state (label, pressed state, danger styling).
   */
  private updateMuteControl(phase: RecordingPhase, session?: RecordingStatusView) {
    const btn = this.el.muteMicBtn;
    if (!btn) return;

    const micMode = session?.runConfig?.micMode;
    const active = isStoppablePhase(phase) && (micMode === 'mixed' || micMode === 'separate');
    btn.hidden = !active;
    if (!active) {
      this.micMuted = false;
      return;
    }

    this.micMuted = session?.micMuted === true;
    btn.disabled = false;
    btn.setAttribute('aria-pressed', String(this.micMuted));
    btn.classList.toggle('btn-danger', this.micMuted);
    btn.classList.toggle('btn-secondary', !this.micMuted);
    const label = btn.querySelector<HTMLElement>('[data-mute-label]') ?? btn;
    label.textContent = this.micMuted ? 'Unmute Mic' : 'Mute Mic';
  }

  private wireHideCamera() {
    const btn = this.el.hideCameraBtn;
    if (!btn) return;
    btn.addEventListener('click', () => void this.toggleCamera());
  }

  /** Toggles the camera (black frames) on the live recording; see {@link toggleMute}. */
  private async toggleCamera(): Promise<void> {
    const btn = this.el.hideCameraBtn;
    if (!btn || btn.disabled) return;
    const next = !this.cameraMuted;
    btn.disabled = true;
    try {
      const resp = await sendToBackground({ type: 'SET_CAMERA_MUTED', muted: next });
      if (resp.ok === false) throw new Error(resp.error || 'Failed to toggle camera');
      this.state.applySession(resp.session);
      this.toast(next ? POPUP_TOAST_TEXT.cameraHidden : POPUP_TOAST_TEXT.cameraShown);
    } catch (e: unknown) {
      console.error('[popup] SET_CAMERA_MUTED error', e);
      btn.disabled = false;
    }
  }

  /**
   * Shows the hide-camera toggle only while a self-video recording is active,
   * and reflects the current hidden state (label, pressed state, danger styling).
   */
  private updateCameraControl(phase: RecordingPhase, session?: RecordingStatusView) {
    const btn = this.el.hideCameraBtn;
    if (!btn) return;

    const active = isStoppablePhase(phase) && session?.runConfig?.recordSelfVideo === true;
    btn.hidden = !active;
    if (!active) {
      this.cameraMuted = false;
      return;
    }

    this.cameraMuted = session?.cameraMuted === true;
    btn.disabled = false;
    btn.setAttribute('aria-pressed', String(this.cameraMuted));
    btn.classList.toggle('btn-danger', this.cameraMuted);
    btn.classList.toggle('btn-secondary', !this.cameraMuted);
    const label = btn.querySelector<HTMLElement>('[data-camera-label]') ?? btn;
    label.textContent = this.cameraMuted ? 'Show Camera' : 'Hide Camera';
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
        await downloadFile({ url, filename: buildTranscriptFilename(suffix), saveAs: true });
      } finally {
        URL.revokeObjectURL(url);
      }
    });
  }

  private wireStartStop() {
    const { startBtn, stopBtn } = this.el;
    if (!startBtn || !stopBtn) return;
    startBtn.addEventListener('click', () => this.executeCommand(startBtn, 'START_RECORDING', () => this.startRecording(), buildStartErrorAlert));
    stopBtn.addEventListener('click',  () => this.executeCommand(stopBtn,  'STOP_RECORDING',  () => this.stopRecording(),  buildStopErrorAlert));
  }

  /**
   * Shared scaffolding for start/stop button handlers: guards against concurrent
   * commands, disables the button while the action is in-flight, and resets UI
   * to idle on failure.
   */
  private async executeCommand(
    btn: HTMLButtonElement,
    label: string,
    action: () => Promise<void>,
    buildErrorAlert: (e: unknown) => string
  ): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    btn.disabled = true;
    try {
      await action();
    } catch (e: unknown) {
      console.error(`[popup] ${label} error`, e);
      this.onPhaseChange('idle');
      alert(buildErrorAlert(e));
    } finally {
      this.inFlight = false;
    }
  }

  private async startRecording(): Promise<void> {
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
  }

  private async stopRecording(): Promise<void> {
    const resp = await sendToBackground({ type: 'STOP_RECORDING' });
    if (resp.ok === false) throw new Error(resp.error || 'Failed to stop');
    this.state.applySession(resp.session);
    this.toast(POPUP_TOAST_TEXT.stopping);
  }
}
