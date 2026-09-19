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
 * The fixed bytes are written back to the file, because the file — not the Blob
 * this returns — is what promotion moves into the retained library, and what
 * the player and the local download eventually read.
 */

import fixWebmDuration from 'webm-duration-fix';
import { FlushPolicy } from './FlushPolicy';
import { fileHandleForKey, removeByKey } from './opfsLayout';

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
  | { type: 'open'; key: string; filename: string; mimeType: string }
  | { type: 'write'; seq: number; buffer: ArrayBuffer }
  | { type: 'close' }
  | { type: 'discard' };

/** The duration fix is an EBML operation, so it applies to audio and video alike. */
function isWebmMime(mimeType: string): boolean {
  return mimeType.startsWith('video/webm') || mimeType.startsWith('audio/webm');
}

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<InboundMessage>) => void) | null;
  postMessage(message: unknown): void;
};

let fileHandle: FileSystemFileHandle | null = null;
let accessHandle: FileSystemSyncAccessHandle | null = null;
let filename = '';
/** Where the bytes live (ADR-0006). Distinct from `filename`, the display name. */
let opfsKey = '';
let mimeType = 'video/webm';
let offset = 0;
let flushPolicy: FlushPolicy | null = null;

ctx.onmessage = async (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'open': {
        filename = msg.filename;
        opfsKey = msg.key;
        mimeType = msg.mimeType;
        const root = await navigator.storage.getDirectory();
        fileHandle = (await fileHandleForKey(root, opfsKey, { create: true })) as FileSystemFileHandle;
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
        let bytes = offset;
        let durationFixed = false;
        // Any WebM, not just video: a separate microphone opens its target as
        // `audio/webm`, and an audio track with no Duration is as unseekable as
        // a video one — the player syncs it against the tab clock.
        if (file && fileHandle && isWebmMime(mimeType)) {
          try {
            const fixed = await fixWebmDuration(file);
            // The fix inserts a Duration element rather than overwriting spare
            // bytes, so the body shifts and an in-place patch is not possible —
            // the file is rewritten whole. `createWritable` streams into a swap
            // file and only replaces the original on close, which matters here:
            // `fixed` is a lazy slice of that very file, so the read source has
            // to stay intact until the write is complete. A failure before
            // close discards the swap and leaves the original untouched.
            const writable = await fileHandle.createWritable();
            await writable.write(fixed);
            await writable.close();
            file = await fileHandle.getFile();
            bytes = file.size;
            durationFixed = true;
          } catch {
            // Leave it unfixed on disk; the main thread attempts the in-memory
            // fix as a fallback so the delivered copy is still correct.
            file = await fileHandle.getFile();
          }
        }
        if (file) file = new File([file], filename, { type: mimeType });
        ctx.postMessage({ type: 'sealed', file, bytes, durationFixed });
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
          await removeByKey(await navigator.storage.getDirectory(), opfsKey);
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
