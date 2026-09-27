/**
 * Owns analysis transitions and decides whether stored output still matches
 * the current transcript, pipeline, model, and configuration.
 */

import type { AnalysisJob, AnalysisJobStatus } from '../../../shared/analysis/job';
import {
  isStale,
  type AnalysisEnvironmentProvenance,
  type AnalysisProvenance,
} from '../../../shared/analysis/provenance';
import type { TranscriptIdentity } from '../../../shared/transcriptIdentity';
import {
  summarize,
  toTopicSummary,
  type AnalysisSummary,
  type RecordingTopicSummary,
  type StoredAnalysis,
} from '../../../shared/analysis/storedAnalysis';
import type { RecordingAnalysisRepositoryPort } from './RecordingAnalysisRepository';
import type { RecordingAnalysisOutcome } from './RecordingAnalysisOutcome';

/** Why a recording has no usable analysis, or that it has one. */
export type AnalysisState =
  | { status: 'ready'; summary: AnalysisSummary }
  /** Never analysed. */
  | { status: 'none' }
  /** Analysed under conditions that no longer apply; recompute to replace it. */
  | { status: 'stale' };

/** Library-owned state for consumers that must distinguish waiting from terminal unavailability. */
export type AnalysisExportState =
  | { status: 'none' }
  | { status: 'analyzing'; error?: string }
  | { status: 'completed'; result: StoredAnalysis }
  | { status: 'failed' | 'canceled' | 'unsupported'; error?: string }
  | { status: 'stale'; error: string };

export class RecordingAnalysisService {
  constructor(
    private readonly repository: RecordingAnalysisRepositoryPort,
    /** The conditions a fresh run would use; compared against what is stored. */
    private readonly currentEnvironment: () => AnalysisEnvironmentProvenance | AnalysisProvenance,
    private readonly readTranscriptIdentity?: (recordingId: string) => Promise<TranscriptIdentity | undefined>,
    private readonly onChanged?: (recordingId: string) => void,
  ) {}

  /**
   * The stored analysis, or `undefined` when there is none **or it is stale**.
   *
   * Stale is folded into "nothing to show" deliberately: a caller that only
   * wants topics should not have to know why there are none, and one that
   * cares can ask {@link state}.
   */
  async get(recordingId: string): Promise<StoredAnalysis | undefined> {
    const stored = await this.repository.get(recordingId);
    if (!stored) return undefined;
    return await this.isCurrent(recordingId, stored.provenance) ? stored : undefined;
  }

  /** What a surface should render, including *why* there is nothing to render. */
  async state(recordingId: string): Promise<AnalysisState> {
    const stored = await this.repository.get(recordingId);
    if (!stored) return { status: 'none' };
    if (!await this.isCurrent(recordingId, stored.provenance)) return { status: 'stale' };
    return { status: 'ready', summary: summarize(stored) };
  }

