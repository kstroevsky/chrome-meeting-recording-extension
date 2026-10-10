import type { RecordingNotation } from '../../shared/notations';
import type { RecordingContext } from '../../shared/recordingContext';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import type { Transcript } from '../../shared/transcript';
import type { AnalysisExportState } from '../library/analysis/RecordingAnalysisService';

export type CanonicalRecordingReaders = {
  listHistory(): Promise<RecordingHistoryEntry[]>;
  getHistory(recordingId: string): Promise<RecordingHistoryEntry | undefined>;
  getContext(recordingId: string): Promise<RecordingContext | undefined>;
  listNotations(recordingId: string): Promise<RecordingNotation[]>;
  getTranscript(recordingId: string): Promise<Transcript | undefined>;
  getAnalysisState(recordingId: string): Promise<AnalysisExportState>;
};

export async function considerRecordingDestinations(
  destinations: readonly { destinationId: string }[],
  consider: (destinationId: string) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    destinations.map(({ destinationId }) => consider(destinationId)),
  );
  for (const result of results) {
    if (result.status === 'rejected') console.warn('[integrations] recording consideration failed:', result.reason);
  }
}
