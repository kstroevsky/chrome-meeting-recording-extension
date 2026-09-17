import { findBoundaryPeaks, longPause, scoreBoundaries, semanticChange, speakerPatternChange } from '../boundaries';
import { BOUNDARY_WEIGHTS, type ContextWindow } from '../types';

const v = (...values: number[]) => Float32Array.from(values);

const window = (over: Partial<ContextWindow> = {}): ContextWindow => ({
  startIndex: 0,
  endIndex: 3,
  tStartMs: 0,
  tEndMs: 1_000,
  text: 'words',
  speakers: ['Ada'],
  opensWithDiscourseCue: false,
  ...over,
});

const CONFIG = { longPauseMs: 3_000, peakNeighbourhood: 2, peakMinProminence: 0.2 };

describe('the boundary signals', () => {
  it('scores semantic change as 1 - cosine (SEG-03)', () => {
    expect(semanticChange(v(1, 0), v(1, 0))).toBeCloseTo(0);
    expect(semanticChange(v(1, 0), v(0, 1))).toBeCloseTo(1);
  });

  it('reads a long enough gap between windows as a break', () => {
    const a = window({ tEndMs: 10_000 });
    expect(longPause(a, window({ tStartMs: 13_000 }), 3_000)).toBe(1);
    expect(longPause(a, window({ tStartMs: 12_999 }), 3_000)).toBe(0);
  });

  it('scores speaker turnover as a Jaccard distance', () => {
    expect(speakerPatternChange(window({ speakers: ['Ada'] }), window({ speakers: ['Ada'] }))).toBe(0);
    expect(speakerPatternChange(window({ speakers: ['Ada'] }), window({ speakers: ['Grace'] }))).toBe(1);
    // {Ada} vs {Ada, Grace}: one shared of two in the union.
    expect(speakerPatternChange(window({ speakers: ['Ada'] }), window({ speakers: ['Ada', 'Grace'] })))
      .toBeCloseTo(0.5);
  });

  it('contributes nothing when no speaker is labelled at all', () => {
    // An STT transcript without diarization must not read as constant turnover.
    expect(speakerPatternChange(window({ speakers: [] }), window({ speakers: [] }))).toBe(0);
  });
});

describe('scoreBoundaries', () => {
  it('blends the four signals at the exact SEG-05 weights', () => {
    const windows = [
      window({ tEndMs: 10_000, speakers: ['Ada'] }),
      window({ tStartMs: 20_000, speakers: ['Grace'], opensWithDiscourseCue: true }),
    ];
    const [score] = scoreBoundaries(windows, [v(1, 0), v(0, 1)], CONFIG);

    expect(score.semanticChange).toBeCloseTo(1);
    expect(score.longPause).toBe(1);
    expect(score.speakerPatternChange).toBe(1);
    expect(score.discourseCue).toBe(1);
    // Everything maxed: the weights sum to 1.
    expect(score.topicChange).toBeCloseTo(1);
  });

  it('degrades to 0.70/0.10/0.10/0.00 when no cue is present', () => {
    // The English-only cue set contributes nothing on a non-English call; the
    // blend must degrade rather than fail.
    const windows = [
      window({ tEndMs: 10_000, speakers: ['Ada'] }),
      window({ tStartMs: 20_000, speakers: ['Grace'], opensWithDiscourseCue: false }),
    ];
    const [score] = scoreBoundaries(windows, [v(1, 0), v(0, 1)], CONFIG);
    expect(score.topicChange).toBeCloseTo(0.9);
  });

  it('weights semantic change far above the rest', () => {
    const semanticOnly = scoreBoundaries(
      [window({ tEndMs: 10_000 }), window({ tStartMs: 10_100 })],
      [v(1, 0), v(0, 1)],
      CONFIG,
    )[0];
    const everythingElse = scoreBoundaries(
      [window({ tEndMs: 10_000, speakers: ['Ada'] }),
        window({ tStartMs: 20_000, speakers: ['Grace'], opensWithDiscourseCue: true })],
      [v(1, 0), v(1, 0)],
      CONFIG,
    )[0];

    expect(semanticOnly.topicChange).toBeCloseTo(BOUNDARY_WEIGHTS.semanticChange);
    expect(everythingElse.topicChange).toBeCloseTo(0.3);
    expect(semanticOnly.topicChange).toBeGreaterThan(everythingElse.topicChange);
  });

  it('records where the boundary falls on the media timeline', () => {
    const [score] = scoreBoundaries(
      [window({ tEndMs: 10_000 }), window({ tStartMs: 11_000 })],
      [v(1, 0), v(1, 0)],
      CONFIG,
    );
    expect(score.tStartMs).toBe(11_000);
    expect(score.index).toBe(0);
  });

  it('produces one score fewer than there are windows', () => {
    const windows = [window(), window(), window(), window()];
    expect(scoreBoundaries(windows, [v(1, 0), v(1, 0), v(1, 0), v(1, 0)], CONFIG)).toHaveLength(3);
    expect(scoreBoundaries([window()], [v(1, 0)], CONFIG)).toEqual([]);
  });

  it('refuses a window list and embedding list that disagree', () => {
    expect(() => scoreBoundaries([window(), window()], [v(1, 0)], CONFIG))
      .toThrow(/Each window needs one embedding/);
  });
});

