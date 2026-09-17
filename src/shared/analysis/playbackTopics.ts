/**
 * @file shared/analysis/playbackTopics.ts
 *
 * Projects a stored analysis into what the player reads.
 *
 * The whole job is turning the *global* topic graph back into *temporal* spans
 * without losing the distinction that makes it worth having (MODEL-01,
 * MODEL-05). A topic owns segments; segments own time. So a topic's presence on
 * the scrubber is its segments' ranges, and its "23 min" is their sum — not the
 * distance from its first to its last, which for a subject that recurs would
 * span everything in between and claim two unrelated discussions.
 *
 * Also the boundary where vectors are dropped. The analysis keeps centroids and
 * per-segment embeddings because the deferred retrieval work needs them
 * (QRY-01); the player needs none of it, and shipping 2.4 MB of floats into a
 * manifest to render four words would be absurd.
 */

import type { PlaybackTopic } from '../playback';
import type { StoredAnalysis } from './storedAnalysis';

/**
 * Builds the player's topic list, strongest first.
 *
 * A topic whose segments have all gone — a damaged row, or a graph written by
 * an older pipeline — is dropped rather than rendered as a label with nothing
 * behind it: clicking it could not seek anywhere.
 */
export function toPlaybackTopics(analysis: Pick<StoredAnalysis, 'segments' | 'topics'>): PlaybackTopic[] {
  const spansByTopic = new Map<string, Array<{ tStartMs: number; tEndMs: number }>>();
  for (const segment of analysis.segments) {
    const spans = spansByTopic.get(segment.localTopicId) ?? [];
    spans.push({ tStartMs: segment.tStartMs, tEndMs: Math.max(segment.tStartMs, segment.tEndMs) });
    spansByTopic.set(segment.localTopicId, spans);
  }

  return analysis.topics
    .map((topic) => {
      const spans = mergeAdjacent((spansByTopic.get(topic.id) ?? [])
        .sort((a, b) => a.tStartMs - b.tStartMs));
      return {
        id: topic.id,
        keywords: [...topic.keywords],
        spans,
        totalMs: spans.reduce((total, span) => total + (span.tEndMs - span.tStartMs), 0),
        importance: topic.importance,
      };
    })
    .filter((topic) => topic.spans.length > 0)
    .sort((a, b) => b.importance - a.importance || b.totalMs - a.totalMs);
}

/**
 * Joins spans that touch or overlap.
 *
 * Two consecutive segments of one subject are one stretch of conversation to a
 * reader, and drawing them as two bands with a hairline between them would
 * invent a boundary the pipeline explicitly decided was not there — `minSegmentMs`
 * and the merge sweep exist precisely to avoid that impression.
 */
function mergeAdjacent(
  spans: Array<{ tStartMs: number; tEndMs: number }>,
): Array<{ tStartMs: number; tEndMs: number }> {
  const merged: Array<{ tStartMs: number; tEndMs: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.tStartMs <= last.tEndMs) last.tEndMs = Math.max(last.tEndMs, span.tEndMs);
    else merged.push({ ...span });
  }
  return merged;
}
