/**
 * @file background/DriveRootFolder.ts
 *
 * Renames the one folder every recording lives under, in Drive, when the user
 * renames it in Settings.
 *
 * Folders are resolved by *name*, so the setting and the folder have to agree.
 * Letting them drift is what splits a library: the next upload would not find
 * the old folder, would create a second one under the new name, and half the
 * recordings would be somewhere nothing looks any more. So the rename happens
 * in Drive first and the setting is only written if it succeeded.
 *
 * A rename keeps the folder id, so every stored file id, folder id and
 * `webViewLink` in history survives it untouched — this moves no bytes.
 */

import type { DriveFolder } from './DriveDestinationFiler';

export type DriveRootFolderDeps = {
  /** Finds a folder by exact name under `parentId`, or directly under My Drive when null. */
  findFolder: (name: string, parentId: string | null) => Promise<DriveFolder | null>;
  /** `files.update` with a new name. The folder keeps its id and its contents. */
  renameFolder: (folderId: string, name: string) => Promise<void>;
};

export type RootRenameResult =
  /** The folder was there and now has the new name. */
  | { status: 'renamed'; folderId: string }
  /** Nothing has been uploaded yet, so there is no folder to rename. */
  | { status: 'absent' }
  /** A folder of the new name already exists; renaming would leave two. */
  | { status: 'taken'; folderId: string };

export class DriveRootFolder {
  constructor(private readonly deps: DriveRootFolderDeps) {}

  async rename(from: string, to: string): Promise<RootRenameResult> {
    const current = from.trim();
    const next = to.trim();
    if (!next || current === next) return { status: 'absent' };

    // Checked before the rename, not after: two folders of the same name are
    // legal in Drive and indistinguishable to a lookup, so the user has to
    // decide which one they meant rather than us guessing.
    const existing = await this.deps.findFolder(next, null);
    if (existing) return { status: 'taken', folderId: existing.id };

    const folder = await this.deps.findFolder(current, null);
    if (!folder) return { status: 'absent' };

    await this.deps.renameFolder(folder.id, next);
    return { status: 'renamed', folderId: folder.id };
  }
}
