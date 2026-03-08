/**
 * @file offscreen/DriveTarget.ts
 *
 * Uploads a fully sealed local recording file to Google Drive using the
 * resumable upload protocol. Recording itself never writes to Drive directly.
 */

import {
  DRIVE_FAST_CHUNK_MS,
  DRIVE_MAX_UPLOAD_CHUNK_BYTES,
  DRIVE_MAX_RETRIES,
  DRIVE_MIN_UPLOAD_CHUNK_BYTES,
  DRIVE_REQUEST_TIMEOUT_MS,
  DRIVE_RETRY_BASE_DELAY_MS,
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
import { PERF_FLAGS, clamp, logPerf, nowMs, roundMs } from '../shared/perf';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), DRIVE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isTransientFetchError(err: unknown): boolean {
  const e = err as any;
  return e?.name === 'AbortError' || e?.name === 'TypeError';
}

function backoffMs(attempt: number): number {
  return DRIVE_RETRY_BASE_DELAY_MS * Math.min(8, 2 ** Math.max(0, attempt - 1));
}

export type DriveTargetOptions = DriveFolderHierarchy;
export type DriveUploadSharedContext = {
  getUploadToken: TokenProvider;
  folderResolver: DriveFolderResolver;
  log?: (...a: any[]) => void;
};

type DriveTargetCtorOptions = DriveFolderHierarchy & {
  shared?: DriveUploadSharedContext;
};

type UploadChunkResult = {
  nextStart: number;
  attempts: number;
  hadRetry: boolean;
  durationMs: number;
  status: number | null;
  sentBytes: number;
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
      const chunkResult = await this.uploadChunk(start, body, total, isFinal);
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

  private async initSession(): Promise<void> {
    const parentFolderId = await this.folderResolver.resolveUploadParentId(this.hierarchy);
    const metadata: Record<string, any> = {
      name: this.filename,
      mimeType: 'video/webm',
    };
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

  private async uploadChunk(start: number, body: Blob, total: number, isFinal: boolean): Promise<UploadChunkResult> {
    let chunkStart = start;
    let chunkBody = body;
    let attempts = 0;
    let lastStatus: number | null = null;
    let hadRetry = false;
    const chunkStartedAt = nowMs();

    while (attempts < DRIVE_MAX_RETRIES) {
      attempts += 1;
      const token = await this.getUploadToken();
      const end = chunkStart + chunkBody.size - 1;

      let res: Response;
      try {
        res = await fetchWithTimeout(this.sessionUri!, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Range': `bytes ${chunkStart}-${end}/${total}`,
            'Content-Type': 'video/webm',
          },
          body: chunkBody,
        });
      } catch (e) {
        if (!isTransientFetchError(e)) throw e;
        hadRetry = true;
        const recovered = await this.recoverFromCommittedState(token, chunkStart, chunkBody, total);
        if (recovered.done) {
          return {
            nextStart: recovered.start,
            attempts,
            hadRetry,
            durationMs: roundMs(nowMs() - chunkStartedAt),
            status: lastStatus,
            sentBytes: body.size,
          };
        }
        chunkStart = recovered.start;
        chunkBody = recovered.body;
        await delay(backoffMs(attempts));
        continue;
      }

      lastStatus = res.status;

      if (!isFinal && res.status === 308) {
        return {
          nextStart: chunkStart + chunkBody.size,
          attempts,
          hadRetry,
          durationMs: roundMs(nowMs() - chunkStartedAt),
          status: lastStatus,
          sentBytes: body.size,
        };
      }

      if (isFinal && (res.status === 200 || res.status === 201)) {
        return {
          nextStart: total,
          attempts,
          hadRetry,
          durationMs: roundMs(nowMs() - chunkStartedAt),
          status: lastStatus,
          sentBytes: body.size,
        };
      }

      if ((res.status === 401 || res.status === 403) && attempts < 2) {
        hadRetry = true;
        await this.getUploadToken({ refresh: true });
        continue;
      }

      if (
        res.status === 429 ||
        res.status === 408 ||
        res.status === 308 ||
        (res.status >= 500 && res.status <= 599)
      ) {
        hadRetry = true;
        const recovered = await this.recoverFromCommittedState(token, chunkStart, chunkBody, total);
        if (recovered.done) {
          return {
            nextStart: recovered.start,
            attempts,
            hadRetry,
            durationMs: roundMs(nowMs() - chunkStartedAt),
            status: lastStatus,
            sentBytes: body.size,
          };
        }
        chunkStart = recovered.start;
        chunkBody = recovered.body;
        await delay(backoffMs(attempts));
        continue;
      }

      const detail = await readDriveErrorDetail(res);
      throw new Error(formatDriveError('Drive PUT failed', res.status, detail));
    }

    throw new Error(
      formatDriveError('Drive PUT failed after retries', lastStatus ?? 0, 'Transient failure persisted')
    );
  }

  private adjustChunkSize(
    currentChunkSize: number,
    fastChunkStreak: number,
    chunkResult: UploadChunkResult
  ): { chunkSize: number; fastChunkStreak: number } {
    if (chunkResult.hadRetry || chunkResult.durationMs >= DRIVE_SLOW_CHUNK_MS) {
      return {
        chunkSize: clamp(
          currentChunkSize - DRIVE_UPLOAD_CHUNK_STEP_BYTES,
          DRIVE_MIN_UPLOAD_CHUNK_BYTES,
          DRIVE_MAX_UPLOAD_CHUNK_BYTES
        ),
        fastChunkStreak: 0,
      };
    }

    if (chunkResult.durationMs <= DRIVE_FAST_CHUNK_MS && chunkResult.sentBytes === currentChunkSize) {
      const nextStreak = fastChunkStreak + 1;
      if (nextStreak >= 2) {
        return {
          chunkSize: clamp(
            currentChunkSize + DRIVE_UPLOAD_CHUNK_STEP_BYTES,
            DRIVE_MIN_UPLOAD_CHUNK_BYTES,
            DRIVE_MAX_UPLOAD_CHUNK_BYTES
          ),
          fastChunkStreak: 0,
        };
      }
      return { chunkSize: currentChunkSize, fastChunkStreak: nextStreak };
    }

    return { chunkSize: currentChunkSize, fastChunkStreak: 0 };
  }

  private async recoverFromCommittedState(
    token: string,
    start: number,
    body: Blob,
    total: number
  ): Promise<{ done: boolean; start: number; body: Blob }> {
    try {
      const committedRes = await fetchWithTimeout(this.sessionUri!, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Range': `bytes */${total}`,
        },
      });

      if (committedRes.status === 200 || committedRes.status === 201) {
        return { done: true, start: total, body: new Blob() };
      }

      const range = committedRes.headers.get('Range');
      if (!range) return { done: false, start, body };

      const committed = parseInt(range.split('-')[1], 10) + 1;
      if (!Number.isFinite(committed)) return { done: false, start, body };

      const end = start + body.size;
      if (committed >= end) return { done: true, start: committed, body: new Blob() };
      if (committed > start) {
        const consumed = committed - start;
        return { done: false, start: committed, body: body.slice(consumed) };
      }
    } catch {}

    return { done: false, start, body };
  }
}
