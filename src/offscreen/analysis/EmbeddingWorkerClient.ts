/**
 * @file offscreen/analysis/EmbeddingWorkerClient.ts
 *
 * The offscreen-side handle on the embedding worker (HOST-01), mirroring
 * `WorkerStorageTarget` structurally: a hand-rolled promise-per-seq ack map, an
 * open handshake on spawn, transferable `ArrayBuffer`s, and a static
 * `unsupported` latch that probes once and stays latched for the session.
 *
 * **What this adds over the raw protocol** is the part a caller should not have
 * to repeat: spawning, the URL knowledge the worker deliberately does not have,
 * splitting a returned row-major block back into per-window vectors, and
 * failing every in-flight request when the worker dies rather than leaving
 * promises hanging.
 *
 * **The device ladder is reported, never inferred** (RES-06, RES-08). The
 * worker walks `webgpu → wasm` internally and answers with what actually
 * loaded; when that is below what was asked for, this client calls
 * `reportWarning` — the house rule established by `WorkerStorageTarget`, where
 * a downgrade is surfaced rather than taken silently.
 */

import type { Embedding } from '../../shared/analysis/types';
import type { EmbeddingDtype } from '../../shared/analysis/provenance';
import type {
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
  EmbeddingDevice,
} from './analysisWorkerProtocol';

/** Where the packaged artifacts live, and what to load from them. */
export type EmbeddingEngineConfig = {
  modelBaseUrl: string;
  wasmBaseUrl: string;
  modelId: string;
  dtype: EmbeddingDtype;
  /** The rung to attempt first; the worker falls through to `wasm` on failure. */
  preferredDevice?: EmbeddingDevice;
};

export type EmbeddingWorkerDeps = {
  /** Spawns the worker. Injected so tests can drive a fake without a bundle. */
  spawn: () => Worker;
  /** Surfaced downgrades and faults; mirrors `WorkerStorageTarget`'s rule. */
  reportWarning?: (message: string) => void;
  /** Bounds the model load, which is the one step that can wedge silently. */
  openTimeoutMs?: number;
  /** Bounds a single batch. Generous: a WASM batch on a cold machine is slow. */
  embedTimeoutMs?: number;
};

/** What the worker answered with when it opened — the provenance-bearing facts. */
export type EmbeddingEngineInfo = {
  device: EmbeddingDevice;
  dimensions: number;
  dtype: EmbeddingDtype;
  loadMs: number;
};

const DEFAULT_OPEN_TIMEOUT_MS = 120_000;
const DEFAULT_EMBED_TIMEOUT_MS = 120_000;

/**
 * Session-wide latch: once the worker path has been probed and found unusable
 * — no `Worker` constructor, a bundle that will not load, a machine with
 * neither backend — every later attempt fails fast instead of re-paying the
 * load cost. Same idiom as `WorkerStorageTarget.unsupported`.
 */
let embeddingWorkerUnsupported = false;

