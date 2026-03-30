/**
 * @file offscreen/drive/DriveChunkUploader.ts
 *
 * Core resumable chunk upload logic including retry strategy, backoff,
 * and partial-write recovery from Drive's Range header response.
 */

import {
  DRIVE_MAX_RETRIES,
  DRIVE_REQUEST_TIMEOUT_MS,
  DRIVE_RETRY_BASE_DELAY_MS,
} from './constants';
import { formatDriveError, readDriveErrorDetail } from './errors';
import type { TokenProvider } from './request';
import { nowMs, roundMs } from '../../shared/perf';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type UploadChunkResult = {
  nextStart: number;
  attempts: number;
  hadRetry: boolean;
  durationMs: number;
  status: number | null;
  sentBytes: number;
};

/** Wraps a Drive PUT with a hard abort timeout. */
export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), DRIVE_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Returns true for error types that allow an immediate retry without backoff. */
export function isTransientFetchError(err: unknown): boolean {
  const e = err as any;
  return e?.name === 'AbortError' || e?.name === 'TypeError';
}

/** Exponential backoff delay capped at 8× the base interval. */
export function backoffMs(attempt: number): number {
  return DRIVE_RETRY_BASE_DELAY_MS * Math.min(8, 2 ** Math.max(0, attempt - 1));
}

/**
 * Queries the Drive session URI for the committed byte range and returns
 * either a completion signal or the adjusted start position and remaining body.
 */
export async function recoverFromCommittedState(
  sessionUri: string,
  token: string,
  start: number,
  body: Blob,
  total: number
): Promise<{ done: boolean; start: number; body: Blob }> {
  try {
    const committedRes = await fetchWithTimeout(sessionUri, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${total}` },
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
    if (committed > start) return { done: false, start: committed, body: body.slice(committed - start) };
  } catch {}

  return { done: false, start, body };
}

/**
 * Uploads one chunk of a resumable Drive session, retrying on transient errors
 * and recovering from partial commits via the Range header protocol.
 */
export async function uploadChunk(
  sessionUri: string,
  getUploadToken: TokenProvider,
  start: number,
  body: Blob,
  total: number,
  isFinal: boolean
): Promise<UploadChunkResult> {
  let chunkStart = start;
  let chunkBody = body;
  let attempts = 0;
  let lastStatus: number | null = null;
  let hadRetry = false;
  const chunkStartedAt = nowMs();

  while (attempts < DRIVE_MAX_RETRIES) {
    attempts += 1;
    const token = await getUploadToken();
    const end = chunkStart + chunkBody.size - 1;

    let res: Response;
    try {
      res = await fetchWithTimeout(sessionUri, {
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
      const recovered = await recoverFromCommittedState(sessionUri, token, chunkStart, chunkBody, total);
      if (recovered.done) {
        return { nextStart: recovered.start, attempts, hadRetry, durationMs: roundMs(nowMs() - chunkStartedAt), status: lastStatus, sentBytes: body.size };
      }
      chunkStart = recovered.start;
      chunkBody = recovered.body;
      await delay(backoffMs(attempts));
      continue;
    }

    lastStatus = res.status;

    if (!isFinal && res.status === 308) {
      return { nextStart: chunkStart + chunkBody.size, attempts, hadRetry, durationMs: roundMs(nowMs() - chunkStartedAt), status: lastStatus, sentBytes: body.size };
    }
    if (isFinal && (res.status === 200 || res.status === 201)) {
      return { nextStart: total, attempts, hadRetry, durationMs: roundMs(nowMs() - chunkStartedAt), status: lastStatus, sentBytes: body.size };
    }
    if ((res.status === 401 || res.status === 403) && attempts < 2) {
      hadRetry = true;
      await getUploadToken({ refresh: true });
      continue;
    }
    if (res.status === 429 || res.status === 408 || res.status === 308 || (res.status >= 500 && res.status <= 599)) {
      hadRetry = true;
      const recovered = await recoverFromCommittedState(sessionUri, token, chunkStart, chunkBody, total);
      if (recovered.done) {
        return { nextStart: recovered.start, attempts, hadRetry, durationMs: roundMs(nowMs() - chunkStartedAt), status: lastStatus, sentBytes: body.size };
      }
      chunkStart = recovered.start;
      chunkBody = recovered.body;
      await delay(backoffMs(attempts));
      continue;
    }

    const detail = await readDriveErrorDetail(res);
    throw new Error(formatDriveError('Drive PUT failed', res.status, detail));
  }

  throw new Error(formatDriveError('Drive PUT failed after retries', lastStatus ?? 0, 'Transient failure persisted'));
}
