/**
 * @file popup/PopupController.ts
 *
 * Stateful popup controller. The popup is intentionally thin and disposable:
 * it initiates actions, reflects current recording/uploading state, and can be
 * closed/reopened at any time without owning the recording lifecycle.
 */

import { CameraPermissionService } from './recording/CameraPermissionService';
import { CaptionPoller } from './recording/CaptionPoller';
import { ConfirmDialog } from './ConfirmDialog';
import { MicPermissionService } from './recording/MicPermissionService';
import { RecordingTimer } from './recording/RecordingTimer';
import { DevicePickerView } from './recording/DevicePickerView';
import { RecordingNotesView } from './notes/RecordingNotesView';
import { RecordingNotesDetail } from './notes/RecordingNotesDetail';
import { RecordingDetailView, type PopupDetailTarget } from './history/RecordingDetailView';
import { RecordingsListView } from './history/RecordingsListView';
import { InterruptedView } from './recording/InterruptedView';
import { PermissionView } from './recording/PermissionView';
import { RecordingControlsView } from './recording/RecordingControlsView';
import { PopupStatusView } from './recording/PopupStatusView';
import { PopupNotations } from './notes/PopupNotations';
import { CompletedNamingPrompt } from './history/CompletedNamingPrompt';
import { RecordingCommands } from './recording/RecordingCommands';
import { wireTranscriptDownload } from './transcriptDownload';
import { RecordingNameDialog } from './RecordingNameDialog';
import type { DriveFolderPreset } from '../shared/settings';
import { SessionTabsView } from './history/SessionTabsView';
import { PopupStateController } from './controllers/PopupStateController';
import type {
  PopupPreviewState,
} from './popupPreviewState';
import {
  buildLocalSaveFailedAlert,
  buildLocalSaveFailedToast,
  buildSavedLocallyMessage,
  POPUP_TOAST_TEXT,
} from './popupMessages';
import { setActiveView, type PopupElements } from './popupView';
import { createRuntimeTab } from '../platform/chrome/tabs';
import { sendToBackground } from '../shared/messages';
import type {
  BgToPopup,
} from '../shared/protocol';
import { isDevBuild, isTestRuntime } from '../shared/build';
import type {
  RecordingPhase,
  RecordingStatusView,
} from '../shared/recording';
import type { RecordingHistoryEntry } from '../shared/recordingHistory';

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
  private readonly notes: RecordingNotesView;
  /** The recording whose saved-screen notes are already mounted. */
  private mountedSavedNotesFor: string | null = null;
  private readonly captionPoller: CaptionPoller;
  private readonly sessionTabs: SessionTabsView;
  private readonly devicePicker: DevicePickerView;
  private readonly commands: RecordingCommands;
  private readonly naming: CompletedNamingPrompt;
  private readonly notations: PopupNotations;
  private readonly status: PopupStatusView;
  private readonly controls: RecordingControlsView;
  private readonly interrupted: InterruptedView;
  private readonly permissionView: PermissionView;
  private readonly detail: RecordingDetailView;
  private readonly recordingsList: RecordingsListView;
  private readonly confirmDialog = new ConfirmDialog();
  private readonly recordingNameDialog = new RecordingNameDialog();
  private destroyed = false;
  /** A local history screen must not be overwritten by the async initial state refresh. */
  private showingRecordings = false;
  /** Last phase/session, replayed when a tab is clicked without a new background push. */
  private lastPhase: RecordingPhase = 'idle';
  private lastSession?: RecordingStatusView;
  /** Preview rendering must never start Chrome polling or live UI timers. */
  private previewing = false;
  /** Drive destinations offered when naming; empty until settings load. */
  private destinations: DriveFolderPreset[] = [];
  /** Download sub-folders offered when naming a local recording. */
  private localFolders: DriveFolderPreset[] = [];
  /** Local recordings whose bytes are retained but not yet written to Downloads. */
  private pendingLocal: { id: string; name: string }[] = [];

  constructor(el: PopupElements) {
    this.el = el;
    this.timer = new RecordingTimer(el.recTimer);
    this.naming = new CompletedNamingPrompt(this.recordingNameDialog, {
      notify: (message) => this.toast(message),
      rename: (historyId, name) => this.renameRecording(historyId, name),
      destinations: () => this.destinations,
      fileTo: (historyId, presetId) => this.fileRecordingToDestination(historyId, presetId),
      localFolders: () => this.localFolders,
      pendingLocal: () => this.pendingLocal,
      deliverLocal: (historyId, folderId) => this.deliverLocalRecording(historyId, folderId),
      applySession: (session) => this.state.applySession(session),
      reveal: (jobId) => this.sessionTabs.select(jobId),
      latest: () => ({ phase: this.lastPhase, session: this.lastSession }),
      suspended: () => this.previewing || this.destroyed,
    });
    this.notations = new PopupNotations({
      notify: (message) => this.toast(message),
      onActiveChanged: (notations) => this.notes.setNotations(notations),
    });
    this.notes = new RecordingNotesView(el.notes, {
      mark: () => this.notations.mark(),
      end: (id) => this.notations.end(id),
      save: (id, text) => this.notations.save(id, text),
      remove: (id) => this.notations.remove(id),
    });
    this.captionPoller = new CaptionPoller(el.chipTranscriptLabel, el.chipTranscript);
    this.devicePicker = new DevicePickerView(el, {
      select: async (device, deviceId) => {
        const response = await sendToBackground({ type: 'SET_INPUT_DEVICE', device, deviceId });
        if (response.ok === false) throw new Error(response.error || `Failed to change ${device}`);
        this.state.applySession(response.session);
        return response.session.capturedDevices?.[device];
      },
      notify: (message) => this.toast(message),
    });
    this.state = new PopupStateController(el, {
      onPhaseChange: (phase, session) => this.onPhaseChange(phase, session),
      onSettings: (settings) => {
        this.destinations = settings.storage.driveFolderPresets;
        this.localFolders = settings.storage.localFolderPresets;
      },
      onToast: (msg) => this.toast(msg),
      onAlert: (msg) => alert(msg),
    });
    this.detail = new RecordingDetailView({
      back: () => this.showRecordingsView(),
      notify: (message) => this.toast(message),
      rename: (id, name) => this.renameRecording(id, name),
      notes: () => this.notations.detailActions(),
      onRemoved: () => void this.recordingsList.refreshCount(),
    }, this.confirmDialog, this.recordingNameDialog);
    this.status = new PopupStatusView(el);
    this.controls = new RecordingControlsView(el, {
      setMicMuted: (muted) => sendToBackground({ type: 'SET_MIC_MUTED', muted }),
      setCameraMuted: (muted) => sendToBackground({ type: 'SET_CAMERA_MUTED', muted }),
      setPaused: (paused) => sendToBackground({ type: 'SET_PAUSED', paused }),
      applySession: (session) => this.state.applySession(session),
      notify: (message) => this.toast(message),
      text: POPUP_TOAST_TEXT,
    });
    this.permissionView = new PermissionView(el, {
      grant: () => this.commands.grantCameraAndStart(),
      skip: () => this.commands.continueWithoutCamera(),
    });
    this.commands = new RecordingCommands(el, {
      notify: (message) => this.toast(message),
      applySession: (session) => this.state.applySession(session),
      runConfigFromForm: () => this.state.getRunConfigFromForm(),
      resetToIdle: () => this.onPhaseChange('idle'),
      refreshSession: () => this.state.refreshInitialState(),
      activeNotations: () => this.notations.activeNotations,
    }, this.mic, this.camera, this.permissionView, this.confirmDialog);
    this.interrupted = new InterruptedView(el, {
      dismiss: () => this.dismissInterruption(),
      discard: (historyId) => this.discardInterrupted(historyId),
      loadNotations: (recordingId) => this.notations.list(recordingId),
    });
    this.recordingsList = new RecordingsListView({
      openRecording: (entry) => this.showRecordingDetail({ kind: 'recording', entry }),
      openUpload: (job) => this.showRecordingDetail({ kind: 'upload', job }),
      loadNotations: (recordingId) => this.notations.list(recordingId),
      noteCounts: (entries) => this.notations.counts(entries),
      activeUploads: () => (this.lastSession?.uploadJobs ?? []).filter((job) => job.status === 'uploading'),
    });
    this.sessionTabs = new SessionTabsView(el, {
      rerender: () => this.onPhaseChange(this.lastPhase, this.lastSession),
      applySession: (session) => this.state.applySession(session),
      toast: (msg) => this.toast(msg),
      onJobRendered: (job) => this.mountSavedNotes(job),
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
    wireTranscriptDownload(this.el.saveBtn, (message) => this.toast(message));
    this.interrupted.wire();
    this.commands.wire();
    this.permissionView.wire();
    this.wireMic();
    this.controls.wire();
    this.devicePicker.wire();
    this.wireSettingsLink();
    this.wireRecordingsLink();
    this.wireUploadNavigation();
    this.detail.wire();
    this.wireDiagnosticsLink();
    document.getElementById('upload-job-transcript')?.addEventListener('click', () => this.el.saveBtn?.click());
    this.sessionTabs.wireEvents();
    void this.recordingsList.refreshCount();
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
    this.devicePicker.close(false);

    if (preview.screen === 'permission') {
      this.showingRecordings = false;
      this.detail.clear();
      this.permissionView.render(preview.microphone, preview.camera);
      return;
    }

    if (preview.screen === 'recording-detail') {
      this.showingRecordings = false;
      this.detail.clear();
      this.notations.usePreview(preview.notations ?? []);
      this.showRecordingDetail(preview.target);
      return;
    }

    if (preview.screen === 'recordings') {
      this.notations.usePreview(preview.notations ?? []);
      this.showingRecordings = false;
      this.detail.clear();
      const session = preview.session ?? { phase: 'idle' as const, runConfig: null, updatedAt: 0 };
      this.state.applyPreviewSession(session);
      this.showRecordingsViewWithEntries(preview.entries);
      return;
    }

    this.showingRecordings = false;
    this.detail.clear();
    // Set before applying the session: painting it mounts the saved-screen notes,
    // which read this fixture rather than the background.
    this.notations.usePreview(preview.notations ?? []);
    this.state.applyPreviewSession(preview.session);
    if (preview.selectedUploadJobId) this.sessionTabs.select(preview.selectedUploadJobId);
    this.renderPreviewTranscript(preview.transcriptActive === true);
    this.renderPreviewSetup(preview.setup);
    if (preview.devicePicker) this.devicePicker.showPreview(preview.devicePicker.device, preview.devicePicker.options);
  }

  /** Wires the controller-owned interactions that are safe inside a static preview. */
  wirePreviewInteractions(): void {
    this.detail.wireMenu();
    this.devicePicker.wireDismissal();
  }

  /** Clears transient timers when the popup is torn down. */
  destroy() {
    this.destroyed = true;
    this.timer.stop();
    this.captionPoller.stop();
    this.sessionTabs.dispose();
    this.confirmDialog.dispose();
    this.recordingNameDialog.dispose();
    this.devicePicker.close(false);
  }

  /**
   * Switches the popup to the view its phase maps to (config / recording /
   * finalizing) and populates that view. Live intervals (the recording timer and
   * the caption-state poll) run only while the recording view is active.
   */
  private onPhaseChange(phase: RecordingPhase, session?: RecordingStatusView) {
    this.lastPhase = phase;
    this.lastSession = session;
    this.devicePicker.sync(session);
    this.naming.queue(phase, session);
    writeCachedPhase(phase);
    this.status.syncUploadNavigation(session);
    // `showRecordingsView` awaits the history query. The initial status refresh can
    // resolve in that gap; retaining the explicit local view prevents setup and
    // history from rendering together (and makes the popup scroll under its footer).
    if (this.showingRecordings) {
      const open = this.detail.target;
      if (open?.kind === 'upload') {
        const current = session?.uploadJobs?.find((job) => job.id === open.job.id);
        if (current) this.detail.syncUploadJob(current);
      }
      return;
    }
    this.sessionTabs.sync(phase, session);
    if (this.el.discardBtn) this.el.discardBtn.hidden = phase !== 'starting' && phase !== 'recording';
    this.status.syncHeaderPhase(phase, session?.paused === true);

    // An upload tab is selected: show only that job's upload view and stop the
    // live-recording intervals (we're not on the recording view).
    const job = this.sessionTabs.activeJob(session);
    if (job) {
      this.devicePicker.close(false);
      this.timer.stop();
      this.notes.stop();
      this.captionPoller.stop();
      if (this.el.sessionTabs) this.el.sessionTabs.hidden = true;
      if (this.el.viewConfig) this.el.viewConfig.hidden = true;
      if (this.el.viewPermission) this.el.viewPermission.hidden = true;
      if (this.el.viewRecording) this.el.viewRecording.hidden = true;
      if (this.el.viewFinalizing) this.el.viewFinalizing.hidden = true;
      if (this.el.viewUpload) this.el.viewUpload.hidden = false;
      this.status.setHeaderCompact(true);
      this.status.syncHeaderUpload(job.status === 'completed');
      this.sessionTabs.renderJobView(job);
      return;
    }

    if (this.el.viewUpload) this.el.viewUpload.hidden = true;
    const view = setActiveView(this.el, phase, session?.interruption != null);
    this.status.setHeaderCompact(view !== 'config');

    if (view === 'interrupted') {
      this.timer.stop();
      this.notes.stop();
      this.captionPoller.stop();
      void this.interrupted.render(session?.interruption);
      return;
    }

    if (view === 'recording') {
      this.status.syncRecordingBanner(phase, session);
      this.status.syncTabSource(session);
      this.status.syncChips(session);
      this.controls.sync(phase, session);
      if (this.el.stopBtn) this.el.stopBtn.disabled = false;
      this.timer.sync(phase, session);
      this.notes.sync(phase, session);
      if (!this.previewing) void this.notations.refreshActive();
      if (this.previewing) this.captionPoller.stop();
      else this.captionPoller.start();
    } else {
      this.devicePicker.close(false);
      this.timer.stop();
      this.captionPoller.stop();
      // The recording this prompt refers to is gone (it stopped on its own, or
      // the tab closed); confirming it now would only produce a "no active
      // session" error, so retract the question.
      this.confirmDialog.dismiss();
      this.controls.reset();
      if (view === 'finalizing') this.status.syncFinalizing(session);
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

  private async dismissInterruption(): Promise<void> {
    try {
      const response = await sendToBackground({ type: 'DISMISS_INTERRUPTION' });
      this.state.applySession(response.session);
    } catch (error) {
      console.warn('[popup] DISMISS_INTERRUPTION failed', error);
    }
  }

  /**
   * Removes the recording the interruption produced. It was already saved, so
   * this is an ordinary delete rather than abandoning anything in flight.
   */
  private async discardInterrupted(historyId: string): Promise<void> {
    try {
      await sendToBackground({ type: 'REMOVE_RECORDING_HISTORY', id: historyId });
    } catch (error) {
      console.warn('[popup] REMOVE_RECORDING_HISTORY failed', error);
    }
    await this.dismissInterruption();
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
      if (msg?.type === 'RECORDING_AWAITING_DELIVERY') {
        // The bytes are safe in the library; the prompt decides where they land.
        void this.refreshPendingLocal().then(() => this.naming.queue(this.lastPhase, this.lastSession));
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

  /** Pushes the detail screen over whatever the popup is currently showing. */
  private showRecordingDetail(target: PopupDetailTarget): void {
    this.showingRecordings = true;
    if (this.el.sessionTabs) this.el.sessionTabs.hidden = true;
    if (this.el.ppHeader) this.el.ppHeader.hidden = true;
    for (const id of ['view-config', 'view-permission', 'view-recording', 'view-finalizing', 'view-upload', 'view-recordings']) {
      const view = document.getElementById(id);
      if (view) view.hidden = true;
    }
    if (!this.detail.show(target)) this.showingRecordings = false;
  }

  /** Reads history into the Recordings screen. */
  private async showRecordingsView(): Promise<void> {
    if (!this.enterRecordingsView()) return;
    await this.recordingsList.load();
  }

  /** Presents the production recordings layout before its data source is resolved. */
  private showRecordingsViewWithEntries(entries?: RecordingHistoryEntry[]): void {
    if (this.enterRecordingsView()) this.recordingsList.paintFrame(entries);
  }

  /** Hides every other screen and titles the header for the list. */
  private enterRecordingsView(): boolean {
    if (!document.getElementById('view-recordings')) return false;
    this.showingRecordings = true;
    this.detail.clear();
    const detail = document.getElementById('view-recording-detail');
    if (detail) detail.hidden = true;
    if (this.el.ppHeader) this.el.ppHeader.hidden = false;
    if (this.el.sessionTabs) this.el.sessionTabs.hidden = true;
    for (const id of ['view-config', 'view-permission', 'view-recording', 'view-finalizing', 'view-upload']) {
      const view = document.getElementById(id);
      if (view) view.hidden = true;
    }
    this.status.setHeaderCompact(false);
    const title = this.el.ppHeader?.querySelector<HTMLElement>('.brand-name');
    if (title) title.textContent = 'Recordings';
    return true;
  }

  /** Shared row renderer for production history responses and preview fixtures. */
  private hideRecordingsView(): void {
    const recordings = document.getElementById('view-recordings');
    if (recordings) recordings.hidden = true;
    const detail = document.getElementById('view-recording-detail');
    if (detail) detail.hidden = true;
    if (this.el.ppHeader) this.el.ppHeader.hidden = false;
    this.detail.clear();
    this.showingRecordings = false;
    const title = this.el.ppHeader?.querySelector<HTMLElement>('.brand-name');
    if (title) title.textContent = 'Meet Recorder';
    this.onPhaseChange(this.lastPhase, this.lastSession);
  }

  /** Schedules naming after the current session render, avoiding recursive tab selection. */
  private async renameRecording(id: string, name: string): Promise<RecordingHistoryEntry | undefined> {
    const response = await sendToBackground({ type: 'RENAME_RECORDING_HISTORY', id, name });
    if (response.ok === false) throw new Error(response.error || 'Could not rename this recording');
    if (response.session) this.state.applySession(response.session);
    return response.entry;
  }

  /**
   * Refreshes the queue of recordings still waiting to be written to Downloads.
   *
   * Driven by the background's broadcast rather than polled or fetched at open:
   * the popup is what you press stop in, so it is listening when a recording
   * starts waiting. One left over from a closed popup is delivered to the
   * download directory by the startup reconciler instead of being asked about.
   */
  private async refreshPendingLocal(): Promise<void> {
    try {
      const response = await sendToBackground({ type: 'LIST_PENDING_LOCAL_DELIVERIES' });
      this.pendingLocal = response.ok ? response.recordings : [];
    } catch {
      this.pendingLocal = [];
    }
  }

  private async deliverLocalRecording(recordingId: string, folderId: string | null): Promise<void> {
    const response = await sendToBackground({ type: 'DELIVER_LOCAL_RECORDING', recordingId, folderId });
    if (response.ok === false) throw new Error(response.error || 'Could not save this recording');
    this.pendingLocal = this.pendingLocal.filter((pending) => pending.id !== recordingId);
  }

  private async fileRecordingToDestination(recordingId: string, presetId: string): Promise<void> {
    const response = await sendToBackground({
      type: 'FILE_RECORDING_TO_DESTINATION', recordingId, presetId,
    });
    if (response.ok === false) throw new Error(response.error || 'Could not file this recording');
  }

  /**
   * Mounts the notes disclosure under the saved screen's file list (n2a → n2c),
   * once per recording so a re-render does not stack duplicates.
   *
   * Shown while the upload runs too: the sidecar row above reports that the
   * notes went up first, and this is still where they are read.
   */
  private mountSavedNotes(job: import('../shared/recording').UploadJob): void {
    const host = this.el.uploadJobNotes;
    if (!host || !job.historyId) return;
    if (this.mountedSavedNotesFor === job.historyId) return;
    this.mountedSavedNotesFor = job.historyId;
    host.replaceChildren();

    const notes = new RecordingNotesDetail(
      job.historyId,
      undefined,
      this.notations.detailActions(),
      { timeline: false, collapsible: true },
    );
    host.appendChild(notes.element);
    void notes.load().then(() => {
      // The subline is painted before the notes load, so extend it once they
      // arrive rather than re-rendering the whole panel.
      const count = Number(notes.element.querySelector('.detail-notes-count')?.textContent ?? 0);
      const sub = this.el.uploadJobSub;
      if (!count || !sub || sub.textContent?.includes('NOTE')) return;
      sub.textContent = `${sub.textContent} · ${count} ${count === 1 ? 'NOTE' : 'NOTES'}`;
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


}
