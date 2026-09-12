/**
 * ADR-0007 step 4B — grid search over §9's semantic values.
 *
 * Reads the embedded corpus (`analysis-calibration-dump.spec.ts`) and scores
 * every candidate configuration against known topic boundaries and known
 * recurrence. Pure arithmetic over cached vectors, so the search is cheap; the
 * expensive encoding happened once.
 *
 *   npx tsx scripts/calibrate-analysis.ts
 */

import { readFileSync } from 'node:fs';
import { scoreBoundaries, findBoundaryPeaks } from '../src/shared/analysis/boundaries';
import { buildConversationSegments } from '../src/shared/analysis/segments';
import { clusterSegments } from '../src/shared/analysis/clusters';
import type { ContextWindow } from '../src/shared/analysis/types';

type Shape = { windowUtterances: number; windowStride: number };
type Corpus = {
  dtype: string;
  cases: {
    name: string;
    topicOfUtterance: string[];
    shapes: { shape: Shape; windows: ContextWindow[]; embeddings: number[][] }[];
  }[];
};

const corpus: Corpus = JSON.parse(readFileSync('output/analysis-calibration/corpus.json', 'utf8'));

/** The true topic a window mostly covers. */
function windowTopic(window: ContextWindow, topicOfUtterance: string[]): string {
  const counts = new Map<string, number>();
  for (let i = window.startIndex; i < window.endIndex; i += 1) {
    const t = topicOfUtterance[i];
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** F1 of detected boundaries against true ones, allowing ±1 window of slack. */
function boundaryF1(detected: number[], truth: number[]): number {
  if (!truth.length) return detected.length ? 0 : 1;
  const hit = (a: number[], b: number[]) => a.filter((x) => b.some((y) => Math.abs(x - y) <= 1)).length;
  const tp = hit(detected, truth);
  const precision = detected.length ? tp / detected.length : truth.length ? 0 : 1;
  const recall = hit(truth, detected) / truth.length;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

/**
 * Pairwise clustering F1: over every pair of segments, did the pipeline put
 * them together exactly when their true topics match?
 *
 * This is what measures *recurrence* — a pipeline that never merges scores well
 * on boundaries and badly here, because the two Redis stretches end up apart.
 */
function clusterF1(assigned: string[], truth: string[]): number {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < truth.length; i += 1) {
    for (let j = i + 1; j < truth.length; j += 1) {
      const same = assigned[i] === assigned[j];
      const shouldBe = truth[i] === truth[j];
      if (same && shouldBe) tp += 1;
      else if (same && !shouldBe) fp += 1;
      else if (!same && shouldBe) fn += 1;
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

const GRID = {
  peakNeighbourhood: [1, 2, 3],
  peakMinProminence: [0.02, 0.05, 0.08, 0.12],
  longPauseMs: [3_000, 5_000, 8_000],
  minSegmentMs: [15_000, 30_000, 60_000],
  // Measured on this encoder: same-topic window pairs sit at p50 0.919 and
  // different-topic at p50 0.835, so anything below ~0.9 merges everything.
  mergeThreshold: [0.93, 0.95, 0.965, 0.975, 0.985],
  mergeEverySegments: [4, 12, 1_000],
};

type Result = { config: Record<string, number>; shape: Shape; boundary: number; cluster: number; score: number };
const results: Result[] = [];

for (const shape of corpus.cases[0].shapes.map((s) => s.shape)) {
  for (const peakNeighbourhood of GRID.peakNeighbourhood)
  for (const peakMinProminence of GRID.peakMinProminence)
  for (const longPauseMs of GRID.longPauseMs)
  for (const minSegmentMs of GRID.minSegmentMs)
  for (const mergeThreshold of GRID.mergeThreshold)
  for (const mergeEverySegments of GRID.mergeEverySegments) {
    let boundaryTotal = 0;
    let clusterTotal = 0;

    for (const testCase of corpus.cases) {
      const entry = testCase.shapes.find((s) =>
        s.shape.windowUtterances === shape.windowUtterances && s.shape.windowStride === shape.windowStride)!;
      const windows = entry.windows;
      const embeddings = entry.embeddings.map((v) => Float32Array.from(v));
      const topics = windows.map((w) => windowTopic(w, testCase.topicOfUtterance));

      const truthBoundaries: number[] = [];
      for (let i = 0; i < windows.length - 1; i += 1) if (topics[i] !== topics[i + 1]) truthBoundaries.push(i);

      const scores = scoreBoundaries(windows, embeddings, { longPauseMs, peakNeighbourhood, peakMinProminence });
      const peaks = findBoundaryPeaks(scores, { longPauseMs, peakNeighbourhood, peakMinProminence });
      boundaryTotal += boundaryF1(peaks.map((p) => p.index), truthBoundaries);

      const segments = buildConversationSegments(windows, embeddings, peaks, { minSegmentMs });
      const { segments: assigned } = clusterSegments(segments, { mergeThreshold, mergeEverySegments });

      // Score clustering at window resolution, so long segments weigh more.
      const assignedPerWindow: string[] = [];
      const truthPerWindow: string[] = [];
      for (const segment of assigned) {
        for (let i = 0; i < windows.length; i += 1) {
          if (windows[i].tStartMs >= segment.tStartMs && windows[i].tEndMs <= segment.tEndMs) {
            assignedPerWindow.push(segment.localTopicId);
            truthPerWindow.push(topics[i]);
          }
        }
      }
      clusterTotal += clusterF1(assignedPerWindow, truthPerWindow);
    }

    const boundary = boundaryTotal / corpus.cases.length;
    const cluster = clusterTotal / corpus.cases.length;
    results.push({
      config: { peakNeighbourhood, peakMinProminence, longPauseMs, minSegmentMs, mergeThreshold, mergeEverySegments },
      shape,
      boundary,
      cluster,
      // Equal weight: a pipeline that finds boundaries but cannot recognize a
      // recurring subject is no more useful than the reverse.
      score: (boundary + cluster) / 2,
    });
  }
}

results.sort((a, b) => b.score - a.score);
console.log(`\ncorpus: ${corpus.cases.length} meetings, dtype ${corpus.dtype}, ${results.length} configurations\n`);
console.log('  rank  score  bound  clust  win/stride  peak(n,prom)  pause   minSeg  merge(thr,every)');
for (const r of results.slice(0, 10)) {
  const c = r.config;
  console.log(
    `  ${String(results.indexOf(r) + 1).padStart(4)}  ${r.score.toFixed(3)}  ${r.boundary.toFixed(3)}  ${r.cluster.toFixed(3)}`
    + `  ${r.shape.windowUtterances}/${r.shape.windowStride}`.padEnd(12)
    + `  ${c.peakNeighbourhood},${c.peakMinProminence}`.padEnd(14)
    + `  ${c.longPauseMs / 1000}s`.padEnd(8)
    + `  ${c.minSegmentMs / 1000}s`.padEnd(8)
    + `  ${c.mergeThreshold},${c.mergeEverySegments}`,
  );
}
