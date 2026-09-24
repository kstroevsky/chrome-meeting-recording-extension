const DRIVE_CLEANUP_LEASE_MS = 10 * 60 * 1000;
const OWNER_PENDING_CLEANUP_HOLDER_ID = 'owner-pending';
const OWNER_PENDING_CLEANUP_BATCH = 20;

export type DriveCleanupAction = 'revoke' | 'delete';
export type DriveCleanupKind = 'permission' | 'revision';

type MediaAssetCleanupRow = {
  drive_file_id: string;
  revision_id: string;
  permission_id: string | null;
};

type CleanupCandidateRow = {
  id: string;
  owner_id: string;
  share_id: string;
  action: DriveCleanupAction;
  kind: DriveCleanupKind;
  drive_file_id: string;
  revision_id: string;
  permission_id: string | null;
};

type CleanupLeaseRow = {
  id: string;
  candidate_id: string;
  holder_owner_id: string;
  holder_id: string;
  kind: DriveCleanupKind;
  drive_file_id: string;
  revision_id: string;
  permission_id: string | null;
  lease_token: string;
  expires_at: number;
};

export type DriveCleanupClaim = {
  candidateId: string;
  leaseId: string;
  leaseToken: string;
  kind: DriveCleanupKind;
  fileId: string;
  revisionId: string;
  permissionId?: string;
};

