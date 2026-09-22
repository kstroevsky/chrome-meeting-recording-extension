import { base64UrlDecode, base64UrlEncode, hmacBase64Url, secureEqual } from './crypto';

const encoder = new TextEncoder();

export type OwnerSession = {
  kind: 'owner';
  ownerId: string;
  expiresAt: number;
};

export async function signOwnerSession(session: OwnerSession, secret: string): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(session)));
  const signature = await hmacBase64Url(secret, `owner-session:${payload}`);
  return `${payload}.${signature}`;
}

export async function verifyOwnerSession(token: string, secret: string): Promise<OwnerSession | null> {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra != null) return null;
  const expected = await hmacBase64Url(secret, `owner-session:${payload}`);
  if (!(await secureEqual(signature, expected, secret))) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as Record<string, unknown>;
    if (parsed.kind !== 'owner'
      || typeof parsed.ownerId !== 'string' || !parsed.ownerId.trim()
      || !Number.isInteger(parsed.expiresAt)) return null;
    return {
      kind: 'owner',
      ownerId: parsed.ownerId.trim(),
      expiresAt: Number(parsed.expiresAt),
    };
  } catch {
    return null;
  }
}

export function ownerSessionTtl(env: Env): number {
  const parsed = Number(env.OWNER_SESSION_TTL_SECONDS);
  return Number.isInteger(parsed) && parsed >= 300 ? Math.min(parsed, 3_600) : 3_600;
}
