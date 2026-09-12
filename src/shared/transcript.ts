/**
 * @file shared/transcript.ts
 *
 * A transcript: what was said, when, and by whom — the third timecoded
 * aggregate on a recording, after notations (ADR-0005) and the recording's own
 * files. See ADR-0007 Decision 1 and `docs/plans/local-text-processing.md` §3.
 *
 * **A transcript has a source, not a provenance story.** The segment shape is
 * identical whether the words came from scraped DOM captions or from speech
 * recognition over the captured audio, so every consumer — export, search,
 * topic analysis — reads one type and never branches on where it came from.
 * This is the seam `docs/plans/portable-transcription.md` §B0 specifies; that
 * plan's STT backbone lands later underneath it, adding `'stt'` segments and
 * changing nothing above.
 *
 * **Two time bases, deliberately separate types.** {@link CaptionUtterance} is
 * what the content script observes: wall clock, because the Meet tab has no
 * idea a recording exists, let alone whether it is paused.
 * {@link TranscriptSegment} is what gets stored: *media-relative* offsets in the
 * same domain as {@link RecordingNotation.tStartMs}, so a transcript offset is
 * directly a playback position. Only background can bridge them, because only
 * background holds the pause-aware clock (`RecordingSession.currentRecordedMs`).
 * Keeping them as one type would mean a field whose meaning depends on which
 * side of a message boundary you read it — exactly the bug this split prevents.
 *
 * **Decode is tolerant, writes are strict** — as with notations. A segment with
 * a broken `tEndMs` degrades to a zero-length segment rather than dropping the
 * words; a segment with no usable start is not a segment at all.
 */

/** Where a transcript's words came from. Consumers must not branch on this. */
export type TranscriptSource = 'meet-captions' | 'stt';

/**
 * One utterance, stored. Offsets are media-relative and pause-aware, matching
 * {@link RecordingNotation} — see the file docblock.
 *
 * `speaker` is optional because it is a property of the *source*, not of
 * transcripts: DOM captions are speaker-labelled for free, and local STT is not
 * (diarization is a separate problem). Absent means unknown, never anonymous.
 */
export type TranscriptSegment = {
  /**
   * **Media-relative** milliseconds: the offset into the produced file, with
   * paused stretches excluded, exactly as {@link RecordingNotation.tStartMs}.
   * Seeking a player here lands on these words. Never a wall clock — see
   * {@link CaptionUtterance.startWallMs}, which is.
   */
  tStartMs: number;
  /** Media-relative end offset in ms; always finite and >= `tStartMs`. */
  tEndMs: number;
  speaker?: string;
  text: string;
};

export type Transcript = {
  source: TranscriptSource;
  segments: TranscriptSegment[];
};

/**
 * One committed utterance as the content script sees it: wall clock, because
 * that is the only clock the Meet tab has. Background converts these into
 * {@link TranscriptSegment}s against the run's pause-aware clock.
 */
export type CaptionUtterance = {
  /**
   * **Wall-clock** milliseconds (`Date.now()`) at first sight of this
   * utterance — when the words were *spoken*, not when the buffer committed
   * them. The distinction matters at the edges of a run: speech at 10.0s that
   * commits at 12.2s, after the recorder stopped, still belongs in the file.
   *
   * Deliberately not named `tStartMs`: that name means media-relative
   * throughout this codebase, and these two are never interchangeable.
   */
  startWallMs: number;
  /** Wall clock at the last change before the grace window elapsed. */
  endWallMs: number;
  speaker: string;
  text: string;
};

/**
 * Per-recording cap, following the house rule that durable lists are always
 * bounded (`MAX_NOTATIONS_PER_RECORDING`, `MAX_ORPHANS_PER_RUN`).
 *
 * Sized from the plan's own working set: three hours of conversation is
 * 1,000–3,000 turns (`docs/plans/local-text-processing.md` EMB-05), so this
 * leaves roughly 6x headroom for a longer or faster-turning recording. It is a
 * runaway guard, not a product limit — nothing in normal use should approach it.
 */
export const MAX_TRANSCRIPT_SEGMENTS = 20_000;

/**
 * A committed utterance is one speaker's speech within a grace window, so it is
 * naturally short. This only stops a pathological caption node from making one
 * unbounded row.
 */
export const MAX_TRANSCRIPT_TEXT_LENGTH = 2_000;

const TRANSCRIPT_SOURCES: readonly TranscriptSource[] = ['meet-captions', 'stt'];

export function isTranscriptSource(value: unknown): value is TranscriptSource {
  return typeof value === 'string' && (TRANSCRIPT_SOURCES as readonly string[]).includes(value);
}

