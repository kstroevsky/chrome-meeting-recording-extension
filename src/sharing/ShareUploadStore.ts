/**
 * @file sharing/ShareUploadStore.ts
 *
 * Durable owner-side bookkeeping for published media uploads. The stored
 * `source` is intentionally private extension state: it may contain OPFS keys
 * or Drive ids and must never be sent to the sharing service.
 */

import { createIndexedDbKeyValueArea, type KeyValueArea } from '../offscreen/storage/indexedDbKeyValueArea';
import type { PlaybackTrack } from '../shared/playback';

const SHARE_UPLOAD_PREFIX = 'shareUpload:';

export type ShareUploadStatus = 'queued' | 'uploading' | 'failed' | 'completed';

export type ShareUploadJob = {
  id: string;
  shareId: string;
  sourceRecordingId: string;
  recordingId: string;
  trackId: string;
  /** Owner-private source locator. Never serialize this to the server. */
  source: PlaybackTrack;
  mimeType: string;
  bytes?: number;
  offset: number;
  status: ShareUploadStatus;
  uploadId?: string;
  chunkSize?: number;
  error?: string;
  updatedAt: number;
};

export interface ShareUploadStorageArea extends KeyValueArea {}

export class ShareUploadStore {
  constructor(private readonly area: ShareUploadStorageArea) {}

  async put(job: ShareUploadJob): Promise<void> {
    await this.area.set({ [SHARE_UPLOAD_PREFIX + job.id]: structuredClone(job) });
  }

  async remove(jobId: string): Promise<void> {
    await this.area.remove(SHARE_UPLOAD_PREFIX + jobId);
  }

  async list(shareId?: string): Promise<ShareUploadJob[]> {
    const all = await this.area.getAll();
    return Object.entries(all)
      .filter(([key]) => key.startsWith(SHARE_UPLOAD_PREFIX))
      .map(([, value]) => value)
      .filter(isShareUploadJob)
      .filter((job) => shareId == null || job.shareId === shareId)
      .map((job) => structuredClone(job));
  }
}

function isShareUploadJob(value: unknown): value is ShareUploadJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as ShareUploadJob;
  return typeof job.id === 'string'
    && typeof job.shareId === 'string'
    && typeof job.sourceRecordingId === 'string'
    && typeof job.recordingId === 'string'
    && typeof job.trackId === 'string'
    && !!job.source
    && typeof job.source === 'object'
    && typeof job.mimeType === 'string'
    && (typeof job.bytes === 'undefined' || typeof job.bytes === 'number')
    && typeof job.offset === 'number'
    && ['queued', 'uploading', 'failed', 'completed'].includes(job.status)
    && (typeof job.uploadId === 'undefined' || typeof job.uploadId === 'string')
    && (typeof job.chunkSize === 'undefined' || typeof job.chunkSize === 'number')
    && (typeof job.error === 'undefined' || typeof job.error === 'string')
    && typeof job.updatedAt === 'number';
}

export const SHARE_UPLOAD_DATABASE = 'published-share-uploads';

export function createShareUploadStore(): ShareUploadStore {
  return new ShareUploadStore(createIndexedDbKeyValueArea({
    databaseName: SHARE_UPLOAD_DATABASE,
    storeName: 'jobs',
  }));
}
