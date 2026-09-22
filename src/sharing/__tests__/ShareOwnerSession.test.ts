import { ShareOwnerSession } from '../ShareOwnerSession';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('ShareOwnerSession', () => {
  it('exchanges an identity token once and reuses the sharing session', async () => {
    const getIdentityToken = jest.fn(async () => 'google-identity-token');
    const fetcher = jest.fn(async () => jsonResponse({
      token: 'sharing-session-token',
      expiresAt: 4_000,
    }));
    const session = new ShareOwnerSession('https://share.example', getIdentityToken, {
      fetch: fetcher as typeof fetch,
      now: () => 1_000_000,
    });

    await expect(session.headers()).resolves.toEqual({ authorization: 'Bearer sharing-session-token' });
    await expect(session.headers()).resolves.toEqual({ authorization: 'Bearer sharing-session-token' });

    expect(getIdentityToken).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://share.example/api/auth/session');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer google-identity-token');
  });

  it('forces a fresh identity exchange after an owner 401', async () => {
    const getIdentityToken = jest.fn(async (options?: { refresh?: boolean }) => (
      options?.refresh ? 'fresh-google-token' : 'cached-google-token'
    ));
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'first-session', expiresAt: 4_000 }))
      .mockResolvedValueOnce(jsonResponse({ token: 'second-session', expiresAt: 4_000 }));
    const session = new ShareOwnerSession('https://share.example', getIdentityToken, {
      fetch: fetcher as typeof fetch,
      now: () => 1_000_000,
    });

    await session.headers();
    await expect(session.headers({ refresh: true })).resolves.toEqual({ authorization: 'Bearer second-session' });

    expect(getIdentityToken).toHaveBeenNthCalledWith(1, undefined);
    expect(getIdentityToken).toHaveBeenNthCalledWith(2, { refresh: true });
    expect(new Headers(fetcher.mock.calls[1][1].headers).get('authorization')).toBe('Bearer fresh-google-token');
  });
});
