/**
 * @file offscreen/DriveTarget.ts
 *
 * Uploads a fully sealed local recording file to Google Drive using the
 * resumable upload protocol. Recording itself never writes to Drive directly.
 */

import { DRIVE_UPLOAD_URL } from './drive/constants';
import { type DriveFolderHierarchy, DriveFolderResolver } from './drive/DriveFolderResolver';
import { formatDriveError, readDriveErrorDetail } from './drive/errors';
import { fetchWithAuthRetry, type TokenProvider } from './drive/request';

const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
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
  return RETRY_BASE_DELAY_MS * Math.min(8, 2 ** Math.max(0, attempt - 1));
}

export type DriveTargetOptions = DriveFolderHierarchy;

export class DriveTarget {
  private sessionUri: string | null = null;
  private readonly folderResolver: DriveFolderResolver;
  private used = false;

  constructor(
    private readonly filename: string,
    private readonly getToken: TokenProvider,
    private readonly onDone: (filename: string) => void,
    private readonly options: DriveTargetOptions = {}
  ) {
    this.folderResolver = new DriveFolderResolver(getToken);
  }

  async upload(file: Blob): Promise<void> {
    if (this.used) throw new Error('Drive target already used');
    this.used = true;
    if (file.size === 0) return;

    await this.initSession();

    const total = file.size;
    let start = 0;

    while (start < total) {
      const endExclusive = Math.min(start + UPLOAD_CHUNK_BYTES, total);
      const body = file.slice(start, endExclusive, 'video/webm');
      const isFinal = endExclusive >= total;
      start = await this.uploadChunk(start, body, total, isFinal);
    }

    this.onDone(this.filename);
  }

  private async initSession(): Promise<void> {
    const parentFolderId = await this.folderResolver.resolveUploadParentId(this.options);
    const metadata: Record<string, any> = {
      name: this.filename,
      mimeType: 'video/webm',
    };
    if (parentFolderId) metadata.parents = [parentFolderId];

    const res = await fetchWithAuthRetry(this.getToken, (token) =>
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

  private async uploadChunk(start: number, body: Blob, total: number, isFinal: boolean): Promise<number> {
    let chunkStart = start;
    let chunkBody = body;
    let attempts = 0;
    let lastStatus: number | null = null;

    while (attempts < MAX_RETRIES) {
      attempts += 1;
      const token = await this.getToken();
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
        const recovered = await this.recoverFromCommittedState(token, chunkStart, chunkBody, total);
        if (recovered.done) return recovered.start;
        chunkStart = recovered.start;
        chunkBody = recovered.body;
        await delay(backoffMs(attempts));
        continue;
      }

      lastStatus = res.status;

      if (!isFinal && res.status === 308) {
        return chunkStart + chunkBody.size;
      }

      if (isFinal && (res.status === 200 || res.status === 201)) {
        return total;
      }

      if ((res.status === 401 || res.status === 403) && attempts < 2) {
        continue;
      }

      if (
        res.status === 429 ||
        res.status === 408 ||
        res.status === 308 ||
        (res.status >= 500 && res.status <= 599)
      ) {
        const recovered = await this.recoverFromCommittedState(token, chunkStart, chunkBody, total);
        if (recovered.done) return recovered.start;
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
