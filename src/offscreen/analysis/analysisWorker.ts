/**
 * @file offscreen/analysis/analysisWorker.ts
 *
 * The embedding engine: a dedicated Worker owned by the offscreen document
 * (ADR-0007 Decision 5, HOST-01), mirroring `opfsWorker`.
 *
 * **The analysis path has no network dependency.** Stated precisely, because
 * the stronger-sounding claim is not true: a worker still has `fetch`. What is
 * enforced is that everything this path loads — model, tokenizer, config, ONNX
 * Runtime WASM — is a `chrome-extension://` URL handed in by its parent, with
 * `allowRemoteModels = false` so a misconfigured path fails loudly instead of
 * quietly reaching a CDN. `tests/e2e/analysis-embedding.spec.ts` confirms it
 * from the outside by blocking all outbound HTTP(S) and still getting vectors.
 *
 * Hand-rolled promise-per-seq protocol, like `opfsWorker`, rather than a
 * library: one more dependency in a worker that already carries an ML runtime
 * is not worth the ergonomics.
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { toEncoderInput } from '../../shared/analysis/encoderInput';
import type { EmbeddingDtype } from '../../shared/analysis/provenance';
import { buildTokenBoundedContextWindows } from '../../shared/analysis/tokenBoundedWindows';
import { meanPoolingLocality } from './meanPooling';
import type {
  AnalysisWorkerOpen,
  AnalysisPoolingMode,
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
  EmbeddingDevice,
} from './analysisWorkerProtocol';

/**
 * The worker global. `WebWorker` is absent from the `lib` this project targets
 * (it conflicts with `DOM`, which every other context needs), so the minimal
 * surface is declared here — the same idiom `opfsWorker` uses for
 * `FileSystemSyncAccessHandle`. BLD-05 replaces both with a worker tsconfig.
 */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<AnalysisWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let extractor: FeatureExtractionPipeline | undefined;
let dimensions = 0;
let maxTokens = 0;
let activeDevice: EmbeddingDevice = 'wasm';
let activeDtype: EmbeddingDtype = 'q8';
let activePoolingMode: AnalysisPoolingMode = 'transformers';

function post(message: AnalysisWorkerResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}

function configure(request: AnalysisWorkerOpen): void {
  // No remote resolution, ever. The model is packaged; if a path is wrong we
  // want a loud failure, not a silent download (BLD-06).
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = request.modelBaseUrl;

  const onnx = env.backends?.onnx;
  if (onnx?.wasm) {
    onnx.wasm.wasmPaths = request.wasmBaseUrl;
    // Threaded ORT needs SharedArrayBuffer, which needs cross-origin isolation.
    // An extension *can* opt into that with `cross_origin_embedder_policy` and
    // `cross_origin_opener_policy`; this one currently does not, so the WASM
    // fallback is single-threaded. If that proves too slow, COOP/COEP is its
    // own optimization spike rather than a rider on this one.
    onnx.wasm.numThreads = 1;
  }
}

