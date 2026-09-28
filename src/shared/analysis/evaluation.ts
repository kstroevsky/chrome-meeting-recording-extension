/**
 * Evaluation helpers for ADR-0009 research.
 *
 * These functions deliberately score on a fixed canonical item axis rather
 * than on whatever analysis windows a candidate happened to create. They are
 * pure so calibration/challenger scripts can share the same judge.
 */

import type { ContextWindow, ConversationSegment } from './types';

type WindowCoverage = Pick<ConversationSegment, 'startWindow' | 'endWindow'>;

export type BoundaryAgreement = {
  precision: number;
  recall: number;
  f1: number;
  matches: Array<{ predicted: number; gold: number; displacement: number }>;
  unmatchedPredicted: number;
  unmatchedGold: number;
};

type MatchState = {
  pairs: Array<[number, number]>;
  displacement: number;
};

/**
 * Maximum-cardinality one-to-one boundary matching, then minimum displacement.
 *
 * The dynamic program also uses a deterministic lexicographic tie break, so a
 * calibration rerun cannot depend on traversal order when several optimum
 * matchings exist.
 */
export function boundaryAgreement(
  predictedInput: number[],
  goldInput: number[],
  tolerance: number,
): BoundaryAgreement {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(`Boundary tolerance must be a finite non-negative number, not ${tolerance}`);
  }
  const predicted = [...predictedInput].sort((a, b) => a - b);
  const gold = [...goldInput].sort((a, b) => a - b);
  const rows = predicted.length + 1;
  const cols = gold.length + 1;
  const dp = Array.from({ length: rows }, () => new Array<MatchState>(cols));

  for (let i = predicted.length; i >= 0; i -= 1) {
    for (let j = gold.length; j >= 0; j -= 1) {
      if (i === predicted.length || j === gold.length) {
        dp[i][j] = { pairs: [], displacement: 0 };
        continue;
      }
      let best = betterMatchState(dp[i + 1][j], dp[i][j + 1]);
      const displacement = Math.abs(predicted[i] - gold[j]);
      if (displacement <= tolerance) {
        const tail = dp[i + 1][j + 1];
        best = betterMatchState(best, {
          pairs: [[predicted[i], gold[j]], ...tail.pairs],
          displacement: displacement + tail.displacement,
        });
      }
      dp[i][j] = best;
    }
  }

  const pairs = dp[0][0].pairs;
  const matched = pairs.length;
  const bothEmpty = predicted.length === 0 && gold.length === 0;
  const precision = predicted.length ? matched / predicted.length : bothEmpty ? 1 : 0;
  const recall = gold.length ? matched / gold.length : bothEmpty ? 1 : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    precision,
    recall,
    f1,
    matches: pairs.map(([predictedBoundary, goldBoundary]) => ({
      predicted: predictedBoundary,
      gold: goldBoundary,
      displacement: Math.abs(predictedBoundary - goldBoundary),
    })),
    unmatchedPredicted: predicted.length - matched,
    unmatchedGold: gold.length - matched,
  };
}

function betterMatchState(left: MatchState, right: MatchState): MatchState {
  if (left.pairs.length !== right.pairs.length) return left.pairs.length > right.pairs.length ? left : right;
  if (left.displacement !== right.displacement) return left.displacement < right.displacement ? left : right;
  const length = Math.min(left.pairs.length, right.pairs.length);
  for (let i = 0; i < length; i += 1) {
    if (left.pairs[i][0] !== right.pairs[i][0]) return left.pairs[i][0] < right.pairs[i][0] ? left : right;
    if (left.pairs[i][1] !== right.pairs[i][1]) return left.pairs[i][1] < right.pairs[i][1] ? left : right;
  }
  return left;
}

/**
 * Projects final temporal segment boundaries onto canonical utterance indices.
 * Overlap or gaps at a segment seam make the fixed-axis score ineligible rather
 * than quietly changing the denominator.
 */
