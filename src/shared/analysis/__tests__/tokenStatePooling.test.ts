import {
  buildTokenStatePrefix,
  poolTokenStateSpan,
} from '../research/tokenStatePooling';

function directMean(
  data: Float32Array,
  dimensions: number,
  include: number[],
  start: number,
  end: number,
): Float32Array {
  const sums = new Float64Array(dimensions);
  let count = 0;
  for (let token = start; token < end; token += 1) {
    if (!include[token]) continue;
    count += 1;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      sums[dimension] += data[token * dimensions + dimension];
    }
  }
  return Float32Array.from(sums, (value) => value / count);
}

describe('TECH-07 token-state prefix pooling', () => {
  it('reconstructs whole-window mean pooling when special tokens remain included', () => {
    const data = Float32Array.from([
      1, 10,
      2, 20,
      3, 30,
      4, 40,
    ]);
    const attention = [1, 1, 1, 0];
    const prefix = buildTokenStatePrefix(data, 4, 2, attention, undefined, 8);
    const pooled = poolTokenStateSpan(prefix, 0, 4);

    expect(pooled.includedTokens).toBe(3);
    expect([...pooled.vector]).toEqual([...directMean(data, 2, attention, 0, 4)]);
  });

  it('excludes masked and special tokens explicitly and pools arbitrary spans', () => {
    const data = Float32Array.from([
      100, 100,
      1, 2,
      3, 4,
      5, 6,
      200, 200,
      300, 300,
    ]);
    const attention = [1, 1, 1, 1, 1, 0];
    const special = [1, 0, 0, 0, 1, 0];
    const prefix = buildTokenStatePrefix(data, 6, 2, attention, special, 6);

    expect(poolTokenStateSpan(prefix, 0, 6)).toEqual({
      vector: Float32Array.from([3, 4]),
      includedTokens: 3,
    });
    expect(poolTokenStateSpan(prefix, 2, 4)).toEqual({
      vector: Float32Array.from([4, 5]),
      includedTokens: 2,
    });
  });

  it('normalizes only after span pooling', () => {
    const prefix = buildTokenStatePrefix(
      Float32Array.from([3, 0, 0, 4]),
      2,
      2,
      [1, 1],
      undefined,
      2,
    );
    const { vector } = poolTokenStateSpan(prefix, 0, 2, { normalize: true });
    expect(vector[0]).toBeCloseTo(0.6, 6);
    expect(vector[1]).toBeCloseTo(0.8, 6);
  });

  it('rejects unbounded blocks, invalid masks, and empty eligible spans', () => {
    expect(() => buildTokenStatePrefix(new Float32Array(6), 3, 2, [1, 1, 1], undefined, 2))
      .toThrow(/1\.\.2 tokens/);
    expect(() => buildTokenStatePrefix(new Float32Array(4), 2, 2, [1, 2], undefined, 2))
      .toThrow(/attention mask must be binary/);

    const prefix = buildTokenStatePrefix(new Float32Array(4), 2, 2, [0, 0], undefined, 2);
    expect(() => poolTokenStateSpan(prefix, 0, 2)).toThrow(/no eligible tokens/);
  });
});
