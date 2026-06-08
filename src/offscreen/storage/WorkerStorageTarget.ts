/**
 * @file offscreen/storage/WorkerStorageTarget.ts
 *
 * Main-thread StorageTarget that hands OPFS writes to opfsWorker.ts. Each chunk's
 * ArrayBuffer is transferred (zero-copy) to the worker, which writes it in-place
 * via a synchronous FileSystemSyncAccessHandle. This keeps disk I/O off the
 * offscreen main thread, which is busy with capture, encoding, and the audio
 * bridge. Falls back (via the factory in offscreen.ts) to LocalFileTarget when
 * Workers or OPFS sync-access are unavailable.
 */

import type { SealedStorageFile, StorageTarget } from '../engine/RecorderEngineTypes';
import type { RecordingStream } from '../../shared/recording';
import { debugPerf, nowMs, roundMs } from '../../shared/perf';

type WorkerOutbound =
  | { type: 'opened' }
  | { type: 'written'; seq: number; bytes: number }
  | { type: 'sealed'; file: File | null; bytes: number }
  | { type: 'discarded' }
  | { type: 'error'; op: string; message: string };

/** Cached capability probe: once the worker path fails, skip it for the session. */
let workerStorageUnsupported = false;

export class WorkerStorageTarget implements StorageTarget {
  private writeChain: Promise<void> = Promise.resolve();
  private seq = 0;
  private writtenBytes = 0;
  private pendingWrites = 0;
  private peakPendingWrites = 0;
  private closed = false;
  private failure: Error | null = null;
  private sealed: SealedStorageFile | null = null;
  private readonly writeAcks = new Map<number, { resolve: () => void; reject: (e: unknown) => void }>();
  private settleSeal: ((file: File | null) => void) | null = null;
  private rejectSeal: ((e: unknown) => void) | null = null;
  private settleDiscard: (() => void) | null = null;

  private constructor(
    private readonly worker: Worker,
    private readonly filename: string,
    private readonly stream?: RecordingStream,
  ) {
    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => this.onMessage(event.data);
    worker.onerror = () => this.fail(new Error('opfsWorker crashed'));
  }

  /** True once the worker/OPFS-sync path has been probed and found unusable. */
  static get unsupported(): boolean {
    return workerStorageUnsupported;
  }

  /** Spawns a worker, opens the file, and resolves once it is ready to receive writes. */
  static async create(filename: string, stream?: RecordingStream): Promise<WorkerStorageTarget> {
    if (workerStorageUnsupported) throw new Error('worker OPFS storage unavailable');
    if (typeof Worker === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime?.getURL) {
      workerStorageUnsupported = true;
      throw new Error('Worker or chrome.runtime.getURL unavailable');
    }

    const startedAt = nowMs();
    const worker = new Worker(chrome.runtime.getURL('opfsWorker.js'));
    try {
      await openHandshake(worker, filename);
    } catch (error) {
      worker.terminate();
      // createSyncAccessHandle is unsupported here — stop trying for the session.
      workerStorageUnsupported = true;
      throw error;
    }

    debugPerf(console.log, 'storage', 'opfs_opened', {
      stream,
      durationMs: roundMs(nowMs() - startedAt),
      pendingWrites: 0,
      worker: true,
    });
    return new WorkerStorageTarget(worker, filename, stream);
  }

  write(chunk: Blob): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Worker storage target is closed'));
    if (this.failure) return Promise.reject(this.failure);

    const seq = ++this.seq;
    this.pendingWrites += 1;
    this.peakPendingWrites = Math.max(this.peakPendingWrites, this.pendingWrites);
    const startedAt = nowMs();

    // Serialize like LocalFileTarget so a write's postMessage can never reorder
    // past close(), and so close() can await the full chain.
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        if (this.failure) throw this.failure;
        const buffer = await chunk.arrayBuffer();
        await new Promise<void>((resolve, reject) => {
          this.writeAcks.set(seq, { resolve, reject });
          this.worker.postMessage({ type: 'write', seq, buffer }, [buffer]);
        });
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
          peakPendingWrites: this.peakPendingWrites,
          worker: true,
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

    let file: File | null = null;
    try {
      file = await new Promise<File | null>((resolve, reject) => {
        this.settleSeal = resolve;
        this.rejectSeal = reject;
        this.worker.postMessage({ type: 'close' });
      });
    } catch (error) {
      debugPerf(console.log, 'storage', 'opfs_closed', {
        stream: this.stream,
        durationMs: roundMs(nowMs() - closeStartedAt),
        artifactBytes: this.writtenBytes,
        pendingWrites: this.pendingWrites,
        worker: true,
        failed: true,
      });
      this.worker.terminate();
      throw error;
    }

    debugPerf(console.log, 'storage', 'opfs_closed', {
      stream: this.stream,
      durationMs: roundMs(nowMs() - closeStartedAt),
      artifactBytes: this.writtenBytes,
      pendingWrites: this.pendingWrites,
      worker: true,
    });

    if (!file || this.writtenBytes === 0) {
      await this.discardInternal();
      this.worker.terminate();
      return null;
    }

    this.sealed = {
      filename: this.filename,
      file,
      opfsFilename: this.filename,
      cleanup: async () => {
        await this.discardInternal();
        this.worker.terminate();
      },
    };
    return this.sealed;
  }

  private discardInternal(): Promise<void> {
    const startedAt = nowMs();
    return new Promise<void>((resolve) => {
      this.settleDiscard = () => {
        debugPerf(console.log, 'storage', 'opfs_cleanup', {
          stream: this.stream,
          durationMs: roundMs(nowMs() - startedAt),
          worker: true,
        });
        resolve();
      };
      this.worker.postMessage({ type: 'discard' });
    });
  }

  private onMessage(msg: WorkerOutbound): void {
    switch (msg.type) {
      case 'written': {
        const ack = this.writeAcks.get(msg.seq);
        if (ack) {
          this.writeAcks.delete(msg.seq);
          ack.resolve();
        }
        break;
      }
      case 'sealed': {
        this.settleSeal?.(msg.file);
        this.settleSeal = null;
        this.rejectSeal = null;
        break;
      }
      case 'discarded': {
        this.settleDiscard?.();
        this.settleDiscard = null;
        break;
      }
      case 'error': {
        this.fail(new Error(`opfsWorker ${msg.op}: ${msg.message}`));
        break;
      }
    }
  }

  /** Rejects every in-flight write/close so no promise hangs after a worker error. */
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const { reject } of this.writeAcks.values()) reject(error);
    this.writeAcks.clear();
    this.rejectSeal?.(error);
    this.settleSeal = null;
    this.rejectSeal = null;
  }
}

/** Sends `open` and resolves on the worker's `opened`; rejects on error or load failure. */
function openHandshake(worker: Worker, filename: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerOutbound>) => {
      const data = event.data;
      if (data?.type === 'opened') {
        cleanup();
        resolve();
      } else if (data?.type === 'error') {
        cleanup();
        reject(new Error(`opfsWorker open: ${data.message}`));
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error('opfsWorker failed to load'));
    };
    const cleanup = () => {
      worker.removeEventListener('message', onMessage as EventListener);
      worker.removeEventListener('error', onError as EventListener);
    };
    worker.addEventListener('message', onMessage as EventListener);
    worker.addEventListener('error', onError as EventListener);
    worker.postMessage({ type: 'open', filename });
  });
}