type PendingRequest = {
  resolve: (response: AnalysisWorkerResponse) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class EmbeddingWorkerClient {
  private seq = 0;
  private failure: Error | null = null;
  private disposed = false;
  private readonly pending = new Map<number, PendingRequest>();

  private constructor(
    private readonly worker: Worker,
    private readonly deps: EmbeddingWorkerDeps,
    readonly info: EmbeddingEngineInfo,
  ) {
    worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => this.settle(event.data);
    worker.onerror = () => this.fail(new Error('The embedding worker crashed'));
  }

  /** True once the embedding path has been found unusable for this session. */
  static get unsupported(): boolean {
    return embeddingWorkerUnsupported;
  }

  /** Clears the latch. For tests; production has no reason to retry a hard failure. */
  static resetUnsupported(): void {
    embeddingWorkerUnsupported = false;
  }

  /**
   * Spawns the worker and completes the open handshake, resolving only once a
   * backend has loaded *and* produced a probe vector — so a client that exists
   * is a client that can embed.
   */
  static async create(
    config: EmbeddingEngineConfig,
    deps: EmbeddingWorkerDeps,
  ): Promise<EmbeddingWorkerClient> {
    if (embeddingWorkerUnsupported) throw new Error('The embedding engine is unavailable on this machine');

    let worker: Worker;
    try {
      worker = deps.spawn();
    } catch (error) {
      embeddingWorkerUnsupported = true;
      throw error instanceof Error ? error : new Error(String(error));
    }

    const requested = config.preferredDevice ?? 'webgpu';
    try {
      const opened = await openHandshake(worker, config, requested, deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
      if (opened.device !== requested) {
        // Not a fault — a machine without WebGPU is an ordinary tier — but the
        // user is about to wait considerably longer, so say so (RES-06).
        deps.reportWarning?.(
          `Topic analysis is running on ${opened.device} rather than ${requested}; it will be slower but produces the same topics.`,
        );
      }
      return new EmbeddingWorkerClient(worker, deps, opened);
    } catch (error) {
      worker.terminate();
      // Neither rung loaded: this machine cannot embed at all, so stop paying
      // the attempt for the rest of the session.
      embeddingWorkerUnsupported = true;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Embeds one batch of window texts, in order.
   *
   * The worker returns a single row-major block; splitting it here means the
   * transfer stays one buffer rather than N, and the caller receives the
   * `Embedding[]` that `analyzeTranscript`'s `EncodeBatch` expects.
   */
  async embed(texts: string[]): Promise<Embedding[]> {
    if (this.failure) throw this.failure;
    if (this.disposed) throw new Error('The embedding worker client is disposed');
    if (!texts.length) return [];

    const response = await this.request({ type: 'EMBED', seq: this.nextSeq(), texts });
    if (response.type === 'ERROR') throw new Error(response.error);
    if (response.type !== 'EMBEDDED') throw new Error(`Unexpected embedding reply: ${response.type}`);
    if (response.count !== texts.length) {
      throw new Error(`The embedding worker returned ${response.count} vectors for ${texts.length} texts`);
    }
    if (response.dimensions !== this.info.dimensions) {
      // A width change mid-session would silently corrupt every stored vector's
      // comparability, so refuse it rather than let it through.
      throw new Error(
        `The embedding worker returned ${response.dimensions}-dimensional vectors, expected ${this.info.dimensions}`,
      );
    }

    const block = new Float32Array(response.vectors);
    const vectors: Embedding[] = [];
    for (let i = 0; i < response.count; i += 1) {
      // `slice`, not `subarray`: each vector must own its bytes, because these
      // outlive the batch and some are stored.
      vectors.push(block.slice(i * response.dimensions, (i + 1) * response.dimensions));
    }
    return vectors;
  }

  /** An `EncodeBatch` bound to this client, for `analyzeTranscript`. */
  encoder(): (texts: string[]) => Promise<Embedding[]> {
    return (texts) => this.embed(texts);
  }

  /** Terminates the worker and rejects anything still in flight. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new Error('The embedding worker was disposed'));
    this.worker.terminate();
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private request(message: AnalysisWorkerRequest): Promise<AnalysisWorkerResponse> {
    const timeoutMs = this.deps.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
    return new Promise<AnalysisWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.seq);
        // A wedged worker never answers; without this the job above would wait
        // forever and its outbox entry would never reach a terminal state.
        this.fail(new Error(`The embedding worker did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(message.seq, { resolve, reject, timer });
      try {
        this.worker.postMessage(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.seq);
        reject(error);
      }
    });
  }

  private settle(response: AnalysisWorkerResponse): void {
    const pending = this.pending.get(response.seq);
    if (!pending) return;
    this.pending.delete(response.seq);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Sends `OPEN` and resolves on `OPENED`.
 *
 * Separate from the instance's ack map on purpose: until this resolves there is
 * no instance, and the handshake has its own budget — loading an ONNX graph is
 * the slowest thing in the pipeline by an order of magnitude.
 */
function openHandshake(
  worker: Worker,
  config: EmbeddingEngineConfig,
  device: EmbeddingDevice,
  timeoutMs: number,
): Promise<EmbeddingEngineInfo> {
  return new Promise<EmbeddingEngineInfo>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`The embedding worker did not open within ${timeoutMs} ms`));
    }, timeoutMs);

    const onMessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const data = event.data;
      if (data?.type === 'OPENED') {
        cleanup();
        resolve({ device: data.device, dimensions: data.dimensions, dtype: data.dtype, loadMs: data.loadMs });
      } else if (data?.type === 'ERROR') {
        cleanup();
        reject(new Error(`The embedding worker could not open: ${data.error}`));
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error('The embedding worker failed to load'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage as EventListener);
      worker.removeEventListener('error', onError as EventListener);
    };

    worker.addEventListener('message', onMessage as EventListener);
    worker.addEventListener('error', onError as EventListener);
    worker.postMessage({
      type: 'OPEN',
      seq: 0,
      modelBaseUrl: config.modelBaseUrl,
      wasmBaseUrl: config.wasmBaseUrl,
      modelId: config.modelId,
      device,
      dtype: config.dtype,
    } satisfies AnalysisWorkerRequest);
  });
}
