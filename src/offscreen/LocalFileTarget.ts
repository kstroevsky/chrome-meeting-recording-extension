/**
 * @file offscreen/LocalFileTarget.ts
 *
 * OPFS-backed StorageTarget used during recording. Chunks are written directly
 * to a temporary OPFS file; close() seals the file and returns a handle that
 * the caller can either upload, download, or discard.
 */

import type { SealedStorageFile, StorageTarget } from './RecorderEngine';

export class LocalFileTarget implements StorageTarget {
  private writable: FileSystemWritableFileStream | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private writtenBytes = 0;
  private sealed: SealedStorageFile | null = null;
  private closed = false;

  private constructor(
    private readonly fileHandle: FileSystemFileHandle,
    writable: FileSystemWritableFileStream,
    private readonly filename: string,
  ) {
    this.writable = writable;
  }

  static async create(filename: string): Promise<LocalFileTarget> {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    return new LocalFileTarget(fileHandle, writable, filename);
  }

  async write(chunk: Blob): Promise<void> {
    if (this.closed) throw new Error('Local file target is closed');

    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await this.writable!.write(chunk);
        this.writtenBytes += chunk.size;
      });

    return this.writeChain;
  }

  async close(): Promise<SealedStorageFile | null> {
    if (this.sealed) return this.sealed;
    if (this.closed) return null;
    this.closed = true;

    await this.writeChain.catch(() => {});
    await this.writable?.close();
    this.writable = null;

    if (this.writtenBytes === 0) {
      await this.discardInternal();
      return null;
    }

    const file = await this.fileHandle.getFile();
    this.sealed = {
      filename: this.filename,
      file,
      opfsFilename: this.filename,
      cleanup: async () => {
        await this.discardInternal();
      },
    };
    return this.sealed;
  }

  private async discardInternal(): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(this.filename);
    } catch (e: any) {
      if (e?.name !== 'NotFoundError') throw e;
    }
  }
}
