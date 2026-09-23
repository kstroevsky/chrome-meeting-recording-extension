import { EmbeddingWorkerClient } from '../EmbeddingWorkerClient';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from '../analysisWorkerProtocol';

/**
 * A worker double that records what it was asked and answers on demand. Using
 * the real `EventTarget` semantics matters: the open handshake attaches and
 * detaches listeners, and a leak there would show up only under load.
 */
class FakeWorker extends EventTarget {
  readonly sent: AnalysisWorkerRequest[] = [];
  onmessage: ((event: MessageEvent<AnalysisWorkerResponse>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  /** Set to throw on the next postMessage, for the transport-failure case. */
  postThrows: Error | null = null;

  postMessage(message: AnalysisWorkerRequest): void {
    if (this.postThrows) throw this.postThrows;
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: AnalysisWorkerResponse, transfer: ArrayBuffer[] = []): void {
    const event = new MessageEvent('message', { data: response });
    this.dispatchEvent(event);
    this.onmessage?.(event as MessageEvent<AnalysisWorkerResponse>);
    void transfer;
  }

  crash(): void {
    this.onerror?.(new Error('boom'));
  }

  /** How many listeners the handshake left behind. */
  get listenerCount(): number {
    return this.trackedListeners;
  }

  private trackedListeners = 0;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    this.trackedListeners += 1;
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    this.trackedListeners -= 1;
    super.removeEventListener(type, listener, options);
  }
}

const CONFIG = {
  modelBaseUrl: 'chrome-extension://x/models/',
  wasmBaseUrl: 'chrome-extension://x/ort/',
  modelId: 'Xenova/multilingual-e5-small',
  dtype: 'q8' as const,
};

function opened(overrides: Partial<Extract<AnalysisWorkerResponse, { type: 'OPENED' }>> = {}) {
  return {
    type: 'OPENED' as const,
    seq: 0,
    device: 'webgpu' as const,
    dimensions: 4,
    dtype: 'q8' as const,
    loadMs: 12,
    ...overrides,
  };
}

/** Row-major block of `count × dimensions`, filled so each row is identifiable. */
function block(count: number, dimensions: number): ArrayBuffer {
  const data = new Float32Array(count * dimensions);
  for (let i = 0; i < count; i += 1) {
    for (let d = 0; d < dimensions; d += 1) data[i * dimensions + d] = i + d / 10;
  }
  return data.buffer;
}

async function openClient(worker: FakeWorker, overrides: Partial<Parameters<typeof EmbeddingWorkerClient.create>[0]> = {}) {
  const promise = EmbeddingWorkerClient.create({ ...CONFIG, ...overrides }, { spawn: () => worker as unknown as Worker });
  await Promise.resolve();
  worker.reply(opened());
  return promise;
}

describe('EmbeddingWorkerClient', () => {
  beforeEach(() => EmbeddingWorkerClient.resetUnsupported());

  it('opens with the packaged artifact URLs the worker will not look up itself', async () => {
    const worker = new FakeWorker();
    await openClient(worker);

    expect(worker.sent[0]).toEqual({
      type: 'OPEN',
      seq: 0,
      modelBaseUrl: CONFIG.modelBaseUrl,
      wasmBaseUrl: CONFIG.wasmBaseUrl,
      modelId: CONFIG.modelId,
      device: 'webgpu',
      allowFallback: false,
      dtype: 'q8',
    });
  });

  it('falls back in a fresh worker and reports the backend that actually loaded', async () => {
    const webgpuWorker = new FakeWorker();
    const wasmWorker = new FakeWorker();
    const workers = [webgpuWorker, wasmWorker];
    let spawnIndex = 0;
    const warnings: string[] = [];
    const promise = EmbeddingWorkerClient.create(CONFIG, {
      spawn: () => workers[spawnIndex++] as unknown as Worker,
      reportWarning: (m) => warnings.push(m),
    });
    await Promise.resolve();
    webgpuWorker.reply({ type: 'ERROR', seq: 0, error: 'webgpu unavailable' });
    await Promise.resolve();
    wasmWorker.reply(opened({ device: 'wasm' }));
    const client = await promise;

    expect(webgpuWorker.terminated).toBe(true);
    expect(wasmWorker.sent[0]).toMatchObject({ device: 'wasm', allowFallback: false });
    expect(client.info.device).toBe('wasm');
    // RES-06: which rung ran is surfaced, never inferred.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('wasm');
    // It reports the backend and promises nothing else: not a slowdown (the two
    // are within each other's variance on Metal-3), and not identical topics
    // (unverified near the calibrated decision boundaries).
    expect(warnings[0]).not.toMatch(/slow/i);
    expect(warnings[0]).not.toMatch(/same topics/i);
  });

  it('stays silent when the requested backend is the one that loaded', async () => {
    const worker = new FakeWorker();
    const warnings: string[] = [];
    const promise = EmbeddingWorkerClient.create(CONFIG, {
      spawn: () => worker as unknown as Worker,
      reportWarning: (m) => warnings.push(m),
    });
    await Promise.resolve();
    worker.reply(opened());
    await promise;

    expect(warnings).toEqual([]);
  });

  it('releases its handshake listeners once open', async () => {
    const worker = new FakeWorker();
    await openClient(worker);
    expect(worker.listenerCount).toBe(0);
  });

  it('splits the returned block into one owned vector per text', async () => {
    const worker = new FakeWorker();
    const client = await openClient(worker);

    const promise = client.embed(['a', 'b', 'c']);
    await Promise.resolve();
    const vectors = block(3, 4);
    worker.reply({ type: 'EMBEDDED', seq: 1, vectors, count: 3, dimensions: 4, embedMs: 5 });

    const result = await promise;
    expect(result).toHaveLength(3);
    expect(Array.from(result[1])).toEqual([1, 1.1, 1.2, 1.3].map((v) => Math.fround(v)));
    // Each vector owns its bytes: mutating one cannot reach another.
    result[0][0] = 99;
    expect(result[1][0]).toBe(1);
  });

  it('refuses a reply whose vector count does not match the batch', async () => {
    const worker = new FakeWorker();
    const client = await openClient(worker);

    const promise = client.embed(['a', 'b']);
    await Promise.resolve();
    worker.reply({ type: 'EMBEDDED', seq: 1, vectors: block(1, 4), count: 1, dimensions: 4, embedMs: 5 });

    await expect(promise).rejects.toThrow('returned 1 vectors for 2 texts');
  });

  it('refuses a width that differs from the one it opened with', async () => {
    const worker = new FakeWorker();
    const client = await openClient(worker);

    const promise = client.embed(['a']);
    await Promise.resolve();
    worker.reply({ type: 'EMBEDDED', seq: 1, vectors: block(1, 8), count: 1, dimensions: 8, embedMs: 5 });

    // A silent width change would make stored vectors incomparable.
    await expect(promise).rejects.toThrow('8-dimensional vectors, expected 4');
  });

  it('surfaces a worker-side error as a rejection of that batch', async () => {
    const worker = new FakeWorker();
    const client = await openClient(worker);

    const promise = client.embed(['a']);
    await Promise.resolve();
    worker.reply({ type: 'ERROR', seq: 1, error: 'out of memory' });

    await expect(promise).rejects.toThrow('out of memory');
  });

  it('rejects everything in flight when the worker crashes', async () => {
    const worker = new FakeWorker();
    const client = await openClient(worker);

    const first = client.embed(['a']);
    const second = client.embed(['b']);
    await Promise.resolve();
    worker.crash();

    await expect(first).rejects.toThrow('crashed');
    await expect(second).rejects.toThrow('crashed');
    // And stays failed, rather than accepting work it cannot do.
    await expect(client.embed(['c'])).rejects.toThrow('crashed');
  });

  it('latches unsupported when neither backend opens, so later attempts fail fast', async () => {
    const webgpuWorker = new FakeWorker();
    const wasmWorker = new FakeWorker();
    const workers = [webgpuWorker, wasmWorker];
    let spawnIndex = 0;
    const promise = EmbeddingWorkerClient.create(CONFIG, {
      spawn: () => workers[spawnIndex++] as unknown as Worker,
    });
    await Promise.resolve();
    webgpuWorker.reply({ type: 'ERROR', seq: 0, error: 'webgpu unavailable' });
    await Promise.resolve();
    wasmWorker.reply({ type: 'ERROR', seq: 0, error: 'wasm unavailable' });

    await expect(promise).rejects.toThrow('wasm unavailable');
    expect(webgpuWorker.terminated).toBe(true);
    expect(wasmWorker.terminated).toBe(true);
    expect(EmbeddingWorkerClient.unsupported).toBe(true);

    let spawned = false;
    await expect(EmbeddingWorkerClient.create(CONFIG, {
      spawn: () => { spawned = true; return new FakeWorker() as unknown as Worker; },
    })).rejects.toThrow('unavailable');
    expect(spawned).toBe(false);
  });

  it('latches unsupported when the worker cannot even be spawned', async () => {
    await expect(EmbeddingWorkerClient.create(CONFIG, {
      spawn: () => { throw new Error('Worker is not defined'); },
    })).rejects.toThrow('Worker is not defined');
    expect(EmbeddingWorkerClient.unsupported).toBe(true);
  });

  it('answers an empty batch without troubling the worker', async () => {
    const worker = new FakeWorker();
    const client = await openClient(worker);
    const before = worker.sent.length;

    await expect(client.embed([])).resolves.toEqual([]);
    expect(worker.sent).toHaveLength(before);
  });

  it('fails the batch when the engine has been disposed', async () => {
    const worker = new FakeWorker();
    const client = await openClient(worker);
    client.dispose();

    expect(worker.terminated).toBe(true);
    await expect(client.embed(['a'])).rejects.toThrow('disposed');
  });

  it('times out a hung WebGPU worker and falls back to WASM in a fresh worker', async () => {
    jest.useFakeTimers();
    try {
      const webgpuWorker = new FakeWorker();
      const wasmWorker = new FakeWorker();
      const workers = [webgpuWorker, wasmWorker];
      let spawnIndex = 0;
      const promise = EmbeddingWorkerClient.create(CONFIG, {
        spawn: () => workers[spawnIndex++] as unknown as Worker,
        openTimeoutMs: 1_000,
      });
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      expect(webgpuWorker.terminated).toBe(true);
      expect(wasmWorker.sent[0]).toMatchObject({ device: 'wasm', allowFallback: false });
      wasmWorker.reply(opened({ device: 'wasm' }));
      await expect(promise).resolves.toMatchObject({ info: { device: 'wasm' } });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects when the whole backend ladder exhausts the global open budget', async () => {
    jest.useFakeTimers();
    try {
      const workers = [new FakeWorker(), new FakeWorker()];
      let spawnIndex = 0;
      const promise = EmbeddingWorkerClient.create(CONFIG, {
        spawn: () => workers[spawnIndex++] as unknown as Worker,
        openTimeoutMs: 1_000,
      });
      const assertion = expect(promise).rejects.toThrow('did not open within 500 ms');
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      jest.advanceTimersByTime(500);
      await assertion;
      expect(workers.every((worker) => worker.terminated)).toBe(true);
      expect(EmbeddingWorkerClient.unsupported).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