export function normalizeTranscriptText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TRANSCRIPT_TEXT_LENGTH) : '';
}

function finiteOffset(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeSpeaker(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const speaker = value.trim().slice(0, MAX_TRANSCRIPT_TEXT_LENGTH);
  return speaker || undefined;
}

/**
 * Decodes one durable segment. Unlike a notation, a segment with no text is not
 * worth keeping — a notation's whole point can be marking a moment to name
 * later, but an utterance with no words is noise.
 */
export function normalizeTranscriptSegment(value: unknown): TranscriptSegment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const tStartMs = finiteOffset(candidate.tStartMs);
  if (tStartMs == null) return undefined;

  const text = normalizeTranscriptText(candidate.text);
  if (!text) return undefined;

  // An end before its start is meaningless; the words are not. Degrade to a
  // zero-length segment so the utterance keeps its place on the timeline.
  const rawEnd = finiteOffset(candidate.tEndMs);
  const tEndMs = rawEnd != null && rawEnd >= tStartMs ? rawEnd : tStartMs;
  const speaker = normalizeSpeaker(candidate.speaker);
  return { tStartMs, tEndMs, ...(speaker ? { speaker } : {}), text };
}

/** Chronological order, tie-broken by end then text so the sort is stable across reads. */
export function sortTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort(
    (a, b) => a.tStartMs - b.tStartMs || a.tEndMs - b.tEndMs || a.text.localeCompare(b.text),
  );
}

/** Decodes a durable segment list into chronological order. Invalid records are skipped. */
export function normalizeTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return sortTranscriptSegments(
    value
      .map(normalizeTranscriptSegment)
      .filter((segment): segment is TranscriptSegment => segment != null)
      .slice(0, MAX_TRANSCRIPT_SEGMENTS),
  );
}

/** Decodes a durable transcript. An unreadable source makes the whole record unreadable. */
export function normalizeTranscript(value: unknown): Transcript | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (!isTranscriptSource(candidate.source)) return undefined;
  return { source: candidate.source, segments: normalizeTranscriptSegments(candidate.segments) };
}

export function normalizeCaptionUtterance(value: unknown): CaptionUtterance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const startWallMs = finiteOffset(candidate.startWallMs);
  if (startWallMs == null) return undefined;

  const text = normalizeTranscriptText(candidate.text);
  if (!text) return undefined;

  const rawEnd = finiteOffset(candidate.endWallMs);
  const endWallMs = rawEnd != null && rawEnd >= startWallMs ? rawEnd : startWallMs;
  return { startWallMs, endWallMs, speaker: normalizeSpeaker(candidate.speaker) ?? '', text };
}

export function normalizeCaptionUtterances(value: unknown): CaptionUtterance[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeCaptionUtterance)
    .filter((utterance): utterance is CaptionUtterance => utterance != null)
    .slice(0, MAX_TRANSCRIPT_SEGMENTS);
}

/**
 * Maps an utterance's *spoken* wall-clock span onto the media timeline, or
 * answers `undefined` when it began somewhere the file does not contain.
 *
 * Implemented by `RecordingSession.recordedRangeAt`. It takes the whole span
 * rather than one instant so the owner of the clock can decide what to do with
 * an utterance that outlives its recorded span — truncating to real recorded
 * time rather than inventing an alignment.
 */
export type MediaRangeProjector = (
  startWallMs: number,
  endWallMs: number,
) => { tStartMs: number; tEndMs: number } | undefined;

/**
 * Projects wall-clock utterances onto the recording's media timeline.
 *
 * Each utterance is projected from *when it was spoken*, never from when the
 * caption buffer committed it: speech at 10.0s that commits at 12.2s, after the
 * recorder stopped, is in the file and belongs in the transcript.
 *
 * Utterances that begin outside the recorded media — before the run, after it,
 * or inside a paused stretch — are dropped rather than clamped, because a
 * segment invented at the edge of a pause would seek to words that are not
 * there.
 */
export function toTranscriptSegments(
  utterances: CaptionUtterance[],
  project: MediaRangeProjector,
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const utterance of utterances) {
    const range = project(utterance.startWallMs, utterance.endWallMs);
    if (!range) continue;
    segments.push({
      tStartMs: range.tStartMs,
      tEndMs: Math.max(range.tStartMs, range.tEndMs),
      ...(utterance.speaker ? { speaker: utterance.speaker } : {}),
      text: utterance.text,
    });
  }
  return sortTranscriptSegments(segments);
}
