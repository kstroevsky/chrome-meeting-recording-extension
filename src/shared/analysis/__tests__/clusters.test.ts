import { CLUSTER_ASSIGNMENT_THRESHOLD, clusterSegments, mergeClusters } from '../clusters';
import { cosine } from '../vector';
import type { TemporalSegment } from '../types';

/** A unit vector at `deg` degrees, so cosine between two is easy to reason about. */
const at = (deg: number): Float32Array => {
  const r = (deg * Math.PI) / 180;
  return Float32Array.from([Math.cos(r), Math.sin(r)]);
};

let seq = 0;
const segment = (deg: number, tStartMs = (seq += 1) * 10_000): TemporalSegment => ({
  id: `segment:${seq}`,
  tStartMs,
  tEndMs: tStartMs + 9_000,
  embedding: at(deg),
});

const CONFIG = { mergeThreshold: 0.95, mergeEverySegments: 100 };

beforeEach(() => { seq = 0; });

describe('the assignment threshold', () => {
  it('is the payload’s exact 0.82', () => {
    expect(CLUSTER_ASSIGNMENT_THRESHOLD).toBe(0.82);
  });

  it('keeps a segment whose similarity is above it, and splits at or below', () => {
    // 30° apart is cos ≈ 0.866, above the bar; 40° is ≈ 0.766, below it.
    expect(cosine(at(0), at(30))).toBeGreaterThan(CLUSTER_ASSIGNMENT_THRESHOLD);
    expect(cosine(at(0), at(40))).toBeLessThan(CLUSTER_ASSIGNMENT_THRESHOLD);

    expect(clusterSegments([segment(0), segment(30)], CONFIG).clusters).toHaveLength(1);
    expect(clusterSegments([segment(0), segment(40)], CONFIG).clusters).toHaveLength(2);
  });
});

describe('clusterSegments', () => {
  it('gathers a run of similar segments into one subject', () => {
    const { clusters, segments } = clusterSegments([segment(0), segment(5), segment(10)], CONFIG);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].n).toBe(3);
    expect(new Set(segments.map((s) => s.localTopicId)).size).toBe(1);
  });

  it('gives every segment the topic it was assigned to', () => {
    const { clusters, segments } = clusterSegments([segment(0), segment(90), segment(180)], CONFIG);

    expect(clusters).toHaveLength(3);
    for (const assigned of segments) {
      expect(clusters.some((cluster) => cluster.id === assigned.localTopicId)).toBe(true);
    }
  });

  it('folds a recurring subject back together, rather than at assignment time', () => {
    // Berlin → Redis → Hiring → Redis again → Berlin again (MODEL-06's shape).
    const berlin = 0;
    const redis = 90;
    const hiring = 180;
    const { clusters, segments } = clusterSegments(
      [segment(berlin), segment(redis), segment(hiring), segment(redis), segment(berlin)],
      CONFIG,
    );

    // Five temporal segments, three global topics — the split MODEL-01 exists for.
    expect(segments).toHaveLength(5);
    expect(clusters).toHaveLength(3);

    // Segments 2 and 4 (the two Redis stretches) share one topic.
    expect(segments[1].localTopicId).toBe(segments[3].localTopicId);
    expect(segments[0].localTopicId).toBe(segments[4].localTopicId);
    expect(segments[2].localTopicId).not.toBe(segments[1].localTopicId);
  });

  it('keeps a merged subject’s segments in conversation order, not id order', () => {
    const { clusters } = clusterSegments(
      [segment(0), segment(90), segment(0)],
      CONFIG,
    );
    const berlin = clusters.find((cluster) => cluster.segmentIds.length === 2)!;
    expect(berlin.segmentIds).toEqual(['segment:1', 'segment:3']);
  });

  it('sweeps periodically as well as at the end', () => {
    const everySegment = { mergeThreshold: 0.95, mergeEverySegments: 1 };
    const { clusters, segments } = clusterSegments(
      [segment(0), segment(90), segment(0), segment(90)],
      everySegment,
    );

    expect(clusters).toHaveLength(2);
    expect(segments[0].localTopicId).toBe(segments[2].localTopicId);
    expect(segments[1].localTopicId).toBe(segments[3].localTopicId);
  });

  it('compares the next segment against the cluster a mid-run sweep merged it into', () => {
    // After the sweep folds the second Berlin back into the first, the segment
    // that follows must be measured against that surviving centroid.
    const { clusters } = clusterSegments(
      [segment(0), segment(90), segment(0), segment(3)],
      { mergeThreshold: 0.95, mergeEverySegments: 3 },
    );
    expect(clusters).toHaveLength(2);
    const berlin = clusters.find((cluster) => cluster.segmentIds.length === 3);
    expect(berlin).toBeDefined();
  });

  it('handles an empty conversation', () => {
    expect(clusterSegments([], CONFIG)).toEqual({ clusters: [], segments: [] });
  });

  it('refuses nonsense configuration rather than guessing', () => {
    expect(() => clusterSegments([segment(0)], { ...CONFIG, mergeThreshold: 1.5 }))
      .toThrow(/merge threshold/);
    expect(() => clusterSegments([segment(0)], { ...CONFIG, mergeEverySegments: 0 }))
      .toThrow(/merge period/);
  });
});

