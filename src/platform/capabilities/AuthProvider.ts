/**
 * @file platform/capabilities/AuthProvider.ts
 *
 * Capability port for OAuth token acquisition (ADR-0002). Common logic depends
 * only on this interface; concrete strategies (Chrome identity vs. the
 * cross-browser launchWebAuthFlow OAuth2 flow) live in adapters under ./auth and
 * are chosen by the composition root in ./auth/createAuthProvider.
 */

export interface AuthTokenRequest {
  /** When false, attempt silent acquisition; when true, allow interactive UI. */
  interactive: boolean;
}

export interface AuthProvider {
  /** Acquire an OAuth access token. */
  getToken(request: AuthTokenRequest): Promise<string>;
  /** Invalidate a previously issued token so the next getToken re-fetches. */
  invalidateToken(token: string): Promise<void>;
}
