import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { deriveCapability, shareUrl } from '../src/auth/capability';
import { cleanupExpiredMediaCache } from '../src/cache/mediaCache';
import { cleanupExpiredShares } from '../src/maintenance/cleanup';
import { PayloadTooLargeError, readJson } from '../src/http/responses';
import { enforceOwnerMutationRate, ensureNewShareQuota } from '../src/security/limits';
import type { ShareRow } from '../src/shares/ShareRepository';

beforeEach(async () => {
  await reset();
  const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(env.SHARING_DB, testEnv.TEST_D1_MIGRATIONS);
});

describe('sharing service hardening', () => {
  it('regenerates existing share URLs with the key id stored at finalization', async () => {
    const share = row({ capability_key_id: 'v1' });
    const request = new Request('https://sharing.test/api/shares/share-1');
    const first = await shareUrl(share, request, env);
    const rotated = overrideEnv({
      CAPABILITY_KEY_ID: 'v2',
      CAPABILITY_KEYS_JSON: JSON.stringify({
        v1: 'test-capability-v1-with-enough-entropy',
        v2: 'test-capability-v2-with-enough-entropy',
      }),
    });
    expect(await shareUrl(share, request, rotated)).toBe(first);

    const newCapability = await deriveCapability(
      share.id,
      share.capability_version,
      'test-capability-v2-with-enough-entropy',
    );
    expect(first).not.toContain(newCapability);
  });

  it('enforces the per-owner control-plane mutation limit', async () => {
    const limited = overrideEnv({ OWNER_MUTATION_RATE_PER_MINUTE: '2' });
    expect(await enforceOwnerMutationRate(limited, 'google:owner', 60_000)).toBeNull();
    expect(await enforceOwnerMutationRate(limited, 'google:owner', 60_001)).toBeNull();
    const denied = await enforceOwnerMutationRate(limited, 'google:owner', 60_002);
    expect(denied?.status).toBe(429);
    expect(await denied?.json()).toEqual({ code: 'OWNER_RATE_LIMITED' });
  });

  it('enforces owner share-count and reserved-byte quotas', async () => {
    await env.SHARING_DB.prepare(
      `INSERT INTO shares
         (id, owner_id, status, manifest_json, created_at, updated_at, capability_key_id)
       VALUES ('existing', 'google:owner', 'draft', '{}', 1, 1, 'v1')`,
    ).run();
    const countLimited = overrideEnv({ MAX_SHARES_PER_OWNER: '1' });
    const countDenied = await ensureNewShareQuota(countLimited, 'google:owner', 0);
    expect(countDenied?.status).toBe(409);
    expect(await countDenied?.json()).toEqual({ code: 'OWNER_SHARE_QUOTA_EXCEEDED' });

    const bytesLimited = overrideEnv({ MAX_SHARES_PER_OWNER: '10', MAX_OWNER_STORED_BYTES: '5' });
    const bytesDenied = await ensureNewShareQuota(bytesLimited, 'google:owner', 6);
    expect(bytesDenied?.status).toBe(413);
    expect(await bytesDenied?.json()).toEqual({ code: 'OWNER_STORAGE_QUOTA_EXCEEDED' });
  });

  it('rejects request bodies that exceed their configured bound', async () => {
    const request = new Request('https://sharing.test/api/shares/x', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-length': '10' },
      body: '{}',
    });
    await expect(readJson(request, 5)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('deletes stale drafts and expired revoked shares while retaining fresh state', async () => {
    const now = 2_000_000_000_000;
    const stale = now - 8 * 24 * 60 * 60 * 1000;
    const expiredRevoked = now - 31 * 24 * 60 * 60 * 1000;
    const fresh = now - 60_000;
    for (const [id, status, updatedAt, revokedAt] of [
      ['stale-draft', 'draft', stale, null],
      ['expired-revoked', 'revoked', expiredRevoked, expiredRevoked],
      ['fresh-revoked', 'revoked', fresh, fresh],
      ['active', 'active', stale, null],
    ] as const) {
      await env.SHARING_DB.prepare(
        `INSERT INTO shares
           (id, owner_id, status, manifest_json, created_at, updated_at, revoked_at, capability_key_id)
         VALUES (?, 'google:owner', ?, '{}', ?, ?, ?, 'v1')`,
      ).bind(id, status, updatedAt, updatedAt, revokedAt).run();
    }

    const result = await cleanupExpiredShares(env, now);
    expect(result).toEqual({ deleted: 2, failed: 0 });
    const remaining = await env.SHARING_DB.prepare('SELECT id FROM shares ORDER BY id').all<{ id: string }>();
    expect(remaining.results.map((item) => item.id)).toEqual(['active', 'fresh-revoked']);
  });

  it.each([101, 500, 1_000])(
    'cleans %i expired media cache rows without exceeding D1 parameter limits',
    async (count) => {
      const now = 2_000_000;
      await seedMediaAsset();
      for (let offset = 0; offset < count; offset += 100) {
        const statements = Array.from(
          { length: Math.min(100, count - offset) },
          (_, index) => {
            const position = offset + index;
            return env.SHARING_DB.prepare(
              `INSERT INTO media_cache_entries
                 (cache_key, asset_id, bytes, cached_at, expires_at)
               VALUES (?, 'asset-1', 1, ?, ?)`,
            ).bind(`expired-${position}`, now - 10_000, now - 1);
          },
        );
        await env.SHARING_DB.batch(statements);
      }
      await env.SHARING_DB.prepare(
        'UPDATE media_cache_budget SET live_bytes = ? WHERE singleton = 1',
      ).bind(count).run();

      expect(await cleanupExpiredMediaCache(env, now)).toEqual({ deleted: count, bytes: count });
      const remaining = await env.SHARING_DB.prepare(
        'SELECT COUNT(*) AS count FROM media_cache_entries',
      ).first<{ count: number }>();
      const budget = await env.SHARING_DB.prepare(
        'SELECT live_bytes FROM media_cache_budget WHERE singleton = 1',
      ).first<{ live_bytes: number }>();
      expect(remaining?.count).toBe(0);
      expect(budget?.live_bytes).toBe(0);
    },
  );
});

function overrideEnv(values: Record<string, string>): Env {
  return Object.assign(Object.create(env), values) as Env;
}

function row(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 'share-1',
    owner_id: 'google:owner',
    status: 'active',
    manifest_json: '{}',
    capability_hash: null,
    capability_version: 1,
    capability_key_id: 'v1',
    created_at: 1,
    updated_at: 1,
    finalized_at: 1,
    revoked_at: null,
    ...overrides,
  };
}

async function seedMediaAsset(): Promise<void> {
  await env.SHARING_DB.batch([
    env.SHARING_DB.prepare(
      `INSERT INTO shares
         (id, owner_id, status, manifest_json, created_at, updated_at, capability_key_id)
       VALUES ('share-cache', 'google:owner', 'active', '{}', 1, 1, 'v1')`,
    ),
    env.SHARING_DB.prepare(
      `INSERT INTO share_tracks
         (share_id, recording_id, track_id, mime_type, bytes, object_key, status)
       VALUES ('share-cache', 'recording-1', 'track-1', 'video/webm', 1, 'unused', 'complete')`,
    ),
    env.SHARING_DB.prepare(
      `INSERT INTO media_assets
         (id, share_id, recording_id, track_id, drive_file_id, revision_id, bytes, mime_type,
          created_at, updated_at)
       VALUES (
         'asset-1', 'share-cache', 'recording-1', 'track-1',
         'drive-file', 'revision-1', 1, 'video/webm', 1, 1
       )`,
    ),
  ]);
}
