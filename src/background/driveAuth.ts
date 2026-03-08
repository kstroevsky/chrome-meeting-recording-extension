import { getAuthToken, removeCachedAuthToken } from '../platform/chrome/identity';
import { getRuntimeId, getRuntimeManifest } from '../platform/chrome/runtime';

type DriveTokenOk = { ok: true; token: string };
type DriveTokenErr = { ok: false; error: string };
export type DriveTokenResponse = DriveTokenOk | DriveTokenErr;
export type DriveTokenOptions = { refresh?: boolean };

const BAD_CLIENT_ID_RE = /bad client id/i;
let lastIssuedToken: string | null = null;

async function issueAuthToken(interactive: boolean): Promise<string> {
  const token = await getAuthToken(interactive);
  lastIssuedToken = token;
  return token;
}

async function invalidateLastIssuedToken(): Promise<void> {
  if (!lastIssuedToken) return;
  const token = lastIssuedToken;
  lastIssuedToken = null;
  await removeCachedAuthToken(token);
}

function isBadClientIdError(message: string): boolean {
  return BAD_CLIENT_ID_RE.test(message);
}

function buildBadClientIdError(rawError: string): string {
  const manifest = getRuntimeManifest();
  const configuredClientId = manifest.oauth2?.client_id ?? '(missing in manifest.oauth2.client_id)';
  const extensionId = getRuntimeId() ?? '(unknown extension id)';

  return [
    `Google OAuth is misconfigured: ${rawError}`,
    `Current extension ID: ${extensionId}`,
    `Manifest client ID: ${configuredClientId}`,
    'Fix: create a Google Cloud OAuth client of type "Chrome Extension" for this extension ID and use that client ID in manifest.oauth2.client_id.',
  ].join(' ');
}

export async function fetchDriveTokenWithFallback(options: DriveTokenOptions = {}): Promise<DriveTokenResponse> {
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
