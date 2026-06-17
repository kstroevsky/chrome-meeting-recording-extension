import { FlushPolicy, DEFAULT_FLUSH_INTERVAL_MS } from '../FlushPolicy';

describe('FlushPolicy', () => {
  it('does not flush before the interval elapses', () => {
    const p = new FlushPolicy(0, 10_000);
    expect(p.onWrite(1_000)).toBe(false);
    expect(p.onWrite(9_999)).toBe(false);
  });

  it('flushes once the interval has elapsed, then resets the clock', () => {
    const p = new FlushPolicy(0, 10_000);
    expect(p.onWrite(10_000)).toBe(true);   // due
    expect(p.onWrite(15_000)).toBe(false);  // clock reset at 10_000 -> only 5s since
    expect(p.onWrite(20_000)).toBe(true);   // a full interval since the last flush
  });

  it('treats the exact interval boundary as due', () => {
    const p = new FlushPolicy(100, 10_000);
    expect(p.onWrite(10_100)).toBe(true);
  });

  it('coalesces a burst of writes within one interval into a single flush', () => {
    const p = new FlushPolicy(0, 10_000);
    let flushes = 0;
    for (const t of [2_000, 4_000, 6_000, 8_000]) {
      if (p.onWrite(t)) flushes += 1;
    }
    expect(flushes).toBe(0);
    if (p.onWrite(10_000)) flushes += 1;
    expect(flushes).toBe(1);
  });

  it('uses a 10 s default interval', () => {
    expect(DEFAULT_FLUSH_INTERVAL_MS).toBe(10_000);
    const p = new FlushPolicy(0);
    expect(p.onWrite(DEFAULT_FLUSH_INTERVAL_MS - 1)).toBe(false);
    expect(p.onWrite(DEFAULT_FLUSH_INTERVAL_MS)).toBe(true);
  });
});
