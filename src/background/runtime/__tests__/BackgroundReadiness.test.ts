import { BackgroundReadiness } from '../BackgroundReadiness';

describe('BackgroundReadiness', () => {
  it('holds stateful ingress until durable state is known', async () => {
    const readiness = new BackgroundReadiness();
    let released = false;
    const waiter = readiness.wait().then(() => { released = true; });

    await Promise.resolve();
    expect(released).toBe(false);

    readiness.markReady();
    await waiter;
    expect(released).toBe(true);
  });

  it('fails closed when durable state cannot be read', async () => {
    const readiness = new BackgroundReadiness();
    readiness.markFailed(new Error('session storage unavailable'));

    await expect(readiness.wait()).rejects.toThrow(
      'Background durable state is unavailable: session storage unavailable',
    );
  });
});
