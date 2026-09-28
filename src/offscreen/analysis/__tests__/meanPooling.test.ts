import { Tensor, mean_pooling } from '@huggingface/transformers';
import { meanPoolingLocality } from '../meanPooling';

type Fixture = {
  batch: number;
  tokens: number;
  width: number;
  mask: number[];
  values: number[];
};

const fixture = (batch: number, tokens: number, width: number, mask: number[]): Fixture => ({
  batch,
  tokens,
  width,
  mask,
  values: Array.from({ length: batch * tokens * width }, (_, index) => (
    Math.fround(Math.sin(index * 0.37) * 4.25 + Math.cos(index * 0.11))
  )),
});

const tensors = ({ batch, tokens, width, mask, values }: Fixture) => ({
  hidden: new Tensor('float32', Float32Array.from(values), [batch, tokens, width]),
  attention: new Tensor('int64', BigInt64Array.from(mask.map(BigInt)), [batch, tokens]),
});

describe('meanPoolingLocality', () => {
  const fixtures = [
    fixture(1, 1, 1, [1]),
    fixture(1, 7, 3, [1, 1, 1, 1, 1, 1, 1]),
    fixture(1, 8, 13, [1, 1, 1, 1, 0, 0, 0, 0]),
    fixture(2, 5, 7, [1, 1, 1, 0, 0, 1, 1, 1, 1, 1]),
    fixture(4, 9, 16, [
      1, 1, 1, 1, 1, 1, 1, 1, 1,
      1, 1, 1, 1, 1, 0, 0, 0, 0,
      1, 1, 1, 0, 0, 0, 0, 0, 0,
      1, 1, 1, 1, 1, 1, 1, 0, 0,
    ]),
  ];

  it.each(fixtures)('preserves installed float32 pooling exactly for %#', (input) => {
    const { hidden, attention } = tensors(input);
    const baseline = mean_pooling(hidden, attention);
    const candidate = meanPoolingLocality(hidden, attention);

    expect(candidate.dims).toEqual(baseline.dims);
    expect(candidate.type).toBe(baseline.type);
    expect(Array.from(candidate.data)).toEqual(Array.from(baseline.data));
  });

  it.each(fixtures)('also preserves the existing L2-normalized vector exactly for %#', (input) => {
    const { hidden, attention } = tensors(input);
    const baseline = mean_pooling(hidden, attention).normalize(2, -1);
    const candidate = meanPoolingLocality(hidden, attention).normalize(2, -1);

    expect(Array.from(candidate.data)).toEqual(Array.from(baseline.data));
  });

  it('rejects a row with no valid token instead of manufacturing NaN output', () => {
    const input = fixture(1, 3, 2, [0, 0, 0]);
    const { hidden, attention } = tensors(input);
    expect(() => meanPoolingLocality(hidden, attention)).toThrow(/no valid tokens/);
  });

  it('rejects non-binary masks and non-finite hidden states outside the equivalence domain', () => {
    const nonBinary = tensors(fixture(1, 2, 2, [1, 2]));
    expect(() => meanPoolingLocality(nonBinary.hidden, nonBinary.attention)).toThrow(/binary attention mask/);

    const nonFinite = tensors(fixture(1, 2, 2, [1, 1]));
    (nonFinite.hidden.data as Float32Array)[2] = Number.NaN;
    expect(() => meanPoolingLocality(nonFinite.hidden, nonFinite.attention)).toThrow(/non-finite/);
  });
});
