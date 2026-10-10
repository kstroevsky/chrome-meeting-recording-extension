import type {
  ArtifactLocation,
  RecordingHistoryEntry,
  RetainedMediaReleaseTarget,
} from '../../../shared/recordingHistory';
import { verifiedRetainedMediaReleaseTargets } from '../../../shared/recordingHistory';
import type { RecordingHistoryRepositoryPort } from './RecordingHistoryRepository';

type DeleteRetainedMedia = (
  keys: string[],
  historyId: string,
) => Promise<void | 'deleted' | 'deferred'>;

/** Owns durable release intent after external playback has been verified. */
export class VerifiedRetainedMediaRelease {
  constructor(
    private readonly repository: RecordingHistoryRepositoryPort,
    private readonly now: () => number,
    private readonly deleteRetainedMedia?: DeleteRetainedMedia,
    private readonly warnCleanup: (message: string, error: unknown) => void = () => {},
    private readonly onChanged?: (recordingId: string) => void,
  ) {}

  async plan(historyId: string): Promise<RetainedMediaReleaseTarget[]> {
    const entry = await this.repository.get(historyId);
    return entry && !entry.deletedAt ? verifiedRetainedMediaReleaseTargets(entry) : [];
  }

  async markReleased(
    historyId: string,
    expected: readonly RetainedMediaReleaseTarget[],
  ): Promise<{ entry?: RecordingHistoryEntry; released: RetainedMediaReleaseTarget[] }> {
    const expectedKeys = new Set(expected.map((target) => `${target.fileId}\u0000${target.key}`));
    const released: RetainedMediaReleaseTarget[] = [];
    const updated = await this.repository.update(historyId, (current) => {
      if (!current || current.deletedAt) return current;
      const files = current.files.map((file) => {
        if (file.kind || !file.locations.some((location) =>
          location.kind === 'external' && location.playbackVerifiedAt != null)) return file;
        const releasedKeys = file.locations
          .filter((location): location is Extract<ArtifactLocation, { kind: 'opfs' }> =>
            location.kind === 'opfs' && expectedKeys.has(`${file.id}\u0000${location.key}`));
        if (!releasedKeys.length) return file;
        const releasedAt = this.now();
        const markerByKey = new Map((file.releasedRetainedMedia ?? []).map((marker) => [marker.key, marker]));
        for (const location of releasedKeys) {
          markerByKey.set(location.key, { key: location.key, releasedAt });
          released.push({ fileId: file.id, key: location.key, ...(file.bytes != null ? { bytes: file.bytes } : {}) });
        }
        return {
          ...file,
          locations: file.locations.filter((location) =>
            location.kind !== 'opfs' || !releasedKeys.some((releasedLocation) => releasedLocation.key === location.key)),
          releasedRetainedMedia: [...markerByKey.values()],
        };
      });
      return released.length ? { ...current, files } : current;
    });
    if (released.length) this.onChanged?.(historyId);
    return { ...(updated && !updated.deletedAt ? { entry: updated } : {}), released };
  }

  async deleteReleased(
    historyId: string,
    targets: readonly RetainedMediaReleaseTarget[],
  ): Promise<'deleted' | 'deferred' | 'pending'> {
    if (!targets.length) return 'deleted';
    if (!this.deleteRetainedMedia) return 'pending';
    try {
      const disposition = await this.deleteRetainedMedia(targets.map((target) => target.key), historyId);
      return disposition === 'deferred' ? 'deferred' : 'deleted';
    } catch (error) {
      this.warnCleanup(`Could not free retained media for recording ${historyId}:`, error);
      return 'pending';
    }
  }
}
