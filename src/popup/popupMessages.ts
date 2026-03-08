/**
 * @file popup/popupMessages.ts
 *
 * User-facing popup copy and small string-formatting helpers.
 */

import type { MicMode } from '../shared/recording';

const DEFAULT_RECORDING_FILENAME = 'recording.webm';
const DEFAULT_UNKNOWN_SAVE_ERROR = 'Unknown save error';
const DEFAULT_TRANSCRIPT_SUFFIX = 'google-meet';
const TRANSCRIPT_FILENAME_PREFIX = 'google-meet-transcript';

export const POPUP_TOAST_DURATION_MS = 12_000;

export const POPUP_TOAST_TEXT = {
  recordingStarted: 'Recording started',
  noTranscriptOnPage: 'No transcript on this page',
  transcriptEmpty: 'Transcript is empty',
  stopping: 'Stopping... finalizing local files. You can close this popup.',
} as const;

export function buildSavedLocallyMessage(filename?: string): string {
  return `Saved locally: ${filename || DEFAULT_RECORDING_FILENAME}`;
}

export function buildLocalSaveFailedToast(filename?: string, error?: string): string {
  const resolvedFilename = filename || DEFAULT_RECORDING_FILENAME;
  const resolvedError = error || DEFAULT_UNKNOWN_SAVE_ERROR;
  return `Local save failed: ${resolvedFilename} (${resolvedError})`;
}

export function buildLocalSaveFailedAlert(filename?: string, error?: string): string {
  const resolvedFilename = filename || DEFAULT_RECORDING_FILENAME;
  const resolvedError = error || DEFAULT_UNKNOWN_SAVE_ERROR;
  return `Failed to save ${resolvedFilename} locally:\n${resolvedError}`;
}

export function buildStartErrorAlert(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to start recording:\n${message}`;
}

export function buildStopErrorAlert(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to stop recording:\n${message}`;
}

export function buildMicPermissionError(micMode: MicMode): string {
  if (micMode === 'mixed') {
    return 'Microphone permission is required to mix your voice into the tab recording. A setup tab was opened.';
  }
  return 'Microphone permission is required to save a separate microphone file. A setup tab was opened.';
}

export const CAMERA_PERMISSION_ERROR =
  'Camera permission is required for "Record my camera separately". A setup tab was opened. Enable camera there and start again.';

export function buildTranscriptFilename(meetingId?: string, now = Date.now()): string {
  const suffix = meetingId || DEFAULT_TRANSCRIPT_SUFFIX;
  return `${TRANSCRIPT_FILENAME_PREFIX}-${suffix}-${now}.txt`;
}
