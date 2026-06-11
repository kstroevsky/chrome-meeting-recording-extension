import { CpuSampler } from '../src/background/perf/CpuSampler';

/** Builds a CpuInfo-shaped snapshot from [idle, total] pairs per processor. */
function info(...procs: Array<[number, number]>) {
  return { processors: procs.map(([idle, total]) => ({ usage: { idle, total } })) };
}

/** A reader that returns each provided snapshot in sequence. */
function sequence(...snaps: ReturnType<typeof info>[]) {
  let i = 0;
  return async () => snaps[Math.min(i++, snaps.length - 1)];
}

describe('CpuSampler', () => {
  it('returns null on the first sample (no baseline yet)', async () => {
    const s = new CpuSampler(sequence(info([100, 200])));
    expect(await s.sample()).toBeNull();
  });

  it('computes system-wide utilization from the idle/total delta', async () => {
    // delta total = 100, delta idle = 50 -> 50% busy
    const s = new CpuSampler(sequence(info([100, 200]), info([150, 300])));
    expect(await s.sample()).toBeNull(); // baseline
    expect(await s.sample()).toBe(50);
  });

  it('aggregates across all logical processors', async () => {
    // delta total = 200, delta idle = (125-100)+(150-100)=75 -> 1 - 75/200 = 62.5%
    const s = new CpuSampler(sequence(
      info([100, 200], [100, 200]),
      info([125, 300], [150, 300]),
    ));
    await s.sample();
    expect(await s.sample()).toBe(62.5);
  });

  it('clamps to [0,100] and rounds to one decimal', async () => {
    // fully busy: delta idle 0 over delta total 100 -> 100%
    const s = new CpuSampler(sequence(info([100, 200]), info([100, 300])));
    await s.sample();
    expect(await s.sample()).toBe(100);
  });

  it('returns null when the cumulative counters did not advance', async () => {
    const s = new CpuSampler(sequence(info([100, 200]), info([100, 200])));
    await s.sample();
    expect(await s.sample()).toBeNull();
  });

  it('returns null when the reader throws (e.g. permission absent)', async () => {
    const s = new CpuSampler(async () => {
      throw new Error('no system.cpu permission');
    });
    expect(await s.sample()).toBeNull();
  });

  it('recovers a baseline after an error and resumes on the next reads', async () => {
    let call = 0;
    const reads = [info([100, 200]), info([200, 400])];
    const s = new CpuSampler(async () => {
      call += 1;
      if (call === 1) throw new Error('transient');
      return reads.shift() ?? info([200, 400]);
    });
    expect(await s.sample()).toBeNull(); // threw
    expect(await s.sample()).toBeNull(); // first good read -> baseline
    expect(await s.sample()).toBe(50);   // delta idle 100 / delta total 200 -> 50%
  });
});