describe('findBoundaryPeaks', () => {
  /** Builds a score series with the given topicChange values. */
  const series = (values: number[]) => values.map((topicChange, index) => ({
    index,
    tStartMs: index * 1_000,
    semanticChange: topicChange,
    longPause: 0,
    speakerPatternChange: 0,
    discourseCue: 0,
    topicChange,
  }));

  it('finds the payload’s reference spike and nothing else', () => {
    // .08 .11 .09 .72 .13 .08 — one real topic change in a calm conversation.
    const peaks = findBoundaryPeaks(series([0.08, 0.11, 0.09, 0.72, 0.13, 0.08]), CONFIG);
    expect(peaks.map((p) => p.index)).toEqual([3]);
  });

  it('ignores background drift that never rises above its neighbourhood', () => {
    expect(findBoundaryPeaks(series([0.08, 0.11, 0.09, 0.13, 0.08, 0.10]), CONFIG)).toEqual([]);
  });

  it('sets the bar by the neighbourhood, not by an absolute level', () => {
    // A heated conversation: every score is high, but only one is a peak.
    const peaks = findBoundaryPeaks(series([0.55, 0.58, 0.57, 0.92, 0.60, 0.56]), CONFIG);
    expect(peaks.map((p) => p.index)).toEqual([3]);

    // A calm one: every score is low, and the same relative spike still counts.
    const calm = findBoundaryPeaks(series([0.05, 0.08, 0.07, 0.42, 0.10, 0.06]), CONFIG);
    expect(calm.map((p) => p.index)).toEqual([3]);
  });

  it('finds several peaks in a conversation that turns more than once', () => {
    const peaks = findBoundaryPeaks(
      series([0.05, 0.60, 0.08, 0.07, 0.06, 0.71, 0.09, 0.05]),
      { ...CONFIG, peakNeighbourhood: 1 },
    );
    expect(peaks.map((p) => p.index)).toEqual([1, 5]);
  });

  it('requires the peak to rise by the configured prominence', () => {
    // Neighbourhood of index 3 is .11 .09 .13 .08, mean .1025, so the rise is
    // .147 — enough at a 0.1 bar, not at the 0.2 the other tests use.
    const shallow = series([0.08, 0.11, 0.09, 0.25, 0.13, 0.08]);
    expect(findBoundaryPeaks(shallow, { ...CONFIG, peakMinProminence: 0.1 }).map((p) => p.index)).toEqual([3]);
    expect(findBoundaryPeaks(shallow, { ...CONFIG, peakMinProminence: 0.2 })).toEqual([]);
  });

  it('does not treat a tie as a peak', () => {
    expect(findBoundaryPeaks(series([0.1, 0.7, 0.7, 0.1]), { ...CONFIG, peakNeighbourhood: 1 })).toEqual([]);
  });

  it('handles a series too short to have a neighbourhood', () => {
    expect(findBoundaryPeaks(series([]), CONFIG)).toEqual([]);
    expect(findBoundaryPeaks(series([0.9]), CONFIG)).toEqual([]);
  });

  it('refuses a neighbourhood of nothing', () => {
    expect(() => findBoundaryPeaks(series([0.1, 0.9, 0.1]), { ...CONFIG, peakNeighbourhood: 0 }))
      .toThrow(/at least 1/);
  });
});
