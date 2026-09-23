import {
  buildRenamedRecordingFilename,
  slugifyRecordingTitle,
} from '../../../shared/recording';
import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';
import type { RecordingHistoryRepositoryPort } from './RecordingHistoryRepository';

type DriveRenameResource = { id: string; name: string };
export type DriveRenameResult = {
  ok: boolean;
  resources?: DriveRenameResource[];
  error?: string;
  rollbackIncomplete?: boolean;
};
export type DriveRecordingRenamer = (
  resources: DriveRenameResource[],
) => Promise<DriveRenameResult>;

export class RecordingRename {
  constructor(
    private readonly repository: RecordingHistoryRepositoryPort,
    private readonly renameDriveResources?: DriveRecordingRenamer,
  ) {}

  async rename(id: string, name: string): Promise<RecordingHistoryEntry | undefined> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Recording name cannot be blank');
    const slug = slugifyRecordingTitle(trimmed);
    if (!slug) throw new Error('Recording name must contain at least one letter or number');
    const current = await this.repository.get(id);
    if (!current || current.deletedAt) return undefined;

    const remoteTargets = this.buildDriveRenameTargets(current, trimmed, slug);
    const renamedFileIds = new Set(
      remoteTargets?.slice(0, -1).map((target) => target.id) ?? [],
    );
    if (remoteTargets) {
      if (!this.renameDriveResources) throw new Error('Drive rename is unavailable');
      const result = await this.renameDriveResources(remoteTargets);
      if (!result.ok) {
        if (result.rollbackIncomplete && result.resources?.length) {
          await this.syncObservedDriveNames(id, result.resources);
        }
        throw new Error(result.error || 'Could not rename the recording in Google Drive');
      }
    }

    const updated = await this.repository.update(id, (entry) => {
      if (!entry || entry.deletedAt) return entry;
      const files = remoteTargets
        ? entry.files.map((file) => file.driveFileId && renamedFileIds.has(file.driveFileId)
          ? {
              ...file,
              filename: buildRenamedRecordingFilename(
                trimmed,
                file.stream,
                file.filename,
                file.kind,
              ),
            }
          : file)
        : entry.files;
      return {
        ...entry,
        name: trimmed,
        userNamed: true as const,
        files,
        ...(remoteTargets ? { driveFolderName: slug } : {}),
      };
    });
    return updated?.deletedAt ? undefined : updated;
  }

  private buildDriveRenameTargets(
    entry: RecordingHistoryEntry,
    title: string,
    slug: string,
  ): DriveRenameResource[] | null {
    if (entry.storageMode !== 'drive' || !entry.driveFolderId) return null;
    const remoteFiles = entry.files.filter(
      (file) => file.destination === 'drive' && file.status === 'available',
    );
    if (remoteFiles.some((file) => !file.driveFileId)) {
      throw new Error(
        'This Drive recording is missing the metadata needed to rename all uploaded files',
      );
    }
    const claims = new Map<string, number>();
    for (const file of remoteFiles) {
      claims.set(file.driveFileId!, (claims.get(file.driveFileId!) ?? 0) + 1);
    }
    const unambiguous = remoteFiles.filter(
      (file) => claims.get(file.driveFileId!) === 1,
    );
    return [
      ...unambiguous.map((file) => ({
        id: file.driveFileId!,
        name: buildRenamedRecordingFilename(title, file.stream, file.filename, file.kind),
      })),
      { id: entry.driveFolderId, name: slug },
    ];
  }

  private async syncObservedDriveNames(
    id: string,
    resources: DriveRenameResource[],
  ): Promise<void> {
    const byId = new Map(resources.map((resource) => [resource.id, resource.name]));
    await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      return {
        ...current,
        files: current.files.map((file) => file.driveFileId && byId.has(file.driveFileId)
          ? { ...file, filename: byId.get(file.driveFileId)! }
          : file),
        ...(current.driveFolderId && byId.has(current.driveFolderId)
          ? { driveFolderName: byId.get(current.driveFolderId)! }
          : {}),
      };
    });
  }
}
