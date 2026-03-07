/**
 * @file offscreen/drive/errors.ts
 *
 * Normalizes Drive API error responses into concise messages that are useful
 * in extension logs without dumping large payloads.
 */

/**
 * Reads and extracts the most relevant message from a Drive HTTP response.
 * Falls back to a short raw body preview if JSON parsing fails.
 */
export async function readDriveErrorDetail(res: Response): Promise<string> {
  try {
    const raw = await res.text();
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      const message = parsed?.error?.message ?? parsed?.message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    } catch {
      // Non-JSON body; fall back to trimmed text.
    }
    return raw.trim().slice(0, 300);
  } catch {
    return '';
  }
}

function buildDriveHint(status: number, detail: string): string {
  const d = detail.toLowerCase();

  if (status === 403 && (d.includes('insufficient') || d.includes('scope'))) {
    return 'Hint: OAuth scope is missing. Confirm manifest oauth2.scopes includes https://www.googleapis.com/auth/drive.file and re-consent.';
  }
  if ((status === 400 || status === 403) && (d.includes('accessnotconfigured') || d.includes('api has not been used') || d.includes('drive api'))) {
    return 'Hint: Enable Google Drive API in the same Google Cloud project as this OAuth client.';
  }
  if (status === 403 && (d.includes('test user') || d.includes('not verified') || d.includes('consent screen'))) {
    return 'Hint: Add this account as an OAuth test user (if app is in Testing mode) or publish the app.';
  }
  if (status === 401) {
    return 'Hint: Token rejected by Google; reloading the extension and reconnecting Drive may help.';
  }
  return '';
}

export function formatDriveError(prefix: string, status: number, detail: string): string {
  const suffix = detail ? `: ${detail}` : '';
  const hint = buildDriveHint(status, detail);
  return hint ? `${prefix}: ${status}${suffix}. ${hint}` : `${prefix}: ${status}${suffix}`;
}
