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
    /** Real conversations decide thresholds; synthetic ones prove mechanics. */
    source?: 'real' | 'synthetic';
    /** Never tuned on, always reported separately. */
    holdout?: boolean;
    notes?: string;
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
function clusterScores(assigned: string[], truth: string[]): { precision: number; recall: number; f1: number } {
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
  // Precision falls when unrelated topics are folded together; recall falls
  // when a recurring subject is left split. They are not symmetric in cost:
  // an over-tight assignment threshold over-splits, and the merge sweep can
  // still repair that — an over-loose one contaminates a cluster and nothing
  // downstream can undo it. So precision is the tie-breaker below.
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  // `falseMerges` is reported on its own, not folded into F1, because an
  // aggregate hides the error that matters most here: a pipeline that joins two
  // subjects cannot be repaired downstream, while one that splits a subject can
  // be — the merge sweep exists for exactly that. A configuration with a better
  // F1 and more false merges is the worse configuration.
  return { precision, recall, f1, falseMerges: fp };
}

const GRID = {
  peakNeighbourhood: [1, 2, 3],
  peakMinProminence: [0.02, 0.05, 0.08, 0.12],
  longPauseMs: [3_000, 5_000, 8_000],
  minSegmentMs: [15_000, 30_000, 60_000],
  // Searched across the band this encoder actually occupies, not around the
  // payload's illustrative 0.82 — every observed cross-topic segment pair sat
  // above 0.861, so 0.82 joins everything (ADR-0007 4B, D-16). Assignment and
  // merge are calibrated *jointly*: they are two halves of one behaviour.
  assignmentThreshold: [0.88, 0.91, 0.93, 0.95, 0.97],
  mergeThreshold: [0.88, 0.92, 0.95, 0.97, 0.98],
  mergeEverySegments: [4, 12, 1_000],
};

/**
 * The corpus, split three ways.
 *
 * Tuning happens on real conversations that are not the holdout. The holdout is
 * scored with the winning configuration and never searched over — with a corpus
 * this small, picking and reporting on the same calls makes a threshold look far
 * more certain than the evidence warrants. Synthetic cases are scored too, and
 * kept apart: they are clean enough to flatter a configuration that fails on
 * real dialogue.
 */
// Only an explicit `real` counts. A corpus dumped before this field existed is
// synthetic, and treating it as real would let the holdout warning read as
// though genuine conversations had been tuned on.
const realCases = corpus.cases.filter((c) => c.source === 'real');
const tuningCases = realCases.filter((c) => !c.holdout);
const holdoutCases = realCases.filter((c) => c.holdout);
// The complement of `realCases`, so a corpus dumped before `source` existed
// still has somewhere to belong rather than falling out of every set.
const syntheticCases = corpus.cases.filter((c) => c.source !== 'real');
/** What the grid searches over. Falls back to synthetic when no real ones exist. */
const searchCases = tuningCases.length ? tuningCases : syntheticCases;

type Scored = {
  boundary: number;
  cluster: number;
  clusterPrecision: number;
  clusterRecall: number;
  falseMerges: number;
};

type Result = Scored & {
  config: Record<string, number>;
  shape: Shape;
  score: number;
};
const results: Result[] = [];

type Config = {
  peakNeighbourhood: number;
  peakMinProminence: number;
  longPauseMs: number;
  minSegmentMs: number;
  assignmentThreshold: number;
  mergeThreshold: number;
  mergeEverySegments: number;
};

/** Runs one configuration over a set of conversations and averages the scores. */
function scoreCases(cases: Corpus['cases'], config: Config, shape: Shape): Scored {
  let boundaryTotal = 0;
  let clusterTotal = 0;
  let precisionTotal = 0;
  let recallTotal = 0;
  let falseMerges = 0;

  for (const testCase of cases) {
    const entry = testCase.shapes.find((s) =>
      s.shape.windowUtterances === shape.windowUtterances && s.shape.windowStride === shape.windowStride)!;
    const windows = entry.windows;
    const embeddings = entry.embeddings.map((v) => Float32Array.from(v));
    const topics = windows.map((w) => windowTopic(w, testCase.topicOfUtterance));

    const truthBoundaries: number[] = [];
    for (let i = 0; i < windows.length - 1; i += 1) if (topics[i] !== topics[i + 1]) truthBoundaries.push(i);

    const scores = scoreBoundaries(windows, embeddings, config);
    const peaks = findBoundaryPeaks(scores, config);
    boundaryTotal += boundaryF1(peaks.map((p) => p.index), truthBoundaries);

    const segments = buildConversationSegments(windows, embeddings, peaks, config);
    const { segments: assigned } = clusterSegments(segments, config);

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
    const scored = clusterScores(assignedPerWindow, truthPerWindow);
    clusterTotal += scored.f1;
    precisionTotal += scored.precision;
    recallTotal += scored.recall;
    falseMerges += scored.falseMerges;
  }

  const n = Math.max(1, cases.length);
  return {
    boundary: boundaryTotal / n,
    cluster: clusterTotal / n,
    clusterPrecision: precisionTotal / n,
    clusterRecall: recallTotal / n,
    falseMerges,
  };
}

