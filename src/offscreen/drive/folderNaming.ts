/**
 * @file offscreen/drive/folderNaming.ts
 *
 * Derives per-recording Google Drive folder names from generated media file
 * names produced by RecorderEngine.
 */

// Matches: google-meet-{slug}-{datetime}-{type}.webm
const RECORDING_FILENAME_RE = /^google-meet-(.+)-(\d{8}T\d{4})-(recording|mic|self-video)\.webm$/;

/**
 * Converts a recording filename into "google-meet-{slug}-{datetime}",
 * grouping all artifacts from the same session under one Drive folder.
 * Falls back to a generic timestamped value if the filename format is unexpected.
 */
export function inferDriveRecordingFolderName(filename: string): string {
  const m = filename.match(RECORDING_FILENAME_RE);
  if (m) return `google-meet-${m[1]}-${m[2]}`;
  return `google-meet-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? 'T' : ''))}`;
}
