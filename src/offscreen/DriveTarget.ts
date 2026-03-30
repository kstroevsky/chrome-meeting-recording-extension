/**
 * @file offscreen/DriveTarget.ts
 *
 * Uploads a fully sealed local recording file to Google Drive using the
 * resumable upload protocol. Recording itself never writes to Drive directly.
 */

import {
  DRIVE_FAST_CHUNK_MS,
  DRIVE_MAX_UPLOAD_CHUNK_BYTES,
  DRIVE_MIN_UPLOAD_CHUNK_BYTES,
  DRIVE_SLOW_CHUNK_MS,
  DRIVE_UPLOAD_CHUNK_BYTES,
  DRIVE_UPLOAD_CHUNK_STEP_BYTES,
  DRIVE_UPLOAD_URL,
} from './drive/constants';
import { type DriveFolderHierarchy, DriveFolderResolver } from './drive/DriveFolderResolver';
import { formatDriveError, readDriveErrorDetail } from './drive/errors';
import {
  createCachedTokenProvider,
  fetchWithAuthRetry,
  type TokenProvider,
} from './drive/request';
import { uploadChunk, fetchWithTimeout } from './drive/DriveChunkUploader';
import type { UploadChunkResult } from './drive/DriveChunkUploader';
import { PERF_FLAGS, clamp, logPerf, nowMs, roundMs } from '../shared/perf';

export type DriveTargetOptions = DriveFolderHierarchy;
export type DriveUploadSharedContext = {
  getUploadToken: TokenProvider;
  folderResolver: DriveFolderResolver;
  log?: (...a: any[]) => void;
};

type DriveTargetCtorOptions = DriveFolderHierarchy & {
  shared?: DriveUploadSharedContext;
};

/**
 * Per-file Drive uploader.
 *
 * One instance uploads exactly one sealed artifact. It reuses a cached token
 * across folder lookup, session creation, and chunk uploads, and refreshes that
 * token only when Google explicitly rejects it.
 */
export class DriveTarget {
  private sessionUri: string | null = null;
  private readonly getUploadToken: TokenProvider;
  private readonly folderResolver: DriveFolderResolver;
  private readonly hierarchy: DriveFolderHierarchy;
  private readonly log: (...a: any[]) => void;
  private used = false;

  constructor(
    private readonly filename: string,
    getToken: TokenProvider,
    private readonly onDone: (filename: string) => void,
    options: DriveTargetCtorOptions = {}
  ) {
    const shared = options.shared;
    this.getUploadToken = shared?.getUploadToken ?? createCachedTokenProvider(getToken);
    this.folderResolver = shared?.folderResolver ?? new DriveFolderResolver(this.getUploadToken);
    this.hierarchy = {
      rootFolderName: options.rootFolderName,
      recordingFolderName: options.recordingFolderName,
    };
    this.log = shared?.log ?? (() => {});
  }

  /** Uploads the sealed artifact using Drive's resumable upload flow. */
  async upload(file: Blob): Promise<void> {
    if (this.used) throw new Error('Drive target already used');
    this.used = true;
    if (file.size === 0) return;

    const uploadStartedAt = nowMs();
    await this.initSession();

    const total = file.size;
    let start = 0;
    let chunkSize = DRIVE_UPLOAD_CHUNK_BYTES;
    let fastChunkStreak = 0;

    while (start < total) {
      const endExclusive = Math.min(start + chunkSize, total);
      const body = file.slice(start, endExclusive, 'video/webm');
      const isFinal = endExclusive >= total;
      const chunkResult = await uploadChunk(this.sessionUri!, this.getUploadToken, start, body, total, isFinal);
      start = chunkResult.nextStart;

      logPerf(this.log, 'drive', 'chunk_uploaded', {
        filename: this.filename,
        chunkBytes: chunkResult.sentBytes,
        durationMs: chunkResult.durationMs,
        attempts: chunkResult.attempts,
        retried: chunkResult.hadRetry,
        status: chunkResult.status,
        isFinal,
      });

      if (!PERF_FLAGS.dynamicDriveChunkSizing || isFinal) continue;

      const tuned = this.adjustChunkSize(chunkSize, fastChunkStreak, chunkResult);
      chunkSize = tuned.chunkSize;
      fastChunkStreak = tuned.fastChunkStreak;
    }

    logPerf(this.log, 'drive', 'file_uploaded', {
      filename: this.filename,
      totalBytes: total,
      durationMs: roundMs(nowMs() - uploadStartedAt),
    });
    this.onDone(this.filename);
  }

  /** Starts a resumable upload session and stores the returned session URI. */
  private async initSession(): Promise<void> {
    const parentFolderId = await this.folderResolver.resolveUploadParentId(this.hierarchy);
    const metadata: Record<string, any> = { name: this.filename, mimeType: 'video/webm' };
    if (parentFolderId) metadata.parents = [parentFolderId];

    const res = await fetchWithAuthRetry(this.getUploadToken, (token) =>
      fetchWithTimeout(DRIVE_UPLOAD_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/webm',
        },
        body: JSON.stringify(metadata),
      })
    );

    if (!res.ok) {
      const detail = await readDriveErrorDetail(res);
      throw new Error(formatDriveError('Drive session init failed', res.status, detail));
    }

    const uri = res.headers.get('Location');
    if (!uri) throw new Error('Drive did not return a session URI');
    this.sessionUri = uri;
  }

  private adjustChunkSize(
    currentChunkSize: number,
    fastChunkStreak: number,
    chunkResult: UploadChunkResult
  ): { chunkSize: number; fastChunkStreak: number } {
    if (chunkResult.hadRetry || chunkResult.durationMs >= DRIVE_SLOW_CHUNK_MS) {
      return {
        chunkSize: clamp(currentChunkSize - DRIVE_UPLOAD_CHUNK_STEP_BYTES, DRIVE_MIN_UPLOAD_CHUNK_BYTES, DRIVE_MAX_UPLOAD_CHUNK_BYTES),
        fastChunkStreak: 0,
      };
    }
    if (chunkResult.durationMs <= DRIVE_FAST_CHUNK_MS && chunkResult.sentBytes === currentChunkSize) {
      const nextStreak = fastChunkStreak + 1;
      if (nextStreak >= 2) {
        return {
          chunkSize: clamp(currentChunkSize + DRIVE_UPLOAD_CHUNK_STEP_BYTES, DRIVE_MIN_UPLOAD_CHUNK_BYTES, DRIVE_MAX_UPLOAD_CHUNK_BYTES),
          fastChunkStreak: 0,
        };
      }
      return { chunkSize: currentChunkSize, fastChunkStreak: nextStreak };
    }
    return { chunkSize: currentChunkSize, fastChunkStreak: 0 };
  }
}
