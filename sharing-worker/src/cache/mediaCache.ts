export const MEDIA_CACHE_MAX_BYTES = 8_000_000_000;
export const MEDIA_CACHE_TTL_MS = 30 * 60 * 60 * 1000;
export const MEDIA_CACHE_MAX_PUTS_PER_DAY = 15_000;
export const MAX_MEDIA_RESPONSE_BYTES = 8 * 1024 * 1024;

export type MediaCacheEntry = {
  cache_key: string;
  asset_id: string;
  bytes: number;
  cached_at: number;
  expires_at: number;
};

export function mediaCacheKey(
  assetId: string,
  revisionId: string,
  start: number,
  end: number,
): string {
  return `cache/v1/${encodeURIComponent(assetId)}/${encodeURIComponent(revisionId)}/${start}-${end}`;
}

/**
 * One D1 lookup followed by at most one R2 GetObject. Missing/expired cache
 * state simply falls through to Drive.
 */
export async function getCachedMedia(
  env: Env,
  cacheKey: string,
  now = Date.now(),
): Promise<R2ObjectBody | null> {
  const entry = await env.SHARING_DB.prepare(
    'SELECT cache_key, asset_id, bytes, cached_at, expires_at FROM media_cache_entries WHERE cache_key = ?',
  ).bind(cacheKey).first<MediaCacheEntry>();
  if (!entry || entry.expires_at <= now) return null;
  return await env.SHARING_MEDIA.get(cacheKey);
}

/**
 * Best-effort cache write guarded by both live-byte and daily-PUT budgets.
 * Cache failure never propagates to playback.
 */
