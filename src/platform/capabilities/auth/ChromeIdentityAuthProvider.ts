/**
 * @file platform/capabilities/auth/ChromeIdentityAuthProvider.ts
 *
 * AuthProvider backed by chrome.identity.getAuthToken — the smoothest path on
 * Chrome, where tokens are tied to the browser's signed-in Google account. This
 * API is Chrome-only; other Chromium browsers use WebAuthFlowAuthProvider.
 */

import type { AuthProvider, AuthTokenRequest } from '../AuthProvider';
import { getAuthToken, removeCachedAuthToken } from '../../chrome/identity';

export class ChromeIdentityAuthProvider implements AuthProvider {
  getToken({ interactive }: AuthTokenRequest): Promise<string> {
    return getAuthToken(interactive);
  }

  invalidateToken(token: string): Promise<void> {
    return removeCachedAuthToken(token);
  }
}
