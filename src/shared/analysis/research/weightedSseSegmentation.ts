import type { Embedding } from '../types';

export type WeightedSseSegmentationConfig = {
  /** Cost paid for every emitted segment, including the first. */
  penalty: number;
  /** Minimum number of input items in every segment. */
  minSegmentItems: number;
};

export type WeightedSseSegmentation = {
  /** Half-open segment ends, always including the input length. */
  endpoints: number[];
  /** Weighted within-segment SSE plus one penalty per segment. */
  objective: number;
};

type PrefixStats = {
  count: number;
  dimensions: number;
  weight: Float64Array;
  squareNorm: Float64Array;
  sums: Float64Array;
};

/**
 * Exact O(n²) dynamic-programming oracle for the global SSE challenger.
 * Keep this implementation: TECH-05's optimized solver is only trustworthy
 * while it reproduces this reference over adversarial and randomized inputs.
 */
export function optimalWeightedSseSegmentation(
  vectors: Embedding[],
  weights: number[],
  config: WeightedSseSegmentationConfig,
): WeightedSseSegmentation {
  const stats = buildPrefixStats(vectors, weights);
  assertConfig(config);
  return solve(stats, config, false);
}

/**
 * Constrained PELT for weighted SSE, with delayed pruning.
 *
 * For SSE, C(s,t)+C(t,u) <= C(s,u). If F(s)+C(s,t) > F(t), candidate s is
 * dominated by t for every future endpoint where t itself is legal. With a
 * minimum segment length that is only true starting at `t + minSegmentItems`,
 * so pruning is scheduled for that endpoint rather than applied immediately.
 * Strict `>` retains equal-cost candidates and therefore the oracle's stable
 * earliest-predecessor tie-break.
 */
export function peltWeightedSseSegmentation(
  vectors: Embedding[],
  weights: number[],
  config: WeightedSseSegmentationConfig,
): WeightedSseSegmentation {
  const stats = buildPrefixStats(vectors, weights);
  assertConfig(config);
  return solve(stats, config, true);
}

/** Weighted SSE for one half-open interval, exposed for exact formula tests. */
export function weightedSseCost(vectors: Embedding[], weights: number[], start = 0, end = vectors.length): number {
  const stats = buildPrefixStats(vectors, weights);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > stats.count || end <= start) {
    throw new Error(`Invalid weighted-SSE interval [${start}, ${end})`);
  }
  return intervalCost(stats, start, end);
}

function solve(
  stats: PrefixStats,
  config: WeightedSseSegmentationConfig,
  prune: boolean,
): WeightedSseSegmentation {
  const { count } = stats;
  if (!count) return { endpoints: [], objective: 0 };
  if (count < config.minSegmentItems) {
    throw new Error(`Cannot segment ${count} items with minimum length ${config.minSegmentItems}`);
  }

  const objective = new Float64Array(count + 1);
  objective.fill(Number.POSITIVE_INFINITY);
  objective[0] = 0;
  const predecessor = new Int32Array(count + 1);
  predecessor.fill(-1);
  const active = new Set<number>([0]);
  const scheduledPrunes = new Map<number, Set<number>>();

  for (let end = config.minSegmentItems; end <= count; end += 1) {
    const pruneNow = scheduledPrunes.get(end);
    if (pruneNow) {
      for (const candidate of pruneNow) active.delete(candidate);
      scheduledPrunes.delete(end);
    }

    let best = Number.POSITIVE_INFINITY;
    let bestStart = -1;
    const eligible: number[] = [];
    for (const start of active) {
      if (end - start < config.minSegmentItems || !Number.isFinite(objective[start])) continue;
      eligible.push(start);
      const candidate = objective[start] + intervalCost(stats, start, end) + config.penalty;
      if (candidate < best) {
        best = candidate;
        bestStart = start;
      }
    }

    if (bestStart !== -1) {
      objective[end] = best;
      predecessor[end] = bestStart;
      active.add(end);
    }

    if (!prune || bestStart === -1) continue;
    const removeAt = end + config.minSegmentItems;
    if (removeAt > count) continue;
    for (const start of eligible) {
      // Penalty is intentionally absent on the left side of the PELT pruning
      // inequality; F(end) already includes the segment ending here.
      if (objective[start] + intervalCost(stats, start, end) <= objective[end]) continue;
      let removals = scheduledPrunes.get(removeAt);
      if (!removals) {
        removals = new Set<number>();
        scheduledPrunes.set(removeAt, removals);
      }
      removals.add(start);
    }
  }

  if (!Number.isFinite(objective[count])) {
    throw new Error('No legal weighted-SSE segmentation covers the complete input');
  }
  const endpoints: number[] = [];
  let cursor = count;
  while (cursor > 0) {
    endpoints.push(cursor);
    cursor = predecessor[cursor];
    if (cursor < 0) throw new Error('Weighted-SSE segmentation predecessor chain is corrupt');
  }
  endpoints.reverse();
  return { endpoints, objective: objective[count] };
}

