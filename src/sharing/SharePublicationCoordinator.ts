/**
 * @file sharing/SharePublicationCoordinator.ts
 *
 * Drives the durable share lifecycle. Every phase transition is persisted only
 * after its remote/local side effect succeeds, so a crash replays an idempotent
 * operation with the same share/recording/track ids.
 */

import type { PublishedPlaybackManifest } from '../shared/sharing';
import type { PublishedRecordingPlan } from './PublishedManifestBuilder';
import {
  SharePublicationStore,
  type SharePublication,
  type SharePublicationPhase,
} from './SharePublicationStore';
import type { ShareUploadManager } from './ShareUploadManager';

export interface SharePublicationApi {
  /** Idempotent PUT of the caller-owned share id and immutable snapshot. */
  createShare(manifest: PublishedPlaybackManifest): Promise<void>;
  /** Idempotent finalization. The returned viewer URL must not derive authority from shareId. */
  finalizeShare(shareId: string): Promise<{ shareUrl: string }>;
  /** Idempotent server-side revocation of the viewer capability. */
  revokeShare(shareId: string): Promise<void>;
}

export type SharePublicationCoordinatorDeps = {
  api: SharePublicationApi;
  uploads: Pick<ShareUploadManager, 'upload' | 'clearShare'>;
  store: SharePublicationStore;
  now?: () => number;
};

export type NewSharePublication = {
  manifest: PublishedPlaybackManifest;
  plans: readonly PublishedRecordingPlan[];
};

export class SharePublicationCoordinator {
  private readonly now: () => number;

  constructor(private readonly deps: SharePublicationCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Persists the complete snapshot before the first network request. */
  async queueNew(input: NewSharePublication): Promise<SharePublication> {
    const existing = await this.deps.store.get(input.manifest.id);
    if (existing) return existing;

    const now = this.now();
    const publication: SharePublication = {
      id: input.manifest.id,
      status: 'draft',
      manifest: structuredClone(input.manifest),
      plans: structuredClone([...input.plans]),
      sourceRecordingIds: input.plans.map((plan) => plan.sourceRecordingId),
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.put(publication);
    return publication;
  }

  /** Persists then drives the publication to its terminal state. */
  async publishNew(input: NewSharePublication): Promise<SharePublication> {
    return await this.resume(await this.queueNew(input));
  }

  /** Persists revoking before the DELETE so a crash can safely replay it. */
  async revoke(shareId: string): Promise<SharePublication> {
    const publication = await this.deps.store.get(shareId);
    if (!publication) throw new Error(`Share ${shareId} is not published locally`);
    if (publication.status === 'revoked') return publication;
    if (publication.status === 'revoking'
      || (publication.status === 'failed' && publication.resumeFrom === 'revoking')) {
      return await this.resume(publication);
    }
    if (publication.status !== 'active') {
      throw new Error(`Share ${shareId} cannot be revoked while ${publication.status}`);
    }

    return await this.resume(await this.transition(publication, 'revoking'));
  }

  /** Resumes interrupted or failed publications without minting any new ids. */
  async resumePending(): Promise<SharePublication[]> {
    const publications = await this.deps.store.list();
    const outcomes: SharePublication[] = [];
    for (const publication of publications) {
      if (publication.status === 'revoked') continue;
      if (publication.status === 'active') {
        // A crash can occur after active was persisted but before temporary
        // upload jobs were cleared. Cleanup is safe and idempotent.
        await this.deps.uploads.clearShare(publication.id).catch(() => {});
        outcomes.push(publication);
        continue;
      }
      try {
        outcomes.push(await this.resume(publication));
      } catch {
        // One permanently unavailable recording must not prevent recovery of
        // unrelated publications. `resume()` already persisted failed state.
        outcomes.push((await this.deps.store.get(publication.id)) ?? publication);
      }
    }
    return outcomes;
  }

  async resume(publication: SharePublication): Promise<SharePublication> {
    let current = structuredClone(publication);
    let phase = current.status === 'failed' ? current.resumeFrom ?? 'draft' : current.status;
    if (!isResumablePhase(phase)) return current;

    try {
      if (phase === 'draft') {
        // The exact persisted public manifest is replayed. No private source
        // locator can reach this API boundary.
        await this.deps.api.createShare(structuredClone(current.manifest));
        current = await this.transition(current, 'uploading');
        phase = 'uploading';
      }

      if (phase === 'uploading') {
        await this.deps.uploads.upload(current.id, structuredClone(current.plans));
        current = await this.transition(current, 'finalizing');
        phase = 'finalizing';
      }

      if (phase === 'finalizing') {
        const { shareUrl } = await this.deps.api.finalizeShare(current.id);
        current = await this.transition(current, 'active', { shareUrl });
        // Active is persisted first. If cleanup is interrupted, resumePending()
        // will remove these temporary upload jobs on the next startup.
        await this.deps.uploads.clearShare(current.id).catch(() => {});
      }

      if (phase === 'revoking') {
        await this.deps.api.revokeShare(current.id);
        current = await this.transition(current, 'revoked');
        // Revoked is persisted first. Cleanup is local-only and idempotent.
        await this.deps.uploads.clearShare(current.id).catch(() => {});
      }
      return current;
    } catch (error) {
      const failed: SharePublication = {
        ...current,
        status: 'failed',
        resumeFrom: phase,
        error: describeError(error),
        updatedAt: this.now(),
      };
      await this.deps.store.put(failed);
      throw error;
    }
  }

  private async transition(
    publication: SharePublication,
    status: SharePublication['status'],
    extra: Pick<SharePublication, 'shareUrl'> | Record<string, never> = {},
  ): Promise<SharePublication> {
    const next: SharePublication = {
      ...publication,
      ...extra,
      status,
      resumeFrom: undefined,
      error: undefined,
      updatedAt: this.now(),
    };
    await this.deps.store.put(next);
    return next;
  }
}

function isResumablePhase(status: SharePublication['status']): status is SharePublicationPhase {
  return status === 'draft' || status === 'uploading' || status === 'finalizing' || status === 'revoking';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
