import { createCachedTokenProvider } from '../src/offscreen/drive/request';

describe('createCachedTokenProvider', () => {
  it('reuses one in-flight token request for concurrent callers', async () => {
    let resolveToken!: (token: string) => void;
    const getToken = jest.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        })
    );

    const provider = createCachedTokenProvider(getToken);
    const first = provider();
    const second = provider();
    resolveToken('shared-token');

    await expect(first).resolves.toBe('shared-token');
    await expect(second).resolves.toBe('shared-token');
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale pending token overwrite a forced refresh', async () => {
    let resolveStale!: (token: string) => void;
    let resolveFresh!: (token: string) => void;
    const getToken = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveStale = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFresh = resolve;
          })
      );

    const provider = createCachedTokenProvider(getToken);
    const staleRequest = provider();
    const refreshedRequest = provider({ refresh: true });

    resolveStale('stale-token');
    resolveFresh('fresh-token');

    await expect(staleRequest).resolves.toBe('stale-token');
    await expect(refreshedRequest).resolves.toBe('fresh-token');
    await expect(provider()).resolves.toBe('fresh-token');
    expect(getToken).toHaveBeenNthCalledWith(2, { refresh: true });
  });
});
