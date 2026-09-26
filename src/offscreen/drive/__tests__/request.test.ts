import { createCachedTokenProvider, driveFetch } from '../request';

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
      constructor(_body: BodyInit | null, init: ResponseInit) {
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
      bodyBase64: Buffer.from('abc').toString('base64'),
    });
    expect(response.status).toBe(308);
    expect(response.headers.get('Range')).toBe('bytes=0-2');
    (globalThis as any).Response = OriginalResponse;
  });

  it('preserves arbitrary binary Drive media bytes across the E2E bridge', async () => {
    (globalThis as any).__E2E_MOCK_DRIVE__ = true;
    const OriginalResponse = (globalThis as any).Response;
    let receivedBody: BodyInit | null = null;
    (globalThis as any).Response = class {
      status: number;
      headers: { get: (name: string) => string | null };
      constructor(body: BodyInit | null, init: ResponseInit) {
        receivedBody = body;
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
    const expected = Uint8Array.from([0x00, 0xff, 0x80, 0x41, 0x00, 0xc3, 0x28]);
    (chrome.runtime.sendMessage as jest.Mock).mockResolvedValue({
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Range': 'bytes 3-9/10',
        'Content-Type': 'video/webm',
      },
      bodyBase64: Buffer.from(expected).toString('base64'),
    });

    const response = await driveFetch(
      'https://www.googleapis.com/drive/v3/files/file-1?alt=media',
      { headers: { Range: 'bytes=3-9' } }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 3-9/10');
    expect(receivedBody).toBeInstanceOf(Uint8Array);
    expect(Array.from(receivedBody! as Uint8Array)).toEqual(Array.from(expected));
    (globalThis as any).Response = OriginalResponse;
  });
});
