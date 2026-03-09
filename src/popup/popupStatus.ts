/**
 * @file popup/popupStatus.ts
 *
 * Pure text-formatting helpers for popup status and upload summaries.
 */

import type { RecordingPhase, RecordingRunConfig, UploadSummary } from '../shared/recording';

export const STATUS_BY_PHASE: Record<Exclude<RecordingPhase, 'idle'>, string> = {
  starting: 'Starting recording...',
  recording: 'Recording in progress.',
  stopping: 'Stopping recording and sealing files...',
  uploading: 'Finalizing and saving files... you can close this popup.',
  failed: 'The last recording attempt failed.',
};

/** Formats the active run configuration into popup-friendly status prose. */
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

/** Builds the post-upload alert when some files fell back to local downloads. */
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
