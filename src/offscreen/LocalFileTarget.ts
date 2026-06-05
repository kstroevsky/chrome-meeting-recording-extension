/**
 * @file offscreen/LocalFileTarget.ts
 *
 * OPFS-backed StorageTarget used during recording. Chunks are written directly
 * to a temporary OPFS file; close() seals the file and returns a handle that
 * the caller can either upload, download, or discard.
 */

import type { SealedStorageFile, StorageTarget } from './RecorderEngine';
import type { RecordingStream } from '../shared/recording';
import { debugPerf, nowMs, roundMs } from '../shared/perf';

export class LocalFileTarget implements StorageTarget {
  private writable: FileSystemWritableFileStream | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private writtenBytes = 0;
  private sealed: SealedStorageFile | null = null;
  private closed = false;
  private pendingWrites = 0;

  private constructor(
    private readonly fileHandle: FileSystemFileHandle,
    writable: FileSystemWritableFileStream,
    private readonly filename: string,
    private readonly stream?: RecordingStream,
  ) {
    this.writable = writable;
  }

  static async create(filename: string, stream?: RecordingStream): Promise<LocalFileTarget> {
    const startedAt = nowMs();
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      debugPerf(console.log, 'storage', 'opfs_opened', {
        stream,
        durationMs: roundMs(nowMs() - startedAt),
        pendingWrites: 0,
      });
      return new LocalFileTarget(fileHandle, writable, filename, stream);
    } catch (error) {
      debugPerf(console.log, 'storage', 'opfs_open_failed', {
        stream,
        durationMs: roundMs(nowMs() - startedAt),
      });
      throw error;
    }
  }

  async write(chunk: Blob): Promise<void> {
    if (this.closed) throw new Error('Local file target is closed');

    this.pendingWrites += 1;
    const pendingWrites = this.pendingWrites;
    const startedAt = nowMs();
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await this.writable!.write(chunk);
        this.writtenBytes += chunk.size;
        this.pendingWrites = Math.max(0, this.pendingWrites - 1);
        const durationMs = roundMs(nowMs() - startedAt);
        debugPerf(console.log, 'storage', 'opfs_write_complete', {
          stream: this.stream,
          chunkBytes: chunk.size,
          durationMs,
          throughputMbps: durationMs > 0
            ? Math.round(((chunk.size / 1024 / 1024) / (durationMs / 1000)) * 10) / 10
            : null,
          pendingWrites: this.pendingWrites,
          peakPendingWrites: pendingWrites,
        });
      });

    return this.writeChain;
  }

  async close(): Promise<SealedStorageFile | null> {
    if (this.sealed) return this.sealed;
    if (this.closed) return null;
    this.closed = true;

    const closeStartedAt = nowMs();
    await this.writeChain.catch(() => {});
    await this.writable?.close();
    this.writable = null;
    debugPerf(console.log, 'storage', 'opfs_closed', {
      stream: this.stream,
      durationMs: roundMs(nowMs() - closeStartedAt),
      artifactBytes: this.writtenBytes,
      pendingWrites: this.pendingWrites,
    });

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
    const startedAt = nowMs();
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(this.filename);
    } catch (e: any) {
      if (e?.name !== 'NotFoundError') throw e;
    } finally {
      debugPerf(console.log, 'storage', 'opfs_cleanup', {
        stream: this.stream,
        durationMs: roundMs(nowMs() - startedAt),
      });
    }
  }
}
