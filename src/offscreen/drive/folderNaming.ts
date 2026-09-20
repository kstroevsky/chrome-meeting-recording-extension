/**
 * @file offscreen/drive/folderNaming.ts
 *
 * Derives per-recording Google Drive folder names from generated media file
 * names produced by RecorderEngine.
 */

// Matches: google-meet-{slug}-{datetime}-{type}.{webm|mp4|m4a}
const RECORDING_FILENAME_RE = /^google-meet-(.+)-(\d{8}T\d{4})-(recording|mic|self-video)\.(?:webm|mp4|m4a)$/;

/** True when a name looks like a recording artifact this extension produced. */
export function isRecordingFilename(name: string): boolean {
  return RECORDING_FILENAME_RE.test(name);
}

/**
 * Converts a recording filename into "google-meet-{slug}-{datetime}",
 * grouping all artifacts from the same session under one Drive folder.
 * Falls back to a generic timestamped value if the filename format is unexpected.
 */
/**
 * Puts a user's title into a generated filename, keeping the datetime and the
 * stream suffix.
 *
 * The shape matters beyond looks: {@link inferDriveRecordingFolderName} reads
 * it to decide which folder the recording's files share, so a name that no
 * longer matches would scatter one recording's files into a folder named after
 * the moment it was recovered rather than the moment it was recorded.
 */
export function retitleRecordingFilename(filename: string, slug: string): string | null {
  const m = filename.match(RECORDING_FILENAME_RE);
  if (!m || !slug) return null;
  const extension = filename.slice(filename.lastIndexOf('.') + 1);
  return `google-meet-${slug}-${m[2]}-${m[3]}.${extension}`;
}

export function inferDriveRecordingFolderName(filename: string): string {
  const m = filename.match(RECORDING_FILENAME_RE);
  if (m) return `google-meet-${m[1]}-${m[2]}`;
  return `google-meet-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? 'T' : ''))}`;
}
