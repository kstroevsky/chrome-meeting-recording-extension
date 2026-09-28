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
import type { ContextWindow } from '../../shared/analysis/types';
import type { WindowConfig } from '../../shared/analysis/windows';
import type { TranscriptSegment } from '../../shared/transcript';

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
  /** Production sets false so the parent can retry each backend in a fresh worker. */
  allowFallback?: boolean;
  dtype: EmbeddingDtype;
};

export type AnalysisWorkerEmbed = {
  type: 'EMBED';
  seq: number;
  texts: string[];
};

export type AnalysisWorkerPrepareWindows = {
  type: 'PREPARE_WINDOWS';
  seq: number;
  segments: TranscriptSegment[];
  config: WindowConfig;
};

export type AnalysisWorkerRequest = AnalysisWorkerOpen | AnalysisWorkerPrepareWindows | AnalysisWorkerEmbed;

export type AnalysisWorkerOpened = {
  type: 'OPENED';
  seq: number;
  /** The backend that actually loaded; may differ when `allowFallback` is enabled. */
  device: EmbeddingDevice;
  dimensions: number;
  /** The quantization that loaded, for `AnalysisProvenance`. */
  dtype: EmbeddingDtype;
  /** Exact maximum sequence length accepted by both packaged tokenizer and graph. */
  maxTokens: number;
  loadMs: number;
};

export type AnalysisWorkerPreparedWindows = {
  type: 'PREPARED_WINDOWS';
  seq: number;
  windows: ContextWindow[];
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
  | AnalysisWorkerPreparedWindows
  | AnalysisWorkerEmbedded
  | AnalysisWorkerError;
