import type { DownloadSettledResult } from '../../../platform/chrome/downloads';
import type {
  RecordingArtifactKind,
  RecordingStream,
} from '../../../shared/recording';
import {
  upsertArtifactLocation,
  type ArtifactDelivery,
  type ArtifactLocation,
  type RecordingHistoryFile,
} from '../../../shared/recordingHistory';
import type { RecordingHistoryRepositoryPort } from './RecordingHistoryRepository';
import { summarizeHistoryFiles } from './RecordingHistoryState';

/** Owns history mutations caused by local-download delivery outcomes. */
export class LocalDeliveryHistory {
  constructor(private readonly repository: RecordingHistoryRepositoryPort) {}

  async localSaveSettled(
    historyId: string,
    stream: RecordingStream,
    downloadId: number | undefined,
    settled: DownloadSettledResult,
    error?: string,
    kind?: RecordingArtifactKind,
  ): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const status: RecordingHistoryFile['status'] = settled === 'complete'
        ? 'available'
        : 'unavailable';
      const files = current.files.map((file) => {
        if (file.stream !== stream || (file.kind ?? null) !== (kind ?? null)) return file;
        const failure = error
          ?? (status === 'unavailable' ? `Download ${settled}` : undefined);
        const delivery: ArtifactDelivery = settled === 'complete'
          ? {
              requested: file.delivery.requested,
              status: file.delivery.requested === 'drive'
                ? 'local-fallback'
                : 'downloaded',
            }
          : {
              requested: file.delivery.requested,
              status: 'failed',
              ...(failure ? { error: failure } : {}),
            };
        return {
          ...file,
          destination: 'local' as const,
          status,
          downloadId,
          error: failure,
          locations: settled === 'complete' && downloadId != null
            ? upsertArtifactLocation(file.locations, { kind: 'download', downloadId })
            : file.locations,
          delivery,
        };
      });
      return { ...current, files, status: summarizeHistoryFiles(files) };
    });
  }

  async recordArtifactLocation(
    historyId: string,
    fileId: string,
    location: ArtifactLocation,
  ): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const files = current.files.map((file) => file.id === fileId
        ? { ...file, locations: upsertArtifactLocation(file.locations, location) }
        : file);
      return { ...current, files };
    });
  }

  async dropArtifactLocation(
    historyId: string,
    fileId: string,
    key: string,
  ): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const files = current.files.map((file) => file.id === fileId
        ? {
            ...file,
            locations: file.locations.filter(
              (location) => !(location.kind === 'opfs' && location.key === key),
            ),
          }
        : file);
      return { ...current, files };
    });
  }
}
