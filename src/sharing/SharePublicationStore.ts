/**
 * @file sharing/SharePublicationStore.ts
 *
 * Durable owner-side state for a whole published share. Unlike ShareUploadStore,
 * these records survive successful publication so the extension can keep a
 * local management cache and, critically, resume the exact same public ids
 * after a browser/process restart.
 *
 * `plans` is private extension state. Only `manifest` may cross the sharing
 * service boundary.
 */

import { createIndexedDbKeyValueArea, type KeyValueArea } from '../offscreen/storage/indexedDbKeyValueArea';
import type { PublishedPlaybackManifest } from '../shared/sharing';
import type { DriveMediaOrigin } from './DriveOriginPreparer';
import type { PublishedRecordingPlan } from './PublishedManifestBuilder';

const SHARE_PUBLICATION_PREFIX = 'sharePublication:';

/** Legacy uploading rows resume into the new preparing-origin phase. */
export type SharePublicationPhase = 'draft' | 'preparing-origin' | 'uploading' | 'finalizing' | 'revoking';
export type SharePublicationStatus = SharePublicationPhase | 'active' | 'revoked' | 'failed';

export type SharePublication = {
  id: string;
  status: SharePublicationStatus;
  /** Public snapshot. This is the only metadata object sent to the service. */
  manifest: PublishedPlaybackManifest;
  /** Private source mapping required to resume uploads with the same public ids. */
  plans: PublishedRecordingPlan[];
  /** Private immutable Drive origins. Never included in the public manifest. */
  origins?: DriveMediaOrigin[];
  sourceRecordingIds: string[];
  shareUrl?: string;
  /** Phase to retry after a handled failure. Crash recovery keeps the phase directly. */
  resumeFrom?: SharePublicationPhase;
  /** Public revocation succeeded, but relay-reader Drive ACL cleanup still needs retry. */
  originAclCleanupPending?: boolean;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export interface SharePublicationStorageArea extends KeyValueArea {}

export class SharePublicationStore {
  constructor(private readonly area: SharePublicationStorageArea) {}

  async put(publication: SharePublication): Promise<void> {
    await this.area.set({ [SHARE_PUBLICATION_PREFIX + publication.id]: structuredClone(publication) });
  }

  async get(id: string): Promise<SharePublication | undefined> {
    return (await this.list()).find((publication) => publication.id === id);
  }

  async remove(id: string): Promise<void> {
    await this.area.remove(SHARE_PUBLICATION_PREFIX + id);
  }

  async list(): Promise<SharePublication[]> {
    const all = await this.area.getAll();
    return Object.entries(all)
      .filter(([key]) => key.startsWith(SHARE_PUBLICATION_PREFIX))
      .map(([, value]) => value)
      .filter(isSharePublication)
      .map((publication) => structuredClone(publication));
  }
}

function isSharePublication(value: unknown): value is SharePublication {
  if (!value || typeof value !== 'object') return false;
  const publication = value as SharePublication;
  const statuses: SharePublicationStatus[] = [
    'draft', 'preparing-origin', 'uploading', 'finalizing', 'active', 'revoking', 'revoked', 'failed',
  ];
  const phases: SharePublicationPhase[] = ['draft', 'preparing-origin', 'uploading', 'finalizing', 'revoking'];
  return typeof publication.id === 'string'
    && statuses.includes(publication.status)
    && !!publication.manifest
    && typeof publication.manifest === 'object'
    && publication.manifest.id === publication.id
    && Array.isArray(publication.manifest.recordings)
    && Array.isArray(publication.plans)
    && (typeof publication.origins === 'undefined'
      || (Array.isArray(publication.origins) && publication.origins.every(isDriveMediaOrigin)))
    && Array.isArray(publication.sourceRecordingIds)
    && publication.sourceRecordingIds.every((id) => typeof id === 'string')
    && (typeof publication.shareUrl === 'undefined' || typeof publication.shareUrl === 'string')
    && (typeof publication.resumeFrom === 'undefined' || phases.includes(publication.resumeFrom))
    && (typeof publication.originAclCleanupPending === 'undefined' || typeof publication.originAclCleanupPending === 'boolean')
    && (typeof publication.error === 'undefined' || typeof publication.error === 'string')
    && typeof publication.createdAt === 'number'
    && typeof publication.updatedAt === 'number';
}

function isDriveMediaOrigin(value: unknown): value is DriveMediaOrigin {
  if (!value || typeof value !== 'object') return false;
  const origin = value as DriveMediaOrigin;
  return typeof origin.sourceRecordingId === 'string'
    && typeof origin.recordingId === 'string'
    && typeof origin.trackId === 'string'
    && typeof origin.fileId === 'string'
    && typeof origin.revisionId === 'string'
    && Number.isSafeInteger(origin.bytes)
    && origin.bytes >= 0
    && typeof origin.mimeType === 'string'
    && (typeof origin.md5Checksum === 'undefined' || typeof origin.md5Checksum === 'string')
    && (typeof origin.permissionId === 'undefined' || typeof origin.permissionId === 'string')
    && typeof origin.createdDriveCopy === 'boolean';
}

export const SHARE_PUBLICATION_DATABASE = 'published-share-publications';

export function createSharePublicationStore(): SharePublicationStore {
  return new SharePublicationStore(createIndexedDbKeyValueArea({
    databaseName: SHARE_PUBLICATION_DATABASE,
    storeName: 'publications',
  }));
}
