/**
 * Unit tests for WorkerStorageTarget. A FakeWorker stands in for opfsWorker.ts,
 * auto-responding to the open/write/close/discard protocol so the target can be
 * exercised end-to-end without a real Worker or OPFS (mirrors LocalFileTarget.test).
 */

import { TIMEOUTS } from '../../../shared/timeouts';

type Behavior = 'normal' | 'openError' | 'writeError' | 'sealHang';

/**
 * jsdom's Blob has no arrayBuffer(); real MediaRecorder chunks in the offscreen
 * document do. Build a chunk that backs arrayBuffer() with its real bytes.
 */
function chunk(text: string): Blob {
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
  const blob = new Blob([bytes]);
  (blob as any).arrayBuffer = async () => bytes.buffer.slice(0);
  return blob;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  static behavior: Behavior = 'normal';

  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  readonly posted: any[] = [];
  readonly transfers: any[][] = [];
  terminated = false;
  private readonly listeners: Record<string, Function[]> = { message: [], error: [] };
  private bytes = 0;

  constructor(public readonly url: string) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, fn: Function) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type: string, fn: Function) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  terminate() { this.terminated = true; }

  private emit(data: any) {
    const event = { data };
    this.onmessage?.(event);
    for (const fn of [...(this.listeners.message || [])]) fn(event);
  }

  postMessage(msg: any, transfer?: any[]) {
    this.posted.push(msg);
    if (transfer) this.transfers.push(transfer);
    queueMicrotask(() => {
      if (msg.type === 'open') {
        FakeWorker.behavior === 'openError'
          ? this.emit({ type: 'error', op: 'open', message: 'no sync access' })
          : this.emit({ type: 'opened' });
      } else if (msg.type === 'write') {
        if (FakeWorker.behavior === 'writeError') {
          this.emit({ type: 'error', op: 'write', message: 'write failed' });
        } else {
          const bytes = new Uint8Array(msg.buffer).byteLength;
          this.bytes += bytes;
          this.emit({ type: 'written', seq: msg.seq, bytes });
        }
      } else if (msg.type === 'close') {
        if (FakeWorker.behavior === 'sealHang') return; // wedged: never reply 'sealed'
        const file = this.bytes > 0 ? new File([new Uint8Array(this.bytes)], 'seal', { type: 'video/webm' }) : null;
        // The worker runs the duration fix in-thread before sealing.
        this.emit({ type: 'sealed', file, bytes: this.bytes, durationFixed: this.bytes > 0 });
      } else if (msg.type === 'discard') {
        this.emit({ type: 'discarded' });
      }
    });
  }
}

