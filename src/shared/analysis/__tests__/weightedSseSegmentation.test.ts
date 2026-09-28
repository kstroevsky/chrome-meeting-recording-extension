import {
  optimalWeightedSseSegmentation,
  peltWeightedSseSegmentation,
  weightedSseCost,
} from '../research/weightedSseSegmentation';

const scalar = (values: number[]) => values.map((value) => Float32Array.of(value));

describe('weighted SSE segmentation research solver', () => {
  it('matches the weighted SSE definition', () => {
    // weights 1 and 3, weighted mean 2.5: 1*(1-2.5)^2 + 3*(3-2.5)^2 = 3
    expect(weightedSseCost(scalar([1, 3]), [1, 3])).toBeCloseTo(3, 12);
  });

  it('retains the TECH-05 minimum-length counterexample that defeats immediate pruning', () => {
    const vectors = scalar([-1, 1, -1, 1, -1, -1, 1]);
    const weights = new Array(vectors.length).fill(1);
    const config = { minSegmentItems: 2, penalty: 3 / 5 };

    const oracle = optimalWeightedSseSegmentation(vectors, weights, config);
    const pelt = peltWeightedSseSegmentation(vectors, weights, config);

    expect(oracle.endpoints).toEqual([7]);
    expect(oracle.objective).toBeCloseTo(261 / 35, 12);
    // The tempting [4, 7] result costs 118/15 and is strictly worse.
    const unsafeSplitCost = weightedSseCost(vectors, weights, 0, 4)
      + weightedSseCost(vectors, weights, 4, 7)
      + 2 * config.penalty;
    expect(unsafeSplitCost).toBeCloseTo(118 / 15, 12);
    expect(pelt).toEqual(oracle);
  });

  it('finds a clear global split while respecting the minimum segment size', () => {
    const vectors = scalar([-4, -4.2, -3.9, 5, 5.1, 4.9]);
    const weights = [1, 2, 1, 1, 1, 3];
    const result = peltWeightedSseSegmentation(vectors, weights, { minSegmentItems: 2, penalty: 1 });
    expect(result.endpoints).toEqual([3, 6]);
  });

  it('reproduces the O(n²) oracle over seeded weighted multidimensional fixtures', () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let fixture = 0; fixture < 250; fixture += 1) {
      const count = 4 + Math.floor(random() * 24);
      const width = 1 + Math.floor(random() * 5);
      const vectors = Array.from({ length: count }, () => Float32Array.from(
        { length: width },
        () => Math.fround((random() - 0.5) * 8),
      ));
      const weights = Array.from({ length: count }, () => 0.25 + random() * 3);
      const minSegmentItems = 1 + Math.floor(random() * Math.min(5, count));
      const config = { minSegmentItems, penalty: random() * 5 };
      const oracle = optimalWeightedSseSegmentation(vectors, weights, config);
      const candidate = peltWeightedSseSegmentation(vectors, weights, config);
      expect(candidate.endpoints).toEqual(oracle.endpoints);
      expect(candidate.objective).toBe(oracle.objective);
    }
  });

  it('handles an empty input and rejects impossible or malformed constraints', () => {
    expect(peltWeightedSseSegmentation([], [], { minSegmentItems: 1, penalty: 1 }))
      .toEqual({ endpoints: [], objective: 0 });
    expect(() => peltWeightedSseSegmentation(scalar([1]), [1], { minSegmentItems: 2, penalty: 1 }))
      .toThrow(/Cannot segment/);
    expect(() => peltWeightedSseSegmentation(scalar([1]), [0], { minSegmentItems: 1, penalty: 1 }))
      .toThrow(/positive finite weights/);
  });
});
