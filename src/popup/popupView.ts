/**
 * @file popup/popupView.ts
 *
 * Pure view helpers for syncing popup controls and status text with the
 * canonical recording session snapshot.
 */

import { isBusyPhase, type RecordingPhase, type RecordingRunConfig, type UploadSummary } from '../shared/recording';

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

export const STATUS_BY_PHASE: Record<Exclude<RecordingPhase, 'idle'>, string> = {
  starting: 'Starting recording...',
  recording: 'Recording in progress.',
  stopping: 'Stopping recording and sealing files...',
  uploading: 'Finalizing and saving files... you can close this popup.',
  failed: 'The last recording attempt failed.',
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

export function describeRunConfig(config: RecordingRunConfig | null): string {
  if (!config) return '';

  const mode = config.storageMode === 'drive' ? 'Mode: Drive.' : 'Mode: Local.';
  const mic =
    config.micMode === 'mixed'
      ? 'Microphone: Mixed into tab recording.'
      : config.micMode === 'separate'
        ? 'Microphone: Saved as a separate audio file.'
        : 'Microphone: Off.';
  const camera = config.recordSelfVideo ? 'Camera: On.' : 'Camera: Off.';
  return `${mode} ${mic} ${camera}`.trim();
}

export function formatUploadFallbackMessage(summary: UploadSummary): string | null {
  if (!summary.localFallbacks.length) return null;

  const uploaded = summary.uploaded.map((entry) => entry.filename).join('\n') || '(none)';
  const fallback = summary.localFallbacks
    .map((entry) => `${entry.filename}${entry.error ? `\n  ${entry.error}` : ''}`)
    .join('\n\n');

  return (
    'Drive upload completed with local fallback for some files.\n\n' +
    `Uploaded to Drive:\n${uploaded}\n\n` +
    `Saved locally instead:\n${fallback}`
  );
}
