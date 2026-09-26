import { createIndexedDbKeyValueArea, type KeyValueArea } from '../offscreen/storage/indexedDbKeyValueArea';

const DRIVE_ORIGIN_PREFIX = 'shareDriveOrigin:';

export type ReusableDriveOrigin = {
  sourceRecordingId: string;
  sourceFileId: string;
  driveFileId: string;
  revisionId: string;
  bytes: number;
  mimeType: string;
  md5Checksum?: string;
  updatedAt: number;
};

export interface ShareDriveOriginRegistryStorageArea extends KeyValueArea {}

export class ShareDriveOriginRegistry {
  constructor(private readonly area: ShareDriveOriginRegistryStorageArea) {}

  async get(sourceRecordingId: string, sourceFileId: string): Promise<ReusableDriveOrigin | undefined> {
    const value = (await this.area.getAll())[registryKey(sourceRecordingId, sourceFileId)];
    return isReusableDriveOrigin(value) ? structuredClone(value) : undefined;
  }

  async put(origin: ReusableDriveOrigin): Promise<void> {
    await this.area.set({
      [registryKey(origin.sourceRecordingId, origin.sourceFileId)]: structuredClone(origin),
    });
  }

  async remove(sourceRecordingId: string, sourceFileId: string): Promise<void> {
    await this.area.remove(registryKey(sourceRecordingId, sourceFileId));
  }
}

function registryKey(sourceRecordingId: string, sourceFileId: string): string {
  return DRIVE_ORIGIN_PREFIX + encodeURIComponent(JSON.stringify([sourceRecordingId, sourceFileId]));
}

function isReusableDriveOrigin(value: unknown): value is ReusableDriveOrigin {
  if (!value || typeof value !== 'object') return false;
  const origin = value as ReusableDriveOrigin;
  return typeof origin.sourceRecordingId === 'string'
    && typeof origin.sourceFileId === 'string'
    && typeof origin.driveFileId === 'string'
    && typeof origin.revisionId === 'string'
    && !!origin.revisionId
    && Number.isSafeInteger(origin.bytes)
    && origin.bytes >= 0
    && typeof origin.mimeType === 'string'
    && (typeof origin.md5Checksum === 'undefined' || typeof origin.md5Checksum === 'string')
    && Number.isFinite(origin.updatedAt);
}

export const SHARE_DRIVE_ORIGIN_DATABASE = 'published-share-drive-origins';

export function createShareDriveOriginRegistry(): ShareDriveOriginRegistry {
  return new ShareDriveOriginRegistry(createIndexedDbKeyValueArea({
    databaseName: SHARE_DRIVE_ORIGIN_DATABASE,
    storeName: 'origins',
  }));
}
