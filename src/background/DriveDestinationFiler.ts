/**
 * @file background/DriveDestinationFiler.ts
 *
 * Files a finished recording into one of the user's named Drive destinations.
 *
 * Every upload lands in the built-in folder first, so filing is a *move*, and
 * the thing that moves is the recording's own subfolder — one `files.update`
 * with `addParents`/`removeParents`. The media never moves: a gigabyte of video
 * stays exactly where it is while its folder is re-parented around it.
 *
 * A destination is a label the user gave a folder. Removing the label from
 * settings must never touch the folder or anything inside it — those are the
 * user's recordings, not ours to tidy.
 */

export type DriveFolder = { id: string; name?: string; parents?: string[] };

export type DriveDestinationFilerDeps = {
  /** Finds a folder by exact name directly under My Drive, or null. */
  findRootFolder: (name: string) => Promise<DriveFolder | null>;
  createRootFolder: (name: string) => Promise<DriveFolder>;
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
   * creating that folder on first use. The destination folder is only ever
   * created, never deleted.
   */
  async file(recordingFolderId: string, destinationName: string): Promise<FileResult> {
    const folder = await this.deps.getFolder(recordingFolderId);
    if (!folder) return { status: 'missing' };

    const destination = await this.deps.findRootFolder(destinationName)
      ?? await this.deps.createRootFolder(destinationName);

    const parents = folder.parents ?? [];
    if (parents.length === 1 && parents[0] === destination.id) return { status: 'unchanged' };

    // Replace every existing parent rather than adding one: a recording in two
    // places has no answer to "where is it?".
    await this.deps.moveFolder(recordingFolderId, destination.id, parents);
    return { status: 'filed', destinationFolderId: destination.id };
  }
}
