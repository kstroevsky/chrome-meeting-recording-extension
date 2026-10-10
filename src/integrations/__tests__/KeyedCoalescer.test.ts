import { KeyedCoalescer } from '../KeyedCoalescer';

/** A work function whose runs finish only when the test says so. */
function controlled() {
  const started: string[] = [];
  const finishers: Array<(error?: Error) => void> = [];
  const work = jest.fn((key: string) => new Promise<void>((resolve, reject) => {
    started.push(key);
    finishers.push((error) => (error ? reject(error) : resolve()));
  }));
  const tick = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
  return { work, started, finish: (error?: Error) => finishers.shift()!(error), tick };
}

describe('KeyedCoalescer', () => {
  it('folds a burst that arrives before the first run into that run', async () => {
    const { work, finish, tick } = controlled();
    const coalescer = new KeyedCoalescer(work);
    const all = [1, 2, 3, 4].map(() => coalescer.request('r1'));
    await tick();
    finish();
    await Promise.all(all);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('runs once more, after the current run, for any number of requests made during it', async () => {
    const { work, finish, tick } = controlled();
    const coalescer = new KeyedCoalescer(work);
    const first = coalescer.request('r1');
    await tick();
    const during = [coalescer.request('r1'), coalescer.request('r1'), coalescer.request('r1')];
    finish();
    await tick();
    expect(work).toHaveBeenCalledTimes(2);
    finish();
    await Promise.all([first, ...during]);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('keeps keys independent', async () => {
    const { work, started, finish, tick } = controlled();
    const coalescer = new KeyedCoalescer(work);
    const both = [coalescer.request('r1'), coalescer.request('r2')];
    await tick();
    expect(started).toEqual(['r1', 'r2']);
    finish();
    finish();
    await Promise.all(both);
  });

  it('does not drop a request made during a run that fails', async () => {
    const { work, finish, tick } = controlled();
    const coalescer = new KeyedCoalescer(work);
    const first = coalescer.request('r1');
    await tick();
    const during = coalescer.request('r1');
    finish(new Error('offline'));
    await tick();
    expect(work).toHaveBeenCalledTimes(2);
    finish();
    // The result is the last run's, which succeeded.
    await expect(Promise.all([first, during])).resolves.toBeDefined();
  });

  it('reports a failing last run, then starts fresh', async () => {
    const { work, finish, tick } = controlled();
    const coalescer = new KeyedCoalescer(work);
    const failing = coalescer.request('r1');
    await tick();
    finish(new Error('offline'));
    await expect(failing).rejects.toThrow('offline');

    const next = coalescer.request('r1');
    await tick();
    finish();
    await expect(next).resolves.toBeUndefined();
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('folds a request made from inside the work instead of running in parallel', async () => {
    let coalescer!: KeyedCoalescer;
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    coalescer = new KeyedCoalescer(async (key) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (calls === 1) void coalescer.request(key);
      await Promise.resolve();
      inFlight -= 1;
    });
    await coalescer.request('r1');
    expect(maxInFlight).toBe(1);
    expect(calls).toBe(2);
  });
});
