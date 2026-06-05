import { createCachedTokenProvider, driveFetch } from '../src/offscreen/drive/request';

describe('createCachedTokenProvider', () => {
  afterEach(() => {
    (globalThis as any).__E2E_MOCK_DRIVE__ = false;
    jest.restoreAllMocks();
  });

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

  it('bridges Drive fetches through the service worker only in E2E builds', async () => {
    (globalThis as any).__E2E_MOCK_DRIVE__ = true;
    const OriginalResponse = (globalThis as any).Response;
    (globalThis as any).Response = class {
      status: number;
      headers: { get: (name: string) => string | null };
      constructor(_body: string, init: ResponseInit) {
        this.status = init.status ?? 200;
        const values = init.headers as Record<string, string> | undefined;
        this.headers = {
          get: (name) => {
            const key = Object.keys(values ?? {}).find(
              (candidate) => candidate.toLowerCase() === name.toLowerCase()
            );
            return key ? values![key] : null;
          },
        };
      }
    };
    (chrome.runtime.sendMessage as jest.Mock).mockResolvedValue({
      ok: true,
      status: 308,
      statusText: 'Resume Incomplete',
      headers: { Range: 'bytes=0-2' },
      body: '',
    });

    const response = await driveFetch('https://www.googleapis.com/upload/session', {
      method: 'PUT',
      headers: { Authorization: 'Bearer token', 'Content-Range': 'bytes 0-2/6' },
      body: new Blob(['abc']),
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'E2E_DRIVE_FETCH',
      url: 'https://www.googleapis.com/upload/session',
      method: 'PUT',
      headers: {
        authorization: 'Bearer token',
        'content-range': 'bytes 0-2/6',
      },
      body: undefined,
    });
    expect(response.status).toBe(308);
    expect(response.headers.get('Range')).toBe('bytes=0-2');
    (globalThis as any).Response = OriginalResponse;
  });
});
