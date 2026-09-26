/**
 * @file background/drive/DriveFolderBackfill.ts
 *
 * Records the Drive folder of recordings saved before the folder was stored.
 *
 * Until 2026-08-15 a Drive recording's history row kept only its file ids, not
 * the per-recording folder they were uploaded into. Such a row can play, but
 * cannot be filed into a destination — filing moves the folder, and there is
 * none on record — so the recordings page shows no DESTINATION for it at all.
 *
 * The folder is still findable: it is the files' parent in Drive. This reads it
 * back and stores it, together with the destination the folder already sits in.
 *
 * Deliberately narrow, because a wrong folder id here is dangerous: filing
 * would then move the wrong folder. A parent is recorded only when every Drive
 * file of the recording shares it, and it is a recording's own folder — never
 * the root, and never a destination folder, both of which older builds used
 * as the direct parent of loose files.
 */

import { DRIVE_DEFAULT_DESTINATION_NAME, loadExtensionSettingsFromStorage } from '../../shared/settings';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import type { RecordingHistoryMutation } from '../library/history/RecordingHistoryRepository';
import type { DriveFolder } from './DriveDestinationFiler';
import { driveFolderLink } from './driveDestinationImport';

export type FolderBackfill = {
  historyId: string;
  recording: string;
  folderId: string;
  folderName: string;
  /** The destination the folder already sits in; absent when unfiled (the default one). */
  presetId?: string;
  destination: string;
};

export type FolderBackfillPlan = { backfill: FolderBackfill[]; skipped: { recording: string; reason: string }[] };

export type DriveFolderBackfillDeps = {
  findFolder: (name: string, parentId: string | null) => Promise<DriveFolder | null>;
  getFolder: (folderId: string) => Promise<DriveFolder | null>;
  /** The parents of a Drive file, or null when the file cannot be read. */
  getFileParents: (fileId: string) => Promise<string[] | null>;
  history: {
    listAllIncludingDeleted: () => Promise<RecordingHistoryEntry[]>;
    update: (id: string, mutate: RecordingHistoryMutation) => Promise<RecordingHistoryEntry | undefined>;
  };
  log: (...args: unknown[]) => void;
};

export class DriveFolderBackfill {
  constructor(private readonly deps: DriveFolderBackfillDeps) {}

  async run(options: { apply?: boolean } = {}): Promise<{ applied: boolean; plan: FolderBackfillPlan }> {
    const settings = await loadExtensionSettingsFromStorage();
    const root = await this.deps.findFolder(settings.storage.driveRootFolderName, null);
    if (!root) throw new Error(`No "${settings.storage.driveRootFolderName}" folder in Google Drive`);

    // The destination folders that exist, by id → which preset (none = the default one).
    const destinations = new Map<string, { presetId?: string; name: string }>();
    const named = [
      { name: DRIVE_DEFAULT_DESTINATION_NAME },
      ...settings.storage.driveFolderPresets.map((preset) => ({ name: preset.name, presetId: preset.id })),
    ];
    for (const destination of named) {
      const folder = await this.deps.findFolder(destination.name, root.id);
      if (folder) destinations.set(folder.id, destination);
    }

    const plan: FolderBackfillPlan = { backfill: [], skipped: [] };
    const rows = (await this.deps.history.listAllIncludingDeleted())
      .filter((entry) => !entry.deletedAt && entry.storageMode === 'drive' && !entry.driveFolderId);
    for (const entry of rows) {
      const skip = (reason: string) => plan.skipped.push({ recording: entry.name, reason });
      const fileIds = [...new Set(entry.files.flatMap((file) => [
        file.driveFileId,
        ...file.locations.flatMap((location) => location.kind === 'drive' ? [location.fileId] : []),
      ]).filter((id): id is string => Boolean(id)))];
      if (!fileIds.length) { skip('no Drive files'); continue; }

      const parents = new Set<string>();
      let unreadable = false;
      for (const fileId of fileIds) {
        const fileParents = await this.deps.getFileParents(fileId);
        if (!fileParents?.length) { unreadable = true; break; }
        fileParents.forEach((parent) => parents.add(parent));
      }
      if (unreadable) { skip('a file is not readable in Drive'); continue; }
      if (parents.size !== 1) { skip('files are in different folders'); continue; }

      const [folderId] = parents;
      if (folderId === root.id) { skip('files sit directly in the root folder'); continue; }
      if (destinations.has(folderId)) { skip('files sit directly in a destination folder'); continue; }
      const folder = await this.deps.getFolder(folderId);
      if (!folder?.name) { skip('folder is not readable in Drive'); continue; }

      const container = folder.parents?.length === 1 ? destinations.get(folder.parents[0]) : undefined;
      const directlyInRoot = folder.parents?.length === 1 && folder.parents[0] === root.id;
      if (!container && !directlyInRoot) { skip('folder is outside the recordings folder'); continue; }
      plan.backfill.push({
        historyId: entry.id,
        recording: entry.name,
        folderId,
        folderName: folder.name,
        ...(container?.presetId ? { presetId: container.presetId } : {}),
        destination: container?.name ?? '(root)',
      });
    }
    if (!options.apply) return { applied: false, plan };

    for (const item of plan.backfill) {
      await this.deps.history.update(item.historyId, (current) => {
        // Re-checked at write time: never overwrite a folder recorded meanwhile.
        if (!current || current.deletedAt || current.driveFolderId) return current;
        return {
          ...current,
          driveFolderId: item.folderId,
          driveFolderName: item.folderName,
          folderWebViewLink: driveFolderLink(item.folderId),
          ...(item.presetId ? { driveFolderPresetId: item.presetId } : {}),
        };
      });
    }
    this.deps.log(`Recorded the Drive folder of ${plan.backfill.length} recording(s)`);
    return { applied: true, plan };
  }
}
