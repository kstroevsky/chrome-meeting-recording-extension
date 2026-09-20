/**
 * @file background/DriveDestinationFiler.ts
 *
 * Files a finished recording into one of the user's named Drive destinations.
 *
 * Every upload lands in the default destination first, so filing is a *move*,
 * and the thing that moves is the recording's own subfolder — one `files.update`
 * with `addParents`/`removeParents`. The media never moves: a gigabyte of video
 * stays exactly where it is while its folder is re-parented around it.
 *
 * Destinations are created *inside* the user's root folder. Creating them beside
 * it, at the top of My Drive, is what this used to do, and it scattered a
 * library across folders whose only common trait was that we had made them.
 *
 * A destination is a label the user gave a folder. Removing the label from
 * settings must never touch the folder or anything inside it — those are the
 * user's recordings, not ours to tidy.
 */

export type DriveFolder = { id: string; name?: string; parents?: string[] };

export type DriveDestinationFilerDeps = {
  /** Finds a folder by exact name under `parentId`, or directly under My Drive when null. */
  findFolder: (name: string, parentId: string | null) => Promise<DriveFolder | null>;
  createFolder: (name: string, parentId: string | null) => Promise<DriveFolder>;
  getFolder: (folderId: string) => Promise<DriveFolder | null>;
  /** `files.update` with addParents/removeParents. */
  moveFolder: (folderId: string, addParent: string, removeParents: string[]) => Promise<void>;
  warn?: (...args: unknown[]) => void;
};

export type FileResult =
  | { status: 'filed'; destinationFolderId: string }
  /** Already where it was asked to go; nothing was touched. */
  | { status: 'unchanged' }
  /** The recording's folder is gone from Drive — filing it is meaningless. */
  | { status: 'missing' };

export class DriveDestinationFiler {
  constructor(private readonly deps: DriveDestinationFilerDeps) {}

  /**
   * Moves `recordingFolderId` into the destination named `destinationName`,
   * inside the root folder named `rootFolderName`, creating either on first
   * use. Both are only ever created, never deleted.
   */
  async file(recordingFolderId: string, destinationName: string, rootFolderName: string): Promise<FileResult> {
    const folder = await this.deps.getFolder(recordingFolderId);
    if (!folder) return { status: 'missing' };

    const root = await this.ensureFolder(rootFolderName, null);
    const destination = await this.ensureFolder(destinationName, root.id);

    const parents = folder.parents ?? [];
    if (parents.length === 1 && parents[0] === destination.id) return { status: 'unchanged' };

    // Replace every existing parent rather than adding one: a recording in two
    // places has no answer to "where is it?".
    await this.deps.moveFolder(recordingFolderId, destination.id, parents);
    return { status: 'filed', destinationFolderId: destination.id };
  }

  private async ensureFolder(name: string, parentId: string | null): Promise<DriveFolder> {
    return await this.deps.findFolder(name, parentId) ?? await this.deps.createFolder(name, parentId);
  }
}
