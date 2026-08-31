/**
 * @file popup/PopupController.ts
 *
 * Stateful popup controller. The popup is intentionally thin and disposable:
 * it initiates actions, reflects current recording/uploading state, and can be
 * closed/reopened at any time without owning the recording lifecycle.
 */

import { CameraPermissionService } from './CameraPermissionService';
import { CaptionPoller } from './CaptionPoller';
import { ConfirmDialog } from './ConfirmDialog';
import { MicPermissionService } from './MicPermissionService';
import { RecordingTimer } from './RecordingTimer';
import { RecordingNotesView } from './RecordingNotesView';
import { RecordingNotesDetail } from './RecordingNotesDetail';
import { RecordingNameDialog } from './RecordingNameDialog';
import { SessionTabsView } from './SessionTabsView';
import { PopupStateController } from './controllers/PopupStateController';
import type {
  PopupPreviewDeviceOption,
  PopupPreviewPermissionState,
  PopupPreviewState,
} from './popupPreviewState';
import {
  buildDiscardConfirmMessage,
  buildLocalSaveFailedAlert,
  buildLocalSaveFailedToast,
  buildDiscardErrorAlert,
  buildMicPermissionError,
  buildSavedLocallyMessage,
  buildStartErrorAlert,
  buildStopErrorAlert,
  buildTranscriptFilename,
  CAMERA_PERMISSION_ERROR,
  DISCARD_CONFIRM_TEXT,
  POPUP_TOAST_TEXT,
} from './popupMessages';
import { setActiveView, type PopupElements } from './popupView';
import { downloadFile } from '../platform/chrome/downloads';
import { createExternalTab, createRuntimeTab, queryActiveTab } from '../platform/chrome/tabs';
import { sendToBackground, sendToContent } from '../shared/messages';
import type { RecordingNotation } from '../shared/notations';
import type {
  BgToPopup,
  CommandResult,
  PopupListRecordingNotations,
  PopupRemoveRecordingNotation,
  PopupUpdateRecordingNotation,
  PopupEndNotation,
  PopupMarkNotation,
  PopupRemoveActiveNotation,
  PopupUpdateActiveNotation,
} from '../shared/protocol';
import { isDevBuild, isTestRuntime } from '../shared/build';
import { formatBytes } from '../shared/format';
import type {
  RecordingInputDevice,
  RecordingPhase,
  RecordingRunConfig,
  RecordingStatusView,
  UploadJob,
} from '../shared/recording';
import type { RecordingHistoryEntry } from '../shared/recordingHistory';
import { formatDuration } from './popupStatus';

/** Joins labels as "a", "a & b", or "a, b & c". */
function humanJoin(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

/** Chrome exposes `default` as a virtual alias alongside the same physical input. */
function normalizedInputLabel(label: string): string {
  return label.trim().replace(/^default\s*[-:]\s*/i, '').replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** Keeps a system-default alias only when it is not also represented by a physical device. */
function uniqueInputDevices(devices: MediaDeviceInfo[], kind: MediaDeviceKind): MediaDeviceInfo[] {
  const physicalLabels = new Set(
    devices
      .filter((item) => item.kind === kind && item.deviceId && item.deviceId !== 'default')
      .map((item) => normalizedInputLabel(item.label))
      .filter(Boolean)
  );
  return devices.filter((item) => {
    if (item.kind !== kind || !item.deviceId) return false;
    return item.deviceId !== 'default' || !physicalLabels.has(normalizedInputLabel(item.label));
  });
}

/** Makes a retained browser alias clear without presenting it as duplicate hardware. */
function inputDeviceLabel(item: MediaDeviceInfo, fallback: string): string {
  const label = item.label.trim();
  if (item.deviceId !== 'default') return label || fallback;
  const target = normalizedInputLabel(label);
  return target ? `System default — ${label.replace(/^default\s*[-:]\s*/i, '').trim()}` : 'System default';
}

/**
 * The popup is a fresh document each open and only learns the real phase from an
 * async status fetch. We mirror the last rendered phase into `localStorage` (the
 * one store the popup can read *synchronously*) so the next open can paint the
 * right view on the first frame and never flash the wrong screen.
 */
const LAST_PHASE_KEY = 'meetRecorder.lastPhase';

type PermissionQueryState = PopupPreviewPermissionState;

type PendingPermissionStart = {
  tabId: number;
  runConfig: RecordingRunConfig;
};

type PopupDetailTarget =
  | { kind: 'recording'; entry: RecordingHistoryEntry }
  | { kind: 'upload'; job: UploadJob };

function recordingDetailDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(timestamp))
    .toUpperCase();
}

function recordingDetailDuration(entry: RecordingHistoryEntry): string {
  return entry.durationMs == null ? '—' : formatDuration(entry.durationMs);
}

