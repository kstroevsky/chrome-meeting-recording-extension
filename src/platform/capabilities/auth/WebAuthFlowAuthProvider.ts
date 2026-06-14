/**
 * @file platform/capabilities/auth/WebAuthFlowAuthProvider.ts
 *
 * Cross-browser AuthProvider using chrome.identity.launchWebAuthFlow + Google's
 * OAuth2 implicit flow. Works on every Chromium browser and Firefox. The implicit
 * flow yields a short-lived access token with no refresh token, which matches the
 * existing re-fetch-on-401 policy in background/driveAuth.
 *
 * The OAuth client ID and flow are configured by the per-browser build target
 * (ADR-0002, Phase 0 step 2); this adapter is otherwise self-contained.
 */

import type { AuthProvider, AuthTokenRequest } from '../AuthProvider';

export interface WebAuthFlowConfig {
  clientId: string;
  scopes: string[];
  redirectUri: string;
  authEndpoint?: string;
}

export type LaunchWebAuthFlow = (url: string, interactive: boolean) => Promise<string>;

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Build the Google OAuth2 authorization URL for the implicit (token) flow. */
export function buildAuthUrl(config: WebAuthFlowConfig, interactive: boolean): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'token',
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '),
    // Silent acquisition must not show UI; interactive may prompt for consent.
    prompt: interactive ? 'consent' : 'none',
  });
  return `${config.authEndpoint ?? GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/** Extract the access token from the OAuth redirect URL fragment. */
export function parseAccessToken(redirectUrl: string): string | null {
  const fragment = redirectUrl.split('#')[1] ?? '';
  return new URLSearchParams(fragment).get('access_token');
}

export class WebAuthFlowAuthProvider implements AuthProvider {
  constructor(
    private readonly config: WebAuthFlowConfig,
    private readonly launch: LaunchWebAuthFlow
  ) {}

  async getToken({ interactive }: AuthTokenRequest): Promise<string> {
    if (!this.config.clientId) {
      throw new Error('Web OAuth client ID is not configured for launchWebAuthFlow');
    }
    const redirectUrl = await this.launch(buildAuthUrl(this.config, interactive), interactive);
    const token = parseAccessToken(redirectUrl);
    if (!token) {
      throw new Error('launchWebAuthFlow returned no access token');
    }
    return token;
  }

  invalidateToken(_token: string): Promise<void> {
    // No browser-side token cache to clear; driveAuth and the upload layer own
    // caching, and a fresh launchWebAuthFlow always re-acquires.
    return Promise.resolve();
  }
}
