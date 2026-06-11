/**
 * @file offscreen/storage/opfsWorker.ts
 *
 * Dedicated worker that owns one OPFS file via a FileSystemSyncAccessHandle and
 * appends transferred chunk buffers synchronously — off the main offscreen
 * thread. Only the byte-sink lives here; capture, encoding, and MediaRecorder
 * all stay in the offscreen document (workers cannot capture media).
 *
 * Protocol (main -> worker): open | write | close | discard
 * Protocol (worker -> main): opened | written | sealed | discarded | error
 *
 * On close the worker also runs the WebM duration fix here, so the streaming
 * parse stays off the offscreen main thread (and keeps that dependency out of
 * the offscreen bundle — the main thread only loads it on the rare fallback).
 */

import fixWebmDuration from 'webm-duration-fix';
import { FlushPolicy } from './FlushPolicy';

// FileSystemSyncAccessHandle is worker-only and absent from the DOM lib we
// target, so declare the minimal surface we use.
interface FileSystemSyncAccessHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  flush(): void;
  close(): void;
  truncate(newSize: number): void;
  getSize(): number;
}
interface SyncCapableFileHandle extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

type InboundMessage =
  | { type: 'open'; filename: string }
  | { type: 'write'; seq: number; buffer: ArrayBuffer }
  | { type: 'close' }
  | { type: 'discard' };

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<InboundMessage>) => void) | null;
  postMessage(message: unknown): void;
};

let fileHandle: FileSystemFileHandle | null = null;
let accessHandle: FileSystemSyncAccessHandle | null = null;
let filename = '';
let offset = 0;
let flushPolicy: FlushPolicy | null = null;

ctx.onmessage = async (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'open': {
        filename = msg.filename;
        const root = await navigator.storage.getDirectory();
        fileHandle = await root.getFileHandle(filename, { create: true });
        accessHandle = await (fileHandle as SyncCapableFileHandle).createSyncAccessHandle();
        accessHandle.truncate(0);
        offset = 0;
        flushPolicy = new FlushPolicy(Date.now());
        ctx.postMessage({ type: 'opened' });
        break;
      }
      case 'write': {
        if (!accessHandle) throw new Error('write before open');
        const view = new Uint8Array(msg.buffer);
        accessHandle.write(view, { at: offset });
        offset += view.byteLength;
        // Periodically force the page cache to disk so a hard power cut loses at
        // most ~one flush interval of recording, not the whole unflushed tail.
        // Best-effort: close() still does the authoritative flush, so a transient
        // flush hiccup must not abort the write path.
        if (flushPolicy?.onWrite(Date.now())) {
          try {
            accessHandle.flush();
          } catch {
            /* best-effort; close() will flush again */
          }
        }
        ctx.postMessage({ type: 'written', seq: msg.seq, bytes: view.byteLength });
        break;
      }
      case 'close': {
        if (accessHandle) {
          accessHandle.flush();
          accessHandle.close();
          accessHandle = null;
        }
        // The file is readable normally once the exclusive sync handle is closed.
        let file: Blob | null = offset > 0 && fileHandle ? await fileHandle.getFile() : null;
        let durationFixed = false;
        if (file) {
          try {
            // Streams the file + lazy-slices the body, so the result crosses back
            // to the main thread as a cheap Blob reference, not a full copy.
            file = await fixWebmDuration(file);
            durationFixed = true;
          } catch {
            // Leave it unfixed; the main thread will attempt the fix as a fallback.
          }
        }
        ctx.postMessage({ type: 'sealed', file, bytes: offset, durationFixed });
        break;
      }
      case 'discard': {
        try {
          accessHandle?.close();
        } catch {
          /* already closed */
        }
        accessHandle = null;
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(filename);
        } catch {
          /* a missing file is fine */
        }
        ctx.postMessage({ type: 'discarded' });
        break;
      }
    }
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      op: msg.type,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