async function load(request: AnalysisWorkerOpen): Promise<void> {
  const started = performance.now();
  configure(request);

  const attempts: EmbeddingDevice[] = request.allowFallback !== false && request.device === 'webgpu'
    ? ['webgpu', 'wasm']
    : [request.device];
  let lastError: unknown;

  for (const device of attempts) {
    let candidate: FeatureExtractionPipeline | undefined;
    try {
      candidate = await pipeline('feature-extraction', request.modelId, {
        device,
        dtype: request.dtype,
      }) as FeatureExtractionPipeline;

      // Probe inside the attempt, not after it. A backend can initialize and
      // then fail on its first inference — a driver that advertises WebGPU but
      // cannot run this graph — and a probe outside the loop would report that
      // as a hard failure instead of falling through to WASM.
      const poolingMode = request.poolingMode ?? 'transformers';
      const probe = await runEmbedding(candidate, [toEncoderInput('probe')], poolingMode);

      const tokenizerLimit = positiveInteger(candidate.tokenizer.model_max_length);
      const modelLimit = positiveInteger((candidate.model.config as { max_position_embeddings?: unknown }).max_position_embeddings);
      if (!tokenizerLimit || !modelLimit) {
        throw new Error('The packaged embedding artifacts do not declare a finite token limit');
      }

      extractor = candidate;
      activeDevice = device;
      activePoolingMode = poolingMode;
      dimensions = (probe.dims as number[])[1];
      maxTokens = Math.min(tokenizerLimit, modelLimit);
      lastError = undefined;
      break;
    } catch (error) {
      // A machine without WebGPU is an ordinary tier, not a fault (RES-06,
      // RES-08): release whatever was half-built and fall through to WASM.
      await candidate?.dispose?.().catch(() => {});
      lastError = error;
    }
  }
  if (!extractor) throw lastError instanceof Error ? lastError : new Error(String(lastError));

  activeDtype = request.dtype;
  post({
    type: 'OPENED',
    seq: request.seq,
    // Reported, never inferred from timing: a caller must be able to tell which
    // rung of the ladder actually loaded (RES-06, RES-08).
    device: activeDevice,
    dimensions,
    dtype: activeDtype,
    maxTokens,
    loadMs: Math.round(performance.now() - started),
  });
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function tokenLength(text: string): number {
  if (!extractor) throw new Error('The embedding worker was asked to tokenize before it was opened');
  return extractor.tokenizer.encode(toEncoderInput(text), { add_special_tokens: true }).length;
}

async function embed(texts: string[]): Promise<{ data: Float32Array; count: number; dimensions: number }> {
  if (!extractor) throw new Error('The embedding worker was asked to embed before it was opened');

  const output = await runEmbedding(extractor, texts, activePoolingMode);
  const [count, width] = output.dims as [number, number];
  return { data: Float32Array.from(output.data as ArrayLike<number>), count, dimensions: width };
}

async function runEmbedding(
  candidate: FeatureExtractionPipeline,
  texts: string[],
  poolingMode: AnalysisPoolingMode,
): Promise<Awaited<ReturnType<FeatureExtractionPipeline['model']>>[string]> {
  // Production keeps Transformers.js' installed pooling by default. The two
  // alternatives exist only for ADR-0009 adoption tests and are fixed for the
  // worker session during OPEN so graph and post-processing cannot disagree.
  if (poolingMode === 'transformers') {
    return candidate(texts, { pooling: 'mean', normalize: true });
  }
  if (poolingMode === 'pooled-onnx') return pooledOnnx(candidate, texts);

  const modelInputs = candidate.tokenizer(texts, { padding: true, truncation: true });
  const modelOutputs = await candidate.model(modelInputs);
  if (!modelOutputs.last_hidden_state) {
    throw new Error('The locality pooling experiment requires last_hidden_state');
  }
  return meanPoolingLocality(modelOutputs.last_hidden_state, modelInputs.attention_mask).normalize(2, -1);
}

async function pooledOnnx(
  candidate: FeatureExtractionPipeline,
  texts: string[],
): Promise<Awaited<ReturnType<FeatureExtractionPipeline['model']>>[string]> {
  const modelInputs = candidate.tokenizer(texts, { padding: true, truncation: true });
  const modelOutputs = await candidate.model(modelInputs);
  // Keep the ordinary BertModel output name when building the experimental
  // graph. Transformers.js tolerates arbitrary output rank but some model-path
  // plumbing assumes the canonical name. Rank is the fence: the production
  // graph exposes [batch, tokens, width], while TECH-03's graph exposes the
  // already pooled [batch, width] tensor.
  const output = modelOutputs.sentence_embedding ?? modelOutputs.last_hidden_state;
  if (!output || output.dims.length !== 2) {
    throw new Error('The pooled ONNX experiment requires one rank-2 sentence embedding output');
  }
  return output;
}

ctx.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      if (request.type === 'OPEN') {
        await load(request);
        return;
      }
      if (request.type === 'PREPARE_WINDOWS') {
        if (!extractor || !maxTokens) throw new Error('The embedding worker was asked to prepare windows before it was opened');
        post({
          type: 'PREPARED_WINDOWS',
          seq: request.seq,
          windows: buildTokenBoundedContextWindows(
            request.segments,
            request.config,
            maxTokens,
            tokenLength,
          ),
        });
        return;
      }
      const started = performance.now();
      const { data, count, dimensions: width } = await embed(request.texts.map(toEncoderInput));
      post({
        type: 'EMBEDDED',
        seq: request.seq,
        vectors: data.buffer as ArrayBuffer,
        count,
        dimensions: width,
        embedMs: Math.round(performance.now() - started),
      }, [data.buffer as ArrayBuffer]);
    } catch (error) {
      post({
        type: 'ERROR',
        seq: request.seq,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
