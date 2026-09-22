import { authorizeOwner } from './auth/ownerAuth';
import { ownerCorsPreflight, withOwnerCors } from './http/cors';
import { json } from './http/responses';
import { routeShareOwnerRequest } from './shares/routes';
import { routeUploadOwnerRequest } from './uploads/routes';
import { routeViewerRequest } from './viewer/routes';

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const ownerRoute = isOwnerRoute(url.pathname);

  if (ownerRoute && request.method === 'OPTIONS') {
    return ownerCorsPreflight(request, env);
  }

  if (ownerRoute) {
    const denied = await authorizeOwner(request, env);
    if (denied) return withOwnerCors(denied, request, env);
    const response = await routeOwner(request, env, url);
    return withOwnerCors(response, request, env);
  }

  return await routeViewerRequest(request, env, url) ?? json({ code: 'NOT_FOUND' }, 404);
}

async function routeOwner(request: Request, env: Env, url: URL): Promise<Response> {
  const shareResponse = await routeShareOwnerRequest(request, env, url);
  if (shareResponse) return shareResponse;

  const uploadResponse = await routeUploadOwnerRequest(request, env, url);
  if (uploadResponse) return uploadResponse;

  return json({ code: 'NOT_FOUND' }, 404);
}

function isOwnerRoute(pathname: string): boolean {
  return pathname === '/api/shares' || pathname.startsWith('/api/shares/') || pathname.startsWith('/api/share-uploads/');
}
