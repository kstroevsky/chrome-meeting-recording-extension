/**
 * @file recordings/fileDeletion.ts
 *
 * What "also delete its files" will do, said before it happens — once in the
 * page's own dialog, and once more, natively, as the last word before files
 * are deleted. Counted the way the background deletes: by the Drive file ids
 * and downloads an entry records, not by where it says its files went.
 */

import type { RecordingHistoryEntry } from '../shared/recordingHistory';

function count(entries: readonly RecordingHistoryEntry[]): { drive: number; local: number } {
  let drive = 0;
  let local = 0;
  for (const entry of entries) {
    for (const file of entry.files) {
      if (file.driveFileId || file.locations.some((location) => location.kind === 'drive')) drive += 1;
      if (file.downloadId != null || file.locations.some((location) => location.kind === 'download')) local += 1;
    }
  }
  return { drive, local };
}

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/** The dialog's body once "also delete its files" is ticked. */
export function fileDeletionWarning(entries: readonly RecordingHistoryEntry[]): string {
  const { drive, local } = count(entries);
  return [
    drive ? `${files(drive)} go${drive === 1 ? 'es' : ''} to the Google Drive trash (recoverable for 30 days).` : '',
    local ? `${files(local)} ${local === 1 ? 'is' : 'are'} permanently deleted from this computer.` : '',
    'If it is shared, the share ends and its link stops working — for every recording in that share.',
  ].filter(Boolean).join(' ');
}

/** The native last check: a plain statement of what is about to be deleted. */
export function fileDeletionFinalCheck(entries: readonly RecordingHistoryEntry[]): string {
  const { drive, local } = count(entries);
  const what = [
    drive ? `move ${files(drive)} to the Google Drive trash` : '',
    local ? `PERMANENTLY delete ${files(local)} from this computer` : '',
  ].filter(Boolean).join(' and ');
  const recordings = `${entries.length} recording${entries.length === 1 ? '' : 's'}`;
  return what
    ? `Delete the files of ${recordings}? This will ${what}. Shared links to them stop working.`
    : `Remove ${recordings}? No files of theirs could be found to delete.`;
}
