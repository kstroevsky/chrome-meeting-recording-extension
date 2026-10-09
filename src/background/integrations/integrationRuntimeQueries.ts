import type { IntegrationRecordingOption } from '../../integrations/contracts';
import type { IntegrationDestination } from '../../integrations/persistence';
import type { RecordingContext } from '../../shared/recordingContext';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';

type RecordingReaders = {
  listHistory(): Promise<RecordingHistoryEntry[]>;
  getContext(recordingId: string): Promise<RecordingContext | undefined>;
};

export async function listIntegrationRecordings(
  readers: RecordingReaders,
): Promise<IntegrationRecordingOption[]> {
  const entries = await readers.listHistory();
  return Promise.all(entries.map(async (entry) => {
    const context = await readers.getContext(entry.id);
    return context
      ? { id: entry.id, name: entry.name, available: true }
      : {
          id: entry.id,
          name: entry.name,
          available: false,
          unavailableReason: 'missing-recording-context' as const,
        };
  }));
}

export async function integrationDisconnectImpact(
  listDestinations: () => Promise<IntegrationDestination[]>,
  listHistory: () => Promise<RecordingHistoryEntry[]>,
  destinationId: string,
): Promise<{ affectedRecordings: number }> {
  if (!(await listDestinations()).some((destination) => destination.id === destinationId)) {
    throw new Error('Integration destination does not exist');
  }
  return {
    affectedRecordings: countExternalPlaybackRecordings(await listHistory(), destinationId),
  };
}

/** Unique live recordings whose canonical history owns a replica at this receiver. */
export function countExternalPlaybackRecordings(
  entries: readonly RecordingHistoryEntry[],
  destinationId: string,
): number {
  return entries.filter((entry) => !entry.deletedAt && entry.files.some((file) =>
    file.locations.some((location) =>
      location.kind === 'external' && location.destinationId === destinationId))).length;
}
