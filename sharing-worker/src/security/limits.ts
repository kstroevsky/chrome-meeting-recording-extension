import { json } from '../http/responses';

const RATE_WINDOW_MS = 60_000;

function positiveInteger(value: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function maxSharesPerOwner(env: Env): number {
  return positiveInteger(env.MAX_SHARES_PER_OWNER, 200, 10_000);
}

export function maxOwnerStoredBytes(env: Env): number {
  return positiveInteger(env.MAX_OWNER_STORED_BYTES, 500 * 1024 * 1024 * 1024);
}

export async function enforceOwnerMutationRate(env: Env, ownerId: string, now = Date.now()): Promise<Response | null> {
  const limit = positiveInteger(env.OWNER_MUTATION_RATE_PER_MINUTE, 120, 10_000);
  const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  await env.SHARING_DB.batch([
    env.SHARING_DB.prepare(
      `INSERT OR IGNORE INTO owner_rate_limits (owner_id, window_start, count) VALUES (?, ?, 0)`,
    ).bind(ownerId, windowStart),
    env.SHARING_DB.prepare(
      `UPDATE owner_rate_limits
          SET count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
              window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END
        WHERE owner_id = ?`,
    ).bind(windowStart, windowStart, windowStart, ownerId),
  ]);
  const row = await env.SHARING_DB.prepare(
    'SELECT count FROM owner_rate_limits WHERE owner_id = ?',
  ).bind(ownerId).first<{ count: number }>();
  if ((row?.count ?? 0) <= limit) return null;
  return json({ code: 'OWNER_RATE_LIMITED' }, 429, { 'retry-after': '60' });
}

export async function ownerStoredBytes(env: Env, ownerId: string): Promise<number> {
  const row = await env.SHARING_DB.prepare(
    `SELECT COALESCE(SUM(t.bytes), 0) AS bytes
       FROM share_tracks t JOIN shares s ON s.id = t.share_id
      WHERE s.owner_id = ?`,
  ).bind(ownerId).first<{ bytes: number }>();
  return Number(row?.bytes ?? 0);
}

export async function ensureNewShareQuota(
  env: Env,
  ownerId: string,
  reservedBytes: number,
): Promise<Response | null> {
  const count = await env.SHARING_DB.prepare(
    'SELECT COUNT(*) AS count FROM shares WHERE owner_id = ?',
  ).bind(ownerId).first<{ count: number }>();
  if ((count?.count ?? 0) >= maxSharesPerOwner(env)) {
    return json({ code: 'OWNER_SHARE_QUOTA_EXCEEDED' }, 409);
  }
  if ((await ownerStoredBytes(env, ownerId)) + reservedBytes > maxOwnerStoredBytes(env)) {
    return json({ code: 'OWNER_STORAGE_QUOTA_EXCEEDED' }, 413);
  }
  return null;
}

export async function ensureAdditionalStorageQuota(
  env: Env,
  ownerId: string,
  additionalBytes: number,
): Promise<Response | null> {
  if ((await ownerStoredBytes(env, ownerId)) + additionalBytes > maxOwnerStoredBytes(env)) {
    return json({ code: 'OWNER_STORAGE_QUOTA_EXCEEDED' }, 413);
  }
  return null;
}
