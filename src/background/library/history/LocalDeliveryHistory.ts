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
    retryable = false,
  ): Promise<void> {
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      if (settled === 'timeout' || (settled === 'interrupted' && retryable)) {
        const files = current.files.map((file) => {
          if (file.stream !== stream || (file.kind ?? null) !== (kind ?? null)) return file;
          const failure = settled === 'interrupted'
            ? error ?? 'Download interrupted'
            : error;
          return {
            ...file,
            destination: 'local' as const,
            ...(downloadId != null ? { downloadId } : {}),
            status: 'pending' as const,
            error: failure,
            delivery: {
              requested: file.delivery.requested,
              status: 'pending' as const,
              ...(failure ? { error: failure } : {}),
            },
          };
        });
        return { ...current, files, status: summarizeHistoryFiles(files) };
      }
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
              status: file.delivery.requested === 'local' ? 'downloaded' : 'local-fallback',
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
      const files = current.files.map((file) => {
        if (file.id !== fileId) return file;
        const requested = file.delivery.requested;
        const externalPrimary = typeof requested === 'object' && requested.kind === 'external';
        const completesPrimary = externalPrimary && location.kind === 'external'
          && requested.destinationId === location.destinationId;
        const retainedPrimary = externalPrimary && location.kind === 'opfs';
        return {
          ...file,
          ...(retainedPrimary || completesPrimary ? { status: 'available' as const, error: undefined } : {}),
          locations: upsertArtifactLocation(file.locations, location),
          ...(completesPrimary ? {
            delivery: { requested, status: 'uploaded' as const },
          } : {}),
        };
      });
      return { ...current, files, status: summarizeHistoryFiles(files) };
    });
  }

  async setExternalDeliveryState(
    historyId: string,
    fileId: string,
    destinationId: string,
    status: 'pending' | 'failed',
    error?: string,
  ): Promise<boolean> {
    let changed = false;
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const files = current.files.map((file) => {
        if (file.id !== fileId) return file;
        const requested = file.delivery.requested;
        if (typeof requested !== 'object' || requested.kind !== 'external'
            || requested.destinationId !== destinationId || file.delivery.status === 'uploaded') return file;
        const normalizedError = error?.trim() || undefined;
        if (file.delivery.status === status && file.delivery.error === normalizedError) return file;
        changed = true;
        return {
          ...file,
          delivery: {
            requested,
            status,
            ...(normalizedError ? { error: normalizedError } : {}),
          },
        };
      });
      return changed ? { ...current, files } : current;
    });
    return changed;
  }

  async replaceExternalPrimaryDestination(
    historyId: string,
    fromDestinationId: string,
    toDestinationId: string,
  ): Promise<boolean> {
    let changed = false;
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const files = current.files.map((file) => {
        if (file.kind) return file;
        const requested = file.delivery.requested;
        if (typeof requested !== 'object' || requested.kind !== 'external'
            || requested.destinationId !== fromDestinationId) return file;
        const nextRequested = { kind: 'external' as const, destinationId: toDestinationId };
        const alreadyOwned = file.locations.some((location) =>
          location.kind === 'external' && location.destinationId === toDestinationId);
        changed = true;
        return {
          ...file,
          error: undefined,
          delivery: {
            requested: nextRequested,
            status: alreadyOwned ? 'uploaded' as const : 'pending' as const,
          },
        };
      });
      return changed ? { ...current, files } : current;
    });
    return changed;
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

  async markExternalPlaybackVerified(
    historyId: string,
    fileId: string,
    destinationId: string,
    artifactId: string,
    verifiedAt: number,
  ): Promise<boolean> {
    let verified = false;
    await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const files = current.files.map((file) => {
        if (file.id !== fileId) return file;
        const locations = file.locations.map((location) => {
          if (location.kind !== 'external' || location.destinationId !== destinationId
              || location.artifactId !== artifactId) return location;
          verified = true;
          return location.playbackVerifiedAt != null
            ? location
            : { ...location, playbackVerifiedAt: verifiedAt };
        });
        return verified ? { ...file, locations } : file;
      });
      return verified ? { ...current, files } : current;
    });
    return verified;
  }
}
