import { buildConversationSegments } from '../segments';
import type { BoundaryScore } from '../boundaries';
import type { ContextWindow } from '../types';

const v = (...values: number[]) => Float32Array.from(values);

/** One window per 10 seconds of media, so durations read directly. */
const windows = (count: number): ContextWindow[] =>
  Array.from({ length: count }, (_, i) => ({
    startIndex: i * 3,
    endIndex: i * 3 + 3,
    tStartMs: i * 10_000,
    tEndMs: i * 10_000 + 9_000,
    text: `window ${i}`,
    speakers: ['Ada'],
    opensWithDiscourseCue: false,
  }));

const embeddings = (count: number) => Array.from({ length: count }, (_, i) => v(i + 1, 0));

const peakAt = (index: number): BoundaryScore => ({
  index,
  tStartMs: (index + 1) * 10_000,
  semanticChange: 0.9,
  longPause: 0,
  speakerPatternChange: 0,
  discourseCue: 0,
  topicChange: 0.63,
});

const NO_FLOOR = { minSegmentMs: 0 };

describe('buildConversationSegments', () => {
  it('cuts the conversation at each boundary peak', () => {
    const segments = buildConversationSegments(windows(6), embeddings(6), [peakAt(1), peakAt(3)], NO_FLOOR);

    expect(segments.map((s) => [s.tStartMs, s.tEndMs])).toEqual([
      [0, 19_000],       // windows 0-1
      [20_000, 39_000],  // windows 2-3
      [40_000, 59_000],  // windows 4-5
    ]);
  });

  it('yields one segment for a conversation that never changes subject', () => {
    const segments = buildConversationSegments(windows(5), embeddings(5), [], NO_FLOOR);
    expect(segments).toHaveLength(1);
    expect([segments[0].tStartMs, segments[0].tEndMs]).toEqual([0, 49_000]);
  });

  it('represents a segment by the mean of its windows, not its first', () => {
    const [segment] = buildConversationSegments(
      windows(3),
      [v(1, 0), v(3, 0), v(5, 0)],
      [],
      NO_FLOOR,
    );
    expect(Array.from(segment.embedding)).toEqual([3, 0]);
  });

  it('gives every segment a distinct id', () => {
    const segments = buildConversationSegments(windows(6), embeddings(6), [peakAt(1), peakAt(3)], NO_FLOOR);
    expect(new Set(segments.map((s) => s.id)).size).toBe(3);
  });

  it('ignores a duplicate or out-of-range peak rather than emitting an empty segment', () => {
    const segments = buildConversationSegments(
      windows(4),
      embeddings(4),
      [peakAt(1), peakAt(1), peakAt(3), peakAt(99)],
      NO_FLOOR,
    );
    // A cut at the very end would leave nothing after it, so it is not a cut.
    expect(segments.map((s) => [s.tStartMs, s.tEndMs])).toEqual([[0, 19_000], [20_000, 39_000]]);
  });

  it('folds a sliver into the subject that was already running', () => {
    // Peaks at 1 and 2 would make window 2 a 9s segment of its own.
    const segments = buildConversationSegments(
      windows(5),
      embeddings(5),
      [peakAt(1), peakAt(2)],
      { minSegmentMs: 15_000 },
    );
    expect(segments.map((s) => [s.tStartMs, s.tEndMs])).toEqual([[0, 29_000], [30_000, 49_000]]);
  });

  it('folds a sliver at the very start forwards, since it has no predecessor', () => {
    const segments = buildConversationSegments(
      windows(5),
      embeddings(5),
      [peakAt(0)],
      { minSegmentMs: 15_000 },
    );
    expect(segments.map((s) => [s.tStartMs, s.tEndMs])).toEqual([[0, 49_000]]);
  });

  it('keeps a single short conversation rather than deleting it', () => {
    const segments = buildConversationSegments(windows(1), embeddings(1), [], { minSegmentMs: 60_000 });
    expect(segments).toHaveLength(1);
  });

  it('returns nothing for an empty conversation', () => {
    expect(buildConversationSegments([], [], [], NO_FLOOR)).toEqual([]);
  });

  it('refuses a window list and embedding list that disagree', () => {
    expect(() => buildConversationSegments(windows(3), embeddings(2), [], NO_FLOOR))
      .toThrow(/Each window needs one embedding/);
  });
});
