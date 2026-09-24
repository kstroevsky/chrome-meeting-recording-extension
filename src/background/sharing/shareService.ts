/**
 * @file background/sharing/shareService.ts
 *
 * Background composition seam for authenticated publishing. Google proves the
 * account identity once; subsequent owner requests use a short-lived sharing
 * service session rather than a Drive-capable OAuth token.
 */

import { ShareServiceClient } from '../../sharing/ShareServiceClient';
import { ShareOwnerSession } from '../../sharing/ShareOwnerSession';
import {
  fetchShareIdentityTokenWithFallback,
  type ShareIdentityTokenOptions,
} from './shareIdentityAuth';

export type ShareOwnerTokenProvider = (
  options?: ShareIdentityTokenOptions,
) => ReturnType<typeof fetchShareIdentityTokenWithFallback>;

export function createAuthenticatedShareServiceClient(
  baseUrl: string,
  getToken: ShareOwnerTokenProvider = fetchShareIdentityTokenWithFallback,
): ShareServiceClient {
  const ownerSession = new ShareOwnerSession(baseUrl, async (options) => {
    const result = await getToken(options);
    if (!result.ok) throw new Error(result.error);
    return result.token;
  });
  return new ShareServiceClient(baseUrl, {
    headers: (options) => ownerSession.headers(options),
  });
}
