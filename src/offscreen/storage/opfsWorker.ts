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
 */

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
        ctx.postMessage({ type: 'opened' });
        break;
      }
      case 'write': {
        if (!accessHandle) throw new Error('write before open');
        const view = new Uint8Array(msg.buffer);
        accessHandle.write(view, { at: offset });
        offset += view.byteLength;
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
        const file = offset > 0 && fileHandle ? await fileHandle.getFile() : null;
        ctx.postMessage({ type: 'sealed', file, bytes: offset });
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
