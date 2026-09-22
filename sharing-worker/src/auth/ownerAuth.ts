import { ownerOriginAllowed } from '../http/cors';
import { json } from '../http/responses';

export type OwnerIdentity = {
  /** Stable Google Drive permission id, namespaced for future identity providers. */
  id: string;
};

const DRIVE_ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)';

export async function authorizeOwner(request: Request, env: Env): Promise<OwnerIdentity | Response> {
  if (!ownerOriginAllowed(request, env)) return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403);

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return json({ code: 'OWNER_AUTH_REQUIRED' }, 401);
  const token = header.slice('Bearer '.length).trim();
  if (!token) return json({ code: 'OWNER_AUTH_REQUIRED' }, 401);

  let response: Response;
  try {
    response = await fetch(DRIVE_ABOUT_URL, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    return json({ code: 'OWNER_AUTH_UNAVAILABLE' }, 503);
  }

  if (response.status === 401 || response.status === 403) {
    return json({ code: 'OWNER_AUTH_INVALID' }, 401);
  }
  if (!response.ok) return json({ code: 'OWNER_AUTH_UNAVAILABLE' }, 503);

  const body = await response.json().catch(() => null) as { user?: { permissionId?: unknown } } | null;
  const permissionId = body?.user?.permissionId;
  if (typeof permissionId !== 'string' || !permissionId.trim()) {
    return json({ code: 'OWNER_AUTH_INVALID' }, 401);
  }
  return { id: `google-drive:${permissionId.trim()}` };
}
