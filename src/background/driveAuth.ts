/**
 * @file background/driveAuth.ts
 *
 * Handles Chrome Identity OAuth token acquisition for Drive uploads, including
 * silent-first fallback and explicit diagnostics for bad client IDs.
 */

import type { AuthProvider } from '../platform/capabilities/AuthProvider';
import { createAuthProvider } from '../platform/capabilities/auth/createAuthProvider';
import { getRuntimeId, getRuntimeManifest } from '../platform/chrome/runtime';
import { isE2EMockDriveBuild } from '../shared/build';

type DriveTokenOk = { ok: true; token: string };
type DriveTokenErr = { ok: false; error: string };
export type DriveTokenResponse = DriveTokenOk | DriveTokenErr;
export type DriveTokenOptions = { refresh?: boolean };

const BAD_CLIENT_ID_RE = /bad client id/i;
let lastIssuedToken: string | null = null;

// Token acquisition is delegated to a browser-specific AuthProvider (ADR-0002);
// the silent-then-interactive, refresh, and bad-client-id policy below stays
// browser-agnostic. Lazily created so the chrome capability check runs after the
// environment is ready (and is overridable in tests via setAuthProvider).
let authProvider: AuthProvider | null = null;

function provider(): AuthProvider {
  if (!authProvider) authProvider = createAuthProvider();
  return authProvider;
}

/** Test seam: inject a fake AuthProvider, or pass null to reset to the default. */
export function setAuthProvider(next: AuthProvider | null): void {
  authProvider = next;
}

async function issueAuthToken(interactive: boolean): Promise<string> {
  const token = await provider().getToken({ interactive });
  lastIssuedToken = token;
  return token;
}

async function invalidateLastIssuedToken(): Promise<void> {
  if (!lastIssuedToken) return;
  const token = lastIssuedToken;
  lastIssuedToken = null;
  await provider().invalidateToken(token);
}

function isBadClientIdError(message: string): boolean {
  return BAD_CLIENT_ID_RE.test(message);
}

function buildBadClientIdError(rawError: string): string {
  const manifest = getRuntimeManifest();
  const configuredClientId = manifest.oauth2?.client_id ?? '(missing in manifest.oauth2.client_id)';
  const extensionId = getRuntimeId() ?? '(unknown extension id)';

  return (
    `Google OAuth is misconfigured: ${rawError} ` +
    `Current extension ID: ${extensionId} ` +
    `Manifest client ID: ${configuredClientId} ` +
    'Fix: create a Google Cloud OAuth client of type "Chrome Extension" for this extension ID and use that client ID in manifest.oauth2.client_id.'
  );
}

export async function fetchDriveTokenWithFallback(options: DriveTokenOptions = {}): Promise<DriveTokenResponse> {
  if (
    (typeof __E2E_MOCK_DRIVE_BUILD__ !== 'undefined'
      ? __E2E_MOCK_DRIVE_BUILD__
      : isE2EMockDriveBuild())
  ) {
    return { ok: true, token: 'e2e-mock-drive-token' };
  }

  if (options.refresh) {
    await invalidateLastIssuedToken();
  }

  try {
    const token = await issueAuthToken(false);
    return { ok: true, token };
  } catch (silentErr: any) {
    const silentMessage = silentErr?.message || String(silentErr);
    if (isBadClientIdError(silentMessage)) {
      return { ok: false, error: buildBadClientIdError(silentMessage) };
    }
    try {
      const token = await issueAuthToken(true);
      return { ok: true, token };
    } catch (interactiveErr: any) {
      const interactiveMessage = interactiveErr?.message || String(interactiveErr);
      if (isBadClientIdError(interactiveMessage)) {
        return { ok: false, error: buildBadClientIdError(interactiveMessage) };
      }
      return {
        ok: false,
        error: `OAuth token fetch failed. Silent auth error: ${silentMessage}. Interactive auth error: ${interactiveMessage}`,
      };
    }
  }
}
