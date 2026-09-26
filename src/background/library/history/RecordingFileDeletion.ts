/**
 * @file background/library/history/RecordingFileDeletion.ts
 *
 * "Remove from library" and "…and delete its files" — the second half.
 *
 * Removing a recording has always left its files alone. When the user also asks
 * for the files to go, each copy goes the way its home allows:
 *
 * - Google Drive: each file to the Drive trash, recoverable for 30 days. The
 *   folder is never trashed, even when it looks empty: the extension sees only
 *   the files it created, and trashing a folder trashes everything in it —
 *   including files the user put there that the extension cannot see.
 * - Downloads: deleted from disk. Chrome can only delete permanently; the page
 *   says so before the user confirms.
 *
 * Best effort per file: one failure does not keep the others, and every failure
 * is reported rather than swallowed. The library entry is already removed by the
 * time this runs, so a failure leaves a file behind — never an entry pointing at
 * files that are gone.
 */

import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';

export type RecordingFileDeletionDeps = {
  trashDriveFile: (fileId: string) => Promise<void>;
  removeDownload: (downloadId: number) => Promise<void>;
};

export type RecordingFileDeletionResult = { deleted: number; errors: string[] };

export async function deleteRecordingFiles(
  entry: RecordingHistoryEntry,
  deps: RecordingFileDeletionDeps,
): Promise<RecordingFileDeletionResult> {
  const result: RecordingFileDeletionResult = { deleted: 0, errors: [] };
  const attempt = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
      result.deleted += 1;
    } catch (error) {
      result.errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const driveIds = new Set<string>();
  const downloadIds = new Set<number>();
  for (const file of entry.files) {
    if (file.driveFileId) driveIds.add(file.driveFileId);
    if (file.downloadId != null) downloadIds.add(file.downloadId);
    for (const location of file.locations) {
      if (location.kind === 'drive') driveIds.add(location.fileId);
      if (location.kind === 'download') downloadIds.add(location.downloadId);
    }
  }
  const nameOf = (id: string) => entry.files.find((file) => file.driveFileId === id)?.filename ?? id;

  for (const id of driveIds) await attempt(`Drive file ${nameOf(id)}`, () => deps.trashDriveFile(id));
  for (const id of downloadIds) {
    const name = entry.files.find((file) => file.downloadId === id)?.filename ?? `download ${id}`;
    await attempt(`Downloads file ${name}`, () => deps.removeDownload(id));
  }

  return result;
}
