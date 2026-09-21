/**
 * @file sharing/ShareUploadManager.ts
 *
 * Chunked, restart-safe media uploader for published recordings. It deliberately
 * knows nothing about Cloudflare/R2: the backend contract is injected as a
 * transport, while the source reader abstracts OPFS/Drive access.
 */

import type { PlaybackTrack } from '../shared/playback';
import type { PublishedRecordingPlan, PublishedTrackPlan } from './PublishedManifestBuilder';
import { ShareUploadStore, type ShareUploadJob } from './ShareUploadStore';

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

export type ShareUploadSource = {
  size: number;
  read(start: number, end: number, signal?: AbortSignal): Promise<Blob>;
};

export type ShareUploadSourceResolver = (track: PlaybackTrack) => Promise<ShareUploadSource>;

export type ShareUploadSession = {
  uploadId: string;
  /** Backend-selected chunk size; absent means the extension default. */
  chunkSize?: number;
  /** Lets a backend resume a session farther ahead than our last durable write. */
  offset?: number;
};

export interface ShareUploadTransport {
  beginTrackUpload(input: {
    shareId: string;
    recordingId: string;
    trackId: string;
    mimeType: string;
    bytes: number;
  }, signal?: AbortSignal): Promise<ShareUploadSession>;

  uploadTrackChunk(input: {
    uploadId: string;
    offset: number;
    totalBytes: number;
    chunk: Blob;
  }, signal?: AbortSignal): Promise<void>;

  completeTrackUpload(input: {
    uploadId: string;
    totalBytes: number;
  }, signal?: AbortSignal): Promise<void>;
}

export type ShareUploadManagerDeps = {
  store: ShareUploadStore;
  source: ShareUploadSourceResolver;
  transport: ShareUploadTransport;
  concurrency?: number;
  now?: () => number;
  report?: (job: ShareUploadJob) => void | Promise<void>;
};

export class ShareUploadManager {
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: ShareUploadManagerDeps) {
    this.concurrency = Math.max(1, deps.concurrency ?? 1);
    this.now = deps.now ?? Date.now;
  }

  /** Uploads every media track in the plans, reusing any durable partial jobs. */
  async upload(shareId: string, plans: readonly PublishedRecordingPlan[]): Promise<void> {
    const existing = new Map((await this.deps.store.list(shareId)).map((job) => [job.id, job]));
    const jobs: ShareUploadJob[] = [];

    for (const plan of plans) {
      for (const track of plan.tracks) {
        const id = jobId(shareId, plan.recording.id, track.published.id);
        const persisted = existing.get(id);
        if (persisted?.status === 'completed') {
          jobs.push(persisted);
          continue;
        }
        const next = persisted ?? this.newJob(shareId, plan, track, id);
        // An interrupted process leaves `uploading`; at startup it is simply
        // eligible to continue from its last durably acknowledged offset.
        if (next.status === 'uploading') next.status = 'queued';
        next.error = undefined;
        next.updatedAt = this.now();
        await this.deps.store.put(next);
        jobs.push(next);
      }
    }

    await runBounded(
      jobs.filter((job) => job.status !== 'completed'),
      this.concurrency,
      async (job) => this.run(job),
    );
  }

  /** Removes durable progress only after the share itself has been finalized. */
  async clearShare(shareId: string): Promise<void> {
    const jobs = await this.deps.store.list(shareId);
    await Promise.all(jobs.map((job) => this.deps.store.remove(job.id)));
  }

  cancel(jobId: string): boolean {
    const controller = this.controllers.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private newJob(
    shareId: string,
    plan: PublishedRecordingPlan,
    track: PublishedTrackPlan,
    id: string,
  ): ShareUploadJob {
    return {
      id,
      shareId,
      sourceRecordingId: plan.sourceRecordingId,
      recordingId: plan.recording.id,
      trackId: track.published.id,
      source: structuredClone(track.source),
      mimeType: track.published.mimeType,
      ...(track.published.bytes != null ? { bytes: track.published.bytes } : {}),
      offset: 0,
      status: 'queued',
      updatedAt: this.now(),
    };
  }

  private async run(job: ShareUploadJob): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const source = await this.deps.source(job.source);
      if (job.bytes != null && job.bytes !== source.size) {
        throw new Error(`Share source size changed: expected ${job.bytes}, got ${source.size}`);
      }
      job.bytes = source.size;
      job.status = 'uploading';
      job.updatedAt = this.now();
      await this.persist(job);

      if (!job.uploadId) {
        const session = await this.deps.transport.beginTrackUpload({
          shareId: job.shareId,
          recordingId: job.recordingId,
          trackId: job.trackId,
          mimeType: job.mimeType,
          bytes: source.size,
        }, controller.signal);
        job.uploadId = session.uploadId;
        job.chunkSize = normalizeChunkSize(session.chunkSize);
        job.offset = clampOffset(session.offset ?? job.offset, source.size);
        job.updatedAt = this.now();
        await this.persist(job);
      }

      const chunkSize = normalizeChunkSize(job.chunkSize);
      while (job.offset < source.size) {
        const end = Math.min(source.size, job.offset + chunkSize);
        const chunk = await source.read(job.offset, end, controller.signal);
        const expected = end - job.offset;
        if (chunk.size !== expected) {
          throw new Error(`Share source returned ${chunk.size} bytes for a ${expected}-byte range`);
        }
        await this.deps.transport.uploadTrackChunk({
          uploadId: job.uploadId!,
          offset: job.offset,
          totalBytes: source.size,
          chunk,
        }, controller.signal);
        job.offset = end;
        job.updatedAt = this.now();
        await this.persist(job);
      }

      await this.deps.transport.completeTrackUpload({
        uploadId: job.uploadId!,
        totalBytes: source.size,
      }, controller.signal);
      job.status = 'completed';
      job.error = undefined;
      job.updatedAt = this.now();
      await this.persist(job);
    } catch (error) {
      job.status = 'failed';
      job.error = describeError(error);
      job.updatedAt = this.now();
      await this.persist(job);
      throw error;
    } finally {
      this.controllers.delete(job.id);
    }
  }

  private async persist(job: ShareUploadJob): Promise<void> {
    await this.deps.store.put(job);
    await this.deps.report?.(structuredClone(job));
  }
}

function jobId(shareId: string, recordingId: string, trackId: string): string {
  return `${shareId}:${recordingId}:${trackId}`;
}

function normalizeChunkSize(value?: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : DEFAULT_CHUNK_SIZE;
}

function clampOffset(value: number, size: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(size, Math.max(0, Math.floor(value)));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runBounded<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await run(item);
    }
  });
  await Promise.all(workers);
}
