/**
 * @file background/DriveArtifactResolver.ts
 *
 * Checks that a recording's Drive file is still where history says, and repairs
 * the row when it is not.
 *
 * History treats a Drive id as permanently valid. It usually is — an id survives
 * moving a file between folders, renaming it, reorganising a whole Drive — but
 * it does not survive the file being trashed, and it does not survive history
 * recording the wrong id in the first place. Both failed silently as
 * "could not open", which is how a user spent an evening hunting for an hour of
 * audio that was sitting in Drive the whole time.
 *
 * Two behaviours, in order of cheapness:
 *
 *  1. Tell trash apart from gone. A trashed file answers `200` with
 *     `trashed: true`; only permanent deletion answers `404`. That is a 30-day
 *     recovery window worth naming instead of swallowing.
 *  2. Re-find a lost file by name inside the recording's own folder, and heal
 *     the row. Costs one search on a path that was already failing.
 */

export type DriveArtifactState =
  | { status: 'ok'; fileId: string }
  /** In Drive's trash: recoverable by the user, for about 30 days. */
  | { status: 'trashed'; fileId: string }
  /** Found under a different id and repaired. */
  | { status: 'relinked'; fileId: string }
  /**
   * Unreachable. Deliberately not called "deleted": under `drive.file` scope a
   * permanently deleted file and one this install no longer has access to are
   * indistinguishable, and guessing between them misleads.
   */
  | { status: 'missing' };

export type DriveMetadata = { id: string; name?: string; size?: string; trashed?: boolean };

export type DriveArtifactResolverDeps = {
  /** Resolves metadata, or null on 404. Throws only for unexpected failures. */
  getMetadata: (fileId: string) => Promise<DriveMetadata | null>;
  /** Files directly inside a folder, for re-finding one that moved id. */
  listFolder: (folderId: string) => Promise<DriveMetadata[]>;
  warn?: (...args: unknown[]) => void;
};

export type ArtifactIdentity = {
  fileId: string;
  /** The recording's own Drive folder, when history recorded one. */
  folderId?: string;
  filename: string;
  bytes?: number;
};

export class DriveArtifactResolver {
  constructor(private readonly deps: DriveArtifactResolverDeps) {}

  async resolve(identity: ArtifactIdentity): Promise<DriveArtifactState> {
    const metadata = await this.deps.getMetadata(identity.fileId).catch((error) => {
      this.deps.warn?.('Drive metadata lookup failed', identity.fileId, error);
      return null;
    });

    if (metadata && !metadata.trashed) return { status: 'ok', fileId: identity.fileId };
    if (metadata?.trashed) return { status: 'trashed', fileId: identity.fileId };

    // Gone under that id. It may still be in the recording's folder under
    // another one — which is exactly the shape a mis-recorded id leaves behind.
    const found = await this.reFind(identity);
    return found ? { status: 'relinked', fileId: found } : { status: 'missing' };
  }

  private async reFind(identity: ArtifactIdentity): Promise<string | undefined> {
    if (!identity.folderId) return undefined;
    const candidates = await this.deps.listFolder(identity.folderId).catch((error) => {
      this.deps.warn?.('Drive folder listing failed', identity.folderId, error);
      return [] as DriveMetadata[];
    });
    const live = candidates.filter((file) => !file.trashed && file.id !== identity.fileId);

    // Name is the strong signal; size breaks a tie and guards against adopting
    // a same-named file of obviously different content.
    const byName = live.filter((file) => file.name === identity.filename);
    const pick = identity.bytes != null
      ? byName.find((file) => Number(file.size) === identity.bytes) ?? byName[0]
      : byName[0];
    if (pick) this.deps.warn?.(`Relinked ${identity.filename} to ${pick.id}`);
    return pick?.id;
  }
}
