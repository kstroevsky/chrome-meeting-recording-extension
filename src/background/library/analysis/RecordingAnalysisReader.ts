import {
  isStale,
  type AnalysisEnvironmentProvenance,
  type AnalysisProvenance,
} from '../../../shared/analysis/provenance';
import {
  summarize,
  toTopicSummary,
  type AnalysisSummary,
  type RecordingTopicSummary,
  type StoredAnalysis,
} from '../../../shared/analysis/storedAnalysis';
import type { TranscriptIdentity } from '../../../shared/transcriptIdentity';
import type { RecordingAnalysisRepositoryPort } from './RecordingAnalysisRepository';
import {
  hasCompleteOutcomeBinding,
  type RecordingAnalysisOutcome,
} from './RecordingAnalysisOutcome';
import {
  requiredAnalysisEnvironment,
  sameRequiredAnalysisEnvironment,
  type RecordingAnalysisWork,
} from './RecordingAnalysisWork';

/** Why a recording has no usable analysis, or that it has one. */
export type AnalysisState =
  | { status: 'ready'; summary: AnalysisSummary }
  | { status: 'none' }
  | { status: 'stale' };

/** Library-owned state for consumers that must distinguish waiting from terminal unavailability. */
export type AnalysisExportState =
  | { status: 'none' }
  | { status: 'analyzing'; error?: string }
  | { status: 'completed'; result: StoredAnalysis }
  | { status: 'failed' | 'canceled' | 'unsupported'; error?: string }
  | { status: 'stale'; error: string };

export class RecordingAnalysisReader {
  constructor(
    private readonly repository: RecordingAnalysisRepositoryPort,
    private readonly currentEnvironment: () => AnalysisEnvironmentProvenance | AnalysisProvenance,
    private readonly readTranscriptIdentity?: (recordingId: string) => Promise<TranscriptIdentity | undefined>,
  ) {}

  async get(recordingId: string): Promise<StoredAnalysis | undefined> {
    const stored = await this.repository.get(recordingId);
    if (!stored) return undefined;
    return await this.isCurrent(recordingId, stored.provenance) ? stored : undefined;
  }

  async state(recordingId: string): Promise<AnalysisState> {
    const stored = await this.repository.get(recordingId);
    if (!stored) return { status: 'none' };
    if (!await this.isCurrent(recordingId, stored.provenance)) return { status: 'stale' };
    return { status: 'ready', summary: summarize(stored) };
  }

  async exportState(recordingId: string): Promise<AnalysisExportState> {
    const { analysis, outcome, work } = await this.repository.getSnapshot(recordingId);
    if (analysis && await this.isCurrent(recordingId, analysis.provenance)) {
      return { status: 'completed', result: analysis };
    }
    const currentOutcome = outcome && await this.isCurrentOutcome(recordingId, outcome, work)
      ? outcome
      : undefined;
    if (currentOutcome?.status === 'analyzing') {
      return { status: 'analyzing', ...(currentOutcome.error ? { error: currentOutcome.error } : {}) };
    }
    if (currentOutcome
      && (currentOutcome.status === 'failed' || currentOutcome.status === 'canceled' || currentOutcome.status === 'unsupported')) {
      return { status: currentOutcome.status, ...(currentOutcome.error ? { error: currentOutcome.error } : {}) };
    }
    if (analysis) {
      return {
        status: 'stale',
        error: 'Stored analysis is stale and must be recomputed before it can be exported.',
      };
    }
    if (currentOutcome?.status === 'completed') {
      return {
        status: 'failed',
        error: 'Analysis completed, but its stored result is unavailable.',
      };
    }
    if (await this.isCurrentWork(recordingId, work)
      && (work!.disposition === 'pending'
        || work!.disposition === 'claimed'
        || work!.disposition === 'retry-wait'
        || work!.disposition === 'hash-pending')) {
      return { status: 'analyzing', ...(work!.error ? { error: work!.error } : {}) };
    }
    return { status: 'none' };
  }

