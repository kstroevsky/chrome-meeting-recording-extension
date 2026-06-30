/**
 * @file popup/PopupController.ts
 *
 * Stateful popup controller. The popup is intentionally thin and disposable:
 * it initiates actions, reflects current recording/uploading state, and can be
 * closed/reopened at any time without owning the recording lifecycle.
 */

import { CameraPermissionService } from './CameraPermissionService';
import { CaptionPoller } from './CaptionPoller';
import { MicPermissionService } from './MicPermissionService';
import { RecordingTimer } from './RecordingTimer';
import { SessionTabsView } from './SessionTabsView';
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
import type { BgToPopup, CommandResult } from '../shared/protocol';
import { isDevBuild, isTestRuntime } from '../shared/build';
import type { MicMode, RecordingPhase, RecordingStatusView } from '../shared/recording';

/** Maps a mic mode to its finalizing-view metadata label. */
function micModeLabel(mode: MicMode | undefined): string {
  return mode === 'mixed' ? 'Mixed' : mode === 'separate' ? 'Separate' : 'Off';
}

/**
 * The popup is a fresh document each open and only learns the real phase from an
 * async status fetch. We mirror the last rendered phase into `localStorage` (the
 * one store the popup can read *synchronously*) so the next open can paint the
 * right view on the first frame and never flash the wrong screen.
 */
const LAST_PHASE_KEY = 'meetRecorder.lastPhase';

function readCachedPhase(): RecordingPhase {
  try {
    const v = localStorage.getItem(LAST_PHASE_KEY);
    if (v === 'starting' || v === 'recording' || v === 'stopping' || v === 'failed') return v;
  } catch { /* localStorage unavailable */ }
  return 'idle';
}

function writeCachedPhase(phase: RecordingPhase): void {
  try { localStorage.setItem(LAST_PHASE_KEY, phase); } catch { /* ignore */ }
}

export class PopupController {
  private readonly el: PopupElements;
  private readonly mic = new MicPermissionService();
  private readonly camera = new CameraPermissionService();
  private readonly state: PopupStateController;
  private readonly timer: RecordingTimer;
  private readonly captionPoller: CaptionPoller;
  private readonly sessionTabs: SessionTabsView;
  private inFlight = false;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private persistentStatus = '';
  private micMuted = false;
  private cameraMuted = false;
  private paused = false;
  /** Last phase/session, replayed when a tab is clicked without a new background push. */
  private lastPhase: RecordingPhase = 'idle';
  private lastSession?: RecordingStatusView;

  constructor(el: PopupElements) {
    this.el = el;
    this.timer = new RecordingTimer(el.recTimer);
    this.captionPoller = new CaptionPoller(el.chipTranscriptLabel, el.chipTranscript);
    this.state = new PopupStateController(el, {
      onPhaseChange: (phase, session) => this.onPhaseChange(phase, session),
      onToast: (msg) => this.toast(msg),
      onAlert: (msg) => alert(msg),
    });
    this.sessionTabs = new SessionTabsView(el, {
      rerender: () => this.onPhaseChange(this.lastPhase, this.lastSession),
      applySession: (session) => this.state.applySession(session),
      toast: (msg) => this.toast(msg),
    });
  }

  /** Wires every popup interaction and kicks off the initial status refresh. */
  init() {
    // Paint the last-known view synchronously, before the async GET_RECORDING_STATUS
    // round-trip resolves, so a popup reopened mid-recording shows the recording view
    // on the first frame instead of flashing the Setup screen. The fetch then corrects
    // it in the rare case the phase changed while the popup was closed.
    setActiveView(this.el, readCachedPhase());
    this.wireRecordingStateListener();
    this.wireTranscriptDownload();
    this.wireStartStop();
    this.wireMic();
    this.wireMuteMic();
    this.wireHideCamera();
    this.wirePause();
    this.wireSettingsLink();
    this.wireDiagnosticsLink();
    this.sessionTabs.wireEvents();
    void this.state.refreshInitialState();
  }

  /** Clears transient timers when the popup is torn down. */
  destroy() {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.timer.stop();
    this.captionPoller.stop();
    this.sessionTabs.dispose();
  }

