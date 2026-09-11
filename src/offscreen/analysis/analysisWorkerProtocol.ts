/**
 * @file offscreen/analysis/analysisWorkerProtocol.ts
 *
 * The wire between the offscreen document and the embedding worker.
 *
 * Deliberately tiny, and deliberately free of `chrome.*`: the worker is a plain
 * computation environment that is *told* where its artifacts are, rather than
 * one that reaches for `chrome.runtime.getURL()` itself. That keeps it
 * testable outside an extension, and keeps the extension-specific knowledge in
 * the one place that already has it.
 */

import type { EmbeddingDtype } from '../../shared/analysis/provenance';

/** Which backend to attempt. `wasm` is the floor every machine has (RES-06). */
export type EmbeddingDevice = 'webgpu' | 'wasm';

export type AnalysisWorkerOpen = {
  type: 'OPEN';
  seq: number;
  /** Extension URL of the directory holding `<model id>/…`. */
  modelBaseUrl: string;
  /** Extension URL of the directory holding the ONNX Runtime `.wasm` files. */
  wasmBaseUrl: string;
  modelId: string;
  device: EmbeddingDevice;
  dtype: EmbeddingDtype;
};

export type AnalysisWorkerEmbed = {
  type: 'EMBED';
  seq: number;
  texts: string[];
};

export type AnalysisWorkerRequest = AnalysisWorkerOpen | AnalysisWorkerEmbed;

export type AnalysisWorkerOpened = {
  type: 'OPENED';
  seq: number;
  /** The backend that actually loaded, which may not be the one requested. */
  device: EmbeddingDevice;
  dimensions: number;
  loadMs: number;
};

export type AnalysisWorkerEmbedded = {
  type: 'EMBEDDED';
  seq: number;
  /** Row-major `count × dimensions`, transferred rather than copied. */
  vectors: ArrayBuffer;
  count: number;
  dimensions: number;
  embedMs: number;
};

export type AnalysisWorkerError = { type: 'ERROR'; seq: number; error: string };

export type AnalysisWorkerResponse =
  | AnalysisWorkerOpened
  | AnalysisWorkerEmbedded
  | AnalysisWorkerError;
