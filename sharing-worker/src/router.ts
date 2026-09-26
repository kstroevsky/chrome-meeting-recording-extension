import { authorizeOwner, createOwnerSession } from './auth/ownerAuth';
import { ownerCorsPreflight, withOwnerCors } from './http/cors';
import { json } from './http/responses';
import { observeSharingResponse } from './observability';
import { enforceOwnerMutationRate } from './security/limits';
import { routeShareOwnerRequest } from './shares/routes';
import { routeViewerRequest } from './viewer/routes';

export async function route(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const ownerRoute = isOwnerRoute(url.pathname);

  if (ownerRoute && request.method === 'OPTIONS') {
    return ownerCorsPreflight(request, env);
  }

  if (url.pathname === '/api/auth/session' && request.method === 'POST') {
    return withOwnerCors(await createOwnerSession(request, env), request, env);
  }

  if (ownerRoute) {
    const owner = await authorizeOwner(request, env);
    if (owner instanceof Response) return withOwnerCors(owner, request, env);
    if (shouldRateLimitOwnerMutation(request, url)) {
      const limited = await enforceOwnerMutationRate(env, owner.id);
      if (limited) return withOwnerCors(limited, request, env);
    }
    const response = await routeOwner(request, env, url, owner.id);
    observeSharingResponse(url, response);
    return withOwnerCors(response, request, env);
  }

  const viewerResponse = await routeViewerRequest(request, env, url, ctx);
  if (viewerResponse) {
    observeSharingResponse(url, viewerResponse);
    return viewerResponse;
  }
  return json({ code: 'NOT_FOUND' }, 404);
}

async function routeOwner(request: Request, env: Env, url: URL, ownerId: string): Promise<Response> {
  const shareResponse = await routeShareOwnerRequest(request, env, url, ownerId);
  if (shareResponse) return shareResponse;

  return json({ code: 'NOT_FOUND' }, 404);
}

function isOwnerRoute(pathname: string): boolean {
  return pathname === '/api/auth/session'
    || pathname === '/api/sharing-reader'
    || pathname === '/api/shares'
    || pathname.startsWith('/api/shares/')
    || pathname.startsWith('/api/origin-cleanup/');
}

function shouldRateLimitOwnerMutation(request: Request, url: URL): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return false;
  return true;
}
