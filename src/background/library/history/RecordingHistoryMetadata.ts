import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';
import type { RecordingHistoryRepositoryPort } from './RecordingHistoryRepository';

/** Focused mutable metadata operations for live recording-history entries. */
export class RecordingHistoryMetadata {
  constructor(
    private readonly repository: RecordingHistoryRepositoryPort,
    private readonly onChanged?: (recordingId: string) => void,
  ) {}

  async setDuration(id: string, durationMs: number | undefined): Promise<RecordingHistoryEntry | undefined> {
    if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
    const updated = await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      return { ...current, durationMs };
    });
    if (updated && !updated.deletedAt) this.onChanged?.(id);
    return updated?.deletedAt ? undefined : updated;
  }

  async setNote(id: string, note: string): Promise<RecordingHistoryEntry | undefined> {
    const normalized = note.trim();
    const updated = await this.repository.update(id, (current) => {
      if (!current || current.deletedAt) return current;
      return normalized
        ? { ...current, note: normalized }
        : { ...current, note: undefined };
    });
    if (updated && !updated.deletedAt) this.onChanged?.(id);
    return updated?.deletedAt ? undefined : updated;
  }

  async setDriveDestination(historyId: string, presetId: string | null): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const { driveFolderPresetId: _dropped, ...rest } = current;
      return presetId ? { ...rest, driveFolderPresetId: presetId } : rest;
    });
  }

  async setLocalFolder(historyId: string, folderName: string | undefined): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const { localFolderName: _dropped, ...rest } = current;
      return folderName ? { ...rest, localFolderName: folderName } : rest;
    });
  }
}