  /**
   * Switches the popup to the view its phase maps to (config / recording /
   * finalizing) and populates that view. Live intervals (the recording timer and
   * the caption-state poll) run only while the recording view is active.
   */
  private onPhaseChange(phase: RecordingPhase, session?: RecordingStatusView) {
    this.lastPhase = phase;
    this.lastSession = session;
    writeCachedPhase(phase);
    this.sessionTabs.sync(phase, session);

    // An upload tab is selected: show only that job's upload view and stop the
    // live-recording intervals (we're not on the recording view).
    const job = this.sessionTabs.activeJob(session);
    if (job) {
      this.timer.stop();
      this.captionPoller.stop();
      if (this.el.viewConfig) this.el.viewConfig.hidden = true;
      if (this.el.viewRecording) this.el.viewRecording.hidden = true;
      if (this.el.viewFinalizing) this.el.viewFinalizing.hidden = true;
      if (this.el.viewUpload) this.el.viewUpload.hidden = false;
      this.sessionTabs.renderJobView(job);
      this.persistentStatus = this.state.buildPersistentStatus(phase, session?.paused === true);
      if (!this.statusTimer) setStatusText(this.el, this.persistentStatus);
      return;
    }

    if (this.el.viewUpload) this.el.viewUpload.hidden = true;
    const view = setActiveView(this.el, phase);

    if (view === 'recording') {
      this.updateRecordingBanner(phase, session);
      this.updateChips(session);
      this.updateMuteControl(session);
      this.updateCameraControl(session);
      this.updatePauseControl(phase, session);
      if (this.el.stopBtn) this.el.stopBtn.disabled = false;
      this.timer.sync(phase, session);
      this.captionPoller.start();
    } else {
      this.timer.stop();
      this.captionPoller.stop();
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
   * Shared scaffolding for the mute/camera/pause toggles: optimistically disables
   * the button, sends the command, syncs the UI from the authoritative session in
   * the response (so a rejected toggle reverts), and re-enables the button on
   * failure. The live recording is never interrupted by any of these.
   */
  private async runToggleCommand(opts: {
    btn: HTMLButtonElement | null;
    current: boolean;
    send: (next: boolean) => Promise<CommandResult>;
    toast: (next: boolean) => string;
    fallbackError: string;
    logLabel: string;
  }): Promise<void> {
    const { btn, current, send, toast, fallbackError, logLabel } = opts;
    if (!btn || btn.disabled) return;
    const next = !current;
    btn.disabled = true;
    try {
      const resp = await send(next);
      if (resp.ok === false) throw new Error(resp.error || fallbackError);
      this.state.applySession(resp.session);
      this.toast(toast(next));
    } catch (e: unknown) {
      console.error(`[popup] ${logLabel} error`, e);
      btn.disabled = false;
    }
  }

  /**
   * Toggles mic mute on the live recording. Optimistically disables the button,
   * sends the command, and syncs the UI from the authoritative session in the
   * response (so a rejected toggle reverts). Recording is never interrupted.
   */
  private toggleMute(): Promise<void> {
    return this.runToggleCommand({
      btn: this.el.muteMicBtn,
      current: this.micMuted,
      send: (muted) => sendToBackground({ type: 'SET_MIC_MUTED', muted }),
      toast: (next) => (next ? POPUP_TOAST_TEXT.micMuted : POPUP_TOAST_TEXT.micUnmuted),
      fallbackError: 'Failed to toggle microphone',
      logLabel: 'SET_MIC_MUTED',
    });
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
    this.renderTogglePill(btn, this.micMuted, '[data-mute-label]');
  }

  /**
   * Renders an on/off pill button (the mic-mute and camera-hide rows share this).
   * `muted` is the "off" state: the pill reads "off"/`aria-pressed=true` when muted.
   */
  private renderTogglePill(btn: HTMLButtonElement, muted: boolean, labelSelector: string): void {
    btn.disabled = false;
    btn.setAttribute('aria-pressed', String(muted));
    btn.classList.toggle('on', !muted);
    btn.classList.toggle('off', muted);
    const label = btn.querySelector<HTMLElement>(labelSelector) ?? btn;
    label.textContent = muted ? 'off' : 'on';
  }

  private wireHideCamera() {
    const btn = this.el.hideCameraBtn;
    if (!btn) return;
    btn.addEventListener('click', () => void this.toggleCamera());
  }

  /** Toggles the camera (black frames) on the live recording; see {@link toggleMute}. */
  private toggleCamera(): Promise<void> {
    return this.runToggleCommand({
      btn: this.el.hideCameraBtn,
      current: this.cameraMuted,
      send: (muted) => sendToBackground({ type: 'SET_CAMERA_MUTED', muted }),
      toast: (next) => (next ? POPUP_TOAST_TEXT.cameraHidden : POPUP_TOAST_TEXT.cameraShown),
      fallbackError: 'Failed to toggle camera',
      logLabel: 'SET_CAMERA_MUTED',
    });
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
    this.renderTogglePill(btn, this.cameraMuted, '[data-camera-label]');
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
  private togglePause(): Promise<void> {
    return this.runToggleCommand({
      btn: this.el.pauseBtn,
      current: this.paused,
      send: (paused) => sendToBackground({ type: 'SET_PAUSED', paused }),
      toast: (next) => (next ? POPUP_TOAST_TEXT.recordingPaused : POPUP_TOAST_TEXT.recordingResumed),
      fallbackError: 'Failed to pause recording',
      logLabel: 'SET_PAUSED',
    });
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

  /** Populates the finalizing view: indeterminate spinner + run metadata (storage/duration/mic/camera). */
  private updateFinalizingView(_phase: RecordingPhase, session?: RecordingStatusView) {
    if (this.el.finalizingLabel) this.el.finalizingLabel.textContent = 'Finalizing files…';
    this.updateUploadRing();
    const cfg = session?.runConfig;
    if (this.el.metaStorage) {
      this.el.metaStorage.textContent = cfg?.storageMode === 'drive' ? 'Google Drive' : 'Local Disk (OPFS)';
    }
    if (this.el.metaDuration) this.el.metaDuration.textContent = formatDuration(session?.recordedMs ?? 0);
    if (this.el.metaMic) this.el.metaMic.textContent = micModeLabel(cfg?.micMode);
    if (this.el.metaCamera) this.el.metaCamera.textContent = cfg?.recordSelfVideo ? 'Separate' : 'Off';
  }

  /**
   * The finalizing view now only appears while `stopping` (sealing files), which has
   * no measurable progress, so its ring is always the indeterminate spinner. Live
   * Drive-upload progress lives in the per-job upload tabs (ADR-0004).
   */
  private updateUploadRing() {
    const ring = this.el.uploadRing;
    if (!ring) return;
    ring.dataset.mode = 'indeterminate';
    if (this.el.uploadRingArc) this.el.uploadRingArc.style.strokeDashoffset = '100';
    if (this.el.uploadRingLabel) this.el.uploadRingLabel.textContent = '';
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
