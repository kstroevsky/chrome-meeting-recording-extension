import type { AuthProvider } from '../platform/capabilities/AuthProvider';
import { createAuthProvider } from '../platform/capabilities/auth/createAuthProvider';
import { isE2EMockDriveBuild } from '../shared/build';

export type ShareIdentityTokenOptions = { refresh?: boolean };
export type ShareIdentityTokenResponse = { ok: true; token: string } | { ok: false; error: string };

export const SHARE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

let authProvider: AuthProvider | null = null;
let lastIssuedToken: string | null = null;

function provider(): AuthProvider {
  if (!authProvider) authProvider = createAuthProvider(SHARE_IDENTITY_SCOPES);
  return authProvider;
}

export function setShareIdentityAuthProvider(next: AuthProvider | null): void {
  authProvider = next;
  lastIssuedToken = null;
}

async function issue(interactive: boolean): Promise<string> {
  const token = await provider().getToken({ interactive });
  lastIssuedToken = token;
  return token;
}

async function invalidateLast(): Promise<void> {
  if (!lastIssuedToken) return;
  const token = lastIssuedToken;
  lastIssuedToken = null;
  await provider().invalidateToken(token);
}

export async function fetchShareIdentityTokenWithFallback(
  options: ShareIdentityTokenOptions = {},
): Promise<ShareIdentityTokenResponse> {
  if (typeof __E2E_MOCK_DRIVE_BUILD__ !== 'undefined'
    ? __E2E_MOCK_DRIVE_BUILD__
    : isE2EMockDriveBuild()) {
    return { ok: true, token: 'e2e-mock-share-identity-token' };
  }
  if (options.refresh) await invalidateLast();
  try {
    return { ok: true, token: await issue(false) };
  } catch (silentError) {
    try {
      return { ok: true, token: await issue(true) };
    } catch (interactiveError) {
      return {
        ok: false,
        error: `Sharing identity OAuth failed. Silent auth error: ${describe(silentError)}. Interactive auth error: ${describe(interactiveError)}`,
      };
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
