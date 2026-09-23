/**
 * @file background/driveFolderNameRepair.ts
 *
 * Renames the Drive folders that were created with the wrong name.
 *
 * Between 2026-06-21 and the fix, `RECORDING_FILENAME_RE` did not match the
 * names `buildRecordingFilename` produced — the stamp had gained seconds and
 * the pattern still expected `HHmm`. Every folder therefore took
 * `inferDriveRecordingFolderName`'s fallback, which is named after the moment
 * of upload rather than the meeting: `google-meet-20260920T1856`, with no clue
 * which recording is inside.
 *
 * Recordings the user named are already right — naming renames the folder in
 * Drive. What this repairs is the ones nobody named, which kept the fallback.
 *
 * Deliberately narrow. A folder is renamed only when its recorded name is
 * *exactly* the fallback shape and the recording's own filename says what it
 * should have been. Anything the user has touched, and anything this cannot
 * explain, is left alone: a wrong rename in someone's Drive is worse than a
 * folder with a dull name.
 */

import { inferDriveRecordingFolderName, isRecordingFilename } from '../offscreen/drive/folderNaming';
import type { RecordingHistoryEntry } from '../shared/recordingHistory';

/** `google-meet-20260920T1856` — the fallback, and nothing else. */
const FALLBACK_FOLDER_NAME_RE = /^google-meet-\d{8}T\d{4,6}$/;

export type FolderRename = { folderId: string; historyId: string; from: string; to: string };

/**
 * The renames that would put things right. Pure, so what gets touched in a
 * user's Drive is decided by something that can be read and tested.
 */
export function plannedFolderRenames(entries: readonly RecordingHistoryEntry[]): FolderRename[] {
  const renames: FolderRename[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const from = entry.driveFolderName;
    if (entry.deletedAt || !entry.driveFolderId || !from) continue;
    if (!FALLBACK_FOLDER_NAME_RE.test(from)) continue;
    // One rename per folder, however many files the recording has.
    if (seen.has(entry.driveFolderId)) continue;

    const media = entry.files.find((file) => !file.kind && isRecordingFilename(file.filename));
    if (!media) continue;
    const to = inferDriveRecordingFolderName(media.filename);
    // The fallback would be returned again for a name this cannot parse, and
    // renaming a folder to what it is already called helps nobody.
    if (to === from || FALLBACK_FOLDER_NAME_RE.test(to)) continue;

    seen.add(entry.driveFolderId);
    renames.push({ folderId: entry.driveFolderId, historyId: entry.id, from, to });
  }
  return renames;
}
