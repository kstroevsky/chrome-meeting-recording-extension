import { RuntimeSampler } from '../src/offscreen/RuntimeSampler';

const INTERVAL = 2_000;

describe('RuntimeSampler', () => {
  it('reports zero lag when sampling exactly on cadence', () => {
    const sampler = new RuntimeSampler(INTERVAL, 0);
    const sample = sampler.sample(INTERVAL);

    expect(sample.eventLoopLagMs).toBe(0);
    expect(sample.avgEventLoopLagMs).toBe(0);
    expect(sample.maxEventLoopLagMs).toBe(0);
    expect(sample.longTaskCount).toBe(0);
    expect(sample.lastLongTaskMs).toBeUndefined();
    expect(sample.maxLongTaskMs).toBeUndefined();
  });

  it('measures positive lag as drift past the expected sample time', () => {
    const sampler = new RuntimeSampler(INTERVAL, 0);
    const sample = sampler.sample(INTERVAL + 300);
    expect(sample.eventLoopLagMs).toBe(300);
  });

  it('clamps early samples to zero lag', () => {
    const sampler = new RuntimeSampler(INTERVAL, 0);
    const sample = sampler.sample(INTERVAL - 500);
    expect(sample.eventLoopLagMs).toBe(0);
  });

  it('rounds lag to one decimal place', () => {
    const sampler = new RuntimeSampler(INTERVAL, 0);
    const sample = sampler.sample(INTERVAL + 0.24);
    expect(sample.eventLoopLagMs).toBe(0.2);
  });

  it('accumulates average and maximum lag across samples', () => {
    const sampler = new RuntimeSampler(INTERVAL, 0);
    // expected baseline starts at INTERVAL (=2000); each sample rebaselines by +INTERVAL.
    const first = sampler.sample(INTERVAL + 100); // lag 100, next expected 4100
    const second = sampler.sample(INTERVAL + 100 + INTERVAL + 300); // lag 300

    expect(first.eventLoopLagMs).toBe(100);
    expect(second.eventLoopLagMs).toBe(300);
    expect(second.avgEventLoopLagMs).toBe(200);
    expect(second.maxEventLoopLagMs).toBe(300);
  });

  it('tracks long-task count, last duration, and maximum', () => {
    const sampler = new RuntimeSampler(INTERVAL, 0);
    sampler.recordLongTask(120);
    sampler.recordLongTask(90);

    const sample = sampler.sample(INTERVAL);
    expect(sample.longTaskCount).toBe(2);
    expect(sample.lastLongTaskMs).toBe(90);
    expect(sample.maxLongTaskMs).toBe(120);
  });

  it('rebaselines the lag clock on an active phase start', () => {
    const sampler = new RuntimeSampler(INTERVAL, 0);
    // Without rebaselining, sampling at 10_000 would report a large lag.
    sampler.markActivePhaseStart(8_000); // expected becomes 10_000
    const sample = sampler.sample(10_000);
    expect(sample.eventLoopLagMs).toBe(0);
  });
});
