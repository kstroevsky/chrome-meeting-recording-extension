import { deletePublishedShare } from '../shares/deleteShare';
import type { ShareRow } from '../shares/ShareRepository';

const MAX_CLEANUP_BATCH = 100;

export type CleanupResult = {
  deleted: number;
  failed: number;
};

function ttlSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 60 ? parsed : fallback;
}

export async function cleanupExpiredShares(env: Env, now = Date.now()): Promise<CleanupResult> {
  const staleBefore = now - ttlSeconds(env.STALE_DRAFT_TTL_SECONDS, 7 * 24 * 60 * 60) * 1000;
  const revokedBefore = now - ttlSeconds(env.REVOKED_RETENTION_SECONDS, 30 * 24 * 60 * 60) * 1000;
  const result = await env.SHARING_DB.prepare(
    `SELECT id, owner_id, status, manifest_json, capability_hash, capability_version, capability_key_id,
            created_at, updated_at, finalized_at, revoked_at
       FROM shares
      WHERE (status IN ('draft', 'uploading') AND updated_at < ?)
         OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at < ?)
      ORDER BY updated_at ASC
      LIMIT ?`,
  ).bind(staleBefore, revokedBefore, MAX_CLEANUP_BATCH).all<ShareRow>();

  let deleted = 0;
  let failed = 0;
  for (const share of result.results) {
    try {
      await deletePublishedShare(env, share);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }

  // Rate-limit rows have no product value after their window has long expired.
  await env.SHARING_DB.prepare(
    'DELETE FROM owner_rate_limits WHERE window_start < ?',
  ).bind(now - 24 * 60 * 60 * 1000).run();
  return { deleted, failed };
}