  provenanceForNewRun(transcript?: TranscriptIdentity): AnalysisProvenance {
    const environment = this.currentEnvironment();
    const input = transcript ?? identityFromProvenance(environment);
    if (!input) throw new Error('Transcript identity is required to start analysis');
    return {
      ...environment,
      transcriptGeneration: input.generation,
      transcriptRevision: input.revision,
      transcriptHash: input.contentHash,
    };
  }

  async isCurrent(recordingId: string, provenance: AnalysisProvenance): Promise<boolean> {
    const transcript = await this.currentTranscriptIdentity(recordingId);
    if (!transcript) return false;
    return !isStale(provenance, this.provenanceForNewRun(transcript));
  }

  async isCurrentTranscript(recordingId: string, provenance: AnalysisProvenance): Promise<boolean> {
    const transcript = await this.currentTranscriptIdentity(recordingId);
    return Boolean(
      transcript
      && provenance.transcriptGeneration === transcript.generation
      && provenance.transcriptRevision === transcript.revision
      && provenance.transcriptHash === transcript.contentHash,
    );
  }

  async topicSummaries(recordingIds: string[]): Promise<Record<string, RecordingTopicSummary>> {
    const summaries: Record<string, RecordingTopicSummary> = {};
    for (const recordingId of recordingIds) {
      const stored = await this.repository.get(recordingId);
      if (!stored || !await this.isCurrent(recordingId, stored.provenance)) continue;
      summaries[recordingId] = toTopicSummary(stored);
    }
    return summaries;
  }

  private async currentTranscriptIdentity(recordingId: string): Promise<TranscriptIdentity | undefined> {
    return this.readTranscriptIdentity
      ? await this.readTranscriptIdentity(recordingId)
      : identityFromProvenance(this.currentEnvironment());
  }

  private async isCurrentOutcome(
    recordingId: string,
    outcome: RecordingAnalysisOutcome,
    work?: RecordingAnalysisWork,
  ): Promise<boolean> {
    const transcript = await this.currentTranscriptIdentity(recordingId);
    // Legacy/pre-transcript terminal rows are useful only while there still is
    // no transcript they could be incorrectly attributed to.
    if (!transcript) return !hasCompleteOutcomeBinding(outcome);
    if (!hasCompleteOutcomeBinding(outcome)) return false;
    if (!work || work.requestEpoch !== outcome.requestEpoch) return false;
    const environment = requiredAnalysisEnvironment(this.currentEnvironment());
    return outcome.transcriptGeneration === transcript.generation
      && outcome.transcriptRevision === transcript.revision
      && outcome.transcriptHash === transcript.contentHash
      && sameRequiredAnalysisEnvironment(outcome.environment, environment);
  }

  private async isCurrentWork(
    recordingId: string,
    work?: RecordingAnalysisWork,
  ): Promise<boolean> {
    if (!work?.transcriptHash) return false;
    const transcript = await this.currentTranscriptIdentity(recordingId);
    if (!transcript) return false;
    return work.transcriptGeneration === transcript.generation
      && work.transcriptRevision === transcript.revision
      && work.transcriptHash === transcript.contentHash
      && sameRequiredAnalysisEnvironment(
        work.environment,
        requiredAnalysisEnvironment(this.currentEnvironment()),
      );
  }
}

function identityFromProvenance(
  value: AnalysisEnvironmentProvenance | AnalysisProvenance,
): TranscriptIdentity | undefined {
  const candidate = value as Partial<AnalysisProvenance>;
  return typeof candidate.transcriptGeneration === 'string'
    && candidate.transcriptGeneration.length > 0
    && typeof candidate.transcriptRevision === 'number'
    && candidate.transcriptRevision > 0
    && typeof candidate.transcriptHash === 'string'
    && candidate.transcriptHash
    ? {
        generation: candidate.transcriptGeneration,
        revision: candidate.transcriptRevision,
        contentHash: candidate.transcriptHash,
      }
    : undefined;
}
