/**
 * @file offscreen/drive/folderNaming.ts
 *
 * Which Drive folder a recording's files share.
 *
 * The filename grammar itself lives in `shared/recordingFilename.ts` — one
 * place, because it used to live in seven and they drifted. This file only
 * decides what to do when a name cannot be read.
 */

import { recordingGroupName } from '../../shared/recordingFilename';

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
