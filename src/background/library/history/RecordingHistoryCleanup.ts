import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';
import type { RecordingHistoryRepositoryPort } from './RecordingHistoryRepository';

type DeleteRetainedMedia = (
  keys: string[],
  historyId: string,
) => Promise<void | 'deleted' | 'deferred'>;

/** Completes dependent and OPFS cleanup for tombstoned history entries. */
export class RecordingHistoryCleanup {
  constructor(
    private readonly repository: RecordingHistoryRepositoryPort,
    private readonly onRemoved?: (id: string) => Promise<void>,
    private readonly deleteRetainedMedia?: DeleteRetainedMedia,
    private readonly warnCleanup: (message: string, error: unknown) => void = () => {},
  ) {}

  async cleanupDeletedEntry(id: string, knownEntry?: RecordingHistoryEntry): Promise<void> {
    const entry = knownEntry ?? await this.repository.get(id);
    if (!entry?.deletedAt || !entry.cleanupPending) return;
    const retainedKeys = entry.files.flatMap((file) => file.locations
      .filter((location) => location.kind === 'opfs')
      .map((location) => location.key));
    const work: Array<{ label: string; run: () => Promise<void> }> = [];
    if (this.onRemoved) work.push({ label: 'dependent data', run: () => this.onRemoved!(id) });
    if (retainedKeys.length && this.deleteRetainedMedia) {
      work.push({
        label: 'retained media',
        run: async () => { await this.deleteRetainedMedia!(retainedKeys, id); },
      });
    }

    const results = await Promise.allSettled(work.map(({ run }) => run()));
    const failures = results.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [];
      const label = work[index]?.label ?? 'cleanup';
      this.warnCleanup(`Could not clean up recording ${id} ${label}:`, result.reason);
      return [result.reason];
    });
    if (failures.length) throw failures[0];

    await this.repository.update(id, (current) => {
      if (!current?.deletedAt || !current.cleanupPending) return current;
      const { cleanupPending: _completed, ...rest } = current;
      return rest;
    });
  }
}
