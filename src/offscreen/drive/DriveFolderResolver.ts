/**
 * @file offscreen/drive/DriveFolderResolver.ts
 *
 * Resolves and creates Google Drive folder hierarchy for uploads:
 *   rootFolderName / destinationFolderName / recordingFolderName
 *
 * This is extracted from DriveTarget so upload streaming logic remains focused
 * on resumable session creation and chunk flushing.
 */
import { DRIVE_FILES_URL, DRIVE_FOLDER_MIME } from './constants';
import { formatDriveError, readDriveErrorDetail } from './errors';
import { fetchWithAuthRetry, fetchWithTimeout, type TokenProvider } from './request';

export type DriveFolderHierarchy = {
  rootFolderName?: string;
  /**
   * The destination inside the root that holds this recording's folder. Every
   * upload lands in the default one; filing later moves the folder to another.
   * Absent leaves the recording's folder directly in the root, which only the
   * paths that predate destinations do.
   */
  destinationFolderName?: string;
  recordingFolderName?: string;
};

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class DriveFolderResolver {
  private static recordingFolderCache = new Map<string, SharedAbortableFlight<string>>();
  private resolvedUploadParentId: string | null = null;
  private resolvedUploadParentFlight: SharedAbortableFlight<string | null> | null = null;

  constructor(private readonly getToken: TokenProvider) {}

  async resolveUploadParentId(hierarchy: DriveFolderHierarchy, signal?: AbortSignal): Promise<string | null> {
    if (this.resolvedUploadParentId) return this.resolvedUploadParentId;
    if (signal?.aborted) throw abortError();
    if (!this.resolvedUploadParentFlight) {
      const flight = new SharedAbortableFlight(async (setupSignal) => {
        const rootFolderName = hierarchy.rootFolderName?.trim();
        if (!rootFolderName) return null;

        const rootFolderId = await this.getOrCreateFolder(rootFolderName, null, setupSignal);
        // The destination sits between the root and the recording, so the root
        // holds folders and never loose files.
        const destinationFolderName = hierarchy.destinationFolderName?.trim();
        const parentId = destinationFolderName
          ? await this.getOrCreateFolder(destinationFolderName, rootFolderId, setupSignal)
          : rootFolderId;

        const recordingFolderName = hierarchy.recordingFolderName?.trim();
        if (!recordingFolderName) {
          this.resolvedUploadParentId = parentId;
          return parentId;
        }

        // Keyed by the folder it goes in, not by the root: two destinations may
        // each hold a recording folder of the same name.
        const cacheKey = `${parentId}:${recordingFolderName}`;
        let folderFlight = DriveFolderResolver.recordingFolderCache.get(cacheKey);
        if (!folderFlight) {
          folderFlight = new SharedAbortableFlight((folderSignal) =>
            this.getOrCreateFolder(recordingFolderName, parentId, folderSignal)
          );
          DriveFolderResolver.recordingFolderCache.set(cacheKey, folderFlight);
          void folderFlight.promise.catch(() => {
            if (DriveFolderResolver.recordingFolderCache.get(cacheKey) === folderFlight) {
              DriveFolderResolver.recordingFolderCache.delete(cacheKey);
            }
          });
        }
        this.resolvedUploadParentId = await folderFlight.join(setupSignal);
        return this.resolvedUploadParentId;
      });
      this.resolvedUploadParentFlight = flight;
      void flight.promise.then(
        () => { if (this.resolvedUploadParentFlight === flight) this.resolvedUploadParentFlight = null; },
        () => { if (this.resolvedUploadParentFlight === flight) this.resolvedUploadParentFlight = null; },
      );
    }
    return await this.resolvedUploadParentFlight.join(signal);
  }

  private async getOrCreateFolder(name: string, parentId: string | null, signal?: AbortSignal): Promise<string> {
    const existingId = await this.findFolder(name, parentId, signal);
    if (existingId) return existingId;
    return await this.createFolder(name, parentId, signal);
  }

  private async findFolder(name: string, parentId: string | null, signal?: AbortSignal): Promise<string | null> {
    const parts = [
      `mimeType='${DRIVE_FOLDER_MIME}'`,
      `name='${escapeDriveQueryLiteral(name)}'`,
      'trashed=false',
    ];
    if (parentId) {
      parts.push(`'${escapeDriveQueryLiteral(parentId)}' in parents`);
    }
    const q = encodeURIComponent(parts.join(' and '));
    const url = `${DRIVE_FILES_URL}&q=${q}&fields=files(id,name)&spaces=drive&includeItemsFromAllDrives=true&pageSize=1`;

    const res = await fetchWithAuthRetry(this.getToken, (token) =>
      fetchWithTimeout(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }, signal)
    );

    if (!res.ok) {
      const detail = await readDriveErrorDetail(res);
      throw new Error(formatDriveError('Drive folder lookup failed', res.status, detail));
    }

    const json = await res.json().catch(() => ({} as any));
    const id = json?.files?.[0]?.id;
    return typeof id === 'string' ? id : null;
  }

  private async createFolder(name: string, parentId: string | null, signal?: AbortSignal): Promise<string> {
    const body: Record<string, any> = {
      name,
      mimeType: DRIVE_FOLDER_MIME,
    };
    if (parentId) body.parents = [parentId];

    const res = await fetchWithAuthRetry(this.getToken, (token) =>
      fetchWithTimeout(DRIVE_FILES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }, signal)
    );

    if (!res.ok) {
      const detail = await readDriveErrorDetail(res);
      throw new Error(formatDriveError('Drive folder create failed', res.status, detail));
    }

    const json = await res.json().catch(() => ({} as any));
    const id = json?.id;
    if (typeof id === 'string' && id) return id;
    throw new Error('Drive folder create succeeded but returned no folder id');
  }
}

/**
 * Shares one setup request without sacrificing cancellation. A caller that aborts
 * stops waiting immediately; the actual Drive request is aborted only after its
 * final cancelable consumer leaves, so one canceled upload cannot poison another.
 */
class SharedAbortableFlight<T> {
  private readonly controller = new AbortController();
  private cancelableConsumers = 0;
  private hasNonCancelableConsumer = false;
  private settled = false;
  readonly promise: Promise<T>;

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal);
    void this.promise.then(
      () => { this.settled = true; },
      () => { this.settled = true; },
    );
  }

  join(signal?: AbortSignal): Promise<T> {
    if (!signal) {
      this.hasNonCancelableConsumer = true;
      return this.promise;
    }
    if (signal.aborted) return Promise.reject(abortError());

    this.cancelableConsumers += 1;
    return new Promise<T>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.cancelableConsumers -= 1;
        if (!this.settled && !this.hasNonCancelableConsumer && this.cancelableConsumers === 0) {
          this.controller.abort();
        }
      };
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        release();
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          release();
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          release();
          reject(error);
        },
      );
    });
  }
}

function abortError(): DOMException {
  return new DOMException('Upload canceled', 'AbortError');
}