describe('WorkerStorageTarget', () => {
  let WorkerStorageTarget: typeof import('../WorkerStorageTarget').WorkerStorageTarget;

  beforeEach(() => {
    jest.resetModules(); // resets the module-level capability cache between tests
    FakeWorker.instances = [];
    FakeWorker.behavior = 'normal';
    (global as any).Worker = FakeWorker;
    (global as any).chrome = {
      ...(global as any).chrome,
      runtime: { ...((global as any).chrome?.runtime), getURL: (p: string) => `chrome-extension://test/${p}` },
    };
    WorkerStorageTarget = require('../../../offscreen/storage/WorkerStorageTarget').WorkerStorageTarget;
  });

  it('spawns a worker at the extension URL and opens the file', async () => {
    const target = await WorkerStorageTarget.create('rec.webm', 'tab');
    expect(target).toBeTruthy();
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].url).toBe('chrome-extension://test/opfsWorker.js');
    expect(FakeWorker.instances[0].posted[0]).toEqual({ type: 'open', filename: 'rec.webm' });
  });

  it('transfers chunk buffers (zero-copy) to the worker and resolves each write', async () => {
    const target = await WorkerStorageTarget.create('rec.webm');
    const worker = FakeWorker.instances[0];

    await target.write(chunk('hello'));
    await target.write(chunk('world!'));

    const writes = worker.posted.filter((m) => m.type === 'write');
    expect(writes).toHaveLength(2);
    expect(writes[0].seq).toBe(1);
    expect(writes[1].seq).toBe(2);
    // each write posted its ArrayBuffer in the transfer list
    expect(worker.transfers).toHaveLength(2);
    expect(worker.transfers[0][0]).toBe(writes[0].buffer);
  });

  it('returns a sealed artifact on close and discards on cleanup', async () => {
    const target = await WorkerStorageTarget.create('rec.webm', 'tab');
    const worker = FakeWorker.instances[0];
    await target.write(chunk('abc'));

    const artifact = await target.close();
    expect(artifact?.filename).toBe('rec.webm');
    expect(artifact?.opfsFilename).toBe('rec.webm');
    expect(artifact?.file).toBeInstanceOf(File);
    expect(artifact?.durationFixed).toBe(true); // worker fixed duration in-thread
    expect(worker.posted.some((m) => m.type === 'close')).toBe(true);

    await artifact?.cleanup();
    expect(worker.posted.some((m) => m.type === 'discard')).toBe(true);
    expect(worker.terminated).toBe(true);
  });

  it('returns null and discards when no bytes were written', async () => {
    const target = await WorkerStorageTarget.create('empty.webm');
    const worker = FakeWorker.instances[0];

    const artifact = await target.close();
    expect(artifact).toBeNull();
    expect(worker.posted.some((m) => m.type === 'discard')).toBe(true);
    expect(worker.terminated).toBe(true);
  });

  it('rejects and marks the worker path unsupported when open fails (capability probe)', async () => {
    FakeWorker.behavior = 'openError';
    await expect(WorkerStorageTarget.create('rec.webm')).rejects.toThrow(/open/);
    expect(WorkerStorageTarget.unsupported).toBe(true);
    expect(FakeWorker.instances[0].terminated).toBe(true);

    // Once unsupported, a subsequent create short-circuits without spawning a worker.
    FakeWorker.behavior = 'normal';
    const before = FakeWorker.instances.length;
    await expect(WorkerStorageTarget.create('rec2.webm')).rejects.toThrow(/unavailable/);
    expect(FakeWorker.instances).toHaveLength(before);
  });

  it('rejects in-flight writes if the worker reports an error', async () => {
    const target = await WorkerStorageTarget.create('rec.webm');
    FakeWorker.behavior = 'writeError';
    await expect(target.write(chunk('x'))).rejects.toThrow(/write failed/);
  });

  it('rejects writes after close', async () => {
    const target = await WorkerStorageTarget.create('rec.webm');
    await target.close();
    await expect(target.write(new Blob(['x']))).rejects.toThrow(/closed/);
  });

  it('fails close() fast when the worker already failed, without awaiting a seal', async () => {
    const target = await WorkerStorageTarget.create('rec.webm');
    FakeWorker.behavior = 'writeError';
    await expect(target.write(chunk('x'))).rejects.toThrow(/write failed/);

    // The worker is in a failed state; close() must not post a 'close' it can never
    // be answered, nor hang waiting for a 'sealed' reply — it fails fast + terminates.
    await expect(target.close()).rejects.toThrow(/write failed/);
    const worker = FakeWorker.instances[0];
    expect(worker.terminated).toBe(true);
    expect(worker.posted.some((m) => m.type === 'close')).toBe(false);
  });

  it('times out a wedged seal instead of hanging close() forever', async () => {
    // Set up with real timers (create/write rely on microtask replies), then fake
    // only the seal wait so the size-scaled budget can be advanced deterministically.
    const target = await WorkerStorageTarget.create('rec.webm');
    await target.write(chunk('abc'));
    FakeWorker.behavior = 'sealHang';

    jest.useFakeTimers();
    try {
      const closePromise = target.close();
      closePromise.catch(() => {}); // avoid an unhandled rejection while advancing
      await jest.advanceTimersByTimeAsync(TIMEOUTS.SEAL_BASE_MS + 5_000);
      await expect(closePromise).rejects.toThrow(/timed out/);
      expect(FakeWorker.instances[0].terminated).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
