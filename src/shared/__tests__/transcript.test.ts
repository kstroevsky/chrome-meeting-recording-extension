import {
  MAX_TRANSCRIPT_SEGMENTS,
  MAX_TRANSCRIPT_TEXT_LENGTH,
  isTranscriptSource,
  normalizeCaptionUtterance,
  normalizeCaptionUtterances,
  normalizeTranscript,
  normalizeTranscriptSegment,
  normalizeTranscriptSegments,
  sortTranscriptSegments,
  toTranscriptSegments,
  type CaptionUtterance,
} from '../transcript';

describe('transcript durable-data boundaries', () => {
  it('normalizes a valid segment and trims its text and speaker', () => {
    expect(normalizeTranscriptSegment({
      tStartMs: 12_500,
      tEndMs: 41_000,
      speaker: '  Ada  ',
      text: '  the pool is saturated  ',
    })).toEqual({ tStartMs: 12_500, tEndMs: 41_000, speaker: 'Ada', text: 'the pool is saturated' });
  });

  it('omits an absent or blank speaker rather than storing an empty one', () => {
    expect(normalizeTranscriptSegment({ tStartMs: 0, tEndMs: 1, text: 'x' }))
      .toEqual({ tStartMs: 0, tEndMs: 1, text: 'x' });
    expect(normalizeTranscriptSegment({ tStartMs: 0, tEndMs: 1, speaker: '   ', text: 'x' }))
      .toEqual({ tStartMs: 0, tEndMs: 1, text: 'x' });
  });

  it('discards segments without a usable start offset', () => {
    expect(normalizeTranscriptSegment({ tEndMs: 1, text: 'x' })).toBeUndefined();
    expect(normalizeTranscriptSegment({ tStartMs: -1, tEndMs: 1, text: 'x' })).toBeUndefined();
    expect(normalizeTranscriptSegment({ tStartMs: Number.NaN, tEndMs: 1, text: 'x' })).toBeUndefined();
    expect(normalizeTranscriptSegment({ tStartMs: Infinity, tEndMs: 1, text: 'x' })).toBeUndefined();
    expect(normalizeTranscriptSegment('nope')).toBeUndefined();
    expect(normalizeTranscriptSegment(null)).toBeUndefined();
  });

  it('discards a segment with no words — unlike a notation, an empty utterance is noise', () => {
    expect(normalizeTranscriptSegment({ tStartMs: 0, tEndMs: 1, text: '   ' })).toBeUndefined();
    expect(normalizeTranscriptSegment({ tStartMs: 0, tEndMs: 1 })).toBeUndefined();
  });

  it('degrades an out-of-order or malformed end to a zero-length segment, keeping the words', () => {
    expect(normalizeTranscriptSegment({ tStartMs: 5_000, tEndMs: 4_999, text: 'x' }))
      .toEqual({ tStartMs: 5_000, tEndMs: 5_000, text: 'x' });
    expect(normalizeTranscriptSegment({ tStartMs: 5_000, tEndMs: 'later', text: 'x' }))
      .toEqual({ tStartMs: 5_000, tEndMs: 5_000, text: 'x' });
    expect(normalizeTranscriptSegment({ tStartMs: 5_000, text: 'x' }))
      .toEqual({ tStartMs: 5_000, tEndMs: 5_000, text: 'x' });
  });

  it('bounds segment text and speaker length', () => {
    const long = 'a'.repeat(MAX_TRANSCRIPT_TEXT_LENGTH + 50);
    const segment = normalizeTranscriptSegment({ tStartMs: 0, tEndMs: 1, speaker: long, text: long });
    expect(segment?.text).toHaveLength(MAX_TRANSCRIPT_TEXT_LENGTH);
    expect(segment?.speaker).toHaveLength(MAX_TRANSCRIPT_TEXT_LENGTH);
  });

  it('sorts a decoded list chronologically and skips invalid records', () => {
    expect(normalizeTranscriptSegments([
      { tStartMs: 900, tEndMs: 1_000, text: 'second' },
      'nope',
      { tStartMs: 10, tEndMs: 20, text: 'first' },
      { tStartMs: -5, tEndMs: 0, text: 'dropped' },
    ])).toEqual([
      { tStartMs: 10, tEndMs: 20, text: 'first' },
      { tStartMs: 900, tEndMs: 1_000, text: 'second' },
    ]);
    expect(normalizeTranscriptSegments('nope')).toEqual([]);
  });

  it('bounds the decoded list', () => {
    const many = Array.from({ length: MAX_TRANSCRIPT_SEGMENTS + 10 }, (_, i) => ({
      tStartMs: i, tEndMs: i, text: `line ${i}`,
    }));
    expect(normalizeTranscriptSegments(many)).toHaveLength(MAX_TRANSCRIPT_SEGMENTS);
  });

  it('breaks sort ties by end then text so reads are stable', () => {
    const tied = [
      { tStartMs: 5, tEndMs: 9, text: 'b' },
      { tStartMs: 5, tEndMs: 9, text: 'a' },
      { tStartMs: 5, tEndMs: 7, text: 'c' },
    ];
    expect(sortTranscriptSegments(tied).map((s) => s.text)).toEqual(['c', 'a', 'b']);
    expect(sortTranscriptSegments(tied)).not.toBe(tied);
  });

  it('reads a whole transcript only when its source is known', () => {
    expect(normalizeTranscript({ source: 'meet-captions', segments: [{ tStartMs: 0, tEndMs: 1, text: 'x' }] }))
      .toEqual({ source: 'meet-captions', segments: [{ tStartMs: 0, tEndMs: 1, text: 'x' }] });
    expect(normalizeTranscript({ source: 'stt', segments: 'nope' }))
      .toEqual({ source: 'stt', segments: [] });
    expect(normalizeTranscript({ source: 'guessed', segments: [] })).toBeUndefined();
    expect(normalizeTranscript({ segments: [] })).toBeUndefined();
    expect(normalizeTranscript(null)).toBeUndefined();
  });

  it('recognizes exactly the two known sources', () => {
    expect(isTranscriptSource('meet-captions')).toBe(true);
    expect(isTranscriptSource('stt')).toBe(true);
    expect(isTranscriptSource('whisper')).toBe(false);
    expect(isTranscriptSource(null)).toBe(false);
  });
});

