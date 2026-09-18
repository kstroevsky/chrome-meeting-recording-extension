/**
 * @file offscreen/drive/UploadJobStateOutbox.ts
 *
 * Durable terminal-state outbox for background Drive-upload jobs (ADR-0004).
 *
 * **Stored in IndexedDB, not `chrome.storage.local`.** This runs in the
 * offscreen document, whose `chrome` object exposes `runtime` and nothing
 * else — and the wrappers in `platform/chrome/storage.ts` deliberately degrade
 * to a no-op rather than throw, so that a failed bookkeeping write cannot abort
 * the stop/finalize pipeline. Together those two facts meant every write here
 * silently succeeded and stored nothing: the outbox reported durability it did
 * not have, and a terminal upload state was never replayed after a
 * service-worker death. IndexedDB belongs to the extension origin, so the
 * offscreen document can actually write it and background can read it.
 */

import { createIndexedDbKeyValueArea } from '../storage/indexedDbKeyValueArea';
import { normalizeUploadJobs, type UploadJob } from '../../shared/recording';

const TERMINAL_UPLOAD_STATE_PREFIX = 'terminalUploadState:';

export interface UploadJobStateStorageArea {
  getAll(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Durable terminal-state outbox. Entries leave only after background acknowledgement. */
export class UploadJobStateOutbox {
  constructor(private readonly area: UploadJobStateStorageArea) {}

  async put(job: UploadJob): Promise<void> {
    if (job.status === 'uploading') throw new Error('Only terminal upload jobs belong in the outbox');
    await this.area.set({ [TERMINAL_UPLOAD_STATE_PREFIX + job.id]: job });
  }

  async remove(jobId: string): Promise<void> {
    await this.area.remove(TERMINAL_UPLOAD_STATE_PREFIX + jobId);
  }

  async list(): Promise<UploadJob[]> {
    const all = await this.area.getAll();
    const jobs: UploadJob[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(TERMINAL_UPLOAD_STATE_PREFIX)) continue;
      const job = normalizeUploadJobs([value])?.[0];
      if (job && job.status !== 'uploading') jobs.push(job);
    }
    return jobs;
  }
}

export const UPLOAD_OUTBOX_DATABASE = 'upload-job-outbox';

/** The outbox the offscreen document uses. */
export function createUploadJobStateOutbox(): UploadJobStateOutbox {
  return new UploadJobStateOutbox(createIndexedDbKeyValueArea({
    databaseName: UPLOAD_OUTBOX_DATABASE,
    storeName: 'jobs',
  }));
}
