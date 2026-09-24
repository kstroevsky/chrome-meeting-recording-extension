import { capabilityUrl, deriveCapability, shareUrl } from '../auth/capability';
import { activeCapabilityKey } from '../auth/capabilityKeys';
import { base64UrlDecode, base64UrlEncode, sha256Base64Url } from '../auth/crypto';
import { driveReaderEmail, getDriveRevisionMetadata } from '../drive/DriveClient';
import { json, readJson } from '../http/responses';
import { ensureNewShareQuota } from '../security/limits';
import { SHARING_CONTRACT_LIMITS } from '../../../src/shared/sharingContract';
import { canonicalizeManifest, canonicalizeStoredManifest } from './manifestSchema';
import { deletePublishedShare } from './deleteShare';
import {
  getOwnedShare,
  getShare,
  mediaObjectKey,
  type ShareRow,
  type ShareSummaryRow,
  type TrackRow,
  type MediaAssetRow,
} from './ShareRepository';

const DEFAULT_SHARE_LIST_LIMIT = 50;
const MAX_SHARE_LIST_LIMIT = 100;
const shareListCursorEncoder = new TextEncoder();
const shareListCursorDecoder = new TextDecoder();

type ShareListCursor = Pick<ShareSummaryRow, 'created_at' | 'id'>;

export async function routeShareOwnerRequest(
  request: Request,
  env: Env,
  url: URL,
  ownerId: string,
): Promise<Response | null> {
  if (url.pathname === '/api/sharing-reader' && request.method === 'GET') {
    return json({ email: driveReaderEmail(env) }, 200, { 'cache-control': 'no-store' });
  }

  if (url.pathname === '/api/shares' && request.method === 'GET') {
    return listShares(request, env, ownerId);
  }

  const shareMatch = /^\/api\/shares\/([^/]+)$/.exec(url.pathname);
  if (shareMatch) {
    const shareId = decodeURIComponent(shareMatch[1]);
    if (request.method === 'PUT') return putShare(shareId, request, env, ownerId);
    if (request.method === 'GET') return getShareResponse(shareId, request, env, ownerId);
    if (request.method === 'DELETE') return deleteShare(shareId, env, ownerId);
  }

  const revokeMatch = /^\/api\/shares\/([^/]+)\/revoke$/.exec(url.pathname);
  if (revokeMatch && request.method === 'POST') {
    return revokeShare(decodeURIComponent(revokeMatch[1]), env, ownerId);
  }

  const originsMatch = /^\/api\/shares\/([^/]+)\/origins$/.exec(url.pathname);
  if (originsMatch && request.method === 'GET') {
    return getDriveOrigins(decodeURIComponent(originsMatch[1]), env, ownerId);
  }

  const originMatch = /^\/api\/shares\/([^/]+)\/recordings\/([^/]+)\/tracks\/([^/]+)\/origin$/.exec(url.pathname);
  if (originMatch && request.method === 'PUT') {
    return putDriveOrigin(
      decodeURIComponent(originMatch[1]),
      decodeURIComponent(originMatch[2]),
      decodeURIComponent(originMatch[3]),
      request,
      env,
      ownerId,
    );
  }

  const finalizeMatch = /^\/api\/shares\/([^/]+)\/finalize$/.exec(url.pathname);
  if (finalizeMatch && request.method === 'POST') {
    return finalizeShare(decodeURIComponent(finalizeMatch[1]), request, env, ownerId);
  }

  return null;
}

type DriveOriginBody = {
  fileId: string;
  revisionId: string;
  bytes: number;
  mimeType: string;
  md5Checksum?: string;
  permissionId?: string;
};

