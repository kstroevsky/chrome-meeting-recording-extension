/**
 * @file background/shareService.ts
 *
 * Background composition seam for authenticated publishing. Sharing reuses the
 * Google OAuth identity already required by Drive instead of embedding a
 * backend-wide secret in the extension.
 */

import { ShareServiceClient } from '../sharing/ShareServiceClient';
import { fetchDriveTokenWithFallback, type DriveTokenOptions } from './driveAuth';

export type ShareOwnerTokenProvider = (options?: DriveTokenOptions) => ReturnType<typeof fetchDriveTokenWithFallback>;

export function createAuthenticatedShareServiceClient(
  baseUrl: string,
  getToken: ShareOwnerTokenProvider = fetchDriveTokenWithFallback,
): ShareServiceClient {
  return new ShareServiceClient(baseUrl, {
    headers: async (options) => {
      const result = await getToken(options?.refresh ? { refresh: true } : undefined);
      if (!result.ok) throw new Error(result.error);
      return { authorization: `Bearer ${result.token}` };
    },
  });
}
