/**
 * @file offscreen/drive/folderNaming.ts
 *
 * Derives per-recording Google Drive folder names from generated media file
 * names produced by RecorderEngine.
 */

const RECORDING_FILENAME_RE = /^google-meet-(?:recording|mic)-(.+)-(\d+)\.webm$/;

/**
 * Converts a recording filename into "<meet-id>-<timestamp>".
 * Falls back to a generic value if filename format is unexpected.
 */
export function inferDriveRecordingFolderName(filename: string): string {
  const m = filename.match(RECORDING_FILENAME_RE);
  if (m) return `${m[1]}-${m[2]}`;
  return `google-meet-${Date.now()}`;
}
