/**
 * @file popup/popupView.ts
 *
 * Pure DOM-focused helpers for syncing popup controls with recording state.
 */

import { isBusyPhase, type RecordingPhase } from '../shared/recording';

export type PopupElements = {
  saveBtn: HTMLButtonElement | null;
  micBtn: HTMLButtonElement | null;
  micModeSelect: HTMLSelectElement | null;
  startBtn: HTMLButtonElement | null;
  stopBtn: HTMLButtonElement | null;
  storageModeSelect: HTMLSelectElement | null;
  recordSelfVideoCheckbox: HTMLInputElement | null;
  openDiagnosticsBtn: HTMLButtonElement | null;
  recordingStatusEl: HTMLElement | null;
};

export function setControlsForPhase(elements: PopupElements, phase: RecordingPhase): void {
  const {
    startBtn,
    stopBtn,
    micModeSelect,
    storageModeSelect,
    recordSelfVideoCheckbox,
  } = elements;

  if (!startBtn || !stopBtn) return;

  const busy = isBusyPhase(phase);
  startBtn.disabled = busy;
  stopBtn.disabled = !(phase === 'starting' || phase === 'recording' || phase === 'stopping');

  if (micModeSelect) micModeSelect.disabled = busy;
  if (storageModeSelect) storageModeSelect.disabled = busy;
  if (recordSelfVideoCheckbox) recordSelfVideoCheckbox.disabled = busy;
}

export function setStatusText(elements: PopupElements, text: string): void {
  if (elements.recordingStatusEl) {
    elements.recordingStatusEl.textContent = text;
  }
}
