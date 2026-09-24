import { createIndexedDbKeyValueArea, type KeyValueArea } from '../offscreen/storage/indexedDbKeyValueArea';
import type {
  DriveOriginCleanupClaim,
  DriveOriginCleanupDescriptor,
  DriveOriginPreparer,
} from './DriveOriginPreparer';

const SHARE_ORIGIN_CLEANUP_PREFIX = 'shareOriginCleanup:';

export type ShareOriginCleanupAction = 'revoke' | 'delete';
export type ShareOriginCleanupStage = 'server-action' | 'drive-cleanup';

export type ShareOriginCleanupJob = {
  shareId: string;
  action: ShareOriginCleanupAction;
  stage: ShareOriginCleanupStage;
  origins: DriveOriginCleanupDescriptor[];
  updatedAt: number;
};

export interface ShareOriginCleanupStorageArea extends KeyValueArea {}

export class ShareOriginCleanupStore {
  constructor(private readonly area: ShareOriginCleanupStorageArea) {}

  async put(job: ShareOriginCleanupJob): Promise<void> {
    await this.area.set({ [SHARE_ORIGIN_CLEANUP_PREFIX + job.shareId]: structuredClone(job) });
  }

  async get(shareId: string): Promise<ShareOriginCleanupJob | undefined> {
    return (await this.list()).find((job) => job.shareId === shareId);
  }

  async remove(shareId: string): Promise<void> {
    await this.area.remove(SHARE_ORIGIN_CLEANUP_PREFIX + shareId);
  }

  async list(): Promise<ShareOriginCleanupJob[]> {
    const all = await this.area.getAll();
    return Object.entries(all)
      .filter(([key]) => key.startsWith(SHARE_ORIGIN_CLEANUP_PREFIX))
      .map(([, value]) => value)
      .filter(isCleanupJob)
      .map((job) => structuredClone(job));
  }
}

export interface ShareOriginCleanupApi {
  getShareDriveOrigins(shareId: string): Promise<DriveOriginCleanupDescriptor[]>;
  revokeShare(shareId: string): Promise<void>;
  deleteShare(shareId: string): Promise<void>;
  claimDriveOriginCleanup(
    shareId: string,
    action: ShareOriginCleanupAction,
  ): Promise<{ claims: DriveOriginCleanupClaim[]; pending: boolean }>;
  completeDriveOriginCleanup(claim: DriveOriginCleanupClaim): Promise<void>;
}

export type ShareOriginCleanupCoordinatorDeps = {
  api: ShareOriginCleanupApi;
  origins: Pick<DriveOriginPreparer, 'cleanupClaim'>;
  store: ShareOriginCleanupStore;
  now?: () => number;
};

/** Crash-safe owner cleanup for shares whose local publication state may be absent. */
export class ShareOriginCleanupCoordinator {
  private readonly now: () => number;

  constructor(private readonly deps: ShareOriginCleanupCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  async run(
    shareId: string,
    action: ShareOriginCleanupAction,
    knownOrigins?: readonly DriveOriginCleanupDescriptor[],
  ): Promise<void> {
    let job = await this.deps.store.get(shareId);
    if (job) {
      if (job.action === 'delete' || job.action === action) {
        await this.resumeForUserAction(job);
        return;
      }
      // Deletion subsumes a pending revoke and also releases the publication pin.
      job = {
        ...job,
        action: 'delete',
        stage: 'server-action',
        updatedAt: this.now(),
      };
      await this.deps.store.put(job);
      await this.resumeForUserAction(job);
      return;
    }

    const origins = knownOrigins
      ? structuredClone([...knownOrigins])
      : await this.deps.api.getShareDriveOrigins(shareId);
    job = {
      shareId,
      action,
      stage: 'server-action',
      origins,
      updatedAt: this.now(),
    };
    // Persist before the public action so a crash can only cause an idempotent
    // server replay, never Drive cleanup while a share might still be active.
    await this.deps.store.put(job);
    await this.resumeForUserAction(job);
  }

  async resumePending(): Promise<void> {
    for (const job of await this.deps.store.list()) {
      await this.resume(job).catch(() => {});
    }
  }

  private async resumeForUserAction(job: ShareOriginCleanupJob): Promise<void> {
    try {
      await this.resume(job);
    } catch (error) {
      // Once the server action has succeeded, public revoke/delete semantics are
      // complete. Drive cleanup stays durable and retries on the next startup.
      const persisted = await this.deps.store.get(job.shareId);
      if (persisted?.stage === 'drive-cleanup') return;
      throw error;
    }
  }

  private async resume(initial: ShareOriginCleanupJob): Promise<void> {
    let job = structuredClone(initial);
    if (job.stage === 'server-action') {
      if (job.action === 'delete') await this.deps.api.deleteShare(job.shareId);
      else await this.deps.api.revokeShare(job.shareId);
      job = { ...job, stage: 'drive-cleanup', updatedAt: this.now() };
      await this.deps.store.put(job);
    }

    const cleanup = await this.deps.api.claimDriveOriginCleanup(job.shareId, job.action);
    for (const claim of cleanup.claims) {
      await this.deps.origins.cleanupClaim(claim);
      await this.deps.api.completeDriveOriginCleanup(claim);
    }
    if (cleanup.pending) throw new Error('Drive origin cleanup is already in progress');
    await this.deps.store.remove(job.shareId);
  }
}

function isCleanupJob(value: unknown): value is ShareOriginCleanupJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as ShareOriginCleanupJob;
  return typeof job.shareId === 'string'
    && (job.action === 'revoke' || job.action === 'delete')
    && (job.stage === 'server-action' || job.stage === 'drive-cleanup')
    && Array.isArray(job.origins)
    && job.origins.every(isCleanupDescriptor)
    && typeof job.updatedAt === 'number';
}

function isCleanupDescriptor(value: unknown): value is DriveOriginCleanupDescriptor {
  if (!value || typeof value !== 'object') return false;
  const origin = value as DriveOriginCleanupDescriptor;
  return typeof origin.fileId === 'string'
    && !!origin.fileId
    && typeof origin.revisionId === 'string'
    && !!origin.revisionId
    && (typeof origin.permissionId === 'undefined'
      || (typeof origin.permissionId === 'string' && !!origin.permissionId));
}

export const SHARE_ORIGIN_CLEANUP_DATABASE = 'published-share-origin-cleanup';

export function createShareOriginCleanupStore(): ShareOriginCleanupStore {
  return new ShareOriginCleanupStore(createIndexedDbKeyValueArea({
    databaseName: SHARE_ORIGIN_CLEANUP_DATABASE,
    storeName: 'jobs',
  }));
}
