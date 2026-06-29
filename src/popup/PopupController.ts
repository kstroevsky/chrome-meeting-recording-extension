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
import type { MicMode, RecordingPhase, RecordingStatusView, RecordingStream, UploadJob, UploadJobFile } from '../shared/recording';

/** How often the recording view polls the content script for live caption presence. */
const CAPTION_POLL_MS = 3000;

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

/** Label for the always-present live tab, reflecting the current recording phase. */
function liveTabLabel(phase: RecordingPhase): string {
  if (phase === 'recording' || phase === 'starting') return '● Recording';
  if (phase === 'stopping') return 'Finishing';
  return 'Setup';
}

/** Compact tab badge for an upload job: percent while uploading, a glyph once done. */
function uploadTabBadge(job: UploadJob): string {
  if (job.status === 'completed') return '✓';
  if (job.status === 'failed' || job.status === 'partial') return '!';
  return `${Math.round(Math.min(1, Math.max(0, job.progress)) * 100)}%`;
}

/** Headline status line for an upload job's view. */
function uploadJobStatusText(job: UploadJob): string {
  switch (job.status) {
    case 'completed': return 'Uploaded to Google Drive';
    case 'partial': return 'Uploaded — some files saved locally';
    case 'failed': return 'Upload failed — saved locally';
    default: return 'Uploading to Google Drive…';
  }
}

/** Per-file outcome label inside an upload job's view. */
function uploadFileStatusText(status: UploadJobFile['status']): string {
  return status === 'uploaded' ? 'Uploaded' : status === 'fallback' ? 'Saved locally' : 'Uploading…';
}

