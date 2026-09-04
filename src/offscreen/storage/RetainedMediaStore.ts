/**
 * @file offscreen/storage/RetainedMediaStore.ts
 *
 * Owns `library/` — media the extension intentionally retains so the player can
 * read it (ADR-0006). Promotion is the moment ownership transfers from capture
 * to the library; it is deliberately an explicit step rather than "stop calling
 * cleanup", because retention without an owner is what makes orphan recovery,
 * retention and retry ambiguous.
 *
 * The move and the IndexedDB metadata write cannot share a transaction, so
 * `promote()` does not pretend to be atomic. It is **idempotent and
 * reconcilable**: library keys are deterministic, so a promotion interrupted by
 * a crash re-runs onto the same destination and converges.
 */

import {
  directoryForKey,
  fileHandleForKey,
  filenameFromKey,
  libraryKey,
  readFileByKey,
  removeByKey,
  type DirectoryHandleLike,
  type OpfsKey,
} from './opfsLayout';

export class MissingArtifactError extends Error {
  constructor(stagingKey: OpfsKey, libraryTarget: OpfsKey) {
    super(`Neither the staging artifact (${stagingKey}) nor its retained copy (${libraryTarget}) exists`);
    this.name = 'MissingArtifactError';
  }
}

export type RetainedMediaLocation = { kind: 'opfs'; key: OpfsKey; retainedAt: number };

export type RetainedMediaStoreDeps = {
  getRoot: () => Promise<DirectoryHandleLike>;
  now?: () => number;
  warn?: (...args: unknown[]) => void;
};

export class RetainedMediaStore {
  private readonly now: () => number;

  constructor(private readonly deps: RetainedMediaStoreDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Transfers a sealed staging artifact into the retained library and returns
   * where it now lives. Safe to call again after a crash at any point.
   */
  async promote(
    stagingKey: OpfsKey,
    recordingId: string,
    fileId: string,
    filename = filenameFromKey(stagingKey),
  ): Promise<RetainedMediaLocation> {
    const root = await this.deps.getRoot();
    const target = libraryKey(recordingId, fileId, filename);

    const [stagingFile, libraryFile] = await Promise.all([
      readFileByKey(root, stagingKey),
      readFileByKey(root, target),
    ]);

    // Already promoted: a previous run finished the move but may have died
    // before the metadata write. Report success so the caller can re-persist.
    if (libraryFile && !stagingFile) return this.located(target);

    if (!libraryFile && stagingFile) {
      await this.transfer(root, stagingKey, target);
      return this.located(target);
    }

    if (libraryFile && stagingFile) {
      // Both exist, so a copy-fallback promotion was interrupted between the
      // copy and the staging delete. Prefer the retained destination when it is
      // complete, and re-copy when it is short.
      if (libraryFile.size >= stagingFile.size) {
        await removeByKey(root, stagingKey);
        return this.located(target);
      }
      this.deps.warn?.(
        `Retained copy of ${target} is short (${libraryFile.size} < ${stagingFile.size}); re-promoting from staging`,
      );
      await removeByKey(root, target);
      await this.transfer(root, stagingKey, target);
      return this.located(target);
    }

    throw new MissingArtifactError(stagingKey, target);
  }

  /** Deletes a retained file. Used by history/retention only — never by recovery. */
  async remove(key: OpfsKey): Promise<void> {
    await removeByKey(await this.deps.getRoot(), key);
  }

  private located(key: OpfsKey): RetainedMediaLocation {
    return { kind: 'opfs', key, retainedAt: this.now() };
  }

  /**
   * `move()` turns a multi-gigabyte promotion into a metadata operation. Its
   * presence is not proof it works: a shipping Chromium target exposes
   * `FileSystemFileHandle.prototype.move` and throws `NotAllowedError` when it
   * is called (measured in `tests/spikes/drive-playback/../opfs-move-spike.mjs`),
   * so capability is decided by *calling* it, never by `typeof`.
   */
  private async transfer(root: DirectoryHandleLike, from: OpfsKey, to: OpfsKey): Promise<void> {
    const source = await fileHandleForKey(root, from);
    const destinationDir = await directoryForKey(root, to, { create: true });
    const destinationName = filenameFromKey(to);

    if (typeof source.move === 'function') {
      try {
        await source.move(destinationDir, destinationName);
        return;
      } catch (error) {
        this.deps.warn?.(
          `OPFS move() unavailable at runtime (${(error as Error)?.name ?? 'error'}); falling back to a streamed copy`,
        );
      }
    }

    // Bounded memory: streamed, so RAM does not scale with recording length.
    // It costs transient double disk, which is why it is the fallback.
    const file = await source.getFile();
    const writable = await (await fileHandleForKey(root, to, { create: true })).createWritable();
    await file.stream().pipeTo(writable as unknown as WritableStream);
    await removeByKey(root, from);
  }
}
