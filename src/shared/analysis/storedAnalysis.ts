/**
 * @file shared/analysis/storedAnalysis.ts
 *
 * What a completed analysis looks like on disk.
 *
 * The third derived aggregate on a recording, after notations (ADR-0005) and
 * the transcript (ADR-0007). Unlike those two it is *recomputable*: nothing a
 * user authored is here, only what the pipeline concluded, so losing one costs
 * time rather than data — which is why it can be discarded whenever its
 * provenance no longer matches.
 *
 * **Embeddings are kept, not discarded.** They are the bulk of the row —
 * 384 floats per segment — and it would be easy to drop them once topics exist.
 * They stay because they are what makes the deferred retrieval index (QRY-01)
 * and cross-session search (QRY-02) cheap later: re-deriving them means
 * re-embedding the whole conversation. This is the payload's "reusable
 * computational memory" (ARCH-08), and it only holds if the vectors survive.
 *
 * **On disk they are plain number arrays, not `Float32Array`** (plan D-19).
 * Chrome's IndexedDB structure-clones typed arrays correctly, but neither a
 * `Float32Array` nor a raw `ArrayBuffer` survives the clone in this project's
 * test harness — both return as featureless objects — so a packed
 * representation would be one no unit test could verify. Roughly doubling the
 * row (2.4 MB rather than 1.2 MB for three hours, against `unlimitedStorage`)
 * buys a format that round-trips identically everywhere and is covered by
 * tests. In memory the pipeline still works in `Float32Array`; the conversion
 * happens here, at the boundary.
 */

import type { AnalysisProvenance } from './provenance';
import type { ConversationSegment, Topic } from './types';

/** One recording's completed topic analysis, as the pipeline holds it. */
export type StoredAnalysis = {
  /** The conditions this was computed under; see `provenance.ts`. */
  provenance: AnalysisProvenance;
  segments: ConversationSegment[];
  topics: Topic[];
  /** How many transcript segments were analysed, for reporting and sanity checks. */
  utteranceCount: number;
  completedAt: number;
};

/** What the player's rail and the library row need, without the vectors. */
export type AnalysisSummary = {
  topicCount: number;
  segmentCount: number;
  completedAt: number;
  /** Topic labels, strongest first, for the list surface (UI-02). */
  labels: string[][];
};

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function embedding(value: unknown): Float32Array | undefined {
  // Structured clone preserves a Float32Array, but a row written by an older
  // build — or hand-edited — can carry a plain array instead.
  if (value instanceof Float32Array) return value.length ? value : undefined;
  if (Array.isArray(value) && value.length && value.every((v) => typeof v === 'number')) {
    return Float32Array.from(value);
  }
  return undefined;
}

function normalizeProvenance(value: unknown): AnalysisProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  const pipelineVersion = finite(c.pipelineVersion);
  const embeddingDimensions = finite(c.embeddingDimensions);
  if (pipelineVersion == null || embeddingDimensions == null) return undefined;
  if (typeof c.embeddingModel !== 'string' || !c.embeddingModel) return undefined;
  if (typeof c.embeddingModelRevision !== 'string' || !c.embeddingModelRevision) return undefined;
  if (typeof c.embeddingDtype !== 'string' || !c.embeddingDtype) return undefined;
  if (typeof c.configHash !== 'string' || !c.configHash) return undefined;
  return {
    pipelineVersion,
    embeddingModel: c.embeddingModel,
    embeddingModelRevision: c.embeddingModelRevision,
    embeddingDimensions,
    embeddingDtype: c.embeddingDtype as AnalysisProvenance['embeddingDtype'],
    configHash: c.configHash,
  };
}

function normalizeSegment(value: unknown): ConversationSegment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  const tStartMs = finite(c.tStartMs);
  const vector = embedding(c.embedding);
  if (tStartMs == null || !vector) return undefined;
  if (typeof c.id !== 'string' || !c.id) return undefined;
  if (typeof c.localTopicId !== 'string' || !c.localTopicId) return undefined;

  const startWindow = finite(c.startWindow);
  const endWindow = finite(c.endWindow);
  if (startWindow == null || endWindow == null || endWindow <= startWindow) return undefined;

  const rawEnd = finite(c.tEndMs);
  return {
    id: c.id,
    tStartMs,
    tEndMs: rawEnd != null && rawEnd >= tStartMs ? rawEnd : tStartMs,
    embedding: vector,
    localTopicId: c.localTopicId,
    startWindow,
    endWindow,
  };
}

function normalizeTopic(value: unknown): Topic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  const centroid = embedding(c.centroid);
  if (!centroid || typeof c.id !== 'string' || !c.id) return undefined;
  return {
    id: c.id,
    centroid,
    segments: Array.isArray(c.segments) ? c.segments.filter((s): s is string => typeof s === 'string') : [],
    keywords: Array.isArray(c.keywords) ? c.keywords.filter((k): k is string => typeof k === 'string') : [],
    importance: finite(c.importance) ?? 0,
  };
}

/**
 * Decodes a stored analysis.
 *
 * Stricter than the transcript's decoder, and deliberately so: a transcript is
 * the only copy of what was said, so a damaged one degrades field by field
 * rather than being thrown away. An analysis is derived, so a damaged one is
 * discarded and recomputed — cheaper than reasoning about a half-valid topic
 * graph, and impossible to get wrong.
 */
