/**
 * @file shared/analysis/types.ts
 *
 * The vocabulary of topic analysis: what the pipeline reads, what it produces,
 * and the values it refuses to guess.
 *
 * **Two aggregates, deliberately separate** (`docs/plans/local-text-processing.md`
 * MODEL-01, MODEL-05). A {@link ConversationSegment} is *temporal*: one
 * contiguous stretch of one subject. A {@link Topic} is *global*: it gathers
 * segments that need not be adjacent. A meeting that goes Berlin → Redis →
 * Hiring → Redis → Berlin is five segments and three topics. Collapsing the two
 * into "one topic per time range" cannot represent a subject that recurs, which
 * is the normal shape of a real conversation.
 *
 * **Timecodes are segment-level, not word-level.** Offsets here are inherited
 * from `TranscriptSegment` and bound a stretch of media that genuinely exists,
 * but a caption's text is not word-aligned to its own timecodes — see ADR-0007's
 * pause-boundary amendment. Nothing in this pipeline may locate an individual
 * word from a segment's offsets.
 */

/**
 * One embedding. 384 dimensions for `multilingual-e5-small` (EMB-03), though
 * nothing here depends on the width — the stage tests run against a stub
 * encoder of whatever size they please.
 */
export type Embedding = Float32Array;

/**
 * A contextual embedding window: the unit that actually gets encoded.
 *
 * A window is 3–5 consecutive utterances, which is the same span SEG-02 asks
 * for on each side of a candidate boundary — so one set of embeddings serves
 * both boundary detection and clustering, exactly as ARCH-03's diagram branches
 * them. It is also what makes the sizing work: 1,000–3,000 turns at ~4
 * utterances per window is the 300–800 windows EMB-06 predicts.
 */
export type ContextWindow = {
  /** Index of this window's first transcript segment. */
  startIndex: number;
  /** Index one past its last transcript segment. */
  endIndex: number;
  /** Media-relative bounds, inherited from the transcript segments it covers. */
  tStartMs: number;
  tEndMs: number;
  /** The window's text, for encoding and for c-TF-IDF. */
  text: string;
  /** Distinct speakers heard in this window, in order of first appearance. */
  speakers: string[];
  /**
   * Whether any utterance in this window *opens* with a discourse cue (SEG-06).
   *
   * Derived here because only the window builder sees the individual
   * utterances. Matching on where an utterance begins, rather than anywhere in
   * the window's joined text, is what makes this need no threshold: a discourse
   * marker introduces a turn, so "anyway, about Redis" counts and "we could do
   * it anyway" does not.
   */
  opensWithDiscourseCue: boolean;
};

/** One contiguous stretch of conversation about one subject (MODEL-02). */
export type ConversationSegment = {
  id: string;
  /** Media-relative, pause-aware — the same domain as `RecordingNotation.tStartMs`. */
  tStartMs: number;
  tEndMs: number;
  embedding: Embedding;
  /** The topic this segment was assigned to. */
  localTopicId: string;
};

/**
 * A segment before clustering has given it a topic.
 *
 * Segmentation is temporal and clustering is global (MODEL-05), so they run in
 * that order and this is what passes between them: the stretch and its
 * embedding, with no opinion yet about what subject it belongs to.
 */
export type TemporalSegment = Omit<ConversationSegment, 'localTopicId'>;

/** A subject, gathering its segments from anywhere in the conversation (MODEL-03). */
export type Topic = {
  id: string;
  centroid: Embedding;
  /** {@link ConversationSegment.id}s, referenced by key rather than by object graph. */
  segments: string[];
  keywords: string[];
  importance: number;
};

/**
 * Boundary-signal weights (SEG-05). Exact contract from the source payload —
 * not tuneable, not config. They sum to 1.
 */
export const BOUNDARY_WEIGHTS = {
  semanticChange: 0.70,
  longPause: 0.10,
  speakerPatternChange: 0.10,
  discourseCue: 0.10,
} as const;

/**
 * Discourse cues that mark a topic change (SEG-06). Exact contract.
 *
 * The payload writes the last as `"speaking of..."`; the ellipsis denotes the
 * continuation a speaker goes on to say, not literal characters in a caption,
 * so the phrase is what is matched.
 *
 * Known limitation, recorded rather than hidden: these are English only, while
 * the encoder is deliberately multilingual (EMB-03). On a non-English call this
 * term contributes nothing and the blend degrades to 0.70/0.10/0.10/0.00 rather
 * than failing.
 */
export const DISCOURSE_CUES = [
  'anyway',
  'by the way',
  'next question',
  'moving on',
  'another thing',
  'speaking of',
] as const;

/**
 * Values the source payload does not fix.
 *
 * `docs/plans/local-text-processing.md` §9 lists these as open contracts, to be
 * frozen from the ADR-0007 Validation spikes and recorded there. There is
 * deliberately **no default export of this type**: a plausible-looking number
 * chosen here would become the frozen value by accident, which is exactly what
 * the plan's discipline exists to prevent. Callers supply it; tests supply
 * fixture values that make their arithmetic legible.
 */
export type SegmentationConfig = {
  /** Utterances per contextual window. SEG-02 bounds this to 3–5. */
  windowUtterances: number;
  /** How many utterances the window start advances each step. */
  windowStride: number;
  /** A gap at least this long between utterances counts as a long pause. */
  longPauseMs: number;
  /** Half-width of the neighbourhood a score must top to be a local peak. */
  peakNeighbourhood: number;
  /** How far a peak must rise above its neighbourhood's mean to count. */
  peakMinProminence: number;
  /** Shortest segment worth emitting; shorter runs merge into their neighbour. */
  minSegmentMs: number;
};

/**
 * True when an utterance opens with one of {@link DISCOURSE_CUES}.
 *
 * Compares against a lowercased, punctuation-trimmed prefix, so "Anyway," and
 * "anyway" both count. Requires a word boundary after the cue so "moving on"
 * matches but "movingonward" does not.
 */
export function startsWithDiscourseCue(text: string): boolean {
  const opening = text.trim().toLowerCase();
  return DISCOURSE_CUES.some((cue) => {
    if (!opening.startsWith(cue)) return false;
    const next = opening.charAt(cue.length);
    return next === '' || !/[a-z0-9]/.test(next);
  });
}

export function createSegmentId(): string {
  return `segment:${crypto.randomUUID()}`;
}

export function createTopicId(): string {
  return `topic:${crypto.randomUUID()}`;
}
