/**
 * @file popup/popupView.ts
 *
 * Pure DOM-focused helpers for syncing popup controls with recording state.
 */

import type { RecordingNotesElements } from './RecordingNotesView';
import type { RecordingPhase } from '../shared/recording';

/** Which top-level popup layout a phase maps to. */
export type PopupView = 'config' | 'recording' | 'finalizing' | 'interrupted';

export type PopupElements = {
  // Header + config view
  saveBtn: HTMLButtonElement | null;
  micBtn: HTMLButtonElement | null;
  micModeSelect: HTMLSelectElement | null;
  startBtn: HTMLButtonElement | null;
  storageModeSelect: HTMLSelectElement | null;
  recordSelfVideoCheckbox: HTMLInputElement | null;
  /** Container of the tab-content-type segmented radio group (screen/video). */
  tabContentTypeGroup: HTMLElement | null;
  openSettingsBtn: HTMLButtonElement | null;
  openRecordingsBtn: HTMLButtonElement | null;
  openDiagnosticsBtn: HTMLButtonElement | null;
  /** The persistent wordmark header; gets `.compact` on every non-idle screen. */
  ppHeader: HTMLElement | null;

  // View containers
  viewConfig: HTMLElement | null;
  viewPermission: HTMLElement | null;
  viewRecording: HTMLElement | null;
  viewFinalizing: HTMLElement | null;
  viewInterrupted: HTMLElement | null;
  interruptedTitle: HTMLElement | null;
  interruptedSub: HTMLElement | null;
  interruptedRibbon: HTMLElement | null;
  interruptedTrack: HTMLElement | null;
  interruptedNotes: HTMLElement | null;
  interruptedCount: HTMLElement | null;
  interruptedList: HTMLElement | null;
  interruptedDiscard: HTMLButtonElement | null;
  interruptedDone: HTMLButtonElement | null;

  // Permission interstitial
  permMicState: HTMLElement | null;
  permCameraState: HTMLElement | null;
  permissionCopy: HTMLElement | null;
  grantPermissionBtn: HTMLButtonElement | null;
  permissionContinueBtn: HTMLButtonElement | null;

  // Recording view
  recBanner: HTMLElement | null;
  recLabel: HTMLElement | null;
  recTimer: HTMLElement | null;
  /** Live notes UI (ADR-0005); grouped so RecordingNotesView owns its own surface. */
  notes: RecordingNotesElements;
  chipTranscript: HTMLElement | null;
  chipTranscriptLabel: HTMLElement | null;
  chipStorage: HTMLElement | null;
  chipStorageLabel: HTMLElement | null;
  micRow: HTMLElement | null;
  micModeLabel: HTMLElement | null;
  micDeviceLabel: HTMLElement | null;
  micDeviceTrigger: HTMLButtonElement | null;
  muteMicBtn: HTMLButtonElement | null;
  cameraRow: HTMLElement | null;
  cameraDeviceLabel: HTMLElement | null;
  cameraDeviceTrigger: HTMLButtonElement | null;
  hideCameraBtn: HTMLButtonElement | null;
  devicePicker: HTMLElement | null;
  devicePickerTitle: HTMLElement | null;
  devicePickerList: HTMLElement | null;
  devicePickerError: HTMLElement | null;
  devicePickerTrack: HTMLElement | null;
  devicePickerMode: HTMLElement | null;
  devicePickerClose: HTMLButtonElement | null;
  pauseBtn: HTMLButtonElement | null;
  stopBtn: HTMLButtonElement | null;
  /** Destructive active-recording action; optional for lightweight view tests. */
  discardBtn?: HTMLButtonElement | null;

  // Finalizing view
  finalizingLabel: HTMLElement | null;
  finalizingSub: HTMLElement | null;
  finalizingFiles: HTMLElement | null;
  /** Progress-ring container; its `data-mode` toggles determinate vs. indeterminate. */
  uploadRing: HTMLElement | null;
  /** The ring's foreground arc; its `stroke-dashoffset` encodes the upload fraction. */
  uploadRingArc: HTMLElement | null;
  /** Centered percentage label, shown only while a Drive upload reports progress. */
  uploadRingLabel: HTMLElement | null;
  metaStorage: HTMLElement | null;
  metaDuration: HTMLElement | null;
  metaMic: HTMLElement | null;
  metaCamera: HTMLElement | null;

  // Session tabs + per-job upload view (ADR-0004)
  /** Tab bar populated with the live tab + one tab per background upload job. */
  sessionTabs: HTMLElement | null;
  viewUpload: HTMLElement | null;
  /** In-progress block (linear bar); hidden once the job completes. */
  uploadProgress: HTMLElement | null;
  /** Done block (saved confirmation); shown only for a completed job. */
  uploadDone: HTMLElement | null;
  uploadJobLabel: HTMLElement | null;
  uploadJobPct: HTMLElement | null;
  /** The linear progress bar's fill; its `width` encodes the upload fraction. */
  uploadBarFill: HTMLElement | null;
  /** Aggregate "N of M files · <size>" line under the bar. */
  uploadJobMeta: HTMLElement | null;
  uploadJobSub: HTMLElement | null;
  uploadJobFiles: HTMLElement | null;
  uploadJobNotes: HTMLElement | null;
  uploadJobNotesLine: HTMLElement | null;
  uploadJobNotesState: HTMLElement | null;
  /** Opens the completed job's Google Drive folder when Drive returned one. */
  uploadJobOpenDrive: HTMLButtonElement | null;
  /** "Retry upload" CTA, shown only for a failed/partial job. */
  uploadJobRetry: HTMLButtonElement | null;
  /** Cancels an in-progress Drive upload and downloads unfinished files. */
  uploadJobCancel: HTMLButtonElement | null;
  cameraWarning: HTMLElement | null;
  cameraWarningText: HTMLElement | null;
  tabSourceSub: HTMLElement | null;

};

/** Maps a recording phase to the top-level view it should display. */
export function viewForPhase(phase: RecordingPhase, interrupted = false): PopupView {
  if (phase === 'starting' || phase === 'recording') return 'recording';
  if (phase === 'stopping') return 'finalizing';
  // The capture is saved by now; this reports what happened to it (n4).
  if (interrupted) return 'interrupted';
  return 'config'; // idle, failed
}

/** Shows the single view that matches the current phase and hides the others. */
export function setActiveView(elements: PopupElements, phase: RecordingPhase, interrupted = false): PopupView {
  const view = viewForPhase(phase, interrupted);
  if (elements.viewConfig) elements.viewConfig.hidden = view !== 'config';
  if (elements.viewPermission) elements.viewPermission.hidden = true;
  if (elements.viewRecording) elements.viewRecording.hidden = view !== 'recording';
  if (elements.viewFinalizing) elements.viewFinalizing.hidden = view !== 'finalizing';
  if (elements.viewInterrupted) elements.viewInterrupted.hidden = view !== 'interrupted';
  return view;
}
