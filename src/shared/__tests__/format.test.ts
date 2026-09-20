import { formatApproximateDuration } from '../format';

/**
 * A length that was inferred, shown at the resolution it is known to (8D): the
 * tilde and the coarseness are the message.
 */
describe('formatApproximateDuration', () => {
  it('reads in the unit that suits the length', () => {
    expect(formatApproximateDuration(45_000)).toBe('~45s');
    expect(formatApproximateDuration(32 * 60_000)).toBe('~32m');
    expect(formatApproximateDuration(90 * 60_000)).toBe('~1.5h');
    expect(formatApproximateDuration(120 * 60_000)).toBe('~2h');
  });

  it('never claims nothing was recorded', () => {
    expect(formatApproximateDuration(400)).toBe('~1s');
  });

  it('rounds to the boundary rather than showing 60m', () => {
    expect(formatApproximateDuration(59 * 60_000 + 40_000)).toBe('~1h');
  });
});

