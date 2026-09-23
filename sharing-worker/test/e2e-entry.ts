import worker from '../src/index';

type Faults = {
  delayNextChunkMs: number;
  dropNextChunkResponse: boolean;
  dropNextDeleteResponse: boolean;
  expireNextUpload: boolean;
  ownerUnauthorizedOnce: boolean;
};

const faults: Faults = {
  delayNextChunkMs: 0,
  dropNextChunkResponse: false,
  dropNextDeleteResponse: false,
  expireNextUpload: false,
  ownerUnauthorizedOnce: false,
};

const counters = {
  authSessions: 0,
  uploadBegins: 0,
  chunkCommits: 0,
  expiredUploads: 0,
  droppedChunkResponses: 0,
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

    const response = await worker.fetch(request, env);
    if (url.pathname === '/api/auth/session' && response.ok) counters.authSessions += 1;

    const begin = /\/uploads$/.test(url.pathname) && request.method === 'POST';
    if (begin && response.status === 201) {
      counters.uploadBegins += 1;
      if (faults.expireNextUpload) {
        faults.expireNextUpload = false;
        const body = await response.clone().json() as { uploadId?: string };
        if (body.uploadId) {
          const upload = await env.SHARING_DB.prepare(
            'SELECT object_key, r2_upload_id FROM share_uploads WHERE id = ?',
          ).bind(body.uploadId).first<{ object_key: string; r2_upload_id: string }>();
          if (upload) {
            await env.SHARING_MEDIA.resumeMultipartUpload(upload.object_key, upload.r2_upload_id).abort();
            counters.expiredUploads += 1;
          }
        }
      }
    }

    const chunk = /^\/api\/share-uploads\/[^/]+\/chunks\/\d+$/.test(url.pathname) && request.method === 'PUT';
    if (chunk && response.ok) {
      counters.chunkCommits += 1;
      if (faults.dropNextChunkResponse) {
        faults.dropNextChunkResponse = false;
        counters.droppedChunkResponses += 1;
        return new Response(JSON.stringify({ code: 'E2E_LOST_RESPONSE' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (faults.delayNextChunkMs > 0) {
        const delay = faults.delayNextChunkMs;
        faults.delayNextChunkMs = 0;
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
  if (body.delayNextChunkMs != null) faults.delayNextChunkMs = Math.max(0, Math.min(30_000, Math.floor(body.delayNextChunkMs)));
  if (body.dropNextChunkResponse != null) faults.dropNextChunkResponse = body.dropNextChunkResponse === true;
  if (body.dropNextDeleteResponse != null) faults.dropNextDeleteResponse = body.dropNextDeleteResponse === true;
  if (body.expireNextUpload != null) faults.expireNextUpload = body.expireNextUpload === true;
  if (body.ownerUnauthorizedOnce != null) faults.ownerUnauthorizedOnce = body.ownerUnauthorizedOnce === true;
  return Response.json({ ...faults });
}

async function state(env: Env): Promise<Response> {
  const shares = await env.SHARING_DB.prepare(
    'SELECT id, owner_id, status, manifest_json, created_at, updated_at FROM shares ORDER BY created_at',
  ).all<{ id: string; owner_id: string; status: string; manifest_json: string; created_at: number; updated_at: number }>();
  const uploads = await env.SHARING_DB.prepare(
    'SELECT id, share_id, status, offset, bytes FROM share_uploads ORDER BY created_at',
  ).all<{ id: string; share_id: string; status: string; offset: number; bytes: number }>();
  const objects = await env.SHARING_MEDIA.list({ prefix: 'shares/' });
  return Response.json({
    counters: { ...counters },
    faults: { ...faults },
    shares: shares.results.map((share) => ({ ...share, manifest: JSON.parse(share.manifest_json), manifest_json: undefined })),
    uploads: uploads.results,
    objects: objects.objects.map((object) => ({ key: object.key, size: object.size })),
  });
}

function isOwnerRequest(pathname: string): boolean {
  return pathname.startsWith('/api/shares') || pathname.startsWith('/api/share-uploads');
}
