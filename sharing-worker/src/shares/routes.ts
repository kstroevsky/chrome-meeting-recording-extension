import { capabilityUrl, deriveCapability, shareUrl } from '../auth/capability';
import { sha256Base64Url } from '../auth/crypto';
import { json, readJson } from '../http/responses';
import { canonicalizeManifest, canonicalizeStoredManifest } from './manifestSchema';
import { getOwnedShare, getShare, mediaObjectKey, type ShareRow } from './ShareRepository';

export async function routeShareOwnerRequest(
  request: Request,
  env: Env,
  url: URL,
  ownerId: string,
): Promise<Response | null> {
  if (url.pathname === '/api/shares' && request.method === 'GET') {
    return listShares(request, env, ownerId);
  }

  const shareMatch = /^\/api\/shares\/([^/]+)$/.exec(url.pathname);
  if (shareMatch) {
    const shareId = decodeURIComponent(shareMatch[1]);
    if (request.method === 'PUT') return putShare(shareId, request, env, ownerId);
    if (request.method === 'GET') return getShareResponse(shareId, request, env, ownerId);
    if (request.method === 'DELETE') return revokeShare(shareId, env, ownerId);
  }

  const finalizeMatch = /^\/api\/shares\/([^/]+)\/finalize$/.exec(url.pathname);
  if (finalizeMatch && request.method === 'POST') {
    return finalizeShare(decodeURIComponent(finalizeMatch[1]), request, env, ownerId);
  }

  return null;
}

async function putShare(shareId: string, request: Request, env: Env, ownerId: string): Promise<Response> {
  const body = await readJson(request);
  const manifest = canonicalizeManifest(body, shareId);
  if (!manifest) return json({ code: 'INVALID_MANIFEST' }, 400);

  const manifestJson = JSON.stringify(manifest);
  const existing = await getShare(env.SHARING_DB, shareId);
  if (existing) {
    if (existing.owner_id !== ownerId) return json({ code: 'SHARE_NOT_FOUND' }, 404);
    const existingManifest = canonicalizeStoredManifest(existing.manifest_json, shareId);
    if (!existingManifest || JSON.stringify(existingManifest) !== manifestJson) {
      return json({ code: 'SHARE_ID_CONFLICT', message: 'Share id already belongs to another snapshot' }, 409);
    }
    if (existing.status === 'revoked') return json({ code: 'SHARE_REVOKED' }, 410);
    return new Response(null, { status: 200 });
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.SHARING_DB.prepare(
      `INSERT INTO shares (id, owner_id, status, manifest_json, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?)`,
    ).bind(shareId, ownerId, manifestJson, now, now),
  ];

  for (const recording of manifest.recordings) {
    for (const track of recording.tracks) {
      statements.push(
        env.SHARING_DB.prepare(
          `INSERT INTO share_tracks
             (share_id, recording_id, track_id, mime_type, bytes, object_key, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        ).bind(
          shareId,
          recording.id,
          track.id,
          track.mimeType,
          track.bytes ?? null,
          mediaObjectKey(shareId, recording.id, track.id),
        ),
      );
    }
  }

  await env.SHARING_DB.batch(statements);
  return new Response(null, { status: 201 });
}

async function listShares(request: Request, env: Env, ownerId: string): Promise<Response> {
  const result = await env.SHARING_DB.prepare(
    `SELECT id, owner_id, status, manifest_json, capability_hash, capability_version,
            created_at, updated_at, finalized_at, revoked_at
       FROM shares WHERE owner_id = ? ORDER BY created_at DESC`,
  ).bind(ownerId).all<ShareRow>();

  const shares = await Promise.all(result.results.map((share) => ownerShareView(share, request, env)));
  return json({ shares });
}

async function getShareResponse(shareId: string, request: Request, env: Env, ownerId: string): Promise<Response> {
  const share = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  return json(await ownerShareView(share, request, env));
}

async function ownerShareView(share: ShareRow, request: Request, env: Env): Promise<Record<string, unknown>> {
  return {
    id: share.id,
    status: share.status,
    manifest: JSON.parse(share.manifest_json),
    createdAt: share.created_at,
    updatedAt: share.updated_at,
    ...(share.finalized_at != null ? { finalizedAt: share.finalized_at } : {}),
    ...(share.revoked_at != null ? { revokedAt: share.revoked_at } : {}),
    ...(share.status === 'active' ? { shareUrl: await shareUrl(share, request, env) } : {}),
  };
}

async function revokeShare(shareId: string, env: Env, ownerId: string): Promise<Response> {
  const share = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  if (share.status === 'revoked') return new Response(null, { status: 204 });

  const now = Date.now();
  await env.SHARING_DB.batch([
    env.SHARING_DB.prepare(
      `UPDATE shares SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(now, now, shareId),
    env.SHARING_DB.prepare(
      `UPDATE share_uploads SET status = 'abandoned', updated_at = ?
       WHERE share_id = ? AND status = 'uploading'`,
    ).bind(now, shareId),
  ]);
  return new Response(null, { status: 204 });
}

async function finalizeShare(shareId: string, request: Request, env: Env, ownerId: string): Promise<Response> {
  const share = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  if (share.status === 'revoked') return json({ code: 'SHARE_REVOKED' }, 410);
  if (share.status === 'active') return json({ shareUrl: await shareUrl(share, request, env) });

  const pending = await env.SHARING_DB.prepare(
    `SELECT COUNT(*) AS count FROM share_tracks WHERE share_id = ? AND status != 'complete'`,
  ).bind(shareId).first<{ count: number }>();
  if (!pending || pending.count !== 0) return json({ code: 'SHARE_UPLOADS_INCOMPLETE' }, 409);

  const capability = await deriveCapability(share.id, share.capability_version, env.CAPABILITY_KEY);
  const capabilityHash = await sha256Base64Url(capability);
  const now = Date.now();
  await env.SHARING_DB.prepare(
    `UPDATE shares
        SET status = 'active', capability_hash = ?, finalized_at = COALESCE(finalized_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('draft', 'uploading')`,
  ).bind(capabilityHash, now, now, share.id).run();

  const active = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
  if (!active || active.status !== 'active') return json({ code: 'FINALIZE_CONFLICT' }, 409);
  return json({ shareUrl: capabilityUrl(request, capability) });
}
