/**
 * @file shared/analysis/analyzeTranscript.ts
 *
 * The whole deterministic pipeline, in one function.
 *
 * ```text
 * transcript → windows → embeddings → boundaries → peaks → segments
 *                            ↓                                ↓
 *                            └────────────── clusters ← ──────┘
 *                                               ↓
 *                                     labels + importance
 * ```
 *
 * Encoding is injected rather than imported, which is what keeps this testable:
 * the caller supplies a real worker in production and a stub in tests, and
 * every stage above the encoder is exercised either way — no GPU, no model, no
 * network (ARCH-04). It is also what lets the calibration harness replay cached
 * vectors instead of re-embedding for each of 40,500 configurations.
 */

import { buildContextWindows } from './windows';
import { findBoundaryPeaks, scoreBoundaries } from './boundaries';
import { buildConversationSegments } from './segments';
import { clusterSegments } from './clusters';
import { topicLabels } from './keywords';
import { rankPassages, type Passage } from './importance';
import type { TranscriptSegment } from '../transcript';
import type { AnalysisConfig, ContextWindow, Embedding, Topic } from './types';

/** EMB-07, exact contract: windows are encoded 32 at a time. */
export const EMBEDDING_BATCH_SIZE = 32;

/** Encodes a batch of window texts. Supplied by the caller; see the file docblock. */
export type EncodeBatch = (texts: string[]) => Promise<Embedding[]>;

export type AnalysisProgress = {
  windowsEncoded: number;
  windowsTotal: number;
};

export type AnalysisResult = {
  segments: import('./types').ConversationSegment[];
  topics: Topic[];
  utteranceCount: number;
};

export type AnalyzeOptions = {
  onProgress?: (progress: AnalysisProgress) => void;
  /** Aborts between batches, so a cancelled job stops at the next boundary. */
  signal?: { aborted: boolean };
};

/**
 * Runs the pipeline over one recording's transcript.
 *
 * Only an *empty* transcript yields nothing. A recording too short to fill a
 * window still gets one, because `buildContextWindows` covers a short
 * transcript rather than dropping it — so two utterances are one thin topic,
 * which is a legitimate outcome rather than a failure.
 */
export async function analyzeTranscript(
  transcript: TranscriptSegment[],
  config: AnalysisConfig,
  encode: EncodeBatch,
  options: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  const windows = buildContextWindows(transcript, config);
  if (!windows.length) return { segments: [], topics: [], utteranceCount: transcript.length };

  const embeddings = await encodeAll(windows, encode, options);

  const scores = scoreBoundaries(windows, embeddings, config);
  const peaks = findBoundaryPeaks(scores, config);
  const temporal = buildConversationSegments(windows, embeddings, peaks, config);
  const { clusters, segments } = clusterSegments(temporal, config);

  // A topic is labelled from the words its segments actually cover, which is
  // what `startWindow`/`endWindow` exist for.
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const documents = clusters.map((cluster) => ({
    id: cluster.id,
    text: cluster.segmentIds
      .map((id) => byId.get(id))
      .filter((segment): segment is NonNullable<typeof segment> => segment != null)
      .flatMap((segment) => windows.slice(segment.startWindow, segment.endWindow))
      .map((window) => window.text)
      .join(' '),
  }));
  const labels = topicLabels(documents, config);

  const topics: Topic[] = clusters.map((cluster) => {
    const keywords = labels.get(cluster.id) ?? [];
    return {
      id: cluster.id,
      centroid: cluster.centroid,
      segments: cluster.segmentIds,
      keywords,
      importance: topicImportance(cluster.id, cluster.centroid, cluster.segmentIds, byId, windows, embeddings, keywords),
    };
  });

  return { segments, topics, utteranceCount: transcript.length };
}

/**
 * Encodes every window in production-sized batches (EMB-07).
 *
 * Sequential rather than concurrent: the encoder is one GPU or one WASM thread,
 * so overlapping batches would queue against themselves while making
 * cancellation and progress harder to reason about.
 */
async function encodeAll(
  windows: ContextWindow[],
  encode: EncodeBatch,
  options: AnalyzeOptions,
): Promise<Embedding[]> {
  const embeddings: Embedding[] = [];
  for (let i = 0; i < windows.length; i += EMBEDDING_BATCH_SIZE) {
    if (options.signal?.aborted) throw new Error('Analysis was cancelled');
    const batch = windows.slice(i, i + EMBEDDING_BATCH_SIZE);
    const encoded = await encode(batch.map((window) => window.text));
    if (encoded.length !== batch.length) {
      throw new Error(`The encoder returned ${encoded.length} vectors for ${batch.length} windows`);
    }
    embeddings.push(...encoded);
    options.onProgress?.({ windowsEncoded: embeddings.length, windowsTotal: windows.length });
  }
  return embeddings;
}

/**
 * How much a topic matters, as the mean importance of its passages (IMP-02…06).
 *
 * A topic's own score has to come from somewhere, and the payload only defines
 * importance for *passages*. Averaging is the reading that keeps a long, dull
 * stretch from outranking a short, consequential one purely on length.
 */
/**
 * A topic's standing, as the mean importance of the passages it covers.
 *
 * **The centroid is the cluster's, not any one segment's.** IMP-02 is explicit:
 * importance is measured against the centroid over a topic's segment
 * embeddings. Ranking against the first segment's embedding instead — which
 * this did — quietly scores a topic by how much it resembles its own opening,
 * and is worst exactly where global topics earn their keep: for a subject the
 * conversation returns to, the later stretches are penalised for differing from
 * the first, which is the thing the centroid exists to average away.
 *
 * The mean rather than the sum is our own choice, and IMP-03 does not cover it:
 * summing would let a long dull stretch outrank a short consequential one on
 * length alone.
 */
function topicImportance(
  topicId: string,
  centroid: Embedding,
  segmentIds: string[],
  byId: Map<string, import('./types').ConversationSegment>,
  windows: ContextWindow[],
  embeddings: Embedding[],
  keywords: string[],
): number {
  const passages: Passage[] = [];
  for (const id of segmentIds) {
    const segment = byId.get(id);
    if (!segment) continue;
    for (let i = segment.startWindow; i < segment.endWindow; i += 1) {
      passages.push({
        id: `${topicId}:${i}`,
        tStartMs: windows[i].tStartMs,
        tEndMs: windows[i].tEndMs,
        text: windows[i].text,
        embedding: embeddings[i],
      });
    }
  }
  if (!passages.length) return 0;

  const ranked = rankPassages(passages, { centroid, keywords });
  return ranked.reduce((sum, passage) => sum + passage.importance, 0) / ranked.length;
}
