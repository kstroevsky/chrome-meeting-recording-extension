import { openDownloadedFile } from '../../platform/chrome/downloads';
import { CANDIDATE_ANALYSIS_CONFIG } from '../../shared/analysis/candidateConfig';
import { packagedModel } from '../../shared/analysis/packagedModel';
import { hashAnalysisConfig, PIPELINE_VERSION } from '../../shared/analysis/provenance';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { PlaybackLeaseManager } from '../playback/PlaybackLeaseManager';
import { RecordingPlaybackService } from '../playback/RecordingPlaybackService';
import { RecordingAnalysisCoordinator } from './analysis/RecordingAnalysisCoordinator';
import { RecordingAnalysisRepository } from './analysis/RecordingAnalysisRepository';
import { RecordingAnalysisService } from './analysis/RecordingAnalysisService';
import { RecordingContextRepository } from './context/RecordingContextRepository';
import { RecordingContextService } from './context/RecordingContextService';
import { RecordingHistoryRepository } from './history/RecordingHistoryRepository';
import { RecordingHistoryService } from './history/RecordingHistoryService';
import { RecordingNotationRepository } from './notations/RecordingNotationRepository';
import { RecordingNotationService } from './notations/RecordingNotationService';
import { RecordingTranscriptRepository } from './transcript/RecordingTranscriptRepository';
import { RecordingTranscriptService } from './transcript/RecordingTranscriptService';

type Logger = {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
};

type LibraryRuntimeDeps = {
  offscreen: OffscreenManager;
  playbackLeases: PlaybackLeaseManager;
  logger: Logger;
  onAnalysisSettled?: () => void;
  onIntegrationChanged?: (recordingId: string) => void;
};

/** Constructs durable library aggregates and wires their offscreen analysis boundary. */
export function createLibraryRuntime({
  offscreen,
  playbackLeases,
  logger,
  onAnalysisSettled,
  onIntegrationChanged,
}: LibraryRuntimeDeps) {
  const historyRepository = new RecordingHistoryRepository();
  const recordingContexts = new RecordingContextService(new RecordingContextRepository(), onIntegrationChanged);
  const notations = new RecordingNotationService(new RecordingNotationRepository(), onIntegrationChanged);
  const currentAnalysisEnvironment = () => {
    const model = packagedModel();
    return {
      pipelineVersion: PIPELINE_VERSION,
      embeddingModel: model.id,
      embeddingModelRevision: model.revision,
      embeddingDimensions: 384,
      embeddingDtype: model.dtype,
      configHash: hashAnalysisConfig(CANDIDATE_ANALYSIS_CONFIG),
    };
  };
  const transcripts = new RecordingTranscriptService(
    new RecordingTranscriptRepository(),
    undefined,
    onIntegrationChanged,
    currentAnalysisEnvironment,
  );
  const analyses = new RecordingAnalysisService(
    new RecordingAnalysisRepository(),
    currentAnalysisEnvironment,
    async (recordingId) => {
      const transcript = await transcripts.getSnapshot(recordingId);
      return transcript
        ? {
            generation: transcript.generation,
            revision: transcript.revision,
            contentHash: transcript.contentHash,
          }
        : undefined;
    },
    onIntegrationChanged,
  );

  const analysisCoordinator = new RecordingAnalysisCoordinator({
    dataPlane: offscreen,
    analyses,
    readTranscript: (historyId) => transcripts.getSnapshot(historyId),
    // Absence is not deletion: history delivery and analysis completion settle independently.
    isRecordingDeleted: async (historyId) => Boolean(
      (await historyRepository.get(historyId))?.deletedAt,
    ),
    isRecordingFinalized: async (historyId) => {
      const entry = await historyRepository.get(historyId);
      return Boolean(entry && !entry.deletedAt && entry.status !== 'saving');
    },
    config: () => CANDIDATE_ANALYSIS_CONFIG,
    onSettled: onAnalysisSettled,
  });
  transcripts.setCommitListener(async (historyId) => {
    const result = await analysisCoordinator.ensureCurrentAnalysis(historyId);
    if (!result.ok && result.reason === 'failed') {
      logger.warn(`Could not reconcile topic analysis for ${historyId}:`, result.error ?? 'unknown failure');
    }
  });

  const history = new RecordingHistoryService(
    historyRepository,
    openDownloadedFile,
    Date.now,
    async (resources) => {
      await offscreen.ensureReady();
      return offscreen.rpc({ type: 'OFFSCREEN_RENAME_DRIVE_RESOURCES', resources });
    },
    async (id) => {
      const cleanup = await Promise.allSettled([
        recordingContexts.remove(id),
        notations.removeAll(id),
        transcripts.removeAll(id),
        analysisCoordinator.purge(id),
      ]);
      const labels = ['recording context', 'notations', 'transcript', 'analysis'];
      let failed = false;
      cleanup.forEach((result, index) => {
        if (result.status === 'fulfilled') return;
        failed = true;
        logger.warn(`Could not remove recording ${labels[index]}:`, result.reason);
      });
      if (failed) throw new Error('Dependent recording cleanup incomplete');
    },
    async (keys, historyId) => {
      await playbackLeases.deleteOrDefer(historyId, keys);
    },
    logger.warn,
    onIntegrationChanged,
  );

  const playback = new RecordingPlaybackService({
    getEntry: (id) => historyRepository.get(id),
    listNotations: (id) => notations.list(id),
    transcriptStatus: (id) => transcripts.status(id),
    analysis: (id) => analyses.get(id),
  });

  return {
    historyRepository,
    history,
    recordingContexts,
    notations,
    transcripts,
    analyses,
    analysisCoordinator,
    playback,
  };
}
