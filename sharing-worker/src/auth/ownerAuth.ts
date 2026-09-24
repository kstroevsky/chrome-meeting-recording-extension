import { ownerOriginAllowed } from '../http/cors';
import { json } from '../http/responses';
import { enforceOwnerMutationRate } from '../security/limits';
import { ownerSessionTtl, signOwnerSession, verifyOwnerSession } from './ownerSession';

export type OwnerIdentity = {
  /** Stable Google Account subject, namespaced for future identity providers. */
  id: string;
};

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

function tokenInfoUrl(env: Env, token: string): URL {
  const configured = (env as Env & { GOOGLE_TOKENINFO_URL?: string }).GOOGLE_TOKENINFO_URL?.trim();
  const url = new URL(configured || GOOGLE_TOKENINFO_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) {
    throw new Error('Google token introspection endpoint must use HTTPS');
  }
  url.searchParams.set('access_token', token);
  return url;
}

export async function createOwnerSession(request: Request, env: Env): Promise<Response> {
  if (!ownerOriginAllowed(request, env)) return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403);
  const token = bearerToken(request);
  if (!token) return json({ code: 'OWNER_IDENTITY_REQUIRED' }, 401);

  let response: Response;
  try {
    const url = tokenInfoUrl(env, token);
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    return json({ code: 'OWNER_IDENTITY_UNAVAILABLE' }, 503);
  }
  if (response.status === 401 || response.status === 403) {
    return json({ code: 'OWNER_IDENTITY_INVALID' }, 401);
  }
  if (!response.ok) return json({ code: 'OWNER_IDENTITY_UNAVAILABLE' }, 503);

  const body = await response.json().catch(() => null) as { sub?: unknown; aud?: unknown } | null;
  const subject = body?.sub;
  const audience = body?.aud;
  if (
    typeof subject !== 'string' || !subject.trim()
    || typeof audience !== 'string' || audience !== env.GOOGLE_OAUTH_CLIENT_ID
  ) {
    return json({ code: 'OWNER_IDENTITY_INVALID' }, 401);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + ownerSessionTtl(env);
  const ownerId = `google:${subject.trim()}`;
  const limited = await enforceOwnerMutationRate(env, ownerId);
  if (limited) return limited;
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
