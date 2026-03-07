/**
 * @file offscreen/LocalFileTarget.ts
 *
 * StorageTarget that streams MediaRecorder chunks directly to the Origin
 * Private File System (OPFS), eliminating in-memory blob accumulation.
 *
 * Write flow:
 *   ondataavailable → write() → OPFS FileSystemWritableFileStream
 *
 * Finalisation flow:
 *   close() → writable.close() → fileHandle.getFile()
 *           → URL.createObjectURL(file) → onReady(blobUrl, opfsFilename)
 *           → chrome.downloads.download(blobUrl)
 *
 * Cleanup:
 *   After download, the caller must call navigator.storage.getDirectory() →
 *   root.removeEntry(opfsFilename) to free disk space.
 *
 * Availability:
 *   OPFS is available in all non-incognito Chrome windows (Chrome 86+, and all
 *   extension offscreen documents share the extension origin). When unavailable,
 *   RecorderEngine falls back to the legacy in-memory blob path automatically.
 *
 * @see src/offscreen/RecorderEngine.ts  — StorageTarget interface
 * @see src/offscreen.ts                 — openTarget wiring + onReady handler
 */

import type { StorageTarget } from './RecorderEngine';

export class LocalFileTarget implements StorageTarget {
  private writable: FileSystemWritableFileStream | null = null;

  /**
   * Promise chain that serialises all write() calls sequentially.
   * FileSystemWritableFileStream rejects concurrent writes, so we queue them.
   * Each new write is appended to the chain; errors in one write are swallowed
   * so subsequent chunks are still attempted (individual chunk loss is better
   * than stopping the whole recording).
   */
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly fileHandle: FileSystemFileHandle,
    writable: FileSystemWritableFileStream,
    /** Called with (blobUrl, opfsFilename) once the file is sealed on close(). */
    private readonly onReady: (blobUrl: string, opfsFilename: string) => void,
    private readonly filename: string,
  ) {
    this.writable = writable;
  }

  // ---------------------------------------------------------------------------
  // Factory + availability check
  // ---------------------------------------------------------------------------

  /**
   * Opens (or creates) an OPFS file for writing.
   * Throws if OPFS is unavailable — RecorderEngine catches this and falls back
   * to the in-memory path.
   */
  static async create(
    filename: string,
    onReady: (blobUrl: string, opfsFilename: string) => void,
  ): Promise<LocalFileTarget> {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    return new LocalFileTarget(fileHandle, writable, onReady, filename);
  }

  /** Returns true if OPFS is usable in this context (quick async probe). */
  static async isAvailable(): Promise<boolean> {
    try {
      await navigator.storage.getDirectory();
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // StorageTarget implementation
  // ---------------------------------------------------------------------------

  /**
   * Enqueues a chunk write. Returns a promise that resolves when this specific
   * chunk has been written to the OPFS stream.
   */
  async write(chunk: Blob): Promise<void> {
    // Append to chain; recover from any previous write error so the stream
    // continues even if an individual chunk fails.
    this.writeChain = this.writeChain
      .catch(() => {})                             // recover from prior error
      .then(() => this.writable!.write(chunk))
      .catch((e) => {
        console.error('[LocalFileTarget] chunk write failed', e);
      });
    return this.writeChain;
  }

  /**
   * Waits for all pending writes, seals the OPFS file, then fires onReady
   * with a streaming blob URL. The file is NOT loaded into RAM — Chrome
   * streams it from OPFS when the download API reads the URL.
   */
  async close(): Promise<void> {
    // Drain the write queue; ignore errors (individual chunk failures were already logged)
    await this.writeChain.catch(() => {});

    await this.writable?.close();
    this.writable = null;

    // File.getFile() returns a lazy File reference — URL.createObjectURL does not
    // read the file into RAM; Chrome streams it from OPFS on demand.
    const file = await this.fileHandle.getFile();
    const blobUrl = URL.createObjectURL(file);
    this.onReady(blobUrl, this.filename);
  }
}
