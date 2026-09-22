import { secureEqual } from './crypto';
import { ownerOriginAllowed } from '../http/cors';
import { json } from '../http/responses';

export async function authorizeOwner(request: Request, env: Env): Promise<Response | null> {
  if (!ownerOriginAllowed(request, env)) return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403);

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return json({ code: 'OWNER_AUTH_REQUIRED' }, 401);
  const supplied = header.slice('Bearer '.length);
  if (!(await secureEqual(supplied, env.OWNER_API_TOKEN, env.SESSION_KEY))) {
    return json({ code: 'OWNER_AUTH_INVALID' }, 401);
  }
  return null;
}