/** Human label for a recording stream in an upload job's file list. */
function streamLabel(stream: RecordingStream): string {
  return stream === 'tab' ? 'Screen / Tab' : stream === 'mic' ? 'Microphone' : 'Camera';
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
  /** Selected session tab: 'live' (config/recording) or an upload job id (ADR-0004). */
  private selectedTab = 'live';
  /** The upload job currently rendered in the upload view, for the dismiss button. */
  private shownJobId: string | null = null;
  /** Last phase/session, replayed when a tab is clicked without a new background push. */
  private lastPhase: RecordingPhase = 'idle';
  private lastSession?: RecordingStatusView;
  /** Upload-job ids already seen, so a *newly*-appeared job (a recording that just
   *  finished) can auto-focus its tab — but a reopen, where jobs are seen on the
   *  first render, still lands on Setup (ADR-0004). */
  private seenUploadJobIds = new Set<string>();
  private hasRenderedSession = false;

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
    this.wireUploadDismiss();
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
    this.lastPhase = phase;
    this.lastSession = session;
    writeCachedPhase(phase);
    this.autoFocusFinishedUpload(session);
    this.renderSessionTabs(phase, session);

    // An upload tab is selected: show only that job's upload view and stop the
    // live-recording intervals (we're not on the recording view).
    const job = this.activeUploadTabJob(session);
    if (job) {
      this.stopTimer();
      this.stopCaptionPoll();
      if (this.el.viewConfig) this.el.viewConfig.hidden = true;
      if (this.el.viewRecording) this.el.viewRecording.hidden = true;
      if (this.el.viewFinalizing) this.el.viewFinalizing.hidden = true;
      if (this.el.viewUpload) this.el.viewUpload.hidden = false;
      this.updateUploadJobView(job);
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

  // ── Session tabs + background upload jobs (ADR-0004) ──────────────────────────

  /**
   * When a recording just finished it produces a *new* upload job; focus its tab so
   * the user lands on the upload screen (with a "New recording" button) rather than
   * an empty Setup form (ADR-0004). The first render only records the existing job
   * ids — so reopening the popup mid-upload still defaults to Setup.
   */
  private autoFocusFinishedUpload(session?: RecordingStatusView) {
    const jobs = session?.uploadJobs ?? [];
    if (this.hasRenderedSession) {
      const freshlyFinished = jobs.filter((j) => !this.seenUploadJobIds.has(j.id));
      if (freshlyFinished.length) this.selectedTab = freshlyFinished[freshlyFinished.length - 1].id;
    }
    this.seenUploadJobIds = new Set(jobs.map((j) => j.id));
    this.hasRenderedSession = true;
  }

  /** The upload job for the selected tab, or null when the live tab is active. */
  private activeUploadTabJob(session?: RecordingStatusView): UploadJob | null {
    if (this.selectedTab === 'live') return null;
    return session?.uploadJobs?.find((j) => j.id === this.selectedTab) ?? null;
  }

  /**
   * Rebuilds the tab bar from the live phase plus the background upload jobs. The
   * bar is hidden when there are no uploads (a single view needs no tabs), and a
   * selected job that has been dismissed/pruned falls back to the live tab.
   */
  private renderSessionTabs(phase: RecordingPhase, session?: RecordingStatusView) {
    const tabsEl = this.el.sessionTabs;
    if (!tabsEl) return;
    const jobs = session?.uploadJobs ?? [];
    if (this.selectedTab !== 'live' && !jobs.some((j) => j.id === this.selectedTab)) {
      this.selectedTab = 'live';
    }
    if (jobs.length === 0) {
      tabsEl.hidden = true;
      tabsEl.replaceChildren();
      return;
    }
    tabsEl.hidden = false;
    const frag = document.createDocumentFragment();
    // Upload tabs first, in creation order, then the live/Setup tab as a stable end anchor.
    for (const job of jobs) frag.appendChild(this.buildTab(job.id, job.label, job));
    frag.appendChild(this.buildTab('live', liveTabLabel(phase), null));
    tabsEl.replaceChildren(frag);
  }

  private buildTab(tab: string, label: string, job: UploadJob | null): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session-tab';
    btn.setAttribute('aria-selected', String(this.selectedTab === tab));
    if (job) btn.dataset.status = job.status;
    const labelEl = document.createElement('span');
    labelEl.className = 'session-tab-label';
    labelEl.textContent = label;
    btn.appendChild(labelEl);
    if (job) {
      const badge = document.createElement('span');
      badge.className = 'session-tab-pct';
      badge.textContent = uploadTabBadge(job);
      btn.appendChild(badge);
    }
    btn.addEventListener('click', () => this.selectTab(tab));
    return btn;
  }

  /** Switches tabs and re-renders the body from the last known phase/session. */
  private selectTab(tab: string) {
    if (this.selectedTab === tab) return;
    this.selectedTab = tab;
    this.onPhaseChange(this.lastPhase, this.lastSession);
  }

  /** Populates the upload view (ring + status + per-file outcomes) for one job. */
  private updateUploadJobView(job: UploadJob) {
    this.shownJobId = job.id;
    const percent = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
    if (this.el.uploadJobRing) this.el.uploadJobRing.dataset.mode = 'determinate';
    if (this.el.uploadJobRingArc) this.el.uploadJobRingArc.style.strokeDashoffset = String(100 - percent);
    if (this.el.uploadJobRingLabel) {
      this.el.uploadJobRingLabel.textContent = job.status === 'completed' ? '✓' : `${percent}%`;
    }
    if (this.el.uploadJobLabel) this.el.uploadJobLabel.textContent = uploadJobStatusText(job);
    if (this.el.uploadJobFiles) {
      const frag = document.createDocumentFragment();
      for (const file of job.files) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = streamLabel(file.stream);
        const status = document.createElement('span');
        status.textContent = uploadFileStatusText(file.status);
        li.append(name, status);
        frag.appendChild(li);
      }
      this.el.uploadJobFiles.replaceChildren(frag);
    }
    // Dismiss only makes sense once the job is finished.
    if (this.el.uploadJobDismiss) this.el.uploadJobDismiss.hidden = job.status === 'uploading';
  }

  private wireUploadDismiss() {
    this.el.uploadJobDismiss?.addEventListener('click', () => void this.dismissUploadJob());
    // "New recording" leaves the upload screen for Setup (the live tab) — the upload
    // keeps running in the background and stays reachable via its tab (ADR-0004).
    this.el.uploadJobNew?.addEventListener('click', () => this.selectTab('live'));
  }

  /** Dismisses the shown job's tab; the background drops it and pushes a fresh view. */
  private async dismissUploadJob() {
    const id = this.shownJobId;
    if (!id) return;
    this.selectedTab = 'live'; // leave the tab before it disappears
    try {
      const resp = await sendToBackground({ type: 'DISMISS_UPLOAD_JOB', jobId: id });
      this.state.applySession(resp.session);
    } catch (e: unknown) {
      console.error('[popup] DISMISS_UPLOAD_JOB error', e);
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
