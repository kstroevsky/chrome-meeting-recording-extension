/**
 * @file offscreen/drive/DriveFolderResolver.ts
 *
 * Resolves and creates Google Drive folder hierarchy for uploads:
 *   rootFolderName / recordingFolderName
 *
 * This is extracted from DriveTarget so upload streaming logic remains focused
 * on resumable session creation and chunk flushing.
 */
import { DRIVE_FILES_URL, DRIVE_FOLDER_MIME } from './constants';
import { formatDriveError, readDriveErrorDetail } from './errors';
import { fetchWithAuthRetry, type TokenProvider } from './request';

export type DriveFolderHierarchy = {
  rootFolderName?: string;
  recordingFolderName?: string;
};

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class DriveFolderResolver {
  private static recordingFolderCache = new Map<string, Promise<string>>();
  private resolvedUploadParentId: string | null = null;
  private resolvedUploadParentPromise: Promise<string | null> | null = null;

  constructor(private readonly getToken: TokenProvider) {}

  async resolveUploadParentId(hierarchy: DriveFolderHierarchy): Promise<string | null> {
    if (this.resolvedUploadParentId) return this.resolvedUploadParentId;
    if (this.resolvedUploadParentPromise) return await this.resolvedUploadParentPromise;

    this.resolvedUploadParentPromise = (async () => {
      const rootFolderName = hierarchy.rootFolderName?.trim();
      if (!rootFolderName) return null;

      const rootFolderId = await this.getOrCreateFolder(rootFolderName, null);
      const recordingFolderName = hierarchy.recordingFolderName?.trim();
      if (!recordingFolderName) {
        this.resolvedUploadParentId = rootFolderId;
        return rootFolderId;
      }

    const cacheKey = `${rootFolderId}:${recordingFolderName}`;
    let folderPromise = DriveFolderResolver.recordingFolderCache.get(cacheKey);
    if (!folderPromise) {
      folderPromise = this.getOrCreateFolder(recordingFolderName, rootFolderId).catch((error) => {
        DriveFolderResolver.recordingFolderCache.delete(cacheKey);
        throw error;
      });
      DriveFolderResolver.recordingFolderCache.set(cacheKey, folderPromise);
    }
      this.resolvedUploadParentId = await folderPromise;
      return this.resolvedUploadParentId;
    })();

    try {
      return await this.resolvedUploadParentPromise;
    } finally {
      this.resolvedUploadParentPromise = null;
    }
  }

  private async getOrCreateFolder(name: string, parentId: string | null): Promise<string> {
    const existingId = await this.findFolder(name, parentId);
    if (existingId) return existingId;
    return await this.createFolder(name, parentId);
  }

  private async findFolder(name: string, parentId: string | null): Promise<string | null> {
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
      fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    if (!res.ok) {
      const detail = await readDriveErrorDetail(res);
      throw new Error(formatDriveError('Drive folder lookup failed', res.status, detail));
    }

    const json = await res.json().catch(() => ({} as any));
    const id = json?.files?.[0]?.id;
    return typeof id === 'string' ? id : null;
  }

  private async createFolder(name: string, parentId: string | null): Promise<string> {
    const body: Record<string, any> = {
      name,
      mimeType: DRIVE_FOLDER_MIME,
    };
    if (parentId) body.parents = [parentId];

    const res = await fetchWithAuthRetry(this.getToken, (token) =>
      fetch(DRIVE_FILES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
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
