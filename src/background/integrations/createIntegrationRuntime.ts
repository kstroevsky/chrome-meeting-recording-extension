import { createDestinationRuntime } from '../destinations/createDestinationRuntime';
import type { createLibraryRuntime } from '../library/createLibraryRuntime';
import { BackgroundIntegrationRuntime } from './BackgroundIntegrationRuntime';

/**
 * Builds the integration runtime over the canonical recording readers, plus
 * the "Save to" destinations owner and the routing port the recording
 * lifecycle uses.
 */
export function createIntegrationRuntime(library: ReturnType<typeof createLibraryRuntime>) {
  const integrations = new BackgroundIntegrationRuntime({
    listHistory: async () => (await library.historyRepository.listAllIncludingDeleted())
      .filter((entry) => !entry.deletedAt),
    getHistory: (recordingId) => library.historyRepository.get(recordingId),
    getContext: (recordingId) => library.recordingContexts.get(recordingId),
    listNotations: (recordingId) => library.notations.list(recordingId),
    getTranscript: (recordingId) => library.transcripts.get(recordingId),
    getAnalysisState: (recordingId) => library.analyses.exportState(recordingId),
  });
  return {
    integrations,
    ...createDestinationRuntime(integrations, (recordingId) => library.recordingContexts.get(recordingId)),
  };
}