export async function enqueueDriveCleanupCandidates(
  env: Env,
  ownerId: string,
  shareId: string,
  action: DriveCleanupAction,
): Promise<void> {
  const assets = await env.SHARING_DB.prepare(
    `SELECT drive_file_id, revision_id, permission_id
       FROM media_assets
      WHERE share_id = ?`,
  ).bind(shareId).all<MediaAssetCleanupRow>();
  if (!assets.results.length) return;

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  const permissionKeys = new Set<string>();
  const revisionKeys = new Set<string>();
  for (const asset of assets.results) {
    if (asset.permission_id && !permissionKeys.has(asset.drive_file_id)) {
      permissionKeys.add(asset.drive_file_id);
      statements.push(env.SHARING_DB.prepare(
        `INSERT OR IGNORE INTO drive_cleanup_candidates
           (id, owner_id, share_id, action, kind, drive_file_id, revision_id, permission_id, created_at)
         VALUES (?, ?, ?, ?, 'permission', ?, '', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        ownerId,
        shareId,
        action,
        asset.drive_file_id,
        asset.permission_id,
        now,
      ));
    }

    if (action === 'delete') {
      const revisionKey = `${asset.drive_file_id}\u0000${asset.revision_id}`;
      if (!revisionKeys.has(revisionKey)) {
        revisionKeys.add(revisionKey);
        statements.push(env.SHARING_DB.prepare(
          `INSERT OR IGNORE INTO drive_cleanup_candidates
             (id, owner_id, share_id, action, kind, drive_file_id, revision_id, permission_id, created_at)
           VALUES (?, ?, ?, ?, 'revision', ?, ?, NULL, ?)`,
        ).bind(
          crypto.randomUUID(),
          ownerId,
          shareId,
          action,
          asset.drive_file_id,
          asset.revision_id,
          now,
        ));
      }
    }
  }
  if (statements.length) await env.SHARING_DB.batch(statements);
}

export async function claimDriveCleanup(
  env: Env,
  ownerId: string,
  shareId: string,
  action: DriveCleanupAction,
  now = Date.now(),
): Promise<{ claims: DriveCleanupClaim[]; pending: boolean }> {
  const candidates = await env.SHARING_DB.prepare(
    `SELECT id, owner_id, share_id, action, kind, drive_file_id, revision_id, permission_id
       FROM drive_cleanup_candidates
      WHERE owner_id = ? AND share_id = ? AND action = ?
      ORDER BY kind ASC, drive_file_id ASC, revision_id ASC`,
  ).bind(ownerId, shareId, action).all<CleanupCandidateRow>();

  return claimCleanupCandidates(env, ownerId, `${shareId}:${action}`, candidates.results, now);
}

export async function claimPendingDriveCleanup(
  env: Env,
  ownerId: string,
  now = Date.now(),
): Promise<{ claims: DriveCleanupClaim[]; pending: boolean }> {
  const candidates = await env.SHARING_DB.prepare(
    `SELECT id, owner_id, share_id, action, kind, drive_file_id, revision_id, permission_id
       FROM drive_cleanup_candidates
      WHERE owner_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
  ).bind(ownerId, OWNER_PENDING_CLEANUP_BATCH + 1).all<CleanupCandidateRow>();

  return claimCleanupCandidates(
    env,
    ownerId,
    OWNER_PENDING_CLEANUP_HOLDER_ID,
    candidates.results.slice(0, OWNER_PENDING_CLEANUP_BATCH),
    now,
    candidates.results.length > OWNER_PENDING_CLEANUP_BATCH,
  );
}

async function claimCleanupCandidates(
  env: Env,
  ownerId: string,
  holderId: string,
  candidates: CleanupCandidateRow[],
  now: number,
  initialPending = false,
): Promise<{ claims: DriveCleanupClaim[]; pending: boolean }> {

  const claims: DriveCleanupClaim[] = [];
  const claimedResources = new Set<string>();
  let pending = initialPending;
  for (const candidate of candidates) {
    if (await hasLiveReference(env.SHARING_DB, candidate)) {
      await env.SHARING_DB.prepare('DELETE FROM drive_cleanup_candidates WHERE id = ?')
        .bind(candidate.id).run();
      continue;
    }

    const resourceKey = `${candidate.kind}\u0000${candidate.drive_file_id}\u0000${candidate.revision_id}`;
    if (claimedResources.has(resourceKey)) {
      pending = true;
      continue;
    }
    claimedResources.add(resourceKey);

    const proposedLeaseId = crypto.randomUUID();
    const proposedToken = crypto.randomUUID();
    const expiresAt = now + DRIVE_CLEANUP_LEASE_MS;
    await env.SHARING_DB.prepare(
      `INSERT INTO drive_cleanup_leases
         (id, candidate_id, holder_owner_id, holder_id, kind, drive_file_id, revision_id,
          permission_id, lease_token, expires_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1
           FROM media_assets AS a
           JOIN shares AS s ON s.id = a.share_id
          WHERE s.status IN ('draft', 'uploading', 'active')
            AND a.drive_file_id = ?
            AND (? = 'permission' OR a.revision_id = ?)
       )
       ON CONFLICT(kind, drive_file_id, revision_id) DO UPDATE SET
         id = CASE
           WHEN drive_cleanup_leases.expires_at <= ? THEN excluded.id
           ELSE drive_cleanup_leases.id
         END,
         candidate_id = CASE
           WHEN drive_cleanup_leases.expires_at <= ? THEN excluded.candidate_id
           ELSE drive_cleanup_leases.candidate_id
         END,
         holder_owner_id = CASE
           WHEN drive_cleanup_leases.expires_at <= ? THEN excluded.holder_owner_id
           ELSE drive_cleanup_leases.holder_owner_id
         END,
         holder_id = CASE
           WHEN drive_cleanup_leases.expires_at <= ? THEN excluded.holder_id
           ELSE drive_cleanup_leases.holder_id
         END,
         permission_id = CASE
           WHEN drive_cleanup_leases.expires_at <= ? THEN excluded.permission_id
           ELSE drive_cleanup_leases.permission_id
         END,
         lease_token = CASE
           WHEN drive_cleanup_leases.expires_at <= ? THEN excluded.lease_token
           ELSE drive_cleanup_leases.lease_token
         END,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       WHERE drive_cleanup_leases.expires_at <= ?
          OR (drive_cleanup_leases.holder_owner_id = excluded.holder_owner_id
              AND drive_cleanup_leases.holder_id = excluded.holder_id)`,
    ).bind(
      proposedLeaseId,
      candidate.id,
      ownerId,
      holderId,
      candidate.kind,
      candidate.drive_file_id,
      candidate.revision_id,
      candidate.permission_id,
      proposedToken,
      expiresAt,
      now,
      now,
      candidate.drive_file_id,
      candidate.kind,
      candidate.revision_id,
      now,
      now,
      now,
      now,
      now,
      now,
      now,
    ).run();

    const lease = await env.SHARING_DB.prepare(
      `SELECT id, candidate_id, holder_owner_id, holder_id, kind, drive_file_id, revision_id,
              permission_id, lease_token, expires_at
         FROM drive_cleanup_leases
        WHERE kind = ? AND drive_file_id = ? AND revision_id = ?`,
    ).bind(candidate.kind, candidate.drive_file_id, candidate.revision_id).first<CleanupLeaseRow>();

    if (!lease || lease.expires_at <= now
      || lease.holder_owner_id !== ownerId || lease.holder_id !== holderId) {
      pending = true;
      continue;
    }
    claims.push({
      candidateId: candidate.id,
      leaseId: lease.id,
      leaseToken: lease.lease_token,
      kind: candidate.kind,
      fileId: candidate.drive_file_id,
      revisionId: candidate.revision_id,
      ...(lease.permission_id ? { permissionId: lease.permission_id } : {}),
    });
  }
  return { claims, pending };
}

export async function completeDriveCleanupClaim(
  env: Env,
  ownerId: string,
  candidateId: string,
  leaseId: string,
  leaseToken: string,
): Promise<boolean> {
  const result = await env.SHARING_DB.batch([
    env.SHARING_DB.prepare(
      `DELETE FROM drive_cleanup_leases
        WHERE id = ? AND candidate_id = ? AND holder_owner_id = ? AND lease_token = ?`,
    ).bind(leaseId, candidateId, ownerId, leaseToken),
    env.SHARING_DB.prepare(
      `DELETE FROM drive_cleanup_candidates
        WHERE id = ? AND owner_id = ?
          AND NOT EXISTS (SELECT 1 FROM drive_cleanup_leases WHERE candidate_id = ?)`,
    ).bind(candidateId, ownerId, candidateId),
  ]);
  return Boolean(result[0]?.meta.changes);
}

export function originRegistrationLeaseGuardSql(): string {
  return `NOT EXISTS (
    SELECT 1
      FROM drive_cleanup_leases AS l
     WHERE l.expires_at > ?
       AND l.drive_file_id = ?
       AND (l.kind = 'permission' OR (l.kind = 'revision' AND l.revision_id = ?))
  )`;
}

async function hasLiveReference(db: D1Database, candidate: CleanupCandidateRow): Promise<boolean> {
  const revisionClause = candidate.kind === 'revision' ? 'AND a.revision_id = ?' : '';
  const bindings = candidate.kind === 'revision'
    ? [candidate.drive_file_id, candidate.revision_id]
    : [candidate.drive_file_id];
  const row = await db.prepare(
    `SELECT 1 AS present
       FROM media_assets AS a
       JOIN shares AS s ON s.id = a.share_id
      WHERE s.status IN ('draft', 'uploading', 'active')
        AND a.drive_file_id = ?
        ${revisionClause}
      LIMIT 1`,
  ).bind(...bindings).first<{ present: number }>();
  return row != null;
}
