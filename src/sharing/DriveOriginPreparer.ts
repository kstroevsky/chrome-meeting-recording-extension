/**
 * @file sharing/DriveOriginPreparer.ts
 *
 * Prepares the owner-private media origin for a published track. Durable media
 * remains in the owner's Google Drive. The sharing service receives only a
 * verified Drive file/revision descriptor through an authenticated owner API.
 *
 * OPFS-only sources are first copied to the owner's Drive with a resumable
 * upload whose session URI and committed offset live in ShareUploadStore.
 */

import type { PlaybackTrack } from '../shared/playback';
import {
  createCachedTokenProvider,
  driveFetch,
  fetchWithAuthRetry,
  type TokenProvider,
} from '../offscreen/drive/request';
import type { PublishedRecordingPlan, PublishedTrackPlan } from './PublishedManifestBuilder';
import type { ShareUploadSourceResolver } from './ShareUploadManager';
import { ShareUploadStore, type ShareUploadJob } from './ShareUploadStore';

const DRIVE_API_ORIGIN = 'https://www.googleapis.com';
const DRIVE_UPLOAD_ORIGIN = 'https://www.googleapis.com';
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 8_000;

export type DriveMediaOrigin = {
  sourceRecordingId: string;
  recordingId: string;
  trackId: string;
  fileId: string;
  revisionId: string;
  bytes: number;
  mimeType: string;
  md5Checksum?: string;
  permissionId?: string;
  /** True only when publication created a Drive copy from an OPFS-only source. */
  createdDriveCopy: boolean;
};

/** Minimal owner-only descriptor needed to remove relay access/publication pins. */
export type DriveOriginCleanupDescriptor = Pick<
  DriveMediaOrigin,
  'fileId' | 'revisionId' | 'permissionId'
>;

export type RegisterDriveOriginInput = {
  shareId: string;
  recordingId: string;
  trackId: string;
  fileId: string;
  revisionId: string;
  bytes: number;
  mimeType: string;
  md5Checksum?: string;
  permissionId?: string;
};

export interface DriveOriginApi {
  getDriveReaderIdentity(): Promise<{ email: string }>;
  registerDriveOrigin(input: RegisterDriveOriginInput): Promise<void>;
}

