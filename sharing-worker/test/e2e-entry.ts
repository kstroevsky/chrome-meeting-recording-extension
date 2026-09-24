import worker from '../src/index';

type Faults = {
  delayNextOriginMs: number;
  dropNextOriginResponse: boolean;
  dropNextDeleteResponse: boolean;
  ownerUnauthorizedOnce: boolean;
};

const faults: Faults = {
  delayNextOriginMs: 0,
  dropNextOriginResponse: false,
  dropNextDeleteResponse: false,
  ownerUnauthorizedOnce: false,
};

const counters = {
  authSessions: 0,
  originRegistrations: 0,
  droppedOriginResponses: 0,
  droppedDeleteResponses: 0,
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__e2e__/state' && request.method === 'GET') return state(env);
    if (url.pathname === '/__e2e__/faults' && request.method === 'POST') return configureFaults(request);

    if (faults.ownerUnauthorizedOnce && isOwnerRequest(url.pathname) && url.pathname !== '/api/auth/session') {
      faults.ownerUnauthorizedOnce = false;
      return new Response(JSON.stringify({ code: 'OWNER_AUTH_INVALID' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    const response = await worker.fetch(request, env, ctx);
    if (url.pathname === '/api/auth/session' && response.ok) counters.authSessions += 1;

    const origin = /^\/api\/shares\/[^/]+\/recordings\/[^/]+\/tracks\/[^/]+\/origin$/.test(url.pathname)
      && request.method === 'PUT';
    if (origin && response.ok) {
      counters.originRegistrations += 1;
      if (faults.dropNextOriginResponse) {
        faults.dropNextOriginResponse = false;
        counters.droppedOriginResponses += 1;
        return new Response(JSON.stringify({ code: 'E2E_LOST_RESPONSE' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (faults.delayNextOriginMs > 0) {
        const delay = faults.delayNextOriginMs;
        faults.delayNextOriginMs = 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    const deleteShare = /^\/api\/shares\/[^/]+$/.test(url.pathname) && request.method === 'DELETE';
    if (deleteShare && response.ok && faults.dropNextDeleteResponse) {
      faults.dropNextDeleteResponse = false;
      counters.droppedDeleteResponses += 1;
      return new Response(JSON.stringify({ code: 'E2E_LOST_RESPONSE' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return response;
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    worker.scheduled?.(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function configureFaults(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as Partial<Faults> | null;
  if (!body) return new Response('invalid fault config', { status: 400 });
  if (body.delayNextOriginMs != null) {
    faults.delayNextOriginMs = Math.max(0, Math.min(90_000, Math.floor(body.delayNextOriginMs)));
  }
  if (body.dropNextOriginResponse != null) faults.dropNextOriginResponse = body.dropNextOriginResponse === true;
  if (body.dropNextDeleteResponse != null) faults.dropNextDeleteResponse = body.dropNextDeleteResponse === true;
  if (body.ownerUnauthorizedOnce != null) faults.ownerUnauthorizedOnce = body.ownerUnauthorizedOnce === true;
  return Response.json({ ...faults });
}

async function state(env: Env): Promise<Response> {
  const shares = await env.SHARING_DB.prepare(
    'SELECT id, owner_id, status, manifest_json, created_at, updated_at FROM shares ORDER BY created_at',
  ).all<{ id: string; owner_id: string; status: string; manifest_json: string; created_at: number; updated_at: number }>();
  const mediaAssets = await env.SHARING_DB.prepare(
    `SELECT id, share_id, recording_id, track_id, drive_file_id, revision_id, bytes,
            mime_type, permission_id
       FROM media_assets
      ORDER BY created_at`,
  ).all<{
    id: string;
    share_id: string;
    recording_id: string;
    track_id: string;
    drive_file_id: string;
    revision_id: string;
    bytes: number;
    mime_type: string;
    permission_id: string | null;
  }>();
  const cacheEntries = await env.SHARING_DB.prepare(
    `SELECT cache_key, asset_id, bytes, cached_at, expires_at
       FROM media_cache_entries
      ORDER BY cached_at`,
  ).all<{ cache_key: string; asset_id: string; bytes: number; cached_at: number; expires_at: number }>();
  const cacheObjects = await env.SHARING_MEDIA.list({ prefix: 'cache/v1/' });
  return Response.json({
    counters: { ...counters },
    faults: { ...faults },
    shares: shares.results.map((share) => ({ ...share, manifest: JSON.parse(share.manifest_json), manifest_json: undefined })),
    mediaAssets: mediaAssets.results,
    cacheEntries: cacheEntries.results,
    cacheObjects: cacheObjects.objects.map((object) => ({ key: object.key, size: object.size })),
  });
}

function isOwnerRequest(pathname: string): boolean {
  return pathname === '/api/sharing-reader' || pathname.startsWith('/api/shares');
}