export function finalTemporalBoundariesOnAxis(
  segments: WindowCoverage[],
  windows: ContextWindow[],
  axisLength: number,
): number[] {
  if (!Number.isSafeInteger(axisLength) || axisLength < 0) {
    throw new Error(`Evaluation axis length must be a non-negative integer, not ${axisLength}`);
  }
  if (!segments.length) {
    if (axisLength === 0) return [];
    throw new Error('Final segmentation does not cover the evaluation axis');
  }

  const ranges = segments.map((segment) => segmentAxisRange(segment, windows));
  if (ranges[0].start !== 0 || ranges[ranges.length - 1].end !== axisLength) {
    throw new Error('Final segmentation does not cover the complete evaluation axis');
  }
  const boundaries: number[] = [];
  for (let i = 0; i < ranges.length - 1; i += 1) {
    if (ranges[i].end !== ranges[i + 1].start) {
      throw new Error('Final segmentation has overlapping or missing fixed-axis coverage');
    }
    boundaries.push(ranges[i].end - 1);
  }
  return boundaries;
}

/** Projects global topic assignments onto each canonical utterance exactly once. */
export function projectTopicAssignmentsToAxis(
  windows: ContextWindow[],
  segments: ConversationSegment[],
  axisLength: number,
): string[] {
  const assigned = new Array<string | undefined>(axisLength);
  for (const segment of segments) {
    if (segment.startWindow < 0 || segment.endWindow > windows.length || segment.endWindow <= segment.startWindow) {
      throw new Error('Analysis segment references invalid window coverage');
    }
    for (let windowIndex = segment.startWindow; windowIndex < segment.endWindow; windowIndex += 1) {
      const window = windows[windowIndex];
      if (window.startIndex < 0 || window.endIndex > axisLength || window.endIndex <= window.startIndex) {
        throw new Error('Analysis window references invalid fixed-axis coverage');
      }
      for (let item = window.startIndex; item < window.endIndex; item += 1) {
        const existing = assigned[item];
        if (existing != null && existing !== segment.localTopicId) {
          throw new Error(`Conflicting topic assignments cover evaluation item ${item}`);
        }
        assigned[item] = segment.localTopicId;
      }
    }
  }
  const missing = assigned.findIndex((topic) => topic == null);
  if (missing !== -1) throw new Error(`No topic assignment covers evaluation item ${missing}`);
  return assigned as string[];
}

function segmentAxisRange(segment: WindowCoverage, windows: ContextWindow[]): { start: number; end: number } {
  if (segment.startWindow < 0 || segment.endWindow > windows.length || segment.endWindow <= segment.startWindow) {
    throw new Error('Analysis segment references invalid window coverage');
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (let i = segment.startWindow; i < segment.endWindow; i += 1) {
    start = Math.min(start, windows[i].startIndex);
    end = Math.max(end, windows[i].endIndex);
  }
  return { start, end };
}

export type ClusterAgreement = {
  precision: number;
  recall: number;
  f1: number;
  truePositivePairs: number;
  falseMergePairs: number;
  falseSplitPairs: number;
  predictedPositivePairs: number;
  falseMergeRate: number | null;
};

/** Pairwise global-topic agreement over one fixed item axis. */
export function clusterAgreement(assigned: string[], gold: string[]): ClusterAgreement {
  if (assigned.length !== gold.length) {
    throw new Error(`Cluster evaluation axes differ: ${assigned.length} vs ${gold.length}`);
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < gold.length; i += 1) {
    for (let j = i + 1; j < gold.length; j += 1) {
      const same = assigned[i] === assigned[j];
      const shouldBe = gold[i] === gold[j];
      if (same && shouldBe) tp += 1;
      else if (same && !shouldBe) fp += 1;
      else if (!same && shouldBe) fn += 1;
    }
  }
  const predictedPositivePairs = tp + fp;
  const precision = predictedPositivePairs ? tp / predictedPositivePairs : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    precision,
    recall,
    f1,
    truePositivePairs: tp,
    falseMergePairs: fp,
    falseSplitPairs: fn,
    predictedPositivePairs,
    falseMergeRate: predictedPositivePairs ? fp / predictedPositivePairs : null,
  };
}