function buildPrefixStats(vectors: Embedding[], weights: number[]): PrefixStats {
  if (vectors.length !== weights.length) {
    throw new Error(`Weighted SSE needs one weight per vector: ${vectors.length} vs ${weights.length}`);
  }
  if (!vectors.length) {
    return {
      count: 0,
      dimensions: 0,
      weight: new Float64Array(1),
      squareNorm: new Float64Array(1),
      sums: new Float64Array(0),
    };
  }
  const dimensions = vectors[0].length;
  if (!dimensions) throw new Error('Weighted SSE vectors must have at least one dimension');
  const prefixWeight = new Float64Array(vectors.length + 1);
  const prefixSquareNorm = new Float64Array(vectors.length + 1);
  const prefixSums = new Float64Array((vectors.length + 1) * dimensions);

  for (let i = 0; i < vectors.length; i += 1) {
    const vector = vectors[i];
    const weight = weights[i];
    if (vector.length !== dimensions) throw new Error('Weighted SSE vectors must have equal dimensions');
    if (!Number.isFinite(weight) || weight <= 0) throw new Error(`Weighted SSE requires positive finite weights, got ${weight}`);
    prefixWeight[i + 1] = prefixWeight[i] + weight;
    let squareNorm = 0;
    const previousOffset = i * dimensions;
    const nextOffset = (i + 1) * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const value = vector[dimension];
      if (!Number.isFinite(value)) throw new Error('Weighted SSE received a non-finite vector');
      squareNorm += value * value;
      prefixSums[nextOffset + dimension] = prefixSums[previousOffset + dimension] + weight * value;
    }
    prefixSquareNorm[i + 1] = prefixSquareNorm[i] + weight * squareNorm;
  }
  return {
    count: vectors.length,
    dimensions,
    weight: prefixWeight,
    squareNorm: prefixSquareNorm,
    sums: prefixSums,
  };
}

function intervalCost(stats: PrefixStats, start: number, end: number): number {
  const mass = stats.weight[end] - stats.weight[start];
  let meanSquare = 0;
  const startOffset = start * stats.dimensions;
  const endOffset = end * stats.dimensions;
  for (let dimension = 0; dimension < stats.dimensions; dimension += 1) {
    const sum = stats.sums[endOffset + dimension] - stats.sums[startOffset + dimension];
    meanSquare += sum * sum;
  }
  const raw = (stats.squareNorm[end] - stats.squareNorm[start]) - meanSquare / mass;
  // Exact SSE is non-negative; a tiny negative can arise only from cancellation
  // in prefix subtraction. Never let that artifact reward an extra segment.
  if (raw < -1e-10) throw new Error(`Weighted-SSE prefix arithmetic became invalid: ${raw}`);
  return raw < 0 ? 0 : raw;
}

function assertConfig(config: WeightedSseSegmentationConfig): void {
  if (!Number.isFinite(config.penalty) || config.penalty < 0) {
    throw new Error(`Weighted-SSE penalty must be finite and non-negative, not ${config.penalty}`);
  }
  if (!Number.isSafeInteger(config.minSegmentItems) || config.minSegmentItems < 1) {
    throw new Error(`Weighted-SSE minimum segment length must be a positive integer, not ${config.minSegmentItems}`);
  }
}
