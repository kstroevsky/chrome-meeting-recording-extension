/**
 * @file shared/analysis/segments.ts
 *
 * Turns boundary peaks into the temporal segments the rest of the pipeline
 * works on.
 *
 * This is the stage that makes segmentation *temporal* (MODEL-05): a segment is
 * one contiguous run of windows between two boundaries. What subject it belongs
 * to is not decided here — that is clustering's job, and a subject can recur in
 * segments far apart, which is precisely why the two are separate.
 */

import { meanCentroid } from './vector';
import { createSegmentId, type ContextWindow, type Embedding, type SegmentationConfig, type TemporalSegment } from './types';
import type { BoundaryScore } from './boundaries';

export type SegmentAssemblyConfig = Pick<SegmentationConfig, 'minSegmentMs'>;

/**
 * Cuts the conversation at its boundary peaks.
 *
 * A segment's embedding is the mean of its windows', so a long segment is
 * represented by where it points on average rather than by whichever window
 * happened to be first. That mean is what clustering compares and what
 * importance ranks against.
 *
 * Runs shorter than `minSegmentMs` are folded into the preceding segment (or
 * the following one, at the start of a conversation). A twenty-second sliver is
 * not a topic; keeping it would fragment the timeline the UI has to render, and
 * it would drag a cluster centroid around for a subject nobody actually
 * changed to. `minSegmentMs` is an open contract (§9).
 */
export function buildConversationSegments(
  windows: ContextWindow[],
  embeddings: Embedding[],
  peaks: BoundaryScore[],
  config: SegmentAssemblyConfig,
): TemporalSegment[] {
  if (windows.length !== embeddings.length) {
    throw new Error(`Each window needs one embedding: ${windows.length} windows, ${embeddings.length} embeddings`);
  }
  if (!windows.length) return [];

  // A peak at index i means the cut falls between window i and window i + 1.
  const cuts = [...new Set(peaks.map((peak) => peak.index + 1))].sort((a, b) => a - b);
  const runs: { from: number; to: number }[] = [];
  let from = 0;
  for (const cut of cuts) {
    if (cut <= from || cut >= windows.length) continue;
    runs.push({ from, to: cut });
    from = cut;
  }
  runs.push({ from, to: windows.length });

  return mergeShortRuns(runs, windows, config.minSegmentMs)
    .map((run) => toSegment(run, windows, embeddings));
}

/**
 * Folds runs shorter than the floor into a neighbour.
 *
 * Backwards by preference, because a sliver almost always belongs to the
 * subject that was already running; only a sliver at the very start has no
 * predecessor and joins what follows instead.
 */
function mergeShortRuns(
  runs: { from: number; to: number }[],
  windows: ContextWindow[],
  minSegmentMs: number,
): { from: number; to: number }[] {
  const merged: { from: number; to: number }[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && durationOf(run, windows) < minSegmentMs) {
      previous.to = run.to;
      continue;
    }
    merged.push({ ...run });
  }

  // The first run can only be folded forwards, and only once everything else
  // has settled — otherwise a conversation that opens with a sliver loses it.
  if (merged.length > 1 && durationOf(merged[0], windows) < minSegmentMs) {
    merged[1].from = merged[0].from;
    merged.shift();
  }
  return merged;
}

function durationOf(run: { from: number; to: number }, windows: ContextWindow[]): number {
  return windows[run.to - 1].tEndMs - windows[run.from].tStartMs;
}

function toSegment(
  run: { from: number; to: number },
  windows: ContextWindow[],
  embeddings: Embedding[],
): TemporalSegment {
  return {
    id: createSegmentId(),
    tStartMs: windows[run.from].tStartMs,
    tEndMs: windows[run.to - 1].tEndMs,
    embedding: meanCentroid(embeddings.slice(run.from, run.to)),
  };
}
