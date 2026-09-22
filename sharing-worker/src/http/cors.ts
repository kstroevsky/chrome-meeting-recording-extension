import { json } from './responses';

function allowedOrigins(env: Env): Set<string> {
  return new Set(env.ALLOWED_EXTENSION_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean));
}

export function ownerCorsPreflight(request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).has(origin)) return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403);
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, content-range',
      'access-control-max-age': '86400',
      vary: 'Origin',
    },
  });
}

export function withOwnerCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.append('vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function ownerOriginAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('origin');
  return !origin || allowedOrigins(env).has(origin);
}