export async function cacheMediaRange(
  env: Env,
  input: {
    cacheKey: string;
    assetId: string;
    body: ReadableStream;
    bytes: number;
    cachedAt?: number;
  },
): Promise<void> {
  const cachedAt = input.cachedAt ?? Date.now();
  const day = Math.floor(cachedAt / 86_400_000);
  await env.SHARING_DB.prepare(
    `UPDATE media_cache_budget
        SET day = ?, puts_today = 0
      WHERE singleton = 1 AND day != ?`,
  ).bind(day, day).run();

  const existing = await env.SHARING_DB.prepare(
    'SELECT cache_key, asset_id, bytes, cached_at, expires_at FROM media_cache_entries WHERE cache_key = ?',
  ).bind(input.cacheKey).first<MediaCacheEntry>();
  if (existing) {
    if (existing.expires_at > cachedAt) return;
    // The key identifies one immutable revision range, so a byte/asset mismatch
    // indicates inconsistent cache metadata. Falling through is safer than
    // changing the hard live-byte accounting for an unexpected row.
    if (existing.asset_id !== input.assetId || existing.bytes !== input.bytes) return;
    await refreshExpiredEntry(env, input, existing, cachedAt);
    return;
  }

  const reserved = await env.SHARING_DB.prepare(
    `UPDATE media_cache_budget
        SET live_bytes = live_bytes + ?, puts_today = puts_today + 1
      WHERE singleton = 1
        AND live_bytes + ? <= ?
        AND puts_today < ?`,
  ).bind(
    input.bytes,
    input.bytes,
    MEDIA_CACHE_MAX_BYTES,
    MEDIA_CACHE_MAX_PUTS_PER_DAY,
  ).run();
  if (!reserved.meta.changes) return;

  const expiresAt = cachedAt + MEDIA_CACHE_TTL_MS;
  try {
    await env.SHARING_DB.prepare(
      `INSERT INTO media_cache_entries (cache_key, asset_id, bytes, cached_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(input.cacheKey, input.assetId, input.bytes, cachedAt, expiresAt).run();
  } catch {
    await releaseBudget(env, input.bytes);
    return;
  }

  try {
    await env.SHARING_MEDIA.put(input.cacheKey, input.body, {
      customMetadata: {
        cachedAt: String(cachedAt),
        expiresAt: String(expiresAt),
      },
    });
  } catch {
    await env.SHARING_DB.prepare('DELETE FROM media_cache_entries WHERE cache_key = ?')
      .bind(input.cacheKey).run()
      .catch(() => {});
    await releaseBudget(env, input.bytes).catch(() => {});
  }
}

async function refreshExpiredEntry(
  env: Env,
  input: {
    cacheKey: string;
    assetId: string;
    body: ReadableStream;
    bytes: number;
  },
  existing: MediaCacheEntry,
  cachedAt: number,
): Promise<void> {
  // The stale object already occupies its live-byte allocation. Refreshing it
  // consumes one PUT but no additional storage budget.
  const reserved = await env.SHARING_DB.prepare(
    `UPDATE media_cache_budget
        SET puts_today = puts_today + 1
      WHERE singleton = 1
        AND puts_today < ?`,
  ).bind(MEDIA_CACHE_MAX_PUTS_PER_DAY).run();
  if (!reserved.meta.changes) return;

  const expiresAt = cachedAt + MEDIA_CACHE_TTL_MS;
  const claimed = await env.SHARING_DB.prepare(
    `UPDATE media_cache_entries
        SET cached_at = ?, expires_at = ?
      WHERE cache_key = ? AND expires_at <= ?`,
  ).bind(cachedAt, expiresAt, input.cacheKey, cachedAt).run();
  if (!claimed.meta.changes) return;

  try {
    await env.SHARING_MEDIA.put(input.cacheKey, input.body, {
      customMetadata: {
        cachedAt: String(cachedAt),
        expiresAt: String(expiresAt),
      },
    });
  } catch {
    // Keep the old object tracked as expired so the hourly cleanup can remove
    // it. The PUT budget remains conservatively consumed for this failed try.
    await env.SHARING_DB.prepare(
      `UPDATE media_cache_entries
          SET cached_at = ?, expires_at = ?
        WHERE cache_key = ? AND cached_at = ? AND expires_at = ?`,
    ).bind(
      existing.cached_at,
      existing.expires_at,
      input.cacheKey,
      cachedAt,
      expiresAt,
    ).run().catch(() => {});
  }
}

export async function cleanupExpiredMediaCache(
  env: Env,
  now = Date.now(),
  limit = 500,
): Promise<{ deleted: number; bytes: number }> {
  const entries = await env.SHARING_DB.prepare(
    `SELECT cache_key, asset_id, bytes, cached_at, expires_at
       FROM media_cache_entries
      WHERE expires_at <= ?
      ORDER BY expires_at ASC
      LIMIT ?`,
  ).bind(now, limit).all<MediaCacheEntry>();
  if (!entries.results.length) return { deleted: 0, bytes: 0 };
  const keys = entries.results.map((entry) => entry.cache_key);
  const bytes = entries.results.reduce((total, entry) => total + entry.bytes, 0);
  await env.SHARING_MEDIA.delete(keys);
  const placeholders = keys.map(() => '?').join(',');
  await env.SHARING_DB.prepare(`DELETE FROM media_cache_entries WHERE cache_key IN (${placeholders})`)
    .bind(...keys).run();
  await releaseBudget(env, bytes);
  return { deleted: keys.length, bytes };
}

export async function deleteAssetCache(env: Env, assetIds: readonly string[]): Promise<void> {
  if (!assetIds.length) return;
  const placeholders = assetIds.map(() => '?').join(',');
  const entries = await env.SHARING_DB.prepare(
    `SELECT cache_key, asset_id, bytes, cached_at, expires_at
       FROM media_cache_entries
      WHERE asset_id IN (${placeholders})`,
  ).bind(...assetIds).all<MediaCacheEntry>();
  if (!entries.results.length) return;
  await env.SHARING_MEDIA.delete(entries.results.map((entry) => entry.cache_key));
  await env.SHARING_DB.prepare(
    `DELETE FROM media_cache_entries WHERE asset_id IN (${placeholders})`,
  ).bind(...assetIds).run();
  await releaseBudget(env, entries.results.reduce((total, entry) => total + entry.bytes, 0));
}

async function releaseBudget(env: Env, bytes: number): Promise<void> {
  await env.SHARING_DB.prepare(
    `UPDATE media_cache_budget
        SET live_bytes = MAX(0, live_bytes - ?)
      WHERE singleton = 1`,
  ).bind(bytes).run();
}
