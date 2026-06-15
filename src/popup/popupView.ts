/**
 * @file popup/popupView.ts
 *
 * Pure DOM-focused helpers for syncing popup controls with recording state.
 */

import type { RecordingPhase } from '../shared/recording';

/** Which top-level popup layout a phase maps to. */
export type PopupView = 'config' | 'recording' | 'finalizing';

export type PopupElements = {
  // Header + config view
  saveBtn: HTMLButtonElement | null;
  micBtn: HTMLButtonElement | null;
  micModeSelect: HTMLSelectElement | null;
  startBtn: HTMLButtonElement | null;
  storageModeSelect: HTMLSelectElement | null;
  recordSelfVideoCheckbox: HTMLInputElement | null;
  openSettingsBtn: HTMLButtonElement | null;
  openDiagnosticsBtn: HTMLButtonElement | null;

  // View containers
  viewConfig: HTMLElement | null;
  viewRecording: HTMLElement | null;
  viewFinalizing: HTMLElement | null;

  // Recording view
  recBanner: HTMLElement | null;
  recLabel: HTMLElement | null;
  recTimer: HTMLElement | null;
  chipTranscript: HTMLElement | null;
  chipTranscriptLabel: HTMLElement | null;
  chipStorage: HTMLElement | null;
  chipStorageLabel: HTMLElement | null;
  micRow: HTMLElement | null;
  micModeLabel: HTMLElement | null;
  muteMicBtn: HTMLButtonElement | null;
  cameraRow: HTMLElement | null;
  hideCameraBtn: HTMLButtonElement | null;
  pauseBtn: HTMLButtonElement | null;
  stopBtn: HTMLButtonElement | null;

  // Finalizing view
  finalizingLabel: HTMLElement | null;
  metaStorage: HTMLElement | null;
  metaDuration: HTMLElement | null;
  metaMic: HTMLElement | null;
  metaCamera: HTMLElement | null;

  // Shared status / toast line
  recordingStatusEl: HTMLElement | null;
};

/** Maps a recording phase to the top-level view it should display. */
export function viewForPhase(phase: RecordingPhase): PopupView {
  if (phase === 'starting' || phase === 'recording') return 'recording';
  if (phase === 'stopping' || phase === 'uploading') return 'finalizing';
  return 'config'; // idle, failed
}

/** Shows the single view that matches the current phase and hides the others. */
export function setActiveView(elements: PopupElements, phase: RecordingPhase): PopupView {
  const view = viewForPhase(phase);
  if (elements.viewConfig) elements.viewConfig.hidden = view !== 'config';
  if (elements.viewRecording) elements.viewRecording.hidden = view !== 'recording';
  if (elements.viewFinalizing) elements.viewFinalizing.hidden = view !== 'finalizing';
  return view;
}

/** Replaces the popup status line with the latest human-readable status text. */
export function setStatusText(elements: PopupElements, text: string): void {
  if (elements.recordingStatusEl) {
    elements.recordingStatusEl.textContent = text;
  }
}
