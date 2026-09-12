import { E5_QUERY_PREFIX, toEncoderInput } from '../encoderInput';

describe('toEncoderInput', () => {
  it('prefixes text the way multilingual-E5 was trained to receive it', () => {
    expect(toEncoderInput('the pool is saturated')).toBe('query: the pool is saturated');
  });

  it('is the prefix the model card asks for, trailing space included', () => {
    expect(E5_QUERY_PREFIX).toBe('query: ');
  });

  it('is idempotent, so a pre-formatted caller cannot double it', () => {
    const once = toEncoderInput('redis timeout');
    expect(toEncoderInput(once)).toBe(once);
  });

  it('trims first, so stray whitespace cannot hide the prefix', () => {
    expect(toEncoderInput('  redis  ')).toBe('query: redis');
    expect(toEncoderInput('  query: redis')).toBe('query: redis');
  });

  it('still prefixes empty text rather than producing a bare string', () => {
    expect(toEncoderInput('')).toBe('query: ');
  });
});