for (const shape of corpus.cases[0].shapes.map((s) => s.shape)) {
  for (const peakNeighbourhood of GRID.peakNeighbourhood)
  for (const peakMinProminence of GRID.peakMinProminence)
  for (const longPauseMs of GRID.longPauseMs)
  for (const minSegmentMs of GRID.minSegmentMs)
  for (const assignmentThreshold of GRID.assignmentThreshold)
  for (const mergeThreshold of GRID.mergeThreshold)
  for (const mergeEverySegments of GRID.mergeEverySegments) {
    const config: Config = {
      peakNeighbourhood, peakMinProminence, longPauseMs, minSegmentMs,
      assignmentThreshold, mergeThreshold, mergeEverySegments,
    };
    // Searched on the tuning set only. The holdout is scored once, below.
    const scored = scoreCases(searchCases, config, shape);
    results.push({
      config: { ...config },
      shape,
      ...scored,
      // Equal weight: a pipeline that finds boundaries but cannot recognize a
      // recurring subject is no more useful than the reverse.
      score: (scored.boundary + scored.cluster) / 2,
    });
  }
}

// Rank by score, but break near-ties toward precision: two configurations that
// score alike are not equally safe, because over-splitting is repairable and
// contamination is not. Where precision ties too, fewer false merges wins for
// the same reason.
results.sort((a, b) => {
  if (Math.abs(b.score - a.score) > 0.002) return b.score - a.score;
  if (Math.abs(b.clusterPrecision - a.clusterPrecision) > 0.002) return b.clusterPrecision - a.clusterPrecision;
  return a.falseMerges - b.falseMerges;
});

const describeCase = (c: Corpus['cases'][number]) => `${c.name}${c.holdout ? ' [holdout]' : ''}`;
console.log(
  `\ncorpus: ${corpus.cases.length} cases, dtype ${corpus.dtype}, ${results.length} configurations`
  + `\n  tuning    ${tuningCases.length ? tuningCases.map(describeCase).join(', ') : '(none — searching synthetic cases)'}`
  + `\n  holdout   ${holdoutCases.length ? holdoutCases.map(describeCase).join(', ') : '(none)'}`
  + `\n  synthetic ${syntheticCases.length}\n`,
);

if (!tuningCases.length) {
  console.log(
    '  WARNING: no real conversations are present, so these values are candidates only —\n'
    + '           the same standing the synthetic 4B pass produced. See\n'
    + '           tests/fixtures/calibration/README.md before freezing anything.\n',
  );
} else if (!holdoutCases.length) {
  console.log(
    '  WARNING: every real conversation was tuned on. Thresholds picked and reported on\n'
    + '           the same calls look more certain than the evidence warrants; mark one\n'
    + '           conversation "holdout": true before freezing anything.\n',
  );
}

console.log('  rank  score  bound  clustF1  cPrec  cRec   fMerge  win/str  peak(n,prom)  pause  minSeg  assign  merge  every');
for (const r of results.slice(0, 12)) {
  const c = r.config;
  console.log(
    `  ${String(results.indexOf(r) + 1).padStart(4)}  ${r.score.toFixed(3)}  ${r.boundary.toFixed(3)}`
    + `  ${r.cluster.toFixed(3)}`.padEnd(9)
    + `  ${r.clusterPrecision.toFixed(3)}  ${r.clusterRecall.toFixed(3)}`
    + `  ${String(r.falseMerges)}`.padEnd(8)
    + `  ${r.shape.windowUtterances}/${r.shape.windowStride}`.padEnd(9)
    + `  ${c.peakNeighbourhood},${c.peakMinProminence}`.padEnd(14)
    + `  ${c.longPauseMs / 1000}s`.padEnd(7)
    + `  ${c.minSegmentMs / 1000}s`.padEnd(8)
    + `  ${c.assignmentThreshold}`.padEnd(8)
    + `  ${c.mergeThreshold}`.padEnd(7)
    + `  ${c.mergeEverySegments}`,
  );
}

/**
 * The winner, scored on conversations it never saw.
 *
 * This is the number that says whether the configuration generalizes. A large
 * drop from the tuning score means the grid fitted the calls it searched rather
 * than the problem — with a corpus this small that is the expected failure, and
 * it is better seen here than after the values ship.
 */
const winner = results[0];
if (winner && holdoutCases.length) {
  const held = scoreCases(holdoutCases, winner.config as unknown as Config, winner.shape);
  console.log(
    `\n  holdout (${holdoutCases.map((c) => c.name).join(', ')}), winning configuration only:`
    + `\n    score ${((held.boundary + held.cluster) / 2).toFixed(3)}`
    + `   bound ${held.boundary.toFixed(3)}   clustF1 ${held.cluster.toFixed(3)}`
    + `   cPrec ${held.clusterPrecision.toFixed(3)}   cRec ${held.clusterRecall.toFixed(3)}`
    + `   falseMerges ${held.falseMerges}`
    + `\n    tuning score was ${winner.score.toFixed(3)}`
    + ` (${(((held.boundary + held.cluster) / 2) - winner.score >= 0 ? '+' : '')}`
    + `${((((held.boundary + held.cluster) / 2) - winner.score)).toFixed(3)} on held-out data)`,
  );
}

if (winner && syntheticCases.length && tuningCases.length) {
  const synthetic = scoreCases(syntheticCases, winner.config as unknown as Config, winner.shape);
  console.log(
    `\n  synthetic cases, winning configuration: score ${((synthetic.boundary + synthetic.cluster) / 2).toFixed(3)}`
    + `   falseMerges ${synthetic.falseMerges}`
    + '\n    (mechanics check only — clean topic blocks, so a high score here proves little)',
  );
}
