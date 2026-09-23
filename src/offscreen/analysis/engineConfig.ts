/**
 * @file offscreen/analysis/engineConfig.ts
 *
 * Where this extension's packaged analysis artifacts live.
 *
 * Only the **URLs** — which only an extension context can form. The model's
 * *identity* is `shared/analysis/packagedModel`, because the control plane
 * needs it too and the two must not disagree about what ran.
 */

import { packagedModel } from '../../shared/analysis/packagedModel';
import type { EmbeddingEngineConfig } from './EmbeddingWorkerClient';

/** Where webpack's CopyPlugin puts the model and the ONNX Runtime binaries. */
const MODEL_DIRECTORY = 'models/';
const WASM_DIRECTORY = 'ort/';
const WORKER_SCRIPT = 'analysisWorker.js';

/** The engine configuration for this extension's packaged artifacts. */
export function analysisEngineConfig(getURL: (path: string) => string): EmbeddingEngineConfig {
  const model = packagedModel();
  return {
    modelBaseUrl: getURL(MODEL_DIRECTORY),
    wasmBaseUrl: getURL(WASM_DIRECTORY),
    modelId: model.id,
    dtype: model.dtype,
    // WebGPU first; EmbeddingWorkerClient retries WASM in a fresh worker if
    // WebGPU fails or exhausts its bounded share of the open budget (RES-06).
    preferredDevice: 'webgpu',
  };
}

/** Spawns the packaged embedding worker. */
export function spawnAnalysisWorker(getURL: (path: string) => string): Worker {
  return new Worker(getURL(WORKER_SCRIPT));
}
