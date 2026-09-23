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
 *
 * It also gathers destinations that were created before destinations were
 * nested — they were made at the top of My Drive, beside the root rather than
 * inside it — back under the root where they belong.
 */

import type { DriveFolder } from './DriveDestinationFiler';

export type DriveRootFolderDeps = {
  /** Finds a folder by exact name under `parentId`, or directly under My Drive when null. */
  findFolder: (name: string, parentId: string | null) => Promise<DriveFolder | null>;
  createFolder: (name: string, parentId: string | null) => Promise<DriveFolder>;
  /** `files.update` with a new name. The folder keeps its id and its contents. */
  renameFolder: (folderId: string, name: string) => Promise<void>;
  getFolder: (folderId: string) => Promise<DriveFolder | null>;
  /** `files.update` with addParents/removeParents. */
  moveFolder: (folderId: string, addParent: string, removeParents: string[]) => Promise<void>;
  warn?: (...args: unknown[]) => void;
};

/** What a gather did, so the page can say it rather than claim success blindly. */
export type GatherResult = {
  /** Names of the destination folders moved inside the root. */
  moved: string[];
  /** Destinations already in the right place. */
  alreadyInside: number;
  /** Folders that could not be moved; the rest still were. */
  failed: number;
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

  /**
   * Moves the destination folders holding these recordings inside the root.
   *
   * Two signals have to agree before anything moves: the folder must actually
   * hold one of this extension's recordings, *and* be named as one of the
   * user's destinations. Either alone is not enough — a name match on its own
   * would drag an unrelated "Work" folder of theirs into ours, and a parent
   * match on its own would move whatever folder they had filed a recording
   * into by hand.
   */
  async gather(
    recordingFolderIds: readonly string[],
    destinationNames: readonly string[],
    rootFolderName: string,
  ): Promise<GatherResult> {
    const result: GatherResult = { moved: [], alreadyInside: 0, failed: 0 };
    if (!recordingFolderIds.length || !destinationNames.length) return result;

    const root = await this.deps.findFolder(rootFolderName.trim(), null)
      ?? await this.deps.createFolder(rootFolderName.trim(), null);
    const wanted = new Set(destinationNames.map((name) => name.trim().toLocaleLowerCase()));
    const seen = new Set<string>();

    for (const recordingFolderId of recordingFolderIds) {
      const parentId = (await this.parentOf(recordingFolderId))?.[0];
      // The recording sits directly in the root, or Drive would not say where.
      if (!parentId || parentId === root.id || seen.has(parentId)) continue;
      seen.add(parentId);

      const destination = await this.deps.getFolder(parentId).catch(() => null);
      const name = destination?.name?.trim();
      if (!destination || !name || !wanted.has(name.toLocaleLowerCase())) continue;

      const parents = destination.parents ?? [];
      if (parents.length === 1 && parents[0] === root.id) { result.alreadyInside += 1; continue; }

      try {
        await this.deps.moveFolder(destination.id, root.id, parents);
        result.moved.push(name);
      } catch (error) {
        // One folder failing is not a reason to leave the others scattered.
        this.deps.warn?.('Could not move a destination folder into the root folder', error);
        result.failed += 1;
      }
    }
    return result;
  }

  private async parentOf(folderId: string): Promise<string[] | undefined> {
    const folder = await this.deps.getFolder(folderId).catch(() => null);
    return folder?.parents;
  }
}
