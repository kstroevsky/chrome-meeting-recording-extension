/**
 * @file shared/analysis/candidateConfig.ts
 *
 * The configuration a run uses today — **candidate defaults, not a frozen
 * contract.**
 *
 * Named `CANDIDATE_` so no call site can import it and mistake it for settled.
 * `docs/plans/local-text-processing.md` §9 lists these as open contracts, and
 * the plan's rule is that they must not be *invented*. They are not: every
 * value below comes from ADR-0007's 4B calibration run, with the two exceptions
 * noted inline. What 4B did not do is validate any of it against real
 * conversation — its corpus is synthetic, and synthetic topic blocks
 * underrepresent interruptions, callbacks, weak transitions and mixed-topic
 * turns, which are exactly the cases that decide a threshold.
 *
 * So this is the configuration the pipeline runs, recorded as provisional and
 * hashed into every result's provenance — which is what makes changing it safe:
 * a stored analysis produced under different values reads as stale and is
 * recomputed rather than silently compared against new ones.
 *
 * **Until the real-conversation pass, prefer loosening to tightening.** The
 * errors are asymmetric: an over-tight assignment bar makes extra
 * micro-clusters the merge sweep can still reunite, while an over-loose one
 * folds two subjects together and this pipeline has no split operation to undo
 * that.
 */

import type { AnalysisConfig } from './types';

export const CANDIDATE_ANALYSIS_CONFIG: AnalysisConfig = {
  // Strong structural result in 4B: boundary F1 0.892, and the produced cluster
  // count matched ground truth exactly. Stride equals the window, so the two
  // contexts compared across a boundary share no utterances — the invariant
  // whose violation cost the earlier run its boundary signal.
  windowUtterances: 4,
  windowStride: 4,

  // Candidate default with a caveat attached: 3 s, 5 s and 8 s produced
  // *identical* results everywhere in 4B's grid. Either the synthetic corpus's
  // pauses are not discriminative or SEG-05's 0.10 weight cannot move a peak on
  // its own. Unresolved, and the first thing to re-measure on real audio.
  longPauseMs: 3_000,

  peakNeighbourhood: 2,
  peakMinProminence: 0.05,
  minSegmentMs: 15_000,

  // Calibrated jointly, as they must be — one compares a segment to a centroid,
  // the other two centroids. CLU-04's stated 0.82 is *rejected* for this
  // encoder: multilingual-e5-small packs unrelated text well above it, so 0.82
  // assigns nearly everything to one cluster.
  assignmentThreshold: 0.93,
  mergeThreshold: 0.95,
  mergeEverySegments: 12,

  // Not from 4B: UI-02's label examples run three to four terms, and four is
  // the longest it shows.
  keywordsPerTopic: 4,

  // Not from 4B either — MMR lambda was never calibrated. This is the classic
  // Carbonell & Goldstein default, held until excerpt selection is evaluated
  // against real passages rather than assumed.
  mmrLambda: 0.7,
};
