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
  setActiveView,
  setStatusText,
  type PopupElements,
} from './popupView';
import { formatDuration } from './popupStatus';
import { downloadFile } from '../platform/chrome/downloads';
import { createRuntimeTab, queryActiveTab } from '../platform/chrome/tabs';
import { sendToBackground, sendToContent } from '../shared/messages';
import type { BgToPopup } from '../shared/protocol';
import { isDevBuild, isTestRuntime } from '../shared/build';
import type { MicMode, RecordingPhase, RecordingStatusView } from '../shared/recording';

/** How often the recording view polls the content script for live caption presence. */
const CAPTION_POLL_MS = 3000;

/** Maps a mic mode to its finalizing-view metadata label. */
function micModeLabel(mode: MicMode | undefined): string {
  return mode === 'mixed' ? 'Mixed' : mode === 'separate' ? 'Separate' : 'Off';
}

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
  private paused = false;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private captionPollInterval: ReturnType<typeof setInterval> | null = null;
  private timerRecordedMs = 0;
  private timerRunningSince: number | null = null;

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
    this.wirePause();
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
    this.stopTimer();
    this.stopCaptionPoll();
  }

  /**
   * Switches the popup to the view its phase maps to (config / recording /
   * finalizing) and populates that view. Live intervals (the recording timer and
   * the caption-state poll) run only while the recording view is active.
   */
  private onPhaseChange(phase: RecordingPhase, session?: RecordingStatusView) {
    const view = setActiveView(this.el, phase);

    if (view === 'recording') {
      this.updateRecordingBanner(phase, session);
      this.updateChips(session);
      this.updateMuteControl(session);
      this.updateCameraControl(session);
      this.updatePauseControl(phase, session);
      if (this.el.stopBtn) this.el.stopBtn.disabled = false;
      this.syncTimer(phase, session);
      this.startCaptionPoll();
    } else {
      this.stopTimer();
      this.stopCaptionPoll();
      this.micMuted = this.cameraMuted = this.paused = false;
      if (view === 'finalizing') this.updateFinalizingView(phase, session);
      if (view === 'config' && this.el.startBtn) this.el.startBtn.disabled = false;
    }

    this.persistentStatus = this.state.buildPersistentStatus(phase, session?.paused === true);
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
   * Shows the microphone row only when the run has a mic, and reflects the live
   * mute state on its on/off pill (a muted mic records silence). Recording view only.
   */
  private updateMuteControl(session?: RecordingStatusView) {
    const row = this.el.micRow;
    const btn = this.el.muteMicBtn;
    if (!row || !btn) return;

    const micMode = session?.runConfig?.micMode;
    const active = micMode === 'mixed' || micMode === 'separate';
    row.hidden = !active;
    if (!active) {
      this.micMuted = false;
      return;
    }

    if (this.el.micModeLabel) this.el.micModeLabel.textContent = `· ${micMode}`;
    this.micMuted = session?.micMuted === true;
    btn.disabled = false;
    btn.setAttribute('aria-pressed', String(this.micMuted));
    btn.classList.toggle('on', !this.micMuted);
    btn.classList.toggle('off', this.micMuted);
    const label = btn.querySelector<HTMLElement>('[data-mute-label]') ?? btn;
    label.textContent = this.micMuted ? 'off' : 'on';
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
   * Shows the camera row only when the run records the camera separately, and
   * reflects the live hidden state on its on/off pill (hidden records black
   * frames). Recording view only.
   */
  private updateCameraControl(session?: RecordingStatusView) {
    const row = this.el.cameraRow;
    const btn = this.el.hideCameraBtn;
    if (!row || !btn) return;

    const active = session?.runConfig?.recordSelfVideo === true;
    row.hidden = !active;
    if (!active) {
      this.cameraMuted = false;
      return;
    }

    this.cameraMuted = session?.cameraMuted === true;
    btn.disabled = false;
    btn.setAttribute('aria-pressed', String(this.cameraMuted));
    btn.classList.toggle('on', !this.cameraMuted);
    btn.classList.toggle('off', this.cameraMuted);
    const label = btn.querySelector<HTMLElement>('[data-camera-label]') ?? btn;
    label.textContent = this.cameraMuted ? 'off' : 'on';
  }

  private wirePause() {
    const btn = this.el.pauseBtn;
    if (!btn) return;
    btn.addEventListener('click', () => void this.togglePause());
  }

  /**
   * Pauses/resumes the whole recording; see {@link toggleMute}. The paused span is
   * never written, so resume yields a seamless join with no black/blank filler.
   */
  private async togglePause(): Promise<void> {
    const btn = this.el.pauseBtn;
    if (!btn || btn.disabled) return;
    const next = !this.paused;
    btn.disabled = true;
    try {
      const resp = await sendToBackground({ type: 'SET_PAUSED', paused: next });
      if (resp.ok === false) throw new Error(resp.error || 'Failed to pause recording');
      this.state.applySession(resp.session);
      this.toast(next ? POPUP_TOAST_TEXT.recordingPaused : POPUP_TOAST_TEXT.recordingResumed);
    } catch (e: unknown) {
      console.error('[popup] SET_PAUSED error', e);
      btn.disabled = false;
    }
  }

  /**
   * Reflects pause state on the Pause/Resume button. Enabled only once actively
   * recording (disabled during the brief `starting` phase). Recording view only.
   */
  private updatePauseControl(phase: RecordingPhase, session?: RecordingStatusView) {
    const btn = this.el.pauseBtn;
    if (!btn) return;

    const recording = phase === 'recording';
    btn.disabled = !recording;
    this.paused = recording && session?.paused === true;
    btn.setAttribute('aria-pressed', String(this.paused));
    btn.classList.toggle('btn-danger', this.paused);
    btn.classList.toggle('btn-secondary', !this.paused);
    const label = btn.querySelector<HTMLElement>('[data-pause-label]') ?? btn;
    label.textContent = this.paused ? 'Resume' : 'Pause';
  }

  /** Sets the recording banner label + paused styling for the current phase. */
  private updateRecordingBanner(phase: RecordingPhase, session?: RecordingStatusView) {
    const paused = phase === 'recording' && session?.paused === true;
    const starting = phase === 'starting';
    if (this.el.recLabel) {
      this.el.recLabel.textContent = starting ? 'Starting…' : paused ? 'Paused' : 'Recording';
    }
    if (this.el.recBanner) this.el.recBanner.classList.toggle('paused', paused);
  }

  /** Renders the storage chip from the run config (the transcript chip is poll-driven). */
  private updateChips(session?: RecordingStatusView) {
    if (this.el.chipStorageLabel) {
      this.el.chipStorageLabel.textContent =
        session?.runConfig?.storageMode === 'drive' ? 'Google Drive' : 'Local Disk';
    }
  }

  // ── Recording timer (pause-aware; driven by session recordedMs/runningSince) ──

  /** Syncs the timer fields from the session and starts/stops the 1s tick. */
  private syncTimer(phase: RecordingPhase, session?: RecordingStatusView) {
    this.timerRecordedMs = session?.recordedMs ?? 0;
    this.timerRunningSince =
      phase === 'recording' && session?.paused !== true ? (session?.runningSince ?? null) : null;
    this.renderTimer();
    if (this.timerRunningSince != null) this.startTimer();
    else this.stopTimer();
  }

  private renderTimer() {
    const elapsed =
      this.timerRecordedMs + (this.timerRunningSince != null ? Date.now() - this.timerRunningSince : 0);
    if (this.el.recTimer) this.el.recTimer.textContent = formatDuration(elapsed);
  }

  private startTimer() {
    if (this.timerInterval != null) return;
    this.timerInterval = setInterval(() => this.renderTimer(), 1000);
  }

  private stopTimer() {
    if (this.timerInterval != null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  // ── Live transcript chip (polls the content script for caption presence) ──

  private startCaptionPoll() {
    if (this.captionPollInterval != null) return;
    void this.pollCaptionState();
    this.captionPollInterval = setInterval(() => void this.pollCaptionState(), CAPTION_POLL_MS);
  }

  private stopCaptionPoll() {
    if (this.captionPollInterval != null) {
      clearInterval(this.captionPollInterval);
      this.captionPollInterval = null;
    }
  }

  /** Best-effort: asks the active tab whether Meet captions are live; off if unreachable. */
  private async pollCaptionState() {
    let active = false;
    try {
      const tab = await queryActiveTab();
      if (tab?.id) {
        const res = await sendToContent(tab.id, { type: 'GET_CAPTION_STATE' }).catch(() => undefined);
        active = res?.captionsActive === true;
      }
    } catch {
      active = false;
    }
    if (this.el.chipTranscriptLabel) {
      this.el.chipTranscriptLabel.textContent = active ? 'Transcript on' : 'Transcript off';
    }
    if (this.el.chipTranscript) this.el.chipTranscript.classList.toggle('off', !active);
  }

  /** Populates the finalizing view: progress ring + run metadata (storage/duration/mic/camera). */
  private updateFinalizingView(phase: RecordingPhase, session?: RecordingStatusView) {
    if (this.el.finalizingLabel) {
      this.el.finalizingLabel.textContent =
        phase === 'uploading' ? 'Uploading to Google Drive…' : 'Finalizing files…';
    }
    this.updateUploadRing(phase, session);
    const cfg = session?.runConfig;
    if (this.el.metaStorage) {
      this.el.metaStorage.textContent = cfg?.storageMode === 'drive' ? 'Google Drive' : 'Local Disk (OPFS)';
    }
    if (this.el.metaDuration) this.el.metaDuration.textContent = formatDuration(session?.recordedMs ?? 0);
    if (this.el.metaMic) this.el.metaMic.textContent = micModeLabel(cfg?.micMode);
    if (this.el.metaCamera) this.el.metaCamera.textContent = cfg?.recordSelfVideo ? 'Separate' : 'Off';
  }

  /**
   * Drives the finalizing ring. A Drive upload reporting a fraction renders a
   * determinate arc with a centered percentage ("how much is left"); every other
   * case (local finalize, or the brief pre-first-chunk window) falls back to the
   * indeterminate spinner. The arc circle declares `pathLength="100"`, so the
   * fraction maps straight onto `stroke-dashoffset = 100 - percent`.
   */
  private updateUploadRing(phase: RecordingPhase, session?: RecordingStatusView) {
    const ring = this.el.uploadRing;
    if (!ring) return;
    const fraction = phase === 'uploading' ? session?.uploadProgress : undefined;
    if (typeof fraction === 'number' && Number.isFinite(fraction)) {
      const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      ring.dataset.mode = 'determinate';
      if (this.el.uploadRingArc) this.el.uploadRingArc.style.strokeDashoffset = String(100 - percent);
      if (this.el.uploadRingLabel) this.el.uploadRingLabel.textContent = `${percent}%`;
    } else {
      ring.dataset.mode = 'indeterminate';
      if (this.el.uploadRingArc) this.el.uploadRingArc.style.strokeDashoffset = '100';
      if (this.el.uploadRingLabel) this.el.uploadRingLabel.textContent = '';
    }
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
