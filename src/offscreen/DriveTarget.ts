/**
 * @file offscreen/DriveTarget.ts
 *
 * StorageTarget implementation that streams MediaRecorder chunks directly into
 * Google Drive using the Drive "resumable upload" protocol.
 *
 * Responsibilities:
 *   1) Resolve upload parent folder hierarchy (if configured).
 *   2) Open a resumable upload session.
 *   3) Flush chunks with bounded memory and retry rules.
 *
 * @see src/offscreen/drive/DriveFolderResolver.ts — folder lookup/create logic
 * @see src/offscreen/RecorderEngine.ts            — StorageTarget interface
 */
import type { StorageTarget } from './RecorderEngine';
import { DRIVE_UPLOAD_URL } from './drive/constants';
import { type DriveFolderHierarchy, DriveFolderResolver } from './drive/DriveFolderResolver';
import { formatDriveError, readDriveErrorDetail } from './drive/errors';
import { fetchWithAuthRetry, type TokenProvider } from './drive/request';

const FLUSH_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MB

export type DriveTargetOptions = DriveFolderHierarchy;

export class DriveTarget implements StorageTarget {
  private sessionUri: string | null = null;
  private uploadedBytes = 0;
  private pending: Blob[] = [];
  private pendingSize = 0;
  private readonly folderResolver: DriveFolderResolver;

  constructor(
    private readonly filename: string,
    /** Callback to get a fresh OAuth token. Background calls chrome.identity.getAuthToken(). */
    private readonly getToken: TokenProvider,
    /** Callback when the file is successfully uploaded and finalized. */
    private readonly onDone: (filename: string) => void,
    private readonly options: DriveTargetOptions = {}
  ) {
    this.folderResolver = new DriveFolderResolver(getToken);
  }

  async write(chunk: Blob): Promise<void> {
    if (!this.sessionUri) await this.initSession();
    this.pending.push(chunk);
    this.pendingSize += chunk.size;

    if (this.pendingSize >= FLUSH_THRESHOLD_BYTES) {
      await this.flush(false);
    }
  }

  async close(): Promise<void> {
    if (!this.sessionUri && this.pendingSize === 0) return;
    await this.flush(true);
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
      fetch(DRIVE_UPLOAD_URL, {
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

  private async flush(isFinal: boolean): Promise<void> {
    if (!this.pending.length && !isFinal) return;

    const body = new Blob(this.pending);
    const start = this.uploadedBytes;

    // Finalize an already-emptied upload by querying commit state.
    if (body.size === 0 && isFinal) {
      const res = await fetchWithAuthRetry(this.getToken, (token) =>
        fetch(this.sessionUri!, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Range': `bytes */${this.uploadedBytes}`,
          },
        })
      );
      if (res.status === 200 || res.status === 201) return;
      const detail = await readDriveErrorDetail(res);
      throw new Error(formatDriveError('Final empty Drive PUT failed', res.status, detail));
    }

    const end = start + body.size - 1;
    const total = isFinal ? String(start + body.size) : '*';

    let attempts = 0;
    while (attempts < 2) {
      attempts++;
      const token = await this.getToken();
      const res = await fetch(this.sessionUri!, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Type': 'video/webm',
        },
        body,
      });

      if (!isFinal && res.status === 308) {
        this.uploadedBytes += body.size;
        this.pending = [];
        this.pendingSize = 0;
        return;
      }

      if (isFinal && (res.status === 200 || res.status === 201)) {
        this.pending = [];
        this.pendingSize = 0;
        return;
      }

      if ((res.status === 401 || res.status === 403) && attempts < 2) {
        continue;
      }

      if (res.status === 503 || res.status === 500) {
        const committedRes = await fetch(this.sessionUri!, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Range': `bytes */${isFinal ? start + body.size : '*'}`,
          },
        });
        const range = committedRes.headers.get('Range');
        if (range) {
          const committed = parseInt(range.split('-')[1]) + 1;
          this.uploadedBytes = committed;
        }
        continue;
      }

      const detail = await readDriveErrorDetail(res);
      throw new Error(formatDriveError('Drive PUT failed', res.status, detail));
    }
  }
}
