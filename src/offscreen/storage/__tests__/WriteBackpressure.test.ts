import { WriteBackpressure } from '../WriteBackpressure';
import { makeChunkHandler } from '../../engine/RecorderTaskUtils';

/** Flushes the microtask queue so fire-and-forget write .then/.catch chains settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('WriteBackpressure', () => {
  // Hard ceiling kept high so the soft-warn cases below never trip it.
  const limits = {
    maxPendingBytes: 1000,
    maxPendingChunks: 4,
    maxPendingBytesHard: 1_000_000,
    rewarnIntervalMs: 10_000,
  };

  it('does not warn while the backlog stays under both thresholds', () => {
    const onWarn = jest.fn();
    const bp = new WriteBackpressure({ onWarn, onCeiling: jest.fn() }, limits, () => 0);
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
    const bp = new WriteBackpressure({ onWarn, onCeiling: jest.fn() }, limits, () => 0);
    for (let i = 0; i < 5; i++) bp.enqueue(1); // 5 > maxPendingChunks(4)
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toEqual(
      expect.objectContaining({ pendingChunks: 5, warnCount: 1 })
    );
  });

  it('warns when the pending byte total crosses the threshold', () => {
    const onWarn = jest.fn();
    const bp = new WriteBackpressure({ onWarn, onCeiling: jest.fn() }, limits, () => 0);
    bp.enqueue(600);
    bp.enqueue(600); // 1200 > maxPendingBytes(1000)
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(bp.stats.peakPendingBytes).toBe(1200);
  });

  it('throttles re-warning to the rewarn interval, then warns again', () => {
    let now = 0;
    const onWarn = jest.fn();
    const bp = new WriteBackpressure({ onWarn, onCeiling: jest.fn() }, limits, () => now);
    for (let i = 0; i < 5; i++) bp.enqueue(1); // first breach -> warn
    bp.enqueue(1); // still over, within interval -> throttled
    expect(onWarn).toHaveBeenCalledTimes(1);
    now += 10_001; // past the rewarn interval
    bp.enqueue(1);
    expect(onWarn).toHaveBeenCalledTimes(2);
  });

  it('tracks peak pending bytes across enqueue/complete cycles', () => {
    const bp = new WriteBackpressure({ onWarn: jest.fn(), onCeiling: jest.fn() }, limits, () => 0);
    bp.enqueue(300);
    bp.enqueue(300); // peak 600
    bp.complete(300);
    bp.enqueue(100); // 400 now, peak stays 600
    expect(bp.stats.peakPendingBytes).toBe(600);
    expect(bp.stats.pendingBytes).toBe(400);
  });

  it('escalates once via onCeiling when the backlog breaches the hard ceiling', () => {
    const onWarn = jest.fn();
    const onCeiling = jest.fn();
    const hardLimits = { ...limits, maxPendingBytesHard: 5000 };
    const bp = new WriteBackpressure({ onWarn, onCeiling }, hardLimits, () => 0);

    bp.enqueue(6000); // 6000 > 5000 hard ceiling
    expect(onCeiling).toHaveBeenCalledTimes(1);
    expect(onCeiling.mock.calls[0][0]).toEqual(
      expect.objectContaining({ pendingBytes: 6000 })
    );
    // Hard ceiling short-circuits before the soft warn for that enqueue.
    expect(onWarn).not.toHaveBeenCalled();

    bp.enqueue(1000); // still over ceiling, but it fires at most once
    expect(onCeiling).toHaveBeenCalledTimes(1);
  });
});

describe('makeChunkHandler backpressure', () => {
  it('warns via reportWarning when writes stall and the queue backs up', () => {
    const deps = { log: jest.fn(), error: jest.fn(), reportWarning: jest.fn(), requestProtectiveStop: jest.fn() };
    // A storage target whose writes never resolve — i.e. a stalled/slow disk.
    const target = { write: jest.fn(() => new Promise<void>(() => {})), close: jest.fn() } as any;
    const handler = makeChunkHandler(target, 'tab', deps);

    // Default threshold is 16 pending chunks; fire enough to cross it.
    for (let i = 0; i < 20; i++) handler({ data: { size: 1024 } } as unknown as BlobEvent);

    expect(target.write).toHaveBeenCalledTimes(20);
    expect(deps.reportWarning).toHaveBeenCalledTimes(1); // throttled to one
    expect(deps.reportWarning.mock.calls[0][0]).toMatch(/slower than it is captured.*tab/);
    // Soft warn only — nowhere near the hard ceiling, so no protective stop.
    expect(deps.requestProtectiveStop).not.toHaveBeenCalled();
  });

  it('does not warn when writes complete promptly', async () => {
    const deps = { log: jest.fn(), error: jest.fn(), reportWarning: jest.fn(), requestProtectiveStop: jest.fn() };
    const target = { write: jest.fn().mockResolvedValue(undefined), close: jest.fn() } as any;
    const handler = makeChunkHandler(target, 'tab', deps);

    for (let i = 0; i < 20; i++) {
      handler({ data: { size: 1024 } } as unknown as BlobEvent);
      await Promise.resolve(); // let each write resolve before the next
    }
    expect(deps.reportWarning).not.toHaveBeenCalled();
    expect(deps.requestProtectiveStop).not.toHaveBeenCalled();
  });

  it('requests a protective stop after repeated consecutive write failures', async () => {
    const deps = { log: jest.fn(), error: jest.fn(), reportWarning: jest.fn(), requestProtectiveStop: jest.fn() };
    // Storage that rejects every write — e.g. the OPFS worker crashed mid-session.
    const target = { write: jest.fn().mockRejectedValue(new Error('opfs dead')), close: jest.fn() } as any;
    const handler = makeChunkHandler(target, 'tab', deps);

    for (let i = 0; i < 3; i++) handler({ data: { size: 1024 } } as unknown as BlobEvent);
    await flush();

    expect(deps.error).toHaveBeenCalledTimes(3);
    expect(deps.requestProtectiveStop).toHaveBeenCalledTimes(1);
    expect(deps.reportWarning).toHaveBeenCalledTimes(1);
    expect(deps.reportWarning.mock.calls[0][0]).toMatch(/consecutive write failures/);
  });

  it('resets the failure streak on a successful write so transient blips do not escalate', async () => {
    const deps = { log: jest.fn(), error: jest.fn(), reportWarning: jest.fn(), requestProtectiveStop: jest.fn() };
    const target = { write: jest.fn(), close: jest.fn() } as any;
    target.write
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValueOnce(undefined) // recovery resets the streak
      .mockRejectedValueOnce(new Error('3'))
      .mockRejectedValueOnce(new Error('4'));
    const handler = makeChunkHandler(target, 'tab', deps);

    for (let i = 0; i < 5; i++) {
      handler({ data: { size: 1024 } } as unknown as BlobEvent);
      await flush(); // settle each write in order so the streak is deterministic
    }

    // 2 fails, reset, 2 fails -> never 3 in a row.
    expect(deps.requestProtectiveStop).not.toHaveBeenCalled();
  });

  it('requests a protective stop once when the write backlog breaches the hard ceiling', () => {
    const deps = { log: jest.fn(), error: jest.fn(), reportWarning: jest.fn(), requestProtectiveStop: jest.fn() };
    // Writes never resolve, so the backlog only grows.
    const target = { write: jest.fn(() => new Promise<void>(() => {})), close: jest.fn() } as any;
    const handler = makeChunkHandler(target, 'tab', deps);

    // One oversized chunk past the 256 MB hard ceiling (size is just a number here).
    handler({ data: { size: 300 * 1024 * 1024 } } as unknown as BlobEvent);
    // Another chunk while still over the ceiling must not re-fire the stop.
    handler({ data: { size: 1024 } } as unknown as BlobEvent);

    expect(deps.requestProtectiveStop).toHaveBeenCalledTimes(1);
    expect(deps.reportWarning).toHaveBeenCalledTimes(1);
    expect(deps.reportWarning.mock.calls[0][0]).toMatch(/fell too far behind on disk/);
  });
});
