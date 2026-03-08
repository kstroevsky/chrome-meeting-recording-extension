/**
 * @file offscreen/drive/request.ts
 *
 * Small helpers for Drive requests that need token reuse and a single auth retry.
 */

export type TokenProvider = (options?: { refresh?: boolean }) => Promise<string>;

/**
 * Wraps a token provider with in-memory per-upload caching.
 *
 * This avoids calling chrome.identity.getAuthToken for every single upload
 * chunk while still allowing one forced refresh when Google responds with
 * 401/403.
 */
export function createCachedTokenProvider(getToken: TokenProvider): TokenProvider {
  let cachedToken: string | null = null;
  let pendingToken: Promise<string> | null = null;

  const loadToken = async (options?: { refresh?: boolean }) => {
    if (!pendingToken) {
      pendingToken = getToken(options)
        .then((token) => {
          cachedToken = token;
          return token;
        })
        .finally(() => {
          pendingToken = null;
        });
    }
    return await pendingToken;
  };

  return async (options?: { refresh?: boolean }) => {
    if (options?.refresh) {
      cachedToken = null;
      pendingToken = null;
      return await loadToken({ refresh: true });
    }

    if (cachedToken) return cachedToken;
    return await loadToken();
  };
}

/**
 * Runs a request with an OAuth token and retries once with a refreshed token
 * for auth-related statuses.
 */
export async function fetchWithAuthRetry(
  getToken: TokenProvider,
  request: (token: string) => Promise<Response>
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt === 0 ? undefined : { refresh: true });
    const res = await request(token);
    last = res;
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    return res;
  }
  return last!;
}
