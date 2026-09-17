/**
 * @file shared/analysis/boundaries.ts
 *
 * Where the conversation changes subject — with no generative model involved
 * (SEG-01).
 *
 * The method is the payload's, exactly: embed the utterances on either side of
 * a candidate boundary, score how far apart they point, blend that with three
 * cheap non-semantic signals at fixed weights, and take the local peaks. Every
 * number below that is a *contract* (the 0.70/0.10/0.10/0.10 blend, `1 -
 * cosine`) is written here; every number that is an *open question* (§9) is
 * required config, never a default.
 */

import { cosine } from './vector';
import { BOUNDARY_WEIGHTS, type ContextWindow, type Embedding, type SegmentationConfig } from './types';

export type BoundaryConfig = Pick<
  SegmentationConfig,
  'longPauseMs' | 'peakNeighbourhood' | 'peakMinProminence'
>;

/** One candidate boundary, with the evidence that produced its score. */
export type BoundaryScore = {
  /** The boundary sits between window `index` and window `index + 1`. */
  index: number;
  /** Media offset of the boundary: where the following window begins. */
  tStartMs: number;
  semanticChange: number;
  longPause: number;
  speakerPatternChange: number;
  discourseCue: number;
  /** The blended score (SEG-05). */
  topicChange: number;
};

/** SEG-03: how far apart two windows point. */
export function semanticChange(a: Embedding, b: Embedding): number {
  return 1 - cosine(a, b);
}

/**
 * How much the set of people talking turned over between two windows.
 *
 * Jaccard distance over the speaker sets: identical speakers score 0, a
 * complete turnover scores 1. **Provisional** — SEG-05 names this term but does
 * not define it, so it is one of §9's open contracts and this definition is
 * subject to the ADR-0007 spikes. Windows with no speaker labels at all (an STT
 * transcript without diarization) contribute 0 rather than a spurious 1.
 */
export function speakerPatternChange(a: ContextWindow, b: ContextWindow): number {
  if (!a.speakers.length && !b.speakers.length) return 0;
  const union = new Set([...a.speakers, ...b.speakers]);
  const shared = a.speakers.filter((speaker) => b.speakers.includes(speaker)).length;
  return 1 - shared / union.size;
}

/** Whether the gap between two windows is long enough to read as a break. */
export function longPause(a: ContextWindow, b: ContextWindow, longPauseMs: number): number {
  return b.tStartMs - a.tEndMs >= longPauseMs ? 1 : 0;
}

/**
 * Scores every candidate boundary in a conversation.
 *
 * ```text
 * topicChange = 0.70 × semanticChange
 *             + 0.10 × longPause
 *             + 0.10 × speakerPatternChange
 *             + 0.10 × discourseCue
 * ```
 *
 * Exact contract (SEG-05). The whole operation is a handful of dot products per
 * boundary, which is what SEG-07 means by "very cheap".
 */
export function scoreBoundaries(
  windows: ContextWindow[],
  embeddings: Embedding[],
  config: BoundaryConfig,
): BoundaryScore[] {
  if (windows.length !== embeddings.length) {
    throw new Error(`Each window needs one embedding: ${windows.length} windows, ${embeddings.length} embeddings`);
  }

  const scores: BoundaryScore[] = [];
  for (let i = 0; i < windows.length - 1; i += 1) {
    const before = windows[i];
    const after = windows[i + 1];
    const signals = {
      semanticChange: semanticChange(embeddings[i], embeddings[i + 1]),
      longPause: longPause(before, after, config.longPauseMs),
      speakerPatternChange: speakerPatternChange(before, after),
      discourseCue: after.opensWithDiscourseCue ? 1 : 0,
    };
    scores.push({
      index: i,
      tStartMs: after.tStartMs,
      ...signals,
      topicChange: BOUNDARY_WEIGHTS.semanticChange * signals.semanticChange
        + BOUNDARY_WEIGHTS.longPause * signals.longPause
        + BOUNDARY_WEIGHTS.speakerPatternChange * signals.speakerPatternChange
        + BOUNDARY_WEIGHTS.discourseCue * signals.discourseCue,
    });
  }
  return scores;
}

/**
 * The local peaks of a boundary-score series (SEG-04).
 *
 * A conversation's scores drift with a low background level and spike where the
 * subject actually turns — the payload's reference series runs .08, .11, .09,
 * **.72**, .13, .08. Detecting peaks rather than thresholding is what makes this
 * work on a calm conversation and a heated one alike: the bar is set by the
 * neighbourhood, not by an absolute number nobody could pick in advance.
 *
 * A score is a peak when it is the strict maximum of its neighbourhood *and*
 * rises at least `peakMinProminence` above that neighbourhood's mean. Both
 * parameters are open contracts (§9) and must be supplied.
 */
export function findBoundaryPeaks(scores: BoundaryScore[], config: BoundaryConfig): BoundaryScore[] {
  const { peakNeighbourhood, peakMinProminence } = config;
  if (!Number.isInteger(peakNeighbourhood) || peakNeighbourhood < 1) {
    throw new Error(`A peak neighbourhood must be at least 1, not ${peakNeighbourhood}`);
  }

  const peaks: BoundaryScore[] = [];
  for (let i = 0; i < scores.length; i += 1) {
    const from = Math.max(0, i - peakNeighbourhood);
    const to = Math.min(scores.length - 1, i + peakNeighbourhood);

    let isMaximum = true;
    let neighbourTotal = 0;
    let neighbourCount = 0;
    for (let j = from; j <= to; j += 1) {
      if (j === i) continue;
      if (scores[j].topicChange >= scores[i].topicChange) { isMaximum = false; break; }
      neighbourTotal += scores[j].topicChange;
      neighbourCount += 1;
    }
    if (!isMaximum || !neighbourCount) continue;

    if (scores[i].topicChange - neighbourTotal / neighbourCount >= peakMinProminence) {
      peaks.push(scores[i]);
    }
  }
  return peaks;
}
