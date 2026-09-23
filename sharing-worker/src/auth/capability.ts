import type { ShareRow } from '../shares/ShareRepository';
import { base64UrlDecode, base64UrlEncode, hmacBase64Url, secureEqual } from './crypto';
import { capabilitySecret } from './capabilityKeys';

const encoder = new TextEncoder();

export type ViewerSession = {
  shareId: string;
  capabilityVersion: number;
  expiresAt: number;
};

export async function deriveCapability(shareId: string, version: number, secret: string): Promise<string> {
  return hmacBase64Url(secret, `share:${shareId}:v${version}`);
}

export async function shareUrl(
  share: Pick<ShareRow, 'id' | 'capability_version' | 'capability_key_id'>,
  request: Request,
  env: Env,
): Promise<string> {
  const capability = await deriveCapability(
    share.id,
    share.capability_version,
    capabilitySecret(env, share.capability_key_id),
  );
  return capabilityUrl(request, capability);
}

export function capabilityUrl(request: Request, capability: string): string {
  const url = new URL(request.url);
  return `${url.origin}/s/${encodeURIComponent(capability)}`;
}

export async function signViewerSession(session: ViewerSession, secret: string): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(session)));
  const signature = await hmacBase64Url(secret, payload);
  return `${payload}.${signature}`;
}

export async function verifyViewerSession(token: string, secret: string): Promise<ViewerSession | null> {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra != null) return null;
  const expected = await hmacBase64Url(secret, payload);
  if (!(await secureEqual(signature, expected, secret))) return null;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as Record<string, unknown>;
    if (
      typeof parsed.shareId !== 'string' ||
      !Number.isInteger(parsed.capabilityVersion) ||
      !Number.isInteger(parsed.expiresAt)
    ) return null;
    return {
      shareId: parsed.shareId,
      capabilityVersion: Number(parsed.capabilityVersion),
      expiresAt: Number(parsed.expiresAt),
    };
  } catch {
    return null;
  }
}

export function viewerSessionTtl(env: Env): number {
  const parsed = Number(env.VIEWER_SESSION_TTL_SECONDS);
  return Number.isInteger(parsed) && parsed >= 60 ? Math.min(parsed, 86_400) : 43_200;
}

export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}
