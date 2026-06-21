import { BitrateObserver } from '../BitrateObserver';

describe('BitrateObserver', () => {
  it('returns null until there are two samples spanning time', () => {
    const obs = new BitrateObserver();
    expect(obs.record(1000, 0)).toBeNull(); // first chunk: no span yet
  });

  it('measures bitrate from bytes that arrived during the span (excludes the boundary chunk)', () => {
    const obs = new BitrateObserver({ windowMs: 10_000, emitIntervalMs: 0 });
    expect(obs.record(50_000, 0)).toBeNull();

    // Second chunk 4s later carrying 100 KB. Span = 4s, bytes-in-span = 100 KB
    // (the first chunk is the window start and is excluded). 100_000*8/4 = 200_000.
    const result = obs.record(100_000, 4_000);
    expect(result).toEqual({ actualBitsPerSecond: 200_000, windowMs: 4_000, chunks: 2 });
  });

  it('throttles observations to one per emitIntervalMs', () => {
    const obs = new BitrateObserver({ windowMs: 60_000, emitIntervalMs: 10_000 });
    expect(obs.record(10_000, 0)).toBeNull();
    expect(obs.record(10_000, 4_000)).not.toBeNull(); // first emit
    expect(obs.record(10_000, 8_000)).toBeNull();      // within 10s of last emit
    expect(obs.record(10_000, 12_000)).toBeNull();     // still within 10s
    expect(obs.record(10_000, 14_001)).not.toBeNull(); // >10s since last emit → emit
  });

  it('drops samples older than the window from the estimate', () => {
    const obs = new BitrateObserver({ windowMs: 10_000, emitIntervalMs: 0 });
    obs.record(999_999, 0);       // will fall out of the window
    obs.record(10_000, 4_000);    // also drops once now passes 14_000
    // now = 20_000: cutoff = 10_000, so only samples at >= 10_000 survive.
    obs.record(20_000, 12_000);
    const result = obs.record(30_000, 20_000);
    // Surviving samples: {12_000: 20_000B}, {20_000: 30_000B}. Span = 8_000ms.
    // bytes-in-span excludes the oldest (12_000): 30_000*8/8 = 30_000.
    expect(result).toEqual({ actualBitsPerSecond: 30_000, windowMs: 8_000, chunks: 2 });
  });

  it('does not emit when all samples collapse to a single point in time', () => {
    const obs = new BitrateObserver({ emitIntervalMs: 0 });
    obs.record(1000, 5_000);
    // Same timestamp → span 0 → no observation.
    expect(obs.record(1000, 5_000)).toBeNull();
  });
});
