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
import {
  boundaryAgreement,
  clusterAgreement,
  finalTemporalBoundariesOnAxis,
  projectTopicAssignmentsToAxis,
} from '../src/shared/analysis/evaluation';
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
  falseMergePairs: number;
  predictedPositivePairs: number;
  falseMergeRate: number | null;
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
  let falseMergePairs = 0;
  let predictedPositivePairs = 0;

  for (const testCase of cases) {
    const entry = testCase.shapes.find((s) =>
      s.shape.windowUtterances === shape.windowUtterances && s.shape.windowStride === shape.windowStride)!;
    const windows = entry.windows;
    const embeddings = entry.embeddings.map((v) => Float32Array.from(v));

    const truthBoundaries: number[] = [];
    for (let i = 0; i < testCase.topicOfUtterance.length - 1; i += 1) {
      if (testCase.topicOfUtterance[i] !== testCase.topicOfUtterance[i + 1]) truthBoundaries.push(i);
    }

    const scores = scoreBoundaries(windows, embeddings, config);
    const peaks = findBoundaryPeaks(scores, config);
    const temporal = buildConversationSegments(windows, embeddings, peaks, config);
    const predictedBoundaries = finalTemporalBoundariesOnAxis(
      temporal,
      windows,
      testCase.topicOfUtterance.length,
    );
    // A one-utterance tolerance is retained as this harness's diagnostic slack,
    // but both truth and predictions now live on the same immutable axis.
    boundaryTotal += boundaryAgreement(predictedBoundaries, truthBoundaries, 1).f1;

    const { segments: assigned } = clusterSegments(temporal, config);
    const assignedOnAxis = projectTopicAssignmentsToAxis(
      windows,
      assigned,
      testCase.topicOfUtterance.length,
    );
    const scored = clusterAgreement(assignedOnAxis, testCase.topicOfUtterance);
    clusterTotal += scored.f1;
    precisionTotal += scored.precision;
    recallTotal += scored.recall;
    falseMergePairs += scored.falseMergePairs;
    predictedPositivePairs += scored.predictedPositivePairs;
  }

  const n = Math.max(1, cases.length);
  return {
    boundary: boundaryTotal / n,
    cluster: clusterTotal / n,
    clusterPrecision: precisionTotal / n,
    clusterRecall: recallTotal / n,
    falseMergePairs,
    predictedPositivePairs,
    falseMergeRate: predictedPositivePairs ? falseMergePairs / predictedPositivePairs : null,
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

// Exact lexicographic ordering is transitive. The old pairwise 0.002 "near tie"
// rule could form preference cycles and therefore made Array.sort traversal part
// of the experiment. Quality score remains primary; precision and false-merge
// rate are deterministic secondary diagnostics until a frozen EVAL-06 manifest
// supplies explicit eligibility gates and tie bands.
results.sort((a, b) => {
  if (b.score !== a.score) return b.score - a.score;
  if (b.clusterPrecision !== a.clusterPrecision) return b.clusterPrecision - a.clusterPrecision;
  const aFalseMerge = a.falseMergeRate ?? Number.POSITIVE_INFINITY;
  const bFalseMerge = b.falseMergeRate ?? Number.POSITIVE_INFINITY;
  if (aFalseMerge !== bFalseMerge) return aFalseMerge - bFalseMerge;
  if (b.clusterRecall !== a.clusterRecall) return b.clusterRecall - a.clusterRecall;
  return JSON.stringify([a.shape, a.config]).localeCompare(JSON.stringify([b.shape, b.config]));
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

console.log('  rank  score  bound  clustF1  cPrec  cRec   fmRate  win/str  peak(n,prom)  pause  minSeg  assign  merge  every');
for (const r of results.slice(0, 12)) {
  const c = r.config;
  const falseMerge = r.falseMergeRate == null ? 'n/a' : r.falseMergeRate.toFixed(3);
  console.log(
    `  ${String(results.indexOf(r) + 1).padStart(4)}  ${r.score.toFixed(3)}  ${r.boundary.toFixed(3)}`
    + `  ${r.cluster.toFixed(3)}`.padEnd(9)
    + `  ${r.clusterPrecision.toFixed(3)}  ${r.clusterRecall.toFixed(3)}`
    + `  ${falseMerge}`.padEnd(8)
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
    + `   falseMergeRate ${held.falseMergeRate == null ? 'n/a' : held.falseMergeRate.toFixed(3)}`
    + `\n    tuning score was ${winner.score.toFixed(3)}`
    + ` (${(((held.boundary + held.cluster) / 2) - winner.score >= 0 ? '+' : '')}`
    + `${((((held.boundary + held.cluster) / 2) - winner.score)).toFixed(3)} on held-out data)`,
  );
}

if (winner && syntheticCases.length && tuningCases.length) {
  const synthetic = scoreCases(syntheticCases, winner.config as unknown as Config, winner.shape);
  console.log(
    `\n  synthetic cases, winning configuration: score ${((synthetic.boundary + synthetic.cluster) / 2).toFixed(3)}`
    + `   falseMergeRate ${synthetic.falseMergeRate == null ? 'n/a' : synthetic.falseMergeRate.toFixed(3)}`
    + '\n    (mechanics check only — clean topic blocks, so a high score here proves little)',
  );
}
