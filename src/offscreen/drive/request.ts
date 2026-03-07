/**
 * @file offscreen/drive/request.ts
 *
 * Small helper for Drive requests that should retry once with a freshly
 * acquired OAuth token on auth-related statuses.
 */

export type TokenProvider = () => Promise<string>;

/**
 * Runs a request with an OAuth token and retries once for 401/403.
 * Returns the final Response (caller handles non-OK details).
 */
export async function fetchWithAuthRetry(
  getToken: TokenProvider,
  request: (token: string) => Promise<Response>
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken();
    const res = await request(token);
    last = res;
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    return res;
  }
  return last!;
}