describe('mergeClusters', () => {
  const clusterOf = (id: string, deg: number, n: number, segmentIds: string[]) =>
    ({ id, centroid: at(deg), n, segmentIds });

  it('folds every pair of centroids above the threshold', () => {
    // CLU-06's worked example: three Redis fragments become one Redis.
    const assignment = new Map([['s1', 'a'], ['s2', 'b'], ['s3', 'c']]);
    const merged = mergeClusters(
      [clusterOf('a', 0, 2, ['s1']), clusterOf('b', 4, 3, ['s2']), clusterOf('c', 8, 1, ['s3'])],
      { mergeThreshold: 0.98, mergeEverySegments: 100 },
      assignment,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].n).toBe(6);
    expect(merged[0].segmentIds.sort()).toEqual(['s1', 's2', 's3']);
    // Every segment follows the cluster it ended up in.
    expect(new Set(assignment.values())).toEqual(new Set([merged[0].id]));
  });

  it('leaves distinct subjects alone', () => {
    const assignment = new Map([['s1', 'a'], ['s2', 'b']]);
    const merged = mergeClusters(
      [clusterOf('a', 0, 1, ['s1']), clusterOf('b', 90, 1, ['s2'])],
      { mergeThreshold: 0.95, mergeEverySegments: 100 },
      assignment,
    );
    expect(merged).toHaveLength(2);
  });

  it('keeps sweeping until no pair is left above the threshold', () => {
    // Three fragments of one subject: 0°, 8°, 16°. Reducing them to one cluster
    // takes two merges, so a single pass would leave the job half done — and
    // merging moves centroids, which is why the sweep has to re-check.
    const assignment = new Map([['s1', 'a'], ['s2', 'b'], ['s3', 'c']]);
    const merged = mergeClusters(
      [clusterOf('a', 0, 1, ['s1']), clusterOf('b', 8, 1, ['s2']), clusterOf('c', 16, 1, ['s3'])],
      { mergeThreshold: 0.95, mergeEverySegments: 100 },
      assignment,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].n).toBe(3);
    expect(new Set(assignment.values()).size).toBe(1);
  });

  it('weights a merged centroid by how many segments each side carried', () => {
    const assignment = new Map([['s1', 'a'], ['s2', 'b']]);
    const [merged] = mergeClusters(
      [clusterOf('a', 0, 9, ['s1']), clusterOf('b', 10, 1, ['s2'])],
      { mergeThreshold: 0.9, mergeEverySegments: 100 },
      assignment,
    );
    // Nine segments at 0° and one at 10° sits much nearer 0° than 5°.
    expect(cosine(merged.centroid, at(0))).toBeGreaterThan(cosine(merged.centroid, at(5)));
  });
});
