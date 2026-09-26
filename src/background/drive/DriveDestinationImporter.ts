/**
 * @file background/drive/DriveDestinationImporter.ts
 *
 * Applies {@link planDestinationImport} to the real Drive and library: lists a
 * destination's recording folders, plans, and — only when asked — writes.
 * The plan is the part worth reading; see `driveDestinationImport.ts`.
 */

import { createRecordingHistoryId, type RecordingHistoryEntry } from '../../shared/recordingHistory';
import { DRIVE_DEFAULT_DESTINATION_NAME, loadExtensionSettingsFromStorage } from '../../shared/settings';
import type { RecordingHistoryMutation } from '../library/history/RecordingHistoryRepository';
import type { DriveFolder } from './DriveDestinationFiler';
import {
  planDestinationImport,
  relinkedEntry,
  restoreDeletedEntry,
  type DestinationImportPlan,
  type DriveListedFile,
  type DriveRecordingFolder,
} from './driveDestinationImport';

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

export type DriveDestinationImporterDeps = {
  /** Finds a folder by exact name under `parentId`, or directly under My Drive when null. */
  findFolder: (name: string, parentId: string | null) => Promise<DriveFolder | null>;
  /** Every live child of a folder, files and folders alike. */
  listChildren: (folderId: string) => Promise<Array<DriveListedFile & { mimeType?: string }>>;
  history: {
    listAllIncludingDeleted: () => Promise<RecordingHistoryEntry[]>;
    update: (id: string, mutate: RecordingHistoryMutation) => Promise<RecordingHistoryEntry | undefined>;
  };
  log: (...args: unknown[]) => void;
};

export class DriveDestinationImporter {
  constructor(private readonly deps: DriveDestinationImporterDeps) {}

  /**
   * Brings the recording folders already inside a destination into the
   * library, filed under it. Plans only, unless `apply` — the plan is what the
   * caller shows the user first. Safe to repeat: a second run finds everything
   * already known and does nothing.
   */
  async importDestination(
    destinationName: string,
    options: { apply?: boolean } = {},
  ): Promise<{ applied: boolean; plan: DestinationImportPlan }> {
    const { preset, folderName, destinationId } = await this.resolveDestination(destinationName);
    const folders: DriveRecordingFolder[] = [];
    for (const child of await this.deps.listChildren(destinationId)) {
      if (child.mimeType !== DRIVE_FOLDER_MIME) continue;
      const files = (await this.deps.listChildren(child.id)).filter((file) => file.mimeType !== DRIVE_FOLDER_MIME);
      folders.push({ id: child.id, name: child.name, files });
    }
    const plan = planDestinationImport(
      folders,
      await this.deps.history.listAllIncludingDeleted(),
      preset?.id,
      createRecordingHistoryId,
    );
    if (!options.apply) return { applied: false, plan };

    for (const entry of plan.create) {
      // Never overwrite: an id collision would be a bug, not a reason to lose a row.
      await this.deps.history.update(entry.id, (current) => current ?? entry);
    }
    for (const link of plan.relink) {
      await this.deps.history.update(link.historyId, (current) => (
        current && !current.deletedAt
          ? relinkedEntry(current, { id: link.folderId, name: link.folderName }, preset?.id)
          : current
      ));
    }
    this.deps.log(`Imported ${plan.create.length} and re-linked ${plan.relink.length} recording(s) from "${folderName}"`);
    return { applied: true, plan };
  }

  /**
   * Brings back one recording the user removed from the library, by the Drive
   * folder its files are in. Deliberately one folder at a time: a deletion is
   * a decision, and only the user can reverse a particular one. The same entry
   * returns — id, name, description — pointed at the folder it is in now.
   */
  async restoreFolder(
    destinationName: string,
    recordingFolderName: string,
    options: { apply?: boolean } = {},
  ): Promise<{ applied: boolean; restored: { historyId: string; name: string; folderId: string } }> {
    const { preset, destinationId } = await this.resolveDestination(destinationName);
    const matches = (await this.deps.listChildren(destinationId))
      .filter((child) => child.mimeType === DRIVE_FOLDER_MIME && child.name === recordingFolderName);
    if (matches.length !== 1) throw new Error(`Expected one folder "${recordingFolderName}" in "${destinationName}", found ${matches.length}`);
    const folder = matches[0];

    const fileIds = new Set((await this.deps.listChildren(folder.id)).map((file) => file.id));
    const owners = (await this.deps.history.listAllIncludingDeleted()).filter((entry) => entry.files.some((file) =>
      [file.driveFileId, ...file.locations.flatMap((location) => location.kind === 'drive' ? [location.fileId] : [])]
        .some((id) => id != null && fileIds.has(id))));
    if (owners.length !== 1) throw new Error(`Expected the files to belong to one library entry, found ${owners.length}`);
    const [owner] = owners;
    if (!owner.deletedAt) throw new Error(`"${owner.name}" is already in the library`);

    const restored = { historyId: owner.id, name: owner.name, folderId: folder.id };
    if (!options.apply) return { applied: false, restored };
    await this.deps.history.update(owner.id, (current) => (
      current?.deletedAt ? restoreDeletedEntry(current, folder, preset?.id) : current
    ));
    this.deps.log(`Restored "${owner.name}" to the library`);
    return { applied: true, restored };
  }

  /** A destination by the name the user knows it by; the default one has no preset. */
  private async resolveDestination(destinationName: string) {
    const settings = await loadExtensionSettingsFromStorage();
    const wanted = destinationName.trim().toLocaleLowerCase();
    const isDefault = wanted === DRIVE_DEFAULT_DESTINATION_NAME.toLocaleLowerCase();
    const preset = isDefault
      ? undefined
      : settings.storage.driveFolderPresets.find((candidate) => candidate.name.trim().toLocaleLowerCase() === wanted);
    if (!isDefault && !preset) throw new Error(`Add "${destinationName}" as a destination in Settings first`);
    const folderName = preset?.name ?? DRIVE_DEFAULT_DESTINATION_NAME;

    const rootName = settings.storage.driveRootFolderName;
    const root = await this.deps.findFolder(rootName, null);
    if (!root) throw new Error(`No "${rootName}" folder in Google Drive`);
    const destination = await this.deps.findFolder(folderName, root.id);
    if (!destination) throw new Error(`No "${folderName}" folder inside "${rootName}"`);
    return { preset, folderName, destinationId: destination.id };
  }
}
