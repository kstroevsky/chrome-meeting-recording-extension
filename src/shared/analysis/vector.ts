/**
 * @file shared/analysis/vector.ts
 *
 * The arithmetic the whole deterministic pipeline runs on.
 *
 * Every stage above this file — boundary detection, online clustering,
 * importance ranking — is built from cosine similarity and incremental means.
 * That is the point of the architecture: topic structure is an embedding
 * problem, and an embedding problem is arithmetic, not generation (ARCH-04).
 * It runs on CPU and it is exactly testable, which is why the stage tests need
 * no GPU, no model download and no network.
 */

import type { Embedding } from './types';

/**
 * Cosine similarity, in [-1, 1].
 *
 * A zero-magnitude vector has no direction, so it is similar to nothing —
 * answering 0 rather than `NaN` keeps one degenerate embedding from poisoning
 * every score derived from it.
 */
export function cosine(a: Embedding, b: Embedding): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare embeddings of different widths: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return 0;
  const similarity = dot / (Math.sqrt(aa) * Math.sqrt(bb));
  // Guard the ends against floating-point drift so callers can rely on the range.
  return Math.min(1, Math.max(-1, similarity));
}

/** Cosine *distance*: how far apart two embeddings are, in [0, 2]. */
export function cosineDistance(a: Embedding, b: Embedding): number {
  return 1 - cosine(a, b);
}

/**
 * Folds one more embedding into a running mean (CLU-05):
 *
 * ```text
 * C_new = (n·C + x) / (n + 1)
 * ```
 *
 * Exact contract from the source payload. `n` is the count the centroid
 * *currently* summarizes, before `x` joins. This is what makes clustering
 * essentially free — no cluster ever re-reads its members.
 */
export function updateCentroid(centroid: Embedding, n: number, x: Embedding): Embedding {
  if (centroid.length !== x.length) {
    throw new Error(`Cannot fold an embedding of width ${x.length} into a centroid of width ${centroid.length}`);
  }
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`A centroid cannot summarize ${n} members`);
  }
  const next = new Float32Array(centroid.length);
  for (let i = 0; i < centroid.length; i += 1) {
    next[i] = (n * centroid[i] + x[i]) / (n + 1);
  }
  return next;
}

/**
 * The mean of a set of embeddings — a topic's centroid over its segments
 * (IMP-02), and the way a merged cluster recomputes its own.
 */
export function meanCentroid(embeddings: Embedding[]): Embedding {
  const [first] = embeddings;
  if (!first) throw new Error('A centroid needs at least one embedding');

  const total = new Float64Array(first.length);
  for (const embedding of embeddings) {
    if (embedding.length !== first.length) {
      throw new Error(`Cannot average embeddings of different widths: ${embedding.length} vs ${first.length}`);
    }
    for (let i = 0; i < embedding.length; i += 1) total[i] += embedding[i];
  }

  const mean = new Float32Array(first.length);
  for (let i = 0; i < mean.length; i += 1) mean[i] = total[i] / embeddings.length;
  return mean;
}
