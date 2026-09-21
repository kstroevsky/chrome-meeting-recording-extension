/**
 * @file offscreen/drive/folderNaming.ts
 *
 * Which Drive folder a recording's files share.
 *
 * The filename grammar itself lives in `shared/recordingFilename.ts` — one
 * place, because it used to live in seven and they drifted. This file only
 * decides what to do when a name cannot be read.
 */

import {
  isRecordingFilename as parseableRecordingFilename,
  recordingGroupName,
  recordingStartedAtMs,
} from '../../shared/recordingFilename';

export {
  isRecordingFilename,
  recordingStartedAtMs,
  retitleRecordingFilename,
} from '../../shared/recordingFilename';

/**
 * Converts a recording filename into the folder its files share. Falls back to
 * a generic timestamped value if the name is not one this extension produced —
 * the recording still gets a folder, it just cannot be named for its meeting.
 */
export function inferDriveRecordingFolderName(filename: string): string {
  return recordingGroupName(filename)
    ?? `google-meet-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? 'T' : ''))}`;
}

/**
 * Roughly how long a recording ran: from the moment in its name to the moment
 * its file was last written.
 *
 * Wall clock, not recorded time — a paused run counts the pause, and the stamp
 * is only as precise as the second it was made in. That is why the caller shows
 * it as `~32m` rather than a timecode. Used only when the run's own measured
 * clock is missing; see `background/recording/unsavedCaptureFlag.ts`.
 */
export function approximateRecordingDurationMs(filename: string, lastModifiedMs: number): number | null {
  if (!parseableRecordingFilename(filename)) return null;
  const startedAt = recordingStartedAtMs(filename);
  if (startedAt == null || !Number.isFinite(lastModifiedMs)) return null;
  const elapsed = lastModifiedMs - startedAt;
  // A file written before the moment its own name claims is not something to
  // reason about; better to say nothing than to show a negative length.
  return elapsed > 0 ? elapsed : null;
}