describe('caption utterance decoding', () => {
  it('keeps an unlabelled speaker as an empty string on the wire shape', () => {
    expect(normalizeCaptionUtterance({ startWallMs: 5, endWallMs: 9, text: 'hi' }))
      .toEqual({ startWallMs: 5, endWallMs: 9, speaker: '', text: 'hi' });
  });

  it('degrades an out-of-order end and drops unusable records', () => {
    expect(normalizeCaptionUtterance({ startWallMs: 9, endWallMs: 5, speaker: 'Ada', text: 'hi' }))
      .toEqual({ startWallMs: 9, endWallMs: 9, speaker: 'Ada', text: 'hi' });
    expect(normalizeCaptionUtterance({ endWallMs: 5, text: 'hi' })).toBeUndefined();
    expect(normalizeCaptionUtterance({ startWallMs: 5, endWallMs: 9, text: '  ' })).toBeUndefined();
    expect(normalizeCaptionUtterances('nope')).toEqual([]);
  });
});

describe('projecting wall-clock utterances onto the media timeline', () => {
  const utterance = (startWallMs: number, endWallMs: number, text: string): CaptionUtterance =>
    ({ startWallMs, endWallMs, speaker: 'Ada', text });

  /** A projector over explicit recorded spans, like the session's ledger. */
  const projectorOver = (spans: { from: number; to: number; mediaStart: number }[]) =>
    (startWallMs: number, endWallMs: number) => {
      const span = spans.find((s) => startWallMs >= s.from && startWallMs <= s.to);
      if (!span) return undefined;
      const boundedEnd = Math.min(Math.max(endWallMs, startWallMs), span.to);
      return {
        tStartMs: span.mediaStart + (startWallMs - span.from),
        tEndMs: span.mediaStart + (boundedEnd - span.from),
      };
    };

  const ONE_SPAN = projectorOver([{ from: 1_000, to: 11_000, mediaStart: 0 }]);

  it('rebases each utterance through the projector', () => {
    expect(toTranscriptSegments(
      [utterance(1_500, 2_000, 'first'), utterance(3_000, 3_400, 'second')],
      ONE_SPAN,
    )).toEqual([
      { tStartMs: 500, tEndMs: 1_000, speaker: 'Ada', text: 'first' },
      { tStartMs: 2_000, tEndMs: 2_400, speaker: 'Ada', text: 'second' },
    ]);
  });

  it('projects from when words were spoken, not when the buffer committed them', () => {
    // Spoken at 10.7s, recorder stopped at 11.0s, committed at 12.2s. The words
    // are in the file; mapping the commit time would have thrown them away.
    expect(toTranscriptSegments([utterance(10_700, 10_900, "that's the answer")], ONE_SPAN))
      .toEqual([{ tStartMs: 9_700, tEndMs: 9_900, speaker: 'Ada', text: "that's the answer" }]);
  });

  it('drops utterances that begin outside the recorded media rather than clamping', () => {
    const paused = projectorOver([
      { from: 1_000, to: 5_000, mediaStart: 0 },
      { from: 15_000, to: 20_000, mediaStart: 4_000 },
    ]);
    expect(toTranscriptSegments(
      [utterance(8_000, 8_500, 'during the pause'), utterance(16_000, 16_400, 'after')],
      paused,
    )).toEqual([{ tStartMs: 5_000, tEndMs: 5_400, speaker: 'Ada', text: 'after' }]);
  });

  it('keeps an utterance that starts inside a span but runs past its end', () => {
    expect(toTranscriptSegments([utterance(10_800, 13_000, 'trailing')], ONE_SPAN))
      .toEqual([{ tStartMs: 9_800, tEndMs: 10_000, speaker: 'Ada', text: 'trailing' }]);
  });

  it('never emits an end before its start', () => {
    const backwards = () => ({ tStartMs: 500, tEndMs: 100 });
    expect(toTranscriptSegments([utterance(1_500, 2_000, 'x')], backwards))
      .toEqual([{ tStartMs: 500, tEndMs: 500, speaker: 'Ada', text: 'x' }]);
  });

  it('returns segments in chronological order regardless of arrival order', () => {
    expect(toTranscriptSegments(
      [utterance(2_900, 2_950, 'late arrival'), utterance(1_010, 1_020, 'early')],
      ONE_SPAN,
    ).map((s) => s.text)).toEqual(['early', 'late arrival']);
  });
});