async function putDriveOrigin(
  shareId: string,
  recordingId: string,
  trackId: string,
  request: Request,
  env: Env,
  ownerId: string,
): Promise<Response> {
  const share = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  if (share.status === 'revoked') return json({ code: 'SHARE_REVOKED' }, 410);

  const body = parseDriveOriginBody(await readJson(request, 8 * 1024));
  if (!body) return json({ code: 'INVALID_DRIVE_ORIGIN' }, 400);

  const track = await env.SHARING_DB.prepare(
    `SELECT share_id, recording_id, track_id, mime_type, bytes, object_key, media_asset_id, status
       FROM share_tracks
      WHERE share_id = ? AND recording_id = ? AND track_id = ?`,
  ).bind(shareId, recordingId, trackId).first<TrackRow>();
  if (!track) return json({ code: 'TRACK_NOT_FOUND' }, 404);
  if (track.mime_type !== body.mimeType || (track.bytes != null && track.bytes !== body.bytes)) {
    return json({ code: 'DRIVE_ORIGIN_TRACK_MISMATCH' }, 409);
  }

  const existing = await env.SHARING_DB.prepare(
    `SELECT id, share_id, recording_id, track_id, drive_file_id, revision_id, bytes, mime_type,
            md5_checksum, permission_id, created_at, updated_at
       FROM media_assets
      WHERE share_id = ? AND recording_id = ? AND track_id = ?`,
  ).bind(shareId, recordingId, trackId).first<MediaAssetRow>();
  if (existing) {
    return sameDriveOrigin(existing, body)
      ? new Response(null, { status: 200 })
      : json({ code: 'DRIVE_ORIGIN_CONFLICT' }, 409);
  }
  if (share.status === 'active') return json({ code: 'SHARE_ALREADY_ACTIVE' }, 409);

  let revision;
  try {
    revision = await getDriveRevisionMetadata(env, body.fileId, body.revisionId);
  } catch (error) {
    const status = errorStatus(error);
    if (status === 403 || status === 404) {
      return json({ code: 'DRIVE_ORIGIN_UNREADABLE' }, 409);
    }
    throw error;
  }
  if (!revision.keepForever
    || revision.size !== body.bytes
    || revision.mimeType !== body.mimeType
    || (body.md5Checksum != null && revision.md5Checksum !== body.md5Checksum)) {
    return json({ code: 'DRIVE_ORIGIN_VERIFICATION_FAILED' }, 409);
  }

  const assetId = crypto.randomUUID();
  const now = Date.now();
  await env.SHARING_DB.batch([
    env.SHARING_DB.prepare(
      `INSERT INTO media_assets
         (id, share_id, recording_id, track_id, drive_file_id, revision_id, bytes, mime_type,
          md5_checksum, permission_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      assetId,
      shareId,
      recordingId,
      trackId,
      body.fileId,
      body.revisionId,
      body.bytes,
      body.mimeType,
      body.md5Checksum ?? null,
      body.permissionId ?? null,
      now,
      now,
    ),
    env.SHARING_DB.prepare(
      `UPDATE share_tracks
          SET media_asset_id = ?, bytes = ?, status = 'complete'
        WHERE share_id = ? AND recording_id = ? AND track_id = ?`,
    ).bind(assetId, body.bytes, shareId, recordingId, trackId),
    env.SHARING_DB.prepare(
      `UPDATE shares
          SET status = CASE WHEN status = 'draft' THEN 'uploading' ELSE status END,
              updated_at = ?
        WHERE id = ?`,
    ).bind(now, shareId),
  ]);
  return new Response(null, { status: 201 });
}

function parseDriveOriginBody(value: unknown): DriveOriginBody | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.fileId !== 'string' || !body.fileId || body.fileId.length > 1024
    || typeof body.revisionId !== 'string' || !body.revisionId || body.revisionId.length > 1024
    || !Number.isSafeInteger(body.bytes) || Number(body.bytes) < 0
    || typeof body.mimeType !== 'string' || !body.mimeType || body.mimeType.length > 255
    || (body.md5Checksum != null && (typeof body.md5Checksum !== 'string' || body.md5Checksum.length > 128))
    || (body.permissionId != null && (typeof body.permissionId !== 'string' || body.permissionId.length > 1024))) {
    return null;
  }
  return {
    fileId: body.fileId,
    revisionId: body.revisionId,
    bytes: Number(body.bytes),
    mimeType: body.mimeType,
    ...(typeof body.md5Checksum === 'string' ? { md5Checksum: body.md5Checksum } : {}),
    ...(typeof body.permissionId === 'string' ? { permissionId: body.permissionId } : {}),
  };
}

function sameDriveOrigin(existing: MediaAssetRow, body: DriveOriginBody): boolean {
  return existing.drive_file_id === body.fileId
    && existing.revision_id === body.revisionId
    && existing.bytes === body.bytes
    && existing.mime_type === body.mimeType
    && (existing.md5_checksum ?? undefined) === body.md5Checksum
    && (existing.permission_id ?? undefined) === body.permissionId;
}

function errorStatus(error: unknown): number | undefined {
  return error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined;
}

async function getDriveOrigins(shareId: string, env: Env, ownerId: string): Promise<Response> {
  const share = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  const assets = await env.SHARING_DB.prepare(
    `SELECT id, share_id, recording_id, track_id, drive_file_id, revision_id, bytes, mime_type,
            md5_checksum, permission_id, created_at, updated_at
       FROM media_assets
      WHERE share_id = ?
      ORDER BY recording_id ASC, track_id ASC`,
  ).bind(shareId).all<MediaAssetRow>();
  return json({
    origins: assets.results.map((asset) => ({
      fileId: asset.drive_file_id,
      revisionId: asset.revision_id,
      ...(asset.permission_id ? { permissionId: asset.permission_id } : {}),
    })),
  }, 200, { 'cache-control': 'no-store' });
}

async function putShare(shareId: string, request: Request, env: Env, ownerId: string): Promise<Response> {
  const body = await readJson(request, SHARING_CONTRACT_LIMITS.manifestRequestBytes);
  const manifest = canonicalizeManifest(body, shareId);
  if (!manifest) return json({ code: 'INVALID_MANIFEST' }, 400);

  const manifestJson = JSON.stringify(manifest);
  if (new TextEncoder().encode(manifestJson).byteLength > SHARING_CONTRACT_LIMITS.manifestBytes) {
    return json({ code: 'MANIFEST_TOO_LARGE' }, 413);
  }
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

  const reservedBytes = manifest.recordings.reduce(
    (recordingTotal, recording) => recordingTotal
      + recording.tracks.reduce((trackTotal, track) => trackTotal + (track.bytes ?? 0), 0),
    0,
  );
  const allTrackBytesKnown = manifest.recordings.every((recording) =>
    recording.tracks.every((track) => track.bytes != null));
  const recordingTitlesJson = JSON.stringify(manifest.recordings.map((recording) => recording.title));
  const trackCount = manifest.recordings.reduce((total, recording) => total + recording.tracks.length, 0);
  const quota = await ensureNewShareQuota(env, ownerId, reservedBytes);
  if (quota) return quota;

  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.SHARING_DB.prepare(
      `INSERT INTO shares
         (id, owner_id, status, manifest_json, recording_titles_json, recording_count,
          track_count, total_bytes, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      shareId,
      ownerId,
      manifestJson,
      recordingTitlesJson,
      manifest.recordings.length,
      trackCount,
      allTrackBytesKnown ? reservedBytes : null,
      now,
      now,
    ),
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
  const url = new URL(request.url);
  const limit = boundedPositiveInteger(url.searchParams.get('limit'), DEFAULT_SHARE_LIST_LIMIT, MAX_SHARE_LIST_LIMIT);
  const encodedCursor = url.searchParams.get('cursor');
  const cursor = encodedCursor == null ? null : decodeShareListCursor(encodedCursor);
  if (encodedCursor != null && cursor == null) return json({ code: 'INVALID_CURSOR' }, 400);

  const baseQuery = `SELECT id, status, capability_version, capability_key_id,
                            recording_titles_json, recording_count, track_count, total_bytes,
                            created_at, updated_at, finalized_at, revoked_at
                       FROM shares
                      WHERE owner_id = ?`;
  const result = cursor == null
    ? await env.SHARING_DB.prepare(
      `${baseQuery}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).bind(ownerId, limit).all<ShareSummaryRow>()
    : await env.SHARING_DB.prepare(
      `${baseQuery}
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).bind(ownerId, cursor.created_at, cursor.created_at, cursor.id, limit).all<ShareSummaryRow>();

  const shares = await Promise.all(result.results.map((share) => ownerShareSummary(share, request, env)));
  const lastShare = result.results.at(-1);
  return json({
    shares,
    ...(result.results.length === limit && lastShare ? { nextCursor: encodeShareListCursor(lastShare) } : {}),
  });
}

async function getShareResponse(shareId: string, request: Request, env: Env, ownerId: string): Promise<Response> {
  const share = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
  if (!share) return json({ code: 'SHARE_NOT_FOUND' }, 404);
  return json(await ownerShareView(share, request, env));
}

async function ownerShareView(share: ShareRow, request: Request, env: Env): Promise<Record<string, unknown>> {
  return {
    ...(await ownerShareSummaryFromDetail(share, request, env)),
    manifest: JSON.parse(share.manifest_json),
  };
}

async function ownerShareSummary(
  share: ShareSummaryRow,
  request: Request,
  env: Env,
): Promise<Record<string, unknown>> {
  return {
    id: share.id,
    status: share.status,
    recordingTitles: parseRecordingTitles(share.recording_titles_json),
    recordingCount: share.recording_count,
    trackCount: share.track_count,
    ...(share.total_bytes != null ? { totalBytes: share.total_bytes } : {}),
    createdAt: share.created_at,
    updatedAt: share.updated_at,
    ...(share.finalized_at != null ? { finalizedAt: share.finalized_at } : {}),
    ...(share.revoked_at != null ? { revokedAt: share.revoked_at } : {}),
    ...(share.status === 'active' ? { shareUrl: await shareUrl(share, request, env) } : {}),
  };
}

async function ownerShareSummaryFromDetail(
  share: ShareRow,
  request: Request,
  env: Env,
): Promise<Record<string, unknown>> {
  const manifest = canonicalizeStoredManifest(share.manifest_json, share.id);
  const recordings = manifest?.recordings ?? [];
  const trackCount = recordings.reduce((total, recording) => total + recording.tracks.length, 0);
  const bytes = recordings.flatMap((recording) => recording.tracks).map((track) => track.bytes);
  return {
    id: share.id,
    status: share.status,
    recordingTitles: recordings.map((recording) => recording.title),
    recordingCount: recordings.length,
    trackCount,
    ...(bytes.every((value) => value != null) ? {
      totalBytes: bytes.reduce((total, value) => total + (value ?? 0), 0),
    } : {}),
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

async function deleteShare(shareId: string, env: Env, ownerId: string): Promise<Response> {
  let share = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
  if (!share) return new Response(null, { status: 204 });
  if (share.status !== 'revoked') {
    await revokeShare(shareId, env, ownerId);
    share = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
    if (!share) return new Response(null, { status: 204 });
  }
  await deletePublishedShare(env, share);
  return new Response(null, { status: 204 });
}

function parseRecordingTitles(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((title): title is string => typeof title === 'string') : [];
  } catch {
    return [];
  }
}

function boundedPositiveInteger(value: string | null, fallback: number, maximum: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function encodeShareListCursor(share: ShareListCursor): string {
  return base64UrlEncode(shareListCursorEncoder.encode(JSON.stringify([share.created_at, share.id])));
}

function decodeShareListCursor(value: string): ShareListCursor | null {
  try {
    const parsed = JSON.parse(shareListCursorDecoder.decode(base64UrlDecode(value))) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (!Number.isSafeInteger(createdAt) || typeof id !== 'string' || !id) return null;
    return { created_at: createdAt, id };
  } catch {
    return null;
  }
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

  const key = activeCapabilityKey(env);
  const capability = await deriveCapability(share.id, share.capability_version, key.secret);
  const capabilityHash = await sha256Base64Url(capability);
  const now = Date.now();
  await env.SHARING_DB.prepare(
    `UPDATE shares
        SET status = 'active', capability_hash = ?, capability_key_id = ?,
            finalized_at = COALESCE(finalized_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('draft', 'uploading')`,
  ).bind(capabilityHash, key.id, now, now, share.id).run();

  const active = await getOwnedShare(env.SHARING_DB, shareId, ownerId);
  if (!active || active.status !== 'active') return json({ code: 'FINALIZE_CONFLICT' }, 409);
  return json({ shareUrl: capabilityUrl(request, capability) });
}