export function normalizeStoredAnalysis(value: unknown): StoredAnalysis | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;

  const provenance = normalizeProvenance(c.provenance);
  if (!provenance) return undefined;

  const segments = Array.isArray(c.segments)
    ? c.segments.map(normalizeSegment).filter((s): s is ConversationSegment => s != null)
    : [];
  const topics = Array.isArray(c.topics)
    ? c.topics.map(normalizeTopic).filter((t): t is Topic => t != null)
    : [];
  if (segments.length !== (Array.isArray(c.segments) ? c.segments.length : 0)) return undefined;
  if (topics.length !== (Array.isArray(c.topics) ? c.topics.length : 0)) return undefined;

  // Every segment must name a topic that exists, or the graph is incoherent.
  const known = new Set(topics.map((t) => t.id));
  if (segments.some((s) => !known.has(s.localTopicId))) return undefined;

  return {
    provenance,
    segments,
    topics,
    utteranceCount: finite(c.utteranceCount) ?? 0,
    completedAt: finite(c.completedAt) ?? 0,
  };
}

/**
 * Converts an analysis into the shape written to IndexedDB.
 *
 * The only difference is the vectors: durable rows carry plain arrays, so the
 * row survives any structured-clone implementation. See the file docblock.
 */
export function toDurableRow(analysis: StoredAnalysis): Record<string, unknown> {
  return {
    provenance: analysis.provenance,
    segments: analysis.segments.map((segment) => ({
      ...segment,
      embedding: Array.from(segment.embedding),
    })),
    topics: analysis.topics.map((topic) => ({
      ...topic,
      centroid: Array.from(topic.centroid),
    })),
    utteranceCount: analysis.utteranceCount,
    completedAt: analysis.completedAt,
  };
}

/**
 * A finished analysis on its way from the data plane to the control plane,
 * before provenance is stamped on it.
 *
 * Exists because the offscreen→background port is **JSON**, not a structured
 * clone: a `Float32Array` sent over it arrives as `{"0": …, "1": …}`, which
 * every consumer downstream would then have to guess at. So the vectors take
 * the same plain-array encoding the durable row uses — one representation for
 * "this left the heap", rather than two.
 */
export type WireAnalysis = {
  segments: Array<Omit<ConversationSegment, 'embedding'> & { embedding: number[] }>;
  topics: Array<Omit<Topic, 'centroid'> & { centroid: number[] }>;
  utteranceCount: number;
};

/** Encodes a pipeline result for the port. */
export function toWireAnalysis(result: {
  segments: ConversationSegment[];
  topics: Topic[];
  utteranceCount: number;
}): WireAnalysis {
  return {
    segments: result.segments.map((segment) => ({ ...segment, embedding: Array.from(segment.embedding) })),
    topics: result.topics.map((topic) => ({ ...topic, centroid: Array.from(topic.centroid) })),
    utteranceCount: result.utteranceCount,
  };
}

/**
 * Decodes a result that arrived over the port, or `undefined` when it is not a
 * coherent one.
 *
 * As strict as {@link normalizeStoredAnalysis} and for the same reason: a
 * damaged analysis is recomputed, never half-trusted. The topic-reference check
 * matters most here — it is what stops a truncated message from being persisted
 * as a graph whose segments point at topics that do not exist.
 */
export function fromWireAnalysis(value: unknown): Omit<StoredAnalysis, 'provenance' | 'completedAt'> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  if (!Array.isArray(c.segments) || !Array.isArray(c.topics)) return undefined;

  const segments = c.segments.map(normalizeSegment).filter((s): s is ConversationSegment => s != null);
  const topics = c.topics.map(normalizeTopic).filter((t): t is Topic => t != null);
  if (segments.length !== c.segments.length || topics.length !== c.topics.length) return undefined;

  const known = new Set(topics.map((t) => t.id));
  if (segments.some((s) => !known.has(s.localTopicId))) return undefined;

  return { segments, topics, utteranceCount: finite(c.utteranceCount) ?? 0 };
}

/**
 * One recording's topics as the library table needs them: something to show in
 * a column, and something to match a query against.
 *
 * Separate from {@link AnalysisSummary} because the two answer different
 * questions. That one describes a *result* — how many topics, when it ran — for
 * a surface deciding whether to offer a re-run. This one is for *finding* a
 * recording, so it flattens every keyword into one haystack and keeps only the
 * few terms a narrow column can show.
 */
export type RecordingTopicSummary = {
  /** Topic labels for the column, strongest topic first, already truncated. */
  keywords: string[];
  /** Every keyword of every topic, lowercased, for substring matching. */
  search: string;
  topicCount: number;
};

/** How many keywords the library column can show before it stops being a column. */
const LIBRARY_KEYWORDS = 4;

export function toTopicSummary(analysis: Pick<StoredAnalysis, 'topics'>): RecordingTopicSummary {
  const ranked = [...analysis.topics].sort((a, b) => b.importance - a.importance);
  return {
    // Taken across topics rather than from the strongest one alone: a library
    // row is there to say what the call covered, not to name its best topic.
    keywords: ranked.flatMap((topic) => topic.keywords).slice(0, LIBRARY_KEYWORDS),
    search: ranked.flatMap((topic) => topic.keywords).join(' ').toLocaleLowerCase(),
    topicCount: ranked.length,
  };
}

/** The list-surface view, with the vectors left behind. */
export function summarize(analysis: StoredAnalysis): AnalysisSummary {
  return {
    topicCount: analysis.topics.length,
    segmentCount: analysis.segments.length,
    completedAt: analysis.completedAt,
    labels: [...analysis.topics]
      .sort((a, b) => b.importance - a.importance)
      .map((topic) => topic.keywords),
  };
}