  /**
   * Durable readiness seam for integrations and future automation.
   *
   * A current result wins over job bookkeeping. Otherwise active work remains
   * pending, terminal job outcomes remain terminal after their offscreen rows
   * are acknowledged, and a stale result is explicitly terminal-unavailable
   * until somebody starts a recomputation.
   */
  async exportState(recordingId: string): Promise<AnalysisExportState> {
    const { analysis, outcome } = await this.repository.getSnapshot(recordingId);
    if (analysis && await this.isCurrent(recordingId, analysis.provenance)) {
      return { status: 'completed', result: analysis };
    }

    if (outcome?.status === 'analyzing') {
      return { status: 'analyzing', ...(outcome.error ? { error: outcome.error } : {}) };
    }
    if (outcome && (outcome.status === 'failed' || outcome.status === 'canceled' || outcome.status === 'unsupported')) {
      return { status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) };
    }
    if (analysis) {
      return {
        status: 'stale',
        error: 'Stored analysis is stale and must be recomputed before it can be exported.',
      };
    }
    if (outcome?.status === 'completed') {
      return {
        status: 'failed',
        error: 'Analysis completed, but its stored result is unavailable.',
      };
    }
    return { status: 'none' };
  }

  /** Persists a job state before its offscreen outbox row may be acknowledged. */
  async recordJobOutcome(
    job: AnalysisJob,
    status: AnalysisJobStatus = job.status,
    error: string | undefined = job.error,
    now: number = Date.now(),
  ): Promise<void> {
    const outcome: RecordingAnalysisOutcome = {
      status,
      jobId: job.id,
      startedAt: job.startedAt,
      // Receipt order is the control-plane ordering we can trust. `finishedAt`
      // can precede a previously received running update after reconnect/replay.
      updatedAt: now,
      ...(error ? { error } : {}),
    };
    await this.repository.putOutcome(job.historyId, outcome);
    this.onChanged?.(job.historyId);
  }

  /** Persists a terminal attempt that ended before the data plane created a job. */
  async recordTerminalOutcome(
    recordingId: string,
    status: Extract<AnalysisJobStatus, 'failed' | 'canceled' | 'unsupported'>,
    error: string | undefined,
    startedAt: number = Date.now(),
    updatedAt: number = Date.now(),
  ): Promise<void> {
    const outcome: RecordingAnalysisOutcome = {
      status,
      startedAt,
      updatedAt,
      ...(error ? { error } : {}),
    };
    await this.repository.putOutcome(recordingId, outcome);
    this.onChanged?.(recordingId);
  }

  /**
   * The conditions a run starting now would use. Captured at **enqueue** and
   * carried with the job, so what is stored describes the run that actually
   * produced those vectors.
   */
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

  /** Checks only transcript identity; other provenance may legitimately become stale mid-run. */
  async isCurrentTranscript(recordingId: string, provenance: AnalysisProvenance): Promise<boolean> {
    const transcript = await this.currentTranscriptIdentity(recordingId);
    return Boolean(
      transcript
      && provenance.transcriptGeneration === transcript.generation
      && provenance.transcriptRevision === transcript.revision
      && provenance.transcriptHash === transcript.contentHash,
    );
  }

  /**
   * Stores a completed analysis under the conditions it **ran** under.
   *
   * `provenance` is the caller's, and must be the value captured when the run
   * was enqueued. Stamping `currentProvenance()` here instead — which this used
   * to do — records what is true at *persistence* time, which is a different
   * claim: a configuration or model change between enqueue and save would make
   * the row assert conditions that never produced it, and it would then read as
   * current when it is not.
   *
   * The two coincide whenever nothing changes mid-run, which is why the bug was
   * invisible; they stop coinciding exactly when staleness starts to matter.
   */
  async save(
    recordingId: string,
    result: Omit<StoredAnalysis, 'provenance' | 'completedAt'>,
    provenance: AnalysisProvenance,
    now: number = Date.now(),
    job?: Pick<AnalysisJob, 'id' | 'startedAt'>,
  ): Promise<StoredAnalysis> {
    const analysis: StoredAnalysis = { ...result, provenance, completedAt: now };
    const outcome: RecordingAnalysisOutcome = {
      status: 'completed',
      ...(job ? { jobId: job.id } : {}),
      startedAt: job?.startedAt ?? now,
      updatedAt: now,
    };
    await this.repository.putCompleted(recordingId, analysis, outcome);
    this.onChanged?.(recordingId);
    return analysis;
  }

  /**
   * Topic digests for a page of the library, keyed by recording id.
   *
   * Recordings with no current analysis are simply absent from the result
   * rather than present with empty keywords — the column renders nothing either
   * way, and a caller can tell "not analysed" from "analysed, no topics".
   *
   * One read per recording, which is what the underlying store supports; the
   * page size is a screenful, and this is a fire-and-forget digest the table
   * does not wait for.
   */
  async topicSummaries(recordingIds: string[]): Promise<Record<string, RecordingTopicSummary>> {
    const summaries: Record<string, RecordingTopicSummary> = {};
    for (const recordingId of recordingIds) {
      const stored = await this.repository.get(recordingId);
      if (!stored || !await this.isCurrent(recordingId, stored.provenance)) continue;
      summaries[recordingId] = toTopicSummary(stored);
    }
    return summaries;
  }

  /** Drops a recording's analysis — a discarded run, a deleted entry, or a recompute. */
  async removeAll(recordingId: string): Promise<void> {
    await this.repository.removeAll(recordingId);
  }

  private async currentTranscriptIdentity(recordingId: string): Promise<TranscriptIdentity | undefined> {
    return this.readTranscriptIdentity
      ? await this.readTranscriptIdentity(recordingId)
      : identityFromProvenance(this.currentEnvironment());
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
