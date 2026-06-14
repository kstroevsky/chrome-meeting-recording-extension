/**
 * @file platform/capabilities/auth/WebAuthFlowAuthProvider.ts
 *
 * Cross-browser AuthProvider using chrome.identity.launchWebAuthFlow with the
 * OAuth2 authorization-code + PKCE flow. The implicit flow (response_type=token)
 * is deprecated under OAuth 2.1 and not supported for new integrations, so this
 * uses response_type=code + a PKCE challenge and exchanges the code for a token.
 * Works on every Chromium browser and Firefox.
 *
 * The code->token exchange is injectable (ADR-0002): the default runs
 * client-side against Google's token endpoint with a Desktop-client secret that
 * Google treats as non-confidential; a backend exchange can be substituted
 * without touching the rest of the flow.
 */

import type { AuthProvider, AuthTokenRequest } from '../AuthProvider';

export interface WebAuthFlowConfig {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  redirectUri: string;
  authEndpoint?: string;
  tokenEndpoint?: string;
}

export type LaunchWebAuthFlow = (url: string, interactive: boolean) => Promise<string>;

export interface PkcePair {
  verifier: string;
  challenge: string;
}
export type CreatePkcePair = () => Promise<PkcePair>;

export interface TokenExchangeParams {
  code: string;
  codeVerifier: string;
  config: WebAuthFlowConfig;
}
export type ExchangeAuthCode = (params: TokenExchangeParams) => Promise<string>;

export interface WebAuthFlowDeps {
  launch: LaunchWebAuthFlow;
  createPkce?: CreatePkcePair;
  exchange?: ExchangeAuthCode;
  generateState?: () => string;
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomUrlSafeToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** SHA-256 + base64url of a PKCE code verifier (RFC 7636 S256). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomUrlSafeToken(32);
  return { verifier, challenge: await deriveCodeChallenge(verifier) };
}

export function buildAuthUrl(
  config: WebAuthFlowConfig,
  params: { codeChallenge: string; state: string; interactive: boolean }
): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '),
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
    // Silent acquisition must not show UI; interactive may prompt for consent.
    prompt: params.interactive ? 'consent' : 'none',
  });
  return `${config.authEndpoint ?? GOOGLE_AUTH_ENDPOINT}?${query.toString()}`;
}

/** Extract the authorization code and state from the OAuth redirect query. */
export function parseAuthRedirect(redirectUrl: string): { code: string | null; state: string | null } {
  const queryIndex = redirectUrl.indexOf('?');
  if (queryIndex < 0) return { code: null, state: null };
  const query = redirectUrl.slice(queryIndex + 1).split('#')[0];
  const params = new URLSearchParams(query);
  return { code: params.get('code'), state: params.get('state') };
}

/** Default client-side code->token exchange against Google's token endpoint. */
export async function exchangeAuthCodeForToken({ code, codeVerifier, config }: TokenExchangeParams): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: codeVerifier,
    redirect_uri: config.redirectUri,
  });
  const response = await fetch(config.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Token exchange failed (${response.status}): ${detail}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('Token exchange returned no access_token');
  }
  return payload.access_token;
}

export class WebAuthFlowAuthProvider implements AuthProvider {
  private readonly launch: LaunchWebAuthFlow;
  private readonly createPkce: CreatePkcePair;
  private readonly exchange: ExchangeAuthCode;
  private readonly generateState: () => string;

  constructor(private readonly config: WebAuthFlowConfig, deps: WebAuthFlowDeps) {
    this.launch = deps.launch;
    this.createPkce = deps.createPkce ?? createPkcePair;
    this.exchange = deps.exchange ?? exchangeAuthCodeForToken;
    this.generateState = deps.generateState ?? (() => randomUrlSafeToken(16));
  }

  async getToken({ interactive }: AuthTokenRequest): Promise<string> {
    if (!this.config.clientId) {
      throw new Error('Web OAuth client ID is not configured for launchWebAuthFlow');
    }
    const { verifier, challenge } = await this.createPkce();
    const state = this.generateState();
    const redirectUrl = await this.launch(
      buildAuthUrl(this.config, { codeChallenge: challenge, state, interactive }),
      interactive
    );
    const parsed = parseAuthRedirect(redirectUrl);
    if (parsed.state !== state) {
      throw new Error('OAuth state mismatch in launchWebAuthFlow redirect');
    }
    if (!parsed.code) {
      throw new Error('launchWebAuthFlow returned no authorization code');
    }
    return this.exchange({ code: parsed.code, codeVerifier: verifier, config: this.config });
  }

  invalidateToken(_token: string): Promise<void> {
    // No browser-side token cache to clear; driveAuth and the upload layer own
    // caching, and a fresh launchWebAuthFlow always re-acquires.
    return Promise.resolve();
  }
}
