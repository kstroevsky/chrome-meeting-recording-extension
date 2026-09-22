import { ownerOriginAllowed } from '../http/cors';
import { json } from '../http/responses';
import { ownerSessionTtl, signOwnerSession, verifyOwnerSession } from './ownerSession';

export type OwnerIdentity = {
  /** Stable Google Account subject, namespaced for future identity providers. */
  id: string;
};

const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export async function createOwnerSession(request: Request, env: Env): Promise<Response> {
  if (!ownerOriginAllowed(request, env)) return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403);
  const token = bearerToken(request);
  if (!token) return json({ code: 'OWNER_IDENTITY_REQUIRED' }, 401);

  let response: Response;
  try {
    response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return json({ code: 'OWNER_IDENTITY_UNAVAILABLE' }, 503);
  }
  if (response.status === 401 || response.status === 403) {
    return json({ code: 'OWNER_IDENTITY_INVALID' }, 401);
  }
  if (!response.ok) return json({ code: 'OWNER_IDENTITY_UNAVAILABLE' }, 503);

  const body = await response.json().catch(() => null) as { sub?: unknown } | null;
  const subject = body?.sub;
  if (typeof subject !== 'string' || !subject.trim()) {
    return json({ code: 'OWNER_IDENTITY_INVALID' }, 401);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + ownerSessionTtl(env);
  const ownerId = `google:${subject.trim()}`;
  const session = await signOwnerSession({ kind: 'owner', ownerId, expiresAt }, env.SESSION_KEY);
  return json({ token: session, expiresAt });
}

export async function authorizeOwner(request: Request, env: Env): Promise<OwnerIdentity | Response> {
  if (!ownerOriginAllowed(request, env)) return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403);
  const token = bearerToken(request);
  if (!token) return json({ code: 'OWNER_AUTH_REQUIRED' }, 401);
  const session = await verifyOwnerSession(token, env.SESSION_KEY);
  if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) {
    return json({ code: 'OWNER_AUTH_INVALID' }, 401);
  }
  return { id: session.ownerId };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}