function detailPercent(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

const DETAIL_OPEN_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4h6v6M11.5 4.5L5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DETAIL_RENAME_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 2.8l2.7 2.7M3 11.4l7.6-7.6 2.7 2.7L5.6 14l-3 .4z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DETAIL_DRIVE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 13a3 3 0 01-.3-5.99A4 4 0 0112 6.5a2.75 2.75 0 01-.25 5.5H4.5z"/></svg>';
const DETAIL_LINK_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.5 9.5a2.5 2.5 0 003.5 0l2-2a2.5 2.5 0 00-3.5-3.5l-1 1M9.5 6.5a2.5 2.5 0 00-3.5 0l-2 2a2.5 2.5 0 003.5 3.5l1-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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
  private readonly notes: RecordingNotesView;
  /** Static notations for gallery previews; null in the real popup. */
  private previewNotations: RecordingNotation[] | null = null;
  private readonly captionPoller: CaptionPoller;
  private readonly sessionTabs: SessionTabsView;
  private readonly confirmDialog = new ConfirmDialog();
  private readonly recordingNameDialog = new RecordingNameDialog();
  private namingJobId: string | null = null;
  private destroyed = false;
  private inFlight = false;
  private micMuted = false;
  private cameraMuted = false;
  private paused = false;
  /** A local history screen must not be overwritten by the async initial state refresh. */
  private showingRecordings = false;
  /** Detail is pushed from the compact history view and keeps that view's context live. */
  private detailTarget: PopupDetailTarget | null = null;
  private pendingPermissionStart: PendingPermissionStart | null = null;
  /** Last phase/session, replayed when a tab is clicked without a new background push. */
  private lastPhase: RecordingPhase = 'idle';
  private lastSession?: RecordingStatusView;
  private activeDevicePicker: RecordingInputDevice | null = null;
  private devicePickerRequestId = 0;
  /** Preview rendering must never start Chrome polling or live UI timers. */
  private previewing = false;

  constructor(el: PopupElements) {
    this.el = el;
    this.timer = new RecordingTimer(el.recTimer);
    this.notes = new RecordingNotesView(el.notes, {
      mark: () => this.markNote(),
      end: (id) => this.endNote(id),
      save: (id, text) => this.saveNoteMessage(id, text),
      remove: (id) => this.removeNote(id),
    });
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
    this.destroyed = false;
    // Paint the last-known view synchronously, before the async GET_RECORDING_STATUS
    // round-trip resolves, so a popup reopened mid-recording shows the recording view
    // on the first frame instead of flashing the Setup screen. The fetch then corrects
    // it in the rare case the phase changed while the popup was closed.
    setActiveView(this.el, readCachedPhase());
    this.wireRecordingStateListener();
    this.wireTranscriptDownload();
    this.wireStartStop();
    this.wireDiscard();
    this.wirePermissionInterstitial();
    this.wireMic();
    this.wireMuteMic();
    this.wireHideCamera();
    this.wireDevicePicker();
    this.wirePause();
    this.wireSettingsLink();
    this.wireRecordingsLink();
    this.wireUploadNavigation();
    this.wireRecordingDetail();
    this.wireDiagnosticsLink();
    document.getElementById('upload-job-transcript')?.addEventListener('click', () => this.el.saveBtn?.click());
    this.sessionTabs.wireEvents();
    void this.refreshRecordingsCount();
    void this.state.refreshInitialState();
  }

  /**
   * Renders a deterministic development fixture through the production popup
   * controller. This is intentionally a data seam, not a second DOM renderer:
   * gallery stories provide only values that Chrome/background would normally
   * supply, while this controller continues to own the resulting markup.
   */
  renderPreview(preview: PopupPreviewState): void {
    this.previewing = true;
    this.captionPoller.stop();
    this.closeDevicePicker(false);

    if (preview.screen === 'permission') {
      this.showingRecordings = false;
      this.detailTarget = null;
      this.renderPermissionView(preview.microphone, preview.camera);
      return;
    }

    if (preview.screen === 'recording-detail') {
      this.showingRecordings = false;
      this.detailTarget = null;
      this.previewNotations = preview.notations ?? [];
      this.showRecordingDetail(preview.target);
      return;
    }

    if (preview.screen === 'recordings') {
      this.showingRecordings = false;
      this.detailTarget = null;
      const session = preview.session ?? { phase: 'idle' as const, runConfig: null, updatedAt: 0 };
      this.state.applyPreviewSession(session);
      this.showRecordingsViewWithEntries(preview.entries);
      return;
    }

    this.showingRecordings = false;
    this.detailTarget = null;
    this.state.applyPreviewSession(preview.session);
    if (preview.selectedUploadJobId) this.sessionTabs.select(preview.selectedUploadJobId);
    this.renderPreviewTranscript(preview.transcriptActive === true);
    this.notes.setNotations(preview.notations ?? []);
    this.renderPreviewSetup(preview.setup);
    if (preview.devicePicker) this.renderPreviewDevicePicker(preview.devicePicker.device, preview.devicePicker.options);
  }

  /** Wires the controller-owned interactions that are safe inside a static preview. */
  wirePreviewInteractions(): void {
    this.wireRecordingDetailMenu();
    this.wireDevicePickerDismissal();
  }

  /** Clears transient timers when the popup is torn down. */
  destroy() {
    this.destroyed = true;
    this.timer.stop();
    this.captionPoller.stop();
    this.sessionTabs.dispose();
    this.confirmDialog.dispose();
    this.recordingNameDialog.dispose();
    this.closeDevicePicker(false);
  }

  /**
   * Switches the popup to the view its phase maps to (config / recording /
   * finalizing) and populates that view. Live intervals (the recording timer and
   * the caption-state poll) run only while the recording view is active.
   */
  private onPhaseChange(phase: RecordingPhase, session?: RecordingStatusView) {
    this.lastPhase = phase;
    this.lastSession = session;
    this.queueCompletedNamingPrompt(phase, session);
    writeCachedPhase(phase);
    this.updateUploadNavigation(session);
    // `showRecordingsView` awaits the history query. The initial status refresh can
    // resolve in that gap; retaining the explicit local view prevents setup and
    // history from rendering together (and makes the popup scroll under its footer).
    if (this.showingRecordings) {
      const detail = this.detailTarget;
      if (detail?.kind === 'upload') {
        const current = session?.uploadJobs?.find((job) => job.id === detail.job.id);
        if (current) {
          if (current.status === 'completed' && current.historyId) void this.promoteCompletedDetailUpload(current);
          else {
            this.detailTarget = { kind: 'upload', job: current };
            this.renderRecordingDetail();
          }
        }
      }
      return;
    }
    this.sessionTabs.sync(phase, session);
    if (this.el.discardBtn) this.el.discardBtn.hidden = phase !== 'starting' && phase !== 'recording';
    this.updateHeaderPhase(phase, session?.paused === true);

    // An upload tab is selected: show only that job's upload view and stop the
    // live-recording intervals (we're not on the recording view).
    const job = this.sessionTabs.activeJob(session);
    if (job) {
      this.closeDevicePicker(false);
      this.timer.stop();
      this.notes.stop();
      this.captionPoller.stop();
      if (this.el.sessionTabs) this.el.sessionTabs.hidden = true;
      if (this.el.viewConfig) this.el.viewConfig.hidden = true;
      if (this.el.viewPermission) this.el.viewPermission.hidden = true;
      if (this.el.viewRecording) this.el.viewRecording.hidden = true;
      if (this.el.viewFinalizing) this.el.viewFinalizing.hidden = true;
      if (this.el.viewUpload) this.el.viewUpload.hidden = false;
      this.setHeaderCompact(true);
      this.updateHeaderUpload(job.status === 'completed');
      this.sessionTabs.renderJobView(job);
      return;
    }

    if (this.el.viewUpload) this.el.viewUpload.hidden = true;
    const view = setActiveView(this.el, phase);
    this.setHeaderCompact(view !== 'config');

    if (view === 'recording') {
      this.updateRecordingBanner(phase, session);
      this.updateTabSourceInfo(session);
      this.updateChips(session);
      this.updateMuteControl(session);
      this.updateCameraControl(session);
      this.updatePauseControl(phase, session);
      if (this.el.stopBtn) this.el.stopBtn.disabled = false;
      this.timer.sync(phase, session);
      this.notes.sync(phase, session);
      if (!this.previewing) void this.refreshNotes();
      if (this.previewing) this.captionPoller.stop();
      else this.captionPoller.start();
    } else {
      this.closeDevicePicker(false);
      this.timer.stop();
      this.captionPoller.stop();
      // The recording this prompt refers to is gone (it stopped on its own, or
      // the tab closed); confirming it now would only produce a "no active
      // session" error, so retract the question.
      this.confirmDialog.dismiss();
      this.micMuted = this.cameraMuted = this.paused = false;
      if (view === 'finalizing') this.updateFinalizingView(phase, session);
      if (view === 'config' && this.el.startBtn) this.el.startBtn.disabled = false;
    }

  }

  /** Renders the one poll-owned recording indicator from a deterministic fixture. */
  private renderPreviewTranscript(active: boolean): void {
    if (this.el.chipTranscriptLabel) this.el.chipTranscriptLabel.textContent = active ? 'Transcribing' : 'Transcript off';
    this.el.chipTranscript?.classList.toggle('off', !active);
  }

  /** Applies setup conditions that Chrome would normally expose through permission services. */
  private renderPreviewSetup(setup?: {
    micPermissionRequired?: boolean;
    cameraWarningText?: string;
  }): void {
    if (!setup) return;
    if (this.el.micBtn) this.el.micBtn.hidden = setup.micPermissionRequired !== true;
    if (setup.cameraWarningText != null) {
      if (this.el.cameraWarning) this.el.cameraWarning.hidden = false;
      if (this.el.cameraWarningText) this.el.cameraWarningText.textContent = setup.cameraWarningText;
    }
  }

  /**
   * Re-reads the active run's notations. Live commands in this protocol name no
   * run — `SET_PAUSED` and `STOP_RECORDING` mean "the one happening now" — so
   * `toStatusView` has never needed to carry the live `historyId`, and the
   * notation commands follow the same shape.
   */
  private async refreshNotes(): Promise<void> {
    try {
      const response = await sendToBackground({ type: 'LIST_ACTIVE_NOTATIONS' });
      if (response.ok) this.notes.setNotations(response.notations);
    } catch (error) {
      console.warn('[popup] LIST_ACTIVE_NOTATIONS failed', error);
    }
  }

  /**
   * Runs one note command and re-reads the list. Deliberately quiet on success:
   * starting and ending a note must not interrupt the meeting, so only a failure
   * is worth a toast.
   */
  private async runNoteCommand(
    message: PopupMarkNotation | PopupEndNotation | PopupUpdateActiveNotation | PopupRemoveActiveNotation,
    fallbackError: string,
  ): Promise<void> {
    try {
      const response = await sendToBackground(message);
      if (!response.ok) this.toast(response.error || fallbackError);
    } catch (error) {
      console.warn(`[popup] ${message.type} failed`, error);
      this.toast(fallbackError);
    }
    await this.refreshNotes();
  }

  private markNote(): Promise<void> {
    return this.runNoteCommand({ type: 'MARK_NOTATION' }, 'Could not start a note');
  }

  private endNote(id: string): Promise<void> {
    return this.runNoteCommand({ type: 'END_NOTATION', id }, 'Could not end the note');
  }

  private saveNoteMessage(id: string, text: string): Promise<void> {
    return this.runNoteCommand({ type: 'UPDATE_ACTIVE_NOTATION', id, text }, 'Could not save the note');
  }

  private removeNote(id: string): Promise<void> {
    return this.runNoteCommand({ type: 'REMOVE_ACTIVE_NOTATION', id }, 'Could not delete the note');
  }

  /**
   * Keyed notation reads/writes for a finished recording. In preview the list
   * is supplied statically so the gallery never talks to the background.
   */
  private notesDetailActions() {
    const preview = this.previewNotations;
    if (preview) {
      let current = [...preview];
      return {
        load: async () => current,
        rename: async (_id: string, id: string, text: string) => {
          current = current.map((n) => (n.id === id ? { ...n, text: text.trim() } : n));
          return current;
        },
        remove: async (_id: string, id: string) => {
          current = current.filter((n) => n.id !== id);
          return current;
        },
      };
    }
    return {
      load: async (recordingId: string) => await this.readNotations({ type: 'LIST_RECORDING_NOTATIONS', recordingId }),
      rename: async (recordingId: string, id: string, text: string) =>
        await this.readNotations({ type: 'UPDATE_RECORDING_NOTATION', recordingId, id, text }),
      remove: async (recordingId: string, id: string) =>
        await this.readNotations({ type: 'REMOVE_RECORDING_NOTATION', recordingId, id }),
    };
  }

  /** Sends a keyed notation message and returns the resulting list, toasting failures. */
  private async readNotations(
    message: PopupListRecordingNotations | PopupUpdateRecordingNotation | PopupRemoveRecordingNotation,
  ): Promise<RecordingNotation[]> {
    const response = await sendToBackground(message);
    if (response.ok) return response.notations;
    this.toast(response.error || 'Could not read the notes for this recording');
    throw new Error(response.error);
  }

  private toast(msg: string) {
    // The shared footer message has been removed; keep notices available in the
    // test console until each action receives its own designed feedback surface.
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
      if (this.el.micDeviceTrigger) this.el.micDeviceTrigger.disabled = true;
      return;
    }

    if (this.el.micModeLabel) this.el.micModeLabel.textContent = micMode.toUpperCase();
    this.updateDeviceLabel(this.el.micDeviceLabel, session?.capturedDevices?.microphone, 'microphone', session?.phase);
    if (this.el.micDeviceTrigger) this.el.micDeviceTrigger.disabled = session?.phase !== 'recording';
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
      if (this.el.cameraDeviceTrigger) this.el.cameraDeviceTrigger.disabled = true;
      return;
    }

    this.cameraMuted = session?.cameraMuted === true;
    this.updateDeviceLabel(this.el.cameraDeviceLabel, session?.capturedDevices?.camera, 'camera', session?.phase);
    if (this.el.cameraDeviceTrigger) this.el.cameraDeviceTrigger.disabled = session?.phase !== 'recording';
    const cameraMode = document.getElementById('camera-mode-label');
    if (cameraMode) {
      cameraMode.textContent = '720P';
    }
    this.renderTogglePill(btn, this.cameraMuted, '[data-camera-label]');
  }

  /** Renders the label Chrome exposed for the active track, without claiming it was explicitly chosen. */
  private updateDeviceLabel(
    el: HTMLElement | null,
    label: string | undefined,
    device: 'microphone' | 'camera',
    phase: RecordingPhase | undefined,
  ): void {
    if (!el) return;
    const text = label || (phase === 'starting' ? 'Connecting…' : `${device === 'microphone' ? 'Microphone' : 'Camera'} unavailable`);
    el.textContent = text;
    el.title = label ? `Current ${device}: ${label}` : text;
  }

  /** Opens the reference-style bottom sheet and switches the active track in place. */
  private wireDevicePicker(): void {
    this.el.micDeviceTrigger?.addEventListener('click', () => void this.openDevicePicker('microphone'));
    this.el.cameraDeviceTrigger?.addEventListener('click', () => void this.openDevicePicker('camera'));
    this.wireDevicePickerDismissal();
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.activeDevicePicker) this.closeDevicePicker();
    });
  }

  /** Shared close interactions for the live picker and the deterministic preview. */
  private wireDevicePickerDismissal(): void {
    this.el.devicePickerClose?.addEventListener('click', () => this.closeDevicePicker());
    this.el.devicePicker?.querySelector<HTMLElement>('[data-device-picker-dismiss]')
      ?.addEventListener('click', () => this.closeDevicePicker());
  }

  private async openDevicePicker(device: RecordingInputDevice): Promise<void> {
    if (this.lastSession?.phase !== 'recording' || !this.el.devicePicker || !this.el.devicePickerList) return;

    const requestId = ++this.devicePickerRequestId;
    this.activeDevicePicker = device;
    this.el.devicePicker.hidden = false;
    if (this.el.devicePickerTitle) this.el.devicePickerTitle.textContent = device.toUpperCase();
    if (this.el.devicePickerTrack) this.el.devicePickerTrack.textContent = device === 'microphone' ? 'Audio track' : 'Video track';
    if (this.el.devicePickerMode) {
      this.el.devicePickerMode.textContent = device === 'microphone'
        ? (this.lastSession.runConfig?.micMode ?? 'separate').toUpperCase()
        : '720P';
    }
    if (this.el.devicePickerError) {
      this.el.devicePickerError.hidden = true;
      this.el.devicePickerError.textContent = '';
    }
    this.el.devicePickerList.replaceChildren(this.buildDevicePickerMessage('Loading devices…'));

    try {
      const devices = await navigator.mediaDevices?.enumerateDevices?.();
      if (this.activeDevicePicker !== device || this.devicePickerRequestId !== requestId) return;
      const kind: MediaDeviceKind = device === 'microphone' ? 'audioinput' : 'videoinput';
      const available = uniqueInputDevices(devices ?? [], kind);
      if (available.length === 0) {
        this.el.devicePickerList.replaceChildren(this.buildDevicePickerMessage(`No ${device === 'microphone' ? 'microphones' : 'cameras'} found`));
        return;
      }

      const currentLabel = this.lastSession.capturedDevices?.[device];
      const options = available.map((item, index) => ({
        id: item.deviceId,
        label: inputDeviceLabel(item, `${device === 'microphone' ? 'Microphone' : 'Camera'} ${index + 1}`),
        selected: Boolean(currentLabel && normalizedInputLabel(item.label) === normalizedInputLabel(currentLabel)),
      }));
      this.renderDevicePickerOptions(options, true);
    } catch (error: unknown) {
      console.error('[popup] enumerateDevices error', error);
      if (this.activeDevicePicker === device && this.devicePickerRequestId === requestId) {
        this.el.devicePickerList.replaceChildren(this.buildDevicePickerMessage('Unable to list devices'));
      }
    }
  }

  private buildDevicePickerMessage(text: string): HTMLElement {
    const message = document.createElement('div');
    message.className = 'device-picker-empty';
    message.textContent = text;
    return message;
  }

  /** Shared option renderer for the browser-backed picker and deterministic preview. */
  private renderDevicePickerOptions(options: PopupPreviewDeviceOption[], focusSelected = false): void {
    if (!this.el.devicePickerList) return;
    const rendered = options.map((item) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'device-picker-option';
      option.dataset.deviceId = item.id;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(item.selected === true));

      const copy = document.createElement('span');
      copy.className = 'device-picker-option-label';
      copy.textContent = item.label;
      option.append(copy);
      if (item.selected) {
        const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        check.setAttribute('class', 'device-picker-check');
        check.setAttribute('viewBox', '0 0 16 16');
        check.setAttribute('aria-hidden', 'true');
        check.innerHTML = '<path d="M3 8.2l3.1 3.1L13 4.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
        option.append(check);
      }
      option.addEventListener('click', () => void this.selectInputDevice(item.id));
      return option;
    });
    this.el.devicePickerList.replaceChildren(...rendered);
    if (focusSelected) rendered.find((option) => option.getAttribute('aria-selected') === 'true')?.focus();
  }

  private renderPreviewDevicePicker(device: RecordingInputDevice, options: PopupPreviewDeviceOption[]): void {
    if (!this.el.devicePicker || !this.el.devicePickerList) return;
    this.activeDevicePicker = device;
    this.el.devicePicker.hidden = false;
    if (this.el.devicePickerTitle) this.el.devicePickerTitle.textContent = device.toUpperCase();
    if (this.el.devicePickerTrack) this.el.devicePickerTrack.textContent = device === 'microphone' ? 'Audio track' : 'Video track';
    if (this.el.devicePickerMode) {
      this.el.devicePickerMode.textContent = device === 'microphone'
        ? (this.lastSession?.runConfig?.micMode ?? 'separate').toUpperCase()
        : '720P';
    }
    if (this.el.devicePickerError) {
      this.el.devicePickerError.hidden = true;
      this.el.devicePickerError.textContent = '';
    }
    this.renderDevicePickerOptions(options);
  }

  private async selectInputDevice(deviceId: string): Promise<void> {
    const device = this.activeDevicePicker;
    if (!device || !deviceId || !this.el.devicePickerList) return;
    const options = Array.from(this.el.devicePickerList.querySelectorAll<HTMLButtonElement>('.device-picker-option'));
    options.forEach((option) => { option.disabled = true; });
    if (this.el.devicePickerError) this.el.devicePickerError.hidden = true;

    try {
      const response = await sendToBackground({ type: 'SET_INPUT_DEVICE', device, deviceId });
      if (response.ok === false) throw new Error(response.error || `Failed to change ${device}`);
      this.state.applySession(response.session);
      const label = response.session.capturedDevices?.[device];
      this.toast(`${device === 'microphone' ? 'Microphone' : 'Camera'} changed${label ? ` to ${label}` : ''}`);
      this.closeDevicePicker();
    } catch (error: unknown) {
      console.error('[popup] SET_INPUT_DEVICE error', error);
      options.forEach((option) => { option.disabled = false; });
      if (this.el.devicePickerError) {
        this.el.devicePickerError.hidden = false;
        this.el.devicePickerError.textContent = error instanceof Error ? error.message : `Failed to change ${device}`;
      }
    }
  }

  private closeDevicePicker(restoreFocus = true): void {
    const device = this.activeDevicePicker;
    this.devicePickerRequestId += 1;
    this.activeDevicePicker = null;
    if (this.el.devicePicker) this.el.devicePicker.hidden = true;
    if (!restoreFocus || !device) return;
    (device === 'microphone' ? this.el.micDeviceTrigger : this.el.cameraDeviceTrigger)?.focus();
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
    btn.classList.toggle('btn-primary', this.paused);
    btn.classList.toggle('btn-secondary', !this.paused);
    btn.classList.remove('btn-danger');
    const label = btn.querySelector<HTMLElement>('[data-pause-label]') ?? btn;
    label.textContent = this.paused ? 'Resume Recording' : 'Pause';
    const icon = btn.querySelector('svg');
    if (icon) {
      icon.innerHTML = this.paused
        ? '<path d="M3 2l7 4-7 4V2z"/>'
        : '<rect x="1" y="1" width="3.4" height="12" rx="1"/><rect x="7.6" y="1" width="3.4" height="12" rx="1"/>';
      icon.setAttribute('viewBox', this.paused ? '0 0 12 12' : '0 0 12 14');
    }
    document.querySelector('.controls')?.classList.toggle('paused', this.paused);
    const stopLabel = this.el.stopBtn?.querySelector<HTMLElement>('[data-stop-label]');
    if (stopLabel) stopLabel.textContent = this.paused ? 'Stop & Save' : 'Finish Recording';
    document.getElementById('paused-meta')?.toggleAttribute('hidden', !this.paused);
  }

  /** Full wordmark header on the idle/config screen; compact header everywhere else. */
  private setHeaderCompact(compact: boolean): void {
    this.el.ppHeader?.classList.toggle('compact', compact);
  }

  /** Mirrors the reference design's compact status label beside the wordmark. */
  private updateHeaderPhase(phase: RecordingPhase, paused: boolean): void {
    const label = document.getElementById('header-phase');
    if (!label) return;
    const active = phase === 'starting' || phase === 'recording' || phase === 'stopping';
    const uploadNavigationVisible = !document.getElementById('open-upload-navigation')?.hidden;
    // Sealing is deliberately quiet: the finalizing screen owns the status, while
    // An in-flight upload is represented by the compact progress control instead.
    label.hidden = uploadNavigationVisible || !active || phase === 'stopping';
    label.textContent = paused ? 'PAUSED' : phase === 'stopping' ? 'SAVING' : 'REC';
    label.dataset.tone = paused ? 'paused' : 'recording';
    this.el.ppHeader?.classList.toggle('recording-active', active && !paused);
    this.el.ppHeader?.classList.toggle('recording-paused', active && paused);
    this.el.ppHeader?.classList.remove('recording-saved');
    this.el.ppHeader?.classList.remove('permission-blocked');
  }

  /** Updates the header tone while a detached upload detail is visible. */
  private updateHeaderUpload(completed: boolean): void {
    const label = document.getElementById('header-phase');
    if (!label) return;
    label.hidden = true;
    this.el.ppHeader?.classList.toggle('recording-active', !completed);
    this.el.ppHeader?.classList.remove('recording-paused');
    this.el.ppHeader?.classList.toggle('recording-saved', completed);
  }

  /** Header-level one-tap return to the latest in-flight upload. */
  private updateUploadNavigation(session?: RecordingStatusView): void {
    const button = document.getElementById('open-upload-navigation') as HTMLButtonElement | null;
    const ring = document.getElementById('upload-navigation-ring');
    const percentLabel = document.getElementById('upload-navigation-percent');
    if (!button || !ring || !percentLabel) return;
    const uploadingJobs = (session?.uploadJobs ?? []).filter((candidate) => candidate.status === 'uploading');
    const job = uploadingJobs[uploadingJobs.length - 1];
    button.hidden = !job;
    if (!job) {
      button.dataset.jobId = '';
      return;
    }
    const percent = detailPercent(job.progress);
    button.dataset.jobId = job.id;
    button.title = `Open upload progress (${percent}%)`;
    button.setAttribute('aria-label', `Open upload progress, ${percent}% complete`);
    ring.style.setProperty('--upload-progress', String(percent));
    percentLabel.textContent = `${percent}%`;
  }

  /** Sets the recording banner label + paused styling for the current phase. */
  private updateRecordingBanner(phase: RecordingPhase, session?: RecordingStatusView) {
    const paused = phase === 'recording' && session?.paused === true;
    const starting = phase === 'starting';
    if (this.el.recLabel) {
      this.el.recLabel.textContent = starting ? 'Starting…' : paused ? 'Paused' : 'REC';
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

  private updateTabSourceInfo(session?: RecordingStatusView) {
    if (!this.el.tabSourceSub) return;
    const contentType = session?.runConfig?.tabContentType === 'video' ? 'Video' : 'Screen';
    const height = session?.tabResolution?.height;
    this.el.tabSourceSub.textContent =
      typeof height === 'number' && height > 0 ? `${contentType} · ${Math.round(height)}p` : contentType;
  }

  /** Populates the finalizing view: spinner + a per-stream checklist of what's being sealed. */
  private updateFinalizingView(_phase: RecordingPhase, session?: RecordingStatusView) {
    if (this.el.finalizingLabel) this.el.finalizingLabel.textContent = 'Finalizing recording';
    this.updateUploadRing();
    const cfg = session?.runConfig;
    // The real output files this run produces: the tab always; a separate mic file
    // only in 'separate' mode; a camera file only when recording it separately.
    const sources: string[] = ['Meeting tab'];
    if (cfg?.micMode === 'separate') sources.push('Microphone');
    if (cfg?.recordSelfVideo) sources.push('Camera');

    if (this.el.finalizingSub) {
      const shorts = sources.map((s) => (s === 'Meeting tab' ? 'tab' : s === 'Microphone' ? 'mic' : 'camera'));
      this.el.finalizingSub.textContent = `Muxing ${humanJoin(shorts)}`;
    }
    if (this.el.finalizingFiles) {
      const frag = document.createDocumentFragment();
      for (const label of sources) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = label;
        const spin = document.createElement('span');
        spin.className = 'file-spin';
        li.append(name, spin);
        frag.appendChild(li);
      }
      this.el.finalizingFiles.replaceChildren(frag);
    }
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

  private wireRecordingsLink() {
    if (!this.el.openRecordingsBtn) return;
    this.el.openRecordingsBtn.addEventListener('click', () => void this.showRecordingsView());
    document.getElementById('new-recording')?.addEventListener('click', () => this.hideRecordingsView());
    document.getElementById('see-all-recordings')?.addEventListener('click', () => void createRuntimeTab('recordings.html'));
  }

  private wireUploadNavigation(): void {
    const button = document.getElementById('open-upload-navigation') as HTMLButtonElement | null;
    if (!button) return;
    button.addEventListener('click', () => {
      const jobId = button.dataset.jobId;
      if (!jobId || !this.lastSession?.uploadJobs?.some((job) => job.id === jobId && job.status === 'uploading')) return;
      this.sessionTabs.openUpload(jobId);
    });
  }

  private wireRecordingDetail(): void {
    const back = document.getElementById('recording-detail-back');
    this.wireRecordingDetailMenu();
    back?.addEventListener('click', () => void this.showRecordingsView());
    document.getElementById('recording-detail-copy')?.addEventListener('click', () => void this.copyDetailDriveLink());
    document.getElementById('recording-detail-rename')?.addEventListener('click', () => void this.startDetailRename());
    document.getElementById('recording-detail-delete')?.addEventListener('click', () => void this.deleteDetailRecording());
    document.getElementById('recording-detail-diagnostics')?.addEventListener('click', () => void createRuntimeTab('debug.html'));
    document.getElementById('recording-detail-settings')?.addEventListener('click', () => void createRuntimeTab('settings.html'));
  }

  /** Shared detail-menu disclosure for the live popup and development preview. */
  private wireRecordingDetailMenu(): void {
    const menuButton = document.getElementById('recording-detail-menu-button');
    const menu = document.getElementById('recording-detail-menu');
    const closeMenu = () => {
      if (menu) menu.hidden = true;
      menuButton?.setAttribute('aria-expanded', 'false');
    };

    menuButton?.addEventListener('click', () => {
      if (!menu) return;
      const opening = menu.hidden;
      menu.hidden = !opening;
      menuButton.setAttribute('aria-expanded', String(opening));
    });
    document.addEventListener('click', (event) => {
      if (menu && !menu.hidden && !menu.contains(event.target as Node) && !menuButton?.contains(event.target as Node)) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });
  }

  private closeRecordingDetailMenu(): void {
    const menu = document.getElementById('recording-detail-menu');
    const button = document.getElementById('recording-detail-menu-button');
    if (menu) menu.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
  }

  private async showRecordingsView(): Promise<void> {
    this.showRecordingsViewWithEntries();
    try {
      const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY' });
      this.renderRecordingsEntries(response.ok ? response.entries : []);
    } catch {
      this.renderRecordingsEntries([]);
    }
  }

  /** Presents the production recordings layout before its data source is resolved. */
  private showRecordingsViewWithEntries(entries?: RecordingHistoryEntry[]): void {
    const recordings = document.getElementById('view-recordings');
    if (!recordings) return;
    this.showingRecordings = true;
    this.detailTarget = null;
    this.closeRecordingDetailMenu();
    const detail = document.getElementById('view-recording-detail');
    if (detail) detail.hidden = true;
    if (this.el.ppHeader) this.el.ppHeader.hidden = false;
    if (this.el.sessionTabs) this.el.sessionTabs.hidden = true;
    for (const id of ['view-config', 'view-permission', 'view-recording', 'view-finalizing', 'view-upload']) {
      const view = document.getElementById(id);
      if (view) view.hidden = true;
    }
    recordings.hidden = false;
    this.setHeaderCompact(false);
    const title = this.el.ppHeader?.querySelector<HTMLElement>('.brand-name');
    if (title) title.textContent = 'Recordings';
    const list = document.getElementById('popup-recordings-list');
    const empty = document.getElementById('popup-recordings-empty');
    if (!list || !empty) return;
    list.replaceChildren();
    if (entries) this.renderRecordingsEntries(entries);
  }

  /** Shared row renderer for production history responses and preview fixtures. */
  private renderRecordingsEntries(entries: RecordingHistoryEntry[]): void {
    const list = document.getElementById('popup-recordings-list');
    const empty = document.getElementById('popup-recordings-empty');
    if (!list || !empty) return;
    list.replaceChildren();
    const uploads = (this.lastSession?.uploadJobs ?? []).filter((job) => job.status === 'uploading');
    for (const job of uploads) list.appendChild(this.renderPopupUpload(job));
    const visibleEntries = entries.slice(0, Math.max(0, 3 - uploads.length));
    empty.hidden = uploads.length > 0 || visibleEntries.length > 0;
    for (const entry of visibleEntries) list.appendChild(this.renderPopupRecording(entry));
  }

  private async refreshRecordingsCount(): Promise<void> {
    const count = document.getElementById('recordings-count');
    if (!count) return;
    try {
      const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY' });
      if (!response.ok) return;
      count.textContent = String(response.entries.length);
      count.hidden = false;
    } catch {
      count.hidden = true;
    }
  }

  private hideRecordingsView(): void {
    const recordings = document.getElementById('view-recordings');
    if (recordings) recordings.hidden = true;
    const detail = document.getElementById('view-recording-detail');
    if (detail) detail.hidden = true;
    if (this.el.ppHeader) this.el.ppHeader.hidden = false;
    this.detailTarget = null;
    this.closeRecordingDetailMenu();
    this.showingRecordings = false;
    const title = this.el.ppHeader?.querySelector<HTMLElement>('.brand-name');
    if (title) title.textContent = 'Meet Recorder';
    this.onPhaseChange(this.lastPhase, this.lastSession);
  }

  private showRecordingDetail(target: PopupDetailTarget): void {
    const detail = document.getElementById('view-recording-detail');
    if (!detail) return;
    this.showingRecordings = true;
    this.detailTarget = target;
    this.closeRecordingDetailMenu();
    if (this.el.sessionTabs) this.el.sessionTabs.hidden = true;
    if (this.el.ppHeader) this.el.ppHeader.hidden = true;
    for (const id of ['view-config', 'view-permission', 'view-recording', 'view-finalizing', 'view-upload', 'view-recordings']) {
      const view = document.getElementById(id);
      if (view) view.hidden = true;
    }
    detail.hidden = false;
    this.renderRecordingDetail();
  }

  private renderRecordingDetail(): void {
    const target = this.detailTarget;
    const content = document.getElementById('recording-detail-content');
    if (!target || !content) return;
    content.replaceChildren();
    if (target.kind === 'recording') this.renderSavedRecordingDetail(content, target.entry);
    else this.renderUploadRecordingDetail(content, target.job);

    const link = this.detailDriveLink();
    const copy = document.getElementById('recording-detail-copy') as HTMLButtonElement | null;
    const rename = document.getElementById('recording-detail-rename') as HTMLButtonElement | null;
    const remove = document.getElementById('recording-detail-delete') as HTMLButtonElement | null;
    const diagnostics = document.getElementById('recording-detail-diagnostics') as HTMLButtonElement | null;
    if (copy) copy.disabled = !link;
    if (rename) rename.hidden = target.kind !== 'recording';
    if (remove) remove.hidden = target.kind !== 'recording';
    if (diagnostics) diagnostics.hidden = !isDevBuild();
  }

  private renderSavedRecordingDetail(content: HTMLElement, entry: RecordingHistoryEntry): void {
    const titleRow = document.createElement('div');
    titleRow.className = 'recording-detail-title-row';
    const title = document.createElement('h2');
    title.id = 'recording-detail-title';
    title.className = 'recording-detail-title';
    title.textContent = entry.name;
    title.title = entry.name;
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'recording-detail-rename';
    rename.setAttribute('aria-label', 'Rename recording');
    rename.title = 'Rename';
    rename.innerHTML = DETAIL_RENAME_ICON;
    rename.addEventListener('click', () => this.startDetailRename());
    titleRow.append(title, rename);

    const meta = document.createElement('p');
    meta.className = 'recording-detail-meta';
    const totalBytes = entry.files.reduce((total, file) => total + (file.bytes ?? 0), 0);
    meta.textContent = `${recordingDetailDate(entry.createdAt)} · ${recordingDetailDuration(entry)} · ${entry.files.length} ${entry.files.length === 1 ? 'FILE' : 'FILES'} · ${totalBytes ? formatBytes(totalBytes) : '—'}`;

    const destination = document.createElement('p');
    destination.className = 'recording-detail-eyebrow';
    destination.textContent = entry.files.some((file) => file.destination === 'drive') ? 'IN GOOGLE DRIVE' : 'ON LOCAL DISK';
    const files = document.createElement('div');
    files.className = 'recording-detail-files';
    for (const file of entry.files) files.appendChild(this.renderDetailFile(entry, file));
    content.append(titleRow, meta, destination, files);

    // Notes for this recording (d1). Loads on its own and stays hidden if the
    // recording has none, so an unnoted recording looks exactly as before.
    const notes = new RecordingNotesDetail(entry.id, entry.durationMs, this.notesDetailActions());
    content.appendChild(notes.element);
    void notes.load();

    const transcript = entry.files.find((file) => /\.(vtt|txt)$/i.test(file.filename));
    const transcriptButton = document.createElement('button');
    transcriptButton.type = 'button';
    transcriptButton.className = 'recording-detail-transcript';
    transcriptButton.innerHTML = '<span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v6.4M5.3 6.2L8 8.9l2.7-2.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.2 12.5h9.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>Transcript</span><span></span>';
    const transcriptMeta = transcriptButton.querySelector('span:last-child');
    if (transcriptMeta) {
      transcriptMeta.textContent = transcript
        ? `${transcript.filename.split('.').pop()?.toUpperCase() ?? 'TEXT'} · ${typeof transcript.bytes === 'number' ? formatBytes(transcript.bytes) : '—'}`
        : 'VTT · —';
    }
    transcriptButton.addEventListener('click', () => {
      if (transcript) void this.openDetailFile(entry, transcript);
      else this.toast('Transcript is not available for this recording.');
    });
    content.appendChild(transcriptButton);
    content.appendChild(this.renderDetailFooter());
  }

  private renderDetailFile(entry: RecordingHistoryEntry, file: RecordingHistoryEntry['files'][number]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'recording-detail-file';
    const name = document.createElement('span');
    name.className = 'recording-detail-file-name';
    name.textContent = file.filename;
    name.title = file.filename;
    const actions = document.createElement('span');
    actions.className = 'recording-detail-file-actions';
    const size = document.createElement('span');
    size.className = 'recording-detail-file-size';
    size.textContent = typeof file.bytes === 'number' ? formatBytes(file.bytes) : '—';
    actions.appendChild(size);
    if ((file.destination === 'drive' && file.webViewLink) || (file.destination === 'local' && file.downloadId && file.status === 'available')) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'recording-detail-file-open';
      open.setAttribute('aria-label', `Open ${file.filename}`);
      open.innerHTML = DETAIL_OPEN_ICON;
      open.addEventListener('click', () => void this.openDetailFile(entry, file));
      actions.appendChild(open);
    }
    row.append(name, actions);
    return row;
  }

  private renderDetailFooter(): HTMLElement {
    const footer = document.createElement('footer');
    footer.className = 'recording-detail-footer';
    const link = this.detailDriveLink();
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn recording-detail-open-drive';
    open.disabled = !link;
    open.innerHTML = DETAIL_DRIVE_ICON;
    open.append('Open in Google Drive');
    open.addEventListener('click', () => { if (link) void createExternalTab(link); });
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-secondary recording-detail-copy-link';
    copy.disabled = !link;
    copy.innerHTML = DETAIL_LINK_ICON;
    copy.append('Copy Drive link');
    copy.addEventListener('click', () => void this.copyDetailDriveLink());
    footer.append(open, copy);
    return footer;
  }

  private renderUploadRecordingDetail(content: HTMLElement, job: UploadJob): void {
    const title = document.createElement('h2');
    title.className = 'recording-detail-title';
    title.style.marginTop = '16px';
    title.textContent = job.label;
    title.title = job.label;
    const meta = document.createElement('p');
    meta.className = 'recording-detail-meta';
    meta.style.marginTop = '4px';
    meta.style.marginBottom = '16px';
    meta.textContent = `${recordingDetailDate(job.startedAt)} · ${job.status === 'uploading' ? 'UPLOADING' : job.status.toUpperCase()}`;
    const progress = document.createElement('div');
    progress.className = 'recording-detail-upload-progress';
    const percent = detailPercent(job.progress);
    progress.innerHTML = `<span class="recording-detail-upload-percent">${percent}%</span><span class="recording-detail-upload-label">to Google Drive</span>`;
    const track = document.createElement('div');
    track.className = 'recording-detail-progress';
    const fill = document.createElement('span');
    fill.style.width = `${percent}%`;
    track.appendChild(fill);
    const eyebrow = document.createElement('p');
    eyebrow.className = 'recording-detail-eyebrow';
    eyebrow.style.marginBottom = '12px';
    eyebrow.textContent = `${job.files.length} ${job.files.length === 1 ? 'FILE' : 'FILES'}`;
    const files = document.createElement('div');
    files.className = 'recording-detail-upload-files';
    for (const file of job.files) {
      const item = document.createElement('div');
      const complete = file.status === 'uploaded';
      item.className = `recording-detail-upload-file${complete ? ' recording-detail-upload-file--done' : ''}`;
      const head = document.createElement('div');
      head.className = 'recording-detail-upload-file-head';
      const name = document.createElement('span');
      name.className = 'recording-detail-upload-file-name';
      name.textContent = file.filename;
      name.title = file.filename;
      const status = document.createElement('span');
      status.className = 'recording-detail-upload-file-status';
      if (complete) status.innerHTML = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7.2l2.6 2.6L11 4.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>DONE';
      else if (typeof file.bytes === 'number') status.textContent = `${formatBytes(Math.round(file.bytes * job.progress))} / ${formatBytes(file.bytes)}`;
      else status.textContent = file.status === 'retry-pending' ? 'RETRYING' : 'UPLOADING';
      head.append(name, status);
      const fileTrack = document.createElement('div');
      fileTrack.className = 'recording-detail-progress';
      fileTrack.style.height = '5px';
      fileTrack.style.margin = '0';
      const fileFill = document.createElement('span');
      fileFill.style.width = `${complete ? 100 : percent}%`;
      fileTrack.appendChild(fileFill);
      item.append(head, fileTrack);
      files.appendChild(item);
    }
    content.append(title, meta, progress, track, eyebrow, files);
    const footer = document.createElement('footer');
    footer.className = 'recording-detail-footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'Cancel upload';
    cancel.disabled = job.status !== 'uploading';
    cancel.addEventListener('click', () => void this.cancelDetailUpload(job, cancel));
    footer.appendChild(cancel);
    content.appendChild(footer);
  }

  private detailDriveLink(): string | undefined {
    if (this.detailTarget?.kind === 'upload') {
      return this.detailTarget.job.folderWebViewLink ?? this.detailTarget.job.files.find((file) => file.webViewLink)?.webViewLink;
    }
    return this.detailTarget?.entry.files.find((file) => file.destination === 'drive' && file.webViewLink)?.webViewLink;
  }

  /** Once the background finalizes a job, replace its progress view with durable history. */
  private async promoteCompletedDetailUpload(job: UploadJob): Promise<void> {
    try {
      const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY' });
      const entry = response.ok ? response.entries.find((candidate) => candidate.id === job.historyId) : undefined;
      if (entry && this.detailTarget?.kind === 'upload' && this.detailTarget.job.id === job.id) {
        this.detailTarget = { kind: 'recording', entry };
        this.renderRecordingDetail();
        return;
      }
    } catch {
      // The progress detail remains usable until history is available on the next refresh.
    }
    if (this.detailTarget?.kind === 'upload' && this.detailTarget.job.id === job.id) {
      this.detailTarget = { kind: 'upload', job };
      this.renderRecordingDetail();
    }
  }

  private async openDetailFile(entry: RecordingHistoryEntry, file: RecordingHistoryEntry['files'][number]): Promise<void> {
    if (file.destination === 'drive' && file.webViewLink) {
      await createExternalTab(file.webViewLink);
      return;
    }
    if (file.destination === 'local' && file.downloadId && file.status === 'available') {
      const response = await sendToBackground({ type: 'OPEN_RECORDING_HISTORY_FILE', recordingId: entry.id, fileId: file.id });
      if (response.ok === false) this.toast(response.error || 'Could not open the local file');
    }
  }

  private async copyDetailDriveLink(): Promise<void> {
    const link = this.detailDriveLink();
    if (!link) {
      this.toast('No Google Drive link is available yet.');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
      else {
        const input = document.createElement('textarea');
        input.value = link;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      this.toast('Google Drive link copied.');
    } catch {
      this.toast('Could not copy the Google Drive link.');
    }
  }

  private async startDetailRename(): Promise<void> {
    if (this.detailTarget?.kind !== 'recording') return;
    this.closeRecordingDetailMenu();
    const target = this.detailTarget;
    await this.recordingNameDialog.ask({
      title: 'Name this recording',
      message: target.entry.storageMode === 'drive'
        ? 'The recording folder and every uploaded media file will use this name.'
        : 'This changes the name shown in recording history.',
      initialValue: target.entry.name,
      saveLabel: 'Save name',
      cancelLabel: 'Cancel',
      onSave: async (name) => {
        if (name === target.entry.name) return;
        const entry = await this.renameRecording(target.entry.id, name);
        if (entry) this.detailTarget = { kind: 'recording', entry };
        this.renderRecordingDetail();
      },
    });
  }

  /** Schedules naming after the current session render, avoiding recursive tab selection. */
  private queueCompletedNamingPrompt(phase: RecordingPhase, session?: RecordingStatusView): void {
    if (this.previewing || this.destroyed) return;
    queueMicrotask(() => void this.openNextCompletedNamingPrompt(phase, session));
  }

  private async openNextCompletedNamingPrompt(phase: RecordingPhase, session?: RecordingStatusView): Promise<void> {
    if (this.previewing || this.destroyed || this.namingJobId || this.recordingNameDialog.isOpen()) return;
    if (phase === 'starting' || phase === 'recording' || phase === 'stopping') return;
    const job = [...(session?.uploadJobs ?? [])]
      .filter((candidate) => candidate.status === 'completed' && candidate.namingStatus === 'pending' && !!candidate.historyId)
      .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt))[0];
    if (!job?.historyId) return;

    this.namingJobId = job.id;
    this.sessionTabs.select(job.id);
    try {
      const outcome = await this.recordingNameDialog.ask({
        title: 'Name this recording',
        message: 'The recording folder and every uploaded media file will use this name.',
        initialValue: job.label,
        saveLabel: 'Save name',
        cancelLabel: 'Skip',
        onSave: async (name) => { await this.renameRecording(job.historyId!, name); },
      });
      if (outcome === 'canceled') {
        const response = await sendToBackground({ type: 'SKIP_RECORDING_NAMING', jobId: job.id });
        if (response.ok === false) throw new Error(response.error || 'Could not skip recording naming');
        if (response.session) this.state.applySession(response.session);
      }
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'Could not update recording name');
    } finally {
      this.namingJobId = null;
      this.queueCompletedNamingPrompt(this.lastPhase, this.lastSession);
    }
  }

  private async renameRecording(id: string, name: string): Promise<RecordingHistoryEntry | undefined> {
    const response = await sendToBackground({ type: 'RENAME_RECORDING_HISTORY', id, name });
    if (response.ok === false) throw new Error(response.error || 'Could not rename this recording');
    if (response.session) this.state.applySession(response.session);
    return response.entry;
  }

  private async deleteDetailRecording(): Promise<void> {
    const target = this.detailTarget;
    if (target?.kind !== 'recording' || this.confirmDialog.isOpen()) return;
    this.closeRecordingDetailMenu();
    const confirmed = await this.confirmDialog.ask({
      title: 'Delete this recording?',
      message: 'This removes it from Recordings. Files already saved to Google Drive or your computer are not deleted.',
      confirmLabel: 'Delete recording',
      cancelLabel: 'Keep recording',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const response = await sendToBackground({ type: 'REMOVE_RECORDING_HISTORY', id: target.entry.id });
      if (response.ok === false || !response.removed) {
        this.toast(response.ok === false ? response.error || 'Could not delete this recording' : 'Could not delete this recording');
        return;
      }
      await this.showRecordingsView();
      void this.refreshRecordingsCount();
    } catch {
      this.toast('Could not delete this recording');
    }
  }

  private async cancelDetailUpload(job: UploadJob, button: HTMLButtonElement): Promise<void> {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const response = await sendToBackground({ type: 'CANCEL_UPLOAD_JOB', jobId: job.id });
      if (response.ok === false) {
        button.disabled = false;
        this.toast(response.error || 'This upload is no longer active');
        return;
      }
      this.toast('Canceling upload — downloading locally…');
    } catch {
      button.disabled = false;
      this.toast('Could not cancel this upload');
    }
  }

  private renderPopupRecording(entry: RecordingHistoryEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'popup-recording-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Open ${entry.name}`);
    const openDetail = () => this.showRecordingDetail({ kind: 'recording', entry });
    row.addEventListener('click', openDetail);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(); }
    });
    const copy = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'popup-recording-title';
    title.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'popup-recording-meta';
    meta.textContent = `${entry.files.length} ${entry.files.length === 1 ? 'FILE' : 'FILES'} · ${new Date(entry.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()}`;
    copy.append(title, meta);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'popup-recording-open';
    open.setAttribute('aria-label', `Open ${entry.name}`);
    // This is the supplied design's source icon, kept as a real SVG control rather
    // than the word “Open”, so popup history rows retain their compact 52px rhythm.
    open.innerHTML = DETAIL_OPEN_ICON;
    open.addEventListener('click', (event) => { event.stopPropagation(); openDetail(); });
    row.append(copy, open);
    return row;
  }

  /** Active uploads are first-class entries in the compact Recordings list. */
  private renderPopupUpload(job: UploadJob): HTMLElement {
    const row = document.createElement('div');
    row.className = 'popup-recording-upload';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Open upload ${job.label}`);
    const openDetail = () => this.showRecordingDetail({ kind: 'upload', job });
    row.addEventListener('click', openDetail);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(); }
    });
    const head = document.createElement('div');
    head.className = 'popup-recording-upload-head';
    const title = document.createElement('span');
    title.textContent = job.label;
    const status = document.createElement('span');
    const percent = detailPercent(job.progress);
    status.textContent = `UPLOADING ${percent}%`;
    head.append(title, status);
    const track = document.createElement('div');
    track.className = 'popup-recording-upload-track';
    const fill = document.createElement('span');
    fill.style.width = `${percent}%`;
    track.append(fill);
    row.append(head, track);
    return row;
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
   * Discard destroys captured media with no undo, so it is gated behind an
   * in-popup confirmation. The prompt runs *before* executeCommand takes the
   * in-flight lock: a cancelled prompt must leave the popup exactly as it was,
   * with the recording still running and every control still live.
   */
  private wireDiscard() {
    const discardBtn = this.el.discardBtn;
    if (!discardBtn) return;
    discardBtn.addEventListener('click', async () => {
      if (this.confirmDialog.isOpen()) return;
      const menu = document.getElementById('popup-menu');
      const menuButton = document.getElementById('open-menu');
      if (menu) menu.hidden = true;
      menuButton?.setAttribute('aria-expanded', 'false');
      const message = () => buildDiscardConfirmMessage(this.el.recTimer?.textContent ?? undefined);
      const confirmation = this.confirmDialog.ask({
        title: DISCARD_CONFIRM_TEXT.title,
        message: message(),
        confirmLabel: DISCARD_CONFIRM_TEXT.confirmLabel,
        cancelLabel: DISCARD_CONFIRM_TEXT.cancelLabel,
        tone: 'danger',
      });
      // Recording continues behind the prompt; keep the amount to be discarded
      // truthful as the popup's live timer advances.
      const messageTimer = setInterval(() => this.confirmDialog.updateMessage(message()), 1_000);
      const confirmed = await confirmation;
      clearInterval(messageTimer);
      if (!confirmed) return;

      // A recording can become visible a few milliseconds before the start RPC
      // settles. Keep Discard responsive in that gap and then serialize the actual
      // destructive command behind the start command instead of dropping the click.
      const deadline = Date.now() + 3_000;
      while (this.inFlight && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      if (this.inFlight) {
        this.toast('Recording is still starting. Please try Discard again.');
        return;
      }

      await this.executeCommand(
        discardBtn,
        'DISCARD_RECORDING',
        () => this.discardRecording(),
        buildDiscardErrorAlert
      );
    });
  }

  /**
   * Shared scaffolding for start/stop button handlers: guards against concurrent
   * commands and disables the button while the action is in-flight. A failed
   * start returns to setup; failed stop/discard commands re-read authoritative
   * background state because capture may still be active.
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
      if (label === 'START_RECORDING') this.onPhaseChange('idle');
      else await this.state.refreshInitialState();
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
      const cameraState = await this.camera.queryCameraPermissionState();
      if (cameraState !== 'granted') {
        await this.showPermissionView({ tabId: tab.id, runConfig }, cameraState);
        return;
      }
    }

    await this.beginRecording(tab.id, runConfig);
  }

  private async beginRecording(tabId: number, runConfig: RecordingRunConfig): Promise<void> {
    const resp = await sendToBackground({ type: 'START_RECORDING', tabId, runConfig });
    if (resp.ok === false) throw new Error(resp.error || 'Failed to start');

    this.state.applySession(resp.session);
    this.toast(POPUP_TOAST_TEXT.recordingStarted);
  }

  private wirePermissionInterstitial(): void {
    this.el.grantPermissionBtn?.addEventListener('click', () => void this.grantCameraAndStart());
    this.el.permissionContinueBtn?.addEventListener('click', () => void this.continueWithoutCamera());
  }

  private async showPermissionView(
    pending: PendingPermissionStart,
    cameraState?: PermissionQueryState
  ): Promise<void> {
    this.pendingPermissionStart = pending;
    const [micState, resolvedCameraState] = await Promise.all([
      this.mic.queryMicPermissionState().catch(() => 'unknown' as const),
      cameraState ? Promise.resolve(cameraState) : this.camera.queryCameraPermissionState().catch(() => 'unknown' as const),
    ]);
    this.renderPermissionView(micState, resolvedCameraState);
  }

  /** Shared permission renderer for real permission queries and preview fixtures. */
  private renderPermissionView(micState: PermissionQueryState, cameraState: PermissionQueryState): void {
    if (this.el.viewConfig) this.el.viewConfig.hidden = true;
    if (this.el.viewPermission) this.el.viewPermission.hidden = false;
    if (this.el.viewRecording) this.el.viewRecording.hidden = true;
    if (this.el.viewFinalizing) this.el.viewFinalizing.hidden = true;
    if (this.el.viewUpload) this.el.viewUpload.hidden = true;
    if (this.el.startBtn) this.el.startBtn.disabled = false;

    if (this.el.permissionCopy) {
      this.el.permissionCopy.textContent = '';
    }

    this.renderPermissionState('mic', micState);
    this.renderPermissionState('camera', cameraState);
    const blocked = micState === 'denied' || cameraState === 'denied';
    this.el.viewPermission?.classList.toggle('permission-blocked', blocked);
    this.el.ppHeader?.classList.toggle('permission-blocked', blocked);
    const title = document.getElementById('permission-title');
    const detail = document.getElementById('permission-detail');
    if (title) title.textContent = blocked ? 'Mic & camera blocked' : 'Allow mic & camera';
    if (detail) detail.textContent = blocked
      ? 'The browser is denying access on this site.'
      : 'Meet Recorder needs access to capture this tab. Your browser will ask once.';
    if (this.el.permissionCopy) this.el.permissionCopy.textContent = blocked
      ? 'Click the lock icon in the address bar → allow Microphone and Camera → reload.'
      : '';
    if (this.el.grantPermissionBtn) this.el.grantPermissionBtn.textContent = blocked ? 'Open site settings' : 'Allow access';
    if (this.el.permissionContinueBtn) this.el.permissionContinueBtn.textContent = blocked ? 'Try again' : 'Not now';
  }

  private renderPermissionState(kind: 'mic' | 'camera', state: PermissionQueryState): void {
    const el = kind === 'mic' ? this.el.permMicState : this.el.permCameraState;
    if (!el) return;
    const granted = state === 'granted';
    el.textContent = granted ? 'Granted' : state === 'denied' ? 'Blocked' : 'Needed';
    el.classList.toggle('ready', granted);
    el.classList.toggle('warn', !granted);

    const icon = this.el.viewPermission?.querySelector<HTMLElement>(
      kind === 'mic' ? '[data-perm-mic-icon]' : '[data-perm-camera-icon]'
    );
    icon?.classList.toggle('ready', granted);
    icon?.classList.toggle('warn', !granted);
  }

  private async grantCameraAndStart(): Promise<void> {
    const pending = this.pendingPermissionStart;
    if (!pending || this.inFlight) return;
    this.inFlight = true;
    if (this.el.grantPermissionBtn) this.el.grantPermissionBtn.disabled = true;
    if (this.el.permissionContinueBtn) this.el.permissionContinueBtn.disabled = true;

    try {
      const ok = await this.camera.ensureReadyForRecording();
      if (!ok) {
        await this.showPermissionView(pending);
        this.toast(CAMERA_PERMISSION_ERROR);
        return;
      }
      await this.beginRecording(pending.tabId, pending.runConfig);
      this.pendingPermissionStart = null;
    } catch (e: unknown) {
      console.error('[popup] START_RECORDING error', e);
      this.onPhaseChange('idle');
      alert(buildStartErrorAlert(e));
    } finally {
      this.inFlight = false;
      if (this.el.grantPermissionBtn) this.el.grantPermissionBtn.disabled = false;
      if (this.el.permissionContinueBtn) this.el.permissionContinueBtn.disabled = false;
    }
  }

  private async continueWithoutCamera(): Promise<void> {
    const pending = this.pendingPermissionStart;
    if (!pending || this.inFlight) return;
    this.inFlight = true;
    if (this.el.grantPermissionBtn) this.el.grantPermissionBtn.disabled = true;
    if (this.el.permissionContinueBtn) this.el.permissionContinueBtn.disabled = true;

    try {
      const runConfig = { ...pending.runConfig, recordSelfVideo: false };
      await this.beginRecording(pending.tabId, runConfig);
      this.pendingPermissionStart = null;
    } catch (e: unknown) {
      console.error('[popup] START_RECORDING error', e);
      this.onPhaseChange('idle');
      alert(buildStartErrorAlert(e));
    } finally {
      this.inFlight = false;
      if (this.el.grantPermissionBtn) this.el.grantPermissionBtn.disabled = false;
      if (this.el.permissionContinueBtn) this.el.permissionContinueBtn.disabled = false;
    }
  }

  private async stopRecording(): Promise<void> {
    const resp = await sendToBackground({ type: 'STOP_RECORDING' });
    if (resp.ok === false) throw new Error(resp.error || 'Failed to stop');
    this.state.applySession(resp.session);
    this.toast(POPUP_TOAST_TEXT.stopping);
  }

  /** Discards both media artifacts and the live caption buffer for this meeting tab. */
  private async discardRecording(): Promise<void> {
    const tab = await queryActiveTab();
    const resp = await sendToBackground({ type: 'DISCARD_RECORDING' });
    if (resp.ok === false) throw new Error(resp.error || 'Failed to discard recording');

    // Captions are recording content too. Reset is best-effort because capture is
    // already being discarded by the background and the tab could close mid-click.
    if (tab?.id) await sendToContent(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {});
    this.state.applySession(resp.session);
    this.toast('Discarding recording and deleting captured media…');
  }
}
