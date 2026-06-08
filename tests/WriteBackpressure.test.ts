import { WriteBackpressure } from '../src/offscreen/storage/WriteBackpressure';
import { makeChunkHandler } from '../src/offscreen/engine/RecorderTaskUtils';

describe('WriteBackpressure', () => {
  const limits = { maxPendingBytes: 1000, maxPendingChunks: 4, rewarnIntervalMs: 10_000 };

  it('does not warn while the backlog stays under both thresholds', () => {
    const onWarn = jest.fn();
    const bp = new WriteBackpressure(onWarn, limits, () => 0);
    bp.enqueue(100);
    bp.enqueue(100);
    bp.complete(100);
    bp.enqueue(100);
    expect(onWarn).not.toHaveBeenCalled();
    expect(bp.stats.pendingChunks).toBe(2);
    expect(bp.stats.pendingBytes).toBe(200);
  });

  it('warns when the pending chunk count crosses the threshold', () => {
    const onWarn = jest.fn();
    const bp = new WriteBackpressure(onWarn, limits, () => 0);
    for (let i = 0; i < 5; i++) bp.enqueue(1); // 5 > maxPendingChunks(4)
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toEqual(
      expect.objectContaining({ pendingChunks: 5, warnCount: 1 })
    );
  });

  it('warns when the pending byte total crosses the threshold', () => {
    const onWarn = jest.fn();
    const bp = new WriteBackpressure(onWarn, limits, () => 0);
    bp.enqueue(600);
    bp.enqueue(600); // 1200 > maxPendingBytes(1000)
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(bp.stats.peakPendingBytes).toBe(1200);
  });

  it('throttles re-warning to the rewarn interval, then warns again', () => {
    let now = 0;
    const onWarn = jest.fn();
    const bp = new WriteBackpressure(onWarn, limits, () => now);
    for (let i = 0; i < 5; i++) bp.enqueue(1); // first breach -> warn
    bp.enqueue(1); // still over, within interval -> throttled
    expect(onWarn).toHaveBeenCalledTimes(1);
    now += 10_001; // past the rewarn interval
    bp.enqueue(1);
    expect(onWarn).toHaveBeenCalledTimes(2);
  });

  it('tracks peak pending bytes across enqueue/complete cycles', () => {
    const bp = new WriteBackpressure(jest.fn(), limits, () => 0);
    bp.enqueue(300);
    bp.enqueue(300); // peak 600
    bp.complete(300);
    bp.enqueue(100); // 400 now, peak stays 600
    expect(bp.stats.peakPendingBytes).toBe(600);
    expect(bp.stats.pendingBytes).toBe(400);
  });
});

describe('makeChunkHandler backpressure', () => {
  it('warns via reportWarning when writes stall and the queue backs up', () => {
    const deps = { log: jest.fn(), error: jest.fn(), reportWarning: jest.fn() };
    // A storage target whose writes never resolve — i.e. a stalled/slow disk.
    const target = { write: jest.fn(() => new Promise<void>(() => {})), close: jest.fn() } as any;
    const handler = makeChunkHandler(target, 'tab', deps);

    // Default threshold is 16 pending chunks; fire enough to cross it.
    for (let i = 0; i < 20; i++) handler({ data: { size: 1024 } } as unknown as BlobEvent);

    expect(target.write).toHaveBeenCalledTimes(20);
    expect(deps.reportWarning).toHaveBeenCalledTimes(1); // throttled to one
    expect(deps.reportWarning.mock.calls[0][0]).toMatch(/slower than it is captured.*tab/);
  });

  it('does not warn when writes complete promptly', async () => {
    const deps = { log: jest.fn(), error: jest.fn(), reportWarning: jest.fn() };
    const target = { write: jest.fn().mockResolvedValue(undefined), close: jest.fn() } as any;
    const handler = makeChunkHandler(target, 'tab', deps);

    for (let i = 0; i < 20; i++) {
      handler({ data: { size: 1024 } } as unknown as BlobEvent);
      await Promise.resolve(); // let each write resolve before the next
    }
    expect(deps.reportWarning).not.toHaveBeenCalled();
  });
});