export type DriveOriginPreparerDeps = {
  store: ShareUploadStore;
  source: ShareUploadSourceResolver;
  api: DriveOriginApi;
  getDriveToken: TokenProvider;
  fetch?: typeof fetch;
  concurrency?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type DriveFileMetadata = {
  id: string;
  headRevisionId: string;
  size: number;
  mimeType: string;
  md5Checksum?: string;
  canDownload: boolean;
};

type DrivePermission = {
  id: string;
  type?: string;
  role?: string;
  emailAddress?: string;
};

export class DriveOriginPreparer {
  private readonly getToken: TokenProvider;
  private readonly fetcher: typeof fetch;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readerEmailPromise: Promise<string> | null = null;

  constructor(private readonly deps: DriveOriginPreparerDeps) {
    this.getToken = createCachedTokenProvider(deps.getDriveToken);
    this.fetcher = deps.fetch ?? driveFetch;
    this.concurrency = Math.max(1, Math.floor(deps.concurrency ?? 1));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async prepare(shareId: string, plans: readonly PublishedRecordingPlan[]): Promise<DriveMediaOrigin[]> {
    const existing = new Map((await this.deps.store.list(shareId)).map((job) => [job.id, job]));
    const work: Array<{ plan: PublishedRecordingPlan; track: PublishedTrackPlan; job: ShareUploadJob }> = [];

    for (const plan of plans) {
      for (const track of plan.tracks) {
        const id = jobId(shareId, plan.recording.id, track.published.id);
        const persisted = existing.get(id);
        const job = persisted ?? this.newJob(shareId, plan, track, id);
        if (!persisted) await this.deps.store.put(job);
        work.push({ plan, track, job });
      }
    }

    const results = new Array<DriveMediaOrigin>(work.length);
    await runBounded(work, this.concurrency, async (item, index) => {
      results[index] = await this.prepareTrack(shareId, item.plan, item.track, item.job);
    });
    return results;
  }

  async clearShare(shareId: string): Promise<void> {
    const jobs = await this.deps.store.list(shareId);
    await Promise.all(jobs.map((job) => this.deps.store.remove(job.id)));
  }

  /**
   * Removes the relay's explicit file permission. Public revocation has already
   * happened in D1 before this is called, so failure here is cleanup-only.
   */
  async cleanupPermissions(origins: readonly DriveOriginCleanupDescriptor[]): Promise<void> {
    const errors: unknown[] = [];
    for (const origin of origins) {
      if (!origin.permissionId) continue;
      try {
        await this.driveRequest(
          `/drive/v3/files/${segment(origin.fileId)}/permissions/${segment(origin.permissionId)}`,
          { method: 'DELETE' },
          [200, 204, 404],
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new Error(`Could not remove ${errors.length} sharing Drive permission(s)`);
  }

  /**
   * Delete-published-data cleanup. It never deletes the user's recording file.
   * If the published revision is no longer the head, the obsolete pinned
   * revision can be deleted. If it is still head, only Keep Forever is cleared.
   */
  async cleanupPublishedData(origins: readonly DriveOriginCleanupDescriptor[]): Promise<void> {
    await this.cleanupPermissions(origins);
    const errors: unknown[] = [];
    for (const origin of origins) {
      try {
        const metadata = await this.getFileMetadata(origin.fileId);
        if (metadata.headRevisionId === origin.revisionId) {
          await this.driveRequest(
            `/drive/v3/files/${segment(origin.fileId)}/revisions/${segment(origin.revisionId)}?fields=id%2CkeepForever`,
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ keepForever: false }),
            },
            [200],
          );
        } else {
          await this.driveRequest(
            `/drive/v3/files/${segment(origin.fileId)}/revisions/${segment(origin.revisionId)}`,
            { method: 'DELETE' },
            [200, 204, 404],
          );
        }
      } catch (error) {
        // If the owner already deleted the Drive file, both the explicit
        // permission and any pinned revision disappeared with it.
        if (errorStatus(error) === 404) continue;
        errors.push(error);
      }
    }
    if (errors.length) throw new Error(`Could not release ${errors.length} pinned Drive revision(s)`);
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

  private async prepareTrack(
    shareId: string,
    plan: PublishedRecordingPlan,
    track: PublishedTrackPlan,
    job: ShareUploadJob,
  ): Promise<DriveMediaOrigin> {
    try {
      job.status = 'uploading';
      job.activity = job.driveFileId || job.uploadId || job.offset > 0 ? 'resuming' : 'uploading';
      job.error = undefined;
      job.updatedAt = this.now();
      await this.deps.store.put(job);

      const existingDrive = driveFileId(track.source);
      if (!job.driveFileId) {
        if (existingDrive) {
          job.driveFileId = existingDrive;
          job.createdDriveCopy = false;
        } else {
          job.createdDriveCopy = true;
          job.driveFileId = await this.ensureDriveCopy(job);
        }
        job.updatedAt = this.now();
        await this.deps.store.put(job);
      }

      const metadata = await this.getFileMetadata(job.driveFileId);
      if (!metadata.canDownload) throw new Error('Drive file cannot be downloaded by the sharing reader');
      if (job.bytes != null && job.bytes !== metadata.size) {
        throw new Error(`Share source size changed: expected ${job.bytes}, got ${metadata.size}`);
      }
      if (metadata.mimeType !== track.published.mimeType) {
        throw new Error(`Share source MIME type changed: expected ${track.published.mimeType}, got ${metadata.mimeType}`);
      }

      await this.pinRevision(job.driveFileId, metadata.headRevisionId);
      job.revisionId = metadata.headRevisionId;
      job.bytes = metadata.size;
      job.md5Checksum = metadata.md5Checksum;

      if (!job.permissionId) {
        job.permissionId = await this.ensureReaderPermission(job.driveFileId);
      }
      job.updatedAt = this.now();
      await this.deps.store.put(job);

      const origin: DriveMediaOrigin = {
        sourceRecordingId: plan.sourceRecordingId,
        recordingId: plan.recording.id,
        trackId: track.published.id,
        fileId: job.driveFileId,
        revisionId: job.revisionId,
        bytes: metadata.size,
        mimeType: metadata.mimeType,
        ...(metadata.md5Checksum ? { md5Checksum: metadata.md5Checksum } : {}),
        ...(job.permissionId ? { permissionId: job.permissionId } : {}),
        createdDriveCopy: job.createdDriveCopy === true,
      };

      await this.deps.api.registerDriveOrigin({
        shareId,
        recordingId: origin.recordingId,
        trackId: origin.trackId,
        fileId: origin.fileId,
        revisionId: origin.revisionId,
        bytes: origin.bytes,
        mimeType: origin.mimeType,
        ...(origin.md5Checksum ? { md5Checksum: origin.md5Checksum } : {}),
        ...(origin.permissionId ? { permissionId: origin.permissionId } : {}),
      });

      job.status = 'completed';
      job.activity = undefined;
      job.attempt = undefined;
      job.error = undefined;
      job.offset = metadata.size;
      job.updatedAt = this.now();
      await this.deps.store.put(job);
      return origin;
    } catch (error) {
      job.status = 'failed';
      job.activity = undefined;
      job.attempt = undefined;
      job.error = describeError(error);
      job.updatedAt = this.now();
      await this.deps.store.put(job);
      throw error;
    }
  }

  private async ensureDriveCopy(job: ShareUploadJob): Promise<string> {
    const source = await this.deps.source(job.source);
    if (job.bytes != null && job.bytes !== source.size) {
      throw new Error(`Share source size changed: expected ${job.bytes}, got ${source.size}`);
    }
    job.bytes = source.size;

    let sessionUri = job.uploadId;
    if (sessionUri) {
      const status = await this.probeUploadSession(sessionUri, source.size);
      if (status.kind === 'gone') {
        sessionUri = undefined;
        job.uploadId = undefined;
        job.offset = 0;
      } else if (status.kind === 'complete') {
        job.uploadId = undefined;
        job.offset = source.size;
        if (!status.fileId) throw new Error('Drive completed upload but returned no file id');
        await this.deps.store.put(job);
        return status.fileId;
      } else {
        job.offset = status.offset;
      }
    }

    if (!sessionUri) {
      sessionUri = await this.beginDriveUpload(job, source.size);
      job.uploadId = sessionUri;
      job.offset = 0;
      job.updatedAt = this.now();
      await this.deps.store.put(job);
    }

    while (job.offset < source.size) {
      const start = job.offset;
      const end = Math.min(source.size, start + DEFAULT_CHUNK_SIZE);
      const chunk = await source.read(start, end);
      if (chunk.size !== end - start) {
        throw new Error(`Share source returned ${chunk.size} bytes for a ${end - start}-byte range`);
      }
      const result = await this.uploadDriveChunk(sessionUri, start, chunk, source.size);
      job.offset = result.offset;
      job.activity = 'uploading';
      job.attempt = 1;
      job.updatedAt = this.now();
      if (result.fileId) {
        job.driveFileId = result.fileId;
        job.uploadId = undefined;
      }
      await this.deps.store.put(job);
      if (result.fileId) return result.fileId;
    }

    const completed = await this.probeUploadSession(sessionUri, source.size);
    if (completed.kind !== 'complete' || !completed.fileId) {
      throw new Error('Drive upload completed without a file id');
    }
    return completed.fileId;
  }

  private async beginDriveUpload(job: ShareUploadJob, bytes: number): Promise<string> {
    const response = await this.driveRequest(
      '/upload/drive/v3/files?uploadType=resumable&fields=id%2Cname',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-upload-content-type': job.mimeType,
          'x-upload-content-length': String(bytes),
        },
        body: JSON.stringify({ name: job.source.filename, mimeType: job.mimeType }),
      },
      [200, 201],
      DRIVE_UPLOAD_ORIGIN,
    );
    const location = response.headers.get('location');
    if (!location) throw new Error('Drive did not return a resumable upload URI');
    return location;
  }

  private async probeUploadSession(
    sessionUri: string,
    bytes: number,
  ): Promise<{ kind: 'pending'; offset: number } | { kind: 'complete'; fileId?: string } | { kind: 'gone' }> {
    const response = await this.withRetry(async () => {
      const token = await this.getToken();
      return await this.fetcher(sessionUri, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-range': `bytes */${bytes}`,
        },
      });
    });
    if (response.status === 404 || response.status === 410) return { kind: 'gone' };
    if (response.status === 200 || response.status === 201) {
      const body = await response.json().catch(() => ({})) as { id?: unknown };
      return { kind: 'complete', ...(typeof body.id === 'string' ? { fileId: body.id } : {}) };
    }
    if (response.status !== 308) throw await driveError('Drive upload status probe failed', response);
    const range = response.headers.get('range');
    const match = /^bytes=0-(\d+)$/i.exec(range ?? '');
    return { kind: 'pending', offset: match ? Math.min(bytes, Number(match[1]) + 1) : 0 };
  }

  private async uploadDriveChunk(
    sessionUri: string,
    start: number,
    chunk: Blob,
    total: number,
  ): Promise<{ offset: number; fileId?: string }> {
    let attempt = 1;
    while (true) {
      const token = await this.getToken(attempt > 1 ? { refresh: attempt === 2 } : undefined);
      const end = start + chunk.size - 1;
      let response: Response;
      try {
        response = await this.fetcher(sessionUri, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': chunk.type || 'application/octet-stream',
            'content-range': `bytes ${start}-${end}/${total}`,
          },
          body: chunk,
        });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error;
        attempt += 1;
        await this.sleep(backoffMs(attempt - 1));
        continue;
      }

      if (response.status === 200 || response.status === 201) {
        const body = await response.json().catch(() => ({})) as { id?: unknown };
        if (typeof body.id !== 'string' || !body.id) throw new Error('Drive completed upload without a file id');
        return { offset: total, fileId: body.id };
      }
      if (response.status === 308) {
        const range = response.headers.get('range');
        const match = /^bytes=0-(\d+)$/i.exec(range ?? '');
        return { offset: match ? Math.min(total, Number(match[1]) + 1) : start + chunk.size };
      }
      if ((response.status === 401 || response.status === 403) && attempt < 2) {
        attempt += 1;
        await this.getToken({ refresh: true });
        continue;
      }
      if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
        const status = await this.probeUploadSession(sessionUri, total);
        if (status.kind === 'complete') {
          if (!status.fileId) throw new Error('Drive completed upload but returned no file id');
          return { offset: total, fileId: status.fileId };
        }
        if (status.kind === 'gone') throw new Error('Drive resumable upload session expired');
        if (status.offset > start) return { offset: status.offset };
        attempt += 1;
        await this.sleep(backoffMs(attempt - 1));
        continue;
      }
      throw await driveError('Drive upload failed', response);
    }
  }

  private async getFileMetadata(fileId: string): Promise<DriveFileMetadata> {
    const response = await this.driveRequest(
      `/drive/v3/files/${segment(fileId)}?fields=id%2CheadRevisionId%2Csize%2CmimeType%2Cmd5Checksum%2Ccapabilities(canDownload)`,
      { method: 'GET' },
      [200],
    );
    const body = await response.json() as Record<string, unknown>;
    const size = Number(body.size);
    const capabilities = body.capabilities as { canDownload?: unknown } | undefined;
    if (body.id !== fileId
      || typeof body.headRevisionId !== 'string'
      || !body.headRevisionId
      || !Number.isSafeInteger(size)
      || size < 0
      || typeof body.mimeType !== 'string') {
      throw new Error('Drive returned invalid media metadata');
    }
    return {
      id: fileId,
      headRevisionId: body.headRevisionId,
      size,
      mimeType: body.mimeType,
      ...(typeof body.md5Checksum === 'string' ? { md5Checksum: body.md5Checksum } : {}),
      canDownload: capabilities?.canDownload === true,
    };
  }

  private async pinRevision(fileId: string, revisionId: string): Promise<void> {
    await this.driveRequest(
      `/drive/v3/files/${segment(fileId)}/revisions/${segment(revisionId)}?fields=id%2CkeepForever`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keepForever: true }),
      },
      [200],
    );
  }

  private async ensureReaderPermission(fileId: string): Promise<string> {
    const readerEmail = await this.readerEmail();
    const list = await this.driveRequest(
      `/drive/v3/files/${segment(fileId)}/permissions?fields=permissions(id%2Ctype%2Crole%2CemailAddress)`,
      { method: 'GET' },
      [200],
    );
    const body = await list.json().catch(() => ({})) as { permissions?: DrivePermission[] };
    const existing = body.permissions?.find((permission) =>
      permission.type === 'user'
      && permission.role === 'reader'
      && permission.emailAddress?.toLowerCase() === readerEmail.toLowerCase());
    if (existing?.id) return existing.id;

    const created = await this.driveRequest(
      `/drive/v3/files/${segment(fileId)}/permissions?fields=id&sendNotificationEmail=false`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: readerEmail }),
      },
      [200, 201],
    );
    const permission = await created.json().catch(() => ({})) as { id?: unknown };
    if (typeof permission.id !== 'string' || !permission.id) {
      throw new Error('Drive returned no sharing-reader permission id');
    }
    return permission.id;
  }

  private async readerEmail(): Promise<string> {
    this.readerEmailPromise ??= this.deps.api.getDriveReaderIdentity().then(({ email }) => {
      if (!email || !email.includes('@')) throw new Error('Sharing service returned an invalid Drive reader identity');
      return email;
    });
    return await this.readerEmailPromise;
  }

  private async driveRequest(
    path: string,
    init: RequestInit,
    statuses: readonly number[],
    origin = DRIVE_API_ORIGIN,
  ): Promise<Response> {
    let attempt = 1;
    while (true) {
      let response: Response;
      try {
        response = await fetchWithAuthRetry(this.getToken, (token) => this.fetcher(origin + path, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            ...headersRecord(init.headers),
          },
          cache: 'no-store',
        }));
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error;
        await this.sleep(backoffMs(attempt++));
        continue;
      }
      if (statuses.includes(response.status)) return response;

      const retryable = response.status === 408
        || response.status === 429
        || response.status >= 500
        || (response.status === 403 && await isDriveRateLimitResponse(response));
      if (retryable && attempt < MAX_ATTEMPTS) {
        await this.sleep(backoffMs(attempt++));
        continue;
      }
      throw await driveError(`Drive ${init.method ?? 'GET'} failed`, response);
    }
  }

  private async withRetry<T>(run: () => Promise<T>): Promise<T> {
    let attempt = 1;
    while (true) {
      try {
        return await run();
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error;
        attempt += 1;
        await this.sleep(backoffMs(attempt - 1));
      }
    }
  }
}

async function isDriveRateLimitResponse(response: Response): Promise<boolean> {
  const detail = await response.clone().text().catch(() => '');
  return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(detail);
}

function driveFileId(track: PlaybackTrack): string | undefined {
  return track.sources.find((source): source is Extract<PlaybackTrack['sources'][number], { kind: 'drive' }> =>
    source.kind === 'drive')?.fileId;
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => { record[key] = value; });
  return record;
}

async function driveError(prefix: string, response: Response): Promise<Error> {
  const detail = await response.text().catch(() => '');
  return Object.assign(
    new Error(`${prefix} (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`),
    { status: response.status },
  );
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function jobId(shareId: string, recordingId: string, trackId: string): string {
  return `${shareId}:${recordingId}:${trackId}`;
}

function backoffMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number | undefined {
  return error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined;
}

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const errors: unknown[] = [];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        await run(items[index], index);
      } catch (error) {
        errors.push(error);
      }
    }
  });
  await Promise.all(workers);
  if (errors.length) {
    throw new Error(`${errors.length} Drive origin preparation(s) failed: ${errors.map(describeError).join('; ')}`);
  }
}
