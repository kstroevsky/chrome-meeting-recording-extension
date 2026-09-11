/**
 * @file shared/analysis/provenance.ts
 *
 * What produced an analysis, recorded beside the analysis itself.
 *
 * Topic results are derived data with an unusually soft definition: four of the
 * scoring terms are provisional, every value in
 * `docs/plans/local-text-processing.md` §9 is an open contract awaiting the
 * ADR-0007 spikes, and the embedding model and its quantization are themselves
 * choices that may change. Without provenance, an analysis produced under one
 * set of those and an analysis produced under another are indistinguishable on
 * disk — they look equally current, sort the same, and answer queries the same
 * way, while meaning different things.
 *
 * So every stored result carries the conditions it was computed under. That is
 * what makes invalidation possible at all: recomputing is cheap enough to do
 * when something changed, and impossible to know about when it is not recorded.
 */

import type { AnalysisConfig } from './types';

/**
 * The deterministic pipeline's own version.
 *
 * Bump whenever a stage's *behaviour* changes in a way that would make an
 * earlier result different — a provisional term redefined, a stage reordered,
 * a contract corrected. Not for refactors that cannot change an output.
 */
export const PIPELINE_VERSION = 1;

export type AnalysisProvenance = {
  pipelineVersion: number;
  /** The model's identity, e.g. its Hugging Face repo id. */
  embeddingModel: string;
  /** Which build of that model: a commit, tag, or artifact digest. */
  embeddingModelRevision: string;
  /** 384 for `multilingual-e5-small` (EMB-03); recorded because it can change with the model. */
  embeddingDimensions: number;
  /** Digest of every §9 value the run used. See {@link hashAnalysisConfig}. */
  configHash: string;
};

/**
 * A stable digest of the configuration a run used.
 *
 * Only has to answer "is this the same configuration as before?", so it is a
 * plain FNV-1a over the config's canonical form rather than a cryptographic
 * hash — nothing here defends against an adversary, and a synchronous function
 * keeps provenance out of the async plumbing of every call site.
 *
 * Keys are sorted, so a config object's property order cannot change the digest
 * and cause a spurious recompute.
 */
export function hashAnalysisConfig(config: AnalysisConfig): string {
  return fnv1a(canonicalize(config));
}

/** Whether an analysis was produced under different conditions than these. */
export function isStale(stored: AnalysisProvenance, current: AnalysisProvenance): boolean {
  return stored.pipelineVersion !== current.pipelineVersion
    || stored.embeddingModel !== current.embeddingModel
    || stored.embeddingModelRevision !== current.embeddingModelRevision
    || stored.embeddingDimensions !== current.embeddingDimensions
    || stored.configHash !== current.configHash;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // The FNV prime, by shifts, so the arithmetic stays inside 32 bits.
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
