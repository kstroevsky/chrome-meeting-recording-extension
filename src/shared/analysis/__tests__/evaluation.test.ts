import {
  boundaryAgreement,
  clusterAgreement,
  finalTemporalBoundariesOnAxis,
  projectTopicAssignmentsToAxis,
} from '../evaluation';
import type { ContextWindow, ConversationSegment } from '../types';

const vector = Float32Array.of(1, 0);

const windows: ContextWindow[] = [0, 1, 2].map((index) => ({
  startIndex: index * 2,
  endIndex: index * 2 + 2,
  tStartMs: index * 2_000,
  tEndMs: index * 2_000 + 2_000,
  text: `w${index}`,
  sourceSpans: [],
  speakers: [],
  opensWithDiscourseCue: false,
}));

const segment = (
  id: string,
  topic: string,
  startWindow: number,
  endWindow: number,
): ConversationSegment => ({
  id,
  localTopicId: topic,
  startWindow,
  endWindow,
  tStartMs: windows[startWindow].tStartMs,
  tEndMs: windows[endWindow - 1].tEndMs,
  embedding: vector,
});

describe('analysis evaluation', () => {
  it('matches boundaries one-to-one instead of crediting one gold boundary repeatedly', () => {
    const scored = boundaryAgreement([9, 10, 11], [10], 1);
    expect(scored.precision).toBeCloseTo(1 / 3);
    expect(scored.recall).toBe(1);
    expect(scored.f1).toBeCloseTo(0.5);
    expect(scored.matches).toHaveLength(1);
  });

  it('minimizes displacement after maximizing boundary matches', () => {
    const scored = boundaryAgreement([8, 10], [9], 2);
    expect(scored.matches).toEqual([{ predicted: 8, gold: 9, displacement: 1 }]);
    expect(scored.unmatchedPredicted).toBe(1);
  });

  it('uses explicit empty-boundary conventions', () => {
    expect(boundaryAgreement([], [], 1).f1).toBe(1);
    expect(boundaryAgreement([1], [], 1).f1).toBe(0);
    expect(boundaryAgreement([], [1], 1).f1).toBe(0);
  });

  it('projects final temporal seams and topics onto a fixed utterance axis', () => {
    const temporal = [segment('s0', 'a', 0, 1), segment('s1', 'b', 1, 3)];
    expect(finalTemporalBoundariesOnAxis(temporal, windows, 6)).toEqual([1]);
    expect(projectTopicAssignmentsToAxis(windows, temporal, 6)).toEqual(['a', 'a', 'b', 'b', 'b', 'b']);
  });

  it('rejects conflicting overlap instead of silently changing the evaluation denominator', () => {
    const overlapping = [
      { ...windows[0], startIndex: 0, endIndex: 3 },
      { ...windows[1], startIndex: 2, endIndex: 4 },
    ];
    const temporal = [
      { ...segment('s0', 'a', 0, 1), startWindow: 0, endWindow: 1 },
      { ...segment('s1', 'b', 1, 2), startWindow: 1, endWindow: 2 },
    ];
    expect(() => projectTopicAssignmentsToAxis(overlapping, temporal, 4)).toThrow(/Conflicting topic assignments/);
  });

  it('reports false-merge support and rate on the fixed axis', () => {
    const scored = clusterAgreement(['a', 'a', 'a', 'b'], ['x', 'x', 'y', 'y']);
    expect(scored.truePositivePairs).toBe(1);
    expect(scored.falseMergePairs).toBe(2);
    expect(scored.predictedPositivePairs).toBe(3);
    expect(scored.falseMergeRate).toBeCloseTo(2 / 3);
  });
});
