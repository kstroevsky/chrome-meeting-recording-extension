import {
  averageCosineBetweenGroups,
  buildAverageLinkHierarchy,
  buildAverageLinkHierarchyReference,
  cutAverageLinkHierarchy,
} from '../research/averageLinkHierarchy';

const v = (...values: number[]) => Float32Array.from(values);

const partitionKey = (groups: number[][]) => groups
  .map((group) => [...group].sort((a, b) => a - b).join(','))
  .sort()
  .join('|');

describe('average-link hierarchy research solver', () => {
  it('recognizes A→B→A recurrence before unrelated material', () => {
    const hierarchy = buildAverageLinkHierarchy([v(1, 0), v(0, 1), v(1, 0)]);
    expect([hierarchy.merges[0].left, hierarchy.merges[0].right]).toEqual([0, 2]);
    expect(hierarchy.merges[0].similarity).toBe(1);
    expect(cutAverageLinkHierarchy(hierarchy, 0.9)).toEqual([[0, 2], [1]]);
  });

  it('uses average leaf cosine rather than cosine of a renormalized cluster mean', () => {
    const embeddings = [v(1, 0), v(0, 1), v(1, 0)];
    const masses = [1, 1, 1];
    // Average-link({0,1}, {2}) = (cos(0,2) + cos(1,2)) / 2 = 0.5.
    // Normalizing the {0,1} centroid would incorrectly produce sqrt(1/2).
    expect(averageCosineBetweenGroups(embeddings, masses, [0, 1], [2])).toBeCloseTo(0.5, 15);
  });

  it('respects unequal leaf masses in the average-link moment identity', () => {
    const embeddings = [v(1, 0), v(0, 1), v(1, 0)];
    const masses = [3, 1, 2];
    // Weighted cross-pair mean: (3*2*1 + 1*2*0) / ((3+1)*2) = 0.75.
    expect(averageCosineBetweenGroups(embeddings, masses, [0, 1], [2])).toBeCloseTo(0.75, 15);
  });

  it('matches the cubic global-pair oracle over seeded no-tie fixtures and reusable cuts', () => {
    let seed = 0xa11ce;
    const random = () => {
      seed = (1103515245 * seed + 12345) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let fixture = 0; fixture < 120; fixture += 1) {
      const count = 2 + Math.floor(random() * 14);
      const width = 2 + Math.floor(random() * 6);
      const embeddings = Array.from({ length: count }, () => Float32Array.from(
        { length: width },
        () => Math.fround((random() - 0.5) * 2),
      ));
      const masses = Array.from({ length: count }, () => 0.5 + random() * 4);
      const candidate = buildAverageLinkHierarchy(embeddings, masses);
      const oracle = buildAverageLinkHierarchyReference(embeddings, masses);

      expect(candidate.merges.map((merge) => [merge.left, merge.right])).toEqual(
        oracle.merges.map((merge) => [merge.left, merge.right]),
      );
      candidate.merges.forEach((merge, index) => {
        expect(merge.similarity).toBeCloseTo(oracle.merges[index].similarity, 14);
      });
      for (const threshold of [-0.25, 0, 0.25, 0.5, 0.75]) {
        expect(partitionKey(cutAverageLinkHierarchy(candidate, threshold))).toBe(
          partitionKey(cutAverageLinkHierarchy(oracle, threshold)),
        );
      }
      for (const merge of oracle.merges) {
        for (const offset of [-1e-12, 1e-12]) {
          const threshold = Math.max(-1, Math.min(1, merge.similarity + offset));
          expect(partitionKey(cutAverageLinkHierarchy(candidate, threshold))).toBe(
            partitionKey(cutAverageLinkHierarchy(oracle, threshold)),
          );
        }
      }
    }
  });

  it('uses deterministic ties', () => {
    const embeddings = [v(1, 0), v(1, 0), v(1, 0), v(1, 0)];
    const first = buildAverageLinkHierarchy(embeddings);
    const second = buildAverageLinkHierarchy(embeddings);
    expect(second).toEqual(first);
    expect(first.merges[0]).toMatchObject({ left: 0, right: 1, similarity: 1 });
    expect(partitionKey(cutAverageLinkHierarchy(first, 1))).toBe(
      partitionKey(cutAverageLinkHierarchy(buildAverageLinkHierarchyReference([
        v(1, 0), v(1, 0), v(1, 0), v(1, 0),
      ]), 1)),
    );
  });

  it('bounds the quadratic similarity table and rejects invalid leaves', () => {
    expect(() => buildAverageLinkHierarchy([v(1, 0), v(0, 1), v(1, 1)], [1, 1, 1], 2))
      .toThrow(/bounded to 2 leaves/);
    expect(() => buildAverageLinkHierarchy([v(0, 0)])).toThrow(/zero embedding/);
    expect(() => buildAverageLinkHierarchy([v(1, 0)], [0])).toThrow(/positive finite masses/);
  });
});
