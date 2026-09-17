import { cosine, cosineDistance, meanCentroid, updateCentroid } from '../vector';

const v = (...values: number[]) => Float32Array.from(values);

describe('cosine similarity', () => {
  it('is 1 for identical directions and 0 for orthogonal ones', () => {
    expect(cosine(v(1, 0, 0), v(1, 0, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 0, 0), v(0, 1, 0))).toBeCloseTo(0);
    expect(cosine(v(1, 0, 0), v(-1, 0, 0))).toBeCloseTo(-1);
  });

  it('ignores magnitude — only direction matters', () => {
    expect(cosine(v(1, 1), v(7, 7))).toBeCloseTo(1);
  });

  it('treats a zero vector as similar to nothing rather than answering NaN', () => {
    // One degenerate embedding must not poison every score derived from it.
    expect(cosine(v(0, 0), v(1, 1))).toBe(0);
    expect(cosine(v(0, 0), v(0, 0))).toBe(0);
  });

  it('stays inside [-1, 1] despite floating-point drift', () => {
    const a = v(0.1, 0.2, 0.3);
    expect(cosine(a, a)).toBeLessThanOrEqual(1);
    expect(cosine(a, a)).toBeGreaterThanOrEqual(-1);
  });

  it('refuses embeddings of different widths', () => {
    expect(() => cosine(v(1, 0), v(1, 0, 0))).toThrow(/different widths/);
  });

  it('reports distance as the complement of similarity', () => {
    expect(cosineDistance(v(1, 0), v(1, 0))).toBeCloseTo(0);
    expect(cosineDistance(v(1, 0), v(0, 1))).toBeCloseTo(1);
  });
});

describe('updateCentroid — C_new = (n·C + x) / (n + 1)', () => {
  it('folds one embedding into a running mean', () => {
    // Worked by hand: (2·[3,3] + [9,9]) / 3 = [5,5]
    expect(Array.from(updateCentroid(v(3, 3), 2, v(9, 9)))).toEqual([5, 5]);
  });

  it('an empty centroid becomes the embedding itself', () => {
    expect(Array.from(updateCentroid(v(0, 0), 0, v(4, 8)))).toEqual([4, 8]);
  });

  it('agrees with a full mean over the same members', () => {
    const members = [v(1, 2), v(3, 4), v(5, 6), v(7, 8)];
    let running = members[0];
    for (let i = 1; i < members.length; i += 1) running = updateCentroid(running, i, members[i]);

    expect(Array.from(running)).toEqual(Array.from(meanCentroid(members)));
  });

  it('does not mutate the centroid it was given', () => {
    const centroid = v(3, 3);
    updateCentroid(centroid, 2, v(9, 9));
    expect(Array.from(centroid)).toEqual([3, 3]);
  });

  it('refuses a mismatched width or an impossible count', () => {
    expect(() => updateCentroid(v(1, 1), 1, v(1, 1, 1))).toThrow(/width/);
    expect(() => updateCentroid(v(1, 1), -1, v(1, 1))).toThrow(/cannot summarize/);
  });
});

describe('meanCentroid', () => {
  it('averages a set of embeddings', () => {
    expect(Array.from(meanCentroid([v(0, 0), v(2, 4), v(4, 8)]))).toEqual([2, 4]);
  });

  it('accumulates in double precision, so a long run does not drift', () => {
    const many = Array.from({ length: 1_000 }, () => v(0.1, 0.2));
    const mean = meanCentroid(many);
    expect(mean[0]).toBeCloseTo(0.1, 6);
    expect(mean[1]).toBeCloseTo(0.2, 6);
  });

  it('refuses an empty set or mismatched widths', () => {
    expect(() => meanCentroid([])).toThrow(/at least one/);
    expect(() => meanCentroid([v(1, 1), v(1, 1, 1)])).toThrow(/different widths/);
  });
});
